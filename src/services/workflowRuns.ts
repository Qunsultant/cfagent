/**
 * Workflow Runs — the one read model for "what actually happened" in
 * every recorded workflow execution.
 *
 * Two systems of record feed it, and neither is copied:
 *  - mas_async_jobs: the run's job tree. A chain (chain_id) is one run;
 *    each job row is one stage (feed / gather / generate / store /
 *    serve / deliver, or the capability itself when no stage is
 *    stamped). Payloads carry the stage's inputs, result_json its
 *    output, error its failure, started_at/completed_at its timing.
 *  - mas_screening_activity (kind "stage"): per-stage terminal
 *    transitions with their reason (completed / failed / skipped /
 *    held) — the only place a skipped or held stage says WHY. They are
 *    attached to the job stage they describe; a transition with no job
 *    row becomes its own stage row (recordedBy "stage-transition"),
 *    so a stage that ran inside a Cloudflare Workflow is never
 *    invisible just because it has no async-job row.
 *
 * mas_job_outcomes supplies the run-level facts a job tree does not
 * carry: the trigger (manual / scheduled), the scan counts, the coded
 * error, the artifact keys, and the per-channel delivery states. An
 * outcome whose id names a job in a run is that run's outcome; an
 * outcome with no job twin is its own run (a discovery run, a
 * synchronous screen) rather than being dropped.
 *
 * Honesty rules:
 *  - a field the store does not record is null, never invented;
 *  - inputs and outputs are normalized summaries, never raw payloads:
 *    secret-shaped keys are redacted and long values truncated, so the
 *    surface can render them without leaking credentials or megabytes;
 *  - trigger is "unknown" (rendered "Not recorded") when no store
 *    records one — the classification never guesses from a label.
 *  - a standalone http.request GET/HEAD row is a read trace, not a
 *    run, and is filtered out (#2456); POST submissions and
 *    chain-member request stages stay.
 */

export type WorkflowRunTrigger = "manual" | "scheduled" | "autonomous" | "webhook" | "agent" | "unknown";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "awaiting"
  | "unknown";

export type WorkflowRunFamily =
  | "stock"
  | "options"
  | "goal"
  | "discovery"
  | "delivery"
  | "feed"
  | "tool"
  | "nlq"
  | "other";

export interface WorkflowRunArtifact {
  kind: "pdf" | "xlsx" | "csv" | "report";
  label: string;
  url: string;
}

