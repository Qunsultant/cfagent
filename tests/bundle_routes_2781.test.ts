/**
 * Issue #2781 (Monetization Phase 2.15) — product bundle routes.
 *
 * CRUD + approval through handleAgenticPaymentsRoutes, and the 2.1-style
 * mint → confirm-by-retrieve purchase flow for bundles: only an APPROVED
 * bundle price may be charged, the price is the OPERATOR-MAPPED provider
 * price id from the billing policy (stripePriceByBundle), and fulfillment
 * writes the purchase + one entitlement per member product atomically.
 * Cancel covers bundle purchases; a bundle payment ref is refused by the
 * refund flow with the coded 422. Harness mirrors
 * tests/subscription_routes.test.ts + tests/billing_activation_2656.test.ts
 * (MockD1Database over node:sqlite, real Drizzle adapters, fetch stubbed
 * as Stripe REST). No value here is an owner decision — bundle, price
 * mapping, and policy are operator data set up in the test itself.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1BillingPolicyDb,
  D1BillingPolicyAdapter,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import {
  createD1BillingCustomerDb,
  ensureBillingCustomerSchema,
} from "../src/data/d1BillingCustomerAdapter";
import {
  createD1JournalDb,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import {
  createD1ProductBundleDb,
  ensureProductBundleSchema,
} from "../src/data/d1ProductBundleAdapter";
import {
  createD1PriceCatalogueDb,
  ensurePriceCatalogueSchema,
} from "../src/data/d1PriceCatalogueAdapter";
import {
  createD1RefundDb,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import { createPriceCatalogueAdapter } from "../src/data/createPriceCataloguePorts";

/** Minimal D1Database stand-in over node:sqlite, with batch() (mirrors tests/product_bundles_2781.test.ts). */
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
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

async function setup(opts: { monetization?: boolean; stripe?: boolean } = {}) {
  const mock = new MockD1Database();
  await ensureCommercialSchema(createD1CommercialDb(mock as unknown as D1Database));
  await ensureSubscriptionSchema(createD1SubscriptionDb(mock as unknown as D1Database));
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  const policy = new D1BillingPolicyAdapter(policyDb);
  await ensureBillingCustomerSchema(createD1BillingCustomerDb(mock as unknown as D1Database));
  await ensureJournalSchema(createD1JournalDb(mock as unknown as D1Database));
  await ensureProductBundleSchema(createD1ProductBundleDb(mock as unknown as D1Database));
  const catalogueDb = createD1PriceCatalogueDb(mock as unknown as D1Database);
  await ensurePriceCatalogueSchema(catalogueDb);
  await ensureRefundSchema(createD1RefundDb(mock as unknown as D1Database));
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
  };
  if (opts.monetization) env.MONETIZATION_ENABLED = "true";
  if (opts.stripe) env.STRIPE_SECRET_KEY = "sk_test_stub";
  const audit = vi.fn();
  const ctx = {
    env,
    getOrm: () => ({}),
    audit,
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env, mock, audit, policy };
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
 * Stub fetch as the Stripe REST API. The checkout POST records the
 * minted draft + its fulfillment metadata (keyed by session id), so
 * the retrieve returns the exact draft the mint produced — the same
 * shape the Billing activation tests stub, with bundleId in place
 * of planId. The provider subscription object is scripted (price
 * id + status overridable per test).
 */
