/**
 * Issue #3534 (Pipeline J1) — the job-pipeline engine and control
 * plane, re-based on the platform's stage runner (#3549,
 * absorbing #3069: one engine). The control plane is the ONE
 * management surface the UX and the copilot doors consume
 * (#3514's uniformity contract): define / configure / run /
 * pause / resume / cancel / retry / status at job granularity,
 * and the uniform stage control — run / re-run / stop / resume /
 * cancel / schedule / re-schedule — at (runId, stageId)
 * granularity, with #3069's pinned meanings.
 *
 * Execution is a DRIVER over the stage-runner contract
 * (src/workflows/stageRunnerPorts.ts + stageRunnerPlan.ts), not
 * a parallel stage machine: each node of the configured job
 * tree compiles to a one-stage StageRunnerPlan (stage id
 * `job:<nodePath>`); the runner's plan decisions — planRun
 * validation, planNext, resumeUnits' rule (a completed unit is
 * never re-run), planStageFanout at stageMaxParallel, retry
 * budgets resolved from pipelinePolicy by
 * resolveStageRetryBudget, per-unit deadlines — decide what
 * executes. The run's checkpoint IS a StageRunnerCheckpoint,
 * persisted through the StageCheckpointStore port
 * (src/data/jobPipelineStageCheckpoint.ts); a unit's output is
 * persisted BEFORE its checkpoint entry completes, and the
 * transition is published after — persist → checkpoint →
 * publish, the #2869 stage contract's order, with the stage's
 * claim key (stageIdempotencyKey) carried on the event. The
 * engine retains only what the stage machine lacks: the
 * recursive job definition model, per-job externalized
 * configuration, schedule registration of configured job
 * trees, and this control surface.
 *
 * A node's own steps run as its stage's unit work (their
 * output is the node's hand-off), then its children —
 * sequentially (output chains child to child) or in parallel
 * (every child receives the node's output; outputs collect in
 * order). The execution mode comes from configuration,
 * resolved per node at dispatch:
 *  - pacing batch: a step sees the full item list in one call;
 *    online: a step is invoked per item and each item's output
 *    chains to the same item of the next step (declared on the
 *    stage plan as the contract's pacing axis).
 *  - shape monolith: one execution unit; sharded: one unit
 *    per configured shard key (a sharded node with no shard
 *    keys configured is a named refusal).
 *  - delivery sync/async shapes only the dispatch contract.
 *
 * Stop/pause are cooperative: the control plane records the
 * desired state (run-level, or per-stage in stageDesired);
 * the engine honors it at the next step boundary, records the
 * in-flight unit as stopped with its intra-unit progress on
 * its checkpoint entry, and unwinds — a stopped stage is
 * resumable and never recorded as failed. Cancel is terminal:
 * the in-flight unit and every outstanding unit are recorded
 * cancelled, and downstream stages never proceed. Resume
 * executes the definition version the run started under (#5278)
 * and continues under the runner's decisions: completed
 * stages/units are read back from their persisted hand-offs,
 * never re-executed; the stopped unit continues from its
 * recorded progress.
 *
 * Honest limits, stated once: in-memory processing
 * (processing.inMemory) keeps hand-offs in the run's process
 * memory, so a resume in a NEW process re-executes nodes whose
 * outputs were never persisted — that volatility is exactly
 * why persisted hand-offs are the default. A unit past its
 * stage deadline is recorded timed_out and the run fails; the
 * underlying step promise is not cancellable, so its late
 * writes may still land (the workflow substrate's deadline
 * sweep has the same shape). Stage actions (runStage and
 * friends) execute inline on the caller's dispatch; hosts
 * needing an async boundary dispatch runJob or the workflow.
 */
import type {
  JobCheckpoint,
  JobDefinition,
  JobExecutionMode,
  JobInstanceRecord,
  JobNodeConfig,
  JobStepConfig,
  JobPipelineStores,
  JobRunProvenance,
  JobRunState,
  JobScheduleConfig,
} from "../data/jobPipelinePorts";
import type {
  JobRunKind,
  JobRunRecord,
  JobRunRecordStore,
  JobRunTrigger,
} from "../data/jobRunRecordPorts";
import {
  normalizeJobRunKind,
  normalizeJobRunTrigger,
} from "../data/jobRunRecordPorts";
import { createJobPipelineStageCheckpointStore } from "../data/jobPipelineStageCheckpoint";
import { buildJobRunRecord, isMissingIdLiteral } from "./jobRunRecords";
import { recordLedgerRun } from "./unifiedLedger";
import {
  JobPipelineError,
  assertExecutionModeSupported,
  mergeJobConfigPatch,
  resolveExecutionMode,
  resolveJobDefinition,
} from "./jobPipelineConfig";
import type { JobStepContext, JobStepRegistry } from "./jobPipelineSteps";
import {
  ASYNC_CAPABILITIES,
  asyncCapabilityJobId,
  asyncCapabilityStepName,
  isAsyncCapability,
  type AsyncCapability,
} from "./asyncCapabilitySteps";
import type { JobStageEventRecord, JobStageEventStore } from "../data/jobStageEventPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { publishJobStatus, publishStageAction } from "./jobPipelineEvents";
import { newRunId, runIdBody, stageIdBody, stepExecutionId } from "./executionTreeIds";
import type { MessagePublisher, StageName } from "../messaging/messagingPorts";
import {
  RETRY_BUCKET_NAMES,
  isRetryBucketName,
  resolvePipelinePolicy,
  type PipelinePolicy,
} from "./pipelinePolicy";
import { computeBackoffDelayMs } from "./resilience";
import {
  FeedJobTimeoutError,
  resolveFeedJobTimeouts,
  withFeedDeadline,
} from "./feedJobTimeouts";
import { resolveStageTimeoutMs, resolveStageTimeoutMsForNode } from "./stageTimeouts";
import { FEED_JOB_CODES } from "./feedJobCodes";

/**
 * The step name of the feed pull, as registered by
 * createFeedStepRegistry (FEED_PULL_STEP in feedPipelineJobs.ts).
 * Declared locally rather than imported: feedPipelineJobs.ts
 * imports this module, so importing its constant here would
 * close a module cycle. The two declarations name the same
 * step; the #3992 PR-4 pin suite exercises the real registry,
 * so a drift between them fails loudly there.
 */
const FEED_PULL_STEP_NAME = "feed.pull";

/** True when any node in the definition tree invokes the named step. */
function jobTreeInvokesStep(node: JobNodeConfig, stepName: string): boolean {
  if ((node.steps ?? []).some((step) => step.step === stepName)) return true;
  return (node.children ?? []).some((child) => jobTreeInvokesStep(child, stepName));
}

/**
 * Resolve a feed run's whole-execution bound (#3992 PR-4): a
 * positive finite injected value wins; absent, non-positive, or
 * non-finite falls back to the env-resolved execution bound
 * (#4312 — resolveFeedJobTimeouts(env).executionMs, itself
 * falling back to the recorded 240s default when no knob is
 * set). Configuration-shaped input can never silently mean "no
 * deadline" — the resolved bound is the floor of meaning,
 * exactly as withFeedDeadline refuses a non-positive bound by
 * name.
 */
export function resolveFeedExecutionDeadlineMs(
  injected?: number,
  env: Record<string, unknown> = {},
): number {
  return typeof injected === "number" && Number.isFinite(injected) && injected > 0
    ? injected
    : resolveFeedJobTimeouts(env).executionMs;
}
import {
  isJobStageId,
  jobStageId,
  resolveStageRetryBudget,
  stageMaxParallel,
  STAGE_RETRY_BUCKET,
  RUNNER_STAGE_FOR_PIPELINE_STAGE,
  runnerStageForPipelineStage,
  type StageCheckpointStore,
  type StageRunnerCheckpoint,
  type StageRunnerInvocation,
  type StageRunnerPlan,
  type StageRunnerStage,
  type StageRunnerStageId,
  type StageUnitCheckpoint,
} from "../workflows/stageRunnerPorts";
import {
  fanoutCapExceeded,
  planNext,
  planRun,
  planStageFanout,
} from "../workflows/stageRunnerPlan";
import {
  OPTIONS_ADDRESSABLE_STAGES,
  STRATEGY_ADDRESSABLE_STAGES,
  type OptionsPipelineStage,
  type StrategyPipelineStage,
} from "../workflows/stageRuntimeIds";
import type { PipelineStage } from "../types";

/**
 * The async seam the engine consumes run records through. The
 * platform store (JobRunRecordStore) is synchronous because DO
 * SQLite is synchronous; this seam wraps it (and the D1 adapter)
 * without inventing a second store or record shape.
 */
export interface JobRunRecorder {
  recordRun(record: JobRunRecord): Promise<void>;
  listRuns(jobId: string, limit?: number): Promise<JobRunRecord[]>;
  latestRun(jobId: string): Promise<JobRunRecord | undefined>;
}

/** Wrap the platform's synchronous run-record store in the async seam. */
export function jobRunRecorderFromStore(store: JobRunRecordStore): JobRunRecorder {
  return {
    recordRun: async (record) => {
      // Issue #3121 Phase 2 (#3123): the seam records through the
      // one ledger entry (which re-validates the built row).
      recordLedgerRun(store, record);
    },
    listRuns: async (jobId, limit) => store.listByJob(jobId, limit),
    latestRun: async (jobId) => store.latestByJob(jobId),
  };
}

/**
 * Issue #4767 — the Run-now trigger (Q4 ruling 2026-11-18): a
 * Run-now records "triggered" UNCONDITIONALLY — a re-run is a
 * triggered dispatch, full stop. The build first shipped a
 * schedule-enabled check (an unscheduled job's Run-now recorded
 * "manual"); the user ruled that wrong and the check is removed.
 * The doors (runPipelineJob / runPipelineChain) and retryJob
 * share this one rule — a dispatcher that knows the trigger
 * passes it explicitly; a Run-now dispatcher that does not know
 * it resolves it here. Schedule firings themselves never reach
 * this helper: they derive "scheduled" via
 * resolveScheduleRunTrigger (#4767 Q1). The `definition`
 * parameter is kept (callers already pass it, and a future rule
 * may read the definition again) — it is not consulted today.
 */
export function resolveRunNowTrigger(_definition: JobDefinition): JobRunTrigger {
  return "triggered";
}

/**
 * Issue #4767 — the origin-run-id boundary rule (the builder's
 * #3650 honesty gate, applied at the dispatch boundary so a bad
 * origin never reaches the instance stamp): null/undefined means
 * no origin; a non-empty string that is not a missing-id literal
 * passes through; anything else throws.
 */
export function normalizeOriginRunId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Job run originRunId must be a non-empty string or null.");
  }
  if (isMissingIdLiteral(value)) {
    throw new Error(
      'Job run originRunId must be a real id or null: a literal "undefined"/"null" id is a missing id (#3650).',
    );
  }
  return value;
}

/**
 * The journal seam: on the workflow substrate each step
 * invocation is wrapped in step.do (journaled, replay-safe); in
 * direct execution the journal is the identity. Checkpointing to
 * the instance store happens regardless — the journal makes
 * workflow replay cheap, the checkpoint makes any resume exact.
 */
/**
 * Issue #6466 part 5 — the run context a step executes under. The OTel
 * journals carry the run id as a FIRST-CLASS field (an attribute / log
 * field), so a run is findable in Grafana by run id alone. Today the run id
 * is only embedded in the step name (`step:<runBody>:…`), which TraceQL can
 * only match with a regex over the step name.
 */
export interface JobStepJournalMeta {
  runId?: string;
  jobId?: string;
}

export interface JobStepJournal {
  do<T>(name: string, fn: () => Promise<T>, meta?: JobStepJournalMeta): Promise<T>;
}

export const identityJobStepJournal: JobStepJournal = {
  do: async (_name, fn) => fn(),
};

/**
 * Issue #3955 — the durable event-wait stage: a step whose name is
 * WAIT_EVENT_STEP waits for ONE named event and continues on it. The
 * wait resolves to a declared outcome — `{outcome: "event"}` carrying
 * the payload, or `{outcome: "timeout"}` — and a timeout is NEVER a
 * failed run: the job can branch on it.
 *
 * The wait is deliberately not a registry step. Rules of Workflows
 * forbid `waitForEvent` inside `step.do`, and a journaled wait would
 * replay as a completed step instead of re-arming; the engine calls the
 * host's channel outside the journal instead.
 */
export const WAIT_EVENT_STEP = "wait.event";

/**
 * Issue #6393 — the durable sleep stage: a step whose name is
 * WAIT_SLEEP_STEP parks the run for ONE declared duration and continues
 * on it. It is the second half of the wait primitive #3955 opened with
 * the event wait, and it follows the same three rules for the same
 * reasons:
 *
 *  - the park runs on the host's own durable timer (`step.sleep`),
 *    NEVER inside `step.do` — a journaled sleep would replay as a
 *    completed step instead of re-arming, and Rules of Workflows forbid
 *    it inside `step.do`;
 *  - the duration is the job's declaration, bounded by the configured
 *    policy maximum (`pipeline.sleepMaxDurationMs`), never by a
 *    hard-coded ceiling;
 *  - a host with no durable sleep REFUSES BY NAME. A hold is not a park:
 *    silently holding is the defect this step exists to remove.
 *
 * The park resolves to a declared outcome `{outcome: "slept"}` — the
 * same contract shape the event wait uses — so a step after it can read
 * how long the run parked without asking the platform.
 */
export const WAIT_SLEEP_STEP = "wait.sleep";

/**
 * Issue #6394 — the child-run stage: a step that starts an INDEPENDENT run of
 * another job and (by default) waits for it. The child has its own run id, its
 * own instance row and its own lifecycle, so its failure is its own — the
 * parent only sees an outcome it can branch on.
 *
 * Two deliberate differences from the wait stages above:
 *  - this step IS journaled: a replay must return the recorded child run id
 *    rather than dispatch a second child, so the exactly-once rule is the
 *    journal's, not a hand-rolled check;
 *  - "proceed without it" is never silent — `onFailure` is REQUIRED and must
 *    name `fail` or `continue`, so the parent's reaction to a failed child is
 *    a recorded decision rather than an accident.
 *
 * The child links back to its parent through the run record's `originRunId`
 * (a child is a fresh ORIGINAL run of its own job, not a re-run of anything).
 */
export const CHILD_RUN_STEP = "child.run";

/** One child-run request, validated at the step. */
export interface JobChildRunRequest {
  parentJobId: string;
  parentRunId: string;
  childJobId: string;
  onFailure: "fail" | "continue";
  awaitSettlement: boolean;
  timeoutMs: number;
}

/** What a child-run step hands the next step. */
export interface JobChildRunOutcome {
  outcome: "completed" | "failed" | "timed_out";
  childJobId: string;
  childRunId: string;
}

/** One park request: where, how long, and under the engine's stable name. */
export interface JobDurableSleepRequest {
  jobId: string;
  runId: string;
  /** The node path the park belongs to (the stage boundary's identity). */
  nodePath: string;
  /**
   * The park's stable platform name — the engine's ONE naming site, so a
   * replay of the same run re-arms the same sleep instead of parking twice.
   */
  stepName: string;
  /** The declared park duration in milliseconds (already bounded). */
  durationMs: number;
}

/** The host's durable sleep. Absent ⇒ the step refuses by name. */
export type JobDurableSleepHandler = (
  request: JobDurableSleepRequest,
) => Promise<void>;

/** One wait request: what to wait for, where, and under what bound. */
export interface JobEventWaitRequest {
  jobId: string;
  runId: string;
  /** The node path the wait belongs to (the stage boundary's identity). */
  nodePath: string;
  /**
   * The wait's stable platform name — the engine's ONE naming site, so a
   * replay of the same run re-arms the same wait instead of opening a second.
   */
  stepName: string;
  /** The event type the delivery side sends. */
  event: string;
  /** The declared bound in ms. Absent from the job, the engine passes the configured default (#6551); null is possible only for a caller that addresses the channel directly. */
  timeoutMs: number | null;
}

/** A wait's result. A timeout is an OUTCOME, never an error. */
export type JobEventWaitOutcome =
  | { outcome: "event"; payload: unknown }
  | { outcome: "timeout" };

/** The host's wait channel. Absent ⇒ a wait stage refuses by name. */
export type JobEventWaitHandler = (
  request: JobEventWaitRequest,
) => Promise<JobEventWaitOutcome>;

/** One delivery: the event, its payload, and the durable host to reach. */
export interface JobEventSendRequest {
  jobId: string;
  runId: string;
  /** The run's durable host instance; null when the run has none. */
  workflowInstanceId: string | null;
  event: string;
  payload: unknown;
}

/** The host's delivery channel. Absent ⇒ delivery refuses by name. */
export type JobEventSender = (request: JobEventSendRequest) => Promise<void>;

/** Issue #5783 — the platform stop a host exposes for a run's instance. */
export type JobPipelineTerminateRun = (request: {
  jobId: string;
  runId: string;
  workflowInstanceId: string;
}) => Promise<void>;

/** Issue #6552 — the platform rewind a host exposes for a live run's instance. */
/**
 * Issue #3967 — one poison landing: everything an operator needs to find the
 * run, the stage and the reason, and to choose the remedy. The engine hands
 * this to the host; mapping it onto the DLQ store's own shape is the host's
 * job (src/services/jobPipelineDeadLetter.ts), so the engine never learns the
 * store's schema or its queue vocabulary.
 */
export interface JobPoisonLanding {
  jobId: string;
  runId: string;
  /** The node path the failing stage belongs to ("" for the root). */
  nodePath: string;
  /** The stage id in the engine's own namespace (`job:<nodePath>`). */
  stageId: string;
  unitId: string;
  /** The coded error — the reason this run is not retried. */
  code: string;
  message: string;
  at: string;
}

export type JobPoisonLandingSink = (landing: JobPoisonLanding) => Promise<void>;

/**
 * Issue #3954 — one unit the stuck sweep reaped: which run, which stage, which
 * unit, and how long it had been silent. The unit is surfaced as failed with a
 * coded error AND its run is settled, so "stuck" is an outcome rather than a
 * run left hanging.
 */
export interface JobStuckUnit {
  jobId: string;
  runId: string;
  stageId: string;
  unitId: string;
  /** How long the unit had gone without a heartbeat when it was reaped. */
  silentMs: number;
}

/**
 * Issue #5279 — the live-state answer: what the engine can say about a run
 * THAT IS EXECUTING IN THIS PROCESS, beyond the stored views `getJob` reads.
 * A query never mutates anything and never invents a stage: a run executing
 * elsewhere (another isolate, the workflow residency) reads as not-live here,
 * which is the truth this process can prove.
 */
export interface JobLiveQuery {
  jobId: string;
  /** The run currently addressed by the instance, or null when it has none. */
  runId: string | null;
  /** The instance's stored state (idle | running | paused | completed | failed | …). */
  state: string;
  /**
   * True only while THIS process is executing one of the run's units right
   * now. Between units (or on a run executing elsewhere) it reads false —
   * what this process can prove, never a guess at another isolate's work.
   */
  live: boolean;
  /** The units executing right now, `stage:unit` — empty when not live. */
  activeUnits: string[];
  /** Steps started in the live run so far (0 when not live). */
  stepExecutions: number;
}

export interface JobStuckSweepResult {
  stuck: JobStuckUnit[];
  /** The job ids whose run was settled failed because a unit was stuck. */
  settled: string[];
}

export type JobPipelineRestartRun = (request: {
  jobId: string;
  runId: string;
  workflowInstanceId: string;
  /** The engine's own step name for step 0 of the target stage. */
  fromStep: string;
}) => Promise<void>;

/** Issue #6028 — module logger, on the same structured-logging seam as the services. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/jobPipelineEngine",
});

/** Default sleep: a real timer that never holds the process open on its own. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    timer?.unref?.();
  });

export interface JobPipelineDeps {
  stores: JobPipelineStores;
  runRecorder: JobRunRecorder;
  /**
   * Optional settle observer (#3530 slice B): invoked once per
   * terminally settled run from recordTerminal — the engine's one
   * terminal-recording point — so every trigger class (manual,
   * scheduled, resume, retry, cancel) is covered by construction.
   * Best-effort by contract: the engine guards the call, so an
   * observer failure can never fail, retry, or duplicate the
   * run's own records; observers log their own failures.
   */
  runSettledObserver?: (info: JobRunSettledInfo) => Promise<void> | void;
  /** Null when the queue substrate is unconfigured: runs proceed, status publication is skipped, store state remains the truth. */
  publisher: MessagePublisher | null;
  steps: JobStepRegistry;
  /**
   * Issue #6028 — the stage-level terminal rows' store (D1
   * `job_stage_events`). Absent ⇒ no stage rows are written, exactly as
   * before this slice; a present store is written best-effort (see
   * `writeStageRows`). Issue #6101 (step 7): D1 is the writer now —
   * the DO leg and the #6202 mirror are deleted; the former mirror
   * store is what this field carries.
   */
  stageEvents?: JobStageEventStore;
  journal?: JobStepJournal;
  /**
   * Issue #3955 — the durable event-wait channel a `wait.event` step waits
   * on. Absent ⇒ the step refuses by name (`stage_port_unavailable`) rather
   * than pretending the wait happened: an unservable capability refuses,
   * per #5517.
   */
  waitForEvent?: JobEventWaitHandler;
  /**
   * Issue #6393 — the durable sleep a `wait.sleep` step parks on. Absent ⇒
   * the step refuses by name (`stage_port_unavailable`) rather than holding
   * the run in-process: a hold dies with the isolate, which is exactly what
   * this seam exists to avoid.
   */
  sleepFor?: JobDurableSleepHandler;
  /**
   * Issue #3955 — the delivery half of the channel: hand a named event to
   * the run's durable host. Absent ⇒ `sendEvent` refuses by name.
   */
  sendEvent?: JobEventSender;
  /**
   * Issue #5783 — stop a run's durable host (the platform terminate). Absent
   * ⇒ cancel stays cooperative: the engine stops at its next step boundary.
   */
  terminateRun?: JobPipelineTerminateRun;
  /**
   * Issue #6552 — rewind a live run through the platform's own restart. Absent
   * ⇒ restartFromStage refuses by name; it never falls back to a guess.
   */
  restartRun?: JobPipelineRestartRun;
  /**
   * Issue #3967 — where a POISON run lands: a coded error the engine will not
   * retry because it can never succeed (an unknown step, an unconfigured
   * shard). Absent ⇒ the run is marked terminal-failed exactly as before; the
   * record is evidence for an operator, never part of the run's outcome, so a
   * sink failure is logged and swallowed rather than failing the run twice.
   */
  deadLetterRun?: JobPoisonLandingSink;
  now?: () => Date;
  newRunId?: () => string;
  /**
   * The resolved pipeline policy (retry budgets, resolved once
   * here — the stage contract's one resolution). When absent the
   * constructor resolves from `env` + `settings` instead
   * (#4782 S3); before that slice the fallback resolved with no
   * env/settings overrides at all.
   */
  policy?: PipelinePolicy;
  /**
   * Issue #4782 S3 — the Worker env the policy resolves from
   * when no explicit `policy` is injected (the platform-default
   * layer: env vars an operator sets without a deploy). The
   * engine never reads env itself; the host passes what it has.
   * Absent → the defaults, exactly as before.
   */
  env?: Record<string, unknown>;
  /**
   * Issue #4782 S3 — the per-tenant settings map (`pipeline.*`
   * values, read where the tenant is known) the policy resolves
   * from when no explicit `policy` is injected. Settings beat
   * env, as in the resolver. A host MUST pass only the settings
   * of the tenant whose job this engine runs: the shared engine
   * never reads a host-global settings map (multi-tenant rule —
   * one tenant's settings must not apply to another's runs).
   * Absent → env-only, as before.
   */
  settings?: Record<string, string | undefined>;
  /** Sleep for retry backoff and unit deadlines. Defaults to a real (unref'd) timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The stage-runner invocation this host drives (the contract's driver kind). Defaults to "sync". */
  invocation?: StageRunnerInvocation;
  /**
   * Optional whole-execution bound for FEED jobs only (#3992
   * PR-4): executeRun races a feed job's execution tree against
   * this many milliseconds and settles the run failed with
   * FEED_DEADLINE_EXCEEDED past it. Resolved through
   * resolveFeedExecutionDeadlineMs — absent / non-positive /
   * non-finite means the env-resolved execution bound (#4312,
   * 240s when no knob is set), so hosts that never set this are
   * bounded by default. Non-feed jobs are never raced by this
   * bound.
   */
  feedExecutionDeadlineMs?: number;
  /**
   * The env-resolved global stage default (#4775 S1): the host's
   * resolveStageTimeoutMs(env), 600s when no knob is set. A stage
   * with no node timeoutMs runs under this bound, clamped to the
   * run deadline whenever one applies (feed jobs). Resolved
   * through stageDefaultMs — absent / non-positive / non-finite
   * means the recorded default, so hosts that never set this are
   * bounded by default. Non-feed jobs are never raced by the run
   * deadline, so their stages carry this bound alone.
   */
  stageTimeoutMs?: number;
  /** The schedule host stage scheduling registers with. registerSchedules takes its host explicitly; scheduleStage falls back to this. */
  scheduleHost?: JobScheduleHost;
}

export interface JobDispatchResult {
  jobId: string;
  runId: string;  /** For sync delivery: the terminal (or paused) state. For async: the state at dispatch. */
  state: JobRunState;
  /** Async delivery only: resolves with the run's outcome when it settles. */
  completion?: Promise<JobRunOutcome>;
}

export interface JobRunOutcome {
  jobId: string;
  runId: string;
  state: JobRunState;
  descriptor?: string;
  error?: string;
  artifactKeys: string[];
}

/**
 * Issue #6554 (F1) — the async mode's submission: the capability
 * to execute, the step's input (the async-capability execution
 * carrier the executor builds), and the dispatching async job's
 * id, which the engine run record carries as its join key.
 */
export interface AsyncUnitRequest {
  /**
   * The capability to execute. A plain string, not the closed
   * union: the queue row's capability is a string, and the
   * engine — not the caller — is the gate that refuses an
   * unregistered one by name (`async_capability_unknown`).
   */
  capability: AsyncCapability | string;
  input: unknown;
  asyncJobId: string;
  trigger?: JobRunTrigger;
}

/**
 * Issue #6554 (F1) — the async mode's outcome: the engine run's
 * ids and terminal state, the step's output when it completed,
 * and the failure message when it did not. A step failure is
 * data here, never a throw — the executor turns it into the
 * queue row's failure.
 */
