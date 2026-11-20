/**
 * Issue #1996 (#1972 slice 1) — goal-screen submission:
 * the shared command builder + best-effort start helper,
 * and the workflow child's goal store/deliver doors.
 * TDD: written before the implementation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildGoalScreenCommand,
  startGoalScreenWorkflow,
} from "../src/services/goalScreenWorkflowSubmission";
import {
  deliverWorkflowGoalScreenOutcome,
  persistWorkflowGoalScreenReport,
} from "../src/agents/orchestrator/goalScreenDispatch";
import { buildScenario } from "../src/services/goalScenarioEngine";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";
import { recordScreeningActivity } from "../src/services/screeningActivity";
import {
  createScreeningDeliverySenders,
  deliverScreeningContent,
  formatGoalScreenDelivery,
} from "../src/services/screeningDelivery";

vi.mock("../src/services/screeningActivity", () => ({
  recordScreeningActivity: vi.fn(),
}));

vi.mock("../src/services/screeningDelivery", () => ({
  formatGoalScreenDelivery: vi.fn(() => ({ subject: "Goal screen", text: "hits" })),
  deliverScreeningContent: vi.fn(async () => []),
  createScreeningDeliverySenders: vi.fn(() => ({ sender: "fake" })),
}));

const mockedActivity = vi.mocked(recordScreeningActivity);
const mockedDeliver = vi.mocked(deliverScreeningContent);
const mockedSenders = vi.mocked(createScreeningDeliverySenders);
const mockedFormat = vi.mocked(formatGoalScreenDelivery);

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
      optionsUnderlyingsScanned: 50,
      optionsContractsMatched: 0,
      hits: 1,
    },
    completedAt: "2026-10-27T12:00:00.000Z",
    ...overrides,
  };
}

function scenario() {
  return buildScenario({ goalKind: "income", portfolioRef: { kind: "hypothetical" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

describe("buildGoalScreenCommand (#1996)", () => {
  it("builds a single-goal-shard parent command with the goal descriptor", () => {
    const cmd = buildGoalScreenCommand({
      jobId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
      source: "manual",
      trigger: "manual",
      userLogin: "alice",
      tenantId: "tenant-1",
      scenario: scenario(),
      scenarioSource: "built",
      assetClasses: ["stocks", "options"],
      symbols: ["AAPL"],
      deliverChannels: ["slack", "email"],
      emailTo: "alice@example.com",
      environment: "PROD",
    });
    expect(cmd.type).toBe("run-screen");
    expect(cmd.role).toBe("parent");
    expect(cmd.jobId).toBe("goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z");
    expect(cmd.shards).toEqual([{ shardId: "goal" }]);
    expect(cmd.deliver).toBe(true);
    expect(cmd.goalScreen?.scenario.goalKind).toBe("income");
    expect(cmd.goalScreen?.scenarioSource).toBe("built");
    expect(cmd.goalScreen?.assetClasses).toEqual(["stocks", "options"]);
    expect(cmd.goalScreen?.symbols).toEqual(["AAPL"]);
    expect(cmd.goalScreen?.deliver).toEqual(["slack", "email"]);
    expect(cmd.goalScreen?.emailTo).toBe("alice@example.com");
    expect(cmd.goalScreen?.provider).toBeUndefined();
  });

  it("leaves deliver unset when no channels are requested", () => {
    const cmd = buildGoalScreenCommand({
      jobId: "goal-screen:scheduled:alice:income:2026-10-27T12:00",
      source: "scheduled-tasks",
      trigger: "scheduled",
      userLogin: "alice",
      scenario: scenario(),
      scenarioSource: "stored",
    });
    expect(cmd.deliver).toBeUndefined();
    expect(cmd.goalScreen?.deliver).toBeUndefined();
  });

  it("carries the Yahoo data mode through (#4436)", () => {
    const cmd = buildGoalScreenCommand({
      jobId: "goal-screen:scheduled:alice:income:2026-10-27T12:00",
      source: "scheduled-tasks",
      trigger: "scheduled",
      userLogin: "alice",
      scenario: scenario(),
      scenarioSource: "built",
      provider: "yahoo",
      yahooDataMode: "full-dataset",
    });
    expect(cmd.goalScreen?.provider).toBe("yahoo");
    expect(cmd.goalScreen?.yahooDataMode).toBe("full-dataset");
  });
});

/* ------------------------------------------------------------------ */
/* Typed start (#2065)                                                   */
/* ------------------------------------------------------------------ */