export interface WorkflowRunStage {
  /** Stable row key: the job id, or `<transition-id>` for a stage recorded only as a transition. */
  key: string;
  order: number;
  /** Stage verb (feed / gather / generate / store / serve / deliver) or the capability. */
  stage: string;
  label: string;
  status: string;
  /** Where this stage row came from — an async job, a recorded stage transition, or a unified run record. */
  recordedBy: "job" | "stage-transition" | "unified-record";
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Human description (the job's display name, or the transition summary). */
  detail: string | null;
  /** Why a skipped/held/failed stage ended that way, when recorded. */
  reason: string | null;
  error: string | null;
  capability: string | null;
  jobKind: string | null;
  channel: string | null;
  input: unknown;
  output: unknown;
}

export interface WorkflowRun {
  /** Row identity (the chain id, or the standalone job/outcome id). */
  id: string;
  /** The run id the producing store records (chain id / outcome id). */
  runId: string;
  workflow: string;
  family: WorkflowRunFamily;
  title: string;
  source: "job-chain" | "job-outcome";
  trigger: WorkflowRunTrigger;
  /** How the trigger was evidenced, e.g. "Scheduled (job-tree)" or "Not recorded by the source". */
  triggerDetail: string;
  triggeredBy: string | null;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stageCount: number;
  completedStages: number;
  failedStages: number;
  stages: WorkflowRunStage[];
  inputs: unknown;
  outputs: unknown;
  artifacts: WorkflowRunArtifact[];
  deliveryStates: Record<string, string>;
  /** The run's first coded error, when any stage or the outcome recorded one. */
  error: string | null;
}

/** The columns of mas_async_jobs this model reads (payload included). */
export interface WorkflowRunJobRow {
  job_id: string;
  capability: string;
  display_name: string;
  status: string;
  payload_json?: string | null;
  result_json?: string | null;
  error?: string | null;
  created_at: string;
  updated_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  parent_job_id?: string | null;
  job_kind?: string | null;
  channel?: string | null;
  not_before?: string | null;
  stage?: string | null;
  chain_id?: string | null;
}

/** The mas_job_outcomes columns this model reads. */
export interface WorkflowRunOutcomeRow {
  id: string;
  kind: string;
  trigger: string;
  status: string;
  scanned?: number | null;
  matched?: number | null;
  codedError?: string | null;
  reportUrl?: string | null;
  pdfKey?: string | null;
  xlsxKey?: string | null;
  csvKey?: string | null;
  deliveryStates?: Record<string, string>;
  origin?: string | null;
  createdAt: string;
}

/** One kind="stage" screening-activity row, flattened for this model. */
export interface WorkflowRunStageTransition {
  id: string;
  createdAt: string;
  summary: string;
  chainId: string | null;
  jobId: string | null;
  stage: string | null;
  status: string;
  reason: string | null;
}

/**
 * A unified run record overlaid onto a Workflow Runs outcome twin.
 * Produced by the route layer from the canonical mas_reports body
 * (body.stages, body.input, body.feed) for strategy runs — the same
 * record Docs Run Details reads. It is NOT a job tree: stages carry
 * no job id, and durations are null unless the recorder measured
 * them. Matching is by runId, or by asyncJobId when the outcome
 * twins an async job.
 */
export interface UnifiedWorkflowRunRecord {
  runId: string;
  asyncJobId?: string | null;
  reportId?: string | null;
  title?: string | null;
  trigger?: string | null;
  triggerDetail?: string | null;
  stages: Array<{
    stage: string;
    status: string;
    durationMs?: number | null;
    detail?: string | null;
    reason?: string | null;
    error?: string | null;
    input?: unknown;
    output?: unknown;
  }>;
  inputs?: unknown;
  outputs?: unknown;
}

export interface BuildWorkflowRunsInput {
  jobs: WorkflowRunJobRow[];
  outcomes: WorkflowRunOutcomeRow[];
  transitions: WorkflowRunStageTransition[];
  unifiedRecords?: UnifiedWorkflowRunRecord[];
  /** Default 40, clamped 1..100. */
  limit?: number;
}

const SECRET_KEY = /(secret|token|password|passwd|authorization|cookie|api[-_]?key|private[-_]?key|credential|session[-_]?key)/i;
const MAX_STRING = 240;
const MAX_DEPTH = 3;
const MAX_KEYS = 16;
const MAX_ARRAY = 6;

const STAGE_LABELS: Record<string, string> = {
  feed: "Feed — market data intake",
  gather: "Gather — enrichment & technicals",
  generate: "Generate — screen / analysis",
  recording: "Recording — canonical record",
  store: "Store — canonical record",
  serve: "Serve — artifact retrieval",
  deliver: "Deliver — channel dispatch",
  analysis: "Analysis — screen evaluation",
};

const CAPABILITY_LABELS: Record<string, string> = {
  "http.request": "HTTP request",
  "followup.report": "Report generation",
  "followup.deliver": "Channel delivery",
  "followup.notify": "Lifecycle notification",
  "shard.execute": "Shard execution",
  "feed.snapshot": "Feed snapshot",
  "mcp.tool": "MCP tool call",
  "nlq.execute": "NLQ execution",
  "screener.run": "Screener run",
};

function parseObject(text: unknown): Record<string, any> | null {
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Truncate a display string without claiming the full value. */
function clip(value: string, max = MAX_STRING): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Normalize one JSON value for display: secrets redacted, long strings
 * clipped, arrays/objects bounded. A normalized value is safe to render
 * — it is a summary, never the stored payload.
 */
export function compactJsonValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return clip(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : "[object]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((entry) => compactJsonValue(entry, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `…${value.length - MAX_ARRAY} more`] : items;
  }
  const obj = asObject(value);
  if (!obj) return String(value);
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key of Object.keys(obj).sort()) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (kept >= MAX_KEYS) break;
    out[key] = compactJsonValue(obj[key], depth + 1);
    kept += 1;
  }
  return out;
}

function compactRecord(obj: Record<string, any> | null, keys?: readonly string[]): Record<string, unknown> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const key of keys ?? Object.keys(obj).sort()) {
    if (!(key in obj) || obj[key] === undefined) continue;
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = compactJsonValue(obj[key], 0);
  }
  return out;
}

const INPUT_KEYS = [
  "method",
  "pathAndQuery",
  "toolName",
  "query",
  "symbols",
  "universe",
  "filters",
  "provider",
  "channel",
  "artifacts",
  "stage",
  "thesis",
  "mode",
  "profileRef",
  "budget",
  "maxItems",
] as const;

/**
 * The stage's recorded inputs, as a summary. A follow-up job carries
 * the whole originating outcome — summarize it instead of echoing it.
 */
