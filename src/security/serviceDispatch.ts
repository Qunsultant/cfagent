/**
 * Service dispatch enforcement (#2331 slice 2).
 *
 * Every dispatch path that can run unattended work resolves its run-as
 * identity through this module. The rules:
 *
 * - A candidate equal to the configured service login is the service tier;
 *   any other shaped login is the owner tier. Service-ness is equality
 *   with the configured login only — with no configuration, nothing is
 *   a service dispatch (a stale service-login string resolves as an
 *   owner login, system-written payloads only, and still cannot present
 *   any user's brokerage token).
 * - The shared-orchestrator address is never an identity. It is an
 *   instance address, and resolving it as a login would let
 *   shared-instance work borrow a principal it does not have.
 * - Platform tier: a live platform-scope MEMBER binding for the service
 *   id. This is deliberately a membership check, not a PDP authorize()
 *   call: authorize() grants platform-scope permissions only to
 *   platform-admin bindings, so a platform-scope member binding carries
 *   no PDP permission under the current policy (the slice-1 caveat).
 *   Using authorize() at platform scope would deny every legitimate
 *   platform dispatch. A platform-admin binding for the service id is
 *   an anomaly, not an upgrade: slice 1 grants member only, so the gate
 *   denies it and surfaces the anomaly via audit instead of silently
 *   running with admin.
 * - Tenant tier: a live tenant-scope member binding in that tenant, PLUS
 *   a PDP authorize() for task:create in that tenant (the "PDP check"
 *   half). A tenant service user never acts across tenants: a binding
 *   in another tenant denies with SERVICE_TENANT_MISMATCH.
 * - Broker independence: a service dispatch that needs brokerage denies
 *   with BROKER_REQUIRED. Brokerage-attached work dispatches as the
 *   owner or not at all; no dispatch path ever resolves, renews, or
 *   presents a user's brokerage token under the service identity.
 *
 * No current production seam carries a tenantId (schedules, async jobs,
 * and Worker crons are tenant-less), so the tenant branch is
 * implemented and tested but awaits a tenant-carrying dispatch. That
 * mirrors authorize() handling scopes it is not always called with.
 *
 * GAP-3 (#5459, CISO coordination #5349, design #5343 / ADR 0034)
 * defines the system-principal binding story on top of the same
 * modules, for consumers that are NOT dispatches — first the
 * IAAA-conformant ledger gate. The story, stated once here and in
 * authz.md §2:
 *
 * - The system principal is `service:<login>`, derived ONLY through
 *   serviceUserInternalUserId — never a second derivation, never a
 *   bare login, never a `system:` provenance string (those stay
 *   provenance-only: grantedBy/createdBy markers, not principals).
 * - The binding that carries a permission for the system actor is a
 *   tenant-scope binding whose role grants it under the EXISTING
 *   policy table — for `ledger:record`, a tenant-admin binding in
 *   the tenant whose ledger is written — provisioned through the
 *   existing general grant path (grantMembership + canGrantRole).
 *   The member-only service-user provisioning route is untouched:
 *   a member binding carries no money permission, and no grant rule
 *   is invented to change that. authorizeSystemPrincipal() below is
 *   the single consultation: configured login -> principal id ->
 *   authorize() at tenant scope. No policy change, no new store.
 * - Fail-closed: an unconfigured or malformed service login does
 *   not resolve (SERVICE_NOT_CONFIGURED); a missing, revoked, or
 *   expired binding denies through the PDP's own reasons at the
 *   next check (0 ms revocation semantics — the PDP fresh-reads
 *   the store on every check). The helper returns explicit denials,
 *   never a silent null; logging and audit belong to the consuming
 *   gate, which receives the threaded login with the decision.
 * - The #2331 invariants stand: a platform-admin binding for the
 *   service id grants nothing at tenant scope (the PDP ignores
 *   platform bindings there), and its presence is surfaced as an
 *   anomaly on the result so the consuming gate audits it — the
 *   flag does not override a PDP allow from a legitimate tenant
 *   binding (CISO review question on the GAP-3 PR). Brokerage
 *   work never runs under the service identity (unchanged).
 * - G-AUD-3 threading is ADVANCED for this actor class, not
 *   closed: the PDP decision carries principalId `service:<login>`
 *   and the result threads the login, so the consuming gate's
 *   audit row is login-attributable. In-process `system` callers
 *   with login null remain open (see the #1763 audit doc).
 *
 * Hardening slice 1 (#5572, CISO coordination #5348/#5349/#5350,
 * design #5343 / ADR 0034 D2) wires the first consumer:
 * authorizeLedgerWrite() below is the ledger-write gate. It
 * composes ONLY the consultations above — the #2331 identity
 * rule for entry, authorizeSystemPrincipal() per tenant for the
 * permission — and adds no policy, no grant rule, and no store.
 * The tenant derivation (from the principal's own memberships,
 * never from the request) is a pattern-following proposal put
 * to CISO review on the slice PR, not a CISO decision; see the
 * helper's contract note.
 */
