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
  DEFAULT_RESEARCH_SETTLEMENT_WAIT_MS,
  DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS,
  DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS,
  EXECUTION_MODE_AXES,
  RESEARCH_STAGE_KINDS,
  mergeResearchStageModes,
  mergeResearchStageRetryBuckets,
  mergeResearchStageTimeouts,
  readResearchSettlementWaitMs,
  readResearchStageModes,
  readResearchStageRetryBuckets,
  readResearchStageTimeouts,
  type ExecutionModeAxis,
  type ResearchStageKind,
  type ResearchStageModes,
  type ResearchStageRetryBuckets,
  type ResearchStageTimeouts,
  type StageRetryBucket,
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
  /**
   * Issue #6466 part 3 — the dispatch settlement wait: the deployment
   * resolution (`RESEARCH_SETTLEMENT_WAIT_MS`, or the 120 s default), any
   * carrier error, the effective value (stored wins) and which carrier
   * supplied it.
   */
  settlementWaitMs: {
    deploymentMs: number;
    errors: string[];
    effectiveMs: number;
    source: "stored" | "deployment";
  };
  /**
   * Issue #6466 part 4 — the per-stage timeouts: the effective merge (stored
   * over deployment over the recorded defaults), per stage which carrier
   * supplied it ("deployment" = the deployment resolution, recorded defaults
   * included), and any deployment-carrier error.
   */
  stageTimeouts: {
    effective: Record<ResearchStageKind, number>;
    sources: Partial<Record<ResearchStageKind, "stored" | "deployment">>;
    errors: string[];
  };
  /**
   * Issue #6466 part 4 — the per-stage retry buckets: same shape as the
   * timeouts (stored over deployment over the recorded defaults).
   */
  stageRetryBuckets: {
    effective: Record<ResearchStageKind, StageRetryBucket>;
    sources: Partial<Record<ResearchStageKind, "stored" | "deployment">>;
    errors: string[];
  };
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

function describeLimitSources<T>(
  effective: Partial<Record<ResearchStageKind, T>>,
  stored: Partial<Record<ResearchStageKind, T>>,
): Partial<Record<ResearchStageKind, "stored" | "deployment">> {
  const sources: Partial<Record<ResearchStageKind, "stored" | "deployment">> = {};
  for (const stage of Object.keys(effective) as ResearchStageKind[]) {
    // "deployment" is the deployment resolution — the carrier plus the
    // recorded defaults it falls back to. Only a stored override is "stored".
    sources[stage] = stored[stage] !== undefined ? "stored" : "deployment";
  }
  return sources;
}

export function describeResearchExecution(
  env: Record<string, string | undefined> | undefined,
  config: {
    stageModes?: ResearchStageModes | null;
    stageTimeouts?: ResearchStageTimeouts | null;
    stageRetryBuckets?: ResearchStageRetryBuckets | null;
    settlementWaitMs?: number | null;
  },
): ResearchExecutionDescription {
  const deployment = readResearchStageModes(env);
  const stored = config.stageModes ?? {};
  const effectiveModes = mergeResearchStageModes(deployment.modes, stored);

  // Issue #6466 part 3 — the settlement wait: stored wins, then the
  // deployment carrier, then the default. A broken carrier is reported and
  // the default governs (the dispatch resolver throws instead; the
  // description never does).
  const waitDeployment = readResearchSettlementWaitMs(env);
  const waitStored = config.settlementWaitMs ?? null;
  const waitDeploymentMs = waitDeployment.waitMs ?? DEFAULT_RESEARCH_SETTLEMENT_WAIT_MS;
  const waitEffectiveMs = waitStored !== null ? waitStored : waitDeploymentMs;
  const waitSource = waitStored !== null ? "stored" : "deployment";

  // Issue #6466 part 4 — the stage timeouts and retry buckets: stored over
  // deployment over the recorded defaults, per stage.
  const timeoutsDeployment = readResearchStageTimeouts(env);
  const timeoutsStored = config.stageTimeouts ?? {};
  const timeoutsEffective = mergeResearchStageTimeouts(
    mergeResearchStageTimeouts(DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS, timeoutsDeployment.timeouts),
    timeoutsStored,
  );
  const bucketsDeployment = readResearchStageRetryBuckets(env);
  const bucketsStored = config.stageRetryBuckets ?? {};
  const bucketsEffective = mergeResearchStageRetryBuckets(
    mergeResearchStageRetryBuckets(DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS, bucketsDeployment.retryBuckets),
    bucketsStored,
  );

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
    settlementWaitMs: {
      deploymentMs: waitDeploymentMs,
      errors: waitDeployment.errors,
      effectiveMs: waitEffectiveMs,
      source: waitSource,
    },
    stageTimeouts: {
      effective: timeoutsEffective,
      sources: describeLimitSources(timeoutsEffective, timeoutsStored),
      errors: timeoutsDeployment.errors,
    },
    stageRetryBuckets: {
      effective: bucketsEffective,
      sources: describeLimitSources(bucketsEffective, bucketsStored),
      errors: bucketsDeployment.errors,
    },
    venues: {
      brokers: [...ROUTED_BROKER_IDS],
      modes: [...RESEARCH_VENUE_MODES],
      defaultBrokerId,
      defaultMode,
      defaultsError,
    },
  };
}
