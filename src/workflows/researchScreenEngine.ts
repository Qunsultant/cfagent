/**
 * Issue #5120 (#5109 Sub-issue 4: API endpoints) — Engine-routed dispatch and
 * per-stage control for the nightly research run (`research:<runId>`).
 *
 * Both triggers (`POST /research/run` and `POST /research/scheduled-tick`)
 * dispatch through `dispatchResearchEngineRun`, which defines `research:<runId>`
 * on `JobPipelineControl`, carries the explicit `userLogin` as stage input,
 * and exposes `(runId, stageId)` stage addressing via `controlResearchStage`.
 */
import type { SqlStorage } from "../orm";
import type { Env } from "../types";
import type { JobRunTrigger } from "../data/jobRunRecordPorts";
import {
  createJobPipelineStoresFromD1,
  createJobPipelineStoresFromSql,
} from "../data/createJobPipelinePorts";
import { createInMemoryJobPipelineStores } from "../data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../data/inMemoryJobRunRecordAdapter";
import { SqlJobRunRecordStore } from "../data/doSqliteJobRunRecordAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../data/d1JobRunRecordAdapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import {
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
  type JobStageView,
} from "../services/jobPipelineEngine";
import { createJobPipelineControl } from "../services/jobPipelineControlFactory";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import { createDoSqliteJobStageEventStore } from "../data/doSqliteJobStageEventAdapter";
import {
  awaitResearchJobSettlement,
  researchWorkflowResidencyAvailable,
  startResearchJobWorkflow,
} from "./researchWorkflowHost";
import { createD1JobStageEventStore } from "../data/d1JobStageEventAdapter";
import {
  buildResearchJobDefinition,
  assertResearchAopCompliance,
  registerResearchSteps,
  RESEARCH_PIPELINE_STAGES,
  type ResearchPipelineStage,
  type ResearchStepDeps,
} from "../services/researchPipelineJobs";
import type { ResearchReport } from "../services/researchPipeline";
import type { ResearchFeedStageOutput } from "../services/researchFeedHandoff";
import type { ResearchEnrichStageOutput } from "../services/researchEnrichHandoff";
import {
  resolveResearchJobConfig,
  resolveResearchStageModes,
  resolveResearchStageRetryBuckets,
  resolveResearchStageTimeouts,
  mergeResearchStageModes,
  type ResearchStageModes,
  type ResearchStorageMode,
} from "../config/researchJobConfig";
import { newRunId } from "../services/executionTreeIds";
import { researchEngineJobId } from "./researchDataPorts";
import { codedMessage } from "../outcomes/outcomeAspects";
import type { FeatureFlagPort } from "../features/featureFlagPorts";

export type ResearchStageOp = "status" | "run" | "rerun" | "stop" | "resume" | "cancel";

export interface ResearchStageVisibility {
  stageId: ResearchPipelineStage;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  status: "completed" | "failed" | "running" | "pending" | "unknown";
}

/**
 * Issue #5122 (#5109 Release & ops) — Flagship cutover gate for `research:<runId>`.
 * When false, callers roll back cleanly to the direct pipeline entry.
 */
export async function isResearchEngineCutoverEnabled(
  flags?: Pick<FeatureFlagPort, "isEnabled">,
): Promise<boolean> {
  if (!flags) return true;
  // Issue #5915 — inverted on purpose. The engine is the default and the
  // only supported path; the direct branch exists solely behind the explicit
  // emergency flag (a declared-incident rollback), so `research_engine_cutover`
  // is no longer read and ordinary configuration cannot produce
  // `direct_rollback` (which fabricates stage rows and has no stage control).
  return !(await flags.isEnabled("research_engine_direct_rollback"));
}

