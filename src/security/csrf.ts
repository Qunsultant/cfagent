/**
 * Issue #3113 (#945 Q5) — CSRF rule for cookie-authenticated mutations.
 *
 * Before this slice, cookie-authenticated mutations relied solely on
 * `SameSite=Lax`; no CSRF token existed anywhere in src/. R7's
 * negative test (a cookie-authenticated mutation without a valid
 * CSRF token is rejected) could not pass. This module is the rule:
 *
 * - A state-changing request (POST/PUT/PATCH/DELETE) that carries a
 *   session cookie must carry `X-CSRF-Token` equal to the
 *   `csrf_token` cookie value. Anything else is rejected with
 *   `csrf_invalid` before any route work happens.
 * - Safe methods pass. Requests without a session cookie pass: a
 *   Bearer/API-key/MCP caller carries no ambient credential, so
 *   there is nothing for a cross-site request to ride on; the auth
 *   layer still rejects unauthenticated callers.
 * - Exempt paths pass: login/callback (no session exists yet when
 *   the flow starts; the OAuth `state` parameter covers the
 *   callback leg), HMAC webhooks, token-authenticated /mcp and
 *   /a2a, and signature-verified Slack events.
 *
 * Token model — double-submit, chosen deliberately over a
 * synchronizer token: the token rides no SessionStore read (the
 * free-tier rows-read quota behind #1819 makes a per-mutation
 * store read expensive), and the gate is purely a header/cookie
 * comparison. The token is minted at login, never rotated
 * mid-session (parallel requests would race a rotation), and
 * re-issued on authenticated responses that lack one so sessions
 * created before this slice self-heal on their next page load
 * instead of failing every mutation until re-login.
 *
 * The token cookie is intentionally NOT HttpOnly: client JS must
 * read it to send the header (see `csrfHeaders` in
 * src/client/apiFetch.ts). It is Secure, SameSite=Lax, Path=/,
 * with the session's 7-day Max-Age. A double-submit token does
 * not protect against XSS or a hostile subdomain setting cookies;
 * it protects exactly the cross-site-request case, alongside
 * SameSite=Lax. That residual is recorded in the Q5 doc.
 */

import { SESSION_LIMITS } from "../config/sessionLimits";
import { COOKIE_NAME } from "./session";

/** Name of the CSRF token cookie (readable by client JS by design). */
export const CSRF_COOKIE_NAME = "csrf_token";
/** Header the client sends the token in. */
export const CSRF_HEADER_NAME = "X-CSRF-Token";

/** State-changing methods the gate applies to. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Exact paths exempt from the gate. */
const EXEMPT_PATHS = new Set([
  "/nlq/webhook",
  "/api/nlq/webhook",
  "/api/trading/nlq/webhook",
  "/mcp",
  "/slack/events",
]);

/** Path prefixes exempt from the gate. */
const EXEMPT_PREFIXES = ["/auth/", "/mcp/", "/a2a/"];

export type CsrfGateResult =
  | { pass: true }
  | { pass: false; code: "csrf_invalid"; error: string };

function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

function isExemptPath(path: string): boolean {
  if (EXEMPT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Pure gate decision for a request. No I/O, no store reads.
 * Callers return 403 with the code on failure, before routing.
 */
export function csrfGateResult(request: Request): CsrfGateResult {
  const method = request.method.toUpperCase();
  if (!MUTATION_METHODS.has(method)) return { pass: true };
  const path = new URL(request.url).pathname;
  if (isExemptPath(path)) return { pass: true };
  const cookies = parseCookies(request.headers.get("Cookie"));
  if (!cookies.has(COOKIE_NAME)) return { pass: true };
  const token = cookies.get(CSRF_COOKIE_NAME);
  const header = request.headers.get(CSRF_HEADER_NAME);
  if (
    typeof token === "string" &&
    token.length > 0 &&
    typeof header === "string" &&
    header.length > 0 &&
    header === token
  ) {
    return { pass: true };
  }
  return {
    pass: false,
    code: "csrf_invalid",
    error: "CSRF token missing or invalid for this cookie-authenticated mutation.",
  };
}

/** Issue a csrf_token cookie for a fresh token value. */
export function setCsrfCookie(token: string): string {
  return (
    `${CSRF_COOKIE_NAME}=${token}; Secure; SameSite=Lax; Path=/; ` +
    `Max-Age=${SESSION_LIMITS.cookieMaxAgeSeconds}`
  );
}

/**
 * Self-heal for pre-slice sessions: when a request carries a session
 * cookie but no csrf cookie, mint a token and return its Set-Cookie
 * string for the response. Returns null when no issuance is due
 * (no session cookie, or a token cookie already present).
 */
export function ensureCsrfCookie(request: Request): string | null {
  const cookies = parseCookies(request.headers.get("Cookie"));
  if (!cookies.has(COOKIE_NAME)) return null;
  if (cookies.has(CSRF_COOKIE_NAME)) return null;
  return setCsrfCookie(crypto.randomUUID());
}
