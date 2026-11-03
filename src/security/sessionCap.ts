/**
 * Issue #2840 (#2837 sub-issue, Q1) — per-user concurrent-session
 * cap with oldest-out eviction.
 *
 * DECISION (recorded for owner correction): the cap is 10
 * concurrent ACTIVE sessions per user, not unlimited. Rationale:
 * 10 covers every plausible multi-device shape (phone, laptop,
 * tablet, several browsers, a spare) while bounding the
 * sessions-bucket listing the cap itself reads, the blast radius
 * of a stolen-credential session spray, and the rows-read cost
 * of the login-time count. Unlimited was rejected because the
 * store previously had no countability at all — an unbounded
 * session set is also an unbounded listing for the #2836 admin
 * surface and for offboarding revocation.
 *
 * COUNTABILITY (the actual work): the SessionStore DO already
 * lists the sessions namespace (#1758, reused by #2836); this
 * module adds no second store and no second listing. It reuses
 * #2836's active-session parser (parseLoggedInSessionEntry),
 * so "active" means exactly what the admin surface shows:
 * absolute 7d + 30d lifetime cap + idle window, with legacy
 * sessions (no activity recorded) idle-exempt. Expired rows the
 * store still lists never count.
 *
 * EVICTION SEMANTICS (fail-visible, never a silent swap):
 * - At the cap, a new login evicts the OLDEST active session
 *   (by createdAt, ties by lastSeenMs, then session id for
 *   determinism) until room exists for the new session; the
 *   login itself succeeds. The eviction is reported to the
 *   caller (evictedSessionIds) so the login path can audit it
 *   and invalidate the isolate cache; the evicted session's
 *   next use fails as unauthenticated (the existing deleted-
 *   session path), and the #2836 panel shows it gone.
 * - When already over the cap (e.g. sessions predating the
 *   cap), eviction brings the count to cap-1 before creating.
 * - Legacy sessions (no internalUserId) are NEVER counted
 *   toward a wired user's cap and never evicted by it: they
 *   cannot be attributed to the logging-in user, and evicting
 *   an unattributed session would be a cross-user revocation.
 *   They stay visible to platform admins only (#2836 rule).
 * - Fail-closed: an unavailable listing (null) or a throwing
 *   list/delete fails the login visibly (SessionCapError with
 *   SESSION_CAP_UNAVAILABLE / SESSION_CAP_EVICTION_FAILED)
 *   instead of creating a session over the cap. A listing
 *   failure in production implies the same DO the login's own
 *   session write needs, so fail-closed costs no login that
 *   would otherwise have succeeded.
 *
 * This module performs no I/O itself: list/delete are injected
 * seams, so the login path supplies the production functions
 * and tests supply fakes. No tokens, secrets, or payloads are
 * read or returned — session ids, times, and counts only.
 */

import { SESSION_LIMITS } from "../config/sessionLimits";
import {
  parseLoggedInSessionEntry,
  type LoggedInSession,
} from "./iaaaLoggedInUsers";

/** The configured cap (10); also the fallback for bad config. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS_PER_USER = 10;

/**
 * Resolve the configured cap. A non-integer, non-positive, or
 * non-finite value falls back to the default — a bad config
 * value must never disable the cap (0) or uncap it (Infinity).
 */
export function resolveSessionCap(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return DEFAULT_MAX_CONCURRENT_SESSIONS_PER_USER;
  }
  return raw;
}

/** The cap in force from config/session-limits.json. */
export function sessionCap(): number {
  return resolveSessionCap(SESSION_LIMITS.maxConcurrentSessionsPerUser);
}

/**
 * The user's ACTIVE sessions from raw sessions-bucket entries,
 * under #2836's active definition. Provider resolution is
 * irrelevant to counting, so the resolver returns null.
 */
export function activeSessionsForUser(
  entries: Array<{ key: string; value: string }>,
  internalUserId: string,
  nowMs: number,
  idleTimeoutMs: number,
): LoggedInSession[] {
  const sessions: LoggedInSession[] = [];
  for (const entry of entries) {
    const parsed = parseLoggedInSessionEntry(
      entry.key,
      entry.value,
      nowMs,
      idleTimeoutMs,
      () => null,
    );
    if (parsed && parsed.internalUserId === internalUserId) sessions.push(parsed);
  }
  return sessions;
}

