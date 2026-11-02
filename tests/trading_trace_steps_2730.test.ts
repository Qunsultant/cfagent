/**
 * Issue #2730 (tracker #2708 item A5) — close the S17 trace break
 * `trading-workflow-steps`: TradeApprovalParams carry the turn's
 * traceparent from the start_trade_approval door, and
 * TradingTradeWorkflow's flow records its step hops under that
 * trace with the landed S17 mechanism (deterministic spans from
 * (orderId, step name), recorded after each step's journaled
 * result, best-effort — tracing observes, never decides).
 *
 * Pins:
 *  - carriage end-to-end: door (McpToolContext.traceparent
 *    resolver, server-side only) → startTradeApprovalViaDoor →
 *    TradingAgent.startTradeApproval → workflow params;
 *  - a settled run's hops join the door's trace id (operations
 *    await-approval / settle-trade), parented on the carried
 *    span, agent TradingTradeWorkflow, jobId = the run's orderId;
 *  - replay convergence: re-running the flow re-records the
 *    identical deterministic spans — one hop per step;
 *  - absence degrades honestly: no traceparent (or a malformed
 *    one) records NOTHING and never mints mid-flight — the
 *    landed recordWorkflowTraceHop contract — and the flow's
 *    outcomes are unchanged;
 *  - the registry spine cell reads carried.
 */

import { describe, it, expect, vi } from "vitest";

