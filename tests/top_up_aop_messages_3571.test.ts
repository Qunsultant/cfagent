/**
 * Issue #3571 — top-up AOP conformance: every mint/confirm outcome
 * is catalog-coded.
 *
 * Pins the F1 gaps from the #3262 post-merge audit:
 * - mint + confirm SUCCESS carry `code` + the catalog message;
 * - every failure status carries a resolving catalog code whose
 *   message comes FROM the catalog (read via resolveOutcome, never
 *   a hardcoded string in the test);
 * - no raw error text leaves the API (a sentinel thrown message
 *   never appears in any body; no `error` field on coded bodies);
 * - audit payloads carry code + message, and the mint audit
 *   carries `checkoutSessionId`;
 * - aspect logging fires on the failure paths (structured
 *   `aspect.event` with the code);
 * - cross-tenant confirm refuses (same login, draft tenant A,
 *   identity tenant B).
 *
 * The classification is structural, not string-matching: expected
 * messages are read from the catalog at test time (#2573).
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import { resolveOutcome } from "../src/outcomes/outcomeAspects";
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
  ensureJournalSchema,
} from "../src/data/d1JournalAdapter";
import {
  createD1TopUpDb,
  D1TopUpAdapter,
} from "../src/data/d1TopUpAdapter";

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

type SqlOp = "run" | "all" | "first" | "raw";
const SENTINEL = "SENTINEL_DB_FAILURE_3571";

/**
 * Mock that throws a sentinel on selected SQL, so a store failure
 * can be forced at an exact layer (policy read, identity read,
 * schema ensure, draft insert, draft mark, credit update) while
 * the rest of the flow runs against real SQLite.
 */
class FailingMockD1Database extends MockD1Database {
  constructor(private readonly failOn: (sql: string, op: SqlOp) => boolean) {
    super();
  }
  override prepare(sql: string) {
    const base = super.prepare(sql);
    const failOn = this.failOn;
    return {
      bind(...params: unknown[]) {
        const bound = base.bind(...params);
        const guard = (op: SqlOp, fn: () => Promise<unknown>) => async () => {
          if (failOn(sql, op)) throw new Error(SENTINEL);
          return fn();
        };
        return {
          run: guard("run", () => bound.run()),
          all: guard("all", () => bound.all()),
          first: guard("first", () => bound.first()),
          raw: guard("raw", () => bound.raw()),
        };
      },
    };
  }
}

async function setup(opts: {
  monetization?: boolean;
  stripe?: boolean;
  x402?: boolean;
  db?: MockD1Database;
} = {}) {
  const mock = opts.db ?? new MockD1Database();
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
 * Stub fetch as the Stripe REST API plus the x402 facilitator
 * verify endpoint (same shape as tests/top_up_3262.test.ts).
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
  vi.restoreAllMocks();
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

/** The catalog business message for a code, read FROM the catalog. */
function catalogMessage(code: string): string {
  const resolved = resolveOutcome(code);
  expect(resolved.resolved).toBe(true);
  return resolved.businessMessage as string;
}

/** Assert a coded body: resolving code, catalog message, no raw `error` field. */
function expectCoded(body: any, res: Response | null, status: number, code: string) {
  expect(res?.status).toBe(status);
  expect(body.code).toBe(code);
  expect(body.message).toBe(catalogMessage(code));
  expect(body.error).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(SENTINEL);
}

/** Collect console.info JSON lines (the unbound structured-log sink). */
function spyConsoleInfo() {
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  return lines;
}

function aspectLines(lines: string[], code: string): string[] {
  return lines.filter((line) => {
    try {
      const parsed = JSON.parse(line) as { fields?: Record<string, unknown> };
      const fields = parsed.fields ?? {};
      return (
        (parsed as { operation?: string }).operation === "aspect.event" &&
        JSON.stringify(fields).includes(code)
      );
    } catch {
      return line.includes("aspect.event") && line.includes(code);
    }
  });
}

describe("top-up success carries the catalog code (#3571)", () => {
  it("card mint returns SUCCESS_TOP_UP_CHECKOUT_CREATED with the catalog message", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { res, body } = await mintCard(ctx, 25);
    expectCoded(body, res, 200, "SUCCESS_TOP_UP_CHECKOUT_CREATED");
    expect(body.topUpRequestId).toMatch(/^topup-/);
    expect(body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("x402 mint returns SUCCESS_TOP_UP_CHECKOUT_CREATED with the catalog message", async () => {
    const { ctx } = await setup({ monetization: true, x402: true });
    stubPayments();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
      amountUSD: 10,
      rail: "x402",
      email: "u1@example.com",
    });
    const body = await bodyOf(res);
    expectCoded(body, res, 200, "SUCCESS_TOP_UP_CHECKOUT_CREATED");
    expect(body.challenge.amountUSD).toBe(10);
  });

  it("card confirm returns SUCCESS_TOP_UP_CREDITED with the catalog message", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    const confirm = await bodyOf(res);
    expectCoded(confirm, res, 200, "SUCCESS_TOP_UP_CREDITED");
    expect(confirm.creditedUSD).toBe(25);
    expect(confirm.account.creditsUSD).toBe(25);
  });

  it("a fresh user with no account row still confirms with the catalog code", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const { body } = await mintCard(ctx, 25);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expectCoded(await bodyOf(res), res, 200, "SUCCESS_TOP_UP_CREDITED");
  });
});

