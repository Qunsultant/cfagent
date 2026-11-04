import type { Env, SessionData } from "../types";
import { SESSION_LIMITS } from "../config/sessionLimits";
import { validateReturnTarget } from "./returnTarget";
import {
  createStoreKv,
  listStoreEntries,
  type DoNamespaceLike,
} from "./durableKv";
import { type KvLike } from "./kvResilience";
import {
  createSessionPorts,
  isSessionPortsEnabled,
} from "../data/createSessionPorts";
import type { SessionFamilyPorts } from "../data/sessionPorts";
import type { MembershipStore } from "./authorization";
import type { AccessRequestStore } from "./iaaaAccessRequests";
import { createKvMembershipStore } from "./iaaaMembershipStore";
import { createAccessRequestStore } from "./iaaaAccessRequests";

export { isSessionPortsEnabled };
import type {
  ResourceAttribution,
  ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";

/**
 * All durations come from config/session-limits.json (see
 * src/config/sessionLimits.ts). These exports are aliases so callers and
 * tests keep a named constant; no value is duplicated here.
 */
export const SESSION_TTL = SESSION_LIMITS.absoluteTtlSeconds;
/** Hard cap on a session's total life, even when activity keeps renewing. */
export const SESSION_MAX_TTL = SESSION_LIMITS.maxLifetimeSeconds;
/** Renew the absolute window when this little of it remains. */
export const SESSION_RENEW_WINDOW = SESSION_LIMITS.renewWindowSeconds;
export const COOKIE_NAME = "session_id";
const STATE_MAX_AGE_MS = SESSION_LIMITS.oauthStateMaxAgeMs;
const STATE_FUTURE_SKEW_MS = SESSION_LIMITS.oauthStateFutureSkewMs;

/**
 * Every `session_id` value the browser sent, in header order, deduplicated.
 *
 * Browsers can send more than one when a stale cookie differs by Domain/Path
 * (an older host-only cookie plus the current one); taking only the first
 * value binds auth to whichever cookie happens to sort first.
 */
export function getSessionIds(request: Request): string[] {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return [];
  const values: string[] = [];
  const prefix = `${COOKIE_NAME}=`;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length).trim();
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * How many cookie candidates a request may make the auth path resolve.
 *
 * The cap exists for the same reason the shape check does (#329): the Cookie
 * header is attacker-controlled, and an unbounded candidate list turns one
 * request into N SessionStore reads plus N negative-cache entries. Real
 * duplicate-cookie cases come from at most a handful of Domain/Path variants.
 */
export const MAX_SESSION_COOKIE_CANDIDATES = 8;

/**
 * UUID-shaped session ids the auth path should try, in header order, capped.
 * `createSession` mints `crypto.randomUUID()`, so any other shape cannot name
 * a session and must not cost a store read.
 */
export function getSessionIdCandidates(request: Request): string[] {
  return getSessionIds(request)
    .filter(isSessionIdFormat)
    .slice(0, MAX_SESSION_COOKIE_CANDIDATES);
}

/** First UUID-shaped session id (the form `createSession` mints), else the first value. */
export function getSessionId(request: Request): string | null {
  const values = getSessionIds(request);
  return values.find((value) => isSessionIdFormat(value)) ?? values[0] ?? null;
}

/**
 * Shape check for a session id, applied before any session-store read (issue #329).
 *
 * `createSession` mints `crypto.randomUUID()`, so a value that is not a UUID
 * cannot name a session. Checking the shape here means a junk or
 * attacker-supplied `session_id` cookie costs a regex instead of a store `get()` —
 * the negative cache alone still allowed one read per unique value per 10s.
 */
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionIdFormat(
  sessionId: string | null | undefined
): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

export function setSessionCookie(sessionId: string): string {
  return `${COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_LIMITS.cookieMaxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Sessions live in the SessionStore Durable Object (issue #329), not KV.
 *
 * KV's free tier caps reads at 100k/day and throws once exhausted — that throw
 * was the 1101. CORRECTION (issue #1819): the DO is NOT uncapped either
 * (free-tier 5M rows read/day, 100k rows written/day); the earlier "no such
 * cap" wording was wrong, and rows-read exhaustion took sign-in down on
 * 2026-10-26. The legacy KV fallback was removed in #604: the migration
 * window has passed and SESSIONS_KV_FALLBACK=off made it dormant. Auth
 * material stays in the DO (never moves back to KV).
 */
export function sessionStore(
  env: Env,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): KvLike {
  // #2433 (step 5b): flag-on composes through the session
  // family's ports — the returned KvLike is the port's
  // declared sessions-bucket handle over the same DO.
  if (isSessionPortsEnabled(env)) {
    return sessionFamilyPorts(env, resource).kv;
  }
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "sessions",
    legacyFallback: false,
    attribution: resource?.attribution,
    resourceSink: resource?.resourceSink,
  });
}

/**
 * #2433 (step 5b) — the session-family composition for this
 * env: the port set when SESSION_PORTS_ENABLED is on, else
 * null (callers then take today's funnel path, untouched).
 * Factories in this family (this module, iaaaLogin's wired
 * binding store, and server.ts's lifecycle sites via the
 * wired* helpers below) read the flag HERE, at the factory.
 */
export function sessionFamilyPorts(
  env: Env,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): SessionFamilyPorts {
  return createSessionPorts(env, resource);
}

/** Membership store for this env: port-composed when the flag is on.
 *  NOTE (#2433): the four evaluateRoutePep gateway sites in
 *  server.ts deliberately keep the literal
 *  createKvMembershipStore(sessionStore(env)) shape — it is
 *  pinned verbatim by tests/iaaa_legacy_pdp_bound_1749.test.ts
 *  (#1755), and sessionStore(env) is itself flag-aware, so
 *  those sites still run over the port's sessions KvLike
 *  when the flag is on, just not via the port object. */
export function wiredMembershipStore(env: Env): MembershipStore {
  if (isSessionPortsEnabled(env)) return sessionFamilyPorts(env).memberships;
  return createKvMembershipStore(sessionStore(env));
}

/** Access-request store for this env: port-composed when the flag is on. */
export function wiredAccessRequestStore(env: Env): AccessRequestStore {
  if (isSessionPortsEnabled(env)) return sessionFamilyPorts(env).accessRequests;
  return createAccessRequestStore(sessionStore(env));
}

/**
 * Sessions-bucket raw listing for this family's lifecycle
 * sites (registry / membership listings in server.ts):
 * port-composed when the flag is on (the port's named
 * listing operation), today's listStoreEntries when off.
 * Null means unavailable in both compositions.
 */
export async function listSessionFamilyEntries(
  env: Env,
  prefix: string
): Promise<Array<{ key: string; value: string }> | null> {
  if (isSessionPortsEnabled(env)) {
    return sessionFamilyPorts(env).sessions.listRawEntries(prefix);
  }
  return listStoreEntries({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "sessions",
    prefix,
  });
}

export async function createSession(env: Env, data: SessionData): Promise<string> {
  if (isSessionPortsEnabled(env)) {
    return sessionFamilyPorts(env).sessions.create(data);
  }
  const sessionId = crypto.randomUUID();
  await sessionStore(env).put(sessionId, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  return sessionId;
}

export async function getSession(
  env: Env,
  sessionId: string,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): Promise<SessionData | null> {
  if (isSessionPortsEnabled(env)) {
    return sessionFamilyPorts(env, resource).sessions.get(sessionId);
  }
  const raw = await sessionStore(env, resource).get(sessionId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export type UpdateSessionResult =
  | { ok: true; remainingTtlSeconds: number }
  | {
      ok: false;
      code: "SESSION_INVALID_CREATED_AT" | "SESSION_ABSOLUTE_EXPIRED";
      error: string;
    };

/**
 * #945 Wiring Phase 2a — persist an updated session record under
 * the SAME session id, with TTL = remaining absolute time.
 *
 * Absolute expiry is NEVER extended: the new TTL is
 * floor((createdAt + SESSION_TTL - nowMs) / 1000), so a touch
 * cannot push a session past its original deadline. A session
 * already past absolute expiry, or with under one second of
 * absolute life left (a TTL of 0 must never be written), is
 * refused and nothing is stored. An invalid createdAt is
 * refused for the same reason: without it there is no deadline
 * to preserve.
 *
 * TTL-overshoot note for the caller: if the underlying store
 * clamps small TTLs upward (Workers KV, for example, has a 60s
 * minimum), a session in its final minute could persist in the
 * store past its absolute deadline. That cannot resurrect it:
 * getValidatedSession re-checks absolute expiry on every read.
 * The caller MUST also call invalidateSessionCache(sessionId)
 * in the same isolate after a successful update (this module
 * cannot import sessionCache.ts without a circular import), or
 * the isolate keeps serving the pre-touch copy until TTL.
 *
 * `updateSessionWithStore` takes the store so tests can use a
 * fake; `updateSession` is the production thin wrapper.
 */
export async function updateSessionWithStore(
  store: KvLike,
  sessionId: string,
  data: SessionData,
  nowMs: number
): Promise<UpdateSessionResult> {
  if (typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)) {
    return {
      ok: false,
      code: "SESSION_INVALID_CREATED_AT",
      error: "session has no valid createdAt, so its absolute deadline cannot be preserved",
    };
  }
  const remainingMs = data.createdAt + SESSION_TTL * 1000 - nowMs;
  const remainingTtlSeconds = Math.floor(remainingMs / 1000);
  if (remainingTtlSeconds < 1) {
    return {
      ok: false,
      code: "SESSION_ABSOLUTE_EXPIRED",
      error: "session is past (or within one second of) its absolute expiry; nothing was stored",
    };
  }
  await store.put(sessionId, JSON.stringify(data), {
    expirationTtl: remainingTtlSeconds,
  });
  return { ok: true, remainingTtlSeconds };
}

/** Production wrapper: the store is the SessionStore DO. */
export async function updateSession(
  env: Env,
  sessionId: string,
  data: SessionData,
  nowMs: number = Date.now(),
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): Promise<UpdateSessionResult> {
  if (isSessionPortsEnabled(env)) {
    return sessionFamilyPorts(env, resource).sessions.update(sessionId, data, nowMs);
  }
  return updateSessionWithStore(sessionStore(env, resource), sessionId, data, nowMs);
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  if (isSessionPortsEnabled(env)) {
    await sessionFamilyPorts(env).sessions.delete(sessionId);
    return;
  }
  await sessionStore(env).delete(sessionId);
}

/**
 * True when a page navigation should slide the absolute window: the
 * session is inside its last two days and has not reached the 30-day
 * lifetime cap. Expired sessions are not renewed (the user signs in again).
 */
export function sessionRenewalDue(session: SessionData, nowMs: number): boolean {
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) return false;
  const firstCreatedAt =
    typeof session.firstCreatedAt === "number" && Number.isFinite(session.firstCreatedAt)
      ? session.firstCreatedAt
      : session.createdAt;
  if (nowMs >= firstCreatedAt + SESSION_MAX_TTL * 1000) return false;
  const remainingMs = session.createdAt + SESSION_TTL * 1000 - nowMs;
  return remainingMs > 0 && remainingMs <= SESSION_RENEW_WINDOW * 1000;
}

/**
 * Slide the absolute 7-day window on an authenticated document navigation.
 * The session id is preserved, so every other open tab keeps working; the
 * browser cookie is re-issued by the caller with a fresh Max-Age. Returns
 * false when no renewal was due (or the lifetime cap is reached).
 */
export async function renewSessionWithStore(
  store: KvLike,
  sessionId: string,
  session: SessionData,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (!sessionRenewalDue(session, nowMs)) return false;
  const firstCreatedAt =
    typeof session.firstCreatedAt === "number" && Number.isFinite(session.firstCreatedAt)
      ? session.firstCreatedAt
      : session.createdAt;
  const renewed: SessionData = {
    ...session,
    createdAt: nowMs,
    firstCreatedAt,
    lastActivityMs: nowMs,
  };
  await store.put(sessionId, JSON.stringify(renewed), {
    expirationTtl: SESSION_TTL,
  });
  return true;
}

/** Production wrapper: the store is the SessionStore DO. */
export async function renewSession(
  env: Env,
  sessionId: string,
  session: SessionData,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (isSessionPortsEnabled(env)) {
    return sessionFamilyPorts(env).sessions.renew(sessionId, session, nowMs);
  }
  return renewSessionWithStore(sessionStore(env), sessionId, session, nowMs);
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Creates a cryptographically signed OAuth state parameter with a timestamp
 * for replay attack prevention.
 */
export async function createState(env: Env): Promise<string> {
  const random = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const payload = `${random}.${timestamp}`;
  const sig = await hmacSign(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

/**
 * Validates the OAuth state parameter in constant time and ensures it hasn't expired.
 *
 * #3015: accepts both the plain 3-part form (random.timestamp.sig)
 * and the return-target 4-part form (random.timestamp.target.sig).
 * The signature always covers every segment before it, so a
 * tampered target segment fails exactly like a tampered signature.
 * Plain states keep verifying exactly as before — in-flight logins
 * at deploy time and other createState callers are unaffected.
 */
export async function verifyState(env: Env, state: string): Promise<boolean> {
  return verifyStateParts(env, state.split("."));
}

async function verifyStateParts(env: Env, parts: string[]): Promise<boolean> {
  if (parts.length !== 3 && parts.length !== 4) return false;
  const [random, timestampStr] = parts;
  const sig = parts[parts.length - 1];
  if (!random || !timestampStr || !sig) return false;
  if (parts.length === 4 && !parts[2]) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (
    isNaN(timestamp) ||
    Date.now() - timestamp > STATE_MAX_AGE_MS ||
    timestamp > Date.now() + STATE_FUTURE_SKEW_MS
  ) {
    return false; // State expired or in the future
  }

  const payload = parts.slice(0, -1).join(".");
  const expectedSig = await hmacSign(env.SESSION_SECRET, payload);

  // Constant-time string equality check to prevent timing side channels
  if (sig.length !== expectedSig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < sig.length; i++) {
    mismatch |= sig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * #3015: base64url helpers for the state target segment. The
 * segment alphabet excludes "." (the state separator) and the
 * URL-unsafe "+/=" characters, so the segment survives provider
 * round-trips as a query parameter. Validated targets are ASCII
 * (URL serialization percent-encodes the rest); a failure here
 * fails closed to null.
 */
function base64UrlEncode(text: string): string | null {
  try {
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  } catch {
    return null;
  }
}

function base64UrlDecode(segment: string): string | null {
  try {
    const restored = segment.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (restored.length % 4)) % 4;
    return atob(restored + "=".repeat(pad));
  } catch {
    return null;
  }
}

/**
 * #3015: creates a signed OAuth state carrying a validated return
 * target. Returns null when the target is refused, so the caller
 * falls back to a plain createState — a tampered target never
 * blocks login, it just drops the target. The state (and, for
 * Apple, the nonce, which IS this state) stays one opaque string
 * the provider echoes back verbatim.
 */
export async function createStateWithReturnTarget(
  env: Env,
  rawTarget: unknown
): Promise<string | null> {
  const target = validateReturnTarget(rawTarget);
  if (!target) return null;
  const segment = base64UrlEncode(target);
  if (!segment) return null;
  const random = crypto.randomUUID();
  const timestamp = Date.now().toString();
  const payload = `${random}.${timestamp}.${segment}`;
  const sig = await hmacSign(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

/**
 * #3015: recovers the return target from a signed state, or null
 * when the state carries none, fails verification, or decodes to
 * a refused target. Verification (signature + expiry) runs again
 * here even though handleCallback already verified the state —
 * extraction is safe as a standalone API, and the target is
 * validated once more before any redirect uses it.
 */
export async function extractStateReturnTarget(
  env: Env,
  state: string
): Promise<string | null> {
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  if (!(await verifyStateParts(env, parts))) return null;
  const decoded = base64UrlDecode(parts[2]);
  if (decoded === null) return null;
  return validateReturnTarget(decoded);
}
