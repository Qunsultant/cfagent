/**
 * #945 IAAA-UI v1 — read-only admin overview builder.
 *
 * What this module is: the single place that assembles the data for
 * GET /api/iaaa/overview from the existing stores, and the single
 * place that decides whether the caller may see it. It performs NO
 * store write of any kind (no put, append, grant, or revoke): the
 * route that calls it is GET-only, and v1 has no mutation path.
 *
 * Gating (fail-closed, server-side — the client never decides):
 * the caller must carry a wired session (internalUserId present;
 * legacy sessions have none) AND the PDP must allow the
 * platform-scope platform-privilege check through the seam
 * (checkPlatformPermission, GAP-1): a live platform-admin
 * membership (role "platform-admin", scope "platform", not
 * revoked, not expired). Anything else gets { allowed: false }
 * with NO membership or audit data attached, so a 403 body can
 * never leak partial data.
 *
 * Trust assumption (documented, not hidden): the caller who passes
 * the gate IS a platform admin, so tenant-level audit data for the
 * resolved tenant is shown to them. Audit events are filtered to
 * the resolved tenant (tenantId === tenant) — a platform admin
 * still does not see other tenants' events from this route.
 *
 * Store limitations (read before extending this panel):
 * - There is NO list-all memberships API in MembershipStore
 *   (getMembershipsByUser only), so v1 shows the CALLER'S OWN
 *   memberships, not every user's. Cross-user listing goes
 *   through the #1758 list-all source (listMembershipsFromEntries
 *   over the sessions-namespace listing), which is what the
 *   #2173 admin-counts field on the overview route uses; the
 *   builder itself still never lists other users.
 * - The audit store is a single tenant-mixed log key
 *   (iaaa-audit:events) read in full and filtered in memory;
 *   at auth-event volume that is acceptable, but this route
 *   must NOT be used for per-request audit until a bounded
 *   backend exists (same limitation as the audit store itself).
 * - Membership/audit reads that throw (e.g. corrupt bytes, which
 *   the stores refuse to overwrite) propagate to the route,
 *   which answers 500 with a generic error and no partial data.
 * - The genesis marker is per-identity (#6191 — one key per
 *   listed identity,
 *   iaaa-bootstrap:platform-genesis:<tenant>:<internalUserId>,
 *   plus the legacy single key per tenant,
 *   iaaa-bootstrap:platform-genesis:<tenant>, in global-once
 *   mode). Presence of the caller's own marker or of the legacy
 *   global marker means genesis has happened — not who holds
 *   the role: holding platform-admin via the grant path is not
 *   a genesis signal, and KvLike has no list, so another
 *   identity's per-identity marker is not visible here; the
 *   membership list answers who holds the role.
 */

import type { Membership } from "./authorization";
import type { MembershipStore } from "./authorization";
import type { AuditStore, IaaaAuditEvent } from "./iaaaAudit";
import type { KvLike } from "./kvResilience";
import {
  platformGenesisMarkerKey,
  platformGenesisMarkerKeyForUser,
} from "./iaaaGithubEndToEnd";
import { checkPlatformPermission } from "./iaaaPdpSeam";
import { resolveLogins } from "./identityDisplay";

/** Max audit events returned, newest first. */
export const IAAA_ADMIN_OVERVIEW_LIMIT = 100;

export interface AdminOverviewDeps {
  membershipStore: MembershipStore;
  auditStore: AuditStore;
  /** SessionStore DO kv (for the genesis marker key read). */
  kv: KvLike;
  tenantId: string;
  nowMs: number;
}

export interface AdminOverviewInput {
  callerInternalUserId: string;
}

/** Audit event fields the panel shows — a subset of the store's own fields, nothing invented. */
export interface AdminAuditEventView {
  id: string;
  timestamp: number;
  type: string;
  actorPrincipalId: string;
  /**
   * #6164 — login resolved server-side via the alias record, or null
   * when no alias exists. The client renders "not recorded", never a
   * fabricated login. System principals ("system:…") resolve to null
   * and render verbatim.
   */
  actorLogin: string | null;
  initiatingPrincipalId: string;
  initiatingLogin: string | null;
  action: string;
  decision: string;
  outcome: string;
  correlationId: string;
  resourceId?: string;
  errorCode?: string;
}

/** A membership with its login resolved server-side (#6164), null when no alias exists. */
export type AdminMembershipWithLogin = Membership & { login: string | null };

export type AdminOverviewResult =
  | { allowed: false }
  | {
      allowed: true;
      tenantId: string;
      callerInternalUserId: string;
      memberships: AdminMembershipWithLogin[];
      genesis: { platformGenesisOccurred: boolean };
      recentAuditEvents: AdminAuditEventView[];
    };

/** One tenant's admin count inside an AdminCounts breakdown. */
export interface TenantAdminCount {
  tenantId: string;
  count: number;
}

/**
 * #2173 admin-counts slice — system-wide admin counts from
 * membership records. Counts only: no member identities are
 * returned (the existing GET /api/iaaa/memberships listing is the
 * surface that exposes identities to platform admins).
 *
 * Rules (fixed from the membership model in authorization.ts):
 * - A membership counts only when live: revokedAtMs undefined.
 *   There is no separate "retired" status; revocation is the
 *   status, and it is per membership.
 * - A binding counts only when live: expiresAtMs undefined or
 *   greater than nowMs.
 * - platformAdmins = DISTINCT internalUserIds holding a live
 *   platform-admin binding at platform scope. Platform scope is
 *   platform-wide, so the membership's tenant does not split
 *   this count.
 * - tenantAdminsByTenant = per tenant, DISTINCT internalUserIds
 *   holding a live tenant-admin binding at tenant scope in that
 *   tenant. An identity admin in two tenants counts in EACH
 *   tenant's count; tenantAdminsTotal is the SUM of the
 *   per-tenant counts, not distinct identities across tenants.
 * - An identity holding both a platform-admin binding and a
 *   tenant-admin binding counts in BOTH dimensions.
 * - member / workspace-admin / approver / auditor bindings never
 *   count, and scope mismatches (platform-admin at tenant scope,
 *   tenant-admin at platform scope) never count.
 * - Breakdown rows are sorted by tenantId for determinism.
 */
