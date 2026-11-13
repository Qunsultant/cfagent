/**
 * Issue #2341 (Agent Mesh S5, programme #2225 G1 batch A) — typed
 * outbound doors from the orchestrator to ScheduledAgent and
 * PaymentsAgent.
 *
 * G1's discipline is the one the two existing wires already keep
 * (the ScreenerAgent typed stub, the ResearchAgent runAgentTool
 * dispatch): typed methods, explicit acting identity, honest typed
 * errors. A door resolves identity first, checks gates second,
 * dispatches third (docs/architecture/agentic/doors-and-layers.md
 * §11.1): a call whose acting identity is missing, blank, or the
 * retired synthetic literal "default" (retired by #2327 / mesh S3)
 * is refused BEFORE any stub is resolved — never defaulted, never
 * substituted.
 *
 * Addressing follows the A2A resolution precedent (#2223,
 * src/a2a/resolution.ts) and the production callers: ScheduledAgent
 * is the singleton instance "default" (the bare name would seed a
 * virgin catalogue); PaymentsAgent's live instance is "default"
 * (both production callers resolve it so, and the class is
 * instance-agnostic — its state derives from the ledger of record).
 *
 * Budget attribution: a chat-initiated budget check names
 * AGENTIC_SPEND_AGENT_ID ("orchestrator") as the budgetCheck
 * agentId. The ledger contract (#785/#896, src/payments/ledger.ts)
 * attributes orchestrator-executed outbound spend to that bucket,
 * and a check is only meaningful against the bucket the gated spend
 * will actually land in — the same reason ScheduledAgent's checks
 * name the same bucket post-S3. The acting user's login is a
 * different field: it is required, carried, and audited as the
 * check's requester; it is never the bucket.
 *
 * processPaidRequest is deliberately NOT exposed through this door
 * to the chat turn: the chat paid-request flow is S10's (G5 —
 * PaymentWorkflow with a PaymentsAgent budget check first), and
 * wiring the raw paid request here would pre-build that shape
 * beside the workflow path. The stub interface below types it for
 * completeness of the agent's surface; no door operation and no
 * turn command calls it in this slice, and no gate inside
 * PaymentsAgent (budget guard, facilitator verification,
 * idempotency) is touched.
 *
 * Batch B (#2349, G1) adds the TradingAgent and ReportAssetAgent
 * doors below, under the same discipline. Addressing is per-user:
 * each door resolves the ACTING user's own instance through the
 * fleet's one instance-name scheme per agent (tradingAgentName /
 * reportAssetAgentName — the bare "trading" / "default" instances
 * belong to the configured service identity alone, #1185).
 *
 * Batch B deliberately did NOT expose the TradingAgent approval
 * door: executeApprovedOrder, startTradeApproval, and
 * decideTradeApproval were not typed on the door stub, not called
 * by any door operation, and had no turn command. Batch B gave the
 * turn only the proposal side (the preview-only trade services,
 * whose result is a pending-approval proposal — never a placed
 * order) and the typed reads.
 *
 * Batch D (#2375, S9/G4) is the slice that crosses that boundary —
 * through the approval door itself, not around it. The door now
 * types startTradeApproval and decideTradeApproval, and exposes
 * three operations: start a TradingTradeWorkflow run behind the
 * door for an existing proposal, deliver the human's decision to
 * that run, and read the run's status from the TRADE_WORKFLOW
 * binding's own instance status (Trading has no D1 projection, and
 * no second tracker is invented here). The authorizer DID on a
 * decision is derived server-side from the acting login
 * (getUserDid) — it is never a caller-supplied field. The
 * synchronous settle (executeApprovedOrder) stays OFF the door:
 * it is called only by the workflow's settle step, inside the
 * agent that holds the draft store.
 *
 * Batch C (#2351, G1) adds the BrowserAgent and SlackAgent doors
 * below, under the same discipline. Addressing follows the A2A
 * resolution precedent (#2223, src/a2a/resolution.ts): both
 * classes are stateless/env-driven, so each door resolves the
 * fixed instance its A2A surface name denotes ("browser" /
 * "slack"). The SlackAgent door exposes only the class's two
 * outbound domain helpers; Slack ingress (the server forwarders
 * and the class's own gated onRequest) is S13/G10 and is not
 * touched, and the approval-ticket operation only POSTS the HITL
 * ticket — it approves and executes nothing.
 *
 * The webhookUrl policy (survey §2.8's open call, decided here):
 * a chat-turn caller may NOT supply a delivery webhook URL
 * through these doors. The stub option types carry no webhookUrl
 * field and the door operations build options field-by-field, so
 * no caller-supplied URL can reach the services; delivery goes
 * only where env configuration sends it (the services fall back
 * to env SLACK_WEBHOOK_URL, and with nothing configured they
 * return an honest not-delivered result, which the door
 * propagates verbatim). This is the same delivery-target
 * discipline the #2223 A2A doors already hold for these agents —
 * an arbitrary caller-chosen webhook would be an SSRF-shaped
 * surface, and no new allowlist is invented here.
 */

import type {
  Env,
  ETradeOrderDraft,
  TransactionSnapData,
  PreTradeApprovalDraft,
  BrowserAgentSnapResult,
  BrowserInspectResult,
} from "../../types";
import type { ScheduledGoal, ScheduleTick } from "../../schedule";
import {
  AGENTIC_SPEND_AGENT_ID,
  type PaymentRecord,
} from "../../payments/ledger";
import { tradingAgentName } from "../trading-agent";
import { getUserDid } from "../did";
import {
  reportAssetAgentName,
  type ReportAssetMeta,
} from "../report-asset-agent";
import { getServiceUserLogin } from "../../security/serviceIdentity";
import type {
  JobDefinition,
  JobInstanceRecord,
  JobScheduleConfig,
} from "../../data/jobPipelinePorts";
import type { JobStagesRead, JobStatusView } from "../../services/jobPipelineEngine";
import {
  resolveFeedJob,
  type FeedJobSurfaceView,
} from "../../services/feedPipelineJobs";
import {
  resolveEnrichJob,
  type EnrichJobSurfaceView,
} from "../../services/enrichPipelineJobs";
import {
  resolveAnalyzeJob,
  type AnalyzeJobSurfaceView,
} from "../../services/analyzePipelineJobs";
import {
  resolveGenerateJob,
  type GenerateJobSurfaceView,
} from "../../services/generatePipelineJobs";
import {
  resolveDeliverJob,
  type DeliverJobSurfaceView,
} from "../../services/deliverPipelineJobs";
import {
  resolvePipelineChain,
  type PipelineChainSurfaceView,
} from "../../services/chainPipelineJobs";
import {
  bridgeRunComplete,
  bridgeRunFail,
  bridgeRunStart,
} from "./runBridge";
import type { AsyncJobPorts } from "../../data/createAsyncJobPorts";

// ---------------------------------------------------------------------------
// Errors — honest, typed, coded (doors-and-layers §11.1)
// ---------------------------------------------------------------------------

export type MeshDoorErrorCode =
  | "identity_required"
  | "door_unavailable"
  | "goal_not_found"
  | "asset_not_found"
  // Issue #3535: the feed-job door's unknown/ambiguous job name.
  | "feed_job_not_found"
  // Issue #3536: the enrich-job door's unknown/ambiguous job name.
  | "enrich_job_not_found"
  // Issue #3537: the analyze-job door's unknown/ambiguous job name.
  | "analyze_job_not_found"
  // Issue #3538: the generate-job door's unknown/ambiguous job name.
  | "generate_job_not_found"
  // Issue #3539: the deliver-job door's unknown/ambiguous job name.
  | "deliver_job_not_found"
  // Issue #3540: the pipeline-chain door's unknown/ambiguous
  // chain name, and a stage action that names no stage.
  | "pipeline_chain_not_found"
  | "pipeline_chain_stage_required"
  // Issue #2488: the mesh screen door's (meshScreenDoor.ts)
  // fail-closed refusal codes — budget_denied (the S5 budget
  // door refused the paid path), price_unavailable (no stored
  // catalogue price), checkout_email_required (no checkout
  // email source for a chat turn).
  | "budget_denied"
  | "price_unavailable"
  | "checkout_email_required"
  // Issue #2530: the screen door's dual-mode refusal codes —
  // nd_mode_unavailable (a non-deterministic run was requested
  // while SCREENER_ND_MODE is off; never a silent downgrade to
  // a deterministic screen), screen_intent_required (ND mode
  // without its intent, or an intent supplied without ND mode).
  | "nd_mode_unavailable"
  | "screen_intent_required"
  // Issue #2581: the options-strategy door's catalog refusal —
  // invalid_strategy_type (the requested strategy type does not
  // resolve against the engine's strategy catalog; refused
  // before any engine call).
  | "invalid_strategy_type";

