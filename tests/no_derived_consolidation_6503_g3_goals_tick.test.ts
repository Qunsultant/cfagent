/**
 * Issue #6503 step 10 (G3) — the goals tick skips a disabled/paused
 * goal on stored state.
 *
 * Companion to tests/no_derived_consolidation_6503.test.ts: the tick
 * needs a ScheduledAgent instance (module mocks for `agents` and
 * `../src/orchestrate`, the #2964 harness), which the repro file
 * cannot carry without disturbing its route tests. The pin proves
 * the D1-backed tick reads the STORED row — a goal whose stored
 * record is paused (enabled=false) is skipped even when its cron
 * is due at the tick, while an active due goal fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/orchestrate", () => ({
  OPERATION_CATALOG: [
    {
      agent: "test",
      binding: "SCHEDULED_AGENT",
      operations: ["test.op"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({
    jobId: "job_test_1",
    ...req,
    status: "pending",
  })),
}));

vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: vi.fn(),
}));
vi.mock("../src/security/storageRetention", () => ({
  runStorageRetention: vi.fn(),
}));
vi.mock("../src/security/etradeOAuth", () => ({
  getStoredTokens: vi.fn(),
  isTokenExpiredEt: vi.fn(() => false),
  etradeIdentityFromLogin: vi.fn(async () => ({})),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    _store: store,
  };
}

function makeEnv(mockD1: MockD1Database) {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
    AGENT_DB: mockD1,
  };
}

async function plantGoals(mockD1: MockD1Database, goals: Array<Record<string, unknown>>) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  for (const goal of goals) {
    await store.save(goalToRecord(goal as never));
  }
  const keep = new Set(goals.map((goal) => String(goal.id)));
  for (const row of await store.listByKind("goal")) {
    if (!keep.has(row.id)) await store.remove(row.id);
  }
}

function testGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-goal",
    name: "Test goal",
    cron: "0 6 * * *",
    operation: "test.op",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("6503 G3: the D1-backed goals tick skips a paused goal", () => {
  it("a paused due goal leaves no run while an active due goal fires", async () => {
    vi.setSystemTime(new Date("2026-11-25T06:00:00Z"));
    const mockD1 = new MockD1Database();
    await plantGoals(mockD1, [
      testGoal({ id: "paused-goal", enabled: false }),
      testGoal({ id: "active-goal", enabled: true }),
    ]);
    const agent = new ScheduledAgent(makeCtx() as never, makeEnv(mockD1) as never);
    const tick = await agent.onCron(makeEnv(mockD1) as never, { halted: false } as never);
    // The paused goal is skipped before evaluation; only the active
    // goal is evaluated (and fires: its cron is due at 06:00).
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(1);
    expect(await agent.listJobRuns("paused-goal")).toHaveLength(0);
    const activeRuns = await agent.listJobRuns("active-goal");
    expect(activeRuns).toHaveLength(1);
    expect(activeRuns[0]!.outcome).toBe("success");
    expect(activeRuns[0]!.triggeredBy).toBe("scheduled");
  });

  it("a paused goal is not flagged as missed by the goals watchdog", async () => {
    vi.setSystemTime(new Date("2026-11-25T06:00:00Z"));
    const mockD1 = new MockD1Database();
    await plantGoals(mockD1, [testGoal({ id: "paused-goal", enabled: false })]);
    const agent = new ScheduledAgent(makeCtx() as never, makeEnv(mockD1) as never);
    const tick = await agent.onCron(makeEnv(mockD1) as never, { halted: false } as never);
    expect(tick.goalsEvaluated).toBe(0);
    expect(await agent.listJobRuns("paused-goal")).toHaveLength(0);
  });
});
