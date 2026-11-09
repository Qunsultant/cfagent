/**
 * Issue #2375 (Agent Mesh S9, programme #2225 G4) — a chat trade
 * runs as a TradingTradeWorkflow through TradingAgent's approval
 * door.
 *
 * Programme acceptance (#2225): G4 is proven by a test that starts
 * the real workflow from the chat path, with fakes only at the
 * binding seams — never a mocked-away run. The seams faked here,
 * each the repo's established idiom:
 *   - the TRADING_AGENT DO namespace (the S5/S6 door-test seam),
 *     whose stub is a REAL TradingAgent instance (prototype-built,
 *     the trading_trade_workflow.test.ts idiom);
 *   - the agent base's workflow runtime methods (runWorkflow /
 *     sendWorkflowEvent) — the binding seam between the agent and
 *     the workflow runtime — wired to a minimal runtime that runs
 *     the REAL runTradeApprovalFlow;
 *   - the flow's step interface (its documented fakeable seam):
 *     waitForEvent parks on a deferred the runtime's
 *     sendWorkflowEvent resolves; step.do runs the real settle
 *     closure;
 *   - the broker platform, registered in TradingPlatformRegistry
 *     (the fakeflow291 / fake1393 idiom): a stateful fake whose
 *     previewOrder drafts and whose executeOrder claim-then-executes
 *     against the draft's current state, exactly the contract the
 *     real platform enforces.
 * Everything between those seams is production code: the chat
 * commands, the mesh door, TradingAgent's approval door methods,
 * the workflow flow, the shared settle core, and the platform
 * resolution.
 *
 * Pins:
 *   - approved decision -> exactly one workflow run carrying the
 *     approved orderId + the acting identity, exactly one settle,
 *     exactly one broker execution; the authorizer DID the settle
 *     carries is derived server-side from the acting login
 *     (getUserDid) — the decision command's schema has no identity
 *     field at all;
 *   - rejected decision -> the same run settles the draft as
 *     rejected and places nothing (zero broker executions);
 *   - pending (no decision delivered) -> nothing settles, nothing
 *     executes, and the status read reports the run still awaiting;
 *   - missing/blank/"default" acting identity -> identity_required
 *     BEFORE the approval door is called (zero workflow runs);
 *   - run status reads come from the TRADE_WORKFLOW binding's own
 *     instance status (no second tracker);
 *   - the enabling fix: the agent's approval door settles a draft
 *     held in the agent's OWN store through the REAL E*TRADE
 *     platform (settle threads the instance ORM into platform
 *     resolution — before #2375 the settle core resolved its
 *     platform ORM-less and could not find any real draft).
 */
import { describe, expect, it, vi } from "vitest";

// Issue #1738: TradingAgent is an Agents SDK actor — mock the SDK
// with a plain base class (the trading_trade_workflow.test.ts
// idiom) so the real module graph's `cloudflare:` imports never
// reach the node loader.
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

import { TradingAgent } from "../src/agents/trading-agent";
import { runTradeApprovalFlow } from "../src/agents/trading-trade-workflow";
import { TradingPlatformRegistry } from "../src/trading";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { getUserDid } from "../src/agents/did";
import {
  MeshDoorError,
  startTradeApprovalViaDoor,
  decideTradeApprovalViaDoor,
  getTradeApprovalStatusViaDoor,
} from "../src/agents/orchestrator/meshDoors";
import {
  ProposeStockTradeCommand,
  StartTradeApprovalCommand,
  DecideTradeApprovalCommand,
  GetTradeApprovalStatusCommand,
} from "../src/mcps/openaimp/meshDoorCommands";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import type { McpToolContext } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

// ---------------------------------------------------------------------------
// Binding seam: the stateful fake broker platform
// ---------------------------------------------------------------------------

interface FakeDraft {
  orderId: string;
  symbol: string;
  action: string;
  quantity: number;
  price: number;
  totalValue: number;
  status: string;
}

const ledger = new Map<string, FakeDraft>();
const executions: Array<{ orderId: string; authorizerDid: string; decision: string }> = [];
const factoryOrms: Array<unknown> = [];
let draftSeq = 0;

