// @vitest-environment node
/**
 * Issue #3246 (slice 3, sub-issue of #3241) — runs-pack routes
 * through handleAgenticPaymentsRoutes, reusing the native
 * verified-payment pattern (top-up checkout/purchase, #3262).
 *
 * A pack purchase credits a dedicated per-login runs balance —
 * NO tier, NO subscription row, NO expiry in v1. Credit lands
 * ONLY on verified payment (Stripe session retrieve / x402
 * facilitator verdict, judged server-side against the draft
 * bound at mint), on the server-resolved (user, tenant) from
 * the session identity — never a client-supplied account. The
 * pack version must be approved AND active at mint AND at
 * confirm (re-checked after verification, before the claim).
 * A credited draft's confirm returns the SAME 200 success
 * payload (literal idempotency); a crediting draft refuses
 * 409. Single currency (USD) only.
 *
 * Test setup mirrors tests/top_up_3262.test.ts: MockD1Database
 * (node:sqlite) with the commercial + subscription + product +
 * journal schemas, Stripe stubbed at fetch, facilitator stubbed
 * at fetch for x402.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";
import {
  createD1ProductDb,
  D1ProductAdapter,
  ensureProductSchema,
} from "../src/data/d1ProductAdapter";
import {
  createD1RunsPackDb,
  D1RunsPackBalanceAdapter,
  D1RunsPackVersionAdapter,
  ensureRunsPackSchema,
} from "../src/data/d1RunsPackAdapter";
import {
  createD1BillingPolicyDb,
  ensureBillingPolicySchema,
} from "../src/data/d1BillingPolicyAdapter";
import {
  createD1JournalDb,
  D1JournalAdapter,
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";

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

async function setup(opts: { monetization?: boolean; stripe?: boolean; x402?: boolean } = {}) {
  const mock = new MockD1Database();
  const commercialDb = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(commercialDb);
  const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb);
  const productDb = createD1ProductDb(mock as unknown as D1Database);
  await ensureProductSchema(productDb);
  const packDb = createD1RunsPackDb(mock as unknown as D1Database);
  await ensureRunsPackSchema(packDb);
  const policyDb = createD1BillingPolicyDb(mock as unknown as D1Database);
  await ensureBillingPolicySchema(policyDb);
  const journalDb = createD1JournalDb(mock as unknown as D1Database);
  await ensureJournalSchema(journalDb);
  const binding = {
    create: vi.fn(async ({ id, params }: { id: string; params?: unknown }) => ({ workflowId: id })),
    get: vi.fn(async () => ({ status: async () => ({ status: "completed" }) })),
  };
  const screenerBinding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async () => {
      throw new Error("not found");
    }),
  };
  const env: Record<string, unknown> = {
    AGENT_DB: mock,
    COMMERCIAL_STORE_OPERATORS: "op1",
    PAYMENT_WORKFLOW: binding,
    SCREENER_WORKFLOW: screenerBinding,
  };
  if (opts.monetization) env.MONETIZATION_ENABLED = "true";
  if (opts.stripe) env.STRIPE_SECRET_KEY = "sk_test_stub";
  if (opts.x402) {
    env.X402_RECIPIENT_ADDRESS = "0x1111111111111111111111111111111111111111";
    env.X402_FACILITATOR_URL = "https://facilitator.example.invalid";
  }
  const audit = vi.fn();
  const ctx = {
    env,
    getOrm: () => ({}),
    audit,
  } as unknown as AgenticPaymentsRouteContext;
  return { ctx, env, mock, audit };
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
 * Stub fetch as the Stripe REST API (same shape as
 * tests/top_up_3262.test.ts) plus the x402 facilitator verify
 * endpoint. Stripe evidence defaults to complete + paid +
 * amount-matched + reference-matched + a payment intent, unless
 * the test overrides fields via setEvidence.
 */
