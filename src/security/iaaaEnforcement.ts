/**
 * #945 Wiring Phase 2b-part1 — live enforcement call sites (pure
 * decision + orchestration helpers for server.ts).
 *
 * This module is the ONLY place that decides whether a request uses
 * the wired validation path. server.ts requireAuth calls it only
 * when IAAA wiring is ON, and only for sessions that already carry
 * an internalUserId (a wired session). Everything else keeps the
 * exact legacy cached path, byte for byte:
 *
 * - Wiring OFF: this module is never called. requireAuth is the
 *   original single line (`getSessionCached`), unchanged.
 * - Wiring ON, session without internalUserId (legacy / Phase 1):
 *   validateAndTouchWiredSession returns { wired: false } having
 *   performed NO fresh read, NO persist, and NO invalidation, and
 *   requireAuth returns the cached session exactly as before.
 *   Such sessions stay idle-exempt, per the Phase 2a contract.
 * - Wiring ON, wired session: the cached copy only decides THAT
 *   the session is wired (internalUserId never changes after
 *   creation, so a <=60s-stale copy cannot misclassify it). The
 *   enforcement decision uses a FRESH read (getSession, never
 *   getSessionCached) — EXCEPT when the #2444 freshness gate applies:
 *   a cached copy fetched within IAAA_WIRED_FRESHNESS_MS (default
 *   30s) is served after local expiry validation only, with no fresh
 *   read. The 60s isolate cache cannot enforce idle timeouts in
 *   either direction — it can falsely reject a session touched in
 *   another isolate within the last 60s, or accept a session up to
 *   60s past its idle deadline — which is why the gate still runs
 *   local expiry validation and why the fresh-read path remains for
 *   stale copies. After a touch persist, the caller MUST invalidate
 *   the isolate cache (done here, in the same isolate); updateSession
 *   cannot do it itself without a circular import.
 *
 * Performance note (wiring ON only): a wired session costs one fresh
 * store read per request on top of the cached read, plus one store
 * write per >=60s of activity (touch precision) — UNLESS the #2444
 * gate applies, in which case the fresh read is skipped entirely and
 * the request costs no store read beyond the cached read that
 * requireAuth already performed (zero on a cache hit). That is the
 * deliberate price of idle enforcement, bounded by the window;
 * wiring OFF costs nothing extra, and non-wired sessions under
 * wiring ON cost nothing extra either (no fresh read happens for
 * them).
 *
 * Limitations, stated plainly:
 * - A wired session whose store record vanished (deleted in
 *   another isolate) is denied here, because the cached copy
 *   proves it was wired. But a session with NO cached copy in
 *   this isolate and NO store record cannot be proven wired, so
 *   it falls back to the legacy path — which returns null for
 *   it anyway (negative cache or store miss). Cross-isolate
 *   cache staleness after a delete is bounded by the 60s TTL,
 *   exactly as before wiring; this module does not change it.
 * - Touch persistence is best-effort: if the persist fails, the
 *   validated session is still returned and the cache is kept,
 *   so the next request retries the touch. Authentication is
 *   never failed merely because an activity write failed.
 * - Step-up here means freshness enforcement only: there is no
 *   separate step-up challenge flow yet. A stale session mints
 *   nothing; the user re-authenticates (a fresh login refreshes
 *   authTimeMs) and retries. The 15-minute default is the Slice 2
 *   documented default, NOT a settled CISO threshold.
 */

import { getValidatedSession } from "./iaaaLogin";
import { touchSession } from "./iaaaSessionActivity";
import {
  isSessionStoreBreakerOpen,
  isSessionStoreLimitError,
  noteSuppressedSessionStoreRead,
  tripSessionStoreBreaker,
} from "./sessionQuotaResilience";
import type { SessionData } from "../types";

/** Store operations the wired validation path needs, injectable for tests. */
export interface WiredSessionStoreDeps {
  /** Authoritative read; must be getSession, never getSessionCached. */
  freshRead(sessionId: string): Promise<SessionData | null>;
  /** Persist a touched session under the same id, preserving absolute expiry. */
  persist(
    sessionId: string,
    data: SessionData,
    nowMs: number,
  ): Promise<{ ok: boolean }>;
  /** Drop the session from this isolate's cache. */
  invalidate(sessionId: string): void;
}