export class MeshDoorError extends Error {
  readonly code: MeshDoorErrorCode;
  constructor(code: MeshDoorErrorCode, message: string) {
    super(message);
    this.name = "MeshDoorError";
    this.code = code;
  }
}

/**
 * The door's identity gate. Returns the trimmed acting login, or
 * throws identity_required — before the caller resolves any stub.
 */
export function requireActingLogin(
  actingLogin: string | undefined | null,
): string {
  const login = typeof actingLogin === "string" ? actingLogin.trim() : "";
  if (!login || login === "default") {
    throw new MeshDoorError(
      "identity_required",
      "This door requires the chat turn's acting identity (the signed-in user's login); " +
        "no identity was supplied, or the retired synthetic identity was presented. " +
        "Refusing before dispatch — identities are never defaulted.",
    );
  }
  return login;
}

// ---------------------------------------------------------------------------
// Typed stubs — the seam. Door-local interfaces over the agents'
// real RPC surfaces (the getScreenerAgent/getResearchAgent cast
// precedent); tests fake the namespace at this boundary.
// ---------------------------------------------------------------------------

export interface ScheduledAgentDoorStub {
  listGoals(): Promise<ScheduledGoal[]>;
  triggerGoal(id: string, env?: unknown, actor?: string | null): Promise<ScheduleTick>;
  // Issue #3535 (Pipeline J2): the job-pipeline door — the
  // ScheduledAgent host's control-plane RPC surface (#3543).
  runPipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  pausePipelineJob(jobId: string): Promise<JobInstanceRecord>;
  /** Issue #3121 #3310 — the stage registry read for the stages adapter: one job's status view (carries its definition). */
  getPipelineJobStatus(jobId: string): Promise<JobStatusView>;
  resumePipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  // Issue #3121 #3310 — run one pipeline job stage on its own
  // schedule: the scoped dispatch (scopePath = the stage's node
  // path) with the dispatching schedule id threaded for the
  // terminal run record's linkage.
  runPipelineStage(
    jobId: string,
    opts?: { nodePath?: string; userLogin?: string; scheduleId?: string; trigger?: "manual" | "scheduled" },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  cancelPipelineJob(jobId: string): Promise<JobInstanceRecord>;
  retryPipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  // Issue #3530 (scheduling-config): reconfigure one pipeline job
  // through the engine — the schedule write path.
  configurePipelineJob(jobId: string, patch: unknown): Promise<JobDefinition>;
  getFeedJobSurfaceStatus(jobId: string): Promise<FeedJobSurfaceView>;
  listFeedJobSurfaceStatuses(): Promise<FeedJobSurfaceView[]>;
  // Issue #3536 (Pipeline J3): the enrich jobs' surface on the
  // same host — the run/manage operations above are the generic
  // pipeline RPCs (every job on the plane, enrich included);
  // these two are the enrich merged-status reads.
  getEnrichJobSurfaceStatus(jobId: string): Promise<EnrichJobSurfaceView>;
  listEnrichJobSurfaceStatuses(): Promise<EnrichJobSurfaceView[]>;
  // Issue #3537 (Pipeline J4): the analyze jobs' surface on the
  // same host — same rule: the generic pipeline RPCs above run
  // and manage them; these two are the analyze merged-status reads.
  getAnalyzeJobSurfaceStatus(jobId: string): Promise<AnalyzeJobSurfaceView>;
  listAnalyzeJobSurfaceStatuses(): Promise<AnalyzeJobSurfaceView[]>;
  // Issue #3538 (Pipeline J5): the generate jobs' surface on the
  // same host — same rule again; these two are the generate
  // merged-status reads.
  getGenerateJobSurfaceStatus(jobId: string): Promise<GenerateJobSurfaceView>;
  listGenerateJobSurfaceStatuses(): Promise<GenerateJobSurfaceView[]>;
  // Issue #3539 (Pipeline J6): the deliver jobs' surface on the
  // same host — same rule again; these two are the deliver
  // merged-status reads.
  getDeliverJobSurfaceStatus(jobId: string): Promise<DeliverJobSurfaceView>;
  listDeliverJobSurfaceStatuses(): Promise<DeliverJobSurfaceView[]>;
  // Issue #3540 (Pipeline J7): the composed chains' surface on
  // the same host — the end-to-end roll-up reads, the chain
  // dispatches (which refresh the chain definition from the
  // stored stage definitions first), and the per-stage control
  // operations inside a chain run. Chain pause/cancel ride the
  // generic pipeline RPCs above, like every job on the plane.
  runPipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  resumePipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  retryPipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  getPipelineChainSurfaceStatus(jobId: string): Promise<PipelineChainSurfaceView>;
  listPipelineChainSurfaceStatuses(): Promise<PipelineChainSurfaceView[]>;
  /**
   * Issue #4359 — the Workflow Runs stage read: one batch call for the
   * page's engine job ids, each entry carrying the checkpoint's views
   * and the run they describe.
   */
  getPipelineRunStages(jobIds: string[]): Promise<Record<string, JobStagesRead>>;
  stopPipelineChainStage(jobId: string, stage: string): Promise<JobInstanceRecord>;
  resumePipelineChainStage(
    jobId: string,
    stage: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }>;
  cancelPipelineChainStage(jobId: string, stage: string): Promise<JobInstanceRecord>;
}

export interface PaymentsAgentDoorStub {
  budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
  todaySpent(): Promise<number>;
  listPayments(limit?: number): Promise<PaymentRecord[]>;
  /** Typed for surface completeness; NOT called by any door
   *  operation in this slice (see the header: S10/G5 owns the chat
   *  paid-request flow). */
  processPaidRequest(req: {
    agentId: string;
    operation: string;
    amountCents: number;
    idempotencyKey: string;
    paymentProof: string;
  }): Promise<PaymentRecord>;
}

const SCHEDULED_AGENT_INSTANCE = "default";
const PAYMENTS_AGENT_INSTANCE = "default";

function resolveStub<T>(
  namespace: DurableObjectNamespace | undefined,
  instanceName: string,
  door: string,
): T {
  if (!namespace) {
    throw new MeshDoorError(
      "door_unavailable",
      `${door} is unavailable: its Durable Object binding is not configured in this deployment.`,
    );
  }
  return namespace.get(namespace.idFromName(instanceName)) as unknown as T;
}

export function getScheduledAgentDoor(env: Env): ScheduledAgentDoorStub {
  return resolveStub<ScheduledAgentDoorStub>(
    env.SCHEDULED_AGENT,
    SCHEDULED_AGENT_INSTANCE,
    "ScheduledAgent door",
  );
}

export function getPaymentsAgentDoor(env: Env): PaymentsAgentDoorStub {
  return resolveStub<PaymentsAgentDoorStub>(
    env.PAYMENTS_AGENT,
    PAYMENTS_AGENT_INSTANCE,
    "PaymentsAgent door",
  );
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — list/inspect the goal catalogue, trigger one
// ---------------------------------------------------------------------------

export interface ScheduledGoalsDoorResult {
  goals: ScheduledGoal[];
}

/**
 * List the scheduled-goal catalogue, or inspect one goal when
 * goalId is given. The catalogue is the shared operator catalogue
 * the session-gated /api/schedule/* routes already expose to any
 * signed-in user (ScheduledGoal carries no owner field); the door
 * mirrors that authority for an identified chat user. An unknown
 * goalId is an honest goal_not_found error, never an empty success.
 */
export async function listScheduledGoalsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  goalId?: string,
): Promise<ScheduledGoalsDoorResult> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  const goals = await door.listGoals();
  if (goalId === undefined) return { goals };
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    throw new MeshDoorError(
      "goal_not_found",
      `No scheduled goal with id "${goalId}" exists in the catalogue.`,
    );
  }
  return { goals: [goal] };
}

export interface ScheduledGoalTriggerDoorResult {
  goalId: string;
  tick: ScheduleTick;
}

