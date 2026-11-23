/**
 * Issue #5109 Fix 1 — the analyze feed leg executes the pipeline as
 * engine step work.
 *
 * Before this fix, `runResearchAndPublish` skipped the agent turn when
 * the feed stage had already run (`child = { status: "feed_stage" }`)
 * while the guard required `"completed"`, so analyze ALWAYS returned
 * `research_agent_turn_incomplete` on the normal engine path — even
 * after the #6312 turn-incomplete fix. The feed branch now runs the
 * pipeline on the tenant agent with the persisted feed/enrich and the
 * parent reads the leg's report directly (never re-reads `getLatest()`).
 *
 * This suite calls the exported `runResearchAndPublish` directly with
 * a fake context/agent: it fails on the old code (the feed branch
 * returns the named turn-incomplete error) and passes on the fix.
 * The turn path is untouched — the #1387 and fallback-observability
 * suites still pin its no-fallback rule.
 */
import { describe, it, expect, vi } from "vitest";
import { runResearchAndPublish } from "../src/agents/orchestrator/researchPublish";
import type { ResearchPublishContext } from "../src/agents/orchestrator/researchPublish";
import type { ResearchAgent } from "../src/agents/research-agent";
import type { ResearchReport } from "../src/services/researchPipeline";
import type { ResearchFeedStageOutput } from "../src/services/researchFeedHandoff";
import type { ResearchEnrichStageOutput } from "../src/services/researchEnrichHandoff";

function makeReport(runId: string, overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    runId,
    generationId: `gen-${runId}`,
    trigger: "manual",
    userLogin: "user-1",
    createdAt: new Date().toISOString(),
    rulesVersion: "1.0.0",
    configSnapshot: {} as ResearchReport["configSnapshot"],
    regime: { regime: "unknown", notes: [], asOf: new Date().toISOString() } as ResearchReport["regime"],
    summary: `report ${runId}`,
    ideas: [],
    watchlist: [],
    rejected: [],
    stats: {} as ResearchReport["stats"],
    oodaTrace: [],
    stageTrace: [],
    ...overrides,
  };
}

const feed = {
  runId: "run-leg",
  asOf: new Date().toISOString(),
  regime: { regime: "unknown" },
  universe: "NASDAQ100",
  universeError: null,
  symbols: ["AAPL"],
  quotes: [],
  universeSize: 1,
  quotesRetrieved: 0,
} as unknown as ResearchFeedStageOutput;

const enrich = {
  runId: "run-leg",
  asOf: new Date().toISOString(),
  feed,
  bySymbol: {},
} as unknown as ResearchEnrichStageOutput;

interface AgentFake {
  getLatest: ReturnType<typeof vi.fn>;
  createResearchTask: ReturnType<typeof vi.fn>;
  beginResearchTask: ReturnType<typeof vi.fn>;
  heartbeatResearchTask: ReturnType<typeof vi.fn>;
  completeResearchTask: ReturnType<typeof vi.fn>;
  failResearchTask: ReturnType<typeof vi.fn>;
  runResearch: ReturnType<typeof vi.fn>;
}

function makeAgent(latest: ResearchReport | null, legResult: { success: boolean; report: ResearchReport | null; error?: string }): AgentFake {
  return {
    getLatest: vi.fn(async () => latest),
    createResearchTask: vi.fn(async () => ({ task: { id: "task-1", status: "queued" }, created: true })),
    beginResearchTask: vi.fn(async (id: string) => ({ id, status: "active" })),
    heartbeatResearchTask: vi.fn(async (id: string) => ({ id, status: "active" })),
    completeResearchTask: vi.fn(async (id: string) => ({ id, status: "completed" })),
    failResearchTask: vi.fn(async (id: string) => ({ id, status: "failed" })),
    runResearch: vi.fn(async () => legResult),
  };
}

