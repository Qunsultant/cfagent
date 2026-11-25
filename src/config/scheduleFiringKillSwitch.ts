/**
 * Issue #6482 — the schedule-firing kill-switch, externalized.
 *
 * One switch halts every armed schedule's firing: when firing is
 * disabled, the one choke point (recordScheduleCallbackRun) records
 * a skipped run and never invokes the callback. Precedence, in one
 * place (see src/services/scheduleControls.ts for the managed-
 * setting read):
 *   managed setting (mas_settings `schedule.firingEnabled`,
 *   settable from the schedules home) >
 *   env carrier (`SCHEDULE_FIRING_ENABLED`) >
 *   default ON (firing allowed).
 *
 * The default is firing ALLOWED on purpose: deploying this slice
 * must not halt any existing schedule. The switch is separate from
 * the scheduling-channel flags (#4249): the one-on invariant
 * forbids both-off there, so the channel flags can never be the
 * master stop. A manual trigger is never halted — the kill-switch
 * stops scheduled firings, not an operator's explicit run-now.
 *
 * This module is pure (no imports): the src/config/*Modes.ts idiom.
 */

/** The env carrier for the kill-switch. */
export const SCHEDULE_FIRING_ENABLED_ENV_VAR = "SCHEDULE_FIRING_ENABLED";

/** The managed-setting key (mas_settings), settable from the schedules home. */
export const SCHEDULE_FIRING_ENABLED_SETTING_KEY = "schedule.firingEnabled";

/** The default: firing allowed (deploying the slice halts nothing). */
export const DEFAULT_SCHEDULE_FIRING_ENABLED = true;

/**
 * Parse a firing-enabled value: "on"/"true"/"1" → true,
 * "off"/"false"/"0" → false (case-insensitive, trimmed);
 * booleans pass through; anything else is undefined (falls
 * through to the next source).
 */
export function parseScheduleFiringEnabled(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "1") return true;
  if (normalized === "off" || normalized === "false" || normalized === "0") return false;
  return undefined;
}

/** Where the effective firing state came from (named for the home + the audit trail). */
export type ScheduleFiringEnabledSource = "managed" | "env" | "default";

/** Resolve firing-enabled from already-read sources: managed > env > default ON. */
export function resolveScheduleFiringEnabled(input: {
  managed?: unknown;
  env?: unknown;
}): boolean {
  return (
    parseScheduleFiringEnabled(input.managed) ??
    parseScheduleFiringEnabled(input.env) ??
    DEFAULT_SCHEDULE_FIRING_ENABLED
  );
}

/** Name the winning source for the same inputs. */
export function scheduleFiringEnabledSource(input: {
  managed?: unknown;
  env?: unknown;
}): ScheduleFiringEnabledSource {
  if (parseScheduleFiringEnabled(input.managed) !== undefined) return "managed";
  if (parseScheduleFiringEnabled(input.env) !== undefined) return "env";
  return "default";
}
