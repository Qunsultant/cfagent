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
 * Issue #3946 (Option B): the engine's D1 job run records
 * (src/data/d1JobRunRecordAdapter, migration 0047) feed it as a
 * third ledger. A D1 record is its own run — family "other",
 * source "job-outcome" — with an honest empty stage list: the
 * record carries no per-stage rows, so no stages are invented for
 * it. It carries no broker provenance and no login, so those fields
 * stay absent and the row is a deployment-level engine run, never
 * attributed to the signed-in user.
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
 *    chain-member request stages stay. #2786 (2026-11-03 ruling)
 *    OVERRIDES the #2815 impression/click carve-out: POST ad
 *    beacons are real submissions and surface labeled — only
 *    GET/HEAD traces hide, and only behind the visible toggle.
 */

import {
  bindingScheduleRows,
  isDelayedRun,
  lifecycleStateForRun,
  scheduleProvenanceForJobs,
  scheduleProvenanceForTrigger,
  type WorkflowLifecycleState,
  type WorkflowRunSchedule,
} from "./workflowLifecycle";
import { codedMessage } from "../outcomes/outcomeAspects";
import { buildFeedJobRegistry } from "./feedJobs";
import { FEED_PIPELINE_CATALOG } from "./feedPipelineJobs";
import type { DataProviderId } from "../trading";
import type { ScanRunSummary } from "../trading";
// Issue #3946 (Option B): the engine's D1 run records merge onto the
// Workflow Runs page through runFromJobRunRecord, beside the DO
// ledgers — never re-homed, never projected here (that is #4116).
// Issue #4069 (Option B for options): the scanner's scan-run rows
// (mas_opportunity_scans) merge the same way through runFromScanRun.
import { d1JobRunRecordId } from "./jobRunRecordReads";
import type { JobRunRecord } from "./jobRunRecords";
// Issue #4359 — the run's stages come from the engine's own checkpoint
// read (getJob's stage views), projected here once; the stage-status
// roll-up is the chain surface's (one rule, not a second copy).
import type { JobStageView } from "./jobPipelineEngine";
import { aggregateStageStatus } from "./chainPipelineJobs";
// Issue #4420 — the inner shard run's identity has ONE home (the engine
// that defines it); this read derives the id from the shard's payload with
// the same function the executor dispatches it under.
import { shardScanJobId } from "../workflows/optionsScreenEngine";

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
  | "research"
  | "ads"
  | "trading"
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
  recordedBy: "job" | "stage-transition" | "unified-record" | "engine-checkpoint";
  /**
   * Issue #4362 — the engine job id this stage can be controlled
   * through (present only on engine stages). The Workflow Runs row's
   * per-stage buttons address this id; a stage with no engine job
   * carries no buttons rather than a guess.
   */
  engineJobId?: string | null;
  /** Issue #4363 — the run's execution mode, as the definition recorded it. */
  executionMode?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Issue #4418: the row's last heartbeat before a reap — pre-reap evidence. */
  lastActivityAt?: string | null;
  /** Issue #4421: the durable job id this stage row stands for (NULL on a
   *  stage recorded only as a transition or an engine checkpoint). */
  jobId?: string | null;
  /** Issue #4421: the job id this row retried, read from the payload the
   *  retry stamped. NULL = an original attempt, never a guess. */
  retryOf?: string | null;
  /** Issue #4417: the failed attempts this shard recorded, oldest first. */
  attempts?: Array<{ attempt: number; error: string; at: string }>;
  /**
   * Issue #4420: the inner per-symbol engine job an options feed shard
   * dispatched (`strategy-screen:shard-scan:<chainId>:<symbol>`), derived
   * from the shard's own payload. Absent on a row that is not a shard.
   */
  innerJobId?: string | null;
  /**
   * Issue #4420: that inner run's stages, read from the checkpoint the
   * shard wrote. Empty = the shard has an inner job id and no checkpoint
   * was recorded (an honest empty, rendered as such); absent = no inner
   * run, so the row claims nothing about one.
   */
  innerStages?: WorkflowRunStage[];
  /**
   * Issue #4422: what this shard recorded about its symbol — verdict, skip
   * reason, target, fit gate, and the quoted best candidate per strategy
   * type. Absent on a row that recorded no scan matrix (never an invented
   * symbol). The fetched chain itself is not retained; the panel says so.
   */
  symbolEvidence?: ShardSymbolEvidence;
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
  source: "job-chain" | "job-outcome" | "report" | "schedule";
  trigger: WorkflowRunTrigger;
  /** How the trigger was evidenced, e.g. "Scheduled (job-tree)" or "Not recorded by the source". */
  triggerDetail: string;
  /**
   * Issue #4419: the chain's feed stage failed in full and no downstream
   * stage was ever planned, so the chain cannot advance without a retry.
   * Absent = not stranded (a merely delayed chain has a downstream row).
   */
  stranded?: boolean;
  triggeredBy: string | null;
  status: WorkflowRunStatus;
  /**
   * Issue #3784: display derivation — true when the run is still
   * `running` AND at least one of its jobs carries the stuck-alert
   * claim (`stuck_alerted_at`, #2567, applied by the sweep or the
   * read path). NOT a stored status and NOT a lifecycle state: the
   * recorded status stays "running" and the lifecycle stays
   * in-progress; the panel renders "Stuck" for a stuck run.
   * Always set by runFromJobs; outcome/report/schedule runs (no
   * job rows) leave it unset, which renders as not stuck.
   */
  stuck?: boolean;
  /**
   * Issue #3021: the run's lifecycle state — exactly one of
   * scheduled / in-progress / done / cancelled — rolled up from the
   * recorded status (and, for delayed runs, from not_before). The
   * raw status stays on the row; the lifecycle is the filterable,
   * sortable rollup, never a replacement for the recorded verb.
   * Optional so older cached responses still type-check; builders
   * always set it.
   */
  lifecycle?: WorkflowLifecycleState;
  /**
   * Issue #3021: the run's schedule provenance — mechanism +
   * identity + reason + next firing + delay. Null when the run
   * carries no scheduling evidence (an untriggered run's schedule
   * is unknown, never guessed). Builders always set it (possibly
   * null); schedule rows always carry it.
   */
  schedule?: WorkflowRunSchedule | null;
  /**
   * Issue #4357: the Cloudflare workflow instance id that executed
   * this run, when known — read off a job row's payload (the bridge
   * row carries the workflow instance id it dispatched). Null when
   * no job row carries one (the run was not workflow-dispatched, or
   * predates the stamp). Read-only surface field; the engine stage
   * surfacing (#4359) builds on it.
   */
  workflowId?: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /**
   * Issue #3811: the executor's last recorded activity across the
   * run's jobs (heartbeat, falling back to the claim instant for
   * rows that predate heartbeats), or null when no job recorded
   * one. Absent on runs recorded before this slice — never
   * backfilled, never invented.
   */
  lastActivityAt?: string | null;
  /**
   * Issue #3811: milliseconds since the last activity, for a
   * running run only — the heartbeat age that distinguishes
   * "still progressing" from "stalled". Null for terminal runs
   * and for runs with no recorded activity.
   */
  heartbeatAgeMs?: number | null;
  /**
   * Issue #3655: broker + data-provider + mode provenance for a
   * scheduled run, recorded at creation/fire time. Absent on runs
   * recorded before provenance existed — never backfilled from the
   * currently selected broker.
   */
  brokerId?: string | null;
  dataProviderId?: string | null;
  mode?: "live" | "paper" | null;
  /** Issue #3655 (effective mode): which resolver leg produced the mode — pin | selection | inference. */
  modeSource?: "pin" | "selection" | "inference" | null;
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
  /**
   * Issue #2786 Part 3: the run's Docs columns, from its canonical
   * mas_reports row when one exists. Absent (null/undefined) when no
   * canonical row matches — the PDF/XLSX/CSV cells then render —
   * (or the outcome's artifact urls as fallback), never invented.
   */
  documents?: WorkflowRunDocuments | null;
  /**
   * Issue #3039: the collation's named cap reason, when a fan-out round
   * deferred a tail (#3028 records it; the tail still ran). Null when the
   * run was not capped — absent is the normal case, never an omission.
   */
  fanoutCapReason: string | null;
  /** Issue #3039: units a resumed run skipped because they were already complete. */
  resumedSkippedUnits: string[];
}

/**
 * Issue #2786 Part 3: the Docs-tab columns for one run, carried from
 * its canonical mas_reports row (via runSummaryFromReport). The family
 * is the Docs family (stock / options / goal / strategy), not the
 * engine family — a discovery-kind row reads "strategy" here, exactly
 * as the Docs tab labels it.
 */