export interface AsyncUnitOutcome {
  jobId: string;
  runId: string;
  state: "completed" | "failed";
  output?: unknown;
  error?: string;
}

/**
 * One terminally settled run, as reported to the settle observer
 * (#3530 slice B): the run's ids, the trigger the engine recorded
 * for it, its terminal state, and its failure message when failed.
 * Emitted from recordTerminal only — a run that never dispatched
 * (or is merely paused) never produces one.
 */
export interface JobRunSettledInfo {
  jobId: string;
  runId: string;
  trigger: JobRunTrigger;
  state: "completed" | "failed" | "cancelled";
  error?: string;
  /**
   * Issue #4767 — the settled run's kind and origin link, stamped
   * by recordTerminal. Optional so observers constructed without
   * them (tests, older callers) still compile; the engine always
   * stamps both.
   */
  kind?: JobRunKind;
  originRunId?: string | null;
}

/**
 * Issue #4359 — the unit statuses a stage can end in. "stopped" is
 * resumable and "never-attempted"/"queued"/"running" are not terminal,
 * so a stage with any of those keeps its end open (no invented end).
 */
const TERMINAL_STAGE_UNIT_STATUSES: ReadonlySet<StageUnitCheckpoint["status"]> = new Set([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "retired",
]);

/** One stage of the current/last run, as the status surface shows it (#3069 surfacing). */
export interface JobStageView {
  /** The stage id (job:<nodePath>) — the (runId, stageId) address's stage half. */
  stageId: string;
  nodePath: string;
  kind: string | null;
  /**
   * Issue #4363 — the execution mode this run was defined with (all four
   * axes), read from the definition. Recorded, never inferred: a legacy
   * definition without one reads null.
   */
  executionMode?: JobExecutionMode | null;
  /**
   * Issue #4359 — the stage's recorded window: the earliest unit start
   * and the latest unit end, both read from the checkpoint. `endedAt`
   * stays null while any unit is non-terminal (the stage is still the
   * run's frontier); `durationMs` is null unless both stamps exist.
   * Nothing here is estimated — the engine recorded the stamps.
   */
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /**
   * Issue #6028 — the result references the stage's units returned (the
   * descriptor each step produced), in unit order. Null when no unit
   * produced one — never a fabricated summary.
   */
  resultRef: string | null;
  /**
   * Issue #6416 — the persisted step output's `status` (e.g.
   * "not_configured") when the stage's artifact carries one. Set only
   * by the research stage adapter, from the orchestrator-side stage
   * read; the engine projection leaves it unset — the engine's own
   * views carry no step status.
   */
  stepStatus?: string | null;
  /**
   * Issue #6416 — the persisted step-output artifact itself. Set only
   * by the research stage adapter, which reads it from the same store
   * as the stages; the Workflow Runs projection synthesizes stage
   * detail from it. The engine projection leaves it unset.
   */
  stageOutput?: unknown;
  /**
   * Issue #6416 — the run's report body, attached by the research stage
   * adapter only when a stage's descriptor and artifact are both absent:
   * fallback evidence for detail synthesis (feed counts from the
   * report's stats / symbolEvaluations). Never set by the engine
   * projection, and never read when the descriptor or artifact exists.
   */
  reportEvidence?: unknown;
  /**
   * Issue #6377 — the checkpoint entry these units came from: the run id
   * it belongs to and the kind of execution it recorded, stamped by the
   * engine projection from the same read that produced the units (never
   * a second store read). A view projected without a checkpoint carries
   * neither, and the viewer then claims none.
   */
  checkpointRunId?: string | null;
  checkpointKind?: JobRunKind | null;
  units: Array<{
    unitId: string;
    status: StageUnitCheckpoint["status"];
    attempt: number;
    error?: string;
    /** Issue #4359 — the unit's recorded start, when it started. */
    startedAt?: string;
    /** Issue #4359 — the unit's recorded terminal instant, when it ended. */
    endedAt?: string;
    /** Issue #6028 — the descriptor the step returned for this unit, when it returned one. */
    resultRef?: string;
    /**
     * Issue #6377 — the unit's recorded resume position (#3549): the
     * step/item indices a resume continues from. Present only on a unit
     * the runner stopped mid-execution (cleared on completion), so an
     * absent value means the unit is atomic from the runner's view —
     * never an estimated position.
     */
    progress?: StageUnitCheckpoint["progress"];
  }>;
}

/** Issue #4359 — the Workflow Runs stage read: the views plus the run they describe. */
export interface JobStagesRead {
  stages: JobStageView[];
  /** The run id the checkpoint belongs to; null when no checkpoint is recorded. */
  checkpointRunId: string | null;
  /**
   * Issue #4767 — the kind of execution the checkpoint's stages
   * belong to (original / re-run / resume / replay), read from
   * the checkpoint when it carries one, else the instance's
   * recorded kind; null when neither names one. The checkpoint
   * kind's read consumer (the Q6 trigger's consumer is the resume
   * guard in executeRun).
   */
  checkpointKind: JobRunKind | null;
}

export interface JobStatusView {
  definition: JobDefinition;
  instance: JobInstanceRecord | null;
  latestRun: JobRunRecord | undefined;
  history: JobRunRecord[];
  /** The current/last run's per-stage states from its stage-runner checkpoint. */
  stages: JobStageView[];
}

/** A schedule host: the platform scheduler's registration surface (Think scheduled tasks on an agent host). */
export interface JobScheduleHost {
  schedule(spec: {
    jobId: string;
    nodePath: string;
    cron?: string;
    interval?: string;
  }): Promise<string>;
  /**
   * Cancel one registration. Optional at the seam: a host that
   * cannot cancel cannot serve re-schedule (the control plane
   * refuses, fail-closed — never a duplicate firing).
   */
  unschedule?(registrationId: string): Promise<void>;
}

interface RunContext {
  deps: JobPipelineDeps;
  definition: JobDefinition;
  jobId: string;
  runId: string;
  /** The run's dispatch trigger (#4767): threaded into the step contexts so steps record it. */
  trigger: JobRunTrigger;
  /** The run's kind (#4767): threaded into the step contexts alongside the trigger. */
  kind: JobRunKind;
  rootConfig: JobDefinition["config"];
  scopePath: string;
  /**
   * The run bound the stage deadlines clamp to (#4775 S1,
   * Decision 1): a feed job's whole-execution deadline, resolved
   * once in executeRun. Undefined when no run deadline applies
   * (non-feed jobs, stage actions) — then a stage's timeout
   * stands alone.
   */
  runDeadlineMs?: number;
  resuming: boolean;
  /** The run's stage-runner checkpoint — the one resume truth, persisted via checkpoints. */
  ledger: StageRunnerCheckpoint;
  checkpoints: StageCheckpointStore;
  memory: Map<string, unknown>;
  /**
   * Issue #6396 — the index of the last step that STARTED in this unit. The
   * retry loop reads it to attribute a failure to a step and honour that
   * step's own retry bucket; absent ⇒ the stage budget, exactly as before.
   */
  lastStepIndex?: number;
  artifactKeys: string[];
  stepsSinceCheckpoint: number;
  currentGranularity: number;
  stepExecutions: number;
  /** The units currently executing, keyed `${stageId}::${unitId}` (parallel fan-out runs several at once). */
  activeUnits: Map<
    string,
    {
      stageId: string;
      nodePath: string;
      unitId: string;
      shardKey: string | null;
      shardIndex: number;
    }
  >;
  /** Run-record notes (fan-out caps, stage cancellations) appended to the terminal descriptor. */
  notes: string[];
  /**
   * Issue #6278 — the last leg failure recorded while a unit
   * retries (message + attempt). The terminal error carries it
   * when the run later dies at the whole-run deadline mid-retry,
   * so the production error names the slow leg instead of only
   * FEED_DEADLINE_EXCEEDED. In-memory only: the terminal record
   * persists it via the error message. Deliberately NOT the
   * ledger unit entry — the stage views treat a unit carrying
   * `error` as failed, so a running unit must never carry one.
   * Null until a retryable attempt fails.
   */
  lastLegError: { message: string; attempt: number } | null;
  /**
   * Issue #6678 — per-leg (unit attempt) elapsed times on the
   * real clock. A slow-progressing leg never fails an attempt,
   * so lastLegError stays null and the deadline terminal error
   * named no leg (2026-11-26 recurrence). Every attempt records
   * its start; settle stamps the end, and an attempt still
   * in-flight at the deadline is named with its elapsed-so-far.
   * In-memory only: the terminal record persists the summary
   * via the error message, like lastLegError.
   */
  legTimings: Array<{
    stageId: string;
    unitId: string;
    attempt: number;
    startedAtMs: number;
    endedAtMs: number | null;
    outcome: "in-flight" | "completed" | "failed" | "timed_out";
  }>;
  /** #6678 — real-clock start of the execution tree, for budget composition. */
  runStartedAtMs: number;
  /** #6678 — the resolved whole-execution budget (feed runs), set by executeRun. */
  executionBudgetMs: number | undefined;
  /** #6678 — set when the retry gate stops on budget exhaustion instead of starting another attempt. */
  budgetExhausted: boolean;
  /** The one node path a stage action forces re-execution of (re-run), or null on a normal run. */
  forceStage: string | null;
}

class RunStopped extends Error {
  constructor(readonly reason: "paused" | "cancelled") {
    super(`run ${reason}`);
    this.name = "RunStopped";
  }
}

/** A stage-scoped cancellation (#3069): the run settles as cancelled, with the stage named. */
class StageCancelled extends RunStopped {
  constructor(readonly stageId: string) {
    super("cancelled");
    this.name = "StageCancelled";
  }
}

/**
 * A stage-scoped retirement (#3944): the run settles as
 * cancelled, with the retired stage named. Unlike a cancel,
 * the stage itself is retired on the job's definition — it
 * never re-runs in any run — so the run's outstanding units
 * are recorded cancelled while the retired stage's own units
 * stay "retired" (see the executeRun catch: the sweep never
 * overwrites a retired entry).
 */
class StageRetired extends RunStopped {
  constructor(readonly stageId: string) {
    super("cancelled");
    this.name = "StageRetired";
  }
}

const TERMINAL: readonly JobRunState[] = ["completed", "failed", "cancelled"];

function pathSegments(path: string): number[] {
  return path === "" ? [] : path.split("/").map((s) => Number(s));
}

function childPath(path: string, index: number): string {
  return path === "" ? `${index}` : `${path}/${index}`;
}

function keyPart(path: string): string {
  return path === "" ? "root" : path;
}

function parentPath(path: string): string {
  const segments = pathSegments(path);
  segments.pop();
  return segments.join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Schedule preservation for the family ensures (#3530
 * scheduling-config): a job's schedule is OPERATOR configuration
 * (set through configureJob), not a re-derivable default — when an
 * ensure re-defines a job because some other part of its built
 * definition drifted, the incoming raw's root schedule is replaced
 * by the STORED definition's resolved root schedule, so the
 * re-definition converges every other field without silently
 * reverting a configured cadence or disable. Returns the incoming
 * raw unchanged when there is nothing to preserve (no stored
 * definition, no stored root schedule, or the incoming raw carries
 * no root record). Sub-node schedules are untouched: the root is
 * the only schedule any surface configures.
 */
export function withSchedulePreserved(
  incomingRaw: unknown,
  existing: JobDefinition | null | undefined,
): unknown {
  const storedSchedule = existing?.root.schedule;
  if (!storedSchedule) return incomingRaw;
  if (!isRecord(incomingRaw) || !isRecord(incomingRaw.root)) return incomingRaw;
  return {
    ...incomingRaw,
    root: { ...incomingRaw.root, schedule: { ...storedSchedule } },
  };
}

/**
 * Issue #3945 (#3550 prep slice) — the vocabulary in the engine:
 * a job node's kind names its vocabulary (catalog) stage. The
 * chain-row kinds ride the contract's own table
 * (RUNNER_STAGE_FOR_PIPELINE_STAGE: feed / generate / store /
 * serve / deliver); the chain's own kinds extend it (enrich is
 * the gather stage — enrichment — and analyze is the analysis
 * stage). The engine adds no second vocabulary: it reads the one
 * the contract already declares. Kinds naming no stage
 * ("pipeline", "dummy", host kinds) are not vocabulary stages
 * and are skipped, never guessed.
 */
const NODE_KIND_VOCABULARY_STAGE: Record<string, StageName> = {
  ...RUNNER_STAGE_FOR_PIPELINE_STAGE,
  enrich: "gather",
  analyze: "analysis",
};

/** The vocabulary stage a node kind names, or null when it names none. */
export function vocabularyStageForNodeKind(kind: string): StageName | null {
  return NODE_KIND_VOCABULARY_STAGE[kind] ?? null;
}

/**
 * Issue #4061 (#3551 prep slice) — the options vocabulary in the
 * engine: the family's 8 execution stages (OPTIONS_ADDRESSABLE_STAGES,
 * pinned by #4067) name themselves — an options job node's kind IS
 * its vocabulary stage, so the kind names the stage by identity.
 * No second list: membership in the #4067 pin IS the vocabulary,
 * so the pin stays the single source of truth. The display stages
 * (feed/store/serve) are presentation only and name no control
 * address: they have no entry here, so a request for one refuses
 * stage_vocabulary_unknown. "deliver" is the one id shared with
 * the catalog vocabulary (execution stage 8); it resolves through
 * both tables to the same node.
 */
export function optionsVocabularyStageForNodeKind(kind: string): OptionsPipelineStage | null {
  return (OPTIONS_ADDRESSABLE_STAGES as readonly string[]).includes(kind)
    ? (kind as OptionsPipelineStage)
    : null;
}

/**
 * Issue #4272 (#3552 S2) — the strategy vocabulary in the engine:
 * the strategy job's 8 execution stages (STRATEGY_ADDRESSABLE_STAGES,
 * pinned by #4272) name themselves, exactly as the options job's do
 * (#4061). No second list: the strategy vocabulary IS the #4067 pin
 * under the strategy family's name (the strategy pipeline is the
 * eight-stage options pipeline over strategy ports, #4271), so the
 * pin stays the single source of truth. A strategy job node's kind
 * IS its vocabulary stage, so the kind names the stage by identity.
 */
export function strategyVocabularyStageForNodeKind(kind: string): StrategyPipelineStage | null {
  return (STRATEGY_ADDRESSABLE_STAGES as readonly string[]).includes(kind)
    ? (kind as StrategyPipelineStage)
    : null;
}

/**
 * A stage addressable by (runId, stageId): a catalog stage, an
 * options execution stage, or a strategy execution stage. The seven
 * *ByVocabulary operations take this union; the (jobId, nodePath)
 * twins they delegate to still take node paths, so their meanings
 * are unchanged.
 */
export type VocabularyStage = StageName | OptionsPipelineStage | StrategyPipelineStage;

/**
 * Resolve a vocabulary stage of a job definition to its node
 * path — the (runId, stageId) address's node half. A node claims
 * a stage under any naming rule: its kind maps to the catalog
 * stage (#3945), its kind IS the options stage (#4061), or its
 * kind IS the strategy stage (#4272 — the same 8 kinds, so a
 * strategy job's node claims its stage under the strategy rule
 * too). One node matching several rules is one match, not
 * several — the shared "deliver" id resolves once, and a node
 * whose kind is both an options and a strategy stage resolves
 * once. Exactly one node may claim the stage: none refuses
 * `stage_vocabulary_unknown`, two or more refuse
 * `stage_vocabulary_ambiguous` (a stage split across nodes is not
 * one addressable stage). The walk is pre-order, root first — a
 * root whose kind is a vocabulary stage (the chain's feed root)
 * resolves to "".
 *
 * Shared kind name, documented: the J-pipeline kind "enrich" IS
 * the gather stage, and the options enrich stage carries that
 * same kind — so "gather" and "enrich" address one node on an
 * options-shaped definition, and the twin behaves identically
 * under either name.
 */
export function vocabularyStageNodePath(
  definition: JobDefinition,
  stage: VocabularyStage,
): string {
  const matches: string[] = [];
  const walk = (node: JobNodeConfig, path: string): void => {
    if (
      vocabularyStageForNodeKind(node.kind) === stage ||
      optionsVocabularyStageForNodeKind(node.kind) === stage ||
      strategyVocabularyStageForNodeKind(node.kind) === stage
    )
      matches.push(path);
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      walk(children[i], childPath(path, i));
    }
  };
  walk(definition.root, "");
  if (matches.length === 0) {
    throw new JobPipelineError(
      "stage_vocabulary_unknown",
      `Job "${definition.jobId}" has no node for vocabulary stage "${stage}"; its nodes' kinds are not that stage.`,
    );
  }
  if (matches.length > 1) {
    throw new JobPipelineError(
      "stage_vocabulary_ambiguous",
      `Job "${definition.jobId}" has ${matches.length} nodes for vocabulary stage "${stage}" (node paths ${matches.join(", ")}); one stage must be one node to address it.`,
    );
  }
  return matches[0];
}

/**
 * Issue #4359 / #4420 — the stage projection from a job's definition and the
 * instance's stage checkpoint. One projection for every reader: the job
 * surfaces (getJob / getJobStages) and a store-direct read of a job this host
 * did not dispatch itself (readStagesFromPipelineStores).
 */
export function projectStageViews(
  /**
   * Issue #6028 — null when the definition is gone (a run whose spec was
   * replaced): the stages and their stamps still come from the checkpoint,
   * only the kinds read null. Nothing is invented in their place.
   */
  definition: JobDefinition | null,
  instance: JobInstanceRecord | null,
): JobStageView[] {
  if (!instance?.stageCheckpoint) return [];
  const kinds = new Map<string, string>();
  const walk = (node: JobNodeConfig, path: string): void => {
    kinds.set(path, node.kind);
    (node.children ?? []).forEach((child, i) => walk(child, childPath(path, i)));
  };
  if (definition) walk(definition.root, "");
  const byStage = new Map<string, JobStageView>();
  for (const unit of instance.stageCheckpoint.units) {
    if (!isJobStageId(unit.stage)) continue;
    const nodePath = unit.stage === "job:root" ? "" : unit.stage.slice("job:".length);
    let view = byStage.get(unit.stage);
    if (!view) {
      const created: JobStageView = {
        stageId: unit.stage,
        nodePath,
        kind: kinds.get(nodePath) ?? null,
        executionMode: definition?.config.executionMode ?? null,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        resultRef: null,
        // Issue #6377 — the checkpoint this view IS, stamped from the
        // same instance read (never a second store read), so the viewer
        // can name the run its units belong to.
        checkpointRunId: instance.stageCheckpoint.runId,
        checkpointKind: instance.stageCheckpoint.kind ?? null,
        units: [],
      };
      byStage.set(unit.stage, created);
      view = created;
    }
    view.units.push({
      unitId: unit.unitId,
      status: unit.status,
      attempt: unit.attempt,
      ...(unit.error !== undefined ? { error: unit.error } : {}),
      ...(unit.startedAt !== undefined ? { startedAt: unit.startedAt } : {}),
      ...(unit.endedAt !== undefined ? { endedAt: unit.endedAt } : {}),
      ...(unit.resultRef !== undefined ? { resultRef: unit.resultRef } : {}),
      ...(unit.progress !== undefined ? { progress: unit.progress } : {}),
    });
  }
  // Issue #4359 — the stage's window is its units' recorded window:
  // earliest start, latest end once every unit is terminal. Nothing is
  // estimated; a stage still running keeps endedAt null.
  for (const view of byStage.values()) {
    const starts = view.units
      .map((unit) => unit.startedAt)
      .filter((at): at is string => typeof at === "string")
      .sort();
    const ends = view.units
      .map((unit) => unit.endedAt)
      .filter((at): at is string => typeof at === "string")
      .sort();
    const allTerminal = view.units.every((unit) =>
      TERMINAL_STAGE_UNIT_STATUSES.has(unit.status),
    );
    const startedAt = starts[0] ?? null;
    const endedAt = allTerminal ? (ends[ends.length - 1] ?? null) : null;
    view.startedAt = startedAt;
    view.endedAt = endedAt;
    view.durationMs =
      startedAt && endedAt
        ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
        : null;
    // Issue #6028 — the stage's result references, in unit order. Null
    // when no unit produced one; the join never invents a summary.
    const refs = view.units
      .map((unit) => unit.resultRef)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    view.resultRef = refs.length > 0 ? refs.join(", ") : null;
  }
  return [...byStage.values()];
}

/**
 * Issue #6028 — one stage-level terminal row per executed stage, for the
 * run ledger's stage store. Pure: the engine's own projection in, the
 * rows out, so the write path and the tests see the same values.
 *
 * The identity is the engine's (runId + stageId), so a re-write of the
 * same run is an update at the store's UNIQUE `event_key`, not a second
 * row. `stage_id` carries the addressable kind when the definition is
 * known (the id the stage-control surface addresses), the engine stage id
 * otherwise.
 */
export function stageTerminalRows(input: {
  runId: string;
  jobId: string;
  definition: JobDefinition | null;
  instance: JobInstanceRecord;
  at: string;
  definitionVersion: number | null;
}): JobStageEventRecord[] {
  const rows: JobStageEventRecord[] = [];
  const rootIsContainer = (input.definition?.root.children?.length ?? 0) > 0;
  for (const stage of projectStageViews(input.definition, input.instance)) {
    // The root of a job whose children ARE the stages is the job itself,
    // not another stage: a row for it would show a stage the operator
    // cannot address. A root with no children is the stage, and keeps its
    // row (the feed/analyze families' shape).
    if (rootIsContainer && stage.nodePath === "") continue;
    const failed = stage.units.filter(
      (unit) => unit.status === "failed" || unit.status === "timed_out",
    );
    const stopped = stage.units.some((unit) => unit.status === "stopped");
    const allTerminal = stage.units.every((unit) =>
      TERMINAL_STAGE_UNIT_STATUSES.has(unit.status),
    );
    const stageStatus =
      failed.length > 0
        ? "failed"
        : stopped
          ? "stopped"
          : allTerminal
            ? "completed"
            : "running";
    const errors = failed
      .map((unit) => unit.error)
      .filter((error): error is string => typeof error === "string" && error.length > 0);
    rows.push({
      eventKey: `${input.runId}:${stage.stageId}:terminal`,
      claimKey: `${input.runId}::${stage.stageId}`,
      runId: input.runId,
      jobId: input.jobId,
      // Issue #6028 — the addressable id: the stage kind the control
      // surface and the flow address (the engine's node path is the
      // identity, above, and stays in the claim key).
      stageId: stage.kind ?? stage.stageId,
      unitId: null,
      action: "terminal",
      at: input.at,
      startedAt: stage.startedAt,
      endedAt: stage.endedAt,
      detail: errors.length > 0 ? errors.join("; ") : null,
      stageStatus,
      durationMs: stage.durationMs,
      unitCount: stage.units.length,
      failedUnitCount: failed.length,
      resultRef: stage.resultRef,
      definitionVersion: input.definitionVersion,
    });
  }
  return rows;
}

/**
 * Issue #4420 — the stage read over a pipeline store directly: the same
 * projection getJobStages serves, for a job this caller can address by id
 * but whose host did not dispatch it here (an options shard's inner
 * `strategy-screen:shard-scan:…` run, written into the shard host's own
 * SQLite by the shard executor). A store with no definition for the job
 * answers null — nothing is invented into a stage list.
 */
export async function readStagesFromPipelineStores(
  stores: JobPipelineStores,
  jobId: string,
): Promise<JobStagesRead | null> {
  const definition = await stores.definitions.getDefinition(jobId);
  if (!definition) return null;
  const instance = await stores.instances.getInstance(jobId);
  return {
    stages: projectStageViews(definition, instance),
    checkpointRunId: instance?.stageCheckpoint?.runId ?? null,
    // Issue #4767 — as in getJobStages: the checkpoint's kind
    // when it carries one, else the instance's recorded kind.
    checkpointKind:
      instance?.stageCheckpoint?.kind ?? instance?.runKind ?? null,
  };
}

export class JobPipelineControl {
  private readonly now: () => Date;
  private readonly newRunId: () => string;
  private readonly policy: PipelinePolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inflight = new Map<string, Promise<JobRunOutcome>>();
  /**
   * Issue #5279 — the units executing right now, per run. Populated by the
   * unit runner and read by `queryJob`; a run that has settled has no entry,
   * so the query can say "not live" from the same map the executor maintains.
   */
  private readonly liveUnits = new Map<string, Set<string>>();
  /** Issue #5279 — steps started per live run, reset when the run settles. */
  private readonly liveSteps = new Map<string, number>();

