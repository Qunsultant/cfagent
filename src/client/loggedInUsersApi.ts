/**
 * Client for the logged-in-users admin endpoints (issue #2836):
 * GET /api/iaaa/logged-in-users,
 * POST /api/iaaa/logged-in-users/revoke.
 *
 * The server scopes every list (platform admin: all tenants;
 * tenant admin: their tenant only) and enforces every revoke;
 * this client only renders what the server returns and surfaces
 * refusals. All calls go through apiFetch (the #71 rule).
 *
 * Privacy: the payload carries identity, tenant, times, counts,
 * and status only — no tokens, secrets, or payloads — and this
 * client renders nothing beyond it.
 */

import { apiFetch } from "./apiFetch";

export interface LoggedInSessionView {
  sessionId: string;
  internalUserId?: string;
  displayLogin: string;
  displayName: string;
  identity: string | null;
  provider: string | null;
  providerId: string | null;
  providerIssuer: string | null;
  createdMs: number;
  firstCreatedMs: number;
  lastSeenMs: number;
  expiresMs: number;
  authTimeMs?: number;
}

export interface LoggedInUserView {
  internalUserId: string | null;
  displayLogin: string;
  identity: string | null;
  tenantIds: string[];
  /** Null for legacy sessions, which cannot be attributed to login events. */
  loginCount: number | null;
  firstLoginMs: number | null;
  mostRecentLoginMs: number | null;
  recentLoginMs: number[];
  firstSeenMs: number | null;
  sessions: LoggedInSessionView[];
}

export interface LoggedInUsersCoverage {
  loginCountBasis: string;
  loginCountNote: string;
  lastSeenNote: string;
  firstSeenNote: string;
}

export interface LoggedInUsersResponse {
  ok: boolean;
  scope: "platform" | "tenant";
  tenantId?: string;
  users: LoggedInUserView[];
  coverage: LoggedInUsersCoverage;
}

export interface RevokeLoggedInSessionResult {
  ok: boolean;
  revokedSessionId: string;
  audited: boolean;
  revokeBoundMs: number;
  revokeBoundNote: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): LoggedInSessionView {
  if (!isRecord(value)) throw new Error("Logged-in-users response was not an object.");
  const sessionId = value.sessionId;
  const displayLogin = value.displayLogin;
  const displayName = value.displayName;
  const createdMs = value.createdMs;
  const firstCreatedMs = value.firstCreatedMs;
  const lastSeenMs = value.lastSeenMs;
  const expiresMs = value.expiresMs;
  if (
    typeof sessionId !== "string" ||
    typeof displayLogin !== "string" ||
    typeof displayName !== "string" ||
    typeof createdMs !== "number" ||
    typeof firstCreatedMs !== "number" ||
    typeof lastSeenMs !== "number" ||
    typeof expiresMs !== "number"
  ) {
    throw new Error("Logged-in-users response was missing required session fields.");
  }
  return {
    sessionId,
    displayLogin,
    displayName,
    identity: typeof value.identity === "string" ? value.identity : null,
    provider: typeof value.provider === "string" ? value.provider : null,
    providerId: typeof value.providerId === "string" ? value.providerId : null,
    providerIssuer: typeof value.providerIssuer === "string" ? value.providerIssuer : null,
    createdMs,
    firstCreatedMs,
    lastSeenMs,
    expiresMs,
    ...(typeof value.internalUserId === "string" ? { internalUserId: value.internalUserId } : {}),
    ...(typeof value.authTimeMs === "number" ? { authTimeMs: value.authTimeMs } : {}),
  };
}

function parseUser(value: unknown): LoggedInUserView {
  if (!isRecord(value)) throw new Error("Logged-in-users response was not an object.");
  const displayLogin = value.displayLogin;
  const tenantIds = value.tenantIds;
  const recentLoginMs = value.recentLoginMs;
  const sessions = value.sessions;
  if (
    typeof displayLogin !== "string" ||
    !Array.isArray(tenantIds) ||
    !tenantIds.every((t) => typeof t === "string") ||
    !Array.isArray(recentLoginMs) ||
    !recentLoginMs.every((t) => typeof t === "number") ||
    !Array.isArray(sessions)
  ) {
    throw new Error("Logged-in-users response was missing required user fields.");
  }
  return {
    internalUserId: typeof value.internalUserId === "string" ? value.internalUserId : null,
    displayLogin,
    identity: typeof value.identity === "string" ? value.identity : null,
    tenantIds: tenantIds as string[],
    loginCount: typeof value.loginCount === "number" ? value.loginCount : null,
    firstLoginMs: typeof value.firstLoginMs === "number" ? value.firstLoginMs : null,
    mostRecentLoginMs: typeof value.mostRecentLoginMs === "number" ? value.mostRecentLoginMs : null,
    recentLoginMs: recentLoginMs as number[],
    firstSeenMs: typeof value.firstSeenMs === "number" ? value.firstSeenMs : null,
    sessions: sessions.map(parseSession),
  };
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === "string" && body.error !== "" ? body.error : fallback;
  return new Error(message);
}

export async function fetchLoggedInUsers(): Promise<LoggedInUsersResponse> {
  const res = await apiFetch("/api/iaaa/logged-in-users");
  if (!res.ok) throw await readError(res, "Failed to load logged-in users.");
  const body = (await res.json().catch(() => null)) as {
    users?: unknown;
    coverage?: unknown;
    scope?: unknown;
    tenantId?: unknown;
  } | null;
  if (!body || !Array.isArray(body.users) || !isRecord(body.coverage)) {
    throw new Error("Logged-in-users response was malformed.");
  }
  const coverage = body.coverage;
  if (
    typeof coverage.loginCountBasis !== "string" ||
    typeof coverage.loginCountNote !== "string" ||
    typeof coverage.lastSeenNote !== "string" ||
    typeof coverage.firstSeenNote !== "string"
  ) {
    throw new Error("Logged-in-users response was malformed.");
  }
  return {
    ok: true,
    scope: body.scope === "tenant" ? "tenant" : "platform",
    ...(typeof body.tenantId === "string" ? { tenantId: body.tenantId } : {}),
    users: body.users.map(parseUser),
    coverage: {
      loginCountBasis: coverage.loginCountBasis,
      loginCountNote: coverage.loginCountNote,
      lastSeenNote: coverage.lastSeenNote,
      firstSeenNote: coverage.firstSeenNote,
    },
  };
}

export async function revokeLoggedInSession(
  sessionId: string,
): Promise<RevokeLoggedInSessionResult> {
  const res = await apiFetch("/api/iaaa/logged-in-users/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw await readError(res, "Failed to revoke session.");
  const body = (await res.json().catch(() => null)) as {
    revokedSessionId?: unknown;
    audited?: unknown;
    revokeBoundMs?: unknown;
    revokeBoundNote?: unknown;
  } | null;
  if (!body || typeof body.revokedSessionId !== "string" || typeof body.revokeBoundMs !== "number") {
    throw new Error("Session-revoke response was malformed.");
  }
  return {
    ok: true,
    revokedSessionId: body.revokedSessionId,
    audited: body.audited === true,
    revokeBoundMs: body.revokeBoundMs,
    revokeBoundNote: typeof body.revokeBoundNote === "string" ? body.revokeBoundNote : "",
  };
}

export function fmtLoggedInTime(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}