function stubBundleStripe(overrides: {
  providerPriceId?: string;
  providerStatus?: string;
  paymentStatus?: string;
} = {}) {
  const sessions = new Map<string, { draft: string; metadata: Record<string, string> }>();
  let counter = 0;
  const providerPriceId = overrides.providerPriceId ?? "price_bundle_1";
  const providerStatus = overrides.providerStatus ?? "active";
  const paymentStatus = overrides.paymentStatus ?? "paid";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      if (href === "https://api.stripe.com/v1/checkout/sessions" && method === "POST") {
        const params = new URLSearchParams(String(init.body));
        const draft = params.get("client_reference_id") ?? "";
        const metadata: Record<string, string> = {};
        for (const key of ["userId", "bundleId", "tenantId"]) {
          const v = params.get(`subscription_data[metadata][${key}]`) ?? params.get(`metadata[${key}]`);
          if (v) metadata[key] = v;
        }
        counter += 1;
        const id = `cs_test_bundle_${counter}`;
        sessions.set(id, { draft, metadata });
        return { ok: true, status: 200, json: async () => ({ id, url: `https://checkout.stripe.com/pay/${id}` }) };
      }
      const m = href.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/([^/]+)$/);
      if (m && method === "GET") {
        const session = sessions.get(decodeURIComponent(m[1]));
        if (!session) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: decodeURIComponent(m[1]),
            status: "complete",
            payment_status: paymentStatus,
            client_reference_id: session.draft,
            subscription: "sub_prov_1",
            customer: "cus_1",
            metadata: session.metadata,
          }),
        };
      }
      if (href.startsWith("https://api.stripe.com/v1/subscriptions/") && method === "GET") {
        const requested = href.slice("https://api.stripe.com/v1/subscriptions/".length);
        if (requested !== "sub_prov_1") {
          return { ok: false, status: 404, json: async () => ({ error: { message: `No such subscription: '${requested}'` } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "sub_prov_1",
            status: providerStatus,
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
            cancel_at_period_end: false,
            canceled_at: null,
            items: { data: [{ price: { id: providerPriceId } }] },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const BUNDLE = {
  id: "bnd-test-1",
  name: "Stock + Options",
  memberProductIds: ["stock:PayPerUse", "options:PayPerUse"],
  priceUSD: 0.06,
  periodDays: 30,
  includedRunsPerMember: 10,
};

async function seedListedPrices(s: Awaited<ReturnType<typeof setup>>) {
  const catalogue = createPriceCatalogueAdapter(s.env as { AGENT_DB?: unknown });
  if (!catalogue) throw new Error("price catalogue adapter unavailable in test setup");
  for (const family of ["stock", "options"]) {
    await catalogue.setPrice({ family, priceUSD: 0.05 });
    await catalogue.approvePrice({ family, approverId: "op1" });
  }
}

async function createBundle(
  ctx: AgenticPaymentsRouteContext,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/bundles", "op1", { ...BUNDLE, ...overrides });
  expect(res?.status).toBe(200);
  return (await bodyOf(res)).bundle;
}

async function seedApprovedMappedBundle(
  s: Awaited<ReturnType<typeof setup>>,
): Promise<{ bundle: any; draft: string; sessionId: string }> {
  await seedListedPrices(s);
  const bundle = await createBundle(s.ctx);
  const approved = await call(s.ctx, "POST", "/payments/agentic/commercial/bundles/approve", "op1", { bundleId: bundle.id });
  expect(approved?.status).toBe(200);
  await s.policy.updatePolicy({ stripePriceByBundle: { [bundle.id]: "price_bundle_1" } });
  const minted = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: bundle.id });
  expect(minted?.status).toBe(200);
  const mintedBody = await bodyOf(minted);
  return { bundle, draft: mintedBody.checkoutRequestId as string, sessionId: mintedBody.checkoutSessionId as string };
}

async function fulfillBundle(
  s: Awaited<ReturnType<typeof setup>>,
  bundleId: string,
  draft: string,
  sessionId: string,
) {
  const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-purchase", "u1", {
    bundleId,
    checkoutRequestId: draft,
    checkoutSessionId: sessionId,
  });
  return { res, body: await bodyOf(res) };
}

describe("bundle CRUD + approval", () => {
  it("auth matrix: anonymous cannot list, non-operator cannot create/approve/deactivate", async () => {
    const { ctx } = await setup();
    expect((await call(ctx, "GET", "/payments/agentic/commercial/bundles", null))?.status).toBe(401);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/bundles", "u1", BUNDLE))?.status).toBe(403);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/bundles/approve", "u1", { bundleId: "x" }))?.status).toBe(403);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/bundles/deactivate", "u1", { bundleId: "x" }))?.status).toBe(403);
  });

  it("operator creates a PROPOSED bundle; duplicate id refuses 409; GET lists it", async () => {
    const s = await setup();
    const { ctx } = s;
    await seedListedPrices(s);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/bundles", "op1", BUNDLE);
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.bundle.id).toBe("bnd-test-1");
    expect(body.bundle.approvalStatus).toBe("proposed");
    expect(body.code).toBe("SUCCESS_BUNDLE_CREATED");
    expect((await call(ctx, "POST", "/payments/agentic/commercial/bundles", "op1", BUNDLE))?.status).toBe(409);
    const listed = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/bundles", "u1"));
    expect(listed.bundles.map((b: any) => b.id)).toEqual(["bnd-test-1"]);
  });

  it("refuses fewer than two members, duplicate members, and unknown families (coded 400)", async () => {
    const { ctx } = await setup();
    for (const members of [
      ["stock:PayPerUse"],
      ["stock:PayPerUse", "stock:PayPerUse"],
      ["stock:PayPerUse", "nope:PayPerUse"],
      ["stock:PayPerUse", "stock:Subscribed"],
    ]) {
      const res = await call(ctx, "POST", "/payments/agentic/commercial/bundles", "op1", { ...BUNDLE, memberProductIds: members });
      expect(res?.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("FAILURE_BUNDLE_MEMBERS_INVALID");
    }
  });

  it("refuses a member whose family has no APPROVED catalogue price (unlisted, coded 400)", async () => {
    const { ctx } = await setup();
    // Only stock is approved; options has no price at all.
    const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
    await catalogue!.setPrice({ family: "stock", priceUSD: 0.05 });
    await catalogue!.approvePrice({ family: "stock", approverId: "op1" });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/bundles", "op1", BUNDLE);
    expect(res?.status).toBe(400);
    expect((await bodyOf(res)).code).toBe("FAILURE_BUNDLE_MEMBERS_INVALID");
  });

  it("approve + deactivate: approve records the operator, deactivation never un-approves", async () => {
    const s = await setup();
    const { ctx } = s;
    await seedListedPrices(s);
    const bundle = await createBundle(ctx);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/bundles/approve", "op1", { bundleId: "missing" }))?.status).toBe(404);
    const approved = await call(ctx, "POST", "/payments/agentic/commercial/bundles/approve", "op1", { bundleId: bundle.id });
    expect(approved?.status).toBe(200);
    const approvedBody = await bodyOf(approved);
    expect(approvedBody.bundle.approvalStatus).toBe("approved");
    expect(approvedBody.bundle.approvedBy).toBe("op1");
    expect(approvedBody.code).toBe("SUCCESS_BUNDLE_APPROVED");
    const off = await bodyOf(await call(ctx, "POST", "/payments/agentic/commercial/bundles/deactivate", "op1", { bundleId: bundle.id }));
    expect(off.bundle.active).toBe(false);
    expect(off.bundle.approvalStatus).toBe("approved");
    const listed = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/bundles", "u1"));
    expect(listed.bundles).toEqual([]);
    expect((await call(ctx, "POST", "/payments/agentic/commercial/bundles/deactivate", "op1", { bundleId: "missing" }))?.status).toBe(404);
  });
});

