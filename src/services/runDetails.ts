/**
 * Run Details (issue #2534): the ONE traceability model behind the
 * Docs & Reports "Run Details" modal — and the same model Autopilot
 * must read for the same run (GET /api/runs rows, never a second
 * divergent copy; Autopilot parity itself is a named remaining step).
 *
 * This module is a READ view only: it mints no run, records nothing,
 * and never rewrites a run record. It builds a detail from a merged
 * RunSummary plus the canonical body (when one exists), and it is
 * deliberately honest about absence: a field no store recorded is
 * `unknown` with the store named, never guessed from a run-id prefix,
 * a timestamp, or a trigger guess. Job type is never inferred from
 * the run id or the source label — it is the recorded `jobType`
 * field, or `unknown`.
 *
 * Messages are externalized with codes (AOP): every user-facing
 * reason/error string in a Run Details view comes from
 * RUN_DETAIL_MESSAGE_CATALOG via resolveRunDetailMessage — the
 * single message aspect. Components, routes, agents, and renderers
 * must not hardcode Run Details wording; changing wording is a
 * catalog change, never a code change. Codes are stable and the
 * catalog is versioned (RUN_DETAIL_MESSAGE_CATALOG_VERSION).
 */

import type { RunSummary } from "./runSummaries";

export const RUN_DETAIL_MESSAGE_CATALOG_VERSION = "1";

export type RunDetailLevel = "info" | "debugging" | "error";

export interface RunDetailMessageDef {
  /** Stable code, rendered verbatim in the modal (debugging level). */
  code: string;
  severity: "info" | "warning" | "error";
  level: RunDetailLevel;
  /** Template with {param} placeholders filled from the run's evidence. */
  template: string;
  action: string;
  params: string[];
}

export type RunDetailMessageCatalog = Record<string, RunDetailMessageDef>;

