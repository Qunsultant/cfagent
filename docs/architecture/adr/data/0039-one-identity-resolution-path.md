# 0039. One identity-resolution path: the verified session is the authoritative caller identity

- Status: accepted
- Date: 2026-11-23
- Deciders: owner (Mubasher)
- Issue: #6238 + #6259 (related: #6236, #6239, #6250)
- Implementing PR: (this PR)

## Context

The app contradicted itself about the owner (observed live
2026-11-23): the Summary tab showed the owner as tenant-admin
AND platform-admin, "2 platform admins", genesis completed,
while the Service user panel said the owner is NOT a platform
admin and its status cards never loaded; the Users view showed
only the revoked 10/22 grant while the Role grants list showed
both owner identities holding both roles, all active.

The two RCAs named the per-user membership index
(`iaaa-membership:user:<id>`) as the root cause and described
the divergence as a store difference: the PDP / auth routes use
`wiredMembershipStore` (the session-ports store) while the Users
view and the service-user route use `createKvMembershipStore`
directly. That description is not what the code does. Verified
on main: the session-ports membership store IS
`createKvMembershipStore(kv)`
(`src/data/sessionFamilyKvImpl.ts`, which delegates
`getMembershipsByUser` / `put` / `revokeMembership` to it), and
flag-off `wiredMembershipStore` IS
`createKvMembershipStore(sessionStore(env))` — the same
implementation over the same SessionStore DO keys in both flag
states. The divergence is the ID input, not the store:

- Summary / Overview: `GET /api/iaaa/overview` gates and reads
  through `buildAdminOverview` with
  `callerInternalUserId = session.internalUserId` — the id the
  live session carries.
- Service-user panel: `resolveCaller`
  (`src/agents/routes/serviceUser.ts`) resolved the caller from
  the `x-user-login` header through the wired-login alias
  (`lookupInternalUserIdByLogin`).
- Users view: `buildUserView`
  (`src/agents/routes/platformUsers.ts`) resolved the same way,
  from the login through the alias.

The alias can resolve to a retired id while the session carries
the derived id — #6236 states it plainly ("The login path and
the Users view therefore still resolve to revoked ids while the
session carries the derived id") — and the retired id's index
holds only the revoked 10/22 grant, because the newer grants
were written under the derived id. So the index read for the
alias id denies platform-admin (the one failing fetch is GET
`/api/admin/service-user/status` → 403, which the panel renders
as "not a platform admin" with `status` null, so the summary
cards and the provisioning checklist never render), while the
index read for the session id allows and the full-scan Role
grants / Members lists show everything.

Separately, the index itself is drift-prone by design: the
module header documents that a failed index write hides a grant
and that two concurrent puts can lose an entry. The owner's
index holding only the first grant is the data half of the same
family.

## Decision

### The verified session's internalUserId is the authoritative caller identity

Every caller gate and self-read resolves the caller from the
verified session first (`resolveActingSession` — the session
cookie, or the `session` test seam — the same id the IAAA
overview / auth routes gate on). Only when no session resolves
does the route fall back to the login→alias lookup. The alias
fallback preserves header-only callers; it is a fallback, not
a second path: it never overrides a resolved session. The
helper is exported from `serviceUser.ts` and reused by
`platformUsers.ts` rather than duplicated. Applied at:

- `resolveCaller` (`serviceUser.ts`) — the service-user panel
  gate and every route behind it (provision / revoke / status /
  tokens / broker-token).
- `resolveOperatorCaller` (`platformUsers.ts`) — the operator
  lookup gate.
- The Users view self-read (`buildUserView` "me") — the
  memberships are read for the session id; the login still
  drives the identity / account half.

The alias lookup remains the ONLY way to resolve a TARGET login
in the operator lookup (a target has no session) — that is a
different question (who is the target?), not a second caller
path.

### The index is repaired from the scan, and writes are verified

`repairMembershipIndexes`
(`src/security/iaaaMembershipStore.ts`) rebuilds every per-user
index from the record scan (`listMembershipsFromEntries`) — the
desired index for a user is exactly that user's membership ids,
revoked included (revocation is history, not a missing row).
Stale entries (no record key) are pruned; an index key for a
user with no memberships is deleted. It writes index keys only,
never membership records. Corruption stays loud: a corrupt
index value is left untouched and named, and an index entry
whose record key exists but is corrupt is kept, so the point
read still throws on it. The route is
`POST /api/iaaa/membership-index/repair` (GET is always a
dry-run report), platform-admin gated in the same block as the
#6236 stale-identities routes, mode from
`IAAA_MEMBERSHIP_INDEX_REPAIR_MODE` (explicit `execute` only,
else dry-run — the mode never comes from the request body),
audited as `iaaa.membership_index_repair`.

`put` verifies its index write (read-back) and retries the
read-modify-write up to three attempts; a failure that survives
all attempts throws loudly instead of returning success with a
stale index. The record write already landed in that case, so
the throw names the membership id and the repair pass
reconciles it.

## Consequences

- In production the session always resolves (the Worker
  forwards the cookie to the DO), so the service-user panel, the
  Users view self-read, and the Summary tab all gate and read on
  the same id: the panels agree, and the service-user status
  cards load (the 403 that blanked them is gone).
- Header-only callers (no resolvable session) keep exactly
  today's behavior through the alias fallback.
- The index can no longer drift silently: verified writes close
  the mechanism, and the repair route reconciles any index that
  predates the fix, through the application.
- A new route is registered in the server route inventory pin
  (`tests/server_route_inventory_2902.test.ts`) and one new
  `listSessionFamilyEntries` call site is pinned in the D-D
  census (`tests/global_dd_census_2356.test.ts`, 23 → 24).
- Residual, named not fixed: the operator lookup of a login
  whose alias still points at a retired id shows THAT id's
  memberships (correct for that id, still disagreeing with the
  full scan). The alias staleness itself is #6236's orphan
  domain (orphan alias rows are reported-only, never deleted
  without a forward pointer). The Members tab empty state is
  likewise not explained by index drift and is a live re-check
  (parent), filed as a second distinct defect if it reproduces.
  #6239 (bootstrap "Unresolved") is the same family but a
  separate issue.
- Live verification (owner step, after merge + deploy): fresh
  login; Summary and Service-user panels agree (owner is
  platform-admin AND tenant-admin, 2 platform admins, genesis
  completed); service-user status cards load; Users view shows
  all of the owner's grants, not only the revoked one. The
  repair itself is an owner step: POST
  `/api/iaaa/membership-index/repair` with
  `IAAA_MEMBERSHIP_INDEX_REPAIR_MODE=execute`.
