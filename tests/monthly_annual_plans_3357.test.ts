/**
 * Issue #3357 — Monthly + annual subscriptions with configurable annual discount,
 * per-user within a tenant.
 *
 * TDD: this file is written FIRST. It fails until the slice lands.
 *
 * Design (recorded on #3357, comments 6681540224 + 6681606820):
 * - Annual prices are PROPOSED until owner-approved. The #2547 approval discipline is
 *   extended to subscription plans (the per-run catalogue gate never covered plan
 *   prices): new plans land PROPOSED; an operator approves via POST /plans/approve;
 *   every charging path refuses an unapproved plan (402, nothing activated).
 * - Annual discount 15% is operator-managed billing-policy data (`annualDiscountPct`,
 *   PROPOSED seed 15), never hardcoded. Annual price = monthly x 12 x (1 - discount).
 *   Pinned defaults: Basic $509.90/yr ($49.99 x 12 x 0.85), Premium $611.90/yr
 *   ($59.99 x 12 x 0.85).
 * - Per-user within a tenant: tenantId is stamped from the resolved identity at every
 *   activation; GET /subscription is self-or-operator; activation throws on tenant
 *   mismatch. This slice pins that with tests.
 * - Alignment with #1069: a subscription attaches to (user, tenant) — NOT a child of a
 *   membership row, membership NOT a child of a subscription, no giant hierarchy.
 *   Multi-membership is extension-ready: subscription rows are (user, tenant) keyed
 *   with NO per-user uniqueness, so a user can already hold rows in two tenants at
 *   the store level. Multi-currency / multiple payment processors are out of scope
 *   (USD only, Stripe/x402 only, no scaffolding).
 *
 * Harness mirrors tests/billing_activation_2656.test.ts (MockD1Database over
 * node:sqlite, real Drizzle adapters, route handler invoked directly).
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableName, isTable } from "drizzle-orm";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1BillingPolicyDb,
  D1BillingPolicyAdapter,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import * as drizzleSchema from "../src/data/drizzleSchema";
import { InMemoryBillingPolicyAdapter } from "../src/data/inMemoryBillingPolicyAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import {
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS,
  MIGRATION_0014_BILLING,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0041_PLAN_TRIAL_DAYS,
  MIGRATION_0049_PLAN_PRICE_APPROVAL,
  MIGRATION_0058_PRODUCT_VERSIONS,
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import {
  annualPriceUSD,
  assertAnnualDiscountPct,
  assertBillingPolicy,
  assertBillingPolicyPartial,
  PROPOSED_SEED_BILLING_POLICY,
  type BillingPolicy,
} from "../src/data/billingPolicyPorts";
import {
  isPlanPriceApproved,
  resolveEffectiveTier,
  type SubscriptionStore,
} from "../src/data/subscriptionPorts";
import { changeBillingPlanPrice } from "../src/services/billingService";
import { recordBillingSubscription } from "../src/services/billingService";
import type { DatabaseORM } from "../src/orm";
import { BusinessError, getOutcome, resolveOutcome } from "../src/outcomes/outcomeAspects";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

const NOW = 1_800_000_000_000;

async function policyAdapters() {
  const mock = new MockD1Database();
  // ensureBillingPolicySchema requires the commercial + subscription
  // schemas first (later migrations alter agent_commercial_accounts
  // and agent_subscriptions) — same order as
  // billing_activation_2656.test.ts.
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  return [
    { name: "in-memory", policy: new InMemoryBillingPolicyAdapter() },
    { name: "drizzle", policy: new D1BillingPolicyAdapter(policyDb) },
  ];
}

async function planAdapters(): Promise<Array<{ name: string; subs: SubscriptionStore }>> {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const db = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(db);
  return [
    { name: "in-memory", subs: new InMemorySubscriptionAdapter() },
    { name: "drizzle", subs: new D1SubscriptionAdapter(db) },
  ];
}

describe("annual price derivation (#3357)", () => {
  it("pins the owner-decided defaults: Basic $509.90/yr, Premium $611.90/yr at 15%", () => {
    expect(annualPriceUSD(49.99, 15)).toBe(509.9);
    expect(annualPriceUSD(59.99, 15)).toBe(611.9);
  });

  it("derives monthly x 12 x (1 - discount), rounded to the cent", () => {
    expect(annualPriceUSD(20, 15)).toBe(204);
    expect(annualPriceUSD(49.99, 0)).toBe(599.88);
    expect(annualPriceUSD(10, 50)).toBe(60);
    expect(annualPriceUSD(9.99, 15)).toBe(101.9);
  });

  it("rejects invalid discount percentages", () => {
    for (const bad of [-1, 101, NaN, Infinity, "15", null, undefined]) {
      expectBusinessError(() => assertAnnualDiscountPct(bad), "FAILURE_ANNUAL_DISCOUNT_INVALID");
    }
    expect(assertAnnualDiscountPct(0)).toBe(0);
    expect(assertAnnualDiscountPct(15)).toBe(15);
    expect(assertAnnualDiscountPct(100)).toBe(100);
  });

  it("policy validation accepts the new field and rejects an out-of-range value", () => {
    expect(assertBillingPolicyPartial({ annualDiscountPct: 20 })).toEqual({ annualDiscountPct: 20 });
    expectBusinessError(() => assertBillingPolicyPartial({ annualDiscountPct: 150 }), "FAILURE_ANNUAL_DISCOUNT_INVALID");
    expect(() => assertBillingPolicyPartial({ annualDiscountPct: 20, nope: 1 })).toThrow(/Unknown billing policy field/);
    const seed = { ...PROPOSED_SEED_BILLING_POLICY };
    expect(assertBillingPolicy(seed).annualDiscountPct).toBe(15);
    expectBusinessError(() => assertBillingPolicy({ ...seed, annualDiscountPct: -5 }), "FAILURE_ANNUAL_DISCOUNT_INVALID");
  });
});

describe("billing policy annualDiscountPct (#3357)", () => {
  it("seeds to the PROPOSED 15% and survives re-ensure when operator-edited", async () => {
    for (const { policy } of await policyAdapters()) {
      expect((await policy.getPolicy()).annualDiscountPct).toBe(15);
      await policy.updatePolicy({ annualDiscountPct: 20 });
      expect((await policy.getPolicy()).annualDiscountPct).toBe(20);
    }
    // D1 only: re-ensure (INSERT OR IGNORE seeding) must not overwrite the operator edit.
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
    await ensureBillingPolicySchema(policyDb);
    const adapter = new D1BillingPolicyAdapter(policyDb);
    await adapter.updatePolicy({ annualDiscountPct: 25 });
    await ensureBillingPolicySchema(policyDb);
    expect((await adapter.getPolicy()).annualDiscountPct).toBe(25);
  });

  it("refuses an invalid discount at update time on both adapters", async () => {
    for (const { policy } of await policyAdapters()) {
      const err = await policy.updatePolicy({ annualDiscountPct: 101 } as Partial<BillingPolicy>).catch((e) => e);
      expect(err).toBeInstanceOf(BusinessError);
      expect(err.code).toBe("FAILURE_ANNUAL_DISCOUNT_INVALID");
      expect(err.message).toBe(getOutcome("FAILURE_ANNUAL_DISCOUNT_INVALID")?.businessMessage);
      expect((await policy.getPolicy()).annualDiscountPct).toBe(15);
    }
  });
});

describe("migration 0049 — plan price approval (#3357)", () => {
  it("is registered in ALL_MIGRATIONS (position-independent containment, never 'latest')", () => {
    const found = ALL_MIGRATIONS.filter((m) => m.version === 49);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("0049_plan_price_approval");
    expect(found[0].sql).toContain("approval_status");
    expect(found[0].sql).toContain("approved_by");
    expect(found[0].sql).toContain("approved_at_ms");
  });

  it("adds the approval columns to agent_subscription_plans on a 0008 database", async () => {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const db = createD1SubscriptionDb(mock as unknown as D1Database);
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0008_SUBSCRIPTIONS]);
    const before = mock.sqlite.prepare("PRAGMA table_info(agent_subscription_plans)").all() as Array<{ name: string }>;
    expect(before.map((c) => c.name)).not.toContain("approval_status");
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0049_PLAN_PRICE_APPROVAL]);
    const after = mock.sqlite.prepare("PRAGMA table_info(agent_subscription_plans)").all() as Array<{ name: string }>;
    expect(after.map((c) => c.name)).toContain("approval_status");
    expect(after.map((c) => c.name)).toContain("approved_by");
    expect(after.map((c) => c.name)).toContain("approved_at_ms");
  });

  it("grandfathers pre-0049 plan rows as approved (owner states today's monthly prices are approved)", async () => {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const db = createD1SubscriptionDb(mock as unknown as D1Database);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0008_SUBSCRIPTIONS,
      MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS,
      MIGRATION_0014_BILLING,
      MIGRATION_0041_PLAN_TRIAL_DAYS,
    ]);
    mock.sqlite
      .prepare(
        `INSERT INTO agent_subscription_plans (id, name, price_usd, period_days, included_runs, trial_days, active, created_at_ms, updated_at_ms)
         VALUES ('legacy-monthly', 'Legacy Monthly', 49.99, 30, 10, NULL, 1, ?, ?)`,
      )
      .run(NOW, NOW);
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0049_PLAN_PRICE_APPROVAL]);
    // Issue #3289: the adapter's SELECT now reads the 0058
    // version columns, so 0058 (+ its prerequisites) must be
    // applied before the adapter read. The legacy row is
    // backfilled as v1 of its name-derived product, approval
    // preserved.
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
      MIGRATION_0009_JOURNAL,
      MIGRATION_0011_PRICE_CATALOGUE,
      MIGRATION_0012_NATIVE_LEDGER,
      MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
      MIGRATION_0058_PRODUCT_VERSIONS,
    ]);
    const subs = new D1SubscriptionAdapter(db);
    const legacy = await subs.getPlan("legacy-monthly");
    expect(legacy?.approvalStatus).toBe("approved");
    expect(legacy?.approvedBy).toBeNull();
    expect(legacy?.approvedAtMs).toBeNull();
    expect(isPlanPriceApproved(legacy!)).toBe(true);
    expect(legacy?.productId).toBe("prod-sub-legacy-monthly");
    expect(legacy?.segment).toBe("default");
    expect(legacy?.version).toBe(1);
    expect(legacy?.effectiveFromMs).toBe(NOW);
    expect(legacy?.billingPeriod).toBe("monthly");
  });

  it("drizzle schema maps the approval columns (DDL/schema parity)", () => {
    const tables = Object.values(drizzleSchema).filter(isTable);
    const plans = tables.find((t) => getTableName(t) === "agent_subscription_plans");
    expect(plans).toBeDefined();
    expect("approvalStatus" in (plans as unknown as Record<string, unknown>)).toBe(true);
    expect("approvedBy" in (plans as unknown as Record<string, unknown>)).toBe(true);
    expect("approvedAtMs" in (plans as unknown as Record<string, unknown>)).toBe(true);
    expect((plans as unknown as { approvalStatus: { name: string } }).approvalStatus.name).toBe("approval_status");
    expect((plans as unknown as { approvedBy: { name: string } }).approvedBy.name).toBe("approved_by");
    expect((plans as unknown as { approvedAtMs: { name: string } }).approvedAtMs.name).toBe("approved_at_ms");
  });
});

describe("plan price approval — port contract (#3357)", () => {
  it("createPlan lands PROPOSED with no approver on both adapters", async () => {
    for (const { subs } of await planAdapters()) {
      const plan = await subs.createPlan({ id: "new-plan", name: "New", priceUSD: 49.99, periodDays: 30, includedRuns: 10 });
      expect(plan.approvalStatus).toBe("proposed");
      expect(plan.approvedBy).toBeNull();
      expect(plan.approvedAtMs).toBeNull();
      expect(isPlanPriceApproved(plan)).toBe(false);
      const reloaded = await subs.getPlan("new-plan");
      expect(reloaded?.approvalStatus).toBe("proposed");
      expect((await subs.listPlans(true)).find((p) => p.id === "new-plan")?.approvalStatus).toBe("proposed");
    }
  });

  it("approvePlan records approver + time and persists on both adapters", async () => {
    for (const { subs } of await planAdapters()) {
      await subs.createPlan({ id: "to-approve", name: "To Approve", priceUSD: 509.9, periodDays: 365, includedRuns: 120 });
      const approved = await subs.approvePlan("to-approve", "op1");
      expect(approved.approvalStatus).toBe("approved");
      expect(approved.approvedBy).toBe("op1");
      expect(typeof approved.approvedAtMs).toBe("number");
      expect(isPlanPriceApproved(approved)).toBe(true);
      expect((await subs.getPlan("to-approve"))?.approvalStatus).toBe("approved");
      // Re-approval by another operator updates the record (operator re-affirms).
      const reapproved = await subs.approvePlan("to-approve", "op2");
      expect(reapproved.approvalStatus).toBe("approved");
      expect(reapproved.approvedBy).toBe("op2");
    }
  });

  it("approvePlan refuses a missing plan and a blank approver, as catalog-coded BusinessErrors", async () => {
    for (const { subs } of await planAdapters()) {
      // Structural classification (#2573): the failure kind is the catalog
      // code, and the message is the catalog's businessMessage — asserted
      // from the catalog, never against a hardcoded string.
      const missing = await subs.approvePlan("no-such-plan", "op1").catch((e) => e);
      expect(missing).toBeInstanceOf(BusinessError);
      expect(missing.code).toBe("FAILURE_PLAN_NOT_FOUND");
      expect(missing.message).toBe(getOutcome("FAILURE_PLAN_NOT_FOUND")?.businessMessage);
      await subs.createPlan({ id: "p1", name: "P1", priceUSD: 5, periodDays: 30, includedRuns: 0 });
      const blank = await subs.approvePlan("p1", "  ").catch((e) => e);
      expect(blank).toBeInstanceOf(BusinessError);
      expect(blank.code).toBe("FAILURE_PLAN_APPROVAL_INVALID");
      expect(blank.message).toBe(getOutcome("FAILURE_PLAN_APPROVAL_INVALID")?.businessMessage);
      expect((await subs.getPlan("p1"))?.approvalStatus).toBe("proposed");
    }
  });

  it("deactivation preserves the approval state", async () => {
    for (const { subs } of await planAdapters()) {
      await subs.createPlan({ id: "d1", name: "D1", priceUSD: 5, periodDays: 30, includedRuns: 0 });
      await subs.approvePlan("d1", "op1");
      const deactivated = await subs.deactivatePlan("d1");
      expect(deactivated.active).toBe(false);
      expect(deactivated.approvalStatus).toBe("approved");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Route tests: plan create/approve, derivation, charging gates        */
