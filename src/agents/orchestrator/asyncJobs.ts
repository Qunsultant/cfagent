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
import { TradingPlatformRegistry, type DataProviderId } from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import type {
  AgentName,
  AsyncJobChannel,
  AsyncJobKind,
  AsyncJobPayload,
  AsyncJobRecord,
  AsyncJobStatus,
  AsyncJobSubmission,
  AsyncJobTrigger,
  Env,
  PipelineStage,
} from "../../types";
import { recordScreeningActivity } from "../../services/screeningActivity";
import { buildFeedJobRegistry } from "../../services/feedJobs";
import { FEED_PIPELINE_CATALOG, resolveFeedJob } from "../../services/feedPipelineJobs";
import { recordJobOutcome } from "../../services/jobOutcomes";
import {
  buildLedgerLinkage,
  recoveryProvenance,
  restampLedgerLinkageAsyncJobId,
  stampLedgerLinkageIntoResult,
  systemProvenance,
} from "../../services/consolidatedScheduling";
import type { NLQSchedulingPort, NLQStockScreenPort } from "../nlq";
import { BusinessError, codedMessage, resolveOutcome } from "../../outcomes/outcomeAspects";
import { recordBlockingAudit } from "../../security/auditChain";
import {
  enforceServiceDispatch,
  resolveAsyncJobIdentity,
} from "../../security/serviceDispatch";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import type { MembershipStore } from "../../security/authorization";
import { enforceOwnerDispatch } from "../../security/runRevocationGate";
import { sessionStore } from "../../security/session";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
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
import { maybeAlertServeFailure } from "../../observability/alertingList";
import { postSlackText } from "../resourceGoals";
import { fetchSlackPost, type SlackDeliveryEnv } from "../social/delivery";
import { createAsyncJobPorts, type AsyncJobPorts } from "../../data/createAsyncJobPorts";
import {
  createDeliverySuppressor,
  deliveryDestinationFor,
  type DeliverySuppressor,
} from "../../workflows/screenDeliverySuppression";
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
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator/asyncJobs",
});

/**
 * Ports the async-job functions receive from the class. Table/state
 * ownership stays in OrchestratorAgent (ensureTables/getOrm are the
 * class's own); executeAsyncJob re-enters the class's routeRequest for
 * queued HTTP jobs exactly as before.
 */
export interface AsyncJobsContext {
  env: Env;
  agentCtx: AgentContext;
  /**
   * Issue #3922: optional per-login settings reader (the
   * hosting instance's mas_settings read), forwarded into the
   * mcp.tool execution context — the mesh screen door's ND
   * gate resolves its stored layer through it when a queued
   * screen executes. Absent → the gate stays env-only.
   */
  readSettingRaw?: (key: string) => string | null;
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
  /**
   * #3154 (Q6): owner-identity resolver for the revocation-mid-run
   *  consumer. When supplied, the execution guard uses it instead
   *  of the default iaaa-alias lookup over sessionStore(ctx.env).
   *  The default keeps production contexts (built by the
   *  orchestrator builder, which does not set this port) working
   *  with no builder change.
   */
  resolveOwnerInternalUserId?: (login: string) => Promise<string | null>;
  /**
   * Issue #2867: the (runId, destination) delivery suppressor
   * for followup.deliver jobs. The orchestrator builder may
   * supply one; otherwise the executor creates an in-memory
   * suppressor on this context (the per-instance pattern of
   * the context's scheduled slot sets). A context without one
   * still suppresses within the instance — a duplicate send
   * is never silent. Issue #2913 (G6): the orchestrator
   * builder supplies the SQL-backed suppressor, so
   * production claims survive an instance eviction.
   */
  deliverySuppressor?: DeliverySuppressor;
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
  trigger?: AsyncJobTrigger | null;
  triggeredBy?: string | null;
  scheduleId?: string | null;
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
    // Issue #3810: provenance stamped at submission. An invalid
    // stored value is dropped (never rendered); NULL = the
    // submission carried none.
    trigger: ASYNC_JOB_TRIGGERS.find((t) => t === row.trigger) ?? null,
    triggeredBy: typeof row.triggered_by === "string" && row.triggered_by ? row.triggered_by : null,
    scheduleId: typeof row.schedule_id === "string" && row.schedule_id ? row.schedule_id : null,
  };
}

/** Issue #3810: the closed run-level trigger domain for provenance. */
const ASYNC_JOB_TRIGGERS: readonly AsyncJobTrigger[] = ["manual", "scheduled", "autonomous", "webhook", "agent"];

/**
 * Issue #3810: map a §4 ledger trigger (the five-valued
 * JobRunLedgerTrigger the follow-up planners stamp) onto the
 * run-level trigger — or NULL when it is not one. "worker-cron"
 * is a scheduled trigger; "async-chain" is not a trigger at all
 * (the chain step inherits its trigger from the chain), and
 * "unknown" stays unknown. Never invents.
 */
function ledgerTriggerToJobTrigger(value: unknown): AsyncJobTrigger | null {
  if (value === "manual" || value === "scheduled") return value;
  if (value === "worker-cron") return "scheduled";
  return null;
}

/**
 * Issue #3810: resolve the provenance a submission stamps onto its
 * row. Explicit submission fields win; otherwise the payload's
 * §4 ledgerLinkage (stamped by the follow-up planners) is the
 * fallback source. A trigger that is neither explicit nor
 * mappable stays NULL — the read model renders that as
 * "Not recorded", never invented.
 */
