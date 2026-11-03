/**
 * Issue #2911 (G4): one status vocabulary for every stock report format
 * (PDF/XLSX/CSV), shared by writers, the canonical row, and the client.
 *
 * The split language this replaces: artifact legs recorded "generated" /
 * "failed" while the detail view rendered any other absence as "No PDF /
 * XLSX recorded", and the scheduled fanout legs recorded "not_attempted"
 * for a format that was never tried. Those are three different facts
 * (missing, failed, never attempted) and they must never collapse into
 * one another in the UI:
 *
 *  - "generated"      — a key exists for the format.
 *  - "failed"         — generation/store was attempted and failed, with
 *                       a coded error on the record.
 *  - "missing"        — the format was requested but no key and no
 *                       recorded status exist (legacy rows, or a writer
 *                       that never set the field).
 *  - "never-attempted" — the format was not requested for this run, so
 *                       its absence is expected, not a gap.
 *  - "skipped"        — a policy explicitly skipped the format. Stock
 *                       writers never emit it today (the options pipeline
 *                       records "skipped" for formats its policy drops);
 *                       the resolver passes a recorded "skipped" through
 *                       so the vocabulary stays shared.
 *
 * Resolution order: a recorded vocabulary status wins; then
 * not-requested; then a stored key; then a failed run with no key; else
 * missing. An unrecognized recorded status is not trusted — the stored
 * key is ground truth.
 *
 * This module imports nothing, so the client can share it with the
 * server without pulling server dependencies into the bundle.
 */

export type StockReportFormatStatus =
  | "generated"
  | "failed"
  | "missing"
  | "never-attempted"
  | "skipped";

const VOCABULARY: ReadonlySet<string> = new Set([
  "generated",
  "failed",
  "missing",
  "never-attempted",
  "skipped",
]);

export function isStockReportFormatStatus(value: unknown): value is StockReportFormatStatus {
  return typeof value === "string" && VOCABULARY.has(value);
}

export function resolveStockReportFormatStatus(input: {
  key?: string | null;
  status?: string | null;
  requested?: boolean;
  runFailed?: boolean;
}): StockReportFormatStatus {
  if (isStockReportFormatStatus(input.status)) return input.status;
  if (input.requested === false) return "never-attempted";
  if (input.key) return "generated";
  if (input.runFailed) return "failed";
  return "missing";
}

export function stockReportFormatStatusLabel(status: StockReportFormatStatus): string {
  switch (status) {
    case "generated":
      return "Generated";
    case "failed":
      return "Failed";
    case "missing":
      return "Missing";
    case "never-attempted":
      return "Not attempted";
    case "skipped":
      return "Skipped";
  }
}