export type WiredSessionValidation =
  | { wired: true; session: SessionData }
  | { wired: true; session: SessionData; degraded: true }
  | { wired: true; session: null }
  | { wired: false };

/**
 * Validate a cached session through the wired path.
 *
 * `cached` is the session requireAuth already read (cached path).
 * Only its internalUserId is consulted, and only to decide whether
 * this session is wired at all.
 *
 * Issue #2444 — freshness gate: when the caller supplies a fetchedAtMs
 * within freshnessWindowMs, the cached copy is served after LOCAL
 * expiry validation only (absolute + idle, pure computation on the
 * cached fields — no store op), without a fresh read. SECURITY
 * TRADE-OFF, stated plainly: revocation and step-up are NOT visible
 * in the cached copy, so a session revoked (or newly step-up-gated)
 * in the store within the window keeps being served until the window
 * elapses. That delay is bounded by the window and is a CISO-domain
 * decision (#945 revocation propagation); the window value is
 * owner-set via IAAA_WIRED_FRESHNESS_MS. Expiry is NOT delayed by the
 * gate: a cached copy that fails local validation falls through to
 * the authoritative fresh-read path below. Touch/persist is deferred
 * to the first stale request after the window; idle enforcement stays
 * conservative (a lagging lastActivityMs can only expire a session
 * early, never late).
 */
export interface WiredSessionValidationOptions {
  /** Owner override for the idle window (default 30 minutes). */
  idleTimeoutMs?: number;
  /**
   * Issue #2444: ms since epoch when the cached copy was fetched from
   * the backing store (see getSessionCachedFetchedAt). Absent → the
   * gate is inactive and behavior is unchanged.
   */
  fetchedAtMs?: number;
  /**
   * Issue #2444: freshness window in ms. 0 disables gating (the
   * rollback lever: set IAAA_WIRED_FRESHNESS_MS=0, redeploy, no code
   * change). Absent → the gate is inactive and behavior is unchanged.
   */
  freshnessWindowMs?: number;
}

/**
 * Issue #2444 — default wired freshness window (ms). Single named
 * default: no interval literal for this tunable appears at any use
 * site. Overridden by IAAA_WIRED_FRESHNESS_MS via
 * resolveWiredFreshnessMs; 0 disables gating.
 */
export const DEFAULT_WIRED_FRESHNESS_MS = 30_000;

/**
 * Issue #2444 — resolve the wired freshness window from an operator
 * override, mirroring resolveIdleTimeoutMs. Well-formed non-negative
 * integers win (0 = gating disabled); anything else (unset, empty,
 * non-numeric, negative, non-finite) falls back to the default, so a
 * typo can neither disable the gate nor invent a window.
 */
export function resolveWiredFreshnessMs(
  rawOverride: string | number | undefined | null,
): number {
  // An empty (or whitespace-only) value means "unset", not zero:
  // Number("") is 0, and silently disabling the gate on an empty var
  // would be exactly the wrong failure mode.
  if (typeof rawOverride === "string" && rawOverride.trim() === "") {
    return DEFAULT_WIRED_FRESHNESS_MS;
  }
  const value =
    typeof rawOverride === "number"
      ? rawOverride
      : rawOverride == null
        ? Number.NaN
        : Number(rawOverride);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_WIRED_FRESHNESS_MS;
  return value;
}