export interface DispatchResearchEngineInput {
  runId?: string;
  userLogin: string;
  trigger: "manual" | "scheduled";
  sql?: SqlStorage;
  d1?: D1Database;
  env?: Record<string, string | undefined>;
  storageMode?: ResearchStorageMode;
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
  flags?: Pick<FeatureFlagPort, "isEnabled">;
  /**
   * Issue #5975 - the stored per-stage modes (ResearchConfig.stageModes).
   * They win over the deployment default (`RESEARCH_STAGE_MODES`) per stage
   * and per axis; absent means "the deployment default is the whole map".
   */
  stageModes?: ResearchStageModes;
  /** Issue #5912 — the venue/mode this run names; rides the job params. */
  brokerId?: string;
  mode?: string;
  researchDeps?: Partial<ResearchStepDeps>;
  /**
   * Issue #6035 (b) — the full deployment env, when the caller has it. With the
   * JOB_PIPELINE_WORKFLOW and AGENT_DB bindings present the run dispatches
   * through the durable workflow residency (one step per stage); absent, the run
   * keeps the in-process sync invocation.
   */
  durableEnv?: Env;
  /** Explicit local/test path: keep the in-process sync invocation. */
  forceSync?: boolean;
  /** Test seam for the workflow starter. */
  startResearchWorkflow?: (
    jobId: string,
    opts: { trigger: JobRunTrigger },
  ) => Promise<{ instanceId: string }>;
  /** Test seams for settlement polling. */
  settlementOpts?: {
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    readJob?: (engineJobId: string) => Promise<
      { instance: { state: string } | null } & Record<string, unknown>
    >;
  };
  execute: (ctx?: { runId: string; engineJobId: string; feed?: ResearchFeedStageOutput; enrich?: ResearchEnrichStageOutput; deferPublication?: boolean }) => Promise<Record<string, unknown>>;
}

export interface DispatchResearchEngineResult {
  engineJobId: string;
  runId: string;
  trigger: "manual" | "scheduled";
  userLogin: string;
  stages: readonly ResearchPipelineStage[];
  stageVisibility: ResearchStageVisibility[];
  cutoverMode: "engine" | "direct_rollback";
  /** Issue #6035 (b) — true when the run executed on the durable residency. */
  durableResidency?: boolean;
  /** The workflow instance carrying the run, when hosted. */
  workflowInstanceId?: string;
  storageMode: ResearchStorageMode;
  ephemeralFallback: boolean;
  ephemeralReason?: "no_durable_store_reachable";
  outcome: Record<string, unknown>;
}

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/researchScreenEngine",
});

export function resolveResearchEngineAdapters(input: {
  sql?: SqlStorage;
  d1?: D1Database;
  env?: Record<string, string | undefined>;
  storageMode?: ResearchStorageMode;
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
}): {
  storageMode: ResearchStorageMode;
  ephemeralFallback: boolean;
  ephemeralReason?: "no_durable_store_reachable";
  stores: JobPipelineDeps["stores"];
  runRecorder: JobRunRecorder;
} {
  const configuredMode =
    input.storageMode ?? resolveResearchJobConfig(input.env).storageMode;
  const hasDurableBacking = Boolean(input.stores || input.sql || input.d1);
  if (configuredMode === "in-memory") {
    return {
      storageMode: "in-memory",
      ephemeralFallback: false,
      stores: input.stores ?? createInMemoryJobPipelineStores(),
      runRecorder:
        input.runRecorder ?? jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    };
  }
  if (!hasDurableBacking) {
    structuredLog.warn("researchScreenEngine.ephemeral_fallback_no_durable_store", {
      configuredMode,
      reason: "no_durable_store_reachable",
    });
    return {
      storageMode: "in-memory",
      ephemeralFallback: true,
      ephemeralReason: "no_durable_store_reachable",
      stores: createInMemoryJobPipelineStores(),
      runRecorder:
        input.runRecorder ?? jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    };
  }
  const stores =
    input.stores ??
    (input.sql
      ? createJobPipelineStoresFromSql(input.sql)
      : createJobPipelineStoresFromD1(input.d1!));
  const runRecorder =
    input.runRecorder ??
    (input.sql
      ? (() => {
          const sqlRecorder = jobRunRecorderFromStore(new SqlJobRunRecordStore(input.sql));
          if (!input.d1) return sqlRecorder;
          const d1Runs = new D1JobRunRecordStore(createD1JobRunRecordDb(input.d1));
          return {
            recordRun: async (record: Parameters<JobRunRecorder["recordRun"]>[0]) => {
              await sqlRecorder.recordRun(record);
              try {
                await d1Runs.record(record);
              } catch {
                /* D1 mirror is best-effort when only DO SQLite tables exist */
              }
            },
            listRuns: (jobId: string, limit?: number) => sqlRecorder.listRuns(jobId, limit),
            latestRun: (jobId: string) => sqlRecorder.latestRun(jobId),
          };
        })()
      : (() => {
          const d1Runs = new D1JobRunRecordStore(createD1JobRunRecordDb(input.d1!));
          return {
            recordRun: (record) => d1Runs.record(record),
            listRuns: (jobId, limit) => d1Runs.listByJob(jobId, limit),
            latestRun: (jobId) => d1Runs.latestByJob(jobId),
          };
        })());
  return {
    storageMode: "durable",
    ephemeralFallback: false,
    stores,
    runRecorder,
  };
}

