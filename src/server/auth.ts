/**
 * Shared Worker-entry auth helpers (Qunsultant/cfagent#2902, Slice 2 Core).
 *
 * Moved verbatim from src/server.ts (contract section 2: shared helpers
 * live once, never duplicated per domain). Every domain route module
 * imports requireAuth / authenticateRequest / isAllowedOrigin from here.
 * No behaviour change: same session resolution, same cookie candidates,
 * same wired-session validation, same origin allowlist.
 */

import type { Env, SessionData } from "../types";
import { getSessionIdCandidates } from "../session";
import { getSessionCached, getSessionCachedFetchedAt, invalidateSessionCache } from "../security/sessionCache";
import { resolveIdleTimeoutMs } from "../security/sessionPolicy";
import { getSession, updateSession } from "../security/session";
import { resolveWiredFreshnessMs, validateAndTouchWiredSession } from "../security/iaaaEnforcement";
import { createResourceUsagePort } from "../telemetry/createResourceUsagePorts";
import type { ResourceAttribution } from "../telemetry/resourceUsagePorts";
import { isWiringEnabled } from "../security/providers";



export function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // Non-browser clients or direct connections

  try {
    const originHost = new URL(origin).host;
    const requestHost = new URL(request.url).host;
    if (originHost === requestHost) return true;

    if (env.APP_BASE_URL) {
      const allowedHost = new URL(env.APP_BASE_URL).host;
      if (originHost === allowedHost) return true;
    }
    if (originHost === "agent.openaimp.com" || originHost.endsWith(".openaimp.com")) return true;
    if (originHost === "localhost" || originHost.startsWith("localhost:")) return true;
    if (originHost === "127.0.0.1" || originHost.startsWith("127.0.0.1:")) return true;
    if (originHost === "[::1]" || originHost.startsWith("[::1]:")) return true;
  } catch {
    return false;
  }
  return false;
}


export async function requireAuth(request: Request, env: Env): Promise<SessionData | null> {
  return (await authenticateRequest(request, env))?.session ?? null;
}


/**
 * Resolve the request's session across every `session_id` cookie the browser
 * sent. A stale duplicate (older Domain/Path variant) must not shadow the
 * live one: candidates are tried in header order, and the id that actually
 * produces a session is returned so the caller re-issues THAT cookie.
 */
export async function authenticateRequest(
  request: Request,
  env: Env,
): Promise<{ session: SessionData; sessionId: string } | null> {
  // Issue #329: a value that isn't a UUID cannot name a session, so reject it
  // before the cache and before the session store. The candidate list is
  // deduplicated and capped, so a hostile Cookie header cannot fan out reads.
  const sessionIds = getSessionIdCandidates(request);
  if (sessionIds.length === 0) return null;
  // #1819: the auth path is the top SessionStore source, so its backing
  // reads are attributed (caller requireAuth / validateAndTouchWiredSession,
  // trigger user) and forwarded to the resource sink when one is durably
  // bound. withProjection: true fans out to the Analytics Engine stream
  // AND the D1 projection, because the ScheduledAgent rollup/alert/
  // comparison goals can only query D1 from inside the Worker. When no
  // durable sink is bound the opts are undefined and the store_op v2
  // log lines remain the record — a per-isolate sink that silently
  // dropped events would be worse than none. A cache hit emits
  // nothing: no rows were read.
  const resourceSink = createResourceUsagePort(env, { withProjection: true });
  const authResource = resourceSink
    ? { resourceSink, attribution: { caller: "requireAuth", trigger: "user" } as ResourceAttribution }
    : undefined;
  const idleTimeoutMs = resolveIdleTimeoutMs(env.SESSION_IDLE_TIMEOUT_MS);

  for (const sessionId of sessionIds) {
    const cached = await getSessionCached(env, sessionId, authResource);
    if (!cached) continue;
    // #945 Phase 2b-part1: when wiring is ON, a session that already
    // carries an internalUserId (a wired session) is validated through
    // the wired path — fresh read, absolute + idle expiry, touch +
    // persist + cache invalidation. Every other case returns the cached
    // session exactly as before.
    // Issue #2444: the wired path is freshness-gated — a cached copy
    // fetched within IAAA_WIRED_FRESHNESS_MS (default 30s) is served
    // after local expiry validation only, with no fresh store read.
    // SECURITY TRADE-OFF: revocation/step-up propagation is delayed
    // up to the window (CISO domain, #945 open item). Gate hits
    // perform no store op and therefore emit no resource event —
    // exactly like cache hits today; the reads that DO happen keep
    // their wiredResource attribution below, and the 24h DO-request
    // watch measures the collapse. Window 0 disables gating.
    if (isWiringEnabled(env) && cached.internalUserId) {
      const wiredResource = resourceSink
        ? {
            resourceSink,
            attribution: { caller: "validateAndTouchWiredSession", trigger: "user" } as ResourceAttribution,
          }
        : undefined;
      const fetchedAtMs = getSessionCachedFetchedAt(sessionId);
      const result = await validateAndTouchWiredSession(
        {
          freshRead: (id) => getSession(env, id, wiredResource),
          persist: (id, data, nowMs) => updateSession(env, id, data, nowMs, wiredResource),
          invalidate: (id) => invalidateSessionCache(id),
        },
        cached,
        sessionId,
        Date.now(),
        {
          idleTimeoutMs,
          fetchedAtMs: fetchedAtMs ?? undefined,
          freshnessWindowMs: resolveWiredFreshnessMs(env.IAAA_WIRED_FRESHNESS_MS),
        },
      );
      if (result.wired) {
        if (!result.session) continue;
        return { session: result.session, sessionId };
      }
    }
    return { session: cached, sessionId };
  }
  return null;
}
