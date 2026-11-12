/**
 * Issue #1996 (#1972 slice 1) — goal-screen commands on the
 * ScreenerScreenWorkflow machinery.
 *
 * #4192: the child-workflow flows (runShardFlow /
 * runParentFlow, ChildWorkflowOps, the fake step + virtual
 * clock) are retired — goal screens run through the one
 * engine now, via InMemoryWorkflowAdapter with a
 * runGoalScreen fake. The pure helpers moved to
 * src/workflows/screenerCollation.ts; the flow describes
 * below drive the adapter instead, asserting the same
 * intents (goal runner executed, envelope stored, deliver
 * per channels, fail-closed without goal support, parent
 * collation) on the collation + projected rows.
 *
 * Covers: port validation for goal-screen commands, the
 * goal result → shard result mapping, the goal branch of
 * the engine path (including the fail-closed rule: a goal
 * command NEVER falls back to a market screen), and parent
 * collation for a single-goal-shard run.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import type { ShardJobStore } from "../src/data/shardJobPorts";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import {
  goalResultToShardResult,
  goalShardRequest,
  type ScreenerWorkflowDeps,
  type ShardScreenResult,
} from "../src/workflows/screenerCollation";
import {
  assertWorkflowJobCommand,
  WorkflowError,
  type ParentScreenReportInput,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";
import { buildScenario } from "../src/services/goalScenarioEngine";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

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

function goalParentCommand(overrides: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    role: "parent",
    tenantId: "tenant-1",
    shards: [{ shardId: "goal" }],
    goalScreen: {
      scenario: buildScenario({
        goalKind: "income",
        portfolioRef: { kind: "hypothetical" },
      }),
      scenarioSource: "built",
    },
    ...overrides,
  };
}

function okGoalShardResult(result: GoalDrivenScreenResult): ShardScreenResult {
  return goalResultToShardResult({
    taskId: "task-1",
    scenarioSource: "built",
    trigger: "manual",
    result,
  });
}

interface GoalDepsBundle {
  store: InMemoryShardJobAdapter;
  stored: unknown[];
  delivered: unknown[];
  /** Parent canonical rows the finalize stored (the parent door). */
  parentStored: ParentScreenReportInput[];
  deps: ScreenerWorkflowDeps;
  runScreen: ReturnType<typeof vi.fn>;
  runGoalScreen: ReturnType<typeof vi.fn>;
}

function makeGoalDeps(opts: {
  withGoalRunner: boolean;
  /** Canned goal result the fake returns (default: the complete fake above). */
  goalResult?: GoalDrivenScreenResult;
  /** When set, the store door returns this as the canonical report id. */
  reportId?: string;
}): GoalDepsBundle {
  const store = new InMemoryShardJobAdapter();
  const stored: unknown[] = [];
  const delivered: unknown[] = [];
  const parentStored: ParentScreenReportInput[] = [];
  const runScreen = vi.fn(async () => {
    throw new Error("market runner must never run for a goal command");
  });
  const runGoalScreen = vi.fn(async () =>
    okGoalShardResult(opts.goalResult ?? fakeGoalResult()),
  );
  const deps: ScreenerWorkflowDeps = {
    screenRunner: opts.withGoalRunner
      ? { runScreen, runGoalScreen }
      : { runScreen },
    shardStore: store,
    storeReport: async (payload) => {
      stored.push(payload);
      if (opts.reportId) return opts.reportId;
    },
    deliverOutcome: async (payload) => {
      delivered.push(payload);
    },
    storeParentReport: async (input) => {
      parentStored.push(input);
      return { stored: true, reportId: "parent-1" };
    },
    // No virtual clock on the engine path: the engine owns
    // pacing; the deps clock is a fixed instant.
    nowMs: () => 1_000_000,
  };
  return { store, stored, delivered, parentStored, deps, runScreen, runGoalScreen };
}

/** The parent canonical row (the door's read-back). */
async function latestParentRow(store: ShardJobStore, jobId: string) {
  return store.latestJob("tenant-1", jobId, jobId);
}

/** The collation the parent row carries (the door's read-back). */
async function collationFor(store: ShardJobStore, jobId: string) {
  const row = await latestParentRow(store, jobId);
  return JSON.parse(row?.resultJson ?? "{}") as Record<string, unknown>;
}

function collationShards(collation: Record<string, unknown>) {
  return (collation.shards ?? []) as Array<Record<string, unknown>>;
}

/* ------------------------------------------------------------------ */
/* Port: goal-screen command validation                                */
/* ------------------------------------------------------------------ */

