/**
 * Goal-screen report artifacts (issue #1335, job-truth program #1332).
 *
 * A completed goal-screen run produces a real report even with 0
 * records: PDF + CSV + XLSX, generated from the run result and stored
 * through the shared blob store (R2 when bound, DO-storage base64
 * otherwise — the same store the stock/options artifacts use).
 *
 * The 0-record case is the point: an empty report states its counts
 * and carries 0 data rows; it never skips, and a generation failure
 * is recorded per format (FAILURE_REPORT_PDF_GENERATION) without failing the run — the
 * #1278 (R5) failure contract, applied to goal-screen artifacts.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "@e965/xlsx";
import type { GoalDrivenScreenResult } from "./goalDrivenScreen";
import { recordJobOutcome } from "./jobOutcomes";
import type { SqlStorage } from "../orm";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/goalScreenReports",
});

export type GoalScreenArtifactFormat = "pdf" | "xlsx" | "csv";

export const GOAL_SCREEN_CSV_HEADERS = [
  "symbol",
  "asset_class",
  "provider_id",
  "structures",
] as const;

export const GOAL_SCREEN_ARTIFACT_PREFIX = "goal_screen:";

export function goalScreenArtifactKey(
  format: GoalScreenArtifactFormat,
  id: string
): string {
  return `${GOAL_SCREEN_ARTIFACT_PREFIX}${format}:${id}`;
}

export function isGoalScreenArtifactKey(key: string): boolean {
  return key.startsWith(GOAL_SCREEN_ARTIFACT_PREFIX);
}

export function goalScreenFileName(
  format: GoalScreenArtifactFormat,
  result: GoalDrivenScreenResult
): string {
  return `goal-screen-${result.goalKind}-${result.outlook}.${format}`;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function hitRows(result: GoalDrivenScreenResult): string[][] {
  return result.hits.map((h) => [
    h.symbol,
    h.assetClass,
    h.providerId,
    (h.structures ?? []).join(";"),
  ]);
}

/** CSV: header row plus one row per hit; headers only at 0 records. */
export function generateGoalScreenCsv(result: GoalDrivenScreenResult): string {
  const lines = [
    GOAL_SCREEN_CSV_HEADERS.join(","),
    ...hitRows(result).map((row) => row.map(csvEscape).join(",")),
  ];
  return lines.join("\n") + "\n";
}

/** XLSX: a Hits sheet (headers + rows) and a Summary sheet (counts). */
export function generateGoalScreenXlsx(result: GoalDrivenScreenResult): Uint8Array {
  const wb = XLSX.utils.book_new();
  const wsHits = XLSX.utils.aoa_to_sheet([
    [...GOAL_SCREEN_CSV_HEADERS],
    ...hitRows(result),
  ]);
  XLSX.utils.book_append_sheet(wb, wsHits, "Hits");
  const wsSummary = XLSX.utils.aoa_to_sheet([
    ["field", "value"],
    ["goal", result.goalKind],
    ["outlook", result.outlook],
    ["status", result.status],
    ["stocks_scanned", result.counts.stocksScanned],
    ["stocks_matched", result.counts.stocksMatched],
    ["options_underlyings_scanned", result.counts.optionsUnderlyingsScanned],
    ["options_contracts_matched", result.counts.optionsContractsMatched],
    ["hits", result.counts.hits],
  ]);
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Uint8Array;
}

/** PDF: title, outcome, counts, and the hit list (or the 0-record note). */
export async function generateGoalScreenPdf(
  result: GoalDrivenScreenResult
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
  let y = 752;
  const draw = (text: string, size: number, useBold = false, color = rgb(0, 0, 0)) => {
    if (y < 56) {
      page = doc.addPage([612, 792]);
      y = 752;
    }
    page.drawText(text, { x: 48, y, size, font: useBold ? bold : font, color });
    y -= size + 9;
  };
  draw(`Goal screen — ${result.goalKind} (${result.outlook})`, 16, true);
  draw(`Status: ${result.status}  ·  Completed: ${result.completedAt}`, 10);
  // Issue #1571: a fallback run's PDF provenance names it as a Yahoo
  // fallback — the market-screen wording verbatim — never as E*TRADE
  // live and never as plain Yahoo. Plain runs carry no such line.
  if (result.providerFallback) {
    draw("Quotes: Yahoo Finance quotes (delayed) — fallback (E*TRADE auth unavailable)", 10);
  }
  draw(
    `Stocks scanned: ${result.counts.stocksScanned}  ·  Stocks matched: ${result.counts.stocksMatched}`,
    10
  );
  draw(
    `Options underlyings scanned: ${result.counts.optionsUnderlyingsScanned}  ·  Contracts matched: ${result.counts.optionsContractsMatched}`,
    10
  );
  draw(`Records: ${result.counts.hits}`, 12, true);
  if (result.hits.length === 0) {
    draw("No records matched this goal screen.", 10, false, rgb(0.4, 0.4, 0.4));
  } else {
    draw("Hits:", 12, true);
    const shown = result.hits.slice(0, 100);
    for (const h of shown) {
      draw(
        `${h.symbol} — ${h.assetClass}${h.structures?.length ? ` (${h.structures.join(", ")})` : ""}`,
        10
      );
    }
    if (result.hits.length > shown.length) {
      draw(`... and ${result.hits.length - shown.length} more`, 10);
    }
  }
  return doc.save();
}

