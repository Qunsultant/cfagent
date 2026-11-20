/**
 * Issue #5119 (#5109 Sub-issue 3: AOP compliance) — Externalized configuration
 * for the nightly OODA research engine job (`research:<runId>`).
 *
 * All timings, OODA budget, guard window (21:00–21:30 UTC), concurrency caps,
 * and §10 AOP rule flags live here rather than as inline literals.
 */

export type ResearchStorageMode = "durable" | "in-memory";

/** Issue #5916 — the six research stages, in execution order. */
export const RESEARCH_STAGE_KINDS = [
  "feed",
  "enrich",
  "analyze",
  "generate",
  "deliver",
  "evaluate",
] as const;
export type ResearchStageKind = (typeof RESEARCH_STAGE_KINDS)[number];

/** Issue #5916 — the four execution-mode axes a stage may override. */
export const EXECUTION_MODE_AXES = ["concurrency", "pacing", "delivery", "shape"] as const;
export type ExecutionModeAxis = (typeof EXECUTION_MODE_AXES)[number];

/**
 * Issue #5916 — per-stage overrides, keyed by stage kind. Unset stages run
 * the job's mode; nothing is inferred and no stage gets a different default.
 */
export type ResearchStageModes = Partial<
  Record<ResearchStageKind, Partial<Record<ExecutionModeAxis, string>>>
>;

/**
 * Issue #5916 — read the per-stage overrides from one config value
 * (`RESEARCH_STAGE_MODES`, JSON). An unknown stage kind or axis refuses by
 * name instead of being dropped: a typo must not silently keep the job mode.
 */
export function resolveResearchStageModes(
  env?: Record<string, string | undefined>,
): ResearchStageModes {
  const raw = env?.RESEARCH_STAGE_MODES;
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RESEARCH_STAGE_MODES is not valid JSON; expected { <stage>: { <axis>: <value> } }.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RESEARCH_STAGE_MODES must be an object keyed by research stage kind.");
  }
  const out: ResearchStageModes = {};
  for (const [stage, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(RESEARCH_STAGE_KINDS as readonly string[]).includes(stage)) {
      throw new Error(
        `Unknown research stage "${stage}" in RESEARCH_STAGE_MODES. Expected one of: ${RESEARCH_STAGE_KINDS.join(", ")}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`RESEARCH_STAGE_MODES.${stage} must be an object keyed by execution-mode axis.`);
    }
    const axes: Partial<Record<ExecutionModeAxis, string>> = {};
    for (const [axis, mode] of Object.entries(value as Record<string, unknown>)) {
      if (!(EXECUTION_MODE_AXES as readonly string[]).includes(axis)) {
        throw new Error(
          `Unknown execution-mode axis "${axis}" for research stage "${stage}". Expected one of: ${EXECUTION_MODE_AXES.join(", ")}`,
        );
      }
      if (typeof mode !== "string" || !mode.trim()) {
        throw new Error(`RESEARCH_STAGE_MODES.${stage}.${axis} must be a non-empty string.`);
      }
      axes[axis as ExecutionModeAxis] = mode;
    }
    out[stage as ResearchStageKind] = axes;
  }
  return out;
}

export interface ResearchJobConfig {
  /** Maximum wall-clock budget (ms) for one OODA analysis loop. */
  oodaBudgetMs: number;
  /** UTC hour (0-23) when the scheduled nightly research run opens. */
  scheduleUtcHour: number;
  /** Guard window duration in minutes starting at scheduleUtcHour:00 UTC. */
  scheduleWindowMinutes: number;
  /** Maximum concurrent candidate evaluations per OODA pass. */
  maxParallelCandidates: number;
  /** Maximum retry attempts for transient stage failures. */
  retryMaxAttempts: number;
  /** Minimum age (hours) before a published run is eligible for §9 evaluation. */
  evaluationLookbackHours: number;
  /** Storage/processing adapter mode for `research:<runId>` (`durable` default, `in-memory` optional). */
  storageMode: ResearchStorageMode;
}

/**
 * Issue #5912 — the venue a run uses when it names none. The historical
 * provider's id is the default; the selection is per run, and one config
 * value means no other surface hardcodes a broker id.
 */
export const DEFAULT_RESEARCH_BROKER_ID = "etrade";

export const DEFAULT_RESEARCH_JOB_CONFIG: Readonly<ResearchJobConfig> = {
  oodaBudgetMs: 90_000,
  scheduleUtcHour: 21,
  scheduleWindowMinutes: 30,
  maxParallelCandidates: 4,
  retryMaxAttempts: 2,
  evaluationLookbackHours: 24,
  storageMode: "durable",
};

/** Programme §10 AOP invariants pinned for the research engine job. */
export const RESEARCH_AOP_RULES = {
  configurable: true,
  storedDataOnly: true,
  durableResumableStages: true,
  ownerScopedReads: true,
  cappedParallel: true,
  fullProvenance: true,
} as const;

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveResearchJobConfig(
  env?: Record<string, string | undefined>,
): ResearchJobConfig {
  return {
    oodaBudgetMs: parseBoundedInt(
      env?.RESEARCH_OODA_BUDGET_MS,
      DEFAULT_RESEARCH_JOB_CONFIG.oodaBudgetMs,
      5_000,
      600_000,
    ),
    scheduleUtcHour: parseBoundedInt(
      env?.RESEARCH_SCHEDULE_UTC_HOUR,
      DEFAULT_RESEARCH_JOB_CONFIG.scheduleUtcHour,
      0,
      23,
    ),
    scheduleWindowMinutes: parseBoundedInt(
      env?.RESEARCH_SCHEDULE_WINDOW_MINUTES,
      DEFAULT_RESEARCH_JOB_CONFIG.scheduleWindowMinutes,
      1,
      180,
    ),
    maxParallelCandidates: parseBoundedInt(
      env?.RESEARCH_MAX_PARALLEL,
      DEFAULT_RESEARCH_JOB_CONFIG.maxParallelCandidates,
      1,
      16,
    ),
    retryMaxAttempts: parseBoundedInt(
      env?.RESEARCH_RETRY_MAX_ATTEMPTS,
      DEFAULT_RESEARCH_JOB_CONFIG.retryMaxAttempts,
      0,
      5,
    ),
    evaluationLookbackHours: parseBoundedInt(
      env?.RESEARCH_EVAL_LOOKBACK_HOURS,
      DEFAULT_RESEARCH_JOB_CONFIG.evaluationLookbackHours,
      1,
      168,
    ),
    storageMode:
      env?.RESEARCH_STORAGE_MODE === "in-memory"
        ? "in-memory"
        : DEFAULT_RESEARCH_JOB_CONFIG.storageMode,
  };
}

/**
 * Check whether `now` falls inside the configured UTC guard window
 * (default 21:00–21:30 UTC).
 */
export function isWithinResearchGuardWindow(
  now: Date,
  config: Pick<ResearchJobConfig, "scheduleUtcHour" | "scheduleWindowMinutes"> = DEFAULT_RESEARCH_JOB_CONFIG,
): boolean {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const windowStart = config.scheduleUtcHour * 60;
  const windowEnd = windowStart + config.scheduleWindowMinutes;
  return utcMinutes >= windowStart && utcMinutes < windowEnd;
}
