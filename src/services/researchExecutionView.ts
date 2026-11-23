/**
 * Issue #5975 (UX slice, #6289) — one read model for "what will the next run
 * execute".
 *
 * The settings page must show, and the operator must be able to change, the one
 * execution configuration a run resolves: the six stage kinds, the four mode
 * axes, the deployment default (`RESEARCH_STAGE_MODES`), the stored overrides
 * (`ResearchConfig.stageModes`, #6268), the effective merge with the source of
 * every mode, and the venue catalogue a run may name (#6036).
 *
 * Every list comes from its declaring module — `RESEARCH_STAGE_KINDS`,
 * `EXECUTION_MODE_AXES`, `ROUTED_BROKER_IDS`, `RESEARCH_VENUE_MODES`, and the
 * venue resolver's own default. Nothing here is a client copy, a second mode
 * model, or a new store; this module only describes what the existing pieces
 * already decide.
 */
import {
  EXECUTION_MODE_AXES,
  RESEARCH_STAGE_KINDS,
  mergeResearchStageModes,
  readResearchStageModes,
  type ExecutionModeAxis,
  type ResearchStageKind,
  type ResearchStageModes,
} from "../config/researchJobConfig";
import { ROUTED_BROKER_IDS } from "../trading";
import { RESEARCH_VENUE_MODES, resolveResearchVenue } from "./researchVenue";

/** Which carrier a stage mode came from. An unset axis runs the job mode. */
export type ResearchModeSource = "stored" | "deployment";

export interface ResearchExecutionDescription {
  /** The six stage kinds, in execution order (the declaring constant). */
  stages: ResearchStageKind[];
  /** The four execution-mode axes (the declaring constant). */
  axes: ExecutionModeAxis[];
  /** The deployment default (`RESEARCH_STAGE_MODES`), verbatim. */
  deploymentModes: ResearchStageModes;
  /** Why the deployment default was unusable; empty when it parsed cleanly. */
  deploymentErrors: string[];
  /** Stored over the deployment default, per stage and per axis. */
  effectiveModes: ResearchStageModes;
  /** Per stage and axis, which carrier the effective value came from. */
  modeSources: Partial<
    Record<ResearchStageKind, Partial<Record<ExecutionModeAxis, ResearchModeSource>>>
  >;
  venues: {
    /** Registered brokers a run may name (the trading catalogue). */
    brokers: string[];
    /** Accepted trade modes for a research run. */
    modes: string[];
    /** The tenant default the resolver answers with — null if it refuses. */
    defaultBrokerId: string | null;
    defaultMode: string | null;
    /** The resolver's refusal, when the tenant default is not runnable. */
    defaultsError: string | null;
  };
}

function describeModeSources(
  effective: ResearchStageModes,
  stored: ResearchStageModes,
): ResearchExecutionDescription["modeSources"] {
  const sources: ResearchExecutionDescription["modeSources"] = {};
  for (const [stage, axes] of Object.entries(effective) as Array<
    [ResearchStageKind, Partial<Record<ExecutionModeAxis, string>>]
  >) {
    const perAxis: Partial<Record<ExecutionModeAxis, ResearchModeSource>> = {};
    for (const axis of Object.keys(axes ?? {}) as ExecutionModeAxis[]) {
      perAxis[axis] = stored[stage]?.[axis] !== undefined ? "stored" : "deployment";
    }
    sources[stage] = perAxis;
  }
  return sources;
}

export function describeResearchExecution(
  env: Record<string, string | undefined> | undefined,
  config: { stageModes?: ResearchStageModes | null },
): ResearchExecutionDescription {
  const deployment = readResearchStageModes(env);
  const stored = config.stageModes ?? {};
  const effectiveModes = mergeResearchStageModes(deployment.modes, stored);

  let defaultBrokerId: string | null = null;
  let defaultMode: string | null = null;
  let defaultsError: string | null = null;
  try {
    const venue = resolveResearchVenue({});
    defaultBrokerId = venue.brokerId;
    defaultMode = venue.mode;
  } catch (err) {
    defaultsError = err instanceof Error ? err.message : String(err);
  }

  return {
    stages: [...RESEARCH_STAGE_KINDS],
    axes: [...EXECUTION_MODE_AXES],
    deploymentModes: deployment.modes,
    deploymentErrors: deployment.errors,
    effectiveModes,
    modeSources: describeModeSources(effectiveModes, stored),
    venues: {
      brokers: [...ROUTED_BROKER_IDS],
      modes: [...RESEARCH_VENUE_MODES],
      defaultBrokerId,
      defaultMode,
      defaultsError,
    },
  };
}