TradingPlatformRegistry.register("fakeg4" as any, (_env: unknown, orm: unknown) => {
  factoryOrms.push(orm);
  return {
    platformId: "fakeg4",
    name: "Fake G4 Broker",
    getStatus: async () => ({}),
    getQuote: async () => ({}),
    getAccounts: async () => [],
    getPositions: async () => ({ account: {}, positions: [] }),
    previewOrder: async (params: any) => {
      const orderId = `ord-g4-${++draftSeq}`;
      const price = 100;
      ledger.set(orderId, {
        orderId,
        symbol: params.symbol,
        action: params.action,
        quantity: params.quantity,
        price,
        totalValue: price * params.quantity,
        status: "previewed",
      });
      return {
        orderId,
        symbol: params.symbol,
        action: params.action,
        orderAction: params.action,
        orderType: params.orderType ?? "MARKET",
        quantity: params.quantity,
        estimatedPrice: price,
        estimatedTotal: price * params.quantity,
        estimatedCommission: 0,
        term: "GOOD_FOR_DAY",
        status: "previewed",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "",
        proofSignature: "sig",
        previewMessage: "Preview generated",
      };
    },
    executeOrder: (orderId: string, authorizerDid: string, decision: string) => {
      const rec = ledger.get(orderId);
      if (!rec) {
        throw new Error(`Order draft '${orderId}' not found. All orders must be previewed and drafted before execution.`);
      }
      if (rec.status !== "previewed") {
        throw new Error(`Order draft '${orderId}' cannot be executed. Current status is '${rec.status}'.`);
      }
      if (decision === "approved") {
        executions.push({ orderId, authorizerDid, decision });
        rec.status = "executed";
        return { success: true, status: "executed", orderId, executionId: `exec-${orderId}`, authorizerDid };
      }
      rec.status = "rejected";
      return { success: false, status: "rejected", orderId, executionId: "", authorizerDid };
    },
  } as any;
});

// ---------------------------------------------------------------------------
// Binding seams: a real TradingAgent + a minimal workflow runtime
// ---------------------------------------------------------------------------

interface RuntimeRun {
  params: { orderId: string; provider?: string; userLogin: string };
  state: "awaiting" | "complete" | "errored";
  output?: unknown;
  error?: string;
  done: Promise<unknown>;
}

function makeChatHarness() {
  ledger.clear();
  executions.length = 0;
  factoryOrms.length = 0;
  draftSeq = 0;

  const sql = new MockSqlStorage();
  const runs = new Map<string, RuntimeRun>();
  let wfSeq = 0;

  const env: Record<string, unknown> = {
    SERVICE_USER_LOGIN: "svc-background",
    TRADING_AGENT_PROVIDERS: "fakeg4",
    TRADING_AGENT_DEFAULT_PROVIDER: "fakeg4",
  };

  const agent: any = Object.create(TradingAgent.prototype);
  agent.env = env as Env;
  agent.name = "trading:alice";
  agent.ctx = {
    id: { toString: () => "trading:alice" },
    storage: {
      sql,
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    },
  };

  const runWorkflowCalls: Array<{ binding: string; params: unknown }> = [];
  const sendWorkflowEventCalls: Array<{ binding: string; workflowId: string; event: any }> = [];

  agent.runWorkflow = async (binding: string, params: RuntimeRun["params"]) => {
    runWorkflowCalls.push({ binding, params });
    const workflowId = `wf-g4-${++wfSeq}`;
    let deliver: (payload: unknown) => void = () => {};
    const eventPromise = new Promise<unknown>((resolve) => {
      deliver = resolve;
    });
    const step = {
      waitForEvent: async () => ({ payload: await eventPromise }),
      do: async (_name: string, fn: () => Promise<unknown>) => fn(),
    };
    const run: RuntimeRun = {
      params,
      state: "awaiting",
      done: Promise.resolve(),
    };
    run.done = runTradeApprovalFlow(env as Env, params, step as any).then(
      (outcome) => {
        run.state = "complete";
        run.output = outcome;
        return outcome;
      },
      (err) => {
        run.state = "errored";
        run.error = err instanceof Error ? err.message : String(err);
        throw err;
      },
    );
    run.done.catch(() => {});
    (run as any).deliver = deliver;
    runs.set(workflowId, run);
    return workflowId;
  };

  agent.sendWorkflowEvent = async (binding: string, workflowId: string, event: any) => {
    sendWorkflowEventCalls.push({ binding, workflowId, event });
    const run = runs.get(workflowId) as any;
    if (!run) throw new Error(`workflow ${workflowId} not found`);
    run.deliver(event.payload);
  };

  env.TRADING_AGENT = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => agent,
  };
  env.TRADE_WORKFLOW = {
    get: (id: string) => ({
      status: async () => {
        const run = runs.get(id);
        if (!run) throw new Error(`workflow instance ${id} not found`);
        if (run.state === "complete") return { status: "complete", output: run.output };
        if (run.state === "errored") return { status: "errored", error: { name: "Error", message: run.error } };
        return { status: "running" };
      },
    }),
  };

  return { env: env as Env, agent, runs, runWorkflowCalls, sendWorkflowEventCalls };
}