export function stageInputSummary(job: WorkflowRunJobRow): unknown {
  const payload = parseObject(job.payload_json);
  if (!payload) return null;
  const out: Record<string, unknown> = {};

  const path = str(payload.pathAndQuery);
  if (path) {
    const [pathOnly, search] = path.split("?");
    out.path = clip(pathOnly, 160);
    // Query params carry the screen's universe/filters on several
    // routes; surface them as inputs (secret-shaped keys withheld).
    if (search) {
      const params: Record<string, string> = {};
      let kept = 0;
      for (const [key, value] of new URLSearchParams(search)) {
        if (kept >= 12) break;
        params[key] = SECRET_KEY.test(key) ? "[redacted]" : clip(value, 120);
        kept += 1;
      }
      if (Object.keys(params).length > 0) out.query = params;
    }
  }
  for (const key of INPUT_KEYS) {
    if (key === "pathAndQuery" || key === "symbols" || key === "filters" || key === "artifacts") continue;
    if (payload[key] !== undefined) out[key] = compactJsonValue(payload[key], 0);
  }
  if (Array.isArray(payload.symbols)) {
    out.symbols = payload.symbols.slice(0, 20).map((s) => (typeof s === "string" ? s : String(s)));
    if (payload.symbols.length > 20) out.symbolCount = payload.symbols.length;
  }
  if (payload.filters !== undefined) out.filters = compactJsonValue(payload.filters, 0);
  if (payload.artifacts !== undefined) out.artifacts = compactJsonValue(payload.artifacts, 0);

  const outcome = asObject(payload.outcome);
  if (outcome) {
    out.outcome = compactRecord(outcome, [
      "kind",
      "trigger",
      "success",
      "universe",
      "sector",
      "thesis",
      "matchedCount",
      "totalScanned",
      "error",
      "pdfStatus",
      "xlsxStatus",
      "csvStatus",
      "deliveryChannels",
    ]);
  }
  const body = asObject(payload.body) ?? parseObject(payload.body);
  if (body) {
    out.body = compactRecord(body, [
      "trigger",
      "universe",
      "sector",
      "symbols",
      "filters",
      "provider",
      "maxItems",
      "strategy",
      "thesis",
    ]);
  }
  if (payload.request !== undefined && out.body === undefined) {
    out.request = compactJsonValue(payload.request, 0);
  }
  return Object.keys(out).length > 0 ? out : null;
}

const OUTPUT_KEYS = [
  "ok",
  "success",
  "status",
  "reason",
  "error",
  "message",
  "responseStatus",
  "matchedCount",
  "totalScanned",
  "totalUnderlyingsScanned",
  "withTrades",
  "evaluated",
  "reportId",
  "reportUrl",
  "pdfKey",
  "xlsxKey",
  "csvKey",
  "deliveryId",
  "channel",
  "skipReason",
  "provider",
  "mode",
  "generationId",
] as const;

/** The stage's recorded output, as a summary. */
export function stageOutputSummary(job: WorkflowRunJobRow): unknown {
  const result = parseObject(job.result_json);
  if (!result) return null;
  const out = compactRecord(result, OUTPUT_KEYS);
  if (Object.keys(out).length > 0) return out;
  // A result with none of the known keys is still evidence it exists;
  // return its key list rather than an empty-looking success.
  return { keys: Object.keys(result).sort().slice(0, MAX_KEYS) };
}

export function stageLabel(stage: string | null, capability: string): string {
  const verb = (stage ?? "").trim().toLowerCase();
  if (STAGE_LABELS[verb]) return STAGE_LABELS[verb];
  if (CAPABILITY_LABELS[capability]) return CAPABILITY_LABELS[capability];
  if (verb) return verb.charAt(0).toUpperCase() + verb.slice(1);
  return capability || "Stage";
}

export function workflowFamilyForJobs(jobs: WorkflowRunJobRow[], outcome?: WorkflowRunOutcomeRow): WorkflowRunFamily {
  if (outcome) {
    if (outcome.kind === "stock") return "stock";
    if (outcome.kind === "options") return "options";
    if (outcome.kind === "goal") return "goal";
    if (outcome.kind === "discovery") return "discovery";
  }
  const caps = new Set(jobs.map((j) => j.capability));
  if (caps.has("nlq.execute")) return "nlq";
  if (caps.has("mcp.tool")) return "tool";
  if (caps.has("feed.snapshot")) return "feed";
  if (caps.has("screener.run")) return "stock";
  for (const job of jobs) {
    const payload = parseObject(job.payload_json);
    const path = str(payload?.pathAndQuery) ?? "";
    if (path.includes("/trading/options") || path.includes("/options/")) return "options";
    if (path.includes("/etrade/screen") || path.includes("/screener")) return "stock";
    if (path.toLowerCase().includes("discovery")) return "discovery";
    if (path.includes("/goal")) return "goal";
  }
  if (jobs.some((j) => j.capability.startsWith("followup."))) return "delivery";
  return "other";
}