function stubPayments(opts: { evidence?: Record<string, unknown>; facilitatorValid?: boolean } = {}) {
  const sessions = new Map<string, { draft: string; amount: number }>();
  let counter = 0;
  let evidenceOverrides: Record<string, unknown> = { ...(opts.evidence ?? {}) };
  const facilitatorValid = opts.facilitatorValid ?? true;
  const setEvidence = (partial: Record<string, unknown>) => {
    evidenceOverrides = { ...evidenceOverrides, ...partial };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      const href = String(url);
      if (href === "https://api.stripe.com/v1/checkout/sessions" && init?.method === "POST") {
        const params = new URLSearchParams(String(init.body));
        const draft = params.get("client_reference_id") ?? "";
        const amount = Number(params.get("line_items[0][price_data][unit_amount]") ?? 0);
        counter += 1;
        const id = `cs_test_${counter}`;
        sessions.set(id, { draft, amount });
        return { ok: true, status: 200, json: async () => ({ id, url: `https://checkout.stripe.com/pay/${id}` }) };
      }
      const m = href.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/([^/]+)$/);
      if (m && init?.method === "GET") {
        const session = sessions.get(decodeURIComponent(m[1]));
        if (!session) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
        const evidence = {
          id: decodeURIComponent(m[1]),
          status: "complete",
          payment_status: "paid",
          amount_total: session.amount,
          client_reference_id: session.draft,
          payment_intent: "pi_test_1",
          ...evidenceOverrides,
        };
        return { ok: true, status: 200, json: async () => evidence };
      }
      if (href === "https://facilitator.example.invalid/verify" && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ isValid: facilitatorValid }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  return { setEvidence };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createAccount(ctx: AgenticPaymentsRouteContext, userId: string, tenantId = "t1") {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/account", "op1", {
    userId,
    tenantId,
    tier: "Free",
  });
  expect(res?.status).toBe(200);
}

async function seedPackProduct(mock: MockD1Database, name = "Pack of 10") {
  const products = new D1ProductAdapter(createD1ProductDb(mock as unknown as D1Database));
  return products.getOrCreateProduct({ name, kind: "runs_pack" });
}

async function seedPackVersion(
  mock: MockD1Database,
  productId: string,
  opts: { runs?: number; priceUSD?: number; approve?: boolean } = {},
) {
  const versions = new D1RunsPackVersionAdapter(createD1RunsPackDb(mock as unknown as D1Database));
  const version = await versions.createVersion({
    productId,
    runs: opts.runs ?? 10,
    priceUSD: opts.priceUSD ?? 4.99,
  });
  if (opts.approve) await versions.approveVersion(version.id, "op1");
  return version;
}

async function packBalance(mock: MockD1Database, login: string): Promise<number> {
  const balance = new D1RunsPackBalanceAdapter(createD1RunsPackDb(mock as unknown as D1Database));
  return balance.getBalance(login);
}

async function accountTier(mock: MockD1Database, login: string): Promise<string | null> {
  const store = new D1CommercialAdapter(createD1CommercialDb(mock as unknown as D1Database));
  return (await store.getAccount(login))?.tier ?? null;
}

async function subscriptionCount(mock: MockD1Database, login: string): Promise<number> {
  const subs = new D1SubscriptionAdapter(createD1SubscriptionDb(mock as unknown as D1Database));
  return (await subs.listSubscriptions(login)).length;
}

async function journalEntries(mock: MockD1Database, ref: string, tenantId = "t1") {
  const journal = new D1JournalAdapter(createD1JournalDb(mock as unknown as D1Database));
  return journal.getEntriesByRef(ref, tenantId);
}

async function mintCard(
  ctx: AgenticPaymentsRouteContext,
  versionId: string,
  login = "u1",
  extra: Record<string, unknown> = {},
): Promise<{ res: Response | null; body: any }> {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/checkout", login, {
    versionId,
    email: "u1@example.com",
    ...extra,
  });
  return { res, body: await bodyOf(res) };
}

async function confirmCard(
  ctx: AgenticPaymentsRouteContext,
  packRequestId: string,
  checkoutSessionId: string,
  login = "u1",
) {
  return call(ctx, "POST", "/payments/agentic/commercial/runs-packs/confirm", login, {
    packRequestId,
    checkoutSessionId,
  });
}

