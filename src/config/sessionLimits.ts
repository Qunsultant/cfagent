/**
 * Session and auth-window limits — the single source of truth.
 *
 * Every value the session/auth path enforces lives in
 * `config/session-limits.json`; no module hardcodes a duration. Change the
 * JSON to change behavior, then update the pins in the tests that quote the
 * value. The only runtime override kept is `SESSION_IDLE_TIMEOUT_MS`, for an
 * operator that needs a different idle window without a code change.
 *
 * Units are explicit in the key names: `*Seconds` are seconds (cookie/store
 * TTLs), `*Ms` are milliseconds (comparisons against Date.now()).
 */
import raw from "../../config/session-limits.json";

export interface SessionLimits {
  /** Absolute session lifetime from the last renewal (7 days). */
  absoluteTtlSeconds: number;
  /** Hard lifetime cap from first login, even with renewals (30 days). */
  maxLifetimeSeconds: number;
  /** Slide the absolute window when this much or less remains (2 days). */
  renewWindowSeconds: number;
  /** Browser cookie Max-Age (7 days). */
  cookieMaxAgeSeconds: number;
  /** Idle window for wired sessions (8 hours; owner override of the CISO 30m). */
  idleTimeoutMs: number;
  /** Smallest accepted idle override, to catch a unit typo. */
  minIdleTimeoutMs: number;
  /** Step-up freshness window for sensitive actions (15 minutes). */
  stepUpFreshnessMs: number;
  /** Minimum gap between activity touches (300 seconds). */
  touchIntervalMs: number;
  /** In-isolate session cache: positive hit TTL (60 seconds). */
  cachePositiveTtlMs: number;
  /** In-isolate session cache: negative/miss TTL (10 seconds). */
  cacheNegativeTtlMs: number;
  /** In-isolate session cache: maximum entries. */
  cacheMaxEntries: number;
  /** OAuth state lifetime (10 minutes). */
  oauthStateMaxAgeMs: number;
  /** Tolerated future clock skew for OAuth state (60 seconds). */
  oauthStateFutureSkewMs: number;
  /** Public OAuth pending-request lifetime (10 minutes). */
  publicOAuthPendingMaxAgeMs: number;
  /** Refresh a Public OAuth token this long before its real expiry (60s). */
  oauthExpirySkewMs: number;
  /**
   * #2840: maximum concurrent ACTIVE sessions per user (10).
   * Not a TTL — #1749 owns the TTL bounds, which this key does
   * not change. At the cap, a new login evicts the oldest
   * active session (oldest-out); the eviction is audited and
   * visible on the #2836 logged-in-users surface (the evicted
   * session disappears from the user's session list).
   */
  maxConcurrentSessionsPerUser: number;
}

export const SESSION_LIMITS: SessionLimits = raw as SessionLimits;

/**
 * Resolve the idle window from an operator override with the config default.
 * Invalid or non-positive values fall back to the config value; the result is
 * clamped to [minIdleTimeoutMs, absoluteTtlSeconds] so a typo can neither
 * disable the timeout nor outlive the session itself.
 */
export function resolveIdleTimeoutMs(
  rawOverride: string | number | undefined | null,
  limits: SessionLimits = SESSION_LIMITS
): number {
  const value =
    typeof rawOverride === "number"
      ? rawOverride
      : rawOverride == null
        ? Number.NaN
        : Number(rawOverride);
  if (!Number.isFinite(value) || value <= 0) return limits.idleTimeoutMs;
  return Math.min(
    Math.max(value, limits.minIdleTimeoutMs),
    limits.absoluteTtlSeconds * 1000
  );
}