import {
  authorize,
  type AuthorizationDecision,
  type Membership,
  type MembershipStore,
  type Permission,
} from "./authorization";
import {
  isLoginShaped,
  isSharedOrchestratorAddress,
  serviceUserInternalUserId,
} from "./serviceIdentity";

export type DispatchDenialReason =
  | "NO_IDENTITY"
  | "SHARED_ADDRESS"
  | "SERVICE_NOT_CONFIGURED"
  | "SERVICE_NOT_PROVISIONED"
  | "SERVICE_TENANT_MISMATCH"
  | "BROKER_REQUIRED"
  | "OWNER_MEMBERSHIP_REVOKED"
  | "OWNER_MEMBERSHIP_EXPIRED"
  | "PDP_DENIED";

export type DispatchIdentity =
  | { kind: "owner"; login: string }
  | { kind: "service"; login: string };

export type DispatchDenial = {
  denied: true;
  reason: DispatchDenialReason;
  detail?: string;
};

export type DispatchDecision = DispatchIdentity & { allowed: true } | DispatchDenial;

export type BrokerDecision =
  | { allowed: true; kind: "owner" | "service" }
  | { denied: true; reason: "BROKER_REQUIRED" };

function bindingIsLive(
  binding: { expiresAtMs?: number },
  nowMs: number,
): boolean {
  return binding.expiresAtMs === undefined || binding.expiresAtMs > nowMs;
}

function membershipIsLive(membership: Membership): boolean {
  return membership.revokedAtMs === undefined;
}

/**
 * Pure resolution of a candidate login string into a dispatch identity.
 * No store access: the caller enforces the service tier separately.
 */
export function resolveDispatchCandidate(
  candidate: unknown,
  serviceLogin: string | null,
): DispatchIdentity | DispatchDenial {
  if (!isLoginShaped(candidate)) {
    return { denied: true, reason: "NO_IDENTITY" };
  }
  const login = candidate as string;
  if (isSharedOrchestratorAddress(login)) {
    return { denied: true, reason: "SHARED_ADDRESS" };
  }
  if (serviceLogin !== null && login === serviceLogin) {
    return { kind: "service", login };
  }
  return { kind: "owner", login };
}

/**
 * Identity precedence for an async job row: the payload's recorded
 * owner first, then the Agent Mesh acting stamp, then the submitting
 * request's header, then the instance session key (which, for a
 * per-user instance, is the owner login).
 */
export function resolveAsyncJobIdentity(
  payload: Record<string, unknown> | null | undefined,
  headers: Record<string, string> | null | undefined,
  sessionKey: string,
  serviceLogin: string | null,
): DispatchIdentity | DispatchDenial {
  const candidate =
    payload?.userLogin ??
    payload?.actingLogin ??
    headers?.["x-user-login"] ??
    sessionKey;
  return resolveDispatchCandidate(candidate, serviceLogin);
}

export interface ServiceDispatchRequest {
  serviceLogin: string | null;
  tier: "platform" | "tenant";
  tenantId?: string;
  nowMs: number;
}

/**
 * Enforces the service tier for one dispatch. Owner identities never
 * reach this function — callers resolve first and only enforce when
 * the identity kind is "service".
 */
