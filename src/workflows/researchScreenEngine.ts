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
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
  type JobStageView,
} from "../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import {
  buildResearchJobDefinition,
  assertResearchAopCompliance,
  registerResearchSteps,
  RESEARCH_PIPELINE_STAGES,
  type ResearchPipelineStage,
  type ResearchStepDeps,
} from "../services/researchPipelineJobs";
import {
  resolveResearchJobConfig,
  type ResearchStorageMode,
} from "../config/researchJobConfig";
import { researchEngineJobId } from "./researchDataPorts";
import { codedMessage } from "../outcomes/outcomeAspects";
import type { FeatureFlagPort } from "../features/featureFlagPorts";

export type ResearchStageOp = "status" | "run" | "rerun" | "stop" | "resume" | "cancel";

export interface ResearchStageVisibility {
  stageId: ResearchPipelineStage;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: "completed" | "failed";
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
  researchDeps?: ResearchStepDeps;
  execute: (ctx?: { runId: string; engineJobId: string }) => Promise<Record<string, unknown>>;
}

export interface DispatchResearchEngineResult {
  engineJobId: string;
  runId: string;
  trigger: "manual" | "scheduled";
  userLogin: string;
  stages: readonly ResearchPipelineStage[];
  stageVisibility: ResearchStageVisibility[];
  cutoverMode: "engine" | "direct_rollback";
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

  const runId = input.runId?.trim() || crypto.randomUUID();
  const engineJobId = researchEngineJobId(runId);

  const cutoverEnabled = await isResearchEngineCutoverEnabled(input.flags);
  if (!cutoverEnabled) {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const outcome = await input.execute({ runId, engineJobId });
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startMs);
    const stageVisibility: ResearchStageVisibility[] = RESEARCH_PIPELINE_STAGES.map((stageId) => ({
      stageId,
      startedAt,
      finishedAt,
      durationMs,
      status: "completed",
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
  const baseDeps: ResearchStepDeps = input.researchDeps ?? {
    runOodaAnalysis: async (ctx) => input.execute({ runId: ctx.runId, engineJobId }),
  };
  const wiredDeps: ResearchStepDeps = {
    ...baseDeps,
    runOodaAnalysis: async (ctx) => {
      const result = await baseDeps.runOodaAnalysis(ctx);
      capturedOutcome = result as Record<string, unknown>;
      return result;
    },
  };

  const { storageMode, ephemeralFallback, ephemeralReason, stores, runRecorder } =
    resolveResearchEngineAdapters(input);
  const control = new JobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: registerResearchSteps(createBuiltinStepRegistry(), wiredDeps),
    invocation: "sync",
  });
  const definition = buildResearchJobDefinition(runId, {
    userLogin: input.userLogin,
    trigger: input.trigger,
  });
  await control.defineJob(definition as never);

  const fallbackStartedAt = new Date().toISOString();
  const dispatch = await control.runJob(engineJobId, { trigger: input.trigger });
  const runOutcome = dispatch.completion ? await dispatch.completion : null;
  const fallbackFinishedAt = new Date().toISOString();
  const jobView = await control.getJob(engineJobId);

  if ((runOutcome?.state ?? dispatch.state) === "failed") {
    throw new Error(jobView.instance?.lastError || `Research engine job ${engineJobId} failed.`);
  }

  const stageVisibility: ResearchStageVisibility[] = RESEARCH_PIPELINE_STAGES.map((stageId) => {
    const sv = jobView.stages.find((s) => s.kind === stageId);
    const startedAt = sv?.startedAt ?? fallbackStartedAt;
    const finishedAt = sv?.endedAt ?? sv?.startedAt ?? fallbackFinishedAt;
    const durationMs =
      sv?.durationMs ??
      Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt) || 0);
    const failed = sv?.units.some((u) => u.status === "failed") ?? false;
    return {
      stageId,
      startedAt,
      finishedAt,
      durationMs,
      status: failed ? "failed" : "completed",
    };
  });

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

export interface ResearchStageRow {
  stageId: ResearchPipelineStage;
  /** The engine's recorded status, or "pending" when the stage never ran. */
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
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
): Promise<{
  engineJobId: string;
  jobState: string;
  engineRunId: string | null;
  storageMode: ResearchStorageMode;
  stages: ResearchStageRow[];
}> {
  const engineJobId = researchEngineJobId(input.runId);
  const { storageMode, stores, runRecorder } = resolveResearchEngineAdapters(input);
  const control = new JobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "sync",
  });
  // No definition yet = the run never started; the six stages are pending,
  // not missing (the page still shows what can be started).
  const view = await control.getJob(engineJobId).catch(() => null);
  const stages: ResearchStageRow[] = RESEARCH_PIPELINE_STAGES.map((stageId) => {
    const found = view?.stages.find((stage) => stage.kind === stageId) ?? null;
    const units = found?.units ?? [];
    const failed = units.some((unit) => unit.status === "failed");
    const running = units.some((unit) => unit.status === "running");
    const stopped = units.some((unit) => unit.status === "stopped");
    const status = !found
      ? "pending"
      : failed
        ? "failed"
        : running
          ? "running"
          : stopped
            ? "stopped"
            : units.length === 0
              ? "pending"
              : "completed";
    return {
      stageId,
      status,
      startedAt: found?.startedAt ?? null,
      endedAt: found?.endedAt ?? null,
      durationMs: found?.durationMs ?? null,
    };
  });
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
  researchDeps?: ResearchStepDeps;
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
  const deps: ResearchStepDeps = input.researchDeps ?? {
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
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder,
    publisher: null,
    steps: registerResearchSteps(createBuiltinStepRegistry(), deps),
    invocation: "sync",
  });

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