describe("goal-screen command validation (#1996)", () => {
  it("accepts a well-formed goal parent command", () => {
    expect(assertWorkflowJobCommand(goalParentCommand())).toBeDefined();
  });

  it("rejects a goal command without a scenario", () => {
    const cmd = goalParentCommand();
    delete (cmd.goalScreen as Partial<NonNullable<WorkflowJobCommand["goalScreen"]>>).scenario;
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a goal command with an unknown asset class", () => {
    const cmd = goalParentCommand({
      goalScreen: {
        scenario: buildScenario({ goalKind: "income", portfolioRef: { kind: "hypothetical" } }),
        scenarioSource: "built",
        assetClasses: ["crypto"] as never,
      },
    });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a goal command with symbols over the claim-check cap", () => {
    const cmd = goalParentCommand({
      goalScreen: {
        scenario: buildScenario({ goalKind: "income", portfolioRef: { kind: "hypothetical" } }),
        scenarioSource: "built",
        symbols: Array.from({ length: 201 }, (_, i) => `SYM${i}`),
      },
    });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("rejects a goal command with an unknown deliver channel", () => {
    const cmd = goalParentCommand({
      goalScreen: {
        scenario: buildScenario({ goalKind: "income", portfolioRef: { kind: "hypothetical" } }),
        scenarioSource: "built",
        deliver: ["smoke-signal"] as never,
      },
    });
    expect(() => assertWorkflowJobCommand(cmd)).toThrow(WorkflowError);
  });

  it("leaves market commands unaffected", () => {
    const cmd = goalParentCommand();
    delete cmd.goalScreen;
    cmd.shards = [{ shardId: "TECH", universe: "TECH" }];
    expect(assertWorkflowJobCommand(cmd)).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Mapping: goal result -> shard result                                */
/* ------------------------------------------------------------------ */

describe("goalResultToShardResult (#1996)", () => {
  it("maps counts, keeps the pdf key, and envelopes the full result for the child store step", () => {
    const result = fakeGoalResult({ pdfKey: "pdf-1" } as Partial<GoalDrivenScreenResult>);
    const shard = goalResultToShardResult({
      taskId: "task-1",
      scenarioSource: "stored",
      trigger: "scheduled",
      result,
    });
    expect(shard.success).toBe(true);
    expect(shard.totalScanned).toBe(150);
    expect(shard.expectedCount).toBe(150);
    expect(shard.matchedCount).toBe(1);
    expect(shard.pdfKey).toBe("pdf-1");
    expect(shard.timestamp).toBe("2026-10-27T12:00:00.000Z");
    const full = shard.full as { taskId: string; scenarioSource: string; trigger: string; result: unknown };
    expect(full.taskId).toBe("task-1");
    expect(full.scenarioSource).toBe("stored");
    expect(full.trigger).toBe("scheduled");
    expect(full.result).toBe(result);
  });

  it("marks a failed goal run failed with a loud error, never a fake success", () => {
    const result = fakeGoalResult({
      status: "failed",
      hits: [],
      counts: {
        stocksScanned: 0,
        stocksMatched: 0,
        optionsUnderlyingsScanned: 0,
        optionsContractsMatched: 0,
        hits: 0,
      },
    });
    const shard = goalResultToShardResult({
      taskId: "task-1",
      scenarioSource: "built",
      trigger: "manual",
      result,
    });
    expect(shard.success).toBe(false);
    expect(shard.error).toMatch(/failed/);
  });

  it("counts a partial goal run as success with qualification (the #462 vocabulary)", () => {
    const result = fakeGoalResult({ status: "partial" });
    const shard = goalResultToShardResult({
      taskId: "task-1",
      scenarioSource: "built",
      trigger: "manual",
      result,
    });
    expect(shard.success).toBe(true);
    expect(shard.error).toBeUndefined();
  });

  it("goalShardRequest builds the goal request from the parent command (idempotency key is the run id)", () => {
    const parent = goalParentCommand();
    const req = goalShardRequest(parent);
    expect(req.scenario.goalKind).toBe("income");
    expect(req.scenarioSource).toBe("built");
    expect(req.trigger).toBe("manual");
    expect(req.idempotencyKey).toBe(parent.jobId);
    expect(req.userLogin).toBe("alice");
  });
});

/* ------------------------------------------------------------------ */
/* Engine path: goal shard (adapter runs, not runShardFlow)            */
/* ------------------------------------------------------------------ */

describe("adapter: goal shard (#1996)", () => {
  it("executes the goal runner, stores the envelope, and never touches the market runner", async () => {
    const parent = goalParentCommand();
    const { store, stored, delivered, parentStored, deps, runScreen, runGoalScreen } =
      makeGoalDeps({ withGoalRunner: true });
    const adapter = new InMemoryWorkflowAdapter(deps);
    const h = await adapter.start(parent);
    expect(h.status).toBe("complete");
    expect(runScreen).not.toHaveBeenCalled();
    expect(runGoalScreen).toHaveBeenCalledTimes(1);
    const req = runGoalScreen.mock.calls[0][0];
    expect(req.scenario.goalKind).toBe("income");
    expect(req.idempotencyKey).toBe(parent.jobId);
    expect(req.userLogin).toBe("alice");
    // The unit stores the full envelope and (no deliver
    // channels on this command) does not deliver.
    expect(stored).toHaveLength(1);
    const envelope = stored[0] as { taskId: string; scenarioSource: string; result: GoalDrivenScreenResult };
    expect(envelope.taskId).toBe("task-1");
    expect(envelope.scenarioSource).toBe("built");
    expect(envelope.result.goalKind).toBe("income");
    expect(delivered).toHaveLength(0);
    // Claim-check: bulk data never leaves the run — the
    // collation carries summaries + flags only.
    const collation = await collationFor(store, parent.jobId);
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect("full" in collation).toBe(false);
    expect(collationShards(collation)[0]).toMatchObject({
      shardId: "goal",
      status: "completed",
      totalScanned: 150,
      expectedCount: 150,
      matchedCount: 1,
      stored: true,
      delivered: false,
    });
    expect(parentStored).toHaveLength(1);
    expect(parentStored[0]?.collation.lifecycle).toBe("ReportGenerated");
    expect(parentStored[0]?.goalScreen).toBe(true);
    const rows = await store.listJobsForChain("tenant-1", parent.jobId);
    expect(rows.find((r) => r.jobKey === "shard:goal")?.status).toBe("completed");
  });

  it("runs the deliver step for goal commands that carry deliver channels", async () => {
    const parent = goalParentCommand({ deliver: true });
    const { store, stored, delivered, parentStored, deps } = makeGoalDeps({
      withGoalRunner: true,
    });
    const adapter = new InMemoryWorkflowAdapter(deps);
    const h = await adapter.start(parent);
    expect(h.status).toBe("complete");
    expect(delivered).toHaveLength(1);
    expect(stored).toHaveLength(1);
    const collation = await collationFor(store, parent.jobId);
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.storedShards).toEqual(["goal"]);
    expect(collation.deliveredShards).toEqual(["goal"]);
    expect(parentStored).toHaveLength(1);
    expect(parentStored[0]?.collation.lifecycle).toBe("ReportGenerated");
  });

  it("fails closed when the runner has no goal support — never a market-screen fallback", async () => {
    const parent = goalParentCommand();
    const { store, stored, delivered, parentStored, deps, runScreen } = makeGoalDeps({
      withGoalRunner: false,
    });
    const adapter = new InMemoryWorkflowAdapter(deps);
    const h = await adapter.start(parent);
    // A unit failure settles as a Failed collation with
    // adapter status "complete" — only an infra/dispatch
    // failure records "errored".
    expect(h.status).toBe("complete");
    expect(runScreen).not.toHaveBeenCalled();
    expect(stored).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(parentStored).toHaveLength(1);
    expect(parentStored[0]?.collation.lifecycle).toBe("Failed");
    expect(parentStored[0]?.collation.error).toMatch(/refusing a market-screen fallback/);
    const rows = await store.listJobsForChain("tenant-1", parent.jobId);
    expect(rows.find((r) => r.jobKey === "leg:goal")?.status).toBe("failed");
    const failedParent = await store.latestJob("tenant-1", parent.jobId, "leg:parent");
    expect(failedParent?.status).toBe("failed");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/1 shards/);
  });

  it("a failed goal result rides as data — the unit still stores/delivers, then the composer fails the shard", async () => {
    // Unlike a market failure (which throws at analysis),
    // a goal failure is a failed goalResult carried through
    // store/deliver; the composer fails the shard on the
    // goal verdict, loudly.
    const parent = goalParentCommand({ deliver: true });
    const failed = fakeGoalResult({
      status: "failed",
      hits: [],
      counts: {
        stocksScanned: 0,
        stocksMatched: 0,
        optionsUnderlyingsScanned: 0,
        optionsContractsMatched: 0,
        hits: 0,
      },
    });
    const { store, stored, delivered, parentStored, deps } = makeGoalDeps({
      withGoalRunner: true,
      goalResult: failed,
    });
    const adapter = new InMemoryWorkflowAdapter(deps);
    const h = await adapter.start(parent);
    expect(h.status).toBe("complete");
    expect(stored).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(parentStored).toHaveLength(1);
    const collation = parentStored[0]?.collation;
    expect(collation?.lifecycle).toBe("Failed");
    expect(collation?.shards).toHaveLength(1);
    expect(collation?.shards[0]?.status).toBe("failed");
    expect(collation?.shards[0]?.error).toMatch(/Goal screen failed \(income\/bullish\)/);
    const rows = await store.listJobsForChain("tenant-1", parent.jobId);
    expect(rows.find((r) => r.jobKey === "leg:goal")?.status).toBe("failed");
    const failedParent = await store.latestJob("tenant-1", parent.jobId, "leg:parent");
    expect(JSON.parse(failedParent?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/1 shards/);
  });

  it("a shard-role goal command is refused — no child workflows exist on the engine path", async () => {
    const parent = goalParentCommand();
    const shardCommand: WorkflowJobCommand = {
      ...parent,
      role: "shard",
      parentJobId: parent.jobId,
      shard: { shardId: "goal" },
      shards: [{ shardId: "goal" }],
      jobId: `${parent.jobId}:shard:goal`,
    };
    const { stored, delivered, parentStored, deps, runScreen, runGoalScreen } = makeGoalDeps({
      withGoalRunner: true,
    });
    const adapter = new InMemoryWorkflowAdapter(deps);
    const h = await adapter.start(shardCommand);
    // The dispatch refuses by name; the adapter records the
    // dispatch failure as "errored" and runs nothing.
    expect(h.status).toBe("errored");
    expect(await adapter.status(h.workflowId)).toMatchObject({ status: "errored" });
    expect(runScreen).not.toHaveBeenCalled();
    expect(runGoalScreen).not.toHaveBeenCalled();
    expect(stored).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(parentStored).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Engine path: goal parent collation (adapter runs, not runParentFlow) */
/* ------------------------------------------------------------------ */

describe("adapter: goal parent collation (#1996)", () => {
  it("collates a single stored goal shard to ReportGenerated", async () => {
    const parent = goalParentCommand({ deliver: true });
    const { store, stored, delivered, parentStored, deps } = makeGoalDeps({
      withGoalRunner: true,
    });
    const adapter = new InMemoryWorkflowAdapter(deps);
    const h = await adapter.start(parent);
    expect(h.status).toBe("complete");
    const collation = await collationFor(store, parent.jobId);
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collation.qualified).toBe(false);
    expect(collation.coverage).toEqual({ evaluated: 150, considered: 150, ratio: 1 });
    expect(collationShards(collation)).toHaveLength(1);
    expect(collationShards(collation)[0]).toMatchObject({
      shardId: "goal",
      status: "completed",
      matchedCount: 1,
    });
    expect(collation.storedShards).toEqual(["goal"]);
    expect(collation.deliveredShards).toEqual(["goal"]);
    // Goal parents link by report id, never by
    // screener:<timestamp>.
    expect(collation.childRunIds).toEqual([]);
    expect(stored).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(parentStored).toHaveLength(1);
    expect(parentStored[0]?.jobId).toBe(parent.jobId);
    expect(parentStored[0]?.goalScreen).toBe(true);
    expect(parentStored[0]?.collation.lifecycle).toBe("ReportGenerated");
    const parentRow = await latestParentRow(store, parent.jobId);
    expect(parentRow?.status).toBe("completed");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
    const rows = await store.listJobsForChain("tenant-1", parent.jobId);
    expect(rows.map((r) => r.jobKey).sort()).toEqual(
      [parent.jobId, "shard:goal"].sort(),
    );
  });

  it("a goal door report id surfaces on the shard outcome and the parent row", async () => {
    const parent = goalParentCommand({ deliver: true });
    const { store, parentStored, deps } = makeGoalDeps({
      withGoalRunner: true,
      reportId: "goal-report-1",
    });
    const adapter = new InMemoryWorkflowAdapter(deps);
    const h = await adapter.start(parent);
    expect(h.status).toBe("complete");
    const collation = await collationFor(store, parent.jobId);
    expect(collation.lifecycle).toBe("ReportGenerated");
    expect(collationShards(collation)[0]?.reportId).toBe("goal-report-1");
    expect(collation.childReportIds).toEqual(["goal-report-1"]);
    expect(parentStored[0]?.childReportIds).toEqual(["goal-report-1"]);
    const parentRow = await latestParentRow(store, parent.jobId);
    expect(JSON.parse(parentRow?.resultJson ?? "{}").childReportIds).toEqual([
      "goal-report-1",
    ]);
  });
});
