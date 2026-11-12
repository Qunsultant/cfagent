/**
 * Issue #1996 (#1972 slice 1) — goal-screen submission from
 * the two entry points: the manual route (async flag) and
 * the scheduled service. The submission module is mocked
 * here so these tests pin the BRANCHING (workflow vs
 * direct, chain-mode exclusion), not the port itself.
 * TDD: written before the implementation.
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
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "MSFT" },
    ],
    counts: {
      stocksScanned: 100,
      stocksMatched: 2,
      optionsUnderlyingsScanned: 0,
      optionsContractsMatched: 0,
      hits: 2,
    },
    completedAt: "2026-10-27T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* Manual route                                                        */
/* ------------------------------------------------------------------ */

describe("POST /screening/goal-screen async flag (#1996)", () => {
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

  function routeCtx(agent: unknown) {
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
      // Issue #1997: the #1996 opt-in path is flag-gated, so
      // these tests run with the flag ON (the flag-OFF direct
      // behavior is pinned in goal_workflow_flag_1997.test.ts).
      env: { FEATURE_FLAGS: JSON.stringify({ goal_workflow: true }) },
    } as unknown as ScreenerResearchRouteContext;
    return { ctx, orm };
  }

  it("returns 202 with the run handle and never runs the screen inline", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const agent = { runGoalScreen: vi.fn() };
    const { ctx } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income", async: true }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.jobId).toBe(HANDLE.jobId);
    expect(body.workflowId).toBe(HANDLE.workflowId);
    expect(body.status).toBe("queued");
    expect(body.statusUrl).toBe(HANDLE.statusUrl);
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    const built = mockedBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(built.trigger).toBe("manual");
    expect(built.userLogin).toBe("alice");
    expect((built.scenario as { goalKind: string }).goalKind).toBe("income");
    expect(mockedStart).toHaveBeenCalledTimes(1);
  });

  it("flag ON: a start failure fails loudly instead of falling back to direct (#1997, #2065)", async () => {
    mockedStart.mockRejectedValue(new WorkflowError("start_failed", "binding boom"));
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-9", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
    const { ctx } = routeCtx(agent);
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
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
  });

  it("validates before submitting: an unknown goal kind 400s and never starts a workflow", async () => {
    const agent = { runGoalScreen: vi.fn() };
    const { ctx } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "moonshot", async: true }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    expect(mockedBuild).not.toHaveBeenCalled();
    expect(mockedStart).not.toHaveBeenCalled();
    expect(agent.runGoalScreen).not.toHaveBeenCalled();
  });

  it("a manual async submit leaves a session-principal audit row (#1999)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const agent = { runGoalScreen: vi.fn() };
    const { ctx, orm } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income", async: true }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res!.status).toBe(202);
    const rows = orm.events.findMany({ where: { type: "goal_screen.workflow_submitted" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("alice");
    // Issue #2178 S1: payloads are stored as JSON text (the #1968 read
    // path parses); read the stored form, not the mock's old object shape.
    expect((JSON.parse(rows[0].payload as unknown as string) as { principalKind: string }).principalKind).toBe("session");
    // Issue #2989: the manual submit audit carries the started workflow
    // id (mirroring the scheduled path, which already records it).
    expect((JSON.parse(rows[0].payload as unknown as string) as { workflowId: string }).workflowId).toBe(
      HANDLE.workflowId,
    );
  });

  it("a manual start failure leaves a session-principal run_failed audit row (#1999)", async () => {
    mockedStart.mockRejectedValue(new WorkflowError("start_failed", "binding boom"));
    const agent = { runGoalScreen: vi.fn() };
    const { ctx, orm } = routeCtx(agent);
    const res = await handleScreenerResearchRoutes(
      req("POST", "/screening/goal-screen", { goalKind: "income", async: true }, { "x-user-login": "alice" }),
      urlOf("/screening/goal-screen"),
      "/screening/goal-screen",
      "s1",
      ctx,
    );
    expect(res!.status).toBe(500);
    const rows = orm.events.findMany({ where: { type: "goal_screen.run_failed" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("alice");
    // Issue #2178 S1: stored payload is JSON text — see the test above.
    const failedPayload = JSON.parse(rows[0].payload as unknown as string) as { principalKind: string; code: string };
    expect(failedPayload.principalKind).toBe("session");
    expect(failedPayload.code).toBe("start_failed");
  });

  it("without the async flag the workflow still runs and the direct path never runs (#4279: async is no longer the gate)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const agent = {
      runGoalScreen: vi.fn(async () => ({
        task: { id: "task-9", status: "completed" },
        executed: true,
        result: fakeGoalResult(),
      })),
    };
    const { ctx } = routeCtx(agent);
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
/* Scheduled service                                                   */
/* ------------------------------------------------------------------ */

describe("autonomousGoalScreen workflow submission (#1996)", () => {
  function goalService(opts: { followupScheduler?: unknown } = {}) {
    // Issue #1997: the #1996 workflow-first path is
    // flag-gated, so these tests run with the flag ON (the
    // flag-OFF direct behavior is pinned in
    // goal_workflow_flag_1997.test.ts).
    const mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      FEATURE_FLAGS: JSON.stringify({ goal_workflow: true }),
    } as unknown as Env;
    const mockOrm = new DatabaseORM(new MockSqlStorage() as any);
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const audit = vi.fn(() => {});
    const guard = vi.fn(async () => ({ blocked: false as const }));
    const runGoalScreen = vi.fn(async (req: Record<string, unknown>) => ({
      task: { id: "task-1", status: "completed" },
      executed: true,
      result: fakeGoalResult(),
    }));
    (service as unknown as Record<string, unknown>).audit = audit;
    (service as unknown as Record<string, unknown>).guardScheduledAuth = guard;
    (service as unknown as Record<string, unknown>).getScreenerAgent = () => ({ runGoalScreen });
    if (opts.followupScheduler) {
      (service as unknown as Record<string, unknown>).followupScheduler = opts.followupScheduler;
    }
    return { service, audit, guard, runGoalScreen };
  }

  it("submits a scheduled run through the workflow and returns the queued handle", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const { service, audit, runGoalScreen } = goalService();
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.status).toBe("queued");
    // The minute-slot key is wall-clock-derived, so assert the
    // shape + that the returned taskId IS the submitted jobId
    // (the run's identity), not a fixed timestamp.
    expect(String(data.taskId)).toMatch(
      /^goal-screen:scheduled:test_trader:income:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
    expect(data.workflowId).toBe(HANDLE.workflowId);
    expect(data.goalKind).toBe("income");
    expect(runGoalScreen).not.toHaveBeenCalled();
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    const built = mockedBuild.mock.calls[0][0] as Record<string, unknown>;
    expect(built.trigger).toBe("scheduled");
    expect((built.scenario as { goalKind: string }).goalKind).toBe("income");
    expect(String(built.jobId)).toMatch(/^goal-screen:scheduled:test_trader:income:/);
    expect(built.jobId).toBe(data.taskId);
    expect(audit.mock.calls.find((c) => c[0] === "goal_screen.workflow_submitted")).toBeDefined();
  });

  it("flag ON: a start failure fails the tick instead of falling back to direct (#1997, #2065)", async () => {
    mockedStart.mockRejectedValue(new WorkflowError("start_failed", "binding boom"));
    const { service, audit, runGoalScreen } = goalService();
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(false);
    expect(runGoalScreen).not.toHaveBeenCalled();
    expect(audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed")).toBeDefined();
  });

  it("chain mode keeps the direct path even when a workflow start would succeed", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const bridge = vi.fn(async () => {});
    const { service, runGoalScreen } = goalService({ followupScheduler: bridge });
    const result = await service.autonomousGoalScreen({ goalKind: "income", stageChain: {} as never });
    expect(result.success).toBe(true);
    expect(mockedStart).not.toHaveBeenCalled();
    expect(runGoalScreen).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});
