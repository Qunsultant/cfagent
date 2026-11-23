/**
 * Issue #5282 — Explicit opt-in in-memory execution for any J-stack stage
 * with named ephemeral guarantees (never a silent production fallback).
 */
import { createInMemoryJobPipelineStores } from "../data/inMemoryJobPipelineAdapter";
import {
  EPHEMERAL_GUARANTEE_CONTRACT,
  type JobExecutionMode,
} from "../data/jobPipelinePorts";
import { createJobPipelineControl } from "./jobPipelineControlFactory";
import { buildEphemeralGuaranteeNotice } from "./jobPipelineConfig";
import type { JobStepRegistry } from "./jobPipelineSteps";

export interface RunStageInMemoryInput {
  jobId: string;
  stageId: string;
  step: string;
  params?: Record<string, unknown>;
  steps: JobStepRegistry;
  mode?: Partial<JobExecutionMode>;
  /** Must explicitly opt in (`optIn: true`); refuses implicit fallback. */
  optIn: boolean;
}

export interface RunStageInMemoryResult {
  jobId: string;
  stageId: string;
  state: string;
  durability: "in-memory";
  ephemeralGuarantees: typeof EPHEMERAL_GUARANTEE_CONTRACT;
  notice: string;
}

export async function runStageInMemory(
  input: RunStageInMemoryInput,
): Promise<RunStageInMemoryResult> {
  if (!input.optIn) {
    throw new Error(
      `Refusing implicit in-memory execution for stage "${input.stageId}": opt-in must be explicit (optIn: true).`,
    );
  }
  const stores = createInMemoryJobPipelineStores();
  const mode: JobExecutionMode = {
    concurrency: input.mode?.concurrency ?? "sequential",
    pacing: input.mode?.pacing ?? "batch",
    delivery: "sync",
    shape: input.mode?.shape ?? "monolith",
    durability: "in-memory",
  };
  const notice = buildEphemeralGuaranteeNotice(input.stageId, mode)!;
  // Issue #6250 — the in-memory stage run builds through the ONE
  // factory too (no env in scope and no durable sink: a bare control,
  // exactly as before — the explicit opt-in ephemeral execution).
  const control = createJobPipelineControl({
    stores,
    runRecorder: {
      recordRun: async () => {},
      listRuns: async () => [],
      latestRun: async () => undefined,
    },
    publisher: null,
    steps: input.steps,
    invocation: "sync",
  });
  await control.defineJob({
    jobId: input.jobId,
    name: `In-memory stage ${input.stageId}`,
    root: {
      kind: input.stageId,
      executionMode: mode,
      steps: [{ step: input.step, params: input.params ?? {} }],
    },
  });
  const dispatch = await control.runJob(input.jobId, { trigger: "manual" });
  const outcome = dispatch.completion ? await dispatch.completion : null;
  return {
    jobId: input.jobId,
    stageId: input.stageId,
    state: outcome?.state ?? dispatch.state,
    durability: "in-memory",
    ephemeralGuarantees: EPHEMERAL_GUARANTEE_CONTRACT,
    notice: notice.notice,
  };
}
