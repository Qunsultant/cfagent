/**
 * Issue #6482 — the schedule frequency floor, externalized.
 *
 * The floor is the minimum interval (seconds) a schedule may be
 * armed with. Precedence, in one place (see
 * src/services/scheduleControls.ts for the managed-setting read):
 *   managed setting (mas_settings `schedule.minIntervalSeconds`,
 *   settable from the schedules home) >
 *   env carrier (`AGENT_SCHEDULE_MIN_INTERVAL_SECONDS`, the
 *   pre-existing carrier from #3122, src/config/environment.ts) >
 *   fail-closed default 2,592,000s (monthly, 30 days).
 *
 * The default is fail-closed on purpose: with nothing configured a
 * 1-second arm is still refused. An invalid managed value (zero,
 * negative, fractional, non-numeric) falls through to the next
 * source instead of disabling the floor — there is no value that
 * turns the floor off. The value is the owner's ruling on #6482
 * (2026-11-24: monthly for everything — no job runs daily).
 *
 * This module is pure (no imports): the src/config/*Modes.ts idiom
 * (a documented env var, a named built-in default, no magic number
 * in the read path).
 */

/** The pre-existing env carrier (#3122). */
export const AGENT_SCHEDULE_MIN_INTERVAL_ENV_VAR = "AGENT_SCHEDULE_MIN_INTERVAL_SECONDS";

/** The fail-closed default, owner-ruled (#6482, 2026-11-24): monthly, 30 days. No job runs daily. */
export const DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS = 2_592_000;

/** The managed-setting key (mas_settings), settable from the schedules home. */
export const SCHEDULE_MIN_INTERVAL_SETTING_KEY = "schedule.minIntervalSeconds";

/** A positive safe integer parses; anything else (zero, negative, fractional, non-numeric) is undefined. */
export function parseScheduleMinIntervalSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Where the effective floor came from (named for the home + the audit trail). */
export type ScheduleMinIntervalSource = "managed" | "env" | "default";

/** Resolve the floor from already-read sources: managed > env > default (monthly). */
export function resolveScheduleMinIntervalSeconds(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseScheduleMinIntervalSeconds(input.managed) ??
    parseScheduleMinIntervalSeconds(input.env) ??
    DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS
  );
}

/** Name the winning source for the same inputs. */
export function scheduleMinIntervalSource(input: {
  managed?: unknown;
  env?: unknown;
}): ScheduleMinIntervalSource {
  if (parseScheduleMinIntervalSeconds(input.managed) !== undefined) return "managed";
  if (parseScheduleMinIntervalSeconds(input.env) !== undefined) return "env";
  return "default";
}