/**
 * Trigger one goal now. The returned tick is ScheduledAgent's own
 * outcome, verbatim: a budget-denied or skipped firing surfaces in
 * tick.errors / jobsSkipped — the door never converts it into a
 * success shape.
 */
export async function triggerScheduledGoalViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  goalId: string,
): Promise<ScheduledGoalTriggerDoorResult> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  // Issue #3121 S3 (#3312) — the mesh door is a third entry path
  // into the DO mutation methods, so it threads the identified chat
  // user as the lifecycle-audit actor (the DO funnel emits
  // `schedule.goal.triggered` with it when the goal fires).
  const tick = await door.triggerGoal(goalId, undefined, actingLogin);
  return { goalId, tick };
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — the job pipeline's feed jobs (#3535)
// ---------------------------------------------------------------------------

/**
 * Resolve a caller's feed-job name ("Yahoo", "Alpaca",
 * "Nasdaq-100", "SP100", "fundamentals", an exact job id) to its
 * catalog entry. An ambiguous or unknown name is an honest
 * feed_job_not_found error — the door never guesses a job.
 */
function resolveFeedJobOrThrow(source: string) {
  const entry = resolveFeedJob(source);
  if (!entry) {
    throw new MeshDoorError(
      "feed_job_not_found",
      `No feed job matches "${source}". Name a source (yahoo, alpaca, etrade, public), a universe (nasdaq100, sp100), "fundamentals", or an exact feed job id.`,
    );
  }
  return entry;
}

export interface FeedJobRunDoorResult {
  jobId: string;
  label: string;
  runId: string;
  state: string;
  error?: string;
  status: FeedJobSurfaceView;
}

/**
 * Run one feed job now through the pipeline host's control plane
 * and report its settled outcome + the merged status view (the
 * same view the UX surface renders — one source of truth). The
 * acting login threads into the per-login provider wiring
 * (E*TRADE / Public) exactly as a session dispatch would.
 */
export async function runFeedJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<FeedJobRunDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveFeedJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const run = await door.runPipelineJob(entry.jobId, { userLogin: login });
  const status = await door.getFeedJobSurfaceStatus(entry.jobId);
  return {
    jobId: entry.jobId,
    label: entry.label,
    runId: run.runId,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    status,
  };
}

/** One feed job's merged status (dataset copy + pipeline state). */
export async function getFeedJobStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<FeedJobSurfaceView> {
  requireActingLogin(actingLogin);
  const entry = resolveFeedJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  return door.getFeedJobSurfaceStatus(entry.jobId);
}

/** Every feed job's merged status, in catalog order. */
export async function listFeedJobsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
): Promise<{ jobs: FeedJobSurfaceView[] }> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  return { jobs: await door.listFeedJobSurfaceStatuses() };
}

export type FeedJobManagementAction = "pause" | "resume" | "cancel" | "retry";

export interface FeedJobManageDoorResult {
  jobId: string;
  label: string;
  action: FeedJobManagementAction;
  /** The instance record for pause/cancel; the settled outcome for resume/retry. */
  instance?: JobInstanceRecord;
  run?: { runId: string; state: string; error?: string };
  status: FeedJobSurfaceView;
}

/**
 * Apply one management operation to a feed job through the same
 * control plane (pause at the next step boundary, resume from
 * the persisted checkpoint, cancel terminally, retry as a new
 * run). The control plane's own refusals (e.g. pausing a job
 * that is not running) propagate — the door never converts them
 * into a success shape.
 */
export async function manageFeedJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  action: FeedJobManagementAction,
): Promise<FeedJobManageDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveFeedJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const base = { jobId: entry.jobId, label: entry.label, action };
  switch (action) {
    case "pause": {
      const instance = await door.pausePipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getFeedJobSurfaceStatus(entry.jobId) };
    }
    case "cancel": {
      const instance = await door.cancelPipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getFeedJobSurfaceStatus(entry.jobId) };
    }
    case "resume": {
      const run = await door.resumePipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getFeedJobSurfaceStatus(entry.jobId) };
    }
    case "retry": {
      const run = await door.retryPipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getFeedJobSurfaceStatus(entry.jobId) };
    }
  }
}

/** A feed job's schedule patch, in the engine's native shape (#3530 scheduling-config). */
export interface FeedJobSchedulePatch {
  enabled?: boolean;
  interval?: string;
  cron?: string;
}

export interface FeedJobScheduleDoorResult {
  jobId: string;
  label: string;
  /** The stored schedule after the patch, as the surface view reports it. */
  schedule: FeedJobSurfaceView["schedule"];
  status: FeedJobSurfaceView;
}

/**
 * Configure one feed job's schedule through the pipeline host's
 * control plane (#3530 scheduling-config). The patch MERGES over
 * the stored schedule — fields the patch omits keep their stored
 * values, so disabling a schedule never loses its cadence and a
 * cadence change never flips its enablement — and is applied as
 * the engine's own configure patch ({ root: { schedule } }); no
 * parallel schedule shape exists anywhere in the chain. The
 * stored schedule the result reports is read back from the merged
 * status view: the same source the UX renders.
 */
export async function configureFeedJobScheduleViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  patch: FeedJobSchedulePatch,
): Promise<FeedJobScheduleDoorResult> {
  requireActingLogin(actingLogin);
  const entry = resolveFeedJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const before = await door.getFeedJobSurfaceStatus(entry.jobId);
  const current = before.schedule;
  // An interval patch supersedes a stored cron and vice versa:
  // the engine's grammar carries one cadence mechanism per node.
  const interval = patch.interval ?? (patch.cron ? null : current?.interval ?? null);
  const cron = patch.cron ?? (patch.interval ? null : current?.cron ?? null);
  const schedule: JobScheduleConfig = {
    enabled: patch.enabled ?? current?.enabled ?? true,
    ...(interval ? { interval } : {}),
    ...(cron ? { cron } : {}),
  };
  await door.configurePipelineJob(entry.jobId, { root: { schedule } });
  const status = await door.getFeedJobSurfaceStatus(entry.jobId);
  return { jobId: entry.jobId, label: entry.label, schedule: status.schedule, status };
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — the job pipeline's enrich jobs (#3536)
// ---------------------------------------------------------------------------

/**
 * Resolve a caller's enrich-job name ("yahoo enrich",
 * "enrich alpaca", "sp100 enrich", an exact job id) to its
 * catalog entry. An ambiguous or unknown name is an honest
 * enrich_job_not_found error — the door never guesses a job.
 */
function resolveEnrichJobOrThrow(source: string) {
  const entry = resolveEnrichJob(source);
  if (!entry) {
    throw new MeshDoorError(
      "enrich_job_not_found",
      `No enrich job matches "${source}". Name a source with its universe ("yahoo nasdaq100 enrich", "sp100 enrich", "enrich alpaca", "enrich etrade", "enrich public") or an exact enrich job id.`,
    );
  }
  return entry;
}

export interface EnrichJobRunDoorResult {
  jobId: string;
  label: string;
  runId: string;
  state: string;
  error?: string;
  status: EnrichJobSurfaceView;
}

/**
 * Run one enrich job now through the pipeline host's control
 * plane (the same generic runPipelineJob RPC every job on the
 * plane dispatches through) and report its settled outcome +
 * the merged status view (the same view the UX renders).
 */
export async function runEnrichJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<EnrichJobRunDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveEnrichJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const run = await door.runPipelineJob(entry.jobId, { userLogin: login });
  const status = await door.getEnrichJobSurfaceStatus(entry.jobId);
  return {
    jobId: entry.jobId,
    label: entry.label,
    runId: run.runId,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    status,
  };
}

/** One enrich job's merged status (enriched copy + pipeline state). */
export async function getEnrichJobStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<EnrichJobSurfaceView> {
  requireActingLogin(actingLogin);
  const entry = resolveEnrichJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  return door.getEnrichJobSurfaceStatus(entry.jobId);
}

/** Every enrich job's merged status, in catalog order. */
export async function listEnrichJobsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
): Promise<{ jobs: EnrichJobSurfaceView[] }> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  return { jobs: await door.listEnrichJobSurfaceStatuses() };
}

export type EnrichJobManagementAction = "pause" | "resume" | "cancel" | "retry";

export interface EnrichJobManageDoorResult {
  jobId: string;
  label: string;
  action: EnrichJobManagementAction;
  instance?: JobInstanceRecord;
  run?: { runId: string; state: string; error?: string };
  status: EnrichJobSurfaceView;
}