function makeCommandContext(env: Env, actingLogin?: () => string | undefined): McpToolContext {
  return {
    env,
    orm: {} as any,
    sessionId: "session-1",
    audit: vi.fn(),
    ...(actingLogin ? { actingLogin } : {}),
  } as McpToolContext;
}

async function proposeViaChat(env: Env) {
  const ctx = makeCommandContext(env, () => "alice");
  const result: any = await new ProposeStockTradeCommand().execute(
    { symbol: "AAPL", action: "BUY", quantity: 10 },
    ctx,
  );
  expect(result.status).toBe("pending_approval");
  return result.proposal.orderId as string;
}

// ---------------------------------------------------------------------------
// The acceptance path: chat command -> door -> agent -> workflow
// ---------------------------------------------------------------------------

describe("mesh G4: chat trade via approval door + TradingTradeWorkflow (#2375)", () => {
  it("an approved decision starts exactly one run carrying the order + identity, settles once, executes once", async () => {
    const { env, runs, runWorkflowCalls, sendWorkflowEventCalls } = makeChatHarness();
    const orderId = await proposeViaChat(env);

    const ctx = makeCommandContext(env, () => "alice");
    const started: any = await new StartTradeApprovalCommand().execute({ orderId }, ctx);
    expect(started.status).toBe("awaiting_approval");
    expect(started.orderId).toBe(orderId);
    expect(typeof started.workflowId).toBe("string");

    // Exactly one workflow run, carrying the approved order and the
    // acting identity — started through the agent's approval door.
    expect(runWorkflowCalls).toHaveLength(1);
    expect(runWorkflowCalls[0].binding).toBe("TRADE_WORKFLOW");
    expect(runWorkflowCalls[0].params).toEqual(
      expect.objectContaining({ orderId, userLogin: "alice" }),
    );

    // Nothing has settled or executed while the decision is pending.
    expect(executions).toHaveLength(0);
    expect(ledger.get(orderId)?.status).toBe("previewed");
    const pendingStatus: any = await new GetTradeApprovalStatusCommand().execute(
      { workflowId: started.workflowId },
      ctx,
    );
    expect(pendingStatus.status).toBe("running");

    const decided: any = await new DecideTradeApprovalCommand().execute(
      { workflowId: started.workflowId, decision: "approved" },
      ctx,
    );
    expect(decided).toEqual({ workflowId: started.workflowId, delivered: true });

    // The decision event carries the authorizer DID derived from the
    // acting login server-side — never a caller-supplied identity.
    expect(sendWorkflowEventCalls).toHaveLength(1);
    expect(sendWorkflowEventCalls[0].event.type).toBe("approval");
    expect(sendWorkflowEventCalls[0].event.payload.decision).toBe("approved");
    expect(sendWorkflowEventCalls[0].event.payload.authorizerDid).toBe(getUserDid("alice"));

    const outcome: any = await runs.get(started.workflowId)!.done;
    expect(outcome.status).toBe("settled");
    expect(outcome.decision).toBe("approved");
    expect(outcome.orderId).toBe(orderId);

    // Exactly one broker execution, under the derived authorizer.
    expect(executions).toEqual([
      { orderId, authorizerDid: getUserDid("alice"), decision: "approved" },
    ]);
    expect(ledger.get(orderId)?.status).toBe("executed");

    // Status now reads the completed run + its outcome from the
    // workflow binding's own status surface.
    const finalStatus: any = await new GetTradeApprovalStatusCommand().execute(
      { workflowId: started.workflowId },
      ctx,
    );
    expect(finalStatus.status).toBe("complete");
    expect(finalStatus.output).toEqual(expect.objectContaining({ status: "settled", orderId }));
  });

  it("a rejected decision settles the draft as rejected through the same run and places nothing", async () => {
    const { env, runs, runWorkflowCalls } = makeChatHarness();
    const orderId = await proposeViaChat(env);
    const ctx = makeCommandContext(env, () => "alice");
    const started: any = await new StartTradeApprovalCommand().execute({ orderId }, ctx);
    await new DecideTradeApprovalCommand().execute(
      { workflowId: started.workflowId, decision: "rejected", reason: "too big" },
      ctx,
    );
    const outcome: any = await runs.get(started.workflowId)!.done;
    expect(runWorkflowCalls).toHaveLength(1);
    expect(outcome.status).toBe("settled");
    expect(outcome.decision).toBe("rejected");
    expect(executions).toHaveLength(0);
    expect(ledger.get(orderId)?.status).toBe("rejected");
  });

  it("a still-pending approval settles nothing and executes nothing", async () => {
    const { env, runs } = makeChatHarness();
    const orderId = await proposeViaChat(env);
    const ctx = makeCommandContext(env, () => "alice");
    const started: any = await new StartTradeApprovalCommand().execute({ orderId }, ctx);
    // Give the flow every chance to (incorrectly) proceed.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runs.get(started.workflowId)?.state).toBe("awaiting");
    expect(executions).toHaveLength(0);
    expect(ledger.get(orderId)?.status).toBe("previewed");
  });

  it("missing, blank, or retired acting identity fails closed before the approval door is called", async () => {
    const { env, runWorkflowCalls, sendWorkflowEventCalls } = makeChatHarness();
    const orderId = await proposeViaChat(env);

    const noCarrier = makeCommandContext(env);
    const err1: any = await new StartTradeApprovalCommand()
      .execute({ orderId }, noCarrier)
      .catch((e) => e);
    expect(err1).toBeInstanceOf(MeshDoorError);
    expect(err1.code).toBe("identity_required");

    for (const bad of [undefined, "", "   ", "default"]) {
      const err: any = await startTradeApprovalViaDoor(env, bad as any, { orderId }).catch((e) => e);
      expect(err).toBeInstanceOf(MeshDoorError);
      expect(err.code).toBe("identity_required");
    }
    expect(runWorkflowCalls).toHaveLength(0);

    // The decision command is gated the same way, before any event.
    const err2: any = await new DecideTradeApprovalCommand()
      .execute({ workflowId: "wf-g4-1", decision: "approved" }, noCarrier)
      .catch((e) => e);
    expect(err2).toBeInstanceOf(MeshDoorError);
    expect(err2.code).toBe("identity_required");
    const err3: any = await decideTradeApprovalViaDoor(env, "default", {
      workflowId: "wf-g4-1",
      decision: "approved",
    }).catch((e) => e);
    expect(err3.code).toBe("identity_required");
    expect(sendWorkflowEventCalls).toHaveLength(0);
  });

  it("the decision command's schema carries no identity field — the authorizer is derived, never supplied", () => {
    const decideKeys = Object.keys((new DecideTradeApprovalCommand() as any).zodSchema.shape);
    expect(decideKeys.sort()).toEqual(["decision", "reason", "workflowId"]);
    const startKeys = Object.keys((new StartTradeApprovalCommand() as any).zodSchema.shape);
    expect(startKeys.sort()).toEqual(["orderId", "provider"]);
    for (const key of [...decideKeys, ...startKeys]) {
      expect(key).not.toMatch(/login|did|authorizer|user/i);
    }
  });

  it("the three commands are registered in the factory, each declaring exactly one scope (#1744)", () => {
    expect(McpToolFactory.getTool("start_trade_approval")).toBeDefined();
    expect(McpToolFactory.getTool("decide_trade_approval")).toBeDefined();
    expect(McpToolFactory.getTool("get_trade_approval_status")).toBeDefined();
    expect(MCP_TOOL_SCOPES["start_trade_approval"]).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES["decide_trade_approval"]).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES["get_trade_approval_status"]).toBe("mcp:read");
  });

  it("status reads fail honestly when the workflow binding is not configured", async () => {
    const { env } = makeChatHarness();
    const bare = { SERVICE_USER_LOGIN: "svc-background" } as unknown as Env;
    void env;
    const err: any = await getTradeApprovalStatusViaDoor(bare, "alice", {
      workflowId: "wf-g4-1",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect(err.code).toBe("door_unavailable");
    // And identity still gates first: no identity + no binding is an
    // identity failure, not an availability leak.
    const err2: any = await getTradeApprovalStatusViaDoor(bare, undefined, {
      workflowId: "wf-g4-1",
    }).catch((e) => e);
    expect(err2.code).toBe("identity_required");
  });
});

