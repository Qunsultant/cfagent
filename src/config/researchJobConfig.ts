/**
 * Issue #5119 (#5109 Sub-issue 3: AOP compliance) — Externalized configuration
 * for the nightly OODA research engine job (`research:<runId>`).
 *
 * All timings, OODA budget, guard window (21:00–21:30 UTC), concurrency caps,
 * and §10 AOP rule flags live here rather than as inline literals.
 */

import { ACCOUNT_TYPES } from "./accountBindings";
import { isRetryBucketName, RETRY_BUCKET_NAMES } from "../services/pipelinePolicy";
import type { StageRetryBucket } from "../workflows/stageRunnerPorts";

export type ResearchStorageMode = "durable" | "in-memory";
export type ResearchAccountType = (typeof ACCOUNT_TYPES)[number];

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
/**
 * Issue #5975 — validate one parsed stage-mode map, returning the modes and
 * the errors by name instead of throwing. One rule for both carriers: the
 * deployment default (`RESEARCH_STAGE_MODES`, JSON) and the stored
 * `ResearchConfig.stageModes` (persisted through the settings API) are judged
 * by this function, and `source` names the carrier in the message.
 */
export function validateResearchStageModes(
  parsed: unknown,
  source: string = "RESEARCH_STAGE_MODES",
): { modes: ResearchStageModes; errors: string[] } {
  const errors: string[] = [];
  const out: ResearchStageModes = {};
  if (parsed === null || parsed === undefined) return { modes: out, errors };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`${source} must be an object keyed by research stage kind.`);
    return { modes: out, errors };
  }
  for (const [stage, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(RESEARCH_STAGE_KINDS as readonly string[]).includes(stage)) {
      errors.push(
        `Unknown research stage "${stage}" in ${source}. Expected one of: ${RESEARCH_STAGE_KINDS.join(", ")}`,
      );
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${source}.${stage} must be an object keyed by execution-mode axis.`);
      continue;
    }
    const axes: Partial<Record<ExecutionModeAxis, string>> = {};
    for (const [axis, mode] of Object.entries(value as Record<string, unknown>)) {
      if (!(EXECUTION_MODE_AXES as readonly string[]).includes(axis)) {
        errors.push(
          `Unknown execution-mode axis "${axis}" for research stage "${stage}". Expected one of: ${EXECUTION_MODE_AXES.join(", ")}`,
        );
        continue;
      }
      if (typeof mode !== "string" || !mode.trim()) {
        errors.push(`${source}.${stage}.${axis} must be a non-empty string.`);
        continue;
      }
      axes[axis as ExecutionModeAxis] = mode.trim();
    }
    out[stage as ResearchStageKind] = axes;
  }
  return { modes: out, errors };
}

/**
 * Issue #5975 — the effective per-stage modes: the stored configuration wins
 * over the deployment default, per stage and per axis, and a stage present in
 * only one of them survives. Nothing is dropped and nothing is invented.
 */
export function mergeResearchStageModes(
  base: ResearchStageModes,
  override?: ResearchStageModes | null,
): ResearchStageModes {
  const out: ResearchStageModes = {};
  for (const [stage, axes] of Object.entries(base)) {
    out[stage as ResearchStageKind] = { ...axes };
  }
  for (const [stage, axes] of Object.entries(override ?? {})) {
    const key = stage as ResearchStageKind;
    out[key] = { ...(out[key] ?? {}), ...axes };
  }
  return out;
}

/**
 * Issue #5975 (UX slice) — read the deployment carrier without throwing, so a
 * surface that only *describes* the configuration reports a broken default
 * beside the read instead of failing. `resolveResearchStageModes` is the
 * throwing form the dispatch uses, over this same parse.
 */
export function readResearchStageModes(env?: Record<string, string | undefined>): {
  modes: ResearchStageModes;
  errors: string[];
} {
  const raw = env?.RESEARCH_STAGE_MODES;
  if (!raw || !raw.trim()) return { modes: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      modes: {},
      errors: [
        "RESEARCH_STAGE_MODES is not valid JSON; expected { <stage>: { <axis>: <value> } }.",
      ],
    };
  }
  return validateResearchStageModes(parsed, "RESEARCH_STAGE_MODES");
}

export function resolveResearchStageModes(
  env?: Record<string, string | undefined>,
): ResearchStageModes {
  const { modes, errors } = readResearchStageModes(env);
  if (errors.length > 0) throw new Error(errors[0]);
  return modes;
}

/**
 * Issue #5109, Fix 2 — the resilient per-stage deadlines (ms) for the
 * OODA job, in the survey's §2 combination: feed 240,000 (quotes for
 * ≤36 symbols complete well inside it), analyze/enrich/generate/
 * evaluate 600,000 (the engine's stage default), deliver 300,000.
 * The research job has no run deadline (the run race applies to feed
 * jobs only), so these are standalone per-stage budgets, consumed by
 * the engine through the `perStage` carrier — never a second literal.
 */
export const DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS: Readonly<Record<ResearchStageKind, number>> = {
  feed: 240_000,
  enrich: 600_000,
  analyze: 600_000,
  generate: 600_000,
  deliver: 300_000,
  evaluate: 600_000,
};

/**
 * Issue #5109, Fix 2 — the per-stage retry bucket for the OODA job, in
 * the survey's §2 combination. Analyze stays on `report`, never
 * `acquisition`: a third attempt would re-run the whole OODA loop a
 * third time. `timed_out` is never retried at the engine level (G4).
 */
export const DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS: Readonly<
  Record<ResearchStageKind, StageRetryBucket>
> = {
  feed: "acquisition",
  enrich: "report",
  analyze: "report",
  generate: "report",
  deliver: "delivery",
  evaluate: "report",
};

/** Issue #5109, Fix 2 — per-stage timeout overrides, keyed by stage kind. */
export type ResearchStageTimeouts = Partial<Record<ResearchStageKind, number>>;

/** Issue #5109, Fix 2 — per-stage retry-bucket overrides, keyed by stage kind. */
export type ResearchStageRetryBuckets = Partial<Record<ResearchStageKind, StageRetryBucket>>;

/**
 * Issue #5109, Fix 2 — validate one parsed stage-timeout map, returning
 * the timeouts and the errors by name instead of throwing. One rule for
 * the carrier: an unknown stage kind, a non-integer, or a non-positive
 * value refuses by name — a typo must not silently keep the default.
 */
export function validateResearchStageTimeouts(
  parsed: unknown,
  source: string = "RESEARCH_STAGE_TIMEOUTS_MS",
): { timeouts: ResearchStageTimeouts; errors: string[] } {
  const errors: string[] = [];
  const out: ResearchStageTimeouts = {};
  if (parsed === null || parsed === undefined) return { timeouts: out, errors };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`${source} must be an object keyed by research stage kind.`);
    return { timeouts: out, errors };
  }
  for (const [stage, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(RESEARCH_STAGE_KINDS as readonly string[]).includes(stage)) {
      errors.push(
        `Unknown research stage "${stage}" in ${source}. Expected one of: ${RESEARCH_STAGE_KINDS.join(", ")}`,
      );
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      errors.push(`${source}.${stage} must be a positive integer number of milliseconds.`);
      continue;
    }
    out[stage as ResearchStageKind] = value;
  }
  return { timeouts: out, errors };
}

/**
 * Issue #5109, Fix 2 — validate one parsed stage-retry-bucket map, returning
 * the buckets and the errors by name instead of throwing. Bucket names
 * are the policy's own (`RETRY_BUCKET_NAMES`) — never a second list.
 */
export function validateResearchStageRetryBuckets(
  parsed: unknown,
  source: string = "RESEARCH_STAGE_RETRY_BUCKETS",
): { retryBuckets: ResearchStageRetryBuckets; errors: string[] } {
  const errors: string[] = [];
  const out: ResearchStageRetryBuckets = {};
  if (parsed === null || parsed === undefined) return { retryBuckets: out, errors };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`${source} must be an object keyed by research stage kind.`);
    return { retryBuckets: out, errors };
  }
  for (const [stage, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(RESEARCH_STAGE_KINDS as readonly string[]).includes(stage)) {
      errors.push(
        `Unknown research stage "${stage}" in ${source}. Expected one of: ${RESEARCH_STAGE_KINDS.join(", ")}`,
      );
      continue;
    }
    if (!isRetryBucketName(value)) {
      errors.push(
        `Unknown retry bucket ${JSON.stringify(value)} for research stage "${stage}" in ${source}. Expected one of: ${RETRY_BUCKET_NAMES.join(", ")}`,
      );
      continue;
    }
    out[stage as ResearchStageKind] = value;
  }
  return { retryBuckets: out, errors };
}

/**
 * Issue #5109, Fix 2 — read the deployment timeout carrier without
 * throwing, so a surface that only *describes* the configuration reports
 * a broken default beside the read instead of failing.
 */
export function readResearchStageTimeouts(env?: Record<string, string | undefined>): {
  timeouts: ResearchStageTimeouts;
  errors: string[];
} {
  const raw = env?.RESEARCH_STAGE_TIMEOUTS_MS;
  if (!raw || !raw.trim()) return { timeouts: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      timeouts: {},
      errors: [
        "RESEARCH_STAGE_TIMEOUTS_MS is not valid JSON; expected { <stage>: <milliseconds> }.",
      ],
    };
  }
  return validateResearchStageTimeouts(parsed, "RESEARCH_STAGE_TIMEOUTS_MS");
}

/** Issue #5109, Fix 2 — read the deployment retry-bucket carrier without throwing. */
export function readResearchStageRetryBuckets(env?: Record<string, string | undefined>): {
  retryBuckets: ResearchStageRetryBuckets;
  errors: string[];
} {
  const raw = env?.RESEARCH_STAGE_RETRY_BUCKETS;
  if (!raw || !raw.trim()) return { retryBuckets: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      retryBuckets: {},
      errors: [
        "RESEARCH_STAGE_RETRY_BUCKETS is not valid JSON; expected { <stage>: <bucket> }.",
      ],
    };
  }
  return validateResearchStageRetryBuckets(parsed, "RESEARCH_STAGE_RETRY_BUCKETS");
}

/**
 * Issue #5109, Fix 2 — the effective per-stage timeouts: the deployment
 * carrier overrides the recorded defaults, per stage; a stage present
 * in only one of them survives. Nothing is dropped and nothing is
 * invented. Throws on the first validation error, like
 * `resolveResearchStageModes`.
 */
export function resolveResearchStageTimeouts(
  env?: Record<string, string | undefined>,
): Record<ResearchStageKind, number> {
  const { timeouts, errors } = readResearchStageTimeouts(env);
  if (errors.length > 0) throw new Error(errors[0]);
  return mergeResearchStageTimeouts(DEFAULT_RESEARCH_STAGE_TIMEOUTS_MS, timeouts);
}

/** Issue #5109, Fix 2 — the effective per-stage retry buckets (same rule). */
export function resolveResearchStageRetryBuckets(
  env?: Record<string, string | undefined>,
): Record<ResearchStageKind, StageRetryBucket> {
  const { retryBuckets, errors } = readResearchStageRetryBuckets(env);
  if (errors.length > 0) throw new Error(errors[0]);
  return mergeResearchStageRetryBuckets(DEFAULT_RESEARCH_STAGE_RETRY_BUCKETS, retryBuckets);
}

/** Issue #5109, Fix 2 — merge one stage-timeout override over a base table. */
export function mergeResearchStageTimeouts(
  base: Readonly<Record<ResearchStageKind, number>>,
  override?: ResearchStageTimeouts | null,
): Record<ResearchStageKind, number> {
  return { ...base, ...(override ?? {}) };
}

/** Issue #5109, Fix 2 — merge one stage-retry-bucket override over a base table. */
export function mergeResearchStageRetryBuckets(
  base: Readonly<Record<ResearchStageKind, StageRetryBucket>>,
  override?: ResearchStageRetryBuckets | null,
): Record<ResearchStageKind, StageRetryBucket> {
  return { ...base, ...(override ?? {}) };
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
  /** Account class whose tenant binding is recorded with OODA evidence. */
  accountBindingType: ResearchAccountType;
}

export const DEFAULT_RESEARCH_JOB_CONFIG: Readonly<ResearchJobConfig> = {
  oodaBudgetMs: 90_000,
  scheduleUtcHour: 21,
  scheduleWindowMinutes: 30,
  maxParallelCandidates: 4,
  retryMaxAttempts: 2,
  evaluationLookbackHours: 24,
  storageMode: "durable",
  accountBindingType: "options",
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
  const accountBindingType = env?.RESEARCH_ACCOUNT_BINDING_TYPE ?? DEFAULT_RESEARCH_JOB_CONFIG.accountBindingType;
  if (!(ACCOUNT_TYPES as readonly string[]).includes(accountBindingType)) {
    throw new Error(`RESEARCH_ACCOUNT_BINDING_TYPE must be one of: ${ACCOUNT_TYPES.join(", ")}`);
  }
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
    accountBindingType: accountBindingType as ResearchAccountType,
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