describe("runs-pack checkout (mint)", () => {
  it("flag OFF refuses mint before any Stripe call", async () => {
    const { ctx, mock } = await setup({ stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    expect((await mintCard(ctx, version.id)).res?.status).toBe(403);
  });

  it("anonymous cannot mint; email and versionId are required; an unknown version 404s", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    expect((await mintCard(ctx, version.id, null)).res?.status).toBe(401);
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/checkout", "u1", {
          versionId: version.id,
        })
      )?.status,
    ).toBe(400);
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/checkout", "u1", {
          email: "u1@example.com",
        })
      )?.status,
    ).toBe(400);
    expect((await mintCard(ctx, "packver-missing")).res?.status).toBe(404);
  });

  it("a PROPOSED version refuses with FAILURE_RUNS_PACK_NO_APPROVED_PRICE (409)", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id);
    const { res, body } = await mintCard(ctx, version.id);
    expect(res?.status).toBe(409);
    expect(body.code).toBe("FAILURE_RUNS_PACK_NO_APPROVED_PRICE");
  });

  it("a deactivated version refuses with a plain 409", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const versions = new D1RunsPackVersionAdapter(createD1RunsPackDb(mock as unknown as D1Database));
    await versions.deactivateVersion(version.id);
    const { res, body } = await mintCard(ctx, version.id);
    expect(res?.status).toBe(409);
    expect(body.code).toBeUndefined();
    expect(body.error).toMatch(/not active/);
  });

  it("card mint returns a real checkoutUrl bound to a pack- draft id, and audits checkout_created", async () => {
    const { ctx, mock, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { res, body } = await mintCard(ctx, version.id);
    expect(res?.status).toBe(200);
    expect(body.packRequestId).toMatch(/^pack-/);
    expect(body.rail).toBe("card");
    expect(body.runs).toBe(10);
    expect(body.priceUSD).toBe(4.99);
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(body.checkoutSessionId).toMatch(/^cs_test_/);
    expect(audit).toHaveBeenCalledWith(
      "commercial.runs_pack.checkout_created",
      "payments",
      expect.objectContaining({
        packRequestId: body.packRequestId,
        versionId: version.id,
        productId: product.id,
        runs: 10,
        priceUSD: 4.99,
        rail: "card",
      }),
    );
  });

  it("x402 mint returns a challenge bound to the draft price; unknown rail refused", async () => {
    const { ctx, mock } = await setup({ monetization: true, x402: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { res, body } = await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/checkout", "u1", {
      versionId: version.id,
      rail: "x402",
      email: "u1@example.com",
    }).then(async (r) => ({ res: r, body: await bodyOf(r) }));
    expect(res?.status).toBe(200);
    expect(body.packRequestId).toMatch(/^pack-/);
    expect(body.rail).toBe("x402");
    expect(body.runs).toBe(10);
    expect(body.priceUSD).toBe(4.99);
    expect(body.checkoutId).toBe(body.packRequestId);
    expect(body.challenge.amountUSD).toBe(4.99);
    expect(body.challenge.recipient).toBe("0x1111111111111111111111111111111111111111");
    expect(typeof body.challenge.nonce).toBe("string");
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/checkout", "u1", {
          versionId: version.id,
          rail: "bogus",
          email: "u1@example.com",
        })
      )?.status,
    ).toBe(400);
  });

  it("card rail unconfigured fails closed with 503", async () => {
    const { ctx, mock } = await setup({ monetization: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { res, body } = await mintCard(ctx, version.id);
    expect(res?.status).toBe(503);
    expect(body.code).toBe("FAILURE_RUNS_PACK_UNAVAILABLE");
  });

  it("an offerContext on the mint audits commercial.offer.accepted with action runs_pack", async () => {
    const { ctx, mock, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { res, body } = await mintCard(ctx, version.id, "u1", {
      offerContext: { trigger: "manual_402", shownAtMs: 123 },
    });
    expect(res?.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      "commercial.offer.accepted",
      "payments",
      expect.objectContaining({
        login: "u1",
        trigger: "manual_402",
        action: "runs_pack",
        checkoutId: body.checkoutSessionId,
        shownAtMs: 123,
      }),
    );
  });
});

describe("runs-pack confirm (card)", () => {
  it("verified payment credits the pack balance, audits, and journals Dr 1000 / Cr 4000 — with NO tier and NO subscription row", async () => {
    const { ctx, mock, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    expect(await packBalance(mock, "u1")).toBe(0);
    const { body } = await mintCard(ctx, version.id);
    const res = await confirmCard(ctx, body.packRequestId, body.checkoutSessionId);
    expect(res?.status).toBe(200);
    const confirmed = await bodyOf(res);
    expect(confirmed).toMatchObject({
      packRequestId: body.packRequestId,
      creditedRuns: 10,
      rail: "card",
      packRunsRemaining: 10,
      code: "SUCCESS_RUNS_PACK_PURCHASED",
      message: "The runs pack was purchased and its runs were added to your pack balance.",
    });
    expect(confirmed.account.tier).toBe("Free");
    expect(await packBalance(mock, "u1")).toBe(10);
    // A pack purchase confers NO tier and creates NO subscription row.
    expect(await accountTier(mock, "u1")).toBe("Free");
    expect(await subscriptionCount(mock, "u1")).toBe(0);
    expect(audit).toHaveBeenCalledWith(
      "commercial.runs_pack.purchased",
      "payments",
      expect.objectContaining({
        packRequestId: body.packRequestId,
        versionId: version.id,
        productId: product.id,
        runs: 10,
        priceUSD: 4.99,
        rail: "card",
        packRunsRemaining: 10,
      }),
    );
    const entries = await journalEntries(mock, body.packRequestId);
    expect(entries.map((e) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["1000", 4.99, 0],
      ["4000", 0, 4.99],
    ]);
    expect(entries[0].productId).toBe(product.id);
    expect(entries[0].versionId).toBe(version.id);
    expect(entries[0].family).toBe("runs_pack");
  });

  it("confirm twice returns the same 200 payload and credits the balance exactly once", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { body } = await mintCard(ctx, version.id);
    const first = await bodyOf(await confirmCard(ctx, body.packRequestId, body.checkoutSessionId));
    const secondRes = await confirmCard(ctx, body.packRequestId, body.checkoutSessionId);
    expect(secondRes?.status).toBe(200);
    const second = await bodyOf(secondRes);
    expect(second).toEqual(first);
    expect(await packBalance(mock, "u1")).toBe(10);
  });

  it("unpaid checkout refuses 402 FAILURE_RUNS_PACK_NOT_PAID: no credit, no journal", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    const stripe = stubPayments({ evidence: { status: "open", payment_status: "unpaid" } });
    await createAccount(ctx, "u1");
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { body } = await mintCard(ctx, version.id);
    const denied = await confirmCard(ctx, body.packRequestId, body.checkoutSessionId);
    expect(denied?.status).toBe(402);
    expect((await bodyOf(denied)).code).toBe("FAILURE_RUNS_PACK_NOT_PAID");
    expect(await packBalance(mock, "u1")).toBe(0);
    expect(await journalEntries(mock, body.packRequestId)).toEqual([]);
    // The draft stays minted: a later paid confirm still works.
    stripe.setEvidence({ status: "complete", payment_status: "paid" });
    const ok = await confirmCard(ctx, body.packRequestId, body.checkoutSessionId);
    expect(ok?.status).toBe(200);
    expect(await packBalance(mock, "u1")).toBe(10);
  });

  it("a version deactivated after mint refuses confirm with 409 and credits nothing", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { body } = await mintCard(ctx, version.id);
    const versions = new D1RunsPackVersionAdapter(createD1RunsPackDb(mock as unknown as D1Database));
    await versions.deactivateVersion(version.id);
    const refused = await confirmCard(ctx, body.packRequestId, body.checkoutSessionId);
    expect(refused?.status).toBe(409);
    expect(await packBalance(mock, "u1")).toBe(0);
    expect(await journalEntries(mock, body.packRequestId)).toEqual([]);
  });

  it("unknown draft 404s; another user's draft 403s; flag OFF refuses confirm", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { body } = await mintCard(ctx, version.id);
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/confirm", "u1", {
          packRequestId: "pack-nope",
          checkoutSessionId: "cs_test_1",
        })
      )?.status,
    ).toBe(404);
    expect(
      (await confirmCard(ctx, body.packRequestId, body.checkoutSessionId, "u2"))?.status,
    ).toBe(403);
    const { ctx: offCtx } = await setup({ stripe: true });
    stubPayments();
    expect(
      (
        await call(offCtx, "POST", "/payments/agentic/commercial/runs-packs/confirm", "u1", {
          packRequestId: body.packRequestId,
          checkoutSessionId: body.checkoutSessionId,
        })
      )?.status,
    ).toBe(403);
  });

  it("a fresh user with no account row can mint and confirm; the account is created Free with no subscription", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const { body } = await mintCard(ctx, version.id);
    expect(body.packRequestId).toMatch(/^pack-/);
    const res = await confirmCard(ctx, body.packRequestId, body.checkoutSessionId);
    expect(res?.status).toBe(200);
    expect(await packBalance(mock, "u1")).toBe(10);
    expect(await accountTier(mock, "u1")).toBe("Free");
    expect(await subscriptionCount(mock, "u1")).toBe(0);
  });
});