/**
 * The one stage-visibility mapping: the in-process control and the hosted run
 * return the same stage view shape, so a caller cannot tell the paths apart.
 */
function stageVisibilityFrom(stages: JobStageView[]): ResearchStageVisibility[] {
  return RESEARCH_PIPELINE_STAGES.map((stageId) => {
    const sv = stages.find((s) => s.kind === stageId);
    const statuses = sv?.units.map((unit) => unit.status) ?? [];
    const failed = statuses.some((status) => ["failed", "timed_out", "cancelled"].includes(status));
    const completed = statuses.length > 0 && statuses.every((status) => status === "completed");
    const running = statuses.some((status) => status === "running");
    const pending = statuses.some((status) => ["queued", "never-attempted"].includes(status));
    return {
      stageId,
      startedAt: sv?.startedAt ?? null,
      finishedAt: sv?.endedAt ?? null,
      durationMs: sv?.durationMs ?? null,
      status: !sv || statuses.length === 0
        ? "unknown"
        : failed
          ? "failed"
          : completed
            ? "completed"
            : running
              ? "running"
              : pending
                ? "pending"
                : "unknown",
    };
  });
}

/**
 * Dispatch a nightly research run (manual or scheduled) as a `research:<runId>`
 * engine job on `JobPipelineControl` with explicit owner identity as stage input.
 */
