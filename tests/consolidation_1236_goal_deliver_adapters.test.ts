/**
 * Issue #1236 (epic #1151 remainder): goal deliver-stage chaining +
 * opt-in outcome adapters for arbitrary http.request routes.
 *
 * RED first: the goal bridge still suppresses nothing (deliverViaChain
 * stays false), the planner still marks a serve-verified canonical
 * result "no artifact to deliver", and no adapter registry exists.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  planDeliveryFollowups,
  plannedDeliveryChannels,
  resolveScreenerFollowupConfig,
  screenerOutcomeFromHttpJob,
  registerHttpOutcomeAdapter,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

const executeGoalScreenRun = vi.hoisted(() => vi.fn());
vi.mock("../src/services/screeningRuntime", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/screeningRuntime")>();
  return { ...original, executeGoalScreenRun: executeGoalScreenRun };
});

vi.mock("../src/services/goalScreenWorkflowSubmission", () => ({
  buildGoalScreenCommand: vi.fn(() => ({ __cannedGoalCommand: true })),
  startGoalScreenWorkflow: vi.fn(),
}));

import {
  buildGoalScreenCommand,
  startGoalScreenWorkflow,
} from "../src/services/goalScreenWorkflowSubmission";

const mockedBuild = vi.mocked(buildGoalScreenCommand);
const mockedStart = vi.mocked(startGoalScreenWorkflow);

const HANDLE = {
  workflowId: "screen-goal-screen-scheduled-goal_test_trader-income-2026-11-12T00-00-00-000Z",
  jobId: "goal-screen:scheduled:goal_test_trader:income:2026-11-12T00:00:00.000Z",
  status: "queued" as const,
  existing: false,
  statusUrl: "/api/jobs/history?chainId=goal-screen%3Ascheduled%3Agoal_test_trader%3Aincome%3A2026-11-12T00%3A00%3A00.000Z",
};

const CHAIN = { serveDelaySeconds: 60, deliverDelaySeconds: 3600 };
const NOW = "2026-10-24T00:00:00.000Z";

function fullConfig() {
  return resolveScreenerFollowupConfig({
    SCREENER_EMAIL_TO: "ops@example.com",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
    SCREENER_WEBHOOK_URL: "https://example.com/hook",
  });
}

describe("goal chain deliver planning (#1236)", () => {
  it("plans real deliveries (no skipReason) for a serve-verified canonical goal result", () => {
    const outcome = {
      kind: "goal",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      canonicalReportId: "rep-1",
      deliverViaChain: true,
      stageChain: CHAIN,
      emailTo: "owner@example.com",
      slackChannel: "C123",
      deliveryChannels: ["email", "slack"],
      matchedCount: 2,
      totalScanned: 14,
    } as unknown as ScreenerRunOutcome;
    const specs = planDeliveryFollowups(
      outcome,
      fullConfig(),
      { status: "ready", artifacts: [], canonicalReportId: "rep-1" },
      "main-g-1",
      "alice",
      { chainId: "chain-g-1", nowIso: NOW },
    );
    // CHANNEL_ORDER is slack, email, webhook; the allowlist drops
    // webhook (an env-configured channel the goal direct path never
    // used) while keeping the run's own recipients.
    expect(specs.map((s) => s.channel)).toEqual(["slack", "email"]);
    for (const spec of specs) {
      expect(spec.payload.skipReason).toBeUndefined();
      expect(spec.stage).toBe("deliver");
      expect(spec.chainId).toBe("chain-g-1");
      expect(spec.runAt).toBe("2026-10-24T01:00:00.000Z");
      expect(spec.parentJobId).toBe("main-g-1");
    }
  });

  it("still marks a ready result with no artifacts and no canonical row undeliverable", () => {
    const outcome = {
      kind: "goal",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      deliverViaChain: true,
      stageChain: CHAIN,
    } as unknown as ScreenerRunOutcome;
    const specs = planDeliveryFollowups(
      outcome,
      resolveScreenerFollowupConfig({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" }),
      { status: "ready", artifacts: [] },
      "main-g-2",
      "alice",
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].payload.skipReason).toBe("Report produced no artifact to deliver.");
  });

  it("plans nothing when deliverViaChain is false, even with a canonical row", () => {
    const outcome = {
      kind: "discovery",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      canonicalReportId: "rep-9",
      deliverViaChain: false,
      stageChain: CHAIN,
    } as unknown as ScreenerRunOutcome;
    expect(planDeliveryFollowups(
      outcome,
      fullConfig(),
      { status: "ready", artifacts: [], canonicalReportId: "rep-9" },
      "main-g-3",
      "alice",
    )).toEqual([]);
  });

  it("deliveryChannels allowlist restricts planned channels; empty allowlist plans nothing", () => {
    const base = {
      kind: "stock",
      trigger: "manual",
      success: true,
      pdfKeys: ["k1"],
    } as unknown as ScreenerRunOutcome;
    expect(plannedDeliveryChannels({ ...base, deliveryChannels: ["email"] }, fullConfig())).toEqual(["email"]);
    expect(plannedDeliveryChannels({ ...base, deliveryChannels: [] }, fullConfig())).toEqual([]);
    expect(plannedDeliveryChannels(base, fullConfig())).toEqual(["slack", "email", "webhook"]);
  });
});

describe("opt-in http outcome adapters (#1236)", () => {
  it("adapts a registered arbitrary route; unregistered routes keep the legacy null", () => {
    registerHttpOutcomeAdapter({
      match: (path) => path.split("?")[0].endsWith("/reports/custom-1236"),
      adapt: ({ responseStatus, body }) => ({
        kind: "stock",
        trigger: "manual",
        success: responseStatus === 200 && body.ok === true,
        pdfKeys: [],
        matchedCount: typeof body.matched === "number" ? body.matched : undefined,
        totalScanned: typeof body.scanned === "number" ? body.scanned : undefined,
      }),
    });
    const adapted = screenerOutcomeFromHttpJob("/api/reports/custom-1236?x=1", 200, '{"ok":true,"matched":3,"scanned":9}');
    expect(adapted).not.toBeNull();
    expect(adapted?.kind).toBe("stock");
    expect(adapted?.success).toBe(true);
    expect(adapted?.matchedCount).toBe(3);
    expect(adapted?.totalScanned).toBe(9);
    expect(screenerOutcomeFromHttpJob("/api/reports/other-1236", 200, '{"ok":true}')).toBeNull();
  });

  it("an adapter that declines (null) leaves the job without follow-ups; builtins still win", () => {
    registerHttpOutcomeAdapter({
      match: (path) => path.split("?")[0].endsWith("/reports/decline-1236"),
      adapt: () => null,
    });
    expect(screenerOutcomeFromHttpJob("/api/reports/decline-1236", 200, '{"ok":true}')).toBeNull();
    registerHttpOutcomeAdapter({
      match: () => true,
      adapt: () => ({ kind: "options", trigger: "manual", success: true, pdfKeys: [] }),
    });
    const builtin = screenerOutcomeFromHttpJob("/etrade/screen", 200, '{"matchedCount":1}');
    expect(builtin?.kind).toBe("stock");
  });
});

describe("goal bridge deliver suppression (#1236)", () => {
  let orm: DatabaseORM;
  let env: Env;

  beforeEach(() => {
    vi.restoreAllMocks();
    executeGoalScreenRun.mockReset();
    executeGoalScreenRun.mockResolvedValue({
      executed: true,
      taskId: "task-1",
      result: {
        goalKind: "income",
        status: "complete",
        counts: { hits: 2, stocksScanned: 10, stocksMatched: 2, optionsUnderlyingsScanned: 4, optionsContractsMatched: 1 },
      },
      canonicalReportId: "rep-1",
    });
    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("goal_test_trader");
    const { namespace: sessionStoreNs } = makeFakeSessionStore();
    env = {
      APP_ENV: "TEST",
      SESSION_STORE: sessionStoreNs,
      SCREENER_AGENT: { idFromName: (n: string) => n, get: () => ({}) },
      // #2051: goal_workflow is default-ON. The chained tests pin
      // the DIRECT deliver path (chain mode keeps it until S5
      // #4280); the unchained test pins the workflow submission.
      // The flag no longer gates either entry (#4279).
      FEATURE_FLAGS: JSON.stringify({ goal_workflow: false }),
    } as unknown as Env;
  });

  function makeService(bridge: ReturnType<typeof vi.fn>) {
    return new ScheduledTasksService(
      env, orm, "goal_test_trader",
      undefined, undefined, undefined, undefined,
      bridge as never,
    );
  }

  it("chained goal: no direct deliver; bridge carries deliverViaChain true + per-task recipients", async () => {
    const bridge = vi.fn().mockResolvedValue(undefined);
    const service = makeService(bridge);
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      emailTo: "owner@example.com",
      slackChannel: "C123",
      stageChain: CHAIN,
    });
    expect(result.success).toBe(true);
    expect(executeGoalScreenRun).toHaveBeenCalledTimes(1);
    expect(executeGoalScreenRun.mock.calls[0][0]).not.toHaveProperty("deliver");
    expect(bridge).toHaveBeenCalledTimes(1);
    const outcome = bridge.mock.calls[0][0] as ScreenerRunOutcome;
    expect(outcome.kind).toBe("goal");
    expect(outcome.deliverViaChain).toBe(true);
    expect(outcome.emailTo).toBe("owner@example.com");
    expect(outcome.slackChannel).toBe("C123");
    expect(outcome.deliveryChannels).toEqual(["email", "slack"]);
    expect(outcome.canonicalReportId).toBe("rep-1");
    expect(outcome.matchedCount).toBe(2);
    expect(outcome.totalScanned).toBe(14);
    expect(outcome.stageChain).toEqual(CHAIN);
  });

  it("unchained goal: the workflow submission carries the deliver channels; bridge never runs (#4279: the direct path is retired for unchained runs)", async () => {
    mockedStart.mockResolvedValue(HANDLE as never);
    const bridge = vi.fn().mockResolvedValue(undefined);
    const service = makeService(bridge);
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      emailTo: "owner@example.com",
      pushToSlack: true,
    });
    expect(result.success).toBe(true);
    expect((result as { data: Record<string, unknown> }).data.status).toBe("queued");
    expect(executeGoalScreenRun).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
    // The deliver channels ride the submission — the engine job's
    // deliver stage reads them from the goal command.
    expect(mockedBuild).toHaveBeenCalledTimes(1);
    expect((mockedBuild.mock.calls[0][0] as Record<string, unknown>).deliverChannels).toEqual(["email", "slack"]);
  });

  it("chained goal with no recipients: bridge allowlist is empty (no invented deliveries)", async () => {
    const bridge = vi.fn().mockResolvedValue(undefined);
    const service = makeService(bridge);
    await service.autonomousGoalScreen({ goalKind: "income", stageChain: CHAIN });
    expect(executeGoalScreenRun.mock.calls[0][0]).not.toHaveProperty("deliver");
    const outcome = bridge.mock.calls[0][0] as ScreenerRunOutcome;
    expect(outcome.deliveryChannels).toEqual([]);
    expect(outcome.emailTo).toBeUndefined();
    expect(outcome.slackChannel).toBeUndefined();
  });
});
