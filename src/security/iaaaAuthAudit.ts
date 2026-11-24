/**
 * #945 Wiring Phase 2a — auth audit event builders + best-effort recording.
 *
 * Builds Slice 5 IaaaAuditEvent inputs for authentication events and
 * records them through a caller-supplied AuditStore seam. This module
 * creates NO production store: the existing audit route and the
 * mas_events store are untouched. The builders take tenantId as an
 * explicit caller parameter and invent no default themselves. (The
 * GitHub end-to-end slice resolved the two open questions at the
 * call sites: the Kv-backed store in iaaaAuditStore.ts is the
 * backend, and server.ts resolves the tenant as IAAA_TENANT_ID else
 * the documented default "primary" — see iaaaGithubEndToEnd.ts.
 * Inventing any other tenant value would fabricate attribution.)
 *
 * Actor attribution: the actor is the Slice 1 internal user id when
 * known. When it is not known — a login that failed before any
 * binding existed — the actor is the literal string "unknown",
 * which states the absence of attribution rather than attributing
 * the event to a login, an email, or a guessed identity. A login
 * is never attributed by display login: logins can change, and
 * Slice 5 forbids login/email as identity.
 *
 * Best-effort recording, deliberately: `recordWiredAuthAudit`
 * never throws and its result never changes a login outcome in
 * this phase. Whether a failed audit write should BLOCK a wired
 * login (the Slice 5 consequential-action rule) is a CISO
 * decision still open, and blocking logins on a store that does
 * not exist in production yet would be the wrong default. The
 * caller that eventually wires a production store must decide
 * this explicitly and document it; until then, a failed write
 * is reported in the result, not enforced.
 *
 * Not yet audited here (Phase 2b): token-exchange / profile-fetch
 * failures in the wired callback (they fail before any binding
 * context exists). Logout IS hooked since Phase 2b-part1: the
 * hook lives in githubOAuth.ts handleLogout (reached from
 * server.ts /auth/logout) and records BEFORE deleteSession when
 * wiring is ON and the session has an internalUserId. Since
 * #1760, a legacy session logout (no internalUserId) records a
 * logout_audit_skipped event instead of silence, when an audit
 * store and tenant resolve. Login events are hooked since the
 * GitHub end-to-end slice: server.ts dispatch supplies the audit
 * store and the resolved tenant (IAAA_TENANT_ID else "primary")
 * to the wired callback, so login success/failure events are
 * recorded in production, best-effort.
 * Whether a failed audit write should BLOCK a wired login (the
 * Slice 5 consequential-action rule) is still an open CISO
 * decision — this slice does not block on audit failure.
 */

import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
  type AuditResult,
  type AuditStore,
  type CreateIaaaAuditEventInput,
} from "./iaaaAudit";

/** Explicit marker for unattributed actors; never a real principal. */
export const IAAA_UNKNOWN_ACTOR = "unknown";

export type WiredLoginFailureCode = "MISSING_SUBJECT_ID" | "BINDING_FAILED";

export interface WiredAuthAuditInput {
  tenantId: string;
  timestamp: number;
  correlationId: string;
}

/**
 * Login success: actor = initiating principal = internal user id.
 * Correlation id is the session id created for this login, so the
 * event correlates to exactly one session.
 */
