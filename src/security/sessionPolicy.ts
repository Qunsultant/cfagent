/**
 * Issue #945, Slice 2 — login/session hardening (pure policy, no wiring).
 *
 * This module is deliberately NOT the live login/session flow. It does
 * not touch src/security/session.ts, src/security/githubOAuth.ts, any
 * cookie, any store backend, any secret, or any provider network call.
 * A later slice wires these pure rules into the live flow; until then
 * they are testable policy, not behaviour change.
 *
 * What is covered:
 * - A provider boundary: descriptors for OIDC providers and for the
 *   existing GitHub OAuth2 provider (which issues no ID token, so
 *   OIDC claim validation does not apply to it).
 * - OIDC claim validation: issuer, audience, subject, expiry.
 * - Session expiry: absolute TTL + idle timeout.
 * - Session rotation: a new id revokes the old one.
 * - Revocation propagation contract: a RevocationStore interface.
 * - Step-up: authentication freshness for sensitive actions.
 *
 * What is NOT covered, explicitly:
 * - Cryptographic signature / JWKS verification of ID tokens.
 *   validateOidcClaims runs on claims the caller has already
 *   obtained; it proves the claims are the expected ones, not that
 *   the token is authentic. Signature verification is a later
 *   wiring step and must not be claimed from this module.
 * - Social login establishing legal identity (#945 §2). Identity
 *   here remains (issuer, subject) per Slice 1; email and display
 *   login are NOT inputs to any function in this module.
 * - Provider selection and costs. The merged spec (§8) lists Auth0
 *   vs application-owned OIDC and Auth0 production costs as open
 *   decisions due before Slice 2; this module therefore wires no
 *   Auth0 or Google provider, and only describes Google as a
 *   generic OIDC descriptor a caller can construct.
 * - Step-up thresholds. The merged spec (§8) lists them as an open
 *   CISO decision; the 15-minute default below is a documented
 *   policy default, overridable by the caller, not a settled CISO
 *   threshold.
 * - Revocation propagation latency. This module defines the
 *   contract (revoked ids are unusable on the next check); the
 *   measurable propagation requirement is still open per spec §8.
 *
 * Time is always a caller-supplied `nowMs` seam (milliseconds since
 * epoch), never Date.now() inside a decision, so every rule is
 * testable at its exact boundary. OIDC `exp` claims are in seconds
 * since epoch, per the OIDC specification, and are converted once
 * at the boundary.
 */

import { SESSION_LIMITS } from "../config/sessionLimits";

// ---------------------------------------------------------------------------
// Provider boundary
// ---------------------------------------------------------------------------

export type ProviderProtocol = "oidc" | "oauth2";

export interface ProviderDescriptor {
  providerId: string;
  protocol: ProviderProtocol;
  /** Validated issuer. Compared exactly (after trimming); no URL canonicalization. */
  issuer: string;
  /**
   * Expected `aud` claim for OIDC providers. Null for providers that
   * issue no ID token (GitHub OAuth2): audience validation cannot
   * apply to a token that does not exist.
   */
  audience: string | null;
}

/**
 * The existing login provider. GitHub login in this codebase is
 * OAuth2 + a server-side profile fetch (src/security/githubOAuth.ts),
 * not an OIDC ID-token flow, so it is described here as oauth2 and
 * validateOidcClaims refuses to validate claims against it.
 */
export const GITHUB_PROVIDER: ProviderDescriptor = {
  providerId: "github",
  protocol: "oauth2",
  issuer: "https://github.com",
  audience: null,
};

/** Generic OIDC descriptor, e.g. for Google once a caller wires it. No network, no secrets. */
export function googleOidcProviderDescriptor(clientId: string): ProviderDescriptor {
  return {
    providerId: "google",
    protocol: "oidc",
    issuer: "https://accounts.google.com",
    audience: clientId,
  };
}

export type ProviderDescriptorErrorCode =
  | "INVALID_PROVIDER_ID"
  | "INVALID_ISSUER"
  | "INVALID_AUDIENCE";

