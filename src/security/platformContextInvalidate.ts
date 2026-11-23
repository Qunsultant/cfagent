/**
 * #6151 S1 — invalidate a principal's cached platform-context facts.
 *
 * The session-facts cache (src/security/platformContext.ts) is keyed
 * by principal + session, so a webhook or grant that changes what a
 * resolution returns (a subscription, an account tier, a membership)
 * must clear the affected sessions' entries or the next load in an
 * open session re-resolves stale facts for up to the cache TTL. The
 * webhook/grant call sites know the affected user by login (billing,
 * grants) or by internal user id (role grants) — never by session id
 * — so this module bridges that gap: list the session registry,
 * find the principal's sessions, drop each one's cached facts.
 *
 * Best-effort by design: a listing failure returns 0 and never
 * throws — the caller must not fail a webhook response or a grant
 * because the session listing was unavailable. The grant itself
 * already succeeded and its audit record stands; the worst case is
 * a stale read until the TTL lapses.
 *
 * Sign-in mints a fresh session id, so its cache is cold by
 * construction — the sign-in call site invalidates the new id as
 * the event's wiring point (and as a guard against any future
 * session-id reuse), not because it drops anything today.
 */
import type { Env } from "../types";
import { listSessionFamilyEntries } from "./session";
import {
  parseSessionRegistryEntries,
  sessionsForPrincipal,
  type SessionRegistryEntry,
} from "./iaaaSessionRegistry";
import {
  invalidatePlatformContextSession,
  type PlatformContextReResolutionEvent,
} from "./platformContext";

/**
 * The one session listing this module performs (the step-5b census
 * pins it): the login and principal variants share it, filtering
 * the parsed registry entries differently below.
 */
async function listPrincipalSessions(env: Env): Promise<SessionRegistryEntry[]> {
  const entries = await listSessionFamilyEntries(env, "");
  if (entries === null) return [];
  return parseSessionRegistryEntries(entries);
}

async function dropSessions(
  sessionIds: string[],
  event: PlatformContextReResolutionEvent,
): Promise<number> {
  let dropped = 0;
  for (const sessionId of sessionIds) {
    if (invalidatePlatformContextSession(sessionId, event)) dropped += 1;
  }
  return dropped;
}

/**
 * Drop the cached platform-context facts for every session of the
 * principal (by internal user id). Returns how many sessions had
 * cached facts dropped; 0 when the listing was unavailable or
 * nothing was cached. Never throws.
 */
export async function invalidatePlatformContextForPrincipal(
  env: Env,
  internalUserId: string,
  event: PlatformContextReResolutionEvent,
): Promise<number> {
  try {
    const sessions = sessionsForPrincipal(
      await listPrincipalSessions(env),
      internalUserId,
    );
    return await dropSessions(
      sessions.map((entry) => entry.sessionId),
      event,
    );
  } catch {
    return 0;
  }
}

/**
 * Drop the cached platform-context facts for every session of the
 * login (the commercial account / subscription owner). Same
 * best-effort contract as the principal variant. The login match
 * also covers legacy sessions, which carry no internalUserId.
 */
export async function invalidatePlatformContextForLogin(
  env: Env,
  login: string,
  event: PlatformContextReResolutionEvent,
): Promise<number> {
  try {
    const sessions = (await listPrincipalSessions(env)).filter(
      (entry) => entry.githubLogin === login,
    );
    return await dropSessions(
      sessions.map((entry) => entry.sessionId),
      event,
    );
  } catch {
    return 0;
  }
}
