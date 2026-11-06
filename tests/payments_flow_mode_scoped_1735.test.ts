/**
 * Issue #1735 (parent #1717, slice (o)): PAYMENTS RE-SCOPE.
 *
 * PAYMENTS_FLOW_MODE (#1711: hitl | immediate, default hitl, invalid
 * fails closed to hitl with a payment.config_error audit) was a SINGLE
 * GLOBAL Worker-env value. This slice re-scopes its resolution to
 *   run > session > user > global env > built-in (hitl)
 * matching the program's execution-context scoping rule, without
 * changing either flow, the HITL default, or the fail-closed rule.
 *
 * RED-FIRST pins: this file is written BEFORE the implementation, so
 * the scoped-resolver imports and the orchestrator carrier fail here
 * and pass only once the slice lands. The #1711 env-only pins in
 * tests/payments_flow_mode.test.ts are controls and must keep passing.
 *
 * SECURITY PIN (the slice's guard, stated in #1735): a scoped value
 * must never let a caller disable their own enforcement. The flow
 * switch governs which money-flow variant an execution uses, and the
 * HITL confirm gate applies inside the hitl flow — so the run value
 * comes from the execution owner via the route context, NEVER from
 * request input. A body/query `flowMode` is ignored (pinned below).
 * Session/user carriers are likewise execution-owner-populated, not
 * caller-settable: no persisted settings store is introduced here
 * (the #1721/#1728 boundary), and in production today the carriers
 * are honored but populated by no caller yet — exactly like the
 * #1728 scopedPaymentsModes carriers.
 *
 * Harness mirrors tests/payments_flow_mode.test.ts (#1711): agent-SDK
 * module mocks, MockSqlStorage, OrchestratorAgent onRequest. The
 * fetch stub THROWS on any call: the sandbox gateway is fetch-free,
 * so both modes' sandbox pins must succeed without any network call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
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
import { handlePaymentsRoutes } from "../src/agents/routes/payments";
import {
  levelsForPaymentsFlowMode,
  resolvePaymentsFlowModeScoped,
  type PaymentsFlowScopedModes,
} from "../src/config/paymentsFlowModes";
import type { Env } from "../src/types";

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock",
    PAYPAL_CLIENT_ID: "paypal-client-id-1735",
    PAYPAL_CLIENT_SECRET: "paypal-secret-1735",
    LEMONSQUEEZY_API_KEY: "lemon-1735",
    LEMONSQUEEZY_STORE_ID: "store-1735",
    ...overrides,
  }) as Env;

const L = (
  scoped: PaymentsFlowScopedModes | undefined,
  run: unknown,
  envValue: unknown
) => resolvePaymentsFlowModeScoped(levelsForPaymentsFlowMode(scoped, run, envValue));

describe("PAYMENTS_FLOW_MODE scoped resolution (#1735)", () => {
  it("all blank → hitl builtin, not invalid", () => {
    const r = L(undefined, undefined, undefined);
    expect(r.mode).toBe("hitl");
    expect(r.invalid).toBe(false);
    expect(r.level).toBe("builtin");
  });

  it("env only: hitl and immediate both resolve at the env level (old #1711 path, preserved)", () => {
    expect(L(undefined, undefined, "hitl")).toMatchObject({ mode: "hitl", invalid: false, level: "env" });
    expect(L(undefined, undefined, "IMMEDIATE")).toMatchObject({ mode: "immediate", invalid: false, level: "env" });
    expect(L(undefined, undefined, "  ")).toMatchObject({ mode: "hitl", invalid: false, level: "builtin" });
  });

  it("user level: hitl and immediate both resolve, beating env", () => {
    expect(L({ user: { flow: "hitl" } }, undefined, "immediate")).toMatchObject({ mode: "hitl", level: "user" });
    expect(L({ user: { flow: "immediate" } }, undefined, "hitl")).toMatchObject({ mode: "immediate", level: "user" });
  });

  it("session level: hitl and immediate both resolve, beating user and env", () => {
    expect(L({ session: { flow: "hitl" }, user: { flow: "immediate" } }, undefined, "immediate")).toMatchObject({
      mode: "hitl",
      level: "session",
    });
    expect(L({ session: { flow: "immediate" }, user: { flow: "hitl" } }, undefined, "hitl")).toMatchObject({
      mode: "immediate",
      level: "session",
    });
  });

  it("run level: hitl and immediate both resolve, beating session, user, and env", () => {
    expect(
      L({ session: { flow: "immediate" }, user: { flow: "immediate" } }, "hitl", "immediate")
    ).toMatchObject({ mode: "hitl", level: "run" });
    expect(
      L({ session: { flow: "hitl" }, user: { flow: "hitl" } }, "immediate", "hitl")
    ).toMatchObject({ mode: "immediate", level: "run" });
  });

  it("blank scoped levels fall through to the next level", () => {
    expect(L({ session: { flow: "  " }, user: {} }, undefined, "immediate")).toMatchObject({
      mode: "immediate",
      level: "env",
    });
    expect(L({ session: {}, user: { flow: " " } }, "  ", undefined)).toMatchObject({
      mode: "hitl",
      level: "builtin",
    });
  });

  it("scoped values are case-insensitive and whitespace-tolerant", () => {
    expect(L({ session: { flow: " Immediate " } }, undefined, undefined).mode).toBe("immediate");
    expect(L({ user: { flow: "HITL" } }, undefined, undefined).mode).toBe("hitl");
  });

  it("invalid at EACH level fails closed to hitl and does NOT fall through to a lower level", () => {
    expect(L(undefined, "bogus", "immediate")).toMatchObject({ mode: "hitl", invalid: true, level: "run", raw: "bogus" });
    expect(L({ session: { flow: "bogus" } }, undefined, "immediate")).toMatchObject({
      mode: "hitl",
      invalid: true,
      level: "session",
    });
    expect(L({ user: { flow: "bogus" } }, undefined, "immediate")).toMatchObject({
      mode: "hitl",
      invalid: true,
      level: "user",
    });
    expect(L(undefined, undefined, "bogus")).toMatchObject({ mode: "hitl", invalid: true, level: "env" });
  });

  it("invalid run beats a valid session immediate (never immediate on an invalid winner)", () => {
    const r = L({ session: { flow: "immediate" } }, "bogus", undefined);
    expect(r.mode).toBe("hitl");
    expect(r.invalid).toBe(true);
    expect(r.level).toBe("run");
  });

  it("non-string scoped value fails closed to hitl (a misconfiguration, not a silent fall-through)", () => {
    const r = L({ session: { flow: 42 as unknown as string } }, undefined, "immediate");
    expect(r.mode).toBe("hitl");
    expect(r.invalid).toBe(true);
    expect(r.level).toBe("session");
  });

  it("two runs on different modes are independent: no shared mutable resolution state leaks across runs", () => {
    const a = L({ session: { flow: "immediate" } }, undefined, undefined);
    const b = L({ session: { flow: "hitl" } }, undefined, undefined);
    const aAgain = L({ session: { flow: "immediate" } }, undefined, undefined);
    expect(a.mode).toBe("immediate");
    expect(b.mode).toBe("hitl");
    expect(aAgain.mode).toBe("immediate");
  });
});

describe("POST /payments/create + /payments/confirm under scoped carriers (#1735)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => {
      throw new Error("Unexpected fetch in test: sandbox pins must be fetch-free");
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const makeAgent = (env: Env, scoped?: PaymentsFlowScopedModes) => {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "payments-flow-1735" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const agent = new OrchestratorAgent(ctx as any, env);
    if (scoped !== undefined) (agent as any).scopedPaymentsFlowModes = scoped;
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

  const allTx = (sql: MockSqlStorage) => Array.from(sql.exec("SELECT * FROM mas_transactions")) as any[];
  const auditsOf = (sql: MockSqlStorage, type: string) =>
    Array.from(sql.exec("SELECT * FROM mas_events WHERE type = ?", type)) as any[];
  const SEED_IDS = new Set(["pay_init_stripe", "pay_init_paypal"]);
  const baseline = (sql: MockSqlStorage) => ({
    txIds: new Set(allTx(sql).map((r) => r.id as string)),
    awaiting: auditsOf(sql, "payment.awaiting_confirmation").length,
    created: auditsOf(sql, "payment.created").length,
    configError: auditsOf(sql, "payment.config_error").length,
  });
  const createBody = { amount: 25, customer: "Acme Corp", gateway: "sandbox" };

  it("session immediate, env unset → immediate (pending_checkout, payment.created, no draft)", async () => {
    const { agent, sql } = makeAgent(makeEnv(), { session: { flow: "immediate" } });
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", createBody);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("pending_checkout");
    expect(json.transaction.checkoutUrl).toBeTruthy();
    expect(auditsOf(sql, "payment.created")).toHaveLength(base.created + 1);
    expect(auditsOf(sql, "payment.awaiting_confirmation")).toHaveLength(base.awaiting);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("user immediate, env unset → immediate", async () => {
    const { agent, sql } = makeAgent(makeEnv(), { user: { flow: "immediate" } });
    const res = await post(agent, "/payments/create", createBody);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("pending_checkout");
  });

  it("session hitl beats user immediate and env immediate → hitl draft", async () => {
    const { agent, sql } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "immediate" }), {
      session: { flow: "hitl" },
      user: { flow: "immediate" },
    });
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", createBody);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.checkoutUrl).toBe("");
    expect(auditsOf(sql, "payment.awaiting_confirmation")).toHaveLength(base.awaiting + 1);
  });

  it("user hitl beats env immediate → hitl draft", async () => {
    const { agent } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "immediate" }), { user: { flow: "hitl" } });
    const res = await post(agent, "/payments/create", createBody);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
  });

  it("session hitl beats env immediate → hitl draft", async () => {
    const { agent } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "immediate" }), { session: { flow: "hitl" } });
    const res = await post(agent, "/payments/create", createBody);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
  });

  it("invalid session value fails closed to hitl with a payment.config_error audit, never immediate", async () => {
    const { agent, sql } = makeAgent(makeEnv(), {
      session: { flow: "bogus-mode" },
      user: { flow: "immediate" },
    });
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", createBody);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.checkoutUrl).toBe("");
    expect(auditsOf(sql, "payment.config_error")).toHaveLength(base.configError + 1);
    const err = auditsOf(sql, "payment.config_error").at(-1) as any;
    const payload = typeof err?.payload === "string" ? JSON.parse(err.payload) : err?.payload;
    expect(JSON.stringify(payload)).toContain("bogus-mode");
  });

  it("env immediate with no carriers still resolves immediate (old #1711 path, control)", async () => {
    const { agent } = makeAgent(makeEnv({ PAYMENTS_FLOW_MODE: "immediate" }));
    const res = await post(agent, "/payments/create", createBody);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("pending_checkout");
  });

  it("session immediate: confirm on a missing draft keeps the immediate silent-success behavior", async () => {
    const { agent } = makeAgent(makeEnv(), { session: { flow: "immediate" } });
    const res = await post(agent, "/payments/confirm", { draftId: "pay_doesnotexist", decision: "approved" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.status).toBe("completed");
  });

  it("session hitl: confirm on a missing draft returns 404 (the hitl gate is not disabled by scoping)", async () => {
    const { agent } = makeAgent(makeEnv(), { session: { flow: "hitl" } });
    const res = await post(agent, "/payments/confirm", { draftId: "pay_doesnotexist", decision: "approved" });
    expect(res.status).toBe(404);
  });

  it("SECURITY: request body flowMode=immediate does NOT flip the flow (env unset → hitl draft)", async () => {
    const { agent, sql } = makeAgent(makeEnv());
    const base = baseline(sql);
    const res = await post(agent, "/payments/create", { ...createBody, flowMode: "immediate" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
    expect(json.transaction.checkoutUrl).toBe("");
    expect(auditsOf(sql, "payment.awaiting_confirmation")).toHaveLength(base.awaiting + 1);
  });

  it("SECURITY: query ?flowMode=immediate does NOT flip the flow (env unset → hitl draft)", async () => {
    const { agent } = makeAgent(makeEnv());
    const res = await post(agent, "/payments/create?flowMode=immediate", createBody);
    const json = (await res.json()) as any;
    expect(json.transaction.status).toBe("awaiting_confirmation");
  });
});

describe("Run-level carrier via the route context (#1735)", () => {
  it("run immediate via ctx.paymentsFlowModeRun beats env hitl → immediate, fetch-free", async () => {
    const sql = new MockSqlStorage();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const res = await handlePaymentsRoutes(
      new Request("https://agent.internal/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 25, customer: "Acme Corp", gateway: "sandbox" }),
      }),
      new URL("https://agent.internal/payments/create"),
      "/payments/create",
      "session-1735-run",
      {
        env: makeEnv({ PAYMENTS_FLOW_MODE: "hitl" }),
        ensureTables: () => sql as any,
        audit: (type, _agent, payload) => {
          audits.push({ type, payload });
        },
        paymentsFlowModeRun: "immediate",
      } as any
    );
    expect(res).not.toBeNull();
    const json = (await res!.json()) as any;
    expect(json.success).toBe(true);
    expect(json.transaction.status).toBe("pending_checkout");
    expect(json.transaction.checkoutUrl).toBeTruthy();
    expect(audits.find((a) => a.type === "payment.created")).toBeTruthy();
  });

  it("run invalid fails closed: immediate branch is NOT taken and payment.config_error is audited", async () => {
    const sql = new MockSqlStorage();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const res = await handlePaymentsRoutes(
      new Request("https://agent.internal/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 25, customer: "Acme Corp", gateway: "sandbox" }),
      }),
      new URL("https://agent.internal/payments/create"),
      "/payments/create",
      "session-1735-run-invalid",
      {
        env: makeEnv(),
        ensureTables: () => sql as any,
        audit: (type, _agent, payload) => {
          audits.push({ type, payload });
        },
        scopedPaymentsFlowModes: { session: { flow: "immediate" } },
        paymentsFlowModeRun: "bogus-mode",
      } as any
    );
    expect(res).not.toBeNull();
    expect(audits.find((a) => a.type === "payment.config_error")).toBeTruthy();
    const json = (await res!.json()) as any;
    // Fail-closed means the immediate branch never ran: no
    // pending_checkout success, whatever the hitl delegation then did
    // (that delegation outcome is the #1690 path's own contract, not
    // this pin's subject — the resolver unit tests pin hitl itself).
    expect(!(json.success === true && json.transaction?.status === "pending_checkout")).toBe(true);
  });
});