describe("bundle checkout mint", () => {
  it("flag OFF refuses mint before any Stripe call; anonymous cannot mint", async () => {
    const s = await setup({ stripe: true });
    stubBundleStripe();
    await seedListedPrices(s);
    await createBundle(s.ctx);
    expect((await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: "bnd-test-1" }))?.status).toBe(403);
    expect((await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", null, { bundleId: "bnd-test-1" }))?.status).toBe(401);
  });

  it("unknown bundle 404, proposed bundle 402, unmapped bundle 503 — all catalog-coded", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    await seedListedPrices(s);
    await createBundle(s.ctx);
    expect((await bodyOf(await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: "missing" })))).toMatchObject({ code: "FAILURE_BUNDLE_NOT_FOUND" });
    expect((await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: "bnd-test-1" }))?.status).toBe(402);
    expect((await bodyOf(await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: "bnd-test-1" })))).toMatchObject({ code: "FAILURE_BUNDLE_PRICE_NOT_APPROVED" });
    await call(s.ctx, "POST", "/payments/agentic/commercial/bundles/approve", "op1", { bundleId: "bnd-test-1" });
    const unmapped = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: "bnd-test-1" });
    expect(unmapped?.status).toBe(503);
    expect((await bodyOf(unmapped)).code).toBe("FAILURE_BUNDLE_PRICE_UNMAPPED");
  });

  it("deactivated bundle refuses 409; card rail unconfigured fails closed with 503", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    await seedListedPrices(s);
    const bundle = await createBundle(s.ctx);
    await call(s.ctx, "POST", "/payments/agentic/commercial/bundles/approve", "op1", { bundleId: bundle.id });
    await s.policy.updatePolicy({ stripePriceByBundle: { [bundle.id]: "price_bundle_1" } });
    await call(s.ctx, "POST", "/payments/agentic/commercial/bundles/deactivate", "op1", { bundleId: bundle.id });
    expect((await bodyOf(await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: bundle.id })))).toMatchObject({ code: "FAILURE_BUNDLE_NOT_ACTIVE" });
    const unconfigured = await setup({ monetization: true });
    stubBundleStripe();
    await seedListedPrices(unconfigured);
    const bundle2 = await createBundle(unconfigured.ctx);
    await call(unconfigured.ctx, "POST", "/payments/agentic/commercial/bundles/approve", "op1", { bundleId: bundle2.id });
    await unconfigured.policy.updatePolicy({ stripePriceByBundle: { [bundle2.id]: "price_bundle_1" } });
    expect((await call(unconfigured.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: bundle2.id }))?.status).toBe(503);
  });

  it("mint returns a real checkoutUrl bound to a bbnd- draft id", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    await seedListedPrices(s);
    const bundle = await createBundle(s.ctx);
    await call(s.ctx, "POST", "/payments/agentic/commercial/bundles/approve", "op1", { bundleId: bundle.id });
    await s.policy.updatePolicy({ stripePriceByBundle: { [bundle.id]: "price_bundle_1" } });
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: bundle.id });
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.checkoutRequestId).toMatch(/^bbnd-/);
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(body.checkoutSessionId).toMatch(/^cs_test_bundle_/);
    expect(body.bundle.id).toBe(bundle.id);
    expect(body.bundle.priceUSD).toBe(0.06);
    expect(s.audit).toHaveBeenCalledWith(
      "commercial.bundle.billing_checkout_created",
      "payments",
      expect.objectContaining({ bundleId: bundle.id, checkoutRequestId: body.checkoutRequestId }),
    );
  });
});