/* ------------------------------------------------------------------ */

async function setupRoute(opts: { monetization?: boolean; stripe?: boolean } = {}) {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
  };
  if (opts.monetization) env.MONETIZATION_ENABLED = "true";
  if (opts.stripe) env.STRIPE_SECRET_KEY = "sk_test_stub";
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const subs = new D1SubscriptionAdapter(subsDb);
  const policy = new D1BillingPolicyAdapter(policyDb);
  return { ctx, env, subs, policy, mock };
}

const req = (method: string, path: string, login: string | null, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const call = (
  ctx: AgenticPaymentsRouteContext,
  method: string,
  path: string,
  login: string | null,
  body?: unknown,
) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
};

const bodyOf = async (res: Response | null) => (await res?.json()) as any;

/**
 * Issue #3357 (AOP, #2573 precedent): a response body is a catalog-coded
 * failure iff its code resolves in the outcome catalog AND its message is
 * the catalog's businessMessage for that code — asserted from the catalog,
 * never against a hardcoded string. No raw `error` field, no raw text.
 */
const expectCodedFailure = (body: any, code: string) => {
  expect(body.code).toBe(code);
  expect(body.message).toBe(getOutcome(code)?.businessMessage);
  expect(body.retryable).toBe(getOutcome(code)?.retryable);
  expect(body.error).toBeUndefined();
};

