/**
 * Issue #3262 — self-service top-up: mint + confirm through
 * handleAgenticPaymentsRoutes, reusing the native verified-payment
 * pattern (subscription checkout/purchase, #2198/#2146).
 *
 * Credit lands ONLY on verified payment (Stripe session retrieve /
 * x402 facilitator verdict, judged server-side against the draft
 * bound at mint), on the server-resolved (user, tenant) from the
 * session identity — never a client-supplied account (#1069 §8).
 * Single currency (USD) only; no additional processors (#1069 §9).
 *
 * Test setup mirrors tests/subscription_routes.test.ts: MockD1Database
 * (node:sqlite) with the commercial + subscription schemas, Stripe
 * stubbed at fetch, facilitator stubbed at fetch for x402.
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
 * tests/subscription_routes.test.ts) plus the x402 facilitator
 * verify endpoint. Stripe evidence defaults to complete + paid +
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

async function accountCredits(ctx: AgenticPaymentsRouteContext, userId: string): Promise<number> {
  const res = await bodyOf(await call(ctx, "GET", `/payments/agentic/commercial/account?userId=${userId}`, userId));
  return res.record.creditsUSD as number;
}

async function mintCard(
  ctx: AgenticPaymentsRouteContext,
  amountUSD: number,
  login = "u1",
): Promise<{ res: Response | null; body: any }> {
  const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", login, {
    amountUSD,
    email: "u1@example.com",
  });
  return { res, body: await bodyOf(res) };
}

describe("top-up checkout (mint)", () => {
  it("flag OFF refuses mint before any Stripe call", async () => {
    const { ctx } = await setup({ stripe: true });
    stubPayments();
    expect((await mintCard(ctx, 25)).res?.status).toBe(403);
  });

  it("anonymous cannot mint; email and a valid amount are required", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    expect((await mintCard(ctx, 25, null)).res?.status).toBe(401);
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
          amountUSD: 25,
        })
      )?.status,
    ).toBe(400);
    expect((await mintCard(ctx, 0)).res?.status).toBe(400);
    expect((await mintCard(ctx, -5)).res?.status).toBe(400);
    expect((await mintCard(ctx, Number.NaN)).res?.status).toBe(400);
    expect((await mintCard(ctx, "25" as unknown as number)).res?.status).toBe(400);
    expect((await mintCard(ctx, 10.555)).res?.status).toBe(400);
  });

  it("amount must sit inside the operator-set bounds (PROPOSED seeds $1–$500)", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    expect((await mintCard(ctx, 0.5)).res?.status).toBe(400);
    expect((await mintCard(ctx, 500.01)).res?.status).toBe(400);
    expect((await mintCard(ctx, 1)).res?.status).toBe(200);
    expect((await mintCard(ctx, 500)).res?.status).toBe(200);
  });

  it("card rail unconfigured fails closed with 503", async () => {
    const { ctx } = await setup({ monetization: true });
    stubPayments();
    expect((await mintCard(ctx, 25)).res?.status).toBe(503);
  });

  it("card mint returns a real checkoutUrl bound to a topup- draft id", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { res, body } = await mintCard(ctx, 25);
    expect(res?.status).toBe(200);
    expect(body.topUpRequestId).toMatch(/^topup-/);
    expect(body.rail).toBe("card");
    expect(body.amountUSD).toBe(25);
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(body.checkoutSessionId).toMatch(/^cs_test_/);
  });

  it("x402 mint returns a challenge bound to the draft amount; unknown rail refused", async () => {
    const { ctx } = await setup({ monetization: true, x402: true });
    stubPayments();
    const { res, body } = await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
      amountUSD: 10,
      rail: "x402",
      email: "u1@example.com",
    }).then(async (r) => ({ res: r, body: await bodyOf(r) }));
    expect(res?.status).toBe(200);
    expect(body.topUpRequestId).toMatch(/^topup-/);
    expect(body.rail).toBe("x402");
    expect(body.challenge.amountUSD).toBe(10);
    expect(body.challenge.recipient).toBe("0x1111111111111111111111111111111111111111");
    expect(typeof body.challenge.nonce).toBe("string");
    expect(body.checkoutId).toBe(body.topUpRequestId);
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
          amountUSD: 10,
          rail: "bogus",
          email: "u1@example.com",
        })
      )?.status,
    ).toBe(400);
  });

  it("x402 rail unconfigured fails closed with 503", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
          amountUSD: 10,
          rail: "x402",
          email: "u1@example.com",
        })
      )?.status,
    ).toBe(503);
  });
});

describe("top-up confirm (card)", () => {
  it("verified payment credits the account, marks the draft, audits, and journals Dr 1000 / Cr 2100", async () => {
    const { ctx, mock, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    expect(await accountCredits(ctx, "u1")).toBe(0);
    const { body } = await mintCard(ctx, 25);
    const confirm = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
        topUpRequestId: body.topUpRequestId,
        checkoutSessionId: body.checkoutSessionId,
      }),
    );
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    // The second confirm above is the replay probe: it must refuse.
    expect(res?.status).toBe(409);
    expect(confirm.creditedUSD).toBe(25);
    expect(confirm.account.creditsUSD).toBe(25);
    expect(await accountCredits(ctx, "u1")).toBe(25);
    expect(audit).toHaveBeenCalledWith(
      "commercial.top_up.credited",
      "payments",
      expect.objectContaining({ topUpRequestId: body.topUpRequestId, amountUSD: 25, rail: "card" }),
    );
    const journal = new D1JournalAdapter(createD1JournalDb(mock as unknown as D1Database));
    const entries = await journal.getEntriesByRef(body.topUpRequestId, "t1");
    expect(entries.map((e) => [e.accountCode, e.debitUSD, e.creditUSD])).toEqual([
      ["1000", 25, 0],
      ["2100", 0, 25],
    ]);
  });

  it("unpaid checkout adds nothing and leaves the draft minted (a later paid confirm still works)", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    const stripe = stubPayments({ evidence: { status: "open", payment_status: "unpaid" } });
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    const denied = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expect(denied?.status).toBe(402);
    expect(await accountCredits(ctx, "u1")).toBe(0);
    stripe.setEvidence({ status: "complete", payment_status: "paid" });
    const ok = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expect(ok?.status).toBe(200);
    expect(await accountCredits(ctx, "u1")).toBe(25);
  });

  it("amount mismatch, reference mismatch, and missing payment intent each refuse with 402 and add nothing", async () => {
    const cases: Array<{ override: Record<string, unknown>; label: string }> = [
      { override: { amount_total: 9999 }, label: "amount" },
      { override: { client_reference_id: "topup-someone-else" }, label: "reference" },
      { override: { payment_intent: null }, label: "intent" },
    ];
    for (const { override } of cases) {
      const { ctx } = await setup({ monetization: true, stripe: true });
      stubPayments({ evidence: override });
      await createAccount(ctx, "u1");
      const { body } = await mintCard(ctx, 25);
      const denied = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
        topUpRequestId: body.topUpRequestId,
        checkoutSessionId: body.checkoutSessionId,
      });
      expect(denied?.status).toBe(402);
      expect(await accountCredits(ctx, "u1")).toBe(0);
    }
  });

  it("unknown draft 404s; another user's draft 403s; flag OFF refuses confirm", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
          topUpRequestId: "topup-nope",
          checkoutSessionId: "cs_test_1",
        })
      )?.status,
    ).toBe(404);
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u2", {
          topUpRequestId: body.topUpRequestId,
          checkoutSessionId: body.checkoutSessionId,
        })
      )?.status,
    ).toBe(403);
    const { ctx: offCtx } = await setup({ stripe: true });
    stubPayments();
    expect(
      (
        await call(offCtx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
          topUpRequestId: body.topUpRequestId,
          checkoutSessionId: body.checkoutSessionId,
        })
      )?.status,
    ).toBe(403);
  });

  it("a fresh user with no account row can mint and confirm; the account is created on verified payment", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const { body } = await mintCard(ctx, 25);
    expect(body.topUpRequestId).toMatch(/^topup-/);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expect(res?.status).toBe(200);
    expect(await accountCredits(ctx, "u1")).toBe(25);
  });

  it("operator-only account/credits is untouched: non-operator 403s, operator still works", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    expect(
      (
        await call(ctx, "POST", "/payments/agentic/commercial/account/credits", "u1", {
          userId: "u1",
          deltaUSD: 5,
        })
      )?.status,
    ).toBe(403);
    const ok = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/account/credits", "op1", {
        userId: "u1",
        deltaUSD: 5,
      }),
    );
    expect(ok.record.creditsUSD).toBe(5);
  });
});

describe("top-up confirm (x402)", () => {
  const payer = "0x2222222222222222222222222222222222222222";
  const proofFor = (nonce: string) =>
    Buffer.from(JSON.stringify({ signature: "0xsig", payer, nonce })).toString("base64");

  it("verified x402 payment credits the account", async () => {
    const { ctx } = await setup({ monetization: true, x402: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const minted = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
        amountUSD: 10,
        rail: "x402",
        email: "u1@example.com",
      }),
    );
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: minted.topUpRequestId,
      paymentProof: proofFor(minted.challenge.nonce),
      payer,
    });
    expect(res?.status).toBe(200);
    expect(await accountCredits(ctx, "u1")).toBe(10);
  });

  it("facilitator refusal, nonce mismatch, and payer mismatch each refuse with 402 and add nothing", async () => {
    const { ctx } = await setup({ monetization: true, x402: true });
    stubPayments({ facilitatorValid: false });
    await createAccount(ctx, "u1");
    const minted = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
        amountUSD: 10,
        rail: "x402",
        email: "u1@example.com",
      }),
    );
    const denied = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: minted.topUpRequestId,
      paymentProof: proofFor(minted.challenge.nonce),
      payer,
    });
    expect(denied?.status).toBe(402);
    expect(await accountCredits(ctx, "u1")).toBe(0);
  });

  it("nonce mismatch refuses even when the facilitator verifies", async () => {
    const { ctx } = await setup({ monetization: true, x402: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const minted = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
        amountUSD: 10,
        rail: "x402",
        email: "u1@example.com",
      }),
    );
    const denied = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: minted.topUpRequestId,
      paymentProof: proofFor("n_some_other_challenge"),
      payer,
    });
    expect(denied?.status).toBe(402);
    expect(await accountCredits(ctx, "u1")).toBe(0);
  });

  it("payer mismatch refuses even when the facilitator verifies", async () => {
    const { ctx } = await setup({ monetization: true, x402: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const minted = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
        amountUSD: 10,
        rail: "x402",
        email: "u1@example.com",
      }),
    );
    const denied = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: minted.topUpRequestId,
      paymentProof: proofFor(minted.challenge.nonce),
      payer: "0x3333333333333333333333333333333333333333",
    });
    expect(denied?.status).toBe(402);
    expect(await accountCredits(ctx, "u1")).toBe(0);
  });
});

describe("pricing top-up limits", () => {
  it("pricing serves the seeded limits; an operator edit is reflected and enforced at mint", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const first = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/pricing", "u1"));
    expect(first.topUpLimits).toEqual({ minUSD: 1, maxUSD: 500 });
    const updated = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/billing-policy", "op1", {
        topUpMinUSD: 5,
        topUpMaxUSD: 100,
      }),
    );
    expect(updated.policy.topUpMinUSD).toBe(5);
    expect(updated.policy.topUpMaxUSD).toBe(100);
    const second = await bodyOf(await call(ctx, "GET", "/payments/agentic/commercial/pricing", "u1"));
    expect(second.topUpLimits).toEqual({ minUSD: 5, maxUSD: 100 });
    expect((await mintCard(ctx, 3)).res?.status).toBe(400);
    expect((await mintCard(ctx, 50)).res?.status).toBe(200);
  });
});