const FAMILY_WORKFLOW: Record<WorkflowRunFamily, string> = {
  stock: "Stock screening workflow",
  options: "Options research workflow",
  goal: "Goal screen workflow",
  discovery: "Strategy discovery workflow",
  delivery: "Report delivery",
  feed: "Feed pipeline",
  tool: "MCP tool run",
  nlq: "NLQ execution",
  other: "Background job",
};

function triggerEvidence(job: WorkflowRunJobRow): { trigger?: string; detail?: string; actor?: string } {
  const payload = parseObject(job.payload_json);
  if (!payload) return {};
  const outcome = asObject(payload.outcome);
  const body = asObject(payload.body) ?? parseObject(payload.body);
  const candidates = [
    str(payload.trigger),
    str(outcome?.trigger),
    str(body?.trigger),
  ].filter(Boolean) as string[];
  if (candidates.includes("manual")) return { trigger: "manual" };
  if (candidates.includes("scheduled")) return { trigger: "scheduled" };

  const scheduleName =
    str(payload.scheduleName) ?? str(payload.scheduleId) ?? str(payload.cron) ?? str(payload.schedule);
  const goalId = str(payload.goalId);
  if (scheduleName || goalId) {
    return {
      trigger: goalId ? "autonomous" : "scheduled",
      detail: goalId ? `Goal ${goalId}` : `Schedule ${scheduleName}`,
    };
  }
  if (payload.scheduled === true || payload.scheduledAt) return { trigger: "scheduled" };
  if (str(payload.webhookUrl) || payload.webhook === true) return { trigger: "webhook" };
  const actor = str(payload.requestedBy) ?? str(payload.userLogin) ?? str(payload.actor);
  if (actor) return { trigger: "manual", actor };
  return {};
}

const TRIGGER_LABEL: Record<WorkflowRunTrigger, string> = {
  manual: "Manual",
  scheduled: "Scheduled",
  autonomous: "Autonomous",
  webhook: "Webhook",
  agent: "Agent",
  unknown: "Not recorded",
};

export function triggerLabel(trigger: WorkflowRunTrigger): string {
  return TRIGGER_LABEL[trigger];
}

function triggerFromOutcome(outcome: WorkflowRunOutcomeRow): {
  trigger: WorkflowRunTrigger;
  detail: string;
  triggeredBy: string | null;
} {
  const origin = str(outcome.origin);
  if (outcome.trigger === "manual") {
    return {
      trigger: "manual",
      detail: origin ? `Manual — recorded by ${origin}` : "Manual",
      triggeredBy: origin && /^@/.test(origin) ? origin : null,
    };
  }
  if (outcome.trigger === "scheduled") {
    const autonomousOrigin = Boolean(origin && /(discover|autopilot|goal|scheduler|tick|cron)/i.test(origin));
    return {
      trigger: "scheduled",
      detail: autonomousOrigin
        ? `Scheduled — autonomous producer (${origin})`
        : origin
          ? `Scheduled — recorded by ${origin}`
          : "Scheduled",
      triggeredBy: autonomousOrigin ? "Scheduler" : origin,
    };
  }
  return { trigger: "unknown", detail: "Not recorded by the source", triggeredBy: origin };
}

function isoOrNull(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function durationBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return to - from;
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "skipped"]);

function normalizeTransitionStatus(status: string): string {
  if (status === "held") return "held";
  if (status === "skipped") return "skipped";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return status || "unknown";
}

function artifactsForOutcome(outcome: WorkflowRunOutcomeRow): WorkflowRunArtifact[] {
  const artifacts: WorkflowRunArtifact[] = [];
  const pdfKey = str(outcome.pdfKey);
  const reportUrl = str(outcome.reportUrl);
  if (reportUrl) {
    artifacts.push({ kind: "report", label: "Report", url: reportUrl });
  } else if (pdfKey) {
    const base =
      outcome.kind === "options"
        ? "/api/options/report.pdf"
        : outcome.kind === "goal"
          ? "/api/screening/goal-screen/report.pdf"
          : "/api/screener/report.pdf";
    artifacts.push({ kind: "pdf", label: "PDF report", url: `${base}?key=${encodeURIComponent(pdfKey)}` });
  }
  const xlsxKey = str(outcome.xlsxKey);
  if (xlsxKey) {
    const base =
      outcome.kind === "options"
        ? "/api/options/report.xlsx"
        : outcome.kind === "goal"
          ? "/api/screening/goal-screen/report.xlsx"
          : "/api/screener/report.xlsx";
    artifacts.push({ kind: "xlsx", label: "XLSX workbook", url: `${base}?key=${encodeURIComponent(xlsxKey)}` });
  }
  const csvKey = str(outcome.csvKey);
  if (csvKey) {
    const base =
      outcome.kind === "options"
        ? "/api/options/report.csv"
        : outcome.kind === "goal"
          ? "/api/screening/goal-screen/report.csv"
          : "/api/screener/report.csv";
    artifacts.push({ kind: "csv", label: "CSV export", url: `${base}?key=${encodeURIComponent(csvKey)}` });
  }
  return artifacts;
}