export interface WorkflowRunDocuments {
  /**
   * The mas_reports row id backing these documents — or, for a
   * scan-run row (#4069), the scan run id, resolved as a scan row
   * by /api/runs/details.
   */
  reportId: string;
  family: "stock" | "options" | "goal" | "strategy";
  pdfUrl: string | null;
  pdfStatus: string | null;
  pdfError: string | null;
  xlsxUrl: string | null;
  xlsxStatus: string | null;
  xlsxError: string | null;
  csvUrl: string | null;
  csvStatus: string | null;
  csvError: string | null;
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
  /** Issue #3784: the stuck-alert claim stamp (#2567) — the ISO
   *  instant the (single) stuck alert was claimed for this row,
   *  or NULL while unclaimed. Carried through the route mapping
   *  so the runs view can derive the Stuck display. */
  stuck_alerted_at?: string | null;
  /** Issue #4417: the durable attempt history (JSON array of {attempt,error,at}). */
  attempts_json?: string | null;
  /** Issue #3810: provenance stamped at submission — the trigger
   *  that caused this job, its actor, and the originating schedule
   *  id. NULL = the submission carried none (the read model renders
   *  that as "Not recorded", never invented). */
  trigger?: string | null;
  triggered_by?: string | null;
  schedule_id?: string | null;
  /** Issue #3811: the executor's last recorded activity (claim,
   *  heartbeat, or terminal transition), or NULL for rows claimed
   *  before heartbeats existed. Carried through the route mapping
   *  so the runs view can show last activity + heartbeat age. */
  last_activity_at?: string | null;
  /** Issue #3811: the coded failure (single outcome catalog),
   *  or NULL for rows that never failed. Carried through the route
   *  mapping so the runs view can show the coded error. */
  error_code?: string | null;
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
  /**
   * Issue #3655: broker + data-provider provenance from the canonical
   * body's provenance object (withProviderProvenance). Absent when
   * the canonical row predates provenance — never backfilled.
   */
  brokerId?: string | null;
  dataProviderId?: string | null;
  /** Issue #3655 (effective mode): which resolver leg produced the mode — pin | selection | inference. */
  modeSource?: "pin" | "selection" | "inference" | null;
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
  /**
   * Issue #4359 — engine stage views by the job id they belong to (the
   * run's engine job, read once per page). A group uses the first entry
   * that names any of its jobs; a group with none keeps today's
   * job-row projection.
   */
  engineStages?: ReadonlyMap<string, JobStageView[]>;
  /**
   * Issue #4420 — each shard job's inner engine stages, keyed by the
   * shard job id, read from the checkpoint the shard wrote. Absent for a
   * page whose shards have no options feed rows.
   */
  innerShardStages?: ReadonlyMap<string, { jobId: string; stages: WorkflowRunStage[] }>;
  jobs: WorkflowRunJobRow[];
  outcomes: WorkflowRunOutcomeRow[];
  transitions: WorkflowRunStageTransition[];
  unifiedRecords?: UnifiedWorkflowRunRecord[];
  /** Default 40, clamped 1..100. */
  limit?: number;
}

const SECRET_KEY = /(secret|token|password|passwd|authorization|cookie|api[-_]?key|private[-_]?key|credential|session[-_]?key)/i;
const MAX_STRING = 240;
/**
 * Issue #4422 — the per-symbol evidence bounds. A shard records one matrix row
 * (its symbol) with one cell per strategy type, and each cell's best candidate
 * carries one leg per side; the view trims both lists so a deep chain never
 * bloats a page, and it names what it trimmed (`strategyTypeCount`) instead of
 * dropping it silently.
 */
const MAX_EVIDENCE_STRATEGIES = 12;
const MAX_EVIDENCE_LEGS = 8;
const MAX_EVIDENCE_REASONS = 6;
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
  // #2869 stage-message ids (src/workflows/stageMessage.ts) — labeled
  // here so a stage message's id renders as its stage, never raw.
  // Keys are lowercase because stageLabel lowercases before lookup;
  // "deliver" above is shared with the #2869 deliver stage.
  plan: "Plan — run plan",
  brokerstart: "Broker start — execution branch",
  acquireuniverse: "Acquire universe — symbols",
  fetchquotes: "Fetch quotes — market data",
  enrich: "Enrich — symbol data",
  computeindicatorsandscores: "Compute indicators & scores",
  applyfilters: "Apply filters — screening criteria",
  rankandgrade: "Rank & grade — opportunities",
  detectstandouts: "Detect standouts",
  persistcanonicalresults: "Persist canonical results",
  "analysis-done": "Analysis done — report ready",
  shapereport: "Shape report — artifacts",
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

/** An already-parsed JSON object, or null — never a coerced non-object. */
function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
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
    if (path.includes("/external-ads/impression") || path.includes("/external-ads/click")) return "ads";
    if (path.includes("/market-data/screen") || path.includes("/foss/screen")) return "stock";
    if (path.includes("/market-data/") || path.includes("/foss/")) return "research";
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
  research: "Market data research",
  ads: "Advertising",
  trading: "Trading order workflow",
  other: "Background job",
};

/** Issue #3810: the stamped trigger domain — the run-level
 *  triggers a submission may stamp. "unknown" is never stamped. */
const STAMPED_TRIGGERS: readonly WorkflowRunTrigger[] = ["manual", "scheduled", "autonomous", "webhook", "agent"];

function triggerEvidence(job: WorkflowRunJobRow): { trigger?: string; detail?: string; actor?: string } {
  // Issue #3810: the stamped columns are the recorded provenance —
  // they win over every payload heuristic below. An invalid stored
  // value is ignored (never rendered); a missing one falls through
  // to the payload evidence, exactly as before.
  const stamped = STAMPED_TRIGGERS.find((t) => t === job.trigger);
  if (stamped) {
    const actor = typeof job.triggered_by === "string" && job.triggered_by ? job.triggered_by : undefined;
    return {
      trigger: stamped,
      detail: actor
        ? `${triggerLabel(stamped)} — recorded by ${actor}`
        : `${triggerLabel(stamped)} — recorded on the run's job tree`,
      actor,
    };
  }
  const payload = parseObject(job.payload_json);
  if (!payload) return {};
  const outcome = asObject(payload.outcome);
  const body = asObject(payload.body) ?? parseObject(payload.body);
  // Issue #4415: legacy shard-chain rows predate the stamps — the chain object
  // they already carry is evidence of the trigger and the actor, never a guess.
  const chain = asObject(payload.chain);
  const chainTrigger = str(chain?.trigger);
  const chainActor = str(chain?.userLogin);
  const candidates = [
    str(payload.trigger),
    str(outcome?.trigger),
    str(body?.trigger),
    chainTrigger,
  ].filter(Boolean) as string[];
  if (candidates.includes("manual")) {
    return { trigger: "manual", ...(chainActor ? { actor: chainActor } : {}) };
  }
  if (candidates.includes("scheduled")) {
    return { trigger: "scheduled", ...(chainActor ? { actor: chainActor } : {}) };
  }

  const scheduleName =
    str(payload.scheduleName) ??
    str(chain?.scheduleId) ??
    str(payload.scheduleId) ??
    str(payload.cron) ??
    str(payload.schedule);
  const goalId = str(payload.goalId);
  if (scheduleName || goalId) {
    return {
      trigger: goalId ? "autonomous" : "scheduled",
      detail: goalId ? `Goal ${goalId}` : `Schedule ${scheduleName}`,
    };
  }
  if (payload.scheduled === true || payload.scheduledAt) return { trigger: "scheduled" };
  if (str(payload.webhookUrl) || payload.webhook === true) return { trigger: "webhook" };
  // #3813 (read-time): an MCP tool run whose payload names its acting
  // login is agent-triggered. #3810 composition: the branch fires only
  // when an actor is present — a tool run with no actor in its payload
  // and no stamped trigger stays "unknown" (never invent a trigger
  // without evidence), falling through to the manual/unknown branches.
  if (job.capability === "mcp.tool") {
    const actingLogin = str(payload.actingLogin) ?? str(payload.userLogin) ?? str(payload.actor);
    if (actingLogin) {
      const toolName = str(payload.toolName) ?? "tool";
      return {
        trigger: "agent",
        detail: `Agent tool call — ${toolName}`,
        actor: actingLogin,
      };
    }
  }
  const actor = str(payload.requestedBy) ?? str(payload.userLogin) ?? str(payload.actor);
  if (actor) return { trigger: "manual", actor };
  // #2786 Part 2 (scope b): an http.request row that records no trigger
  // evidence still states its submission channel honestly — it was
  // submitted as an async API request — instead of rendering "Not
  // recorded". The trigger stays "unknown": the channel is evidence
  // of HOW it arrived, never a guess at manual/scheduled. Headers are
  // deliberately NOT read here: httpEntry stores x-user-login as a
  // sessionKey fallback when no login exists, and a session key must
  // never render as an actor.
  if (job.capability === "http.request" && str(payload.pathAndQuery)) {
    const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "";
    const pathOnly = str(payload.pathAndQuery)?.split("?")[0] ?? "";
    return {
      trigger: "unknown",
      detail: method && pathOnly ? `Submitted as an async API request — ${method} ${pathOnly}` : "Submitted as an async API request",
    };
  }
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

/**
 * Issue #3811: the detail after a leading "[CODE] business — "
 * prefix, or null when the message carries no such prefix. The
 * single outcome catalog renders coded messages in exactly that
 * shape (codedMessage), so the detail is what follows the first
 * " — " separator.
 */
function codedErrorDetail(message: string | null | undefined): string | null {
  if (!message) return null;
  const match = /^\[[^\]]+\][^—]*—\s([\s\S]*)$/.exec(message);
  return match ? match[1] : null;
}

