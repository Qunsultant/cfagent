/**
 * Issue #2223 (slice 1) — OrchestratorAgent A2A dispatch.
 *
 * Pre-#2223 the orchestrator card advertised operations
 * (search.query, payments.draft, tasks.create, memory.remember,
 * nlq.execute) that no code served: the name had no catalog entry,
 * so the dispatcher 404'd. This slice serves them for real through
 * the MAS tool factory (src/agents/mas.ts — the same createMAS the
 * Search Hub MAS tab uses) and the NLQ async executor, following the
 * TradingAgent dispatch template (SURVEY §5): extract → dispatch
 * (never throws) → outcome wrapper with a mandatory text part.
 *
 * Honesty pins (SURVEY §3): tasks.create returns an UNPERSISTED
 * draft; payments.draft moves NO funds. The text part must say so.
 */
import { describe, it, expect } from "vitest";

import {
  ORCHESTRATOR_A2A_OPERATIONS,
  dispatchOrchestratorA2A,
  orchestratorA2AOutcome,
} from "../src/agents/orchestrator/a2aDispatch";
import { getAgentCard } from "../src/a2a/agent-cards";

const CANNED: Record<string, unknown> = {
  searchKnowledge: {
    query: "margin rules",
    resultsFound: true,
    count: 2,
    reportCount: 1,
    chunks: [{ title: "FINRA Rule 4210", snippet: "…", source: "scheduled_report" }],
    message: "Retrieved 1 scheduled-run report(s) and 2 factual documents.",
    source: "Scheduled reports + Cloudflare AI Search",
  },
  draftPayment: {
    draftId: "pay_abcd1234",
    requestId: "req-1",
    status: "awaiting_confirmation",
    requiresConfirmation: true,
    action: "charge",
    amount: 25,
    currency: "USD",
    customer: "acct-1",
    gateway: "sandbox",
    securityNotice: "NO FUNDS HAVE BEEN MOVED.",
  },
  confirmDraft: { draftId: "pay_abcd1234", status: "completed", decision: "approved" },
  createTaskDraft: {
    taskId: "task_abcd1234",
    status: "draft",
    requiresConfirmation: true,
    title: "Review Q3 report",
    message: "Task draft created. Awaiting human confirmation via 'confirmDraft'.",
  },
  rememberFact: { stored: true, key: "preferred_tone", value: "direct", updatedAt: "2026-10-29T00:00:00Z" },
  recallFacts: { count: 1, facts: [{ key: "preferred_tone", value: "direct", updated_at: "2026-10-29T00:00:00Z" }] },
};

function fakeMasFactory(behavior: Record<string, (args: never) => unknown> = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown>; options: any }> = [];
  const make =
    (tool: string) =>
    async (args: Record<string, unknown>, options: any): Promise<unknown> => {
      calls.push({ tool, args, options });
      const b = behavior[tool];
      if (b) return b(args as never);
      return CANNED[tool];
    };
  const factory = (_env: unknown, _ctx: unknown) => ({
    searchKnowledge: { execute: make("searchKnowledge") },
    draftPayment: { execute: make("draftPayment") },
    createTaskDraft: { execute: make("createTaskDraft") },
    confirmDraft: { execute: make("confirmDraft") },
    rememberFact: { execute: make("rememberFact") },
    recallFacts: { execute: make("recallFacts") },
  });
  return { factory, calls };
}

function makeDeps(opts: { masBehavior?: Record<string, (args: never) => unknown>; withNlq?: boolean } = {}) {
  const mas = fakeMasFactory(opts.masBehavior);
  const nlqCalls: string[] = [];
  const deps: Record<string, unknown> = {
    sessionId: "sess-a2a-test",
    sql: { exec: (_q: string, ..._a: unknown[]) => [] as unknown[] },
    audit: () => {},
    masFactory: mas.factory,
  };
  if (opts.withNlq !== false) {
    deps.nlqExecute = async (query: string) => {
      nlqCalls.push(query);
      return { status: "success", summary: "fake nlq result", rows: [], count: 0 };
    };
  }
  return { deps, masCalls: mas.calls, nlqCalls };
}

const ENV = {} as never;

