/**
 * Issue #3243 — trial subscriptions: plan trial days, trial
 * checkout, trial-end handling (slice 3 of #3241).
 *
 * A trial is a $0 / no-payment checkout that creates a TRIALING
 * subscription for the user on our own path — the survey found no
 * Stripe-trial parameter path in-repo (the Billing checkout port
 * takes price/customer/metadata only), so no Stripe trial is
 * faked. The trial MUST grant the plan's included runs to the
 * account (mirroring activateSubscription): tier alone enables
 * nothing, because the gate reads included runs from the
 * commercial account row only (platformIdentity.ts) and the
 * Billing purchase route confers tier only ("Included-run bypass
 * stays OFF", agenticPayments.ts). Length (plan.trialDays) and
 * inclusions (plan.includedRuns) are OPERATOR DATA — no trial
 * length or run count is hardcoded in code.
 *
 * Trial-end: the trial row's periodEnd is the trial end. The
 * existing unexpired-row reads (resolveEffectiveTier) lapse the
 * tier at expiry with no sweeper; the fallback is the existing
 * at-limit 402 checkout offer, messaged in outcome-encoded copy.
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
import * as drizzleSchema from "../src/data/drizzleSchema";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import {
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0041_PLAN_TRIAL_DAYS,
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import {
  MS_PER_DAY,
  isTrialSubscription,
  resolveEffectiveTier,
  type SubscriptionStore,
} from "../src/data/subscriptionPorts";
import {
  activateTrialSubscription,
  trialEndedMessage,
  trialStartedMessage,
} from "../src/services/trialSubscriptionActivation";
import type { DatabaseORM } from "../src/orm";

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

async function adapters(): Promise<Array<{ name: string; subs: SubscriptionStore }>> {
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

describe("migration 0041 — plan trial days (#3243)", () => {
  it("is registered in ALL_MIGRATIONS (position-independent containment, never 'latest')", () => {
    const found = ALL_MIGRATIONS.filter((m) => m.version === 41);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("0041_plan_trial_days");
    expect(found[0].sql).toContain("trial_days");
  });

  it("adds the trial_days column to agent_subscription_plans on a 0008 database", async () => {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const db = createD1SubscriptionDb(mock as unknown as D1Database);
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0008_SUBSCRIPTIONS]);
    const before = mock.sqlite.prepare("PRAGMA table_info(agent_subscription_plans)").all() as Array<{ name: string }>;
    expect(before.map((c) => c.name)).not.toContain("trial_days");
    await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0041_PLAN_TRIAL_DAYS]);
    const after = mock.sqlite.prepare("PRAGMA table_info(agent_subscription_plans)").all() as Array<{ name: string }>;
    expect(after.map((c) => c.name)).toContain("trial_days");
  });

  it("drizzle schema maps the trial_days column (DDL/schema parity)", () => {
    const tables = Object.values(drizzleSchema).filter(isTable);
    const plans = tables.find((t) => getTableName(t) === "agent_subscription_plans");
    expect(plans).toBeDefined();
    // The mapping object itself carries the column under its camelCase key.
    expect("trialDays" in (plans as unknown as Record<string, unknown>)).toBe(true);
    // ... and the column maps to the migration's trial_days column name.
    expect((plans as unknown as { trialDays: { name: string } }).trialDays.name).toBe("trial_days");
  });
});

describe("plan trialDays — port contract (#3243)", () => {
  it("absent trialDays means no trial (null round-trips on both adapters)", async () => {
    for (const { subs } of await adapters()) {
      const plan = await subs.createPlan({ id: "no-trial", name: "No Trial", priceUSD: 5, periodDays: 30, includedRuns: 3 });
      expect(plan.trialDays).toBeNull();
      expect((await subs.getPlan("no-trial"))?.trialDays).toBeNull();
    }
  });

  it("persists trialDays through create/get/list on both adapters", async () => {
    for (const { subs } of await adapters()) {
      const plan = await subs.createPlan({ id: "trial-plan", name: "Trial", priceUSD: 20, periodDays: 30, includedRuns: 10, trialDays: 14 });
      expect(plan.trialDays).toBe(14);
      expect((await subs.getPlan("trial-plan"))?.trialDays).toBe(14);
      expect((await subs.listPlans(true)).find((p) => p.id === "trial-plan")?.trialDays).toBe(14);
    }
  });

  it("rejects invalid trialDays", async () => {
    for (const { subs } of await adapters()) {
      for (const bad of [0, -1, 1.5, "seven", NaN]) {
        await expect(
          subs.createPlan({ id: "bad", name: "Bad", priceUSD: 5, periodDays: 30, includedRuns: 0, trialDays: bad }),
        ).rejects.toThrow(/trialDays/);
      }
    }
  });
});

describe("trial activation service (#3243)", () => {
  async function setup() {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    const created = await subs.createPlan({ id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10, trialDays: 14 });
    // Issue #3289: trial activation validates the version is
    // effective + approved for the buyer's segment — approve the
    // fixture plan (and re-read it: createPlan returns PROPOSED).
    await subs.approvePlan(created.id, "test-operator");
    const plan = (await subs.getPlan(created.id))!;
    return { subs, store, plan };
  }

  it("creates a trialing subscription AND grants the plan's included runs", async () => {
    const { subs, store, plan } = await setup();
    const { subscription, account, trialEndsAtMs } = await activateTrialSubscription({
      subs, store, userId: "u1", tenantId: "t1", plan, nowMs: NOW,
    });
    expect(subscription.provider).toBe("trial");
    expect(subscription.providerStatus).toBe("trialing");
    expect(subscription.status).toBe("active");
    expect(subscription.planId).toBe("pro");
    expect(subscription.periodStartMs).toBe(NOW);
    expect(subscription.periodEndMs).toBe(NOW + 14 * MS_PER_DAY);
    expect(trialEndsAtMs).toBe(NOW + 14 * MS_PER_DAY);
    expect(subscription.stripeSessionId).toBeNull();
    expect(subscription.stripePaymentIntentId).toBeNull();
    // THE critical requirement: runs granted, not tier only.
    expect(account.includedRuns).toBe(10);
    expect(account.tierSource).toBe("subscription");
    expect(isTrialSubscription(subscription)).toBe(true);
    expect(resolveEffectiveTier(account, [subscription], NOW)).toBe("Subscribed");
  });

  it("refuses a plan with no trialDays", async () => {
    const subs = new InMemorySubscriptionAdapter();
    const store = new InMemoryCommercialAdapter();
    const created = await subs.createPlan({ id: "plain", name: "Plain", priceUSD: 5, periodDays: 30, includedRuns: 0 });
    // Issue #3289: approve first, so the trialDays refusal (not
    // the approval refusal) is what this test pins.
    await subs.approvePlan(created.id, "test-operator");
    const plan = (await subs.getPlan(created.id))!;
    await expect(
      activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan, nowMs: NOW }),
    ).rejects.toThrow(/no trial/);
    expect(await subs.listSubscriptions("u1")).toEqual([]);
  });

  it("refuses an inactive plan and a second trial of the same plan", async () => {
    const { subs, store } = await setup();
    await subs.deactivatePlan("pro");
    const inactivePlan = await subs.getPlan("pro");
    expect(inactivePlan?.active).toBe(false);
    await expect(
      activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: inactivePlan!, nowMs: NOW }),
    ).rejects.toThrow(/not active/);
    // Issue #3289: activation validates the STORED version is
    // effective + approved — the old spread-hack ({...plan,
    // active: true}) no longer reactivates a deactivated row, so
    // the success path uses a fresh active plan with the same terms.
    const createdPro2 = await subs.createPlan({ id: "pro2", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10, trialDays: 14 });
    await subs.approvePlan(createdPro2.id, "test-operator");
    const activePlan = (await subs.getPlan(createdPro2.id))!;
    await activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: activePlan, nowMs: NOW });
    await expect(
      activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: activePlan, nowMs: NOW }),
    ).rejects.toThrow(/already used/);
    // A different trial plan for the same user is still allowed.
    const createdOther = await subs.createPlan({ id: "team", name: "Team", priceUSD: 40, periodDays: 30, includedRuns: 5, trialDays: 7 });
    await subs.approvePlan(createdOther.id, "test-operator");
    const other = (await subs.getPlan(createdOther.id))!;
    const second = await activateTrialSubscription({ subs, store, userId: "u1", tenantId: "t1", plan: other, nowMs: NOW });
    expect(second.subscription.planId).toBe("team");
    expect(second.account.includedRuns).toBe(15);
  });

  it("trial-end: the tier lapses at periodEnd via the existing unexpired-row read", async () => {
    const { subs, store, plan } = await setup();
    const { subscription, account } = await activateTrialSubscription({
      subs, store, userId: "u1", tenantId: "t1", plan, nowMs: NOW,
    });
    expect(resolveEffectiveTier(account, [subscription], NOW + 14 * MS_PER_DAY)).toBe("Free");
    expect(resolveEffectiveTier(account, [subscription], NOW + 14 * MS_PER_DAY - 1)).toBe("Subscribed");
  });

  it("trial messages are outcome-encoded, never a raw error code", () => {
    const started = trialStartedMessage({ planName: "Pro", trialDays: 14, includedRuns: 10, trialEndsAtMs: NOW + 14 * MS_PER_DAY });
    expect(started).toContain("Pro");
    expect(started).toContain("14");
    expect(started).toContain("10");
    expect(started).not.toMatch(/402|ERR_|error code/i);
    const ended = trialEndedMessage("Pro");
    expect(ended).toContain("Pro");
    expect(ended).toMatch(/trial.*ended/i);
    expect(ended).toMatch(/subscribe|pay per run/i);
    expect(ended).not.toMatch(/402|ERR_|error code/i);
  });
});

describe("trial checkout route (#3243)", () => {
  async function setupRoute(opts: { monetization?: boolean } = {}) {
    const mock = new MockD1Database();
    const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(commercialDb);
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    const env: Record<string, unknown> = {
      AGENT_DB: mock,
      COMMERCIAL_STORE_OPERATORS: "op1",
    };
    if (opts.monetization) env.MONETIZATION_ENABLED = "true";
    const ctx = {
      env,
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
    return { ctx };
  }

  const call = (ctx: AgenticPaymentsRouteContext, method: string, path: string, login: string | null, body?: unknown) => {
    const url = new URL(`https://agent.internal${path}`);
    return handleAgenticPaymentsRoutes(
      new Request(`https://agent.internal${path}`, {
        method,
        headers: {
          ...(login ? { "x-user-login": login } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      url,
      url.pathname,
      "sess-1",
      ctx,
    );
  };
  const bodyOf = async (res: Response | null) => (await res?.json()) as any;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trial checkout creates a trialing row, grants runs, and a second trial is refused", async () => {
    const { ctx } = await setupRoute({ monetization: true });
    const created = await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "pro", name: "Pro", priceUSD: 20, periodDays: 30, includedRuns: 10, trialDays: 14,
    });
    expect(created?.status).toBe(200);
    expect((await bodyOf(created)).plan.trialDays).toBe(14);
    // Issue #3289: trial activation validates effective +
    // approved — approve the plan an operator would approve
    // before offering it.
    const approved = await call(ctx, "POST", "/payments/agentic/commercial/plans/approve", "op1", { planId: "pro" });
    expect(approved?.status).toBe(200);
    const listed = await call(ctx, "GET", "/payments/agentic/commercial/plans", "u1");
    expect((await bodyOf(listed)).plans.find((p: any) => p.id === "pro")?.trialDays).toBe(14);

    const res = await call(ctx, "POST", "/payments/agentic/commercial/subscription/trial", "u1", { planId: "pro" });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.subscription.providerStatus).toBe("trialing");
    expect(body.subscription.provider).toBe("trial");
    expect(body.account.includedRuns).toBe(10);
    expect(body.effectiveTier).toBe("Subscribed");
    expect(body.trialEndsAtMs).toBe(body.subscription.periodEndMs);
    expect(typeof body.message).toBe("string");
    expect(body.message).toContain("Pro");

    const again = await call(ctx, "POST", "/payments/agentic/commercial/subscription/trial", "u1", { planId: "pro" });
    expect(again?.status).toBe(409);
  });

  it("auth/flag/plan matrix: anonymous 401, flag OFF 403, unknown plan 404, no-trial plan 409", async () => {
    const { ctx } = await setupRoute({ monetization: true });
    await call(ctx, "POST", "/payments/agentic/commercial/plans", "op1", {
      id: "plain", name: "Plain", priceUSD: 5, periodDays: 30, includedRuns: 0,
    });
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/trial", null, { planId: "plain" }))?.status).toBe(401);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/trial", "u1", { planId: "missing" }))?.status).toBe(404);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/subscription/trial", "u1", { planId: "plain" }))?.status).toBe(409);
    const { ctx: ctxOff } = await setupRoute({});
    expect((await call(ctxOff, "POST", "/payments/agentic/commercial/subscription/trial", "u1", { planId: "plain" }))?.status).toBe(403);
  });
});