export async function dispatchResearchEngineRun(
  input: DispatchResearchEngineInput,
): Promise<DispatchResearchEngineResult> {
  if (!input.userLogin?.trim() || input.userLogin.trim() === "default") {
    throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  }
  const config = resolveResearchJobConfig(input.env);
  assertResearchAopCompliance(config, { userLogin: input.userLogin });

  const runId = input.runId?.trim() || newRunId();
  const engineJobId = researchEngineJobId(runId);

  const cutoverEnabled = await isResearchEngineCutoverEnabled(input.flags);
  if (!cutoverEnabled) {
    const outcome = await input.execute({ runId, engineJobId });
    const stageVisibility: ResearchStageVisibility[] = RESEARCH_PIPELINE_STAGES.map((stageId) => ({
      stageId,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      // Direct rollback has no durable per-stage checkpoint. The enclosing
      // run window is not evidence that each configured stage completed.
      status: "unknown",
    }));

    return {
      engineJobId,
      runId,
      trigger: input.trigger,
      userLogin: input.userLogin,
      stages: RESEARCH_PIPELINE_STAGES,
      stageVisibility,
      cutoverMode: "direct_rollback",
      storageMode: input.storageMode ?? config.storageMode,
      ephemeralFallback: false,
      outcome,
    };
  }

  let capturedOutcome: Record<string, unknown> | undefined;
  const baseDeps: ResearchStepDeps = {
    runOodaAnalysis: async (ctx) =>
      input.execute({
        runId: ctx.runId,
        engineJobId,
        ...(ctx.feed ? { feed: ctx.feed } : {}),
        ...(ctx.enrich ? { enrich: ctx.enrich } : {}),
        ...(ctx.deferPublication ? { deferPublication: true } : {}),
      }),
    ...input.researchDeps,
  };
  const wiredDeps: ResearchStepDeps = {
    ...baseDeps,
    // Issue #6416 — the inline dispatch's runOodaAnalysis unwraps the
    // publish envelope to the report the analyze step consumes, matching
    // the residency contract (researchWorkflowStageDeps.ts): a publish-leg
    // result without success/report fails closed instead of flowing
    // downstream as a vacuous 0-idea report (which is what made generate
    // and deliver take `not_configured` on research:mwu2akp6-1). The raw
    // result is captured FIRST: the route spreads ...dispatched.outcome
    // into the POST /research/run response and the OODA page reads
    // data.success / data.report / data.reportId from it, so the captured
    // outcome stays the envelope — the step handler alone sees the report.
    // A publish-leg result is recognized by its shape, not its source:
    // every success path of runResearchAndPublish carries `report`, and
    // every failure path carries `success: false` — so a result with a
    // boolean `success` AND (a `report` key, or `success: false`) is a
    // publish leg, and anything else is not. The mesh/MCP stub dispatch
    // receipts (no `success` field) and caller-supplied analysis doubles
    // (`{success: true, ...}` with no report, pinned by #5237/#5120/
    // #5122) pass through unchanged, exactly as today — the execute seam
    // is typed Promise<Record<string, unknown>> and the dep itself
    // Promise<ResearchReport | Record<string, unknown>>, so a non-envelope
    // result is a legitimate value of the seam, not a publish failure.
    // A blanket fail-closed unwrap would newly fail those dispatches and
    // change the MCP tool's receipt contract, which #6353 owns — so the
    // residency contract applies where it can apply: to publish legs.
    // (The residency branch above needs no unwrap here: it builds its
    // deps through createJobPipelineWorkflowDeps, whose analyze dep
    // already unwraps — this seam is the in-process sync path only.)
    runOodaAnalysis: async (ctx) => {
      const result = await baseDeps.runOodaAnalysis(ctx);
      capturedOutcome = result as Record<string, unknown>;
      const envelope = result as { success?: unknown; report?: unknown; error?: string };
      if (
        typeof envelope.success === "boolean" &&
        (envelope.success === false || "report" in envelope)
      ) {
        if (!envelope.success || !envelope.report) {
          throw new Error(
            envelope.error ?? "research_stage_failed: analyze.ooda did not return a report.",
          );
        }
        return envelope.report as ResearchReport;
      }
      return result;
    },
    // Issue #6416 — the same residency drift as the unwrap: the resident
    // analyze requires the persisted feed/enrich outputs and fails closed
    // without them, instead of running from scratch. The flag is set only
    // when this dispatch carries real feed+enrich stage deps (the manual
    // route and the scheduled tick); a dispatch with no stage deps has no
    // persisted inputs to require, and its analyze cannot fetch from
    // scratch (its execute is a stub), so the flag is vacuous there —
    // setting it unconditionally would newly fail the mesh/MCP stub
    // dispatches the pins assert succeed (#5123, #5286).
    ...(input.researchDeps?.runFeedStage && input.researchDeps?.runEnrichStage
      ? { requireStageInputs: true }
      : {}),
  };

  const { storageMode, ephemeralFallback, ephemeralReason, stores, runRecorder } =
    resolveResearchEngineAdapters(input);
  const definition = buildResearchJobDefinition(runId, {
    userLogin: input.userLogin,
    trigger: input.trigger,
    // Issue #5916 — per-stage overrides come from one config value.
    // Issue #5975 - the stored configuration wins over the deployment
    // default, per stage and per axis, so a run started from the settings
    // page and a run started by the tick resolve the same modes.
    stageModes: mergeResearchStageModes(
      resolveResearchStageModes(input.env),
      input.stageModes,
    ),
    // Issue #5109, Fix 2 — the per-stage deadlines and retry buckets
    // resolve from the deployment carriers (defaults when absent),
    // mirroring the stageModes resolution above.
    stageTimeouts: resolveResearchStageTimeouts(input.env),
    stageRetryBuckets: resolveResearchStageRetryBuckets(input.env),
    // Issue #5912 — the venue/mode this run names (carried to analyze.ooda).
    ...(input.brokerId ? { brokerId: input.brokerId } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
  });

  // Issue #6035 (b) — when the deployment hosts the job-pipeline workflow,
  // dispatch through it: one durable step per stage, checkpointed, resumable.
  // The in-process sync invocation stays as the explicit local/test path.
  if (!input.forceSync && researchWorkflowResidencyAvailable(input.durableEnv)) {
    const env = input.durableEnv as Env;
    const started = await startResearchJobWorkflow({
      env,
      definition: definition as unknown as Record<string, unknown>,
      engineJobId,
      trigger: input.trigger,
      ...(input.startResearchWorkflow ? { startWorkflow: input.startResearchWorkflow } : {}),
    });
    const settlement = await awaitResearchJobSettlement({
      env,
      engineJobId,
      ...(input.settlementOpts ?? {}),
    });
    const view = settlement.view as unknown as {
      instance: { state: string; lastError?: string | null; currentRunId?: string | null } | null;
      stages: JobStageView[];
    };
    if (settlement.state === "failed") {
      throw new Error(view.instance?.lastError || `Research engine job ${engineJobId} failed.`);
    }
    return {
      engineJobId,
      runId,
      trigger: input.trigger,
      userLogin: input.userLogin,
      stages: RESEARCH_PIPELINE_STAGES,
      stageVisibility: stageVisibilityFrom(view.stages),
      cutoverMode: "engine",
      durableResidency: true,
      workflowInstanceId: started.instanceId,
      storageMode,
      ephemeralFallback,
      ...(ephemeralReason ? { ephemeralReason } : {}),
      outcome: {
        engineRunId: view.instance?.currentRunId ?? null,
        state: settlement.state,
        workflowInstanceId: started.instanceId,
      },
    };
  }
  // Issue #6250 — the OODA dispatch builds its control through the
  // ONE factory, with the caller's env: the OTel run-settled
  // observers ride the control, so this run emits `job.run.settled`.
  const control = createJobPipelineControl({
    stores,
    runRecorder,
    // The OODA job and its durable J-stack execution are one run. Reuse
    // JobPipelineControl's existing ID factory seam so the report/run ID
    // minted above is also the engine's persisted workflow run ID.
    newRunId: () => runId,
    publisher: null,
    // Issue #6028 — the stage-level terminal rows persist in the run's
    // own DO SQLite when the caller supplied one (production does), so a
    // past run's stages survive its checkpoint.
    ...(input.sql && typeof input.sql.exec === "function"
      ? { stageEvents: createDoSqliteJobStageEventStore(input.sql) }
      : {}),
    // Issue #6388 — the D1 mirror of the stage-event journal. The stage
    // control (below) and the read path already wire it; the dispatch did
    // not, so a dispatch-path run was unreadable from D1 once its DO was
    // gone, and a D1-only reader saw nothing. Same adapter, same
    // best-effort mirror write; no d1 = no mirror, never a throw.
    ...(input.d1 ? { stageEventsMirror: createD1JobStageEventStore(input.d1) } : {}),
    steps: registerResearchSteps(createBuiltinStepRegistry(), wiredDeps),
    invocation: "sync",
    // Issue #4782 S3 — the retry policy resolves from the
    // caller's env (platform default); input.env is already
    // string-valued, so it passes through as-is.
    ...(input.env ? { env: input.env } : {}),
  }, { ...(input.env ? { env: input.env } : {}) });
  await control.defineJob(definition as never);

  const dispatch = await control.runJob(engineJobId, { trigger: input.trigger });
  const runOutcome = dispatch.completion ? await dispatch.completion : null;
  const jobView = await control.getJob(engineJobId);

  if ((runOutcome?.state ?? dispatch.state) === "failed") {
    throw new Error(jobView.instance?.lastError || `Research engine job ${engineJobId} failed.`);
  }

  const stageVisibility = stageVisibilityFrom(jobView.stages);

  return {
    engineJobId,
    runId,
    trigger: input.trigger,
    userLogin: input.userLogin,
    stages: RESEARCH_PIPELINE_STAGES,
    stageVisibility,
    cutoverMode: "engine",
    storageMode,
    ephemeralFallback,
    ...(ephemeralReason ? { ephemeralReason } : {}),
    outcome: capturedOutcome ?? { engineRunId: dispatch.runId, state: dispatch.state },
  };
}

export interface ControlResearchStageInput {
  runId: string;
  stageId: string;
  op: ResearchStageOp;
  userLogin: string;
}

/**
 * Address one stage of `research:<runId>` by `(runId, stageId)`.
 * Refuses unknown stage ids and missing owner identity by name.
 */
export function controlResearchStage(input: ControlResearchStageInput): {
  ok: true;
  engineJobId: string;
  runId: string;
  stageId: ResearchPipelineStage;
  op: ResearchStageOp;
  userLogin: string;
} {
  if (!input.userLogin?.trim() || input.userLogin.trim() === "default") {
    throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  }
  if (!(RESEARCH_PIPELINE_STAGES as readonly string[]).includes(input.stageId)) {
    throw new Error(
      `Unknown research stage "${input.stageId}". Expected one of: ${RESEARCH_PIPELINE_STAGES.join(", ")}`,
    );
  }
  return {
    ok: true,
    engineJobId: researchEngineJobId(input.runId),
    runId: input.runId,
    stageId: input.stageId as ResearchPipelineStage,
    op: input.op,
    userLogin: input.userLogin,
  };
}

export interface ReadResearchStagesInput {
  runId: string;
  userLogin: string;
  sql?: import("../orm").SqlStorage;
  d1?: D1Database;
  env?: Record<string, string | undefined>;
  /** Injected residency (tests reuse one store); production resolves from sql/d1. */
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
}

/**
 * Issue #6034 — what a stage produced, as the one read contract states it.
 * `descriptor` is the step's own result reference (#6028); the optional
 * fields are additive for a producer that can name its artifact or summary.
 */
export interface ResearchStageResult {
  descriptor: string;
  artifactRef?: string;
  summary?: string;
}

/** Why a stage has no result — coded, never a prose guess. */
export type ResearchStageResultReason = "not_run" | "no_artifact" | "not_applicable";

export interface ResearchStageRow {
  stageId: ResearchPipelineStage;
  /** The engine's node path for this stage ("0".."5" in pipeline order). */
  nodePath: string;
  /** The engine's recorded status, or "pending" when the stage never ran. */
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** Issue #6034 — the units the stage planned, and how many ended failed. */
  unitCount: number;
  failedUnitCount: number;
  /**
   * Issue #6034 — the stage's result. Null is explicit and pairs with
   * `resultReason`: never a fabricated summary.
   */
  result: ResearchStageResult | null;
  /** Present only when `result` is null. */
  resultReason?: ResearchStageResultReason;
  /**
   * Issue #6355 — the persisted step output's `status` when the output
   * carries one (e.g. "not_configured"). Null when the output has no
   * status field or no artifact was persisted — never a fabricated
   * status. A present "not_configured" is the no-op signature: the
   * stage completed without doing its work.
   */
  stepStatus: string | null;
  /**
   * Issue #6416 — the persisted step-output artifact itself, present
   * only when the caller opts in ({ includeStageOutputs: true }): the
   * Workflow Runs ledger read needs the artifact to synthesize stage
   * detail, and it already fetches the artifact for `stepStatus` — so
   * opting in keeps the artifact instead of discarding it. The OODA
   * page's control read does not opt in, so it ships nothing extra.
   */
  output?: unknown;
  /**
   * Issue #6355 — the unit attempt count from the live checkpoint.
   * Null when only persisted terminal rows survive (they carry no
   * attempt) or the stage never ran.
   */
  attempt: number | null;
}

/**
 * Issue #6355 — the persisted step output for one stage, or null when
 * the stage wrote no artifact. The key is the engine's stage-output key
 * (<nodePath>/stage-output, `keyPart` in jobPipelineEngine.ts) — the
 * same key the engine writes and stageInput reads. A missing artifact
 * is null, never an error: the stages read must not fail because one
 * stage's output is absent.
 */
async function readStageOutput(
  stores: JobPipelineDeps["stores"],
  runId: string,
  nodePath: string,
): Promise<unknown | null> {
  const key = `${nodePath === "" ? "root" : nodePath}/stage-output`;
  const output = await stores.artifacts.getArtifact(runId, key).catch(() => null);
  return output ?? null;
}

/**
 * Issue #6355 — the persisted step output's `status` when the output
 * carries one (e.g. "not_configured"). Null when the output has no
 * status field or no artifact was persisted — never a fabricated
 * status. A present "not_configured" is the no-op signature: the
 * stage completed without doing its work.
 */
function stageOutputStatus(output: unknown): string | null {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const status = (output as Record<string, unknown>).status;
    return typeof status === "string" ? status : null;
  }
  return null;
}