describe("runs-pack confirm (x402)", () => {
  const payer = "0x2222222222222222222222222222222222222222";
  const proofFor = (nonce: string) =>
    Buffer.from(JSON.stringify({ signature: "0xsig", payer, nonce })).toString("base64");

  it("verified x402 payment credits the pack balance", async () => {
    const { ctx, mock } = await setup({ monetization: true, x402: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const product = await seedPackProduct(mock);
    const version = await seedPackVersion(mock, product.id, { approve: true });
    const minted = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/checkout", "u1", {
        versionId: version.id,
        rail: "x402",
        email: "u1@example.com",
      }),
    );
    const res = await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/confirm", "u1", {
      packRequestId: minted.packRequestId,
      paymentProof: proofFor(minted.challenge.nonce),
      payer,
    });
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).creditedRuns).toBe(10);
    expect(await packBalance(mock, "u1")).toBe(10);
  });

  it("facilitator refusal and nonce mismatch each refuse with 402 and add nothing", async () => {
    for (const facilitatorValid of [false, true]) {
      const { ctx, mock } = await setup({ monetization: true, x402: true });
      stubPayments({ facilitatorValid });
      await createAccount(ctx, "u1");
      const product = await seedPackProduct(mock);
      const version = await seedPackVersion(mock, product.id, { approve: true });
      const minted = await bodyOf(
        await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/checkout", "u1", {
          versionId: version.id,
          rail: "x402",
          email: "u1@example.com",
        }),
      );
      const nonce = facilitatorValid ? "n_some_other_challenge" : minted.challenge.nonce;
      const denied = await call(ctx, "POST", "/payments/agentic/commercial/runs-packs/confirm", "u1", {
        packRequestId: minted.packRequestId,
        paymentProof: proofFor(nonce),
        payer,
      });
      expect(denied?.status).toBe(402);
      expect((await bodyOf(denied)).code).toBe("FAILURE_RUNS_PACK_NOT_PAID");
      expect(await packBalance(mock, "u1")).toBe(0);
    }
  });
});

