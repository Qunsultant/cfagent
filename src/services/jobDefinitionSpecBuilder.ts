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

export interface RawJobConfig {
  jobId: string;
  name: string;
  root: Record<string, unknown>;
  executionMode?: Record<string, string>;
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

function nodeFromStage(stage: JobStageSpec): Record<string, unknown> {
  const children = stage.children?.length ? stage.children.map(nodeFromStage) : undefined;
  return {
    kind: stage.kind,
    steps: [
      {
        step: stage.step,
        ...(stage.params ? { params: stage.params } : {}),
      },
    ],
    ...(children ? { children } : {}),
  };
}

function chain(stages: JobStageSpec[]): Record<string, unknown> {
  const [head, ...rest] = stages;
  const node = nodeFromStage(head);
  if (rest.length === 0) return node;
  const existing = Array.isArray(node.children) ? node.children : [];
  return { ...node, children: [...existing, chain(rest)] };
}

/** The engine's raw config for one spec + one concrete job id. */
export function buildJobConfigFromSpec(
  spec: JobDefinitionSpec,
  jobId: string,
  params: Record<string, unknown> = {},
): RawJobConfig {
  const schedule = spec.schedule;
  return {
    jobId,
    name: `${spec.name} (${jobId})`,
    root: withParams(chain(spec.stages), params),
    ...(spec.executionMode
      ? { executionMode: spec.executionMode as unknown as Record<string, string> }
      : {}),
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
