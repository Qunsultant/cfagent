/**
 * Issue #6503 step 13 — the isDue anti-double-fire guard, externalized.
 *
 * The guard caps a cron schedule at one firing per guard window
 * (the daily ceiling): without a sub-daily opt-in, `isDue` answers
 * false within this long after the last run. The literal was
 * `23 * 60 * 60 * 1000` in `src/schedule.ts` (dueGuardPassed) —
 * 23 hours, one hour short of a day so a daily cron still fires on
 * its next-day tick. The value is the owner's #4235 daily ceiling,
 * and the default below IS that literal, unchanged: with no managed
 * or env value every cron goal behaves exactly as today.
 *
 * Precedence: managed setting (mas_settings
 * `schedule.dueGuardMs`, settable from the schedules home) >
 * env carrier (`SCHEDULE_DUE_GUARD_MS`, new — there was no env
 * carrier for the guard) > default (23h). A managed/env value
 * must be a positive whole number of milliseconds; anything else
 * falls through to the next source. There is no disabling value:
 * a zero guard would let a daily cron fire on every tick.
 *
 * Live-wiring gap (step 13, named, not silently papered over):
 * the guard is read on the ScheduledAgent goal tick
 * (`src/agents/scheduled-agent.ts`), a different durable object
 * whose storage cannot see the orchestrator's mas_settings — the
 * same cross-DO boundary the governed halt crosses with a D1
 * mirror (`src/data/governedHalt.ts`). The seam exists here
 * (`IsDueOptions.dueGuardMs` in `src/schedule.ts` takes the
 * resolved value) and the managed key is readable/writable
 * through the schedules-home controls surface, but no live path
 * passes a managed value into `isDue` yet: that needs the mirror
 * (or an orchestrator settings RPC), which is a follow-up, not
 * this slice. Until then the default governs, exactly as today.
 *
 * This module is pure (no imports): the src/config/*Modes.ts idiom
 * (mirrors src/config/scheduleFiringRateAlert.ts).
 */

/** The env carrier (new — the guard had no env carrier before step 13). */
export const SCHEDULE_DUE_GUARD_ENV_VAR = "SCHEDULE_DUE_GUARD_MS";

/** The managed-setting key (mas_settings), settable from the schedules home. */
export const SCHEDULE_DUE_GUARD_SETTING_KEY = "schedule.dueGuardMs";

/** The built-in default: 23 hours, in milliseconds — the #4235 literal, unchanged. */
export const DEFAULT_SCHEDULE_DUE_GUARD_MS = 23 * 60 * 60 * 1000;

/**
 * Parse a due-guard window in milliseconds: a positive whole
 * number, or undefined (non-numeric, non-finite, zero, negative,
 * or fractional — falls through to the next source). Strings parse
 * as numbers so managed settings (stored as text) resolve the
 * same way as env carriers.
 */
export function parseScheduleDueGuardMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Where the effective guard came from (named for the home + the audit trail). */
export type ScheduleDueGuardSource = "managed" | "env" | "default";

/** Resolve the guard from already-read sources: managed > env > default (23h). */
export function resolveScheduleDueGuardMs(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseScheduleDueGuardMs(input.managed) ??
    parseScheduleDueGuardMs(input.env) ??
    DEFAULT_SCHEDULE_DUE_GUARD_MS
  );
}

/** Name the winning guard source for the same inputs. */
export function scheduleDueGuardSource(input: {
  managed?: unknown;
  env?: unknown;
}): ScheduleDueGuardSource {
  if (parseScheduleDueGuardMs(input.managed) !== undefined) return "managed";
  if (parseScheduleDueGuardMs(input.env) !== undefined) return "env";
  return "default";
}

/** Resolve the guard from env: a positive whole number of milliseconds, else the default. */
export function resolveScheduleDueGuardMsFromEnv(env: unknown): number {
  const raw = (env as Record<string, unknown> | undefined)?.[SCHEDULE_DUE_GUARD_ENV_VAR];
  return parseScheduleDueGuardMs(raw) ?? DEFAULT_SCHEDULE_DUE_GUARD_MS;
}