/**
 * Issue #3811: a job row's error rendered with its code — the
 * coded message (code + business message + the raw detail, with a
 * leading "[CODE] ..." prefix stripped so the code never renders
 * twice). A row with no code keeps its raw error verbatim; a row
 * with a code but no message renders the code alone. The code is
 * the answer to "failing or successful?"; the detail is the why.
 */
function codedStageError(job: WorkflowRunJobRow): string | null {
  const raw = str(job.error);
  const code = str(job.error_code);
  if (!code) return raw;
  const detail = codedErrorDetail(raw) ?? raw;
  return codedMessage(code, detail ?? undefined);
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
  // Issue #4359 — the engine's own non-terminal and terminal verbs:
  // a stage that has not started yet reads queued, a stopped one is
  // resumable (awaiting), and a wholly cancelled run is the platform's
  // "skipped" rather than an unknown verb.
  if (statuses.length > 0 && statuses.every((s) => s === "pending")) return "queued";
  if (statuses.includes("stopped")) return statuses.includes("completed") ? "partial" : "awaiting";
  if (statuses.length > 0 && statuses.every((s) => s === "cancelled")) return "skipped";
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
 *
 * #2786 OVERRIDE (2026-11-03 ruling, "nothing excluded"): the
 * #2815 impression/click carve-out is REMOVED. POST ad beacons are
 * real submissions and surface labeled through the ads family; only
 * GET/HEAD traces hide, and only behind the panel's visible toggle.
 */
export function isStandaloneRequestTrace(job: WorkflowRunJobRow): boolean {
  if (job.capability !== "http.request") return false;
  if (str(job.chain_id) || str(job.parent_job_id) || str(job.stage)) return false;
  const payload = parseObject(job.payload_json);
  if (payload && "stageChain" in payload) return false;
  const method = typeof payload?.method === "string" ? payload.method.toUpperCase() : "";
  if (method === "GET" || method === "HEAD") return true;
  return false;
}

function mainJobOf(jobs: WorkflowRunJobRow[]): WorkflowRunJobRow {
  // Issue #4357 — a linked group carries TWO main rows (the wrapper
  // and its bridge child); the run's identity stays the ROOT main —
  // the one with no parent — so the wrapper id (and its MCP title)
  // is the run id. A lone main keeps today's behavior.
  const rootMain = jobs.find((j) => j.job_kind === "main" && !str(j.parent_job_id));
  if (rootMain) return rootMain;
  const main = jobs.find((j) => j.job_kind === "main");
  if (main) return main;
  const root = jobs.find((j) => !str(j.parent_job_id));
  if (root) return root;
  return [...jobs].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
}

/**
 * Issue #4357 — the join-key read: an engine D1 run record belongs
 * to the grouped run whose bridge row it names (record.asyncJobId
 * === bridge job_id). Unlinked records (asyncJobId null, or no
 * matching row in this read) render standalone, as today — a missing
 * bridge row never drops the run.
 */
export function d1RecordLinkedToJobs(
  record: JobRunRecord,
  jobs: WorkflowRunJobRow[],
): boolean {
  const bridgeId = record.asyncJobId;
  if (!bridgeId) return false;
  return jobs.some((j) => j.job_id === bridgeId);
}

function sortJobs(jobs: WorkflowRunJobRow[]): WorkflowRunJobRow[] {
  return [...jobs].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.job_id < b.job_id ? -1 : 1;
  });
}

/** Issue #4417: parse a row's attempt history; malformed history reads empty. */
function attemptsForJob(job: WorkflowRunJobRow): Array<{ attempt: number; error: string; at: string }> {
  try {
    const parsed = JSON.parse(job.attempts_json ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        attempt: Number((row as Record<string, unknown>).attempt) || 0,
        error: String((row as Record<string, unknown>).error ?? ""),
        at: String((row as Record<string, unknown>).at ?? ""),
      }));
  } catch {
    return [];
  }
}
/** Issue #4421: the payload-stamped retry lineage of a job row. Only a
 *  retry carries `retryOf`; anything else is an original attempt. */
function retryOfJob(job: WorkflowRunJobRow): string | null {
  const payload = parseObject(job.payload_json);
  return typeof payload?.retryOf === "string" && payload.retryOf ? payload.retryOf : null;
}

/**
 * Issue #4420 — the inner engine job an options feed shard dispatched, read
 * from the shard's own payload (`chain.chainId` + `shard.key`). The identity
 * is DERIVED, not stored twice: the executor defines that run under the same
 * function (shardScanRunId), so a failed shard with no result is still
 * addressable, and a non-shard row answers null rather than a guess.
 */
export function innerShardScanJobId(job: WorkflowRunJobRow): string | null {
  if (job.capability !== "shard.execute") return null;
  const payload = parseObject(job.payload_json);
  const shard = asObject(payload?.shard);
  const chain = asObject(payload?.chain);
  if (!shard || !chain) return null;
  if (shard.stage !== "feed" || chain.screenType !== "options") return null;
  const chainId = typeof chain.chainId === "string" && chain.chainId ? chain.chainId : null;
  const symbol = typeof shard.key === "string" && shard.key ? shard.key : null;
  if (!chainId || !symbol) return null;
  return shardScanJobId(chainId, symbol);
}

/** Issue #4422 — one quoted leg of a recorded best candidate. */
export interface ShardLegEvidence {
  side: string;
  optionType: string;
  quantity: number;
  strike: number | null;
  expirationDate: string | null;
  entryPrice: number | null;
  bid: number | null;
  ask: number | null;
  impliedVolatility: number | null;
  openInterest: number | null;
  volume: number | null;
}

/** Issue #4422 — one strategy type's recorded fit for the shard's symbol. */
export interface ShardStrategyEvidence {
  strategyType: string;
  evaluatedCount: number;
  passedCount: number;
  rejectedCount: number;
  rejectionReasons: Array<{ reason: string; count: number }>;
  best: {
    label: string;
    expirationDate: string | null;
    netDebit: number | null;
    maxLoss: number | null;
    maxProfit: number | null;
    maxProfitUnbounded: boolean;
    probabilityOfProfit: number | null;
    legs: ShardLegEvidence[];
    legCount: number;
  } | null;
}

/**
 * Issue #4422 — what one options feed shard recorded about its symbol.
 *
 * This is the RECORDED evidence, not the fetched chain: the shard keeps its
 * scan result (verdict, skip reason, target, fit gate, one cell per strategy
 * type, and the quoted legs of each cell's best candidate), and the full
 * fetched chain — every strike of every expiry — is not persisted at all.
 * The view says that where the owner looks; it never presents derived rows as
 * a raw chain, and never invents a symbol the record does not name.
 */
export interface ShardSymbolEvidence {
  symbol: string;
  verdict: string;
  skipReason: string | null;
  targetPrice: number | null;
  targetSource: string | null;
  targetEmUnits: number | null;
  gateBucket: string | null;
  gateReasons: string[];
  strategies: ShardStrategyEvidence[];
  /** Every strategy type the record held, before the render cap. */
  strategyTypeCount: number;
}

function legEvidence(value: unknown, cap: number): { legs: ShardLegEvidence[]; legCount: number } {
  const rows = Array.isArray(value) ? value : [];
  const legs = rows.slice(0, cap).map((row) => {
    const leg = asObject(row) ?? {};
    return {
      side: typeof leg.side === "string" ? leg.side : "",
      optionType: typeof leg.optionType === "string" ? leg.optionType : "",
      quantity: num(leg.quantity) ?? 0,
      strike: num(leg.strike),
      expirationDate: str(leg.expirationDate),
      entryPrice: num(leg.entryPrice),
      bid: num(leg.bid),
      ask: num(leg.ask),
      impliedVolatility: num(leg.impliedVolatility),
      openInterest: num(leg.openInterest),
      volume: num(leg.volume),
    };
  });
  return { legs, legCount: rows.length };
}

/**
 * Issue #4422 — the per-symbol evidence a shard's recorded result carries.
 * Null when the record holds no matrix row (a job that never reached the
 * scan, or a non-scan shard): the row then claims nothing about a symbol.
 */
