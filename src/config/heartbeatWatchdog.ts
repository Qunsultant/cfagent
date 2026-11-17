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
 *
 * HEARTBEAT_RENEWAL_DUE_HOUR_UTC / HEARTBEAT_RETENTION_DUE_HOUR_UTC
 * (non-secret, owner-set; this slice sets NO production value):
 *   The UTC hour after which the token-renewal / retention duty is
 *   due inside the one heartbeat tick (issue #4234 verdicts 2–3:
 *   the duties ride the tick as daily due-checks, never as separate
 *   crons). Built-in defaults: renewal 03:00 UTC (the old `0 3`
 *   cron's hour), retention 04:00 UTC (the old `0 4` cron's hour).
 *   A blank, unparseable, or out-of-range (not an integer hour
 *   0–23) value falls through to the default — the duties have no
 *   disabling value.
 */

/** The watchdog's own Worker cron expression (ADR 0030: hourly). */
export const HEARTBEAT_WATCHDOG_CRON = "0 * * * *";

/** The SDK alarm callback the watchdog watches and re-arms. */
export const HEARTBEAT_ALARM_CALLBACK = "onCron";

export const HEARTBEAT_INTERVAL_ENV_VAR = "HEARTBEAT_INTERVAL_SECONDS";
export const HEARTBEAT_WATCHDOG_STALE_AFTER_ENV_VAR =
  "HEARTBEAT_WATCHDOG_STALE_AFTER_MINUTES";
export const HEARTBEAT_RENEWAL_DUE_HOUR_ENV_VAR =
  "HEARTBEAT_RENEWAL_DUE_HOUR_UTC";
export const HEARTBEAT_RETENTION_DUE_HOUR_ENV_VAR =
  "HEARTBEAT_RETENTION_DUE_HOUR_UTC";

/** The built-in default heartbeat interval: 30 minutes, in seconds. */
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 1800;

/** The built-in default staleness threshold: 120 minutes, in milliseconds. */
export const DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS = 120 * 60 * 1000;

/** The built-in default renewal due hour: 03:00 UTC (the old `0 3` cron's hour). */
export const DEFAULT_HEARTBEAT_RENEWAL_DUE_HOUR_UTC = 3;

/** The built-in default retention due hour: 04:00 UTC (the old `0 4` cron's hour). */
export const DEFAULT_HEARTBEAT_RETENTION_DUE_HOUR_UTC = 4;

/**
 * Resolvers take the env as a `Record<string, unknown>` (the
 * `dlqDepthAlert` idiom): the Worker's `Env` type does not declare
 * these vars as properties, and a narrow all-optional interface
 * would fail the weak-type check at every production call site.
 */

/**
 * Resolve the heartbeat alarm interval in seconds. Blank,
 * unparseable, or non-positive values fall through to the default.
 */
export function resolveHeartbeatIntervalSeconds(
  env: Record<string, unknown>,
): number {
  const rawValue = env[HEARTBEAT_INTERVAL_ENV_VAR];
  const raw =
    typeof rawValue === "string" ? rawValue.trim() : "";
  if (raw === "") return DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    return DEFAULT_HEARTBEAT_INTERVAL_SECONDS;
  return Math.floor(seconds);
}

/**
 * Resolve the watchdog staleness threshold in milliseconds. Blank,
 * unparseable, or non-positive values fall through to the default.
 */
export function resolveHeartbeatWatchdogStaleAfterMs(
  env: Record<string, unknown>,
): number {
  const rawValue = env[HEARTBEAT_WATCHDOG_STALE_AFTER_ENV_VAR];
  const raw =
    typeof rawValue === "string" ? rawValue.trim() : "";
  if (raw === "") return DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0)
    return DEFAULT_HEARTBEAT_WATCHDOG_STALE_AFTER_MS;
  return Math.round(minutes * 60 * 1000);
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

/** Both due-check hours, resolved together from one env read. */
export interface HeartbeatDueCheckConfig {
  renewalDueHourUtc: number;
  retentionDueHourUtc: number;
}

function resolveDueHourUtc(
  env: Record<string, unknown>,
  envVar: string,
  fallback: number,
): number {
  const rawValue = env[envVar];
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (raw === "") return fallback;
  const hour = Number(raw);
  if (!Number.isFinite(hour)) return fallback;
  const floored = Math.floor(hour);
  if (floored < 0 || floored > 23) return fallback;
  return floored;
}

/**
 * Resolve the renewal due hour (UTC). Blank, unparseable, or
 * out-of-range (not an integer hour 0–23) values fall through to
 * the default.
 */
export function resolveHeartbeatRenewalDueHourUtc(
  env: Record<string, unknown>,
): number {
  return resolveDueHourUtc(
    env,
    HEARTBEAT_RENEWAL_DUE_HOUR_ENV_VAR,
    DEFAULT_HEARTBEAT_RENEWAL_DUE_HOUR_UTC,
  );
}

/**
 * Resolve the retention due hour (UTC). Blank, unparseable, or
 * out-of-range (not an integer hour 0–23) values fall through to
 * the default.
 */
export function resolveHeartbeatRetentionDueHourUtc(
  env: Record<string, unknown>,
): number {
  return resolveDueHourUtc(
    env,
    HEARTBEAT_RETENTION_DUE_HOUR_ENV_VAR,
    DEFAULT_HEARTBEAT_RETENTION_DUE_HOUR_UTC,
  );
}

export function resolveHeartbeatDueCheckConfig(
  env: Record<string, unknown>,
): HeartbeatDueCheckConfig {
  return {
    renewalDueHourUtc: resolveHeartbeatRenewalDueHourUtc(env),
    retentionDueHourUtc: resolveHeartbeatRetentionDueHourUtc(env),
  };
}
