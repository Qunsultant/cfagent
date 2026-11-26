/**
 * Issue #4234 (ADR 0030) — the hourly heartbeat watchdog: configuration
 * in the src/config/*Modes.ts idiom (a documented Worker env var, a
 * named built-in default, no magic number in the read path).
 *
 * ADR 0030 decides ONE Worker cron is the watchdog — and the only
 * cron. It fires hourly and does no work itself: it checks the
 * heartbeat SDK alarm (the recurring `onCron` alarm on the
 * ScheduledAgent) exists and has fired recently, and re-arms it when
 * it is missing or stale. The three duty crons (tick `*\/30`, token
 * renewal `0 3`, retention `0 4`) stay OFF per #4112 and are NOT
 * restored by this slice.
 *
 * HEARTBEAT_INTERVAL_SECONDS (non-secret, owner-set; this slice sets
 * NO production value):
 *   Seconds between heartbeat alarm firings — the tick cadence the
 *   watchdog re-arms with. Built-in default: 1800 (30 minutes, the
 *   cadence the Worker tick cron ran on before #4112 turned it off).
 *   The tick's cadence follows #4235's granularity (default at most
 *   once per day); when #4235 lands it changes this value, not code.
 *   A blank or unparseable value falls through to the default; a
 *   non-positive value falls through to the default (an alarm with
 *   no interval cannot be armed, so there is no disabling value).
 *
 * HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES (non-secret, owner-set;
 * this slice sets NO production value):
 *   Minutes since the last recorded tick firing after which the
 *   watchdog treats a present heartbeat alarm as wedged (exists but
 *   not firing) and re-arms it. Built-in default: 120 minutes — two
 *   missed 30-minute beats plus grace for ordinary platform jitter.
 *   A blank or unparseable value falls through to the default; a
 *   non-positive value falls through to the default (a zero
 *   threshold would flag every healthy alarm as stale, so there is
 *   no disabling value — the watchdog is the ADR 0030 backstop and
 *   must not be silently switched off).
 */

/** The watchdog's own Worker cron expression (ADR 0030: hourly). */
export const HEARTBEAT_WATCHDOG_CRON = "0 * * * *";

/** The SDK alarm callback the watchdog watches and re-arms. */
export const HEARTBEAT_ALARM_CALLBACK = "onCron";

export const HEARTBEAT_INTERVAL_ENV_VAR = "HEARTBEAT_INTERVAL_SECONDS";
export const HEARTBEAT_WATCHDOG_STALE_AFTER_ENV_VAR =
  "HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES";

/**
 * Issue #6503 step 13 — the heartbeat values are MANAGED settings,
 * not env-only: mas_settings `schedule.heartbeatIntervalSeconds` /
 * `schedule.heartbeatWatchdogStaleAfterMinutes`, settable from the
 * schedules home. Precedence everywhere: managed > env carrier >
 * default (1800s / 120 minutes). The env carriers and the defaults
 * are unchanged; a managed value only wins, it never redefines
 * what "no value" means (blank / unparseable / non-positive still
 * falls through, exactly as the env resolvers have always done —
 * there is no disabling value for either knob).
 */
export const HEARTBEAT_INTERVAL_SETTING_KEY = "schedule.heartbeatIntervalSeconds";
export const HEARTBEAT_WATCHDOG_STALE_AFTER_SETTING_KEY =
  "schedule.heartbeatWatchdogStaleAfterMinutes";

/** The built-in default heartbeat interval: 30 minutes, in seconds. */
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 1800;

/** The built-in default staleness threshold: 120 minutes, in milliseconds. */
export const DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS = 120 * 60 * 1000;

/** The built-in default staleness threshold, in minutes (the managed/env unit). */
export const DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES = 120;

/** Where the effective heartbeat value came from (named for the home + the audit trail). */
export type HeartbeatWatchdogSource = "managed" | "env" | "default";

/**
 * Parse a heartbeat interval in seconds: a positive number, or
 * undefined (blank, non-numeric, non-positive — falls through to
 * the next source). Strings parse as numbers so managed settings
 * (stored as text) resolve the same way as env carriers.
 */
export function parseHeartbeatIntervalSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.floor(seconds);
}

/**
 * Parse a watchdog staleness threshold in minutes: a positive
 * number, or undefined (blank, non-numeric, non-positive — falls
 * through to the next source; a zero threshold would flag every
 * healthy alarm as stale, so there is no disabling value).
 */
export function parseHeartbeatWatchdogStaleAfterMinutes(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const minutes = Number(value.trim());
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return minutes;
}

