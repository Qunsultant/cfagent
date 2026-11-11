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
 * reason/error string in a Run Details view comes from the single
 * outcome catalog (src/outcomes/outcomeCatalog.json, top-level
 * "runDetailMessages" section) via resolveRunDetailMessage in
 * src/outcomes/outcomeAspects.ts — the single message aspect.
 * Components, routes, agents, and renderers must not hardcode Run
 * Details wording; changing wording is a catalog change, never a
 * code change. Codes are stable and the catalog is versioned
 * (RUN_DETAIL_MESSAGE_CATALOG_VERSION; v1 was the standalone
 * catalog this file carried, v2 is the fold into the outcome
 * catalog — issue #2608). The RUN_DETAIL_MESSAGE_CATALOG const
 * below is a deprecated alias of the catalog-file section, kept so
 * existing callers and tests keep resolving; new code imports the
 * resolver from outcomeAspects.
 */

import type { RunSummary } from "./runSummaries";
import {
  classifyRunDetailError,
  getRunDetailMessageCatalog,
  resolveRunDetailMessage as resolveRunDetailMessageFromCatalog,
  RUN_DETAIL_MESSAGE_CATALOG_VERSION as OUTCOME_CATALOG_RUN_DETAIL_VERSION,
  type RunDetailMessageCatalog as OutcomeRunDetailMessageCatalog,
  type RunDetailMessageEntry as OutcomeRunDetailMessageEntry,
  type ResolvedRunDetailMessage as OutcomeResolvedRunDetailMessage,
} from "../outcomes/outcomeAspects";

/** @deprecated Superseded by src/outcomes/outcomeCatalog.json ("runDetailMessages"), resolved via src/outcomes/outcomeAspects.ts resolveRunDetailMessage. Kept as the catalog-file section so existing callers keep resolving; do not add codes here — extend the catalog file. */
export const RUN_DETAIL_MESSAGE_CATALOG_VERSION = OUTCOME_CATALOG_RUN_DETAIL_VERSION;

export type RunDetailLevel = "info" | "debugging" | "error";

/** @deprecated Superseded by src/outcomes/outcomeAspects.ts RunDetailMessageEntry. */
export type RunDetailMessageDef = OutcomeRunDetailMessageEntry;

/** @deprecated Superseded by src/outcomes/outcomeAspects.ts RunDetailMessageCatalog. */
export type RunDetailMessageCatalog = OutcomeRunDetailMessageCatalog;

/**
 * @deprecated Superseded by src/outcomes/outcomeCatalog.json
 * ("runDetailMessages"), read via
 * src/outcomes/outcomeAspects.ts getRunDetailMessageCatalog. This
 * const is that section, not a second catalog: do not add codes
 * here — extend the catalog file.
 */
export const RUN_DETAIL_MESSAGE_CATALOG: RunDetailMessageCatalog = getRunDetailMessageCatalog();

/** @deprecated Superseded by src/outcomes/outcomeAspects.ts ResolvedRunDetailMessage. */
export type ResolvedRunDetailMessage = OutcomeResolvedRunDetailMessage;

/**
 * @deprecated Superseded by src/outcomes/outcomeAspects.ts
 * resolveRunDetailMessage (the single resolver). Thin wrapper kept
 * for existing callers and tests; it delegates verbatim, including
 * the optional catalog override.
 */
export function resolveRunDetailMessage(
  code: string,
  params: Record<string, string> = {},
  catalog: RunDetailMessageCatalog = RUN_DETAIL_MESSAGE_CATALOG,
): ResolvedRunDetailMessage {
  return resolveRunDetailMessageFromCatalog(code, params, catalog);
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

/**
 * Recorded-error classifier, re-homed on the single resolver module
 * (issue #2608): the substring-to-code table now lives in
 * src/outcomes/outcomeAspects.ts classifyRunDetailError. This
 * private helper is the call-site alias; the wording for any code
 * it returns always comes from resolveRunDetailMessage.
 */
function classifyRecordedError(error: string | null): string | null {
  return classifyRunDetailError(error);
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
  const store = options.store ?? (summary.reportId ? "mas_reports" : summary.source === "job-pipeline" ? "job-pipeline" : summary.kind === "options_scanner" ? "mas_opportunity_scans" : summary.kind === "discovery" ? "mas_discovery_runs" : "screener-feed");
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
    ["allowedStrategiesResolved", ["input.allowedStrategiesResolved", "allowedStrategiesResolved"]],
    ["targetPrice", ["input.targetPrice", "targetPrice"]],
    ["dteMin", ["input.dte.min", "input.dteMin", "dteMin"]],
    ["dteMax", ["input.dte.max", "input.dteMax", "dteMax"]],
    ["candidateLimit", ["input.candidateLimit", "candidateLimit"]],
    ["alternatives", ["input.alternatives", "alternatives"]],
    ["farDated", ["input.farDated", "farDated"]],
    ["fetchBands", ["input.fetchBands", "fetchBands"]],
    ["horizonLimited", ["input.horizonLimited", "horizonLimited"]],
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
  // Issue #2608: every reason resolves through the single resolver
  // (outcomeAspects.resolveRunDetailMessage, backed by the catalog
  // file) — never the deprecated local catalog.
  const pushReason = (
    code: string,
    format: RunDetailReason["format"],
    stage: RunDetailReason["stage"],
    params: Record<string, string>,
    evidence: Record<string, string | number | null>,
  ) => {
    const resolved = resolveRunDetailMessageFromCatalog(code, params, catalog);
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
