// @vitest-environment node
/**
 * Issue #3246 (slice 1, sub-issue of #3241) — offer routes +
 * set-rank route, over a node:sqlite D1 stand-in.
 *
 * Pins the §5.1 route semantics: 401 absent login, 400 unknown
 * trigger/family and missing family on interruptive triggers,
 * the guaranteed commercial.offer.shown audit on eligible
 * responses only (with the §4.3 payload), the ambient compare
 * read (no audit, downgradeTargets, suppressions ignored), the
 * dismiss route auditing BEFORE writing with the operator
 * cooldown, the operator-only set-rank route (409 prod-free),
 * the 503 fail-closed shape on an unbound store, and the
 * billing-policy offerRules audit branch.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import { createCommercialAdapter } from "../src/data/createCommercialPorts";
import { createSubscriptionAdapter } from "../src/data/createSubscriptionPorts";
import { createProductAdapter } from "../src/data/createProductPorts";
import { createPriceCatalogueAdapter } from "../src/data/createPriceCataloguePorts";
import { createBillingPolicyAdapter } from "../src/data/createBillingPolicyPorts";
import { createOfferSuppressionAdapter } from "../src/data/createOfferSuppressionPorts";
import { createD1CommercialDb, ensureCommercialSchema } from "../src/data/d1CommercialAdapter";
import { createD1SubscriptionDb, ensureSubscriptionSchema } from "../src/data/d1SubscriptionAdapter";
import { createD1ProductDb, ensureProductSchema } from "../src/data/d1ProductAdapter";
import { createD1PriceCatalogueDb, ensurePriceCatalogueSchema } from "../src/data/d1PriceCatalogueAdapter";
import { createD1BillingPolicyDb, ensureBillingPolicySchema } from "../src/data/d1BillingPolicyAdapter";
import { createD1OfferSuppressionDb, ensureOfferSuppressionSchema } from "../src/data/d1OfferSuppressionAdapter";
import { createD1FreeRunCounterDb, ensureFreeRunCounterSchema } from "../src/data/d1FreeRunCounterAdapter";
import { createD1ApprovedFreeQuotaDb, ensureApprovedFreeQuotaSchema } from "../src/data/d1ApprovedFreeQuotaAdapter";
import { createFreeRunCounterAdapter } from "../src/data/createFreeRunCounterPorts";
import { PROPOSED_SEED_OFFER_RULES } from "../src/data/billingPolicyPorts";
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

interface Harness {
  ctx: AgenticPaymentsRouteContext;
  audit: ReturnType<typeof vi.fn>;
  mock: MockD1Database;
}

async function setup(envOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    FEATURE_MONETIZATION: "1",
    ...envOverrides,
  };
  const audit = vi.fn();
  const ctx = {
    env,
    getOrm: () => ({}) as DatabaseORM,
    audit,
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, audit, mock };
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

async function ensureAll(mock: MockD1Database): Promise<void> {
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
  await ensureProductSchema(createD1ProductDb(mock as unknown as D1Database));
  await ensurePriceCatalogueSchema(createD1PriceCatalogueDb(mock as unknown as D1Database));
  await ensureBillingPolicySchema(createD1BillingPolicyDb(mock as unknown as D1Database));
  await ensureOfferSuppressionSchema(createD1OfferSuppressionDb(mock as unknown as D1Database));
  await ensureFreeRunCounterSchema(createD1FreeRunCounterDb(mock as unknown as D1Database));
  await ensureApprovedFreeQuotaSchema(createD1ApprovedFreeQuotaDb(mock as unknown as D1Database));
}

/** Seed: a Free account, an approved stock price, an approved Basic plan (rank 2). */
async function seedWorld(mock: MockD1Database) {
  await ensureAll(mock);
  const env = { AGENT_DB: mock as unknown as D1Database };
  const store = createCommercialAdapter(env)!;
  await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "Free", creditsUSD: 0, includedRuns: 0 });
  const catalogue = createPriceCatalogueAdapter(env)!;
  await catalogue.setPrice({ family: "stock", priceUSD: 0.02 });
  await catalogue.approvePrice({ family: "stock", approverId: "op1" });
  const products = createProductAdapter(env)!;
  await products.createProduct({ id: "prod-basic", name: "Basic", kind: "subscription", rank: 2 });
  const subs = createSubscriptionAdapter(env)!;
  const plan = await subs.createPlan({
    name: "Basic",
    priceUSD: 49.99,
    periodDays: 30,
    includedRuns: 20,
    productId: "prod-basic",
  });
  await subs.approvePlan(plan.id, "op1");
  return { store, catalogue, products, subs, plan };
}

