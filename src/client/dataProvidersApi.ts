/**
 * Client for the data-provider lifecycle endpoints (issue #1180,
 * E4 of epic #1116; server: issue #1170 in
 * src/agents/routes/dataProviders.ts):
 *
 *   GET  /api/data-providers
 *   POST /api/data-providers/:id/register|configure|verify|enable|disable|deprovision
 *
 * The view types below mirror the server's GET shapes field-for-field
 * (providerView + routeServability there). The panel renders what the
 * API returns — servability in particular is the registry's own rule
 * computed server-side; nothing here recomputes it.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule — the
 * worker may answer with a 202 async-job stub that only apiFetch
 * resolves).
 */

import { apiFetch } from "./apiFetch";

/** Verification evidence recorded by a passing verify (E3: config.verification). */
export interface DataProviderVerification {
  verifiedAt: string;
  summary: string;
  verifiedBy: string;
}

/**
 * Health status derived server-side from capture records (E6,
 * issue #1235): "no-data" means the provider has no captures at
 * all — an honest unknown, never rendered as healthy.
 */
export type DataProviderHealthStatus = "healthy" | "degraded" | "down" | "no-data";

/** Usage + outcome aggregates over a provider's (or capability's) captures (E6). */
export interface DataProviderCaptureAggregates {
  totalCaptures: number;
  capturedCount: number;
  failedCount: number;
  /** failedCount / totalCaptures; 0 when there are no captures. */
  failureRate: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  /** Bytes actually stored for `captured` records. */
  totalRawBytes: number;
  capturesLast24h: number;
  failuresLast24h: number;
  /**
   * E7 (issue #1248) fetch-outcome fields — OPTIONAL here because
   * an older API response omits them; the panel renders the fetch
   * line only when they are present and never derives them.
   */
  fetchAttempts?: number;
  fetchFailures?: number;
  /** fetchFailures / fetchAttempts; 0 when there were no attempts. */
  fetchFailureRate?: number;
  /** Capture-write failures, reported separately from fetch failures. */
  captureFailures?: number;
  lastFetchFailureAt?: string | null;
  fetchConsecutiveFailures?: number;
  /** The classified kind of the most recent fetch failure. */
  latestFetchFailureKind?: DataProviderFetchFailureKind | null;
}

/** The classified kinds a failed provider fetch can carry (E7). */
export type DataProviderFetchFailureKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "upstream"
  | "parse"
  | "unknown";

/** The E6 health block on each provider view (server-derived; the panel only formats). */
export interface DataProviderHealth extends DataProviderCaptureAggregates {
  status: DataProviderHealthStatus;
  byCapability: Record<string, DataProviderCaptureAggregates>;
}

/** One provider as the E3 GET surface serves it (providerView). */
export interface DataProviderView {
  id: string;
  adapterKind: string;
  lifecycleState: string;
  enabled: boolean;
  precedence: number;
  /** The credential REFERENCE name only — never a secret value. */
  credentialRef: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  declaredCapabilities: string[];
  verification: DataProviderVerification | null;
  /** Whether any capability route currently resolves to this provider. */
  serving: boolean;
  /** Capture-derived health + usage metering (E6, issue #1235). */
  health: DataProviderHealth;
  /** #3535: this provider's feed jobs as pipeline surface views. */
  feedJobs?: FeedJobView[];
  /** #3536: this provider's enrich jobs as pipeline surface views. */
  enrichJobs?: EnrichJobView[];
  /** #3537: this provider's analyze jobs as pipeline surface views. */
  analyzeJobs?: AnalyzeJobView[];
  /** #3538: this provider's generate jobs as pipeline surface views. */
  generateJobs?: GenerateJobView[];
  /** #3539: this provider's deliver jobs as pipeline surface views. */
  deliverJobs?: DeliverJobView[];
  /** #3540: this provider's composed pipeline chains as end-to-end roll-up views. */
  pipelineChains?: PipelineChainView[];
  /**
   * #3530: this provider's direct feed-job status (the S1 block) —
   * null when no feed job is registered for the provider. Optional
   * here because an older API response omits it; the panel treats
   * absent as null.
   */
  feed?: FeedDatasetStatusView | null;
}