export function shardSymbolEvidence(job: WorkflowRunJobRow): ShardSymbolEvidence | null {
  if (job.capability !== "shard.execute") return null;
  const result = parseObject(job.result_json);
  if (!result) return null;
  const matrix = Array.isArray(result.matrix) ? result.matrix : [];
  const row = asObject(matrix[0]);
  if (!row) return null;
  const symbol = str(row.symbol);
  if (!symbol) return null;
  const cells = Array.isArray(row.cells) ? row.cells.map((cell) => asObject(cell)).filter(Boolean) : [];
  const strategies: ShardStrategyEvidence[] = cells
    .slice(0, MAX_EVIDENCE_STRATEGIES)
    .map((cell) => {
      const best = asObject(cell!.best);
      const reasons = asObject(cell!.rejectionReasons) ?? {};
      return {
        strategyType: str(cell!.strategyType) ?? "",
        evaluatedCount: num(cell!.evaluatedCount) ?? 0,
        passedCount: num(cell!.passedCount) ?? 0,
        rejectedCount: num(cell!.rejectedCount) ?? 0,
        rejectionReasons: Object.entries(reasons)
          .slice(0, MAX_EVIDENCE_REASONS)
          .map(([reason, count]) => ({ reason, count: num(count) ?? 0 })),
        best: best
          ? {
              label: str(best.label) ?? "",
              expirationDate: str(best.expirationDate),
              netDebit: num(best.netDebit),
              maxLoss: num(best.maxLoss),
              maxProfit: num(best.maxProfit),
              maxProfitUnbounded: best.maxProfitUnbounded === true,
              probabilityOfProfit: num(best.probabilityOfProfit),
              ...legEvidence(best.legs, MAX_EVIDENCE_LEGS),
            }
          : null,
      };
    });
  return {
    symbol,
    verdict: str(row.verdict) ?? "",
    skipReason: str(row.skipReason),
    targetPrice: num(row.targetPrice),
    targetSource: str(row.targetSource),
    targetEmUnits: num(row.targetEmUnits),
    gateBucket: str(row.gateBucket),
    gateReasons: Array.isArray(row.gateReasons)
      ? row.gateReasons.filter((reason: unknown): reason is string => typeof reason === "string").slice(0, MAX_EVIDENCE_REASONS)
      : [],
    strategies,
    strategyTypeCount: cells.length,
  };
}

function stageRowsForGroup(
  jobs: WorkflowRunJobRow[],
  transitions: WorkflowRunStageTransition[],
  /** Issue #4420 — inner shard stages, keyed by the shard job row they belong to. */
  innerShardStages?: ReadonlyMap<string, { jobId: string; stages: WorkflowRunStage[] }> | null,
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
    // Issue #3811: stage terminal reasons for ALL jobs, not only
    // screening stages. A transition's reason wins; otherwise a
    // skipped/held stage carries its result's reason, and a failed
    // stage carries its coded error — so a tool run's stage says
    // WHY it ended, not just that it did.
    const jobResult = parseObject(job.result_json);
    const resultReason =
      (jobResult?.status === "skipped" || jobResult?.status === "held") &&
      typeof jobResult?.reason === "string"
        ? jobResult.reason
        : null;
    const errorCode = str(job.error_code);
    const inner = innerShardStages?.get(job.job_id);
    const evidence = shardSymbolEvidence(job);
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
      lastActivityAt: isoOrNull(job.last_activity_at) ?? null,
      attempts: attemptsForJob(job),
      jobId: job.job_id,
      retryOf: retryOfJob(job),
      ...(inner ? { innerJobId: inner.jobId, innerStages: inner.stages } : {}),
      ...(evidence ? { symbolEvidence: evidence } : {}),
      detail: job.display_name || null,
      reason: matchedTransition?.reason ?? resultReason ?? (errorCode ? codedMessage(errorCode) : null),
      error: codedStageError(job),
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
      // Issue #4421: a transition records the job that wrote it, so its id is
      // evidence. It has no retry lineage of its own.
      jobId: transition.jobId ?? null,
      retryOf: null,
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

/**
 * Issue #4359 — the engine's stage views as Workflow Runs stage rows.
 *
 * One projection, in the definition's order: the status is the units'
 * recorded roll-up (the chain surface's rule), the times are the stamps
 * the engine wrote at the unit's start and terminal transition, and the
 * duration is their difference. A stage with no stamps keeps null times
 * — this projection never invents a clock. Nothing here is a second
 * stage-read mechanism: the views come from the job-status surface.
 */
export function stagesFromEngineViews(
  views: JobStageView[],
  engineJobId: string | null = null,
): WorkflowRunStage[] {
  const statusFor: Record<string, string> = {
    completed: "completed",
    failed: "failed",
    running: "running",
    stopped: "stopped",
    cancelled: "cancelled",
    pending: "pending",
    "not-run": "pending",
  };
  return views.map((view, index) => {
    const aggregate = aggregateStageStatus([view]);
    const status = statusFor[aggregate.status] ?? "pending";
    const stage = view.kind ?? view.nodePath ?? view.stageId;
    return {
      key: view.stageId,
      order: index + 1,
      stage,
      label: stageLabel(view.kind, ""),
      status,
      recordedBy: "engine-checkpoint",
      ...(engineJobId ? { engineJobId } : {}),
      ...(view.executionMode
        ? {
            executionMode: `${view.executionMode.concurrency} · ${view.executionMode.pacing} · ${view.executionMode.delivery} · ${view.executionMode.shape}`,
          }
        : {}),
      startedAt: view.startedAt,
      finishedAt: view.endedAt,
      durationMs: view.durationMs,
      detail: view.nodePath || null,
      reason: aggregate.error,
      error: status === "failed" ? aggregate.error : null,
      capability: null,
      jobKind: null,
      channel: null,
      input: null,
      output: null,
    };
  });
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

/**
 * #2786 Part 2 (scope b): derive a human purpose title for an
 * http.request row from its actual work — never "Background job".
 *  - /market-data/compare (or its /foss alias) → a market-data
 *    comparison WITH the symbols compared, taken from body.symbols or
 *    the ?symbols= query. When the payload records no symbols, the
 *    title says so by omission — it NEVER fabricates the handler's
 *    defaults (NVDA/AAPL/MSFT) as if they were recorded.
 *  - /external-ads/impression|click → an ad beacon with its id, or
 *    the bare beacon name when no id is recorded.
 *  - any other http.request row with an empty display name → METHOD +
 *    path, so no row renders only "Background job" + an id. Rows with
 *    a meaningful display name keep it (null here).
 * Non-http.request rows always return null.
 */
export function httpRequestRunIdentity(job: WorkflowRunJobRow): { title: string } | null {
  if (job.capability !== "http.request") return null;
  const payload = parseObject(job.payload_json);
  if (!payload) return null;
  const pathAndQuery = str(payload.pathAndQuery) ?? "";
  const [pathOnly, query] = pathAndQuery.split("?");
  const method = typeof payload.method === "string" ? payload.method.toUpperCase() : "";
  const body = asObject(payload.body) ?? parseObject(payload.body);

  if (pathOnly.endsWith("/market-data/compare") || pathOnly.endsWith("/foss/compare")) {
    const fromBody = Array.isArray(body?.symbols)
      ? (body.symbols as unknown[]).filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim())
      : [];
    let symbols = fromBody;
    if (symbols.length === 0 && query) {
      const fromQuery = new URLSearchParams(query).get("symbols");
      symbols = fromQuery ? fromQuery.split(",").map((s) => s.trim()).filter(Boolean) : [];
    }
    return { title: symbols.length > 0 ? `Market data comparison — ${symbols.join(", ")}` : "Market data comparison" };
  }
  if (pathOnly.includes("/external-ads/impression")) {
    const id = str(body?.id) ?? (query ? new URLSearchParams(query).get("id") : null);
    return { title: id ? `Ad impression — ${id}` : "Ad impression beacon" };
  }
  if (pathOnly.includes("/external-ads/click")) {
    const id = str(body?.id) ?? (query ? new URLSearchParams(query).get("id") : null);
    return { title: id ? `Ad click — ${id}` : "Ad click beacon" };
  }
  // Issue #4002 (recording slice): a feed-run row's list title
  // carries the feed job id it executed — the route takes only a
  // provider id and forSource() returns the first registered job
  // for that source, so the title names the job the run actually
  // was (quotes), not just the provider. The registry's identity
  // is env-independent (env feeds cadence/stale only), so the
  // empty-knobs registry resolves the same ids. An unregistered
  // provider falls through to the existing behaviour — never an
  // invented job id. This branch fires regardless of display
  // name, like the market-data/ad branches above: feed-run rows
  // already carry a "METHOD path" display name.
  const feedRunMatch = /^\/data-providers\/([^/]+)\/feed-run$/.exec(pathOnly);
  if (feedRunMatch && method) {
    const jobId = buildFeedJobRegistry({})
      .forSource(feedRunMatch[1] as DataProviderId)?.id;
    if (jobId) return { title: `${method} ${pathOnly} — ${jobId}` };
  }
  // Issue #4002 (third slice): the per-job feed-jobs action
  // path names its job id in the path — validated by EXACT
  // catalog match, never taken on trust (resolveFeedJob's alias
  // / containing fallbacks are for copilot queries, not path
  // segments); pause / cancel fall through (no pipeline
  // execution to name).
  const feedJobsMatch =
    /^\/data-providers\/[^/]+\/feed-jobs\/([^/]+)\/(run|retry|resume)$/.exec(pathOnly);
  if (feedJobsMatch && method) {
    const jobId = FEED_PIPELINE_CATALOG.find((e) => e.jobId === feedJobsMatch[1])?.jobId;
    if (jobId) return { title: `${method} ${pathOnly} — ${jobId}` };
  }
  if (!str(job.display_name) && method && pathOnly) {
    return { title: `${method} ${pathOnly}` };
  }
  return null;
}

export function runFromJobs(
  jobs: WorkflowRunJobRow[],
  transitions: WorkflowRunStageTransition[],
  outcome?: WorkflowRunOutcomeRow,
  nowMs: number = Date.now(),
  /**
   * Issue #4359 — the engine's own stage views for this group, when the
   * run is an engine run. Present and non-empty = the checkpoint is the
   * run's stage truth; absent/empty = today's job-row projection.
   */
  engineStages?: JobStageView[] | null,
  engineJobId?: string | null,
  /**
   * Issue #4420 — the inner per-symbol engine stages of this group's
   * shards, keyed by shard job id. Only the job-row projection carries
   * them: an engine run's own stages are the run's truth.
   */
  innerShardStages?: ReadonlyMap<string, { jobId: string; stages: WorkflowRunStage[] }> | null,
): WorkflowRun {
  const main = mainJobOf(jobs);
  const family = workflowFamilyForJobs(jobs, outcome);
  const stages =
    engineStages && engineStages.length > 0
      ? stagesFromEngineViews(engineStages, engineJobId ?? null)
      : stageRowsForGroup(jobs, transitions, innerShardStages);
  // Real trigger evidence wins; an "unknown" API-channel evidence is
  // the fallback, never a mask over a job that recorded a real one.
  const evidences = jobs.map(triggerEvidence);
  const triggerEvidenceForRun =
    evidences.find((t) => t.trigger && t.trigger !== "unknown") ?? evidences.find((t) => t.trigger) ?? {};
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
  // Issue #4419: stranded = the feed stage failed as a whole AND no
  // downstream stage row exists. The absence of a downstream row is what
  // distinguishes "never planned" from "pending": a chain that already
  // recorded a generate/store/serve row is merely progressing, never labelled.
  const feedStages = stages.filter((s) => s.stage === "feed");
  const downstreamStages = stages.filter((s) => s.stage !== "feed");
  const stranded =
    Boolean(str(jobs[0]?.chain_id)) &&
    runStatus === "failed" &&
    feedStages.length > 0 &&
    feedStages.every((s) => s.status === "failed") &&
    downstreamStages.length === 0;
  // Issue #3039: the parent flow writes its collation into the main row's
  // result as `{ shardJobIds, result: <collation> }`. Read the two fields
  // the contract records; absent or malformed degrades to "not recorded".
  const mainResult = parseObject(main.result_json);
  const collation =
    mainResult && typeof mainResult.result === "object" && mainResult.result !== null
      ? (mainResult.result as Record<string, unknown>)
      : null;
  const fanoutCapReason =
    typeof collation?.fanoutCapReason === "string" && collation.fanoutCapReason
      ? collation.fanoutCapReason
      : null;
  const resumedSkippedUnits = Array.isArray(collation?.resumedSkippedUnits)
    ? collation.resumedSkippedUnits.filter((v): v is string => typeof v === "string")
    : [];

  // Issue #3811: the run's last activity — the latest heartbeat
  // across its jobs, falling back to the claim instant (started_at)
  // for rows that predate heartbeats. A running run's heartbeat age
  // is the stall evidence; a terminal run has none.
  const lastActivityAt =
    jobs
      .map((j) => isoOrNull(j.last_activity_at) ?? isoOrNull(j.started_at))
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop() ?? null;
  const heartbeatAgeMs =
    runStatus === "running" && lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))
      ? nowMs - Date.parse(lastActivityAt)
      : null;

  return {
    id: str(jobs[0]?.chain_id) ?? main.job_id,
    runId: str(jobs[0]?.chain_id) ?? main.job_id,
    workflow: FAMILY_WORKFLOW[family],
    family,
    // #2786 Part 2 (scope b): an http.request row's title names the
    // work it actually did (comparison + symbols, beacon + id, or
    // METHOD + path) — never a bare "Background job". A meaningful
    // display name is kept for already-specific rows.
    title: (main.capability === "http.request" ? httpRequestRunIdentity(main)?.title : null) ?? (main.display_name || FAMILY_WORKFLOW[family]),
    source: "job-chain",
    trigger,
    triggerDetail,
    stranded,
    triggeredBy: outcomeTrigger?.triggeredBy ?? triggerEvidenceForRun.actor ?? null,
    status: runStatus,
    // Issue #3784: Stuck is a display derivation on running +
    // flagged — a job whose stuck alert was claimed while the run
    // is still running. A terminal run is never stuck, even when
    // a claim stamp is present (the stamp predates the terminal
    // transition); an unflagged running run is just running.
    stuck:
      runStatus === "running" &&
      jobs.some((j) => typeof j.stuck_alerted_at === "string" && j.stuck_alerted_at !== ""),
    // Issue #3021: lifecycle + schedule provenance. A chain with no
    // started stage and a not-yet-due job is scheduled, not
    // in-progress — the status verb alone cannot say that, because
    // "queued" covers both due and delayed work.
    lifecycle: isDelayedRun(jobs, nowMs)
      ? "scheduled"
      : lifecycleStateForRun({ status: runStatus, stages }),
    schedule: scheduleProvenanceForJobs(jobs, trigger, nowMs),
    // Issue #4357 — the workflow instance id, read off the first
    // job payload that carries one (the bridge row stamps the
    // workflow instance it dispatched). Null when no job carries
    // it; the panel renders nothing rather than inventing one.
    workflowId:
      sortJobs(jobs)
        .map((j) => parseObject(j.payload_json)?.workflowId)
        .find((v): v is string => typeof v === "string" && v !== "") ?? null,
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    lastActivityAt,
    heartbeatAgeMs,
    stageCount: stages.length,
    completedStages: stages.filter((s) => s.status === "completed").length,
    failedStages: stages.filter((s) => s.status === "failed").length,
    stages,
    inputs: stageInputSummary(main),
    outputs: outputsForGroup(jobs, stages, outcome),
    artifacts,
    deliveryStates: outcome?.deliveryStates ?? {},
    error: firstError,
    fanoutCapReason,
    resumedSkippedUnits,
  };
}