/**
 * Apply one management operation to an enrich job through the
 * same control plane (the feed door's manage, transposed). The
 * control plane's own refusals propagate unchanged.
 */
export async function manageEnrichJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  action: EnrichJobManagementAction,
): Promise<EnrichJobManageDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveEnrichJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const base = { jobId: entry.jobId, label: entry.label, action };
  switch (action) {
    case "pause": {
      const instance = await door.pausePipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getEnrichJobSurfaceStatus(entry.jobId) };
    }
    case "cancel": {
      const instance = await door.cancelPipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getEnrichJobSurfaceStatus(entry.jobId) };
    }
    case "resume": {
      const run = await door.resumePipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getEnrichJobSurfaceStatus(entry.jobId) };
    }
    case "retry": {
      const run = await door.retryPipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getEnrichJobSurfaceStatus(entry.jobId) };
    }
  }
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — the job pipeline's analyze jobs (#3537)
// ---------------------------------------------------------------------------

/**
 * Resolve a caller's analyze-job name ("yahoo analyze",
 * "analyze alpaca", "sp100 analyze", an exact job id) to its
 * catalog entry. An ambiguous or unknown name is an honest
 * analyze_job_not_found error — the door never guesses a job.
 */
function resolveAnalyzeJobOrThrow(source: string) {
  const entry = resolveAnalyzeJob(source);
  if (!entry) {
    throw new MeshDoorError(
      "analyze_job_not_found",
      `No analyze job matches "${source}". Name a source with its universe ("yahoo nasdaq100 analyze", "sp100 analyze", "analyze alpaca", "analyze etrade", "analyze public") or an exact analyze job id.`,
    );
  }
  return entry;
}

export interface AnalyzeJobRunDoorResult {
  jobId: string;
  label: string;
  runId: string;
  state: string;
  error?: string;
  status: AnalyzeJobSurfaceView;
}

/**
 * Run one analyze job now through the pipeline host's control
 * plane (the same generic runPipelineJob RPC every job on the
 * plane dispatches through) and report its settled outcome +
 * the merged status view (the same view the UX renders).
 */
export async function runAnalyzeJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<AnalyzeJobRunDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveAnalyzeJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const run = await door.runPipelineJob(entry.jobId, { userLogin: login });
  const status = await door.getAnalyzeJobSurfaceStatus(entry.jobId);
  return {
    jobId: entry.jobId,
    label: entry.label,
    runId: run.runId,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    status,
  };
}

/** One analyze job's merged status (analyzed copy + pipeline state). */
export async function getAnalyzeJobStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<AnalyzeJobSurfaceView> {
  requireActingLogin(actingLogin);
  const entry = resolveAnalyzeJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  return door.getAnalyzeJobSurfaceStatus(entry.jobId);
}

/** Every analyze job's merged status, in catalog order. */
export async function listAnalyzeJobsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
): Promise<{ jobs: AnalyzeJobSurfaceView[] }> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  return { jobs: await door.listAnalyzeJobSurfaceStatuses() };
}

export type AnalyzeJobManagementAction = "pause" | "resume" | "cancel" | "retry";

export interface AnalyzeJobManageDoorResult {
  jobId: string;
  label: string;
  action: AnalyzeJobManagementAction;
  instance?: JobInstanceRecord;
  run?: { runId: string; state: string; error?: string };
  status: AnalyzeJobSurfaceView;
}

/**
 * Apply one management operation to an analyze job through the
 * same control plane (the enrich door's manage, transposed).
 * The control plane's own refusals propagate unchanged.
 */
export async function manageAnalyzeJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  action: AnalyzeJobManagementAction,
): Promise<AnalyzeJobManageDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveAnalyzeJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const base = { jobId: entry.jobId, label: entry.label, action };
  switch (action) {
    case "pause": {
      const instance = await door.pausePipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getAnalyzeJobSurfaceStatus(entry.jobId) };
    }
    case "cancel": {
      const instance = await door.cancelPipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getAnalyzeJobSurfaceStatus(entry.jobId) };
    }
    case "resume": {
      const run = await door.resumePipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getAnalyzeJobSurfaceStatus(entry.jobId) };
    }
    case "retry": {
      const run = await door.retryPipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getAnalyzeJobSurfaceStatus(entry.jobId) };
    }
  }
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — the job pipeline's generate jobs (#3538)
// ---------------------------------------------------------------------------

/**
 * Resolve a caller's generate-job name ("yahoo generate",
 * "generate alpaca", "sp100 generate", an exact job id) to its
 * catalog entry. An ambiguous or unknown name is an honest
 * generate_job_not_found error — the door never guesses a job.
 */
function resolveGenerateJobOrThrow(source: string) {
  const entry = resolveGenerateJob(source);
  if (!entry) {
    throw new MeshDoorError(
      "generate_job_not_found",
      `No generate job matches "${source}". Name a source with its universe ("yahoo nasdaq100 generate", "sp100 generate", "generate alpaca", "generate etrade", "generate public") or an exact generate job id.`,
    );
  }
  return entry;
}

export interface GenerateJobRunDoorResult {
  jobId: string;
  label: string;
  runId: string;
  state: string;
  error?: string;
  status: GenerateJobSurfaceView;
}

/**
 * Run one generate job now through the pipeline host's control
 * plane (the same generic runPipelineJob RPC every job on the
 * plane dispatches through) and report its settled outcome +
 * the merged status view (the same view the UX renders).
 */
export async function runGenerateJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<GenerateJobRunDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveGenerateJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const run = await door.runPipelineJob(entry.jobId, { userLogin: login });
  const status = await door.getGenerateJobSurfaceStatus(entry.jobId);
  return {
    jobId: entry.jobId,
    label: entry.label,
    runId: run.runId,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    status,
  };
}

/** One generate job's merged status (generated copy + pipeline state). */
export async function getGenerateJobStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<GenerateJobSurfaceView> {
  requireActingLogin(actingLogin);
  const entry = resolveGenerateJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  return door.getGenerateJobSurfaceStatus(entry.jobId);
}

/** Every generate job's merged status, in catalog order. */
export async function listGenerateJobsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
): Promise<{ jobs: GenerateJobSurfaceView[] }> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  return { jobs: await door.listGenerateJobSurfaceStatuses() };
}

export type GenerateJobManagementAction = "pause" | "resume" | "cancel" | "retry";

export interface GenerateJobManageDoorResult {
  jobId: string;
  label: string;
  action: GenerateJobManagementAction;
  instance?: JobInstanceRecord;
  run?: { runId: string; state: string; error?: string };
  status: GenerateJobSurfaceView;
}

/**
 * Apply one management operation to a generate job through the
 * same control plane (the analyze door's manage, transposed).
 * The control plane's own refusals propagate unchanged.
 */
export async function manageGenerateJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  action: GenerateJobManagementAction,
): Promise<GenerateJobManageDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveGenerateJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const base = { jobId: entry.jobId, label: entry.label, action };
  switch (action) {
    case "pause": {
      const instance = await door.pausePipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getGenerateJobSurfaceStatus(entry.jobId) };
    }
    case "cancel": {
      const instance = await door.cancelPipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getGenerateJobSurfaceStatus(entry.jobId) };
    }
    case "resume": {
      const run = await door.resumePipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getGenerateJobSurfaceStatus(entry.jobId) };
    }
    case "retry": {
      const run = await door.retryPipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getGenerateJobSurfaceStatus(entry.jobId) };
    }
  }
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — the job pipeline's deliver jobs (#3539)
// ---------------------------------------------------------------------------

/**
 * Resolve a caller's deliver-job name ("yahoo deliver",
 * "deliver alpaca", "sp100 deliver", an exact job id) to its
 * catalog entry. An ambiguous or unknown name is an honest
 * deliver_job_not_found error — the door never guesses a job.
 */
function resolveDeliverJobOrThrow(source: string) {
  const entry = resolveDeliverJob(source);
  if (!entry) {
    throw new MeshDoorError(
      "deliver_job_not_found",
      `No deliver job matches "${source}". Name a source with its universe ("yahoo nasdaq100 deliver", "sp100 deliver", "deliver alpaca", "deliver etrade", "deliver public") or an exact deliver job id.`,
    );
  }
  return entry;
}

export interface DeliverJobRunDoorResult {
  jobId: string;
  label: string;
  runId: string;
  state: string;
  error?: string;
  status: DeliverJobSurfaceView;
}

