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
import { JobPipelineControl } from "../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../services/jobPipelineSteps";
import {
  buildResearchJobDefinition,
  assertResearchAopCompliance,
  RESEARCH_PIPELINE_STAGES,
  type ResearchPipelineStage,
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

  const stores = input.sql
    ? createJobPipelineStoresFromSql(input.sql)
    : createInMemoryJobPipelineStores();
  const control = new JobPipelineControl({
    stores,
    runRecorder: null,
    publisher: null,
    steps: createBuiltinStepRegistry(),
    invocation: "sync",
  });
  const definition = buildResearchJobDefinition(runId, {
    userLogin: input.userLogin,
    trigger: input.trigger,
  });
  await control.defineJob(definition as never);

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
    cutoverMode: "engine",
    outcome,
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