describe("runs-pack version routes (operator)", () => {
  const versionsPath = (productId: string) => `/payments/agentic/commercial/products/${productId}/versions`;

  it("POST /products/:productId/versions creates a pack version: PROPOSED, version numbers increment", async () => {
    const { ctx, mock, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock, "Pack of 5");
    const first = await bodyOf(
      await call(ctx, "POST", versionsPath(product.id), "op1", { runs: 5, priceUSD: 4.99 }),
    );
    expect(first.version).toMatchObject({
      productId: product.id,
      version: 1,
      segment: "default",
      runs: 5,
      priceUSD: 4.99,
      approvalStatus: "proposed",
      approvedBy: null,
      active: true,
    });
    const second = await bodyOf(
      await call(ctx, "POST", versionsPath(product.id), "op1", { runs: 10, priceUSD: 9.99 }),
    );
    expect(second.version.version).toBe(2);
    expect(audit).toHaveBeenCalledWith(
      "commercial.runs_pack.version.created",
      "payments",
      expect.objectContaining({ productId: product.id, versionId: first.version.id, version: 1 }),
    );
  });

  it("pack version creation rejects invalid terms with 400", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    for (const bad of [
      { runs: 0, priceUSD: 4.99 },
      { runs: -5, priceUSD: 4.99 },
      { runs: 10, priceUSD: 0 },
      { priceUSD: 4.99 },
      { runs: 10 },
    ]) {
      expect((await call(ctx, "POST", versionsPath(product.id), "op1", bad))?.status).toBe(400);
    }
    expect(
      (await call(ctx, "POST", versionsPath("prod-missing"), "op1", { runs: 10, priceUSD: 4.99 }))?.status,
    ).toBe(404);
  });

  it("a valid 2-decimal price (2.49) creates a version (validator tolerates binary-float error)", async () => {
    // Price validation rejects price <= 0 and > 2 decimals;
    // 2.49 has exactly two decimals and must be accepted (the
    // validator compares with a tolerance: 2.49 * 100 is
    // 249.00000000000003, which an exact compare rejects).
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const res = await call(ctx, "POST", versionsPath(product.id), "op1", { runs: 5, priceUSD: 2.49 });
    expect(res?.status).toBe(200);
    expect((await bodyOf(res)).version).toMatchObject({ runs: 5, priceUSD: 2.49 });
  });

  it("a > 2-decimal price (10.555) is a 400, not a 500 (validator wording matches the route's 400 pattern)", async () => {
    // The version-create catch maps /required|must be|Invalid/ to
    // 400; the validator's message is worded "must be a value
    // with at most two decimal places" so a client validation
    // error returns 400, never 500.
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const res = await call(ctx, "POST", versionsPath(product.id), "op1", { runs: 10, priceUSD: 10.555 });
    expect(res?.status).toBe(400);
  });

  it("approve/deactivate version routes return the version and audit", async () => {
    const { ctx, mock, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const created = await bodyOf(
      await call(ctx, "POST", versionsPath(product.id), "op1", { runs: 10, priceUSD: 4.99 }),
    );
    const versionId = created.version.id as string;
    const approved = await bodyOf(
      await call(ctx, "POST", `${versionsPath(product.id)}/${versionId}/approve`, "op1", {}),
    );
    expect(approved.version).toMatchObject({ id: versionId, approvalStatus: "approved", approvedBy: "op1" });
    expect(audit).toHaveBeenCalledWith(
      "commercial.runs_pack.version.approved",
      "payments",
      expect.objectContaining({ versionId, productId: product.id, approvedBy: "op1" }),
    );
    const deactivated = await bodyOf(
      await call(ctx, "POST", `${versionsPath(product.id)}/${versionId}/deactivate`, "op1", {}),
    );
    expect(deactivated.version).toMatchObject({ id: versionId, active: false });
    expect(audit).toHaveBeenCalledWith(
      "commercial.runs_pack.version.deactivated",
      "payments",
      expect.objectContaining({ versionId, productId: product.id }),
    );
    expect(
      (
        await call(ctx, "POST", `${versionsPath(product.id)}/packver-missing/approve`, "op1", {})
      )?.status,
    ).toBe(404);
  });

  it("pack version routes are operator-only", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    expect(
      (await call(ctx, "POST", versionsPath(product.id), "u1", { runs: 10, priceUSD: 4.99 }))?.status,
    ).toBe(403);
    expect((await call(ctx, "POST", versionsPath(product.id), null, { runs: 10, priceUSD: 4.99 }))?.status).toBe(
      401,
    );
  });

  it("GET /products/:productId/versions lists the pack versions", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const product = await seedPackProduct(mock);
    const created = await bodyOf(
      await call(ctx, "POST", versionsPath(product.id), "op1", { runs: 10, priceUSD: 4.99 }),
    );
    const chain = await bodyOf(await call(ctx, "GET", versionsPath(product.id), "op1"));
    expect(chain.product.id).toBe(product.id);
    expect(chain.versions.map((v: { id: string }) => v.id)).toEqual([created.version.id]);
    expect(chain.versions[0]).toMatchObject({ runs: 10, priceUSD: 4.99, approvalStatus: "proposed" });
  });
});