/**
 * Run one deliver job now through the pipeline host's control
 * plane (the same generic runPipelineJob RPC every job on the
 * plane dispatches through) and report its settled outcome +
 * the merged status view (the same view the UX renders).
 */
export async function runDeliverJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<DeliverJobRunDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveDeliverJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const run = await door.runPipelineJob(entry.jobId, { userLogin: login });
  const status = await door.getDeliverJobSurfaceStatus(entry.jobId);
  return {
    jobId: entry.jobId,
    label: entry.label,
    runId: run.runId,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    status,
  };
}

/** One deliver job's merged status (delivery copy + pipeline state). */
export async function getDeliverJobStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<DeliverJobSurfaceView> {
  requireActingLogin(actingLogin);
  const entry = resolveDeliverJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  return door.getDeliverJobSurfaceStatus(entry.jobId);
}

/** Every deliver job's merged status, in catalog order. */
export async function listDeliverJobsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
): Promise<{ jobs: DeliverJobSurfaceView[] }> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  return { jobs: await door.listDeliverJobSurfaceStatuses() };
}

export type DeliverJobManagementAction = "pause" | "resume" | "cancel" | "retry";

export interface DeliverJobManageDoorResult {
  jobId: string;
  label: string;
  action: DeliverJobManagementAction;
  instance?: JobInstanceRecord;
  run?: { runId: string; state: string; error?: string };
  status: DeliverJobSurfaceView;
}

/**
 * Apply one management operation to a deliver job through the
 * same control plane (the generate door's manage, transposed).
 * The control plane's own refusals propagate unchanged.
 */
export async function manageDeliverJobViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  action: DeliverJobManagementAction,
): Promise<DeliverJobManageDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolveDeliverJobOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const base = { jobId: entry.jobId, label: entry.label, action };
  switch (action) {
    case "pause": {
      const instance = await door.pausePipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getDeliverJobSurfaceStatus(entry.jobId) };
    }
    case "cancel": {
      const instance = await door.cancelPipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getDeliverJobSurfaceStatus(entry.jobId) };
    }
    case "resume": {
      const run = await door.resumePipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getDeliverJobSurfaceStatus(entry.jobId) };
    }
    case "retry": {
      const run = await door.retryPipelineJob(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getDeliverJobSurfaceStatus(entry.jobId) };
    }
  }
}

// ---------------------------------------------------------------------------
// ScheduledAgent door — the composed pipeline chains (#3540)
// ---------------------------------------------------------------------------

/**
 * Resolve a caller's chain name ("yahoo nasdaq100 pipeline",
 * "alpaca pipeline", an exact chain job id) to its catalog
 * entry. An ambiguous or unknown name is an honest
 * pipeline_chain_not_found error — the door never guesses.
 */
function resolvePipelineChainOrThrow(source: string) {
  const entry = resolvePipelineChain(source);
  if (!entry) {
    throw new MeshDoorError(
      "pipeline_chain_not_found",
      `No pipeline chain matches "${source}". Name a source with its universe ("yahoo nasdaq100 pipeline", "sp100 pipeline", "alpaca pipeline", "etrade pipeline", "public pipeline") or an exact pipeline chain job id.`,
    );
  }
  return entry;
}

export interface PipelineChainRunDoorResult {
  jobId: string;
  label: string;
  runId: string;
  state: string;
  error?: string;
  status: PipelineChainSurfaceView;
}

/**
 * Issue #3787: the bridge handle a caller supplies when it owns
 * a mas_async_jobs store for this chain run (the MCP command's
 * orchestrator instance store). Absent → the chain runs
 * unbridged (its own control-plane records still exist; only
 * its stuck coverage is off). The door never invents a store:
 * without a handle there is nowhere honest to write the row.
 */
export interface PipelineChainRunBridge {
  ports: AsyncJobPorts;
  /** The mas_async_jobs session (the orchestrator instance id). */
  sessionId: string;
}

/**
 * Run one composed chain end-to-end through the pipeline
 * host's control plane (the chain dispatch refreshes the
 * chain definition from the stored stage definitions first)
 * and report its settled outcome + the end-to-end status view
 * (the same view the UX renders).
 *
 * Issue #3787: when a bridge handle is supplied, the run is
 * bridged into mas_async_jobs (insert + claim to `running`
 * before dispatch, settled from the run's terminal state
 * after) so the #3784 sweep owns stuck detection for it — a
 * dispatch that never settles leaves its row `running` for
 * the sweep to alert (30 min) and reap (2h). A dispatch that
 * throws fails the bridge row with the throw's message (the
 * run never started under this call). Non-terminal states
 * (running/queued/paused) leave the row `running` — the sweep
 * owns the verdict, including for a paused run (see the #3787
 * repair doc's known limitation).
 */
export async function runPipelineChainViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  opts?: { runBridge?: PipelineChainRunBridge },
): Promise<PipelineChainRunDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolvePipelineChainOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const bridge = opts?.runBridge;
  const nowIso = new Date().toISOString();
  const bridgeJobId = `chain:${entry.jobId}:${nowIso}:${crypto.randomUUID().slice(0, 8)}`;
  let bridged = false;
  if (bridge) {
    bridged = bridgeRunStart(bridge.ports, {
      jobId: bridgeJobId,
      sessionId: bridge.sessionId,
      capability: "pipeline.chain",
      displayName: `Pipeline chain — ${entry.label}`,
      userLogin: login,
      trigger: "manual",
      chainJobId: entry.jobId,
      nowIso,
    });
  }
  let run: Awaited<ReturnType<typeof door.runPipelineChain>>;
  try {
    run = await door.runPipelineChain(entry.jobId, { userLogin: login });
  } catch (err) {
    if (bridged && bridge) {
      bridgeRunFail(
        bridge.ports,
        bridgeJobId,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
  if (bridged && bridge) {
    if (run.state === "completed") {
      bridgeRunComplete(
        bridge.ports,
        bridgeJobId,
        JSON.stringify({ status: "completed", runId: run.runId, state: run.state }),
      );
    } else if (run.state === "failed" || run.state === "cancelled") {
      bridgeRunFail(
        bridge.ports,
        bridgeJobId,
        run.error ??
          `Pipeline chain run ${run.runId} ended with state "${run.state}".`,
      );
    }
    // running / queued / paused: leave the row running — the
    // #3784 sweep owns the stuck verdict.
  }
  const status = await door.getPipelineChainSurfaceStatus(entry.jobId);
  return {
    jobId: entry.jobId,
    label: entry.label,
    runId: run.runId,
    state: run.state,
    ...(run.error ? { error: run.error } : {}),
    status,
  };
}

/** One chain's end-to-end status (per-stage states + frontier). */
export async function getPipelineChainStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
): Promise<PipelineChainSurfaceView> {
  requireActingLogin(actingLogin);
  const entry = resolvePipelineChainOrThrow(source);
  const door = getScheduledAgentDoor(env);
  return door.getPipelineChainSurfaceStatus(entry.jobId);
}

/** Every chain's end-to-end status, in catalog order. */
export async function listPipelineChainsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
): Promise<{ jobs: PipelineChainSurfaceView[] }> {
  requireActingLogin(actingLogin);
  const door = getScheduledAgentDoor(env);
  return { jobs: await door.listPipelineChainSurfaceStatuses() };
}

export type PipelineChainManagementAction =
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "stage_pause"
  | "stage_resume"
  | "stage_cancel";

export interface PipelineChainManageDoorResult {
  jobId: string;
  label: string;
  action: PipelineChainManagementAction;
  stage?: string;
  instance?: JobInstanceRecord;
  run?: { runId: string; state: string; error?: string };
  status: PipelineChainSurfaceView;
}

/**
 * Apply one management operation to a pipeline chain through
 * the same control plane: pause / resume / cancel / retry of
 * the chain itself, and stop / resume / cancel of any single
 * stage inside its run (the #3549 stage operations, addressed
 * by stage kind through the chain's own definition). The
 * control plane's own refusals propagate unchanged.
 */