describe("top-up mint failures are catalog-coded (#3571)", () => {
  it("anonymous mint -> 401 FAILURE_TOP_UP_UNAUTHORIZED", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const { res, body } = await mintCard(ctx, 25, null);
    expectCoded(body, res, 401, "FAILURE_TOP_UP_UNAUTHORIZED");
  });

  it("missing email and unknown rail -> 400 FAILURE_TOP_UP_VALIDATION", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const noEmail = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", { amountUSD: 25 }),
    );
    const noEmailRes = await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
      amountUSD: 25,
    });
    expectCoded(noEmail, noEmailRes, 400, "FAILURE_TOP_UP_VALIDATION");
    const badRail = await bodyOf(
      await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
        amountUSD: 10,
        rail: "bogus",
        email: "u1@example.com",
      }),
    );
    const badRailRes = await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
      amountUSD: 10,
      rail: "bogus",
      email: "u1@example.com",
    });
    expectCoded(badRail, badRailRes, 400, "FAILURE_TOP_UP_VALIDATION");
  });

  it("invalid amount -> 400 FAILURE_TOP_UP_AMOUNT_INVALID with the catalog message", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    for (const amount of [0, -5, 10.555]) {
      const { res, body } = await mintCard(ctx, amount);
      expectCoded(body, res, 400, "FAILURE_TOP_UP_AMOUNT_INVALID");
    }
  });

  it("unconfigured rail -> 503 FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE", async () => {
    const { ctx } = await setup({ monetization: true });
    stubPayments();
    const { res, body } = await mintCard(ctx, 25);
    expectCoded(body, res, 503, "FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE");
  });

  it("billing-policy read failure -> 503 FAILURE_TOP_UP_STORE_UNAVAILABLE, no raw text leaks", async () => {
    const db = new FailingMockD1Database(
      (sql) => /\bselect\b/i.test(sql) && sql.toLowerCase().includes("agent_billing_policy"),
    );
    const { ctx } = await setup({ monetization: true, stripe: true, db });
    stubPayments();
    const { res, body } = await mintCard(ctx, 25);
    expectCoded(body, res, 503, "FAILURE_TOP_UP_STORE_UNAVAILABLE");
  });

  it("identity resolution failure -> 503 FAILURE_TOP_UP_STORE_UNAVAILABLE, no raw text leaks", async () => {
    const db = new FailingMockD1Database(
      (sql) => /\bselect\b/i.test(sql) && sql.toLowerCase().includes("agent_subscriptions"),
    );
    const { ctx } = await setup({ monetization: true, stripe: true, db });
    stubPayments();
    const { res, body } = await mintCard(ctx, 25);
    expectCoded(body, res, 503, "FAILURE_TOP_UP_STORE_UNAVAILABLE");
  });

  it("top-up schema ensure failure -> 503 FAILURE_TOP_UP_STORE_UNAVAILABLE", async () => {
    const db = new FailingMockD1Database(
      (sql) => /create table/i.test(sql) && sql.toLowerCase().includes("agent_top_up_drafts"),
    );
    const { ctx } = await setup({ monetization: true, stripe: true, db });
    stubPayments();
    const { res, body } = await mintCard(ctx, 25);
    expectCoded(body, res, 503, "FAILURE_TOP_UP_STORE_UNAVAILABLE");
  });

  it("draft record failure -> 500 FAILURE_TOP_UP_DRAFT_RECORD_FAILED, no raw text leaks", async () => {
    const db = new FailingMockD1Database(
      (sql) => /insert into/i.test(sql) && sql.toLowerCase().includes("agent_top_up_drafts"),
    );
    const { ctx } = await setup({ monetization: true, stripe: true, db });
    stubPayments();
    const { res, body } = await mintCard(ctx, 25);
    expectCoded(body, res, 500, "FAILURE_TOP_UP_DRAFT_RECORD_FAILED");
  });
});

