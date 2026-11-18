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
import { createJobPipelineStoresFromSql } from "../data/createJobPipelinePorts";
import { createInMemoryJobPipelineStores } from "../data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../data/inMemoryJobRunRecordAdapter";
import { SqlJobRunRecordStore } from "../data/doSqliteJobRunRecordAdapter";
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
import { resolveResearchJobConfig } from "../config/researchJobConfig";
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
  return flags.isEnabled("research_engine_cutover");
}

export interface DispatchResearchEngineInput {
  runId?: string;
  userLogin: string;
  trigger: "manual" | "scheduled";
  sql?: SqlStorage;
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
  flags?: Pick<FeatureFlagPort, "isEnabled">;
  researchDeps?: ResearchStepDeps;
  execute: () => Promise<Record<string, unknown>>;
}

export interface DispatchResearchEngineResult {
  engineJobId: string;
  runId: string;
  trigger: "manual" | "scheduled";
  userLogin: string;
  stages: readonly ResearchPipelineStage[];
  stageVisibility: ResearchStageVisibility[];
  cutoverMode: "engine" | "direct_rollback";
  outcome: Record<string, unknown>;
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
  const config = resolveResearchJobConfig();
  assertResearchAopCompliance(config, { userLogin: input.userLogin });

  const runId = input.runId?.trim() || crypto.randomUUID();
  const engineJobId = researchEngineJobId(runId);

  const cutoverEnabled = await isResearchEngineCutoverEnabled(input.flags);
  if (!cutoverEnabled) {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const outcome = await input.execute();
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
      outcome,
    };
  }

  let capturedOutcome: Record<string, unknown> | undefined;
  const baseDeps: ResearchStepDeps = input.researchDeps ?? {
    runOodaAnalysis: async () => input.execute(),
  };
  const wiredDeps: ResearchStepDeps = {
    ...baseDeps,
    runOodaAnalysis: async (ctx) => {
      const result = await baseDeps.runOodaAnalysis(ctx);
      capturedOutcome = result as Record<string, unknown>;
      return result;
    },
  };

  const stores =
    input.stores ??
    (input.sql ? createJobPipelineStoresFromSql(input.sql) : createInMemoryJobPipelineStores());
  const runRecorder =
    input.runRecorder ??
    jobRunRecorderFromStore(
      input.sql ? new SqlJobRunRecordStore(input.sql) : new InMemoryJobRunRecordStore(),
    );
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

export interface ExecuteResearchStageControlInput extends ControlResearchStageInput {
  sql?: SqlStorage;
  stores?: JobPipelineDeps["stores"];
  runRecorder?: JobRunRecorder;
  researchDeps?: ResearchStepDeps;
}

export interface ExecuteResearchStageControlResult {
  ok: true;
  engineJobId: string;
  runId: string;
  stageId: ResearchPipelineStage;
  op: ResearchStageOp;
  userLogin: string;
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
  const stores =
    input.stores ??
    (input.sql ? createJobPipelineStoresFromSql(input.sql) : createInMemoryJobPipelineStores());
  const runRecorder =
    input.runRecorder ??
    jobRunRecorderFromStore(
      input.sql ? new SqlJobRunRecordStore(input.sql) : new InMemoryJobRunRecordStore(),
    );
  const deps: ResearchStepDeps = input.researchDeps ?? {
    runOodaAnalysis: async (ctx) => ({
      ok: true,
      runId: ctx.runId,
      stageId: validated.stageId,
      userLogin: ctx.userLogin,
    }),
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
    jobState: after.instance?.state ?? "idle",
    engineRunId: after.instance?.currentRunId ?? after.latestRun?.operation ?? null,
    stage: stageAfter,
  };
}