export async function managePipelineChainViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  source: string,
  action: PipelineChainManagementAction,
  stage?: string,
): Promise<PipelineChainManageDoorResult> {
  const login = requireActingLogin(actingLogin);
  const entry = resolvePipelineChainOrThrow(source);
  const door = getScheduledAgentDoor(env);
  const base = { jobId: entry.jobId, label: entry.label, action };
  switch (action) {
    case "pause": {
      const instance = await door.pausePipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getPipelineChainSurfaceStatus(entry.jobId) };
    }
    case "cancel": {
      const instance = await door.cancelPipelineJob(entry.jobId);
      return { ...base, instance, status: await door.getPipelineChainSurfaceStatus(entry.jobId) };
    }
    case "resume": {
      const run = await door.resumePipelineChain(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getPipelineChainSurfaceStatus(entry.jobId) };
    }
    case "retry": {
      const run = await door.retryPipelineChain(entry.jobId, { userLogin: login });
      return { ...base, run, status: await door.getPipelineChainSurfaceStatus(entry.jobId) };
    }
    case "stage_pause":
    case "stage_resume":
    case "stage_cancel": {
      if (!stage || !stage.trim()) {
        throw new MeshDoorError(
          "pipeline_chain_stage_required",
          `The ${action} operation on pipeline chain "${entry.jobId}" requires a stage (feed, enrich, analyze, generate, or deliver).`,
        );
      }
      const stageName = stage.trim().toLowerCase();
      if (action === "stage_pause") {
        const instance = await door.stopPipelineChainStage(entry.jobId, stageName);
        return { ...base, stage: stageName, instance, status: await door.getPipelineChainSurfaceStatus(entry.jobId) };
      }
      if (action === "stage_cancel") {
        const instance = await door.cancelPipelineChainStage(entry.jobId, stageName);
        return { ...base, stage: stageName, instance, status: await door.getPipelineChainSurfaceStatus(entry.jobId) };
      }
      const run = await door.resumePipelineChainStage(entry.jobId, stageName, {
        userLogin: login,
      });
      return { ...base, stage: stageName, run, status: await door.getPipelineChainSurfaceStatus(entry.jobId) };
    }
  }
}

// ---------------------------------------------------------------------------
// PaymentsAgent door — budget check + the read side
// ---------------------------------------------------------------------------

export interface PaymentBudgetDoorResult {
  allowed: boolean;
  reason?: string;
  /** The spend bucket the check was evaluated against. */
  agentId: string;
  operation: string;
  amountCents: number;
}

/**
 * Ask PaymentsAgent whether the orchestrator spend bucket may
 * spend amountCents on operation. The guard's verdict propagates
 * as-is, denial reason included; the check records nothing (only
 * processPaidRequest records, after verification).
 */
export async function checkPaymentBudgetViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { operation: string; amountCents: number },
): Promise<PaymentBudgetDoorResult> {
  requireActingLogin(actingLogin);
  const door = getPaymentsAgentDoor(env);
  const verdict = await door.budgetCheck({
    operation: input.operation,
    amountCents: input.amountCents,
    agentId: AGENTIC_SPEND_AGENT_ID,
  });
  return {
    allowed: verdict.allowed,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    agentId: AGENTIC_SPEND_AGENT_ID,
    operation: input.operation,
    amountCents: input.amountCents,
  };
}

export interface PaymentsOverviewDoorResult {
  todaySpentCents: number;
  recentPayments: PaymentRecord[];
}

/** The payments read side a turn may show: today's total spend and
 *  the most recent ledger payments, both read by PaymentsAgent from
 *  the ledger of record. */
export async function getPaymentsOverviewViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  limit = 10,
): Promise<PaymentsOverviewDoorResult> {
  requireActingLogin(actingLogin);
  const door = getPaymentsAgentDoor(env);
  const todaySpentCents = await door.todaySpent();
  const recentPayments = await door.listPayments(limit);
  return { todaySpentCents, recentPayments };
}

// ---------------------------------------------------------------------------
// TradingAgent door (#2349) — proposals + reads, per-user instance.
// The approval door is NOT part of this stub (see the header): the
// stub types only the proposal-side executeService and the typed
// read surface, so no door operation can reach trade execution.
// ---------------------------------------------------------------------------

/** The door-local shape of a TradingServiceCall: the fields the
 *  door supplies. The agent fills ORM/storage from its own
 *  instance handles (the executeService contract). */
export interface TradingServiceDoorCall {
  serviceId: string;
  input?: Record<string, unknown>;
  /** The acting identity, threaded at the call level — the agent
   *  executes under it. Never read from the service input. */
  userLogin: string;
}

/** The approval door's start result (TradingAgent.startTradeApproval). */
export interface TradeApprovalStartDoorResult {
  workflowId: string;
  orderId: string;
  status: "awaiting_approval";
}

/** The approval door's decision result (TradingAgent.decideTradeApproval). */
export interface TradeApprovalDecisionDoorResult {
  workflowId: string;
  delivered: true;
}

export interface TradingAgentDoorStub {
  executeService(call: TradingServiceDoorCall): Promise<unknown>;
  getAccounts(provider?: string): Promise<unknown>;
  getPositions(accountKey?: string, provider?: string): Promise<unknown>;
  getQuote(symbol: string, provider?: string): Promise<unknown>;
  /** #2375 (batch D): the approval door's workflow operations —
   *  start a TradingTradeWorkflow run for a previewed order, and
   *  deliver a decision to it. The synchronous settle
   *  (executeApprovedOrder) is deliberately NOT typed here: it is
   *  reached only by the workflow's own settle step. */
  startTradeApproval(input: {
    orderId: string;
    provider?: string;
    userLogin: string;
    /** Issue #2730: the door call's W3C traceparent (server-side carrier only), carried into the run's params. */
    traceparent?: string;
  }): Promise<TradeApprovalStartDoorResult>;
  decideTradeApproval(input: {
    workflowId: string;
    authorizerDid: string;
    decision: "approved" | "rejected";
    reason?: string;
  }): Promise<TradeApprovalDecisionDoorResult>;
}

export function getTradingAgentDoor(env: Env, actingLogin: string): TradingAgentDoorStub {
  return resolveStub<TradingAgentDoorStub>(
    env.TRADING_AGENT,
    tradingAgentName(actingLogin, getServiceUserLogin(env)),
    "TradingAgent door",
  );
}

export type TradeAction = "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
export type TradeOrderType = "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";

export interface StockTradeProposalInput {
  symbol: string;
  action: TradeAction;
  quantity: number;
  orderType?: TradeOrderType;
  limitPrice?: number;
  stopPrice?: number;
  provider?: string;
}

export interface OptionsTradeLegInput {
  underlyingSymbol: string;
  securityType: "OPTN";
  side: "BUY" | "SELL";
  quantity: number;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expirationDate?: string;
}

export interface OptionsTradeProposalInput extends StockTradeProposalInput {
  optionLegs: OptionsTradeLegInput[];
  strategyNetDebit?: number;
}

/**
 * The trade services' result envelope: a broker preview held as a
 * pending-approval proposal. `status` is the service's own value
 * ("pending_approval" for both trade services); the door returns
 * the envelope verbatim — it never converts a preview into
 * anything resembling an execution result.
 */
export interface TradeProposalDoorResult {
  status: string;
  proposal: ETradeOrderDraft;
  note?: string;
}

/**
 * Create a stock trade proposal through TradingAgent's
 * stock_trading service. Preview only: the service validates the
 * intent against the provider and returns the pending-approval
 * proposal; no order is placed (placement lives behind the
 * agent's approval door, which this door does not expose). The
 * acting identity is threaded as the call's userLogin; the
 * service input is built field-by-field and carries no identity
 * field of its own, so a caller can never smuggle a different
 * identity through the arguments. TradingServiceError tokens from
 * the agent propagate unchanged.
 */
export async function proposeStockTradeViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: StockTradeProposalInput,
): Promise<TradeProposalDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  const serviceInput: Record<string, unknown> = {
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
  };
  if (input.orderType !== undefined) serviceInput.orderType = input.orderType;
  if (input.limitPrice !== undefined) serviceInput.limitPrice = input.limitPrice;
  if (input.stopPrice !== undefined) serviceInput.stopPrice = input.stopPrice;
  if (input.provider !== undefined) serviceInput.provider = input.provider;
  const result = await door.executeService({
    serviceId: "stock_trading",
    input: serviceInput,
    userLogin: login,
  });
  return result as TradeProposalDoorResult;
}

/**
 * Create an options trade proposal through TradingAgent's
 * options_trading service (single-leg or multi-leg via
 * optionLegs). Same discipline as the stock door: preview only,
 * call-level identity, field-by-field input.
 */
