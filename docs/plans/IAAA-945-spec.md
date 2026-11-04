# IAAA-with-Auth0 — Assessment and Specification (PROPOSED)

> Status: **PROPOSED, not adopted.** This document is the assessment-first
> step required by GitHub issue #945 §10 ("Begin with assessment,
> architecture options, provider costs, schemas, permission matrix, tests,
> and migration plan"). It does not change production identity, secrets,
> permissions, or infrastructure, and it does not select a provider.
> No code is changed by this document alone.
>
> **Refresh 2026-11-04 (issue #3152, parent #945):** this refresh applies
> the Q11 reconciliations from #945 comment 6630444615, verified
> file by file against `main` @ `acea3a6`. The document stays PROPOSED.
> This refresh does not adopt any decision, and no decision is claimed
> as adopted that its deciding role has not approved. The CISO assurance
> review (`docs/architecture/security/iaaa-945-assurance-review.md`)
> stays DRAFT, NOT ADOPTED; this refresh uses it as a source of
> questions, never as an adopted verdict.
>
> Issue: [#945 — [EPIC] IAAA-with-Auth0](https://github.com/Qunsultant/cfagent/issues/945)
> Agent: #ceo-aimp
> Ownership per #945: CISO owns security requirements + assurance,
> CTO owns implementation, CDO owns identity-data integrity/lifecycle,
> Independent Evaluation verifies. Reserved approvals stay with named humans.

## 1. Outcome

Every human or agent action in cfagent must be able to answer, from
evidence: who initiated it, how they authenticated, why it was authorized,
which agent or service executed it, and what actually happened.

IAAA = Identification, Authentication, Authorization, Accountability
(including auditing). This is broader than "users can log in and have
roles": a login must not be treated as authorization, a role name must not
be treated as a credential, and ordinary logs must not be treated as
non-repudiation proof (#945 §2, §10).

## 2. Assessment — current state (verified 2026-11-04, `main` @ `acea3a6`)

The 2026-10-21 assessment is struck as history. What follows is what is
actually on main now. "Exists" means code and tests on main; it does not
mean adopted, wired into every live path, or proven by Independent
Evaluation — §7 separates those three states per slice.

### What exists

- **Human login:** GitHub OAuth and Google OIDC through a generic
  provider boundary (`src/security/providers.ts` registers `github`,
  `google`, and `apple`; Google issuer `https://accounts.google.com`).
  Tests: `tests/iaaa_google_provider.test.ts`,
  `tests/iaaa_github_end_to_end.test.ts`,
  `tests/iaaa_oidc_validation.test.ts`. Login is federated social
  only; there are no local passwords.
- **Stable internal identities:** identity is `(issuer, subject)`,
  never email or login alone. Identity binding, login-key cutover,
  and migration code live in `src/security/iaaaLogin.ts`,
  `src/security/iaaaLoginKey.ts`, `src/security/iaaaMigration.ts`.
  Tests: `tests/iaaa_identity_binding.test.ts`,
  `tests/iaaa_login_key_cutover_1759.test.ts`,
  `tests/iaaa_repair_migration.test.ts`.
- **Sessions:** `src/security/session.ts` plus
  `src/security/iaaaSessionActivity.ts` — UUID session IDs in the
  SessionStore Durable Object, 7-day TTL, `HttpOnly; Secure;
  SameSite=Lax` cookie, idle expiry (30 min, settled CISO value),
  step-up freshness (15 min, settled CISO value), rotation, and CSRF
  protection. Tests: `tests/iaaa_session_*.test.ts`,
  `tests/iaaa_csrf_3113.test.ts`, `tests/iaaa_step_up*.test.ts`.
  **Main behavior wins over the old spec line:** a session without
  `authTimeMs` (every legacy session) is stale for step-up purposes
  (`iaaaSessionActivity.ts`). The 2026-10-21 spec line making new
  session fields "optional until adoption, so old sessions are not
  invalidated" is struck.
- **Tenant/workspace membership and PDP:** `src/security/iaaaMembershipStore.ts`
  (memberships with per-binding expiry and revoke-by-id),
  `src/security/iaaaPdpSeam.ts`, `src/security/iaaaEnforcement.ts`.
  Both `IAAA_PDP_ENABLED=1` and `IAAA_WIRING_ENABLED=1` are live in
  production configuration, each with a documented off-switch
  (set to `"0"` and redeploy; no code change). Tests:
  `tests/iaaa_authorization.test.ts`,
  `tests/iaaa_pdp_architecture_1755.test.ts`,
  `tests/iaaa_gate_coverage_1754.test.ts`,
  `tests/iaaa_legacy_pdp_bound_1749.test.ts`.
- **Tenant isolation:** `tests/iaaa_tenant_isolation.test.ts` exists.
  Extending it to search-index and job paths (assurance-review R8)
  is an adoption requirement, not a proven property.
- **Bounded agent delegation (policy, not live enforcement):**
  `src/security/delegation.ts` — effective authority as an
  intersection (initiator ∩ tenant ∩ resource ∩ delegation ∩
  approval), action-count budget, expiry, revocation, re-check at
  execution time, re-delegation capped by the original. By its own
  header it is deliberately NOT live enforcement and touches no
  agent, task, job, route, or permission check. Tests:
  `tests/iaaa_delegation.test.ts`.
- **Audit:** live audit routes over `mas_events`
  (`src/agents/routes/audit.ts`); tamper-evident SHA-256 hash chain
  on live `mas_events` rows (`src/security/auditChain.ts`, #2178,
  Q7 S1); the `iaaaAudit.ts` audit-event model and audit-failure
  policy (consequential actions block, non-consequential proceed
  with warning) as pure policy, not live enforcement. The money-path
  audit gate (`src/services/auditGate.ts`, #2183) is available but
  NOT wired into money paths (audit-only mode until CISO+CDO sign
  off and an operator enables enforcement). Retention is live on
  the nightly `0 4` Worker cron (`src/security/storageRetention.ts`):
  mas_messages 90 days, mas_events 365 days, mas_memory 365 days,
  env-configurable, per-run caps, never silent. Tests:
  `tests/iaaa_audit.test.ts`, `tests/audit_chain_2178.test.ts`.
- **Revocation:** numeric propagation targets in
  `src/security/revocationTargets.ts` (#1750) for five triggers
  (membership-revocation, session-revocation, API-key deletion,
  admin-removal, token-expiry), pinned by
  `tests/iaaa_revocation_targets_1750.test.ts` and
  `tests/iaaa_revocation_session_cache_1750.test.ts`; the Q6
  extension rows (cached decisions, running tasks, pending
  approvals, queued actions, re-delegated work) are defined in
  #945 comment 6630444615. A revocation-mid-run consumer on the
  run path does not exist yet.
- **Service / workload identity:** see §4. Live via #2331 slices
  1–2 (provision route, dispatch enforcement, provisioning UI).
  Provisioning itself awaits a platform-admin session; that is an
  owner step, not missing code.
- **Admin UI and counts:** `src/client/IaaaAdminPanel.tsx` plus
  `src/security/iaaaAdminOverview.ts`; platform-admin and
  tenant-admin counts served on the overview route. Tests:
  `tests/iaaa_admin_*.test.ts`.
- **Provider state:** zero Auth0 runtime paths on main. The only
  `auth0` mentions under `src/` are comments (a provider-
  registration template in `providers.ts`, spec references in
  `authorization.ts` and `sessionPolicy.ts`). No Auth0 tenant,
  application, secret, callback, or client exists.

### Gaps remaining (each is a slice, a proposal, or a verdict — not a claim)

| #945 requirement | Current state | What remains |
|---|---|---|
| Stable internal identities (§3) | Identity binding live | Migration of remaining GitHub-login-scoped data (CDO + CTO) |
| Secure sessions (§4) | Idle/step-up/rotation/CSRF live | Per-action step-up windows (Q4 remainder); legacy-session rule |
| Membership + PDP (§5) | Store, seam, enforcement live | Enforcement inventory across retrieval/search/job surfaces (R8) |
| Bounded delegation (§5) | Policy module live, not wired | Live enforcement wiring; `maxCost` (future requirement); approval-record binding |
| Attributable audit (§6) | Chain live on mas_events; model pure | Audit-gate money-path wiring (needs CISO+CDO fail-direction decision); tamper-response runbook |
| Revocation (§7) | Targets live; Q6 rows defined | Revocation-mid-run consumer; user-callback dispatch re-check proof |
| Service identity (§5/§10) | #2331 model live | Platform-tier provisioning (owner step); stale `serviceIdentity.ts` framing correction |
| Adoption (§8/§10) | This refresh; Q1–Q11 answered or proposed | Independent Evaluation verdict; §15 report; owner close decision |

### Reference implementation note

#945 names cfpay #252 as the existing reference implementation,
described in the epic as "code-complete, dark pending owner OAuth/secret
actions". That pattern is the warning for this epic too: provider
integration must not be presented as live until the owner OAuth/secret
actions it depends on are actually completed. The live provider surface
here is GitHub + Google through the application-owned boundary; no
Auth0 dependency exists.

## 3. Architecture options (decision recorded, not re-decided here)

**Owner decision 2026-10-25 (Q1, Q2): provider APP-OWNED, framework
FOSS; tenant APP-OWNED. Auth0 is deferred; the Auth0 cost verification
the 2026-10-21 draft asked for is moot while Auth0 is deferred.** This
refresh records that decision; it does not re-decide it.

### Option A — Auth0 as identity provider, application-owned authorization

- Auth0 (or Auth0 Organizations) issues human identities; the
  application binds `(issuer, subject)` to a stable internal user ID,
  owns tenant/workspace memberships, roles, delegation, and the PDP,
  and owns audit evidence.
- Retained as a future option if the owner revisits the provider
  decision. It is not the implemented direction, and no adoption
  statement in this refresh implies otherwise.

### Option B — Application-owned OIDC (Google + GitHub first, Auth0 later)

- The implemented direction: GitHub OAuth and Google OIDC through the
  same integration boundary, with the internal identity, membership,
  PDP, delegation, and audit layers owned by the application.
  Auth0 becomes a later provider behind that boundary only if the
  owner re-decides, not a prerequisite for the core.
- Trade-off: the application owns the provider-integration burden
  (session, step-up, recovery) that Auth0 would otherwise provide.

### Option C — Auth0 for identity AND authorization

- Delegate roles/permissions to the provider's authorization features.
- Rejected as the default (to be challenged in review):
  #945 §5 requires resource, tenant, delegation, approval, and context
  checks that live in application state, and §9 warns that a provider
  may charge for exactly the custom-role/organization/audit features
  this epic needs. If this option is ever chosen, the spec must show
  how each §5 check is evaluated server-side, not only in the UI or token.

## 4. Proposed data model (additive, backward-compatible)

No existing field is renamed or removed in this spec. New fields are
optional until a migration slice adopts them, so existing sessions
keep working — except for the step-up rule in §2, where main behavior
(a session without `authTimeMs` is stale) already wins.

```typescript
// Proposed — not yet implemented, except where §2/§7 say live.
interface IdentityBinding {
  internalUserId: string;          // stable, never derived from email/login
  providerIssuer: string;           // validated issuer, e.g. GitHub / Google / Auth0
  providerSubject: string;          // provider-stable subject, never email alone
  linkedAt: number;
  proofOfControl: "oidc" | "invitation" | "recovery";
}

interface Membership {
  membershipId: string;
  internalUserId: string;
  tenantId: string;
  workspaceId?: string;
  roleBindings: RoleBinding[];      // roles bundle permissions; they are not the decision
  createdBy: string;
  createdAt: number;
  revokedAt?: number;
}

interface RoleBinding {
  role: string;                     // e.g. tenant-admin, workspace-admin, member, approver, auditor
  scope: "platform" | "tenant" | "workspace" | "resource";
  resourceId?: string;
  grantedBy: string;
  expiresAt?: number;
}

interface Delegation {
  delegationId: string;
  initiatorId: string;              // initiating human/service principal
  agentInstanceId: string;
  taskId: string;
  allowedActions: string[];         // explicit, not "all"
  resourceScope: string[];
  expiresAt: number;
  budget?: { maxActions?: number; maxCost?: number };
  reDelegation: "forbidden" | "scoped";
  revokedAt?: number;
}

// NOTE (Q8, #945 comment 6630444615): budget.maxCost is a FUTURE
// REQUIREMENT, not an implemented control. src/security/delegation.ts
// is action-count only and says so explicitly ("spec §4 maxCost field
// is not modelled until a cost model"). "Scoped" re-delegation means:
// bounded by the original's actions, scope, expiry, and remaining
// budget — never wider, never longer, never more total actions.
// Proposal-version/hash binding for approvals is defined as a rule
// (a material proposal change invalidates the approval); the binding
// mechanism in approval records is owed. These definitions are
// PROPOSED for CISO+CTO adoption, not adopted here.

interface ServiceIdentity {
  serviceId: string;                // "service:<login>", e.g. service:svc-background
  login: string;                    // non-secret login id (SERVICE_USER_LOGIN)
  memberships: Membership[];        // first-class IAAA memberships, same store as users
  tiers: ("platform" | "tenant")[]; // platform tier = live-membership check;
                                    // tenant tier = membership + PDP task:create
  brokerageToken: never;            // the service NEVER holds a brokerage token (#2331)
}

// NOTE (Q10, #945 comment 6630444615): this is the #2331 model, live
// in slices 1–2 (provision route, dispatch enforcement, provisioning
// UI; dispatch denied → async_job.dispatch_denied audit + job failed,
// schedule preserved; fail-closed when unprovisioned). CORRECTION
// FLAGGED, not silently rewritten here: src/security/serviceIdentity.ts
// still describes the service identity as authorized "through the same
// 3-legged E*TRADE linking flow". That framing is superseded by the
// #2331 owner decision (never a brokerage token) and needs its own
// correction; this refresh does not edit that file.

interface AuthorizationDecision {
  principalId: string;
  membershipId?: string;
  action: string;                   // e.g. artifact:export, task:cancel
  resourceId?: string;
  tenantId: string;
  workspaceId?: string;
  delegationId?: string;
  approvalId?: string;
  decision: "allow" | "deny";
  policyVersion: string;
  reason: string;
  decidedAt: number;
}

// IAAA audit event — extends mas_events, does not replace its existing
// session-scoped rows until a migration slice says so (#945 §6).
interface IaaaAuditEvent {
  id: string;
  timestamp: number;                // trusted time
  type: string;
  actorPrincipalId: string;
  actorType: "human" | "service" | "agent";
  initiatingPrincipalId: string;
  tenantId: string;
  workspaceId?: string;
  taskId?: string;
  agentInstanceId?: string;
  agentRunId?: string;
  delegationId?: string;
  correlationId: string;
  action: string;
  resourceId?: string;
  decision: "allow" | "deny";
  policyVersion: string;
  approvalId?: string;
  outcome: "succeeded" | "failed" | "pending" | "unknown";
  errorCode?: string;
  // Never raw credentials or tokens. Authentication assurance/session
  // references only.
}
```

Session evolution (live, not future): `SessionData` carries
`internalUserId`, `providerIssuer`, `providerSubject`, `tenantId`,
`authTimeMs` (for step-up freshness), and `sessionVersion` (for
revocation propagation). A session without `authTimeMs` is stale for
step-up purposes — see §2.

## 5. Permission matrix (from #945 §5; grant rules to be confirmed)

Default: **deny**. Possessing a permission must not automatically
grant permission to grant it to others. Platform administration is
separate from tenant administration; a tenant administrator cannot
grant platform privileges. A platform binding never grants tenant
permissions.

| Permission | Platform admin | Tenant admin | Workspace admin | Member | Approver | Auditor |
|---|---|:---:|:---:|:---:|:---:|:---:|
| membership:invite | — | ✓ | ✓ (workspace) | — | — | — |
| membership:revoke | — | ✓ | ✓ (workspace) | — | — | — |
| role:assign | ✓ (platform) | ✓ (tenant) | ✓ (workspace) | — | — | — |
| task:create / task:read / task:cancel | — | ✓ | ✓ | ✓ (own scope) | — | read |
| artifact:read / artifact:edit / artifact:export | — | ✓ | ✓ | ✓ (own scope) | — | read |
| integration:connect / integration:use / integration:manage | — | ✓ | ✓ | use (granted) | — | — |
| action:propose / action:approve / action:execute | — | ✓ | ✓ | propose | approve (assigned) | — |
| audit:read / audit:export | ✓ (platform) | ✓ (tenant) | ✓ (workspace) | — | — | read |

Every permission above is evaluated at the PDP as:
principal + active membership + role permissions + resource
relationship + tenant/workspace policy + delegation limits +
approval requirements + relevant context. Role alone never decides.

NOTE (Q9, #945 comment 6630444615): grant rules are PROPOSED for
CISO+CTO + owner approval, not adopted here: second approver for
tenant-admin and platform-admin grants (today single-admin approval
through the access-request route); a default grant expiry (proposed
initial value 90 days for tenant grants; platform genesis exempt
pending an owner decision; the value itself is the owner's to set);
granter revocation does not cascade-revoke grants, but grants by a
revoked granter are listed in a review queue (the queue itself is an
owed slice). Member brokerage self-connect follows the #2450 policy
(members granted `integration:connect`, admin revokes per member).

## 6. Acceptance tests (from #945 §8, mapped to tests on main)

"File exists" below is verified against `main` @ `acea3a6`
(2026-11-04). File existence is not proof of every negative case:
the assurance-review R1–R10 negative tests are adoption requirements
for Independent Evaluation, and a file is listed here only where the
named demonstration's test file exists on main.

| #945 demonstration | Test on main (verified) |
|---|---|
| Email changes do not create a new identity or transfer another user's account | `tests/iaaa_identity_binding.test.ts` |
| Unproven provider linking is rejected | `tests/iaaa_identity_binding.test.ts` |
| Invalid, expired, wrong-issuer, or wrong-audience tokens are rejected | `tests/iaaa_oidc_validation.test.ts` |
| Sensitive actions enforce authentication freshness / step-up | `tests/iaaa_step_up.test.ts` |
| Tenant A cannot access Tenant B's resources via direct IDs, search, exports, or jobs | `tests/iaaa_tenant_isolation.test.ts` (extend to search-index and job paths per R8) |
| A tenant administrator cannot grant platform privileges | `tests/iaaa_authorization.test.ts` |
| Agents cannot expand delegated scope or reuse revoked authority | `tests/iaaa_delegation.test.ts` |
| Material proposal changes invalidate prior approval | `tests/iaaa_approval.test.ts` |
| A consequential action traces to initiator, workload, delegation, policy, approval, outcome | `tests/iaaa_audit.test.ts` |
| Audit failures are detected and handled per policy | `tests/iaaa_audit.test.ts` |
| Membership revocation affects sessions, queued work, active tasks per contract | `tests/iaaa_revocation.test.ts`, `tests/iaaa_revocation_targets_1750.test.ts`, `tests/iaaa_revocation_session_cache_1750.test.ts` |
| Interrupted execution reconciles without blindly repeating side effects | `tests/iaaa_recovery.test.ts` |
| Legitimate workflows still succeed (a system that denies everything fails) | every test file above, positive cases |

Supporting coverage verified on main: `tests/iaaa_gate_coverage_1754.test.ts`,
`tests/iaaa_legacy_pdp_bound_1749.test.ts`,
`tests/iaaa_obligations_1751.test.ts`,
`tests/iaaa_csrf_3113.test.ts`,
`tests/iaaa_wired_freshness_gate_2444.test.ts`,
`tests/iaaa_session_rotation_3113.test.ts`,
`tests/iaaa_bootstrap_v1_entries.test.ts`,
`tests/iaaa_genesis_atomic_claim.test.ts`,
`tests/audit_chain_2178.test.ts`.

## 7. Migration plan — delta against implemented code (per #945 §10 order)

Adoption is a delta against implemented code, not a green-field
sequence. Each row states what is on main, what is flag-gated, and
what remains. "Live" means code and tests on main and enabled in
production configuration unless noted; it does not mean adopted by
Independent Evaluation.

| Spec slice | On main | Flag-gated / pure policy | Remains |
|---|---|---|---|
| 1 — Stable internal identities + provider binding | Identity binding, login-key cutover, migration; GitHub + Google login | — | Migration of remaining GitHub-login-scoped data (CDO + CTO) |
| 2 — Login/session hardening | Session activity, idle 30 min, step-up 15 min, rotation, CSRF | — | Per-action step-up windows (Q4 remainder); legacy-session rule |
| 3 — Membership + PDP | Membership store, PDP seam, enforcement; `IAAA_PDP_ENABLED=1`, `IAAA_WIRING_ENABLED=1` | Off-switches documented (set to `"0"` + redeploy) | Enforcement inventory across retrieval/search/job surfaces (R8) |
| 4 — Delegation | Policy module + tests | Pure policy, NOT live enforcement; `maxCost` not implemented (future requirement); approval-record binding owed | Live enforcement wiring |
| 5 — Accountability | Audit routes; hash chain live on mas_events (#2178); retention live (90d/365d/365d nightly) | `iaaaAudit.ts` model pure, not wired; audit gate (#2183) unwired, audit-only mode | Money-path gate wiring (needs CISO+CDO fail-direction decision); tamper-response runbook |
| 6 — Lifecycle verification | Revocation targets (#1750) + Q6 extension rows defined; recovery tests | — | Revocation-mid-run consumer; user-callback dispatch re-check proof |
| Service identity (#2331) | Provision route, dispatch enforcement, provisioning UI | — | Platform-tier provisioning (owner session step, not code) |
| Admin UI + counts | Panel + overview counts | — | — |
| Agentic scheduling (#3121/#3122) | — | — | Filed program only, not built: no scheduler code is claimed here |
| This refresh (#3152) | This document, PROPOSED | — | CTO + CDO review of the refresh |
| Adoption (#945 close) | Q1–Q11 answered or proposed (comment 6630444615) | — | Independent Evaluation verdict (Q12); §15 report; owner close decision |

Each slice is one issue → branch → PR → merge into `main` →
post-merge verification (AGENTS.md §11), TDD red→green, never over a
red required check, agent hashtag on every issue/PR, pins updated in
the same PR if altered, §15 completion report on close.

## 8. Open decisions (owners, due before the slice that needs them)

| Decision | Owner | Status after this refresh |
|---|---|---|
| Auth0 (Option A) vs application-owned OIDC first (Option B) | CTO + CISO, human owner approves provider | DECIDED 2026-10-25: APP-OWNED, FOSS (Q1). Auth0 deferred. |
| Auth0 production costs: custom roles, federation, org scale, audit | Finance + CTO | MOOT while Auth0 deferred (Q1). |
| Tenant model: Auth0 Organizations vs application-owned tenants | CTO + CDO | DECIDED 2026-10-25: APP-OWNED (Q2). Mapping onto §4 types owed by CTO lane. |
| Step-up thresholds: which actions require freshness, and how fresh | CISO | SETTLED in part: 15 min step-up / 30 min idle (D-1). Per-action windows carried (Q4 remainder). |
| Revocation propagation requirement (measurable, not "instant") | CISO + CTO | MEASURE TABLE COMPLETE: #1750 five triggers + Q6 five extension rows (comment 6630444615). Mid-run consumer owed as a slice. |
| Audit retention, tamper-detection mechanism, audit-failure blocking set | CISO + CDO | PARTLY LIVE: retention windows live; tamper chain live (#2178); blocking set defined. OPEN: enforcing-mode fail direction; tamper runbook owed. |
| Delegation definitions (scoped re-delegation, approval binding) | CISO + CTO | PROPOSED in comment 6630444615 (Q8). `maxCost` future requirement. |
| Grant rules (second approver, default expiry, granter revocation) | CISO + CTO + owner | PROPOSED in comment 6630444615 (Q9). |
| Service / workload identity model | #2331 decisions + owner | SETTLED as a model (Q10): #2331 slices 1–2 live; never a brokerage token. |
| Spec refresh adoption | CEO-aimp (owner) + CTO + CDO | THIS DOCUMENT, PROPOSED. Adoption needs co-owner review. |
| Independent evaluation of adoption | Independent Evaluation | CHARTER COMPLETE (Q12). Verdict awaits Independent Evaluation. |
| Migration of existing GitHub-login-scoped data (E*TRADE tokens, DO names) to internal IDs | CDO + CTO | OWED (Slice 1 remainder). |
| Whether #945 stays one epic issue or is split into slice issues | CEO-aimp + human owner | Epic stays open; slices filed per question (Q6–Q12 slice issues). |

## 9. Explicit non-goals for this spec

- No Auth0 tenant, application, secret, or callback is created.
- No production user, session, token, or permission is changed.
- No claim that social login establishes legal identity or a
  particular assurance level (#945 §2).
- No weakening of existing controls, no privilege expansion, no
  change to protected criteria, and no self-promotion of this spec
  (#945 §10).
- This refresh does not adopt the assurance review (stays DRAFT),
  does not adopt the Q7/Q8/Q9 proposals, does not edit
  `src/security/serviceIdentity.ts`, and does not claim agentic
  scheduler code (program #3121/#3122 is filed, not built).

## Appendix — Refresh record (#3152)

- Source: #945 comment 6630444615 (Q11 reconciliations).
- Verified against `main` @ `acea3a6` on 2026-11-04, file by file:
  identity/login/membership/PDP modules and tests, Google provider
  registration, delegation action-count-only status, `authTimeMs`
  stale-session rule, §6 test files listed in §6, service-user
  routes and `SERVICE_USER_LOGIN`, Auth0 mentions under `src/`
  (comments only, no runtime path).
- Corrections to loose wording in the #3152 issue body: the agentic
  scheduler has not "landed" as code — #3121/#3122 are filed program
  issues, and this document claims no scheduler implementation.
  Likewise, "admin counts" and "dispatch enforcement" are live code
  (cited in §2/§7), while Q6–Q10 answers are record-complete with
  the implementation items §7 lists as remaining.
- The D-5 table in `docs/architecture/security/iaaa-decisions-1757.md`
  is updated by its owning lane from comment 6630444615, not by this
  refresh.
