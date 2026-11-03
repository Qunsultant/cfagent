# Human role grants (`platform-admin` / `tenant-admin`) — issue #2688

The human-user counterpart to the #2681 service-token role
assignment. Both surfaces share ONE role model and the same
authorization gates; this surface does not create a second one.

## Shared role model (same as #2681)

- **Catalog:** `Role` + `ALL_ROLES` in
  `src/security/authorization.ts` (platform-admin, tenant-admin,
  workspace-admin, member, approver, auditor). This surface may
  assign exactly two of them: `ROLE_GRANT_ROLES` in
  `src/security/roleGrants.ts` is `ALL_ROLES` filtered to
  platform-admin and tenant-admin — computed, never re-declared.
  The grant form's role list
  (`ROLE_GRANT_ROLE_OPTIONS` in `src/client/roleGrantsApi.ts`) is
  a presentation of that filter, never an enforcement point: the
  server validates every request against `ALL_ROLES` first, then
  against the filter.
- **Gates:** `canGrantRole()` for every grant decision and for
  every revoke decision (revoke mirrors grant — only a granter
  who could grant the role, in that scope and tenant, may revoke
  it), and `authorize()` for every permission check, all over the
  Kv MembershipStore, read fresh (revocation denies on the next
  check, 0 ms).
- **No default admin:** admin comes only from a live, unrevoked
  membership binding (`isPlatformAdmin` reads bindings, never IdP
  claims). A fresh login via any provider (#2686) holds no admin
  role until explicitly granted.
- **Self-grant (route-level, as in #2681):** `canGrantRole`
  itself does not compare granter to target — it denies grants
  the granter has no right to make, which already blocks
  self-escalation into scopes the granter does not hold. The
  explicit "granter ≠ target" refusal lives at the grant route
  (`SELF_GRANT`, 403), as the token mint route does. Self-revoke
  is NOT refused: removing one's own privilege is de-escalation,
  never escalation, and it is audited like any other revoke.

## What this surface adds over the #1758 Members tab

The Members tab already grants/revokes whole memberships for any
role. This surface is narrower and deeper, not a duplicate:

- **Admin-only, per binding:** the list flattens one row per
  admin binding, showing who granted it (`grantedBy`) and when
  (the membership's `createdAtMs`) — the Members tab shows
  neither.
- **Per-binding revoke:** revoking one admin role preserves
  sibling bindings on the same membership. Removing the last
  binding revokes the membership record itself, so a revoked
  empty record — not a live empty one — is what remains.
- **Tenant-admin reachability:** the IAAA panel's Overview gate
  is platform-admin, so tenant-admins could previously call the
  membership routes but never reach a grant UI. The role-grants
  endpoints admit tenant-admins in their own tenant, and the
  panel renders a limited tenant-admin view (Role grants only)
  when the overview gate refuses but the role-grants list
  succeeds. Overview data, Service tokens, and Service user state
  stay platform-gated server-side; the limited view exposes
  nothing else.

## Grant semantics — including the platform-admin limit

- **Default-deny.** No admin role until granted. The IdP used to
  sign in never implies any role.
- **Platform-admin:** platform-wide, granted only by an existing
  platform admin.
- **Tenant-admin:** scoped to exactly one tenant. Granted by a
  tenant admin of that tenant — and, critically, NOT by a bare
  platform admin. Slice 3 policy is not a tenant superuser: a
  platform-admin's membership grants nothing in a tenant, so
  `canGrantRole` denies a platform-admin-only granter a
  tenant-admin grant. A tenant-admin grant requires the granter
  to hold `role:assign` in that tenant: a tenant-admin of that
  tenant, or a platform-admin who also holds tenant-admin there.
  The issue body's "granted by a platform admin" shorthand does
  not override the PDP, and this slice does not widen it. A
  tenant admin cannot administer other tenants, cannot grant
  platform admin, and cannot touch platform settings.
- **Tenant isolation:** a tenant admin's list shows tenant-scope
  grants in their own tenant only (platform-scope grants are
  platform state and are not listed to them); cross-tenant grant
  and revoke attempts deny and are audited.
- **Audit:** grants and revokes go through the #1751 obligation
  channel (step-up + audit-before-allow for `role:assign`,
  audit-before-allow for `membership:revoke`, with the
  documented platform-scope audit-before-revoke exception for
  platform grants, as in the membership revoke route). Denied
  grant, revoke, and list attempts are recorded as deny audit
  events (best-effort — a failed audit write never converts a
  deny into an allow). Every audit record carries grantor,
  grantee, role, tenant, and timestamp.
- **Immediate effect, including revocation:** a revoked admin's
  next admin call is denied, because every check re-reads the
  store fresh. Re-granting a held binding is a no-op
  (`alreadyGranted`), never a duplicate row.

## Endpoints (all session-wired; 401 unauthenticated, 403 legacy sessions)

- `GET /api/iaaa/role-grants` — list. Platform-admin: all
  tenants. Tenant-admin: own tenant, tenant-scope grants only.
  Each row carries `identity` (`issuer:subject` from the
  identity binding, or `null` when the user has no binding
  entry — never invented) and `email` (captured at grant time
  via #2661, or `null`). No user directory exists for display
  names: sessions carry display names ephemerally, so the list
  shows identity-or-internal-user-id, not a fabricated name.
- `POST /api/iaaa/role-grants/grant`
  `{"internalUserId", "role", "tenantId?", "email?"}` — 201 with
  the grant row; 400 for unknown/non-admin roles; 403
  `SELF_GRANT` for self-grants and 403 for non-granters.
- `POST /api/iaaa/role-grants/revoke`
  `{"membershipId", "bindingIndex"}` — 200 with `grantId`,
  `emptied`, `revoked`; 404 unknown membership; 400 for a
  non-admin binding index.

## UX

IAAA Admin → Overview → Role grants, beside Service tokens and
Service user (no new tab, tab indices unchanged, no duplicated
panel). Grant form: target internal user id, role
(platform-admin / tenant-admin), tenant id for tenant-admin
(blank = this tenant), optional grantee email. List shows
identity, role + scope + tenant, grantor + grant time, and
email when captured; revoked grants stay visible, marked
Revoked. Revoke is two-click confirm. Every button calls a real
endpoint; server refusals surface as errors. The UI enforces
nothing by itself: hiding a button is not enforcement.

## Bootstrap: the first platform admin (owner-controlled, never self-service)

- The first platform admin comes from owner-controlled bootstrap
  genesis: a `platform:` entry in `IAAA_BOOTSTRAP_ADMINS`,
  claimed exactly once via the genesis marker
  (`iaaaGithubEndToEnd.ts`, atomic `putIfAbsent` claim before
  the grant; the loser takes the genesis-closed path and gets
  tenant-admin only). After genesis, only an existing
  platform-admin grants platform-admin.
- Tenant-admin bootstrap is the ordinary `IAAA_BOOTSTRAP_ADMINS`
  path (`provisionBootstrapAdmins`, tenant-admin only, in a
  caller-supplied tenant). Admin signup is never open
  self-service on either path.

## Residuals (named, not hidden)

- Per-route PDP enforcement for service-token callers lands with
  #945 route wiring (the #2681 residual, unchanged by this
  slice — this slice's routes are session-wired, and token
  callers cannot reach them).
- Display names: no directory source exists, so the list shows
  `issuer:subject` or the internal user id. A display-name
  directory is separate work, not silently approximated here.
- The #1758 Members tab still grants/revokes whole memberships
  for any role; this surface does not replace it, and the two
  stay consistent because both enforce `canGrantRole` at the
  store call.