/**
 * Issue #2786 losslessness fix: the unified-record stage conversion,
 * shared by the outcome-twin path (runFromOutcome) and the
 * report-only path (the route's second canonical read). One mapping
 * for both — a canonical body's stages render identically wherever
 * they surface, never a divergent second copy. The synthetic
 * "recording" stage is NOT added here: runFromOutcome appends it for
 * outcome twins, while a report-only run IS its canonical record and
 * keeps exactly the body's stages (or an honest empty list).
 */
export function stagesFromUnifiedStages(
  stages: UnifiedWorkflowRunRecord["stages"],
  createdAt: string,
): WorkflowRunStage[] {
  return stages.map((s, index) => ({
    key: `unified:${s.stage}`,
    order: index + 1,
    stage: s.stage,
    label: stageLabel(s.stage, ""),
    status: s.status,
    recordedBy: "unified-record" as const,
    startedAt: isoOrNull(createdAt),
    finishedAt: isoOrNull(createdAt),
    durationMs: typeof s.durationMs === "number" ? s.durationMs : null,
    detail: s.detail ?? null,
    reason: s.reason ?? null,
    error: s.error ?? null,
    capability: null,
    jobKind: null,
    channel: null,
    input: s.input ?? null,
    output: s.output ?? null,
  }));
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
            : outcome.kind === "trading"
              ? "trading"
              : "other";
  const unifiedStages: WorkflowRunStage[] = unified
    ? stagesFromUnifiedStages(unified.stages, outcome.createdAt)
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
    // Issue #3021: lifecycle from the recorded verb; schedule from
    // the trigger alone (an outcome carries no schedule identity).
    lifecycle: lifecycleStateForRun({ status, stages }),
    schedule: scheduleProvenanceForTrigger(trigger.trigger),
    startedAt: outcome.createdAt,
    finishedAt: outcome.createdAt,
    durationMs: null,
    // Issue #3811: an outcome-only run's last activity is its
    // recording instant; outcomes are terminal records, so there
    // is no heartbeat age.
    lastActivityAt: outcome.createdAt,
    heartbeatAgeMs: null,
    // Issue #3655: broker + data-provider provenance from the unified
    // canonical record when it carries them.
    ...(unified?.brokerId ? { brokerId: unified.brokerId } : {}),
    ...(unified?.dataProviderId ? { dataProviderId: unified.dataProviderId } : {}),
    // Issue #3655 (effective mode): the resolver source rides the
    // Workflow Run with the mode when the unified record carries it.
    ...(unified?.modeSource ? { modeSource: unified.modeSource } : {}),
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
    // Issue #3039: an outcome row is not a workflow collation, so neither
    // field is recorded there — absent, never invented.
    fanoutCapReason: null,
    resumedSkippedUnits: [],
  };
}

/** Issue #2786 Part 3: a run counts as a report run when it carries
 *  canonical documents, or when its outcome recorded document
 *  artifacts (report / PDF / XLSX / CSV). Used by the route's
 *  reports=only filter. Any other artifact kind does not qualify. */
export function hasReportDocuments(run: WorkflowRun): boolean {
  if (run.documents != null) return true;
  return run.artifacts.some(
    (a) => a.kind === "report" || a.kind === "pdf" || a.kind === "xlsx" || a.kind === "csv",
  );
}

