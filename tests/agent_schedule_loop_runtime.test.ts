import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";

const enabledSettings = {
  enabled: true,
  maxTurns: 4,
  maxDurationMs: 30_000,
  maxModelTokens: 100,
};

function makeAgent() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => void store.set(key, value),
    },
  };
  const agent = new ScheduledAgent(ctx as never, {} as never) as unknown as {
    lifecycle: { start: () => Promise<void> };
    runTurn: (options: Record<string, unknown>) => Promise<unknown>;
    beforeTurn: (context: unknown) => Promise<unknown>;
    onStepEnd: (context: unknown) => Promise<void>;
    getGoals: () => Promise<Array<Record<string, unknown>>>;
    triggerGoal: (
      id: string,
      env?: unknown,
      actor?: string | null,
    ) => Promise<unknown>;
    resolveAgentScheduleLoopSettingsForLogin: (
      login: string,
    ) => Promise<{ settings: typeof enabledSettings | null; issues: string[] }>;
    runBoundedAgenticLoop: (goal: Record<string, unknown>) => Promise<{
      status: string;
      detail?: string;
      pendingApprovalId?: string;
      usedModelTokens: number;
      turns: number;
    }>;
    ctx: typeof ctx;
  };
  Object.defineProperty(agent, "activeTurn", {
    configurable: true,
    value: { requestId: "loop-turn" },
  });
  return { agent, store };
}

const loopGoal = {
  id: "loop-goal",
  name: "Bounded loop goal",
  cron: "0 9 * * *",
  operation: "resource.rollup_daily",
  budgetCents: 500,
  enabled: true,
  executionMode: "agentic-loop",
  provenance: { origin: "agent", createdBy: "OpenAIMP", agentId: "agent-1" },
};