/** One feed run's record, as the status surface serves it (#3530). */
export interface FeedJobRunRecordView {
  runId: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "partial" | "failed";
  requested: number;
  received: number;
  failed: number;
  missingSymbols: string[];
  codedError: string | null;
  errorMessage: string | null;
}

/** The dataset half of a feed job's status (the local copy). */
export interface FeedJobDatasetView {
  jobId: string;
  sourceId: string;
  dataset: string;
  elements: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: FeedJobRunRecordView | null;
  history: FeedJobRunRecordView[];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    rowsPersisted: number;
    stale: boolean;
  } | null;
}

/**
 * One feed job's merged surface status (#3535): the dataset copy
 * plus the job pipeline's state for the same job — the same view
 * the copilot tools return (one source of truth).
 */
export interface FeedJobView {
  jobId: string;
  sourceId: string;
  dataset: string;
  label: string;
  feed: FeedJobDatasetView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
  } | null;
  nextScheduledRun: string | null;
}

/**
 * The provider view's direct feed block (issue #3530): the mirror
 * of feedViewFor's union on the server — a FeedStatusView
 * ("never-run" | "ready") from buildFeedStatus, OR the
 * "not-configured" shape served when no dataset store is wired
 * (which omits `history`, hence optional here). Distinct from
 * FeedJobDatasetView above: the pipeline-merged shape is never
 * "not-configured".
 */
export interface FeedDatasetStatusView {
  jobId: string;
  sourceId: string;
  dataset: string;
  elements: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready" | "not-configured";
  lastRun: FeedJobRunRecordView | null;
  history?: FeedJobRunRecordView[];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    rowsPersisted: number;
    stale: boolean;
  } | null;
}

/** One feed run's result, as POST …/feed-run returns it (issue #3530; since #3578 the run is a pipeline run and runId is the pipeline run id). */
export interface FeedRunResultView {
  jobId: string;
  runId: string;
  status: "completed" | "partial" | "failed";
  artifactId: string;
  requested: number;
  received: number;
  failed: number;
  missingSymbols: string[];
  codedError: string | null;
  startedAt: string;
  finishedAt: string;
}

/**
 * Run one provider's feed job now through the S1 route
 * (issue #3530), which dispatches the job through the pipeline
 * host door (#3578) and returns the settled run outcome + the
 * fresh status block. A run that fails at the provider still
 * resolves (the route answers 200 with run.status "failed" +
 * codedError); wiring/session refusals reject with the server's
 * message and its stable code preserved (see send()).
 */
export async function postFeedRun(
  id: string
): Promise<{ run: FeedRunResultView; feed: FeedDatasetStatusView }> {
  return send<{ run: FeedRunResultView; feed: FeedDatasetStatusView }>(
    `/api/data-providers/${encodeURIComponent(id)}/feed-run`,
    { method: "POST" }
  );
}

export type FeedJobActionName = "run" | "pause" | "resume" | "cancel" | "retry";

/** Run / manage one feed job through the pipeline host (#3535). */
export async function postFeedJobAction(
  id: string,
  jobId: string,
  action: FeedJobActionName
): Promise<void> {
  await send<unknown>(
    `/api/data-providers/${encodeURIComponent(id)}/feed-jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" }
  );
}

/** The enriched-dataset half of an enrich job's status (#3536). */
export interface EnrichJobDatasetView {
  jobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  elements: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: FeedJobRunRecordView | null;
  history: FeedJobRunRecordView[];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    rowsPersisted: number;
    stale: boolean;
    /** Lineage: the feed artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    elements: string[];
  } | null;
}

/**
 * One enrich job's merged surface status (#3536): the enriched
 * copy plus the job pipeline's state for the same job — the
 * same view the copilot tools return (one source of truth).
 */
export interface EnrichJobView {
  jobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  label: string;
  enrich: EnrichJobDatasetView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
  } | null;
  nextScheduledRun: string | null;
}

export type EnrichJobActionName = FeedJobActionName;

/** Run / manage one enrich job through the pipeline host (#3536). */
export async function postEnrichJobAction(
  id: string,
  jobId: string,
  action: EnrichJobActionName
): Promise<void> {
  await send<unknown>(
    `/api/data-providers/${encodeURIComponent(id)}/enrich-jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" }
  );
}