/** Normalize a canonical body's recorded trigger onto WorkflowRunTrigger. */
function reportTrigger(trigger: string | null): WorkflowRunTrigger {
  const t = (trigger ?? "").trim().toLowerCase();
  if (t.startsWith("manual")) return "manual";
  // Issue #3946: the engine's own scheduled vocabulary — a job run
  // record stamps "worker-cron" for its cron-scheduled runs.
  if (t.startsWith("schedul") || t === "cron" || t === "worker-cron") return "scheduled";
  return "unknown";
}

/** Normalize a canonical row's recorded status onto WorkflowRunStatus. */
function reportStatus(status: string | null): WorkflowRunStatus {
  if (status === "completed" || status === "partial" || status === "failed") return status;
  return "unknown";
}

/**
 * Issue #2786 Part 3: a run backed ONLY by its canonical mas_reports
 * row — no job chain, no outcome twin. It carries the run's Docs
 * columns and, when the canonical body carries stages, those stages
 * (losslessness fix: a staged canonical row keeps its trace here,
 * exactly as the unified overlay keeps it for outcome twins). A
 * report with no body stages keeps an honest empty stage list: no
 * execution trace says so, exactly as an outcome-only run does. The
 * detail view must render "no stage records" for it, never inferred
 * stages.
 */
export function runFromReportDocument(input: {
  reportId: string;
  runId: string;
  title: string;
  engineFamily: WorkflowRunFamily;
  documents: WorkflowRunDocuments;
  trigger: string | null;
  status: string | null;
  createdAt: string;
  stages?: WorkflowRunStage[];
}): WorkflowRun {
  const trigger = reportTrigger(input.trigger);
  const stages = input.stages ?? [];
  return {
    id: input.runId,
    runId: input.runId,
    workflow: FAMILY_WORKFLOW[input.engineFamily],
    family: input.engineFamily,
    title: input.title,
    source: "report",
    trigger,
    triggerDetail:
      trigger === "manual"
        ? "Manual — recorded on the canonical row"
        : trigger === "scheduled"
          ? "Scheduled — recorded on the canonical row"
          : "Not recorded by the source",
    triggeredBy: null,
    status: reportStatus(input.status),
    // Issue #3021: lifecycle from the recorded verb; schedule from
    // the trigger alone (a canonical row carries no schedule id).
    lifecycle: lifecycleStateForRun({ status: reportStatus(input.status), stages }),
    schedule: scheduleProvenanceForTrigger(trigger),
    startedAt: input.createdAt,
    finishedAt: input.createdAt,
    durationMs: null,
    stageCount: stages.length,
    completedStages: stages.filter((s) => s.status === "completed").length,
    failedStages: stages.filter((s) => s.status === "failed").length,
    stages,
    inputs: {},
    outputs: { status: input.status ?? null },
    artifacts: [],
    deliveryStates: {},
    error: null,
    documents: input.documents,
    fanoutCapReason: null,
    resumedSkippedUnits: [],
  };
}

/**
 * Issue #3946 (Option B): an engine D1 job run record → a WorkflowRun.
 * The record is its own run (family "other", source "job-outcome")
 * with an honest empty stage list — the D1 row carries no per-stage
 * rows, so no stages are invented for it. Duration is recorded
 * (finished − started); the trigger is normalized through the same
 * reportTrigger as canonical rows, with the engine's "worker-cron"
 * vocabulary named in triggerDetail. Broker provenance is absent on
 * D1 rows (#3655), so brokerId stays undefined; the row is a
 * deployment-level engine run, never attributed to the signed-in
 * user. Lifecycle comes from the recorded outcome verb — a terminal
 * outcome is done.
 */
export function runFromJobRunRecord(
  record: JobRunRecord,
  /**
   * Issue #4359 — the engine's stage views for THIS run (the caller
   * matched the checkpoint's run id to the record's workflowId). Absent
   * = the record carries no stage evidence, and the row says so.
   */
  engineStages?: JobStageView[] | null,
): WorkflowRun {
  const stages =
    engineStages && engineStages.length > 0
      ? stagesFromEngineViews(engineStages, record.jobId)
      : [];
  const status: WorkflowRunStatus =
    record.outcome === "success"
      ? "completed"
      : record.outcome === "failure"
        ? "failed"
        : "skipped";
  const trigger = reportTrigger(record.trigger ?? null);
  const startedMs = Date.parse(record.started);
  const finishedMs = Date.parse(record.finished);
  return {
    id: d1JobRunRecordId(record),
    runId: d1JobRunRecordId(record),
    workflow: FAMILY_WORKFLOW["other"],
    family: "other",
    title: `Job ${record.jobId}`,
    source: "job-outcome",
    trigger,
    triggerDetail:
      record.trigger === "worker-cron"
        ? "Worker cron — the engine's scheduled trigger"
        : trigger === "manual"
          ? "Manual — recorded on the D1 run record"
          : trigger === "scheduled"
            ? "Scheduled — recorded on the D1 run record"
            : "Not recorded by the source",
    triggeredBy: record.triggeredBy ?? null,
    status,
    lifecycle: lifecycleStateForRun({ status, stages }),
    schedule: scheduleProvenanceForTrigger(trigger),
    startedAt: record.started,
    finishedAt: record.finished,
    durationMs:
      Number.isFinite(startedMs) && Number.isFinite(finishedMs)
        ? Math.max(0, finishedMs - startedMs)
        : null,
    stageCount: stages.length,
    completedStages: stages.filter((s) => s.status === "completed").length,
    failedStages: stages.filter((s) => s.status === "failed").length,
    stages,
    inputs: {},
    outputs: { status },
    artifacts: [],
    deliveryStates: {},
    error: record.outcome === "failure" ? record.error ?? null : null,
    documents: null,
    fanoutCapReason: null,
    resumedSkippedUnits: [],
  };
}

/**
 * Issue #4069 (Option B for options): a scan-run row
 * (mas_opportunity_scans) → a WorkflowRun. Scanner legs write no
 * canonical mas_reports row, so without this the scan ledger is
 * invisible on Workflow Runs — ReportsPanel and detail already merge
 * it (runSummaryFromScanRun). The row is its own run (family
 * "options", source "report") with an honest empty stage list — the
 * scan row carries no per-stage rows, so none are invented. Status
 * is "completed": a saved scan row means the scan ran to its persist
 * stage, which never fails the run (#27/#103); partial coverage
 * rides the gate summary in outputs, never a second status.
 * Documents come from the row's own pdf/xlsx/csv keys (the same
 * /api/options/report.* urls runSummaryFromScanRun builds), so the
 * Docs columns and the RunDetail fetch (by scan id, resolved as a
 * scan row) work exactly as in the Docs tab. Broker provenance comes
 * from the row's broker (#3327); absent stays absent, never
 * backfilled (#3655). The row is owner-scoped by the route (the
 * store's visibility rule); the mapper itself stamps no identity.
 */
export function runFromScanRun(scan: ScanRunSummary): WorkflowRun {
  const gate = scan.gate;
  const evaluated = scan.coverage?.evaluated ?? null;
  const trigger = reportTrigger(scan.trigger ?? null);
  const title = scan.profileRef?.name
    ? `Options scan — ${scan.mode} (${scan.profileRef.name})`
    : `Options scan — ${scan.mode}`;
  return {
    id: scan.id,
    runId: scan.id,
    workflow: FAMILY_WORKFLOW["options"],
    family: "options",
    title,
    source: "report",
    trigger,
    triggerDetail:
      trigger === "manual"
        ? "Manual — recorded on the scan run"
        : trigger === "scheduled"
          ? "Scheduled — recorded on the scan run"
          : "Not recorded by the source",
    triggeredBy: scan.userLogin ?? null,
    status: "completed",
    lifecycle: lifecycleStateForRun({ status: "completed", stages: [] }),
    schedule: scheduleProvenanceForTrigger(trigger),
    startedAt: scan.generatedAt,
    finishedAt: scan.generatedAt,
    durationMs: null,
    stageCount: 0,
    completedStages: 0,
    failedStages: 0,
    stages: [],
    inputs: {},
    outputs: {
      status: "completed",
      gate: { fit: gate?.fit ?? 0, borderline: gate?.borderline ?? 0, noFit: gate?.noFit ?? 0 },
      ...(evaluated !== null ? { evaluated } : {}),
      ...(scan.partial ? { partial: scan.partial } : {}),
    },
    artifacts: [],
    deliveryStates: {},
    error: null,
    documents: {
      reportId: scan.id,
      family: "options",
      pdfUrl: scan.pdfKey ? `/api/options/report.pdf?key=${encodeURIComponent(scan.pdfKey)}` : null,
      pdfStatus: scan.pdfKey ? "generated" : null,
      pdfError: null,
      xlsxUrl: scan.xlsxKey ? `/api/options/report.xlsx?key=${encodeURIComponent(scan.xlsxKey)}` : null,
      xlsxStatus: scan.xlsxKey ? "generated" : null,
      xlsxError: null,
      csvUrl: scan.csvKey ? `/api/options/report.csv?key=${encodeURIComponent(scan.csvKey)}` : null,
      csvStatus: scan.csvKey ? "generated" : null,
      csvError: null,
    },
    ...(scan.broker ? { brokerId: scan.broker } : {}),
    fanoutCapReason: null,
    resumedSkippedUnits: [],
  };
}

