/** @vitest-environment jsdom */
/**
 * Issue #4262 (S2) — the Workflow Runs read folded into the one ledger.
 *
 * Pins:
 *  - 4262S2-P01 attachment by linkage: a workflow run whose id/runId a ledger
 *    row already carries (asyncJobId / workflowId / jobId) is the same run —
 *    the ledger row wins and no second row appears.
 *  - 4262S2-P02 a workflow run with no ledger twin becomes one ledger row,
 *    stamped with its recorded family as the kind (options/stock/strategy),
 *    falling back to `workflow`.
 *  - 4262S2-P03 the status → outcome mapping is honest: completed success,
 *    failed/partial failure, everything else skipped (the detail carries why).
 *  - 4262S2-P04 the old Workflow Runs address is a folded view: it redirects to
 *    the one ledger with kind=workflow, so existing links keep working.
 *  - 4262S2-P05 the ledger renders a folded workflow run and opens the SAME
 *    detail component for it (no second detail implementation).
 */
import { describe, it, expect } from "vitest";
import {
  attachWorkflowRuns,
  WORKFLOW_RUNS_LEDGER_SYSTEM,
} from "../src/services/runLedgerWorkflowRuns";
import { classifyRunKind } from "../src/services/runLedgerKinds";
import { legacySchedulesRedirect } from "../src/client/schedulesHomeView";
import type { WorkflowRun } from "../src/services/workflowRuns";
import type { JobRunRecord } from "../src/data/jobRunRecordPorts";

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    runId: "run-1",
    workflow: "screener",
    family: "stock",
    title: "Stock screen",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled (job-tree)",
    triggeredBy: "schedule:sched-1",
    status: "completed",
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:05:00.000Z",
    durationMs: 300000,
    stageCount: 6,
    completedStages: 6,
    failedStages: 0,
    stages: [],
    inputs: null,
    outputs: null,
    artifacts: [],
    deliveryStates: {},
    error: null,
    ...(overrides as object),
  } as WorkflowRun;
}

function ledgerRow(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    system: "orchestrator-schedule",
    jobId: "sched-1",
    operation: "trading.screen_stocks",
    started: "2026-11-12T09:00:00.000Z",
    finished: "2026-11-12T09:01:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    ...(overrides as object),
  } as JobRunRecord;
}

describe("4262S2-P01 linkage attachment", () => {
  it("drops a workflow run the ledger already carries by asyncJobId", () => {
    const entries = attachWorkflowRuns([ledgerRow({ asyncJobId: "run-1" })], [run()]);
    expect(entries).toHaveLength(0);
  });

  it("drops it by workflowId or jobId too", () => {
    expect(attachWorkflowRuns([ledgerRow({ workflowId: "run-1" })], [run()])).toHaveLength(0);
    expect(attachWorkflowRuns([ledgerRow({ jobId: "run-1" })], [run()])).toHaveLength(0);
  });

  it("keeps a workflow run with no ledger twin", () => {
    const entries = attachWorkflowRuns([ledgerRow()], [run()]);
    expect(entries).toHaveLength(1);
    expect(entries[0].row.jobId).toBe("run-1");
    expect(entries[0].row.system).toBe(WORKFLOW_RUNS_LEDGER_SYSTEM);
  });

  it("never lists the same workflow run twice", () => {
    const entries = attachWorkflowRuns([], [run(), run()]);
    expect(entries).toHaveLength(1);
  });
});

describe("4262S2-P02 kind from the recorded family", () => {
  it("classifies by family, falling back to workflow", () => {
    expect(classifyRunKind(attachWorkflowRuns([], [run({ family: "options" })])[0].row)).toBe(
      "options",
    );
    expect(classifyRunKind(attachWorkflowRuns([], [run({ family: "stock" })])[0].row)).toBe("stock");
    expect(classifyRunKind(attachWorkflowRuns([], [run({ family: "strategy" })])[0].row)).toBe(
      "strategy",
    );
    expect(
      classifyRunKind(attachWorkflowRuns([], [run({ family: "payment" as never })])[0].row),
    ).toBe("workflow");
  });
});

describe("4262S2-P03 honest status mapping", () => {
  it("maps the recorded status without inventing one", () => {
    const outcome = (status: WorkflowRun["status"]) =>
      attachWorkflowRuns([], [run({ status })])[0].row.outcome;
    expect(outcome("completed")).toBe("success");
    expect(outcome("failed")).toBe("failure");
    expect(outcome("partial")).toBe("failure");
    expect(outcome("running")).toBe("skipped");
    expect(outcome("queued")).toBe("skipped");
  });

  it("narrows the trigger to the ledger's vocabulary", () => {
    const trigger = (t: WorkflowRun["trigger"]) =>
      attachWorkflowRuns([], [run({ trigger: t })])[0].row.trigger;
    expect(trigger("scheduled")).toBe("scheduled");
    expect(trigger("manual")).toBe("manual");
    // Not representable in the ledger's five-valued trigger: stays unrecorded.
    expect(trigger("agent")).toBeUndefined();
  });
});

describe("4262S2-P04 the old address is a folded view", () => {
  it("redirects workflow-runs to the one ledger with kind=workflow", () => {
    expect(legacySchedulesRedirect("?tab=workflow-runs")).toEqual({
      tab: "schedules",
      view: "runs",
      params: { kind: "workflow" },
    });
  });

  it("leaves every other address alone", () => {
    expect(legacySchedulesRedirect("?tab=schedules&view=runs")).toBeNull();
    expect(legacySchedulesRedirect("?tab=chat")).toBeNull();
  });
});