describe("top-up confirm failures are catalog-coded (#3571)", () => {
  it("anonymous confirm -> 401 FAILURE_TOP_UP_UNAUTHORIZED", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", null, {
      topUpRequestId: "topup-nope",
    });
    expectCoded(await bodyOf(res), res, 401, "FAILURE_TOP_UP_UNAUTHORIZED");
  });

  it("missing topUpRequestId and missing paymentProof -> 400 FAILURE_TOP_UP_VALIDATION", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const missingId = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {});
    expectCoded(await bodyOf(missingId), missingId, 400, "FAILURE_TOP_UP_VALIDATION");
    const { ctx: x402Ctx } = await setup({ monetization: true, x402: true });
    stubPayments();
    const minted = await bodyOf(
      await call(x402Ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", {
        amountUSD: 10,
        rail: "x402",
        email: "u1@example.com",
      }),
    );
    const missingProof = await call(x402Ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: minted.topUpRequestId,
    });
    expectCoded(await bodyOf(missingProof), missingProof, 400, "FAILURE_TOP_UP_VALIDATION");
  });

  it("unknown draft -> 404 FAILURE_TOP_UP_NOT_FOUND", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: "topup-nope",
      checkoutSessionId: "cs_test_1",
    });
    expectCoded(await bodyOf(res), res, 404, "FAILURE_TOP_UP_NOT_FOUND");
  });

  it("another user's draft -> 403 FAILURE_TOP_UP_FORBIDDEN", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u2", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expectCoded(await bodyOf(res), res, 403, "FAILURE_TOP_UP_FORBIDDEN");
    expect(await accountCredits(ctx, "u1")).toBe(0);
  });

  it("unpaid checkout -> 402 FAILURE_TOP_UP_NOT_PAID with the catalog message", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments({ evidence: { status: "open", payment_status: "unpaid" } });
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expectCoded(await bodyOf(res), res, 402, "FAILURE_TOP_UP_NOT_PAID");
    expect(await accountCredits(ctx, "u1")).toBe(0);
  });

  it("replay confirm -> 409 FAILURE_TOP_UP_REPLAY with the catalog message", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    const first = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expect(first?.status).toBe(200);
    const replay = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expectCoded(await bodyOf(replay), replay, 409, "FAILURE_TOP_UP_REPLAY");
  });

  it("unconfigured rail at confirm -> 503 FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE", async () => {
    const { ctx, env, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    const envNoStripe = { ...env };
    delete envNoStripe.STRIPE_SECRET_KEY;
    const ctxNoStripe = { ...ctx, env: envNoStripe } as unknown as AgenticPaymentsRouteContext;
    void mock;
    const res = await call(ctxNoStripe, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expectCoded(await bodyOf(res), res, 503, "FAILURE_TOP_UP_CHECKOUT_UNAVAILABLE");
  });

  it("missing checkoutSessionId on a card draft without one stored -> 400 FAILURE_TOP_UP_VALIDATION", async () => {
    const { ctx, mock } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const topUpDb = createD1TopUpDb(mock as unknown as D1Database);
    const { ensureTopUpSchema } = await import("../src/data/d1TopUpAdapter");
    await ensureTopUpSchema(topUpDb);
    const adapter = new D1TopUpAdapter(topUpDb);
    await adapter.createDraft({
      id: "topup-manual-1",
      userLogin: "u1",
      tenantId: "t1",
      email: "u1@example.com",
      amountUSD: 25,
      rail: "card",
      status: "minted",
      createdAtMs: Date.now(),
      creditedAtMs: null,
      paymentIntentId: null,
      checkoutSessionId: null,
      challengeNonce: null,
    });
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: "topup-manual-1",
    });
    expectCoded(await bodyOf(res), res, 400, "FAILURE_TOP_UP_VALIDATION");
  });

  it("credit landed but draft mark failed -> 500 FAILURE_TOP_UP_CREDIT_MARK_FAILED with the draft id as a field", async () => {
    // Fail ONLY the mark update: on main (#3572) both the claim and
    // the mark are conditional updates with .returning(), which
    // Drizzle executes via raw() — and the claim must succeed so the
    // credit lands before the mark fails. The mark is the update
    // whose SET clause assigns credited_at_ms; the claim only sets
    // status (its RETURNING list also names the column, so a bare
    // name match would catch the claim too — match the assignment).
    const db = new FailingMockD1Database(
      (sql, op) =>
        (op === "run" || op === "all" || op === "raw") &&
        /update/i.test(sql) &&
        sql.toLowerCase().includes("agent_top_up_drafts") &&
        sql.includes('"credited_at_ms" = ?'),
    );
    const { ctx } = await setup({ monetization: true, stripe: true, db });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    const failed = await bodyOf(res);
    expectCoded(failed, res, 500, "FAILURE_TOP_UP_CREDIT_MARK_FAILED");
    expect(failed.topUpRequestId).toBe(body.topUpRequestId);
    expect(await accountCredits(ctx, "u1")).toBe(25);
  });

  it("unexpected credit failure -> 500 FAILURE_TOP_UP_UNEXPECTED, no raw text leaks", async () => {
    let armed = false;
    const db = new FailingMockD1Database(
      (sql, op) =>
        armed && op === "run" && sql.toLowerCase().includes("agent_commercial_accounts") &&
        (/update/i.test(sql) || /on conflict/i.test(sql)),
    );
    const { ctx } = await setup({ monetization: true, stripe: true, db });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    armed = true;
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expectCoded(await bodyOf(res), res, 500, "FAILURE_TOP_UP_UNEXPECTED");
    expect(await accountCredits(ctx, "u1")).toBe(0);
  });
});