/**
 * Run fn, expect a BusinessError with the catalog code whose message is
 * the catalog's businessMessage for that code (asserted from the catalog,
 * never against a hardcoded string). Returns the error for further checks.
 */
const expectBusinessError = (fn: () => unknown, code: string): BusinessError => {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(BusinessError);
  expect((caught as BusinessError).code).toBe(code);
  expect((caught as BusinessError).message).toBe(getOutcome(code)?.businessMessage);
  return caught as BusinessError;
};

describe("POST /plans annual derivation + approve route (#3357)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a new plan lands PROPOSED and GET /plans surfaces its approval state", async () => {
    const s = await setupRoute();
    const created = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "basic-monthly",
      name: "Basic Monthly",
      priceUSD: 49.99,
      periodDays: 30,
      includedRuns: 10,
    });
    expect(created?.status).toBe(200);
    expect((await bodyOf(created)).plan.approvalStatus).toBe("proposed");
    const listed = await call(s.ctx, "GET", "/payments/agentic/commercial/plans", "u1");
    const found = (await bodyOf(listed)).plans.find((p: any) => p.id === "basic-monthly");
    expect(found.approvalStatus).toBe("proposed");
    expect(found.priceUSD).toBe(49.99);
  });

  it("derives the annual price from the monthly plan and the current policy discount", async () => {
    const s = await setupRoute();
    await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "basic-monthly",
      name: "Basic Monthly",
      priceUSD: 49.99,
      periodDays: 30,
      includedRuns: 10,
    });
    const annual = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "basic-annual",
      name: "Basic Annual",
      periodDays: 365,
      includedRuns: 120,
      monthlyPlanId: "basic-monthly",
    });
    expect(annual?.status).toBe(200);
    const annualBody = (await bodyOf(annual)) as any;
    // Success is catalog-coded too: code + message resolve from the catalog.
    expect(annualBody.code).toBe("SUCCESS_PLAN_CREATED");
    expect(annualBody.message).toBe(getOutcome("SUCCESS_PLAN_CREATED")?.businessMessage);
    const plan = annualBody.plan;
    expect(plan.priceUSD).toBe(509.9);
    expect(plan.approvalStatus).toBe("proposed");
    // The derivation is recorded in the audit event — with code + message +
    // login, so the record alone answers which code, what happened, for
    // which login (#1969 acceptance).
    expect(s.ctx.audit).toHaveBeenCalledWith(
      "commercial.plan.created",
      "payments",
      expect.objectContaining({
        code: "SUCCESS_PLAN_CREATED",
        message: getOutcome("SUCCESS_PLAN_CREATED")?.businessMessage,
        login: "op1",
        planId: "basic-annual",
        monthlyPlanId: "basic-monthly",
        annualDiscountPct: 15,
        derivedPriceUSD: 509.9,
      }),
    );
  });

  it("an operator-edited discount changes the derived price; an explicit price overrides", async () => {
    const s = await setupRoute();
    await call(s.ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", { annualDiscountPct: 20 });
    expect((await s.policy.getPolicy()).annualDiscountPct).toBe(20);
    await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "basic-monthly",
      name: "Basic Monthly",
      priceUSD: 49.99,
      periodDays: 30,
      includedRuns: 10,
    });
    const annual = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "basic-annual",
      name: "Basic Annual",
      periodDays: 365,
      includedRuns: 120,
      monthlyPlanId: "basic-monthly",
    });
    expect((await bodyOf(annual)).plan.priceUSD).toBe(479.9);
    const explicit = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "premium-annual",
      name: "Premium Annual",
      priceUSD: 600,
      periodDays: 365,
      includedRuns: 240,
      monthlyPlanId: "basic-monthly",
    });
    expect((await bodyOf(explicit)).plan.priceUSD).toBe(600);
  });

  it("refuses a derived annual plan whose period is not 365 days, and an unknown monthly plan", async () => {
    const s = await setupRoute();
    await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "basic-monthly",
      name: "Basic Monthly",
      priceUSD: 49.99,
      periodDays: 30,
      includedRuns: 10,
    });
    const wrongPeriod = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "bad-annual",
      name: "Bad Annual",
      periodDays: 30,
      includedRuns: 120,
      monthlyPlanId: "basic-monthly",
    });
    expect(wrongPeriod?.status).toBe(400);
    expectCodedFailure(await bodyOf(wrongPeriod), "FAILURE_ANNUAL_PLAN_PERIOD_INVALID");
    const unknownMonthly = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "orphan-annual",
      name: "Orphan Annual",
      periodDays: 365,
      includedRuns: 120,
      monthlyPlanId: "no-such-plan",
    });
    expect(unknownMonthly?.status).toBe(404);
    expectCodedFailure(await bodyOf(unknownMonthly), "FAILURE_PLAN_NOT_FOUND");
  });

  it("POST /plans/approve approves as operator, refuses non-operators and missing plans", async () => {
    const s = await setupRoute();
    await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "basic-annual",
      name: "Basic Annual",
      priceUSD: 509.9,
      periodDays: 365,
      includedRuns: 120,
    });
    const forbidden = await call(s.ctx, "POST", "/payments/agentic/commercial/plans/approve", "u1", {
      planId: "basic-annual",
    });
    expect(forbidden?.status).toBe(403);
    expect((await s.subs.getPlan("basic-annual"))?.approvalStatus).toBe("proposed");
    const missing = await call(s.ctx, "POST", "/payments/agentic/commercial/plans/approve", "op1", {
      planId: "no-such-plan",
    });
    expect(missing?.status).toBe(404);
    expectCodedFailure(await bodyOf(missing), "FAILURE_PLAN_NOT_FOUND");
    const approved = await call(s.ctx, "POST", "/payments/agentic/commercial/plans/approve", "op1", {
      planId: "basic-annual",
    });
    expect(approved?.status).toBe(200);
    const approvedBody = (await bodyOf(approved)) as any;
    expect(approvedBody.code).toBe("SUCCESS_PLAN_APPROVED");
    expect(approvedBody.message).toBe(getOutcome("SUCCESS_PLAN_APPROVED")?.businessMessage);
    const plan = approvedBody.plan;
    expect(plan.approvalStatus).toBe("approved");
    expect(plan.approvedBy).toBe("op1");
    expect(typeof plan.approvedAtMs).toBe("number");
    expect(s.ctx.audit).toHaveBeenCalledWith(
      "commercial.plan.approved",
      "payments",
      expect.objectContaining({
        code: "SUCCESS_PLAN_APPROVED",
        message: getOutcome("SUCCESS_PLAN_APPROVED")?.businessMessage,
        login: "op1",
        planId: "basic-annual",
        approvedBy: "op1",
      }),
    );
  });
});

