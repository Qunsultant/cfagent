/**
 * Issue #992: Async jobs (submit / recover / read / execute the mas_async_jobs queue) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * AsyncJobsContext.
 *
 * Issue #2358 (#1976 step 4a): every storage statement of this
 * module now serves through the async-job ports
 * (src/data/asyncJobPorts.ts — Queue / Read / Maintenance roles,
 * composed by src/data/createAsyncJobPorts.ts over the context's
 * sql handle). This module keeps the domain logic: display-name
 * derivation, chain stamping, follow-up planning, the executor's
 * capability dispatch, and the claim's orchestration. The claim
 * itself is the port's guarded UPDATE (audit R-7: NOT
 * transaction-wrapped — serialization + the guard + the
 * rowsWritten verification are the mechanism, pinned as-is).
 */

import type { AgentContext, ScheduleOptions } from "agents";
import type { DatabaseORM } from "../../orm";
import type {
  AgentName,
  AsyncJobChannel,
  AsyncJobKind,
  AsyncJobPayload,
  AsyncJobRecord,
  AsyncJobStatus,
  AsyncJobSubmission,
  Env,
  PipelineStage,
} from "../../types";
import { recordScreeningActivity } from "../../services/screeningActivity";
import { recordJobOutcome } from "../../services/jobOutcomes";
import type { NLQSchedulingPort, NLQStockScreenPort } from "../nlq";
import { codedMessage } from "../../outcomes/outcomeAspects";
import { recordBlockingAudit } from "../../security/auditChain";
import {
  enforceServiceDispatch,
  resolveAsyncJobIdentity,
} from "../../security/serviceDispatch";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import type { MembershipStore } from "../../security/authorization";
import { executeMCPTool } from "../../mcps/openaimp";
import { recordTraceHopBestEffort } from "../../data/createMeshTracePorts";
import { childContextOfTraceparent } from "../../observability/meshTrace";
import { executeNaturalLanguageQuery } from "../nlq";
import {
  NLQ_MODE_SWITCH,
  levelsForNlq,
  nlqConfigErrorEvent,
  resolveNlqMode,
} from "../../config/nlqModes";
import { getUserDid } from "../did";
import { resolveStuckRunAlertThresholdMs } from "../../config/stuckRunAlert";
import { createAsyncJobPorts, type AsyncJobPorts } from "../../data/createAsyncJobPorts";
import { createOptionsDiscoveryPorts } from "../../data/createOptionsDiscoveryPorts";
import { createDiscoveryService } from "../../services/discoveryService";
import { buildDataProviderPorts } from "../../data/buildDataProviderPorts";
import { createFitDiscoveryRunner } from "../../services/fitDiscoveryRunner";
import {
  followupChannelLabel,
  formatLifecycleNotification,
  formatUndeliverableNotification,
  isEmailAllowed,
  planDeliveryFollowups,
  planInitialFollowups,
  planLifecycleNotifications,
  plannedDeliveryChannels,
  resolveHttpJobChain,
  resolveScreenerFollowupConfig,
  screenerKindForPath,
  screenerKindLabel,
  screenerOutcomeFromHttpJob,
  type FollowupLifecycleEvent,
  type FollowupReportResult,
  type ScreenerRunOutcome,
} from "../../services/screenerFollowups";
import { resolvePipelinePolicy, shouldNotify } from "../../services/pipelinePolicy";

/**
 * Ports the async-job functions receive from the class. Table/state
 * ownership stays in OrchestratorAgent (ensureTables/getOrm are the
 * class's own); executeAsyncJob re-enters the class's routeRequest for
 * queued HTTP jobs exactly as before.
 */
export interface AsyncJobsContext {
  env: Env;
  agentCtx: AgentContext;
  ensureTables: () => AgentContext["storage"]["sql"];
  sessionKey: () => string;
  schedule: (when: Date | number | string, callback: string, payload?: unknown, options?: ScheduleOptions) => Promise<unknown>;
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
  getOrm: () => DatabaseORM;
  routeRequest: (request: Request) => Promise<Response>;
  nlqSchedulingPort: () => NLQSchedulingPort;
  nlqStockScreenPort: () => NLQStockScreenPort;
  /** #2331 slice 2: the membership store the dispatch guard checks
   *  service identities against. The orchestrator builder supplies the
   *  KV store; a context without one denies every service dispatch
   *  (fail closed — an unverifiable service identity never runs). */
  serviceMembershipStore?: MembershipStore;
  /** Issue #2567: the stuck-running alert delivery hook. The
   *  orchestrator builder wires the Slack operator surface
   *  (postSlackText); a context without one still claims + audits
   *  the detection (async_job.stuck_detected) so a stuck run is
   *  never invisible. Invoked fire-and-forget off the read path;
   *  the implementation audits its own delivery outcome. */
  notifyStuckRun?: (info: StuckRunAlertInfo) => Promise<void>;
  /** Issue #1123: artifact lookups for followup.report jobs — the
   *  ScreenerAgent's stored PDFs, by kind and run key. */
  followupReportPort: () => {
    getStockPdf: (userLogin: string, key: string) => Promise<{ fileName: string } | null>;
    getOptionsPdf: (userLogin: string, key: string) => Promise<{ fileName: string } | null>;
  };
  /** Issue #1123 S3: channel deliveries for followup.deliver jobs. The
   *  port owns content + transport (Slack/email/webhook services); the
   *  executor owns policy (allowlist, skip) and job state. */
  followupDeliveryPort: () => {
    deliver: (input: {
      channel: AsyncJobChannel;
      userLogin: string;
      outcome: import("../../services/screenerFollowups").ScreenerRunOutcome;
      artifacts: Array<{ key: string; fileName: string }>;
    }) => Promise<{ ok: boolean; error?: string; detail?: string }>;
    /** Issue #1123 S4: text-only lifecycle notifications. */
    notify: (input: {
      channel: AsyncJobChannel;
      userLogin: string;
      text: string;
    }) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  };
}

const ASYNC_JOB_KINDS: readonly AsyncJobKind[] = ["main", "report", "delivery", "notification"];
const ASYNC_JOB_CHANNELS: readonly AsyncJobChannel[] = ["email", "slack", "webhook"];
const PIPELINE_STAGES: readonly PipelineStage[] = ["feed", "generate", "store", "serve", "deliver"];

/** The family's ports over the context's sql handle (#2358). */
function ports(ctx: AsyncJobsContext): AsyncJobPorts {
  return createAsyncJobPorts(ctx.agentCtx.storage.sql as never);
}

/**
 * Issue #2358: the family's ONE DDL home is the queue port's
 * ensureSchema (base table + session index + gate index + the
 * probed graph migration). OrchestratorAgent.ensureTables calls
 * this in place of its former inline CREATE TABLE block.
 */
export function ensureAsyncJobTables(sql: AgentContext["storage"]["sql"]): void {
  createAsyncJobPorts(sql as never).queue.ensureSchema();
}

/**
 * Issue #1123: additive job-graph migration for mas_async_jobs —
 * parent_job_id / job_kind / channel, probed and added when missing so
 * existing DO tables upgrade in place. Called from
 * OrchestratorAgent.ensureTables after the CREATE TABLE.
 * Consolidation C3 (#1277): the same probed migration adds the
 * stage-chain columns — not_before (per-stage timing), stage and
 * chain_id (stage identity) — all nullable, so legacy rows read as
 * unchained.
 *
 * @deprecated Superseded by the queue port's ensureSchema
 * (src/data/asyncJobPorts.ts, composed by
 * src/data/createAsyncJobPorts.ts) — #2358 (#1976 step 4a). Kept
 * as a delegation shim for the existing call sites and pins: it
 * runs the port's full schema ensure (base + indexes + the same
 * probed migration), which is idempotent and a no-op beyond the
 * migration on an existing table.
 */
export function ensureAsyncJobGraphColumns(sql: AgentContext["storage"]["sql"]): void {
  createAsyncJobPorts(sql as never).queue.ensureSchema();
}

/** Issue #1123: map a row's graph columns onto record fields, tolerating
 *  legacy rows (job_kind NULL/'main', no parent/channel). */