  constructor(private readonly deps: JobPipelineDeps) {
    this.now = deps.now ?? (() => new Date());
    // Issue #4782 S3 — an explicit policy wins; otherwise the
    // policy resolves once here from the host's env (platform
    // default) + the tenant's settings map (settings beat env).
    // Before this slice the fallback resolved with no env and no
    // settings at all, so operator tuning had no effect on runs.
    this.policy = deps.policy ?? resolvePipelinePolicy(deps.env, deps.settings);
    this.sleep = deps.sleep ?? defaultSleep;
    this.newRunId =
      // Issue #5175 slice 3: the engine default mints through the one
      // leaf minter — the same `run:<time36>-<counter36>` format, with
      // the counter per module (per isolate) rather than per engine
      // instance, so two engines in one isolate cannot collide.
      deps.newRunId ?? newRunId;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ---- definition management -------------------------------------------

  /** Define a job from configuration data alone. Refuses coded errors for invalid config. */
  async defineJob(rawConfig: unknown): Promise<JobDefinition> {
    const resolved = resolveJobDefinition(rawConfig);
    const existing = await this.deps.stores.definitions.getDefinition(resolved.jobId);
    const definition: JobDefinition = {
      jobId: resolved.jobId,
      name: resolved.name,
      root: resolved.root,
      rawConfig,
      config: resolved.config,
      version: (existing?.version ?? 0) + 1,
      updatedAt: this.iso(),
    };
    await this.deps.stores.definitions.saveDefinition(definition);
    if (!existing) {
      await this.deps.stores.instances.saveInstance(this.freshInstance(resolved.jobId));
    }
    return definition;
  }

  /** Reconfigure a job: the patch merges into the stored raw config and re-resolves. Applies to the next run / resume. */
  async configureJob(jobId: string, patch: unknown): Promise<JobDefinition> {
    const existing = await this.requireDefinition(jobId);
    const merged = mergeJobConfigPatch(existing.rawConfig, patch);
    return this.saveResolved(jobId, merged);
  }

  /** Resolve a full raw configuration and store it as the job's next definition version. */
  private async saveResolved(jobId: string, rawConfig: unknown): Promise<JobDefinition> {
    const existing = await this.requireDefinition(jobId);
    const resolved = resolveJobDefinition({
      ...(rawConfig as Record<string, unknown>),
      jobId,
    });
    const definition: JobDefinition = {
      jobId,
      name: resolved.name,
      root: resolved.root,
      rawConfig,
      config: resolved.config,
      version: existing.version + 1,
      updatedAt: this.iso(),
    };
    await this.deps.stores.definitions.saveDefinition(definition);
    return definition;
  }

  // ---- management operations (job granularity) ---------------------------

  /**
   * Issue #6466 part 2 — stamp a workflow dispatch on the instance row.
   * After the host starts a workflow instance, the row records the instance
   * id in the EXISTING `runWorkflowInstanceId` field, the start time, and
   * state "idle" — before the settlement poller runs, so the OODA page and
   * the ledger can show the run from dispatch. The stamp is an UPDATE to the
   * row `defineJob` already created (state "idle"); it never invents a
   * second field. It refuses `job_already_running` on a live instance
   * (queued/running/paused) — the same guard `dispatchResolved` enforces —
   * because stamping "running" would break the workflow's own `runJob`.
   */
  async stampWorkflowDispatch(
    jobId: string,
    stamp: { workflowInstanceId: string; startedAt?: string | null },
  ): Promise<JobInstanceRecord> {
    const instance = await this.requireInstance(jobId);
    if (
      instance.state === "queued" ||
      instance.state === "running" ||
      instance.state === "paused"
    ) {
      throw new JobPipelineError(
        "job_already_running",
        `Job "${jobId}" is ${instance.state} (run ${instance.currentRunId ?? "unknown"}); resume or cancel it before dispatching a new run.`,
      );
    }
    const updated: JobInstanceRecord = {
      ...instance,
      runWorkflowInstanceId: stamp.workflowInstanceId,
      runStartedAt: stamp.startedAt ?? this.iso(),
      state: "idle",
      updatedAt: this.iso(),
    };
    await this.setInstance(updated);
    return updated;
  }

  /**
   * Dispatch a run. The delivery mode comes from the job's
   * resolved configuration: sync awaits the outcome; async
   * returns the handle immediately (the run proceeds on the
   * host's behalf — the instance store is its durable truth).
   * `scopePath` runs one sub-tree (individually schedulable
   * sub-jobs); the default runs the whole job.
   */
  async runJob(
    jobId: string,
    opts?: { trigger?: JobRunTrigger; kind?: JobRunKind; originRunId?: string | null; scopePath?: string; scheduleId?: string; asyncJobId?: string; workflowInstanceId?: string; provenance?: JobRunProvenance | null },
  ): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    return this.dispatchResolved(definition, opts ?? {});
  }