describe("approval gate on charging routes (#3357)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedUnapprovedAndApproved() {
    const s = await setupRoute({ monetization: true });
    await s.subs.createPlan({ id: "plan-unapproved", name: "Unapproved", priceUSD: 509.9, periodDays: 365, includedRuns: 120 });
    await s.subs.createPlan({ id: "plan-approved", name: "Approved", priceUSD: 49.99, periodDays: 30, includedRuns: 10 });
    await s.subs.approvePlan("plan-approved", "op1");
    await s.policy.updatePolicy({ stripePriceByPlan: { "plan-unapproved": "price_annual", "plan-approved": "price_monthly" } });
    return s;
  }

  it("Billing checkout refuses an unapproved plan with 402 before any Stripe call", async () => {
    const s = await seedUnapprovedAndApproved();
    const refused = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-unapproved",
    });
    expect(refused?.status).toBe(402);
    const refusedBody = (await bodyOf(refused)) as any;
    expectCodedFailure(refusedBody, "FAILURE_PLAN_PRICE_NOT_APPROVED");
    expect(JSON.stringify(refusedBody)).not.toContain("plan-unapproved");
    // An approved plan passes the gate (no Stripe configured here, so the next check fires).
    const passed = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-approved",
    });
    expect(passed?.status).toBe(503);
  });

  it("Billing purchase refuses an unapproved plan with 402 before any Stripe call", async () => {
    const s = await seedUnapprovedAndApproved();
    const refused = await call(
      s.ctx,
      "POST",
      "/payments/agentic/commercial/subscription/billing-purchase",
      "u1",
      { planId: "plan-unapproved", checkoutRequestId: "bill-1", checkoutSessionId: "cs_test_1" },
    );
    expect(refused?.status).toBe(402);
    const refusedBody = (await bodyOf(refused)) as any;
    expectCodedFailure(refusedBody, "FAILURE_PLAN_PRICE_NOT_APPROVED");
    expect(JSON.stringify(refusedBody)).not.toContain("plan-unapproved");
    const passed = await call(
      s.ctx,
      "POST",
      "/payments/agentic/commercial/subscription/billing-purchase",
      "u1",
      { planId: "plan-approved", checkoutRequestId: "bill-1", checkoutSessionId: "cs_test_1" },
    );
    expect(passed?.status).toBe(503);
  });

  it("native checkout refuses an unapproved plan with 402 before any Stripe call", async () => {
    const s = await seedUnapprovedAndApproved();
    const refused = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", {
      planId: "plan-unapproved",
      email: "u1@example.test",
    });
    expect(refused?.status).toBe(402);
    const refusedBody = (await bodyOf(refused)) as any;
    expectCodedFailure(refusedBody, "FAILURE_PLAN_PRICE_NOT_APPROVED");
    expect(JSON.stringify(refusedBody)).not.toContain("plan-unapproved");
    const passed = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/checkout", "u1", {
      planId: "plan-approved",
      email: "u1@example.test",
    });
    expect(passed?.status).toBe(503);
  });

  it("native purchase refuses an unapproved plan with 402 before any Stripe call", async () => {
    const s = await seedUnapprovedAndApproved();
    const refused = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: "plan-unapproved",
      checkoutRequestId: "sub-1",
      checkoutSessionId: "cs_test_1",
    });
    expect(refused?.status).toBe(402);
    const refusedBody = (await bodyOf(refused)) as any;
    expectCodedFailure(refusedBody, "FAILURE_PLAN_PRICE_NOT_APPROVED");
    expect(JSON.stringify(refusedBody)).not.toContain("plan-unapproved");
    const passed = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/purchase", "u1", {
      planId: "plan-approved",
      checkoutRequestId: "sub-1",
      checkoutSessionId: "cs_test_1",
    });
    expect(passed?.status).toBe(503);
  });

  it("billing-change-plan refuses an unapproved target plan (service throws before any provider call)", async () => {
    const subs = new InMemorySubscriptionAdapter();
    await subs.createPlan({ id: "target", name: "Target", priceUSD: 509.9, periodDays: 365, includedRuns: 120 });
    await subs.createSubscription({
      id: "sub-1",
      userId: "u1",
      tenantId: "t1",
      planId: "current",
      provider: "stripe",
      providerPaymentRef: "sub_prov_1",
      providerSubscriptionId: "sub_prov_1",
      providerStatus: "active",
      periodStartMs: NOW,
      periodEndMs: NOW + 30 * 86_400_000,
    });
    const billing = { retrieveProviderSubscription: vi.fn(), updateProviderSubscriptionPrice: vi.fn() };
    const policy = { ...PROPOSED_SEED_BILLING_POLICY, stripePriceByPlan: { target: "price_annual" } } as BillingPolicy;
    const svcErr = await changeBillingPlanPrice({
      billing: billing as any,
      subs,
      policy,
      subscriptionId: "sub-1",
      planId: "target",
    }).catch((e) => e);
    expect(svcErr).toBeInstanceOf(BusinessError);
    expect(svcErr.code).toBe("FAILURE_PLAN_PRICE_NOT_APPROVED");
    expect(svcErr.message).toBe(getOutcome("FAILURE_PLAN_PRICE_NOT_APPROVED")?.businessMessage);
    expect(billing.retrieveProviderSubscription).not.toHaveBeenCalled();
    expect(billing.updateProviderSubscriptionPrice).not.toHaveBeenCalled();
  });

  it("billing-change-plan route maps an unapproved target to 402 (catalog-coded)", async () => {
    const s = await setupRoute({ monetization: true, stripe: true });
    await s.subs.createPlan({ id: "target", name: "Target", priceUSD: 509.9, periodDays: 365, includedRuns: 120 });
    await s.subs.createSubscription({
      id: "sub-1",
      userId: "u1",
      tenantId: "t1",
      planId: "current",
      provider: "stripe",
      providerPaymentRef: "sub_prov_1",
      providerSubscriptionId: "sub_prov_1",
      providerStatus: "active",
      periodStartMs: NOW,
      periodEndMs: NOW + 30 * 86_400_000,
    });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-change-plan", "op1", {
      subscriptionId: "sub-1",
      planId: "target",
    });
    expect(res?.status).toBe(402);
    expectCodedFailure(await bodyOf(res), "FAILURE_PLAN_PRICE_NOT_APPROVED");
  });
});

