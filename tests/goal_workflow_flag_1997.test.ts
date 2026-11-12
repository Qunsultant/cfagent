/**
 * Issue #1997 (Phase 2, rebased onto #1996) — the
 * goal_workflow flag gates #1996's goal-workflow
 * submission paths, and the goal door surfaces the
 * canonical report id for the panel's fetch.
 *
 * Flag rule (both entries, before #4279): flag OFF → direct,
 * exactly as before #1996's opt-in; flag ON → the workflow
 * is REQUIRED, and a null start fails loudly (route: coded
 * 500; scheduled tick: thrown failure + run_failed audit),
 * never a silent fallback to direct.
 *
 * Issue #4279 (#3550 S4) RETIRES the flag as an entry gate:
 * the workflow is now THE path for both entries whatever
 * the flag says — flag OFF behaves exactly like flag ON.
 * These tests pin that: the flag env is still passed (the
 * port itself is REAL and env-driven) but the outcome no
 * longer depends on it.
 *
 * The submission module is mocked here (as in the #1996
 * routes test) so these tests pin the BRANCHING, not the
 * port itself.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildGoalScreenCommand,
  startGoalScreenWorkflow,
} from "../src/services/goalScreenWorkflowSubmission";
import { WorkflowError } from "../src/workflows/workflowPorts";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";
import { persistWorkflowGoalScreenReport } from "../src/agents/orchestrator/goalScreenDispatch";

vi.mock("../src/services/goalScreenWorkflowSubmission", () => ({
  buildGoalScreenCommand: vi.fn(() => ({ __cannedGoalCommand: true })),
  startGoalScreenWorkflow: vi.fn(),
}));

const mockedBuild = vi.mocked(buildGoalScreenCommand);
const mockedStart = vi.mocked(startGoalScreenWorkflow);

const HANDLE = {
  workflowId: "screen-goal-screen-manual-alice-income-2026-10-27T12-00-00-000Z",
  jobId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
  status: "queued" as const,
  existing: false,
  statusUrl: "/api/jobs/history?chainId=goal-screen%3Amanual%3Aalice%3Aincome%3A2026-10-27T12%3A00%3A00.000Z",
};

const FLAG_ON_ENV = {
  FEATURE_FLAGS: JSON.stringify({ goal_workflow: true }),
} as unknown as Env;

// Issue #2051: "flag OFF" now means EXPLICIT off (bulk false), not
// a bare env — a bare env resolves goal_workflow ON by default.
const FLAG_OFF_ENV = {
  FEATURE_FLAGS: JSON.stringify({ goal_workflow: false }),
} as unknown as Env;

function fakeGoalResult(overrides: Partial<GoalDrivenScreenResult> = {}): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: ["cash_secured_put"],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "AAPL" },
    ],
    counts: {
      stocksScanned: 100,
      stocksMatched: 1,
      optionsUnderlyingsScanned: 0,
      optionsContractsMatched: 0,
      hits: 1,
    },
    completedAt: "2026-10-27T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* Goal door report id                                                 */
/* ------------------------------------------------------------------ */

describe("goal door report id (#1997)", () => {
  function fakeOrm(stored: { reportId: string; created: boolean } | null) {
    return {
      storeCanonicalReport: () => stored,
      exec: () => [],
    };
  }
  const envelope = {
    taskId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
    scenarioSource: "built" as const,
    trigger: "manual" as const,
    result: fakeGoalResult(),
  };

  it("returns the canonical report id on a stored run", async () => {
    const id = await persistWorkflowGoalScreenReport(
      { env: {}, getOrm: () => fakeOrm({ reportId: "rep-9", created: true }) as never },
      envelope,
      "alice",
    );
    expect(id).toBe("rep-9");
  });

  it("returns the existing id on an idempotent re-store (created: false)", async () => {
    const id = await persistWorkflowGoalScreenReport(
      { env: {}, getOrm: () => fakeOrm({ reportId: "rep-9", created: false }) as never },
      envelope,
      "alice",
    );
    expect(id).toBe("rep-9");
  });

  it("throws when the canonical store returns null (flow records storeError)", async () => {
    await expect(
      persistWorkflowGoalScreenReport(
        { env: {}, getOrm: () => fakeOrm(null) as never },
        envelope,
        "alice",
      ),
    ).rejects.toThrow("could not be stored");
  });
});

/* ------------------------------------------------------------------ */
/* Manual route flag gate                                              */
/* ------------------------------------------------------------------ */