// Issue #1738: TradingAgent is an Agents SDK actor, so its module
// graph pulls `cloudflare:` imports the node loader cannot
// resolve — mock the SDK with a plain base class (the
// trading_trade_workflow.test.ts idiom).
vi.mock("agents", () => {
  return {
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

import {
  runTradeApprovalFlow,
  TradingTradeWorkflow,
  type TradeApprovalStep,
} from "../src/agents/trading-trade-workflow";
import { TradingAgent, settleTradingOrder } from "../src/agents/trading-agent";
import { getTradingAgentConfig } from "../src/config/tradingAgentConfig";
import { TradingPlatformRegistry } from "../src/trading";
import { StartTradeApprovalCommand } from "../src/mcps/openaimp/meshDoorCommands";
import {
  meshTraceStoreForEnv,
  readTraceHops,
} from "../src/data/createMeshTracePorts";
import { deterministicSpanId } from "../src/observability/meshTrace";
import { MESH_TRACE_SPINE } from "../src/agents/registry";
import type { McpToolContext } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CARRIED_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${CARRIED_SPAN_ID}-01`;

const executions: any[] = [];
TradingPlatformRegistry.register("faketrace2730" as any, () => ({
  platformId: "faketrace2730",
  name: "Fake Trace 2730",
  getStatus: async () => ({}),
  getQuote: async () => ({}),
  getAccounts: async () => [],
  getPositions: async () => ({ account: {}, positions: [] }),
  previewOrder: async (params: any) => ({ id: "draft-2730", ...params }),
  executeOrder: async (orderId: string, authorizerDid: string, decision: string) => {
    executions.push({ orderId, authorizerDid, decision });
    return { orderId, status: decision === "approved" ? "placed" : "cancelled", authorizerDid };
  },
}) as any);

const coreEnv = {
  TRADING_AGENT_PROVIDERS: "faketrace2730",
  TRADING_AGENT_DEFAULT_PROVIDER: "faketrace2730",
} as unknown as Env;

/** Flow env: the #2375 approval-door stub over the shared settle core, no AGENT_DB (in-memory trace store). */
function makeFlowEnv() {
  const env = {
    TRADING_AGENT_PROVIDERS: "faketrace2730",
    TRADING_AGENT_DEFAULT_PROVIDER: "faketrace2730",
    TRADING_AGENT: {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        executeApprovedOrder: (input: any) =>
          settleTradingOrder(
            coreEnv,
            getTradingAgentConfig(coreEnv as unknown as Record<string, unknown>),
            input,
            "workflow",
          ),
      }),
    },
  } as unknown as Env;
  return env;
}

function fakeStep(payload: unknown, opts: { timeout?: boolean } = {}): TradeApprovalStep {
  return {
    waitForEvent: async () => {
      if (opts.timeout) throw new Error("waitForEvent timed out");
      return { payload } as any;
    },
    do: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

/* ------------------------------------------------------------------ */
/* Carriage: door -> via-door -> agent -> workflow params              */
/* ------------------------------------------------------------------ */

describe("issue #2730 — traceparent carriage into the trade workflow params", () => {
  function makeDoorHarness(withTraceparent: boolean) {
    const captured: any[] = [];
    const agent: any = Object.create(TradingAgent.prototype);
    const env: Record<string, unknown> = {
      SERVICE_USER_LOGIN: "svc-background",
      TRADING_AGENT_PROVIDERS: "faketrace2730",
      TRADING_AGENT_DEFAULT_PROVIDER: "faketrace2730",
      TRADE_WORKFLOW: {},
    };
    agent.env = env as Env;
    agent.runWorkflow = async (_binding: string, params: unknown) => {
      captured.push(params);
      return "wf-2730-1";
    };
    env.TRADING_AGENT = {
      idFromName: (name: string) => name,
      get: (_id: unknown) => agent,
    };
    const context = {
      env: env as Env,
      orm: {} as any,
      sessionId: "session-2730",
      audit: vi.fn(),
      actingLogin: () => "alice",
      ...(withTraceparent ? { traceparent: () => TRACEPARENT } : {}),
    } as unknown as McpToolContext;
    return { captured, context };
  }

  it("the door stamps the turn's traceparent into the workflow params", async () => {
    const { captured, context } = makeDoorHarness(true);
    const result: any = await new StartTradeApprovalCommand().execute(
      { orderId: "draft-2730" },
      context,
    );
    expect(result.status).toBe("awaiting_approval");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(
      expect.objectContaining({
        orderId: "draft-2730",
        userLogin: "alice",
        traceparent: TRACEPARENT,
      }),
    );
  });

  it("a door call with no traceparent carrier produces params with no traceparent field", async () => {
    const { captured, context } = makeDoorHarness(false);
    const result: any = await new StartTradeApprovalCommand().execute(
      { orderId: "draft-2730" },
      context,
    );
    expect(result.status).toBe("awaiting_approval");
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("traceparent");
  });

  it("TradingAgent.startTradeApproval threads an explicit traceparent input and omits it otherwise", async () => {
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = { TRADE_WORKFLOW: {} } as unknown as Env;
    const captured: any[] = [];
    agent.runWorkflow = async (_binding: string, params: unknown) => {
      captured.push(params);
      return "wf-2730-2";
    };
    await agent.startTradeApproval({
      orderId: "draft-2730",
      userLogin: "alice",
      traceparent: TRACEPARENT,
    });
    await agent.startTradeApproval({ orderId: "draft-2730", userLogin: "alice" });
    expect(captured[0]).toEqual(
      expect.objectContaining({ traceparent: TRACEPARENT }),
    );
    expect(captured[1]).not.toHaveProperty("traceparent");
  });
});

/* ------------------------------------------------------------------ */
/* Step hops: the flow records under the carried trace                 */
/* ------------------------------------------------------------------ */

describe("issue #2730 — TradingTradeWorkflow step hops join the door's trace", () => {
  it("a settled run records await-approval + settle-trade hops under the carried trace id", async () => {
    executions.length = 0;
    const env = makeFlowEnv();
    const outcome = await runTradeApprovalFlow(
      env,
      {
        orderId: "draft-2730",
        provider: "faketrace2730",
        userLogin: "alice",
        traceparent: TRACEPARENT,
      },
      fakeStep({ decision: "approved", authorizerDid: "did:web:venus" }),
    );
    expect(outcome.status).toBe("settled");
    expect(executions).toHaveLength(1);

    const hops = await readTraceHops(env, TRACE_ID);
    expect(hops).toHaveLength(2);
    const byOperation = new Map(hops.map((h) => [h.operation, h]));
    for (const operation of ["await-approval", "settle-trade"]) {
      const hop = byOperation.get(operation);
      expect(hop, operation).toBeDefined();
      expect(hop!.kind).toBe("workflow-step");
      expect(hop!.traceId).toBe(TRACE_ID);
      expect(hop!.spanId).toBe(deterministicSpanId(`draft-2730:${operation}`));
      expect(hop!.parentSpanId).toBe(CARRIED_SPAN_ID);
      expect(hop!.agent).toBe("TradingTradeWorkflow");
      expect(hop!.jobId).toBe("draft-2730");
      expect(hop!.caller).toBe("alice");
    }
  });

  it("replay re-records converge: running the flow twice leaves one hop per step", async () => {
    const env = makeFlowEnv();
    const params = {
      orderId: "draft-2730",
      provider: "faketrace2730",
      userLogin: "alice",
      traceparent: TRACEPARENT,
    };
    const step = () =>
      fakeStep({ decision: "approved", authorizerDid: "did:web:venus" });
    await runTradeApprovalFlow(env, params, step());
    await runTradeApprovalFlow(env, params, step());
    const hops = await readTraceHops(env, TRACE_ID);
    expect(hops).toHaveLength(2);
    expect(new Set(hops.map((h) => h.spanId)).size).toBe(2);
  });

  it("an expired run records the await-approval hop with the expired note and settles nothing", async () => {
    executions.length = 0;
    const env = makeFlowEnv();
    const outcome = await runTradeApprovalFlow(
      env,
      {
        orderId: "draft-2730",
        provider: "faketrace2730",
        userLogin: "alice",
        traceparent: TRACEPARENT,
      },
      fakeStep(null, { timeout: true }),
    );
    expect(outcome).toEqual({ status: "expired", orderId: "draft-2730" });
    expect(executions).toHaveLength(0);
    const hops = await readTraceHops(env, TRACE_ID);
    expect(hops).toHaveLength(1);
    expect(hops[0].operation).toBe("await-approval");
    expect(hops[0].kind).toBe("workflow-step");
    expect(hops[0].note).toBe("expired");
  });

  it("no traceparent → no hops recorded, nothing minted, outcome unchanged", async () => {
    executions.length = 0;
    const env = makeFlowEnv();
    const store = meshTraceStoreForEnv(env);
    const recordSpy = vi.spyOn(store, "record");
    const outcome = await runTradeApprovalFlow(
      env,
      { orderId: "draft-2730", provider: "faketrace2730", userLogin: "alice" },
      fakeStep({ decision: "approved", authorizerDid: "did:web:venus" }),
    );
    expect(outcome.status).toBe("settled");
    expect(executions).toHaveLength(1);
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("a malformed traceparent → no hops, no throw, outcome unchanged", async () => {
    const env = makeFlowEnv();
    const store = meshTraceStoreForEnv(env);
    const recordSpy = vi.spyOn(store, "record");
    const outcome = await runTradeApprovalFlow(
      env,
      {
        orderId: "draft-2730",
        provider: "faketrace2730",
        userLogin: "alice",
        traceparent: "not-a-traceparent",
      },
      fakeStep({ decision: "rejected", authorizerDid: "did:web:venus" }),
    );
    expect(outcome.status).toBe("settled");
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("the workflow class carries the payload traceparent into the flow", async () => {
    const env = makeFlowEnv();
    const workflow: any = Object.create(TradingTradeWorkflow.prototype);
    workflow.env = env;
    const step = {
      waitForEvent: async () => ({
        payload: { decision: "approved", authorizerDid: "did:web:venus" },
      }),
      do: async (_name: string, fn: () => Promise<unknown>) => fn(),
    };
    const outcome = await workflow.run(
      {
        payload: {
          orderId: "draft-2730",
          provider: "faketrace2730",
          userLogin: "alice",
          traceparent: TRACEPARENT,
        },
      },
      step,
    );
    expect(outcome.status).toBe("settled");
    const hops = await readTraceHops(env, TRACE_ID);
    expect(hops.map((h) => h.operation).sort()).toEqual([
      "await-approval",
      "settle-trade",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Registry truth-sync                                                 */
/* ------------------------------------------------------------------ */

describe("issue #2730 — registry spine truth-sync", () => {
  it("MESH_TRACE_SPINE records trading-workflow-steps as carried", () => {
    const entry = MESH_TRACE_SPINE.find((e) => e.hop === "trading-workflow-steps");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("carried");
    expect(entry!.carrier).toContain("TradeApprovalParams.traceparent");
    expect(entry!.evidence).toContain("workflow-step");
    const breaks = MESH_TRACE_SPINE.filter((e) => e.status === "break");
    expect(breaks.map((b) => b.hop).sort()).toEqual([
      "channel-ingress-turns",
      "http-route-workflow-starts",
      "payment-workflow-steps",
    ]);
  });
});