describe("top-up audit payloads carry code + message (#3571)", () => {
  it("mint audit carries the checkout code, message, and checkoutSessionId", async () => {
    const { ctx, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    expect(audit).toHaveBeenCalledWith(
      "commercial.top_up.checkout_created",
      "payments",
      expect.objectContaining({
        code: "SUCCESS_TOP_UP_CHECKOUT_CREATED",
        message: catalogMessage("SUCCESS_TOP_UP_CHECKOUT_CREATED"),
        topUpRequestId: body.topUpRequestId,
        checkoutSessionId: body.checkoutSessionId,
      }),
    );
  });

  it("credit audit carries the credited code and message", async () => {
    const { ctx, audit } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expect(audit).toHaveBeenCalledWith(
      "commercial.top_up.credited",
      "payments",
      expect.objectContaining({
        code: "SUCCESS_TOP_UP_CREDITED",
        message: catalogMessage("SUCCESS_TOP_UP_CREDITED"),
        topUpRequestId: body.topUpRequestId,
        amountUSD: 25,
      }),
    );
  });
});

describe("top-up aspect logging fires with the code (#3571)", () => {
  it("a validation failure emits a structured aspect.event with the code", async () => {
    const lines = spyConsoleInfo();
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await call(ctx, "POST", "/payments/agentic/commercial/top-up/checkout", "u1", { amountUSD: 25 });
    expect(aspectLines(lines, "FAILURE_TOP_UP_VALIDATION").length).toBeGreaterThan(0);
  });

  it("a paid-confirm failure emits a structured aspect.event with the code", async () => {
    const lines = spyConsoleInfo();
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments({ evidence: { status: "open", payment_status: "unpaid" } });
    await createAccount(ctx, "u1");
    const { body } = await mintCard(ctx, 25);
    await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expect(aspectLines(lines, "FAILURE_TOP_UP_NOT_PAID").length).toBeGreaterThan(0);
  });

  it("a mint success emits a structured aspect.event with the checkout code", async () => {
    const lines = spyConsoleInfo();
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1");
    await mintCard(ctx, 25);
    expect(aspectLines(lines, "SUCCESS_TOP_UP_CHECKOUT_CREATED").length).toBeGreaterThan(0);
  });
});

describe("top-up cross-tenant confirm refuses (#3571)", () => {
  it("same login, draft tenant A, identity tenant B -> 403 FAILURE_TOP_UP_FORBIDDEN, no credit", async () => {
    const { ctx } = await setup({ monetization: true, stripe: true });
    stubPayments();
    await createAccount(ctx, "u1", "t1");
    const { body } = await mintCard(ctx, 25);
    // The account moves tenants after mint (operator re-provision):
    // the identity now resolves to t2 while the draft belongs to t1.
    await createAccount(ctx, "u1", "t2");
    const res = await call(ctx, "POST", "/payments/agentic/commercial/top-up/confirm", "u1", {
      topUpRequestId: body.topUpRequestId,
      checkoutSessionId: body.checkoutSessionId,
    });
    expectCoded(await bodyOf(res), res, 403, "FAILURE_TOP_UP_FORBIDDEN");
    expect(await accountCredits(ctx, "u1")).toBe(0);
  });
});
