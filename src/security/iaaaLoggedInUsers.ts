/**
 * Issue #2836 (#2837 sub-issue) — admin surface for logged-in
 * users: active sessions, login counts, login times, session
 * history.
 *
 * Pure aggregation over already-listed durable records. This
 * module performs no I/O and imports no Cloudflare
 * infrastructure: the caller supplies session-namespace entries
 * (listStoreEntries / listSessionFamilyEntries over ""), retained
 * auth.login audit events, login-alias records, and memberships.
 * The SessionStore DO remains the only session backend, the
 * audit store the only login-event record, and the alias store
 * the only login-alias record — this module invents no second
 * record of any kind.
 *
 * Sources, and what each one can honestly support:
 * - Live sessions (bare-UUID keys in the sessions namespace):
 *   the active-session list and per-user session history. A
 *   session is ACTIVE only when it passes the policy expiry
 *   check (absolute 7d from createdAt, 30d lifetime cap from
 *   firstCreatedAt, idle window for sessions with recorded
 *   activity). The store listing alone is not enough: its TTL
 *   enforces the absolute deadline only, so an idle-expired
 *   session can still list and must be excluded here. Legacy
 *   sessions (no internalUserId, no recorded activity) are
 *   idle-exempt, exactly as the Phase 2a contract states.
 * - Retained auth.login succeeded audit events (actor =
 *   internalUserId, correlation = session id): the per-user
 *   login count, first/most-recent login, and recent login
 *   times. The count is a RECORDED-EVENTS count, never a
 *   lifetime total: the audit store is bounded (22,000 events)
 *   and login writes are best-effort, so events outside the
 *   retained window — or lost to a failed write — are absent
 *   and unrecoverable from here. The route labels the count
 *   with that basis; this module never presents it as total
 *   logins ever. A true lifetime login count needs an
 *   unbounded login-event record, which is the carried
 *   follow-up tied to #2808's login-trace kind, not something
 *   this slice estimates into existence.
 * - Login-alias records (iaaa-alias:user:): first wired-login
 *   observation (recordedAtMs) and the verbatim display login.
 *   An alias is one observation, not a history: it is recorded
 *   once per user and never updated by later logins.
 * - Memberships: tenant attribution. Sessions carry no tenant,
 *   so a session's tenant visibility comes from its user's
 *   active memberships. A user with no active membership in the
 *   caller's tenant is invisible to that tenant admin, and a
 *   legacy session — attributable to no tenant at all — is
 *   visible to platform admins only (fail-closed).
 *
 * Privacy by construction: the row shape carries identity,
 * tenant, times, counts, and status only. No token, secret,
 * credential, or raw payload field is read from any record or
 * returned in any row.
 */

import { SESSION_LIMITS } from "../config/sessionLimits";

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maximum recent-login timestamps carried per user row. */
export const LOGGED_IN_USERS_RECENT_LIMIT = 10;

export type ProviderResolver = (
  issuer: unknown,
) => { providerId: string; displayName?: string } | null;

export interface LoggedInSession {
  sessionId: string;
  internalUserId?: string;
  displayLogin: string;
  displayName: string;
  /** issuer:subject, or null when the session carries no binding identity. */
  identity: string | null;
  /** Resolved provider display name, else the raw issuer, else null. */
  provider: string | null;
  providerId: string | null;
  providerIssuer: string | null;
  createdMs: number;
  firstCreatedMs: number;
  /** Last recorded activity, or createdMs when none was recorded. */
  lastSeenMs: number;
  /** Earliest applicable expiry deadline (absolute, lifetime cap, idle). */
  expiresMs: number;
  authTimeMs?: number;
}

export interface LoggedInUserRow {
  /** Null for the legacy group (sessions with no internalUserId). */
  internalUserId: string | null;
  displayLogin: string;
  /** issuer:subject of the user's first bound session, else null. */
  identity: string | null;
  /** Active-membership tenants, sorted; [] for the legacy group. */
  tenantIds: string[];
  /**
   * Retained auth.login succeeded events for this user. Null
   * for the legacy group, which cannot be attributed to events.
   */
  loginCount: number | null;
  firstLoginMs: number | null;
  mostRecentLoginMs: number | null;
  /** Newest first, at most LOGGED_IN_USERS_RECENT_LIMIT entries. */
  recentLoginMs: number[];
  /** First wired-login observation from the alias record, if any. */
  firstSeenMs: number | null;
  sessions: LoggedInSession[];
}

/** One retained login event, pre-filtered by the caller to auth.login. */
export interface LoginAuditEventInput {
  actorPrincipalId: string;
  tenantId: string;
  timestamp: number;
  outcome: "succeeded" | "failed" | "pending" | "unknown";
}