export type ProviderDescriptorResult =
  | { ok: true; provider: ProviderDescriptor }
  | { ok: false; code: ProviderDescriptorErrorCode; error: string };

const MAX_FIELD_LENGTH = 512;

function isValidField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_FIELD_LENGTH
  );
}

/** Build an OIDC provider descriptor, rejecting empty issuer/audience up front. */
export function createOidcProviderDescriptor(input: {
  providerId: string;
  issuer: string;
  audience: string;
}): ProviderDescriptorResult {
  if (!isValidField(input.providerId)) {
    return { ok: false, code: "INVALID_PROVIDER_ID", error: "providerId must be a non-empty string of at most 512 characters" };
  }
  if (!isValidField(input.issuer)) {
    return { ok: false, code: "INVALID_ISSUER", error: "issuer must be a non-empty string of at most 512 characters" };
  }
  if (!isValidField(input.audience)) {
    return { ok: false, code: "INVALID_AUDIENCE", error: "audience must be a non-empty string of at most 512 characters" };
  }
  return {
    ok: true,
    provider: {
      providerId: input.providerId.trim(),
      protocol: "oidc",
      issuer: input.issuer.trim(),
      audience: input.audience.trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// OIDC claim validation (claims only — see the module header re: signatures)
// ---------------------------------------------------------------------------

/** Raw claims as presented by a caller; all fields are untrusted until checked. */
export interface OidcClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  auth_time?: unknown;
}

export type OidcValidationErrorCode =
  | "NOT_OIDC_PROVIDER"
  | "WRONG_ISSUER"
  | "WRONG_AUDIENCE"
  | "INVALID_SUBJECT"
  | "MISSING_EXPIRY"
  | "TOKEN_EXPIRED";

export type OidcValidationResult =
  | { ok: true }
  | { ok: false; code: OidcValidationErrorCode; error: string };

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud.trim() === expected;
  if (Array.isArray(aud)) {
    return aud.some((entry) => typeof entry === "string" && entry.trim() === expected);
  }
  return false;
}

/**
 * Validate OIDC claims against a provider descriptor at `nowMs`.
 * Expiry is exclusive: a token expiring exactly at now is expired.
 * This function does NOT verify a cryptographic signature — see the
 * module header. Do not treat a passing result as proof of authenticity.
 */
export function validateOidcClaims(
  provider: ProviderDescriptor,
  claims: OidcClaims,
  nowMs: number
): OidcValidationResult {
  if (provider.protocol !== "oidc" || provider.audience === null) {
    return {
      ok: false,
      code: "NOT_OIDC_PROVIDER",
      error: "this provider issues no OIDC ID token, so OIDC claim validation does not apply",
    };
  }
  if (!isValidField(claims.iss) || claims.iss.trim() !== provider.issuer) {
    return { ok: false, code: "WRONG_ISSUER", error: "token issuer does not match the provider issuer" };
  }
  if (!audienceMatches(claims.aud, provider.audience)) {
    return { ok: false, code: "WRONG_AUDIENCE", error: "token audience does not include the expected audience" };
  }
  if (!isValidField(claims.sub)) {
    return { ok: false, code: "INVALID_SUBJECT", error: "token subject must be a non-empty string" };
  }
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, code: "MISSING_EXPIRY", error: "token has no numeric expiry claim" };
  }
  if (claims.exp * 1000 <= nowMs) {
    return { ok: false, code: "TOKEN_EXPIRED", error: "token has expired" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Session policy: absolute + idle expiry
// ---------------------------------------------------------------------------

/** Absolute session lifetime from config (7 days), in milliseconds here. */
export const SESSION_ABSOLUTE_TTL_MS = SESSION_LIMITS.absoluteTtlSeconds * 1000;
/** Configured idle timeout (8 hours; owner override of the CISO 30m default). */
export const DEFAULT_IDLE_TIMEOUT_MS = SESSION_LIMITS.idleTimeoutMs;
/** Configured step-up freshness window (15 minutes). */
export const DEFAULT_STEP_UP_FRESHNESS_MS = SESSION_LIMITS.stepUpFreshnessMs;

export interface SessionPolicy {
  absoluteTtlMs: number;
  /** Hard lifetime cap from first login, even with renewals (30 days). */
  maxLifetimeMs: number;
  idleTimeoutMs: number;
  stepUpFreshnessMs: number;
}

/**
 * Resolve the idle window from an owner override (ms as a string) with the
 * settled 8-hour config default (#3113, #945 Q5). Values under 5 minutes
 * are clamped up (a typo like "3000" must not mean 3 seconds), and
 * values above the absolute TTL are clamped down: idle can never exceed the
 * session's own lifetime.
 */
/** Re-exported from the config module; kept here for existing callers/tests. */
export { resolveIdleTimeoutMs } from "../config/sessionLimits";
export const MIN_IDLE_TIMEOUT_MS = SESSION_LIMITS.minIdleTimeoutMs;

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  absoluteTtlMs: SESSION_ABSOLUTE_TTL_MS,
  maxLifetimeMs: SESSION_LIMITS.maxLifetimeSeconds * 1000,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  stepUpFreshnessMs: DEFAULT_STEP_UP_FRESHNESS_MS,
};

/**
 * Minimal session state this policy needs. It intentionally carries
 * no email, display login, or token: identity is the internal user
 * id bound in Slice 1 to (issuer, subject).
 */
export interface SessionState {
  sessionId: string;
  internalUserId: string;
  createdAtMs: number;
  /**
   * First creation time, preserved across sliding renewals. Absent
   * on legacy states, where createdAtMs is the first creation time
   * and the cap falls back to it.
   */
  firstCreatedAtMs?: number;
  lastActivityMs: number;
  /** Milliseconds of the last authentication (or step-up) event. */
  authTimeMs: number;
}

export type SessionExpiryReason =
  | "OK"
  | "ABSOLUTE_EXPIRED"
  | "LIFETIME_EXPIRED"
  | "IDLE_EXPIRED";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidSessionState(session: SessionState, nowMs: number): boolean {
  return (
    isValidField(session.sessionId) &&
    isValidField(session.internalUserId) &&
    isFiniteNumber(session.createdAtMs) &&
    isFiniteNumber(session.lastActivityMs) &&
    isFiniteNumber(session.authTimeMs) &&
    // A session cannot be created in the future; that is corrupt state, not a live session.
    session.createdAtMs <= nowMs &&
    session.lastActivityMs <= nowMs
  );
}

/**
 * Pure expiry check: lifetime cap first (the outermost bound), then
 * absolute deadline, then idle deadline. All are exclusive. The cap
 * is measured from firstCreatedAtMs, falling back to createdAtMs
 * for legacy states — matching production enforcement
 * (getValidatedSession), which already applied the cap while this
 * pure helper did not.
 */
export function sessionExpiryReason(
  session: SessionState,
  policy: SessionPolicy,
  nowMs: number
): SessionExpiryReason {
  const firstCreatedAtMs = isFiniteNumber(session.firstCreatedAtMs)
    ? (session.firstCreatedAtMs as number)
    : session.createdAtMs;
  if (nowMs >= firstCreatedAtMs + policy.maxLifetimeMs) return "LIFETIME_EXPIRED";
  if (nowMs >= session.createdAtMs + policy.absoluteTtlMs) return "ABSOLUTE_EXPIRED";
  if (nowMs >= session.lastActivityMs + policy.idleTimeoutMs) return "IDLE_EXPIRED";
  return "OK";
}

// ---------------------------------------------------------------------------
// Revocation propagation contract
// ---------------------------------------------------------------------------

/**
 * Contract a session store must satisfy for revocation to propagate.
 * Callers register a session at issuance (and at rotation); revoking
 * a session, or all sessions for a user, makes exactly those session
 * ids unusable on the next sessionIsUsable check. Revoking all of a
 * user's sessions does NOT ban the user: a session issued afterwards
 * is usable, because revocation is of sessions, not of the identity.
 */
export interface RevocationStore {
  registerSession(sessionId: string, internalUserId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllSessionsForUser(internalUserId: string): Promise<void>;
  isSessionRevoked(sessionId: string): Promise<boolean>;
}

/** In-memory store for tests and for callers that have not wired a backend yet. */
export function createMemoryRevocationStore(): RevocationStore {
  const sessionToUser = new Map<string, string>();
  const revoked = new Set<string>();

  return {
    async registerSession(sessionId, internalUserId) {
      sessionToUser.set(sessionId, internalUserId);
    },
    async revokeSession(sessionId) {
      revoked.add(sessionId);
    },
    async revokeAllSessionsForUser(internalUserId) {
      for (const [sessionId, userId] of sessionToUser) {
        if (userId === internalUserId) revoked.add(sessionId);
      }
    },
    async isSessionRevoked(sessionId) {
      return revoked.has(sessionId);
    },
  };
}

export type SessionUsabilityReason =
  | "OK"
  | "INVALID_SESSION"
  | "REVOKED"
  | "ABSOLUTE_EXPIRED"
  | "LIFETIME_EXPIRED"
  | "IDLE_EXPIRED";

export interface SessionUsability {
  usable: boolean;
  reason: SessionUsabilityReason;
}

/** Combined usability check: validity, then revocation, then expiry. */
export async function sessionIsUsable(
  store: RevocationStore,
  session: SessionState,
  policy: SessionPolicy,
  nowMs: number
): Promise<SessionUsability> {
  if (!isValidSessionState(session, nowMs)) {
    return { usable: false, reason: "INVALID_SESSION" };
  }
  if (await store.isSessionRevoked(session.sessionId)) {
    return { usable: false, reason: "REVOKED" };
  }
  const expiry = sessionExpiryReason(session, policy, nowMs);
  if (expiry !== "OK") return { usable: false, reason: expiry };
  return { usable: true, reason: "OK" };
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export type RotationResult =
  | { ok: true; session: SessionState }
  | { ok: false; code: "INVALID_SESSION_ID" | "SAME_SESSION_ID"; error: string };

/**
 * Rotate a session to a new id: the old id is revoked via the store.
 * Rotation preserves createdAtMs (absolute expiry is NOT extended)
 * and authTimeMs (rotation is NOT re-authentication); it only resets
 * the idle clock to `nowMs`. The caller registers the new session
 * with the store; this function does not register it, so a failed
 * registration cannot leave a half-rotated state behind silently.
 */
export async function rotateSession(
  store: RevocationStore,
  session: SessionState,
  newSessionId: string,
  nowMs: number
): Promise<RotationResult> {
  if (!isValidField(newSessionId)) {
    return { ok: false, code: "INVALID_SESSION_ID", error: "new session id must be a non-empty string" };
  }
  if (newSessionId.trim() === session.sessionId) {
    return { ok: false, code: "SAME_SESSION_ID", error: "rotation requires a different session id" };
  }
  await store.revokeSession(session.sessionId);
  return {
    ok: true,
    session: {
      ...session,
      sessionId: newSessionId.trim(),
      lastActivityMs: nowMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

/**
 * True when a sensitive action requires fresh authentication.
 * Freshness is: authTimeMs is a finite number, not in the future,
 * and younger than the freshness window. A missing, invalid, or
 * future auth time is treated as stale, never as fresh.
 * This answers freshness only; callers must check sessionIsUsable
 * separately before relying on a session at all.
 */
export function requiresStepUp(
  session: SessionState,
  policy: SessionPolicy,
  nowMs: number
): boolean {
  if (!isFiniteNumber(session.authTimeMs)) return true;
  if (session.authTimeMs > nowMs) return true;
  return nowMs - session.authTimeMs >= policy.stepUpFreshnessMs;
}
