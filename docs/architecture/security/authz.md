# Authorization — the PDP, roles, memberships, and delegation

How cfagent decides whether an authenticated caller may do something. Who
the caller is (authentication) is in [authn.md](authn.md); the end-to-end
picture is in [security-workflow.md](security-workflow.md).

## 1. Default deny, always

Authorization is Slice 3 (`src/security/authorization.ts`): `authorize()`
is default-deny. Nothing is permitted unless a rule grants it. A grant
requires `role:assign` in scope, every binding is checked with
`canGrantRole` before any write, and `grantedBy` is always overwritten
with the granter — a caller cannot launder provenance.

There are 18 permissions: the 17 of spec §5 plus `ledger:record`
(#5450, GAP-2 — recording a ledger row). The full list lives in the module;
the ones that appear at enforcement points in this folder include
`integration:connect` (link an integration) and `role:assign` (grant roles).

## 2. Roles and the tenant-admin trap

## 2. RBAC: roles, scopes, and grants

Authorization is role-based access control. A membership carries
**role bindings**; each binding names a role, a scope, and optionally a
workspace or resource; bindings may expire. `authorize()` grants a
permission only when an active, unrevoked binding grants it **and** the
scope, tenant, and resource checks pass on top. The role table is the
whole model — there are no ad-hoc permission checks outside it:

| Role | Grants (within scope) | Scope notes |
| --- | --- | --- |
| `platform-admin` | `role:assign`, `audit:read`, `audit:export` — only these three | Platform scope only; this set **never** grants tenant permissions. Platform scope is a hard boundary: only a platform-admin binding at platform scope grants, whatever tenant roles the actor holds |
| `tenant-admin` | All 18 permissions | Tenant scope; cannot grant platform privileges |
| `workspace-admin` | All 18 permissions | Workspace scope (binding's `workspaceId`) |
| `member` | `task:create`, `task:read`, `task:cancel`, `artifact:read`, `artifact:edit`, `artifact:export`, `action:propose` | Propose, never approve or execute |
| `approver` | `action:approve` | One permission: approve what others propose |
| `auditor` | `task:read`, `artifact:read`, `audit:read` | Read-only, including audit |

The 18 permissions are: `membership:invite`, `membership:revoke`,
`role:assign`, `task:create`, `task:read`, `task:cancel`,
`artifact:read`, `artifact:edit`, `artifact:export`,
`integration:connect`, `integration:use`, `integration:manage`,
`action:propose`, `action:approve`, `action:execute`, `audit:read`,
`audit:export`, `ledger:record`.

Grant rules (`canGrantRole`, enforced for every binding before any
write): a platform target (platform-admin role or platform scope)
requires a platform-admin granter, full stop; tenant-scope grants
require a tenant admin; workspace-scope grants are confined to the
binding's workspace. A denied binding denies the whole grant atomically,
and `grantedBy` is always overwritten with the granter.

Two consequences worth stating plainly. First, **platform-admin is not
omnipotent**: it is the only role that can grant platform privileges,
but it holds only three permissions at platform scope, while
tenant-admin and workspace-admin hold all eighteen inside their
scopes. "Highest privilege" means "can grant across the boundary", not
"can do everything". Second, **revocation is a permission too**:
`membership:revoke` is in the table, but the revocation *actions*
themselves (session logout, E*TRADE revoke, key delete) are deliberately
ungated safety actions (§7) — the permission governs who may revoke
*others*, never whether you may revoke your own.

- **Platform admin:** the highest privilege; granted only through the
  genesis window below, or by an existing platform admin.
- **Tenant admin:** holds **all** permissions, including
  `integration:connect` — but tenant admins **cannot grant platform
  privileges**. That boundary is the point: a tenant admin is powerful
  inside a tenant and powerless to escalate out of it.
- **Membership** is per (user, tenant, role), stored in the Kv
  MembershipStore (`src/security/iaaaMembershipStore.ts`):
  `iaaa-membership:<id>` records plus a `iaaa-membership:user:<userId>`
  index. The store fails closed on index-write failure, and corrupt
  records throw instead of being silently overwritten. There is **no
  list-all API**: the admin overview reads the caller's own memberships
  only, which is why the panel can never leak another user's roles.

### The system-principal binding (GAP-3, #5459; CISO coordination #5349)

Workflow-internal actors — scheduled runs, payment-workflow steps,
service-to-service calls that act without a signed-in user — hold
authority through the same table, not a parallel gate. The story:

- The system principal is `service:<login>`, derived only through
  `serviceUserInternalUserId` (`src/security/serviceIdentity.ts`).
  The `system:` strings (`system:bootstrap`, `system:auto-provision`)
  stay provenance-only markers on grants — never principals, never
  evaluated. The principal's agent-world id is `agent:service:<login>`
  (`agentIdForServiceLogin`, `src/security/agentAccess.ts`), derived
  from the same login; neither derivation is ever duplicated.
- The binding that carries a permission for the system actor is a
  tenant-scope binding whose role grants it under the table above —
  for `ledger:record`, a tenant-admin binding in the tenant whose
  ledger is written — provisioned through the existing general grant
  path (`grantMembership` + `canGrantRole`). The member-only
  service-user provisioning route is untouched: a member binding
  carries no money permission, and no grant rule is invented to
  change that. The binding shape is a CISO review question on the
  GAP-3 PR; the story as built follows the existing table.
- Evaluation is `authorize()` at tenant scope, through the single
  consultation `authorizeSystemPrincipal`
  (`src/security/serviceDispatch.ts`): configured login, principal
  id, PDP decision. An unconfigured or malformed login does not
  resolve; a missing, revoked, or expired binding denies at the
  next check (0 ms revocation semantics, §9). No policy change, no
  new store, no new identity scheme.
- The #2331 invariants stand: a platform-admin binding for the
  service id grants nothing at tenant scope (the PDP ignores
  platform bindings there) and is surfaced as an anomaly on the
  consultation result so the consuming gate audits it; the flag
  does not override a PDP allow from a legitimate tenant binding.
  Brokerage-attached work never runs under the service identity.
- G-AUD-3 threading is advanced for this actor class, not closed:
  the PDP decision carries `principalId` `service:<login>` and the
  consultation threads the login, so the consuming gate's audit row
  is login-attributable. In-process `system` callers with login
  null remain open — see the #1763 audit doc. This slice wires no
  gate: the ledger gate that consumes the story is a later slice,
  and the G-1 hole stays open until it lands (ADR 0034 D2, owner's
  choice).

## 3. Bootstrap and the genesis window

Bootstrap (`src/security/iaaaBootstrap.ts`) provisions the first admins
from `IAAA_BOOTSTRAP_ADMINS`, parsed strictly:

- Bare entries must be UUIDs. A pasted GitHub login is **rejected** with a
  reason (logins are renameable and recyclable — see
  [authn.md](authn.md)).
- Provider entries split at the **last** colon.
- Blank or unset means zero entries, zero error, no fallback.
- Grants are tenant-admin only, for a caller-supplied tenant; an empty
  tenant refuses everything. `createdBy` / `grantedBy` are
  `system:bootstrap`.

The genesis rule: entries prefixed `platform:` grant platform-admin
**only while** the marker key
`iaaa-bootstrap:platform-genesis:<tenantId>` is absent. Once the marker
is set, later `platform:` entries grant tenant-admin only. Genesis grants
use `system:bootstrap-genesis`. The marker is claimed atomically
(#1756): on backends offering `KvLike.putIfAbsent` (production:
the SessionStore DO's atomic consume op) exactly one first-login
wins and the loser grants tenant-admin only; backends without it
keep the legacy check-then-set order and must serialize their
first logins. Bootstrap fires on wired login
when the caller is listed and holds no membership yet; a blank list means
zero writes.

## 4. Tenant resolution

The tenant for a request is `IAAA_TENANT_ID` if set, otherwise the
documented single-tenant default `"primary"`. Multi-tenant deployments
must set the variable; the underlying modules always take the tenant
explicitly, so a missing variable can never silently resolve to another
tenant's data. Underlying detail (defaults, gated set, and the exact
enforcement points) is in
[iaaa-github-end-to-end-defaults.md](iaaa-github-end-to-end-defaults.md).

## 5. Delegation

Delegation (`src/security/delegation.ts`, Slice 4) is an intersection,
not a union: effective authority = initiator ∩ tenant ∩ resource ∩
delegation ∩ approval. Delegations expire and carry action budgets. A
delegate can never exceed what the initiator, the tenant, the resource,
and the approval each independently allow.

## 6. Where enforcement actually happens

| Enforcement point | Gate | Denial behavior |
| --- | --- | --- |
| E*TRADE link start + verifier | `integration:connect`, PDP on + wired session, or PDP on + legacy session past its §8 grace bound | 403, action not performed; grace-expired legacy denials carry code `legacy_pdp_grace_expired` |
| Public link start + token connect | `integration:connect`, same PDP rule as the E*TRADE gates | 403, action not performed; grace-expired legacy denials carry code `legacy_pdp_grace_expired` |
| API-key mint | Step-up (fresh authentication), not PDP | 403 for stale and legacy sessions until re-login |
| `GET /api/iaaa/overview` | PDP platform-scope check (`role:assign`, seam A) + wired session, server-side, always enforced | 401 no session; 403 legacy session; 403 wired non-admin with no data; 500 generic on corrupt store |
| Platform-admin surfaces (tenant queues, KV wipe, user admin, service-user admin, lifecycle platform ops, SecHub policy/PDP/PEP/PIP views, telemetry mutations, reconcile routes) | PDP platform-scope check (`role:assign`, seam A) + wired session, always enforced | 401 no session; 403 wired non-admin with no data |
| IAAA admin panel | Same gate, client-side | Shows "not an admin" on 403 |

## 7. Deliberately ungated — and why

"Ungated" in this section has always meant "not PDP-gated" (or, for
the revocations, "not step-up-gated") — NOT "reachable without any
authentication". The precise gate for each surface is in the
gate-coverage inventory
([gate-coverage-inventory-1754.md](gate-coverage-inventory-1754.md)),
audited surface-by-surface for #1754; the summary below states the
gate, not just the exemption, so the shorthand cannot be misread.

- **E*TRADE revoke and API-key deletion.** Session-gated; NOT
  PDP-gated (revoke) / NOT step-up-gated (key deletion; minting IS
  step-up-gated). Revocation is a safety action; gating it would let
  the policy it escapes from block the escape. A stale session can
  still kill its own keys, and deletion is scoped to the session's
  own keys.
- **`/trade/approve`.** Session-gated at the edge AND a downstream
  Durable Object human-in-the-loop gate owns the decision (the draft
  must exist, still be `previewed`, and match the preview).
- **The generic `/api/*` forwarder and schedule-goal mutations.**
  Session-gated, not PDP-gated; the forwarder is instance-scoped to
  the caller (see [api-security.md](api-security.md)). Membership /
  admin revocation does not deny forwarder routes (§9 residual).

### Gate-coverage inventory (#1754)

Every Worker route was inventoried against current main and given
exactly one status — gated, deliberately ungated with reason, or
gap closed — with no route left "unknown". Full table (branch,
gate, evidence):
[gate-coverage-inventory-1754.md](gate-coverage-inventory-1754.md).

- **PDP-gated:** the `integration:connect` / `action:approve` /
  `task:create` gates (§6) and the platform-admin surfaces, whose
  gates consult the PDP at platform scope through seam A (GAP-1,
  CISO coordination #5350). Session-gated routes outside §6 never
  consult the PDP.
- **Session-gated:** the bulk of the API (schedule dashboard,
  social, governance/jobs/retention/audit/reports, API keys, MCP
  transport, wallet, premium, omnichannel, browser, forwarder,
  Agents SDK routing, OpenAPI/docs, clear/reset).
- **Session + admin / grant-gated:** access-request family
  (`canGrantRole`). The overview, telemetry mutations, retention
  purge, seed-halt, reconcile routes, and canonical seeding
  consult the PDP at platform scope (seam A) — see §6.
- **Signature / token / payment-gated:** NLQ webhooks (HMAC +
  replay nonce), Slack webhooks (signing secret, 503 when
  unconfigured), payment webhooks (provider HMAC), email approval
  links (signed token, verified twice), A2A dispatch
  (`A2A_API_TOKEN` Bearer, 503 when unset), scanner
  `screen_options` (x402 payment).
- **Public by design:** landing page, A2A agent cards, strategy
  pages and static assets, health, OAuth metadata document, CORS
  preflights, login/OAuth entry points, logout, market quotes
  (recorded #1725 M10 decision), sandbox demo page.
- **Gaps closed by #1754 (were ungated with no recorded
  decision):** `POST /api/qa/investigate` (now session OR the
  dedicated `QA_INVESTIGATE_TOKEN` service token, fail-closed when
  unset — deliberately NOT the A2A token), `POST /api/memory/search`
  (now session-gated), `GET|ANY /api/options/flows/*` (now
  session-gated). Proving tests:
  `tests/iaaa_gate_coverage_1754.test.ts`.
- **F-44 verdict:** NOT a verified live bypass. `iaaaGates.ts`
  holds two predicates, not middleware — no route is "wrapped"
  with it, so no route can bypass it; every route's gate is named
  in the inventory. The token-cache race is mitigated by #1218
  epochs (60 s positive-TTL residual); the derived-identity
  collision risk is designed out (SHA-256 over issuer + subject).
  See the inventory §7 for the full reasoning, and §9 below for
  the scanner shared-instance and quotes-quota residuals.

## 8. Legacy sessions and the bounded exemption (#1749)

Legacy (pre-wiring) sessions carry no internal id, so no tenant
membership can be resolved for them — and denying them outright
would lock out every session created before wiring. Their PDP
exemption is therefore BOUNDED, not open-ended: a legacy session
is PDP-exempt only while it is inside its absolute session
lifetime (createdAt + `SESSION_TTL`, 7 days; `isLegacyPdpGraceExpired`
in `src/security/iaaaGithubEndToEnd.ts`, enforced through the
single choke point `shouldEnforcePdp` that every gated route
already calls). Inside the bound it takes the pre-change path at
the `integration:connect` gates (§6). Past the bound it is
PDP-enforced and denied there (403, code
`legacy_pdp_grace_expired`) until it re-logs in through wiring
and becomes wired — that re-login is the migration path, not a
lockout cliff: ungated routes are unaffected, and login itself
is never PDP-gated. A legacy session with no provable createdAt
cannot prove it is inside its bound and fails closed.
The bound is not configurable at any scope: it reuses
`SESSION_TTL`, so no caller can widen, narrow, or disable their
own enforcement. The SessionStore record already expires at the
same deadline, so the gate is explicit policy plus defense in
depth, not the only thing standing between a stale record and a
gate. This is a migration property with a deadline, not a
permanent second class of privilege — but while any inside-bound
legacy session exists, the PDP is not universal, and audits must
say so (see §10).

## 9. Open decisions (owner, not defaults)

Step-up/idle thresholds are settled as CISO values by #1757 (see the
decision record, `iaaa-decisions-1757.md`): the 15-minute step-up window
and the 30-minute idle window are the enforced platform defaults, adopted
as CISO values with no change to enforcement. The owner overrode the
idle window to 8 hours on 2026-10-29; it and every other session window live
in `config/session-limits.json` (`SESSION_IDLE_TIMEOUT_MS` remains an optional
runtime override). Audit retention and tamper
response are undecided and carried (see the same record). A failed audit
write does **not** block a wired login on the live path — recorded as
deliberately non-blocking by #1757, with its risk stated in the record;
the consequential-action blocking set itself is carried to #945 Slice 5
adoption (Q7). See the #945 open list.

### Revocation-propagation targets (#1750)

Revocation propagation HAS numeric targets now (they replace the
previous observed-property-only wording). The single source of truth
is `src/security/revocationTargets.ts` — frozen constants, not
configuration: no env var, session value, run value, or user value
can widen, narrow, or disable them, because a caller-extendable
revocation grace would let a caller disable their own enforcement.
Every number below reuses a value the system already enforces; this
slice invents no new threshold.

Measurement (all rows): the clock starts when the revoking write
COMPLETES (the store put/delete returns), and ends at the first gate
check at or after that moment. A bound of 0 means the very next gate
check denies. For token-expiry there is no revoking write: the clock
starts at the deadline, and a gate check at or after the deadline
must deny (0 ms past the deadline).

| Trigger | Target | Gate |
| --- | --- | --- |
| Membership / grant revocation | 0 ms — next PDP check denies | PDP check (`checkRoutePermission` / `authorize`) on PDP-enforced routes. The PDP reads the membership store fresh on every check; no membership cache sits between store and PDP. Binding expiry is exact the same way: a binding denies at the first check at or after its `expiresAtMs`. |
| Session revocation | 0 ms same-isolate; ≤ 60,000 ms every isolate | Session gate (`requireAuth`). The logout path invalidates the isolate cache before deleting the record, so its own next read denies. Any other isolate serves its stale cached copy until the 60-second isolate-cache TTL lapses, then re-reads the store and denies. A wired session is denied immediately on every isolate: the wired validation path fresh-reads and denies on a missing record even when a cached copy exists, so the 60 s tier never applies to it. |
| API-key deletion | 0 ms — next verification denies | API-key verification (`verifyApiKey`) at the MCP transport. Verification reads the key store fresh (hash lookup, then record read) with no cache layer. API keys carry no expiry; deletion is the only key-revocation trigger. |
| Admin removal | 0 ms — next admin-gate check denies | Admin gates (GET `/api/iaaa/overview` gate, PDP, grant gate), all fresh membership reads. Admin removal IS membership revocation applied to an admin binding, so it shares the membership mechanism and bound. |
| Token expiry | 0 ms past the deadline | Session gate (wired validation) and OIDC claim validation. Absolute session expiry: first wired gate check at or after `createdAt + SESSION_TTL` (7 days; `createdAt` slides on authenticated page navigation when 2 days remain, capped at 30 days from `firstCreatedAt`) denies. Idle expiry: first wired gate check at or after recorded last-activity + the configured idle window (8 hours in `config/session-limits.json`) denies. OIDC claims: a claim with `exp` at or before now denies on presentation. The idle and step-up windows are settled CISO values (#1757); these targets reuse the enforced defaults. |

Proving tests: `tests/iaaa_revocation_targets_1750.test.ts` (one
group per trigger, revoke-then-gate at the bound) and
`tests/iaaa_revocation_session_cache_1750.test.ts` (the 60-second
isolate-cache interaction: same-isolate invalidation, cross-isolate
TTL expiry at exactly 60,000 ms, and the honest stale-serve window
inside the TTL).

### Residual gaps — NOT covered by the targets above

These are named here, with their own follow-ups, not folded into a
passing target:

- **Legacy sessions inside the §8 bound are PDP-exempt.** For them,
  membership revocation and admin removal do NOT deny at the
  integration gates until the §8 bound expires (at most 7 days from
  session creation, then 403 `legacy_pdp_grace_expired`) or the
  session re-logs in through wiring. The 0 ms membership/admin
  targets bind PDP-enforced sessions only.
- **The PDP is not a universal gate.** Session-gated-only routes
  (the generic `/api/*` forwarder, schedule-goal mutations) and the
  §7 deliberately ungated routes never consult memberships, so
  membership/admin revocation does not deny those routes at all.
  Gate coverage is #1754's audit (scan F-06), not this slice.
- **Sessions the store cannot see cannot be revoked by id.**
  Closed by #1758: the SessionStore DO list op now covers the
  sessions namespace and the IAAA lifecycle routes offboard
  through the session registry (iaaaSessionRegistry.ts), so bulk
  revocation discovers a principal's sessions instead of requiring
  caller-supplied ids. The remaining edge is a legacy session
  whose login was transferred to a different person after the
  session was created (see the slice doc for the bound).
- **Admin removal does not terminate the removed admin's session.**
  The removed admin stays authenticated for session-gated routes
  until session revocation or expiry; only admin gates deny
  immediately. That is the mechanism as designed (revocation is a
  permission), stated here so it is not mistaken for session
  revocation.
- **API keys have no expiry.** A key lives until deleted. Deletion
  is immediate (0 ms), but there is no rotation or expiry bound,
  and none is invented here.
- **Idle expiry is exact against RECORDED activity, not true
  activity.** Recorded activity lags true activity by up to 60 s
  (touch precision: touches persist at most every 60 s), and a
  session with no recorded activity at all (legacy / Phase 1) is
  idle-exempt by contract — its only expiry bound is the absolute
  deadline. Neither slack is hidden inside a looser gate bound.

## 10. XACML mapping — conceptual, not conformant

This section names the XACML roles this system already plays. It is a
mapping, not a claim of conformance: cfagent implements no XACML policy
language, no XACML request/response protocol, and no standalone XACML
engine. The vocabulary is useful because it separates four jobs that are
easy to conflate in code — who writes policy, who decides, who
enforces, and who supplies attributes. Where the code does not cleanly
separate them, this section says so.

| XACML concept | cfagent equivalent (verified on main) |
| --- | --- |
| PAP — Policy Administration Point: authors and manages policy | Three places, in decreasing order of permanence. (1) The policy itself, as code: the `ROLE_GRANTS` table in `src/security/authorization.ts` (with `PERMISSIONS` and `AUTHORIZATION_POLICY_VERSION = "iaaa-authorization-2"`). Changing a grant means changing this table and shipping it — there is no policy editor. Its portable form is the `PolicySnapshot` (`src/security/pdpPorts.ts`: `exportPolicySnapshot()` / validated `parsePolicySnapshot()`), served through the `PolicyProvider` port; the compiled tables are the default provider, and the only alternative source is a platform-configured snapshot (`IAAA_PDP_POLICY_SOURCE` = `snapshot` + `IAAA_PDP_POLICY_SNAPSHOT_JSON`, platform-only, invalid fails closed to compiled — see `docs/architecture/security/iaaa-pdp-architecture-1755.md`). (2) Bootstrap provisioning: `IAAA_BOOTSTRAP_ADMINS` parsing in `src/security/iaaaBootstrap.ts`, which seeds the first grants (§3). (3) Runtime grants: the IAAA admin panel (`src/client/IaaaAdminPanel.tsx`, "Access requests" section) driving `POST /api/iaaa/access-request/decision`, which calls `grantMembership` (`src/security/iaaaMembershipStore.ts`) under `canGrantRole` enforcement (`src/security/authorization.ts`). |
| PDP — Policy Decision Point: evaluates a request against policy | The PDP core is `authorizeWithPolicy()` in `src/security/authorization.ts`: policy from a `PolicyProvider`, attributes only through the PIP port, answering allow or deny for a subject, permission, and scope. `authorize()` is its back-compatible entry point (compiled policy + store adapted to the PIP), reached through the seam `checkPermission()` in `src/security/iaaaPdpSeam.ts`. The port is `PolicyDecisionPoint` in `src/security/pdpPorts.ts`, with a JSON-serializable request/response contract; the only live adapter is the in-process one. The PDP performs no enforcement and no side effects. |
| PEP — Policy Enforcement Point: enforces the PDP's answer at the boundary | Several, one per surface — there is no single runtime gateway, by decision (#1755). (1) `requireAuth()` in `src/server.ts`: the session gate, which rejects unauthenticated callers before any permission is evaluated. (2) The four `integration:connect` gates (E*TRADE start, E*TRADE verifier, Public start, Public connect routes in `src/server.ts`) share one gateway pattern: `evaluateRoutePep()` in `src/security/pepGateway.ts`, which centralizes the `shouldEnforcePdp` check, the PDP decision through the port, and the grace mapping (403 on deny; see §6). It enforces for wired sessions and for legacy sessions past their §8 grace bound, and exempts only legacy sessions inside the bound; a grace-expired legacy denial carries code `legacy_pdp_grace_expired`. (3) The `canGrantRole` checks on the access-request decision route in `src/server.ts`. (4) The `requireAuth` gate at the top of the `/api/schedule/` block in `src/server.ts` (401 before the ScheduledAgent stub is reached). A PEP that cannot reach the PDP denies: a missing session, a legacy session past its grace bound (no internal id to evaluate), or an unresolvable tenant all fail closed. The one documented exception is a legacy session inside its grace bound (§8), which takes the pre-change path at the `integration:connect` gates. |
| PIP — Policy Information Point: supplies the attributes the PDP reads | The `AttributeProvider` port in `src/security/authorization.ts` (`getMembershipsByUser`): the PDP reads attributes only through it, never through a store directly. The live attribute source is the SessionStore Durable Object, adapted to the port (`membershipStoreToAttributeProvider`): memberships under `iaaa-membership:` keys (`src/security/iaaaMembershipStore.ts`), identity bindings under `iaaa-binding:` keys (`src/security/iaaaLogin.ts`), migration aliases under `iaaa-alias:` keys (`src/security/iaaaMigration.ts`), and sessions via `sessionStore(env)`. The tenant attribute defaults to `"primary"` (`IAAA_DEFAULT_TENANT_ID` in `src/security/iaaaGithubEndToEnd.ts`; see §4). No federation, transformation, or caching layer exists yet — the port is where one lands. |
| Context Handler — assembles the request the PDP evaluates | The `CheckPermissionInput` in `src/security/iaaaPdpSeam.ts`: subject = `internalUserId` (the derived `v1:` identity, never a login handle or email), resource = `tenantId` plus `scope` / `resourceScope`, action = `permission`, environment = `nowMs` plus caller-side facts the PDP does not itself fetch — session validity (established by `requireAuth` before the call), step-up freshness (`DEFAULT_STEP_UP_FRESHNESS_MS` in `src/security/sessionPolicy.ts`), and the `IAAA_PDP_ENABLED` flag (callers check `shouldEnforcePdp` before calling; the PDP seam itself does not read flags). |
| Obligations / Advice — things that must or should happen alongside the decision | Built (#1751): obligations and advice attach to policy in the frozen `OBLIGATION_POLICY` table (`src/security/obligations.ts`) and are enforced by the PEP-side evaluator `evaluateWithObligations()`, which wraps the PDP seam. Step-up-as-obligation and audit-before-allow (audit as a condition, not a record) are demonstrated for `role:assign`, `membership:revoke`, and `audit:export`; policy advice accompanies allow and deny alike and never changes a decision. Everything fails closed: a missing/stale authentication, a missing audit writer, a failed or throwing audit write, or an unknown obligation kind all deny. The pre-#1751 equivalents remain as the record below (audit-on-decision; ad-hoc per-gate step-up at API-key mint) until CTO-lane #945 route wiring adopts the evaluator route by route — see the residual list under §10 below. |

### Combining rule

Default-deny, with deny-overrides. The PDP permits only when an active,
unrevoked binding grants the permission **and** the scope, tenant, and
resource checks pass (§1, §2). Unknown permissions, missing
memberships, revoked memberships, cross-tenant requests, and
scope/resource mismatches all deny. For grants, the rule is atomic: a
single denied binding denies the whole grant, and nothing is partially
written (§2). There is no permit-overrides path anywhere in the system,
and no rule ordering to configure — the combining behavior is
hardcoded, not policy.

### Honest gaps — what this mapping is not

- **Policy is TypeScript tables, not portable XACML — partially
  closed (#1755).** The tables stay authoritative and are not
  XACML, and policy versioning is still the single string constant
  (`iaaa-authorization-2`), carried on the snapshot — not a policy
  set with versioning semantics. What changed: the tables now have
  a portable JSON form (`PolicySnapshot`: version + permissions +
  role grants) with a validated parse and a `PolicyProvider` store
  interface, so policy can be exported, inspected, and loaded
  through the port. What is still not true: there is no policy
  editor, and no XACML implementation can evaluate the snapshot.
- **The PDP is an in-process library, not a service — stands, by
  decision (#1755).** There is still no network boundary between
  PEP and PDP, no PDP endpoint, and no independent PDP deployment;
  a bug in the PDP ships with the Worker. What changed: the PDP now
  has a logical service boundary — the `PolicyDecisionPoint` port
  with a JSON-serializable request/response contract — so a future
  network PDP is a new adapter behind the same port, not a rewrite.
- **There is no attribute service — closed at the seam (#1755).**
  The `AttributeProvider` (PIP) port is real: the PDP core reads
  memberships only through it, and `authorize()` / `canGrantRole()`
  are thin adapters over it, so no PDP code path reads a store
  directly anymore. What is still not true: the only live attribute
  source is the SessionStore membership store — attributes are not
  yet federated, transformed, or cached by a PIP layer; what the
  store holds is still what the decision sees.
- **There is no single runtime gateway — stands, by decision
  (#1755).** Surfaces keep their own PEPs (session gate, schedule
  gate, access-request gate unchanged); the consolidation is the
  shared `evaluateRoutePep()` pattern at the four
  `integration:connect` sites, not one gateway all surfaces funnel
  through.
- **Obligations/advice are policy-declared but not yet route-wired
  (#1751).** The channel exists and is enforced by its evaluator
  (`src/security/obligations.ts`, proving tests
  `tests/iaaa_obligations_1751.test.ts`): obligations attach to the
  permission in the frozen `OBLIGATION_POLICY` table, not to per-gate
  code. What is NOT yet true: no live route calls the evaluator,
  so the ad-hoc gates (per-gate step-up at API-key mint, audit-on-
  decision elsewhere) still do the live enforcing until CTO-lane
  #945 route wiring adopts the evaluator route by route, each
  adopting route supplying its session's `authTimeMs` and its audit
  sink. Until that wiring lands, "the PDP decided, obligations
  enforced" describes the evaluator's decisions, not every live
  route's. The old gates were not removed by #1751, so nothing live
  regressed in the meantime.
- **The obligation table is frozen, not configurable — by design.**
  No env var, session value, run value, or user value can widen,
  narrow, or disable an obligation, because a caller-configurable
  obligation would let a caller disable their own enforcement. The
  step-up window is the reused platform default (15 minutes, settled
  as a CISO value by #1757, enforcement unchanged). Scope-
  qualified obligations (different obligations per scope for the
  same permission) are not in v1 and are not invented here.
- **The PDP is not the only gate.** Legacy sessions inside their
  grace bound are PDP-exempt (§8), deliberately ungated routes
  exist (§7), and the `/trade/approve` decision belongs to a
  downstream Durable Object gate. While any inside-bound legacy
  session exists, "the PDP decided" is not a complete description
  of how a request was authorized, and audits should say so.

Until those gaps close, describe this system as XACML-*inspired*: the
separation of PAP / PDP / PEP / PIP is real and load-bearing, but
conformance is not claimed and must not be implied to reviewers,
auditors, or users.