export async function enforceServiceDispatch(
  store: MembershipStore,
  request: ServiceDispatchRequest,
): Promise<DispatchDecision> {
  if (request.serviceLogin === null) {
    return { denied: true, reason: "SERVICE_NOT_CONFIGURED" };
  }
  const serviceLogin = request.serviceLogin;
  const serviceId = serviceUserInternalUserId(serviceLogin);
  const memberships = await store.getMembershipsByUser(serviceId);

  if (request.tier === "platform") {
    const provisioned = memberships.some(
      (membership) =>
        membershipIsLive(membership) &&
        membership.roleBindings.some(
          (binding) =>
            binding.role === "member" &&
            binding.scope === "platform" &&
            bindingIsLive(binding, request.nowMs),
        ),
    );
    if (!provisioned) {
      return { denied: true, reason: "SERVICE_NOT_PROVISIONED" };
    }
    return { allowed: true, kind: "service", login: serviceLogin };
  }

  // Tenant tier: the membership's tenant is the tenant it belongs to.
  const tenantId = request.tenantId;
  if (tenantId === undefined) {
    return { denied: true, reason: "SERVICE_TENANT_MISMATCH" };
  }
  const liveMemberships = memberships.filter(membershipIsLive);
  const tenantProvisioned = liveMemberships.some(
    (membership) =>
      membership.tenantId === tenantId &&
      membership.roleBindings.some(
        (binding) =>
          binding.role === "member" &&
          binding.scope === "tenant" &&
          bindingIsLive(binding, request.nowMs),
      ),
  );
  if (tenantProvisioned) {
    const decision = await authorize(store, {
      actorInternalUserId: serviceId,
      tenantId,
      permission: "task:create",
      scope: "tenant",
      nowMs: request.nowMs,
    });
    if (decision.decision === "allow") {
      return { allowed: true, kind: "service", login: serviceLogin };
    }
    return {
      denied: true,
      reason: "PDP_DENIED",
      detail: decision.reason,
    };
  }
  const hasLiveMembershipInRequestedTenant = liveMemberships.some(
    (membership) => membership.tenantId === tenantId,
  );
  if (hasLiveMembershipInRequestedTenant) {
    return { denied: true, reason: "SERVICE_NOT_PROVISIONED" };
  }
  if (liveMemberships.length > 0) {
    return { denied: true, reason: "SERVICE_TENANT_MISMATCH" };
  }
  return { denied: true, reason: "SERVICE_NOT_PROVISIONED" };
}

/**
 * Broker independence at dispatch: a service identity never runs
 * brokerage-attached work. Owner dispatches are unaffected.
 */
export function enforceBrokerDispatch(
  kind: "owner" | "service",
  needsBroker: boolean,
): BrokerDecision {
  if (kind === "service" && needsBroker) {
    return { denied: true, reason: "BROKER_REQUIRED" };
  }
  return { allowed: true, kind };
}

// ---------------------------------------------------------------------------
// System-principal binding story (GAP-3, #5459)
// ---------------------------------------------------------------------------

export interface SystemPrincipalPermissionRequest {
  /** Configured service login (getServiceUserLogin), or null when unconfigured. */
  serviceLogin: string | null;
  /** Tenant the permission is evaluated in — the tenant whose ledger is written. */
  tenantId: string;
  permission: Permission;
  nowMs: number;
}

export type SystemPrincipalPermissionResult =
  | {
      resolved: true;
      /**
       * The PDP decision over the service principal's binding.
       * principalId is `service:<login>` — the threaded login
       * (G-AUD-3 advance): the consuming gate's audit row carries
       * it verbatim. The decision is authorize()'s own, unchanged.
       */
      decision: AuthorizationDecision;
      /** The configured service login the principal id derives from. */
      serviceLogin: string;
      /** The service principal's stable internal id, `service:<login>`. */
      principalId: string;
      /**
       * Set when the service principal holds a platform-admin
       * binding on a live membership — an anomaly under #2331
       * slice 1 (the provisioning route grants member only). The
       * PDP grants such a binding nothing at tenant scope, so the
       * anomaly never silently runs with admin; the flag exists so
       * the consuming gate audits it. It does not override a PDP
       * allow from a legitimate tenant binding.
       */
      anomaly?: string;
    }
  | { resolved: false; reason: "SERVICE_NOT_CONFIGURED" | "SHARED_ADDRESS" };

/**
 * GAP-3 (#5459): the system-principal binding consultation — the
 * single place a non-dispatch consumer (first the ledger gate)
 * asks whether the system actor holds a permission in a tenant.
 * Configured login -> `service:<login>` -> authorize() at tenant
 * scope, through the existing modules only: no policy change, no
 * new grant rule, no new store. The binding that carries the
 * permission is a tenant-scope binding whose role grants it under
 * the existing table (for `ledger:record`, tenant-admin), granted
 * through the existing general grant path; a member binding denies
 * with the PDP's own NO_GRANT, exactly as it denies any actor.
 *
 * Fail-closed: an unconfigured or malformed login does not
 * resolve — never a fallback identity, never a throw. A missing,
 * revoked, or expired binding denies through the PDP at the next
 * check. Store/PDP errors propagate to the caller, which fails
 * closed — no access without an explicit PDP allow.
 */