/** Resolve the heartbeat interval from already-read sources: managed > env > default (1800s). */
export function resolveHeartbeatIntervalSecondsFrom(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  return (
    parseHeartbeatIntervalSeconds(input.managed) ??
    parseHeartbeatIntervalSeconds(input.env) ??
    DEFAULT_HEARTBEAT_INTERVAL_SECONDS
  );
}

/** Name the winning heartbeat-interval source for the same inputs. */
export function heartbeatIntervalSecondsSource(input: {
  managed?: unknown;
  env?: unknown;
}): HeartbeatWatchdogSource {
  if (parseHeartbeatIntervalSeconds(input.managed) !== undefined) return "managed";
  if (parseHeartbeatIntervalSeconds(input.env) !== undefined) return "env";
  return "default";
}

/** Resolve the staleness threshold in milliseconds from already-read sources: managed > env > default (120 min). */
export function resolveHeartbeatWatchdogStaleAfterMsFrom(input: {
  managed?: unknown;
  env?: unknown;
}): number {
  const minutes =
    parseHeartbeatWatchdogStaleAfterMinutes(input.managed) ??
    parseHeartbeatWatchdogStaleAfterMinutes(input.env) ??
    DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES;
  return Math.round(minutes * 60 * 1000);
}

/** Name the winning staleness-threshold source for the same inputs. */
export function heartbeatWatchdogStaleAfterSource(input: {
  managed?: unknown;
  env?: unknown;
}): HeartbeatWatchdogSource {
  if (parseHeartbeatWatchdogStaleAfterMinutes(input.managed) !== undefined) return "managed";
  if (parseHeartbeatWatchdogStaleAfterMinutes(input.env) !== undefined) return "env";
  return "default";
}

/**
 * Resolvers take the env as a `Record<string, unknown>` (the
 * `dlqDepthAlert` idiom): the Worker's `Env` type does not declare
 * these vars as properties, and a narrow all-optional interface
 * would fail the weak-type check at every production call site.
 */

/**
 * Resolve the heartbeat alarm interval in seconds. Blank,
 * unparseable, or non-positive values fall through to the default.
 * Issue #6503 step 13 — delegates to the managed-aware resolver
 * with no managed value, so the env-only behavior is unchanged.
 */
export function resolveHeartbeatIntervalSeconds(
  env: Record<string, unknown>,
): number {
  return resolveHeartbeatIntervalSecondsFrom({ env: env[HEARTBEAT_INTERVAL_ENV_VAR] });
}

/**
 * Resolve the watchdog staleness threshold in milliseconds. Blank,
 * unparseable, or non-positive values fall through to the default.
 * Issue #6503 step 13 — delegates to the managed-aware resolver
 * with no managed value, so the env-only behavior is unchanged.
 */
export function resolveHeartbeatWatchdogStaleAfterMs(
  env: Record<string, unknown>,
): number {
  return resolveHeartbeatWatchdogStaleAfterMsFrom({
    env: env[HEARTBEAT_WATCHDOG_STALE_AFTER_ENV_VAR],
  });
}

/** Both watchdog values, resolved together from one env read. */
export interface HeartbeatWatchdogConfig {
  intervalSeconds: number;
  staleAfterMs: number;
}

export function resolveHeartbeatWatchdogConfig(
  env: Record<string, unknown>,
): HeartbeatWatchdogConfig {
  return {
    intervalSeconds: resolveHeartbeatIntervalSeconds(env),
    staleAfterMs: resolveHeartbeatWatchdogStaleAfterMs(env),
  };
}

/**
 * Issue #6503 step 13 — both watchdog values, resolved together
 * from already-read sources: managed > env > default. The managed
 * values are the mas_settings keys above, read by the caller (the
 * schedules home); the env values are the raw carrier strings.
 * This is also the step-12 staleness threshold's managed home: the
 * outer observation's `staleAfterMs` is this same value.
 */
export function resolveHeartbeatWatchdogConfigFrom(input: {
  managedIntervalSeconds?: unknown;
  envIntervalSeconds?: unknown;
  managedStaleAfterMinutes?: unknown;
  envStaleAfterMinutes?: unknown;
}): HeartbeatWatchdogConfig {
  return {
    intervalSeconds: resolveHeartbeatIntervalSecondsFrom({
      managed: input.managedIntervalSeconds,
      env: input.envIntervalSeconds,
    }),
    staleAfterMs: resolveHeartbeatWatchdogStaleAfterMsFrom({
      managed: input.managedStaleAfterMinutes,
      env: input.envStaleAfterMinutes,
    }),
  };
}