describe("startGoalScreenWorkflow (#2065: throws with codes, never null)", () => {
  const cmd = buildGoalScreenCommand({
    jobId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    scenario: scenario(),
    scenarioSource: "built",
  });
  const sink = { write: async () => {} } as never;

  it("throws workflow_binding_absent when the workflow binding is absent", async () => {
    await expect(startGoalScreenWorkflow({}, cmd, sink)).rejects.toMatchObject({
      code: "workflow_binding_absent",
    });
  });

  it("throws projection_store_unbound when the projection store is unbound (never runs blind)", async () => {
    const env = {
      SCREENER_WORKFLOW: {
        create: async ({ id }: { id: string }) => ({ id }),
        get: async (id: string) => ({ id, status: async () => ({ status: "queued" }) }),
      },
    };
    await expect(startGoalScreenWorkflow(env, cmd, sink)).rejects.toMatchObject({
      code: "projection_store_unbound",
    });
  });

  it("returns the handle when the binding + store are present", async () => {
    const created: Array<{ id: string; params: unknown }> = [];
    const env = {
      SCREENER_WORKFLOW: {
        create: async ({ id, params }: { id: string; params: unknown }) => {
          created.push({ id, params });
          return { id };
        },
        get: async (id: string) => ({ id, status: async () => ({ status: "queued" }) }),
      },
      AGENT_DB: {},
    };
    const handle = await startGoalScreenWorkflow(env, cmd, sink);
    expect(handle.jobId).toBe(cmd.jobId);
    expect(handle.status).toBe("queued");
    expect(handle.existing).toBe(false);
    expect(handle.statusUrl).toBe(`/api/jobs/history?chainId=${encodeURIComponent(cmd.jobId)}`);
    expect(created).toHaveLength(1);
    expect((created[0].params as { jobId: string }).jobId).toBe(cmd.jobId);
  });

  it("throws start_failed (never null) when start fails", async () => {
    const env = {
      SCREENER_WORKFLOW: {
        create: async () => {
          throw new Error("binding boom");
        },
        get: async () => {
          throw new Error("no instance");
        },
      },
      AGENT_DB: {},
    };
    await expect(startGoalScreenWorkflow(env, cmd, sink)).rejects.toMatchObject({
      code: "start_failed",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Child store door                                                    */
/* ------------------------------------------------------------------ */

describe("persistWorkflowGoalScreenReport (#1996)", () => {
  it("stores the canonical goal report + activity with the sync path's shape", async () => {
    const storeCanonicalReport = vi.fn(() => ({ reportId: "rep-1" }));
    const orm = { storeCanonicalReport } as never;
    const result = fakeGoalResult({ pdfKey: "pdf-1", xlsxKey: "xlsx-1" } as Partial<GoalDrivenScreenResult>);
    await persistWorkflowGoalScreenReport(
      { env: {}, getOrm: () => orm },
      { taskId: "task-1", scenarioSource: "stored", trigger: "scheduled", result },
      "alice",
    );
    expect(storeCanonicalReport).toHaveBeenCalledTimes(1);
    const row = storeCanonicalReport.mock.calls[0][0] as Record<string, unknown>;
    expect(row.runId).toBe("goal-screen:task-1");
    expect(row.generationId).toBe("goal-screen:task-1");
    expect(row.source).toBe("goal_screen");
    expect(row.title).toBe("Goal screen — income (bullish)");
    expect(row.summary).toMatch(/1 hit\(s\)/);
    const body = row.body as Record<string, unknown>;
    expect(body.taskId).toBe("task-1");
    expect(body.scenarioSource).toBe("stored");
    expect(body.trigger).toBe("scheduled");
    expect(body.result).toBe(result);
    expect(body.pdfKey).toBe("pdf-1");
    expect(body.xlsxKey).toBe("xlsx-1");
    expect(mockedActivity).toHaveBeenCalledTimes(1);
    const activity = mockedActivity.mock.calls[0][1] as Record<string, unknown>;
    expect(activity.kind).toBe("screen_run");
    expect(activity.refId).toBe("task-1");
    expect((activity.detail as Record<string, unknown>).taskId).toBe("task-1");
  });

  it("stamps the Yahoo data mode + provider defensively when the result lacks them (#4436)", async () => {
    const storeCanonicalReport = vi.fn(() => ({ reportId: "rep-1" }));
    const orm = { storeCanonicalReport } as never;
    const result = fakeGoalResult();
    expect(result.yahooDataMode).toBeUndefined();
    await persistWorkflowGoalScreenReport(
      { env: {}, getOrm: () => orm },
      {
        taskId: "task-1",
        scenarioSource: "built",
        trigger: "scheduled",
        result,
        provider: "yahoo",
        yahooDataMode: "full-dataset",
      },
      "alice",
    );
    const row = storeCanonicalReport.mock.calls[0][0] as Record<string, unknown>;
    const body = row.body as Record<string, unknown>;
    const stored = body.result as GoalDrivenScreenResult;
    expect(stored.provider).toBe("yahoo");
    expect(stored.yahooDataMode).toBe("full-dataset");
  });
});

/* ------------------------------------------------------------------ */
/* Child deliver door                                                  */
/* ------------------------------------------------------------------ */

describe("deliverWorkflowGoalScreenOutcome (#1996)", () => {
  it("delivers through the goal delivery seam with the sync path's event + data", async () => {
    const orm = {} as never;
    const result = fakeGoalResult();
    await deliverWorkflowGoalScreenOutcome(
      { env: {}, getOrm: () => orm },
      { taskId: "task-1", scenarioSource: "built", trigger: "manual", result },
      "alice",
      ["slack", "email"],
      "alice@example.com",
    );
    expect(mockedFormat).toHaveBeenCalledTimes(1);
    expect(mockedFormat.mock.calls[0][0]).toBe(result);
    expect(mockedSenders).toHaveBeenCalledTimes(1);
    expect(mockedDeliver).toHaveBeenCalledTimes(1);
    const input = mockedDeliver.mock.calls[0][0] as Record<string, unknown>;
    expect(input.channels).toEqual(["slack", "email"]);
    expect(input.event).toBe("screening.goal_screen");
    expect(input.emailTo).toBe("alice@example.com");
    expect(input.userLogin).toBe("alice");
    expect(input.data).toEqual({
      taskId: "task-1",
      goalKind: "income",
      outlook: "bullish",
      status: "complete",
      hits: 1,
    });
  });
});