export async function authorizeSystemPrincipal(
  store: MembershipStore,
  request: SystemPrincipalPermissionRequest,
): Promise<SystemPrincipalPermissionResult> {
  const serviceLogin = request.serviceLogin;
  if (serviceLogin === null || !isLoginShaped(serviceLogin)) {
    return { resolved: false, reason: "SERVICE_NOT_CONFIGURED" };
  }
  if (isSharedOrchestratorAddress(serviceLogin)) {
    // The shared-orchestrator address is an instance address, never
    // an identity — the same rule resolveDispatchCandidate applies
    // on the dispatch path. A service login configured to an
    // address resolves to nothing, even if bindings exist for it.
    return { resolved: false, reason: "SHARED_ADDRESS" };
  }
  const principalId = serviceUserInternalUserId(serviceLogin);
  const decision = await authorize(store, {
    actorInternalUserId: principalId,
    tenantId: request.tenantId,
    permission: request.permission,
    scope: "tenant",
    nowMs: request.nowMs,
  });
  const memberships = await store.getMembershipsByUser(principalId);
  const holdsAdminBinding = memberships.some(
    (membership) =>
      membership.revokedAtMs === undefined &&
      membership.roleBindings.some((binding) => binding.role === "platform-admin"),
  );
  return {
    resolved: true,
    decision,
    serviceLogin,
    principalId,
    ...(holdsAdminBinding
      ? {
          anomaly:
            "platform-admin binding held by the service principal — an anomaly under #2331 slice 1 (provisioning grants member only); the PDP grants it nothing at tenant scope",
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Ledger-write gate (hardening slice 1, #5572)
// ---------------------------------------------------------------------------

export interface LedgerWriteGateRequest {
  /** The login the request presented (the `x-user-login` header value). */
  presentedLogin: unknown;
  /** Configured service login (getServiceUserLogin), or null when unconfigured. */
  serviceLogin: string | null;
  nowMs: number;
}

export type LedgerWriteDenialReason =
  | "NO_IDENTITY"
  | "SHARED_ADDRESS"
  | "SERVICE_NOT_CONFIGURED"
  | "SERVICE_NOT_PROVISIONED"
  | "NOT_SERVICE_ACTOR"
  | "PDP_DENIED";

export type LedgerWriteGateResult =
  | {
      allowed: true;
      /** The configured service login the principal id derives from. */
      serviceLogin: string;
      /** The service principal's stable internal id, `service:<login>`. */
      principalId: string;
      /** The tenant whose binding allowed the write. */
      tenantId: string;
      /** The PDP decision that allowed the write. */
      decision: AuthorizationDecision;
      /** Every tenant evaluated, in evaluation order. */
      tenantsEvaluated: string[];
      /** Carried from the consultation when the anomaly flag was raised. */
      anomaly?: string;
    }
  | {
      allowed: false;
      reason: LedgerWriteDenialReason;
      /**
       * The PDP reason(s) when the denial came from the PDP
       * (`<tenant>:<reason>` per evaluated tenant), else the
       * rule detail from the identity resolution.
       */
      detail?: string;
      /** Every tenant evaluated, in evaluation order (empty when the denial precedes evaluation). */
      tenantsEvaluated: string[];
      /** Carried from the consultation when the anomaly flag was raised. */
      anomaly?: string;
    };

/**
 * #5572: the ledger-write gate — the single consultation the
 * ledger write-through handlers enforce before writing a row.
 * It composes only existing consultations:
 *
 * 1. Entry requires the request to present the service identity.
 *    Service-ness is equality with the configured login only
 *    (#2331, resolveDispatchCandidate): the PDP consultation
 *    below evaluates the SERVICE principal's binding, so a
 *    request presenting anything else must never reach it —
 *    otherwise any caller would borrow the service actor's
 *    grant. A shaped non-service login denies as
 *    NOT_SERVICE_ACTOR; only the service actor writes ledger
 *    rows through these routes (their only legitimate callers
 *    are server-side).
 * 2. The permission is `ledger:record` (GAP-2) over the system
 *    actor's binding (GAP-3), via authorizeSystemPrincipal()
 *    — no policy change, no new grant rule, no new store.
 * 3. Tenant derivation is from the service principal's OWN
 *    memberships in the store, never from the request: two
 *    legitimate write paths carry no tenant at all (the x402
 *    `record` path has no tenant concept; the saga compensation
 *    credit passes none), and a body tenantId is
 *    client-supplied from the handler's perspective (filed
 *    M-4). The gate consults in every tenant where the
 *    principal holds a membership, in sorted order, and
 *    allows iff the PDP allows in at least one. The PDP
 *    itself decides revoked/expired bindings — the gate never
 *    pre-filters what the PDP decides. This derivation is a
 *    pattern-following proposal put to CISO review on the
 *    slice PR, not a CISO decision; the residual is stated
 *    plainly: the gate authorizes the ACTOR, not the
 *    actor-in-the-write's-tenant, and the tenant-attribution
 *    refinement is a CISO follow-up question.
 *
 * Fail-closed: an unconfigured or malformed service login, a
 * missing identity, a shared-orchestrator address, a
 * non-service presenter, no membership anywhere, or a PDP
 * denial in every evaluated tenant all deny — never a
 * fallback identity, never a throw for an expected denial.
 * Store/PDP errors propagate to the caller, which fails
 * closed — no write without an explicit PDP allow. Logging
 * and audit belong to the consuming handler, which receives
 * the threaded login, the evaluated tenants, and the anomaly
 * flag with the decision (GAP-3's contract: the anomaly never
 * overrides a PDP allow from a legitimate tenant binding).
 */
export async function authorizeLedgerWrite(
  store: MembershipStore,
  request: LedgerWriteGateRequest,
): Promise<LedgerWriteGateResult> {
  const serviceLogin = request.serviceLogin;
  if (serviceLogin === null || !isLoginShaped(serviceLogin)) {
    return {
      allowed: false,
      reason: "SERVICE_NOT_CONFIGURED",
      tenantsEvaluated: [],
    };
  }
  if (isSharedOrchestratorAddress(serviceLogin)) {
    return {
      allowed: false,
      reason: "SHARED_ADDRESS",
      tenantsEvaluated: [],
    };
  }
  const candidate = resolveDispatchCandidate(
    request.presentedLogin,
    serviceLogin,
  );
  if ("denied" in candidate) {
    // resolveDispatchCandidate denies only with NO_IDENTITY or
    // SHARED_ADDRESS; the narrowing below is exhaustive over its
    // denial shape (the wider DispatchDenialReason union covers
    // the enforcement halves this gate never calls).
    const reason: LedgerWriteDenialReason =
      candidate.reason === "SHARED_ADDRESS"
        ? "SHARED_ADDRESS"
        : "NO_IDENTITY";
    return {
      allowed: false,
      reason,
      ...(candidate.detail !== undefined
        ? { detail: candidate.detail }
        : {}),
      tenantsEvaluated: [],
    };
  }
  if (candidate.kind !== "service") {
    return {
      allowed: false,
      reason: "NOT_SERVICE_ACTOR",
      tenantsEvaluated: [],
    };
  }
  const principalId = serviceUserInternalUserId(serviceLogin);
  const memberships = await store.getMembershipsByUser(principalId);
  const tenantsEvaluated = [
    ...new Set(memberships.map((membership) => membership.tenantId)),
  ].sort();
  if (tenantsEvaluated.length === 0) {
    return {
      allowed: false,
      reason: "SERVICE_NOT_PROVISIONED",
      tenantsEvaluated,
    };
  }
  let anomaly: string | undefined;
  const pdpReasons: string[] = [];
  for (const tenantId of tenantsEvaluated) {
    const consultation = await authorizeSystemPrincipal(store, {
      serviceLogin,
      tenantId,
      permission: "ledger:record",
      nowMs: request.nowMs,
    });
    if (!consultation.resolved) {
      // Unreachable: the login was validated above. Fail closed
      // rather than assume the consultation can only resolve.
      return {
        allowed: false,
        reason: "SERVICE_NOT_CONFIGURED",
        detail: consultation.reason,
        tenantsEvaluated,
      };
    }
    if (consultation.anomaly !== undefined && anomaly === undefined) {
      anomaly = consultation.anomaly;
    }
    if (consultation.decision.decision === "allow") {
      return {
        allowed: true,
        serviceLogin,
        principalId,
        tenantId,
        decision: consultation.decision,
        tenantsEvaluated,
        ...(anomaly !== undefined ? { anomaly } : {}),
      };
    }
    pdpReasons.push(`${tenantId}:${consultation.decision.reason}`);
  }
  return {
    allowed: false,
    reason: "PDP_DENIED",
    detail: pdpReasons.join(","),
    tenantsEvaluated,
    ...(anomaly !== undefined ? { anomaly } : {}),
  };
}

/**
 * Thin Worker-entry helper: the scheduled()/queue() gates need only the
 * platform provisioned answer, not the full decision shape.
 */
export async function isPlatformServiceProvisioned(
  store: MembershipStore,
  serviceLogin: string | null,
  nowMs: number,
): Promise<boolean> {
  if (serviceLogin === null) {
    return false;
  }
  const decision = await enforceServiceDispatch(store, {
    serviceLogin,
    tier: "platform",
    nowMs,
  });
  return !("denied" in decision);
}