export async function validateAndTouchWiredSession(
  deps: WiredSessionStoreDeps,
  cached: SessionData | null,
  sessionId: string,
  nowMs: number,
  options?: WiredSessionValidationOptions,
): Promise<WiredSessionValidation> {
  if (!cached?.internalUserId) {
    return { wired: false };
  }
  // Issue #2444 — freshness gate. A cached copy fetched within the
  // window is served after local expiry validation only (see the
  // options doc above for the trade-off). When the gate does not
  // apply — no fetchedAt, window 0/unset, stale copy, or failed local
  // validation — execution falls through to the fresh-read path
  // below, exactly as before.
  const freshnessWindowMs = options?.freshnessWindowMs;
  const fetchedAtMs = options?.fetchedAtMs;
  if (
    typeof freshnessWindowMs === "number" &&
    Number.isFinite(freshnessWindowMs) &&
    freshnessWindowMs > 0 &&
    typeof fetchedAtMs === "number" &&
    Number.isFinite(fetchedAtMs) &&
    nowMs - fetchedAtMs < freshnessWindowMs
  ) {
    const locallyValidated = getValidatedSession(cached, nowMs, options);
    if (locallyValidated.ok) {
      return { wired: true, session: locallyValidated.session };
    }
  }
  // Issue #2666 — quota resilience (the 2026-10-26 sign-in-down failure
  // mode). While the session-store breaker is open, NO store read is
  // attempted at all: the read is counted as suppressed, and a
  // locally-valid cached session is served degraded instead of
  // failing the request. TRADE-OFF, stated plainly (same family as
  // the #2444 gate's): revocation and step-up propagation are delayed
  // until the store recovers, because the authoritative record cannot
  // be read. Bounded to limit errors only, and local absolute + idle
  // expiry still apply — an expired cached copy NEVER serves, even
  // degraded. A blocked validation with no valid cached copy throws
  // a typed quota error (never null: auth null means
  // "unauthenticated", and returning it during an outage would lie
  // and could drop cookies); the error boundary turns it into a 503.
  if (isSessionStoreBreakerOpen()) {
    noteSuppressedSessionStoreRead();
    const breakerValidated = getValidatedSession(cached, nowMs, options);
    if (breakerValidated.ok) {
      console.warn(
        `[iaaa] wired session ${sessionId} served degraded: session-store breaker open; revocation/step-up propagation delayed until the store recovers`,
      );
      return {
        wired: true,
        session: breakerValidated.session,
        degraded: true,
      };
    }
    throw new Error(
      "session store quota exhausted: breaker open and no locally-valid cached session",
    );
  }
  let fresh: SessionData | null;
  try {
    fresh = await deps.freshRead(sessionId);
  } catch (error) {
    // Non-limit errors propagate UNCHANGED — only a provider limit
    // error degrades. A limit error trips the breaker, then the same
    // local-validation fallback applies: valid cached → degraded
    // serve; invalid cached → the original error rethrown (fail
    // closed), becoming a typed 503 via the error boundary.
    if (!isSessionStoreLimitError(error)) throw error;
    tripSessionStoreBreaker(error);
    const fallbackValidated = getValidatedSession(cached, nowMs, options);
    if (fallbackValidated.ok) {
      console.warn(
        `[iaaa] wired session ${sessionId} served degraded: session-store limit error; revocation/step-up propagation delayed until the store recovers`,
      );
      return {
        wired: true,
        session: fallbackValidated.session,
        degraded: true,
      };
    }
    throw error;
  }
  if (!fresh) {
    // The store record is gone but the cached copy proves this was a
    // wired session: deny, do not resurrect it from cache.
    deps.invalidate(sessionId);
    return { wired: true, session: null };
  }
  if (!fresh.internalUserId) {
    // Defensive branch, unreachable in practice: internalUserId
    // never changes after creation. The authoritative record wins
    // and is returned under legacy semantics.
    return { wired: true, session: fresh };
  }
  const validated = getValidatedSession(fresh, nowMs, options);
  if (!validated.ok) {
    deps.invalidate(sessionId);
    return { wired: true, session: null };
  }
  const touched = touchSession(validated.session, nowMs);
  if (touched.touched) {
    const persisted = await deps.persist(sessionId, touched.session, nowMs);
    if (persisted.ok) {
      deps.invalidate(sessionId);
    }
    return { wired: true, session: touched.session };
  }
  return { wired: true, session: validated.session };
}

/**
 * The two small gating predicates (logout-audit tenant, step-up
 * for minting) live in iaaaGates.ts, not here: this module imports
 * iaaaLogin.ts, which imports githubOAuth.ts, so defining the
 * predicates here would make them unimportable from
 * githubOAuth.ts without a cycle. See iaaaGates.ts.
 */
