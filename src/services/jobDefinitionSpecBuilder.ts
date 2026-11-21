/**
 * Issue #4366 — a validated definition spec → the engine's raw job config.
 *
 * One translation, so the UX flow and the screener builder cannot describe
 * the same spec differently: stages become the node chain (a stage's own
 * children nest inside it), the spec's mode becomes the root's execution
 * mode, and its schedule block rides the definition the engine stores.
 * Nothing is defaulted here — a spec that failed validation never reaches
 * this function.
 */
import type { JobDefinitionSpec, JobStageSpec } from "../config/jobDefinitionCatalog";
import type { JobExecutionMode } from "../data/jobPipelinePorts";
import type { StageRetryBucket } from "../workflows/stageRunnerPorts";

/** Issue #4466 — per-stage overrides the flow collects, keyed by stage kind. */
export interface JobDefinitionPerStage {
  params?: Record<string, Record<string, unknown>>;
  modes?: Record<string, Partial<JobExecutionMode>>;
  /** Issue #4479 — a stage's own cadence (engine `JobScheduleConfig` shape). */
  schedules?: Record<string, { enabled: boolean; cron?: string; interval?: string }>;
  /** Issue #4775 S1 — a stage's own per-unit deadline, in milliseconds. */
  timeouts?: Record<string, number>;
  /** Issue #4781 S2 — a stage's own fan-out cap. */
  maxParallel?: Record<string, number>;
  /** Issue #4781 S2 — a stage's own retry bucket. */
  retryBuckets?: Record<string, StageRetryBucket>;
  /**
   * Issue #4781 S2 — a stage's own processing overrides (checkpoint
   * interval). The spec declares no `processing`, so this is the
   * only way a spec-built node gets `checkpointEverySteps`.
   */
  processing?: Record<string, { checkpointEverySteps?: number }>;
}

export interface RawJobConfig {
  jobId: string;
  name: string;
  root: Record<string, unknown>;
  schedule?: { enabled: boolean; cron?: string; interval?: string };
}

function withParams(node: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const steps = Array.isArray(node.steps) ? (node.steps as Array<Record<string, unknown>>) : [];
  return {
    ...node,
    steps: steps.map((step) => ({
      ...step,
      params: { ...params, ...(step.params as Record<string, unknown> | undefined) },
    })),
    ...(Array.isArray(node.children)
      ? { children: (node.children as Array<Record<string, unknown>>).map((child) => withParams(child, params)) }
      : {}),
  };
}

function nodeFromStage(stage: JobStageSpec, perStage: JobDefinitionPerStage): Record<string, unknown> {
  const children = stage.children?.length
    ? stage.children.map((child) => nodeFromStage(child, perStage))
    : undefined;
  const stageParams = { ...(stage.params ?? {}), ...(perStage.params?.[stage.kind] ?? {}) };
  const mode = { ...(stage.executionMode ?? {}), ...(perStage.modes?.[stage.kind] ?? {}) };
  const schedule = { ...(stage.schedule ?? {}), ...(perStage.schedules?.[stage.kind] ?? {}) };
  const timeoutMs = perStage.timeouts?.[stage.kind];
  const maxParallel = perStage.maxParallel?.[stage.kind];
  const retryBucket = perStage.retryBuckets?.[stage.kind];
  const processing = perStage.processing?.[stage.kind];
  return {
    kind: stage.kind,
    steps: [
      {
        step: stage.step,
        ...(Object.keys(stageParams).length > 0 ? { params: stageParams } : {}),
      },
    ],
    ...(Object.keys(mode).length > 0 ? { executionMode: mode } : {}),
    ...(schedule.enabled ? { schedule } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxParallel !== undefined ? { maxParallel } : {}),
    ...(retryBucket !== undefined ? { retryBucket } : {}),
    ...(processing !== undefined ? { processing: { ...processing } } : {}),
    ...(children ? { children } : {}),
  };
}

function chain(stages: JobStageSpec[], perStage: JobDefinitionPerStage): Record<string, unknown> {
  const [head, ...rest] = stages;
  const node = nodeFromStage(head, perStage);
  if (rest.length === 0) return node;
  const existing = Array.isArray(node.children) ? node.children : [];
  return { ...node, children: [...existing, chain(rest, perStage)] };
}

/** The engine's raw config for one spec + one concrete job id. */
export function buildJobConfigFromSpec(
  spec: JobDefinitionSpec,
  jobId: string,
  params: Record<string, unknown> = {},
  perStage: JobDefinitionPerStage = {},
): RawJobConfig {
  const schedule = spec.schedule;
  const root = withParams(chain(spec.stages, perStage), params);
  // Issue #4773 — the spec's mode IS the root's execution mode. The
  // engine resolves the job-level mode from root.executionMode only, so
  // a top-level field never reaches a run (a spec-defined job silently
  // ran on the engine default instead of the spec's mode). The spec
  // default sits under any mode the root node already carries from a
  // stage-level override.
  const nodeMode = root.executionMode as Record<string, string> | undefined;
  const rootExecutionMode = { ...(spec.executionMode ?? {}), ...(nodeMode ?? {}) };
  return {
    jobId,
    name: `${spec.name} (${jobId})`,
    root: {
      ...root,
      ...(Object.keys(rootExecutionMode).length > 0
        ? { executionMode: rootExecutionMode }
        : {}),
    },
    ...(schedule
      ? {
          schedule: {
            enabled: false,
            ...(schedule.cron ? { cron: schedule.cron } : {}),
            ...(schedule.intervalSeconds !== undefined
              ? { interval: `${schedule.intervalSeconds}s` }
              : {}),
          },
        }
      : {}),
  };
}
