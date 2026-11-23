/**
 * Issue #5119 (#5109 Sub-issue 3: AOP compliance) — Externalized configuration
 * for the nightly OODA research engine job (`research:<runId>`).
 *
 * All timings, OODA budget, guard window (21:00–21:30 UTC), concurrency caps,
 * and §10 AOP rule flags live here rather than as inline literals.
 */

import { ACCOUNT_TYPES } from "./accountBindings";

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
  const { modes, errors } = validateResearchStageModes(parsed, "RESEARCH_STAGE_MODES");
  if (errors.length > 0) throw new Error(errors[0]);
  return modes;
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