function runStatusFromStages(stages: WorkflowRunStage[]): WorkflowRunStatus {
  const statuses = stages.map((s) => s.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("queued")) return "queued";
  if (statuses.includes("held")) return statuses.includes("completed") ? "partial" : "awaiting";
  if (statuses.includes("skipped")) return statuses.includes("completed") ? "partial" : "skipped";
  if (statuses.length > 0 && statuses.every((s) => s === "completed")) return "completed";
  return "unknown";
}

interface RunGroup {
  key: string;
  jobs: WorkflowRunJobRow[];
}

/** A chain is one run; a job with no chain groups under its parent (or itself). */
export function runGroupKey(job: WorkflowRunJobRow): string {
  return str(job.chain_id) ?? str(job.parent_job_id) ?? job.job_id;
}

/**
 * #2456: a standalone http.request GET/HEAD row with no chain, no
 * parent, no stage, and no stageChain is a read trace (a queued
 * page-load read), not a run, and must not appear in the runs list.
 * The method matters: POST http.request singletons are real
 * submissions (a scheduled screen, a goal-triggered job — pinned by
 * the existing workflow_runs tests), and they still queue today, so
 * they stay. Each carve-out preserves one way a request row belongs
 * to a real run: a chain id or parent id makes it a chain member, a
 * stage makes it a recorded stage, and a stageChain payload makes it
 * a chain main in formation. A row with no readable method is kept:
 * unclassifiable rows are never hidden. The row stays in the store
 * and in audit; only this read model hides it. Nothing is deleted.
 */
function isStandaloneRequestTrace(job: WorkflowRunJobRow): boolean {
  if (job.capability !== "http.request") return false;
  if (str(job.chain_id) || str(job.parent_job_id) || str(job.stage)) return false;
  const payload = parseObject(job.payload_json);
  if (payload && "stageChain" in payload) return false;
  const method = typeof payload?.method === "string" ? payload.method.toUpperCase() : "";
  return method === "GET" || method === "HEAD";
}

function mainJobOf(jobs: WorkflowRunJobRow[]): WorkflowRunJobRow {
  const main = jobs.find((j) => j.job_kind === "main");
  if (main) return main;
  const root = jobs.find((j) => !str(j.parent_job_id));
  if (root) return root;
  return [...jobs].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
}

function sortJobs(jobs: WorkflowRunJobRow[]): WorkflowRunJobRow[] {
  return [...jobs].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.job_id < b.job_id ? -1 : 1;
  });
}

function stageRowsForGroup(
  jobs: WorkflowRunJobRow[],
  transitions: WorkflowRunStageTransition[],
): WorkflowRunStage[] {
  const ordered = sortJobs(jobs);
  const usedTransitionIds = new Set<string>();
  const stages: WorkflowRunStage[] = [];

  for (const job of ordered) {
    const stageVerb = str(job.stage) ?? "";
    const matchedTransition =
      transitions.find((t) => !usedTransitionIds.has(t.id) && t.jobId === job.job_id && (!t.stage || !stageVerb || t.stage === stageVerb)) ??
      transitions.find((t) => !usedTransitionIds.has(t.id) && t.jobId === job.job_id);
    if (matchedTransition) usedTransitionIds.add(matchedTransition.id);

    const startedAt = isoOrNull(job.started_at) ?? isoOrNull(job.created_at);
    const completedAt = isoOrNull(job.completed_at);
    stages.push({
      key: job.job_id,
      order: stages.length + 1,
      stage: stageVerb || job.capability,
      label: stageLabel(stageVerb || null, job.capability),
      status: matchedTransition ? normalizeTransitionStatus(matchedTransition.status) : job.status,
      recordedBy: "job",
      startedAt,
      finishedAt: completedAt,
      durationMs: durationBetween(startedAt, completedAt),
      detail: job.display_name || null,
      reason: matchedTransition?.reason ?? null,
      error: str(job.error),
      capability: job.capability || null,
      jobKind: str(job.job_kind),
      channel: str(job.channel),
      input: stageInputSummary(job),
      output: stageOutputSummary(job),
    });
  }

  // Transitions with no job row: a stage ran (e.g. inside a Cloudflare
  // Workflow) and only its terminal state was recorded. Show it rather
  // than pretend the run had no such stage.
  for (const transition of transitions) {
    if (usedTransitionIds.has(transition.id)) continue;
    const status = normalizeTransitionStatus(transition.status);
    stages.push({
      key: transition.id,
      order: stages.length + 1,
      stage: transition.stage ?? "stage",
      label: stageLabel(transition.stage, ""),
      status,
      recordedBy: "stage-transition",
      startedAt: isoOrNull(transition.createdAt),
      finishedAt: isoOrNull(transition.createdAt),
      durationMs: null,
      detail: transition.summary || null,
      reason: transition.reason,
      error: status === "failed" ? transition.reason : null,
      capability: null,
      jobKind: null,
      channel: null,
      input: null,
      output: null,
    });
  }

  return stages;
}