export interface LoginAliasInput {
  internalUserId: string;
  recordedAtMs: number;
}

export interface MembershipInput {
  internalUserId: string;
  tenantId: string;
  revoked: boolean;
  /**
   * Single-expiry form: a caller holding multi-binding records
   * folds binding expiry into `revoked` instead (no unexpired
   * binding ⇒ revoked), which is what the route does.
   */
  expiresAtMs?: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse one listed store entry into an active-session row, or
 * null when the entry is not an active session record. Null is
 * the only failure signal: callers skip nulls and never treat
 * them as sessions. The UUID-key rule mirrors the session
 * registry (iaaaSessionRegistry.ts): membership, binding,
 * audit, and alias keys share the sessions namespace but are
 * not sessions.
 */
export function parseLoggedInSessionEntry(
  key: string,
  raw: string,
  nowMs: number,
  idleTimeoutMs: number,
  resolveProvider: ProviderResolver,
): LoggedInSession | null {
  if (typeof key !== "string" || !SESSION_ID_PATTERN.test(key)) return null;
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (!isNonEmptyString(record.githubLogin)) return null;
  if (!isFiniteNumber(record.createdAt)) return null;
  const createdMs = record.createdAt;
  const firstCreatedMs = isFiniteNumber(record.firstCreatedAt)
    ? record.firstCreatedAt
    : createdMs;
  // Absolute expiry, then the lifetime cap — both exclusive,
  // matching getValidatedSession in iaaaLogin.ts.
  const absoluteMs = createdMs + SESSION_LIMITS.absoluteTtlSeconds * 1000;
  if (nowMs >= absoluteMs) return null;
  const capMs = firstCreatedMs + SESSION_LIMITS.maxLifetimeSeconds * 1000;
  if (nowMs >= capMs) return null;
  let expiresMs = Math.min(absoluteMs, capMs);
  const lastActivityMs = record.lastActivityMs;
  let lastSeenMs = createdMs;
  if (isFiniteNumber(lastActivityMs)) {
    // Idle expiry applies only to sessions with recorded
    // activity; legacy sessions without it are idle-exempt.
    const idleMs = lastActivityMs + idleTimeoutMs;
    if (nowMs >= idleMs) return null;
    expiresMs = Math.min(expiresMs, idleMs);
    lastSeenMs = lastActivityMs;
  }
  const internalUserId = isNonEmptyString(record.internalUserId)
    ? record.internalUserId
    : undefined;
  const providerIssuer = isNonEmptyString(record.providerIssuer)
    ? record.providerIssuer
    : null;
  const providerSubject = isNonEmptyString(record.providerSubject)
    ? record.providerSubject
    : null;
  const resolved = providerIssuer ? resolveProvider(providerIssuer) : null;
  const session: LoggedInSession = {
    sessionId: key,
    displayLogin: record.githubLogin,
    displayName: isNonEmptyString(record.githubName) ? record.githubName : "",
    identity:
      providerIssuer && providerSubject
        ? `${providerIssuer}:${providerSubject}`
        : null,
    provider: resolved?.displayName ?? providerIssuer,
    providerId: resolved?.providerId ?? null,
    providerIssuer,
    createdMs,
    firstCreatedMs,
    lastSeenMs,
    expiresMs,
  };
  if (internalUserId !== undefined) session.internalUserId = internalUserId;
  if (isFiniteNumber(record.authTimeMs)) session.authTimeMs = record.authTimeMs;
  return session;
}

export interface BuildLoggedInUserRowsInput {
  sessionEntries: Array<{ key: string; value: string }>;
  loginEvents: LoginAuditEventInput[];
  aliases: LoginAliasInput[];
  memberships: MembershipInput[];
  /**
   * Optional issuer:subject per user from the identity-binding
   * user index. Used ONLY when none of the user's sessions
   * carries its own issuer:subject — the session's own identity
   * always wins, and a user with no binding keeps null. Never
   * invented: every value here comes from a stored binding.
   */
  identityByUser?: Record<string, string>;
  scope: "platform" | "tenant";
  /** Required for tenant scope; ignored for platform scope. */
  tenantId?: string;
  nowMs: number;
  idleTimeoutMs: number;
  resolveProvider: ProviderResolver;
}

function isActiveMembership(m: MembershipInput, nowMs: number): boolean {
  return (
    !m.revoked &&
    (m.expiresAtMs === undefined || m.expiresAtMs > nowMs)
  );
}

/**
 * Aggregate parsed sessions, login events, aliases, and
 * memberships into per-user rows under the caller's scope.
 * Tenant scope keeps only users with an active membership in
 * tenantId, and only that tenant's login events for them;
 * platform scope keeps every user and every tenant's events.
 * Legacy sessions group under one row per display login with
 * no login stats and no tenants, platform scope only.
 */
export function buildLoggedInUserRows(
  input: BuildLoggedInUserRowsInput,
): LoggedInUserRow[] {
  const sessions: LoggedInSession[] = [];
  for (const entry of input.sessionEntries) {
    const parsed = parseLoggedInSessionEntry(
      entry.key,
      entry.value,
      input.nowMs,
      input.idleTimeoutMs,
      input.resolveProvider,
    );
    if (parsed) sessions.push(parsed);
  }

  const activeByUser = new Map<string, string[]>();
  for (const m of input.memberships) {
    if (!isActiveMembership(m, input.nowMs)) continue;
    const tenants = activeByUser.get(m.internalUserId) ?? [];
    if (!tenants.includes(m.tenantId)) tenants.push(m.tenantId);
    activeByUser.set(m.internalUserId, tenants);
  }

  const aliasByUser = new Map<string, number>();
  for (const alias of input.aliases) {
    if (isFiniteNumber(alias.recordedAtMs) && !aliasByUser.has(alias.internalUserId)) {
      aliasByUser.set(alias.internalUserId, alias.recordedAtMs);
    }
  }

  // Retained succeeded login events per user. Failed, pending,
  // and unknown-outcome events never count, and the literal
  // "unknown" actor is never attributed to a user.
  const eventsByUser = new Map<string, number[]>();
  for (const event of input.loginEvents) {
    if (event.outcome !== "succeeded") continue;
    if (!isNonEmptyString(event.actorPrincipalId)) continue;
    if (event.actorPrincipalId === "unknown") continue;
    if (!isFiniteNumber(event.timestamp)) continue;
    if (input.scope === "tenant" && event.tenantId !== input.tenantId) continue;
    const list = eventsByUser.get(event.actorPrincipalId) ?? [];
    list.push(event.timestamp);
    eventsByUser.set(event.actorPrincipalId, list);
  }

  const sessionsByUser = new Map<string, LoggedInSession[]>();
  const legacyByLogin = new Map<string, LoggedInSession[]>();
  for (const session of sessions) {
    if (session.internalUserId !== undefined) {
      const list = sessionsByUser.get(session.internalUserId) ?? [];
      list.push(session);
      sessionsByUser.set(session.internalUserId, list);
    } else {
      const list = legacyByLogin.get(session.displayLogin) ?? [];
      list.push(session);
      legacyByLogin.set(session.displayLogin, list);
    }
  }

  const rows: LoggedInUserRow[] = [];
  const isVisible = (internalUserId: string): boolean => {
    if (input.scope === "platform") return true;
    const tenants = activeByUser.get(internalUserId) ?? [];
    return tenants.includes(input.tenantId ?? "");
  };

  for (const [internalUserId, userSessions] of sessionsByUser) {
    if (!isVisible(internalUserId)) continue;
    const timestamps = (eventsByUser.get(internalUserId) ?? []).sort((a, b) => a - b);
    const tenants = (activeByUser.get(internalUserId) ?? []).sort();
    const identity =
      userSessions.find((s) => s.identity !== null)?.identity ??
      input.identityByUser?.[internalUserId] ??
      null;
    const displayLogin = userSessions[0].displayLogin;
    rows.push({
      internalUserId,
      displayLogin,
      identity,
      tenantIds:
        input.scope === "tenant" ? [input.tenantId ?? ""] : tenants,
      loginCount: timestamps.length,
      firstLoginMs: timestamps.length > 0 ? timestamps[0] : null,
      mostRecentLoginMs:
        timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
      recentLoginMs: [...timestamps]
        .sort((a, b) => b - a)
        .slice(0, LOGGED_IN_USERS_RECENT_LIMIT),
      firstSeenMs: aliasByUser.get(internalUserId) ?? null,
      sessions: [...userSessions].sort((a, b) => b.lastSeenMs - a.lastSeenMs),
    });
  }

  if (input.scope === "platform") {
    for (const [displayLogin, legacySessions] of legacyByLogin) {
      rows.push({
        internalUserId: null,
        displayLogin,
        identity: null,
        tenantIds: [],
        loginCount: null,
        firstLoginMs: null,
        mostRecentLoginMs: null,
        recentLoginMs: [],
        firstSeenMs: null,
        sessions: [...legacySessions].sort((a, b) => b.lastSeenMs - a.lastSeenMs),
      });
    }
  }

  rows.sort((a, b) => a.displayLogin.localeCompare(b.displayLogin));
  return rows;
}
