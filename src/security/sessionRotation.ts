/**
 * Issue #3113 (#945 Q5) — rotation triggers on privilege change.
 *
 * Before this slice, `rotateSession` (sessionPolicy.ts) existed and
 * was tested but had zero production callers: no session was ever
 * rotated on privilege change or auth-method change. This module
 * is the trigger.
 *
 * Rule: after a successful role/membership grant or revoke, every
 * ACTIVE session of the affected user rotates — the old id is
 * revoked and a rotated copy is registered with createdAt,
 * firstCreatedAt, and authTimeMs preserved (rotation is NOT
 * re-authentication and does NOT extend absolute expiry; only the
 * idle clock resets). Expired sessions are skipped, never
 * resurrected. Other users' sessions and legacy sessions (no
 * internalUserId) are untouched.
 *
 * Why rotation, not just revocation: the rotated copy keeps the
 * user's other tabs working with the same session data under a
 * fresh id, while any leaked old id is dead. Note the honest
 * limit: a rotated copy only helps a browser that receives the
 * new id — for the acting session the route re-issues the cookie
 * in its response; other browsers holding the old id are
 * effectively logged out and sign in again. The security
 * property (the old id is dead after the privilege change) holds
 * in both cases.
 *
 * Effective expiry is preserved by the record's timestamps, not
 * by store TTL: enforcement reads createdAt/firstCreatedAt
 * (getValidatedSession), so registering the copy at the standard
 * 7-day store TTL cannot extend the session past its original
 * absolute deadline or its 30-day lifetime cap.
 *
 * Auth-method change: there is no in-app auth-method-change
 * route (established by Q4). The settled rule is that every
 * login mints a fresh id, so provider (re)linking — which flows
 * through login — rotates by construction; any future
 * auth-method-change route MUST call rotateUserSessions (see
 * the Q5 doc). Nothing in this module invents such a route.
 */

import { SESSION_LIMITS } from "../config/sessionLimits";
import type { Env, SessionData } from "../types";
import {
  createSession,
  deleteSession,
  getSessionIdCandidates,
  listSessionFamilyEntries,
  setSessionCookie,
} from "./session";

/** Session-id shape: live sessions are bare-UUID keys in the sessions namespace. */
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One listed session record, paired with its store key (the id). */
export interface ListedSession {
  sessionId: string;
  data: SessionData;
}

/**
 * Minimal store contract the rotation core needs. The env adapter
 * in server.ts implements it over session.ts functions (which
 * abstract the ports/DO backends); tests use an in-memory fake.
 * `registerSession` returns the id the copy was registered under
 * (the store mints it — createSession ignores any id in data).
 */
export interface RotationStore {
  listSessions(): Promise<ListedSession[]>;
  revokeSession(sessionId: string): Promise<void>;
  registerSession(session: SessionData): Promise<string>;
}

export interface RotationResult {
  rotated: Array<{ oldId: string; newId: string }>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Active by the same rules production enforcement uses
 * (getValidatedSession): absolute 7d from createdAt, 30d cap from
 * firstCreatedAt (falling back to createdAt for legacy records),
 * idle 8h only when activity was recorded — sessions without
 * recorded activity are idle-exempt.
 */
export function isSessionActiveForRotation(
  data: SessionData,
  nowMs: number,
): boolean {
  if (!isFiniteNumber(data.createdAt)) return false;
  if (data.createdAt + SESSION_LIMITS.absoluteTtlSeconds * 1000 <= nowMs) {
    return false;
  }
  const firstCreatedAt = isFiniteNumber(data.firstCreatedAt)
    ? data.firstCreatedAt
    : data.createdAt;
  if (firstCreatedAt + SESSION_LIMITS.maxLifetimeSeconds * 1000 <= nowMs) {
    return false;
  }
  if (
    isFiniteNumber(data.lastActivityMs) &&
    data.lastActivityMs + SESSION_LIMITS.idleTimeoutMs <= nowMs
  ) {
    return false;
  }
  return true;
}

/**
 * Rotate every active session of `userId`. Returns the old→new id
 * pairs so the caller can re-issue the acting session's cookie
 * when the acting session itself rotated.
 */
export async function rotateUserSessions(
  store: RotationStore,
  userId: string,
  nowMs: number,
): Promise<RotationResult> {
  const rotated: Array<{ oldId: string; newId: string }> = [];
  const entries = await store.listSessions();
  for (const entry of entries) {
    if (entry.data.internalUserId !== userId) continue;
    if (!isSessionActiveForRotation(entry.data, nowMs)) continue;
    await store.revokeSession(entry.sessionId);
    const newId = await store.registerSession({
      ...entry.data,
      lastActivityMs: nowMs,
    });
    rotated.push({ oldId: entry.sessionId, newId });
  }
  return { rotated };
}

export interface EnvRotationResult extends RotationResult {
  /**
   * True when the session listing was unavailable, so no rotation
   * ran. Callers surface this (never silently skip) — the grant
   * itself already succeeded, and its audit record stands; the
   * rotated count in the response is 0 with this flag set.
   */
  unavailable: boolean;
}

/**
 * Env adapter: lists the sessions namespace (both backends via
 * listSessionFamilyEntries), filters to UUID keys, and rotates via
 * deleteSession + createSession (which mints the new id and stores
 * at the standard TTL — effective expiry is still bounded by the
 * preserved createdAt/firstCreatedAt timestamps, see module header).
 */
export async function rotateUserSessionsForEnv(
  env: Env,
  userId: string,
  nowMs: number,
): Promise<EnvRotationResult> {
  const entries = await listSessionFamilyEntries(env, "");
  if (entries === null) return { rotated: [], unavailable: true };
  const store: RotationStore = {
    async listSessions() {
      const out: ListedSession[] = [];
      for (const entry of entries) {
        if (!SESSION_ID_PATTERN.test(entry.key)) continue;
        try {
          out.push({
            sessionId: entry.key,
            data: JSON.parse(entry.value) as SessionData,
          });
        } catch {
          continue;
        }
      }
      return out;
    },
    async revokeSession(sessionId: string) {
      await deleteSession(env, sessionId);
    },
    async registerSession(session: SessionData) {
      return createSession(env, session);
    },
  };
  const result = await rotateUserSessions(store, userId, nowMs);
  return { ...result, unavailable: false };
}

/**
 * When the acting session itself rotated, the route must re-issue
 * its cookie or the actor is logged out by their own grant. The
 * acting session id is one of the request's cookie candidates
 * (requireAuth resolves from the same list), so a rotated old id
 * matching a candidate identifies it. Returns the Set-Cookie
 * string, or null when the acting session did not rotate. Only
 * counts, never ids, leave this module in responses or logs.
 */
export function sessionRotationCookie(
  request: Request,
  rotation: RotationResult,
): string | null {
  const candidates = getSessionIdCandidates(request);
  const selfRotated = rotation.rotated.find((pair) =>
    candidates.includes(pair.oldId),
  );
  if (!selfRotated) return null;
  return setSessionCookie(selfRotated.newId);
}
