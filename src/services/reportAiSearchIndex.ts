/**
 * Issue #2246 — report indexing into the Cloudflare AI Search
 * instance, riding beside S4-1's Vectorize hook.
 *
 * At the canonical-report store seams (src/services/
 * scheduledReports.ts, the same points that call
 * indexCanonicalReport), when AI_SEARCH_REPORT_INDEXING_ENABLED is
 * ON, each stored report is ALSO uploaded to the AI Search
 * instance through AiSearchAgent's indexing executor
 * (runAiSearchIndexUpload in src/agents/aiSearchPaths.ts), so the
 * agent can retrieve report content with run/login provenance.
 * Flag OFF (the default) = today's behaviour exactly: this hook is
 * a silent no-op and the Vectorize leg is the only index.
 *
 * Contract (mirroring #1133's never-throws capture discipline and
 * S4-1's hook):
 * - Best-effort, ALWAYS: any failure is recorded (console.warn with
 *   the stable event code `ai_search_report_index_failed` plus the
 *   executor's stable outcome code — id and code only, never report
 *   content, never credentials) and NEVER fails the report store
 *   or the run. This function never throws.
 * - The document id is `report:<reportId>` (the prefix constant
 *   lives in aiSearchPaths.ts) — the same document-id convention
 *   the Vectorize leg uses, and the key the search-side login
 *   discipline identifies report-type results by.
 * - Metadata carries the provenance the retrieval discipline
 *   needs: kind "report", reportId, runId, ownerLogin, the
 *   report's source, and storedAt — each set only when the store
 *   seam genuinely has it (fresh stores have all of them; the
 *   redelivery seam's row lookup does not select created_at, so
 *   redeliveries omit storedAt rather than fabricating one).
 * - The uploaded content is the report title plus
 *   buildCanonicalIndexText's output — the same searchable text
 *   the Vectorize leg embeds, so both indexes describe the same
 *   report the same way. R2 bodies resolve best-effort exactly as
 *   in indexCanonicalReport.
 * - Retention rows are excluded (mirrors INDEX_EXCLUDED_SOURCES:
 *   storage-pruning notices are not reports).
 * - NO backfill: the S4-4 backfill path calls indexCanonicalReport
 *   only, never this hook — historical reports are not silently
 *   migrated into the instance.
 */

import {
  buildCanonicalIndexText,
  INDEX_EXCLUDED_SOURCES,
  type CanonicalReportForIndex,
} from "./reportSemanticIndex";
import {
  AI_SEARCH_REPORT_DOCUMENT_PREFIX,
  isAiSearchReportIndexingEnabled,
  runAiSearchIndexUpload,
  type AiSearchIndexOutcome,
} from "../agents/aiSearchPaths";
import { AgentErrorCode } from "../aspects/errorCodes";
import { createBlobStore } from "./blobStoreR2Adapter";
import { blobText } from "./blobStorePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/reportAiSearchIndex",
});

/** Stable log event code for a failed/degraded instance indexing leg. */
export const AI_SEARCH_REPORT_INDEX_FAILED = "ai_search_report_index_failed";

/** The env subset the hook reads (flag + namespace door + R2 seam). */
export interface ReportAiSearchIndexEnv {
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
  AI_SEARCH_REPORT_INDEXING_ENABLED?: string;
  REPORTS_BUCKET?: any;
}

/** One canonical report for the instance leg: S4-1's shape + provenance. */
export interface CanonicalReportForAiSearchIndex extends CanonicalReportForIndex {
  /** The run that produced the report, when the seam has it. */
  runId?: string;
  /** The report owner's login (the store seam's tenant owner). */
  ownerLogin?: string;
  /** The row's stored-at timestamp, when the seam has it. */
  storedAt?: string;
}

/**
 * The hook's outcome: the executor's outcome when the leg ran, or
 * a `disabled` outcome when it did not (flag off, no report id, or
 * an excluded source) — disabled is a silent no-op at the call
 * site, recorded nowhere, exactly like S4-1's absent-bindings case.
 */
export type ReportAiSearchIndexOutcome =
  | AiSearchIndexOutcome
  | { ok: false; code: "disabled"; correlationId: string };

/**
 * Index one canonical report into the AI Search instance.
 * Fire-and-forget at the seams (`void`), never throws, and inert
 * unless AI_SEARCH_REPORT_INDEXING_ENABLED is on.
 */
export async function indexCanonicalReportInAiSearch(
  env: ReportAiSearchIndexEnv | undefined,
  report: CanonicalReportForAiSearchIndex,
): Promise<ReportAiSearchIndexOutcome> {
  const correlationId = crypto.randomUUID();
  try {
    if (!env || !isAiSearchReportIndexingEnabled(env)) {
      return { ok: false, code: "disabled", correlationId };
    }
    if (!report.reportId) return { ok: false, code: "disabled", correlationId };
    if ((INDEX_EXCLUDED_SOURCES as readonly string[]).includes(report.source)) {
      return { ok: false, code: "disabled", correlationId };
    }
    let body = report.body;
    const store = createBlobStore(env);
    if (!body && report.bodyR2Key && store) {
      try {
        const obj = await store.get(report.bodyR2Key);
        const text = obj ? blobText(obj) : undefined;
        if (typeof text === "string" && text.length > 0) body = text;
      } catch {
        // R2 resolution is best-effort; fall back to summary + title.
      }
    }
    const text = buildCanonicalIndexText({
      source: report.source,
      summary: report.summary,
      title: report.title,
      body,
    });
    const metadata: Record<string, unknown> = {
      kind: "report",
      reportId: report.reportId,
      source: report.source,
      ...(report.runId ? { runId: report.runId } : {}),
      ...(report.ownerLogin ? { ownerLogin: report.ownerLogin } : {}),
      ...(report.storedAt ? { storedAt: report.storedAt } : {}),
    };
    const outcome = await runAiSearchIndexUpload(env, {
      id: `${AI_SEARCH_REPORT_DOCUMENT_PREFIX}${report.reportId}`,
      content: `${report.title}\n${text}`,
      metadata,
    });
    if (!outcome.ok) {
      structuredLog.warn("report_ai_search.index_failed", {
        message: `[reportAiSearchIndex] ${AI_SEARCH_REPORT_INDEX_FAILED} reportId=${report.reportId} code=${outcome.code}: ${outcome.error ?? ""}`,
        reportId: report.reportId,
        code: outcome.code,
        error: outcome.error ?? "",
      });
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    structuredLog.warn("report_ai_search.index_failed", {
      message: `[reportAiSearchIndex] ${AI_SEARCH_REPORT_INDEX_FAILED} reportId=${report?.reportId ?? "?"} code=upload_failed: ${message}`,
      reportId: report?.reportId ?? "?",
      code: "upload_failed",
      error: message,
    });
    return {
      ok: false,
      code: "upload_failed",
      errorToken: AgentErrorCode.TOOL_EXECUTION_FAILED,
      correlationId,
      error: message,
    };
  }
}
