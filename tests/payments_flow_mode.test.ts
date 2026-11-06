/**
 * Issue #1711 (follow-up to #1690, #1644): payments flow configurable.
 *
 * Owner directive (2026-10-26, verbatim): "never either/or, always
 * configurable." Both payments flows must exist behind ONE runtime
 * configuration switch; neither is deleted. The owner's earlier
 * HITL-draft decision stands as the DEFAULT, not as the only path.
 *
 * RED-FIRST pins: this file is written BEFORE the implementation, so
 * the immediate-mode pins FAIL on the current HITL-only routes and
 * PASS only once PAYMENTS_FLOW_MODE=immediate restores the pre-#1690
 * route behavior, while hitl / unset / invalid keep the #1690
 * behavior. The hitl pins are controls: they already pass and must
 * keep passing.
 *
 * Harness mirrors tests/payments_hitl_unification.test.ts (#1690):
 * agent-SDK module mocks, MockSqlStorage, OrchestratorAgent
 * onRequest. The fetch stub THROWS on any call: the sandbox gateway
 * is fetch-free, so both modes' sandbox pins must succeed without
 * any network call.
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
import { resolvePaymentsFlowMode } from "../src/agents/routes/payments";
import type { Env } from "../src/types";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock",
    PAYPAL_CLIENT_ID: "paypal-client-id-1711",
    PAYPAL_CLIENT_SECRET: "paypal-secret-1711",
    LEMONSQUEEZY_API_KEY: "ls-key-1711",
    LEMONSQUEEZY_STORE_ID: "store-1711",
    ...overrides,
  }) as Env;

describe("PAYMENTS_FLOW_MODE resolution (#1711)", () => {
  it("unset → hitl, not invalid", () => {
    const r = resolvePaymentsFlowMode({} as any);
    expect(r.mode).toBe("hitl");
    expect(r.invalid).toBe(false);
  });

  it("blank → hitl, not invalid", () => {
    const r = resolvePaymentsFlowMode({ PAYMENTS_FLOW_MODE: "   " } as any);
    expect(r.mode).toBe("hitl");
    expect(r.invalid).toBe(false);
  });

  it("hitl (any case, padded) → hitl, not invalid", () => {
    expect(resolvePaymentsFlowMode({ PAYMENTS_FLOW_MODE: "HITL" } as any).mode).toBe("hitl");
    expect(resolvePaymentsFlowMode({ PAYMENTS_FLOW_MODE: " hitl " } as any).invalid).toBe(false);
  });

  it("immediate → immediate, not invalid", () => {
    const r = resolvePaymentsFlowMode({ PAYMENTS_FLOW_MODE: "immediate" } as any);
    expect(r.mode).toBe("immediate");
    expect(r.invalid).toBe(false);
  });

  it("unrecognized value → hitl FAIL-CLOSED and flagged invalid (never immediate)", () => {
    const r = resolvePaymentsFlowMode({ PAYMENTS_FLOW_MODE: "direct" } as any);
    expect(r.mode).toBe("hitl");
    expect(r.invalid).toBe(true);
    expect(r.raw).toBe("direct");
  });
});

describe("POST /payments/create + /payments/confirm per mode (#1711)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => {
      throw new Error("Unexpected fetch in test: sandbox pins must be fetch-free");
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const makeAgent = (env: Env) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "payments-flow-1711" },
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
  const SEED_IDS = new Set(["pay_init_stripe", "pay_init_paypal"]);
  const baseline = (sql: MockSqlStorage) => ({
    txIds: new Set(allTx(sql).map((r) => r.id as string)),
    awaiting: auditsOf(sql, "payment.awaiting_confirmation").length,
    created: auditsOf(sql, "payment.created").length,
    confirmed: auditsOf(sql, "payment.confirmed").length,
    rejected: auditsOf(sql, "payment.rejected").length,
    configError: auditsOf(sql, "payment.config_error").length,
  });
  const newTx = (sql: MockSqlStorage, base: { txIds: Set<string> }) =>
    allTx(sql).filter((r) => !base.txIds.has(r.id) && !SEED_IDS.has(r.id));

  it("hitl mode: create stores awaiting_confirmation with NO checkout (control, #1690 unchanged)", async () => {
    const { agent, sql } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "hitl" }));
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.checkoutUrl).toBe("");
    expect(json.transaction.gatewayRef).toBe("");
    expect(newTx(sql, base)[0].status).toBe("awaiting_confirmation");
    expect(auditsOf(sql, "payment.awaiting_confirmation")).toHaveLength(base.awaiting + 1);
    expect(auditsOf(sql, "payment.created")).toHaveLength(base.created);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("immediate mode: create stores pending_checkout WITH checkoutUrl/gatewayRef and payment.created audit", async () => {
    const { agent, sql } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "immediate" }));
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.status).toBe("pending_checkout");
    expect(json.transaction.checkoutUrl).toBeTruthy();
    expect(json.transaction.checkoutUrl).toContain("/checkout/sandbox");
    expect(json.transaction.gatewayRef).toBeTruthy();
    const rows = newTx(sql, base);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending_checkout");
    expect(rows[0].checkout_url).toBeTruthy();
    expect(rows[0].gateway_ref).toBeTruthy();
    expect(auditsOf(sql, "payment.created")).toHaveLength(base.created + 1);
    expect(auditsOf(sql, "payment.awaiting_confirmation")).toHaveLength(base.awaiting);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("immediate mode: confirm approved does NOT create a second checkout when one already exists (checkout only if missing)", async () => {
    const { agent, sql } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "immediate" }));
    const base = baseline(sql);
    const created = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    const createdJson = (await created.json()) as any;
    const draftId = createdJson.transaction.id as string;
    const existingUrl = createdJson.transaction.checkoutUrl as string;
    const existingRef = createdJson.transaction.gatewayRef as string;
    const confirmed = await post(agent, "/payments/confirm", { draftId, decision: "approved" });
    expect(confirmed.status).toBe(200);
    const json = (await confirmed.json()) as any;
    expect(json.status).toBe("completed");
    // Pre-#1690 rule: an existing checkout is kept, not overwritten.
    expect(json.checkoutUrl).toBe(existingUrl);
    expect(json.gatewayRef).toBe(existingRef);
    expect(newTx(sql, base)[0].status).toBe("completed");
    expect(auditsOf(sql, "payment.confirmed")).toHaveLength(base.confirmed + 1);
  });

  it("immediate mode: confirm on a missing draft keeps the recovered silent-success behavior (NOT 404)", async () => {
    const { agent, sql } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "immediate" }));
    const res = await post(agent, "/payments/confirm", {
      draftId: "pay_doesnotexist", decision: "approved",
    });
    // Deliberately NOT 404: this is the pre-#1690 behavior being
    // restored verbatim, not a new bug — the hitl mode's 404 is the
    // contrasting behavior, pinned in the hitl test below.
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBe("completed");
  });

  it("hitl mode: confirm on a missing draft returns 404 (control, #1690 unchanged)", async () => {
    const { agent, sql } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "hitl" }));
    const res = await post(agent, "/payments/confirm", {
      draftId: "pay_doesnotexist", decision: "approved",
    });
    expect(res.status).toBe(404);
  });

  it("default (unset) → hitl: create stores awaiting_confirmation, no checkout", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.checkoutUrl).toBe("");
    expect(newTx(sql, base)[0].status).toBe("awaiting_confirmation");
  });

  it("invalid value → hitl FAIL-CLOSED with a payment.config_error audit, never immediate", async () => {
    const { agent, sql } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "bogus-mode" }));
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", {
      amount: 25, customer: "Acme Corp", gateway: "sandbox",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.checkoutUrl).toBe("");
    expect(auditsOf(sql, "payment.created")).toHaveLength(base.created);
    expect(auditsOf(sql, "payment.config_error")).toHaveLength(base.configError + 1);
    const err = auditsOf(sql, "payment.config_error").at(-1) as any;
    const payload = typeof err?.payload === "string" ? JSON.parse(err.payload) : err?.payload;
    expect(JSON.stringify(payload)).toContain("bogus-mode");
  });
});

describe("Source pins (#1711)", () => {
  it("the route resolves one switch, branches create/confirm on it, and restores the immediate audit", () => {
    const routes = src("agents/routes/payments.ts");
    expect(routes).toContain("PAYMENTS_FLOW_MODE");
    expect(routes).toContain("resolvePaymentsFlowMode");
    expect(routes).toContain('ctx.audit("payment.created"');
    expect(routes).toContain('ctx.audit("payment.config_error"');
    expect(routes).toContain("PAYMENT_GATEWAY_ERROR");
  });

  it("the Env type declares the single switch with its default/fail-closed contract", () => {
    const types = src("types.ts");
    expect(types).toContain("PAYMENTS_FLOW_MODE");
    expect(types).toContain("hitl");
  });
});
