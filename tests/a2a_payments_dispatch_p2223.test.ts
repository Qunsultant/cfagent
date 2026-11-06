/**
 * Issue #2223 (payments slice) — PaymentsAgent A2A dispatch pins.
 *
 * The payments card used to advertise payments.draft — an operation
 * that does not exist on PaymentsAgent (it is a MAS tool inside
 * OrchestratorAgent, SURVEY §6.3) — while the agent's real surface
 * (budgetCheck / todaySpent / listPayments / processPaidRequest) had
 * no A2A door at all. This slice re-scopes the card to the four real
 * operations and serves them through a dispatch module in the
 * TradingAgent / slice-1 shape.
 *
 * Money-path discipline (user decision on #2223, 2026-10-29 —
 * processPaidRequest INCLUDED): the dispatch passes arguments to
 * processPaidRequest faithfully; the method's own facilitator
 * verification and ledger recording are the only path. The
 * money-path pins below run the REAL PaymentsAgent against the REAL
 * ledger routes (the payments_guard harness): only the facilitator's
 * HTTP transport is stubbed, never the verification logic — a
 * rejected proof must record NOTHING, an approved proof exactly ONE
 * ledger record.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

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
    },
  };
});

import {
  PAYMENTS_A2A_OPERATIONS,
  dispatchPaymentsA2A,
  paymentsA2AOutcome,
  type PaymentsA2AExecutor,
} from "../src/agents/payments/a2aDispatch";
import { AGENT_CARDS, getAgentCard } from "../src/a2a/agent-cards";
import { AGENT_ERROR_CATALOG } from "../src/aspects/errorCodes";
import { handleA2A } from "../src/a2a/index";
import { PaymentsAgent } from "../src/agents/payments-agent";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { handleAgenticPaymentsRoutes } from "../src/agents/routes/agenticPayments";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fake executor (the injectable seam)
// ---------------------------------------------------------------------------

function makeFakeExecutor(overrides: Partial<PaymentsA2AExecutor> = {}) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const executor: PaymentsA2AExecutor = {
    budgetCheck: async (req) => {
      calls.push({ method: "budgetCheck", args: req });
      return { allowed: true };
    },
    todaySpent: async () => {
      calls.push({ method: "todaySpent", args: undefined });
      return 1234;
    },
    listPayments: async (limit) => {
      calls.push({ method: "listPayments", args: limit });
      return [
        {
          id: "tx-1",
          agentId: "a1",
          operation: "search.query",
          amountCents: 10,
          idempotencyKey: "k-1",
          status: "verified",
          timestamp: "2026-10-29T00:00:00.000Z",
        } as any,
      ];
    },
    processPaidRequest: async (req) => {
      calls.push({ method: "processPaidRequest", args: req });
      return {
        id: "tx-2",
        agentId: req.agentId,
        operation: req.operation,
        amountCents: req.amountCents,
        idempotencyKey: req.idempotencyKey,
        status: "verified",
        timestamp: "2026-10-29T00:00:00.000Z",
      } as any;
    },
    ...overrides,
  };
  return { executor, calls };
}

const ENV = {} as any;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("dispatchPaymentsA2A routing (#2223 payments)", () => {
  it("payments.budget_check routes a bare body with faithful args", async () => {
    const { executor, calls } = makeFakeExecutor();
    const data = await dispatchPaymentsA2A(
      ENV,
      { operation: "payments.budget_check", op: "search.query", amountCents: 250, agentId: "sched-1" } as any,
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(data.operation).toBe("payments.budget_check");
    expect(data.correlationId).toBeTruthy();
    expect(calls).toEqual([
      { method: "budgetCheck", args: { operation: "search.query", amountCents: 250, agentId: "sched-1" } },
    ]);
    expect((data.result as any).allowed).toBe(true);
  });

  it("payments.budget_check routes the message/send envelope", async () => {
    const { executor, calls } = makeFakeExecutor();
    const body = {
      jsonrpc: "2.0",
      id: 7,
      method: "message/send",
      params: {
        message: {
          parts: [
            { kind: "text", text: "check" },
            { kind: "data", data: { operation: "payments.budget_check", op: "nlq.execute", amountCents: 5, agentId: "nlq-caller" } },
          ],
        },
      },
    };
    const data = await dispatchPaymentsA2A(ENV, body, { executor });
    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      { method: "budgetCheck", args: { operation: "nlq.execute", amountCents: 5, agentId: "nlq-caller" } },
    ]);
  });

  it("a budget_check denial is a SUCCESS result (the method is fail-closed by design)", async () => {
    const { executor } = makeFakeExecutor({
      budgetCheck: async () => ({ allowed: false, reason: "daily cap exceeded" }),
    });
    const data = await dispatchPaymentsA2A(
      ENV,
      { operation: "payments.budget_check", op: "search.query", amountCents: 9000, agentId: "sched-1" },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(data.code).toBeUndefined();
    expect(data.errorToken).toBeUndefined();
    expect((data.result as any).allowed).toBe(false);
    const outcome = paymentsA2AOutcome(data);
    expect(outcome.text).toContain("NOT within budget");
    expect(outcome.data).toBe(data);
  });

  it("payments.today_spent routes and reports cents", async () => {
    const { executor, calls } = makeFakeExecutor();
    const data = await dispatchPaymentsA2A(ENV, { operation: "payments.today_spent" }, { executor });
    expect(data.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["todaySpent"]);
    expect((data.result as any).spentTodayCents).toBe(1234);
    expect(paymentsA2AOutcome(data).text).toContain("1234");
  });

  it("payments.list routes with the limit passed through", async () => {
    const { executor, calls } = makeFakeExecutor();
    const data = await dispatchPaymentsA2A(ENV, { operation: "payments.list", limit: 5 }, { executor });
    expect(data.ok).toBe(true);
    expect(calls).toEqual([{ method: "listPayments", args: 5 }]);
    expect(Array.isArray(data.result)).toBe(true);
    expect((data.result as any[]).length).toBe(1);
  });

  it("payments.process passes the five request fields faithfully (nothing added, nothing altered)", async () => {
    const { executor, calls } = makeFakeExecutor();
    const req = {
      agentId: "a1",
      op: "search.query",
      amountCents: 42,
      idempotencyKey: "pay-1",
      paymentProof: "proof-xyz",
    };
    const data = await dispatchPaymentsA2A(
      ENV,
      { operation: "payments.process", ...req },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      {
        method: "processPaidRequest",
        args: {
          agentId: "a1",
          operation: "search.query",
          amountCents: 42,
          idempotencyKey: "pay-1",
          paymentProof: "proof-xyz",
        },
      },
    ]);
    expect((data.result as any).status).toBe("verified");
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe("dispatchPaymentsA2A classification (#2223 payments)", () => {
  it("payments.draft is an UNKNOWN operation here (it belongs to the orchestrator)", async () => {
    const { executor, calls } = makeFakeExecutor();
    const data = await dispatchPaymentsA2A(ENV, { operation: "payments.draft" }, { executor });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("unknown_operation");
    expect(data.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
    expect(AGENT_ERROR_CATALOG[data.errorToken as keyof typeof AGENT_ERROR_CATALOG]).toBeDefined();
    expect(calls).toEqual([]);
  });

  it("a body with no operation is missing_operation", async () => {
    const { executor } = makeFakeExecutor();
    for (const body of [{}, null, "nope", { params: { message: { parts: [] } } }]) {
      const data = await dispatchPaymentsA2A(ENV, body, { executor });
      expect(data.ok).toBe(false);
      expect(data.code).toBe("missing_operation");
      expect(data.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
      expect(data.correlationId).toBeTruthy();
    }
  });

  it("payments.process with a missing paymentProof is invalid_input and never reaches the executor", async () => {
    const { executor, calls } = makeFakeExecutor();
    const data = await dispatchPaymentsA2A(
      ENV,
      { operation: "payments.process", agentId: "a1", op: "search.query", amountCents: 10, idempotencyKey: "k" },
      { executor },
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("payments.budget_check with a non-numeric amountCents is invalid_input", async () => {
    const { executor, calls } = makeFakeExecutor();
    const data = await dispatchPaymentsA2A(
      ENV,
      { operation: "payments.budget_check", op: "search.query", amountCents: "10" },
      { executor },
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("never throws: an executor throw becomes a classified internal_error", async () => {
    const { executor } = makeFakeExecutor({
      todaySpent: async () => {
        throw new Error("ledger unreachable");
      },
    });
    const data = await dispatchPaymentsA2A(ENV, { operation: "payments.today_spent" }, { executor });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("internal_error");
    expect(data.errorToken).toBe("ERR_TOOL_EXECUTION_FAILED");
    expect(data.error).toContain("ledger unreachable");
  });

  it("without an injected executor the dispatch fails honestly (no fabricated success)", async () => {
    const data = await dispatchPaymentsA2A(ENV, { operation: "payments.list" }, {});
    expect(data.ok).toBe(false);
    expect(data.code).toBe("internal_error");
    expect(data.error).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// Anti-drift: the card advertises exactly what the dispatch serves
// ---------------------------------------------------------------------------

describe("payments card anti-drift (#2223 payments)", () => {
  it("the payments card operations equal the dispatch served-operations constant", () => {
    const card = getAgentCard("payments");
    expect(card).toBeDefined();
    expect(card!.operations).toEqual([...PAYMENTS_A2A_OPERATIONS]);
  });

  it("payments.draft is NOT on the payments card and IS on the orchestrator card", () => {
    expect(getAgentCard("payments")!.operations).not.toContain("payments.draft");
    expect(getAgentCard("orchestrator")!.operations).toContain("payments.draft");
    expect(AGENT_CARDS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Entrypoint: the dispatcher reaches the payments stub on the URL-name
// instance (slice 1 resolution parity)
// ---------------------------------------------------------------------------

describe("A2A entrypoint reaches PaymentsAgent (#2223 payments)", () => {
  it("POST /a2a/payments resolves PAYMENTS_AGENT with idFromName('payments')", async () => {
    const idFromNameCalls: string[] = [];
    const stubCalls: unknown[] = [];
    const env = {
      A2A_API_TOKEN: "test-token",
      PAYMENTS_AGENT: {
        idFromName: (name: string) => {
          idFromNameCalls.push(name);
          return name;
        },
        get: (_id: unknown) => ({
          handleA2A: async (body: unknown, origin: string) => {
            stubCalls.push({ body, origin });
            return { text: "ok", data: { ok: true } };
          },
        }),
      },
    };
    const req = new Request("https://agent.test/a2a/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "message/send",
        params: { message: { parts: [{ kind: "data", data: { operation: "payments.list" } }] } },
      }),
    });
    const res = await handleA2A(req, env as any);
    expect(res.status).toBe(200);
    expect(idFromNameCalls).toEqual(["payments"]);
    expect(stubCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Money path: the REAL PaymentsAgent through its real handleA2A.
// Harness mirrors tests/payments_guard.test.ts (#896): a real ledger
// owner (DatabaseORM over MockSqlStorage) served through the REAL
// agentic-payments routes, bound as ORCHESTRATOR_AGENT. Only the
// facilitator's HTTP transport is stubbed — the class's own
// verification logic (proof parsing, simulated-proof rejection,
// isValid check) runs for real.
// ---------------------------------------------------------------------------

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
    _store: store,
  };
}

function makeLedgerEnv(): any {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  orm.initializeSchema("default_trader");
  const routeCtx = { env: {}, getOrm: () => orm, audit: () => {} };
  return {
    CF_WALLET_FACILITATOR: "https://facilitator.test",
    SERVICE_USER_LOGIN: "default_trader",
    ORCHESTRATOR_AGENT: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          const res = await handleAgenticPaymentsRoutes(
            req,
            url,
            url.pathname,
            "default_trader",
            routeCtx as any
          );
          return res ?? Response.json({ error: "no such route" }, { status: 404 });
        },
      }),
    },
  };
}

const validProof = () => btoa(JSON.stringify({ signature: "0xsig", payer: "0xpayer", nonce: "n1" }));

function processBody(overrides: Record<string, unknown> = {}) {
  return {
    operation: "payments.process",
    agentId: "a1",
    op: "search.query",
    amountCents: 10,
    idempotencyKey: "pay-door-1",
    paymentProof: validProof(),
    ...overrides,
  };
}

describe("PaymentsAgent.handleA2A money path (#2223 payments)", () => {
  it("a facilitator REJECTION is a classified failure and records NOTHING", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ isValid: false }));
    const agent = new (PaymentsAgent as any)(makeCtx(), makeLedgerEnv());
    const outcome = await agent.handleA2A(processBody(), "https://agent.test");
    expect(outcome.data.ok).toBe(false);
    expect(outcome.data.code).toBe("payment_verification_failed");
    expect(outcome.text).toContain("failed");
    expect(await agent.listPayments()).toHaveLength(0);
  });

  it("a facilitator APPROVAL records exactly ONE ledger payment", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ isValid: true }));
    const agent = new (PaymentsAgent as any)(makeCtx(), makeLedgerEnv());
    const outcome = await agent.handleA2A(processBody(), "https://agent.test");
    expect(outcome.data.ok).toBe(true);
    expect((outcome.data.result as any).status).toBe("verified");
    const payments = await agent.listPayments();
    expect(payments).toHaveLength(1);
    expect(payments[0].idempotencyKey).toBe("pay-door-1");
  });

  it("a replayed idempotency key is a classified duplicate and still exactly ONE record", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ isValid: true }));
    const agent = new (PaymentsAgent as any)(makeCtx(), makeLedgerEnv());
    const first = await agent.handleA2A(processBody(), "https://agent.test");
    expect(first.data.ok).toBe(true);
    const second = await agent.handleA2A(processBody(), "https://agent.test");
    expect(second.data.ok).toBe(false);
    expect(second.data.code).toBe("duplicate_idempotency_key");
    expect(await agent.listPayments()).toHaveLength(1);
  });

  it("a SIMULATED proof is rejected before the facilitator is called and records NOTHING", async () => {
    const fetchMock = vi.fn(async () => Response.json({ isValid: true }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new (PaymentsAgent as any)(makeCtx(), makeLedgerEnv());
    const simulated = btoa(JSON.stringify({ signature: "simulated", payer: "0xpayer", simulated: true }));
    const outcome = await agent.handleA2A(
      processBody({ paymentProof: simulated }),
      "https://agent.test"
    );
    expect(outcome.data.ok).toBe(false);
    expect(outcome.data.code).toBe("payment_verification_failed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await agent.listPayments()).toHaveLength(0);
  });

  it("a budget DENIAL (over the per-call cap) is classified budget_denied and records NOTHING", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ isValid: true }));
    const agent = new (PaymentsAgent as any)(makeCtx(), makeLedgerEnv());
    const outcome = await agent.handleA2A(
      processBody({ amountCents: 1001, idempotencyKey: "pay-door-over" }),
      "https://agent.test"
    );
    expect(outcome.data.ok).toBe(false);
    expect(outcome.data.code).toBe("budget_denied");
    expect(await agent.listPayments()).toHaveLength(0);
  });

  it("budget_check through the door returns the verdict as a success result", async () => {
    const agent = new (PaymentsAgent as any)(makeCtx(), makeLedgerEnv());
    const outcome = await agent.handleA2A(
      // Issue #2327: the door requires the caller's agentId, like
      // payments.process — an anonymous check is invalid input now.
      { operation: "payments.budget_check", op: "search.query", amountCents: 100, agentId: "door-caller" },
      "https://agent.test"
    );
    expect(outcome.data.ok).toBe(true);
    expect((outcome.data.result as any).allowed).toBe(true);
  });
});