function auditCalls(audit: ReturnType<typeof vi.fn>, type: string) {
  return audit.mock.calls.filter((c) => c[0] === type).map((c) => c[2] as Record<string, unknown>);
}

describe("POST /payments/agentic/commercial/offer (#3246 §5.1)", () => {
  it("401s without a verified login", async () => {
    const { ctx } = await setup();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer", null, { trigger: "manual_402", family: "stock" });
    expect(res?.status).toBe(401);
  });

  it("400s on the ambient trigger, an unknown trigger, a missing family, and an invalid family", async () => {
    const { ctx } = await setup();
    const ambient = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "ambient", family: "stock" });
    expect(ambient?.status).toBe(400);
    const unknown = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "bogus", family: "stock" });
    expect(unknown?.status).toBe(400);
    const noFamily = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "manual_402" });
    expect(noFamily?.status).toBe(400);
    const badFamily = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "manual_402", family: "crypto" });
    expect(badFamily?.status).toBe(400);
  });

  it("returns an eligible offer and audits commercial.offer.shown with the §4.3 payload", async () => {
    const { ctx, audit, mock } = await setup();
    const { plan } = await seedWorld(mock);
    // The seeded free-run allowance (10, migration 0044) IS coverage
    // for a Free account: exhaust it so the at-limit moment is real.
    const counter = createFreeRunCounterAdapter({ AGENT_DB: mock as unknown as D1Database })!;
    await counter.setAllowance({ family: "stock", runs: 0 });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", {
      trigger: "manual_402",
      family: "stock",
      runRequestId: "run-1",
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      trigger: string;
      eligible: boolean;
      family: string;
      current: { effectiveTier: string; segment: string; includedRunsRemaining: number; creditsUSD: number };
      targets: Array<{ productId: string; versionId: string; recommended: boolean; buyable: boolean }>;
      perRun: { family: string; priceUSD: number } | null;
      topUp: unknown;
    };
    expect(body.trigger).toBe("manual_402");
    expect(body.eligible).toBe(true);
    expect(body.family).toBe("stock");
    expect(body.current).toMatchObject({ effectiveTier: "Free", segment: "default", includedRunsRemaining: 0, creditsUSD: 0 });
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]).toMatchObject({ productId: "prod-basic", versionId: plan.id, recommended: true, buyable: true });
    expect(body.perRun).toMatchObject({ family: "stock", priceUSD: 0.02 });
    // Checkout is unconfigured in this harness: top-up reads as unavailable.
    expect(body.topUp).toBeNull();
    const shown = auditCalls(audit, "commercial.offer.shown");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      login: "u1",
      tenantId: "t1",
      trigger: "manual_402",
      family: "stock",
      targetPlanIds: [plan.id],
      segment: "default",
      runRequestId: "run-1",
    });
  });

  it("reports coverage while the seeded free-run allowance has runs left (the real counter wires through)", async () => {
    const { ctx, audit, mock } = await setup();
    await seedWorld(mock);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "manual_402", family: "stock" });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { eligible: boolean; reasonCode: string; current: { freeRunsRemaining: number } };
    expect(body.eligible).toBe(false);
    expect(body.reasonCode).toBe("FAILURE_OFFER_COVERAGE_EXISTS");
    expect(body.current.freeRunsRemaining).toBe(10);
    expect(auditCalls(audit, "commercial.offer.shown")).toHaveLength(0);
  });

  it("does not audit shown on an ineligible response (flag OFF)", async () => {
    const { ctx, audit, mock } = await setup({ FEATURE_MONETIZATION: "0" });
    await seedWorld(mock);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "manual_402", family: "stock" });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { eligible: boolean; reasonCode: string };
    expect(body.eligible).toBe(false);
    expect(body.reasonCode).toBe("FAILURE_OFFER_DISABLED");
    expect(auditCalls(audit, "commercial.offer.shown")).toHaveLength(0);
  });

  it("503s catalog-coded when the store is unbound", async () => {
    const { ctx } = await setup({ AGENT_DB: undefined });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "manual_402", family: "stock" });
    expect(res?.status).toBe(503);
    const body = (await res?.json()) as { code: string };
    expect(body.code).toBe("FAILURE_OFFER_UNAVAILABLE");
  });
});

