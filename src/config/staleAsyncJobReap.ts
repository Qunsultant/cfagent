/**
 * Issue #6503 step 13 — the stale-async-job reap policy, externalized.
 *
 * The reap is the backstop that fails a `running` async job whose
 * executor is dead: a row older than the reap window with a stale
 * heartbeat (or, for pre-heartbeat rows, older than the window on
 * `started_at` alone) is failed on read and by the scheduled sweep,
 * which examines at most the batch limit of running rows per tick
 * (oldest first; the rest wait for the next tick). The literals
 * were module-private constants in
 * `src/agents/orchestrator/asyncJobs.ts` (`STALE_RUNNING_REAP_MS`
 * = 2h, `STALE_SWEEP_BATCH_LIMIT` = 100) — the defaults below ARE
 * those literals, unchanged: with no managed or env value a stale
 * row reaps exactly as today.
 *
 * Precedence: managed setting (mas_settings
 * `asyncJob.staleRunningReapMs` / `asyncJob.staleSweepBatchLimit`,
 * settable through the schedules-home controls surface) > env
 * carrier (`ASYNC_JOB_STALE_RUNNING_REAP_MS` /
 * `ASYNC_JOB_STALE_SWEEP_BATCH_LIMIT`, new — there was no env
 * carrier for either knob) > default (2h / 100). The reap window
 * must be a positive whole number of milliseconds and the batch
 * limit a positive whole number of rows; anything else falls
 * through to the next source. There is no disabling value: a zero
 * reap window would fail every live row, and a zero batch would
 * stop the sweep.
 *
 * The read path resolves through the context's settings reader
 * (`AsyncJobsContext.readSettingRaw`, the #3922 seam — the
 * orchestrator builder wires it to the instance's mas_settings
 * read), so the managed leg is live in production, not just
 * declared. Callers without that reader (tests, bare contexts)
 * fall back to env/default.
 *
 * This module is pure (no imports): the src/config/*Modes.ts idiom
 * (mirrors src/config/scheduleFiringRateAlert.ts).
 */

/** The env carrier for the reap window (new — the reap had no env carrier before step 13). */
export const STALE_RUNNING_REAP_ENV_VAR = "ASYNC_JOB_STALE_RUNNING_REAP_MS";

/** The env carrier for the sweep batch limit (new). */
export const STALE_SWEEP_BATCH_LIMIT_ENV_VAR = "ASYNC_JOB_STALE_SWEEP_BATCH_LIMIT";

/** The managed-setting key for the reap window (mas_settings). */
export const STALE_RUNNING_REAP_SETTING_KEY = "asyncJob.staleRunningReapMs";

/** The managed-setting key for the sweep batch limit (mas_settings). */
export const STALE_SWEEP_BATCH_LIMIT_SETTING_KEY = "asyncJob.staleSweepBatchLimit";

/** The built-in default reap window: 2 hours, in milliseconds — the #3784 literal, unchanged. */
export const DEFAULT_STALE_RUNNING_REAP_MS = 2 * 60 * 60 * 1000;

/** The built-in default sweep batch limit: 100 running rows per tick — the #3784 literal, unchanged. */
export const DEFAULT_STALE_SWEEP_BATCH_LIMIT = 100;

/**
 * Parse a reap window in milliseconds: a positive whole number,
 * or undefined (non-numeric, non-finite, zero, negative, or
 * fractional — falls through to the next source). Strings parse
 * as numbers so managed settings (stored as text) resolve the
 * same way as env carriers.
 */
export function parseStaleRunningReapMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Parse a sweep batch limit in rows: a positive whole number, or
 * undefined (non-numeric, non-finite, zero, negative, or
 * fractional — falls through to the next source).
 */
export function parseStaleSweepBatchLimit(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Where the effective reap value came from (named for the home + the audit trail). */
export type StaleAsyncJobReapSource = "managed" | "env" | "default";

/** Resolve the reap window from already-read sources: managed > env > default (2h). */
export function resolveStaleRunningReapMs(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseStaleRunningReapMs(input.managed) ??
    parseStaleRunningReapMs(input.env) ??
    DEFAULT_STALE_RUNNING_REAP_MS
  );
}

/** Name the winning reap-window source for the same inputs. */
export function staleRunningReapSource(input: {
  managed?: unknown;
  env?: unknown;
}): StaleAsyncJobReapSource {
  if (parseStaleRunningReapMs(input.managed) !== undefined) return "managed";
  if (parseStaleRunningReapMs(input.env) !== undefined) return "env";
  return "default";
}

/** Resolve the sweep batch limit from already-read sources: managed > env > default (100). */
export function resolveStaleSweepBatchLimit(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseStaleSweepBatchLimit(input.managed) ??
    parseStaleSweepBatchLimit(input.env) ??
    DEFAULT_STALE_SWEEP_BATCH_LIMIT
  );
}

/** Name the winning batch-limit source for the same inputs. */
export function staleSweepBatchLimitSource(input: {
  managed?: unknown;
  env?: unknown;
}): StaleAsyncJobReapSource {
  if (parseStaleSweepBatchLimit(input.managed) !== undefined) return "managed";
  if (parseStaleSweepBatchLimit(input.env) !== undefined) return "env";
  return "default";
}

/** Both reap values, resolved together from already-read sources: managed > env > default. */
export interface StaleAsyncJobReapPolicy {
  reapMs: number;
  batchLimit: number;
}

export function resolveStaleAsyncJobReapPolicy(input: {
  managedReapMs?: unknown;
  envReapMs?: unknown;
  managedBatchLimit?: unknown;
  envBatchLimit?: unknown;
}): StaleAsyncJobReapPolicy {
  return {
    reapMs: resolveStaleRunningReapMs({
      managed: input.managedReapMs,
      env: input.envReapMs,
    }),
    batchLimit: resolveStaleSweepBatchLimit({
      managed: input.managedBatchLimit,
      env: input.envBatchLimit,
    }),
  };
}