  /**
   * Issue #6554 (F1) — the engine's async mode: an ad-hoc
   * single-unit submission. No registered job definition is
   * needed per submission (the withdrawn "one-stage job per
   * capability" shape is NOT this): the caller names the
   * capability, the engine resolves its registered step
   * (`async.capability.<capability>`) from the step registry,
   * invokes it once with the caller's input, and records the
   * unit as an engine run (`async.<capability>`, carrying the
   * dispatching async job's id) through the run recorder + the
   * settle observer — the same terminal-recording seam the
   * staged runs use.
   *
   * The queue's guarded claim stays the atomic exactly-once
   * gate (the executor claims before dispatching here); this
   * mode has no single-row guard to serialize on — each
   * submission is its own run, the F2 run-per-row foundation —
   * and no resume path: a retry re-dispatches as a new run.
   * The step executes inside the step journal, so the OTel
   * journal sees the unit exactly as it sees a staged step.
   * A step failure is returned as the outcome (never thrown):
   * the executor turns it into the queue row's failure, so
   * the row's coded failure derivation stays the one path.
   * An unknown capability refuses by name before any run is
   * recorded, exactly as an unknown definition does.
   */
  async runAsyncUnit(request: AsyncUnitRequest): Promise<AsyncUnitOutcome> {
    const capability = request.capability;
    if (!isAsyncCapability(capability)) {
      throw new JobPipelineError(
        "async_capability_unknown",
        `Unknown async capability "${String(capability)}". Registered capabilities: ${ASYNC_CAPABILITIES.join(", ")}.`,
      );
    }
    const jobId = asyncCapabilityJobId(capability);
    const runId = this.newRunId();
    const startedAt = this.iso();
    const trigger = normalizeJobRunTrigger(request.trigger);
    const handler = this.deps.steps.resolve(asyncCapabilityStepName(capability));
    const stepCtx: JobStepContext = {
      jobId,
      runId,
      nodePath: "",
      kind: "async",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { capability },
      input: request.input,
      now: startedAt,
      trigger,
      runKind: "original",
    };
    // Issue #5279 — the unit is live until it settles, under the
    // same map the staged units report through.
    const liveSet = this.liveUnits.get(runId) ?? new Set<string>();
    liveSet.add(`async:${capability}`);
    this.liveUnits.set(runId, liveSet);
    this.liveSteps.set(runId, 1);
    const journal = this.deps.journal ?? identityJobStepJournal;
    let output: unknown;
    let error: string | undefined;
    try {
      const result = await journal.do(
        stepExecutionId(runId, "", 0, null, null),
        () => handler(stepCtx),
        { runId, jobId },
      );
      output = result.output;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.liveUnits.delete(runId);
      this.liveSteps.delete(runId);
    }
    const state = error === undefined ? "completed" : "failed";
    const record = buildJobRunRecord({
      system: "job-pipeline",
      jobId,
      operation: "async",
      started: startedAt,
      finished: this.iso(),
      outcome: state === "completed" ? "success" : "failure",
      triggeredBy: trigger,
      kind: "original",
      originRunId: null,
      scheduleId: null,
      asyncJobId: request.asyncJobId,
      workflowId: runId,
      ...(error !== undefined ? { error } : {}),
    });
    await this.deps.runRecorder.recordRun(record);
    const observer = this.deps.runSettledObserver;
    if (observer) {
      try {
        await observer({
          jobId,
          runId,
          trigger,
          state,
          ...(error ? { error } : {}),
          kind: "original",
          originRunId: null,
        });
      } catch {
        // Best-effort by contract (see JobPipelineDeps): the
        // observers log their own failures.
      }
    }
    return {
      jobId,
      runId,
      state,
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  /**
   * Issue #4467 — replay a past run: start a NEW run of the definition
   * version the original executed, with the original's trigger. The
   * original run and its artifacts are read, never touched.
   *
   * Not to be confused with `replayJob` (#4454), which re-enters the
   * SAME run id after a workflow eviction. This one mints a new run.
   *
   * Refusals are named, never guessed:
   *  - the id is not among the job's retained runs → `job_run_not_found`;
   *  - the original predates the definition-version stamp (#5887) →
   *    `replay_pre_retention_run` (its exact configuration was never
   *    retained; "closest version" would be a false reproduction);
   *  - the stamped version is no longer resolvable →
   *    `replay_definition_version_unresolved`.
   */
  async replayRun(jobId: string, runId: string): Promise<JobDispatchResult> {
    const { original, definition } = await this.pastRunDefinition(jobId, runId);
    // The original's trigger is the replay's trigger; its schedule and
    // async-job links belong to that dispatch, so they are NOT copied —
    // a replay is the operator's new run, not a second firing.
    return this.dispatchResolved(definition, {
      trigger: normalizeJobRunTrigger(original.trigger),
      kind: "replay",
      originRunId: runId,
    });
  }

  /**
   * The past-run resolution `replayRun` and `replayStage` share: the
   * retained run record, and the definition version that run executed.
   * One resolution, so a whole-run replay and a stage replay cannot
   * disagree about which configuration is being reproduced.
   */
  private async pastRunDefinition(
    jobId: string,
    runId: string,
  ): Promise<{ original: JobRunRecord; definition: JobDefinition }> {
    const history = await this.deps.runRecorder.listRuns(jobId);
    const original = history.find((record) => record.workflowId === runId);
    if (!original) {
      throw new JobPipelineError(
        "job_run_not_found",
        `Job "${jobId}" has no run "${runId}" among its retained runs; there is nothing to replay.`,
      );
    }
    if (original.definitionVersion == null) {
      throw new JobPipelineError(
        "replay_pre_retention_run",
        `Run "${runId}" of job "${jobId}" predates the definition-version stamp; its exact configuration was not retained, so it cannot be replayed. A replay refuses rather than substituting the closest version.`,
      );
    }
    const definition = await this.deps.stores.definitions.getDefinitionVersion(
      jobId,
      original.definitionVersion,
    );
    if (!definition) {
      throw new JobPipelineError(
        "replay_definition_version_unresolved",
        `Run "${runId}" of job "${jobId}" recorded definition version ${original.definitionVersion}, which is no longer resolvable; refusing rather than replaying a different configuration.`,
      );
    }
    return { original, definition };
  }

  /**
   * The one dispatch tail: guard the instance, assert the mode, mint a
   * fresh run id, execute, and return the sync outcome or the handle.
   * Shared by `runJob` and `replayRun` so a replay cannot drift into a
   * second execution path.
   *
   * Issue #6555 — run-per-row mode: when the definition's instance
   * scope is "run", dispatch keys the run by its own instance row
   * (`dispatchPerRun`) instead of the job's single row, so concurrent
   * submissions of the definition run concurrently. The single-row
   * path below is unchanged: the guard, its order (guard first,
   * then mode/scope asserts), and its refusal are exactly as before.
   */
  private async dispatchResolved(
    definition: JobDefinition,
    opts: { trigger?: JobRunTrigger; kind?: JobRunKind; originRunId?: string | null; scopePath?: string; scheduleId?: string; asyncJobId?: string; workflowInstanceId?: string; provenance?: JobRunProvenance | null; input?: unknown; stageOnly?: boolean },
  ): Promise<JobDispatchResult> {
    const jobId = definition.jobId;
    let runId: string;
    let completion: Promise<JobRunOutcome>;
    if (definition.config.instanceScope === "run") {
      assertExecutionModeSupported(definition.config.executionMode);
      this.assertScopeNotRetired(definition, opts.scopePath ?? "");
      ({ runId, completion } = await this.dispatchPerRun(definition, opts));
    } else {
      const instance = await this.requireInstance(jobId);
      if (
        instance.state === "queued" ||
        instance.state === "running" ||
        instance.state === "paused"
      ) {
        throw new JobPipelineError(
          "job_already_running",
          `Job "${jobId}" is ${instance.state} (run ${instance.currentRunId ?? "unknown"}); resume or cancel it before dispatching a new run.`,
        );
      }
      assertExecutionModeSupported(definition.config.executionMode);
      this.assertScopeNotRetired(definition, opts.scopePath ?? "");
      runId = this.newRunId();
      completion = this.executeRun(definition, {
        runId,
        trigger: normalizeJobRunTrigger(opts.trigger),
        // Issue #4767 — a fresh dispatch is an original unless the
        // caller is retryJob, which passes kind "re-run" + the origin
        // run id it retried. The kind is normalized, never trusted.
        kind: normalizeJobRunKind(opts.kind),
        originRunId: normalizeOriginRunId(opts.originRunId),
        scopePath: opts.scopePath ?? "",
        scheduleId: opts.scheduleId ?? null,
        asyncJobId: opts.asyncJobId ?? null,
        workflowInstanceId: opts.workflowInstanceId ?? null,
        // Issue #6557 — the firing schedule payload's provenance, and only
        // that: a manual, retried or re-run dispatch passes none and the
        // run records explicit nulls.
        provenance: opts.provenance ?? null,
        resuming: false,
        runInstanceKey: null,
        // Issue #6400 — a stage replay hands the named stage its RECORDED
        // input and executes that stage alone (see replayStage).
        input: opts.input,
        stageOnly: opts.stageOnly,
      });
    }
    this.inflight.set(runId, completion);
    if (definition.config.executionMode.delivery === "sync") {
      const outcome = await completion;
      return { jobId, runId, state: outcome.state };
    }
    return { jobId, runId, state: "queued", completion };
  }

  /**
   * Issue #6555 — the per-run dispatch tail. Each submission gets
   * its own instance row, keyed by the submission: the dispatching
   * async job id when one dispatched it, else the run id itself.
   * A live row under the same key is a true duplicate — the same
   * submission dispatched twice — and refuses `job_already_running`;
   * a terminal row under the same key is a re-dispatch (retry),
   * which proceeds with a fresh run. A submission with no async
   * job id has nothing to dedupe against, so every such dispatch
   * is a new run.
   *
   * Duplicate semantics, stated honestly: this is check-then-write,
   * not an atomic claim — two simultaneous dispatches of the same
   * key can both pass the check. The queue's guarded claim remains
   * the atomic gate on F1's path; this check is the second line.
   *
   * A proven replay re-enters here, not through `replayJob` (which
   * addresses the job's management row): when the caller proves it
   * is the same workflow instance that dispatched the live run —
   * the recorded workflow instance id equals the caller's — the
   * live run resumes under its own id. An unproven re-entry
   * refuses exactly as a duplicate does.
   */
  private async dispatchPerRun(
    definition: JobDefinition,
    opts: { trigger?: JobRunTrigger; kind?: JobRunKind; originRunId?: string | null; scopePath?: string; scheduleId?: string; asyncJobId?: string; workflowInstanceId?: string; provenance?: JobRunProvenance | null; input?: unknown; stageOnly?: boolean },
  ): Promise<{ runId: string; completion: Promise<JobRunOutcome> }> {
    const jobId = definition.jobId;
    const runId = this.newRunId();
    const runKey = opts.asyncJobId ?? runId;
    const live = await this.deps.stores.instances.getInstance(jobId, runKey);
    if (
      live &&
      (live.state === "queued" || live.state === "running" || live.state === "paused")
    ) {
      if (
        opts.workflowInstanceId &&
        live.runWorkflowInstanceId === opts.workflowInstanceId &&
        live.currentRunId
      ) {
        const resumed = this.executeRun(definition, {
          runId: live.currentRunId,
          trigger: normalizeJobRunTrigger(live.runTrigger),
          kind: "replay",
          originRunId: live.currentRunId,
          scopePath: live.checkpoint?.scopePath ?? opts.scopePath ?? "",
          scheduleId: live.runScheduleId ?? null,
          asyncJobId: live.runAsyncJobId ?? null,
          workflowInstanceId: opts.workflowInstanceId,
          resuming: true,
          runInstanceKey: runKey,
        });
        return { runId: live.currentRunId, completion: resumed };
      }
      throw new JobPipelineError(
        "job_already_running",
        `Job "${jobId}" run "${runKey}" is ${live.state} (run ${live.currentRunId ?? "unknown"}); resume or cancel it before dispatching a new run.`,
      );
    }
    const completion = this.executeRun(definition, {
      runId,
      trigger: normalizeJobRunTrigger(opts.trigger),
      kind: normalizeJobRunKind(opts.kind),
      originRunId: normalizeOriginRunId(opts.originRunId),
      scopePath: opts.scopePath ?? "",
      scheduleId: opts.scheduleId ?? null,
      asyncJobId: opts.asyncJobId ?? null,
      workflowInstanceId: opts.workflowInstanceId ?? null,
      // Issue #6557 — the firing schedule payload's provenance, and only
      // that: a manual, retried or re-run dispatch passes none and the
      // run records explicit nulls.
      provenance: opts.provenance ?? null,
      resuming: false,
      runInstanceKey: runKey,
      // Issue #6400 — a stage replay in run-per-row mode narrows the same
      // way: the named stage's recorded input, that stage alone.
      input: opts.input,
      stageOnly: opts.stageOnly,
    });
    return { runId, completion };
  }

  /**
   * Stop the run (the #3069 stop at run granularity — the
   * pipeline's historical name is pause): honored at the next
   * step boundary; the run checkpoints and settles as paused,
   * its in-flight unit recorded stopped, never failed.
   */
  async pauseJob(jobId: string): Promise<JobInstanceRecord> {
    const instance = await this.requireInstance(jobId);
    if (instance.state !== "running" && instance.state !== "queued") {
      throw new JobPipelineError(
        "job_not_pausable",
        `Job "${jobId}" is ${instance.state}; only a queued or running job can pause.`,
      );
    }
    const updated: JobInstanceRecord = {
      ...instance,
      desiredState: "pause",
      updatedAt: this.iso(),
    };
    await this.deps.stores.instances.saveInstance(updated);
    return updated;
  }

  /**
   * Issue #5278 — the definition a resume or a running-instance replay must
   * execute: the exact version the run started under (#5887's stamp on the
   * instance), never today's pointer. A reconfigure applies to new runs
   * only; a run that is half-executed under v1 must not silently finish
   * under v2's semantics. This is the execution half of #5887's stamp —
   * `replayRun` (#4467) already resolves it for a past run.
   *
   * The refusals are named, never a silent substitution:
   *  - no live/last run → today's definition, so the caller's own
   *    no-run / no-checkpoint refusal is the one that surfaces;
   *  - the run predates the stamp → `resume_pre_retention_run` (its exact
   *    configuration was never retained, so "today's" would be a false
   *    continuation; a retry starts a new run);
   *  - the stamped version is no longer resolvable →
   *    `resume_definition_version_unresolved`.
   */
  private async pinnedRunDefinition(
    jobId: string,
    instance: JobInstanceRecord,
  ): Promise<JobDefinition> {
    if (!instance.currentRunId) return this.requireDefinition(jobId);
    const stamped = instance.runDefinitionVersion;
    if (stamped == null) {
      throw new JobPipelineError(
        "resume_pre_retention_run",
        `resume_pre_retention_run: run "${instance.currentRunId}" of job "${jobId}" predates the definition-version stamp; its exact configuration was not retained, so it cannot be resumed under it. Retry the job to start a new run on the current definition.`,
      );
    }
    const pinned = await this.deps.stores.definitions.getDefinitionVersion(
      jobId,
      stamped,
    );
    if (!pinned) {
      throw new JobPipelineError(
        "resume_definition_version_unresolved",
        `resume_definition_version_unresolved: run "${instance.currentRunId}" of job "${jobId}" recorded definition version ${stamped}, which is no longer resolvable; refusing rather than resuming under a different configuration. Retry the job to start a new run on the current definition.`,
      );
    }
    return pinned;
  }

  /** Resume a stopped (paused) run from its persisted stage checkpoint, under the definition version it started with (#5278). */
  async resumeJob(jobId: string): Promise<JobDispatchResult> {
    const instance = await this.requireInstance(jobId);
    if (instance.state !== "paused") {
      throw new JobPipelineError(
        "job_not_resumable",
        `Job "${jobId}" is ${instance.state}; only a paused job can resume.`,
      );
    }
    if (!instance.checkpoint || !instance.currentRunId) {
      throw new JobPipelineError(
        "job_no_checkpoint",
        `Job "${jobId}" is paused without a checkpoint; retry it instead.`,
      );
    }
    const definition = await this.pinnedRunDefinition(jobId, instance);
    assertExecutionModeSupported(definition.config.executionMode);
    const runId = instance.currentRunId;
    const completion = this.executeRun(definition, {
      runId,
      trigger: normalizeJobRunTrigger(instance.runTrigger),
      // Issue #4767 — a resume is the SAME run continued: kind
      // "resume", and the origin is the run itself.
      kind: "resume",
      originRunId: runId,
      scopePath: instance.checkpoint.scopePath,
      // A resumed run keeps the schedule id that dispatched it.
      scheduleId: instance.runScheduleId ?? null,
      // ... and the async job id that dispatched it (#4357 join key).
      asyncJobId: instance.runAsyncJobId ?? null,
      // ... but NOT the workflow instance id: a resume is a new
      // executor, and the dispatching workflow instance settled
      // with the paused outcome — the stamp clears (#4454).
      workflowInstanceId: null,
      resuming: true,
      // Issue #6555 — resume addresses the job's management row.
      runInstanceKey: null,
    });
    this.inflight.set(runId, completion);
    if (definition.config.executionMode.delivery === "sync") {
      const outcome = await completion;
      return { jobId, runId, state: outcome.state };
    }
    return { jobId, runId, state: "queued", completion };
  }

  /**
   * Issue #4454 — replay a still-`running` instance after a
   * workflow eviction. A replayed workflow flow re-enters
   * through runJob, which refuses `job_already_running` — the
   * instance never settled, because the evicted process wrote
   * nothing on its way out. The replay is safe ONLY when the
   * caller proves it is the same workflow instance that
   * dispatched the run: the recorded workflow instance id must
   * equal the caller's. A different instance, an unstamped run,
   * or a non-running state refuses by name — the guard's
   * protection against concurrent executors is never weakened.
   * The resumed run keeps its engine run id, its trigger, its
   * schedule and async-job links, and its scope (the
   * checkpoint's when one was written, else the caller's —
   * the replay carries the dispatch payload, so the scope is
   * the dispatch's own). The journal + persisted artifacts
   * carry the resume position, exactly as for a paused resume.
   */
  async replayJob(
    jobId: string,
    opts: { workflowInstanceId: string; scopePath?: string },
  ): Promise<JobDispatchResult> {
    const instance = await this.requireInstance(jobId);
    if (instance.state !== "running") {
      throw new JobPipelineError(
        "job_not_resumable",
        `Job "${jobId}" is ${instance.state}; only a still-running instance can be replayed.`,
      );
    }
    if (!instance.currentRunId) {
      throw new JobPipelineError(
        "job_no_checkpoint",
        `Job "${jobId}" is running without a run id; there is no run to replay.`,
      );
    }
    if (instance.runWorkflowInstanceId !== opts.workflowInstanceId) {
      throw new JobPipelineError(
        "job_already_running",
        `Job "${jobId}" is running (run ${instance.currentRunId}) under a different executor; ` +
          `this replay cannot prove it dispatched the run, so it cannot resume it.`,
      );
    }
    // Issue #5278 — a replay re-enters the SAME run, so it executes the
    // version that run started under, exactly as a paused resume does.
    const definition = await this.pinnedRunDefinition(jobId, instance);
    assertExecutionModeSupported(definition.config.executionMode);
    const runId = instance.currentRunId;
    const completion = this.executeRun(definition, {
      runId,
      trigger: normalizeJobRunTrigger(instance.runTrigger),
      // Issue #4767 — a replay is the SAME run re-entered: kind
      // "replay", and the origin is the run itself.
      kind: "replay",
      originRunId: runId,
      scopePath: instance.checkpoint?.scopePath ?? opts.scopePath ?? "",
      scheduleId: instance.runScheduleId ?? null,
      asyncJobId: instance.runAsyncJobId ?? null,
      // The replay re-stamps the same id: the proof survives a
      // second eviction of the same workflow instance.
      workflowInstanceId: opts.workflowInstanceId,
      resuming: true,
      // Issue #6555 — replay addresses the job's management row.
      runInstanceKey: null,
    });
    this.inflight.set(runId, completion);
    if (definition.config.executionMode.delivery === "sync") {
      const outcome = await completion;
      return { jobId, runId, state: outcome.state };
    }
    return { jobId, runId, state: "queued", completion };
  }

  /** Cancel: a running job stops at the next boundary; a paused or queued job cancels immediately. Terminal either way. */
  async cancelJob(jobId: string): Promise<JobInstanceRecord> {
    const instance = await this.requireInstance(jobId);
    if (TERMINAL.includes(instance.state) || instance.state === "idle") {
      throw new JobPipelineError(
        "job_not_cancellable",
        `Job "${jobId}" is ${instance.state}; there is no live run to cancel.`,
      );
    }
    if (instance.state === "running" || instance.state === "queued") {
      const updated: JobInstanceRecord = {
        ...instance,
        desiredState: "cancel",
        updatedAt: this.iso(),
      };
      await this.deps.stores.instances.saveInstance(updated);
      // Issue #5783 — the durable host is stopped too. The flag above only
      // reaches an engine that is between steps; a run parked in a durable
      // wait (#3955) never reaches a boundary at all. Once the platform
      // instance is terminated no executor remains, so the record settles
      // here instead of waiting for a boundary that will never come.
      if (await this.terminateDurableRun(jobId, updated)) {
        return this.settleCancelled(updated);
      }
      return updated;
    }
    return this.settleCancelled(instance);
  }

  /**
   * Issue #5783 — stop the run's durable host, when it has one and the host
   * can reach it. Returns true only when an instance was terminated.
   *
   * The rollback choice is recorded here, at the one call site: `rollback:
   * false` because no engine step registers a platform rollback handler yet
   * (#5958 retires the hand-built compensation into them); asking the
   * platform to compensate now would claim work that does not exist.
   */
  private async terminateDurableRun(
    jobId: string,
    instance: JobInstanceRecord,
  ): Promise<boolean> {
    const workflowInstanceId = instance.runWorkflowInstanceId;
    const terminate = this.deps.terminateRun;
    if (!workflowInstanceId || !terminate) return false;
    await terminate({
      jobId,
      runId: instance.currentRunId ?? "",
      workflowInstanceId,
    });
    return true;
  }

  /**
   * Issue #5783 — settle a cancelled run with no executor left. The paused
   * branch and the terminated-instance branch share ONE settlement: the
   * run's outstanding units are swept to cancelled so the cancellation is
   * surfaced per stage, never vanished (#3069).
   */
  private async settleCancelled(instance: JobInstanceRecord): Promise<JobInstanceRecord> {
    const settled: JobInstanceRecord = {
      ...instance,
      state: "cancelled",
      desiredState: "none",
      stageDesired: null,
      stageCheckpoint: instance.stageCheckpoint
        ? {
            ...instance.stageCheckpoint,
            units: instance.stageCheckpoint.units.map((unit) =>
              unit.status === "completed" || unit.status === "cancelled"
                ? unit
                : { ...unit, status: "cancelled" as const, endedAt: this.iso(), updatedAt: this.iso() },
            ),
          }
        : null,
      updatedAt: this.iso(),
    };
    await this.deps.stores.instances.saveInstance(settled);
    await publishJobStatus(this.deps.publisher, {
      jobId: instance.jobId,
      runId: instance.currentRunId ?? "unknown",
      state: "cancelled",
      at: this.iso(),
    });
    await this.recordTerminal(settled, "cancelled", undefined);
    return settled;
  }
  /**
   * Issue #3955 — deliver a named event to a RUNNING job's durable host.
   * This is the delivery half of the wait: an approval decision, a webhook,
   * or a sibling stage sends, and the waiting stage resumes on it. Refusals
   * are by name — a job that is not running, a host with no channel — never
   * a silent drop.
   */
  async sendEvent(
    jobId: string,
    event: string,
    payload?: unknown,
  ): Promise<{ jobId: string; runId: string; workflowInstanceId: string | null }> {
    const name = typeof event === "string" ? event.trim() : "";
    if (!name) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Job "${jobId}" event delivery requires a non-empty event name.`,
      );
    }
    const instance = await this.requireInstance(jobId);
    if (instance.state !== "running") {
      throw new JobPipelineError(
        "job_not_running",
        `Job "${jobId}" is ${instance.state}; only a running job can receive event "${name}".`,
      );
    }
    const runId = instance.currentRunId;
    if (!runId) {
      throw new JobPipelineError(
        "job_run_not_found",
        `Job "${jobId}" is running without a run id; event "${name}" has no run to reach.`,
      );
    }
    const send = this.deps.sendEvent;
    if (!send) {
      throw new JobPipelineError(
        "stage_port_unavailable",
        `Job "${jobId}" cannot receive event "${name}": this host provides no event-delivery channel.`,
      );
    }
    await send({
      jobId,
      runId,
      workflowInstanceId: instance.runWorkflowInstanceId,
      event: name,
      payload: payload ?? null,
    });
    return { jobId, runId, workflowInstanceId: instance.runWorkflowInstanceId };
  }

  /**
   * Issue #6552 — rewind a LIVE run to the first step of one stage through the
   * platform's own restart.
   *
   * This is not `rerunStage` and must not become it: `rerunStage` refuses
   * while a run is live (`assertStageNotLive`) and re-executes a stage from
   * the engine's own artifacts; the platform restart rewinds a live instance.
   * Opposite preconditions, different mechanisms, both named.
   *
   * Addressability is checked, never guessed: the platform identifies a step
   * by the name this engine gave it, so a stage is addressable only when its
   * first step has ONE name. A sharded stage or per-item `online` pacing has
   * one name per unit or item and refuses by name instead of rewinding the
   * wrong one.
   */
  async restartFromStage(jobId: string, nodePath: string): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    const runId = instance.currentRunId;
    if (instance.state !== "running" || !runId) {
      throw new JobPipelineError(
        "job_not_running",
        `Job "${jobId}" is ${instance.state}; a platform restart rewinds a live run only.`,
      );
    }
    this.assertStageNotRetired(definition, nodePath);
    const restart = this.deps.restartRun;
    const workflowInstanceId = instance.runWorkflowInstanceId;
    if (!restart || !workflowInstanceId) {
      throw new JobPipelineError(
        "stage_port_unavailable",
        `Job "${jobId}" cannot be rewound: ${workflowInstanceId ? "this host exposes no restart channel" : "the run is not stamped to a workflow instance"}.`,
      );
    }
    const node = this.nodeAtPath(definition.root, nodePath);
    // Issue #6560 — the target is derived from the SAME plan the executor
    // compiles, never assumed: a sharded stage's first unit is the plan's
    // first unit, and per-item pacing's first item is item 0. Rewinding to
    // that step discards every later step, so the whole stage re-runs —
    // which is what "restart from this stage" means.
    const mode = resolveExecutionMode({
      ...definition.config.executionMode,
      ...(node.executionMode ?? {}),
    });
    assertExecutionModeSupported(mode);
    const shardKeys: Array<string | null> =
      mode.shape === "sharded"
        ? [...(node.processing?.shards ?? definition.config.processing.shards)]
        : [];
    if (mode.shape === "sharded" && shardKeys.length === 0) {
      throw new JobPipelineError(
        "job_shards_not_configured",
        `Stage "${jobStageId(nodePath)}" of job "${jobId}" is configured for the sharded shape but names no shard keys; refusing rather than guessing a target.`,
      );
    }
    const stage = this.stageForNode(node, nodePath, mode, undefined);
    const plan = planRun({
      runId,
      invocation: this.deps.invocation ?? "sync",
      stages: [stage],
      units: shardKeys
        .filter((key): key is string => key !== null)
        .map((unitId) => ({ unitId })),
    });
    const firstUnit = plan.units[0]?.unitId ?? null;
    const firstItem = mode.pacing === "online" ? 0 : null;
    const fromStep = stepExecutionId(runId, nodePath, 0, firstUnit, firstItem);
    try {
      await restart({ jobId, runId, workflowInstanceId, fromStep });
    } catch (error) {
      throw new JobPipelineError(
        "stage_restart_rejected",
        `The platform refused to rewind job "${jobId}" to "${fromStep}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { jobId, runId, state: "running" };
  }

  /**
   * Issue #6395 — rewind a LIVE run to ONE named journal entry.
   *
   * This is the general form of `restartFromStage` (#6552): the platform
   * journals every engine step under the name `stepExecutionId` computed, so
   * "a journal entry" and "a step execution id" are the same name. Where
   * #6552 derives that name from a stage's first step, this takes the entry
   * an operator (or the checkpoint viewer, #6377) names.
   *
   * Addressability is checked against the run's OWN record, never guessed:
   * the entry's run segment must be this run, and its stage segment must be
   * one the run actually recorded in its stage checkpoint. A foreign or
   * stale entry refuses by name rather than rewinding something else.
   *
   * The definition is the run's pinned version (#5278, reused through
   * `pinnedRunDefinition`), so a rewind never executes today's configuration
   * against a half-executed run. The restart event is published only after
   * the platform accepts the rewind — an event that claims a restart which
   * did not happen is worse than no event.
   */
  async restartFromJournalEntry(
    jobId: string,
    runId: string,
    entryId: string,
  ): Promise<JobDispatchResult> {
    const instance = await this.requireInstance(jobId);
    if (instance.state !== "running") {
      throw new JobPipelineError(
        "job_not_running",
        `Job "${jobId}" is ${instance.state}; a platform restart rewinds a live run only.`,
      );
    }
    this.assertRunAddressed(instance, runId);
    // The entry's own construction is the first check: the id embeds the
    // run's body (never another run's) — `step:<runBody>:<stage>:...`.
    const runBody = runIdBody(runId);
    const segments = entryId.split(":");
    if (!entryId.startsWith(`step:${runBody}:`) || segments.length < 4) {
      throw new JobPipelineError(
        "journal_entry_not_addressed",
        `Entry "${entryId}" is not a step of run "${runId}" of job "${jobId}"; a restart rewinds the run's own journal, never another run's.`,
      );
    }
    // The named stage must be one this run recorded. The checkpoint is the
    // run's own record of which stages it produced, so it is the authority
    // here — not the current definition, which may have moved on.
    const stageSegment = segments[2];
    const ledger = await createJobPipelineStageCheckpointStore(
      this.deps.stores.instances,
      jobId,
    ).read(runId);
    const stageId = (ledger?.units ?? [])
      .map((unit) => unit.stage)
      .find((id) => (stageIdBody(id) || "root") === stageSegment);
    if (!stageId) {
      throw new JobPipelineError(
        "journal_entry_not_addressed",
        `Entry "${entryId}" names stage "${stageSegment}", which run "${runId}" of job "${jobId}" never recorded; the entry is not one of this run's journal entries.`,
      );
    }
    // Issue #5278, reused: the run executes under the version it started
    // with, and a missing or unresolvable version refuses by name.
    await this.pinnedRunDefinition(jobId, instance);
    const restart = this.deps.restartRun;
    const workflowInstanceId = instance.runWorkflowInstanceId;
    if (!restart || !workflowInstanceId) {
      throw new JobPipelineError(
        "stage_port_unavailable",
        `Job "${jobId}" cannot be rewound to "${entryId}": ${
          workflowInstanceId
            ? "this host exposes no restart channel"
            : "the run is not stamped to a workflow instance"
        }.`,
      );
    }
    try {
      await restart({ jobId, runId, workflowInstanceId, fromStep: entryId });
    } catch (error) {
      throw new JobPipelineError(
        "restart_rejected",
        `The platform refused to rewind job "${jobId}" to "${entryId}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId,
      stageId,
      action: "restart",
      at: this.iso(),
      detail: entryId,
    });
    return { jobId, runId, state: "running" };
  }

  /** Retry: a NEW run from the start (fresh run id, checkpoints cleared), from a terminal or paused state. */
  async retryJob(jobId: string): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    if (instance.state === "running" || instance.state === "queued") {
      throw new JobPipelineError(
        "job_not_retirable",
        `Job "${jobId}" is ${instance.state}; a live run cannot be retried — cancel it first.`,
      );
    }
    // Issue #4767 — the origin link: capture the run id BEFORE
    // the clear below wipes it. A retry is a NEW run (fresh run
    // id) that records which run it retried.
    const originRunId = instance.currentRunId;
    const cleared: JobInstanceRecord = {
      ...instance,
      state: "idle",
      desiredState: "none",
      checkpoint: null,
      stageCheckpoint: null,
      stageDesired: null,
      currentRunId: null,
      runStartedAt: null,
      runTrigger: null,
      runKind: null,
      runOriginId: null,
      runDefinitionVersion: null,
      runProvenance: null,
      runScheduleId: null,
      runWorkflowInstanceId: null,
      lastError: null,
      updatedAt: this.iso(),
    };
    await this.deps.stores.instances.saveInstance(cleared);
    return this.runJob(jobId, {
      trigger: resolveRunNowTrigger(definition),
      kind: "re-run",
      originRunId,
    });
  }

  /**
   * Issue #4002: settle pipeline runs orphaned by a host restart.
   * Called from the pipeline host's onStart, after the job
   * definitions are ensured. At host start no executor can still
   * be running — a live run cannot survive its host's death — so
   * every instance still marked `running` is settled as failed
   * with a named orphan error, through the engine's own failure
   * path (state + terminal run record + published transition),
   * and the job is dispatchable again. Paused, queued, idle,
   * completed, and failed instances are untouched: a paused run
   * resumes from its checkpoint, a queued run is still owed its
   * execution. Returns the settled job ids for the host's log.
   */
  async settleOrphanedRuns(): Promise<{ settled: string[] }> {
    const definitions = await this.deps.stores.definitions.listDefinitions();
    const settled: string[] = [];
    for (const definition of definitions) {
      const instance = await this.deps.stores.instances.getInstance(definition.jobId);
      if (!instance || instance.state !== "running") continue;
      const message =
        `Orphaned by a host restart: the run was still 'running' when the pipeline host started, ` +
        `so no executor can still be running it (run ${instance.currentRunId ?? "unknown"}, ` +
        `started ${instance.runStartedAt ?? "unknown"}). The run never recorded a result.`;
      await this.settleRunningInstance(definition.jobId, instance, message);
      settled.push(definition.jobId);
    }
    return { settled };
  }

  /**
   * Issue #3954 / #4002 — settle one instance still marked `running` through
   * the engine's own failure path: state + published transition + terminal run
   * record. One settle, two triggers (an orphaned host, a reaped stuck unit).
   */
  private async settleRunningInstance(
    jobId: string,
    instance: JobInstanceRecord,
    message: string,
  ): Promise<void> {
    const updated: JobInstanceRecord = {
      ...instance,
      state: "failed",
      desiredState: "none",
      lastError: message,
    };
    await this.setInstance(updated);
    await publishJobStatus(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId ?? "unknown",
      state: "failed",
      at: this.iso(),
      detail: message,
    });
    await this.recordTerminal(updated, "failed", message);
  }

  /**
   * Issue #3954 — the uniform stuck sweep: find RUNNING units whose recorded
   * liveness is older than the configured bound, mark them failed with a coded
   * error, and settle their run.
   *
   * The bound is policy (`pipeline.stuckUnitAfterMs`, default 30 minutes), the
   * same order as the async-jobs alert threshold this capability makes
   * uniform across families. The activity stamp is `heartbeatAt`, falling back
   * to `updatedAt`/`startedAt` so checkpoints written before heartbeats
   * existed stay sweepable — a run is never left unswept because it predates
   * the field.
   *
   * Additive by contract: a unit is touched only when it is provably stale. A
   * unit with no readable stamp is left alone (sweeping on no evidence would be
   * a guess), and a terminal unit is never reaped.
   */
  async sweepStuckUnits(
    opts: { nowMs?: number; stuckAfterMs?: number } = {},
  ): Promise<JobStuckSweepResult> {
    const nowMs = opts.nowMs ?? this.now().getTime();
    const bound = opts.stuckAfterMs ?? this.policy.stuckUnitAfterMs;
    const stuck: JobStuckUnit[] = [];
    const settled: string[] = [];
    const definitions = await this.deps.stores.definitions.listDefinitions();
    for (const definition of definitions) {
      const instance = await this.deps.stores.instances.getInstance(definition.jobId);
      if (!instance || instance.state !== "running" || !instance.currentRunId) continue;
      const runId = instance.currentRunId;
      const checkpoints = createJobPipelineStageCheckpointStore(
        this.deps.stores.instances,
        definition.jobId,
      );
      const checkpoint = await checkpoints.read(runId);
      if (!checkpoint) continue;
      const reaped = checkpoint.units
        .filter((unit) => unit.status === "running")
        .map((unit) => {
          const stamp = unit.heartbeatAt ?? unit.updatedAt ?? unit.startedAt;
          const at = stamp ? Date.parse(stamp) : Number.NaN;
          return { unit, silentMs: Number.isFinite(at) ? nowMs - at : Number.NaN };
        })
        .filter(({ silentMs }) => Number.isFinite(silentMs) && silentMs > bound);
      if (reaped.length === 0) continue;
      const at = this.iso();
      const reapedKeys = new Set(reaped.map(({ unit }) => `${unit.stage}\u0000${unit.unitId}`));
      await checkpoints.write({
        ...checkpoint,
        units: checkpoint.units.map((unit) =>
          reapedKeys.has(`${unit.stage}\u0000${unit.unitId}`)
            ? {
                ...unit,
                status: "failed" as never,
                error:
                  `job_unit_stuck: no step progress for ` +
                  `${Math.round((reaped.find((r) => r.unit === unit)?.silentMs ?? 0) / 1000)}s ` +
                  `(bound ${Math.round(bound / 1000)}s); the stuck sweep reaped the unit.`,
                updatedAt: at,
              }
            : unit,
        ),
      });
      for (const { unit, silentMs } of reaped) {
        const landing: JobStuckUnit = {
          jobId: definition.jobId,
          runId,
          stageId: unit.stage,
          unitId: unit.unitId,
          silentMs,
        };
        stuck.push(landing);
        await publishStageAction(this.deps.publisher, {
          jobId: definition.jobId,
          runId,
          stageId: unit.stage,
          unitId: unit.unitId,
          action: "failed",
          at,
          detail:
            `job_unit_stuck: no step progress for ${Math.round(silentMs / 1000)}s ` +
            `(bound ${Math.round(bound / 1000)}s)`,
        });
      }
      // The settle writes the whole instance record, so it must read the one
      // that carries the checkpoint we just wrote — a stale snapshot would
      // clobber the reaped units back to `running`.
      const fresh = (await this.deps.stores.instances.getInstance(definition.jobId)) ?? instance;
      await this.settleRunningInstance(
        definition.jobId,
        fresh,
        `Stuck run: ${reaped.length} unit(s) recorded no step progress for more than ` +
          `${Math.round(bound / 1000)}s in run ${runId}, so the run was settled failed ` +
          `rather than left hanging. The reaped units are named on the stage read.`,
      );
      settled.push(definition.jobId);
    }
    return { stuck, settled };
  }

  /** The status view: definition + live instance + run history from the one run-record machinery + per-stage states. */
  async getJob(jobId: string): Promise<JobStatusView> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.deps.stores.instances.getInstance(jobId);
    const history = await this.deps.runRecorder.listRuns(jobId, 50);
    return {
      definition,
      instance,
      latestRun: history[0],
      history,
      stages: this.stageViews(definition, instance),
    };
  }

  /**
   * Issue #6400 (owner decision 2026-11-26: "a new op") — replay ONE stage
   * of a PAST run.
   *
   * `replayRun` reproduces a whole past run; `rerunStage` re-executes a
   * stage of the CURRENT run. This is the third op: the named stage of a
   * settled run executes again as its OWN new run, on that run's recorded
   * definition version, from that stage's recorded input.
   *
   * What "one stage" is, stated rather than implied. A stage is a node's
   * OWN work; its children are the stages that run AFTER it, which is why
   * executing the node the way a run does would execute the rest of the
   * chain too. A replay therefore requires a stage that owns no
   * downstream stage: a node with children is a composite (a chain root,
   * or a sub-job), and it is refused by name with the stages that can be
   * replayed instead. `replayRun` is the operation for a composite.
   *
   * The downstream rule, stated rather than implied: stages AFTER the
   * replayed one do NOT re-execute. A replay is that stage's work,
   * reproduced; continuing the tree would make the new run's outputs a
   * mixture of old and new work.
   *
   * The run is `kind: "replay"` linked to the original by origin, and its
   * descriptor names the replayed stage — so the recorder and the Workflow
   * Runs view show a stage replay as what it is.
   */
  async replayStage(
    jobId: string,
    runId: string,
    nodePath: string,
  ): Promise<JobDispatchResult> {
    const { original, definition } = await this.pastRunDefinition(jobId, runId);
    const node = this.nodeAtPath(definition.root, nodePath);
    const downstream = node.children ?? [];
    if (downstream.length > 0) {
      const stages = downstream
        .map(
          (child, index) =>
            `${jobStageId(childPath(nodePath, index))} (${child.kind})`,
        )
        .join(", ");
      throw new JobPipelineError(
        "replay_stage_composite",
        `Stage "${jobStageId(nodePath)}" of job "${jobId}" is not one stage: it owns downstream stages ${stages}. A replay reproduces exactly one stage, so name one of those, or replay run "${runId}" whole.`,
      );
    }
    // The stage's recorded input is the past run's hand-off — the same
    // fail-closed read a re-run of that stage resolves, addressed to the
    // ORIGINAL run's artifacts (stageInput's runId argument).
    const input = await this.stageInput(definition, runId, nodePath);
    return this.dispatchResolved(definition, {
      trigger: normalizeJobRunTrigger(original.trigger),
      kind: "replay",
      originRunId: runId,
      scopePath: nodePath,
      input,
      stageOnly: true,
    });
  }

  /**
   * Issue #5279 — answer a LIVE question about a run, not a stored one.
   *
   * `getJob` reads persisted views; a run in flight looks like whatever was
   * last written. This reads what only this process can prove: whether it
   * holds the run's execution right now, which units are active, and how many
   * steps have started. A run executing elsewhere reads `live: false` — the
   * honest answer from here, never a guess at another isolate's state.
   *
   * Read-only by contract: nothing is written, no state is advanced.
   */
  async queryJob(jobId: string): Promise<JobLiveQuery> {
    const instance = await this.deps.stores.instances.getInstance(jobId);
    if (!instance) {
      throw new JobPipelineError(
        "job_not_found",
        `No pipeline job "${jobId}" is defined; nothing to query.`,
      );
    }
    const runId = instance.currentRunId ?? null;
    const live = runId !== null && this.liveUnits.has(runId);
    if (!live) {
      // A settled run leaves no live bookkeeping behind.
      if (runId) {
        this.liveSteps.delete(runId);
        this.liveUnits.delete(runId);
      }
      return {
        jobId,
        runId,
        state: instance.state,
        live: false,
        activeUnits: [],
        stepExecutions: 0,
      };
    }
    return {
      jobId,
      runId,
      state: instance.state,
      live: true,
      activeUnits: [...(this.liveUnits.get(runId!) ?? [])].sort(),
      stepExecutions: this.liveSteps.get(runId!) ?? 0,
    };
  }

  /**
   * Issue #4767 — the definition read the Run-now doors need: a
   * door resolves the Run-now trigger from the job's root
   * schedule (resolveRunNowTrigger) without re-implementing the
   * definition lookup. Thin wrapper over requireDefinition.
   */
  async getDefinition(jobId: string): Promise<JobDefinition> {
    return this.requireDefinition(jobId);
  }

  /**
   * Issue #4359 — the stage views alone: the read the Workflow Runs
   * projection needs (definition + live instance), without the run
   * history getJob also loads. Same projection as getJob, one rule.
   */
  async getJobStages(jobId: string): Promise<JobStagesRead> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.deps.stores.instances.getInstance(jobId);
    return {
      stages: this.stageViews(definition, instance),
      checkpointRunId: instance?.stageCheckpoint?.runId ?? null,
      // Issue #4767 — the checkpoint's kind when it carries one,
      // else the instance's recorded kind (a legacy checkpoint
      // predates the field); null when neither names one.
      checkpointKind:
        instance?.stageCheckpoint?.kind ?? instance?.runKind ?? null,
    };
  }

  async listJobs(): Promise<JobDefinition[]> {
    return this.deps.stores.definitions.listDefinitions();
  }

  /** The async-delivery completion handle for a dispatched run, when this host dispatched it. */
  waitForRun(runId: string): Promise<JobRunOutcome> | undefined {
    return this.inflight.get(runId);
  }

  /**
   * Register every enabled schedule (the job's own and every
   * sub-node's — sub-jobs are individually schedulable) with the
   * platform schedule host. Firing a registration maps to
   * runJob(jobId, { trigger: "scheduled", scopePath }).
   */
  async registerSchedules(
    host: JobScheduleHost,
  ): Promise<Array<{ jobId: string; nodePath: string; registrationId: string }>> {
    const registrations: Array<{
      jobId: string;
      nodePath: string;
      registrationId: string;
    }> = [];
    for (const definition of await this.deps.stores.definitions.listDefinitions()) {
      const walk = async (node: JobNodeConfig, path: string): Promise<void> => {
        const schedule = path === "" ? definition.config.schedule : node.schedule;
        if (schedule?.enabled) {
          const registrationId = await host.schedule({
            jobId: definition.jobId,
            nodePath: path,
            ...(schedule.cron ? { cron: schedule.cron } : {}),
            ...(schedule.interval ? { interval: schedule.interval } : {}),
          });
          registrations.push({ jobId: definition.jobId, nodePath: path, registrationId });
        }
        const children = node.children ?? [];
        for (let i = 0; i < children.length; i++) {
          await walk(children[i], childPath(path, i));
        }
      };
      await walk(definition.root, "");
    }
    return registrations;
  }

  // ---- uniform stage control (run granularity is above; stage granularity here) ----
  //
  // The seven operations of #3069 (folded into #3549), addressed
  // by (runId, stageId) — here the job's current run and a node
  // path (stageId `job:<nodePath>`). Meanings are #3069's pinned
  // ones; the claims are the stage checkpoint's entries (the
  // runId + stageId claim of the #2869 seam, carried on every
  // published stage event as its idempotencyKey).

  /** The stage entries of one stage in the instance's current ledger. */
  private stageEntries(instance: JobInstanceRecord, stageId: string): StageUnitCheckpoint[] {
    return (instance.stageCheckpoint?.units ?? []).filter((u) => u.stage === stageId);
  }

  /** Refuse stage actions addressed to a run the job is not currently on. */
  private assertRunAddressed(instance: JobInstanceRecord, runId?: string): void {
    if (runId !== undefined && instance.currentRunId !== runId) {
      throw new JobPipelineError(
        "stage_run_mismatch",
        `Stage actions address the job's current run (${instance.currentRunId ?? "none"}); run "${runId}" is not addressable — its stage checkpoint is no longer the live one.`,
      );
    }
    if (!instance.currentRunId || !instance.stageCheckpoint) {
      throw new JobPipelineError(
        "stage_no_run",
        `Job "${instance.jobId}" has no run to address; dispatch the job before addressing its stages.`,
      );
    }
  }

  /**
   * Retire refusal at dispatch (#3944): a job carrying a
   * retired stage in the dispatched scope never starts — the
   * run refuses by name before any step executes, naming the
   * retired stage(s). Retiring is an operator act on the
   * definition; a run that would include the stage cannot
   * silently skip it, and cannot run it either.
   */
  private assertScopeNotRetired(definition: JobDefinition, scopePath: string): void {
    const scopeNode = this.nodeAtPath(definition.root, scopePath);
    const retired: string[] = [];
    const walk = (node: JobNodeConfig, path: string): void => {
      if (node.retired === true) retired.push(jobStageId(path));
      (node.children ?? []).forEach((child, i) => walk(child, childPath(path, i)));
    };
    walk(scopeNode, scopePath);
    if (retired.length > 0) {
      throw new JobPipelineError(
        "stage_not_retirable",
        `Job "${definition.jobId}" has retired stage(s) ${retired.join(", ")} in scope "${scopePath || "root"}"; a retired stage never re-runs — redefine the job to remove or replace them.`,
      );
    }
  }

  /**
   * Refuse a stage action on a retired stage (#3944): the
   * stage's definition carries the retirement, so the refusal
   * is by name at the operation, never a silent no-op.
   */
  private assertStageNotRetired(definition: JobDefinition, nodePath: string): void {
    const node = this.nodeAtPath(definition.root, nodePath);
    if (node.retired === true) {
      throw new JobPipelineError(
        "stage_not_retirable",
        `Stage "${jobStageId(nodePath)}" of job "${definition.jobId}" is retired; a retired stage never re-runs.`,
      );
    }
  }

  private assertStageNotLive(instance: JobInstanceRecord, action: string): void {
    if (instance.state === "running" || instance.state === "queued" || instance.state === "paused") {
      throw new JobPipelineError(
        "stage_action_conflict",
        `Cannot ${action} a stage of job "${instance.jobId}" while its run is ${instance.state}; the live run owns its stages — stop or cancel it first.`,
      );
    }
  }

  /**
   * The persisted input a stage consumes: the hand-off its predecessor
   * wrote in this run. The root stage consumes the run input (null).
   * Fail-closed (#3069): a missing hand-off refuses — input is never
   * fabricated. In-memory processing keeps hand-offs in a dead run
   * context, so stage actions on such jobs refuse by name.
   *
   * `stageHandoffKey` owns which artifact that is, so run / re-run /
   * resume / replay all feed a stage what the run fed it.
   *
   * **"Absent" and "recorded null" are different facts (#6362).** A stage
   * whose predecessor genuinely produced null (the research chain's noop
   * root, for one) consumed exactly that null — refusing it would make the
   * first stage of a chain un-replayable while the run itself fed it fine.
   * Presence is therefore answered by whether the artifact KEY exists,
   * never by whether the value is null; the value itself is returned as
   * recorded, including null.
   */
  private async stageInput(
    definition: JobDefinition,
    runId: string,
    nodePath: string,
  ): Promise<unknown> {
    if (nodePath === "") return null;
    if (definition.config.processing.inMemory) {
      throw new JobPipelineError(
        "stage_input_missing",
        `Stage "${jobStageId(nodePath)}" of job "${definition.jobId}" cannot be addressed independently: the job processes in memory, so its stages' hand-offs were never persisted.`,
      );
    }
    const key = this.stageHandoffKey(definition, nodePath);
    const keys = await this.deps.stores.artifacts.listArtifactKeys(runId);
    if (!keys.includes(key)) {
      throw new JobPipelineError(
        "stage_input_missing",
        `Stage "${jobStageId(nodePath)}" of job "${definition.jobId}" has no persisted input in run ${runId}: its predecessor's hand-off is absent. Refusing rather than fabricating input.`,
      );
    }
    // The key exists, so the hand-off was recorded — reproduce it verbatim,
    // including a recorded null.
    return this.deps.stores.artifacts.getArtifact(runId, key);
  }

  /**
   * The artifact key of the hand-off a stage consumed, matching the
   * engine's own wiring in `execNode`: sequential children chain, so
   * child i>0 consumes child i-1's stage output; a first child — and
   * every child of a parallel parent, whose children all receive the
   * parent's output — consumes the parent's. One rule, read by every
   * stage-addressing operation, so a stage action never feeds a stage a
   * different input than the run did.
   */
  private stageHandoffKey(
    definition: JobDefinition,
    nodePath: string,
  ): string {
    const segments = pathSegments(nodePath);
    const index = segments[segments.length - 1];
    const parent = parentPath(nodePath);
    if (index === 0) return `${keyPart(parent)}/stage-output`;
    const parentNode = this.nodeAtPath(definition.root, parent);
    const parentMode = resolveExecutionMode({
      ...definition.config.executionMode,
      ...(parentNode.executionMode ?? {}),
    });
    if (parentMode.concurrency === "parallel") {
      return `${keyPart(parent)}/stage-output`;
    }
    return `${keyPart(childPath(parent, index - 1))}/stage-output`;
  }

  /**
   * Run: start a stage that has not run in the current run,
   * from its persisted input (out-of-order starts included —
   * the input is the only precondition).
   */
  async runStage(
    jobId: string,
    nodePath: string,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance, opts?.runId);
    this.assertStageNotLive(instance, "run");
    this.assertStageNotRetired(definition, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (entries.some((e) => e.status === "completed")) {
      throw new JobPipelineError(
        "stage_already_completed",
        `Stage "${stageId}" of job "${jobId}" already completed in run ${instance.currentRunId}; re-run is the operation for a completed stage.`,
      );
    }
    if (
      entries.length > 0 &&
      entries.every((e) => e.status === "cancelled" || e.status === "skipped")
    ) {
      throw new JobPipelineError(
        "stage_not_runnable",
        `Stage "${stageId}" of job "${jobId}" is ${entries[0].status} in run ${instance.currentRunId}; a cancelled stage never silently resumes.`,
      );
    }
    await this.stageInput(definition, instance.currentRunId!, nodePath);
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "run",
      at: this.iso(),
    });
    return this.executeStageAction(definition, instance, nodePath, false);
  }