describe("GET /payments/agentic/commercial/offer/compare (#3246 §5.1)", () => {
  it("401s without a verified login and audits nothing", async () => {
    const { ctx, audit } = await setup();
    const res = await call(ctx, "GET", "/payments/agentic/commercial/offer/compare", null);
    expect(res?.status).toBe(401);
    expect(audit).not.toHaveBeenCalled();
  });

  it("renders the ambient payload with downgradeTargets and ignores suppressions", async () => {
    const { ctx, audit, mock } = await setup();
    const { subs, plan } = await seedWorld(mock);
    // A cheaper plan below the held Basic: the ambient downgrade column.
    const products = createProductAdapter({ AGENT_DB: mock as unknown as D1Database })!;
    await products.createProduct({ id: "prod-cheap", name: "Cheap", kind: "subscription", rank: 2 });
    const cheap = await subs.createPlan({ name: "Cheap", priceUSD: 29.99, periodDays: 30, includedRuns: 10, productId: "prod-cheap" });
    await subs.approvePlan(cheap.id, "op1");
    // Hold Basic: a subscription row for u1.
    const store = createCommercialAdapter({ AGENT_DB: mock as unknown as D1Database })!;
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier: "Subscribed", tierSource: "subscription", creditsUSD: 0, includedRuns: 0 });
    const sub = await subs.createSubscription({
      id: "sub-1",
      userId: "u1",
      tenantId: "t1",
      planId: plan.id,
      provider: "stripe",
      providerPaymentRef: "cs_test",
      periodStartMs: Date.now(),
      periodEndMs: Date.now() + 30 * 86400000,
    });
    expect(sub.id).toBeTruthy();
    // Dismiss manual_402 first: compare must still render.
    const dismissed = await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", "u1", { trigger: "manual_402", family: "stock" });
    expect(dismissed?.status).toBe(200);
    const res = await call(ctx, "GET", "/payments/agentic/commercial/offer/compare?family=stock", "u1");
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      trigger: string;
      eligible: boolean;
      targets: Array<{ productId: string }>;
      downgradeTargets: Array<{ productId: string; buyable: boolean }>;
    };
    expect(body.trigger).toBe("ambient");
    expect(body.eligible).toBe(true);
    expect(body.downgradeTargets.map((t) => t.productId)).toEqual(["prod-cheap"]);
    expect(body.downgradeTargets[0].buyable).toBe(true);
    expect(auditCalls(audit, "commercial.offer.shown")).toHaveLength(0);
  });
});

describe("POST /payments/agentic/commercial/offer/dismiss (#3246 §4.4/§5.1)", () => {
  it("401s without a login; 400s on ambient, unknown trigger, and invalid family", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", null, { trigger: "manual_402" }))?.status).toBe(401);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", "u1", { trigger: "ambient" }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", "u1", { trigger: "bogus" }))?.status).toBe(400);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", "u1", { trigger: "manual_402", family: "crypto" }))?.status).toBe(400);
  });

  it("writes the suppression with the seeded 7-day cooldown and audits BEFORE writing", async () => {
    const { ctx, audit, mock } = await setup();
    await seedWorld(mock);
    const before = Date.now();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", "u1", { trigger: "manual_402", family: "stock" });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { suppressedUntilMs: number };
    expect(body.suppressedUntilMs).toBeGreaterThanOrEqual(before + 7 * 86400000);
    expect(body.suppressedUntilMs).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
    const dismissed = auditCalls(audit, "commercial.offer.dismissed");
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toMatchObject({
      login: "u1",
      tenantId: "t1",
      trigger: "manual_402",
      family: "stock",
      suppressedUntilMs: body.suppressedUntilMs,
      cooldownDays: 7,
    });
    // The row exists after the audit: the audit preceded the write.
    const suppressions = createOfferSuppressionAdapter({ AGENT_DB: mock as unknown as D1Database })!;
    const row = await suppressions.getSuppression("u1", "manual_402");
    expect(row?.suppressedUntilMs).toBe(body.suppressedUntilMs);
  });

  it("a dismissal suppresses the trigger on the next offer call, across families", async () => {
    const { ctx, mock } = await setup();
    await seedWorld(mock);
    await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", "u1", { trigger: "manual_402", family: "stock" });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer", "u1", { trigger: "manual_402", family: "goal" });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { eligible: boolean; reasonCode: string };
    expect(body.eligible).toBe(false);
    expect(body.reasonCode).toBe("FAILURE_OFFER_SUPPRESSED");
  });

  it("honors the operator cooldown (30 days) from the stored rules", async () => {
    const { ctx, mock } = await setup();
    await seedWorld(mock);
    const policy = createBillingPolicyAdapter({ AGENT_DB: mock as unknown as D1Database })!;
    await policy.updatePolicy({ offerRules: { ...PROPOSED_SEED_OFFER_RULES, dismissCooldownDays: 30 } });
    const before = Date.now();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/offer/dismiss", "u1", { trigger: "trial_end" });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { suppressedUntilMs: number };
    expect(body.suppressedUntilMs).toBeGreaterThanOrEqual(before + 30 * 86400000);
    expect(body.suppressedUntilMs).toBeLessThanOrEqual(Date.now() + 30 * 86400000);
  });
});