export const RUN_DETAIL_MESSAGE_CATALOG: RunDetailMessageCatalog = {
  RUN_NO_ARTIFACT_RECORDED: {
    code: "RUN_NO_ARTIFACT_RECORDED",
    severity: "warning",
    level: "error",
    template:
      "No {format} artifact was recorded for this run. The run record carries no {format} key, so Docs cannot link a file that was never recorded — this does not by itself prove the file was never generated.",
    action: "Re-run the screen, or use a regenerate path for this run once one exists for its family.",
    params: ["format"],
  },
  RUN_PDF_FAILED: {
    code: "RUN_PDF_FAILED",
    severity: "error",
    level: "error",
    template: "PDF generation failed for this run{error}. The PDF leg failed while the other legs were attempted independently.",
    action: "Re-run the screen, or regenerate the PDF for this run once a regenerate path exists for its family.",
    params: ["error"],
  },
  RUN_XLSX_FAILED: {
    code: "RUN_XLSX_FAILED",
    severity: "error",
    level: "error",
    template: "XLSX generation failed for this run{error}. The XLSX leg failed while the other legs were attempted independently.",
    action: "Re-run the screen, or regenerate the XLSX for this run once a regenerate path exists for its family.",
    params: ["error"],
  },
  RUN_CSV_FAILED: {
    code: "RUN_CSV_FAILED",
    severity: "error",
    level: "error",
    template: "CSV generation failed for this run{error}. The CSV leg failed while the other legs were attempted independently.",
    action: "Re-run the screen, or regenerate the CSV for this run once a regenerate path exists for its family.",
    params: ["error"],
  },
  RUN_EMPTY_RESULT: {
    code: "RUN_EMPTY_RESULT",
    severity: "warning",
    level: "error",
    template:
      "This run completed with no results: the analysis ran, but nothing passed its gates, so there was no result set to report on.",
    action: "Widen the filters (universe, DTE window, or fit gates) and re-run, or inspect the stage trace for which gate excluded everything.",
    params: [],
  },
  RUN_PARTIAL_COVERAGE: {
    code: "RUN_PARTIAL_COVERAGE",
    severity: "warning",
    level: "info",
    template:
      "This run has partial coverage: it evaluated only part of the requested universe. The result set covers the evaluated subset, not the full request.",
    action: "Check the stage trace for the failed or truncated underlyings, then re-run for the missing subset.",
    params: [],
  },
  RUN_CAPTURE_MISSING: {
    code: "RUN_CAPTURE_MISSING",
    severity: "error",
    level: "error",
    template:
      "No stored data capture was recorded for this run{capture}. Analysis reads stored captures only; without one, the analysis stage cannot be evidenced.",
    action: "Re-run the screen so feed/gather captures are recorded before analysis.",
    params: ["capture"],
  },
  RUN_CONNECTOR_UNAVAILABLE: {
    code: "RUN_CONNECTOR_UNAVAILABLE",
    severity: "error",
    level: "error",
    template:
      "A connector was unavailable for enriching data during this run{connector}. The stage that needed it could not complete its enrichment.",
    action: "Check the connector's availability and re-run; the stage trace names the connector and capability.",
    params: ["connector"],
  },
  RUN_PROVIDER_FETCH_FAILED: {
    code: "RUN_PROVIDER_FETCH_FAILED",
    severity: "error",
    level: "error",
    template: "A provider data fetch failed during this run{provider}. The stage that needed that data could not complete.",
    action: "Check the provider's availability and re-run; the stage trace names the provider.",
    params: ["provider"],
  },
  RUN_FIT_GATE_ALL_REJECTED: {
    code: "RUN_FIT_GATE_ALL_REJECTED",
    severity: "warning",
    level: "error",
    template:
      "The fit gate rejected every candidate for this run: candidates were evaluated, but none met the composite score, probability-of-profit, freshness, or confidence thresholds in force.",
    action: "Loosen the fit gates or widen the universe/DTE window and re-run.",
    params: [],
  },
  RUN_DTE_EXCLUDED_ALL: {
    code: "RUN_DTE_EXCLUDED_ALL",
    severity: "warning",
    level: "error",
    template:
      "The DTE window excluded every contract for this run: no contract in the fetched chain fell inside the requested days-to-expiry window.",
    action: "Widen the DTE window and re-run.",
    params: [],
  },
  RUN_DUPLICATE_SUPPRESSED: {
    code: "RUN_DUPLICATE_SUPPRESSED",
    severity: "info",
    level: "info",
    template:
      "This run was suppressed as a duplicate: an equivalent run for the same slot was already recorded, so this attempt recorded no new artifacts.",
    action: "Find the original run for the same slot; do not re-run for the same slot.",
    params: [],
  },
  RUN_SERVICE_USER_NOT_PROVISIONED: {
    code: "RUN_SERVICE_USER_NOT_PROVISIONED",
    severity: "error",
    level: "error",
    template:
      "The service user was not provisioned for this platform tier, so the scheduled tick that would have run this job was skipped before any stage ran.",
    action: "Provision the service user for the platform tier, then trigger the run again.",
    params: [],
  },
  RUN_QUEUE_DROPPED: {
    code: "RUN_QUEUE_DROPPED",
    severity: "error",
    level: "error",
    template:
      "A queue message for this run was dropped without retry: the queue path that would have delivered it has no consumer, or the message was refused under its owner identity.",
    action: "Trigger the run directly (Trigger-Now) and check the queue consumer wiring.",
    params: [],
  },
  RUN_BRIDGE_SERVE_SKIPPED: {
    code: "RUN_BRIDGE_SERVE_SKIPPED",
    severity: "error",
    level: "error",
    template:
      "The async-job bridge serve stage was skipped for this run because no PDF key was available (or the PDF leg had failed), so no serve record was written and no delivery was planned.",
    action: "Fix the PDF leg first, then re-run; serve cannot deliver a report with no PDF key.",
    params: [],
  },
  RUN_STAGE_FAILED: {
    code: "RUN_STAGE_FAILED",
    severity: "error",
    level: "error",
    template: "The {stage} stage failed for this run{error}. Later stages were not planned after this failure.",
    action: "Check the stage trace for the failing stage's error, then resume from the last completed stage or re-run.",
    params: ["stage", "error"],
  },
  RUN_NEVER_ATTEMPTED: {
    code: "RUN_NEVER_ATTEMPTED",
    severity: "info",
    level: "info",
    template:
      "The {format} leg was never attempted for this run: it is not part of this run type's path, so its absence is by construction, not a failure.",
    action: "No action: this run type does not produce this format.",
    params: ["format"],
  },
  RUN_LEGACY_UNKNOWN: {
    code: "RUN_LEGACY_UNKNOWN",
    severity: "info",
    level: "info",
    template:
      "This field predates provenance/lineage recording for this run's store ({store}), so its value is unknown — it was not recorded, and it is not guessed here.",
    action: "No action: newer runs for the same family record this field.",
    params: ["store"],
  },
};

