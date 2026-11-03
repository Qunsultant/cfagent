# Logged-in users admin surface (#2836)

Admin-only view of who is logged in, per-user login history, and
per-user session history with admin revocation. IAAA Admin →
Overview ("Logged-in users" section, beside Service tokens / Role
grants / Policy proposals; no new tab). Tenant admins reach the
same section through the panel's limited view, server-scoped to
their tenant.

## Endpoints

- `GET /api/iaaa/logged-in-users` — per-user rows: identity
  (`issuer:subject` plus display login), tenant(s), active
  sessions (created, last-seen, expiry, provider), recorded login
  count, first / most-recent / recent login times, first-seen
  time. Plus a `coverage` block stating the count's basis (below).
- `POST /api/iaaa/logged-in-users/revoke` — `{ sessionId }`.
  Deletes the session, invalidates the revoking isolate's session
  cache, and audits the revoke. Returns `audited: true/false`
  honestly: a failed audit write does not un-revoke and is not
  hidden.

## Sources (existing durable records only)

No second login record is invented by this slice:

- **Live sessions** (SessionStore `sessions` namespace, bare-UUID
  keys): the active-session list. "Active" means passing the
  policy expiry check — absolute 7d from `createdAt`, 30d
  lifetime cap from `firstCreatedAt`, idle window (live gate's
  `resolveIdleTimeoutMs`, 8h default) for sessions with recorded
  activity. The store listing alone is insufficient: its TTL
  enforces the absolute deadline only, so an idle-expired
  session can still list and is excluded here. Legacy sessions
  (no `internalUserId`, no recorded activity) are idle-exempt,
  per the Phase 2a contract.
- **Retained `auth.login` succeeded audit events** (actor =
  `internalUserId`, correlation = session id): the login count,
  first / most-recent login, and recent login times.
- **Login-alias records** (`iaaa-alias:user:`): first wired-login
  observation (`recordedAtMs`) and the verbatim display login.
  One observation, not a history — never updated by later logins.
- **Identity bindings** (`iaaa-binding:user:`): `issuer:subject`
  fallback when none of a user's sessions carries its own
  issuer/subject. The session's own identity always wins.
- **Memberships** (`iaaa-membership:`): tenant attribution.
  Sessions carry no tenant, so visibility comes from the user's
  active memberships (unrevoked + at least one unexpired binding).

## The count's honesty rule (read before quoting a number)

`loginCount` counts **retained `auth.login` succeeded audit
events only**. The audit store is bounded (22,000 events) and
login writes are best-effort, so logins outside the retained
window — or lost to a failed write — are absent and
unrecoverable from here. The response's `coverage` block states
this basis in the payload, and the panel renders the note with
the list, so no consumer can mistake the count for a lifetime
total. Failed logins never count, and `unknown`-actor events are
never attributed to a user. A user with sessions but no retained
events reports count `0` with null times, never zeros presented
as times.

**Carried follow-up (tied to #2808's login-trace kind):** a true
lifetime login count needs an unbounded login-event record.
That record is not built here and its absence is not estimated
around. When #2808 Phase 0 lands, verify this surface's login
sources against its login-trace finding; any mismatch becomes a
follow-up slice.

## Access control (enforced at the gates, not by the UI)

- Unauthenticated → 401. Legacy session (no `internalUserId`)
  → 403 (no identity to scope by).
- Platform admin → all tenants, all users, all login events,
  including legacy sessions.
- Tenant admin (the #2688 proxy: `canGrantRole` for
  tenant-admin in the resolved tenant) → only users with an
  active membership in their tenant, and only that tenant's
  login events. Legacy sessions are platform-only: with no
  tenant attribution, showing them to a tenant admin would leak
  across tenants, so they are withheld fail-closed.
- Non-admin denials (list and revoke) are audited best-effort
  (`iaaa.lifecycle`, action `logged_in_users.list` /
  `logged_in_users.revoke`, decision `deny`); a failed denial
  audit leaves the deny standing.
- Cross-tenant revoke attempts are denied and audited the same
  way. Unknown/inactive session ids answer 404, not a claimed
  revoke.
- A null listing (sessions, memberships, aliases, bindings) or
  a throwing audit read answers 500 with no partial data.

## Revocation bound (#1750 session-revocation target)

- 0 ms on the revoking isolate (cache invalidated before the
  response) and for wired sessions on fresh reads everywhere.
- At most the 60s isolate-cache TTL for an isolate holding a
  stale cached copy.
- The audit record carries the revoked session id as
  `correlationId` and the target user (or display login for
  legacy) as `resourceId`, with admin, tenant, and timestamp —
  the four fields the issue's audit requirement names.
- Revoking a session terminates that session only; it does not
  revoke the user's memberships, keys, or other sessions
  (offboarding owns the wider operation). An admin may revoke
  their own session; the next call then 401s, as expected.
- Revoke is audit-after-delete with a reported `audited` flag,
  not audit-before-allow: session revoke is outside #1751's
  fail-closed obligation set (role:assign, membership:revoke,
  audit:export), and widening that set is a separate decision.
  The flag keeps a failed audit write visible instead of
  silently unaudited.

## Privacy

Rows carry identity, tenant, times, counts, and status only.
No token, secret, credential, or raw payload field is read from
any record or returned by either endpoint. The UI renders
nothing beyond the payload.

## Implementation map

- Pure aggregation: `src/security/iaaaLoggedInUsers.ts`
  (parsing, expiry, aggregation, tenant scoping).
- Routes: `src/server.ts` (`/api/iaaa/logged-in-users`,
  `/api/iaaa/logged-in-users/revoke`, inside the IAAA guard
  block); catalogued in `src/client/iaaaEndpointCatalog.ts`.
- UI: `src/client/loggedInUsersApi.ts`,
  `src/client/LoggedInUsersPanel.tsx`,
  `src/client/loggedInUsersPanel.css`, mounted in
  `src/client/IaaaAdminPanel.tsx` (Overview + limited view).
- Tests: `tests/iaaa_logged_in_users_2836.test.ts` (module:
  parsing, expiry, scoping, count honesty),
  `tests/logged_in_users_panel_2836.test.tsx` (panel: list,
  revoke-with-confirm, refusal surfacing).

#CISO-bhdm