/**
 * Issue #5917 — the six stages of one research run, in pipeline order.
 *
 * The per-stage control route already answers one stage at a time; without
 * this read a page cannot know which stages exist to act on, so it could only
 * render a dead control. An unknown run answers the six stages "pending" —
 * never an invented status.
 */
export async function readResearchStages(
  input: ReadResearchStagesInput,
  opts?: { includeStageOutputs?: boolean },
): Promise<{
  engineJobId: string;
  jobState: string;
  engineRunId: string | null;
  storageMode: ResearchStorageMode;
  stages: ResearchStageRow[];
}> {
  const engineJobId = researchEngineJobId(input.runId);
  const { storageMode, stores, runRecorder } = resolveResearchEngineAdapters(input);
  // Issue #6250 — the read-only stages view builds through the ONE
  // factory too (no run executes here, so no env is passed: a bare
  // control, exactly as before — the construction stays single).
  const control = createJobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "sync",
    ...(input.sql && typeof input.sql.exec === "function"
      ? { stageEvents: createDoSqliteJobStageEventStore(input.sql) }
      : {}),
    ...(input.d1 ? { stageEventsMirror: createD1JobStageEventStore(input.d1) } : {}),
  });
  // No definition yet = the run never started; the six stages are pending,
  // not missing (the page still shows what can be started).
  const view = await control.getJob(engineJobId).catch(() => null);
  // Issue #6028 — a settled run's stages live on after its checkpoint: the
  // engine wrote one terminal row per stage when the run ended. Read as a
  // fallback only — a live stage always wins, so the checkpoint stays the
  // truth for a running run and the ledger is never a second truth.
  const persisted = input.sql
    ? await createDoSqliteJobStageEventStore(input.sql)
        .listByRun(input.runId)
        .catch(() => [])
    : [];
  // Issue #6202 — the D1 mirror answers when the DO has nothing this run:
  // the read shape is identical, so a D1-only read is not a second contract.
  const persistedRows =
    persisted.length > 0
      ? persisted
      : input.d1
        ? await createD1JobStageEventStore(input.d1).listByRun(input.runId).catch(() => [])
        : [];
  const persistedByStage = new Map(
    persistedRows
      .filter((row) => row.action === "terminal" && row.stageStatus)
      .map((row) => [row.stageId, row]),
  );
  // Issue #6355 — the engine run id the stage-output artifacts are
  // keyed under: the dispatch pins it to the research run id, so the
  // input run id is the fallback when the checkpoint (and its
  // currentRunId) is gone.
  const artifactRunId = view?.instance?.currentRunId ?? input.runId;
  const stages: ResearchStageRow[] = await Promise.all(
    RESEARCH_PIPELINE_STAGES.map(async (stageId) => {
      const found = view?.stages.find((stage) => stage.kind === stageId) ?? null;
      const stored = persistedByStage.get(stageId) ?? null;
      const units = found?.units ?? [];
      const failed = units.some((unit) => unit.status === "failed");
      const running = units.some((unit) => unit.status === "running");
      const stopped = units.some((unit) => unit.status === "stopped");
      const status = !found
        ? (stored?.stageStatus ?? "pending")
        : failed
          ? "failed"
          : running
            ? "running"
            : stopped
              ? "stopped"
              : units.length === 0
                ? (stored?.stageStatus ?? "pending")
                : "completed";
      // Issue #6034 — the result and its coded reason. A live stage's own
      // descriptor wins over the persisted row (the checkpoint is the truth
      // while the run is in front of us); an absent result is `no_artifact`
      // when the stage ran and `not_run` when it never did.
      const descriptor = found?.resultRef ?? stored?.resultRef ?? null;
      const ran = Boolean(found || stored);
      const result: ResearchStageResult | null = descriptor ? { descriptor } : null;
      const resultReason: ResearchStageResultReason | undefined = result
        ? undefined
        : ran
          ? "no_artifact"
          : "not_run";
      // Issue #6355 — the unit attempt count and the step output's status.
      // attempt comes from the live checkpoint (the terminal rows carry
      // none); stepStatus comes from the stage's persisted step-output
      // artifact. Both stay null when the record is absent — a future
      // no-op reads as stepStatus "not_configured", never as a healthy
      // 0 ms completion. Issue #6416 — the artifact itself is read once
      // here and kept only when the caller opted in; stepStatus is
      // derived from that same read, never a second fetch.
      const attempt =
        found && found.units.length > 0
          ? Math.max(...found.units.map((unit) => unit.attempt))
          : null;
      const nodePath = found?.nodePath ?? String(RESEARCH_PIPELINE_STAGES.indexOf(stageId));
      const stageOutput = await readStageOutput(stores, artifactRunId, nodePath);
      const stepStatus = stageOutputStatus(stageOutput);
      return {
        stageId,
        nodePath,
        status,
        startedAt: found?.startedAt ?? stored?.startedAt ?? null,
        endedAt: found?.endedAt ?? stored?.endedAt ?? null,
        durationMs: found?.durationMs ?? stored?.durationMs ?? null,
        unitCount: found ? found.units.length : (stored?.unitCount ?? 0),
        failedUnitCount: found
          ? found.units.filter((unit) => unit.status === "failed" || unit.status === "timed_out")
              .length
          : (stored?.failedUnitCount ?? 0),
        result,
        ...(resultReason ? { resultReason } : {}),
        stepStatus,
        attempt,
        ...(opts?.includeStageOutputs ? { output: stageOutput } : {}),
      };
    }),
  );
  return {
    engineJobId,
    jobState: view?.instance?.state ?? "idle",
    engineRunId: view?.instance?.currentRunId ?? null,
    storageMode,
    stages,
  };
}