/** One analyze run's record, as the status surface serves it (#3537). */
export interface AnalyzeJobRunRecordView {
  runId: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "partial" | "failed";
  requested: number;
  received: number;
  failed: number;
  codedError: string | null;
  errorMessage: string | null;
}

/** The analyzed copy's universe summary, as served (#3537). */
export interface AnalyzeJobSummaryView {
  symbols: number;
  advancers: number;
  decliners: number;
  flat: number;
  meanMomentum: number | null;
  meanCompositeScore: number | null;
  topByComposite: Array<{ symbol: string; score: number }>;
  bottomByComposite: Array<{ symbol: string; score: number }>;
}

/** The analyzed-dataset half of an analyze job's status (#3537). */
export interface AnalyzeJobDatasetView {
  jobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  ruleSets: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: AnalyzeJobRunRecordView | null;
  history: AnalyzeJobRunRecordView[];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    rowsPersisted: number;
    stale: boolean;
    /** Lineage: the enriched artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    ruleSets: string[];
    summary: AnalyzeJobSummaryView;
  } | null;
}

/**
 * One analyze job's merged surface status (#3537): the analyzed
 * copy plus the job pipeline's state for the same job — the
 * same view the copilot tools return (one source of truth).
 */
export interface AnalyzeJobView {
  jobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  label: string;
  analyze: AnalyzeJobDatasetView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
  } | null;
  nextScheduledRun: string | null;
}

export type AnalyzeJobActionName = FeedJobActionName;

/** Run / manage one analyze job through the pipeline host (#3537). */
export async function postAnalyzeJobAction(
  id: string,
  jobId: string,
  action: AnalyzeJobActionName
): Promise<void> {
  await send<unknown>(
    `/api/data-providers/${encodeURIComponent(id)}/analyze-jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" }
  );
}

/** One generate run's record, as the status surface serves it (#3538). */
export interface GenerateJobRunRecordView {
  runId: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "partial" | "failed";
  requested: number;
  received: number;
  failed: number;
  codedError: string | null;
  errorMessage: string | null;
}

/** One generated report's outcome, as served (#3538). */
export interface GenerateJobReportView {
  kind: string;
  title: string;
  formatsGenerated: string[];
  formatsFailed: string[];
  canonicalStatus: "stored" | "deduped" | "not_wired" | "failed";
  canonicalReportId: string | null;
}

/** The generated-dataset half of a generate job's status (#3538). */
export interface GenerateJobDatasetView {
  jobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  reports: string[];
  formats: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: GenerateJobRunRecordView | null;
  history: GenerateJobRunRecordView[];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    reportsPersisted: number;
    formatsPersisted: number;
    stale: boolean;
    /** Lineage: the analyzed artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    reports: GenerateJobReportView[];
  } | null;
}

/**
 * One generate job's merged surface status (#3538): the generated
 * copy plus the job pipeline's state for the same job — the
 * same view the copilot tools return (one source of truth).
 */
export interface GenerateJobView {
  jobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  label: string;
  generate: GenerateJobDatasetView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
  } | null;
  nextScheduledRun: string | null;
}

export type GenerateJobActionName = FeedJobActionName;

/** Run / manage one generate job through the pipeline host (#3538). */
export async function postGenerateJobAction(
  id: string,
  jobId: string,
  action: GenerateJobActionName
): Promise<void> {
  await send<unknown>(
    `/api/data-providers/${encodeURIComponent(id)}/generate-jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" }
  );
}

