/**
 * Discovery-run artifact publish (#2180).
 *
 * One seam for a discovery run's documents, mirroring every other report
 * path: generate PDF, XLSX and CSV from the run's recorded outcomes, store
 * each under `discovery:<format>:<runId>` (deterministic, so a re-delivery
 * overwrites rather than accumulating), and report a per-format status.
 *
 * A failed format is recorded and never throws — the run itself already
 * happened, and its record must land either way.
 */

import {
  discoveryReportFileName,
  generateDiscoveryReportCsv,
  generateDiscoveryReportPdf,
  generateDiscoveryReportXlsx,
  type DiscoveryReportArtifactOutcome,
  type DiscoveryReportInput,
} from "../trading";
import { codedMessage } from "../outcomes/outcomeAspects";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/discoveryReportPublish",
});

export interface DiscoveryReportStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function reportId(input: DiscoveryReportInput): string {
  const id = String(input?.runId ?? "").replace(/[^a-zA-Z0-9-]/g, "");
  return id || crypto.randomUUID().slice(0, 8);
}

export async function generateAndStoreDiscoveryReport(args: {
  env: { REPORTS_BUCKET?: unknown } | Record<string, unknown>;
  storage: DiscoveryReportStorage | undefined;
  input: DiscoveryReportInput;
}): Promise<DiscoveryReportArtifactOutcome> {
  const outcome: DiscoveryReportArtifactOutcome = {
    pdfStatus: "failed",
    xlsxStatus: "failed",
    csvStatus: "failed",
  };
  if (!args.storage) {
    const message = "blob storage is not configured for this discovery run";
    return {
      ...outcome,
      pdfError: message,
      xlsxError: codedMessage("FAILURE_REPORT_XLSX_GENERATION", message),
      csvError: codedMessage("FAILURE_REPORT_CSV_GENERATION", message),
    };
  }
  const { withRetry } = await import("./resilience");
  const { resolvePipelinePolicy } = await import("./pipelinePolicy");
  const { putReportPdf } = await import("./reportBlobStore");
  const policy = resolvePipelinePolicy(args.env as Record<string, unknown>).retry.report;
  const id = reportId(args.input);

  try {
    const key = `discovery:pdf:${id}`;
    const bytes = await generateDiscoveryReportPdf(args.input);
    await withRetry(
      () => putReportPdf(args.env as any, args.storage as any, key, discoveryReportFileName(args.input, "pdf"), bytes),
      policy,
      { label: "discovery-pdf" },
    );
    outcome.pdfKey = key;
    outcome.pdfStatus = "generated";
  } catch (err) {
    outcome.pdfError = err instanceof Error ? err.message : String(err);
    structuredLog.error("generateAndStoreDiscoveryReport.pdf_generation_failed", {
      message: "[DiscoveryReport] PDF generation failed",
      error: outcome.pdfError,
    });
  }

  try {
    const key = `discovery:xlsx:${id}`;
    const bytes = generateDiscoveryReportXlsx(args.input);
    await withRetry(
      () =>
        putReportPdf(
          args.env as any,
          args.storage as any,
          key,
          discoveryReportFileName(args.input, "xlsx"),
          bytes,
          XLSX_MIME,
        ),
      policy,
      { label: "discovery-xlsx" },
    );
    outcome.xlsxKey = key;
    outcome.xlsxStatus = "generated";
  } catch (err) {
    outcome.xlsxError = codedMessage("FAILURE_REPORT_XLSX_GENERATION", err instanceof Error ? err.message : String(err));
    structuredLog.error("generateAndStoreDiscoveryReport.xlsx_generation_failed", {
      message: "[DiscoveryReport] XLSX generation failed",
      error: outcome.xlsxError,
    });
  }

  try {
    const key = `discovery:csv:${id}`;
    const bytes = new TextEncoder().encode(generateDiscoveryReportCsv(args.input));
    await withRetry(
      () =>
        putReportPdf(args.env as any, args.storage as any, key, discoveryReportFileName(args.input, "csv"), bytes, "text/csv"),
      policy,
      { label: "discovery-csv" },
    );
    outcome.csvKey = key;
    outcome.csvStatus = "generated";
  } catch (err) {
    outcome.csvError = codedMessage("FAILURE_REPORT_CSV_GENERATION", err instanceof Error ? err.message : String(err));
    structuredLog.error("generateAndStoreDiscoveryReport.csv_generation_failed", {
      message: "[DiscoveryReport] CSV generation failed",
      error: outcome.csvError,
    });
  }

  return outcome;
}

/**
 * The canonical discovery body: the run's identity fields plus the artifact
 * keys/statuses/errors. Undefined values are dropped so an absent key never
 * masquerades as a recorded one.
 */
export function buildDiscoveryCanonicalBody(
  base: Record<string, unknown>,
  artifacts: DiscoveryReportArtifactOutcome,
): Record<string, unknown> {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(artifacts).filter(([, value]) => value !== undefined)),
  };
}