/** Newest-first ordering for run lists. Ties break by id so the order is stable. */
export function compareWorkflowRunsNewestFirst(a: WorkflowRun, b: WorkflowRun): number {
  return a.startedAt === b.startedAt ? (a.id < b.id ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1;
}

/** One audit-mapped stage row for a saga chain (the mapSagaAuditToJobs output shape). */
export interface SagaChainStageRow {
  stage: string;
  status: string;
  detail: string;
  updatedAtMs?: number;
  resultJson?: Record<string, unknown>;
}

/** Inputs for building a saga run in the Workflow Runs surface (issue #2780). */
export interface SagaChainRunInput {
  sagaId: string;
  /** Audit-mapped stage rows in audit order; empty when nothing mapped. */
  jobs: SagaChainStageRow[];
  /** The saga's own projection row, when the D1 read answered. */
  projection: {
    stage: string;
    status: string;
    detail: string;
    createdAtMs: number;
    updatedAtMs: number;
  } | null;
  triggeredBy: string | null;
  /** Issue #3810: the trigger the saga's entry carried (manual /
   *  scheduled), when the caller could evidence it. Absent = the
   *  chain stays "unknown" — the trigger is never guessed. */
  trigger?: WorkflowRunTrigger;
  /** Issue #3810: how the trigger above was evidenced. */
  triggerDetail?: string;
  /** The saga.ended outcomeCode, when an ended row exists. */
  endedCode?: string | null;
  /** The saga.ended row's timestamp, when one exists. */
  endedAtMs?: number | null;
  /** The saga.started payload fields for run inputs. */
  started?: {
    family?: string | null;
    rail?: string | null;
    runRequestId?: string | null;
  } | null;
}

function msToIso(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * Build a saga chain run for the Workflow Runs surface (issue #2780).
 * Stages come from the saga's audit rows; when the audit mapping yields
 * nothing but a projection row exists, the run shows that row's
 * submitted stage instead. When neither exists, returns null so the
 * caller skips the chain rather than fabricating a run. The trigger
 * is never guessed: it comes only from the input's carried trigger
 * (the saga entry's own trigger, issue #3810) — audit payloads and
 * projection rows carry no trigger field of their own, so without
 * one it stays "unknown" ("Not recorded by the source").
 */
export function runFromSagaChain(input: SagaChainRunInput): WorkflowRun | null {
  const { sagaId } = input;
  let stages: WorkflowRunStage[];
  if (input.jobs.length > 0) {
    stages = input.jobs.map((job, i) => {
      const at = msToIso(job.updatedAtMs);
      const failed = job.status === "failed";
      const payload = job.resultJson ?? {};
      const error = failed
        ? typeof payload.error === "string"
          ? payload.error
          : typeof payload.reason === "string"
            ? payload.reason
            : null
        : null;
      return {
        key: `${sagaId}:${job.stage}:${i}`,
        order: i,
        stage: job.stage,
        label: stageLabel(job.stage, "saga"),
        status: job.status,
        recordedBy: "stage-transition" as const,
        startedAt: at,
        finishedAt: job.status === "completed" || failed ? at : null,
        durationMs: null,
        detail: job.detail,
        reason: null,
        error,
        capability: "saga",
        jobKind: null,
        channel: null,
        input: null,
        output: compactJsonValue(payload),
      };
    });
  } else if (input.projection) {
    const p = input.projection;
    stages = [
      {
        key: `${sagaId}:projection`,
        order: 0,
        stage: p.stage,
        label: stageLabel(p.stage, "saga"),
        status: p.status,
        recordedBy: "stage-transition" as const,
        startedAt: msToIso(p.updatedAtMs),
        finishedAt: null,
        durationMs: null,
        detail: p.detail,
        reason: null,
        error: null,
        capability: "saga",
        jobKind: null,
        channel: null,
        input: null,
        output: null,
      },
    ];
  } else {
    return null;
  }
  const ended = input.endedCode ?? null;
  const status: WorkflowRunStatus = ended
    ? ended.startsWith("SUCCESS_")
      ? "completed"
      : "failed"
    : stages.some((s) => s.status === "failed")
      ? "failed"
      : "running";
  const startedAt =
    (input.projection ? msToIso(input.projection.createdAtMs) : null) ??
    stages
      .map((s) => s.startedAt)
      .filter((v): v is string => v !== null)
      .sort()[0] ??
    new Date(0).toISOString();
  const finishedAt = msToIso(input.endedAtMs);
  const firstError = stages.map((s) => s.error).find((e) => e !== null && e !== undefined) ?? null;
  const started = input.started;
  // Issue #3810: the saga uses the trigger its entry carried, when
  // the caller evidenced one — otherwise it stays "unknown", never
  // guessed. An invalid carried value is ignored.
  const sagaTrigger =
    input.trigger === "manual" || input.trigger === "scheduled"
      ? input.trigger
      : ("unknown" as const);
  // Issue #3811: the saga's last activity — the latest recorded
  // instant across its stages, projection row, and ended row.
  const lastActivityAt =
    [
      ...stages.map((s) => s.finishedAt ?? s.startedAt),
      msToIso(input.projection?.updatedAtMs),
      msToIso(input.endedAtMs),
    ]
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop() ?? null;
  const heartbeatAgeMs =
    status === "running" && lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))
      ? Date.now() - Date.parse(lastActivityAt)
      : null;
  return {
    id: sagaId,
    runId: sagaId,
    workflow: FAMILY_WORKFLOW.goal,
    family: "goal",
    title: `Saga run — ${sagaId}`,
    source: "job-chain",
    trigger: sagaTrigger,
    triggerDetail:
      sagaTrigger === "unknown"
        ? "Not recorded by the source"
        : (input.triggerDetail ?? `${triggerLabel(sagaTrigger)} — recorded on the run's job tree`),
    triggeredBy: input.triggeredBy,
    status,
    // Issue #3021: lifecycle from the recorded verb; a saga chain
    // carries no schedule evidence, so its schedule is unknown.
    lifecycle: lifecycleStateForRun({ status, stages }),
    schedule: scheduleProvenanceForTrigger(sagaTrigger),
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    lastActivityAt,
    heartbeatAgeMs,
    stageCount: stages.length,
    completedStages: stages.filter((s) => s.status === "completed").length,
    failedStages: stages.filter((s) => s.status === "failed").length,
    stages,
    inputs: started
      ? compactJsonValue({
          family: started.family ?? "goal",
          ...(started.rail ? { rail: started.rail } : {}),
          ...(started.runRequestId ? { runRequestId: started.runRequestId } : {}),
        })
      : {},
    outputs: ended ? { outcomeCode: ended } : {},
    artifacts: [],
    deliveryStates: {},
    error: firstError ?? (ended && !ended.startsWith("SUCCESS_") ? ended : null),
    // Issue #3039: a saga run is not a workflow collation.
    fanoutCapReason: null,
    resumedSkippedUnits: [],
  };
}

/** Group, attach outcomes, and merge — newest first, uncapped. The caller slices. */
function collectWorkflowRuns(input: BuildWorkflowRunsInput, includeTraces: boolean, nowMs: number = Date.now()): WorkflowRun[] {
  const jobs = includeTraces ? [...input.jobs] : input.jobs.filter((job) => !isStandaloneRequestTrace(job));
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

  // Issue #4359 — a group's engine stages are keyed by the job id that
  // owns them; the first job in the group with views wins (a wrapper
  // group carries the bridge child that dispatched the engine run).
  const engineStagesFor = (
    groupJobs: WorkflowRunJobRow[],
  ): { jobId: string; views: JobStageView[] } | undefined => {
    if (!input.engineStages || input.engineStages.size === 0) return undefined;
    for (const job of groupJobs) {
      const views = input.engineStages.get(job.job_id);
      if (views && views.length > 0) return { jobId: job.job_id, views };
    }
    return undefined;
  };

  const runs: WorkflowRun[] = [];
  for (const [key, group] of groups) {
    const jobIds = new Set(group.jobs.map((j) => j.job_id));
    // Issue #4415: a chain's serve outcome is keyed by its chain id
    // (`workflow:<chainId>:<shard>`); match it to the chain group instead of
    // letting it render as a separate singleton.
    jobIds.add(key);
    const outcome = input.outcomes.find((o) => outcomeMatchesGroup(o.id, jobIds));
    const engine = engineStagesFor(group.jobs);
    runs.push(
      runFromJobs(
        group.jobs,
        transitionsByRun.get(key) ?? [],
        outcome,
        nowMs,
        engine?.views,
        engine?.jobId ?? null,
        input.innerShardStages ?? null,
      ),
    );
  }

  for (const outcome of input.outcomes) {
    // The outcome belongs to a job-chain run when its id names one of
    // that run's jobs (directly, or via the `workflow:<jobId>:<shard>`
    // delivery id). Otherwise it IS the run.
    // Issue #4415: an outcome naming a chain (not a job) is already attached to
    // that chain's run by the group loop above; it is a twin, not a singleton.
    const isTwin =
      runs.some((run) =>
        run.stages.some((stage) => stage.recordedBy === "job" && outcomeMatchesGroup(outcome.id, new Set([stage.key]))),
      ) || outcomeMatchesGroup(outcome.id, new Set(groups.keys()));
    if (isTwin) continue;
    const ownTransitions = input.transitions.filter(
      (transition) => transition.chainId === outcome.id || transition.jobId === outcome.id,
    );
    const unified = (input.unifiedRecords ?? []).find(
      (u) => u.runId === outcome.id || (u.asyncJobId && u.asyncJobId === outcome.id),
    );
    runs.push(runFromOutcome(outcome, ownTransitions, unified));
  }

  runs.sort(compareWorkflowRunsNewestFirst);
  return runs;
}

/** Legacy wrapper: traces excluded, newest-first, sliced to limit. */
export function buildWorkflowRuns(input: BuildWorkflowRunsInput): WorkflowRun[] {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 40) || 40, 100));
  return collectWorkflowRuns(input, false).slice(0, limit);
}