describe("orchestrator A2A dispatch (#2223 slice 1)", () => {
  it("search.query routes to MAS searchKnowledge with the production call shape", async () => {
    const { deps, masCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(ENV, { operation: "search.query", query: "margin rules" }, deps as never);
    expect(data.ok).toBe(true);
    expect(data.operation).toBe("search.query");
    expect(typeof data.correlationId).toBe("string");
    expect((data.correlationId as string).length).toBeGreaterThan(0);
    expect(data.result).toEqual(CANNED.searchKnowledge);
    expect(masCalls).toHaveLength(1);
    expect(masCalls[0].tool).toBe("searchKnowledge");
    expect(masCalls[0].args).toEqual({ query: "margin rules" });
    // searchHub.ts precedent: toolCallId + a user message carrying the
    // natural-language arg + empty context.
    expect(typeof masCalls[0].options.toolCallId).toBe("string");
    expect(masCalls[0].options.messages).toEqual([{ role: "user", content: "margin rules" }]);
    expect(masCalls[0].options.context).toEqual({});
    expect(orchestratorA2AOutcome(data).text).toContain("search.query");
  });

  it("payments.draft routes to MAS draftPayment and its text says no funds moved", async () => {
    const { deps, masCalls } = makeDeps();
    const args = { operation: "payments.draft", action: "charge", amount: 25, currency: "USD", customer: "acct-1", gateway: "sandbox" };
    const data = await dispatchOrchestratorA2A(ENV, args, deps as never);
    expect(data.ok).toBe(true);
    expect(masCalls[0].tool).toBe("draftPayment");
    expect(masCalls[0].args).toEqual({ action: "charge", amount: 25, currency: "USD", customer: "acct-1", gateway: "sandbox" });
    const { text } = orchestratorA2AOutcome(data);
    expect(text).toContain("awaiting_confirmation");
    expect(text).toContain("NO FUNDS HAVE BEEN MOVED");
  });

  it("payments.confirm routes to MAS confirmDraft", async () => {
    const { deps, masCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "payments.confirm", draftId: "pay_abcd1234", decision: "approved" },
      deps as never,
    );
    expect(data.ok).toBe(true);
    expect(masCalls[0].tool).toBe("confirmDraft");
    expect(masCalls[0].args).toEqual({ draftId: "pay_abcd1234", decision: "approved" });
    expect((data.result as { status: string }).status).toBe("completed");
  });

  it("tasks.create routes to MAS createTaskDraft and its text says UNPERSISTED draft", async () => {
    const { deps, masCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(ENV, { operation: "tasks.create", title: "Review Q3 report" }, deps as never);
    expect(data.ok).toBe(true);
    expect(masCalls[0].tool).toBe("createTaskDraft");
    expect(masCalls[0].args).toEqual({ title: "Review Q3 report" });
    const { text } = orchestratorA2AOutcome(data);
    expect(text).toContain("UNPERSISTED");
    expect(text.toLowerCase()).toContain("draft");
    expect(text).not.toContain("tracked task was created");
  });

  it("memory.remember routes to MAS rememberFact", async () => {
    const { deps, masCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "memory.remember", key: "preferred_tone", value: "direct" },
      deps as never,
    );
    expect(data.ok).toBe(true);
    expect(masCalls[0].tool).toBe("rememberFact");
    expect(masCalls[0].args).toEqual({ key: "preferred_tone", value: "direct" });
  });

  it("memory.recall routes to MAS recallFacts", async () => {
    const { deps, masCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(ENV, { operation: "memory.recall", filter: "tone" }, deps as never);
    expect(data.ok).toBe(true);
    expect(masCalls[0].tool).toBe("recallFacts");
    expect(masCalls[0].args).toEqual({ filter: "tone" });
    expect((data.result as { count: number }).count).toBe(1);
  });

  it("nlq.execute routes to the injected NLQ executor, not to MAS", async () => {
    const { deps, masCalls, nlqCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "nlq.execute", query: "screen stocks with PE below 15" },
      deps as never,
    );
    expect(data.ok).toBe(true);
    expect(nlqCalls).toEqual(["screen stocks with PE below 15"]);
    expect(masCalls).toHaveLength(0);
  });

  it("accepts the JSON-RPC message/send data-part envelope (trading template)", async () => {
    const { deps, masCalls } = makeDeps();
    const body = {
      jsonrpc: "2.0",
      id: "req-9",
      method: "message/send",
      params: {
        message: {
          parts: [{ kind: "data", data: { operation: "memory.recall", filter: "tone" } }],
        },
      },
    };
    const data = await dispatchOrchestratorA2A(ENV, body, deps as never);
    expect(data.ok).toBe(true);
    expect(data.operation).toBe("memory.recall");
    expect(masCalls[0].args).toEqual({ filter: "tone" });
  });

  it("unknown operation → classified unknown_operation with a catalog errorToken", async () => {
    const { deps, masCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(ENV, { operation: "bogus.op" }, deps as never);
    expect(data.ok).toBe(false);
    expect(data.code).toBe("unknown_operation");
    expect(data.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
    expect(data.correlationId).toBeTruthy();
    expect(masCalls).toHaveLength(0);
    expect(orchestratorA2AOutcome(data).text).toContain("failed:");
  });

  it("missing operation → missing_operation (empty body, null body, non-object body)", async () => {
    const { deps } = makeDeps();
    for (const body of [{}, null, "a string", 42]) {
      const data = await dispatchOrchestratorA2A(ENV, body, deps as never);
      expect(data.ok).toBe(false);
      expect(data.code).toBe("missing_operation");
      expect(data.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
      expect(data.correlationId).toBeTruthy();
    }
  });

  it("never throws when an executor throws — classified internal_error", async () => {
    const { deps } = makeDeps({
      masBehavior: {
        searchKnowledge: () => {
          throw new Error("upstream down");
        },
      },
    });
    const data = await dispatchOrchestratorA2A(ENV, { operation: "search.query", query: "x" }, deps as never);
    expect(data.ok).toBe(false);
    expect(data.code).toBe("internal_error");
    expect(data.errorToken).toBe("ERR_TOOL_EXECUTION_FAILED");
    expect(data.error).toContain("upstream down");
  });

  it("nlq.execute without an injected executor fails honestly (no fabricated plan)", async () => {
    const { deps } = makeDeps({ withNlq: false });
    const data = await dispatchOrchestratorA2A(ENV, { operation: "nlq.execute", query: "anything" }, deps as never);
    expect(data.ok).toBe(false);
    expect(data.code).toBe("internal_error");
    expect(data.error).toMatch(/not configured/i);
  });

  it("search.query without a query is invalid_input, not a tool call", async () => {
    const { deps, masCalls } = makeDeps();
    const data = await dispatchOrchestratorA2A(ENV, { operation: "search.query" }, deps as never);
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(masCalls).toHaveLength(0);
  });

  it("default MAS factory: memory.remember runs the REAL createMAS against injected sql", async () => {
    const execs: Array<{ query: string; args: unknown[] }> = [];
    const deps = {
      sessionId: "sess-default-factory",
      sql: {
        exec: (query: string, ...args: unknown[]) => {
          execs.push({ query, args });
          return [] as unknown[];
        },
      },
      audit: () => {},
    };
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "memory.remember", key: "Preferred_Tone", value: "direct" },
      deps as never,
    );
    expect(data.ok).toBe(true);
    // rememberFact normalizes the key (trim + lowercase) in its native result.
    expect(data.result).toMatchObject({ stored: true, key: "preferred_tone", value: "direct" });
    expect(execs.some((e) => e.query.includes("INSERT INTO mas_memory"))).toBe(true);
  });

  it("anti-drift: orchestrator card ops == served ops; satellite cards are subsets", () => {
    const served = [...ORCHESTRATOR_A2A_OPERATIONS].sort();
    expect([...getAgentCard("orchestrator")!.operations].sort()).toEqual(served);
    for (const name of ["search", "tasks", "memory"]) {
      for (const op of getAgentCard(name)!.operations) {
        expect(ORCHESTRATOR_A2A_OPERATIONS, `${name}: ${op}`).toContain(op);
      }
    }
    expect([...getAgentCard("memory")!.operations].sort()).toEqual(
      ["memory.remember", "memory.recall"].sort(),
    );
  });
});

describe("orchestrator A2A schedule.* operations (issue #3122)", () => {
  const principal = { login: "OpenAIMP", agentId: "a2a-test" };

  function makeScheduleDeps(outcome?: (request: Record<string, unknown>) => Record<string, unknown>) {
    const requests: Array<Record<string, unknown>> = [];
    const deps: Record<string, unknown> = {
      sessionId: "sess-a2a-schedule",
      sql: { exec: (_q: string, ..._a: unknown[]) => [] as unknown[] },
      audit: () => {},
      agentScheduleExecute: async (request: Record<string, unknown>) => {
        requests.push(request);
        if (outcome) return outcome(request);
        return { ok: true, scheduleId: "sdk-1", schedule: { id: "sdk-1", callback: request.callback } };
      },
      schedulePrincipal: principal,
    };
    return { deps, requests };
  }

  it("3122-A2A1 schedule.create delegates to the capability with callback, timing, principal, tenant", async () => {
    const { deps, requests } = makeScheduleDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      {
        operation: "schedule.create",
        callback: "autonomousMarketScreen",
        timing: { type: "interval", intervalSeconds: 3600 },
      },
      deps as never,
    );
    expect(data.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: "create",
      kind: "sdk",
      callback: "autonomousMarketScreen",
      timing: { type: "interval", intervalSeconds: 3600 },
      principal,
      tenantId: "primary",
    });
    expect(orchestratorA2AOutcome(data).text).toContain("sdk-1");
  });

  it("3122-A2A2 schedule.* without a principal refuses fail-closed and never calls the capability (#4143)", async () => {
    const { deps, requests } = makeScheduleDeps();
    delete (deps as Record<string, unknown>).schedulePrincipal;
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.create", callback: "autonomousMarketScreen", timing: { type: "interval", intervalSeconds: 3600 } },
      deps as never,
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(data.error).toMatch(/#4143/);
    expect(requests).toHaveLength(0);
  });

  it("3122-A2A3 schedule.* without a bound capability fails honestly", async () => {
    const { deps } = makeDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.list" },
      deps as never,
    );
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/not configured/);
  });

  it("3122-A2A4 a capability refusal surfaces as the operation failure with the capability reason", async () => {
    const { deps } = makeScheduleDeps(() => ({
      ok: false,
      code: "denied",
      reason: "Callback 'executeAsyncJob' is not agent-schedulable.",
    }));
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.create", callback: "executeAsyncJob", timing: { type: "interval", intervalSeconds: 3600 } },
      deps as never,
    );
    expect(data.ok).toBe(false);
    expect(data.error).toContain("not agent-schedulable");
  });

  it("3122-A2A5 schedule.list / pause / resume / trigger / delete translate to capability actions", async () => {
    const { deps, requests } = makeScheduleDeps((request) => {
      if (request.action === "list") return { ok: true, schedule: [{ id: "sdk-1" }, { id: "sdk-2" }] };
      return { ok: true, scheduleId: "sdk-1" };
    });
    for (const [operation, args, action] of [
      ["schedule.list", {}, "list"],
      ["schedule.pause", { scheduleId: "sdk-1" }, "pause"],
      ["schedule.resume", { scheduleId: "sdk-1" }, "resume"],
      ["schedule.trigger", { scheduleId: "sdk-1" }, "trigger"],
      ["schedule.delete", { scheduleId: "sdk-1" }, "delete"],
    ] as const) {
      const data = await dispatchOrchestratorA2A(ENV, { operation, ...args }, deps as never);
      expect(data.ok).toBe(true);
    }
    expect(requests.map((r) => r.action)).toEqual(["list", "pause", "resume", "trigger", "delete"]);
    expect(requests.every((r) => r.kind === "sdk" && r.principal === principal)).toBe(true);
  });

  it("3122-A2A6 schedule.create rejects a malformed timing object as invalid input", async () => {
    const { deps, requests } = makeScheduleDeps();
    const data = await dispatchOrchestratorA2A(
      ENV,
      { operation: "schedule.create", callback: "autonomousMarketScreen", timing: { type: "interval" } },
      deps as never,
    );
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(requests).toHaveLength(0);
  });
});