/** One deliver run's record, as the status surface serves it (#3539). */
export interface DeliverJobRunRecordView {
  runId: string;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "partial" | "failed";
  requested: number;
  received: number;
  failed: number;
  codedError: string | null;
  errorMessage: string | null;
}

/** One report's per-channel delivery outcome, as served (#3539). */
export interface DeliverJobChannelView {
  channel: string;
  status: "delivered" | "failed" | "not_configured" | "already_delivered";
  target: string | null;
}

/** One delivered report's outcome, as served (#3539). */
export interface DeliverJobReportView {
  kind: string;
  title: string;
  channels: DeliverJobChannelView[];
}

/** The delivery-dataset half of a deliver job's status (#3539). */
export interface DeliverJobDatasetView {
  jobId: string;
  generateJobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  channels: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: DeliverJobRunRecordView | null;
  history: DeliverJobRunRecordView[];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    pairsDelivered: number;
    channelsDelivered: string[];
    stale: boolean;
    /** Lineage: the generated artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    reports: DeliverJobReportView[];
  } | null;
}

/**
 * One deliver job's merged surface status (#3539): the delivery
 * copy plus the job pipeline's state for the same job — the
 * same view the copilot tools return (one source of truth).
 */
export interface DeliverJobView {
  jobId: string;
  generateJobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: string;
  dataset: string;
  label: string;
  deliver: DeliverJobDatasetView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
  } | null;
  nextScheduledRun: string | null;
}

export type DeliverJobActionName = FeedJobActionName;

/** Run / manage one deliver job through the pipeline host (#3539). */
export async function postDeliverJobAction(
  id: string,
  jobId: string,
  action: DeliverJobActionName
): Promise<void> {
  await send<unknown>(
    `/api/data-providers/${encodeURIComponent(id)}/deliver-jobs/${encodeURIComponent(jobId)}/${action}`,
    { method: "POST" }
  );
}

/** One stage of a pipeline chain's end-to-end roll-up (#3540). */
export interface PipelineChainStageView {
  stage: "feed" | "enrich" | "analyze" | "generate" | "deliver";
  jobId: string;
  nodePath: string;
  status:
    | "completed"
    | "running"
    | "failed"
    | "stopped"
    | "cancelled"
    | "pending"
    | "not-run";
  units: number;
  completedUnits: number;
  error: string | null;
  jobState: string | null;
  jobLastRunStatus: string | null;
  jobLastRunAt: string | null;
}

/**
 * One composed pipeline chain's end-to-end surface status
 * (#3540): per-stage states + the current frontier + the chain
 * run's state — the same view the copilot tools return (one
 * source of truth).
 */
export interface PipelineChainView {
  jobId: string;
  feedJobId: string;
  enrichJobId: string;
  analyzeJobId: string;
  generateJobId: string;
  deliverJobId: string;
  sourceId: string;
  dataset: string;
  label: string;
  stages: PipelineChainStageView[];
  frontier: "feed" | "enrich" | "analyze" | "generate" | "deliver" | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    lastError: string | null;
  } | null;
  nextScheduledRun: string | null;
}

export type PipelineChainActionName =
  | FeedJobActionName
  | "stage_pause"
  | "stage_resume"
  | "stage_cancel";

/** Run / manage one pipeline chain (or one of its stages) through the pipeline host (#3540). */
export async function postPipelineChainAction(
  id: string,
  jobId: string,
  action: PipelineChainActionName,
  stage?: string
): Promise<void> {
  await send<unknown>(
    `/api/data-providers/${encodeURIComponent(id)}/pipeline-chains/${encodeURIComponent(jobId)}/${action}`,
    {
      method: "POST",
      ...(stage
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage }),
          }
        : {}),
    }
  );
}

/** One capability route as the E3 GET surface serves it (routeServability). */
/** Offering tier a route requires of its callers (E5, issue #1202). */
export type DataProviderTier = "freemium" | "premium";

