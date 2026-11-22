# IAAA admin UI — read-only v1 (issue #945)

> Update (#1758): the read-only limitation below described v1.
> The panel has since gained a Members tab (grant / revoke /
> membership-edit) plus self-deactivation on the Overview tab,
> backed by the routes in `docs/architecture/security/iaaa-lifecycle-wiring-1758.md`.
> The overview builder itself (`buildAdminOverview`) stays
> read-only; the audit/catalog tabs stay read-only. Access-request
> approve/deny (#1274) predates #1758.

## Agent #ceo-aimp

## What the panel shows

The **IAAA Admin** section (in the settings menu, next to API Keys)
renders `GET /api/iaaa/overview`:

- **Tenant** — the resolved tenant (`IAAA_TENANT_ID` else the
  documented default `"primary"`, same resolution as the GitHub
  end-to-end slice).
- **Your roles** — the caller's own role bindings (e.g.
  `platform-admin (platform)`).
- **Platform genesis** — whether the platform-genesis marker key
  exists for the tenant (i.e. a genesis grant has happened).
- **Recent audit events** — the tenant's audit events, newest
  first, capped at 100, showing time, action, decision, outcome,
  and correlation id.

## The gating rule (server-side, never client-side only)

The route is fail-closed:

- No session → `401`.
- Legacy session (no `internalUserId`) → `403`, no data.
- Wired session without a live platform-admin membership
  (role `platform-admin`, scope `platform`, not revoked, not
  expired) → `403`, no data.
- Wired session with a live platform-admin membership → `200`.

The client only renders what the server returns; on `403` it
shows a plain "not an admin" state and fetches nothing else.

## Read-only limitation

v1 cannot change anything: there is no grant, revoke, or
membership-edit UI, and no mutation endpoint exists behind the
panel. The server route is `GET`-only and the builder performs
no store write.

## Trust assumption

A caller who passes the gate **is** a platform admin, so
tenant-level audit data for the resolved tenant is shown to
them. Audit events are filtered to the resolved tenant — other
tenants' events are never returned by this route.

## Store limitations (why the panel shows what it shows)

- `MembershipStore` has no list-all API (`getMembershipsByUser`
  only), so v1 shows the **caller's own** memberships, not every
  user's. Cross-user listing needs a new store capability.
- The audit store is a single tenant-mixed log read in full
  and filtered in memory; acceptable at auth-event volume, and
  now bounded: since #1760 the wired store appends atomically
  through the SessionStore DO's `audit-append` op, the live key
  rotates into archive segments, and the whole store caps at
  22,000 events (failing visible instead of deleting evidence).
  New audit consumers append through that bounded backend and
  must not list-and-filter per request; this overview route
  stays an admin-only read (capped at 100 newest), not a
  per-request path.
- A corrupt membership/audit read answers `500` with a generic
  error and no partial data (the stores refuse to overwrite
  corrupt evidence).

## v2: tabbed endpoint/event explorer (read-only, same gate)

The Overview tab is the v1 content, unchanged. Four more tabs render
static code knowledge from `src/client/iaaaEndpointCatalog.ts` — no new
server route, no fetch beyond the v1 overview call:

- **API**: every route branch in `src/server.ts` (method, path, aliases,
  edge gating). The generic `/api/*` forwarder is a catch-all row, not an
  endpoint. A test pins the catalog against the route-branch path
  literals in `server.ts`, so a new route branch without a catalog entry
  fails; method/auth drift on an existing branch is still a manual
  review item (documented residual gap in the test).
- **MCP**: the existing `MCP_TOOLS_CATALOG` / `MCP_RESOURCES_CATALOG` /
  `MCP_PROMPTS_CATALOG` from `src/client/mcpEndpointsData.ts`, reused —
  plus a gaps list of server capabilities the catalog lacks (scanner
  tools and other command classes), reported, never invented.
- **IAAA**: the audit-event taxonomy (builders plus live emitters) and
  the explicit gaps list of IAAA occurrences that emit no audit event.
  Since #1760, bootstrap grants, alias recording, the genesis marker,
  and legacy-session logout-audit skips DO emit (see
  [audit-store-bounded-backend-1760.md](audit-store-bounded-backend-1760.md));
  the remaining explicitly-decided silences are PDP denials, step-up
  denials, and idle-expiry rejection, each with a recorded trigger.
- **Correlations**: endpoint-to-MCP-tool rows (transport for every
  catalog tool, one shares-source row for the audit store, UNMAPPED rows
  for tools with no worker HTTP handler) and event-to-endpoint rows
  (emits rows plus UNMAPPED gap rows).

Styling uses the shared `Tabs` primitive and semantic `--color-*`
tokens only; the v2 change also fixed a v1 CSS literal (an `rgba()`
border) that failed the token ratchet, so the ratchet is green.

## How to extend it (mutations later)

1. Add a mutation endpoint per action (grant/revoke) behind the
   same platform-admin gate, enforcing Slice 3's `canGrantRole`
   rule server-side (a tenant admin must never grant platform
   privileges).
2. Add a list-all memberships capability to the store first —
   do not scan key prefixes from the route.
3. Keep the read path and the write path in separate modules so
   the read-only guarantee of this panel stays reviewable.
4. Add client controls only after the server endpoints exist
   and are tested with the same gating matrix as v1.

## One admin-creation path (#6165)

Inventory (verified in code 2026-11-22) and the consolidation
decision. One of everything: an operator creates a platform-admin
or tenant-admin from exactly one UX surface, and the bootstrap
list changes through exactly one proposal flow.

**The one grant path — Members tab.** `POST
/api/iaaa/membership/grant` (`grantMembershipApi`), minting
through the single `grantMembership` seam
(`src/security/authorization.ts`). It grants any role (member,
approver, auditor, workspace-admin, tenant-admin,
platform-admin), any scope, multi-binding — and sits beside
revoke, edit, and the memberships table. Q9 two-admin rule and
the SELF_GRANT 403 stay.

**Retired grant surfaces (deprecated, never deleted).**
`POST /api/iaaa/role-grants/grant` and `POST
/api/iaaa/role-grants/revoke` are deprecated aliases of the
membership-grant route: they mint through the same seam, so
behavior is unchanged. The Role grants section (Overview) keeps
only its read-only admin-role list and points at the Members
tab. Client `grantRoleGrant` / `revokeRoleGrant`
(`src/client/roleGrantsApi.ts`) are `@deprecated` and frozen.
Ledger: `docs/architecture/transition/deprecations.md`
(#6165 entry).

**The one bootstrap path.** `IAAA_BOOTSTRAP_ADMINS` env list →
login-path provisioning (`runWiredPostLogin` in
`src/security/iaaaGithubEndToEnd.ts`: listed ids get
tenant-admin at sign-in; `platform:` entries claim genesis →
platform-admin via the atomic marker) + the data-lifecycle
bootstrap routes as the operator surface (platform bootstrap
check/init claims genesis for a `platform:` caller;
tenant-bootstrap initializes a tenant, including its founding
tenant-admin via the same `provisionBootstrapAdmins`). The list
changes through exactly one proposal flow: Bootstrap proposals
(#3077). Security split, unchanged: the env list never mints
platform-admin; platform-admin comes only from an existing
platform-admin or the one-time genesis claim.

**Not a second grant path — access requests (#1274).** A user
requests access; admins approve/deny. Approval mints through the
same `grantMembership` seam under the same two-approver rule. A
request is an entry point to the one grant mechanism, not a
parallel creation path.