function makeCtx(agent: AgentFake) {
  const runAgentTool = vi.fn(async () => {
    throw new Error("runAgentTool must not be called in the feed branch");
  });
  const ctx: ResearchPublishContext = {
    env: {} as ResearchPublishContext["env"],
    agentCtx: { storage: { sql: {} } } as unknown as ResearchPublishContext["agentCtx"],
    ensureTables: () => {
      throw new Error("ensureTables must not be called on the analyze leg");
    },
    getOrm: () => {
      throw new Error("getOrm must not be called on the analyze leg");
    },
    getResearchAgent: () => agent as unknown as ResearchAgent,
    runAgentTool,
    getReportDispatchHitl: () => false,
    createReportConfirmation: () => "confirm-1",
    RESEARCH_TASK_HEARTBEAT_MS: 3600000,
  };
  return { ctx, runAgentTool };
}

describe("analyze feed leg executes the pipeline as engine step work (#5109 Fix 1)", () => {
  it("feed branch runs the leg on the tenant agent and returns the leg's report", async () => {
    const previous = makeReport("run-prev");
    const leg = makeReport("run-leg");
    const agent = makeAgent(previous, { success: true, report: leg });
    const { ctx, runAgentTool } = makeCtx(agent);
    const result = await runResearchAndPublish(ctx, "manual", "user-1", {
      brokerId: "alpaca",
      mode: "paper",
      runId: "run-leg",
      stage: "analyze",
      feed,
      enrich,
    });
    expect(result.success).toBe(true);
    // The leg's report wins — not getLatest()'s stale previous report.
    expect(result.report).toBe(leg);
    expect(agent.runResearch).toHaveBeenCalledTimes(1);
    expect(agent.runResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "manual",
        userLogin: "user-1",
        runId: "run-leg",
        brokerId: "alpaca",
        mode: "paper",
        feed,
        enrich,
      }),
    );
    // getLatest is read once (the previousRunId read); the report itself
    // is never re-read from it.
    expect(agent.getLatest).toHaveBeenCalledTimes(1);
    expect(runAgentTool).not.toHaveBeenCalled();
    expect(agent.completeResearchTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ reportRunId: "run-leg" }),
    );
  });

  it("feed branch with no report fails with the named turn-incomplete error", async () => {
    const previous = makeReport("run-prev");
    const agent = makeAgent(previous, { success: false, report: null, error: "boom" });
    const { ctx, runAgentTool } = makeCtx(agent);
    const result = await runResearchAndPublish(ctx, "manual", "user-1", {
      brokerId: "alpaca",
      mode: "paper",
      runId: "run-leg",
      stage: "analyze",
      feed,
      enrich,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("research_agent_turn_incomplete: boom");
    expect(runAgentTool).not.toHaveBeenCalled();
    expect(agent.failResearchTask).toHaveBeenCalledWith(
      "task-1",
      "research_agent_turn_incomplete: boom",
      true,
    );
  });

  it("feed branch with a dataRefusal report returns the report (parity with the completed turn)", async () => {
    const previous = makeReport("run-prev");
    const leg = makeReport("run-leg", {
      dataRefusal: { code: "research_data_unavailable", message: "no data" },
    });
    const agent = makeAgent(previous, { success: false, report: leg });
    const { ctx } = makeCtx(agent);
    const result = await runResearchAndPublish(ctx, "manual", "user-1", {
      brokerId: "alpaca",
      mode: "paper",
      runId: "run-leg",
      stage: "analyze",
      feed,
      enrich,
    });
    // A dataRefusal report is a report too: it flows through exactly as it
    // would from a completed turn, and the engine records the coded failure.
    expect(result.success).toBe(true);
    expect(result.report).toBe(leg);
  });

  it("feed branch without enrich still runs the leg (enrich is optional)", async () => {
    const previous = makeReport("run-prev");
    const leg = makeReport("run-leg");
    const agent = makeAgent(previous, { success: true, report: leg });
    const { ctx } = makeCtx(agent);
    const result = await runResearchAndPublish(ctx, "manual", "user-1", {
      brokerId: "alpaca",
      mode: "paper",
      runId: "run-leg",
      stage: "analyze",
      feed,
    });
    expect(result.success).toBe(true);
    expect(result.report).toBe(leg);
    expect(agent.runResearch).toHaveBeenCalledTimes(1);
    const req = agent.runResearch.mock.calls[0][0] as Record<string, unknown>;
    expect(req.feed).toBe(feed);
    expect(req.enrich).toBeUndefined();
  });
});