function outcomeMatchesGroup(outcomeId: string, jobIds: Set<string>): boolean {
  if (jobIds.has(outcomeId)) return true;
  const workflowPrefix = outcomeId.match(/^workflow:([^:]+):/);
  return Boolean(workflowPrefix && jobIds.has(workflowPrefix[1]));
}

function outputsForGroup(
  jobs: WorkflowRunJobRow[],
  stages: WorkflowRunStage[],
  outcome: WorkflowRunOutcomeRow | undefined,
): unknown {
  const main = mainJobOf(jobs);
  const mainResult = parseObject(main.result_json);
  const out: Record<string, unknown> = {};
  if (outcome) {
    out.outcome = compactRecord(
      {
        status: outcome.status,
        scanned: outcome.scanned ?? null,
        matched: outcome.matched ?? null,
        codedError: outcome.codedError ?? null,
      },
      ["status", "scanned", "matched", "codedError"],
    );
  }
  if (mainResult) {
    out.result = stageOutputSummary(main);
  }
  const stageSummary = stages
    .filter((s) => s.status !== "completed" || s.reason)
    .map((s) => ({ stage: s.stage, status: s.status, ...(s.reason ? { reason: s.reason } : {}) }));
  if (stageSummary.length > 0) out.stageOutcomes = stageSummary;
  return Object.keys(out).length > 0 ? out : null;
}

export function runFromJobs(
  jobs: WorkflowRunJobRow[],
  transitions: WorkflowRunStageTransition[],
  outcome?: WorkflowRunOutcomeRow,
): WorkflowRun {
  const main = mainJobOf(jobs);
  const family = workflowFamilyForJobs(jobs, outcome);
  const stages = stageRowsForGroup(jobs, transitions);
  const triggerEvidenceForRun = jobs.map(triggerEvidence).find((t) => t.trigger) ?? {};
  const outcomeTrigger = outcome ? triggerFromOutcome(outcome) : null;
  const trigger: WorkflowRunTrigger =
    (triggerEvidenceForRun.trigger as WorkflowRunTrigger | undefined) ?? outcomeTrigger?.trigger ?? "unknown";
  const triggerDetail = triggerEvidenceForRun.detail
    ? triggerEvidenceForRun.detail
    : triggerEvidenceForRun.trigger
      ? `${triggerLabel(trigger)} — recorded on the run's job tree`
      : (outcomeTrigger?.detail ?? "Not recorded by the source");
  const startedAt = isoOrNull(main.created_at) ?? isoOrNull(jobs[0]?.created_at) ?? new Date(0).toISOString();
  const allTerminal = jobs.every((j) => TERMINAL_JOB_STATUSES.has(j.status));
  const finishedAt = allTerminal
    ? jobs.map((j) => isoOrNull(j.completed_at)).filter(Boolean).sort().pop() ?? null
    : null;
  const artifacts = outcome ? artifactsForOutcome(outcome) : [];
  const recordedStageStatus = runStatusFromStages(stages);
  // A recorded failure always wins; an outcome's completed verb never
  // overrides a stage that failed on the record.
  const runStatus: WorkflowRunStatus = outcome
    ? outcome.status === "failed"
      ? "failed"
      : outcome.status === "partial"
        ? "partial"
        : recordedStageStatus === "failed"
          ? "failed"
          : recordedStageStatus === "partial"
            ? "partial"
            : recordedStageStatus === "running" || recordedStageStatus === "queued"
              ? recordedStageStatus
              : "completed"
    : recordedStageStatus;
  const firstError =
    stages.map((s) => s.error).find((e) => Boolean(e)) ?? str(outcome?.codedError) ?? null;

  return {
    id: str(jobs[0]?.chain_id) ?? main.job_id,
    runId: str(jobs[0]?.chain_id) ?? main.job_id,
    workflow: FAMILY_WORKFLOW[family],
    family,
    title: main.display_name || FAMILY_WORKFLOW[family],
    source: "job-chain",
    trigger,
    triggerDetail,
    triggeredBy: outcomeTrigger?.triggeredBy ?? triggerEvidenceForRun.actor ?? null,
    status: runStatus,
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    stageCount: stages.length,
    completedStages: stages.filter((s) => s.status === "completed").length,
    failedStages: stages.filter((s) => s.status === "failed").length,
    stages,
    inputs: stageInputSummary(main),
    outputs: outputsForGroup(jobs, stages, outcome),
    artifacts,
    deliveryStates: outcome?.deliveryStates ?? {},
    error: firstError,
  };
}

