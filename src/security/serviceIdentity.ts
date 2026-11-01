/**
 * #1185 / #1066 — the explicit service identity for unattended work.
 *
 * Background execution (worker `scheduled()` / `queue()`, session-less
 * entry points) used to run under a hardcoded synthetic login with a
 * process-wide static E*TRADE token as its fallback. That identity is
 * removed: unattended work now runs under an explicit service identity —
 * a non-secret login id the owner configures via `SERVICE_USER_LOGIN`
 * and authorizes once through the same 3-legged E*TRADE linking flow any
 * user completes, so its token is a stored per-identity token in the
 * SessionStore (`etrade:token:<ENV>:<serviceId>`) with the same expiry,
 * renewal, and revocation lifecycle as a user token.
 *
 * Fail-closed contract: when the id is unset, blank, or not login-shaped,
 * there is NO unattended identity. Callers must skip (and log) rather
 * than substitute any other identity.
 */
import { resolveEnvironmentConfig } from "../config/environment";
import type { Env } from "../types";

/**
 * Login shape the Orchestrator accepts on the `x-user-login` header.
 *
 * Issue #2071: the header carries the session identity verbatim. Google
 * sign-in yields an email, and IAAA identities are `issuer:subject`
 * shaped (`https://github.com:82253453`, `github:OpenAIMP`). The old
 * `[A-Za-z0-9._-]` rule rejected every one of those, so a signed-in user
 * fell through to "An authenticated E*TRADE account is required" on the
 * schedules routes. The rule is about SHAPE safety, not authentication:
 * no whitespace/control/quote characters, a leading alphanumeric, and a
 * bounded length. The Worker strips client-supplied `x-user-login` and
 * sets it from the verified session.
 */
const LOGIN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,119}$/;

/** True when `value` is a string shaped like a login this system forwards. */
export function isLoginShaped(value: unknown): value is string {
  return typeof value === "string" && LOGIN_SHAPE.test(value);
}

/**
 * The configured service identity, or null when none is configured.
 * Null is a hard stop for unattended dispatch — never a fallback.
 */
export function getServiceUserLogin(env: Env): string | null {
  const resolved = resolveEnvironmentConfig(env).serviceUserLogin;
  return isLoginShaped(resolved) ? resolved : null;
}

/**
 * The address — NOT an identity — of the shared Orchestrator instance the
 * session-less entry points forward to.
 *
 * Durable Object instance names are addresses, not principals. This
 * value is the live address: new unattended work talks to this
 * instance. It must never be used as a login, a token key, an audit
 * actor, or a payer — identity for those purposes comes from
 * `getServiceUserLogin` or from an authenticated session.
 */
export const SHARED_ORCHESTRATOR_INSTANCE = "shared_orchestrator";

/**
 * Issue #2681 — the legacy shared-orchestrator address.
 *
 * The pre-#2681 address. It survives ONLY here, for two reasons, and
 * nowhere else in src/ (enforced by the legacy-address pin test):
 * (1) in-flight queued messages naming the legacy address must still be
 * denied as fabricated identity (see isSharedOrchestratorAddress);
 * (2) the orchestrator-migration driver takes its source address
 * explicitly, and the operator passes this legacy address once at run
 * time. The legacy instance is never deleted (no delete API exists);
 * after the #2681 flip it simply receives no new work, and its alarms
 * drain on their own storage. This constant is never a live address,
 * login, token key, audit actor, or payer.
 */
export const LEGACY_SHARED_ORCHESTRATOR_INSTANCE = "default_trader";

/**
 * True when `login` names a shared-orchestrator address — the live one
 * or the legacy one. Either must never be used as an identity: a
 * payload or dispatch candidate naming an address is denied, not
 * forwarded (issues #1185, #2331 slice 2, #2681).
 */
export function isSharedOrchestratorAddress(login: unknown): boolean {
  return (
    login === SHARED_ORCHESTRATOR_INSTANCE ||
    login === LEGACY_SHARED_ORCHESTRATOR_INSTANCE
  );
}

/**
 * #2331 slice 1 — the service user's stable internalUserId, derived
 * deterministically from its login: `service:<login>`.
 *
 * The service user never logs in through OAuth, so it has no
 * (issuer, subject) pair and no v1: identity hash, and no wired-login
 * alias record is ever written for it (alias records are observations
 * of wired logins only). Slice 2 dispatch resolves the service login
 * to this same id through this helper — never through a second
 * derivation, and never through the alias store. A bare login is
 * never used as the id: real internal ids are UUIDs or v1: hashes,
 * so the `service:` prefix cannot collide with a human identity.
 */
export function serviceUserInternalUserId(serviceLogin: string): string {
  return `service:${serviceLogin}`;
}