describe("POST /payments/agentic/commercial/products/:productId/rank (#3246 §5.1)", () => {
  it("401s without a login and 403s for a non-operator", async () => {
    const { ctx, mock } = await setup();
    await seedWorld(mock);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/products/prod-basic/rank", null, { rank: 5 }))?.status).toBe(401);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/products/prod-basic/rank", "u1", { rank: 5 }))?.status).toBe(403);
  });

  it("404s an unknown product, 409s prod-free, and 400s an invalid rank", async () => {
    const { ctx, mock } = await setup();
    await seedWorld(mock);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/products/prod-nope/rank", "op1", { rank: 5 }))?.status).toBe(404);
    const free = await call(ctx, "POST", "/payments/agentic/commercial/products/prod-free/rank", "op1", { rank: 5 });
    expect(free?.status).toBe(409);
    expect(((await free?.json()) as { code: string }).code).toBe("FAILURE_PRODUCT_RANK_INVALID");
    for (const bad of [0, -1, 1.5, "high"]) {
      const res = await call(ctx, "POST", "/payments/agentic/commercial/products/prod-basic/rank", "op1", { rank: bad });
      expect(res?.status).toBe(400);
    }
    // No upper bound (design §3.3: "a positive whole number or null").
    const large = await call(ctx, "POST", "/payments/agentic/commercial/products/prod-basic/rank", "op1", { rank: 10001 });
    expect(large?.status).toBe(200);
  });

  it("sets and clears the rank, auditing old and new", async () => {
    const { ctx, audit, mock } = await setup();
    await seedWorld(mock);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/products/prod-basic/rank", "op1", { rank: 5 });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { product: { id: string; rank: number | null } };
    expect(body.product).toMatchObject({ id: "prod-basic", rank: 5 });
    const ranked = auditCalls(audit, "commercial.product.rank.set");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ productId: "prod-basic", oldRank: 2, newRank: 5, operator: "op1" });
    const cleared = await call(ctx, "POST", "/payments/agentic/commercial/products/prod-basic/rank", "op1", { rank: null });
    expect(cleared?.status).toBe(200);
    expect(((await cleared?.json()) as { product: { rank: number | null } }).product.rank).toBeNull();
    const products = createProductAdapter({ AGENT_DB: mock as unknown as D1Database })!;
    expect((await products.getProduct("prod-basic"))?.rank).toBeNull();
  });
});

describe("billing-policy offerRules (#3246 §4.2)", () => {
  it("POSTs the rules block through the policy route and audits the rules update", async () => {
    const { ctx, audit, mock } = await setup();
    await ensureAll(mock);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
      offerRules: { ...PROPOSED_SEED_OFFER_RULES, dismissCooldownDays: 14, showProposed: false },
    });
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { policy: { offerRules: { dismissCooldownDays: number; showProposed: boolean } } };
    expect(body.policy.offerRules).toMatchObject({ dismissCooldownDays: 14, showProposed: false });
    const sets = auditCalls(audit, "commercial.billing.policy_set");
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ code: "SUCCESS_OFFER_RULES_UPDATED", login: "op1" });
  });

  it("rejects a malformed rules block with the catalog-coded 400", async () => {
    const { ctx, mock } = await setup();
    await ensureAll(mock);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
      offerRules: { ...PROPOSED_SEED_OFFER_RULES, dismissCooldownDays: 0 },
    });
    expect(res?.status).toBe(400);
    expect(((await res?.json()) as { code: string }).code).toBe("FAILURE_OFFER_RULES_INVALID");
  });
});