export function runFromOutcome(
  outcome: WorkflowRunOutcomeRow,
  transitions: WorkflowRunStageTransition[] = [],
  unified?: UnifiedWorkflowRunRecord,
): WorkflowRun {
  const trigger = triggerFromOutcome(outcome);
  const family: WorkflowRunFamily =
    outcome.kind === "stock"
      ? "stock"
      : outcome.kind === "options"
        ? "options"
        : outcome.kind === "goal"
          ? "goal"
          : outcome.kind === "discovery"
            ? "discovery"
            : "other";
  const unifiedStages: WorkflowRunStage[] = unified
    ? unified.stages.map((s, index) => ({
        key: `unified:${s.stage}`,
        order: index + 1,
        stage: s.stage,
        label: stageLabel(s.stage, ""),
        status: s.status,
        recordedBy: "unified-record" as const,
        startedAt: isoOrNull(outcome.createdAt),
        finishedAt: isoOrNull(outcome.createdAt),
        durationMs: typeof s.durationMs === "number" ? s.durationMs : null,
        detail: s.detail ?? null,
        reason: s.reason ?? null,
        error: s.error ?? null,
        capability: null,
        jobKind: null,
        channel: null,
        input: s.input ?? null,
        output: s.output ?? null,
      }))
    : [];
  // The recording stage is derived from the written canonical row,
  // exactly as Docs Run Details derives it — never stored as
  // "completed" before the write lands.
  if (unified && unified.reportId && !unifiedStages.some((s) => s.stage === "recording")) {
    unifiedStages.push({
      key: "unified:recording",
      order: unifiedStages.length + 1,
      stage: "recording",
      label: stageLabel("recording", ""),
      status: "completed",
      recordedBy: "unified-record" as const,
      startedAt: isoOrNull(outcome.createdAt),
      finishedAt: isoOrNull(outcome.createdAt),
      durationMs: null,
      detail: `Canonical row ${unified.reportId}`,
      reason: null,
      error: null,
      capability: null,
      jobKind: null,
      channel: null,
      input: null,
      output: [unified.reportId],
    });
  }
  const stages: WorkflowRunStage[] = unified
    ? unifiedStages
    : transitions.map((transition, index) => ({
        key: transition.id,
        order: index + 1,
        stage: transition.stage ?? "stage",
        label: stageLabel(transition.stage, ""),
        status: normalizeTransitionStatus(transition.status),
        recordedBy: "stage-transition" as const,
        startedAt: isoOrNull(transition.createdAt),
        finishedAt: isoOrNull(transition.createdAt),
        durationMs: null,
        detail: transition.summary || null,
        reason: transition.reason,
        error: transition.status === "failed" ? transition.reason : null,
        capability: null,
        jobKind: null,
        channel: null,
        input: null,
        output: null,
      }));
  const recordedStageStatus = runStatusFromStages(stages);
  // With a unified record, the run's status verb is the outcome's
  // verb — a failed feed stage is stage evidence (failedStages,
  // stage error), not a retroactive rewrite of the recorded
  // outcome, so Docs and Workflow Runs agree on status while
  // differing honestly on stage detail. Without a unified record,
  // the previous promotion rule is unchanged.
  const status: WorkflowRunStatus = unified
    ? outcome.status === "failed"
      ? "failed"
      : outcome.status === "partial"
        ? "partial"
        : outcome.status === "completed"
          ? "completed"
          : "unknown"
    : outcome.status === "failed"
      ? "failed"
      : outcome.status === "partial"
        ? "partial"
        : recordedStageStatus === "failed"
          ? "failed"
          : recordedStageStatus === "partial"
            ? "partial"
            : recordedStageStatus === "running" || recordedStageStatus === "queued" || recordedStageStatus === "awaiting"
              ? recordedStageStatus
              : outcome.status === "completed"
                ? "completed"
                : "unknown";
  const kindLabel = outcome.kind ? `${outcome.kind.charAt(0).toUpperCase()}${outcome.kind.slice(1)}` : "Workflow";
  const feedError = unifiedStages.find((s) => s.stage === "feed")?.error ?? null;
  return {
    id: outcome.id,
    runId: outcome.id,
    workflow: FAMILY_WORKFLOW[family],
    family,
    title: unified?.title ?? `${kindLabel} run — ${outcome.id}`,
    source: "job-outcome",
    trigger: trigger.trigger,
    triggerDetail: unified?.triggerDetail ?? trigger.detail,
    triggeredBy: trigger.triggeredBy,
    status,
    startedAt: outcome.createdAt,
    finishedAt: outcome.createdAt,
    durationMs: null,
    stageCount: stages.length,
    completedStages: stages.filter((s) => s.status === "completed").length,
    failedStages: stages.filter((s) => s.status === "failed").length,
    // An outcome records the run's terminal result; without a
    // unified record the only stage rows it can carry are
    // transitions recorded under its own id. An empty list is the
    // truthful answer, not a fabricated one.
    stages,
    inputs: unified?.inputs ?? { kind: outcome.kind, origin: outcome.origin ?? null },
    outputs: unified?.outputs ?? {
      status: outcome.status,
      scanned: outcome.scanned ?? null,
      matched: outcome.matched ?? null,
      ...(outcome.codedError ? { codedError: outcome.codedError } : {}),
    },
    artifacts: artifactsForOutcome(outcome),
    deliveryStates: outcome.deliveryStates ?? {},
    error: outcome.codedError ?? feedError,
  };
}