export interface AdminCounts {
  platformAdmins: number;
  tenantAdminsTotal: number;
  tenantAdminsByTenant: TenantAdminCount[];
}

function bindingIsLive(
  membership: Membership,
  role: "platform-admin" | "tenant-admin",
  scope: "platform" | "tenant",
  nowMs: number,
): boolean {
  if (membership.revokedAtMs !== undefined) return false;
  return membership.roleBindings.some(
    (b) =>
      b.role === role &&
      b.scope === scope &&
      (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
  );
}

/** Pure count over any membership list (route lists all records; see server.ts). */
export function computeAdminCounts(memberships: Membership[], nowMs: number): AdminCounts {
  const platformIds = new Set<string>();
  const tenantIdsByTenant = new Map<string, Set<string>>();
  for (const membership of memberships) {
    if (bindingIsLive(membership, "platform-admin", "platform", nowMs)) {
      platformIds.add(membership.internalUserId);
    }
    if (bindingIsLive(membership, "tenant-admin", "tenant", nowMs)) {
      let ids = tenantIdsByTenant.get(membership.tenantId);
      if (!ids) {
        ids = new Set<string>();
        tenantIdsByTenant.set(membership.tenantId, ids);
      }
      ids.add(membership.internalUserId);
    }
  }
  const tenantAdminsByTenant: TenantAdminCount[] = [...tenantIdsByTenant.entries()]
    .map(([tenantId, ids]) => ({ tenantId, count: ids.size }))
    .sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0));
  return {
    platformAdmins: platformIds.size,
    tenantAdminsTotal: tenantAdminsByTenant.reduce((sum, row) => sum + row.count, 0),
    tenantAdminsByTenant,
  };
}

function toEventView(
  event: IaaaAuditEvent,
  logins: Map<string, string | null>,
): AdminAuditEventView {
  const view: AdminAuditEventView = {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    actorPrincipalId: event.actorPrincipalId,
    actorLogin: logins.get(event.actorPrincipalId) ?? null,
    initiatingPrincipalId: event.initiatingPrincipalId,
    initiatingLogin: logins.get(event.initiatingPrincipalId) ?? null,
    action: event.action,
    decision: event.decision,
    outcome: event.outcome,
    correlationId: event.correlationId,
  };
  if (event.resourceId !== undefined) view.resourceId = event.resourceId;
  if (event.errorCode !== undefined) view.errorCode = event.errorCode;
  return view;
}

/**
 * Assemble the overview or refuse it. Reads only; throws only
 * when an underlying store read throws (corrupt evidence), in
 * which case the route answers 500 with no partial data. The gate
 * consults the PDP first: on deny, the caller's memberships are
 * never read for the response, so a refusal carries no data.
 */
export async function buildAdminOverview(
  deps: AdminOverviewDeps,
  input: AdminOverviewInput,
): Promise<AdminOverviewResult> {
  // GAP-1 (seam A): the PDP platform-scope decision replaces the
  // hand-rolled isPlatformAdmin predicate. The decision is
  // behavior-identical (live platform-admin binding at platform
  // scope, unrevoked, unexpired); the memberships below are read
  // only on allow, for the response body.
  const decision = await checkPlatformPermission(deps.membershipStore, {
    internalUserId: input.callerInternalUserId,
    permission: "role:assign",
    nowMs: deps.nowMs,
  });
  if (decision.decision !== "allow") {
    return { allowed: false };
  }
  const memberships = await deps.membershipStore.getMembershipsByUser(input.callerInternalUserId);
  const allEvents = await deps.auditStore.list();
  const recentEvents = allEvents
    .filter((event) => event.tenantId === deps.tenantId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, IAAA_ADMIN_OVERVIEW_LIMIT);
  // #6164 — one alias join for the whole response: the caller's
  // memberships plus every actor/initiator on the recent events.
  // Unaliased ids resolve to null; system principals are skipped.
  const logins = await resolveLogins(deps.kv, [
    ...memberships.map((m) => m.internalUserId),
    ...recentEvents.flatMap((event) => [event.actorPrincipalId, event.initiatingPrincipalId]),
  ]);
  const recentAuditEvents = recentEvents.map((event) => toEventView(event, logins));
  const marker = await deps.kv.get(platformGenesisMarkerKey(deps.tenantId));
  // #6191 — per-identity genesis: the legacy global marker alone
  // no longer answers "has genesis happened". Genesis has happened
  // when the legacy marker exists OR the caller's own per-identity
  // marker exists. Holding platform-admin via the grant path is
  // NOT a genesis signal (a grant-path admin with no marker still
  // reads false — the membership list answers who holds the role).
  // KvLike has no list, so another identity's per-identity marker
  // is not visible here; that is a named gap, not a silent false
  // negative in the other direction.
  const ownMarker = await deps.kv.get(
    platformGenesisMarkerKeyForUser(deps.tenantId, input.callerInternalUserId),
  );
  return {
    allowed: true,
    tenantId: deps.tenantId,
    callerInternalUserId: input.callerInternalUserId,
    memberships: memberships.map((m) => ({
      ...m,
      login: logins.get(m.internalUserId) ?? null,
    })),
    genesis: {
      platformGenesisOccurred: marker !== null || ownMarker !== null,
    },
    recentAuditEvents,
  };
}