/**
 * Record one goal-screen run in the job-outcome sink (multi-tenant
 * run ledger). Goal runs have no async-job tree, so without this row
 * they never appear in Workflow Runs even though their artifacts and
 * canonical report exist. Keyed by the run id, so a re-record (direct
 * + workflow path on the same run) converges on one row.
 * Never throws — a sink failure must not fail the run.
 */
export interface GoalRunOutcomeRecord {
  id: string;
  trigger: "manual" | "scheduled";
  status: "completed" | "failed" | "partial";
  scanned?: number;
  matched?: number;
  error?: string;
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
  reportUrl?: string;
  origin?: string;
  createdAt?: string;
}

export function recordGoalRunOutcome(
  sql: SqlStorage | null | undefined,
  run: GoalRunOutcomeRecord,
): void {
  if (!sql) return;
  try {
    recordJobOutcome(sql, {
      id: run.id,
      kind: "goal",
      trigger: run.trigger,
      status: run.status,
      scanned: run.scanned,
      matched: run.matched,
      codedError: run.error,
      reportUrl: run.reportUrl,
      pdfKey: run.pdfKey,
      xlsxKey: run.xlsxKey,
      csvKey: run.csvKey,
      origin: run.origin ?? "goal-screen",
      createdAt: run.createdAt,
    });
  } catch (err) {
    structuredLog.warn("goal_screen.outcome_write_failed", {
      message: `[GoalScreenReports] outcome write failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface GoalScreenArtifactOutcome {
  pdfKey?: string;
  pdfStatus: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus: "generated" | "failed";
  csvError?: string;
}

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * Generate + store all three artifacts for a goal-screen result, each
 * retried under the R1 report policy. A per-format failure is recorded
 * on the outcome (FAILURE_REPORT_PDF_GENERATION) and never throws — the run completed,
 * the artifact did not.
 */
export async function generateAndStoreGoalScreenArtifacts(
  env: { REPORTS_BUCKET?: unknown },
  storage: BlobStorage,
  result: GoalDrivenScreenResult
): Promise<GoalScreenArtifactOutcome> {
  const { putReportPdf } = await import("./reportBlobStore");
  const { resolvePipelinePolicy } = await import("./pipelinePolicy");
  const { withRetry } = await import("./resilience");
  const { codedMessage, hasOutcomeCodePrefix } = await import("../outcomes/outcomeAspects");
  const policy = resolvePipelinePolicy(env as Record<string, unknown>);
  const contentTypes: Record<GoalScreenArtifactFormat, string> = {
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
  };
  const outcome: GoalScreenArtifactOutcome = {
    pdfStatus: "failed",
    xlsxStatus: "failed",
    csvStatus: "failed",
  };
  const formats: GoalScreenArtifactFormat[] = ["pdf", "xlsx", "csv"];
  for (const format of formats) {
    const statusKey = `${format}Status` as "pdfStatus" | "xlsxStatus" | "csvStatus";
    const keyKey = `${format}Key` as "pdfKey" | "xlsxKey" | "csvKey";
    const errorKey = `${format}Error` as "pdfError" | "xlsxError" | "csvError";
    try {
      const key = goalScreenArtifactKey(format, crypto.randomUUID().slice(0, 8));
      const bytes =
        format === "pdf"
          ? await generateGoalScreenPdf(result)
          : format === "xlsx"
            ? generateGoalScreenXlsx(result)
            : new TextEncoder().encode(generateGoalScreenCsv(result));
      await withRetry(
        async () => {
          await putReportPdf(
            env as { REPORTS_BUCKET?: R2Bucket },
            storage,
            key,
            goalScreenFileName(format, result),
            bytes,
            contentTypes[format]
          );
        },
        policy.retry.report,
        { label: `goal-screen-artifact:${format}` }
      );
      outcome[keyKey] = key;
      outcome[statusKey] = "generated";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome[statusKey] = "failed";
      outcome[errorKey] = hasOutcomeCodePrefix(message)
        ? message
        : codedMessage("FAILURE_REPORT_PDF_GENERATION", message);
      structuredLog.error("goal_screen.artifact_failed", {
        message: `[GoalScreenReports] ${format} artifact failed: ${outcome[errorKey]}`,
        format,
        error: outcome[errorKey],
      });
    }
  }
  return outcome;
}