describe("agentic-loop execution guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an approval request when measured model usage reaches the configured cap", async () => {
    const { agent, store } = makeAgent();
    vi.spyOn(agent.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(agent, "resolveAgentScheduleLoopSettingsForLogin")
      .mockResolvedValue({ settings: enabledSettings, issues: [] });
    vi.spyOn(agent, "runTurn").mockImplementation(async (options) => {
      await agent.beforeTurn({
        body: options.body,
        requestId: "loop-turn",
        messages: [],
      });
      await agent.onStepEnd({
        usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
      });
      return { status: "error" };
    });

    const outcome = await agent.runBoundedAgenticLoop(loopGoal);
    const approvals = store.get("pendingScheduleApprovals") as Array<Record<string, unknown>>;
    expect(outcome).toMatchObject({
      status: "approval-required",
      usedModelTokens: 100,
      turns: 1,
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: "agentic-loop",
      requestedBy: "OpenAIMP",
      status: "pending",
    });
    expect((approvals[0]?.approvalReasons as string[])[0]).toContain(
      "100 model tokens",
    );
  });

  it("uses the existing owner approval to authorize one bounded continuation", async () => {
    const { agent, store } = makeAgent();
    store.set("pendingScheduleApprovals", [
      {
        id: "pending-loop-1",
        kind: "agentic-loop",
        requestedBy: "OpenAIMP",
        agentId: "agent-1",
        requestedAt: "2026-01-01T00:00:00.000Z",
        definition: {
          purpose: "continue-agentic-loop",
          scheduleId: "loop-goal",
          usedModelTokens: 100,
          maxModelTokens: 100,
          turns: 1,
        },
        approvalReasons: ["Configured model-token cap reached."],
        status: "pending",
      },
    ]);
    vi.spyOn(agent, "getGoals").mockResolvedValue([loopGoal]);
    vi.spyOn(agent, "resolveAgentScheduleLoopSettingsForLogin")
      .mockResolvedValue({ settings: enabledSettings, issues: [] });
    const trigger = vi.spyOn(agent, "triggerGoal").mockResolvedValue({
      timestamp: "2026-01-01T00:00:00.000Z",
      goalsEvaluated: 1,
      jobsCreated: 1,
      jobsSkipped: 0,
      errors: [],
    });

    const result = await (agent as unknown as {
      approvePendingGoalApproval: (
        id: string,
        decidedBy: string,
      ) => Promise<{ approval: { status: string }; scheduleId?: string }>;
    }).approvePendingGoalApproval("pending-loop-1", "OpenAIMP");

    expect(result).toMatchObject({
      approval: { status: "approved" },
      scheduleId: "loop-goal",
    });
    expect(trigger).toHaveBeenCalledWith("loop-goal", undefined, "OpenAIMP");
  });

  it("stops at the configured step limit without treating it as a cost-cap approval", async () => {
    const { agent, store } = makeAgent();
    vi.spyOn(agent.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(agent, "resolveAgentScheduleLoopSettingsForLogin")
      .mockResolvedValue({
        settings: { ...enabledSettings, maxTurns: 1 },
        issues: [],
      });
    vi.spyOn(agent, "runTurn").mockImplementation(async (options) => {
      await agent.beforeTurn({
        body: options.body,
        requestId: "loop-turn",
        messages: [],
      });
      await agent.onStepEnd({
        usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
      });
      return { status: "error" };
    });

    const outcome = await agent.runBoundedAgenticLoop(loopGoal);
    expect(outcome).toMatchObject({
      status: "completed",
      usedModelTokens: 10,
      turns: 1,
    });
    expect(store.get("pendingScheduleApprovals")).toBeUndefined();
  });

  it("aborts at the configured duration boundary", async () => {
    const { agent } = makeAgent();
    const controller = new AbortController();
    Object.assign(agent as object, {
      activeAgenticLoop: {
        login: "OpenAIMP",
        scheduleId: "loop-goal",
        runId: "run-1",
        prompt: "bounded",
        settings: { ...enabledSettings, maxDurationMs: 1 },
        controller,
        startedAtMs: Date.now() - 10,
        usedModelTokens: 0,
        turns: 0,
        requestId: "loop-turn",
      },
    });
    vi.spyOn(agent, "resolveAgentScheduleLoopSettingsForLogin")
      .mockResolvedValue({
        settings: { ...enabledSettings, maxDurationMs: 1 },
        issues: [],
      });

    await agent.onStepEnd({
      usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
    });
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts at a live kill-switch change and does not request continuation approval", async () => {
    const { agent, store } = makeAgent();
    vi.spyOn(agent.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(agent, "resolveAgentScheduleLoopSettingsForLogin")
      .mockResolvedValueOnce({ settings: enabledSettings, issues: [] })
      .mockResolvedValueOnce({
        settings: { ...enabledSettings, enabled: false },
        issues: [],
      });
    vi.spyOn(agent, "runTurn").mockImplementation(async (options) => {
      await agent.beforeTurn({
        body: options.body,
        requestId: "loop-turn",
        messages: [],
      });
      await agent.onStepEnd({
        usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
      });
      expect((options.signal as AbortSignal).aborted).toBe(true);
      return { status: "error" };
    });

    const outcome = await agent.runBoundedAgenticLoop(loopGoal);
    expect(outcome).toMatchObject({ status: "skipped" });
    expect(store.get("pendingScheduleApprovals")).toBeUndefined();
  });

  it("fails closed when the provider does not report usage", async () => {
    const { agent, store } = makeAgent();
    vi.spyOn(agent.lifecycle, "start").mockResolvedValue(undefined);
    vi.spyOn(agent, "resolveAgentScheduleLoopSettingsForLogin")
      .mockResolvedValue({ settings: enabledSettings, issues: [] });
    vi.spyOn(agent, "runTurn").mockImplementation(async (options) => {
      await agent.beforeTurn({
        body: options.body,
        requestId: "loop-turn",
        messages: [],
      });
      await agent.onStepEnd({ usage: {} });
      return { status: "error" };
    });

    const outcome = await agent.runBoundedAgenticLoop(loopGoal);
    expect(outcome).toMatchObject({ status: "failed" });
    expect(outcome.detail).toContain("usage was unavailable");
    expect(store.get("pendingScheduleApprovals")).toBeUndefined();
  });
});