describe("bundle purchase fulfill", () => {
  it("flag OFF refuses fulfill; wrong draft prefix refuses 400", async () => {
    const s = await setup({ stripe: true });
    stubBundleStripe();
    await seedListedPrices(s);
    await createBundle(s.ctx);
    expect((await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-purchase", "u1", { bundleId: "bnd-test-1", checkoutRequestId: "bbnd-x", checkoutSessionId: "cs_test_bundle_1" }))?.status).toBe(403);
    const on = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    const { res } = await fulfillBundle(on, "bnd-test-1", "bill-wrong-prefix", "cs_test_bundle_1");
    expect(res?.status).toBe(400);
  });

  it("unverified evidence refuses 402 with the coded message and activates nothing", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe({ paymentStatus: "unpaid" });
    const { bundle, draft, sessionId } = await seedApprovedMappedBundle(s);
    const { res, body } = await fulfillBundle(s, bundle.id, draft, sessionId);
    expect(res?.status).toBe(402);
    expect(body.code).toBe("FAILURE_BUNDLE_PURCHASE_NOT_PAID");
    const sub = await bodyOf(await call(s.ctx, "GET", `/payments/agentic/commercial/subscription?userId=u1`, "u1"));
    expect(sub.bundlePurchases).toEqual([]);
  });

  it("provider price mismatch and non-active provider status refuse 402", async () => {
    const wrongPrice = await setup({ monetization: true, stripe: true });
    stubBundleStripe({ providerPriceId: "price_other" });
    const seeded = await seedApprovedMappedBundle(wrongPrice);
    expect((await fulfillBundle(wrongPrice, seeded.bundle.id, seeded.draft, seeded.sessionId)).res?.status).toBe(402);
    const canceled = await setup({ monetization: true, stripe: true });
    stubBundleStripe({ providerStatus: "canceled" });
    const seeded2 = await seedApprovedMappedBundle(canceled);
    expect((await fulfillBundle(canceled, seeded2.bundle.id, seeded2.draft, seeded2.sessionId)).res?.status).toBe(402);
  });

  it("fulfills atomically: purchase + one entitlement per member, coded success, audit recorded", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    const { bundle, draft, sessionId } = await seedApprovedMappedBundle(s);
    const { res, body } = await fulfillBundle(s, bundle.id, draft, sessionId);
    expect(res?.status).toBe(200);
    expect(body.code).toBe("SUCCESS_BUNDLE_PURCHASED");
    expect(body.purchase.bundleId).toBe(bundle.id);
    expect(body.purchase.status).toBe("active");
    expect(body.purchase.providerPaymentRef).toBe(draft);
    expect(body.purchase.providerSubscriptionId).toBe("sub_prov_1");
    expect(body.entitlements).toHaveLength(2);
    expect(body.entitlements.map((e: any) => e.productId).sort()).toEqual(["options:PayPerUse", "stock:PayPerUse"]);
    expect(body.entitlements.every((e: any) => e.includedRuns === 10)).toBe(true);
    expect(body.entitlements.every((e: any) => e.bundlePurchaseId === body.purchase.id)).toBe(true);
    expect(s.audit).toHaveBeenCalledWith(
      "commercial.bundle.billing_activated",
      "payments",
      expect.objectContaining({ bundleId: bundle.id, purchaseId: body.purchase.id }),
    );
    const sub = await bodyOf(await call(s.ctx, "GET", `/payments/agentic/commercial/subscription?userId=u1`, "u1"));
    expect(sub.bundlePurchases).toHaveLength(1);
    expect(sub.bundleEntitlements).toHaveLength(2);
  });

  it("replay by draft id and by provider subscription id both refuse 409 coded", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    const { bundle, draft, sessionId } = await seedApprovedMappedBundle(s);
    const first = await fulfillBundle(s, bundle.id, draft, sessionId);
    expect(first.res?.status).toBe(200);
    const replayDraft = await fulfillBundle(s, bundle.id, draft, sessionId);
    expect(replayDraft.res?.status).toBe(409);
    expect(replayDraft.body.code).toBe("FAILURE_BUNDLE_PURCHASE_EXISTS");
    // A second mint produces a new draft but the same provider
    // subscription id — the provider replay guard refuses it too.
    const minted2 = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/bundle-checkout", "u1", { bundleId: bundle.id });
    const mintedBody2 = await bodyOf(minted2);
    const replayProvider = await fulfillBundle(s, bundle.id, mintedBody2.checkoutRequestId, mintedBody2.checkoutSessionId);
    expect(replayProvider.res?.status).toBe(409);
    expect(replayProvider.body.code).toBe("FAILURE_BUNDLE_PURCHASE_EXISTS");
    const sub = await bodyOf(await call(s.ctx, "GET", `/payments/agentic/commercial/subscription?userId=u1`, "u1"));
    expect(sub.bundlePurchases).toHaveLength(1);
  });
});