// ---------------------------------------------------------------------------
// The enabling fix: settle threads the draft-store ORM
// ---------------------------------------------------------------------------

describe("mesh G4 enabling fix: the approval door settles from the agent's own store (#2375)", () => {
  it("executeApprovedOrder settles a draft held in the agent's store through the real E*TRADE platform", async () => {
    // §7 adaptation (#2389): the platform now settles through the
    // broker client's placeOrder instead of settling locally, so the
    // broker seam is stubbed with a broker-confirmed result. The
    // subject under test — the approval door settling a draft from
    // the agent's own store through the real platform — is unchanged.
    const placeSpy = vi.spyOn(ETradeRestClient.prototype, "placeOrder").mockImplementation(async (params: any) => ({
      success: true,
      orderId: params.orderId,
      executionId: "et_order_g4",
      brokerOrderRef: "et_order_g4",
      authorizerDid: params.userLogin,
      status: "executed",
      symbol: params.symbol,
      action: params.action,
      quantity: params.quantity,
      executionPrice: 130,
      totalSettled: 1300,
      didAttestation: {
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: params.userLogin,
        signature: ["sig", "0xbrokerg4"].join("_"),
      },
      message: "E*TRADE Execution Confirmed: Broker Order ID et_order_g4",
      timestamp: new Date().toISOString(),
    }) as any);
    try {
    const sql = new MockSqlStorage();
    const seedOrm = new DatabaseORM(sql);
    seedOrm.initializeSchema("trading:alice");
    seedOrm.trades.create({
      id: "ord-real-1",
      sessionId: "seed-session",
      symbol: "NVDA",
      action: "BUY",
      orderType: "LIMIT",
      quantity: 10,
      price: 130,
      totalValue: 1300,
      status: "previewed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const agent: any = Object.create(TradingAgent.prototype);
    agent.env = {
      SERVICE_USER_LOGIN: "svc-background",
      ETRADE_ENVIRONMENT: "sandbox",
      // Issue #3812: this test settles through the real E*TRADE platform;
      // the platform default is Alpaca, so the provider is explicit.
      TRADING_AGENT_PROVIDERS: "etrade",
      TRADING_AGENT_DEFAULT_PROVIDER: "etrade",
    } as Env;
    agent.name = "trading:alice";
    agent.ctx = {
      id: { toString: () => "trading:alice" },
      storage: { sql },
    };

    const result: any = await agent.executeApprovedOrder({
      orderId: "ord-real-1",
      authorizerDid: "did:user:github:alice",
      decision: "approved",
    });
    expect(result.status).toBe("executed");
    expect(seedOrm.trades.findById("ord-real-1")?.status).toBe("executed");
    expect(seedOrm.trades.findById("ord-real-1")?.authorizerDid).toBe("did:user:github:alice");
    } finally {
      placeSpy.mockRestore();
    }
  });
});
