/**
 * Issue #2402: the single sign-in outcome channel.
 *
 * The sign-in flow previously had no outcome channel at all: the boot
 * redirected to /auth/login/github whenever __USER__ was absent, with
 * no distinction between "never signed in" and "session read failed"
 * (the #2280 silent loop), and a successful sign-in booted Chat with
 * no confirmation. This module is the allowlist both ends share:
 *
 * - Server: /login renders a failure notice for exactly these codes;
 *   the / handler redirects a just-created-but-unreadable session to
 *   /login?auth_outcome=session_unreadable.
 * - Client: the app boot shows a one-time success toast for
 *   signed_in, then strips the parameter.
 *
 * Deliberately dependency-free: the failure-message path must render
 * with SessionStore unavailable (quota exhaustion), so nothing here
 * imports a store, a provider, or any async resource. Messages are
 * static literals carrying no internals — no row counts, quota
 * numbers, token details, or provider internals. Technical cause goes
 * to server logs / audit only, at the call sites that redirect here.
 */
export type AuthOutcomeCode =
  | "signed_in"
  | "session_unreadable"
  | "signin_failed"
  | "provider_unavailable"
  | "wiring_disabled"
  | "session_limit_unavailable";

/** The single query parameter carrying an outcome code. */
export const AUTH_OUTCOME_PARAM = "auth_outcome";

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "signed_in",
  "session_unreadable",
  "signin_failed",
  "provider_unavailable",
  "wiring_disabled",
  "session_limit_unavailable",
]);

/** Allowlisted parse: anything not exactly a known code is null. */
export function parseAuthOutcome(value: unknown): AuthOutcomeCode | null {
  if (typeof value !== "string") return null;
  return KNOWN_CODES.has(value) ? (value as AuthOutcomeCode) : null;
}

/** Login-page URL carrying one outcome code. */
export function authOutcomeLoginUrl(code: AuthOutcomeCode): string {
  return `/login?${AUTH_OUTCOME_PARAM}=${code}`;
}

type FailureCode = Exclude<AuthOutcomeCode, "signed_in">;

const FAILURE_NOTICES: Record<FailureCode, { title: string; message: string }> = {
  session_unreadable: {
    title: "Sign-in did not complete",
    message: "Your session could not be verified. Please sign in again.",
  },
  signin_failed: {
    title: "Sign-in failed",
    message: "Sign-in did not complete. Please try again.",
  },
  provider_unavailable: {
    title: "Sign-in unavailable",
    message:
      "This sign-in provider is not available. Please try another provider or try again later.",
  },
  wiring_disabled: {
    title: "Sign-in disabled",
    message: "Sign-in is currently disabled. Please try again later.",
  },
  // #2840: the session-cap check could not run (the session
  // listing was unavailable), so no new session was created
  // rather than creating one over the cap. Static text only:
  // no counts, no store names, no internals (the #2402 rule).
  session_limit_unavailable: {
    title: "Sign-in could not check your sessions",
    message:
      "Your active sessions could not be checked, so no new session was created. Please try again.",
  },
};

/**
 * Static notice snippet for the server-rendered login page. Failure
 * codes only: the success code is consumed by the app boot, never by
 * /login, and unknown codes render nothing (never invent a message).
 * The caller passes the inline style (built from SERVER_PALETTE in
 * the login page renderer) so the no-outcome page stays byte-identical
 * — no stylesheet change, no golden churn. Text is static literals,
 * so no escaping is needed.
 */
export function authOutcomeNoticeHtml(
  code: AuthOutcomeCode | null,
  inlineStyle?: string
): string | null {
  if (code === null || code === "signed_in") return null;
  const notice = FAILURE_NOTICES[code];
  if (!notice) return null;
  const styleAttr = inlineStyle ? ` style="${inlineStyle}"` : "";
  return (
    `<div class="notice" role="status"${styleAttr}>` +
    `<div>${notice.title}</div>` +
    `<div>${notice.message}</div>` +
    `</div>`
  );
}