  /**
   * Re-run: re-execute a completed or failed stage from its
   * persisted input. Idempotent via the runId + stageId claim:
   * the stage's entries return to queued under their existing
   * attempt counts and the re-execution overwrites the stage's
   * own hand-offs — a second re-run converges on the same
   * effects, never duplicates them. Downstream stages keep
   * their recorded outputs (re-running them is their own
   * operation).
   */
  async rerunStage(
    jobId: string,
    nodePath: string,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance, opts?.runId);
    this.assertStageNotLive(instance, "re-run");
    this.assertStageNotRetired(definition, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (entries.some((e) => e.status === "running")) {
      throw new JobPipelineError(
        "stage_action_in_flight",
        `Stage "${stageId}" of job "${jobId}" is recorded running in run ${instance.currentRunId}; a re-run of an in-flight stage converges on the live execution, never a second one.`,
      );
    }
    if (!entries.some((e) => e.status === "completed" || e.status === "failed" || e.status === "timed_out")) {
      throw new JobPipelineError(
        "stage_not_rerunnable",
        `Stage "${stageId}" of job "${jobId}" has no completed or failed units in run ${instance.currentRunId} — run starts a stage that has not run, resume continues a stopped one.`,
      );
    }
    await this.stageInput(definition, instance.currentRunId!, nodePath);
    const checkpoints = createJobPipelineStageCheckpointStore(
      this.deps.stores.instances,
      jobId,
    );
    const ledger = await checkpoints.read(instance.currentRunId!);
    if (ledger) {
      await checkpoints.write({
        ...ledger,
        units: ledger.units.map((u) =>
          u.stage === stageId ? { ...u, status: "queued" as const, updatedAt: this.iso() } : u,
        ),
      });
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "rerun",
      at: this.iso(),
    });
    const fresh = await this.requireInstance(jobId);
    return this.executeStageAction(definition, fresh, nodePath, true);
  }

  /**
   * Stop: halt a running stage — non-terminal, resumable,
   * recorded and surfaced as stopped, never as failed. On a
   * live run the request is recorded per stage and honored at
   * that stage's next boundary (or when the stage is reached);
   * on a run whose engine is gone, recorded-running units are
   * marked stopped directly. Stopping an already-stopped stage
   * converges (returns the instance unchanged in effect).
   */
  async stopStage(jobId: string, nodePath: string): Promise<JobInstanceRecord> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance);
    this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (instance.state === "running" || instance.state === "queued") {
      if (
        entries.length > 0 &&
        entries.every(
          (e) => e.status === "completed" || e.status === "cancelled" || e.status === "skipped",
        )
      ) {
        throw new JobPipelineError(
          "stage_not_stoppable",
          `Stage "${stageId}" of job "${jobId}" is already terminal in run ${instance.currentRunId}; there is nothing left to stop.`,
        );
      }
      const stageDesired = { ...(instance.stageDesired ?? {}), [stageId]: "pause" as const };
      const updated: JobInstanceRecord = { ...instance, stageDesired, updatedAt: this.iso() };
      await this.deps.stores.instances.saveInstance(updated);
      await publishStageAction(this.deps.publisher, {
        jobId,
        runId: instance.currentRunId!,
        stageId,
        action: "stop",
        at: this.iso(),
      });
      return updated;
    }
    if (entries.some((e) => e.status === "stopped")) return instance;
    if (entries.some((e) => e.status === "running" || e.status === "queued")) {
      const checkpoints = createJobPipelineStageCheckpointStore(
        this.deps.stores.instances,
        jobId,
      );
      const ledger = await checkpoints.read(instance.currentRunId!);
      if (ledger) {
        await checkpoints.write({
          ...ledger,
          units: ledger.units.map((u) =>
            u.stage === stageId && (u.status === "running" || u.status === "queued")
              ? { ...u, status: "stopped" as const, updatedAt: this.iso() }
              : u,
          ),
        });
      }
      await publishStageAction(this.deps.publisher, {
        jobId,
        runId: instance.currentRunId!,
        stageId,
        action: "stop",
        at: this.iso(),
      });
      return this.requireInstance(jobId);
    }
    throw new JobPipelineError(
      "stage_not_stoppable",
      `Stage "${stageId}" of job "${jobId}" is not running in run ${instance.currentRunId}; only a running (or recorded-running) stage can stop.`,
    );
  }

  /**
   * Resume: continue a stopped stage from its persisted
   * checkpoint via the runId + stageId claim. The run resumes
   * (its checkpoint is the stage's), and the runner's decisions
   * guarantee no completed effect re-executes.
   */
  async resumeStage(jobId: string, nodePath: string): Promise<JobDispatchResult> {
    // The retire check reads TODAY's definition on purpose (#3944): a
    // retirement is the operator's current veto over that stage, not a
    // property of the run's pinned version — a retired stage never
    // re-runs, whatever version the run started on. The execution that
    // follows still pins the run's own version (#5278).
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance);
    this.assertStageNotRetired(definition, nodePath);
    const stageId = jobStageId(nodePath);
    if (instance.state !== "paused") {
      throw new JobPipelineError(
        "stage_not_resumable",
        `Job "${jobId}" is ${instance.state}; only a stopped (paused) run's stage can resume.`,
      );
    }
    const stoppedStages = [
      ...new Set(
        (instance.stageCheckpoint?.units ?? [])
          .filter((u) => u.status === "stopped")
          .map((u) => u.stage),
      ),
    ];
    if (!stoppedStages.includes(stageId)) {
      throw new JobPipelineError(
        "stage_not_resumable",
        `Stage "${stageId}" of job "${jobId}" is not the stopped stage of run ${instance.currentRunId} (stopped: ${stoppedStages.join(", ") || "none"}); a run resumes from its stopped stage.`,
      );
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "resume",
      at: this.iso(),
    });
    return this.resumeJob(jobId);
  }

  /**
   * Cancel a stage: terminal and surfaced as cancelled. On a
   * live run the request is honored at the stage's boundaries
   * (or when the stage is reached — it then never executes,
   * and its downstream never proceeds). On a stopped run, the
   * stopped stage's cancellation settles the run as cancelled;
   * any other stage's entries are marked cancelled in place.
   */
  async cancelStage(jobId: string, nodePath: string): Promise<JobInstanceRecord> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    this.assertRunAddressed(instance);
    this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (entries.length > 0 && entries.every((e) => e.status === "completed")) {
      throw new JobPipelineError(
        "stage_not_cancellable",
        `Stage "${stageId}" of job "${jobId}" already completed in run ${instance.currentRunId}; a completed stage cannot be cancelled.`,
      );
    }
    if (instance.state === "running" || instance.state === "queued") {
      const stageDesired = { ...(instance.stageDesired ?? {}), [stageId]: "cancel" as const };
      const updated: JobInstanceRecord = { ...instance, stageDesired, updatedAt: this.iso() };
      await this.deps.stores.instances.saveInstance(updated);
      await publishStageAction(this.deps.publisher, {
        jobId,
        runId: instance.currentRunId!,
        stageId,
        action: "cancel",
        at: this.iso(),
      });
      return updated;
    }
    if (entries.length === 0) {
      throw new JobPipelineError(
        "stage_not_cancellable",
        `Stage "${stageId}" of job "${jobId}" has not run in run ${instance.currentRunId}; there is nothing to cancel.`,
      );
    }
    const checkpoints = createJobPipelineStageCheckpointStore(
      this.deps.stores.instances,
      jobId,
    );
    const ledger = await checkpoints.read(instance.currentRunId!);
    if (ledger) {
      await checkpoints.write({
        ...ledger,
        units: ledger.units.map((u) =>
          u.stage === stageId && u.status !== "completed"
            ? { ...u, status: "cancelled" as const, updatedAt: this.iso() }
            : u,
        ),
      });
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId!,
      stageId,
      action: "cancel",
      at: this.iso(),
    });
    const fresh = await this.requireInstance(jobId);
    // Cancelling the stage a stopped run is stopped at settles
    // the run: it can never resume past a cancelled stage.
    if (
      fresh.state === "paused" &&
      entries.some((e) => e.status === "stopped")
    ) {
      const settled: JobInstanceRecord = {
        ...fresh,
        state: "cancelled",
        desiredState: "none",
        stageDesired: null,
        updatedAt: this.iso(),
      };
      await this.deps.stores.instances.saveInstance(settled);
      await publishJobStatus(this.deps.publisher, {
        jobId,
        runId: fresh.currentRunId ?? "unknown",
        state: "cancelled",
        at: this.iso(),
      });
      await this.recordTerminal(settled, "cancelled", undefined);
      return settled;
    }
    return fresh;
  }

  /**
   * Retire a stage (#3944): the eighth uniform operation.
   * Definition-level and permanent — the stage is stamped
   * retired on the job's stored definition (versioned, like a
   * schedule change), so it never re-runs in any run. On a
   * live run the request is recorded per stage and honored at
   * that stage's next boundary (or when the stage is reached);
   * on a stopped run, retiring the stopped stage settles the
   * run as cancelled. A retired stage's units are recorded
   * "retired", never failed and never silently skipped — and
   * its downstream never proceeds. Retiring an already-retired
   * stage refuses by name; retiring needs no run (a stage can
   * be retired before it ever runs).
   */
  async retireStage(jobId: string, nodePath: string): Promise<JobInstanceRecord> {
    const definition = await this.requireDefinition(jobId);
    const instance = await this.requireInstance(jobId);
    const node = this.nodeAtPath(definition.root, nodePath);
    const stageId = jobStageId(nodePath);
    if (node.retired === true) {
      throw new JobPipelineError(
        "stage_not_retirable",
        `Stage "${stageId}" of job "${jobId}" is already retired; a retired stage never re-runs and cannot be retired again.`,
      );
    }
    await this.applyNodeRetired(jobId, nodePath);
    const entries = this.stageEntries(instance, stageId);
    if (instance.state === "running" || instance.state === "queued") {
      const stageDesired = { ...(instance.stageDesired ?? {}), [stageId]: "retire" as const };
      const updated: JobInstanceRecord = { ...instance, stageDesired, updatedAt: this.iso() };
      await this.deps.stores.instances.saveInstance(updated);
      await publishStageAction(this.deps.publisher, {
        jobId,
        runId: instance.currentRunId!,
        stageId,
        action: "retire",
        at: this.iso(),
      });
      return updated;
    }
    if (entries.length > 0) {
      const checkpoints = createJobPipelineStageCheckpointStore(
        this.deps.stores.instances,
        jobId,
      );
      const ledger = await checkpoints.read(instance.currentRunId!);
      if (ledger) {
        await checkpoints.write({
          ...ledger,
          units: ledger.units.map((u) =>
            u.stage === stageId && u.status !== "completed"
              ? { ...u, status: "retired" as const, updatedAt: this.iso() }
              : u,
          ),
        });
      }
    }
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: instance.currentRunId ?? "none",
      stageId,
      action: "retire",
      at: this.iso(),
    });
    const fresh = await this.requireInstance(jobId);
    // Retiring the stage a stopped run is stopped at settles
    // the run: it can never resume past a retired stage.
    if (
      fresh.state === "paused" &&
      entries.some((e) => e.status === "stopped")
    ) {
      const settled: JobInstanceRecord = {
        ...fresh,
        state: "cancelled",
        desiredState: "none",
        stageDesired: null,
        updatedAt: this.iso(),
      };
      await this.deps.stores.instances.saveInstance(settled);
      await publishJobStatus(this.deps.publisher, {
        jobId,
        runId: fresh.currentRunId ?? "unknown",
        state: "cancelled",
        at: this.iso(),
      });
      await this.recordTerminal(settled, "cancelled", undefined);
      return settled;
    }
    return fresh;
  }

  /**
   * Schedule: attach a not-yet-scheduled stage to the schedule
   * mechanism. The registration identity and the reason are
   * recorded on the stage's (externalized) schedule
   * configuration at creation and surfaced from it.
   */
  async scheduleStage(
    jobId: string,
    nodePath: string,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    const definition = await this.requireDefinition(jobId);
    const node = this.nodeAtPath(definition.root, nodePath);
    const existing = node.schedule;
    if (existing?.registrationId) {
      throw new JobPipelineError(
        "stage_already_scheduled",
        `Stage "${jobStageId(nodePath)}" of job "${jobId}" is already scheduled (registration ${existing.registrationId}); re-schedule is the operation for changing it.`,
      );
    }
    const scheduleHost = host ?? this.deps.scheduleHost;
    if (!scheduleHost) {
      throw new JobPipelineError(
        "stage_schedule_host_unconfigured",
        `No schedule host is configured for stage scheduling of job "${jobId}"; the host wiring supplies one (or pass it to scheduleStage).`,
      );
    }
    const registrationId = await scheduleHost.schedule({
      jobId,
      nodePath,
      ...(spec.cron ? { cron: spec.cron } : {}),
      ...(spec.interval ? { interval: spec.interval } : {}),
    });
    const schedule: JobScheduleConfig = {
      enabled: true,
      ...(spec.cron ? { cron: spec.cron } : {}),
      ...(spec.interval ? { interval: spec.interval } : {}),
      registrationId,
      reason,
    };
    await this.applyNodeSchedule(jobId, nodePath, schedule);
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: (await this.requireInstance(jobId)).currentRunId ?? "none",
      stageId: jobStageId(nodePath),
      action: "schedule",
      at: this.iso(),
      detail: registrationId,
    });
    return { registrationId, schedule };
  }

  /**
   * Re-schedule: one atomic action — the old registration is
   * cancelled and the new one created, in that order, and any
   * failure is loud (never a silent drop, never a duplicate
   * firing at both times: a host that cannot cancel cannot
   * re-schedule, fail-closed).
   */
  async rescheduleStage(
    jobId: string,
    nodePath: string,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    const definition = await this.requireDefinition(jobId);
    const node = this.nodeAtPath(definition.root, nodePath);
    const existing = node.schedule;
    if (!existing?.registrationId) {
      throw new JobPipelineError(
        "stage_not_scheduled",
        `Stage "${jobStageId(nodePath)}" of job "${jobId}" has no control-plane registration to re-schedule; schedule is the operation for attaching one.`,
      );
    }
    const scheduleHost = host ?? this.deps.scheduleHost;
    if (!scheduleHost) {
      throw new JobPipelineError(
        "stage_schedule_host_unconfigured",
        `No schedule host is configured for stage re-scheduling of job "${jobId}".`,
      );
    }
    if (!scheduleHost.unschedule) {
      throw new JobPipelineError(
        "stage_reschedule_unsupported",
        `The schedule host cannot cancel registration ${existing.registrationId}, so re-scheduling stage "${jobStageId(nodePath)}" of job "${jobId}" would risk a duplicate firing; refusing, fail-closed.`,
      );
    }
    await scheduleHost.unschedule(existing.registrationId);
    let registrationId: string;
    try {
      registrationId = await scheduleHost.schedule({
        jobId,
        nodePath,
        ...(spec.cron ? { cron: spec.cron } : {}),
        ...(spec.interval ? { interval: spec.interval } : {}),
      });
    } catch (error) {
      throw new JobPipelineError(
        "stage_reschedule_failed",
        `Re-scheduling stage "${jobStageId(nodePath)}" of job "${jobId}": the old registration ${existing.registrationId} was cancelled, but creating the new schedule failed (${error instanceof Error ? error.message : String(error)}). The stage is now unscheduled — schedule it explicitly.`,
      );
    }
    const schedule: JobScheduleConfig = {
      enabled: true,
      ...(spec.cron ? { cron: spec.cron } : {}),
      ...(spec.interval ? { interval: spec.interval } : {}),
      registrationId,
      reason,
    };
    await this.applyNodeSchedule(jobId, nodePath, schedule);
    await publishStageAction(this.deps.publisher, {
      jobId,
      runId: (await this.requireInstance(jobId)).currentRunId ?? "none",
      stageId: jobStageId(nodePath),
      action: "reschedule",
      at: this.iso(),
      detail: registrationId,
    });
    return { registrationId, schedule };
  }

  // ---- uniform stage control addressed by vocabulary stage (#3945, #4061) ----
  //
  // The same seven operations, addressed by (runId, stageId) with
  // the stage half a vocabulary stage name instead of a node path:
  // a catalog stage (#3945) or an options execution stage (#4061).
  // Each resolves the stage to its node path through
  // vocabularyStageNodePath and delegates to its (jobId, nodePath)
  // twin — the twins' meanings, claims, and refusals ARE the
  // operation, so a vocabulary address can never behave
  // differently from the node-path address of the same node. The
  // run half is the twins': the job's current run, optionally
  // pinned by opts.runId (run / re-run); schedule / re-schedule
  // need no run and address the definition's node directly.

  /** Resolve one vocabulary stage of one job to its node path. */
  private async vocabularyNodePath(jobId: string, stage: VocabularyStage): Promise<string> {
    const definition = await this.requireDefinition(jobId);
    return vocabularyStageNodePath(definition, stage);
  }

  /** Run a vocabulary stage that has not run in the current run. */
  async runStageByVocabulary(
    jobId: string,
    stage: VocabularyStage,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    return this.runStage(jobId, await this.vocabularyNodePath(jobId, stage), opts);
  }

  /** Re-run a completed or failed vocabulary stage from its persisted input. */
  async rerunStageByVocabulary(
    jobId: string,
    stage: VocabularyStage,
    opts?: { runId?: string },
  ): Promise<JobDispatchResult> {
    return this.rerunStage(jobId, await this.vocabularyNodePath(jobId, stage), opts);
  }

  /** Stop a running vocabulary stage — non-terminal, resumable. */
  async stopStageByVocabulary(jobId: string, stage: VocabularyStage): Promise<JobInstanceRecord> {
    return this.stopStage(jobId, await this.vocabularyNodePath(jobId, stage));
  }

  /** Resume a stopped vocabulary stage from its persisted checkpoint. */
  async resumeStageByVocabulary(jobId: string, stage: VocabularyStage): Promise<JobDispatchResult> {
    return this.resumeStage(jobId, await this.vocabularyNodePath(jobId, stage));
  }

  /** Cancel a vocabulary stage — terminal, surfaced as cancelled. */
  async cancelStageByVocabulary(jobId: string, stage: VocabularyStage): Promise<JobInstanceRecord> {
    return this.cancelStage(jobId, await this.vocabularyNodePath(jobId, stage));
  }

  /**
   * Retire a vocabulary stage — permanent, the stage never
   * re-runs in any run. Delegates to the (jobId, nodePath)
   * twin, so the twin's meanings, claims, and refusals ARE
   * the operation.
   */
  async retireStageByVocabulary(jobId: string, stage: StageName): Promise<JobInstanceRecord> {
    return this.retireStage(jobId, await this.vocabularyNodePath(jobId, stage));
  }

  /** Schedule a vocabulary stage: attach it to the schedule mechanism. */
  async scheduleStageByVocabulary(
    jobId: string,
    stage: VocabularyStage,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    return this.scheduleStage(
      jobId,
      await this.vocabularyNodePath(jobId, stage),
      spec,
      reason,
      host,
    );
  }

  /** Re-schedule a vocabulary stage: one atomic action. */
  async rescheduleStageByVocabulary(
    jobId: string,
    stage: VocabularyStage,
    spec: { cron?: string; interval?: string },
    reason: string,
    host?: JobScheduleHost,
  ): Promise<{ registrationId: string; schedule: JobScheduleConfig }> {
    return this.rescheduleStage(
      jobId,
      await this.vocabularyNodePath(jobId, stage),
      spec,
      reason,
      host,
    );
  }

  /**
   * Persist one node's retirement into the job's stored raw
   * definition (re-resolved + versioned, like a schedule
   * change). The flag survives re-resolution because
   * resolveNode parses it; a definition that never carried it
   * resolves it absent.
   */
  private async applyNodeRetired(jobId: string, nodePath: string): Promise<JobDefinition> {
    const existing = await this.requireDefinition(jobId);
    const raw = JSON.parse(JSON.stringify(existing.rawConfig ?? {})) as Record<string, unknown>;
    if (!isRecord(raw.root)) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Job "${jobId}" has no stored root node to retire a stage on.`,
      );
    }
    let node: Record<string, unknown> = raw.root;
    for (const segment of pathSegments(nodePath)) {
      const children = node.children;
      if (!Array.isArray(children) || !isRecord(children[segment])) {
        throw new JobPipelineError(
          "job_config_invalid",
          `Scope path "${nodePath}" does not resolve in job "${jobId}"'s stored configuration.`,
        );
      }
      node = children[segment] as Record<string, unknown>;
    }
    node.retired = true;
    return this.saveResolved(jobId, raw);
  }

  /** Persist one node's schedule configuration into the job's stored raw definition (re-resolved + versioned). */
  private async applyNodeSchedule(
    jobId: string,
    nodePath: string,
    schedule: JobScheduleConfig,
  ): Promise<JobDefinition> {
    const existing = await this.requireDefinition(jobId);
    const raw = JSON.parse(JSON.stringify(existing.rawConfig ?? {})) as Record<string, unknown>;
    if (!isRecord(raw.root)) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Job "${jobId}" has no stored root node to schedule a stage on.`,
      );
    }
    let node: Record<string, unknown> = raw.root;
    for (const segment of pathSegments(nodePath)) {
      const children = node.children;
      if (!Array.isArray(children) || !isRecord(children[segment])) {
        throw new JobPipelineError(
          "job_config_invalid",
          `Scope path "${nodePath}" does not resolve in job "${jobId}"'s stored configuration.`,
        );
      }
      node = children[segment] as Record<string, unknown>;
    }
    node.schedule = { ...schedule };
    return this.saveResolved(jobId, raw);
  }

  /**
   * Execute one stage action (run / re-run) inline: the stage
   * executes under the runner's decisions against the current
   * run's checkpoint; the job's instance state is restored to
   * the run's recorded state afterwards (a stage action is not
   * a new run — the run's history is untouched).
   */
  private async executeStageAction(
    definition: JobDefinition,
    instance: JobInstanceRecord,
    nodePath: string,
    force: boolean,
  ): Promise<JobDispatchResult> {
    const jobId = definition.jobId;
    const runId = instance.currentRunId!;
    const priorState = instance.state;
    const priorCheckpoint = instance.checkpoint;
    const node = this.nodeAtPath(definition.root, nodePath);
    const input = await this.stageInput(definition, runId, nodePath);
    const running: JobInstanceRecord = {
      ...instance,
      state: "running",
      desiredState: "none",
      lastError: null,
    };
    await this.setInstance(running);
    const ctx = await this.buildContext(definition, {
      runId,
      // Issue #4767 — a stage action is not a new run: it
      // executes under the current run's trigger (Q5).
      trigger: normalizeJobRunTrigger(running.runTrigger),
      kind: normalizeJobRunKind(running.runKind),
      scopePath: "",
      resuming: true,
      instance: running,
      forceStage: force ? nodePath : null,
    });
    try {
      await this.execNode(ctx, node, nodePath, input);
      const settled = await this.requireInstance(jobId);
      await this.setInstance({ ...settled, state: priorState, checkpoint: priorCheckpoint });
      return { jobId, runId, state: "completed" };
    } catch (error) {
      const settled = await this.requireInstance(jobId);
      if (error instanceof RunStopped) {
        await this.setInstance({
          ...settled,
          state: error.reason === "paused" ? "paused" : priorState,
          ...(error.reason === "cancelled" ? { checkpoint: priorCheckpoint } : {}),
        });
        return { jobId, runId, state: error.reason };
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.setInstance({
        ...settled,
        state: priorState,
        checkpoint: priorCheckpoint,
        lastError: message,
      });
      return { jobId, runId, state: "failed" };
    }
  }

  /** Per-stage states for the status view, from the instance's stage checkpoint. */
  private stageViews(
    definition: JobDefinition,
    instance: JobInstanceRecord | null,
  ): JobStageView[] {
    return projectStageViews(definition, instance);
  }

  // ---- execution ----------------------------------------------------------

  private freshInstance(jobId: string): JobInstanceRecord {
    return {
      jobId,
      state: "idle",
      desiredState: "none",
      currentRunId: null,
      runStartedAt: null,
      runTrigger: null,
      runKind: null,
      runOriginId: null,
      runDefinitionVersion: null,
      runProvenance: null,
      runScheduleId: null,
      runAsyncJobId: null,
      runWorkflowInstanceId: null,
      checkpoint: null,
      stageCheckpoint: null,
      stageDesired: null,
      lastError: null,
      updatedAt: this.iso(),
    };
  }

  private async requireDefinition(jobId: string): Promise<JobDefinition> {
    const definition = await this.deps.stores.definitions.getDefinition(jobId);
    if (!definition) {
      throw new JobPipelineError("job_not_found", `No job defined with id "${jobId}".`);
    }
    return definition;
  }

  private async requireInstance(jobId: string): Promise<JobInstanceRecord> {
    const instance = await this.deps.stores.instances.getInstance(jobId);
    if (instance) return instance;
    await this.requireDefinition(jobId);
    const fresh = this.freshInstance(jobId);
    await this.deps.stores.instances.saveInstance(fresh);
    return fresh;
  }

  /**
   * Issue #6555 — load the instance row a run executes against.
   * Null key: the job's management row (single mode). A key:
   * the run's own row, created fresh when the dispatch is the
   * row's first — a re-dispatch after terminal reuses the row,
   * re-stamped by executeRun's start.
   */
  private async requireRunInstance(
    jobId: string,
    runKey: string | null,
  ): Promise<JobInstanceRecord> {
    if (!runKey) return this.requireInstance(jobId);
    const existing = await this.deps.stores.instances.getInstance(jobId, runKey);
    if (existing) return existing;
    const fresh: JobInstanceRecord = {
      ...this.freshInstance(jobId),
      instanceScope: "run",
      runKey,
    };
    await this.deps.stores.instances.saveInstance(fresh);
    return fresh;
  }

  private async setInstance(instance: JobInstanceRecord): Promise<void> {
    await this.deps.stores.instances.saveInstance({ ...instance, updatedAt: this.iso() });
  }

  /**
   * Issue #6028 — write one terminal row per executed stage to the stage
   * store. Best-effort by contract, the same rule the settle observer
   * follows: a store failure never fails, retries or duplicates the run;
   * it is logged, never swallowed.
   */
  private async writeStageRows(
    instance: JobInstanceRecord,
    definition: JobDefinition | null,
  ): Promise<void> {
    const stageEventStore = this.deps.stageEvents;
    const runId = instance.currentRunId;
    if (!stageEventStore || !runId) return;
    const rows = stageTerminalRows({
      runId,
      jobId: instance.jobId,
      definition,
      instance,
      at: this.iso(),
      definitionVersion: instance.runDefinitionVersion ?? null,
    });
    for (const row of rows) {
      try {
        await stageEventStore.record(row);
      } catch (error) {
        structuredLog.warn("jobPipeline.stage_row_write_failed", {
          jobId: instance.jobId,
          runId,
          stageId: row.stageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async recordTerminal(
    instance: JobInstanceRecord,
    outcome: "completed" | "failed" | "cancelled",
    error: string | undefined,
    descriptor?: string,
    artifactRefs?: string[],
  ): Promise<void> {
    if (!instance.currentRunId || !instance.runStartedAt) return;
    const definition = await this.deps.stores.definitions.getDefinition(instance.jobId);
    const record = buildJobRunRecord({
      system: "job-pipeline",
      jobId: instance.jobId,
      operation: definition?.root.kind ?? "job",
      started: instance.runStartedAt,
      finished: this.iso(),
      outcome:
        outcome === "completed" ? "success" : outcome === "failed" ? "failure" : "skipped",
      triggeredBy: normalizeJobRunTrigger(instance.runTrigger),
      // Issue #4767 — the terminal record stamps the run's kind
      // and origin link from the instance (a first dispatch reads
      // "original" with no origin; a retry reads "re-run" + the
      // run it retried).
      kind: normalizeJobRunKind(instance.runKind),
      originRunId: instance.runOriginId ?? null,
      definitionVersion: instance.runDefinitionVersion ?? null,
      // Issue #6557 — the four #3655 provenance fields, from the instance
      // carrier (stamped at dispatch from the firing schedule payload).
      // Explicit nulls on every other dispatch: a manual, retried or
      // replayed run never infers them.
      brokerId: instance.runProvenance?.brokerId ?? null,
      dataProviderId: instance.runProvenance?.dataProviderId ?? null,
      mode: instance.runProvenance?.mode ?? null,
      modeSource: instance.runProvenance?.modeSource ?? null,
      // Issue #3310 — the terminal record joins to the dispatching
      // schedule and to the workflow instance (the pipeline run IS
      // the workflow instance on the direct-execution firing path).
      // Issue #4357 — the join key: the async job id that dispatched
      // this run, so the record links to its bridge row; null means
      // no async job dispatched this run, never a laundered id.
      scheduleId: instance.runScheduleId ?? null,
      asyncJobId: instance.runAsyncJobId ?? null,
      workflowId: instance.currentRunId,
      ...(outcome === "failed" ? { error: error ?? "job run failed" } : {}),
      ...(outcome === "cancelled" ? { detail: "job_cancelled" } : {}),
      ...(descriptor !== undefined ? { descriptor } : {}),
      ...(artifactRefs !== undefined ? { artifactRefs } : {}),
    });
    await this.deps.runRecorder.recordRun(record);
    // Issue #6028 — the stage rows ride the engine's one terminal-
    // recording point, so every trigger class (manual, scheduled,
    // resume, retry, cancel) is covered by construction.
    await this.writeStageRows(instance, definition ?? null);
    // #3530 slice B: the settle observer fires here — downstream
    // of the no-run guard above, so it observes exactly the runs
    // that settled, exactly once each. Guarded: an observer
    // failure never fails or retries the settled run.
    const observer = this.deps.runSettledObserver;
    if (observer) {
      try {
        await observer({
          jobId: instance.jobId,
          runId: instance.currentRunId,
          trigger: normalizeJobRunTrigger(instance.runTrigger),
          state: outcome,
          ...(error ? { error } : {}),
          // Issue #4767 — the settle observer names the settled
          // run's kind and origin link alongside its trigger.
          kind: normalizeJobRunKind(instance.runKind),
          originRunId: instance.runOriginId ?? null,
        });
      } catch {
        // Best-effort by contract (see JobPipelineDeps): the
        // observers log their own failures with the run's ids.
      }
    }
  }

  /** Build the run context: the ledger is read through the StageCheckpointStore (resumes), or started empty. */
  private async buildContext(
    definition: JobDefinition,
    opts: {
      runId: string;
      trigger: JobRunTrigger;
      kind: JobRunKind;
      scopePath: string;
      resuming: boolean;
      instance: JobInstanceRecord;
      forceStage: string | null;
      /** Issue #4775 S1 — the run bound the stage deadlines clamp to; absent when none applies. */
      runDeadlineMs?: number;
      /**
       * Issue #6555 — the run's own instance row in run-per-row
       * mode (its dedup key); absent in single mode, where the
       * stage checkpoint binds to the job's management row.
       */
      runKey?: string | null;
    },
  ): Promise<RunContext> {
    const checkpoints = createJobPipelineStageCheckpointStore(
      this.deps.stores.instances,
      definition.jobId,
      opts.runKey ?? null,
    );
    // Issue #4767 (Q6) — the ledger carries the run's trigger and
    // kind. A fresh run stamps both; a resumed run restamps the
    // kind to the current execution's kind and fills a legacy
    // trigger from the run (the guard in executeRun already
    // proved a present trigger matches the run's).
    const stored = opts.resuming
      ? await checkpoints.read(opts.runId)
      : null;
    const ledger: StageRunnerCheckpoint = stored
      ? {
          ...stored,
          trigger: stored.trigger ?? opts.trigger,
          kind: opts.kind,
        }
      : { runId: opts.runId, trigger: opts.trigger, kind: opts.kind, units: [] };
    return {
      deps: this.deps,
      definition,
      jobId: definition.jobId,
      runId: opts.runId,
      trigger: opts.trigger,
      kind: opts.kind,
      rootConfig: definition.config,
      scopePath: opts.scopePath,
      runDeadlineMs: opts.runDeadlineMs,
      resuming: opts.resuming,
      ledger,
      checkpoints,
      memory: new Map(),
      artifactKeys: opts.resuming ? [...(opts.instance.checkpoint?.artifactKeys ?? [])] : [],
      stepsSinceCheckpoint: 0,
      currentGranularity: definition.config.processing.checkpointEverySteps,
      stepExecutions: 0,
      activeUnits: new Map(),
      notes: [],
      lastLegError: null,
      legTimings: [],
      runStartedAtMs: Date.now(),
      executionBudgetMs: undefined,
      budgetExhausted: false,
      forceStage: opts.forceStage,
    };
  }

  private async executeRun(
    definition: JobDefinition,
    opts: {
      runId: string;
      trigger: JobRunTrigger;
      kind: JobRunKind;
      originRunId: string | null;
      scopePath: string;
      scheduleId: string | null;
      asyncJobId: string | null;
      workflowInstanceId: string | null;
      /**
       * Issue #6557 — the dispatch's provenance carrier. Read only on a
       * fresh dispatch; a resume keeps the instance's own (the payload
       * that fired the run is still the run's fact).
       */
      provenance?: JobRunProvenance | null;
      resuming: boolean;
      /**
       * Issue #6555 — the run's own instance row in run-per-row
       * mode (the submission's dedup key); null in single mode,
       * where the run uses the job's management row.
       */
      runInstanceKey: string | null;
      /**
       * Issue #6400 — a stage replay's two narrowing values: the input the
       * past run handed the stage, and whether the run executes ONLY that
       * stage (its downstream children detached). Absent on every ordinary
       * dispatch, so the shared tail behaves exactly as before.
       */
      input?: unknown;
      stageOnly?: boolean;
    },
  ): Promise<JobRunOutcome> {
    const { publisher } = this.deps;
    const jobId = definition.jobId;
    const startedAt = this.iso();
    let instance = await this.requireRunInstance(jobId, opts.runInstanceKey);
    // Issue #4767 (Q6) — the resume guard: a resuming run refuses
    // a stage checkpoint stamped under a different trigger than
    // the run's own. A checkpoint belongs to exactly one
    // execution's trigger lineage; resuming under the wrong
    // trigger would silently restamp it. A checkpoint with no
    // trigger (stored before #4767) is legacy, not a mismatch —
    // it is restamped from the run below. Checked BEFORE the
    // instance stamp, so a refusal leaves the instance untouched.
    if (opts.resuming && instance.stageCheckpoint?.trigger !== undefined) {
      const storedTrigger = normalizeJobRunTrigger(
        instance.stageCheckpoint.trigger,
      );
      if (storedTrigger !== opts.trigger) {
        throw new JobPipelineError(
          "job_checkpoint_trigger_mismatch",
          `Job "${jobId}" run ${opts.runId} cannot resume: its stage checkpoint was stamped under trigger "${storedTrigger}" but the run's trigger is "${opts.trigger}". Refusing rather than resuming under the wrong trigger.`,
        );
      }
    }
    instance = {
      ...instance,
      state: "queued",
      desiredState: "none",
      currentRunId: opts.runId,
      runStartedAt: opts.resuming ? (instance.runStartedAt ?? startedAt) : startedAt,
      runTrigger: opts.trigger,
      // Issue #4767 — the run kind and origin link, stamped on
      // the instance so the terminal record (and any settle path)
      // stamps the run they settle.
      runKind: opts.kind,
      runOriginId: opts.originRunId,
      // Issue #5887 — the definition version this run executes, captured
      // from the definition the engine just resolved. Settle reads the
      // instance, never the current pointer: a reconfigure during the run
      // must not change what the run records it used.
      runDefinitionVersion: definition.version,
      // Issue #6557 — the payload provenance rides the instance from
      // dispatch to settle. A resume keeps the run's own provenance: the
      // firing payload is still the fact of the run it fired, and a
      // resume never re-fires anything.
      runProvenance: opts.resuming ? instance.runProvenance ?? null : opts.provenance ?? null,
      runScheduleId: opts.scheduleId,
      // Issue #4357 — the join key: the async job that dispatched
      // this run, persisted on the instance so the terminal record
      // (and any settle path) stamps it.
      runAsyncJobId: opts.asyncJobId,
      // Issue #4454 — the replay proof: the workflow instance
      // that dispatched this run, persisted on the instance so
      // a replayed flow can prove it dispatched the run it
      // resumes. Null for a non-workflow dispatch; a resume
      // clears it (a new executor).
      runWorkflowInstanceId: opts.workflowInstanceId,
      // Issue #4767 (Q6) — the checkpoint carries the run's
      // trigger and kind. A fresh run stamps both; a resumed run
      // restamps the kind to the current execution's kind (a
      // resume IS a resume now) and fills a legacy trigger from
      // the run — the trigger itself never changes across a
      // resume (the guard above proved it).
      stageCheckpoint: opts.resuming
        ? instance.stageCheckpoint
          ? {
              ...instance.stageCheckpoint,
              trigger: instance.stageCheckpoint.trigger ?? opts.trigger,
              kind: opts.kind,
            }
          : { runId: opts.runId, trigger: opts.trigger, kind: opts.kind, units: [] }
        : { runId: opts.runId, trigger: opts.trigger, kind: opts.kind, units: [] },
      stageDesired: opts.resuming ? instance.stageDesired : null,
      lastError: null,
    };
    await this.setInstance(instance);
    await publishJobStatus(publisher, { jobId, runId: opts.runId, state: "queued", at: this.iso() });
    instance = { ...instance, state: "running" };
    await this.setInstance(instance);
    await publishJobStatus(publisher, { jobId, runId: opts.runId, state: "running", at: this.iso() });

    // Issue #4775 S1 (Decision 1) — the run bound the stage
    // deadlines clamp to: a feed job's whole-execution deadline;
    // a non-feed job has no run deadline, so its stages carry
    // their own timeout alone. Resolved once here so the race
    // below and the stage compilation agree on the bound.
    const runDeadlineMs = jobTreeInvokesStep(definition.root, FEED_PULL_STEP_NAME)
      ? resolveFeedExecutionDeadlineMs(this.deps.feedExecutionDeadlineMs)
      : undefined;
    const ctx = await this.buildContext(definition, {
      runId: opts.runId,
      trigger: opts.trigger,
      kind: opts.kind,
      scopePath: opts.scopePath,
      resuming: opts.resuming,
      instance,
      forceStage: null,
      runDeadlineMs,
      // Issue #6555 — the stage checkpoint binds to this run's
      // own instance row in run-per-row mode.
      runKey: opts.runInstanceKey,
    });
    if (!opts.resuming) await this.persistLedger(ctx);
    // Issue #6678 — the execution budget the legs compose
    // against: the same resolved bound the race below enforces,
    // stamped on the real clock so attempt timings and the
    // retry gate share one budget instead of each leg silently
    // spending against its own bound.
    ctx.executionBudgetMs = runDeadlineMs;
    ctx.runStartedAtMs = Date.now();

    try {
      const scoped = this.nodeAtPath(definition.root, opts.scopePath);
      // Issue #6400 — a stage replay executes ONE stage: the named node's
      // own work, with its downstream children detached. replayStage
      // refuses a composite by name, so this detach is the backstop that
      // keeps "one stage" true even for a definition that grew children
      // after the past run.
      const scopeNode = opts.stageOnly
        ? { ...scoped, children: undefined }
        : scoped;
      // #3992 PR-4: a feed job's whole execution tree is bounded
      // by the resolved feed execution deadline. The race covers
      // ONLY this await — instance setup above and the terminal
      // writes below stay outside it. The rejection abandons the
      // execution (abandon-not-abort, the withFeedDeadline
      // idiom): the tree may keep running in the host, but the
      // run is terminally settled by the catch below, and the
      // zombie's late writes go through the step journal and the
      // run's own stores — never through this run's terminal
      // path — so the settled outcome cannot flip. Non-feed jobs
      // execute exactly as before.
      const execution = this.execNode(
        ctx,
        scopeNode,
        opts.scopePath,
        opts.input ?? null,
      );
      if (runDeadlineMs !== undefined) {
        await withFeedDeadline(
          execution,
          runDeadlineMs,
          FEED_JOB_CODES.deadlineExceeded,
        );
      } else {
        await execution;
      }
      instance = await this.requireRunInstance(jobId, opts.runInstanceKey);
      // Issue #6400 — a stage replay's descriptor names the replayed stage
      // and the run it came from: the record carries the origin link at
      // stage granularity, in the field the Workflow Runs view already
      // reads (no new column).
      const descriptor =
        (opts.stageOnly
          ? `replay of ${jobStageId(opts.scopePath)} from run ${opts.originRunId ?? opts.runId}: `
          : `run ${opts.runId}: `) +
        `${ctx.stepExecutions} step executions, ${ctx.artifactKeys.length} artifacts` +
        (ctx.notes.length > 0 ? `; ${ctx.notes.join("; ")}` : "");
      instance = { ...instance, state: "completed", desiredState: "none", checkpoint: null };
      await this.setInstance(instance);
      await publishJobStatus(publisher, {
        jobId,
        runId: opts.runId,
        state: "completed",
        at: this.iso(),
        artifactKeys: [...ctx.artifactKeys],
      });
      await this.recordTerminal(instance, "completed", undefined, descriptor, [
        ...ctx.artifactKeys,
      ]);
      return {
        jobId,
        runId: opts.runId,
        state: "completed",
        descriptor,
        artifactKeys: [...ctx.artifactKeys],
      };
    } catch (error) {
      instance = await this.requireRunInstance(jobId, opts.runInstanceKey);
      if (error instanceof RunStopped && error.reason === "paused") {
        // The boundary that stopped already persisted the checkpoint + paused state.
        return { jobId, runId: opts.runId, state: "paused", artifactKeys: [...ctx.artifactKeys] };
      }
      if (error instanceof RunStopped && error.reason === "cancelled") {
        // Surface the cancellation per stage: every outstanding
        // unit of the run is recorded cancelled, never vanished.
        // A retired stage names itself instead, and its own
        // units stay "retired" — the sweep below never
        // overwrites them; only the run's other outstanding
        // units are recorded cancelled.
        if (error instanceof StageRetired && !ctx.notes.includes(`stage retired: ${error.stageId}`)) {
          ctx.notes.push(`stage retired: ${error.stageId}`);
        }
        if (error instanceof StageCancelled && !ctx.notes.includes(`stage cancelled: ${error.stageId}`)) {
          ctx.notes.push(`stage cancelled: ${error.stageId}`);
        }
        for (const unit of ctx.ledger.units) {
          if (unit.status !== "completed" && unit.status !== "cancelled" && unit.status !== "skipped" && unit.status !== "retired") {
            this.setEntry(ctx, { ...unit, status: "cancelled", endedAt: this.iso(), updatedAt: this.iso() });
          }
        }
        await this.persistLedger(ctx);
        instance = { ...instance, state: "cancelled", desiredState: "none", stageDesired: null };
        await this.setInstance(instance);
        await publishJobStatus(publisher, {
          jobId,
          runId: opts.runId,
          state: "cancelled",
          at: this.iso(),
        });
        await this.recordTerminal(instance, "cancelled", undefined);
        return {
          jobId,
          runId: opts.runId,
          state: "cancelled",
          artifactKeys: [...ctx.artifactKeys],
        };
      }
      // #3992 PR-4: a feed execution that exceeded its whole-run
      // deadline arrives here as a FeedJobTimeoutError whose
      // code is FEED_JOB_CODES.deadlineExceeded, and settles
      // EXACTLY like any other failure — same instance state,
      // same publication, same terminal record — by design: no
      // separate settle path exists for it to diverge through.
      // Its message carries the FEED_DEADLINE_EXCEEDED code, so
      // the run record, the instance's lastError, and the panel
      // name the deadline rather than a generic failure.
      // Issue #6278: the deadline message alone names no leg, so
      // when a leg error was recorded while the unit retried it
      // is appended (codedError + attempt) — the terminal record
      // stays diagnosable from the production error. A
      // non-deadline failure is untouched: its own message
      // already is the leg error.
      const message = error instanceof Error ? error.message : String(error);
      // Issue #6678 — the deadline terminal error names the
      // legs that consumed the budget: every recorded attempt
      // with its elapsed time (in-flight legs measured to now),
      // plus the budget-exhaustion naming when the retry gate
      // stopped the run. A slow leg that never failed an
      // attempt is named here even though lastLegError is null.
      const legSummary =
        error instanceof FeedJobTimeoutError &&
        error.code === FEED_JOB_CODES.deadlineExceeded &&
        ctx.legTimings.length > 0
          ? ` Leg timings: ${ctx.legTimings
              .map(
                (leg) =>
                  `${leg.stageId} attempt ${leg.attempt}: ${Math.max(0, (leg.endedAtMs ?? Date.now()) - leg.startedAtMs)}ms (${leg.outcome})`,
              )
              .join("; ")}.${
              ctx.budgetExhausted && ctx.executionBudgetMs !== undefined
                ? ` The execution budget of ${ctx.executionBudgetMs}ms was consumed by cumulative legs; no further attempt was started.`
                : ""
            }`
          : "";
      const terminalMessage =
        error instanceof FeedJobTimeoutError &&
        error.code === FEED_JOB_CODES.deadlineExceeded &&
        ctx.lastLegError !== null
          ? `${message} Last leg error (attempt ${ctx.lastLegError.attempt}): ${ctx.lastLegError.message}${legSummary}`
          : `${message}${legSummary}`;
      instance = { ...instance, state: "failed", desiredState: "none", lastError: terminalMessage };
      await this.setInstance(instance);
      await publishJobStatus(publisher, {
        jobId,
        runId: opts.runId,
        state: "failed",
        at: this.iso(),
        detail: terminalMessage,
      });
      await this.recordTerminal(instance, "failed", terminalMessage);
      return {
        jobId,
        runId: opts.runId,
        state: "failed",
        error: terminalMessage,
        artifactKeys: [...ctx.artifactKeys],
      };
    }
  }

  private nodeAtPath(root: JobNodeConfig, path: string): JobNodeConfig {
    let node = root;
    for (const segment of pathSegments(path)) {
      const next = (node.children ?? [])[segment];
      if (!next) {
        throw new JobPipelineError(
          "job_config_invalid",
          `Scope path "${path}" does not resolve in the job's node tree.`,
        );
      }
      node = next;
    }
    return node;
  }

  private async readArtifact(
    ctx: RunContext,
    key: string,
    inMemory: boolean,
  ): Promise<unknown> {
    if (inMemory) return ctx.memory.has(key) ? ctx.memory.get(key) : null;
    return this.deps.stores.artifacts.getArtifact(ctx.runId, key);
  }

  private async artifactExists(
    ctx: RunContext,
    key: string,
    inMemory: boolean,
  ): Promise<boolean> {
    if (inMemory) return ctx.memory.has(key);
    const keys = await this.deps.stores.artifacts.listArtifactKeys(ctx.runId);
    return keys.includes(key);
  }

  private async writeArtifact(
    ctx: RunContext,
    key: string,
    value: unknown,
    inMemory: boolean,
  ): Promise<void> {
    if (inMemory) {
      ctx.memory.set(key, value);
      return;
    }
    await this.deps.stores.artifacts.putArtifact(ctx.runId, key, value);
    if (!ctx.artifactKeys.includes(key)) ctx.artifactKeys.push(key);
  }

  // ---- the stage-runner ledger -------------------------------------------

  private entryFor(
    ledger: StageRunnerCheckpoint,
    stageId: string,
    unitId: string,
  ): StageUnitCheckpoint | undefined {
    return ledger.units.find((u) => u.stage === stageId && u.unitId === unitId);
  }

  /** Replace-or-add one entry, mutating the ledger in place (parallel units share it safely). */
  private setEntry(ctx: RunContext, entry: StageUnitCheckpoint): void {
    const index = ctx.ledger.units.findIndex(
      (u) => u.stage === entry.stage && u.unitId === entry.unitId,
    );
    if (index >= 0) ctx.ledger.units[index] = entry;
    else ctx.ledger.units.push(entry);
  }

  /** Persist the ledger through the StageCheckpointStore (a snapshot — later mutations never alias it). */
  /**
   * Issue #4360 — the latest recorded end across a stage's units, or now
   * when none is recorded. The stage-level control events (cancelled /
   * retired) carry it as `endedAt`, so they stay in the same vocabulary
   * as the unit transitions.
   */
  private stageEndedAt(ctx: RunContext, stageId: string): string {
    const ends = ctx.ledger.units
      .filter((unit) => unit.stage === stageId && typeof unit.endedAt === "string")
      .map((unit) => unit.endedAt as string)
      .sort();
    return ends[ends.length - 1] ?? this.iso();
  }

  private async persistLedger(ctx: RunContext): Promise<void> {
    // Issue #4767 (Q6) — the checkpoint write carries the run's
    // trigger and kind with the units; the store persists the
    // whole checkpoint object, so no adapter change is needed.
    await ctx.checkpoints.write({
      runId: ctx.runId,
      trigger: ctx.trigger,
      kind: ctx.kind,
      units: ctx.ledger.units.map((u) => ({ ...u })),
    });
  }

  /** Compile one node to its stage-runner stage. */
  private stageForNode(
    node: JobNodeConfig,
    path: string,
    mode: JobExecutionMode,
    runDeadlineMs?: number,
  ): StageRunnerStage {
    const kind = node.kind as PipelineStage;
    // Issue #4781 S2 — the node's own fan-out cap and retry bucket
    // win; absent, the contract's defaults apply (stageMaxParallel
    // → 4; stageRetryBucket → the table / "report"). An invalid
    // value that somehow reaches the engine is refused by name —
    // never silently the default, and never a mid-run TypeError on
    // budget.maxAttempts. A cap on a sequential node is inert, not
    // an error (the runner returns 1 for sequential stages).
    if (
      node.maxParallel !== undefined &&
      (typeof node.maxParallel !== "number" ||
        !Number.isInteger(node.maxParallel) ||
        node.maxParallel < 1)
    ) {
      throw new Error(
        `Stage "${path}" maxParallel ${String(node.maxParallel)} must be a positive integer.`,
      );
    }
    if (node.retryBucket !== undefined && !isRetryBucketName(node.retryBucket)) {
      throw new Error(
        `Stage "${path}" retryBucket ${JSON.stringify(node.retryBucket)} is invalid — a stage retries under one of: ${RETRY_BUCKET_NAMES.join(", ")}.`,
      );
    }
    // Kinds naming a chain stage retry under that stage's bucket
    // (the contract's own tables); any other kind takes the
    // contract's job-stage default ("report"). The node's own
    // bucket wins over both.
    const retryBucket =
      node.retryBucket ??
      ((["feed", "generate", "store", "serve", "deliver"] as const).includes(kind)
        ? STAGE_RETRY_BUCKET[runnerStageForPipelineStage(kind)]
        : undefined);
    return {
      stage: jobStageId(path),
      execution: mode.concurrency,
      // Issue #4775 S1 — the effective stage deadline: the node's
      // own timeoutMs, else the env-resolved global default,
      // clamped to the run deadline whenever one applies (a stage
      // unit can never outlive its run). A run without a deadline
      // passes no bound, so the stage timeout stands alone.
      timeoutMs: resolveStageTimeoutMsForNode(node, this.stageDefaultMs(), runDeadlineMs),
      pacing: mode.pacing,
      ...(node.maxParallel !== undefined ? { maxParallel: node.maxParallel } : {}),
      ...(retryBucket ? { retryBucket } : {}),
    };
  }

  /**
   * Issue #4775 S1 (Decision 2) — the env-resolved global stage
   * default: a positive finite injected value (the host's
   * resolveStageTimeoutMs(env)) wins; absent / non-positive /
   * non-finite falls back to the recorded 600s default, so hosts
   * that never set this are bounded by default.
   */
  private stageDefaultMs(): number {
    const injected = this.deps.stageTimeoutMs;
    return typeof injected === "number" && Number.isFinite(injected) && injected > 0
      ? injected
      : resolveStageTimeoutMs({});
  }

  private async clearStageDesired(jobId: string, stageId: string): Promise<void> {
    const instance = await this.requireInstance(jobId);
    if (!instance.stageDesired || !(stageId in instance.stageDesired)) return;
    const stageDesired = { ...instance.stageDesired };
    delete stageDesired[stageId];
    await this.deps.stores.instances.saveInstance({
      ...instance,
      stageDesired: Object.keys(stageDesired).length > 0 ? stageDesired : null,
      updatedAt: this.iso(),
    });
  }

  /**
   * Record a retired stage's units before it runs (#3944):
   * every planned unit is "retired" (never executed), the
   * ledger persists, the transition publishes — then the run
   * settles cancelled with the stage named. Shared by the
   * live-request path (honorStageControl) and the
   * definition-level backstop (execNode).
   */
  private async retireUnitsBeforeRun(
    ctx: RunContext,
    plan: StageRunnerPlan,
    stageId: StageRunnerStageId,
  ): Promise<never> {
    const units = plan.units.length > 0 ? plan.units : [{ unitId: ctx.runId }];
    for (const unit of units) {
      const prior = this.entryFor(ctx.ledger, stageId, unit.unitId);
      this.setEntry(ctx, {
        stage: stageId,
        unitId: unit.unitId,
        status: "retired",
        attempt: prior?.attempt ?? 0,
        // Issue #4359 — retired before it ran: a real terminal instant,
        // no start stamp (the unit never started).
        endedAt: this.iso(),
        updatedAt: this.iso(),
      });
    }
    await this.persistLedger(ctx);
    const retiredAt = this.stageEndedAt(ctx, stageId);
    await publishStageAction(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      stageId,
      action: "retired",
      at: retiredAt,
      endedAt: retiredAt,
      detail: "stage retired before it ran",
    });
    throw new StageRetired(stageId);
  }

  /**
   * Honor a stage control request recorded for a stage that has
   * not started yet (the driver reaching it IS the boundary):
   * stop marks its units stopped and stops the run there;
   * cancel marks them cancelled and cancels the run — the
   * stage never executes, and its downstream never proceeds.
   */
  private async honorStageControl(
    ctx: RunContext,
    plan: StageRunnerPlan,
    path: string,
  ): Promise<void> {
    const stageId = plan.stages[0].stage;
    const instance = await this.requireInstance(ctx.jobId);
    const action = instance.stageDesired?.[stageId];
    if (!action) return;
    await this.clearStageDesired(ctx.jobId, stageId);
    const units = plan.units.length > 0 ? plan.units : [{ unitId: plan.runId }];
    if (action === "cancel") {
      for (const unit of units) {
        const prior = this.entryFor(ctx.ledger, stageId, unit.unitId);
        this.setEntry(ctx, {
          stage: stageId,
          unitId: unit.unitId,
          status: "cancelled",
          attempt: prior?.attempt ?? 0,
          // Issue #4359 — cancelled before it ran: terminal, never started.
          endedAt: this.iso(),
          updatedAt: this.iso(),
        });
      }
      await this.persistLedger(ctx);
      const cancelledAt = this.stageEndedAt(ctx, stageId);
      await publishStageAction(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        stageId,
        action: "cancelled",
        at: cancelledAt,
        endedAt: cancelledAt,
        detail: "stage cancelled before it ran",
      });
      throw new StageCancelled(stageId);
    }
    if (action === "retire") {
      await this.retireUnitsBeforeRun(ctx, plan, stageId);
    }
    for (const unit of units) {
      const prior = this.entryFor(ctx.ledger, stageId, unit.unitId);
      this.setEntry(ctx, {
        stage: stageId,
        unitId: unit.unitId,
        status: "stopped",
        attempt: prior?.attempt ?? 0,
        // Issue #4359 — stopped is resumable, not terminal: keep the
        // start (when it started) and leave the end open.
        ...(prior?.startedAt ? { startedAt: prior.startedAt } : {}),
        updatedAt: this.iso(),
      });
    }
    await this.persistLedger(ctx);
    const fresh = await this.requireInstance(ctx.jobId);
    await this.setInstance({
      ...fresh,
      state: "paused",
      desiredState: "none",
      checkpoint: {
        runId: ctx.runId,
        nodePath: path,
        scopePath: ctx.scopePath,
        stepIndex: 0,
        itemIndex: 0,
        shardIndex: 0,
        childIndex: 0,
        artifactKeys: [...ctx.artifactKeys],
        updatedAt: this.iso(),
      },
    });
    await publishJobStatus(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      state: "paused",
      at: this.iso(),
      detail: stageId,
    });
    await publishStageAction(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      stageId,
      action: "stopped",
      at: this.iso(),
      detail: "stage stopped before it ran",
    });
    throw new RunStopped("paused");
  }

  /**
   * A step boundary: honor pause/cancel requests (run-level on
   * the instance, per-stage in stageDesired), persist the
   * ledger (with the in-flight unit's progress) and the resume
   * cursor when a checkpoint is due (every `countAsStep`
   * completions at the configured granularity, or whenever a
   * stop is honored).
   */
  private async boundary(
    ctx: RunContext,
    cursor: Omit<JobCheckpoint, "runId" | "scopePath" | "artifactKeys" | "updatedAt"> & {
      unitId?: string | null;
    },
    countAsStep: boolean,
  ): Promise<void> {
    const instance = await this.requireInstance(ctx.jobId);
    const cursorStageId = jobStageId(cursor.nodePath);
    const activeStageIds = new Set([...ctx.activeUnits.values()].map((a) => a.stageId));

    // Cancellation first: run-level, or a stage-level cancel for
    // the cursor's stage or any in-flight stage.
    const cancelStageId =
      instance.desiredState === "cancel"
        ? cursorStageId
        : [cursorStageId, ...activeStageIds].find(
            (s) => instance.stageDesired?.[s] === "cancel",
          );
    if (cancelStageId) {
      for (const active of ctx.activeUnits.values()) {
        if (active.stageId !== cancelStageId) continue;
        const prior = this.entryFor(ctx.ledger, active.stageId, active.unitId);
        if (prior) {
          this.setEntry(ctx, { ...prior, status: "cancelled", endedAt: this.iso(), updatedAt: this.iso() });
        }
      }
      await this.persistLedger(ctx);
      if (instance.desiredState !== "cancel") {
        await this.clearStageDesired(ctx.jobId, cancelStageId);
      }
      const cancelledAt = this.stageEndedAt(ctx, cancelStageId);
      await publishStageAction(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        stageId: cancelStageId,
        action: "cancelled",
        at: cancelledAt,
        endedAt: cancelledAt,
      });
      throw new StageCancelled(cancelStageId);
    }

    // Retirement next: a stage-level retire for the cursor's
    // stage or any in-flight stage settles the run the same
    // way a cancel does — the stage's units are "retired",
    // never executed, and downstream never proceeds.
    const retireStageId = [cursorStageId, ...activeStageIds].find(
      (s) => instance.stageDesired?.[s] === "retire",
    );
    if (retireStageId) {
      for (const active of ctx.activeUnits.values()) {
        if (active.stageId !== retireStageId) continue;
        const prior = this.entryFor(ctx.ledger, active.stageId, active.unitId);
        if (prior) {
          this.setEntry(ctx, { ...prior, status: "retired", endedAt: this.iso(), updatedAt: this.iso() });
        }
      }
      await this.persistLedger(ctx);
      await this.clearStageDesired(ctx.jobId, retireStageId);
      await publishStageAction(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        stageId: retireStageId,
        action: "retired",
        at: this.iso(),
      });
      throw new StageRetired(retireStageId);
    }

    if (countAsStep) ctx.stepsSinceCheckpoint += 1;
    const due = ctx.stepsSinceCheckpoint >= ctx.currentGranularity;
    const stagePauseId = [cursorStageId, ...activeStageIds].find(
      (s) => instance.stageDesired?.[s] === "pause",
    );
    const pausing = instance.desiredState === "pause" || stagePauseId !== undefined;
    if (!pausing && !due) return;

    // The cursor's unit records its intra-unit progress (and,
    // when stopping, its stopped state); a run-level stop marks
    // every in-flight unit stopped — stopped is recorded,
    // never failed, and a resume continues each from its
    // recorded position or its persisted step hand-offs.
    const active =
      cursor.unitId != null
        ? ctx.activeUnits.get(`${cursorStageId}::${cursor.unitId}`)
        : undefined;
    if (active) {
      const prior = this.entryFor(ctx.ledger, active.stageId, active.unitId);
      if (prior) {
        this.setEntry(ctx, {
          ...prior,
          status: pausing ? "stopped" : prior.status,
          progress: { stepIndex: cursor.stepIndex, itemIndex: cursor.itemIndex },
          updatedAt: this.iso(),
        });
      }
    }
    if (pausing) {
      for (const other of ctx.activeUnits.values()) {
        if (active && other.stageId === active.stageId && other.unitId === active.unitId) {
          continue;
        }
        const prior = this.entryFor(ctx.ledger, other.stageId, other.unitId);
        if (prior && prior.status === "running") {
          this.setEntry(ctx, { ...prior, status: "stopped", updatedAt: this.iso() });
        }
      }
    }
    await this.persistLedger(ctx);

    const checkpoint: JobCheckpoint = {
      runId: ctx.runId,
      scopePath: ctx.scopePath,
      nodePath: cursor.nodePath,
      stepIndex: cursor.stepIndex,
      itemIndex: cursor.itemIndex,
      shardIndex: cursor.shardIndex,
      childIndex: cursor.childIndex,
      artifactKeys: [...ctx.artifactKeys],
      updatedAt: this.iso(),
    };
    const fresh = await this.requireInstance(ctx.jobId);
    await this.setInstance({
      ...fresh,
      state: pausing ? "paused" : fresh.state,
      desiredState: "none",
      checkpoint,
    });
    if (stagePauseId) await this.clearStageDesired(ctx.jobId, stagePauseId);
    ctx.stepsSinceCheckpoint = 0;
    await publishJobStatus(this.deps.publisher, {
      jobId: ctx.jobId,
      runId: ctx.runId,
      state: "checkpointed",
      at: this.iso(),
      detail: cursorStageId,
      artifactKeys: [...ctx.artifactKeys],
    });
    if (pausing) {
      await publishJobStatus(this.deps.publisher, {
        jobId: ctx.jobId,
        runId: ctx.runId,
        state: "paused",
        at: this.iso(),
        ...(stagePauseId ? { detail: stagePauseId } : {}),
      });
      if (active) {
        await publishStageAction(this.deps.publisher, {
          jobId: ctx.jobId,
          runId: ctx.runId,
          stageId: active.stageId,
          unitId: active.unitId,
          action: "stopped",
          at: this.iso(),
        });
      }
      throw new RunStopped("paused");
    }
  }

  private effectiveMode(ctx: RunContext, node: JobNodeConfig): JobExecutionMode {
    const mode = resolveExecutionMode({
      ...ctx.rootConfig.executionMode,
      ...(node.executionMode ?? {}),
    });
    assertExecutionModeSupported(mode);
    return mode;
  }

  /**
   * The driver for one node = one stage of the run. The plan
   * is compiled and validated by the stage runner (planRun);
   * what executes is decided by its plan functions over the
   * run's checkpoint (planNext / planStageFanout /
   * fanoutCapExceeded) — completed units are never handed back,
   * which is what makes resume exact.
   */
  private async execNode(
    ctx: RunContext,
    node: JobNodeConfig,
    path: string,
    input: unknown,
  ): Promise<unknown> {
    const mode = this.effectiveMode(ctx, node);
    const inMemory = node.processing?.inMemory ?? ctx.rootConfig.processing.inMemory;
    const outputKey = `${keyPart(path)}/output`;
    const stageId = jobStageId(path);
    const previousGranularity = ctx.currentGranularity;
    ctx.currentGranularity =
      node.processing?.checkpointEverySteps ?? ctx.rootConfig.processing.checkpointEverySteps;
    try {
      const shardKeys: Array<string | null> =
        mode.shape === "sharded"
          ? (node.processing?.shards ?? ctx.rootConfig.processing.shards)
          : [null];
      if (mode.shape === "sharded" && shardKeys.length === 0) {
        throw new JobPipelineError(
          "job_shards_not_configured",
          `Node "${path || "root"}" (kind "${node.kind}") is configured for the sharded execution shape but names no shard keys (processing.shards). Refusing rather than silently running monolith.`,
        );
      }
      const stage = this.stageForNode(node, path, mode, ctx.runDeadlineMs);
      const plan = planRun({
        runId: ctx.runId,
        invocation: this.deps.invocation ?? "sync",
        stages: [stage],
        units: shardKeys
          .filter((k): k is string => k !== null)
          .map((unitId) => ({ unitId })),
      });

      await this.honorStageControl(ctx, plan, path);

      // Definition-level retirement (#3944): a node stamped
      // retired never executes in any run — the backstop for
      // resumes and races, where no stageDesired entry exists
      // to honor. The stage's units are recorded "retired"
      // and the run settles cancelled with the stage named.
      if (node.retired === true) {
        await this.retireUnitsBeforeRun(ctx, plan, stageId);
      }

      const entries = ctx.ledger.units.filter((u) => u.stage === stageId);
      if (
        ctx.resuming &&
        entries.length === 0 &&
        (await this.artifactExists(ctx, outputKey, inMemory))
      ) {
        // The ledger has no entries for this stage but its
        // persisted hand-off exists: the hand-off is the
        // completion proof (the stage contract's persisted
        // input/output rule), so the stage is read back.
        return this.readArtifact(ctx, outputKey, inMemory);
      }

      let next = planNext(plan, ctx.ledger);
      if (!next) {
        if (entries.some((e) => e.status === "cancelled")) {
          throw new StageCancelled(stageId);
        }
        if (entries.some((e) => e.status === "retired")) {
          throw new StageRetired(stageId);
        }
        if (await this.artifactExists(ctx, outputKey, inMemory)) {
          return this.readArtifact(ctx, outputKey, inMemory);
        }
        // The ledger calls the stage complete but its hand-off
        // is gone (in-memory volatility): re-plan with the
        // stage's entries cleared and execute — never fabricate
        // a completion.
        ctx.ledger.units = ctx.ledger.units.filter((u) => u.stage !== stageId);
        await this.persistLedger(ctx);
        next = planNext(plan, ctx.ledger);
      }

      const items = node.inputs?.items ?? ctx.rootConfig.inputs.items;
      const unitOutputs = new Map<string, unknown>();
      while (next) {
        const fanout = planStageFanout(next.stage, next.units);
        const note = fanoutCapExceeded(fanout);
        if (note && !ctx.notes.includes(note)) ctx.notes.push(note);
        const execute = async (unit: { unitId: string }): Promise<void> => {
          const out = await this.executeUnit(ctx, plan, next!.stage, unit, node, path, input, {
            mode,
            inMemory,
            items,
            shardIndex: shardKeys.indexOf(unit.unitId),
          });
          unitOutputs.set(unit.unitId, out);
        };
        if (next.stage.execution === "parallel" && fanout.started.length > 1) {
          await Promise.all(fanout.started.map((unit) => execute(unit)));
        } else {
          for (const unit of fanout.started) await execute(unit);
        }
        next = planNext(plan, ctx.ledger);
      }

      // Compose the node's own output from its units.
      let current: unknown;
      if (mode.shape === "sharded") {
        const byShard: Record<string, unknown> = {};
        for (const key of shardKeys) {
          const shardKey = key as string;
          byShard[shardKey] = unitOutputs.has(shardKey)
            ? unitOutputs.get(shardKey)
            : await this.readArtifact(
                ctx,
                `${keyPart(path)}/shard-${encodeURIComponent(shardKey)}/output`,
                inMemory,
              );
        }
        current = byShard;
      } else {
        current = unitOutputs.has(ctx.runId)
          ? unitOutputs.get(ctx.runId)
          : await this.readArtifact(ctx, outputKey, inMemory);
      }

      // The stage's own produced artifact (its units' composed
      // output, before children chain onto it): the persisted
      // input every child stage — and any later stage action on
      // a child — reads by key, per the stage contract.
      await this.writeArtifact(ctx, `${keyPart(path)}/stage-output`, current ?? null, inMemory);

      // Children.
      const children = node.children ?? [];
      if (children.length > 0) {
        if (mode.concurrency === "parallel") {
          const cap = stageMaxParallel(stage);
          const results: unknown[] = new Array(children.length);
          let nextChild = 0;
          const workers = Array.from(
            { length: Math.min(cap, children.length) },
            async (): Promise<void> => {
              while (nextChild < children.length) {
                const index = nextChild++;
                results[index] = await this.execNode(
                  ctx,
                  children[index],
                  childPath(path, index),
                  current,
                );
              }
            },
          );
          await Promise.all(workers);
          current = results;
        } else {
          for (let i = 0; i < children.length; i++) {
            await this.boundary(
              ctx,
              {
                nodePath: path,
                stepIndex: (node.steps ?? []).length,
                itemIndex: 0,
                shardIndex: 0,
                childIndex: i,
                unitId: null,
              },
              false,
            );
            current = await this.execNode(ctx, children[i], childPath(path, i), current);
          }
        }
      }

      await this.writeArtifact(ctx, outputKey, current ?? null, inMemory);
      return current;
    } finally {
      ctx.currentGranularity = previousGranularity;
    }
  }

  /**
   * Execute one (stage, unit) under the stage contract: the
   * claim (a running entry with its attempt count) is
   * persisted BEFORE the unit acts; processing failures retry
   * within the stage's pipelinePolicy budget (poison — coded
   * configuration errors — never retries); the unit's output
   * persists before its entry completes, and the transition
   * publishes last.
   */
  private async executeUnit(
    ctx: RunContext,
    plan: StageRunnerPlan,
    stage: StageRunnerStage,
    unit: { unitId: string },
    node: JobNodeConfig,
    path: string,
    input: unknown,
    eff: {
      mode: JobExecutionMode;
      inMemory: boolean;
      items: unknown[];
      shardIndex: number;
    },
  ): Promise<unknown> {
    const stageId = stage.stage;
    const shardKey = plan.units.length > 0 ? unit.unitId : null;
    const budget = resolveStageRetryBudget(this.policy, stage);
    const prior = this.entryFor(ctx.ledger, stageId, unit.unitId);
    const force = ctx.forceStage === path;
    // The starting position: a forced re-run starts from the
    // stage's input; a stopped unit continues from its recorded
    // progress; a unit of a RESUMED run derives its position
    // from its persisted hand-offs; a fresh run starts at zero.
    // (Deriving on a fresh run would let a colliding run id's
    // artifacts skip steps — the run id is the claim scope, and
    // a fresh dispatch owns none of its predecessor's effects.)
    let resume = force
      ? { stepIndex: 0, itemIndex: 0 }
      : prior?.status === "stopped"
        ? {
            stepIndex: prior.progress?.stepIndex ?? 0,
            itemIndex: prior.progress?.itemIndex ?? 0,
          }
        : ctx.resuming
          ? await this.deriveResumePosition(
              ctx,
              node,
              path,
              shardKey,
              eff.mode,
              eff.inMemory,
              eff.items,
            )
          : { stepIndex: 0, itemIndex: 0 };

    const activeKey = `${stageId}::${unit.unitId}`;
    ctx.activeUnits.set(activeKey, {
      stageId,
      nodePath: path,
      unitId: unit.unitId,
      shardKey,
      shardIndex: eff.shardIndex,
    });
    try {
      // Issue #5279 — this unit is live until it settles.
      const liveKey = ctx.runId;
      const liveSet = this.liveUnits.get(liveKey) ?? new Set<string>();
      liveSet.add(`${stageId}:${unit.unitId}`);
      this.liveUnits.set(liveKey, liveSet);
      let tries = 0;
      for (;;) {
        tries += 1;
        const claimed = this.entryFor(ctx.ledger, stageId, unit.unitId);
        this.setEntry(ctx, {
          stage: stageId,
          unitId: unit.unitId,
          status: "running",
          attempt: (claimed?.attempt ?? 0) + 1,
          // Issue #4359 — the unit's first start in this run; a retry
          // keeps the original stamp so the window stays the wall clock.
          startedAt: claimed?.startedAt ?? this.iso(),
          updatedAt: this.iso(),
          // Issue #3954 — the first sign of life; the stuck sweep reads it.
          heartbeatAt: this.iso(),
          ...(resume.stepIndex > 0 || resume.itemIndex > 0
            ? { progress: { ...resume } }
            : {}),
        });
        await this.persistLedger(ctx);
        // Issue #4360 — the start is published the moment it happens,
        // after the checkpoint holds the stamp (persist → checkpoint →
        // publish, the stage contract's order). The event carries the
        // recorded instant, never a second clock reading.
        const running = this.entryFor(ctx.ledger, stageId, unit.unitId);
        await publishStageAction(this.deps.publisher, {
          jobId: ctx.jobId,
          runId: ctx.runId,
          stageId,
          unitId: unit.unitId,
          action: "started",
          at: running?.startedAt ?? this.iso(),
          ...(running?.startedAt ? { startedAt: running.startedAt } : {}),
        });
        // Issue #6678 — record the attempt's leg timing before
        // it starts, so a leg still in-flight when the deadline
        // fires is named with its elapsed-so-far instead of
        // leaving the terminal error leg-less.
        const legTiming = {
          stageId,
          unitId: unit.unitId,
          attempt: tries,
          startedAtMs: Date.now(),
          endedAtMs: null as number | null,
          outcome: "in-flight" as "in-flight" | "completed" | "failed" | "timed_out",
        };
        ctx.legTimings.push(legTiming);
        try {
          const executed = await this.runUnit(stage, node, () =>
            this.execSteps(ctx, node, path, input, {
              mode: eff.mode,
              inMemory: eff.inMemory,
              items: eff.items,
              shardKey,
              shardIndex: eff.shardIndex,
              resumeStep: resume.stepIndex,
              resumeItem: resume.itemIndex,
            }),
          );
          legTiming.endedAtMs = Date.now();
          legTiming.outcome = "completed";
          const out = executed.output;
          if (shardKey !== null) {
            await this.writeArtifact(
              ctx,
              `${keyPart(path)}/shard-${encodeURIComponent(shardKey)}/output`,
              out ?? null,
              eff.inMemory,
            );
          }
          const done = this.entryFor(ctx.ledger, stageId, unit.unitId);
          // Issue #6028 — the step's own descriptor becomes the unit's
          // result reference, recorded with the completion.
          const resultRef = executed.resultRef;
          this.setEntry(ctx, {
            stage: stageId,
            unitId: unit.unitId,
            status: "completed",
            attempt: done?.attempt ?? tries,
            ...(done?.startedAt ? { startedAt: done.startedAt } : {}),
            endedAt: this.iso(),
            updatedAt: this.iso(),
            ...(resultRef ? { resultRef } : {}),
          });
          await this.persistLedger(ctx);
          const settled = this.entryFor(ctx.ledger, stageId, unit.unitId);
          await publishStageAction(this.deps.publisher, {
            jobId: ctx.jobId,
            runId: ctx.runId,
            stageId,
            unitId: unit.unitId,
            action: "completed",
            at: settled?.endedAt ?? this.iso(),
            ...(settled?.startedAt ? { startedAt: settled.startedAt } : {}),
            ...(settled?.endedAt ? { endedAt: settled.endedAt } : {}),
          });
          return out;
        } catch (error) {
          legTiming.endedAtMs = Date.now();
          legTiming.outcome =
            error instanceof JobPipelineError && error.code === "job_stage_timed_out"
              ? "timed_out"
              : "failed";
          if (error instanceof RunStopped) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const attemptNow =
            this.entryFor(ctx.ledger, stageId, unit.unitId)?.attempt ?? tries;
          if (error instanceof JobPipelineError && error.code === "job_stage_timed_out") {
            const timedOut = this.entryFor(ctx.ledger, stageId, unit.unitId);
            this.setEntry(ctx, {
              stage: stageId,
              unitId: unit.unitId,
              status: "timed_out",
              attempt: attemptNow,
              error: message,
              ...(timedOut?.startedAt ? { startedAt: timedOut.startedAt } : {}),
              endedAt: this.iso(),
              updatedAt: this.iso(),
            });
            await this.persistLedger(ctx);
            const timedOutSettled = this.entryFor(ctx.ledger, stageId, unit.unitId);
            await publishStageAction(this.deps.publisher, {
              jobId: ctx.jobId,
              runId: ctx.runId,
              stageId,
              unitId: unit.unitId,
              action: "timed_out",
              at: timedOutSettled?.endedAt ?? this.iso(),
              ...(timedOutSettled?.startedAt ? { startedAt: timedOutSettled.startedAt } : {}),
              ...(timedOutSettled?.endedAt ? { endedAt: timedOutSettled.endedAt } : {}),
              detail: message,
            });
            throw error;
          }
          // Poison (a coded configuration error — an unknown
          // step, an unconfigured shard) can never succeed on a
          // retry: dead-letter it immediately, per the stage
          // contract's failure handling. A step's processing
          // failure (job_step_failed, or an uncoded throw)
          // retries within the stage's budget. Uncoded stays
          // retryable deliberately (#4544 survey): a transient
          // failure such as the gateway's "temporarily
          // unavailable" names retry as its own remedy, and the
          // second attempt after backoff is the retry budget
          // working as designed — not a defect to poison.
          const retryable =
            error instanceof JobPipelineError ? error.code === "job_step_failed" : true;
          // Issue #6396 — the failing step's own bucket, when it declared one,
          // replaces the stage's budget for this retry decision: the step's
          // economics decide how often it is attempted. Absent ⇒ exactly the
          // stage budget as before.
          const stepOverride = (node.steps ?? [])[
            ctx.lastStepIndex ?? -1
          ]?.retry;
          const attemptBudget =
            stepOverride?.bucket && isRetryBucketName(stepOverride.bucket)
              ? this.policy.retry[stepOverride.bucket]
              : budget;
          if (retryable && tries < attemptBudget.maxAttempts) {
            // Issue #6278 — record the attempt's error before
            // the backoff, so the deadline catch in executeRun
            // can name the last leg error when the run dies at
            // the whole-run deadline mid-retry. Without this the
            // terminal error carries only FEED_DEADLINE_EXCEEDED
            // and the leg that was slow is undiagnosable from
            // the production error.
            ctx.lastLegError = { message, attempt: attemptNow };
            // Issue #6678 — legs compose against the execution
            // budget: when the elapsed time plus the backoff
            // would consume the remaining budget, stop here and
            // settle by name instead of starting an attempt the
            // race would kill unnamed mid-leg.
            const backoffMs = computeBackoffDelayMs(attemptBudget, tries);
            if (
              ctx.executionBudgetMs !== undefined &&
              Date.now() - ctx.runStartedAtMs + backoffMs >= ctx.executionBudgetMs
            ) {
              ctx.budgetExhausted = true;
              throw new FeedJobTimeoutError(
                FEED_JOB_CODES.deadlineExceeded,
                ctx.executionBudgetMs,
              );
            }
            await this.sleep(backoffMs);
            // Issue #4544 — a forced re-run restarts at step 0
            // on retry, exactly as it starts: deriving here
            // would find the dispatch's recorded step artifacts
            // (a re-run reuses the dispatch's run id, the claim
            // scope) and resume past the steps the re-run is
            // ordered to re-run, returning recorded output
            // without re-executing. Every other retry keeps
            // deriving — a fresh run resumes from what its own
            // first try persisted, a resumed run from the
            // persisted hand-offs.
            resume = force
              ? { stepIndex: 0, itemIndex: 0 }
              : await this.deriveResumePosition(
                  ctx,
                  node,
                  path,
                  shardKey,
                  eff.mode,
                  eff.inMemory,
                  eff.items,
                );
            continue;
          }
          // Issue #3967 — a poison unit lands in the DLQ, so the operator
          // can inspect and re-drive it rather than only learn it failed.
          // Best-effort by contract: the landing is evidence, not part of
          // the run's outcome, so a sink failure never masks the run's own
          // coded error (the same discipline the stage publisher follows).
          if (!retryable) {
            const sink = this.deps.deadLetterRun;
            if (sink) {
              try {
                await sink({
                  jobId: ctx.jobId,
                  runId: ctx.runId,
                  nodePath: path,
                  stageId,
                  unitId: unit.unitId,
                  code:
                    error instanceof JobPipelineError
                      ? error.code
                      : "job_step_failed",
                  message,
                  at: this.iso(),
                });
              } catch (sinkError) {
                structuredLog.warn("jobPipeline.poison_landing_failed", {
                  message:
                    `[job-pipeline] poison landing for job "${ctx.jobId}" run ` +
                    `"${ctx.runId}" could not be recorded: ` +
                    `${sinkError instanceof Error ? sinkError.message : String(sinkError)} ` +
                    "— the run's own failure is unchanged",
                  jobId: ctx.jobId,
                  runId: ctx.runId,
                  stageId,
                });
              }
            }
          }
          const failed = this.entryFor(ctx.ledger, stageId, unit.unitId);
          this.setEntry(ctx, {
            stage: stageId,
            unitId: unit.unitId,
            status: "failed",
            attempt: attemptNow,
            error: message,
            ...(failed?.startedAt ? { startedAt: failed.startedAt } : {}),
            endedAt: this.iso(),
            updatedAt: this.iso(),
          });
          await this.persistLedger(ctx);
          const failedSettled = this.entryFor(ctx.ledger, stageId, unit.unitId);
          await publishStageAction(this.deps.publisher, {
            jobId: ctx.jobId,
            runId: ctx.runId,
            stageId,
            unitId: unit.unitId,
            action: "failed",
            at: failedSettled?.endedAt ?? this.iso(),
            ...(failedSettled?.startedAt ? { startedAt: failedSettled.startedAt } : {}),
            ...(failedSettled?.endedAt ? { endedAt: failedSettled.endedAt } : {}),
            detail: message,
          });
          throw error;
        }
      }
    } finally {
      ctx.activeUnits.delete(activeKey);
      // Issue #5279 — the unit is no longer live; drop the run's entry once
      // its last unit leaves, so a settled run reads not-live.
      const set = this.liveUnits.get(ctx.runId);
      if (set) {
        set.delete(`${stageId}:${unit.unitId}`);
        if (set.size === 0) {
          this.liveUnits.delete(ctx.runId);
          // The run's last unit is done: its step count is no longer live.
          this.liveSteps.delete(ctx.runId);
        }
      }
    }
  }

  /**
   * Issue #3955 — a unit that contains a durable wait is bounded by the
   * wait's own declaration (or the host's maximum), never by the stage
   * deadline: a 600s stage default would otherwise kill an approval wait at
   * ten minutes while looking like a timeout the job never declared. A unit
   * with no wait keeps its stage deadline exactly as before.
   */
  private async runUnit<T>(
    stage: StageRunnerStage,
    node: JobNodeConfig,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (
      (node.steps ?? []).some(
        (step) => step.step === WAIT_EVENT_STEP || step.step === WAIT_SLEEP_STEP,
      )
    ) {
      return fn();
    }
    return this.withUnitDeadline(stage, fn);
  }

  /** Race a unit's execution against its stage deadline; a unit past it is timed_out. */
  private async withUnitDeadline<T>(
    stage: StageRunnerStage,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timeout = this.sleep(stage.timeoutMs).then(() => {
      throw new JobPipelineError(
        "job_stage_timed_out",
        `Stage "${stage.stage}" exceeded its per-unit deadline of ${stage.timeoutMs}ms.`,
      );
    });
    return Promise.race([fn(), timeout]);
  }

  /**
   * Derive a unit's resume position from its persisted step
   * hand-offs: the first step (and, online, the first item)
   * whose output artifact is absent. Steps are idempotent at
   * their boundaries, so a position derived from what actually
   * persisted can never re-execute a completed effect.
   */
  private async deriveResumePosition(
    ctx: RunContext,
    node: JobNodeConfig,
    path: string,
    shardKey: string | null,
    mode: JobExecutionMode,
    inMemory: boolean,
    items: unknown[],
  ): Promise<{ stepIndex: number; itemIndex: number }> {
    const steps = node.steps ?? [];
    if (mode.pacing === "online") {
      for (let s = 0; s < steps.length; s++) {
        for (let i = 0; i < items.length; i++) {
          if (
            !(await this.artifactExists(
              ctx,
              this.stepKey(path, s, shardKey, "online", i),
              inMemory,
            ))
          ) {
            return { stepIndex: s, itemIndex: i };
          }
        }
      }
      return { stepIndex: steps.length, itemIndex: 0 };
    }
    for (let s = 0; s < steps.length; s++) {
      if (
        !(await this.artifactExists(ctx, this.stepKey(path, s, shardKey, "batch", 0), inMemory))
      ) {
        return { stepIndex: s, itemIndex: 0 };
      }
    }
    return { stepIndex: steps.length, itemIndex: 0 };
  }

  private stepKey(
    path: string,
    stepIndex: number,
    shardKey: string | null,
    pacing: "batch" | "online",
    itemIndex: number,
  ): string {
    let key = `${keyPart(path)}/step-${stepIndex}`;
    if (shardKey !== null) key += `/shard-${encodeURIComponent(shardKey)}`;
    if (pacing === "online") key += `/item-${itemIndex}`;
    return key;
  }

  /**
   * Issue #3955 — one durable wait: resolve the declaration, refuse an
   * unservable host by name, and turn the channel's answer into the step's
   * declared outcome. The request carries the engine's ONE wait name, so a
   * replay re-arms the same platform wait.
   */
  /**
   * Issue #6393 — validate and execute one declared park. The bound is
   * policy (`pipeline.sleepMaxDurationMs`), and an over-long duration
   * REFUSES rather than being silently shortened: waking a run earlier
   * than its job asked, without saying so, is a lie the record cannot
   * show.
   */
  private async awaitSleep(
    ctx: RunContext,
    path: string,
    stepIndex: number,
    shardKey: string | null,
    itemIndex: number | null,
    params: Record<string, unknown>,
  ): Promise<{ outcome: "slept"; durationMs: number }> {
    const raw = params.durationMs;
    if (
      raw === undefined ||
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      raw <= 0
    ) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${WAIT_SLEEP_STEP}" of node "${path || "root"}" has an invalid "durationMs" (${String(raw)}); it must be a positive number of milliseconds.`,
      );
    }
    const max = this.policy.sleepMaxDurationMs;
    if (raw > max) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${WAIT_SLEEP_STEP}" of node "${path || "root"}" asks to park ${raw}ms, past the configured maximum of ${max}ms (pipeline.sleepMaxDurationMs); shorten the duration or raise the bound.`,
      );
    }
    const park = this.deps.sleepFor;
    if (!park) {
      throw new JobPipelineError(
        "stage_port_unavailable",
        `Step "${WAIT_SLEEP_STEP}" of node "${path || "root"}" parks for ${raw}ms, but this host provides no durable sleep; a parked run needs the workflow residency.`,
      );
    }
    const request: JobDurableSleepRequest = {
      jobId: ctx.jobId,
      runId: ctx.runId,
      nodePath: path,
      // The engine's ONE naming site: the same run, node, step and unit
      // produce the same platform name on every replay.
      stepName: `sleep:${stepExecutionId(ctx.runId, path, stepIndex, shardKey, itemIndex)}`,
      durationMs: raw,
    };
    try {
      await park(request);
    } catch (error) {
      if (error instanceof JobPipelineError) throw error;
      throw new JobPipelineError(
        "job_step_failed",
        `Durable sleep of ${raw}ms at node "${path || "root"}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { outcome: "slept", durationMs: raw };
  }

  /**
   * Issue #6394 — validate and run one child dispatch.
   *
   * The child is started through the SAME `runJob` the doors use, so it is a
   * first-class run: its own id, its own record, its own lifecycle. The parent
   * records the child's id in this step's output and waits for it unless the
   * job asked not to.
   */
  private async runChildRun(
    ctx: RunContext,
    path: string,
    params: Record<string, unknown>,
  ): Promise<JobChildRunOutcome> {
    const childJobId = typeof params.jobId === "string" ? params.jobId.trim() : "";
    if (!childJobId) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${CHILD_RUN_STEP}" of node "${path || "root"}" requires a non-empty "jobId" (the job the child run executes).`,
      );
    }
    if (childJobId === ctx.jobId) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${CHILD_RUN_STEP}" of node "${path || "root"}" names this run's own job ("${childJobId}"); a child must be a different job, because a job's instance carries one live run. Dispatch a distinct job, or the run-per-row shape.`,
      );
    }
    const onFailure = params.onFailure;
    if (onFailure !== "fail" && onFailure !== "continue") {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${CHILD_RUN_STEP}" of node "${path || "root"}" must name what the parent does when the child fails: "onFailure" is required and must be "fail" or "continue" (got ${JSON.stringify(onFailure)}) — a parent never silently proceeds past a failed child.`,
      );
    }
    const awaitSettlement = params.awaitSettlement !== false;
    const rawTimeout = params.timeoutMs;
    if (
      rawTimeout !== undefined &&
      (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0)
    ) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${CHILD_RUN_STEP}" of node "${path || "root"}" has an invalid "timeoutMs" (${String(rawTimeout)}); it must be a positive number of milliseconds.`,
      );
    }
    const timeoutMs =
      typeof rawTimeout === "number" ? rawTimeout : this.policy.waitDefaultTimeoutMs;

    // The child is a fresh ORIGINAL run of its own job, linked to this run by
    // origin — never a re-run of the parent's work.
    let dispatch: JobDispatchResult;
    try {
      dispatch = await this.runJob(childJobId, {
        trigger: ctx.trigger,
        kind: "original",
        originRunId: ctx.runId,
      });
    } catch (error) {
      if (error instanceof JobPipelineError) throw error;
      throw new JobPipelineError(
        "job_child_failed",
        `Child run of job "${childJobId}" (node "${path || "root"}") could not be started: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const outcome = await this.childOutcome(childJobId, dispatch, awaitSettlement, timeoutMs);
    if (outcome.outcome !== "completed" && onFailure === "fail") {
      throw new JobPipelineError(
        "job_child_failed",
        `Child run "${outcome.childRunId}" of job "${childJobId}" ${outcome.outcome} (node "${path || "root"}"), and this step's "onFailure" is "fail".`,
      );
    }
    return outcome;
  }

  /**
   * The child's settlement, bounded: a child that is still live is awaited
   * (or polled through the run recorder when its dispatch returned no
   * completion), and a child that outlives the step's bound reads as
   * `timed_out` — a named outcome the parent branches on, never a hang.
   */
  private async childOutcome(
    childJobId: string,
    dispatch: JobDispatchResult,
    awaitSettlement: boolean,
    timeoutMs: number,
  ): Promise<JobChildRunOutcome> {
    const settled = (state: string): JobChildRunOutcome => ({
      outcome: state === "completed" ? "completed" : "failed",
      childJobId,
      childRunId: dispatch.runId,
    });
    const terminal = new Set(["completed", "failed", "cancelled", "paused"]);
    if (terminal.has(dispatch.state)) return settled(dispatch.state);
    if (!awaitSettlement) return settled(dispatch.state);
    if (dispatch.completion) {
      const raced = await Promise.race([
        dispatch.completion.then((outcome) => outcome.state),
        this.sleep(timeoutMs).then(() => "timed_out" as const),
      ]);
      if (raced === "timed_out") {
        return { outcome: "timed_out", childJobId, childRunId: dispatch.runId };
      }
      return settled(raced);
    }
    // No completion handle (a cross-process dispatch): read the child's own
    // instance until it settles or the bound expires. The instance is the
    // authoritative liveness view — the run record is written at settle, so
    // polling it would miss a child that is still working.
    const deadline = this.now().getTime() + timeoutMs;
    for (;;) {
      const view = await this.getJob(childJobId);
      const state = view.instance?.state ?? "idle";
      if (state === "completed") return settled("completed");
      if (state === "failed" || state === "cancelled") return settled("failed");
      if (this.now().getTime() >= deadline) {
        return { outcome: "timed_out", childJobId, childRunId: dispatch.runId };
      }
      await this.sleep(250);
    }
  }

  private async awaitEvent(
    ctx: RunContext,
    path: string,
    stepIndex: number,
    shardKey: string | null,
    itemIndex: number | null,
    params: Record<string, unknown>,
  ): Promise<
    { outcome: "event"; event: string; payload: unknown } | { outcome: "timeout"; event: string }
  > {
    const event = typeof params.event === "string" ? params.event.trim() : "";
    if (!event) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${WAIT_EVENT_STEP}" of node "${path || "root"}" requires a non-empty "event" name (the event the delivery side sends).`,
      );
    }
    const rawTimeout = params.timeoutMs;
    if (
      rawTimeout !== undefined &&
      (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0)
    ) {
      throw new JobPipelineError(
        "job_config_invalid",
        `Step "${WAIT_EVENT_STEP}" of node "${path || "root"}" has an invalid "timeoutMs" (${String(rawTimeout)}); it must be a positive number of milliseconds.`,
      );
    }
    const wait = this.deps.waitForEvent;
    if (!wait) {
      throw new JobPipelineError(
        "stage_port_unavailable",
        `Step "${WAIT_EVENT_STEP}" of node "${path || "root"}" waits for event "${event}", but this host provides no event-wait channel; a durable wait runs on the workflow residency.`,
      );
    }
    let result: JobEventWaitOutcome;
    try {
      result = await wait({
        jobId: ctx.jobId,
        runId: ctx.runId,
        nodePath: path,
        stepName: `wait:${stepExecutionId(ctx.runId, path, stepIndex, shardKey, itemIndex)}`,
        event,
        // Issue #6551 — a wait with no declared bound runs under the
        // configured default, never the platform's 24h maximum: an unbounded
        // wait is a live instance, and the cost direction forbids that shape.
        timeoutMs:
          typeof rawTimeout === "number" ? rawTimeout : this.policy.waitDefaultTimeoutMs,
      });
    } catch (error) {
      if (error instanceof JobPipelineError) throw error;
      throw new JobPipelineError(
        "job_step_failed",
        `Event wait "${event}" of node "${path || "root"}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.outcome === "timeout") return { outcome: "timeout", event };
    return { outcome: "event", event, payload: result.payload ?? null };
  }

  private async execSteps(
    ctx: RunContext,
    node: JobNodeConfig,
    path: string,
    input: unknown,
    eff: {
      mode: JobExecutionMode;
      inMemory: boolean;
      items: unknown[];
      shardKey: string | null;
      shardIndex: number;
      resumeStep: number;
      resumeItem: number;
    },
  ): Promise<{ output: unknown; resultRef?: string }> {
    const journal = this.deps.journal ?? identityJobStepJournal;
    const steps = node.steps ?? [];
    const unitId = eff.shardKey ?? ctx.runId;
    // Issue #6028 — the last non-empty descriptor a step returned for this
    // unit. It is the step's own result reference, never derived from the
    // output's shape.
    let resultRef: string | undefined;
    const invoke = async (
      stepIndex: number,
      item: unknown,
      itemIndex: number | null,
      stepInput: unknown,
    ): Promise<unknown> => {
      const stepConfig = steps[stepIndex];
      // Issue #3955 — the event-wait stage runs on the host's channel and
      // NEVER inside the journal: Rules of Workflows forbid waitForEvent
      // inside step.do, and a journaled wait would replay as a completed
      // step instead of re-arming.
      if (stepConfig.step === WAIT_EVENT_STEP) {
        const waited = await this.awaitEvent(
          ctx,
          path,
          stepIndex,
          eff.shardKey,
          itemIndex,
          stepConfig.params ?? {},
        );
        ctx.stepExecutions += 1;
        return waited;
      }
      // Issue #6394 — the child dispatch IS journaled (unlike the waits): a
      // replay must read the recorded child run id, not start a second child.
      if (stepConfig.step === CHILD_RUN_STEP) {
        const child = await journal.do(
          stepExecutionId(ctx.runId, path, stepIndex, eff.shardKey, itemIndex),
          () => this.runChildRun(ctx, path, stepConfig.params ?? {}),
          { runId: ctx.runId, jobId: ctx.jobId },
        );
        ctx.stepExecutions += 1;
        return child;
      }
      // Issue #6393 — the park runs on the host's durable timer, never in
      // the journal, exactly as the event wait does (and for the same
      // Rules-of-Workflows reason).
      if (stepConfig.step === WAIT_SLEEP_STEP) {
        const slept = await this.awaitSleep(
          ctx,
          path,
          stepIndex,
          eff.shardKey,
          itemIndex,
          stepConfig.params ?? {},
        );
        ctx.stepExecutions += 1;
        return slept;
      }
      // Issue #6396 — the last step that STARTED is the one that failed;
      // the retry loop reads it to pick the step's own bucket.
      ctx.lastStepIndex = stepIndex;
      // Issue #5279 — the live step count the query reports.
      this.liveSteps.set(ctx.runId, (this.liveSteps.get(ctx.runId) ?? 0) + 1);
      const handler = this.deps.steps.resolve(stepConfig.step);
      const stepCtx: JobStepContext = {
        jobId: ctx.jobId,
        runId: ctx.runId,
        nodePath: path,
        kind: node.kind,
        stepIndex,
        item,
        itemIndex,
        items: eff.mode.pacing === "batch" ? eff.items : [],
        shardKey: eff.shardKey,
        params: stepConfig.params ?? {},
        input: stepInput,
        now: this.iso(),
        trigger: ctx.trigger,
        runKind: ctx.kind,
      };
      let result;
      try {
        result = await journal.do(
          stepExecutionId(ctx.runId, path, stepIndex, eff.shardKey, itemIndex),
          () => handler(stepCtx),
          // Issue #6466 part 5 — the run id rides as a first-class field, so
          // the OTel journals can attribute the step span/log to the run.
          { runId: ctx.runId, jobId: ctx.jobId },
        );
      } catch (error) {
        if (error instanceof JobPipelineError) throw error;
        throw new JobPipelineError(
          "job_step_failed",
          `Step "${stepConfig.step}" of node "${path || "root"}" (kind "${node.kind}") failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      ctx.stepExecutions += 1;
      // Issue #3954 — a completed step IS progress: refresh the unit's
      // liveness stamp so a long-but-working unit is never reaped as stuck.
      // In-memory here; the ledger's own write points persist it.
      const live = this.entryFor(ctx.ledger, jobStageId(path), unitId);
      if (live) {
        this.setEntry(ctx, {
          ...live,
          heartbeatAt: this.iso(),
          updatedAt: this.iso(),
        });
      }
      const descriptor = (result as { descriptor?: unknown }).descriptor;
      if (typeof descriptor === "string" && descriptor.length > 0) resultRef = descriptor;
      return result.output;
    };

    if (eff.mode.pacing === "online") {
      // Per-item chaining: item i's output of step s is item i's
      // input to step s+1. On a resume, the per-item state is
      // rebuilt from the persisted artifacts of the last
      // completed step.
      let perItem: unknown[] = eff.items.map(() => input);
      if (eff.resumeStep > 0) {
        const rebuilt: unknown[] = [];
        for (let i = 0; i < eff.items.length; i++) {
          const prior = await this.readArtifact(
            ctx,
            this.stepKey(path, eff.resumeStep - 1, eff.shardKey, "online", i),
            eff.inMemory,
          );
          rebuilt.push(prior ?? input);
        }
        perItem = rebuilt;
      }
      for (let s = eff.resumeStep; s < steps.length; s++) {
        const startItem = s === eff.resumeStep ? eff.resumeItem : 0;
        const next: unknown[] = [...perItem];
        for (let i = 0; i < startItem; i++) {
          const prior = await this.readArtifact(
            ctx,
            this.stepKey(path, s, eff.shardKey, "online", i),
            eff.inMemory,
          );
          if (prior !== null && prior !== undefined) next[i] = prior;
        }
        for (let i = startItem; i < eff.items.length; i++) {
          await this.boundary(
            ctx,
            {
              nodePath: path,
              stepIndex: s,
              itemIndex: i,
              shardIndex: eff.shardIndex,
              childIndex: 0,
              unitId,
            },
            false,
          );
          const out = await invoke(s, eff.items[i], i, perItem[i]);
          await this.writeArtifact(
            ctx,
            this.stepKey(path, s, eff.shardKey, "online", i),
            out ?? null,
            eff.inMemory,
          );
          next[i] = out;
        }
        perItem = next;
        await this.boundary(
          ctx,
          {
            nodePath: path,
            stepIndex: s + 1,
            itemIndex: 0,
            shardIndex: eff.shardIndex,
            childIndex: 0,
            unitId,
          },
          true,
        );
      }
      return { output: perItem, ...(resultRef ? { resultRef } : {}) };
    }

    // Batch pacing.
    let current = input;
    if (eff.resumeStep > 0) {
      const prior = await this.readArtifact(
        ctx,
        this.stepKey(path, eff.resumeStep - 1, eff.shardKey, "batch", 0),
        eff.inMemory,
      );
      if (prior !== null && prior !== undefined) current = prior;
    }
    for (let s = eff.resumeStep; s < steps.length; s++) {
      await this.boundary(
        ctx,
        {
          nodePath: path,
          stepIndex: s,
          itemIndex: 0,
          shardIndex: eff.shardIndex,
          childIndex: 0,
          unitId,
        },
        false,
      );
      const out = await invoke(s, null, null, current);
      await this.writeArtifact(
        ctx,
        this.stepKey(path, s, eff.shardKey, "batch", 0),
        out ?? null,
        eff.inMemory,
      );
      current = out;
      await this.boundary(
        ctx,
        {
          nodePath: path,
          stepIndex: s + 1,
          itemIndex: 0,
          shardIndex: eff.shardIndex,
          childIndex: 0,
          unitId,
        },
        true,
      );
    }
    return { output: current, ...(resultRef ? { resultRef } : {}) };
  }
}

