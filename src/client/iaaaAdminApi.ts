/**
 * Client for the IAAA admin overview (issue #945, IAAA-UI v1) and
 * the lifecycle mutations (issue #1758): membership grant, revoke,
 * edit, and list, plus self-deactivation and admin offboarding.
 * The overview itself stays read-only; the mutations below are
 * server-gated (see the route comments in src/server.ts) and this
 * module never decides authorization — a 403 here means the server
 * refused, never a client bug.
 *
 * All calls go through src/client/apiFetch.ts (the #71 rule).
 * The panel renders only payloads that pass isAdminOverview; a 403
 * body ("not an admin") or garbage must never reach the table.
 */

import { apiFetch } from "./apiFetch";

export interface AdminRoleBindingView {
  role: string;
  scope: string;
  grantedBy: string;
  expiresAtMs?: number;
}

export interface AdminMembershipView {
  membershipId: string;
  internalUserId: string;
  tenantId: string;
  roleBindings: AdminRoleBindingView[];
  createdBy: string;
  createdAtMs: number;
  revokedAtMs?: number;
}

export interface AdminAuditEventView {
  id: string;
  timestamp: number;
  type: string;
  actorPrincipalId: string;
  initiatingPrincipalId: string;
  action: string;
  decision: string;
  outcome: string;
  correlationId: string;
  resourceId?: string;
  errorCode?: string;
}

/** #2173 admin-counts slice — counts only, no member identities. */
export interface TenantAdminCountView {
  tenantId: string;
  count: number;
}

/** #2173 admin-counts slice — system-wide counts + per-tenant breakdown. */
export interface AdminCountsView {
  platformAdmins: number;
  tenantAdminsTotal: number;
  tenantAdminsByTenant: TenantAdminCountView[];
}

export interface AdminOverview {
  tenantId: string;
  callerInternalUserId: string;
  memberships: AdminMembershipView[];
  genesis: { platformGenesisOccurred: boolean };
  recentAuditEvents: AdminAuditEventView[];
  /** #2173: present on server responses that carry admin counts; older payloads omit it. */
  adminCounts?: AdminCountsView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMembership(value: unknown): value is AdminMembershipView {
  if (!isRecord(value)) return false;
  return (
    typeof value.membershipId === "string" &&
    typeof value.internalUserId === "string" &&
    typeof value.tenantId === "string" &&
    Array.isArray(value.roleBindings) &&
    typeof value.createdBy === "string" &&
    typeof value.createdAtMs === "number"
  );
}

function isAuditEvent(value: unknown): value is AdminAuditEventView {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.timestamp === "number" &&
    typeof value.action === "string" &&
    typeof value.decision === "string" &&
    typeof value.outcome === "string" &&
    typeof value.correlationId === "string"
  );
}

function isAdminCounts(value: unknown): value is AdminCountsView {
  if (!isRecord(value)) return false;
  if (typeof value.platformAdmins !== "number") return false;
  if (typeof value.tenantAdminsTotal !== "number") return false;
  if (!Array.isArray(value.tenantAdminsByTenant)) return false;
  return value.tenantAdminsByTenant.every(
    (row) =>
      isRecord(row) && typeof row.tenantId === "string" && typeof row.count === "number",
  );
}

/** Shape guard: true only for a well-formed overview payload. */
export function isAdminOverview(value: unknown): value is AdminOverview {
  if (!isRecord(value)) return false;
  if (typeof value.tenantId !== "string") return false;
  if (typeof value.callerInternalUserId !== "string") return false;
  if (!Array.isArray(value.memberships) || !value.memberships.every(isMembership)) return false;
  if (!isRecord(value.genesis) || typeof value.genesis.platformGenesisOccurred !== "boolean") {
    return false;
  }
  if (!Array.isArray(value.recentAuditEvents) || !value.recentAuditEvents.every(isAuditEvent)) {
    return false;
  }
  // #2173: adminCounts is optional for backward compatibility, but
  // when present it must be well-formed — a malformed counts block
  // rejects the whole payload instead of rendering partial counts.
  if (value.adminCounts !== undefined && !isAdminCounts(value.adminCounts)) return false;
  return true;
}

async function send<T>(path: string): Promise<T> {
  const resp = await apiFetch(path);
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

/** Fetch the overview; throws on 401/403/500 with the server message. */
export async function fetchAdminOverview(): Promise<AdminOverview> {
  const data = await send<unknown>("/api/iaaa/overview");
  if (!isAdminOverview(data)) throw new Error("Unexpected IAAA overview response.");
  return data;
}

/**
 * Issue #1274 — access requests (list + decide). The list/decide
 * routes are tenant-admin gated server-side; a 403 here means the
 * caller cannot grant, never a client bug. Payloads that fail the
 * shape guard throw instead of rendering.
 */
export interface AccessRequestView {
  requestId: string;
  requesterInternalUserId: string;
  requestedRole: string;
  scope: string;
  tenantId: string;
  status: "pending" | "approved" | "denied";
  createdAtMs: number;
  decidedAtMs?: number;
  decidedBy?: string;
}

function isAccessRequestView(value: unknown): value is AccessRequestView {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === "string" &&
    typeof value.requesterInternalUserId === "string" &&
    typeof value.requestedRole === "string" &&
    typeof value.status === "string" &&
    (value.status === "pending" || value.status === "approved" || value.status === "denied") &&
    typeof value.createdAtMs === "number"
  );
}

