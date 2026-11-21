/**
 * Issue #6003 — the Autopilot outcome rows folded into the one ledger.
 *
 * Autopilot's list reads its own divergent copy — `GET /api/autopilot/jobs`
 * → the `mas_job_outcomes` outcome sink — it reads neither `GET /api/runs`
 * nor `GET /api/ledger/runs` for that list (#2606 reconciliation, live main
 * `dc021d3e`). The ledger's merge (`mergeLedgerRuns`) cannot carry the
 * twin-less kinds (corpus-sync, reports-index-backfill, trading-order,
 * feed): they live in neither DO half. The named minimal carve-out is this
 * fold, following the workflow/report attaches exactly:
 *
 *   - An outcome row whose id a ledger row already carries (as its
 *     `asyncJobId` / `workflowId` / `jobId`) is the same run: the ledger
 *     row wins and the outcome row is dropped. The run stays in the
 *     ledger under its existing kind — existing rows and counts do not
 *     move (additive).
 *   - An outcome row with no ledger twin becomes one ledger row stamped
 *     `system: "autopilot-jobs"` and `ledgerKind: "autopilot"`, so the
 *     Autopilot filter shows exactly the rows that would otherwise be
 *     absent. Nothing Autopilot shows today is dropped (lossless).
 *
 * Pure by construction (no fetch, no clock); the panel does the reading.
 * The rows are projections: they are never written back to
 * `job_run_records`, so the writer's system domain is untouched.
 */
import type { JobOutcomeRow } from "../data/jobOutcomePorts";
import type { JobRunRecord } from "../data/jobRunRecordPorts";
import type { RunLedgerKind } from "../config/runLedgerModes";

/** The system stamp for rows adapted from the Autopilot outcome read. */
export const AUTOPILOT_JOBS_LEDGER_SYSTEM = "autopilot-jobs";

/** A ledger row adapted from an Autopilot outcome row, plus its source. */
export interface AutopilotLedgerEntry {
  row: JobRunRecord & { ledgerKind?: RunLedgerKind };
  outcome: JobOutcomeRow;
}

function outcomeOf(outcome: JobOutcomeRow): JobRunRecord["outcome"] {
  if (outcome.status === "completed") return "success";
  // failed / partial: the run did not complete. A coded error rides
  // `error` when the outcome recorded one; a failure without one
  // carries no invented text — the detail view carries the real state.
  return "failure";
}

/**
 * The success summary: the counts Autopilot's own table renders, plus the
 * producer that wrote the outcome (the feed labels rows by origin).
 */
function descriptorOf(outcome: JobOutcomeRow): string {
  const parts: string[] = [];
  if (typeof outcome.scanned === "number") parts.push(`${outcome.scanned} scanned`);
  if (typeof outcome.matched === "number") parts.push(`${outcome.matched} matched`);
  if (parts.length > 0) return `${parts.join(", ")} via ${outcome.origin}`;
  return `Autopilot ${outcome.kind} run via ${outcome.origin}`;
}

/**
 * Attach the Autopilot outcome rows to the ledger rows.
 *
 * `ledgerRows` are the rows already read — the ledger base plus the
 * workflow- and report-folded rows, in merge order — so an outcome row
 * that any of them already carries is dropped as the same run. `jobs`
 * is the `/api/autopilot/jobs` payload's `jobs` array (newest first,
 * the same window Autopilot itself surfaces).
 */
export function attachAutopilotOutcomes(
  ledgerRows: readonly JobRunRecord[],
  jobs: readonly JobOutcomeRow[],
): AutopilotLedgerEntry[] {
  const taken = new Set<string>();
  for (const row of ledgerRows) {
    for (const value of [row.asyncJobId, row.workflowId, row.jobId]) {
      if (typeof value === "string" && value.trim()) taken.add(value.trim());
    }
  }

  const out: AutopilotLedgerEntry[] = [];
  for (const outcome of jobs) {
    const id = typeof outcome.id === "string" ? outcome.id.trim() : "";
    if (!id || taken.has(id)) continue; // the ledger row is this run
    taken.add(id);

    out.push({
      outcome,
      row: {
        // A projection: the row names the read that produced it. It is
        // never written back to job_run_records.
        system: AUTOPILOT_JOBS_LEDGER_SYSTEM as JobRunRecord["system"],
        jobId: id,
        // Namespaced under the family that produced it. No rule-table
        // entry matches it (deliberately — see runLedgerModes.ts: a
        // prefix rule would also catch the `autopilot.evaluate` goal
        // operation, which today classifies as "other"); the stamped
        // ledgerKind below is the classification.
        operation: `autopilot.${outcome.kind}`,
        started: outcome.createdAt,
        finished: outcome.createdAt,
        outcome: outcomeOf(outcome),
        triggeredBy: outcome.trigger,
        // No ledger trigger is recorded on an outcome row, and none is
        // invented: the five dispatch modes ride `triggeredBy`.
        scheduleId: null,
        // No linkage is known from the outcome row alone: the stock
        // bridge id is a delivery-or-job id the row does not label,
        // and an options run id is not a ledger linkage id. Nulls
        // render as "—" (§4), never a guessed link.
        asyncJobId: null,
        workflowId: null,
        error: outcome.codedError ?? undefined,
        descriptor: descriptorOf(outcome),
        ledgerKind: "autopilot" as RunLedgerKind,
      },
    });
  }
  return out;
}