function jobGraphFields(row: Record<string, unknown>): {
  parentJobId?: string;
  jobKind: AsyncJobKind;
  channel?: AsyncJobChannel;
  stage?: PipelineStage;
  chainId?: string;
  notBefore?: string;
} {
  const kind = ASYNC_JOB_KINDS.find((k) => k === row.job_kind);
  const channel = ASYNC_JOB_CHANNELS.find((c) => c === row.channel);
  const stage = PIPELINE_STAGES.find((s) => s === row.stage);
  return {
    parentJobId: typeof row.parent_job_id === "string" && row.parent_job_id ? row.parent_job_id : undefined,
    jobKind: kind ?? "main",
    channel,
    stage,
    chainId: typeof row.chain_id === "string" && row.chain_id ? row.chain_id : undefined,
    notBefore: typeof row.not_before === "string" && row.not_before ? row.not_before : undefined,
  };
}

/** Consolidation C3 (#1277): whole seconds from now until an ISO
 *  not-before time — the arming delay for a deferred job (0 when the
 *  time has passed or is unparseable). */
function delaySecondsUntil(iso: string | undefined, nowMs: number): number {
  if (!iso) return 0;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** Consolidation C3 (#1277): record one stage transition in the
 *  screening activity log, so a chain's stages are visible per stage
 *  (with held/failed/skipped reasons) in the screening activity feed
 *  — never invisible (the #1209 anti-pattern). Recording follows the
 *  activity log's own contract: it never throws. */
function recordStageTransition(
  ctx: AsyncJobsContext,
  input: {
    userLogin?: string;
    stage: PipelineStage;
    chainId?: string;
    jobId: string;
    status: "completed" | "failed" | "skipped" | "held";
    reason?: string;
  },
): void {
  const userLogin = input.userLogin || ctx.sessionKey();
  const reasonText = input.reason ? `: ${input.reason}` : "";
  recordScreeningActivity(ctx.agentCtx.storage.sql, {
    userLogin,
    kind: "stage",
    summary: `Stage ${input.stage} ${input.status}${reasonText}`,
    detail: {
      chainId: input.chainId ?? null,
      jobId: input.jobId,
      stage: input.stage,
      status: input.status,
      reason: input.reason ?? null,
    },
    refId: input.jobId,
  });
}

export async function submitAsyncJob(ctx: AsyncJobsContext,
  job: AsyncJobSubmission,
): Promise<{ jobId: string; status: "queued"; statusUrl: string }> {
  ctx.ensureTables();
  const queue = ports(ctx).queue;
  const payloadJson = JSON.stringify(job.payload);
  if (new TextEncoder().encode(payloadJson).byteLength > 17_000_000) {
    throw new Error("Async job payload exceeds the 17 MB serialized storage limit.");
  }
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  queue.pruneTerminalBefore(ctx.sessionKey(), cutoff);
  queue.pruneTerminalToCap(ctx.sessionKey(), 500);
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  // Consolidation C4 (#1329): a generic http.request job whose payload
  // carries stageChain is submitted as its chain's generate stage —
  // the same idiom as the bridge (chainId minted when stageChain is
  // present). An explicit stage/chainId on the submission wins; a job
  // without stageChain is untouched (the degenerate case).
  const payloadStageChain = (job.payload as Record<string, unknown> | undefined)?.stageChain;
  const httpChainStage = job.capability === "http.request" && payloadStageChain && !job.stage ? "generate" : job.stage;
  const httpChainId = job.capability === "http.request" && payloadStageChain && !job.chainId ? crypto.randomUUID() : job.chainId;
  const displayName = job.displayName ?? (job.capability === "http.request"
    ? `${job.payload.method} ${job.payload.pathAndQuery.split("?")[0]}`
    : job.capability === "mcp.tool"
      ? `MCP: ${job.payload.toolName}`
      : job.capability === "nlq.execute"
        ? `NLQ: ${job.payload.query.slice(0, 100)}`
        : job.capability === "followup.report"
          ? "Generate report"
          : job.capability === "followup.deliver"
            ? "Deliver report"
            : job.capability === "followup.notify"
              ? "Notify"
              : job.capability === "shard.execute"
                ? `Shard: ${(job.payload as { shard: { stage: string; key: string } }).shard.stage}/${(job.payload as { shard: { stage: string; key: string } }).shard.key}`
                : job.capability === "feed.snapshot"
                  ? `Feed snapshot: ${((job.payload as { symbols?: Array<{ symbol?: string }> }).symbols ?? []).map((s) => s.symbol).filter(Boolean).join(", ").slice(0, 100) || "universe"}`
                  : `Task: ${(job.payload as { title?: string }).title ?? job.capability}`);
  queue.insertQueued({
    jobId,
    sessionId: ctx.sessionKey(),
    capability: job.capability,
    displayName,
    payloadJson,
    nowIso: now,
    parentJobId: job.parentJobId ?? null,
    jobKind: job.jobKind ?? "main",
    channel: job.channel ?? null,
    notBefore: job.runAt ?? null,
    stage: httpChainStage ?? null,
    chainId: httpChainId ?? null,
  });

  try {
    // Consolidation C3 (#1277): a job with a not-before time is armed
    // at the remaining delay instead of immediately — the executor
    // still refuses an early claim (defense in depth for re-arms).
    await ctx.schedule(delaySecondsUntil(job.runAt, Date.now()), "executeAsyncJob", { jobId } satisfies AsyncJobPayload, {
      idempotent: true,
      retry: { maxAttempts: 1 },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    queue.failQueued(
      jobId,
      `Could not schedule async work: ${message}`,
      new Date().toISOString(),
    );
    throw error;
  }

  ctx.audit("async_job.queued", "orchestrator", { jobId, capability: job.capability });
  return { jobId, status: "queued", statusUrl: `/api/jobs/${jobId}` };
}

export async function recoverQueuedAsyncJobs(ctx: AsyncJobsContext): Promise<void> {
  ctx.ensureTables();
  const pending = ports(ctx).read.listQueued(ctx.sessionKey());
  for (const row of pending) {
    const jobId = row.job_id;
    try {
      // Consolidation C3 (#1277): re-arm at the remaining delay — a
      // deferred stage must not fire early just because the DO
      // restarted and recovered its queue.
      await ctx.schedule(
        delaySecondsUntil(typeof row.not_before === "string" ? row.not_before : undefined, Date.now()),
        "executeAsyncJob",
        { jobId } satisfies AsyncJobPayload,
        {
          idempotent: true,
          retry: { maxAttempts: 1 },
        },
      );
    } catch (error) {
      console.error(`[OrchestratorAgent] Could not reschedule queued async job ${jobId}:`, error);
    }
  }
}

/** Issue #2567: what the stuck-running alert carries — the run's
 *  id, its kind (capability + display name), its age against the
 *  configured threshold, and its owner (the job's session scope:
 *  the per-login orchestrator instance name). */
export interface StuckRunAlertInfo {
  jobId: string;
  capability: string;
  label: string;
  ownerLogin: string;
  startedAt: string;
  ageMs: number;
  thresholdMs: number;
}

/**
 * Issue #2567: stuck-running detection on the read path (the
 * reap's own seam). A `running` row older than the configured
 * threshold (src/config/stuckRunAlert.ts; default 30 min, well
 * before the 2h reap backstop) is claimed exactly once through
 * the port's guarded markStuckAlerted — the claim stamp is what
 * makes repeated and concurrent reads safe — and the delivery
 * hook is invoked fire-and-forget so a slow or failing channel
 * can never break or delay the read. Detection is audited even
 * when no delivery hook is wired, so a stuck run is never
 * invisible. Returns true iff this call claimed + dispatched.
 *
 * Claim-first trade-off (deliberate, vs the resourceGoals
 * mark-on-success precedent): if delivery then fails, no second
 * alert fires; the delivery failure is audited by the hook
 * implementation and the runbook covers the case.
 */
export function maybeAlertStuckRunning(
  ctx: AsyncJobsContext,
  row: Record<string, unknown>,
  nowMs: number = Date.now(),
): boolean {
  if (row.status !== "running" || typeof row.started_at !== "string") return false;
  if (typeof row.stuck_alerted_at === "string" && row.stuck_alerted_at !== "") return false;
  const thresholdMs = resolveStuckRunAlertThresholdMs(ctx.env);
  if (thresholdMs <= 0) return false;
  const ageMs = nowMs - Date.parse(row.started_at);
  if (!(ageMs > thresholdMs)) return false;
  const jobId = String(row.job_id);
  const claimed = ports(ctx).queue.markStuckAlerted(jobId, new Date(nowMs).toISOString());
  if (claimed !== 1) return false;
  const info: StuckRunAlertInfo = {
    jobId,
    capability: String(row.capability),
    label: String(row.display_name),
    ownerLogin: String(row.session_id),
    startedAt: row.started_at,
    ageMs,
    thresholdMs,
  };
  ctx.audit("async_job.stuck_detected", "orchestrator", {
    jobId: info.jobId,
    capability: info.capability,
    ownerLogin: info.ownerLogin,
    ageMs: info.ageMs,
    thresholdMs: info.thresholdMs,
  });
  if (typeof ctx.notifyStuckRun === "function") {
    void Promise.resolve()
      .then(() => ctx.notifyStuckRun!(info))
      .catch(() => {
        // Delivery failures are audited by the hook itself; a
        // throwing hook must never surface on the read path.
      });
  }
  return true;
}

export function getAsyncJob(ctx: AsyncJobsContext, jobId: string): AsyncJobRecord | undefined {
  ctx.ensureTables();
  const row = ports(ctx).read.getRow(jobId, ctx.sessionKey()) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  if (row.status === "running" && typeof row.started_at === "string" &&
    Date.now() - Date.parse(row.started_at) > 2 * 60 * 60 * 1000) {
    const completedAt = new Date().toISOString();
    ports(ctx).queue.reapStaleRunning(
      jobId,
      "Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again.",
      completedAt,
    );
    return getAsyncJob(ctx, jobId);
  }
  // Issue #2567: stuck-running alert — after the reap check, so
  // an already-reaped row is never alerted; before the reap's 2h
  // by configuration (default threshold 30 min).
  maybeAlertStuckRunning(ctx, row);
  let result: unknown;
  if (typeof row.result_json === "string") {
    try {
      result = JSON.parse(row.result_json);
    } catch (error) {
      throw new Error(`Stored result for async job ${jobId} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    jobId: String(row.job_id),
    sessionId: String(row.session_id),
    capability: String(row.capability),
    label: String(row.display_name),
    status: row.status as AsyncJobStatus,
    ...jobGraphFields(row),
    result,
    responseStatus: typeof row.response_status === "number" ? row.response_status : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
  };
}

export function listAsyncJobs(ctx: AsyncJobsContext, limit = 50): AsyncJobRecord[] {
  ctx.ensureTables();
  const rows = ports(ctx).read.listRows(
    ctx.sessionKey(),
    Math.max(1, Math.min(100, Math.floor(limit))),
  ) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => {
    if (row.status === "running") {
      const updated = getAsyncJob(ctx, String(row.job_id));
      if (updated?.status === "failed") return updated;
    }
    // Consolidation C3 (#1277): the parsed result rides the list
    // record so stage projections can read a stage's terminal state
    // (skipped / held + reason). Wire consumers strip it before
    // responding, exactly as they already do for getAsyncJob-shaped
    // records. Lenient parse: one corrupt result must not take the
    // whole list down (the per-job read stays strict).
    let result: unknown;
    if (typeof row.result_json === "string") {
      try {
        result = JSON.parse(row.result_json);
      } catch {
        result = undefined;
      }
    }
    return {
      jobId: String(row.job_id),
      sessionId: String(row.session_id),
      capability: String(row.capability),
      label: String(row.display_name),
      status: row.status as AsyncJobStatus,
      ...jobGraphFields(row),
      result,
      error: typeof row.error === "string" ? row.error : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
    };
  });
}

/** Issue #1123 S4: plan + submit the lifecycle notifications for one
 *  transition. Callers wrap this so notification scheduling can never
 *  fail the job that triggered it. */
async function submitLifecycleNotifications(
  ctx: AsyncJobsContext,
  event: FollowupLifecycleEvent,
  outcome: ScreenerRunOutcome,
  mainJobId: string,
  userLogin: string,
  detail?: string,
  suppressChannels?: readonly AsyncJobChannel[],
): Promise<void> {
  const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
  for (const spec of planLifecycleNotifications(event, outcome, config, mainJobId, userLogin, detail, { suppressChannels })) {
    await submitAsyncJob(ctx, spec);
  }
}

/**
 * Issue #1123 S5a: the bridge for screener runs that did NOT execute
 * as async jobs (synchronous route executions, scheduled runs).
 * Records the run as a completed main-job row (capability
 * 'screener.run', visible in the jobs panel like any other job) and
 * submits the standard chain — report sub-job + completion/failure
 * notifications — so every completion source produces the same tree.
 * 'started' notifications are not emitted retroactively.
 */
export async function recordScreenerRunMainJob(
  ctx: AsyncJobsContext,
  outcome: ScreenerRunOutcome,
  userLogin: string,
  options?: { chainReport?: boolean },
): Promise<string> {
  ctx.ensureTables();
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const kindLabel = screenerKindLabel(outcome.kind);
  const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
  const displayName = `${kindLabel} screen${scope ? ` — ${scope}` : ""}`;
  // Consolidation C3 (#1277): with a stage chain on the outcome, the
  // run's main job IS the chain's generate stage — stamped with the
  // stage + a fresh chain id the serve/deliver stages link back to.
  const chainId = outcome.stageChain ? crypto.randomUUID() : undefined;
  ports(ctx).queue.insertTerminal({
    jobId,
    sessionId: ctx.sessionKey(),
    capability: "screener.run",
    displayName,
    status: outcome.success ? "completed" : "failed",
    payloadJson: JSON.stringify({ outcome, userLogin }),
    resultJson: JSON.stringify({
      status: outcome.success ? "completed" : "failed",
      kind: outcome.kind,
      trigger: outcome.trigger,
      matchedCount: outcome.matchedCount,
      totalScanned: outcome.totalScanned,
      reportUrl: outcome.reportUrl,
      // Options run-record fix: the stage output names every artifact the run
      // produced, not just the PDF — the artifact set is the run's
      // evidence on the ledger.
      pdfKey: outcome.pdfKeys?.[0],
      xlsxKey: outcome.xlsxKey,
      csvKey: outcome.csvKey,
      bridged: true,
    }),
    error: outcome.success ? null : outcome.error ?? null,
    nowIso: now,
    jobKind: "main",
    stage: chainId ? "generate" : null,
    chainId: chainId ?? null,
  });
  ctx.audit("screener.run_bridged", "orchestrator", { jobId, kind: outcome.kind, success: outcome.success });
  // Issue #1333: every bridged run lands in the job-outcome sink
  // Autopilot Control renders as its job feed. The id is the run's
  // deliveryId when one exists (shared with any bus re-record, so a
  // run recorded twice converges to one row), else this main job's
  // id. Never throws: a sink failure must not fail the run.
  try {
    recordJobOutcome(ctx.ensureTables(), {
      id: outcome.deliveryId ?? jobId,
      kind: outcome.kind,
      trigger: outcome.trigger,
      status: outcome.success ? "completed" : "failed",
      scanned: outcome.totalScanned,
      matched: outcome.matchedCount,
      codedError: outcome.success ? undefined : outcome.error ?? undefined,
      reportUrl: outcome.reportUrl,
      pdfKey: outcome.pdfKeys?.[0],
      xlsxKey: outcome.xlsxKey,
      csvKey: outcome.csvKey,
      origin: "job-tree",
      createdAt: now,
    });
  } catch (err) {
    console.warn("[AsyncJobs] job outcome record failed:", err instanceof Error ? err.message : String(err));
  }
  if (chainId) {
    recordStageTransition(ctx, {
      userLogin,
      stage: "generate",
      chainId,
      jobId,
      status: outcome.success ? "completed" : "failed",
      reason: outcome.success ? undefined : outcome.error,
    });
  }
  const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
  // chainReport=false covers sources whose report delivery lives on
  // another sanctioned path (scheduled options, #223): the run is
  // recorded + notified, never double-delivered.
  let reportChained = false;
  if (options?.chainReport !== false) {
    const initialSpecs = planInitialFollowups(
      outcome,
      config,
      jobId,
      userLogin,
      chainId ? { chainId, nowIso: now } : undefined,
    );
    reportChained = initialSpecs.length > 0;
    for (const spec of initialSpecs) {
      await submitAsyncJob(ctx, spec);
    }
  }
  // Issue #1228 (#1209 F2): when the report chain will run, the
  // delivery carries the completion message — suppress the text-only
  // 'completed' notify on the delivery channels. Unchained runs
  // (scheduled options) keep theirs: it is their only notice.
  const suppressChannels = reportChained ? plannedDeliveryChannels(outcome, config) : undefined;
  await submitLifecycleNotifications(ctx, outcome.success ? "completed" : "failed", outcome, jobId, userLogin, undefined, suppressChannels);
  return jobId;
}

/** Route/scheduler-facing alias: bridge one finished run end-to-end.
 *  chainReport=false records + notifies without the report chain
 *  (sources whose delivery lives on another sanctioned path). */
export async function scheduleScreenerFollowups(
  ctx: AsyncJobsContext,
  outcome: ScreenerRunOutcome,
  userLogin: string,
  chainReport?: boolean,
): Promise<void> {
  await recordScreenerRunMainJob(ctx, outcome, userLogin, { chainReport: chainReport !== false });
}

/**
 * Consolidation C3 (#1277, #1236 per-stage retry): resubmit a FAILED
 * job from its recorded payload — the retried stage reuses its
 * recorded inputs verbatim and the executor's existing completion
 * hooks resume the chain from it. No upstream job is re-executed;
 * the failed row stays failed (the failure record is kept), and the
 * retry carries `retryOf` in its payload plus the original's stage /
 * chain identity. A second retry while an earlier retry is queued,
 * running, or completed is refused, so a stage is never delivered
 * twice by double-clicking retry.
 */
export async function retryAsyncJob(
  ctx: AsyncJobsContext,
  jobId: string,
): Promise<{ jobId: string; status: "queued"; statusUrl: string }> {
  ctx.ensureTables();
  const row = ports(ctx).read.getRetrySource(jobId, ctx.sessionKey()) as unknown as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new Error(`Async job ${jobId} was not found in this session.`);
  }
  if (row.status !== "failed") {
    throw new Error(`Only a failed job can be retried; job ${jobId} is ${String(row.status)}.`);
  }
  const prior = ports(ctx).read.listSessionPayloads(ctx.sessionKey()) as unknown as Array<Record<string, unknown>>;
  for (const candidate of prior) {
    if (candidate.job_id === jobId) continue;
    if (!["queued", "running", "completed"].includes(String(candidate.status))) continue;
    try {
      const parsed = JSON.parse(String(candidate.payload_json)) as { retryOf?: unknown };
      if (parsed?.retryOf === jobId) {
        throw new Error(
          `Job ${jobId} was already retried as job ${String(candidate.job_id)} (status ${String(candidate.status)}); refusing a duplicate retry.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("already retried")) throw error;
      // An unparseable sibling payload cannot be a retry of this job.
    }
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  } catch {
    throw new Error(`Stored payload for async job ${jobId} is invalid JSON; it cannot be retried.`);
  }
  payload.retryOf = jobId;
  const graph = jobGraphFields(row);
  const submission = {
    capability: String(row.capability),
    payload,
    displayName: String(row.display_name),
    parentJobId: graph.parentJobId,
    jobKind: graph.jobKind,
    channel: graph.channel,
    stage: graph.stage,
    chainId: graph.chainId,
  } as unknown as AsyncJobSubmission;
  const submitted = await submitAsyncJob(ctx, submission);
  ctx.audit("async_job.retried", "orchestrator", { jobId, retryJobId: submitted.jobId, capability: String(row.capability) });
  return submitted;
}

export async function executeAsyncJob(ctx: AsyncJobsContext, { jobId }: AsyncJobPayload): Promise<void> {
  ctx.ensureTables();
  const family = ports(ctx);
  // Consolidation C3 (#1277): the not-before guard — a deferred stage
  // job whose alarm fired early (recovery re-arm, duplicate fire) is
  // re-armed for the remainder instead of being claimed early. A
  // stage never runs before its time.
  const preRow = family.read.getExecutionState(jobId, ctx.sessionKey());
  if (preRow?.status === "queued" && typeof preRow.not_before === "string") {
    const remainingSeconds = delaySecondsUntil(preRow.not_before, Date.now());
    if (remainingSeconds > 0) {
      await ctx.schedule(remainingSeconds, "executeAsyncJob", { jobId } satisfies AsyncJobPayload, {
        idempotent: true,
        retry: { maxAttempts: 1 },
      });
      return;
    }
  }
  const now = new Date().toISOString();
  // THE CLAIM (audit R-7, #2358): the queue port's guarded UPDATE —
  // claim iff still queued. NOT transaction-wrapped, by ruling:
  // serialization + the guard + this verification are the
  // mechanism. false here is the honest not-claimed outcome.
  if (!family.queue.claim(jobId, ctx.sessionKey(), now)) return;

  const job = family.read.getClaimed(jobId, ctx.sessionKey());
  if (!job) throw new Error(`Async job ${jobId} disappeared after it was claimed.`);
  // Consolidation C3 (#1277): stage identity for transition recording
  // (in scope for both the completion and failure paths below).
  const jobStage = PIPELINE_STAGES.find((s) => s === job.stage);
  const jobChainId = typeof job.chain_id === "string" && job.chain_id ? job.chain_id : undefined;
  let jobUserLogin: string | undefined;
  try {
    const parsed = JSON.parse(job.payload_json) as { userLogin?: unknown };
    if (typeof parsed?.userLogin === "string") jobUserLogin = parsed.userLogin;
  } catch {
    jobUserLogin = undefined;
  }

  try {
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    let result: unknown;
    let responseStatus: number | undefined;

    // #2331 slice 2: dispatch enforcement, fail closed. The guard runs
    // before any capability leg, so a denied job never reaches a tool,
    // a route, or a start notification. A denial throws into the catch
    // below, which marks the job failed and audits async_job.failed;
    // the dispatch_denied audit here records the decision itself.
    // Broker enforcement for async jobs is identity-only at this seam:
    // per-capability broker flags are not derivable from the job row,
    // so broker-attached service work is denied at the callback seams
    // (where needsBroker is known) and service-tier jobs never carry a
    // token (none exists), so broker legs fail closed downstream.
    const serviceLogin = getServiceUserLogin(ctx.env);
    const identity = resolveAsyncJobIdentity(
      payload,
      (payload.headers ?? null) as Record<string, string> | null,
      ctx.sessionKey(),
      serviceLogin,
    );
    if ("denied" in identity) {
      ctx.audit("async_job.dispatch_denied", "orchestrator", {
        jobId,
        capability: job.capability,
        reason: identity.reason,
      });
      throw new Error(`Async job dispatch denied: ${identity.reason}`);
    }
    if (identity.kind === "service") {
      const store = ctx.serviceMembershipStore;
      const decision = store
        ? await enforceServiceDispatch(store, {
            serviceLogin: serviceLogin ?? identity.login,
            tier: "platform",
            nowMs: Date.now(),
          })
        : {
            denied: true as const,
            reason: "SERVICE_NOT_PROVISIONED" as const,
            detail: "no membership store on the execution context",
          };
      if ("denied" in decision) {
        ctx.audit("async_job.dispatch_denied", "orchestrator", {
          jobId,
          capability: job.capability,
          reason: decision.reason,
          ...(decision.detail ? { detail: decision.detail } : {}),
        });
        throw new Error(`Async job dispatch denied: ${decision.reason}`);
      }
    }

    // Issue #1123 S4: a screener main job announces its start on Slack
    // + email as tracked notification sub-jobs. Planned exactly once —
    // only the executor that won the claim reaches this point.
    if (job.capability === "http.request") {
      const kind = screenerKindForPath(typeof payload.pathAndQuery === "string" ? payload.pathAndQuery : "");
      if (kind) {
        try {
          const startHeaders = (payload.headers ?? {}) as Record<string, unknown>;
          const startUserLogin = typeof startHeaders["x-user-login"] === "string" ? startHeaders["x-user-login"] : ctx.sessionKey();
          await submitLifecycleNotifications(
            ctx,
            "started",
            { kind, trigger: "manual", success: true, pdfKeys: [] },
            jobId,
            startUserLogin,
          );
        } catch (notifyError) {
          console.error(`[OrchestratorAgent] Start notification scheduling failed for job ${jobId}:`, notifyError);
        }
      }
    }

    if (job.capability === "http.request") {
      const pathAndQuery = String(payload.pathAndQuery || "");
      const method = String(payload.method || "GET");
      const headers = new Headers(payload.headers as HeadersInit);
      // Issue #1123: the harmonization seam — a route executed as a job
      // can see its main-job id and defer follow-ups (report, delivery,
      // notifications) to the tracked pipeline instead of firing its
      // own untracked publishers.
      headers.set("x-async-job-id", jobId);
      const body = typeof payload.body === "string" ? payload.body : undefined;
      const response = await ctx.routeRequest(new Request(new URL(pathAndQuery, "https://agent.internal"), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
      }));
      const responseBody = await response.text();
      if (new TextEncoder().encode(responseBody).byteLength > 5_000_000) {
        throw new Error("Async API response exceeds the 5 MB job-result limit.");
      }
      responseStatus = response.status;
      result = {
        body: responseBody,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } else if (job.capability === "mcp.tool") {
      // #2428 (Agent Mesh S17): the execution hop — recorded when
      // the job's payload carries the turn's stamped traceparent;
      // an unstamped job executes untraced (the recorded break),
      // never under a minted-after-the-fact trace.
      const traceChild = childContextOfTraceparent(payload.traceparent);
      if (traceChild) {
        const executeHop: import("../../data/meshTracePorts").MeshTraceHop = {
          traceId: traceChild.traceId,
          spanId: traceChild.spanId,
          parentSpanId: traceChild.parentSpanId,
          kind: "job-execute",
          operation: String(payload.toolName || ""),
          timestampMs: Date.now(),
          caller:
            typeof payload.actingLogin === "string" ? payload.actingLogin : undefined,
          jobId,
        };
        await recordTraceHopBestEffort(ctx.env, executeHop);
      }
      const toolName = String(payload.toolName || "");
      const args = (payload.arguments || {}) as Record<string, unknown>;
      result = await executeMCPTool(toolName, args, {
        env: ctx.env,
        orm: ctx.getOrm(),
        sessionId: ctx.sessionKey(),
        audit: (type, agent, detail) => ctx.audit(type, agent, detail),
        // #1744: job-executor call — the external gate already ran
        // at queue time for /mcp-queued jobs; this gate is the
        // second layer at execution time.
        principal: { kind: "system", login: null },
        // #2341 (Agent Mesh S5): re-supply the acting identity the
        // turn adapter stamped into this job's payload at queue
        // time (server-side only — a payload without the stamp
        // resolves to no identity, and identity-gated tools fail
        // closed). The stamp is payload data, so it is re-read per
        // call rather than captured.
        actingLogin: () =>
          typeof payload.actingLogin === "string" ? payload.actingLogin : undefined,
        // #2428 (Agent Mesh S17): re-supply the traceparent the
        // turn adapter stamped into this job's payload at queue
        // time (server-side only — a payload without the stamp
        // resolves to no trace, and the execution records no
        // trace hops rather than fabricating one).
        traceparent: () =>
          typeof payload.traceparent === "string" ? payload.traceparent : undefined,
        // Issue #1686: async-job MCP scans capture like turn-tool scans.
        // The scan mechanism itself is executing-pinned via the MCP leg
        // pin; this literal is source-pinned below (see the pin file).
        storage: ctx.agentCtx.storage,
      });
    } else if (job.capability === "task.draft") {
      result = {
        taskId: `task_${crypto.randomUUID().slice(0, 8)}`,
        status: "draft",
        requiresConfirmation: true,
        ...payload,
        message: "Task draft created. Awaiting human confirmation.",
      };
    } else if (job.capability === "followup.report") {
      // Issue #1123 S2: secure the run's report artifact for the
      // pipeline. The run generates the PDF once (inside the screening
      // pipeline); this sub-job verifies and adopts the stored artifact
      // so S3's deliveries all share the same bytes. A failed run
      // generation completes as 'skipped' with the reason — never a
      // stale-PDF fallback (the #822 honesty rule).
      const outcome = payload.outcome as import("../../services/screenerFollowups").ScreenerRunOutcome;
      const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
      if (!outcome || typeof outcome !== "object") throw new Error("followup.report job requires an outcome payload.");
      if (outcome.pdfStatus === "failed") {
        result = { status: "skipped", reason: codedMessage("FAILURE_REPORT_PDF_GENERATION", outcome.pdfError || undefined) };
      } else if (outcome.canonicalReportId) {
        // Consolidation C4 (#1329): serve's schedulable content for
        // runs whose artifact is a canonical row (discovery, goal) —
        // verify the row exists via the serve stage. A missing row
        // fails the serve job explicitly (the chain's stop point),
        // exactly like a missing PDF key below.
        const { serveReportStage } = await import("../../services/unifiedReportPipeline");
        const checked = await serveReportStage({
          canonicalReportId: outcome.canonicalReportId,
          findCanonicalReport: (id: string) => ctx.getOrm().reports.findById(id),
        });
        if (!checked.verified) {
          throw new Error(codedMessage("FAILURE_REPORT_ARTIFACT_MISSING", checked.reason));
        }
        result = { status: "ready", artifacts: [], canonicalReportId: outcome.canonicalReportId };
      } else if (!outcome.pdfKeys || outcome.pdfKeys.length === 0) {
        result = { status: "skipped", reason: codedMessage("FAILURE_REPORT_ARTIFACT_MISSING", "The run produced no report artifact key.") };
      } else {
        const port = ctx.followupReportPort();
        const artifacts: Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" | "csv" }> = [];
        const missing: string[] = [];
        for (const key of outcome.pdfKeys) {
          const pdf = outcome.kind === "stock"
            ? await port.getStockPdf(userLogin, key)
            : await port.getOptionsPdf(userLogin, key);
          if (pdf) artifacts.push({ key, fileName: pdf.fileName, kind: "pdf" });
          else missing.push(key);
        }
        if (artifacts.length === 0) {
          throw new Error(codedMessage("FAILURE_REPORT_ARTIFACT_MISSING", `Report artifact(s) referenced by the run are missing from storage: ${missing.join(", ")}`));
        }
        // Issue #1191 (#1173 R3): adopt the run's XLSX alongside the
        // PDF so deliveries carry text + PDF + XLSX. persistRun only
        // stamps the key after a successful store, so the outcome's
        // word is the adoption evidence (the delivery port's byte
        // fetch is the verification — a missing XLSX is reported in
        // the delivery detail, never fabricated). A failed XLSX
        // generation is recorded on the result, not silent.
        let xlsxNote: string | undefined;
        if (outcome.xlsxKey && outcome.xlsxStatus !== "failed") {
          artifacts.push({ key: outcome.xlsxKey, fileName: "screener-report.xlsx", kind: "xlsx" });
        } else if (outcome.xlsxStatus === "failed") {
          xlsxNote = codedMessage("FAILURE_REPORT_XLSX_GENERATION", outcome.xlsxError || undefined);
        }
        // Issue #1346: adopt the run's CSV on the same terms as the
        // XLSX (outcome's word is the evidence; the delivery port's
        // byte fetch verifies). perFormat records each format's
        // adoption so a missing format is visible, not silent.
        let csvNote: string | undefined;
        if (outcome.csvKey && outcome.csvStatus !== "failed") {
          artifacts.push({ key: outcome.csvKey, fileName: "screener-report.csv", kind: "csv" });
        } else if (outcome.csvStatus === "failed") {
          csvNote = codedMessage("FAILURE_REPORT_PDF_GENERATION", outcome.csvError || undefined);
        }
        const perFormat: Record<string, string> = {
          pdf: artifacts.some((a) => a.kind === "pdf") ? "adopted" : "missing",
          xlsx: outcome.xlsxKey && outcome.xlsxStatus !== "failed"
            ? "adopted"
            : outcome.xlsxStatus === "failed"
              ? "failed"
              : "missing",
          csv: outcome.csvKey && outcome.csvStatus !== "failed"
            ? "adopted"
            : outcome.csvStatus === "failed"
              ? "failed"
              : "missing",
        };
        result = { status: "ready", artifacts, missingKeys: missing, perFormat, ...(xlsxNote ? { xlsxNote } : {}), ...(csvNote ? { csvNote } : {}) };
        // Issue #2091: sharded options runs produced blobs but no
        // record — the serve stage now writes the canonical row +
        // history row so Docs and Reports can list the run. Record
        // failures warn inside the helper and never fail the job.
        if (outcome.kind === "options" && outcome.timestamp) {
          const { recordOptionsServeReport } = await import("../../services/optionsServeRecord");
          await recordOptionsServeReport(
            { orm: ctx.getOrm() as never, storage: ctx.agentCtx.storage },
            { ...outcome, userLogin },
          );
        }
      }
    } else if (job.capability === "followup.deliver") {
      // Issue #1123 S3: deliver the shared report artifact on one
      // channel. Policy lives here (skip passthrough, the Assessment's
      // email allowlist); transport lives behind the delivery port.
      const channel = payload.channel as AsyncJobChannel;
      const outcome = payload.outcome as import("../../services/screenerFollowups").ScreenerRunOutcome;
      const artifacts = (payload.artifacts ?? []) as Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" | "csv" }>;
      const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
      // Issue #1191 (#1173 R3): the pipeline policy gates deliveries
      // per channel + event — an operator's explicit off switch
      // completes the job as 'skipped' with the reason recorded,
      // instead of the pre-R3 behavior where coverage depended on
      // incidental config.
      const pipelinePolicy = resolvePipelinePolicy(ctx.env as unknown as Record<string, unknown>);
      if (typeof payload.skipReason === "string" && payload.skipReason) {
        // Issue #1228 (#1209 F2): the 'completed' notify job was
        // suppressed on this channel because the delivery was to be
        // the completion message — so a delivery that has nothing to
        // attach must still SPEAK (completion text + the reason) or
        // the channel hears nothing about a completed run. Policy
        // gates it exactly like a completed notification; best-effort.
        let noticeSent = false;
        if (channel !== "webhook" && shouldNotify(pipelinePolicy, "completed", channel)) {
          try {
            const notice = await ctx.followupDeliveryPort().notify({
              channel,
              userLogin,
              text: formatUndeliverableNotification(outcome, payload.skipReason),
              ...(channel === "email" && outcome.emailTo ? { emailTo: outcome.emailTo } : {}),
              ...(channel === "slack" && outcome.slackChannel ? { slackChannel: outcome.slackChannel } : {}),
            });
            noticeSent = notice.ok;
          } catch (noticeError) {
            console.warn("[asyncJobs] undeliverable-notice failed:", noticeError instanceof Error ? noticeError.message : String(noticeError));
          }
        }
        result = { status: "skipped", reason: payload.skipReason, channel, noticeSent };
      } else if (!shouldNotify(pipelinePolicy, "completed", channel)) {
        result = { status: "skipped", reason: `Pipeline policy disables completed-run deliveries on ${channel}.`, channel };
      // Issue #1347 (owner ruling 2026-10-24, reversing #277 for
      // RUN deliveries): screener follow-up deliveries send
      // immediately — no confirmation hold, no held announcement.
      // The research-report dispatch gate is untouched: it lives
      // in reportDispatch / the reports routes, not this executor.
      } else {
        if (channel === "email") {
          const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
          // Per-task override wins over the env recipient (S5b); the
          // allowlist applies to the effective recipient either way.
          const to = outcome.emailTo ?? config.channels.email.to;
          if (!to) throw new Error("Email delivery is not configured (SCREENER_EMAIL_TO is unset).");
          if (!isEmailAllowed(config, to, outcome)) {
            throw new Error(codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", `recipient ${to}`));
          }
        }
        const delivery = await ctx.followupDeliveryPort().deliver({ channel, userLogin, outcome, artifacts });
        if (!delivery.ok) throw new Error(codedMessage("FAILURE_DELIVERY_CHANNEL_FAILED", delivery.error || `Delivery via ${channel} failed.`));
        // Issue #2178 (Q7 S2): the delivery claim is consequential —
        // audit it through the blocking helper before the job can
        // complete as sent. A throwing store propagates to the
        // executor's catch, which marks the job failed: the recipient
        // may already hold the artifact, but the system never reports
        // an unrecorded delivery as success.
        recordBlockingAudit(ctx.getOrm().events, {
          id: crypto.randomUUID(),
          sessionId: userLogin,
          type: "followup.delivered",
          agent: "orchestrator",
          payload: { jobId, channel, userLogin, detail: delivery.detail },
          createdAt: new Date().toISOString(),
        });
        result = { status: "sent", channel, detail: delivery.detail };
      }
    } else if (job.capability === "followup.notify") {
      // Issue #1123 S4: one lifecycle notification on one channel.
      // Text-only; the email allowlist applies exactly as for
      // deliveries (Assessment cross-channel rule).
      const channel = payload.channel as AsyncJobChannel;
      const event = payload.event as FollowupLifecycleEvent;
      const outcome = payload.outcome as ScreenerRunOutcome;
      const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
      // Issue #1191 (#1173 R3): pipeline policy gate, mirroring the
      // deliver branch — a policy-off event/channel completes as
      // 'skipped' with the reason on the job, never a silent drop.
      const notifyPolicy = resolvePipelinePolicy(ctx.env as unknown as Record<string, unknown>);
      if (!shouldNotify(notifyPolicy, event, channel)) {
        result = { status: "skipped", reason: `Pipeline policy disables ${event} notifications on ${channel}.`, channel, event };
      } else {
      if (channel === "email") {
        const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
        // Issue #1191: per-task recipient wins (mirrors deliveries);
        // the allowlist applies to the effective recipient.
        const to = outcome.emailTo ?? config.channels.email.to;
        if (!to) throw new Error("Email notification is not configured (SCREENER_EMAIL_TO is unset).");
        if (!isEmailAllowed(config, to, outcome)) {
          throw new Error(codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", `notification recipient ${to}`));
        }
      }
      const text = formatLifecycleNotification(
        event,
        outcome,
        typeof payload.detail === "string" ? payload.detail : undefined,
      );
      const sent = await ctx.followupDeliveryPort().notify({
        channel,
        userLogin,
        text,
        ...(channel === "email" && outcome.emailTo ? { emailTo: outcome.emailTo } : {}),
        ...(channel === "slack" && outcome.slackChannel ? { slackChannel: outcome.slackChannel } : {}),
      });
      if (!sent.ok) throw new Error(sent.error || `Notification via ${channel} failed.`);
      result = { status: "notified", channel, event };
      }
    } else if (job.capability === "shard.execute") {
      // Issue #1355: one shard of a sharded scheduled screen. The
      // executor owns policy + job state; the handler owns the
      // shard's work (providers, pipeline, store seams).
      const { executeShardJob } = await import("../../services/shardExecutors");
      const { ETradeService } = await import("../../services/etrade");
      const shardPayload = payload as unknown as import("../../services/shardJobs").ShardPayload;
      result = await executeShardJob(
        {
          sql: ctx.agentCtx.storage.sql,
          env: ctx.env as unknown as Record<string, unknown>,
          orm: ctx.getOrm(),
          storage: ctx.agentCtx.storage,
          createETradeService: (userLogin, environment) =>
            new ETradeService(ctx.getOrm(), ctx.env, userLogin, environment),
          sessionId: ctx.sessionKey(),
        },
        shardPayload
      );
    } else if (job.capability === "feed.snapshot") {
      // Consolidation #1236 (feed seam): the feed stage job. The
      // executor owns job state; the handler owns the work
      // (providers, producer, store seams) — the shard.execute idiom.
      const { executeFeedSnapshotJob } = await import("../../services/feedSnapshotJob");
      const { ETradeService } = await import("../../services/etrade");
      const feedPayload = payload as unknown as import("../../services/feedSnapshotJob").FeedSnapshotJobPayload;
      result = await executeFeedSnapshotJob(
        {
          sql: ctx.agentCtx.storage.sql,
          env: ctx.env as unknown as Record<string, unknown>,
          orm: ctx.getOrm(),
          createETradeService: (userLogin, environment) =>
            new ETradeService(ctx.getOrm(), ctx.env, userLogin, environment),
          sessionId: ctx.sessionKey(),
        },
        feedPayload
      );
    } else if (job.capability === "nlq.execute") {
      const query = String(payload.query || "").trim();
      if (!query) throw new Error("NLQ job requires a non-empty query.");
      // #1722: NLQ_MODE, run (payload `mode`) > session > user
      // (payload scopedNlqModes, set by the job submitter) > global
      // env > built-in "rest". An invalid winning value fails closed
      // to "rest" and is logged + audited as nlq.config_error.
      // "rest" (default) is the pre-#1722 async contract verbatim —
      // scheduling, stock screen, discovery + fit runners, stores
      // (the async context binds NO social port, in either mode, so
      // async NLQ can never set a social brief). "mcp" is the
      // MCP-direct shape — the full function with NO options (no
      // ports, no stores, no runners). Identity is not switched:
      // payload userLogin / session key in both modes.
      const jobUserLoginForNlq = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
      const resolvedNlqMode = resolveNlqMode(
        levelsForNlq(
          (payload as { scopedNlqModes?: { session?: unknown; user?: unknown } }).scopedNlqModes,
          (payload as { mode?: unknown }).mode,
          (ctx.env as unknown as Record<string, unknown> | undefined)?.[NLQ_MODE_SWITCH]
        )
      );
      if (resolvedNlqMode.invalid) {
        console.error(
          `[nlq] invalid ${NLQ_MODE_SWITCH} value ${JSON.stringify(resolvedNlqMode.raw)} — failing closed to "rest"`
        );
        ctx.audit(nlqConfigErrorEvent(), "orchestrator", {
          setting: NLQ_MODE_SWITCH,
          value: resolvedNlqMode.raw ?? "",
          resolved: "rest",
        });
      }
      // #2303: ports for the REST-mode discovery runner (the
      // mcp mode takes no options, unchanged).
      const nlqDpPorts =
        resolvedNlqMode.mode === "mcp" ? null : await buildDataProviderPorts(ctx.env);
      result = resolvedNlqMode.mode === "mcp"
        ? await executeNaturalLanguageQuery(
            ctx.getOrm(),
            ctx.sessionKey(),
            query,
            ctx.env,
            jobUserLoginForNlq,
            getUserDid(ctx.sessionKey()),
          )
        : await executeNaturalLanguageQuery(
            ctx.getOrm(),
            ctx.sessionKey(),
            query,
            ctx.env,
            jobUserLoginForNlq,
            getUserDid(ctx.sessionKey()),
            { scanRunStore: createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, profileStore: createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).strategyProfiles, schedulingPort: ctx.nlqSchedulingPort(), stockScreenPort: ctx.nlqStockScreenPort(), discoveryRunner: createDiscoveryService({ env: ctx.env, userLogin: jobUserLoginForNlq, orm: ctx.getOrm(), sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, ...(nlqDpPorts?.config ? { configPort: nlqDpPorts.config } : {}), ...(nlqDpPorts?.captures ? { capturePort: nlqDpPorts.captures } : {}) }), fitDiscoveryRunner: createFitDiscoveryRunner({ env: ctx.env, userLogin: jobUserLoginForNlq, sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }) },
          );
    } else {
      throw new Error(`Unsupported async capability: ${job.capability}`);
    }

    const serializedResult = JSON.stringify(result);
    if (new TextEncoder().encode(serializedResult).byteLength > 12_000_000) {
      throw new Error("Async job result exceeds the 12 MB serialized result limit.");
    }
    const completedAt = new Date().toISOString();
    family.queue.complete(jobId, serializedResult, responseStatus ?? null, completedAt);
    ctx.audit("async_job.completed", "orchestrator", { jobId, capability: job.capability });
    // Consolidation C3 (#1277): a stage job's terminal state is
    // recorded per stage — a skipped or held stage says so, with its
    // reason, instead of reading as a plain completion.
    if (jobStage) {
      const stageResult = (result ?? {}) as { status?: unknown; reason?: unknown };
      const stageStatus =
        stageResult.status === "skipped" ? "skipped" : stageResult.status === "held" ? "held" : "completed";
      recordStageTransition(ctx, {
        userLogin: jobUserLogin,
        stage: jobStage,
        chainId: jobChainId,
        jobId,
        status: stageStatus,
        reason: typeof stageResult.reason === "string" ? stageResult.reason : undefined,
      });
    }

    // Issue #1355: a completed shard advances its chain — the
    // completion hook plans the next stage's shards (feed order,
    // assemble gate, per-format generate/store, serve adoption),
    // exactly like report → deliveries above. Scheduling must
    // never fail the completed shard.
    if (job.capability === "shard.execute" && jobStage && jobChainId) {
      try {
        const { planShardAdvance, chainRowsFromSql } = await import("../../services/shardJobs");
        const shardPayload = payload as unknown as import("../../services/shardJobs").ShardPayload;
        if (shardPayload?.chain) {
          const rows = chainRowsFromSql(ctx.agentCtx.storage.sql as never, jobChainId, ctx.sessionKey());
          const completed = rows.find((r) => r.jobId === jobId);
          const specs = planShardAdvance({
            chain: shardPayload.chain,
            rows,
            completedStage: jobStage,
            completedKey: shardPayload.shard.key,
            rootJobId: completed?.parentJobId ?? jobId,
            assembleJobId:
              shardPayload.shard.key === "assemble"
                ? jobId
                : (completed?.parentJobId ?? jobId),
            nowIso: completedAt,
          });
          for (const spec of specs) {
            await submitAsyncJob(ctx, spec);
          }
        }
      } catch (hookError) {
        ctx.audit("shard.advance_failed", "orchestrator", {
          jobId,
          chainId: jobChainId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
        console.error(`[OrchestratorAgent] Shard advance failed for job ${jobId}:`, hookError);
      }
    }

    // Consolidation #1236 (feed seam): a completed feed stage plans
    // its generate stage — an http.request job to the discovery
    // trigger route, carrying the fresh artifacts map. The trigger
    // route is not a recognized screener completion
    // (screenerOutcomeFromHttpJob matches only /etrade/screen and
    // /trading/options/screen), so the http hook below plans nothing
    // for it: no double-planning. The trigger body carries no
    // stageChain, so the discovery bridge takes its direct path
    // (canonical row = serve, direct delivery = deliver, exactly
    // today's non-chain discovery behavior). Scheduling must never
    // fail the completed feed job. A failed feed job never reaches
    // this hook — it is the chain's stop point.
    if (job.capability === "feed.snapshot" && jobStage === "feed" && jobChainId) {
      try {
        const { planFeedGenerateJobs } = await import("../../services/feedSnapshotJob");
        const feedResult = result as unknown as import("../../services/feedSnapshotJob").FeedSnapshotJobResult;
        const feedPayload = payload as unknown as import("../../services/feedSnapshotJob").FeedSnapshotJobPayload;
        const specs = planFeedGenerateJobs({
          feedJobId: jobId,
          chainId: jobChainId,
          userLogin: typeof feedPayload?.userLogin === "string" ? feedPayload.userLogin : (jobUserLogin ?? ctx.sessionKey()),
          environment: feedPayload?.environment,
          result: feedResult,
        });
        for (const spec of specs) {
          await submitAsyncJob(ctx, spec);
        }
      } catch (hookError) {
        ctx.audit("feed.generate_schedule_failed", "orchestrator", {
          jobId,
          chainId: jobChainId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
        console.error(`[OrchestratorAgent] Feed generate scheduling failed for job ${jobId}:`, hookError);
      }
    }

    // Issue #1123 S2: a completed screener main-job schedules its
    // follow-ups (report first; deliveries/notifications chain from
    // there in S3/S4). Scheduling must never fail the main job.
    if (job.capability === "http.request") {
      try {
        const httpResult = result as { body?: string } | undefined;
        const outcome = screenerOutcomeFromHttpJob(
          String(payload.pathAndQuery || ""),
          responseStatus,
          typeof httpResult?.body === "string" ? httpResult.body : "",
        );
        if (outcome) {
          const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
          const headers = (payload.headers || {}) as Record<string, string>;
          const userLogin = typeof headers["x-user-login"] === "string" ? headers["x-user-login"] : ctx.sessionKey();
          // Consolidation C4 (#1329): a staged http.request job plans
          // its serve/deliver stages with per-stage delays instead of
          // the legacy immediate chain. The job row carries the stage
          // + chain identity (stamped at submit); the payload carries
          // the config. Unstaged jobs and non-screener completions
          // keep the legacy behavior (no outcome ⇒ no specs).
          const httpChain = resolveHttpJobChain(
            { stage: job.stage, chainId: job.chain_id },
            payload as { stageChain?: import("../../types").StageChainConfig },
          );
          if (httpChain) outcome.stageChain = httpChain.stageChain;
          const initialSpecs = planInitialFollowups(
            outcome,
            config,
            jobId,
            userLogin,
            httpChain ? { chainId: httpChain.chainId, nowIso: new Date().toISOString() } : undefined,
          );
          for (const spec of initialSpecs) {
            await submitAsyncJob(ctx, spec);
          }
          // S4: completion (or run-level failure) notifications ride
          // the same completion point — Slack + email, tracked.
          // Issue #1228: with the report chain planned, the delivery
          // is the completion message on its channels (see bridge).
          const suppressChannels = initialSpecs.length > 0 ? plannedDeliveryChannels(outcome, config) : undefined;
          await submitLifecycleNotifications(
            ctx,
            outcome.success ? "completed" : "failed",
            outcome,
            jobId,
            userLogin,
            undefined,
            suppressChannels,
          );
        }
      } catch (followupError) {
        ctx.audit("followup.schedule_failed", "orchestrator", {
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
        console.error(`[OrchestratorAgent] Follow-up scheduling failed for job ${jobId}:`, followupError);
      }
    }

    // Issue #1123 S3: a completed report sub-job chains the deliveries
    // (parented to the MAIN job, not the report). Same never-fail rule.
    if (job.capability === "followup.report") {
      try {
        const config = resolveScreenerFollowupConfig(ctx.env as unknown as Record<string, unknown>);
        const outcome = (payload as { outcome?: import("../../services/screenerFollowups").ScreenerRunOutcome }).outcome;
        const userLogin = typeof (payload as { userLogin?: unknown }).userLogin === "string"
          ? (payload as { userLogin: string }).userLogin
          : ctx.sessionKey();
        if (outcome) {
          const mainJobId = getAsyncJob(ctx, jobId)?.parentJobId ?? jobId;
          // Consolidation C3 (#1277): in chain mode the completed
          // serve stage's payload carries the chain config + id, so
          // the deliver stages planned here inherit their own delay
          // and chain identity from the completed stage's record.
          const chainPayload = payload as { stageChain?: unknown; chainId?: unknown };
          const chain =
            outcome.stageChain && typeof chainPayload.chainId === "string"
              ? { chainId: chainPayload.chainId, nowIso: completedAt }
              : undefined;
          const specs = planDeliveryFollowups(
            outcome,
            config,
            (result ?? {}) as FollowupReportResult,
            mainJobId,
            userLogin,
            chain,
          );
          for (const spec of specs) {
            await submitAsyncJob(ctx, spec);
          }
        }
      } catch (followupError) {
        ctx.audit("followup.schedule_failed", "orchestrator", {
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
        console.error(`[OrchestratorAgent] Delivery scheduling failed for job ${jobId}:`, followupError);
      }
    }

    // Issue #1123 S4: a delivery that actually sent announces itself —
    // 'delivered' notifications parented to the MAIN job.
    if (job.capability === "followup.deliver" && (result as { status?: string } | undefined)?.status === "sent") {
      try {
        const outcome = (payload as { outcome?: ScreenerRunOutcome }).outcome;
        const channel = payload.channel as AsyncJobChannel;
        const userLogin = typeof payload.userLogin === "string" ? payload.userLogin : ctx.sessionKey();
        if (outcome) {
          const mainJobId = getAsyncJob(ctx, jobId)?.parentJobId ?? jobId;
          await submitLifecycleNotifications(
            ctx,
            "delivered",
            outcome,
            mainJobId,
            userLogin,
            `via ${followupChannelLabel(channel)}`,
          );
        }
      } catch (followupError) {
        ctx.audit("followup.schedule_failed", "orchestrator", {
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
        console.error(`[OrchestratorAgent] Delivered-notification scheduling failed for job ${jobId}:`, followupError);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = new Date().toISOString();
    family.queue.failRunning(jobId, message, completedAt);
    ctx.audit("async_job.failed", "orchestrator", { jobId, capability: job.capability, error: message });
    // Consolidation C3 (#1277): a failed stage is the chain's stop
    // point — recorded per stage with its reason; nothing downstream
    // was scheduled (the completion hooks above never ran).
    if (jobStage) {
      recordStageTransition(ctx, {
        userLogin: jobUserLogin,
        stage: jobStage,
        chainId: jobChainId,
        jobId,
        status: "failed",
        reason: message,
      });
    }
    // Issue #1355: a failed feed shard blocks assembly by NAME —
    // the chain stops here, and the audit names the blocker so a
    // partial report is never silently produced downstream.
    if (job.capability === "shard.execute" && jobStage === "feed" && jobChainId) {
      let shardKey = "unknown";
      let failedPayload: import("../../services/shardJobs").ShardPayload | undefined;
      try {
        const parsed = JSON.parse(job.payload_json) as import("../../services/shardJobs").ShardPayload;
        failedPayload = parsed;
        if (typeof parsed?.shard?.key === "string") shardKey = parsed.shard.key;
      } catch {
        shardKey = "unknown";
      }
      ctx.audit("shard.blocked", "orchestrator", {
        jobId,
        chainId: jobChainId,
        shardKey,
        error: message,
      });
      if (failedPayload?.chain?.screenType === "options") {
        // Options have independent symbol shards. Once every symbol has
        // reached a terminal state, assemble the qualified results even
        // when one or more symbols exhausted their retries.
        try {
          const { planShardAdvance, chainRowsFromSql } = await import("../../services/shardJobs");
          const rows = chainRowsFromSql(ctx.agentCtx.storage.sql as never, jobChainId, ctx.sessionKey());
          for (const spec of planShardAdvance({
            chain: failedPayload.chain,
            rows,
            completedStage: "feed",
            completedKey: shardKey,
            rootJobId: getAsyncJob(ctx, jobId)?.parentJobId ?? jobId,
            nowIso: completedAt,
          })) await submitAsyncJob(ctx, spec);
        } catch (hookError) {
          ctx.audit("shard.advance_failed", "orchestrator", { jobId, chainId: jobChainId, error: hookError instanceof Error ? hookError.message : String(hookError) });
        }
      } else {
        console.error(
          `[OrchestratorAgent] Sharded chain ${jobChainId} blocked: feed shard ${shardKey} failed (${message}) — assembly refused, no partial report.`
        );
      }
    }
    console.error(`[OrchestratorAgent] Async job ${jobId} failed:`, error);
    // Issue #1123 S4: a screener main job that fails hard (the route
    // threw before any response) still emits its failed notifications
    // — the run-level failures that DO produce a response are covered
    // by the completion hook above.
    if (job.capability === "http.request") {
      let failurePayload: Record<string, unknown> = {};
      try {
        failurePayload = JSON.parse(job.payload_json) as Record<string, unknown>;
      } catch {
        failurePayload = {};
      }
      const kind = screenerKindForPath(typeof failurePayload.pathAndQuery === "string" ? failurePayload.pathAndQuery : "");
      if (kind) {
        try {
          const headers = (failurePayload.headers ?? {}) as Record<string, unknown>;
          const userLogin = typeof headers["x-user-login"] === "string" ? headers["x-user-login"] : ctx.sessionKey();
          await submitLifecycleNotifications(
            ctx,
            "failed",
            { kind, trigger: "manual", success: false, pdfKeys: [], error: message },
            jobId,
            userLogin,
          );
        } catch (notifyError) {
          console.error(`[OrchestratorAgent] Failure notification scheduling failed for job ${jobId}:`, notifyError);
        }
      }
    }
  }
}