export function buildLoginSuccessAuditEventInput(input: {
  internalUserId: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "auth.login",
    actorPrincipalId: input.internalUserId,
    actorType: "human",
    initiatingPrincipalId: input.internalUserId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "auth.login",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * Login failure (missing subject id, or binding failure): the
 * login is denied and failed, and the actor is explicitly
 * "unknown" — no binding existed to attribute it to.
 */
export function buildLoginFailureAuditEventInput(input: {
  code: WiredLoginFailureCode;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "auth.login",
    actorPrincipalId: IAAA_UNKNOWN_ACTOR,
    actorType: "human",
    initiatingPrincipalId: IAAA_UNKNOWN_ACTOR,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "auth.login",
    decision: "deny",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "failed",
    errorCode: input.code,
  };
}

/**
 * Logout: actor = internal user id when the session carried one;
 * "unknown" for legacy sessions without it. The caller (the future
 * logout hook) records this BEFORE the session is deleted.
 */
export function buildLogoutAuditEventInput(input: {
  internalUserId?: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  const actor = input.internalUserId ?? IAAA_UNKNOWN_ACTOR;
  return {
    timestamp: input.timestamp,
    type: "auth.logout",
    actorPrincipalId: actor,
    actorType: "human",
    initiatingPrincipalId: actor,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "auth.logout",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * #1760 — a logout whose audit record was SKIPPED, recorded as an
 * event itself so the skip stops being silent. Emitted by
 * handleLogout when an audit store and tenant resolve but the
 * session is legacy (no internalUserId): the logout proceeded,
 * the attribution did not exist, and that fact is now evidence
 * instead of an absence. Outcome "unknown" states exactly that:
 * the logout happened, its audit status is unrecorded. When no
 * store or tenant is supplied there is no backend to write to,
 * so that skip stays a decided silence (see the #1760 slice doc).
 */
export function buildLogoutAuditSkippedEventInput(input: {
  tenantId: string;
  timestamp: number;
  correlationId: string;
  reason: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "auth.logout_audit_skipped",
    actorPrincipalId: IAAA_UNKNOWN_ACTOR,
    actorType: "human",
    initiatingPrincipalId: IAAA_UNKNOWN_ACTOR,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "auth.logout_audit_skipped",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "unknown",
    errorCode: input.reason,
  };
}

/**
 * #1760 — login-time alias recording, previously a Kv write only.
 * Actor = the internal user the login was recorded for; the
 * mapping itself stays in the alias store, this event proves a
 * recording happened, when, and for whom. Best-effort, never
 * changes the login outcome.
 */
export function buildAliasRecordedAuditEventInput(input: {
  internalUserId: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "iaaa.alias.record",
    actorPrincipalId: input.internalUserId,
    actorType: "human",
    initiatingPrincipalId: input.internalUserId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "iaaa.alias.record",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * #1760 — bootstrap / genesis grants, previously membership writes
 * with no audit call. Actor = the system grantor (the genesis
 * exception has no human granter by construction); the initiating
 * principal is the user whose login triggered the grant, so the
 * event attributes both the mechanism and the trigger. Genesis
 * grants (platform-admin + marker set) and ordinary bootstrap
 * grants (tenant-admin, including the genesis-closed path) are
 * distinct types: conflating them would hide which exception
 * granted platform scope. Best-effort, never changes the login
 * outcome; a failed write is fail-visible in the result, never
 * fail-blocking — blocking a first-admin grant on an audit outage
 * was not decided anywhere, and #1751's fail-closed set
 * (role:assign / membership:revoke / audit:export where wired)
 * does not cover the bootstrap exception path.
 */
export function buildBootstrapGrantAuditEventInput(input: {
  internalUserId: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
  genesis: boolean;
}): CreateIaaaAuditEventInput {
  const type = input.genesis ? "iaaa.genesis.grant" : "iaaa.bootstrap.grant";
  return {
    timestamp: input.timestamp,
    type,
    actorPrincipalId: input.genesis ? "system:bootstrap-genesis" : "system:bootstrap",
    actorType: "service",
    initiatingPrincipalId: input.internalUserId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: type,
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * #6258 — post-login alias-conflict repair, previously a silent
 * Kv write (the migration record) with only a status string to
 * show for it. Actor = the derived id the login now resolves to;
 * resourceId = the retired id the record migrates from, so the
 * event proves which forward pointer was written, when, and for
 * whom. The mapping itself stays in the alias store. Best-effort,
 * never changes the login outcome.
 */
export function buildIdMigrationRecordedAuditEventInput(input: {
  oldInternalUserId: string;
  newInternalUserId: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "iaaa.id_migration.record",
    actorPrincipalId: input.newInternalUserId,
    actorType: "human",
    initiatingPrincipalId: input.newInternalUserId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "iaaa.id_migration.record",
    resourceId: input.oldInternalUserId,
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * #5160 — the sign-in IDP profile refresh. Actor = the signing-in
 * user (human); the event proves a refresh happened, when, and
 * for whom. It carries no attribute names and no values — the
 * stored profile row is the evidence of what was captured.
 */
export function buildIdpProfileRefreshedAuditEventInput(input: {
  internalUserId: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "iaaa.idp_profile.refreshed",
    actorPrincipalId: input.internalUserId,
    actorType: "human",
    initiatingPrincipalId: input.internalUserId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "iaaa.idp_profile.refreshed",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * #5160 — a sign-in observed a divergence: a user-owned profile
 * value hiding a different provider value. The diverged FIELD
 * NAMES ride in resourceId (comma-joined, sorted) — field names
 * only, never values. Best-effort, never changes the login
 * outcome.
 */
export function buildIdpProfileDivergedAuditEventInput(input: {
  internalUserId: string;
  tenantId: string;
  timestamp: number;
  correlationId: string;
  divergedFields: string[];
}): CreateIaaaAuditEventInput {
  return {
    timestamp: input.timestamp,
    type: "iaaa.idp_profile.diverged",
    actorPrincipalId: input.internalUserId,
    actorType: "human",
    initiatingPrincipalId: input.internalUserId,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    action: "iaaa.idp_profile.diverged",
    resourceId: [...input.divergedFields].sort().join(","),
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: "succeeded",
  };
}

/**
 * Best-effort record: returns the Slice 5 result, and converts a
 * throwing store into an ok:false AUDIT_WRITE_FAILED result
 * instead of propagating. Never throws. Never changes a login
 * outcome by itself — the caller decides what a failure means.
 */
export async function recordWiredAuthAudit(
  store: AuditStore,
  input: CreateIaaaAuditEventInput
): Promise<AuditResult> {
  try {
    return await recordAuditEvent(store, input);
  } catch (err) {
    return {
      ok: false,
      code: "AUDIT_WRITE_FAILED",
      error:
        err instanceof Error
          ? `audit event could not be recorded: ${err.message}`
          : "audit event could not be recorded",
    };
  }
}