export async function proposeOptionsTradeViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: OptionsTradeProposalInput,
): Promise<TradeProposalDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  const serviceInput: Record<string, unknown> = {
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
    optionLegs: input.optionLegs,
  };
  if (input.orderType !== undefined) serviceInput.orderType = input.orderType;
  if (input.limitPrice !== undefined) serviceInput.limitPrice = input.limitPrice;
  if (input.stopPrice !== undefined) serviceInput.stopPrice = input.stopPrice;
  if (input.strategyNetDebit !== undefined) serviceInput.strategyNetDebit = input.strategyNetDebit;
  if (input.provider !== undefined) serviceInput.provider = input.provider;
  const result = await door.executeService({
    serviceId: "options_trading",
    input: serviceInput,
    userLogin: login,
  });
  return result as TradeProposalDoorResult;
}

/** The acting user's broker accounts, read through their own
 *  TradingAgent instance (the platform resolves for the instance's
 *  user). The agent's result propagates verbatim. */
export async function getTradingAccountsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  provider?: string,
): Promise<unknown> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.getAccounts(provider);
}

/** The acting user's broker positions (optionally for one
 *  account), read through their own TradingAgent instance. */
export async function getTradingPositionsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { accountKey?: string; provider?: string },
): Promise<unknown> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.getPositions(input.accountKey, input.provider);
}

/** A quote for one symbol, read through the acting user's own
 *  TradingAgent instance. */
export async function getTradingQuoteViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { symbol: string; provider?: string },
): Promise<unknown> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.getQuote(input.symbol, input.provider);
}

// ---------------------------------------------------------------------------
// TradingAgent approval door (#2375, batch D — S9/G4). A proposal
// created through the batch-B door is submitted to the agent's
// approval door, which starts the durable TradingTradeWorkflow run;
// the human's decision is delivered back through the same door; the
// run's status reads from the workflow binding's own surface.
// ---------------------------------------------------------------------------

/**
 * Submit an existing proposal (an orderId from propose_stock_trade /
 * propose_options_trade) to TradingAgent's approval door: the agent
 * starts a TradingTradeWorkflow run that waits for the decision
 * (up to the workflow's 24h timeout) and settles through the
 * agent's own draft store on an approved decision. The acting
 * identity is threaded as the run's userLogin — the run's owner is
 * the acting user, never the service identity. Places nothing:
 * starting the run only opens the approval wait.
 */
export async function startTradeApprovalViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { orderId: string; provider?: string },
  traceparent?: string,
): Promise<TradeApprovalStartDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.startTradeApproval({
    orderId: input.orderId,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    userLogin: login,
    // Issue #2730: the turn's traceparent rides into the run's
    // params under the S5 carrier discipline — resolved by the
    // door command from its server-side resolver, never a tool
    // argument. Absent → the run's steps record no hops.
    ...(traceparent ? { traceparent } : {}),
  });
}

/**
 * Deliver the human's decision to a running trade approval
 * workflow through TradingAgent's approval door. The authorizer DID
 * is derived here from the acting login (getUserDid — the same
 * derivation the platform stamps on the draft at preview); it is
 * never accepted from the caller, so a decision can only ever be
 * attributed to the signed-in user delivering it. An approved
 * decision makes the workflow settle the draft exactly once; a
 * rejected decision settles it as rejected and places nothing.
 */
export async function decideTradeApprovalViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { workflowId: string; decision: "approved" | "rejected"; reason?: string },
): Promise<TradeApprovalDecisionDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getTradingAgentDoor(env, login);
  return door.decideTradeApproval({
    workflowId: input.workflowId,
    authorizerDid: getUserDid(login),
    decision: input.decision,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

/** The status read for one trade approval run: the workflow
 *  binding's own instance status, shaped without inventing a
 *  vocabulary — `status` is the binding's value verbatim, `output`
 *  carries the run's outcome once complete, `error` its message
 *  once errored. */
export interface TradeApprovalStatusDoorResult {
  workflowId: string;
  status: string;
  output?: unknown;
  error?: string;
}

/**
 * Read one trade approval run's status from the TRADE_WORKFLOW
 * binding. Trading writes no D1 projection (survey §3.1), so the
 * workflow's own status IS the status surface — no second tracker.
 * Identity gates first, as at every door; a missing binding is an
 * honest door_unavailable.
 */
export async function getTradeApprovalStatusViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { workflowId: string },
): Promise<TradeApprovalStatusDoorResult> {
  requireActingLogin(actingLogin);
  const binding = env.TRADE_WORKFLOW as unknown as
    | {
        get(id: string): {
          status(): Promise<{
            status: string;
            output?: unknown;
            error?: { name?: string; message?: string } | string;
          }>;
        };
      }
    | undefined;
  if (!binding) {
    throw new MeshDoorError(
      "door_unavailable",
      "Trade approval status is unavailable: the TRADE_WORKFLOW binding is not configured on this deployment.",
    );
  }
  const s = await binding.get(input.workflowId).status();
  return {
    workflowId: input.workflowId,
    status: s.status,
    ...(s.output !== undefined ? { output: s.output } : {}),
    ...(s.error !== undefined && s.error !== null
      ? {
          error:
            typeof s.error === "string"
              ? s.error
              : (s.error.message ?? s.error.name ?? "workflow error"),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// ReportAssetAgent door (#2349) — list + get, per-user instance.
// Replaces the turn's indirect reach through the report pipeline
// with a direct typed path to the agent that owns the assets.
// ---------------------------------------------------------------------------

export interface ReportAssetAgentDoorStub {
  listAssets(limit?: number): Promise<ReportAssetMeta[]>;
  getAsset(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null>;
}

export function getReportAssetAgentDoor(env: Env, actingLogin: string): ReportAssetAgentDoorStub {
  return resolveStub<ReportAssetAgentDoorStub>(
    env.REPORT_ASSET_AGENT,
    reportAssetAgentName(actingLogin, getServiceUserLogin(env)),
    "ReportAssetAgent door",
  );
}

export interface ReportAssetsDoorResult {
  assets: ReportAssetMeta[];
}

/**
 * List the acting user's report assets (metadata only, newest
 * first) from their own ReportAssetAgent instance — the assets
 * the report pipeline generated for them. Assets generated under
 * the service identity (e.g. via the A2A door) live on the service
 * instance and are not the user's; they are listed only for a
 * turn acting as that identity.
 */
export async function listReportAssetsViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  limit = 20,
): Promise<ReportAssetsDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getReportAssetAgentDoor(env, login);
  const assets = await door.listAssets(limit);
  return { assets };
}

export interface ReportAssetDoorResult {
  key: string;
  fileName: string;
  byteLength: number;
  bytesBase64: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetch one of the acting user's report assets by key, shaped
 * exactly as the report-asset A2A door shapes it (reportAsset
 * A2A dispatch: key, fileName, byteLength, bytesBase64).
 * getAsset's null failure signal (no such key, or the store could
 * not be read) becomes an honest typed asset_not_found error —
 * never an empty success.
 */
export async function getReportAssetViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  key: string,
): Promise<ReportAssetDoorResult> {
  const login = requireActingLogin(actingLogin);
  const door = getReportAssetAgentDoor(env, login);
  const stored = await door.getAsset(key);
  if (!stored) {
    throw new MeshDoorError(
      "asset_not_found",
      `No report asset stored under key "${key}" for this user (or the asset store could not be read).`,
    );
  }
  return {
    key,
    fileName: stored.fileName,
    byteLength: stored.bytes.length,
    bytesBase64: bytesToBase64(stored.bytes),
  };
}

// ---------------------------------------------------------------------------
// BrowserAgent door (#2351) — transaction snap, page capture, table
// scrape. Fixed instance "browser" (A2A parity: the class is
// stateless, every method delegates to a service built from env,
// so any instance name behaves identically). Delivery options are
// typed WITHOUT a webhookUrl field — see the header's policy.
// ---------------------------------------------------------------------------

export interface BrowserAgentDoorStub {
  sendTransactionSnapToSlack(
    tx: TransactionSnapData,
    options: { channel?: string; caption?: string },
  ): Promise<BrowserAgentSnapResult>;
  capturePageSnapshot(
    url: string,
    options: { caption?: string; channel?: string },
  ): Promise<BrowserAgentSnapResult>;
  scrapeTables(url: string): Promise<BrowserInspectResult>;
}

const BROWSER_AGENT_INSTANCE = "browser";

export function getBrowserAgentDoor(env: Env): BrowserAgentDoorStub {
  return resolveStub<BrowserAgentDoorStub>(
    env.BROWSER_AGENT,
    BROWSER_AGENT_INSTANCE,
    "BrowserAgent door",
  );
}

/**
 * The door-local transaction shape: the TransactionSnapData
 * fields a chat caller may supply. The door builds the
 * TransactionSnapData field-by-field from it, so nothing else a
 * caller attaches (an identity field, a delivery URL) can travel
 * into the agent call.
 */
export interface TransactionSnapDoorInput {
  transactionId: string;
  symbol: string;
  action: string;
  quantity: number;
  status: string;
  price?: number;
  orderType?: string;
  totalValue?: number;
  environment?: string;
  accountKey?: string;
  commission?: number;
  timestamp?: string;
  humanApproved?: boolean;
  notes?: string;
  legs?: Array<{
    action: string;
    symbol: string;
    strike?: number;
    expiry?: string;
    type?: string;
  }>;
}

function buildTransactionSnap(input: TransactionSnapDoorInput): TransactionSnapData {
  const tx: TransactionSnapData = {
    transactionId: input.transactionId,
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
    status: input.status,
  };
  if (input.price !== undefined) tx.price = input.price;
  if (input.orderType !== undefined) tx.orderType = input.orderType;
  if (input.totalValue !== undefined) tx.totalValue = input.totalValue;
  if (input.environment !== undefined) tx.environment = input.environment;
  if (input.accountKey !== undefined) tx.accountKey = input.accountKey;
  if (input.commission !== undefined) tx.commission = input.commission;
  if (input.timestamp !== undefined) tx.timestamp = input.timestamp;
  if (input.humanApproved !== undefined) tx.humanApproved = input.humanApproved;
  if (input.notes !== undefined) tx.notes = input.notes;
  if (input.legs !== undefined) tx.legs = input.legs;
  return tx;
}

/**
 * Generate a transaction snap receipt and deliver it to the
 * configured Slack destination through BrowserAgent. The
 * agent's result propagates verbatim: a not-delivered outcome
 * (success: false with its reason) is the honest result, never
 * converted into a success shape.
 */
export async function sendTransactionSnapViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { transaction: TransactionSnapDoorInput; channel?: string; caption?: string },
): Promise<BrowserAgentSnapResult> {
  requireActingLogin(actingLogin);
  const door = getBrowserAgentDoor(env);
  const options: { channel?: string; caption?: string } = {};
  if (input.channel !== undefined) options.channel = input.channel;
  if (input.caption !== undefined) options.caption = input.caption;
  return door.sendTransactionSnapToSlack(buildTransactionSnap(input.transaction), options);
}

/**
 * Capture a rendered page snapshot through BrowserAgent and
 * deliver it to the configured Slack destination. Same
 * verbatim-result discipline as the transaction snap.
 */
export async function capturePageSnapshotViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { url: string; caption?: string; channel?: string },
): Promise<BrowserAgentSnapResult> {
  requireActingLogin(actingLogin);
  const door = getBrowserAgentDoor(env);
  const options: { caption?: string; channel?: string } = {};
  if (input.caption !== undefined) options.caption = input.caption;
  if (input.channel !== undefined) options.channel = input.channel;
  return door.capturePageSnapshot(input.url, options);
}

/**
 * Scrape structured DOM tables from a rendered page through
 * BrowserAgent. The inspect result propagates verbatim —
 * including its provenance labelling: when no real Browser
 * Rendering capture was available, the service marks the
 * screenshot "placeholder" (#120), and the door returns that
 * label untouched rather than presenting the image as a capture
 * of the page.
 */
export async function scrapePageTablesViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  url: string,
): Promise<BrowserInspectResult> {
  requireActingLogin(actingLogin);
  const door = getBrowserAgentDoor(env);
  return door.scrapeTables(url);
}

