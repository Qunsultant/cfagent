/**
 * Issue #2911 (G4): the ONE generation path for stock report artifacts
 * (PDF + XLSX + CSV).
 *
 * Before this module, PDF went through the unified report pipeline
 * (#914/#680) inside ScreenerAgent.generateRunPdf, while XLSX and CSV
 * were generated inline in ScreenerAgent.persistRun and again (for shard
 * datasets) in the shard executor's tabular leg — three call sites, two
 * status languages, and a detail view with no CSV row at all. Every
 * stock artifact now flows through this module:
 *
 *  - PDF: the unified report pipeline (runReportPipeline), with exactly
 *    the inputs generateRunPdf used — the pipeline remains the only PDF
 *    path (#914, #1023 S4: no direct-generator fallback).
 *  - XLSX/CSV: the trading generators, retried under the R1 report
 *    policy, stored per-run plus the latest pointer, exactly as the
 *    agent legs did (#1278 R5, #2062).
 *
 * The module generates and stores the tabular legs (generate + blob
 * puts + latest pointer) and mutates the run record the way the agent
 * legs did: a successful leg sets key + "generated"; a failed leg sets
 * "failed" + a coded error and leaves no key, and never throws. The
 * PDF latest-pointer copy (fetch stored bytes, per-run + latest puts)
 * stays in ScreenerAgent.generateRunPdf, because it needs the agent's
 * ReportAssetAgent fallback — storage, not generation.
 *
 * A format the caller did not request records "never-attempted" (see
 * stockReportFormatStatus.ts), never "missing" or "failed". "skipped"
 * is not produced here: it is a policy outcome, not a generation
 * outcome, and only a recorded "skipped" passes through the resolver.
 *
 * Out of scope, explicitly: the options tabular legs in the shard
 * executor keep their own options generators — options is a separate
 * domain (#2621), not a second stock path.
 */

import type { ScreenerRunResult } from "../agents/screener-agent";
import { codedMessage } from "../outcomes/outcomeAspects";
import { resolvePipelinePolicy } from "./pipelinePolicy";
import { putReportPdf } from "./reportBlobStore";
import { withRetry } from "./resilience";
import {
  generateScreenerCsv,
  generateScreenerXlsx,
  resolveScreenerPdfSectionConfig,
  SCREENER_CSV_KEY_PREFIX,
  screenerCsvFileName,
  screenerXlsxFileName,
} from "../trading";
import { runReportPipeline } from "./unifiedReportPipeline";
import type { StockReportFormatStatus } from "./stockReportFormatStatus";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/stockReportArtifacts",
});

export type StockReportFormat = "pdf" | "xlsx" | "csv";

export interface StockReportArtifactOutcome {
  format: StockReportFormat;
  status: StockReportFormatStatus;
  key?: string;
  fileName?: string;
  error?: string;
}

export type StockReportArtifactsOutcome = Record<StockReportFormat, StockReportArtifactOutcome>;

/** The stock XLSX per-run key family (same family the agent leg used). */
export const STOCK_XLSX_KEY_PREFIX = "screener:xlsx:";
export const STOCK_XLSX_LATEST_KEY = "screener:latest.xlsx";
export const STOCK_CSV_LATEST_KEY = "screener:latest.csv";

export interface GenerateStockReportArtifactsInput {
  env: unknown;
  storage: any;
  result: ScreenerRunResult;
  userLogin: string;
  /** Formats to generate; default all three. Anything omitted is never-attempted. */
  formats?: StockReportFormat[];
  /** PDF section config; resolved from env (code defaults + overrides, #2088) when omitted. */
  pdfOptions?: { sections: unknown };
}