export interface CapabilityRouteView {
  capability: string;
  primaryProviderId: string;
  gapFillProviderId: string | null;
  /** Minimum caller tier served through this route (E5). */
  minTier: DataProviderTier;
  resolves: boolean;
  resolvedPrimaryId: string | null;
  resolvedGapFillId: string | null;
  error?: string;
}

export interface DataProvidersList {
  providers: DataProviderView[];
  routes: CapabilityRouteView[];
}

export type DataProviderActionName =
  | "configure"
  | "verify"
  | "enable"
  | "disable"
  | "deprovision";

/**
 * The actions the panel offers for a provider, mirroring the legal
 * map the E3 lifecycle service enforces (lifecycle.ts):
 *
 *   configure:   registered | configured
 *   verify:      configured
 *   enable:      verified, or disabled WITH verification evidence
 *   disable:     enabled
 *   deprovision: any state except deprovisioned (terminal)
 *
 * (register is not a per-provider action — it creates the record.)
 * The server remains the authority: it re-checks every move and the
 * panel surfaces its rejection verbatim.
 */
export function providerActions(view: DataProviderView): DataProviderActionName[] {
  switch (view.lifecycleState) {
    case "registered":
      return ["configure", "deprovision"];
    case "configured":
      return ["configure", "verify", "deprovision"];
    case "verified":
      return ["enable", "deprovision"];
    case "enabled":
      return ["disable", "deprovision"];
    case "disabled":
      return view.verification
        ? ["enable", "deprovision"]
        : ["deprovision"];
    default:
      return [];
  }
}

/** Display name: config.displayName when the record carries one, else the id. */
export function providerDisplayName(view: DataProviderView): string {
  const name = view.config?.displayName;
  return typeof name === "string" && name !== "" ? name : view.id;
}

/**
 * One request seam. A failed response carries the server's own explanation
 * when it sent one: the JSON `error`, or — for a body that is not JSON
 * (an edge/error-boundary page, a truncated response) — the first lines of
 * the raw text, clamped. A bare `Request failed (500)` told the operator
 * nothing, which is why the Data Providers surface could not be diagnosed
 * from the UI (issue #2624 fix-up).
 */
async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(path, init);
  const raw = await resp.text().catch(() => "");
  let data = {} as T & { error?: string; code?: string };
  if (raw) {
    try {
      data = JSON.parse(raw) as T & { error?: string; code?: string };
    } catch {
      data = {} as T & { error?: string; code?: string };
    }
  }
  if (!resp.ok) {
    const bodyHint = !raw
      ? ""
      : raw.startsWith("<")
        ? " (HTML error page from the edge — see Worker logs)"
        : `: ${raw.replace(/\s+/g, " ").trim().slice(0, 200)}`;
    const message = data.error || `Request failed (${resp.status})${bodyHint}`;
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = resp.status;
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}

export async function fetchDataProviders(): Promise<DataProvidersList> {
  const data = await send<Partial<DataProvidersList>>("/api/data-providers");
  // Shape guard (issue #71): never hand the renderer a non-array.
  return {
    providers: Array.isArray(data?.providers) ? data.providers : [],
    routes: Array.isArray(data?.routes) ? data.routes : [],
  };
}

export async function postDataProviderAction(
  id: string,
  action: DataProviderActionName | "register",
  body?: Record<string, unknown>
): Promise<void> {
  await send<{ provider: unknown }>(
    `/api/data-providers/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      ...(body !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }
  );
}

/** Timestamp rendering, same convention as the API keys panel. */
export function fmtDataProviderTime(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Age rendering for a persisted feed copy (formatting only; the server computes the age). */
export function fmtFeedAge(ageSeconds: number): string {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return "—";
  if (ageSeconds < 90) return `${Math.floor(ageSeconds)}s old`;
  if (ageSeconds < 5400) return `${Math.round(ageSeconds / 60)}m old`;
  return `${(ageSeconds / 3600).toFixed(1)}h old`;
}

/** Plain byte-count rendering for the E6 captured-data total (formatting only). */
export function fmtCaptureBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}