/**
 * Chains run-settled observers so an existing observer (e.g. the
 * feed-run observer on the ScheduledAgent host) is kept and the
 * OTel observer runs alongside it. Each observer is guarded: one
 * observer's failure never blocks the others.
 *
 * Lives here (not in the observability modules) so the ONE factory
 * (`jobPipelineControlFactory.ts`) can chain observers without
 * importing the OTel provider chain: the providers import Node-only
 * modules (`@opentelemetry/context-async-hooks`) the vite browser
 * bundle cannot include, and the factory is imported by
 * browser-bundled dispatch sites (issue #6250, CI Fast-gates build
 * failure on PR #6261). `otelJobPipeline.ts` re-exports this so its
 * existing importers keep working.
 */
export function chainRunSettledObservers(
  ...observers: Array<
    ((info: JobRunSettledInfo) => Promise<void> | void) | undefined | null
  >
): (info: JobRunSettledInfo) => Promise<void> {
  return async (info: JobRunSettledInfo): Promise<void> => {
    for (const observer of observers) {
      if (!observer) continue;
      try {
        await observer(info);
      } catch {
        // One observer's failure never blocks the others.
      }
    }
  };
}

/** Build the control plane from explicit parts (hosts compose this). */
export function createJobPipelineControl(deps: JobPipelineDeps): JobPipelineControl {
  return new JobPipelineControl(deps);
}