// ---------------------------------------------------------------------------
// SlackAgent door (#2351) — the class's two outbound domain
// helpers. Fixed instance "slack" (A2A parity). Slack ingress is
// NOT part of this door (S13/G10): nothing here parses Slack
// payloads, and the class's sessionKey fallback is untouched.
// ---------------------------------------------------------------------------

export interface SlackAgentDoorStub {
  sendPreTradeApprovalTicket(
    draft: PreTradeApprovalDraft,
    options: { channel?: string; threadTs?: string },
  ): Promise<{ success: boolean; payload: unknown; orderId: string }>;
  dispatchTransactionSnap(
    tx: TransactionSnapData,
    options: { channel?: string; caption?: string },
  ): Promise<BrowserAgentSnapResult>;
}

const SLACK_AGENT_INSTANCE = "slack";

export function getSlackAgentDoor(env: Env): SlackAgentDoorStub {
  return resolveStub<SlackAgentDoorStub>(
    env.SLACK_AGENT,
    SLACK_AGENT_INSTANCE,
    "SlackAgent door",
  );
}

/**
 * The door-local approval-draft shape: the PreTradeApprovalDraft
 * fields a chat caller may supply (its channel field is
 * deliberately not one of them — the delivery channel is a door
 * option, as on the A2A door). The door builds the draft
 * field-by-field, so no extra caller field travels.
 */
export interface PreTradeApprovalDraftDoorInput {
  orderId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  estimatedPrice?: number | string;
  estimatedTotal?: number | string;
  commission?: number | string;
  proposerDid?: string;
  expiresAt?: string;
  notes?: string;
}

function buildPreTradeApprovalDraft(
  input: PreTradeApprovalDraftDoorInput,
): PreTradeApprovalDraft {
  const draft: PreTradeApprovalDraft = {
    orderId: input.orderId,
    symbol: input.symbol,
    action: input.action,
    quantity: input.quantity,
  };
  if (input.orderType !== undefined) draft.orderType = input.orderType;
  if (input.limitPrice !== undefined) draft.limitPrice = input.limitPrice;
  if (input.estimatedPrice !== undefined) draft.estimatedPrice = input.estimatedPrice;
  if (input.estimatedTotal !== undefined) draft.estimatedTotal = input.estimatedTotal;
  if (input.commission !== undefined) draft.commission = input.commission;
  if (input.proposerDid !== undefined) draft.proposerDid = input.proposerDid;
  if (input.expiresAt !== undefined) draft.expiresAt = input.expiresAt;
  if (input.notes !== undefined) draft.notes = input.notes;
  return draft;
}

/** The approval-ticket service result, as SlackAgent returns it. */
export interface PreTradeApprovalTicketDoorResult {
  success: boolean;
  payload: unknown;
  orderId: string;
}

/**
 * Post a pre-trade approval ticket (the strict HITL gate card)
 * to the configured Slack destination through SlackAgent. This
 * door only REQUESTS the human decision: it approves nothing
 * and executes nothing — the trade stays blocked until a human
 * authorizes it through the ticket's own flow. The service
 * result propagates verbatim.
 */
export async function sendPreTradeApprovalTicketViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { draft: PreTradeApprovalDraftDoorInput; channel?: string; threadTs?: string },
): Promise<PreTradeApprovalTicketDoorResult> {
  requireActingLogin(actingLogin);
  const door = getSlackAgentDoor(env);
  const options: { channel?: string; threadTs?: string } = {};
  if (input.channel !== undefined) options.channel = input.channel;
  if (input.threadTs !== undefined) options.threadTs = input.threadTs;
  return door.sendPreTradeApprovalTicket(buildPreTradeApprovalDraft(input.draft), options);
}

/**
 * Dispatch a transaction snap to the configured Slack
 * destination through SlackAgent (which coordinates BrowserAgent
 * for the receipt image; its delivery target likewise falls back
 * to env configuration inside the class). The agent's result
 * propagates verbatim.
 */
export async function dispatchTransactionSnapViaDoor(
  env: Env,
  actingLogin: string | undefined | null,
  input: { transaction: TransactionSnapDoorInput; channel?: string; caption?: string },
): Promise<BrowserAgentSnapResult> {
  requireActingLogin(actingLogin);
  const door = getSlackAgentDoor(env);
  const options: { channel?: string; caption?: string } = {};
  if (input.channel !== undefined) options.channel = input.channel;
  if (input.caption !== undefined) options.caption = input.caption;
  return door.dispatchTransactionSnap(buildTransactionSnap(input.transaction), options);
}