/** Oldest first: createdAt, then lastSeenMs, then session id. */
function compareOldestFirst(a: LoggedInSession, b: LoggedInSession): number {
  if (a.createdMs !== b.createdMs) return a.createdMs - b.createdMs;
  if (a.lastSeenMs !== b.lastSeenMs) return a.lastSeenMs - b.lastSeenMs;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

export interface SessionEvictionSelection {
  /** Sessions that survive (newest-first is NOT guaranteed; callers re-sort if they display). */
  kept: LoggedInSession[];
  /** Sessions to delete, oldest first. */
  evicted: LoggedInSession[];
}

/**
 * Pure oldest-out selection: keep at most cap-1 sessions so the
 * incoming login fits under the cap. Below the cap, nothing is
 * evicted; at/over the cap, the oldest go first.
 */
export function selectSessionEvictions(
  sessions: LoggedInSession[],
  cap: number,
): SessionEvictionSelection {
  const resolvedCap = resolveSessionCap(cap);
  const sorted = [...sessions].sort(compareOldestFirst);
  const evictCount = Math.max(0, sorted.length - (resolvedCap - 1));
  return {
    kept: sorted.slice(evictCount),
    evicted: sorted.slice(0, evictCount),
  };
}

/** Fail-closed cap error: the code is the user-visible reason. */
export class SessionCapError extends Error {
  constructor(
    public readonly code: "SESSION_CAP_UNAVAILABLE" | "SESSION_CAP_EVICTION_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "SessionCapError";
  }
}

export interface EnforceSessionCapDeps {
  /** Sessions-bucket listing; null means unavailable (fail-visible, never empty). */
  listEntries: () => Promise<Array<{ key: string; value: string }> | null>;
  /** Delete one session by id. */
  deleteSession: (sessionId: string) => Promise<void>;
  internalUserId: string;
  cap: number;
  nowMs: number;
  idleTimeoutMs: number;
  /** Best-effort hook per evicted id (audit, cache invalidation). Never throws into the caller. */
  onEvicted?: (sessionId: string) => Promise<void> | void;
}

export interface EnforceSessionCapResult {
  evictedSessionIds: string[];
  /** Active count before eviction (the count the decision used). */
  activeCountBefore: number;
}

/**
 * Enforce the cap BEFORE the caller creates the new session:
 * list, count the user's active sessions, evict oldest-out to
 * cap-1, and report the evicted ids. Throws SessionCapError on
 * an unavailable listing or a failed eviction — the caller must
 * fail the login visibly, not create over the cap.
 */
export async function enforceSessionCap(
  deps: EnforceSessionCapDeps,
): Promise<EnforceSessionCapResult> {
  let entries: Array<{ key: string; value: string }> | null;
  try {
    entries = await deps.listEntries();
  } catch (err) {
    throw new SessionCapError(
      "SESSION_CAP_UNAVAILABLE",
      `SESSION_CAP_UNAVAILABLE: session limit cannot be verified: session listing failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (entries === null) {
    throw new SessionCapError(
      "SESSION_CAP_UNAVAILABLE",
      "SESSION_CAP_UNAVAILABLE: session limit cannot be verified: session listing unavailable",
    );
  }
  const active = activeSessionsForUser(
    entries,
    deps.internalUserId,
    deps.nowMs,
    deps.idleTimeoutMs,
  );
  const { evicted } = selectSessionEvictions(active, deps.cap);
  const evictedSessionIds: string[] = [];
  for (const session of evicted) {
    try {
      await deps.deleteSession(session.sessionId);
    } catch (err) {
      throw new SessionCapError(
        "SESSION_CAP_EVICTION_FAILED",
        `SESSION_CAP_EVICTION_FAILED: session limit cannot be enforced: evicting oldest session failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    evictedSessionIds.push(session.sessionId);
    if (deps.onEvicted) {
      try {
        await deps.onEvicted(session.sessionId);
      } catch {
        // Best-effort hook (audit/cache): a hook failure must
        // never undo an eviction that already landed.
      }
    }
  }
  return { evictedSessionIds, activeCountBefore: active.length };
}
