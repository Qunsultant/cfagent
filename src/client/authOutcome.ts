/**
 * Issue #2402: client-side sign-in outcome helpers (pure, no store,
 * no DOM access beyond the URL string passed in).
 *
 * - signedInMessage: the one-time boot confirmation text, only for
 *   the success code with a display name. Anything else is null —
 *   the boot never invents a confirmation.
 * - stripAuthOutcomeParam: removes the outcome parameter from a URL
 *   string so a shown outcome is never reshown on refresh. Other
 *   parameters are preserved untouched.
 */
import { AUTH_OUTCOME_PARAM, parseAuthOutcome } from "../security/authOutcome";

export function signedInMessage(
  outcome: unknown,
  displayName: string | undefined
): string | null {
  if (parseAuthOutcome(outcome) !== "signed_in") return null;
  if (typeof displayName !== "string" || displayName.trim() === "") return null;
  return `Signed in as ${displayName}`;
}

export function stripAuthOutcomeParam(url: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const parsed = new URL(url, "https://auth-outcome.invalid");
  parsed.searchParams.delete(AUTH_OUTCOME_PARAM);
  if (absolute) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * #3015: the return target for a signed-out boot, from the
 * current location parts. Returns "" when there is nothing worth
 * carrying (a malformed location, or a protocol-relative path).
 * Pure: it never touches storage — the caller saves the result
 * to sessionStorage best-effort AND carries it as ?target= into
 * startLogin, so a storage failure (private mode) loses nothing:
 * the signed-state leg still carries the return.
 */
export function bootReturnTarget(
  pathname: string,
  search: string,
  hash: string
): string {
  if (typeof pathname !== "string" || pathname === "") return "";
  // A protocol-relative pathname would parse away to "/" under the
  // dummy base and look like a valid relative path — refuse it
  // (and backslashes) before stripping, not after.
  if (pathname.startsWith("//") || pathname.includes("\\")) return "";
  try {
    const next = stripAuthOutcomeParam(`${pathname}${search}${hash}`);
    return next.startsWith("/") && !next.startsWith("//") ? next : "";
  } catch {
    return "";
  }
}

/**
 * #3015: true only for the bare default landing ("/", no query,
 * no fragment), absolute or relative. The boot restores a saved
 * auth:next page ONLY on the default landing: after #3015 the
 * callback may itself land on a bookmarked target, and a stale
 * saved page must never clobber the server-chosen target. On the
 * default landing the restore behaves exactly as before.
 */
export function isDefaultLandingUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    const parsed = new URL(url, "https://default-landing.invalid");
    return (
      parsed.pathname === "/" && parsed.search === "" && parsed.hash === ""
    );
  } catch {
    return false;
  }
}
