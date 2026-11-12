/**
 * Issue #4262 (S2) — folding the Workflow Runs read into the one ledger.
 *
 * The ledger (`job_run_records`) is the one run store; the workflow-runs read
 * (`GET /api/workflow-runs`) is the second system of record. Folding means
 * **adapting** its rows into the ledger's row shape and **attaching** them by
 * linkage, never listing them twice:
 *
 *   - A workflow run whose id/runId a ledger row already carries as its
 *     `asyncJobId`, `workflowId` or `jobId` is the SAME run: the ledger row
 *     wins and the workflow run is dropped.
 *   - A workflow run with no ledger twin becomes one ledger row whose
 *     `system` is "workflow-runs" and whose `kind` is the family the store
 *     recorded (options/stock/strategy/goal), falling back to `workflow`.
 *     The kind is stamped because the source knows it; the rule table cannot
 *     see a family it was not told about.
 *
 * Pure by construction: rows in, rows out. No fetch, no clock. The panel keeps
 * the adapted `WorkflowRun` for the detail view (the row is a projection).
 */
import type { JobRunOutcome, JobRunRecord } from "../data/jobRunRecordPorts";
import type { RunLedgerKind } from "../config/runLedgerModes";
import type { WorkflowRun } from "./workflowRuns";

/** The system stamp for rows adapted from the workflow-runs read. */
export const WORKFLOW_RUNS_LEDGER_SYSTEM = "workflow-runs";

/** A ledger row adapted from a workflow run, plus its source for the detail. */
export interface WorkflowLedgerEntry {
  row: JobRunRecord & { kind?: RunLedgerKind };
  run: WorkflowRun;
}

const FAMILY_KINDS: Record<string, RunLedgerKind> = {
  stock: "stock",
  options: "options",
  strategy: "strategy",
  goal: "goal",
  reports: "reports",
  report: "reports",
};

function outcomeOf(run: WorkflowRun): JobRunOutcome {
  if (run.status === "failed" || run.status === "partial") return "failure";
  if (run.status === "completed") return "success";
  // queued / running / awaiting / skipped / unknown: the run did not
  // complete, and a skip needs a recorded reason the ledger does not have
  // here — the detail view carries the real state.
  return "skipped";
}

function linkageKeys(run: WorkflowRun): string[] {
  const keys = new Set<string>();
  for (const value of [run.id, run.runId]) {
    if (typeof value === "string" && value.trim()) keys.add(value.trim());
  }
  return [...keys];
}

/**
 * Attach the workflow-runs rows to the ledger rows.
 *
 * `ledgerRows` are the rows already read from `job_run_records`; a workflow
 * run is dropped when one of its linkage keys is one of their
 * `asyncJobId`/`workflowId`/`jobId` values.
 */
export function attachWorkflowRuns(
  ledgerRows: readonly JobRunRecord[],
  runs: readonly WorkflowRun[],
): WorkflowLedgerEntry[] {
  const taken = new Set<string>();
  for (const row of ledgerRows) {
    for (const value of [row.asyncJobId, row.workflowId, row.jobId]) {
      if (typeof value === "string" && value.trim()) taken.add(value.trim());
    }
  }

  const out: WorkflowLedgerEntry[] = [];
  for (const run of runs) {
    const keys = linkageKeys(run);
    if (keys.some((key) => taken.has(key))) continue; // the ledger row is this run
    for (const key of keys) taken.add(key);

    const kind: RunLedgerKind = FAMILY_KINDS[run.family] ?? "workflow";
    const stageNote =
      run.stageCount > 0
        ? `${run.completedStages}/${run.stageCount} stages`
        : "no stages recorded";

    const row: JobRunRecord & { kind?: RunLedgerKind } = {
      // A projection: the row names the read that produced it. It is never
      // written back to job_run_records, so the writer's system domain is
      // untouched (#4262 keeps one store, one writer).
      system: WORKFLOW_RUNS_LEDGER_SYSTEM as JobRunRecord["system"],
      jobId: run.id,
      operation: run.workflow,
      started: run.startedAt,
      finished: run.finishedAt ?? run.startedAt,
      outcome: outcomeOf(run),
      // The ledger's trigger vocabulary is narrower than the workflow read's:
      // an unrepresentable leg stays unrecorded here and is visible in the
      // detail view, never coerced into another verb.
      triggeredBy: (run.triggeredBy ?? run.triggerDetail) as JobRunRecord["triggeredBy"],
      trigger:
        run.trigger === "scheduled" || run.trigger === "manual"
          ? run.trigger
          : undefined,
      scheduleId: null,
      asyncJobId: run.source === "job-chain" || run.source === "job-outcome" ? run.runId : null,
      workflowId: run.source === "job-chain" ? run.runId : null,
      error: run.error ?? undefined,
      detail: stageNote,
      descriptor: run.title,
      brokerId: run.brokerId ?? null,
      mode: run.mode ?? null,
      modeSource: run.modeSource ?? null,
      kind,
    };
    out.push({ row, run });
  }
  return out;
}