/** Counts for the run list's header, computed from the returned rows. */
export function summarizeWorkflowRuns(runs: WorkflowRun[]): {
  total: number;
  completed: number;
  partial: number;
  failed: number;
  active: number;
  /** Issue #3021: runs in the scheduled lifecycle state (schedule rows + delayed runs). */
  scheduled: number;
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
  let scheduled = 0;
  for (const run of runs) {
    byTrigger[run.trigger] += 1;
    // Issue #3021: a schedule row is not an in-flight run — it counts
    // as scheduled, never as active, even though its status verb is
    // "queued". A delayed queue run is likewise scheduled, not active.
    const lifecycle = run.lifecycle ?? lifecycleStateForRun(run);
    if (lifecycle === "scheduled") {
      scheduled += 1;
      continue;
    }
    if (run.status === "completed") completed += 1;
    else if (run.status === "partial") partial += 1;
    else if (run.status === "failed") failed += 1;
    else if (run.status === "running" || run.status === "queued" || run.status === "awaiting") active += 1;
  }
  return { total: runs.length, completed, partial, failed, active, scheduled, byTrigger };
}

/**
 * Server-side run filtering (#2786 Part 2, scope e; #3021 lifecycle +
 * schedule): trigger/status/search/lifecycle/schedule apply BEFORE
 * paging, so a match past the page limit stays reachable. Mirrors the
 * panel's client-side semantics (status "active" =
 * running|queued|awaiting; search over title, run id, workflow,
 * trigger detail, error, and stage fields). Lifecycle and schedule
 * filter on the computed rollup/provenance, never the raw verb alone:
 * a delayed queued run matches lifecycle "scheduled" even though its
 * status verb is "queued".
 */
export function filterWorkflowRuns(
  runs: WorkflowRun[],
  filters: { trigger?: string; status?: string; search?: string; reportsOnly?: boolean; lifecycle?: string; schedule?: string },
): WorkflowRun[] {
  const trigger = filters.trigger && filters.trigger !== "all" ? filters.trigger : null;
  const status = filters.status && filters.status !== "all" ? filters.status : null;
  const lifecycle = filters.lifecycle && filters.lifecycle !== "all" ? filters.lifecycle : null;
  const schedule = filters.schedule && filters.schedule !== "all" ? filters.schedule : null;
  const needle = filters.search?.trim().toLowerCase() || "";
  return runs.filter((run) => {
    if (filters.reportsOnly && !hasReportDocuments(run)) return false;
    if (trigger && run.trigger !== trigger) return false;
    if (status) {
      if (status === "active") {
        if (run.status !== "running" && run.status !== "queued" && run.status !== "awaiting") return false;
      } else if (run.status !== status) {
        return false;
      }
    }
    if (lifecycle && (run.lifecycle ?? lifecycleStateForRun(run)) !== lifecycle) return false;
    if (schedule && (run.schedule?.mechanism ?? "unknown") !== schedule) return false;
    if (needle) {
      const hay = [
        run.title,
        run.runId,
        run.workflow,
        run.triggerDetail,
        run.error ?? "",
        ...run.stages.map((s) => [s.label, s.detail ?? "", s.reason ?? "", s.error ?? ""].join(" ")),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export interface WorkflowRunsPageOptions {
  /** When true, GET/HEAD read traces join the list; otherwise they are counted, not shown. */
  includeTraces?: boolean;
  trigger?: string;
  status?: string;
  search?: string;
  /** Issue #3021: lifecycle-state filter (scheduled / in-progress / done / cancelled). */
  lifecycle?: string;
  /** Issue #3021: schedule-mechanism filter (cron-trigger / queue / agent-scheduler / workflow-binding / manual / unknown). */
  schedule?: string;
  /** Clock for delayed-run evaluation (not_before vs now); defaults to Date.now(). */
  nowMs?: number;
  /** Page start over the filtered, newest-first list. Clamped 0..10000. */
  offset?: number;
  /**
   * Runs produced outside the job/outcome trees (saga chains, #2780).
   * They join BEFORE filter/slice, so a saga run obeys the same
   * filters and paging as every other run — never appended after.
   */
  extraRuns?: WorkflowRun[];
  /**
   * Canonical report documents (Part 3). When present, their columns
   * attach to twin runs and unclaimed rows mint report-only runs —
   * BEFORE filter/slice, so the reports filter and paging see them.
   */
  reportDocs?: Array<{
    documents: WorkflowRunDocuments;
    matchKeys: string[];
    stages: UnifiedWorkflowRunRecord["stages"];
    summary: {
      runId: string;
      title: string;
      trigger: string | null;
      status: string | null;
      createdAt: string;
    };
  }>;
  /** When true, only report-backed runs survive filtering. */
  reportsOnly?: boolean;
}

/**
 * The paged read model (#2786 Part 2, scope e): filter BEFORE slice,
 * then page with offset. hiddenTraceCount is the count of read traces
 * in the input window when traces are hidden (0 when shown) — the
 * toggle's visible effect, never a silent drop.
 */
export function buildWorkflowRunsPage(
  input: BuildWorkflowRunsInput & WorkflowRunsPageOptions,
): { runs: WorkflowRun[]; hiddenTraceCount: number; totalMatched: number } {
  const includeTraces = input.includeTraces === true;
  const nowMs = input.nowMs ?? Date.now();
  const all = collectWorkflowRuns(input, includeTraces, nowMs);
  if (input.extraRuns) all.push(...input.extraRuns);
  // Issue #3021: registered binding schedules join as scheduled
  // rows BEFORE filter/slice, so the lifecycle and schedule filters
  // see them exactly like any other run. Their startedAt is empty
  // (a configured schedule has no start time), so they sort after
  // timed runs and are reached via the filters.
  all.push(...bindingScheduleRows());
  // Issue #2786 Part 3: attach Docs columns to their runs (first
  // newest row wins per key), then mint report-only runs for
  // canonical rows with no job/outcome twin. A run id already
  // claimed — by a built run or an earlier report-only run — is
  // never minted twice. This runs BEFORE filter/slice so the
  // reports filter and paging both see the full list.
  if (input.reportDocs && input.reportDocs.length > 0) {
    const docByKey = new Map<string, WorkflowRunDocuments>();
    for (const entry of input.reportDocs) {
      for (const key of entry.matchKeys) {
        if (!docByKey.has(key)) docByKey.set(key, entry.documents);
      }
    }
    const runIds = new Set<string>();
    for (const run of all) {
      runIds.add(run.runId);
      const doc = docByKey.get(run.runId);
      if (doc && run.documents == null) run.documents = doc;
    }
    for (const entry of input.reportDocs) {
      if (entry.matchKeys.some((key) => runIds.has(key))) continue;
      const engineFamily = entry.documents.family === "strategy" ? "discovery" : entry.documents.family;
      const reportRun = runFromReportDocument({
        reportId: entry.documents.reportId,
        runId: entry.summary.runId,
        title: entry.summary.title,
        engineFamily,
        documents: entry.documents,
        trigger: entry.summary.trigger,
        status: entry.summary.status,
        createdAt: entry.summary.createdAt,
        stages: stagesFromUnifiedStages(entry.stages, entry.summary.createdAt),
      });
      all.push(reportRun);
      runIds.add(reportRun.runId);
    }
  }
  all.sort(compareWorkflowRunsNewestFirst);
  const hiddenTraceCount = includeTraces ? 0 : input.jobs.filter(isStandaloneRequestTrace).length;
  const filtered = filterWorkflowRuns(all, { trigger: input.trigger, status: input.status, search: input.search, reportsOnly: input.reportsOnly, lifecycle: input.lifecycle, schedule: input.schedule });
  const totalMatched = filtered.length;
  const offset = Math.max(0, Math.min(Math.floor(input.offset ?? 0) || 0, 10000));
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 40) || 40, 100));
  return { runs: filtered.slice(offset, offset + limit), hiddenTraceCount, totalMatched };
}
