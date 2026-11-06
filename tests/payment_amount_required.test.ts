/**
 * Issue #524: both payment create paths silently defaulted an omitted
 * or unparseable amount to $10 — `Number(body.amount) || 10` in
 * POST /payments/create (src/agents/routes/payments.ts) and
 * `Number(input.amount) || 10` in the MCP draft_payment command
 * (src/mcps/openaimp/commands.ts). A create that never named an amount produced
 * a real $10 checkout session and a $10 ledger row; an amount-less
 * draft sat at $10 awaiting a human confirm into the same.
 *
 * The fix shipped directly on main in 4a7e688 ("fix(payments): reject
 * missing/invalid amount instead of defaulting to $10 (#524)"): both
 * paths validate up front — the route returns 400 and the command
 * throws, both with "amount is required and must be a positive
 * number", and neither writes a transaction row or an audit event for
 * a rejected create. That commit landed with NO tests; this file pins
 * the contract so a future refactor cannot quietly restore a default
 * (the same treatment as the alias-auth pins for #181 in PR #486).
 *
 * Route harness mirrors tests/payment_description_honesty.test.ts
 * (#514) / tests/payment_create_gateway_validation.test.ts (#156):
 * agent-SDK module mocks, MockSqlStorage, and fetch stubbed at the
 * real gateway endpoints. MCP cases invoke DraftPaymentCommand
 * directly with the context shape of tests/mcp.test.ts /
 * tests/patterns_solid.test.ts (DatabaseORM over MockSqlStorage).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// src/agents/orchestrator.ts pulls in `cloudflare:`-adjacent SDK entry
// points the node test loader cannot resolve. Mock them with plain
// stand-ins (same pattern as tests/payment_webhook_default_deny.test.ts).
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import { DraftPaymentCommand } from "../src/mcps/openaimp/commands";
import type { McpToolContext } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

const AMOUNT_ERROR = "amount is required and must be a positive number";

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock",
    PAYPAL_CLIENT_ID: "paypal-client-id-524",
    PAYPAL_CLIENT_SECRET: "paypal-secret-524",
    LEMONSQUEEZY_API_KEY: "ls-api-key-524",
    LEMONSQUEEZY_STORE_ID: "store-524",
    ...overrides,
  }) as Env;

function stubGatewayFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/checkout/sessions")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ id: "cs_test_524", url: "https://checkout.stripe.com/c/pay/cs_test_524" }),
        } as any;
      }
      if (url.includes("/v1/oauth2/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok-524" }) } as any;
      }
      if (url.includes("/v2/checkout/orders")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "PP-ORDER-524",
            links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-524" }],
          }),
        } as any;
      }
      if (url.includes("api.lemonsqueezy.com/v1/checkouts")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { id: "ls_524", attributes: { url: "https://checkout.lemonsqueezy.com/ls_524" } },
          }),
        } as any;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    })
  );
}

describe("POST /payments/create — amount is required, never defaulted (#524)", () => {
  beforeEach(stubGatewayFetch);
  afterEach(() => vi.unstubAllGlobals());

  const makeAgent = (env: Env) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "payments-creator-524" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as any, env);
    return { agent, sql };
  };

  const postCreate = (agent: OrchestratorAgent, body: Record<string, unknown>) =>
    agent.onRequest(
      new Request("https://agent.internal/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  const allTx = (sql: MockSqlStorage) =>
    Array.from(sql.exec("SELECT * FROM mas_transactions")) as any[];
  // #1690: the create audit is now the draft command's
  // payment.awaiting_confirmation (payment.created no longer exists).
  const createdAudits = (sql: MockSqlStorage) =>
    Array.from(sql.exec("SELECT * FROM mas_events WHERE type = ?", "payment.awaiting_confirmation")) as any[];

  // The agent lazily seeds two ledger rows on its first request
  // (pay_init_stripe / pay_init_paypal — #175's territory), so assertions
  // diff against the baseline captured after construction and exclude the
  // seed ids: "no row written" means no NEW row (pattern from #156).
  const SEED_IDS = new Set(["pay_init_stripe", "pay_init_paypal"]);
  const baseline = (sql: MockSqlStorage) => ({
    txIds: new Set(allTx(sql).map((r) => r.id as string)),
    audits: createdAudits(sql).length,
  });
  const newTx = (sql: MockSqlStorage, base: { txIds: Set<string> }) =>
    allTx(sql).filter((r) => !base.txIds.has(r.id) && !SEED_IDS.has(r.id));

  const expectRejected = async (body: Record<string, unknown>) => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toBe(AMOUNT_ERROR);
    expect(newTx(sql, base)).toHaveLength(0);
    expect(createdAudits(sql)).toHaveLength(base.audits);
  };

  it("amount omitted: 400 with the contract error, no transaction row, no payment.awaiting_confirmation audit", async () => {
    await expectRejected({ customer: "Acme Corp", gateway: "stripe" });
  });

  it("amount unparseable ('abc'): 400, no transaction row, no payment.awaiting_confirmation audit", async () => {
    await expectRejected({ amount: "abc", customer: "Acme Corp", gateway: "stripe" });
  });

  it("amount zero: 400, no transaction row, no payment.awaiting_confirmation audit", async () => {
    await expectRejected({ amount: 0, customer: "Acme Corp", gateway: "stripe" });
  });

  it("amount negative (-5): 400, no transaction row, no payment.awaiting_confirmation audit", async () => {
    await expectRejected({ amount: -5, customer: "Acme Corp", gateway: "stripe" });
  });

  it("control — a valid amount creates exactly as before (200, one row, one audit)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await postCreate(agent, { amount: 25, customer: "Acme Corp", gateway: "stripe" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.amount).toBe(25);
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(25);
    expect(createdAudits(sql)).toHaveLength(base.audits + 1);
  });
});

describe("MCP draft_payment — amount is required, never defaulted (#524)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let auditMock: ReturnType<typeof vi.fn>;
  let context: McpToolContext;

  const allTx = () => Array.from(sql.exec("SELECT * FROM mas_transactions")) as any[];

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("amount-pin-user");
    auditMock = vi.fn();
    context = { env: makeEnv(), orm, sessionId: "session_amount_pin", audit: auditMock as any };
  });

  it("amount missing (customer present): throws the contract error and creates no transaction", async () => {
    const before = allTx().length;
    const cmd = new DraftPaymentCommand();
    await expect(cmd.execute({ customer: "Acme Corp" } as any, context)).rejects.toThrow(AMOUNT_ERROR);
    expect(allTx()).toHaveLength(before);
    expect(auditMock.mock.calls.some((c) => c[0] === "payment.awaiting_confirmation")).toBe(false);
  });

  it("amount unparseable ('x'): throws the contract error and creates no transaction", async () => {
    const before = allTx().length;
    const cmd = new DraftPaymentCommand();
    await expect(
      cmd.execute({ customer: "Acme Corp", amount: "x" } as any, context)
    ).rejects.toThrow(AMOUNT_ERROR);
    expect(allTx()).toHaveLength(before);
    expect(auditMock.mock.calls.some((c) => c[0] === "payment.awaiting_confirmation")).toBe(false);
  });

  it("control — a valid amount drafts exactly as before (awaiting_confirmation, one row)", async () => {
    const before = allTx().length;
    const cmd = new DraftPaymentCommand();
    const result = await cmd.execute(
      { amount: 25, customer: "Acme Corp", gateway: "stripe" },
      context
    );
    expect(result.status).toBe("awaiting_confirmation");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.amount).toBe(25);
    expect(result.draftId.startsWith("pay_")).toBe(true);
    const rows = allTx();
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1].amount).toBe(25);
  });
});