describe("subscription GET additive keys, cancel, refund refusal", () => {
  it("subscription GET carries empty bundle keys before any purchase", async () => {
    const { ctx } = await setup();
    const sub = await bodyOf(await call(ctx, "GET", `/payments/agentic/commercial/subscription?userId=u1`, "u1"));
    expect(sub.bundlePurchases).toEqual([]);
    expect(sub.bundleEntitlements).toEqual([]);
    expect(sub.subscriptions).toEqual([]);
  });

  it("cancel covers bundle purchases: bundle-only cancel succeeds and cancels the purchase", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    const { bundle, draft, sessionId } = await seedApprovedMappedBundle(s);
    const fulfilled = await fulfillBundle(s, bundle.id, draft, sessionId);
    expect(fulfilled.res?.status).toBe(200);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(res?.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.canceled).toEqual([]);
    expect(body.canceledBundles).toHaveLength(1);
    expect(body.canceledBundles[0].id).toBe(fulfilled.body.purchase.id);
    expect(body.bundleCancelFailed).toBe(false);
    const sub = await bodyOf(await call(s.ctx, "GET", `/payments/agentic/commercial/subscription?userId=u1`, "u1"));
    expect(sub.bundlePurchases[0].status).toBe("canceled");
    expect(sub.bundleEntitlements.every((e: any) => e.status === "canceled")).toBe(true);
    // Replay: nothing live left — the idempotent 409.
    const replay = await call(s.ctx, "POST", "/payments/agentic/commercial/subscription/cancel", "u1", {});
    expect(replay?.status).toBe(409);
  });

  it("a bundle payment ref is refused by the refund flow with the coded 422", async () => {
    const s = await setup({ monetization: true, stripe: true });
    stubBundleStripe();
    const { bundle, draft, sessionId } = await seedApprovedMappedBundle(s);
    const fulfilled = await fulfillBundle(s, bundle.id, draft, sessionId);
    expect(fulfilled.res?.status).toBe(200);
    const res = await call(s.ctx, "POST", "/payments/agentic/commercial/refunds", "u1", {
      kind: "subscription",
      originalPaymentRef: draft,
      amountUSD: 0.06,
      reason: "changed my mind",
    });
    expect(res?.status).toBe(422);
    expect((await bodyOf(res)).code).toBe("FAILURE_BUNDLE_REFUND_UNDECIDED");
  });
});