export interface ResolvedRunDetailMessage {
  code: string;
  text: string;
  severity: "info" | "warning" | "error";
  level: RunDetailLevel;
  action: string;
}

/** The single message aspect: every Run Details string resolves here. */
export function resolveRunDetailMessage(
  code: string,
  params: Record<string, string> = {},
  catalog: RunDetailMessageCatalog = RUN_DETAIL_MESSAGE_CATALOG,
): ResolvedRunDetailMessage {
  const def = catalog[code];
  if (!def) {
    return {
      code,
      text: `Reason code ${code} has no catalog entry in message catalog version ${RUN_DETAIL_MESSAGE_CATALOG_VERSION}.`,
      severity: "info",
      level: "info",
      action: "No action recorded for this code.",
    };
  }
  let text = def.template;
  for (const [key, value] of Object.entries(params)) {
    text = text.replaceAll(`{${key}}`, value);
  }
  // Unfilled optional evidence slots render as an empty string, never
  // as a raw "{param}" placeholder in the modal.
  text = text.replace(/\{[a-zA-Z]+\}/g, "");
  return { code: def.code, text, severity: def.severity, level: def.level, action: def.action };
}

export type RunDetailStageStatus =
  | "completed"
  | "failed"
  | "skipped"
  | "never-attempted"
  | "unknown";

export interface RunDetailStage {
  stage: "feed" | "gather" | "analysis" | "generation" | "recording" | "delivery";
  status: RunDetailStageStatus;
  /** Recorded duration in milliseconds, when the store records one. */
  durationMs: number | null;
  inputIds: string[];
  outputIds: string[];
  errorCode: string | null;
  error: string | null;
  /** Stage evidence as recorded (capture ids, provider, gate counts). */
  evidence: Record<string, string | number | null>;
}

export interface RunDetailField {
  field: string;
  value: string | null;
  /** "recorded" | "unknown" — never "inferred". */
  source: "recorded" | "unknown";
  store: string | null;
}

export interface RunDetailReason extends ResolvedRunDetailMessage {
  format: "PDF" | "XLSX" | "CSV" | "result" | null;
  stage: RunDetailStage["stage"] | null;
  evidence: Record<string, string | number | null>;
}

export interface RunDetailProvenance {
  executionMode: string | null;
  syncAsync: string | null;
  interface: string | null;
  parallelism: string | null;
  parallelCount: number | null;
  parallelCap: number | null;
  submittedVia: string | null;
  deliveredVia: string | null;
  trigger: string | null;
  scheduleId: string | null;
  goalId: string | null;
  asyncJobId: string | null;
  jobType: string | null;
  strategyMode: string | null;
  workflowId: string | null;
  workflowName: string | null;
  workflowVersion: string | null;
  workflowType: string | null;
}