export async function fetchAccessRequests(): Promise<AccessRequestView[]> {
  const data = await send<{ requests?: unknown }>("/api/iaaa/access-requests");
  if (!Array.isArray(data.requests) || !data.requests.every(isAccessRequestView)) {
    throw new Error("Unexpected access-request list response.");
  }
  return data.requests;
}

/**
 * Issue #1758 — lifecycle mutations. Role bindings are passed
 * through verbatim; the server validates roles/scopes and enforces
 * the no-self-grant rule, the PDP obligation channel, and the admin
 * gates. Membership payloads reuse the overview shape guard.
 */
export interface MembershipMutationBinding {
  role: string;
  scope: string;
  workspaceId?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  return data;
}

export async function fetchMemberships(): Promise<AdminMembershipView[]> {
  const data = await send<{ memberships?: unknown }>("/api/iaaa/memberships");
  if (!Array.isArray(data.memberships) || !data.memberships.every(isMembership)) {
    throw new Error("Unexpected membership list response.");
  }
  return data.memberships;
}

export async function grantMembershipApi(
  internalUserId: string,
  roleBindings: MembershipMutationBinding[],
  email?: string,
): Promise<{
  membership?: AdminMembershipView;
  welcome?: { sent: boolean; reason?: string };
  pending?: boolean;
  proposalId?: string;
}> {
  const data = await postJson<{ membership?: unknown; welcome?: unknown; pending?: unknown; proposalId?: unknown }>("/api/iaaa/membership/grant", {
    internalUserId,
    roleBindings,
    ...(email ? { email } : {}),
  });
  // Issue #3155 (Q9): an admin-role grant proposed by the first
  // approver returns 202 with no membership — that is a pending
  // proposal, not an error. The panel shows an awaiting notice.
  if (data.pending === true) {
    return {
      pending: true,
      ...(typeof data.proposalId === "string" ? { proposalId: data.proposalId } : {}),
    };
  }
  if (!isMembership(data.membership)) throw new Error("Unexpected grant response.");
  const welcome =
    data.welcome && typeof data.welcome === "object" && typeof (data.welcome as { sent?: unknown }).sent === "boolean"
      ? (data.welcome as { sent: boolean; reason?: string })
      : undefined;
  return { membership: data.membership, ...(welcome ? { welcome } : {}) };
}

export async function revokeMembershipApi(membershipId: string): Promise<void> {
  await postJson("/api/iaaa/membership/revoke", { membershipId });
}

export async function editMembershipApi(
  membershipId: string,
  roleBindings: MembershipMutationBinding[],
): Promise<{ membership: AdminMembershipView; oldRevoked: boolean }> {
  const data = await postJson<{ membership?: unknown; oldRevoked?: unknown }>(
    "/api/iaaa/membership/edit",
    { membershipId, roleBindings },
  );
  if (!isMembership(data.membership) || typeof data.oldRevoked !== "boolean") {
    throw new Error("Unexpected edit response.");
  }
  return { membership: data.membership, oldRevoked: data.oldRevoked };
}

export interface DeactivationReport {
  verified: boolean;
  offboarded: boolean;
  sessionsRevoked: string[];
  membershipsRevoked: string[];
  apiKeysRevoked: string[];
  etradeLogins: string[];
  mailSuppressed: boolean;
  auditEmitted: boolean;
  residuals: string[];
}

function isDeactivationReport(value: unknown): value is DeactivationReport {
  return (
    isRecord(value) &&
    typeof value.verified === "boolean" &&
    Array.isArray(value.residuals)
  );
}

/** Self-service deactivation: the server always targets the caller's own session identity. */
export async function deactivateSelf(): Promise<DeactivationReport> {
  const data = await postJson<unknown>("/api/iaaa/deactivate", { confirm: "deactivate" });
  if (!isDeactivationReport(data)) throw new Error("Unexpected deactivation response.");
  return data;
}

/** Admin offboarding: server-gated; the caller never supplies session ids. */
export async function offboardPrincipalApi(
  internalUserId: string,
  login?: string,
): Promise<DeactivationReport> {
  const data = await postJson<unknown>("/api/iaaa/offboard", {
    internalUserId,
    ...(login ? { login } : {}),
  });
  if (!isDeactivationReport(data)) throw new Error("Unexpected offboard response.");
  return data;
}

export async function decideAccessRequest(
  requestId: string,
  decision: "approve" | "deny",
): Promise<AccessRequestView> {
  const resp = await apiFetch("/api/iaaa/access-request/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, decision }),
  });
  const data = (await resp.json().catch(() => ({}))) as { request?: unknown; error?: string };
  if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
  if (!isAccessRequestView(data.request)) throw new Error("Unexpected access-request decision response.");
  return data.request;
}

/** "2026-10-22 · 14:32" style timestamp; "—" for invalid input. */
export function formatEventTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