export function resolveJobProvenance(job: AsyncJobSubmission): {
  trigger: AsyncJobTrigger | null;
  triggeredBy: string | null;
  scheduleId: string | null;
} {
  const explicit = ASYNC_JOB_TRIGGERS.find((t) => t === job.trigger);
  const triggeredBy = typeof job.triggeredBy === "string" && job.triggeredBy ? job.triggeredBy : null;
  const explicitScheduleId = typeof job.scheduleId === "string" && job.scheduleId ? job.scheduleId : null;
  if (explicit) {
    return { trigger: explicit, triggeredBy, scheduleId: explicitScheduleId };
  }
  const linkage = (job.payload as Record<string, unknown> | undefined)?.ledgerLinkage;
  const link = linkage && typeof linkage === "object" ? (linkage as Record<string, unknown>) : null;
  return {
    trigger: link ? ledgerTriggerToJobTrigger(link.trigger) : null,
    triggeredBy,
    scheduleId:
      explicitScheduleId ??
      (link && typeof link.scheduleId === "string" && link.scheduleId ? link.scheduleId : null),
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
  const jobId = crypto.randomUUID();
  // Issue #3121 S4 — the follow-up row's own id: a submission whose
  // payload carries ledgerLinkage (stamped by the follow-up planners
  // with the chain-parent main job id — the only id that exists at
  // plan time) is restamped here with the minted row's own id before
  // serializing. The §4 rule is asyncJobId IS the row's own job_id;
  // the parent link rides parent_job_id, unchanged. A payload
  // without ledgerLinkage is untouched (never coerced) — and a retry
  // resubmission keeps its original trigger/schedule/workflow
  // linkage, restamping only the id to the retry's own job.
  const payloadJson = JSON.stringify(restampLedgerLinkageAsyncJobId(job.payload, jobId));
  if (new TextEncoder().encode(payloadJson).byteLength > 17_000_000) {
    throw new Error("Async job payload exceeds the 17 MB serialized storage limit.");
  }
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  queue.pruneTerminalBefore(ctx.sessionKey(), cutoff);
  queue.pruneTerminalToCap(ctx.sessionKey(), 500);
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
  // Issue #3810: provenance stamped at submission — explicit fields
  // win, else the payload's §4 ledgerLinkage; NULL when neither
  // names a trigger (the read model renders "Not recorded", never
  // invented).
  const provenance = resolveJobProvenance(job);
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
    trigger: provenance.trigger,
    triggeredBy: provenance.triggeredBy,
    scheduleId: provenance.scheduleId,
  });

  try {
    // Consolidation C3 (#1277): a job with a not-before time is armed
    // at the remaining delay instead of immediately — the executor
    // still refuses an early claim (defense in depth for re-arms).
    // Issue #3121 S1 — the executeAsyncJob arming is framework
    // machinery, not a user schedule: it carries origin system /
    // async-job-arm provenance in its payload.
    await ctx.schedule(delaySecondsUntil(job.runAt, Date.now()), "executeAsyncJob", { jobId, provenance: systemProvenance("async-job-arm") } satisfies AsyncJobPayload, {
      idempotent: true,
      retry: { maxAttempts: 1 },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    queue.failQueued(
      jobId,
      `Could not schedule async work: ${message}`,
      new Date().toISOString(),
      // Issue #3811: an arming failure is a job failure — it carries
      // the generic code.
      FAILURE_ASYNC_JOB_FAILED_CODE,
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
      // restarted and recovered its queue. Issue #3121 S1 — a
      // recovery re-arm carries origin system / recovery provenance.
      await ctx.schedule(
        delaySecondsUntil(typeof row.not_before === "string" ? row.not_before : undefined, Date.now()),
        "executeAsyncJob",
        { jobId, provenance: recoveryProvenance() } satisfies AsyncJobPayload,
        {
          idempotent: true,
          retry: { maxAttempts: 1 },
        },
      );
    } catch (error) {
      structuredLog.error("asyncJobs.recover_queued_async_job_reschedule_failed", {
        message: `[OrchestratorAgent] Could not reschedule queued async job ${jobId}:`,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Issue #4002: the reap message for a row this recovery closes —
 *  names the cause (the executor died with its host at a restart)
 *  with the last-activity evidence, never the generic
 *  unknown-outcome text. The sweep and read path keep the generic
 *  message: they decide on age, not on a restart. */
function orphanedReapMessage(
  lastActivityAt: string | null,
  rearmedAs?: string,
  recording?: { feedJobId?: string | null; pipelineRunId?: string | null },
): string {
  const base = `Orphaned by a host restart: the executor died with its host before a result was recorded (last activity ${lastActivityAt ?? "unknown"}). The run never recorded a result.`;
  let message = rearmedAs ? `${base} Re-armed as job ${rearmedAs}; the work continues there.` : base;
  // Issue #4002 (recording slice): the ids the row must carry.
  // The Workflow Runs view renders the row's error, so the feed
  // job id (+ pipeline run id when known) is visible there even
  // when no artifact was stored. Only the parts known are
  // named; nothing is invented.
  if (recording?.feedJobId) {
    message += ` Feed job ${recording.feedJobId}`;
    if (recording.pipelineRunId) message += `; pipeline run ${recording.pipelineRunId}`;
    message += ".";
  }
  return message;
}

/** Issue #4002: parse a row's stored payload, or null when it is
 *  not valid JSON — an unparseable row can never be re-armed. */
function parseRowPayload(row: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(row.payload_json ?? "")) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Issue #4002: is this payload a pipeline feed-job dispatch at
 *  all — the shape, without the re-arm's payment guard? Two
 *  shapes: the HTTP feed-run route (the POST
 *  /data-providers/:id/feed-run the workflow runs show) and the
 *  MCP run_feed_job tool (the copilot-dispatched shape — the
 *  sentiment run). The recording slice uses this shape alone:
 *  identification is always safe, even for a row that must
 *  never be re-executed. */
function isFeedDispatchShape(capability: string, payload: Record<string, unknown>): boolean {
  if (capability === "http.request") {
    if (
      payload.method !== "POST" ||
      typeof payload.pathAndQuery !== "string"
    ) {
      return false;
    }
    // The provider-level feed-run route.
    if (/^\/data-providers\/[^/]+\/feed-run$/.test(payload.pathAndQuery)) return true;
    // Issue #4002 (third slice): the per-job feed-jobs action
    // route — run / retry / resume execute the pipeline (a long
    // dispatch, orphanable like a feed-run). Pause / cancel are
    // fast control calls and are excluded.
    return /^\/data-providers\/[^/]+\/feed-jobs\/[^/]+\/(run|retry|resume)$/.test(
      payload.pathAndQuery,
    );
  }
  if (capability === "mcp.tool") {
    return payload.toolName === "run_feed_job";
  }
  return false;
}

/** Issue #4002: is this payload a resumable pipeline feed-job
 *  dispatch? Both are side-effect-free re-executions of a feed
 *  read: no order, no payment, no mutation beyond the persisted
 *  dataset the run itself writes. A payload carrying a consumed
 *  paymentSignature is never resumable (the #3907 rule);
 *  anything else reaps as before. */
function isResumableFeedDispatch(capability: string, payload: Record<string, unknown>): boolean {
  const args = payload.arguments;
  const signature =
    args && typeof args === "object"
      ? (args as Record<string, unknown>).paymentSignature
      : undefined;
  if (typeof signature === "string" && signature.trim() !== "") return false;
  return isFeedDispatchShape(capability, payload);
}

/** Issue #4002 (recording slice): the feed job id a feed
 *  dispatch resolves to — the id the Workflow Runs view and the
 *  audits must carry, because the dispatch itself records no job
 *  id anywhere. HTTP: the provider in the feed-run path -> the
 *  registry's forSource (the same rule the route uses, so the id
 *  is the one the run actually executed). MCP: the run_feed_job
 *  source argument -> resolveFeedJob (exact id / alias), falling
 *  back to forSource. Pure, no I/O. Null when nothing resolves
 *  — never invented. */
function resolveFeedDispatchJobId(
  env: Env,
  capability: string,
  payload: Record<string, unknown>,
): string | null {
  const knobs: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env as unknown as Record<string, unknown>)) {
    if (typeof value === "string") knobs[key] = value;
  }
  const registry = buildFeedJobRegistry(knobs);
  if (capability === "http.request") {
    const path = payload.pathAndQuery;
    if (typeof path !== "string") return null;
    // Issue #4002 (third slice): the per-job feed-jobs action
    // route names its job id in the path — validated by EXACT
    // catalog match, never taken on trust (a row for an
    // unregistered id records nothing). resolveFeedJob's alias /
    // containing fallbacks are for copilot queries, not path
    // segments: a near-miss id must never silently resolve to
    // another job (#2144 no-silent-substitution).
    const feedJobsMatch =
      /^\/data-providers\/[^/]+\/feed-jobs\/([^/]+)\/(run|retry|resume)$/.exec(path);
    if (feedJobsMatch) {
      return FEED_PIPELINE_CATALOG.find((e) => e.jobId === feedJobsMatch[1])?.jobId ?? null;
    }
    const match = /^\/data-providers\/([^/]+)\/feed-run$/.exec(path);
    if (!match) return null;
    // Same cast as the route (dataProviders.ts:965): the path
    // segment is a provider id by construction, and forSource
    // returns undefined for anything unregistered.
    return registry.forSource(match[1] as DataProviderId)?.id ?? null;
  }
  if (capability === "mcp.tool") {
    const args = payload.arguments;
    const source =
      args && typeof args === "object"
        ? (args as Record<string, unknown>).source
        : undefined;
    if (typeof source !== "string" || !source.trim()) return null;
    return (
      resolveFeedJob(source)?.jobId ??
      registry.forSource(source as DataProviderId)?.id ??
      null
    );
  }
  return null;
}

/** Issue #4002 (recording slice): the pipeline run id for a
 *  feed job, read from the pipeline host through the existing
 *  getFeedJobSurfaceStatus door method (pipeline.currentRunId
 *  comes from the instance record, not artifacts, so it survives
 *  the host's orphan settle). Accepted ONLY when the run started
 *  before the executor's last activity (runStartedAt <=
 *  lastActivityAt): a run that started after is a LATER run of
 *  the same job, not this row's orphan, and must never be
 *  attributed to it. Best-effort: any failure (no binding, door
 *  throws, no pipeline, no runStartedAt, guard fails) returns
 *  null — the recovery never fails because the lookup failed,
 *  and the feed job id is still recorded. */
async function resolveFeedDispatchPipelineRunId(
  env: Env,
  feedJobId: string,
  lastActivityAt: string | null,
): Promise<string | null> {
  try {
    const ns = env.SCHEDULED_AGENT;
    if (!ns) return null;
    const door = ns.get(ns.idFromName("default")) as unknown as {
      getFeedJobSurfaceStatus(jobId: string): Promise<{
        pipeline?: { currentRunId?: string | null; runStartedAt?: string | null } | null;
      } | null>;
    };
    const view = await door.getFeedJobSurfaceStatus(feedJobId);
    const pipeline = view?.pipeline;
    if (!pipeline?.currentRunId) return null;
    const runStartedAt = pipeline.runStartedAt;
    if (typeof runStartedAt !== "string" || !runStartedAt) return null;
    if (!lastActivityAt) return null;
    const startedMs = Date.parse(runStartedAt);
    const lastMs = Date.parse(lastActivityAt);
    if (Number.isNaN(startedMs) || Number.isNaN(lastMs)) return null;
    if (startedMs > lastMs) return null;
    return pipeline.currentRunId;
  } catch {
    return null;
  }
}

/** Issue #4002: how many re-arms have already been spawned from
 *  this row — counted over the session's rows, mirroring
 *  retryAsyncJob's duplicate-retry scan (a sibling in queued /
 *  running / completed whose payload carries recoveryRearmOf for
 *  this row). Unparseable siblings cannot be re-arms. */
function countRecoveryRearms(ctx: AsyncJobsContext, jobId: string): number {
  const prior = ports(ctx).read.listSessionPayloads(ctx.sessionKey()) as unknown as Array<
    Record<string, unknown>
  >;
  let count = 0;
  for (const candidate of prior) {
    if (!["queued", "running", "completed"].includes(String(candidate.status))) continue;
    try {
      const parsed = JSON.parse(String(candidate.payload_json)) as { recoveryRearmOf?: unknown };
      if (parsed?.recoveryRearmOf === jobId) count++;
    } catch {
      // An unparseable sibling payload cannot be a re-arm of this row.
    }
  }
  return count;
}

/** Issue #3907: fail-fast recovery for orphaned `running` rows —
 *  called from OrchestratorAgent.onStart next to
 *  recoverQueuedAsyncJobs. A row whose executor died with the DO
 *  (eviction / restart / deployment) has a stale heartbeat and no
 *  path to a terminal state until the sweep's 2h backstop; recovery
 *  closes that window at startup. Only stale-heartbeat rows are
 *  failed (the same bound as the reap); fresh-heartbeat rows are
 *  left alone — their executor may still be alive in a hibernated
 *  isolate. Issue #4002: a stale row whose work is a resumable
 *  pipeline feed-job dispatch is RE-ARMED (same payload, retryOf
 *  + recoveryRearmOf link, capped at two re-arms per chain) and
 *  the original row is failed with the cataloged
 *  FAILURE_ASYNC_JOB_ORPHANED code naming the restart; every
 *  other stale row reaps with that code too, never the generic
 *  unknown-outcome code. A paid row is never re-armed (its x402
 *  signature was consumed — the #3907 rule). Idempotent by the
 *  guarded failRunning transition (reapStaleRunning, same
 *  message/code as the reap); per-row try/catch so one bad row
 *  never fails startup. */
export async function recoverStaleRunningAsyncJobs(
  ctx: AsyncJobsContext,
): Promise<{ examined: number; failed: number; rearmed: number }> {
  ctx.ensureTables();
  const rows = ports(ctx).read.listRunning(ctx.sessionKey(), STALE_SWEEP_BATCH_LIMIT) as unknown as Array<Record<string, unknown>>;
  const nowMs = Date.now();
  let failed = 0;
  let rearmed = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);
    try {
      if (row.status !== "running" || typeof row.started_at !== "string") continue;
      if (!isHeartbeatStale(row, nowMs)) continue;
      const lastActivityAt =
        typeof row.last_activity_at === "string" && row.last_activity_at
          ? row.last_activity_at
          : typeof row.started_at === "string"
            ? row.started_at
            : null;
      // Issue #4002: re-arm a resumable feed dispatch before
      // reaping the original — the re-armed row replays the same
      // dispatch once the pipeline host has settled its orphan
      // (its onStart precedes any dispatch). A failed re-arm
      // falls through to the reap below: the row is never left
      // running on a submit failure.
      let rearmedJobId: string | undefined;
      let rearmCount = 0;
      const payload = parseRowPayload(row);
      const isFeedDispatch = payload
        ? isFeedDispatchShape(String(row.capability), payload)
        : false;
      if (payload && isResumableFeedDispatch(String(row.capability), payload)) {
        const ownRearmCount =
          typeof payload.recoveryRearmCount === "number" ? payload.recoveryRearmCount : 0;
        if (ownRearmCount + countRecoveryRearms(ctx, jobId) < RECOVERY_REARM_CAP) {
          try {
            const graph = jobGraphFields(row);
            const submission = {
              capability: String(row.capability),
              payload: {
                ...payload,
                retryOf: jobId,
                recoveryRearmOf: jobId,
                recoveryRearmCount: ownRearmCount + 1,
              },
              displayName: String(row.display_name),
              parentJobId: graph.parentJobId,
              jobKind: graph.jobKind,
              channel: graph.channel,
              stage: graph.stage,
              chainId: graph.chainId,
              // Issue #3810: a re-arm keeps the source row's
              // provenance — the retry is the same run,
              // re-attempted, not a new trigger.
              trigger: graph.trigger ?? undefined,
              triggeredBy: graph.triggeredBy ?? undefined,
              scheduleId: graph.scheduleId ?? undefined,
            } as unknown as AsyncJobSubmission;
            const submitted = await submitAsyncJob(ctx, submission);
            rearmedJobId = submitted.jobId;
            rearmCount = ownRearmCount + 1;
          } catch (error) {
            structuredLog.error("asyncJobs.recover_stale_running_job_rearm_failed", {
              message: `[OrchestratorAgent] Stale running-job re-arm failed for job ${jobId} (reaping instead):`,
              jobId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      // Issue #4002 (recording slice): resolve the feed job id +
      // pipeline run id for the row's error column and the audits
      // — a failed feed-run that stored no artifact is otherwise
      // unidentifiable beyond its provider. The door read is
      // best-effort and guarded (a later run is never attributed
      // to this row); a lookup failure records the job id alone.
      let feedJobId: string | null = null;
      let pipelineRunId: string | null = null;
      if (isFeedDispatch && payload) {
        feedJobId = resolveFeedDispatchJobId(ctx.env, String(row.capability), payload);
        if (feedJobId) {
          pipelineRunId = await resolveFeedDispatchPipelineRunId(
            ctx.env,
            feedJobId,
            lastActivityAt,
          );
        }
      }
      const completedAt = new Date(nowMs).toISOString();
      const message = orphanedReapMessage(lastActivityAt, rearmedJobId, {
        feedJobId,
        pipelineRunId,
      });
      const written = ports(ctx).queue.reapStaleRunning(
        jobId,
        message,
        completedAt,
        FAILURE_ASYNC_JOB_ORPHANED_CODE,
      );
      if (written === 1) {
        const toolName = toolNameFromRow(row);
        ctx.audit("async_job.failed", "orchestrator", {
          jobId,
          capability: String(row.capability),
          ...(toolName ? { tool: toolName } : {}),
          error: message,
          errorCode: FAILURE_ASYNC_JOB_ORPHANED_CODE,
          lastActivityAt,
          ...(rearmedJobId ? { rearmedAs: rearmedJobId } : {}),
          ...(feedJobId ? { feedJobId } : {}),
          ...(pipelineRunId ? { pipelineRunId } : {}),
        });
        failed++;
        if (rearmedJobId) {
          ctx.audit("async_job.retried", "orchestrator", {
            jobId,
            retryJobId: rearmedJobId,
            capability: String(row.capability),
            recoveredBy: "stale_running_recovery",
            recoveryRearmCount: rearmCount,
            ...(feedJobId ? { feedJobId } : {}),
            ...(pipelineRunId ? { pipelineRunId } : {}),
          });
          rearmed++;
        }
      }
    } catch (error) {
      structuredLog.error("asyncJobs.recover_stale_running_job_failed", {
        message: `[OrchestratorAgent] Stale running-job recovery failed for job ${jobId}:`,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { examined: rows.length, failed, rearmed };
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
  /** Issue #3811: the stall evidence — the executor's last recorded
   *  activity (heartbeat, falling back to the claim instant) and how
   *  long ago it was. A stuck run with a fresh heartbeat is still
   *  progressing; one whose last activity is the claim is not. */
  lastActivityAt: string | null;
  heartbeatAgeMs: number | null;
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
  // Issue #3811: the stall evidence rides the alert — the executor's
  // last recorded activity (heartbeat, falling back to the claim
  // instant for rows that predate heartbeats) and its age. The
  // threshold itself stays on started_at (the #2567 contract); the
  // last activity is evidence, never a second threshold.
  const lastActivityAt =
    typeof row.last_activity_at === "string" && row.last_activity_at
      ? row.last_activity_at
      : typeof row.started_at === "string"
        ? row.started_at
        : null;
  const heartbeatAgeMs =
    lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))
      ? nowMs - Date.parse(lastActivityAt)
      : null;
  const info: StuckRunAlertInfo = {
    jobId,
    capability: String(row.capability),
    label: String(row.display_name),
    ownerLogin: String(row.session_id),
    startedAt: row.started_at,
    ageMs,
    thresholdMs,
    lastActivityAt,
    heartbeatAgeMs,
  };
  ctx.audit("async_job.stuck_detected", "orchestrator", {
    jobId: info.jobId,
    capability: info.capability,
    ownerLogin: info.ownerLogin,
    ageMs: info.ageMs,
    thresholdMs: info.thresholdMs,
    lastActivityAt: info.lastActivityAt,
    heartbeatAgeMs: info.heartbeatAgeMs,
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
  // Issue #3784: a stale running job is failed on READ (the
  // requester path cannot wait for the 15-minute sweep; the
  // caller asking for status of a zombie job must not be told
  // it is still running). Issue #3907: the reap consults the
  // heartbeat — a live, heartbeating job is never reaped, at any
  // age; only a stale heartbeat (or a pre-heartbeat row past the
  // 2h backstop) is failed.
  if (row.status === "running" && typeof row.started_at === "string" &&
    Date.now() - Date.parse(row.started_at) > STALE_RUNNING_REAP_MS &&
    isHeartbeatStale(row)) {
    const completedAt = new Date().toISOString();
    ports(ctx).queue.reapStaleRunning(
      jobId,
      STALE_RUNNING_REAP_MESSAGE,
      completedAt,
      // Issue #3811: a reaped row carries the generic failure code —
      // the execution stopped before a result was recorded.
      FAILURE_ASYNC_JOB_FAILED_CODE,
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
    // Issue #3811: the execution telemetry — the executor's last
    // recorded activity and the coded failure, when one exists.
    lastActivityAt: typeof row.last_activity_at === "string" ? row.last_activity_at : undefined,
    errorCode: typeof row.error_code === "string" ? row.error_code : undefined,
  };
}

/**
 * Issue #3784: the stale-running reap's backstop (2h) and its fixed
 * unknown-outcome message, shared by the read path (getAsyncJob
 * above) and the scheduled sweep (sweepStaleAsyncJobs below) so both
 * transitions carry the identical verdict. The message is the
 * read path's exact string, unchanged — a reaped row reads the
 * same whether a read or the sweep reaped it.
 */
const STALE_RUNNING_REAP_MS = 2 * 60 * 60 * 1000;
const STALE_RUNNING_REAP_MESSAGE =
  "Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again.";
/** Issue #3784: the sweep's batch cap — at most this many running
 *  rows per tick; the oldest are swept first (listRunning orders
 *  by created_at ASC), the rest wait for the next tick. */
const STALE_SWEEP_BATCH_LIMIT = 100;

/** Issue #3811: the generic failure code for an execution that
 *  stopped before a result was recorded (reap) or threw without a
 *  cataloged code. The single outcome catalog is the resolver;
 *  this constant is the fallback, never an invented code. */
const FAILURE_ASYNC_JOB_FAILED_CODE = "FAILURE_ASYNC_JOB_FAILED";

/** Issue #4002: the cataloged code for a row whose executor died
 *  with its host (a deploy restart) — registered in
 *  src/outcomes/outcomeCatalog.json. The onStart recovery below
 *  is the only path that names it: a stale heartbeat at host
 *  start means the executor is dead, not that the leg failed. */
const FAILURE_ASYNC_JOB_ORPHANED_CODE = "FAILURE_ASYNC_JOB_ORPHANED";

/** Issue #4002: how many times the onStart recovery re-arms one
 *  orphaned dispatch chain before it reaps instead — a run that
 *  orphans twice in a row is failing for a reason a re-arm cannot
 *  fix, so the third orphan is a visible failure, not a loop. */
const RECOVERY_REARM_CAP = 2;

/** Issue #3811: heartbeat interval while a job runs — the #624
 *  research-task precedent (2 minutes). */
export const ASYNC_JOB_HEARTBEAT_MS = 120_000;

/** Issue #3907: the heartbeat-staleness bound — a live executor
 *  heartbeats every ASYNC_JOB_HEARTBEAT_MS (2 min), so silence
 *  longer than three intervals means the executor is dead. The
 *  reap consults this bound, never age alone: a row whose last
 *  activity is fresh is progressing and is never reaped, at any
 *  age. Rows that predate heartbeats carry no last_activity_at;
 *  for them the started_at age is the only evidence and the 2h
 *  backstop still applies (see isHeartbeatStale). */
export const HEARTBEAT_STALE_MS = 3 * ASYNC_JOB_HEARTBEAT_MS;

/** Issue #3907: is this running row's executor dead? True when
 *  its last recorded activity is older than HEARTBEAT_STALE_MS.
 *  A row with no last_activity_at (predates #3811 heartbeats)
 *  is stale only past the 2h backstop, measured on started_at —
 *  the #3784 backstop is preserved for legacy rows. Never throws:
 *  an unparseable timestamp reads as stale (fail the row closed,
 *  never leave it running forever on a bad value). */
export function isHeartbeatStale(
  row: Record<string, unknown>,
  nowMs: number = Date.now(),
): boolean {
  const lastActivity =
    typeof row.last_activity_at === "string" && row.last_activity_at
      ? Date.parse(row.last_activity_at)
      : NaN;
  if (Number.isFinite(lastActivity)) return nowMs - lastActivity > HEARTBEAT_STALE_MS;
  const startedAt = typeof row.started_at === "string" ? Date.parse(row.started_at) : NaN;
  if (!Number.isFinite(startedAt)) return true;
  return nowMs - startedAt > STALE_RUNNING_REAP_MS;
}

/** Issue #3907: best-effort tool name for an mcp.tool row
 *  (audit evidence only — never throws). */
function toolNameFromRow(row: Record<string, unknown>): string | undefined {
  try {
    const payload = JSON.parse(String(row.payload_json ?? "")) as { toolName?: unknown };
    return typeof payload?.toolName === "string" && payload.toolName ? payload.toolName : undefined;
  } catch {
    return undefined;
  }
}

/** Issue #3907: the executor's max-runtime deadline — env
 *  ASYNC_JOB_MAX_RUNTIME_MINUTES, default 90 minutes (below the
 *  2h reap backstop with margin for the sweep to observe the
 *  failure). A blank/unparseable value falls through to the
 *  default; 0 or negative DISABLES the deadline (the reap
 *  backstop still applies). Follows the stuckRunAlert resolver
 *  idiom (documented Worker env var, named built-in default, no
 *  magic number in the execution path). */
export const ASYNC_JOB_MAX_RUNTIME_ENV_VAR = "ASYNC_JOB_MAX_RUNTIME_MINUTES";
export const DEFAULT_ASYNC_JOB_MAX_RUNTIME_MS = 90 * 60 * 1000;
export const FAILURE_ASYNC_JOB_TIMEOUT_CODE = "FAILURE_ASYNC_JOB_TIMEOUT";
export function resolveAsyncJobMaxRuntimeMs(env: Record<string, unknown>): number {
  const raw = typeof env[ASYNC_JOB_MAX_RUNTIME_ENV_VAR] === "string"
    ? (env[ASYNC_JOB_MAX_RUNTIME_ENV_VAR] as string).trim()
    : "";
  if (raw === "") return DEFAULT_ASYNC_JOB_MAX_RUNTIME_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return DEFAULT_ASYNC_JOB_MAX_RUNTIME_MS;
  if (minutes <= 0) return 0;
  return Math.round(minutes * 60 * 1000);
}

/** Issue #3907: a per-job execution deadline — a promise that
 *  rejects with the cataloged timeout BusinessError after ms.
 *  The caller races the capability leg against it and cancels it
 *  on every terminal path (cancel is idempotent). The rejection
 *  abandons the hung leg, it does not abort it: the leg may still
 *  settle in the background, but the row is already terminal, so
 *  its late result is dropped and no second execution occurs. */
export function createExecutionDeadline(maxRuntimeMs: number): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectFn: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectFn = reject;
  });
  if (maxRuntimeMs > 0) {
    timer = setTimeout(() => {
      rejectFn?.(new BusinessError(FAILURE_ASYNC_JOB_TIMEOUT_CODE, { maxRuntimeMs }));
    }, maxRuntimeMs);
  }
  return {
    promise,
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** Issue #3811: derive the coded failure for a thrown error, through
 *  the single outcome catalog — never a message where a code belongs.
 *  A BusinessError keeps its own code; a message whose leading
 *  "[CODE]" bracket names a cataloged code keeps that code; anything
 *  else (uncoded, unknown bracket, non-Error) falls back to the
 *  generic job code. The resolver never invents a code. */
export function resolveJobFailureCode(error: unknown): string {
  if (error instanceof BusinessError) {
    const resolved = resolveOutcome(error.code);
    return resolved.resolved ? resolved.code : FAILURE_ASYNC_JOB_FAILED_CODE;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = /^\[([^\]]+)\]/.exec(message);
  if (match) {
    const resolved = resolveOutcome(match[1]);
    if (resolved.resolved) return resolved.code;
  }
  return FAILURE_ASYNC_JOB_FAILED_CODE;
}

/** Issue #3811: stamp the executor's heartbeat for a running job.
 *  Best-effort by contract: a heartbeat failure is logged and
 *  returns false — it must never fail the job it observes. */
export function heartbeatAsyncJob(ctx: AsyncJobsContext, jobId: string, nowMs: number = Date.now()): boolean {
  try {
    return ports(ctx).queue.heartbeat(jobId, new Date(nowMs).toISOString()) === 1;
  } catch (error) {
    structuredLog.warn("asyncJobs.heartbeat_failed", {
      message: `[OrchestratorAgent] Async job heartbeat failed for job ${jobId}:`,
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface StaleAsyncJobSweepResult {
  examined: number;
  alerted: number;
  reaped: number;
}

/**
 * Issue #3784 (parent incident #3781): the scheduled stale-async-job
 * sweep — the read path's reap + stuck alert (#2567) applied without
 * a read. A claimed-but-unfinished row whose executor stalled (the
 * six incident jobs, still `running` ~53 min after start) has no
 * recovery path until something reads it; the sweep closes that
 * window on a 15-minute tick (armed by OrchestratorAgent.onStart,
 * next to the #618 ledger sweep).
 *
 * Per row, oldest first: past the 2h backstop AND with a stale
 * heartbeat the row is reaped as failed with the read path's
 * exact message and audited as `async_job.failed` (the established
 * `{ jobId, capability, error }` shape, docs/operations/jobs-
 * workflows-stages-01.md §Auditing — no new event name). Issue
 * #3907: the heartbeat is the liveness signal — a row whose
 * heartbeat is fresh is progressing and is never reaped, at any
 * age (the 2026-11-09 incident: two paid jobs reaped by one
 * sweep tick while still running). Past the stuck threshold
 * (default 30 min, 0 = disabled) the row is flagged + alerted
 * through maybeAlertStuckRunning (exactly-once claim, so a second
 * sweep never re-alerts or re-reaps). Reap check BEFORE alert,
 * same order as getAsyncJob, so an already-reaped row is never
 * alerted. Idempotent by the guarded transitions; per-row
 * try/catch so one bad row never fails the sweep or its caller.
 * The sweep never publishes to the J1 CloudEvents stream
 * (recorded decision on #3784: mas_async_jobs rows are not J1
 * pipeline runs) and never deletes a row.
 */
export function sweepStaleAsyncJobs(ctx: AsyncJobsContext, nowMs: number = Date.now()): StaleAsyncJobSweepResult {
  ctx.ensureTables();
  const rows = ports(ctx).read.listRunning(ctx.sessionKey(), STALE_SWEEP_BATCH_LIMIT) as unknown as Array<Record<string, unknown>>;
  let alerted = 0;
  let reaped = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);
    try {
      if (row.status !== "running" || typeof row.started_at !== "string") continue;
      const ageMs = nowMs - Date.parse(row.started_at);
      if (ageMs > STALE_RUNNING_REAP_MS && isHeartbeatStale(row, nowMs)) {
        const completedAt = new Date(nowMs).toISOString();
        const written = ports(ctx).queue.reapStaleRunning(
          jobId,
          STALE_RUNNING_REAP_MESSAGE,
          completedAt,
          // Issue #3811: a reaped row carries the generic failure
          // code — the execution stopped before a result was recorded.
          FAILURE_ASYNC_JOB_FAILED_CODE,
        );
        if (written === 1) {
          const toolName = toolNameFromRow(row);
          ctx.audit("async_job.failed", "orchestrator", {
            jobId,
            capability: String(row.capability),
            // Issue #3907: the tool name, so a reaped paid MCP job
            // can be traced to its payment receipt (a reaped job
            // otherwise carries no link to the x402 charge).
            ...(toolName ? { tool: toolName } : {}),
            error: STALE_RUNNING_REAP_MESSAGE,
            errorCode: FAILURE_ASYNC_JOB_FAILED_CODE,
            // Issue #3811: the stall evidence — the executor's last
            // recorded activity (heartbeat, falling back to the claim
            // instant for rows that predate heartbeats).
            lastActivityAt:
              typeof row.last_activity_at === "string" && row.last_activity_at
                ? row.last_activity_at
                : typeof row.started_at === "string"
                  ? row.started_at
                  : null,
          });
          reaped++;
        }
        continue;
      }
      if (maybeAlertStuckRunning(ctx, row, nowMs)) alerted++;
    } catch (error) {
      structuredLog.error("asyncJobs.sweep_stale_async_job_failed", {
        message: `[OrchestratorAgent] Stale async-job sweep failed for job ${jobId}:`,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { examined: rows.length, alerted, reaped };
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
      // Issue #3811: the execution telemetry.
      lastActivityAt: typeof row.last_activity_at === "string" ? row.last_activity_at : undefined,
      errorCode: typeof row.error_code === "string" ? row.error_code : undefined,
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
  // Issue #3121 S4 — the main job's payload carries the same §4
  // linkage its result does (S1), resolved through the shared
  // builder: the run's trigger (the main job is the chain root, not
  // a chain step, so its trigger is the run's own scheduled/manual,
  // never async-chain), the originating schedule/workflow ids when
  // the run names them (explicit nulls otherwise — never a missing
  // column), and this row's own id. Follow-ups minted from this
  // main job stamp async-chain + these same run ids (see
  // followupLedgerLinkage), restamped with their own ids at submit.
  const ledgerLinkage = buildLedgerLinkage({
    payload: {
      trigger: outcome.trigger,
      scheduleId: outcome.scheduleId ?? null,
      asyncJobId: jobId,
      workflowId: outcome.workflowId ?? null,
    },
  });
  ports(ctx).queue.insertTerminal({
    jobId,
    sessionId: ctx.sessionKey(),
    capability: "screener.run",
    displayName,
    status: outcome.success ? "completed" : "failed",
    payloadJson: JSON.stringify({ outcome, userLogin, ledgerLinkage }),
    resultJson: JSON.stringify({
      status: outcome.success ? "completed" : "failed",
      kind: outcome.kind,
      trigger: outcome.trigger,
      // Issue #3121 S1 — the §4 linkage on the bridged run record:
      // the originating schedule / workflow when the run names one
      // (explicit nulls otherwise — never a missing column), and this
      // main job's own id as the run's async job.
      scheduleId: outcome.scheduleId ?? null,
      asyncJobId: jobId,
      workflowId: outcome.workflowId ?? null,
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
    // Issue #3810: the bridged run's own trigger + schedule ride
    // the row (the outcome already names them — no new source).
    trigger: outcome.trigger,
    scheduleId: outcome.scheduleId ?? null,
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
    structuredLog.warn("asyncJobs.job_outcome_record_failed", {
      message: "[AsyncJobs] job outcome record failed:",
      error: err instanceof Error ? err.message : String(err),
    });
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
  // Issue #3907: a paid job cannot be retried from its recorded
  // payload — the x402 paymentSignature it carries was consumed
  // at verification (consumeTxHash), so a retry's verification
  // rejects it as already used and the retry completes with a 402
  // instead of re-running. Refuse with a named message; a retry
  // needs a fresh payment, which this path cannot supply. (A
  // payment-verification failure never reaches here as a failed
  // job: the tool returns the 402 as its result and the job
  // completes — so any failed paid row got past payment, and its
  // signature is consumed.)
  const retryArgs = payload.arguments;
  const retrySignature =
    retryArgs && typeof retryArgs === "object"
      ? (retryArgs as Record<string, unknown>).paymentSignature
      : undefined;
  if (typeof retrySignature === "string" && retrySignature.trim() !== "") {
    throw new Error(
      "This paid job cannot be retried from its recorded payload: its payment was already consumed. Submit a new call with a fresh payment.",
    );
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
    // Issue #3810: a retry keeps the source row's provenance — the
    // retry is the same run, re-attempted, not a new trigger.
    trigger: graph.trigger ?? undefined,
    triggeredBy: graph.triggeredBy ?? undefined,
    scheduleId: graph.scheduleId ?? undefined,
  } as unknown as AsyncJobSubmission;
  const submitted = await submitAsyncJob(ctx, submission);
  ctx.audit("async_job.retried", "orchestrator", { jobId, retryJobId: submitted.jobId, capability: String(row.capability) });
  return submitted;
}

/**
 * Issue #3264: record a keyless options run before the serve stage
 * skips it. The serve stage used to return `skipped` before the
 * record call whenever no artifact was adoptable, so a run whose
 * formats all failed left no canonical row, no history row, and no
 * job-outcome row — invisible in Docs (beyond a scan-store twin,
 * if any) and in Workflow Runs. The outcome already carries
 * per-format failed statuses + errors from the serve planner; a
 * format with no carried status and no key records "failed" with
 * the skip reason, never a silent absence. A carried status
 * ("generated" / "failed" / "skipped") is never rewritten.
 * Never throws — recordOptionsServeReport warns and continues.
 */
async function recordKeylessOptionsServe(
  ctx: AsyncJobsContext,
  outcome: import("../../services/screenerFollowups").ScreenerRunOutcome,
  reason: string,
): Promise<void> {
  if (outcome.kind !== "options" || !outcome.timestamp) return;
  const { recordOptionsServeReport } = await import("../../services/optionsServeRecord");
  type FormatStatus = NonNullable<import("../../services/screenerFollowups").ScreenerRunOutcome["pdfStatus"]>;
  const normalize = (
    status: FormatStatus | undefined,
    key: string | undefined,
    error: string | undefined,
  ): { status: FormatStatus; error?: string } => {
    const resolved = status ?? (key ? "generated" : "failed");
    return resolved === "failed"
      ? { status: resolved, error: error ?? reason }
      : { status: resolved };
  };
  const pdf = normalize(outcome.pdfStatus, outcome.pdfKeys?.[0], outcome.pdfError);
  const xlsx = normalize(outcome.xlsxStatus, outcome.xlsxKey, outcome.xlsxError);
  const csv = normalize(outcome.csvStatus, outcome.csvKey, outcome.csvError);
  await recordOptionsServeReport(
    { orm: ctx.getOrm() as never, storage: ctx.agentCtx.storage },
    {
      ...outcome,
      pdfStatus: pdf.status,
      ...(pdf.error ? { pdfError: pdf.error } : {}),
      xlsxStatus: xlsx.status,
      ...(xlsx.error ? { xlsxError: xlsx.error } : {}),
      csvStatus: csv.status,
      ...(csv.error ? { csvError: csv.error } : {}),
    },
  );
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
      // Issue #3121 S1 — an early-fire re-arm is framework machinery:
      // origin system / recovery provenance, as on the recovery path.
      await ctx.schedule(remainingSeconds, "executeAsyncJob", { jobId, provenance: recoveryProvenance() } satisfies AsyncJobPayload, {
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
  // #3309 (15-factor F14 Telemetry): the claim is the point the live
  // job's trail went dark — queued was audited at submit, completed /
  // failed at the end, but nothing marked the start. Audit the start
  // so a job stuck in "running" is observable from its own trail
  // (queued → started → completed/failed), not only from the 30-min
  // stuck-run threshold.
  ctx.audit("async_job.started", "orchestrator", { jobId, capability: job.capability });
  // Issue #3811: heartbeat while the job runs — the #624
  // research-task precedent (2-minute interval, cleared at the
  // terminal points below). The stamp is observation, not a state
  // change: if the executor dies, the timer dies with it and the
  // row's last activity ages — the stall evidence. The callback
  // never throws (heartbeatAsyncJob is best-effort).
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  heartbeatTimer = setInterval(() => {
    heartbeatAsyncJob(ctx, jobId);
  }, ASYNC_JOB_HEARTBEAT_MS);
  // Issue #3907: the execution deadline — a race against the
  // capability legs below (maxRuntime default 90 min, env
  // ASYNC_JOB_MAX_RUNTIME_MINUTES). A hung provider fetch is
  // failed with FAILURE_ASYNC_JOB_TIMEOUT instead of running
  // until the 2h reap backstop. Cancelled at both terminal
  // points next to stopHeartbeat; the rejection abandons the
  // hung leg, it does not abort it.
  const executionDeadline = createExecutionDeadline(resolveAsyncJobMaxRuntimeMs(ctx.env as unknown as Record<string, unknown>));
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
    // #3154 (Q6): revocation-mid-run consumer — an owner job
    // re-checks live membership at execution, mirroring the service
    // tier above. This is also the stage boundary: every pipeline
    // stage re-executes through executeAsyncJob, so a job whose
    // owner was revoked mid-pipeline denies at the next stage's
    // execution, is marked failed (via the throw into the catch
    // below, which audits async_job.failed), and never reaches a
    // capability leg. The schedule that queued it is preserved.
    // The resolver is the iaaa-alias login lookup over the
    // SessionStore KV; unresolvable logins, a missing store, or a
    // lookup failure preserve pre-existing behavior (allow, logged
    // inside enforceOwnerDispatch) — see runRevocationGate.ts.
    if (identity.kind === "owner") {
      const owner = await enforceOwnerDispatch({
        store: ctx.serviceMembershipStore,
        resolveInternalUserId:
          ctx.resolveOwnerInternalUserId ??
          ((login) => lookupInternalUserIdByLogin(sessionStore(ctx.env), login)),
        login: identity.login,
        nowMs: Date.now(),
      });
      if ("denied" in owner) {
        ctx.audit("async_job.dispatch_denied", "orchestrator", {
          jobId,
          capability: job.capability,
          reason: "OWNER_MEMBERSHIP_REVOKED",
          ...(owner.detail ? { detail: owner.detail } : {}),
        });
        throw new Error("Async job dispatch denied: OWNER_MEMBERSHIP_REVOKED");
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
          structuredLog.error("asyncJobs.start_notification_schedule_failed", {
            message: `[OrchestratorAgent] Start notification scheduling failed for job ${jobId}:`,
            jobId,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
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
      const response = await Promise.race([
        ctx.routeRequest(new Request(new URL(pathAndQuery, "https://agent.internal"), {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
        })),
        executionDeadline.promise,
      ]);
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
      result = await Promise.race([
        executeMCPTool(toolName, args, {
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
        // Issue #3922: the settings reader carrier (see the
        // AsyncJobsContext field) for the ND gate's stored layer.
        ...(ctx.readSettingRaw ? { readSettingRaw: ctx.readSettingRaw } : {}),
        }),
        executionDeadline.promise,
      ]);
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
      // Issue #2599 (F4): serve is per format, not per PDF. A
      // failed PDF leg skips serve ONLY when no tabular format
      // survived with it; when XLSX and/or CSV generated, serve
      // adopts those (status ready, perFormat pdf: failed, coded
      // pdfNote) and the options serve record is still written,
      // so a PDF failure no longer suppresses successful XLSX/CSV
      // delivery. The PDF failure itself stays coded and visible
      // (pdfNote + the serve record's pdfError), never silent.
      const tabularAdoptable =
        (outcome.xlsxKey && outcome.xlsxStatus !== "failed") ||
        (outcome.csvKey && outcome.csvStatus !== "failed");
      if (outcome.pdfStatus === "failed" && !tabularAdoptable) {
        // Issue #3264: the run is still recorded (canonical +
        // history + outcome rows, per-format failures named) before
        // the serve job skips — a failed run must not vanish.
        const reason = codedMessage("FAILURE_REPORT_PDF_GENERATION", outcome.pdfError || undefined);
        await recordKeylessOptionsServe(ctx, outcome, reason);
        result = { status: "skipped", reason };
      } else if (outcome.canonicalReportId) {
        // Consolidation C4 (#1329): serve's schedulable content for
        // runs whose artifact is a canonical row (discovery, goal) —
        // verify the row exists via the serve stage. A missing row
        // fails the serve job explicitly (the chain's stop point),
        // exactly like a missing PDF key below.
        const { serveReportStage } = await import("../../services/unifiedReportPipeline");
        const checked = await Promise.race([
          serveReportStage({
            canonicalReportId: outcome.canonicalReportId,
            findCanonicalReport: (id: string) => ctx.getOrm().reports.findById(id),
          }),
          executionDeadline.promise,
        ]);
        if (!checked.verified) {
          throw new Error(codedMessage("FAILURE_REPORT_ARTIFACT_MISSING", checked.reason));
        }
        result = { status: "ready", artifacts: [], canonicalReportId: outcome.canonicalReportId };
      } else if ((!outcome.pdfKeys || outcome.pdfKeys.length === 0) && !tabularAdoptable) {
        // Issue #3264: same record-before-skip as the PDF-failed
        // branch above — a keyless run still lands its rows.
        const reason = codedMessage("FAILURE_REPORT_ARTIFACT_MISSING", "The run produced no report artifact key.");
        await recordKeylessOptionsServe(ctx, outcome, reason);
        result = { status: "skipped", reason };
      } else {
        const port = ctx.followupReportPort();
        const artifacts: Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" | "csv" }> = [];
        const missing: string[] = [];
        for (const key of outcome.pdfKeys ?? []) {
          const pdf = outcome.kind === "stock"
            ? await port.getStockPdf(userLogin, key)
            : await port.getOptionsPdf(userLogin, key);
          if (pdf) artifacts.push({ key, fileName: pdf.fileName, kind: "pdf" });
          else missing.push(key);
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
          // Issue #2599 (F4): a CSV failure carries the CSV code
          // (single outcome catalog), not the PDF code this line
          // previously reused — per-format failures must name
          // their own format.
          csvNote = codedMessage("FAILURE_REPORT_CSV_GENERATION", outcome.csvError || undefined);
        }
        // Issue #2599 (F4): the no-artifact throw moves here,
        // after tabular adoption — a run whose PDF failed but
        // whose XLSX/CSV adopted has artifacts and must not
        // throw for its missing PDF. A run with nothing adopted
        // still fails explicitly, as before.
        if (artifacts.length === 0) {
          throw new Error(codedMessage("FAILURE_REPORT_ARTIFACT_MISSING", `Report artifact(s) referenced by the run are missing from storage: ${missing.join(", ")}`));
        }
        const pdfNote = outcome.pdfStatus === "failed"
          ? codedMessage("FAILURE_REPORT_PDF_GENERATION", outcome.pdfError || undefined)
          : undefined;
        const perFormat: Record<string, string> = {
          pdf: artifacts.some((a) => a.kind === "pdf")
            ? "adopted"
            : outcome.pdfStatus === "failed"
              ? "failed"
              : "missing",
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
        result = { status: "ready", artifacts, missingKeys: missing, perFormat, ...(pdfNote ? { pdfNote } : {}), ...(xlsxNote ? { xlsxNote } : {}), ...(csvNote ? { csvNote } : {}) };
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
            const notice = await Promise.race([
              ctx.followupDeliveryPort().notify({
              channel,
              userLogin,
              text: formatUndeliverableNotification(outcome, payload.skipReason),
              ...(channel === "email" && outcome.emailTo ? { emailTo: outcome.emailTo } : {}),
              ...(channel === "slack" && outcome.slackChannel ? { slackChannel: outcome.slackChannel } : {}),
              }),
              executionDeadline.promise,
            ]);
            noticeSent = notice.ok;
          } catch (noticeError) {
            structuredLog.warn("asyncJobs.undeliverable_notice_failed", {
              message: "[asyncJobs] undeliverable-notice failed:",
              error: noticeError instanceof Error ? noticeError.message : String(noticeError),
            });
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
        // Issue #2867: (runId, destination) delivery suppression,
        // checked after the policy gates above and before any
        // send — a deliver job that sent and then failed to
        // complete must not send the same run to the same
        // destination again on retry. The claim completes the
        // job as skipped with the reason on the job, never a
        // silent drop and never a second send.
        const suppressor =
          ctx.deliverySuppressor ?? (ctx.deliverySuppressor = createDeliverySuppressor());
        const deliveryRunId = outcome.deliveryId ?? jobId;
        const deliveryDestination = deliveryDestinationFor(channel, outcome.emailTo);
        if (!suppressor.tryClaim(deliveryRunId, deliveryDestination)) {
          ctx.audit("followup.delivery_suppressed", "orchestrator", {
            jobId,
            runId: deliveryRunId,
            destination: deliveryDestination,
            channel,
          });
          result = {
            status: "skipped",
            reason: `Duplicate delivery suppressed for run ${deliveryRunId} to ${deliveryDestination}.`,
            channel,
          };
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
          // Issue #2867: a failed send releases the claim, so
          // a retry may send (the recipient holds nothing). A
          // post-send failure below does NOT release — the
          // recipient already holds the artifact, so the retry
          // is the duplicate this suppressor exists to stop.
          let delivery: { ok: boolean; error?: string; detail?: string };
          try {
            delivery = await Promise.race([
              ctx.followupDeliveryPort().deliver({ channel, userLogin, outcome, artifacts }),
              executionDeadline.promise,
            ]);
            if (!delivery.ok) throw new Error(codedMessage("FAILURE_DELIVERY_CHANNEL_FAILED", delivery.error || `Delivery via ${channel} failed.`));
          } catch (sendErr) {
            suppressor.release(deliveryRunId, deliveryDestination);
            throw sendErr;
          }
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
      const sent = await Promise.race([
        ctx.followupDeliveryPort().notify({
          channel,
          userLogin,
          text,
          ...(channel === "email" && outcome.emailTo ? { emailTo: outcome.emailTo } : {}),
          ...(channel === "slack" && outcome.slackChannel ? { slackChannel: outcome.slackChannel } : {}),
        }),
        executionDeadline.promise,
      ]);
      if (!sent.ok) throw new Error(sent.error || `Notification via ${channel} failed.`);
      result = { status: "notified", channel, event };
      }
    } else if (job.capability === "shard.execute") {
      // Issue #1355: one shard of a sharded scheduled screen. The
      // executor owns policy + job state; the handler owns the
      // shard's work (providers, pipeline, store seams).
      const { executeShardJob, resolveShardChainSource } = await import("../../services/shardExecutors");
      const { ETradeService } = await import("../../services/etrade");
      const shardPayload = payload as unknown as import("../../services/shardJobs").ShardPayload;
      // Issue #3655: one E*TRADE factory closure, shared by the legacy
      // executor seam and the broker-aware chain-source resolver
      // below — a second inline construction would trip the #291
      // extraction ledger (one site per file).
      const createETradeService = (userLogin: string, environment: string | undefined) =>
        new ETradeService(ctx.getOrm(), ctx.env, userLogin, environment);
      result = await Promise.race([
        executeShardJob(
        {
          sql: ctx.agentCtx.storage.sql,
          env: ctx.env as unknown as Record<string, unknown>,
          orm: ctx.getOrm(),
          storage: ctx.agentCtx.storage,
          createETradeService,
          // Issue #3655: broker-aware chain source (tenant broker →
          // Alpaca platform chain source / etrade client /
          // provider_unsupported). Without this the sharded options
          // executor would fetch E*TRADE chains for every tenant.
          resolveChainSource: (chain) =>
            resolveShardChainSource(
              {
                env: ctx.env as unknown as Record<string, unknown>,
                orm: ctx.getOrm(),
                createETradeService,
              },
              chain
            ),
          sessionId: ctx.sessionKey(),
        },
        shardPayload
        ),
        executionDeadline.promise,
      ]);
    } else if (job.capability === "feed.snapshot") {
      // Consolidation #1236 (feed seam): the feed stage job. The
      // executor owns job state; the handler owns the work
      // (providers, producer, store seams) — the shard.execute idiom.
      const { executeFeedSnapshotJob } = await import("../../services/feedSnapshotJob");
      const { ETradeService } = await import("../../services/etrade");
      const feedPayload = payload as unknown as import("../../services/feedSnapshotJob").FeedSnapshotJobPayload;
      result = await Promise.race([
        executeFeedSnapshotJob(
        {
          sql: ctx.agentCtx.storage.sql,
          env: ctx.env as unknown as Record<string, unknown>,
          orm: ctx.getOrm(),
          createETradeService: (userLogin, environment) =>
            new ETradeService(ctx.getOrm(), ctx.env, userLogin, environment),
          sessionId: ctx.sessionKey(),
        },
        feedPayload
        ),
        executionDeadline.promise,
      ]);
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
        structuredLog.error("asyncJobs.nlq_mode_invalid", {
          message: `[nlq] invalid ${NLQ_MODE_SWITCH} value ${JSON.stringify(resolvedNlqMode.raw)} — failing closed to "rest"`,
          setting: NLQ_MODE_SWITCH,
          rawValue: resolvedNlqMode.raw,
        });
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
      result = await Promise.race([
        resolvedNlqMode.mode === "mcp"
        ? executeNaturalLanguageQuery(
            ctx.getOrm(),
            ctx.sessionKey(),
            query,
            ctx.env,
            jobUserLoginForNlq,
            getUserDid(ctx.sessionKey()),
          )
        : executeNaturalLanguageQuery(
            ctx.getOrm(),
            ctx.sessionKey(),
            query,
            ctx.env,
            jobUserLoginForNlq,
            getUserDid(ctx.sessionKey()),
            { scanRunStore: createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, profileStore: createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).strategyProfiles, schedulingPort: ctx.nlqSchedulingPort(), stockScreenPort: ctx.nlqStockScreenPort(), discoveryRunner: createDiscoveryService({ env: ctx.env, userLogin: jobUserLoginForNlq, orm: ctx.getOrm(), sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, platform: TradingPlatformRegistry.getPlatform(await resolveTenantBroker(ctx.env), ctx.env, ctx.getOrm(), jobUserLoginForNlq), ...(nlqDpPorts?.config ? { configPort: nlqDpPorts.config } : {}), ...(nlqDpPorts?.captures ? { capturePort: nlqDpPorts.captures } : {}) }), fitDiscoveryRunner: createFitDiscoveryRunner({ env: ctx.env, userLogin: jobUserLoginForNlq, sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }) },
        ),
        executionDeadline.promise,
      ]);
    } else {
      throw new Error(`Unsupported async capability: ${job.capability}`);
    }

    const serializedResult = JSON.stringify(
      // Issue #3121 S4 — the completed step's run record carries its
      // §4 linkage flat (trigger / scheduleId / asyncJobId /
      // workflowId), matching the bridged main job's result shape.
      // The linkage rides the stored payload; a payload without one
      // (any non-chain job) leaves the result untouched, and a failed
      // step's row stays joinable through its payload linkage.
      stampLedgerLinkageIntoResult(payload, result, jobId),
    );
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
        structuredLog.error("asyncJobs.shard_advance_failed", {
          message: `[OrchestratorAgent] Shard advance failed for job ${jobId}:`,
          jobId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
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
        structuredLog.error("asyncJobs.feed_generate_schedule_failed", {
          message: `[OrchestratorAgent] Feed generate scheduling failed for job ${jobId}:`,
          jobId,
          error: hookError instanceof Error ? hookError.message : String(hookError),
        });
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
        structuredLog.error("asyncJobs.followup_schedule_failed", {
          message: `[OrchestratorAgent] Follow-up scheduling failed for job ${jobId}:`,
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
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
        structuredLog.error("asyncJobs.delivery_schedule_failed", {
          message: `[OrchestratorAgent] Delivery scheduling failed for job ${jobId}:`,
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
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
        structuredLog.error("asyncJobs.delivered_notification_schedule_failed", {
          message: `[OrchestratorAgent] Delivered-notification scheduling failed for job ${jobId}:`,
          jobId,
          error: followupError instanceof Error ? followupError.message : String(followupError),
        });
      }
    }
    // Issue #3811: the job's work is done — stop the heartbeat
    // (the terminal transition below stamps the final activity).
    // Issue #3907: cancel the execution deadline with it.
    stopHeartbeat();
    executionDeadline.cancel();
  } catch (error) {
    stopHeartbeat();
    executionDeadline.cancel();
    const message = error instanceof Error ? error.message : String(error);
    const completedAt = new Date().toISOString();
    // Issue #3811: executor-side failure capture — the throw writes
    // a terminal failed state with a CODED error (the single outcome
    // catalog's code, via resolveJobFailureCode), never a silent
    // stuck row.
    const errorCode = resolveJobFailureCode(error);
    family.queue.failRunning(jobId, message, completedAt, errorCode);
    ctx.audit("async_job.failed", "orchestrator", { jobId, capability: job.capability, error: message, errorCode });
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
    } else if (job.capability === "followup.report") {
      // Phase 5 slice 7 (#2000): a monolithic serve failure —
      // the report job with no chain identity — gets the same
      // first-class failure state the chained path records
      // (serve/failed transition + audit) plus, for a first
      // failure only, the operator page. Chained serve failures
      // never reach this branch (jobStage is set); retries
      // record state but never re-page. Delivery is
      // fire-and-forget through the existing postSlackText
      // channel and can never fail the already-terminal job.
      let retryOf: string | null = null;
      try {
        const parsed = JSON.parse(job.payload_json) as { retryOf?: unknown };
        if (typeof parsed?.retryOf === "string" && parsed.retryOf) retryOf = parsed.retryOf;
      } catch {
        retryOf = null;
      }
      await maybeAlertServeFailure(
        {
          jobId,
          capability: job.capability,
          stage: null,
          chainId: null,
          retryOf,
          userLogin: jobUserLogin ?? ctx.sessionKey(),
          error: message,
        },
        {
          recordTransition: (t) =>
            recordStageTransition(ctx, {
              userLogin: t.userLogin,
              stage: t.stage,
              jobId: t.jobId,
              status: t.status,
              reason: t.reason,
            }),
          audit: (type, _agent, payload) => ctx.audit(type, "orchestrator", payload),
          postText: async (text) =>
            // Env carries non-string bindings, so it is not
            // assignable to SlackDeliveryEnv's string index
            // (same cast as server.ts); delivery reads only the
            // string Slack fields at runtime.
            postSlackText({ post: fetchSlackPost, env: ctx.env as unknown as SlackDeliveryEnv, text }),
        },
      ).catch(() => {
        // maybeAlertServeFailure never throws by contract; this
        // guard is defense in depth for the terminal path.
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
        structuredLog.error("asyncJobs.sharded_chain_blocked", {
          message: `[OrchestratorAgent] Sharded chain ${jobChainId} blocked: feed shard ${shardKey} failed (${message}) — assembly refused, no partial report.`,
          chainId: jobChainId,
          shardKey,
          error: message,
        });
      }
    }
    structuredLog.error("asyncJobs.async_job_failed", {
      message: `[OrchestratorAgent] Async job ${jobId} failed:`,
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
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
          structuredLog.error("asyncJobs.failure_notification_schedule_failed", {
            message: `[OrchestratorAgent] Failure notification scheduling failed for job ${jobId}:`,
            jobId,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        }
      }
    }
  }
}