export interface RunDetail {
  catalogVersion: string;
  id: string;
  runId: string;
  kind: string;
  source: string;
  title: string;
  createdAt: string;
  status: string | null;
  resultCount: number | null;
  /** Exact input as submitted, where recorded; unknown fields are listed, not guessed. */
  request: RunDetailField[];
  /** Defaults the run records as applied, with their source; empty when none recorded. */
  defaultsApplied: RunDetailField[];
  provenance: RunDetailProvenance;
  lineage: {
    inputHash: string | null;
    captureIds: string[];
    captures: RunDetailField[];
    engineVersion: string | null;
    catalogueVersion: string | null;
    rendererVersions: Record<string, string | null>;
    store: string;
  };
  stages: RunDetailStage[];
  formats: Array<{
    format: "PDF" | "XLSX" | "CSV";
    status: string | null;
    url: string | null;
    key: string | null;
    error: string | null;
  }>;
  reasons: RunDetailReason[];
  /** Store that produced this detail, so "unknown" can name it. */
  store: string;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseBody(body: unknown): Record<string, any> {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body || "{}") : body;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function bodyField(body: Record<string, any>, ...paths: string[]): unknown {
  for (const path of paths) {
    const parts = path.split(".");
    let cur: any = body;
    for (const part of parts) {
      cur = cur?.[part];
      if (cur === undefined) break;
    }
    if (cur !== undefined) return cur;
  }
  return undefined;
}

function stringifyValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v || null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function field(body: Record<string, any>, name: string, store: string, ...paths: string[]): RunDetailField {
  const v = bodyField(body, ...paths);
  const value = stringifyValue(v);
  return value === null
    ? { field: name, value: null, source: "unknown", store }
    : { field: name, value, source: "recorded", store: null };
}

function errorSuffix(error: string | null): string {
  return error ? `: ${error}` : "";
}

function classifyRecordedError(error: string | null): string | null {
  if (!error) return null;
  const lower = error.toLowerCase();
  if (lower.includes("connector") || lower.includes("enrich")) return "RUN_CONNECTOR_UNAVAILABLE";
  if (lower.includes("provider") || lower.includes("fetch") || lower.includes("etrade"))
    return "RUN_PROVIDER_FETCH_FAILED";
  if (lower.includes("service user") || lower.includes("not provisioned"))
    return "RUN_SERVICE_USER_NOT_PROVISIONED";
  if (lower.includes("queue") || lower.includes("dropped")) return "RUN_QUEUE_DROPPED";
  if (lower.includes("duplicate")) return "RUN_DUPLICATE_SUPPRESSED";
  return null;
}

export interface BuildRunDetailOptions {
  catalog?: RunDetailMessageCatalog;
  store?: string;
}

/**
 * Builds a Run Details view from a merged RunSummary plus its
 * canonical body (when one exists). Pure and synchronous: no I/O,
 * no new run, no record. A body field that is absent is `unknown`;
 * a stage with no evidence is `unknown` — except the discovery
 * generation leg, which is `never-attempted` by construction
 * (discovery-store rows are structurally linkless), and formats
 * whose leg is not part of a run type's path.
 */
export function buildRunDetail(
  summary: Pick<
    RunSummary,
    | "id"
    | "runId"
    | "kind"
    | "source"
    | "title"
    | "trigger"
    | "createdAt"
    | "status"
    | "resultCount"
    | "pdfKey"
    | "reportUrl"
    | "xlsxKey"
    | "xlsxUrl"
    | "csvKey"
    | "csvUrl"
    | "pdfStatus"
    | "pdfError"
    | "xlsxStatus"
    | "xlsxError"
    | "csvStatus"
    | "csvError"
    | "reportId"
    | "scanRunId"
    | "discoveryRunId"
    | "partial"
  > & { body?: unknown },
  options: BuildRunDetailOptions = {},
): RunDetail {
  const catalog = options.catalog ?? RUN_DETAIL_MESSAGE_CATALOG;
  const store = options.store ?? (summary.reportId ? "mas_reports" : summary.kind === "options_scanner" ? "mas_opportunity_scans" : summary.kind === "discovery" ? "mas_discovery_runs" : "screener-feed");
  const body = parseBody((summary as { body?: unknown }).body);
  const nested = (parseBody(body?.report?.result) as Record<string, any>) ?? {};
  const mergedBody = { ...body, ...nested };

  const provenanceBody = (body?.provenance ?? {}) as Record<string, any>;
  const workflowBody = (body?.workflow ?? {}) as Record<string, any>;
  const parallelism = provenanceBody.parallelism ?? body?.parallelism ?? null;
  const parallelCount = numOrNull(provenanceBody.parallelCount ?? body?.parallelCount);
  const parallelCap = numOrNull(provenanceBody.parallelCap ?? body?.parallelCap);

  const requestNames: Array<[string, string[]]> = [
    ["symbols", ["input.symbols", "symbols", "request.symbols"]],
    ["universe", ["input.universe", "universe"]],
    ["thesis", ["input.thesis", "thesis"]],
    ["strategyMode", ["strategyMode", "input.strategyMode"]],
    ["targetDate", ["input.targetDate", "targetDate", "target"]],
    ["riskProfile", ["input.riskProfile", "riskProfile"]],
    ["allowedStrategies", ["input.allowedStrategies", "allowedStrategies"]],
    ["targetPrice", ["input.targetPrice", "targetPrice"]],
    ["dteMin", ["input.dte.min", "input.dteMin", "dteMin"]],
    ["dteMax", ["input.dte.max", "input.dteMax", "dteMax"]],
    ["sector", ["input.sector", "sector"]],
    ["contractType", ["input.contractType", "contractType"]],
  ];
  const request = requestNames.map(([name, paths]) => field(mergedBody, name, store, ...paths));

  const defaultsRaw = body?.defaultsApplied ?? body?.defaults ?? null;
  const defaultsApplied: RunDetailField[] = Array.isArray(defaultsRaw)
    ? defaultsRaw.map((d: any) => ({
        field: String(d?.field ?? "unknown"),
        value: stringifyValue(d?.value),
        source: "recorded" as const,
        store: null,
      }))
    : [];

  const captureIds: string[] = [];
  const rawCaptureIds = body?.captureIds ?? body?.captures ?? null;
  if (Array.isArray(rawCaptureIds)) {
    for (const c of rawCaptureIds) {
      const id = typeof c === "string" ? c : strOrNull((c as any)?.id);
      if (id) captureIds.push(id);
    }
  }
  if (summary.scanRunId) captureIds.unshift(summary.scanRunId);
  if (summary.discoveryRunId) captureIds.unshift(summary.discoveryRunId);

  const captures: RunDetailField[] = [
    field(mergedBody, "provider", store, "provider", "input.provider", "capture.provider", "feed.connector"),
    field(mergedBody, "connector", store, "connector", "input.connector", "capture.connector", "feed.connector"),
    field(mergedBody, "connectorVersion", store, "connectorVersion", "capture.connectorVersion"),
    field(mergedBody, "snapshotId", store, "snapshotId", "capture.snapshotId", "snapshot.id"),
    field(mergedBody, "freshness", store, "freshness", "capture.freshness", "quoteAge"),
  ];

  const anyGenerated =
    summary.pdfStatus === "generated" || summary.xlsxStatus === "generated" || summary.csvStatus === "generated" ||
    Boolean(summary.pdfKey || summary.xlsxKey || summary.csvKey);
  const anyFailed =
    summary.pdfStatus === "failed" || summary.xlsxStatus === "failed" || summary.csvStatus === "failed";
  const isDiscovery = summary.kind === "discovery";
  const analysisStatus: RunDetailStageStatus =
    summary.status === "failed"
      ? "failed"
      : summary.resultCount !== null || summary.status === "completed"
        ? "completed"
        : "unknown";
  const generationStatus: RunDetailStageStatus = isDiscovery
    ? "never-attempted"
    : anyGenerated
      ? "completed"
      : anyFailed
        ? "failed"
        : "unknown";

  // Unified strategy runs store their stage trace in the canonical
  // body (body.stages, written by recordStrategyScreenRun). When
  // present and well-formed, it IS the stage trace — the synthetic
  // derivation below must not overwrite it, or Docs and Workflow
  // Runs would diverge again. Legacy bodies without stored stages
  // keep the synthetic derivation unchanged.
  const storedStagesRaw = Array.isArray(body?.stages) ? (body.stages as unknown[]) : [];
  const storedStages: RunDetailStage[] = storedStagesRaw
    .map((s): RunDetailStage | null => {
      const o = s && typeof s === "object" ? (s as Record<string, unknown>) : null;
      if (!o) return null;
      const stageName = typeof o.stage === "string" ? o.stage : "";
      if (!["feed", "gather", "analysis", "generation", "recording", "delivery"].includes(stageName)) return null;
      const status = typeof o.status === "string" ? o.status : "";
      if (!["completed", "failed", "skipped", "never-attempted", "unknown"].includes(status)) return null;
      const evidence = o.evidence && typeof o.evidence === "object" && !Array.isArray(o.evidence)
        ? { ...(o.evidence as Record<string, string | number | null>), ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}) }
        : (typeof o.reason === "string" && o.reason ? { reason: o.reason } : {});
      return {
        stage: stageName as RunDetailStage["stage"],
        status: status as RunDetailStageStatus,
        durationMs: numOrNull(o.durationMs),
        inputIds: Array.isArray(o.inputIds) ? o.inputIds.filter((x): x is string => typeof x === "string") : [],
        outputIds: Array.isArray(o.outputIds) ? o.outputIds.filter((x): x is string => typeof x === "string") : [],
        errorCode: strOrNull(o.errorCode),
        error: strOrNull(o.error),
        evidence,
      };
    })
    .filter((s): s is RunDetailStage => s !== null);
  const hasStoredStages = storedStages.length > 0;
  const stages: RunDetailStage[] = hasStoredStages
    ? [
        ...storedStages,
        ...(storedStages.some((s) => s.stage === "recording")
          ? []
          : [{
              stage: "recording" as const,
              status: "completed" as const,
              durationMs: null,
              inputIds: [summary.pdfKey, summary.xlsxKey, summary.csvKey].filter((k): k is string => Boolean(k)),
              outputIds: [summary.id],
              errorCode: null,
              error: null,
              evidence: { store, reportId: summary.reportId ?? null },
            }]),
      ]
    : [
    {
      stage: "feed",
      status: analysisStatus === "completed" || anyGenerated ? "completed" : analysisStatus === "failed" ? "failed" : "unknown",
      durationMs: null,
      inputIds: request.filter((f) => f.value).map((f) => `${f.field}:${f.value}`),
      outputIds: captureIds,
      errorCode: null,
      error: null,
      evidence: { captureIds: captureIds.length, provider: captures[0]?.value ?? null },
    },
    {
      stage: "gather",
      status: analysisStatus === "completed" || anyGenerated ? "completed" : analysisStatus === "failed" ? "failed" : "unknown",
      durationMs: null,
      inputIds: captureIds,
      outputIds: captureIds,
      errorCode: null,
      error: null,
      evidence: { captureIds: captureIds.length },
    },
    {
      stage: "analysis",
      status: analysisStatus,
      durationMs: null,
      inputIds: captureIds,
      outputIds: summary.resultCount !== null ? [`resultCount:${summary.resultCount}`] : [],
      errorCode: summary.status === "failed" ? "RUN_STAGE_FAILED" : null,
      error: summary.pdfError ?? summary.xlsxError ?? summary.csvError ?? null,
      evidence: { resultCount: summary.resultCount },
    },
    {
      stage: "generation",
      status: generationStatus,
      durationMs: null,
      inputIds: captureIds,
      outputIds: [summary.pdfKey, summary.xlsxKey, summary.csvKey].filter((k): k is string => Boolean(k)),
      errorCode: anyFailed ? "RUN_STAGE_FAILED" : null,
      error: summary.pdfError ?? summary.xlsxError ?? summary.csvError ?? null,
      evidence: {
        pdfStatus: summary.pdfStatus ?? null,
        xlsxStatus: summary.xlsxStatus ?? null,
        csvStatus: summary.csvStatus ?? null,
      },
    },
    {
      stage: "recording",
      status: "completed",
      durationMs: null,
      inputIds: [summary.pdfKey, summary.xlsxKey, summary.csvKey].filter((k): k is string => Boolean(k)),
      outputIds: [summary.id],
      errorCode: null,
      error: null,
      evidence: { store, reportId: summary.reportId ?? null },
    },
    {
      stage: "delivery",
      status: body?.deliveredVia || body?.delivery ? "completed" : "unknown",
      durationMs: null,
      inputIds: [summary.id],
      outputIds: [],
      errorCode: null,
      error: null,
      evidence: { deliveredVia: stringifyValue(body?.deliveredVia ?? body?.delivery) ?? null },
    },
  ];

  const formats = [
    { format: "PDF" as const, status: summary.pdfStatus ?? null, url: summary.reportUrl ?? null, key: summary.pdfKey ?? null, error: summary.pdfError ?? null },
    { format: "XLSX" as const, status: summary.xlsxStatus ?? null, url: summary.xlsxUrl ?? null, key: summary.xlsxKey ?? null, error: summary.xlsxError ?? null },
    { format: "CSV" as const, status: summary.csvStatus ?? null, url: summary.csvUrl ?? null, key: summary.csvKey ?? null, error: summary.csvError ?? null },
  ];

  const reasons: RunDetailReason[] = [];
  const pushReason = (
    code: string,
    format: RunDetailReason["format"],
    stage: RunDetailReason["stage"],
    params: Record<string, string>,
    evidence: Record<string, string | number | null>,
  ) => {
    const resolved = resolveRunDetailMessage(code, params, catalog);
    reasons.push({ ...resolved, format, stage, evidence });
  };

  for (const f of formats) {
    if (isDiscovery) {
      pushReason("RUN_NEVER_ATTEMPTED", f.format, "generation", { format: f.format }, { store, kind: summary.kind });
      continue;
    }
    if (f.status === "failed") {
      const code = f.format === "PDF" ? "RUN_PDF_FAILED" : f.format === "XLSX" ? "RUN_XLSX_FAILED" : "RUN_CSV_FAILED";
      pushReason(code, f.format, "generation", { format: f.format, error: errorSuffix(f.error) }, { error: f.error ?? null, store });
      const classified = classifyRecordedError(f.error);
      if (classified && classified !== code) {
        pushReason(classified, f.format, "feed", { connector: f.error ? `: ${f.error}` : "", provider: f.error ? `: ${f.error}` : "" }, { error: f.error ?? null, store });
      }
    } else if (!f.key && !f.url) {
      pushReason("RUN_NO_ARTIFACT_RECORDED", f.format, "recording", { format: f.format }, { store, kind: summary.kind });
    }
  }
  if (summary.resultCount === 0) {
    pushReason("RUN_EMPTY_RESULT", "result", "analysis", {}, { resultCount: 0, store });
  }
  // Unified strategy runs: a failed feed stage with provider fetch
  // errors is a distinct why-no-data reason from a gate-empty
  // result — the feed evidence names the provider error, and the
  // stage trace names the stage. Never claimed when the feed
  // completed with no fetch errors (an empty slice is a filter /
  // window outcome, not a provider failure).
  const feedStage = stages.find((s) => s.stage === "feed");
  const feedFirstError = typeof feedStage?.evidence?.firstFetchError === "string" ? feedStage.evidence.firstFetchError : null;
  if (feedStage?.status === "failed" && feedStage?.errorCode === "RUN_PROVIDER_FETCH_FAILED" && feedFirstError) {
    pushReason("RUN_PROVIDER_FETCH_FAILED", null, "feed", { provider: `: ${feedFirstError}` }, { error: feedFirstError, store });
  }
  if (summary.partial) {
    pushReason("RUN_PARTIAL_COVERAGE", "result", "analysis", {}, { store, kind: summary.kind });
  }
  if (captureIds.length === 0 && (summary.kind === "options_scanner" || summary.kind === "screener")) {
    pushReason("RUN_CAPTURE_MISSING", null, "feed", { capture: "" }, { store, kind: summary.kind });
  }
  if (summary.status === "failed" && !anyFailed) {
    pushReason("RUN_STAGE_FAILED", null, "analysis", { stage: "analysis", error: errorSuffix(summary.pdfError ?? summary.xlsxError ?? summary.csvError ?? null) }, { store });
  }

  return {
    catalogVersion: RUN_DETAIL_MESSAGE_CATALOG_VERSION,
    id: String(summary.id),
    runId: String(summary.runId),
    kind: String(summary.kind),
    source: String(summary.source),
    title: String(summary.title ?? ""),
    createdAt: String(summary.createdAt ?? ""),
    status: summary.status ?? null,
    resultCount: summary.resultCount ?? null,
    request,
    defaultsApplied,
    provenance: {
      executionMode: strOrNull(provenanceBody.executionMode ?? body?.executionMode) ?? null,
      syncAsync: strOrNull(provenanceBody.syncAsync ?? body?.syncAsync) ?? null,
      interface: strOrNull(provenanceBody.interface ?? body?.interface) ?? null,
      parallelism: strOrNull(parallelism) ?? null,
      parallelCount,
      parallelCap,
      submittedVia: strOrNull(provenanceBody.submittedVia?.channel ?? provenanceBody.submittedVia ?? body?.submittedVia?.channel ?? body?.submittedVia) ?? null,
      deliveredVia: stringifyValue(body?.deliveredVia ?? provenanceBody.deliveredVia) ?? null,
      trigger: strOrNull(summary.trigger) ?? null,
      scheduleId: strOrNull(body?.scheduleId ?? provenanceBody.scheduleId) ?? null,
      goalId: strOrNull(body?.goalId ?? provenanceBody.goalId) ?? null,
      asyncJobId: strOrNull(body?.asyncJobId ?? provenanceBody.asyncJobId) ?? null,
      jobType: strOrNull(body?.jobType ?? provenanceBody.jobType) ?? null,
      strategyMode: strOrNull(body?.strategyMode ?? (body?.evaluateAllStrategies === true ? "all" : null)) ?? null,
      workflowId: strOrNull(workflowBody.id ?? body?.workflowId) ?? null,
      workflowName: strOrNull(workflowBody.name ?? body?.workflowName) ?? null,
      workflowVersion: strOrNull(workflowBody.version ?? body?.workflowVersion) ?? null,
      workflowType: strOrNull(workflowBody.type ?? body?.workflowType) ?? null,
    },
    lineage: {
      inputHash: strOrNull(body?.inputHash ?? body?.input?.hash) ?? null,
      captureIds,
      captures,
      engineVersion: strOrNull(body?.modelVersion ?? body?.engineVersion) ?? null,
      catalogueVersion: strOrNull(body?.catalogueVersion ?? body?.catalogVersion) ?? null,
      rendererVersions: {
        pdf: strOrNull(body?.rendererVersions?.pdf) ?? null,
        xlsx: strOrNull(body?.rendererVersions?.xlsx) ?? null,
        csv: strOrNull(body?.rendererVersions?.csv) ?? null,
      },
      store,
    },
    stages,
    formats,
    reasons,
    store,
  };
}