async function generatePdfLeg(
  input: GenerateStockReportArtifactsInput,
): Promise<StockReportArtifactOutcome> {
  const { env, storage, result, userLogin } = input;
  const pdfOptions = input.pdfOptions ?? {
    sections: resolveScreenerPdfSectionConfig(env as unknown as Record<string, string | undefined>),
  };
  const pipelineResult = await runReportPipeline(
    env as { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
    storage,
    {
      type: "screener",
      trigger: result.trigger === "manual" ? "manual" : "scheduled",
      result,
      userLogin,
      title: `Market screen — ${String((result as any).universe ?? (result as any).sector ?? "ALL")}`,
      summary: result.success
        ? `Scanned ${result.totalScanned} symbols, ${result.matchedCount} matched.`
        : `Screen failed: ${(result as any).error ?? "unknown error"}.`,
      timestamp: result.timestamp,
      pdfOptions: pdfOptions as never,
    },
  );
  if (pipelineResult.pdfStatus === "generated") {
    result.pdfKey = pipelineResult.pdfKey;
    result.pdfStatus = "generated";
    // A regenerated run must not keep its previous failure on record.
    delete (result as any).pdfError;
    return { format: "pdf", status: "generated", key: pipelineResult.pdfKey };
  }
  // Issue #1023 (S4): NO direct-generator fallback — the unified
  // pipeline is the only PDF path (#914/#680). Issue #822: do NOT
  // swallow. Record the failure explicitly so the publisher knows
  // not to fall back to a stale PDF.
  result.pdfStatus = "failed";
  result.pdfError = pipelineResult.pdfError;
  structuredLog.error("stock_report.pdf_generation_failed", {
    message: "[stockReportArtifacts] PDF generation failed",
    error: result.pdfError,
  });
  return { format: "pdf", status: "failed", error: pipelineResult.pdfError };
}

async function generateXlsxLeg(
  input: GenerateStockReportArtifactsInput,
): Promise<StockReportArtifactOutcome> {
  const { env, storage, result } = input;
  // Issue #1278 (#1173 R5): generate+store retries under the R1 report
  // policy — a transient blob-store failure no longer fails the XLSX.
  const reportRetry = resolvePipelinePolicy(env as unknown as Record<string, unknown>).retry.report;
  const xlsxKey = `${STOCK_XLSX_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
  try {
    let fileName = "";
    await withRetry(async () => {
      const xlsxBytes = generateScreenerXlsx(result);
      fileName = screenerXlsxFileName(result);
      await putReportPdf(env as Parameters<typeof putReportPdf>[0], storage, xlsxKey, fileName, xlsxBytes);
      await putReportPdf(env as Parameters<typeof putReportPdf>[0], storage, STOCK_XLSX_LATEST_KEY, fileName, xlsxBytes);
      result.xlsxKey = xlsxKey;
      result.xlsxStatus = "generated";
    }, reportRetry, { label: "screener-xlsx" });
    return { format: "xlsx", status: "generated", key: xlsxKey, fileName };
  } catch (xlsxErr) {
    result.xlsxStatus = "failed";
    result.xlsxError = codedMessage(
      "FAILURE_REPORT_XLSX_GENERATION",
      xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr),
    );
    structuredLog.error("stock_report.xlsx_generation_failed", {
      message: "[stockReportArtifacts] XLSX generation failed",
      error: result.xlsxError,
    });
    return { format: "xlsx", status: "failed", error: result.xlsxError };
  }
}

async function generateCsvLeg(
  input: GenerateStockReportArtifactsInput,
): Promise<StockReportArtifactOutcome> {
  const { env, storage, result } = input;
  // Issue #2062: every stock run records its full document set. Same
  // contract as the XLSX leg: retried under the R1 report policy, and
  // a real failure is recorded on the run instead of failing the screen.
  const reportRetry = resolvePipelinePolicy(env as unknown as Record<string, unknown>).retry.report;
  const csvKey = `${SCREENER_CSV_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
  try {
    let fileName = "";
    await withRetry(async () => {
      const csvBytes = new TextEncoder().encode(generateScreenerCsv(result));
      fileName = screenerCsvFileName(result);
      await putReportPdf(env as Parameters<typeof putReportPdf>[0], storage, csvKey, fileName, csvBytes, "text/csv");
      await putReportPdf(env as Parameters<typeof putReportPdf>[0], storage, STOCK_CSV_LATEST_KEY, fileName, csvBytes, "text/csv");
      result.csvKey = csvKey;
      result.csvStatus = "generated";
    }, reportRetry, { label: "screener-csv" });
    return { format: "csv", status: "generated", key: csvKey, fileName };
  } catch (csvErr) {
    result.csvStatus = "failed";
    result.csvError = codedMessage(
      "FAILURE_REPORT_CSV_GENERATION",
      csvErr instanceof Error ? csvErr.message : String(csvErr),
    );
    structuredLog.error("stock_report.csv_generation_failed", {
      message: "[stockReportArtifacts] CSV generation failed",
      error: result.csvError,
    });
    return { format: "csv", status: "failed", error: result.csvError };
  }
}

export async function generateStockReportArtifacts(
  input: GenerateStockReportArtifactsInput,
): Promise<StockReportArtifactsOutcome> {
  const requested = new Set(input.formats ?? (["pdf", "xlsx", "csv"] as StockReportFormat[]));
  const pdf = requested.has("pdf")
    ? await generatePdfLeg(input)
    : { format: "pdf" as const, status: "never-attempted" as const };
  const xlsx = requested.has("xlsx")
    ? await generateXlsxLeg(input)
    : { format: "xlsx" as const, status: "never-attempted" as const };
  const csv = requested.has("csv")
    ? await generateCsvLeg(input)
    : { format: "csv" as const, status: "never-attempted" as const };
  return { pdf, xlsx, csv };
}

/**
 * The shard executor's stock tabular leg, through this module: given a
 * shard dataset, produce the workbook/CSV bytes and file name. The
 * caller keeps its own retry policy and blob puts (the shard store leg
 * owns the key), so this helper is pure generation — it throws on
 * failure, and the stock chain keeps its existing throw.
 */
export function generateStockTabularBytes(
  format: "xlsx" | "csv",
  dataset: ScreenerRunResult,
): { fileName: string; bytes: Uint8Array } {
  if (format === "xlsx") {
    return { fileName: screenerXlsxFileName(dataset), bytes: generateScreenerXlsx(dataset) };
  }
  return {
    fileName: screenerCsvFileName(dataset),
    bytes: new TextEncoder().encode(generateScreenerCsv(dataset)),
  };
}
