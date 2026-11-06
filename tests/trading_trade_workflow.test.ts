/**
 * Issue #291 slice T3b — the durable trade approval workflow.
 *
 * Pins: the flow settles exactly once from an explicit decision event
 * (approve and reject), expires WITHOUT settling when no decision
 * arrives, refuses anonymous decisions through the shared settle core,
 * and the deployment wiring (wrangler binding, server export, class
 * shape, agent doors' guards) stays in place.
 *
 * #2375: the flow's settle step delegates to the order owner's
 * TradingAgent approval door (executeApprovedOrder) instead of
 * calling the settle core workflow-side — the draft store lives in
 * the agent's DO. The fake TRADING_AGENT namespace below is the
 * binding seam: its stub's executeApprovedOrder delegates straight
 * to the shared settle core, so every assertion in this file still
 * exercises the same core validation and platform contract.
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Issue #1738: TradingAgent is an Agents SDK actor now, so its
// module graph pulls `cloudflare:` imports the node loader cannot
// resolve — mock the SDK with a plain base class (the
// api_chat_route.test.ts idiom). The ThinkWorkflow stub stays: the
// workflow class is still ThinkWorkflow by ADR 0004 W13.
vi.mock("agents", () => {
  return {
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
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import {
  runTradeApprovalFlow,
  TradingTradeWorkflow,
  TRADE_APPROVAL_TIMEOUT,
  type TradeApprovalStep,
} from "../src/agents/trading-trade-workflow";
import { TradingAgent, settleTradingOrder } from "../src/agents/trading-agent";
import { getTradingAgentConfig } from "../src/config/tradingAgentConfig";
import { TradingPlatformRegistry } from "../src/trading";
import type { Env } from "../src/types";

const executions: any[] = [];
TradingPlatformRegistry.register("fakeflow291" as any, () => ({
  platformId: "fakeflow291",
  name: "Fake Flow 291",
  getStatus: async () => ({}),
  getQuote: async () => ({}),
  getAccounts: async () => [],
  getPositions: async () => ({ account: {}, positions: [] }),
  previewOrder: async (params: any) => ({ id: "draft-flow", ...params }),
  executeOrder: async (orderId: string, authorizerDid: string, decision: string) => {
    executions.push({ orderId, authorizerDid, decision });
    return { orderId, status: decision === "approved" ? "placed" : "cancelled", authorizerDid };
  },
}) as any);

const coreEnv = {
  TRADING_AGENT_PROVIDERS: "fakeflow291",
  TRADING_AGENT_DEFAULT_PROVIDER: "fakeflow291",
} as unknown as Env;

const env = {
  TRADING_AGENT_PROVIDERS: "fakeflow291",
  TRADING_AGENT_DEFAULT_PROVIDER: "fakeflow291",
  // #2375 binding seam: the approval-door stub the flow's settle
  // step reaches. It delegates to the shared settle core exactly as
  // the real agent's executeApprovedOrder does.
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

function fakeStep(payload: unknown, opts: { timeout?: boolean } = {}): TradeApprovalStep {
  return {
    waitForEvent: async () => {
      if (opts.timeout) throw new Error("waitForEvent timed out");
      return { payload } as any;
    },
    do: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

describe("trade approval flow (#291 T3b)", () => {
  it("settles an approved decision exactly once, with the authorizer verified by the core", async () => {
    executions.length = 0;
    const outcome = await runTradeApprovalFlow(
      env,
      { orderId: "draft-flow", provider: "fakeflow291", userLogin: "default_trader" },
      fakeStep({ decision: "approved", authorizerDid: "did:web:venus" }),
    );
    expect(outcome.status).toBe("settled");
    if (outcome.status === "settled") {
      expect(outcome.decision).toBe("approved");
      expect((outcome.result as any).status).toBe("placed");
    }
    expect(executions).toEqual([
      { orderId: "draft-flow", authorizerDid: "did:web:venus", decision: "approved" },
    ]);
    expect(TRADE_APPROVAL_TIMEOUT).toBe("24 hours");
  });

  it("settles a rejection through the same door (draft cancelled, nothing placed)", async () => {
    executions.length = 0;
    const outcome = await runTradeApprovalFlow(
      env,
      { orderId: "draft-flow", provider: "fakeflow291", userLogin: "default_trader" },
      fakeStep({ decision: "rejected", authorizerDid: "did:web:venus", reason: "too big" }),
    );
    expect(outcome.status).toBe("settled");
    expect(executions).toEqual([
      { orderId: "draft-flow", authorizerDid: "did:web:venus", decision: "rejected" },
    ]);
  });

  it("expires without settling when no decision arrives", async () => {
    executions.length = 0;
    const outcome = await runTradeApprovalFlow(
      env,
      { orderId: "draft-flow", provider: "fakeflow291", userLogin: "default_trader" },
      fakeStep(null, { timeout: true }),
    );
    expect(outcome).toEqual({ status: "expired", orderId: "draft-flow" });
    expect(executions).toHaveLength(0);
  });

  it("an anonymous decision event cannot settle — the core refuses it", async () => {
    executions.length = 0;
    const err: any = await runTradeApprovalFlow(
      env,
      { orderId: "draft-flow", provider: "fakeflow291", userLogin: "default_trader" },
      fakeStep({ decision: "approved", authorizerDid: "" }),
    ).catch((e) => e);
    expect(err.code).toBe("invalid_input");
    expect(executions).toHaveLength(0);
  });
});

describe("trade workflow wiring (#291 T3b)", () => {
  it("the workflow class extends ThinkWorkflow and is exported from the entrypoint", () => {
    expect(TradingTradeWorkflow.prototype).toBeInstanceOf(ThinkWorkflow);
    // Slice 9 of #2902 moves the exports to src/server/exports.ts;
    // server.ts re-exports them. The live export surface is both files;
    // the export moved one directory deeper, so the relative path is
    // now ../ — the module is the same; the pattern accepts either spelling.
    const server =
      fs.readFileSync(path.join(__dirname, "../src/server.ts"), "utf8") +
      fs.readFileSync(path.join(__dirname, "../src/server/exports.ts"), "utf8");
    expect(server).toMatch(/export \{ TradingTradeWorkflow \} from "\.{1,2}\/agents\/trading-trade-workflow"/);
  });

  it("wrangler binds TRADE_WORKFLOW to the workflow class", () => {
    const wrangler = fs.readFileSync(path.join(__dirname, "../wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"binding": "TRADE_WORKFLOW"');
    expect(wrangler).toContain('"class_name": "TradingTradeWorkflow"');
  });

  it("the agent doors guard their inputs before touching the workflow runtime", async () => {
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = {} as Env;
    const noOrder: any = await agent.startTradeApproval({}).catch((e: any) => e);
    expect(noOrder.code).toBe("invalid_input");
    const unconfigured: any = await agent
      .startTradeApproval({ orderId: "draft-flow" })
      .catch((e: any) => e);
    expect(unconfigured.code).toBe("internal_error");
    const anon: any = await agent
      .decideTradeApproval({ workflowId: "wf-1", decision: "approved" })
      .catch((e: any) => e);
    expect(anon.code).toBe("invalid_input");
  });

  it("startTradeApproval records a trade.approval_started audit carrying the workflow id (#2989)", async () => {
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = { TRADE_WORKFLOW: {} };
    agent.runWorkflow = async () => "trade-wf-1";
    agent.instanceUserLogin = () => "alice";
    const created: any[] = [];
    agent.getOrm = () => ({ events: { create: (row: any) => { created.push(row); return row; } } });
    const res = await agent.startTradeApproval({ orderId: "draft-1", provider: "fake", userLogin: "alice" });
    expect(res).toEqual({ workflowId: "trade-wf-1", orderId: "draft-1", status: "awaiting_approval" });
    const started = created.find((r) => r.type === "trade.approval_started");
    expect(started).toBeDefined();
    expect(started.payload).toMatchObject({ orderId: "draft-1", workflowId: "trade-wf-1" });
  });

  it("a failing start audit never fails the trade approval start (#2989)", async () => {
    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = { TRADE_WORKFLOW: {} };
    agent.runWorkflow = async () => "trade-wf-1";
    agent.instanceUserLogin = () => "alice";
    agent.getOrm = () => { throw new Error("orm down"); };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await agent.startTradeApproval({ orderId: "draft-1", provider: "fake", userLogin: "alice" });
      expect(res.workflowId).toBe("trade-wf-1");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
