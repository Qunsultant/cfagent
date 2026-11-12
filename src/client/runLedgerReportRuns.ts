/**
 * Issue #4262 (S4, option A) — the reports read folded into the one ledger.
 *
 * The ledger row answers "what ran"; this adapter attaches what the run
 * PRODUCED. The reports read (`GET /api/runs`) already models each run's
 * three artifacts with their per-kind state (a download link, an honest
 * "—", or a recorded leg failure with its reason — #2088). Folding therefore
 * means attaching those rows to the ledger, not re-drawing them:
 *
 *   - A report run the ledger already carries (same runId as a row's
 *     `asyncJobId`/`workflowId`/`jobId`) is the same run: the ledger row wins.
 *   - A report run with no ledger twin becomes one ledger row stamped
 *     `system: "report-runs"` and `kind: "reports"`, carrying its
 *     `DocumentRow` so the panel renders the same artifact cells and the same
 *     details dialog.
 *
 * Pure by construction (no fetch, no clock); the panel does the reading.
 */
import type { JobRunRecord } from "../data/jobRunRecordPorts";
import type { RunLedgerKind } from "../config/runLedgerModes";
import { toDocumentRows, type DocumentRow } from "./docsAndReports";

/** The system stamp for rows adapted from the reports read. */
export const REPORT_RUNS_LEDGER_SYSTEM = "report-runs";

export interface ReportLedgerEntry {
  row: JobRunRecord & { kind?: RunLedgerKind };
  docs: DocumentRow;
}

/**
 * Attach the reports rows to the ledger rows.
 *
 * `rawRuns` is the `/api/runs` payload's `runs` array — the same shape the
 * Docs page maps with `toDocumentRows`, so the artifact states are produced by
 * the one mapping, never a second copy.
 */
export function attachReportRuns(
  ledgerRows: readonly JobRunRecord[],
  rawRuns: readonly unknown[],
): ReportLedgerEntry[] {
  const taken = new Set<string>();
  for (const row of ledgerRows) {
    for (const value of [row.asyncJobId, row.workflowId, row.jobId]) {
      if (typeof value === "string" && value.trim()) taken.add(value.trim());
    }
  }

  const out: ReportLedgerEntry[] = [];
  for (const docs of toDocumentRows(rawRuns as Parameters<typeof toDocumentRows>[0])) {
    if (!docs.runId || taken.has(docs.runId)) continue; // the ledger row is this run
    taken.add(docs.runId);

    const failed = docs.status === "failed";
    out.push({
      docs,
      row: {
        system: REPORT_RUNS_LEDGER_SYSTEM as JobRunRecord["system"],
        jobId: docs.runId,
        operation: "report.generate",
        started: docs.createdAt,
        finished: docs.createdAt,
        outcome: failed ? "failure" : "success",
        triggeredBy: (docs.rawTrigger ?? docs.runType ?? "unknown") as JobRunRecord["triggeredBy"],
        trigger: docs.runType === "manual" || docs.runType === "scheduled" ? docs.runType : undefined,
        scheduleId: null,
        asyncJobId: null,
        workflowId: null,
        descriptor: docs.title,
        detail: failed ? (docs.pdfError ?? docs.xlsxError ?? docs.csvError ?? "failed") : undefined,
        kind: "reports" as RunLedgerKind,
      },
    });
  }
  return out;
}