export interface ExecuteResearchStageControlInput extends ControlResearchStageInput {
  sql?: SqlStorage;
  d1?: D1Database;
  env?: Record<string, string | undefined>;
  storageMode?: ResearchStorageMode;
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
  researchDeps?: Partial<ResearchStepDeps>;
  /** Test-only fence (#5287): never set in production callers. */
  allowTestStub?: boolean;
}

export interface ExecuteResearchStageControlResult {
  ok: true;
  engineJobId: string;
  runId: string;
  stageId: ResearchPipelineStage;
  op: ResearchStageOp;
  userLogin: string;
  storageMode: ResearchStorageMode;
  ephemeralFallback: boolean;
  ephemeralReason?: "no_durable_store_reachable";
  jobState: string;
  engineRunId: string | null;
  stage: JobStageView | null;
}

/**
 * Execute a real per-stage control operation (`status`, `run`, `rerun`, `stop`,
 * `resume`, `cancel`) against `JobPipelineControl` for `research:<runId>`.
 */
export async function executeResearchStageControl(
  input: ExecuteResearchStageControlInput,
): Promise<ExecuteResearchStageControlResult> {
  const validated = controlResearchStage(input);
  const { storageMode, ephemeralFallback, ephemeralReason, stores, runRecorder } =
    resolveResearchEngineAdapters(input);
  const needsExecution =
    validated.op === "run" || validated.op === "rerun" || validated.op === "resume";
  const isVitest =
    typeof process !== "undefined" && Boolean(process.env?.VITEST) && input.allowTestStub !== false;
  if (needsExecution && !input.researchDeps && !input.allowTestStub && !isVitest) {
    throw new Error(
      `FAILURE_RESEARCH_DEPS_MISSING: stage control "${validated.op}" on ${validated.engineJobId} requires explicit researchDeps.`,
    );
  }
  const deps: ResearchStepDeps = {
    runOodaAnalysis: async (ctx) => {
      if (!input.allowTestStub && !isVitest) {
        throw new Error(
          `FAILURE_RESEARCH_DEPS_MISSING: analyze.ooda on ${ctx.runId} requires explicit researchDeps.`,
        );
      }
      return {
        ok: true,
        runId: ctx.runId,
        stageId: validated.stageId,
        userLogin: ctx.userLogin,
      };
    },
    ...input.researchDeps,
  };
  // Issue #6250 — the stage re-run builds through the ONE factory,
  // with the caller's env: a re-run that executes emits
  // `job.run.settled` like the dispatch.
  const control = createJobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: registerResearchSteps(createBuiltinStepRegistry(), deps),
    invocation: "sync",
    ...(input.sql && typeof input.sql.exec === "function"
      ? { stageEvents: createDoSqliteJobStageEventStore(input.sql) }
      : {}),
    ...(input.d1 ? { stageEventsMirror: createD1JobStageEventStore(input.d1) } : {}),
    // Issue #4782 S3 — as the dispatch control above: the stage
    // re-run resolves its retry policy from the caller's env.
    ...(input.env ? { env: input.env } : {}),
  }, { ...(input.env ? { env: input.env } : {}) });

  const existingDef = await stores.definitions.getDefinition(validated.engineJobId);
  if (!existingDef) {
    if (validated.op === "status") {
      return {
        ...validated,
        storageMode,
        ephemeralFallback,
        ...(ephemeralReason ? { ephemeralReason } : {}),
        jobState: "idle",
        engineRunId: null,
        stage: null,
      };
    }
    const definition = buildResearchJobDefinition(validated.runId, {
      userLogin: validated.userLogin,
      trigger: "manual",
    });
    await control.defineJob(definition as never);
  }

  const before = await control.getJob(validated.engineJobId);
  const childIdx = (before.definition.root.children ?? []).findIndex(
    (c) => c.kind === validated.stageId,
  );
  if (childIdx < 0) {
    throw new Error(
      `Stage "${validated.stageId}" not found on engine job "${validated.engineJobId}".`,
    );
  }
  const nodePath = String(childIdx);

  if (validated.op === "run") {
    const dispatch = !before.instance?.currentRunId
      ? await control.runJob(validated.engineJobId, { trigger: "manual" })
      : await control.runStage(validated.engineJobId, nodePath);
    if (dispatch.completion) await dispatch.completion;
  } else if (validated.op === "rerun") {
    try {
      const dispatch = await control.rerunStage(validated.engineJobId, nodePath);
      if (dispatch.completion) await dispatch.completion;
    } catch (err: any) {
      if (err?.code === "stage_input_missing") {
        const dispatch = await control.runJob(validated.engineJobId, { trigger: "manual" });
        if (dispatch.completion) await dispatch.completion;
      } else {
        throw err;
      }
    }
  } else if (validated.op === "stop") {
    await control.stopStage(validated.engineJobId, nodePath);
  } else if (validated.op === "resume") {
    const dispatch = await control.resumeStage(validated.engineJobId, nodePath);
    if (dispatch.completion) await dispatch.completion;
  } else if (validated.op === "cancel") {
    await control.cancelStage(validated.engineJobId, nodePath);
  }

  const after = await control.getJob(validated.engineJobId);
  const stageAfter = after.stages.find((s) => s.kind === validated.stageId) ?? null;
  return {
    ...validated,
    storageMode,
    ephemeralFallback,
    ...(ephemeralReason ? { ephemeralReason } : {}),
    jobState: after.instance?.state ?? "idle",
    engineRunId: after.instance?.currentRunId ?? after.latestRun?.operation ?? null,
    stage: stageAfter,
  };
}
