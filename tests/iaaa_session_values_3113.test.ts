/**
 * Issue #3113 (#945 Q5) — settled session values, pinned.
 *
 * These are settlement pins, not new behavior: each value below is
 * the recorded Q5 decision, and the test fails loudly if the value
 * changes without updating docs/architecture/security/session-values-3113.md.
 * Q4's action freshness windows (5/10/15 min) are NOT session
 * lifetimes and are deliberately not asserted here.
 */
import { describe, it, expect } from "vitest";
import { SESSION_LIMITS, resolveIdleTimeoutMs } from "../src/config/sessionLimits";
import {
  COOKIE_NAME,
  MAX_SESSION_COOKIE_CANDIDATES,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL,
  SESSION_MAX_TTL,
  SESSION_RENEW_WINDOW,
} from "../src/security/session";
import {
  DEFAULT_SESSION_POLICY,
  SESSION_ABSOLUTE_TTL_MS,
} from "../src/security/sessionPolicy";

describe("settled session values (Q5)", () => {
  it("absolute TTL is 7 days, sliding; renew window is 2 days", () => {
    expect(SESSION_LIMITS.absoluteTtlSeconds).toBe(604800);
    expect(SESSION_LIMITS.renewWindowSeconds).toBe(172800);
    expect(SESSION_TTL).toBe(604800);
    expect(SESSION_RENEW_WINDOW).toBe(172800);
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(604800 * 1000);
  });

  it("hard lifetime cap is 30 days from first login", () => {
    expect(SESSION_LIMITS.maxLifetimeSeconds).toBe(2592000);
    expect(SESSION_MAX_TTL).toBe(2592000);
    expect(DEFAULT_SESSION_POLICY.maxLifetimeMs).toBe(2592000 * 1000);
  });

  it("wired idle window is 8 hours with a clamped operator override", () => {
    expect(SESSION_LIMITS.idleTimeoutMs).toBe(28800000);
    expect(SESSION_LIMITS.minIdleTimeoutMs).toBe(300000);
    expect(resolveIdleTimeoutMs(undefined)).toBe(28800000);
    expect(resolveIdleTimeoutMs("not-a-number")).toBe(28800000);
    expect(resolveIdleTimeoutMs(1000)).toBe(300000);
    expect(resolveIdleTimeoutMs(999999999999)).toBe(604800 * 1000);
  });

  it("cookie is HttpOnly, Secure, SameSite=Lax, Path=/, 7-day Max-Age", () => {
    expect(COOKIE_NAME).toBe("session_id");
    const header = setSessionCookie("11111111-1111-4111-8111-111111111111");
    expect(header).toContain("session_id=11111111-1111-4111-8111-111111111111");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=604800");
    expect(SESSION_LIMITS.cookieMaxAgeSeconds).toBe(604800);
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("auth-path cookie candidates are capped at 8", () => {
    expect(MAX_SESSION_COOKIE_CANDIDATES).toBe(8);
  });

  it("touch interval is 300s; cache TTLs are 60s positive / 10s negative, 2,000 entries", () => {
    expect(SESSION_LIMITS.touchIntervalMs).toBe(300000);
    expect(SESSION_LIMITS.cachePositiveTtlMs).toBe(60000);
    expect(SESSION_LIMITS.cacheNegativeTtlMs).toBe(10000);
    expect(SESSION_LIMITS.cacheMaxEntries).toBe(2000);
  });

  it("OAuth state is 10 minutes with 60s future skew", () => {
    expect(SESSION_LIMITS.oauthStateMaxAgeMs).toBe(600000);
    expect(SESSION_LIMITS.oauthStateFutureSkewMs).toBe(60000);
  });

  it("per-user concurrent cap is 10 active sessions", () => {
    expect(SESSION_LIMITS.maxConcurrentSessionsPerUser).toBe(10);
  });
});