describe("POST /screening/goal-screen flag gate (#1997, retired by #4279)", () => {
  const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

  function routeCtx(agent: unknown, env: Record<string, unknown>) {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    const settings = new Map<string, string>();
    const ctx = {
      getScreenerAgent: vi.fn(() => agent),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      getResearchAgent: vi.fn(() => null),
      runResearchAndPublish: vi.fn(async () => ({ success: true })),
      getOrm: vi.fn(() => orm),
      readSettingRaw: vi.fn((key: string) => settings.get(key) ?? null),
      writeSetting: vi.fn((key: string, value: string) => void settings.set(key, value)),
      env,
    } as unknown as ScreenerResearchRouteContext;
    return { ctx, orm };
  }

  function directAgent() {
    return {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-9", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
  }

  it("start success → 202, screen never runs inline", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const agent = { runGoalScreen: vi.fn() };
    const { ctx } = routeCtx(agent, FLAG_ON_ENV as unknown as Record<string, unknown>);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income", async: true }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
    expect(mockedStart).toHaveBeenCalledTimes(1);
  });

  it("start throws → coded 500 with code + reason, screen never runs (no silent fallback)", async () => {
    mockedStart.mockRejectedValue(new WorkflowError("start_failed", "binding boom"));
    const agent = { runGoalScreen: vi.fn() };
    const { ctx } = routeCtx(agent, FLAG_ON_ENV as unknown as Record<string, unknown>);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income", async: true }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.error).toBe("goal_workflow_start_failed");
    expect(body.code).toBe("start_failed");
    expect(typeof body.jobId).toBe("string");
    // Issue #2065: the coded failure names the missing dependency.
    expect(body.reason).toBe("workflow_binding_unavailable");
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
  });

  it("flag OFF + async:true → 202, workflow attempted, direct never runs (#4279: the flag is retired as an entry gate)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const agent = directAgent();
    const { ctx } = routeCtx(agent, FLAG_OFF_ENV as unknown as Record<string, unknown>);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income", async: true }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
  });

  it("flag OFF + async:false → 202, workflow attempted, direct never runs (#4279: async is no longer the gate)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const agent = directAgent();
    const { ctx } = routeCtx(agent, FLAG_OFF_ENV as unknown as Record<string, unknown>);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income" }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Scheduled service flag gate                                         */
/* ------------------------------------------------------------------ */

describe("autonomousGoalScreen flag gate (#1997, retired by #4279)", () => {
  function goalService(env: Record<string, unknown>) {
    const mockEnv = { ETRADE_ENVIRONMENT: "sandbox", ...env } as unknown as Env;
    const mockOrm = new DatabaseORM(new MockSqlStorage() as any);
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const audit = vi.fn(() => {});
    const guard = vi.fn(async () => ({ blocked: false as const }));
    const runGoalScreen = vi.fn(async () => ({
      task: { id: "task-1", status: "completed" },
      executed: true,
      result: fakeGoalResult(),
    }));
    (service as unknown as Record<string, unknown>).audit = audit;
    (service as unknown as Record<string, unknown>).guardScheduledAuth = guard;
    (service as unknown as Record<string, unknown>).getScreenerAgent = () => ({ runGoalScreen });
    return { service, audit, runGoalScreen };
  }

  it("start failure → failure result + run_failed audit carrying the code, screen never runs", async () => {
    mockedStart.mockRejectedValue(new WorkflowError("start_failed", "binding boom"));
    const { service, audit, runGoalScreen } = goalService(
      FLAG_ON_ENV as unknown as Record<string, unknown>,
    );
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(false);
    expect(runGoalScreen).not.toHaveBeenCalled();
    expect(audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed")).toBeDefined();
    const failed = audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed");
    expect((failed[1] as Record<string, unknown>).errorCode).toBe("start_failed");
  });

  it("flag OFF → queued, workflow attempted, direct never runs (#4279: the flag is retired as an entry gate)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const { service, runGoalScreen } = goalService(FLAG_OFF_ENV as unknown as Record<string, unknown>);
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data.status).toBe("queued");
    expect(mockedStart).toHaveBeenCalledTimes(1);
    expect(runGoalScreen).not.toHaveBeenCalled();
  });

  it("start success → queued, screen never runs inline", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const { service, runGoalScreen } = goalService(
      FLAG_ON_ENV as unknown as Record<string, unknown>,
    );
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data.status).toBe("queued");
    expect(runGoalScreen).not.toHaveBeenCalled();
  });
});
