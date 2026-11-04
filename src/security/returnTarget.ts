/**
 * #3015 — return-target validation for post-login deep links.
 *
 * A signed-out visit to a bookmarked in-app URL must survive
 * sign-in: the target is validated here, sealed into the signed
 * OAuth state (see session.ts), and validated AGAIN at use time
 * when the post-login redirect is built. Every layer fails closed
 * to the default landing — an invalid target never blocks login
 * and never redirects off-site.
 *
 * Pure and dependency-free except for the shared outcome
 * parameter: no store, no provider, no async resource, so the
 * validator is usable from the login page, the landing page,
 * the factory, and the wired tail alike.
 *
 * Rules (a target is returned normalized, or null when refused):
 * - Only relative URLs: anything that parses as absolute (any
 *   scheme, or protocol-relative //host) is refused, even a
 *   same-origin absolute URL — our own callers always build
 *   relative targets, so refusing absolute forms loses nothing
 *   and removes any origin comparison to get wrong.
 * - Auth routes are never valid targets: /login, /login/*, and
 *   /auth/* (login, callback, logout, and action routes) are
 *   refused, so a target can never loop back into the auth flow.
 * - Raw control characters and backslashes are refused outright
 *   (defense against parser differentials between this check
 *   and the browser's Location handling).
 * - Absurd input is refused (empty, blank, over 2048 chars).
 * - The outcome parameter is stripped from the target, so a
 *   saved return page never carries an outcome (#2402 rule);
 *   buildPostLoginRedirect appends the fresh signed_in outcome.
 * - Unknown in-app paths are NOT refused: a same-origin relative
 *   path can only ever land on this app, where the SPA's own
 *   routing handles it — it can never redirect off-site.
 */
import { AUTH_OUTCOME_PARAM } from "./authOutcome";

/** Refuse absurd input rather than sealing it into signed state. */
const MAX_TARGET_LENGTH = 2048;

/** Dummy origin for relative-URL parsing; never a real host. */
const DUMMY_BASE = "https://return-target.invalid";

/** Auth routes: a return target must never point back into auth. */
function isAuthRoute(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/")
  );
}

/**
 * Validate a raw return-target candidate. Returns the normalized
 * relative URL (pathname + search + hash, outcome parameter
 * stripped), or null when the candidate is refused.
 */
export function validateReturnTarget(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_TARGET_LENGTH) return null;
  if (/[\r\n\t\\]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed, DUMMY_BASE);
  } catch {
    return null;
  }
  // Anything absolute (any scheme, protocol-relative host) parses
  // to an origin other than the dummy base — refused.
  if (parsed.origin !== DUMMY_BASE) return null;
  if (isAuthRoute(parsed.pathname)) return null;
  parsed.searchParams.delete(AUTH_OUTCOME_PARAM);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Build the post-login redirect for a (possibly absent) return
 * target. The target is validated AGAIN here — use-time
 * validation, even when the caller recovered it from signed
 * state. An absent or invalid target yields the default landing
 * with the signed_in outcome, exactly as before #3015.
 */
export function buildPostLoginRedirect(
  returnTarget: string | null | undefined
): string {
  const target = returnTarget ? validateReturnTarget(returnTarget) : null;
  if (!target) return `/?${AUTH_OUTCOME_PARAM}=signed_in`;
  const parsed = new URL(target, DUMMY_BASE);
  parsed.searchParams.set(AUTH_OUTCOME_PARAM, "signed_in");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
