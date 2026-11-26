/**
 * Issue #6503 — the start-paused control, externalized.
 *
 * New schedules start paused unless an authorized operator
 * configures otherwise. Precedence, in one place (see
 * src/services/scheduleControls.ts for the managed-setting read):
 *   managed setting (mas_settings `schedule.startPaused`,
 *   settable from the schedules home) >
 *   env carrier (`AGENT_SCHEDULE_START_PAUSED`) >
 *   default true (created paused, #6511).
 *
 * The default is paused on purpose: a new schedule never fires
 * before an operator has looked at it. An operator may configure
 * start-paused off so a schedule can be created the regular way
 * (any cadence within the floor, running on its next schedule) —
 * the creation paths read this control, they never hardcode the
 * starting state. An invalid managed value falls through to the
 * next source instead of flipping the default — there is no value
 * that silently un-pauses creation.
 *
 * This module is pure (no imports): the src/config/*Modes.ts idiom
 * (mirrors src/config/scheduleFiringKillSwitch.ts; the boolean
 * parse is that module's one parser, reused here).
 */
import { parseScheduleFiringEnabled } from "./scheduleFiringKillSwitch";

/** The env carrier for the start-paused control. */
export const SCHEDULE_START_PAUSED_ENV_VAR = "AGENT_SCHEDULE_START_PAUSED";

/** The managed-setting key (mas_settings), settable from the schedules home. */
export const SCHEDULE_START_PAUSED_SETTING_KEY = "schedule.startPaused";

/** The default: new schedules start paused (#6511). */
export const DEFAULT_SCHEDULE_START_PAUSED = true;

/**
 * Parse a start-paused value: "on"/"true"/"1" → true,
 * "off"/"false"/"0" → false (case-insensitive, trimmed);
 * booleans pass through; anything else is undefined (falls
 * through to the next source). One boolean parser for the whole
 * schedule-controls surface (scheduleFiringKillSwitch.ts).
 */
export function parseScheduleStartPaused(value: unknown): boolean | undefined {
  return parseScheduleFiringEnabled(value);
}

/** Where the effective start-paused value came from (named for the home + the audit trail). */
export type ScheduleStartPausedSource = "managed" | "env" | "default";

/** Resolve start-paused from already-read sources: managed > env > default (paused). */
export function resolveScheduleStartPaused(input: {
  managed?: unknown;
  env?: unknown;
}): boolean {
  return (
    parseScheduleStartPaused(input.managed) ??
    parseScheduleStartPaused(input.env) ??
    DEFAULT_SCHEDULE_START_PAUSED
  );
}

/** Name the winning source for the same inputs. */
export function scheduleStartPausedSource(input: {
  managed?: unknown;
  env?: unknown;
}): ScheduleStartPausedSource {
  if (parseScheduleStartPaused(input.managed) !== undefined) return "managed";
  if (parseScheduleStartPaused(input.env) !== undefined) return "env";
  return "default";
}