describe("per-user within a tenant (#3357, #1069)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("one user can hold subscriptions in two tenants at the store level (multi-membership extension-ready)", async () => {
    for (const { subs } of await planAdapters()) {
      await subs.createSubscription({
        id: "s-a",
        userId: "u1",
        tenantId: "tenant-a",
        planId: "p",
        provider: "stripe",
        providerPaymentRef: "ref-a",
        periodStartMs: NOW,
        periodEndMs: NOW + 30 * 86_400_000,
      });
      await subs.createSubscription({
        id: "s-b",
        userId: "u1",
        tenantId: "tenant-b",
        planId: "p",
        provider: "stripe",
        providerPaymentRef: "ref-b",
        periodStartMs: NOW,
        periodEndMs: NOW + 30 * 86_400_000,
      });
      const rows = await subs.listSubscriptions("u1");
      expect(rows.map((r) => r.tenantId).sort()).toEqual(["tenant-a", "tenant-b"]);
      expect(resolveEffectiveTier({ tier: "Free" }, rows, NOW)).toBe("Subscribed");
      // The other user's rows are never in this list.
      expect(await subs.listSubscriptions("u2")).toEqual([]);
    }
  });

  it("GET /subscription is self-or-operator: another user gets 403", async () => {
    const s = await setupRoute();
    const forbidden = await call(s.ctx, "GET", "/payments/agentic/commercial/subscription?userId=u2", "u1");
    expect(forbidden?.status).toBe(403);
    const own = await call(s.ctx, "GET", "/payments/agentic/commercial/subscription?userId=u1", "u1");
    expect(own?.status).toBe(200);
    const asOperator = await call(s.ctx, "GET", "/payments/agentic/commercial/subscription?userId=u2", "op1");
    expect(asOperator?.status).toBe(200);
  });

  it("a Billing row claimed by another user/tenant is never silently reassigned", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const provider = {
      providerSubscriptionId: "sub_prov_1",
      status: "active",
      currentPeriodStartMs: NOW,
      currentPeriodEndMs: NOW + 30 * 86_400_000,
    };
    await recordBillingSubscription({ subs, provider: provider as any, userId: "u1", tenantId: "tenant-a", planId: "p", nowMs: NOW });
    await expect(
      recordBillingSubscription({ subs, provider: provider as any, userId: "u2", tenantId: "tenant-b", planId: "p", nowMs: NOW }),
    ).rejects.toThrow(/another user\/tenant/);
    expect((await subs.listSubscriptions("u2")).length).toBe(0);
    expect((await subs.listSubscriptions("u1")).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* AOP coded messages + build standards (#3357)                        */
/*                                                                     */
/* Every #3357 outcome is a catalog entry resolved through the single  */
/* resolver; tests assert the message comes FROM the catalog, never    */
/* from a hardcoded string. Money is decimal USD, rounded to cents at  */
/* the derivation — the defined rounding point.                         */
/* ------------------------------------------------------------------ */

describe("AOP coded messages + build standards (#3357)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("every #3357 catalog entry resolves: commercial category, catalog httpStatus, coded rendering", async () => {
    const expected: Array<[string, "success" | "failure", number]> = [
      ["SUCCESS_PLAN_CREATED", "success", 200],
      ["SUCCESS_PLAN_APPROVED", "success", 200],
      ["SUCCESS_ANNUAL_DISCOUNT_UPDATED", "success", 200],
      ["FAILURE_PLAN_PRICE_NOT_APPROVED", "failure", 402],
      ["FAILURE_ANNUAL_DISCOUNT_INVALID", "failure", 400],
      ["FAILURE_ANNUAL_PLAN_PERIOD_INVALID", "failure", 400],
      ["FAILURE_PLAN_NOT_FOUND", "failure", 404],
      ["FAILURE_PLAN_APPROVAL_INVALID", "failure", 400],
    ];
    for (const [code, outcome, httpStatus] of expected) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved, code).toBe(true);
      expect(resolved.entry?.outcome).toBe(outcome);
      expect(resolved.entry?.category).toBe("commercial");
      expect(resolved.entry?.httpStatus).toBe(httpStatus);
      expect(typeof resolved.entry?.businessMessage).toBe("string");
      expect((resolved.entry?.businessMessage as string).length).toBeGreaterThan(0);
      expect(typeof resolved.entry?.technicalDetail).toBe("string");
      expect(typeof resolved.entry?.retryable).toBe("boolean");
      // The one rendering: "[CODE] business message", from the catalog.
      expect(resolved.businessMessage).toBe(resolved.entry?.businessMessage);
    }
  });

  it("an invalid discount is a catalog-coded 400, and the discount change is audited with code + login", async () => {
    const s = await setupRoute();
    const invalid = await call(s.ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
      annualDiscountPct: 150,
    });
    expect(invalid?.status).toBe(400);
    expectCodedFailure(await bodyOf(invalid), "FAILURE_ANNUAL_DISCOUNT_INVALID");
    // A non-numeric discount is the same coded failure, never a raw throw.
    const nonNumeric = await call(s.ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
      annualDiscountPct: "15",
    });
    expect(nonNumeric?.status).toBe(400);
    expectCodedFailure(await bodyOf(nonNumeric), "FAILURE_ANNUAL_DISCOUNT_INVALID");
    // A valid change lands and its audit carries code + message + login.
    const changed = await call(s.ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
      annualDiscountPct: 20,
    });
    expect(changed?.status).toBe(200);
    expect((await s.policy.getPolicy()).annualDiscountPct).toBe(20);
    expect(s.ctx.audit).toHaveBeenCalledWith(
      "commercial.billing.policy_set",
      "payments",
      expect.objectContaining({
        code: "SUCCESS_ANNUAL_DISCOUNT_UPDATED",
        message: getOutcome("SUCCESS_ANNUAL_DISCOUNT_UPDATED")?.businessMessage,
        login: "op1",
        annualDiscountPct: 20,
      }),
    );
  });

  it("a replayed plan create (same id) is a 409 — the id is the dedup key", async () => {
    const s = await setupRoute();
    const first = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "dup-plan",
      name: "Dup",
      priceUSD: 49.99,
      periodDays: 30,
      includedRuns: 10,
    });
    expect(first?.status).toBe(200);
    expect(((await bodyOf(first)) as any).code).toBe("SUCCESS_PLAN_CREATED");
    const replay = await call(s.ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "dup-plan",
      name: "Dup",
      priceUSD: 49.99,
      periodDays: 30,
      includedRuns: 10,
    });
    expect(replay?.status).toBe(409);
    // Exactly one row exists: the replay created nothing.
    expect((await s.subs.listPlans(false)).filter((p) => p.id === "dup-plan").length).toBe(1);
  });

  it("annual derivation rounds to cents at the defined point (tech-standards §8)", async () => {
    // Pinned values, computed in integer cents by hand.
    expect(annualPriceUSD(49.99, 15)).toBe(509.9);
    expect(annualPriceUSD(59.99, 15)).toBe(611.9);
    expect(annualPriceUSD(33.33, 15)).toBe(339.97);
    expect(annualPriceUSD(10, 15)).toBe(102);
    expect(annualPriceUSD(49.99, 0)).toBe(599.88);
    expect(annualPriceUSD(49.99, 100)).toBe(0);
    // Invariant: the result is a decimal USD value already exact to the
    // cent — no sub-cent residue is ever accumulated downstream.
    for (const [monthly, pct] of [
      [49.99, 15],
      [59.99, 15],
      [33.33, 15],
      [19.99, 20],
      [7.5, 10],
      [0.99, 5],
    ] as Array<[number, number]>) {
      expect(Number.isInteger(annualPriceUSD(monthly, pct) * 100)).toBe(true);
    }
    // Invalid discounts fail catalog-coded at the assert boundary.
    for (const bad of ["15", null, undefined, Number.NaN, -1, 101]) {
      const err = (() => {
        try {
          assertAnnualDiscountPct(bad);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(BusinessError);
      expect((err as BusinessError).code).toBe("FAILURE_ANNUAL_DISCOUNT_INVALID");
    }
  });

  it("a client-supplied tenantId on a charging call is never authority", async () => {
    const s = await setupRoute({ monetization: true });
    await s.subs.createPlan({ id: "plan-approved", name: "Approved", priceUSD: 49.99, periodDays: 30, includedRuns: 10 });
    await s.subs.approvePlan("plan-approved", "op1");
    await s.policy.updatePolicy({ stripePriceByPlan: { "plan-approved": "price_monthly" } });
    // Forged tenant: the charging path resolves the tenant server-side
    // (#2219) and never reads body.tenantId — the value must not appear
    // in, or affect, the response. (No Stripe is configured here, so the
    // next check after the approval gate fires: 503.)
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/billing-checkout", "u1", {
      planId: "plan-approved",
      tenantId: "tenant-b",
    });
    expect(res?.status).toBe(503);
    expect(JSON.stringify(await bodyOf(res))).not.toContain("tenant-b");
  });
});