/** Group, attach outcomes, and merge — newest first, capped at limit. */
export function buildWorkflowRuns(input: BuildWorkflowRunsInput): WorkflowRun[] {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 40) || 40, 100));
  const jobs = input.jobs.filter((job) => !isStandaloneRequestTrace(job));
  const groups = new Map<string, RunGroup>();
  for (const job of jobs) {
    const key = runGroupKey(job);
    const group = groups.get(key);
    if (group) group.jobs.push(job);
    else groups.set(key, { key, jobs: [job] });
  }

  const transitionsByRun = new Map<string, WorkflowRunStageTransition[]>();
  const jobToGroup = new Map<string, string>();
  for (const [key, group] of groups) {
    for (const job of group.jobs) jobToGroup.set(job.job_id, key);
  }
  for (const transition of input.transitions) {
    const key =
      (transition.chainId && groups.has(transition.chainId) ? transition.chainId : undefined) ??
      (transition.jobId ? jobToGroup.get(transition.jobId) : undefined);
    if (!key) continue;
    const list = transitionsByRun.get(key) ?? [];
    list.push(transition);
    transitionsByRun.set(key, list);
  }

  const runs: WorkflowRun[] = [];
  for (const [key, group] of groups) {
    const jobIds = new Set(group.jobs.map((j) => j.job_id));
    const outcome = input.outcomes.find((o) => outcomeMatchesGroup(o.id, jobIds));
    runs.push(runFromJobs(group.jobs, transitionsByRun.get(key) ?? [], outcome));
  }

  for (const outcome of input.outcomes) {
    // The outcome belongs to a job-chain run when its id names one of
    // that run's jobs (directly, or via the `workflow:<jobId>:<shard>`
    // delivery id). Otherwise it IS the run.
    const isTwin = runs.some((run) =>
      run.stages.some((stage) => stage.recordedBy === "job" && outcomeMatchesGroup(outcome.id, new Set([stage.key]))),
    );
    if (isTwin) continue;
    const ownTransitions = input.transitions.filter(
      (transition) => transition.chainId === outcome.id || transition.jobId === outcome.id,
    );
    const unified = (input.unifiedRecords ?? []).find(
      (u) => u.runId === outcome.id || (u.asyncJobId && u.asyncJobId === outcome.id),
    );
    runs.push(runFromOutcome(outcome, ownTransitions, unified));
  }

  runs.sort((a, b) => (a.startedAt === b.startedAt ? (a.id < b.id ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1));
  return runs.slice(0, limit);
}

/** Counts for the run list's header, computed from the returned rows. */
export function summarizeWorkflowRuns(runs: WorkflowRun[]): {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  active: number;
  byTrigger: Record<WorkflowRunTrigger, number>;
} {
  const byTrigger: Record<WorkflowRunTrigger, number> = {
    manual: 0,
    scheduled: 0,
    autonomous: 0,
    webhook: 0,
    agent: 0,
    unknown: 0,
  };
  let completed = 0;
  let partial = 0;
  let failed = 0;
  let active = 0;
  for (const run of runs) {
    byTrigger[run.trigger] += 1;
    if (run.status === "completed") completed += 1;
    else if (run.status === "partial") partial += 1;
    else if (run.status === "failed") failed += 1;
    else if (run.status === "running" || run.status === "queued" || run.status === "awaiting") active += 1;
  }
  return { total: runs.length, completed, partial, failed, active, byTrigger };
}
