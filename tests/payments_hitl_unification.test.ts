/**
 * Issue #1690 (follow-up to #1644, parent #1638): payments unification
 * under the owner's HITL-draft decision (2026-10-26, verbatim in the
 * issue): for the payments pair, the HITL-draft flow wins over
 * immediate-checkout. draft/confirm_payment_draft is the canonical
 * payments money flow; payments create/confirm (immediate-checkout)
 * must be unified under it.
 *
 * RED-FIRST pins: this file is written BEFORE the refactor, so the
 * behavior-change pins below FAIL on the old immediate-checkout
 * routes and PASS only once POST /payments/create executes through
 * draft_payment and POST /payments/confirm through
 * confirm_payment_draft via executeMCPTool.
 *
 * Harness mirrors tests/payment_create_gateway_validation.test.ts
 * (#156): agent-SDK module mocks, MockSqlStorage, OrchestratorAgent
 * onRequest. The fetch stub THROWS on any call: after unification no
 * gateway checkout happens at create time, so a create must succeed
 * without any network call at all. Confirm pins use the explicit
 * sandbox harness (fetch-free by construction).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";

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
import { MockD1Database } from "./mock-d1";
import { DatabaseORM } from "../src/orm";
import { DraftPaymentCommand, ConfirmPaymentDraftCommand } from "../src/mcps/openaimp/commands";
import type { McpToolContext } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    // Test keys so the Stripe strategy takes its REST path at confirm
    // time (without a key it returns success:false with an empty URL —
    // the #1690 recorded limitation, not a test-harness gap).
    STRIPE_SECRET_KEY: "sk_test_mock",
    PAYPAL_CLIENT_ID: "paypal-client-id-1690",
    PAYPAL_CLIENT_SECRET: "paypal-secret-1690",
    LEMONSQUEEZY_API_KEY: "ls-key-1690",
    LEMONSQUEEZY_STORE_ID: "store-1690",
    // #3156: the money-path audit gate needs a reachable policy
    // store, or it fails closed (503). The mock D1 stands in for
    // the bound AGENT_DB; the orchestrator ensures its schema.
    AGENT_DB: new MockD1Database() as any,
    ...overrides,
  }) as Env;

describe("POST /payments/create — HITL-draft canonical flow (#1690)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => {
      throw new Error("Unexpected fetch in test: no gateway call may happen at create time");
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const makeAgent = (env: Env) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "payments-unify-1690" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as any, env);
    return { agent, sql };
  };

  const post = (agent: OrchestratorAgent, path: string, body: Record<string, unknown>) =>
    agent.onRequest(
      new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  const allTx = (sql: MockSqlStorage) =>
    Array.from(sql.exec("SELECT * FROM mas_transactions")) as any[];
  const auditsOf = (sql: MockSqlStorage, type: string) =>
    Array.from(sql.exec("SELECT * FROM mas_events WHERE type = ?", type)) as any[];

  // The agent lazily seeds two ledger rows on its first request
  // (pay_init_stripe / pay_init_paypal); diff against the baseline.
  const SEED_IDS = new Set(["pay_init_stripe", "pay_init_paypal"]);
  const baseline = (sql: MockSqlStorage) => ({
    txIds: new Set(allTx(sql).map((r) => r.id as string)),
    awaiting: auditsOf(sql, "payment.awaiting_confirmation").length,
    created: auditsOf(sql, "payment.created").length,
    confirmed: auditsOf(sql, "payment.confirmed").length,
    rejected: auditsOf(sql, "payment.rejected").length,
  });
  const newTx = (sql: MockSqlStorage, base: { txIds: Set<string> }) =>
    allTx(sql).filter((r) => !base.txIds.has(r.id) && !SEED_IDS.has(r.id));

  it("stripe create stores awaiting_confirmation with NO checkoutUrl/gatewayRef and NO gateway call", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "stripe",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.checkoutUrl).toBe("");
    expect(json.transaction.gatewayRef).toBe("");
    expect(json.transaction.proofSignature).toBeTruthy();
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("awaiting_confirmation");
    expect(rows[0].checkout_url).toBe("");
    expect(rows[0].gateway_ref).toBe("");
    expect(auditsOf(sql, "payment.awaiting_confirmation")).toHaveLength(base.awaiting + 1);
    expect(auditsOf(sql, "payment.created")).toHaveLength(base.created);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sandbox create likewise drafts without checkout; note is empty when no description is supplied (#514 preserved)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.note).toBe("");
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("create with a description stores it unchanged", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
      description: "Q3 consulting engagement",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.note).toBe("Q3 consulting engagement");
    expect(newTx(sql, base)[0].note).toBe("Q3 consulting engagement");
  });

  it("create keeps #524 amount 400 and #156 gateway 400-before-row-write", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const badAmount = await post(agent, "/payments/create", { customer: "Acme Corp", gateway: "sandbox" });
    expect(badAmount.status).toBe(400);
    const badGateway = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "boguspay",
    });
    expect(badGateway.status).toBe(400);
    const badJson = (await badGateway.json()) as any;
    expect(badJson.code).toBe("UNSUPPORTED_GATEWAY");
    expect(badJson.error).toContain("stripe, paypal, lemonsqueezy, sandbox");
    expect(newTx(sql, base)).toHaveLength(0);
    expect(auditsOf(sql, "payment.awaiting_confirmation")).toHaveLength(base.awaiting);
  });

  it("confirm on a missing draft returns 404 for approved AND rejected (no silent success)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const approved = await post(agent, "/payments/confirm", {
      draftId: "pay_doesnotexist", decision: "approved",
    });
    expect(approved.status).toBe(404);
    const rejected = await post(agent, "/payments/confirm", {
      draftId: "pay_doesnotexist", decision: "rejected",
    });
    expect(rejected.status).toBe(404);
    expect(newTx(sql, base)).toHaveLength(0);
    expect(auditsOf(sql, "payment.confirmed")).toHaveLength(base.confirmed);
    expect(auditsOf(sql, "payment.rejected")).toHaveLength(base.rejected);
  });

  it("confirm approved charge creates checkout via the facade (sandbox URL + ref on the row)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const created = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    const draftId = ((await created.json()) as any).transaction.id as string;
    const confirmed = await post(agent, "/payments/confirm", { draftId, decision: "approved" });
    expect(confirmed.status).toBe(200);
    const json = (await confirmed.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.draftId).toBe(draftId);
    expect(json.checkoutUrl).toContain("/checkout/sandbox");
    expect(json.gatewayRef).toContain("sandbox_");
    expect(json.authorizerDid).toBeTruthy();
    const row = newTx(sql, base)[0];
    expect(row.status).toBe("completed");
    expect(row.checkout_url).toContain("/checkout/sandbox");
    expect(row.gateway_ref).toContain("sandbox_");
    expect(row.note).toBe("Approved by human authorizer");
    expect(auditsOf(sql, "payment.confirmed")).toHaveLength(base.confirmed + 1);
  });

  it("confirm approved OVERWRITES a pre-existing checkoutUrl (unconditional checkout; old-flow rows get a fresh checkout)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const created = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    const draftId = ((await created.json()) as any).transaction.id as string;
    // Simulate an in-flight row from the old immediate-checkout flow.
    sql.exec("UPDATE mas_transactions SET checkout_url = ?, gateway_ref = ? WHERE id = ?",
      "https://old.example/checkout", "old_ref_123", draftId);
    const confirmed = await post(agent, "/payments/confirm", { draftId, decision: "approved" });
    expect(confirmed.status).toBe(200);
    const json = (await confirmed.json()) as any;
    expect(json.checkoutUrl).toContain("/checkout/sandbox");
    expect(json.checkoutUrl).not.toBe("https://old.example/checkout");
    expect(json.gatewayRef).not.toBe("old_ref_123");
  });

  it("confirm rejected marks the draft rejected with the command note text", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const created = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    const draftId = ((await created.json()) as any).transaction.id as string;
    const res = await post(agent, "/payments/confirm", { draftId, decision: "rejected" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toEqual({ success: true, status: "rejected", draftId });
    const row = newTx(sql, base)[0];
    expect(row.status).toBe("rejected");
    expect(row.note).toBe("Rejected by human reviewer");
    expect(auditsOf(sql, "payment.rejected")).toHaveLength(base.rejected + 1);
  });

  it("confirm approved refund executes a refund (sandbox refund ref on the row)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const created = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox", action: "refund",
    });
    const draftId = ((await created.json()) as any).transaction.id as string;
    const res = await post(agent, "/payments/confirm", { draftId, decision: "approved" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.status).toBe("completed");
    expect(json.gatewayRef).toContain("ref_sandbox_");
    expect(newTx(sql, base)[0].status).toBe("completed");
  });
});

describe("DraftPaymentCommand description handling (#514, #1690)", () => {
  const makeCtx = () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("unify-pin-user");
    const auditMock = vi.fn();
    const context = {
      env: makeEnv(), orm, sessionId: "session_unify_pin", audit: auditMock as any,
    } as McpToolContext;
    return { sql, orm, auditMock, context };
  };

  it("omitted description keeps the generic caller-derived default (MCP behavior unchanged)", async () => {
    const { context } = makeCtx();
    const result = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "sandbox" } as any, context);
    expect(result.transaction.note).toBe("Payment intent for Acme Corp");
  });

  it("EXPLICITLY empty description stays empty (was: overridden by the generic default)", async () => {
    const { context } = makeCtx();
    const result = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "sandbox", description: "" } as any, context);
    expect(result.transaction.note).toBe("");
  });

  it("supplied description passes through unchanged", async () => {
    const { context } = makeCtx();
    const result = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "sandbox", description: "Hosting renewal" } as any, context);
    expect(result.transaction.note).toBe("Hosting renewal");
  });
});

describe("ConfirmPaymentDraftCommand contract (#1690)", () => {
  const makeCtx = (facade: any) => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("unify-confirm-user");
    const auditMock = vi.fn();
    const context = {
      env: makeEnv(), orm, sessionId: "session_unify_confirm", audit: auditMock as any, facade,
    } as unknown as McpToolContext;
    return { sql, orm, auditMock, context };
  };

  const seedDraft = async (context: McpToolContext) => {
    const out = await new DraftPaymentCommand().execute(
      { amount: 25, customer: "Acme Corp", gateway: "sandbox", description: "" } as any, context);
    return out.draftId as string;
  };

  it("missing draft throws not-found for approved AND rejected (route maps this to 404)", async () => {
    const { context } = makeCtx({});
    const cmd = new ConfirmPaymentDraftCommand();
    await expect(cmd.execute({ draftId: "pay_missing", decision: "approved" }, context))
      .rejects.toThrow(/not found/);
    await expect(cmd.execute({ draftId: "pay_missing", decision: "rejected" }, context))
      .rejects.toThrow(/not found/);
  });

  it("approved audit carries decision + status and NO executorDid; rejected audit carries decision and NO executorDid", async () => {
    const facade = {
      createCheckout: async () => ({ checkoutUrl: "https://checkout.test/x", gatewayRef: "ref_test" }),
      executeRefund: async () => ({ refundId: "ref_test_refund" }),
    };
    const { context, auditMock } = makeCtx(facade);
    const draftId = await seedDraft(context);
    const cmd = new ConfirmPaymentDraftCommand();
    await cmd.execute({ draftId, decision: "approved" }, context);
    const confirmed = auditMock.mock.calls.find((c) => c[0] === "payment.confirmed");
    expect(confirmed).toBeDefined();
    expect(confirmed[2]).toMatchObject({ draftId, decision: "approved", status: "completed" });
    expect("executorDid" in (confirmed[2] as Record<string, unknown>)).toBe(false);

    const draftId2 = await seedDraft(context);
    await cmd.execute({ draftId: draftId2, decision: "rejected" }, context);
    const rejected = auditMock.mock.calls.find(
      (c) => c[0] === "payment.rejected" && (c[2] as any).draftId === draftId2);
    expect(rejected).toBeDefined();
    expect((rejected[2] as any).decision).toBe("rejected");
    expect("executorDid" in (rejected[2] as Record<string, unknown>)).toBe(false);
  });
});

describe("Confirm-time gateway payload (#514 intent, moved with the checkout to confirm)", () => {
  // #514 pinned the gateway payload at CREATE because create used to
  // check out immediately. Under #1690 the checkout — and therefore
  // the gateway payload — happens at CONFIRM, so the pin moves with
  // it: the caller's description must reach Stripe's product name at
  // confirm time, and no gateway call may happen at create time.
  let captured: URLSearchParams | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    captured = undefined;
    fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("api.stripe.com/v1/checkout/sessions")) {
        captured = new URLSearchParams(String(init?.body ?? ""));
        return {
          ok: true, status: 200, statusText: "OK",
          json: async () => ({ id: "cs_test_1690", url: "https://checkout.stripe.com/c/pay/cs_test_1690" }),
        } as any;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stripe: create makes no gateway call; confirm sends the caller's description as the Stripe product name", async () => {
    const sql = new MockSqlStorage();
    const agent = new OrchestratorAgent(
      { id: { toString: () => "payments-unify-1690-stripe" }, storage: { sql }, waitUntil: vi.fn() } as any,
      makeEnv(),
    );
    const post = (path: string, body: Record<string, unknown>) =>
      agent.onRequest(new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    const created = await post("/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "stripe",
      description: "Q3 consulting engagement",
    });
    expect(created.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const draftId = ((await created.json()) as any).transaction.id as string;
    const confirmed = await post("/payments/confirm", { draftId, decision: "approved" });
    expect(confirmed.status).toBe(200);
    const json = (await confirmed.json()) as any;
    expect(json.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_1690");
    expect(json.gatewayRef).toBe("cs_test_1690");
    expect(captured?.get("line_items[0][price_data][product_data][name]")).toBe("Q3 consulting engagement");
  });
});

describe("Source pins (#1690, updated by #1711)", () => {
  it("the hitl create/confirm routes delegate to the MCP commands; payment.created exists ONLY in the immediate-mode branch (#1711)", () => {
    const routes = src("agents/routes/payments.ts");
    expect(routes).toContain('executeMCPTool("draft_payment"');
    expect(routes).toContain('executeMCPTool("confirm_payment_draft"');
    // #1711: payment.created is restored for immediate mode only — the
    // hitl path still emits payment.awaiting_confirmation via the
    // command, never payment.created. The old blanket
    // not-toContain(payment.created) pin is therefore replaced by the
    // per-mode behavior pins in tests/payments_flow_mode.test.ts.
    expect(routes).toContain('ctx.audit("payment.created"');
    expect(routes).toContain("PAYMENTS_FLOW_MODE");
  });
});
