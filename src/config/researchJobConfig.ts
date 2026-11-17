/**
 * Issue #5119 (#5109 Sub-issue 3: AOP compliance) — Externalized configuration
 * for the nightly OODA research engine job (`research:<runId>`).
 *
 * All timings, OODA budget, guard window (21:00–21:30 UTC), concurrency caps,
 * and §10 AOP rule flags live here rather than as inline literals.
 */

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
}

export const DEFAULT_RESEARCH_JOB_CONFIG: Readonly<ResearchJobConfig> = {
  oodaBudgetMs: 90_000,
  scheduleUtcHour: 21,
  scheduleWindowMinutes: 30,
  maxParallelCandidates: 4,
  retryMaxAttempts: 2,
  evaluationLookbackHours: 24,
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
