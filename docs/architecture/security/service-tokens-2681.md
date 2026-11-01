# Service tokens (`svc_token`) — issue #2681

A service token is a credential **for** a provisioned service identity,
not a replacement for provisioning. It authenticates non-interactive
callers (automation, other agents) as the service identity
(`SERVICE_USER_LOGIN`, e.g. `svc-background`) against the platform API.
Companion to [service-identity.md](service-identity.md) (the identity
itself) and [authz.md](authz.md) (the PDP and role model). The
provisioning surface for #2171 (agent access management) consumes this
mechanism; #2171's full agent-access model is separate scope.

## What it is not

- Not an API key (`cfk_`): API keys authenticate a *user* to `/mcp`
  and carry no expiry. Service tokens authenticate the *service
  identity* to `/api/*`, always expire, and are always tier-bound.
- Not `QA_INVESTIGATE_TOKEN`: a single operator secret for one route,
  plaintext-compared, not per-token, not revocable per token. Service
  tokens are individually provisioned, hashed, revocable, and
  expirable. The two credentials are never aliased.
- Not `A2A_API_TOKEN`: agent-dispatch mesh credentials, env-compared,
  no per-credential metadata. Service tokens carry metadata (label,
  tier, tenant, roles, expiry, revocation) in the SessionStore.
- Not a brokerage credential: a token never resolves, renews, or
  presents any user's (or the service identity's) E*TRADE token.

## Mechanism (`src/security/serviceTokens.ts`)

- **Format:** `svc_` + 32 random bytes (base64url). Only the SHA-256
  hash is stored (SessionStore bucket `service_tokens`, keys
  `token:<id>`, `hash:<sha256>`, `subject:<serviceId>`, `index:all`).
  The plaintext secret is returned exactly once, in the mint/rotate
  response; list responses carry metadata only.
- **Tier binding:** every token is minted for exactly one tier.
  Platform tier has no tenant; tenant tier requires a tenant id, and
  verification requires the server-resolved tenant to equal it
  (never a request header). Cross-tenant use denies and is audited.
- **Roles:** roles come from the 6-role catalog. Mint enforces one
  `canGrantRole` check per role, so a granter who cannot grant a
  role cannot mint a token carrying it — no token is ever
  self-granted. `workspace-admin` is refused on tokens (no workspace
  binding exists for them). Platform-scope non-admin roles grant
  nothing through the PDP (platform scope only honors
  `platform-admin`) — that is the policy, not a gap in the token.
- **Expiry:** required at mint. There are no immortal service tokens.
  The UX prefills 90 days; the API accepts any future expiry.
- **Rotation:** mints a new secret for the same record (same id,
  roles, tier, tenant) and deletes the old hash index, so the old
  secret denies on its very next use. The new secret is shown once.
- **Revocation:** deletes the hash index (0 ms: the next verify
  denies) and marks the record revoked; the record is kept so the
  admin list still shows it. Revoking the service identity's
  memberships implicitly invalidates its tokens, because verify
  re-reads memberships fresh on every use.
- **Mint gating:** platform-admin, wired session only (the
  `serviceUser.ts` `resolveCaller` gate). Tenant-tier mint
  additionally requires tenant-admin in that tenant (via
  `canGrantRole`: a platform-admin without it gets a grant denial).
  Minting for an unprovisioned service identity fails closed.
  Service-token callers can never mint, rotate, or revoke tokens
  (explicit `x-principal-kind` guard, plus the service login has no
  wired alias so `resolveCaller` would 403 them anyway).

## Use (v1 consumer)

The catch-all `/api/` forwarder in `src/server.ts` tries the session
first, then a `svc_` Bearer token. A verified token forwards as
`x-user-login` = the service login with `x-principal-kind:
service-token`, addressed to the service login's instance. Special-branch
forwarders (schedules, options, voice, MCP) stay session-only in v1;
a token caller reaching them gets 401, not a silent fallback.

Per-route PDP enforcement for token callers lands with #945 route
wiring (the same residual as obligations #1751, which are built but
not route-wired). What v1 ships and tests is the seam:
`authorizeServiceToken` evaluates a token's roles through the real
PDP (`authorize()`) over an in-memory store built from the token
record, with `CROSS_TENANT` denied before the PDP. Existing admin
gates already deny token callers where they must: admin DO routes
resolve the service id to member, not admin, under
`isPlatformAdmin`, and the token-admin routes are session-only.
One fail-closed guard closes the remaining hole: the MCP permission
gate maps `x-principal-kind: service-token` to `unknown`
(deny-all scopes) instead of the legacy session default, so a token
caller reaching an MCP-backed DO route cannot inherit session scope
before #945 wiring adopts the PDP seam.

## Audit

| Event | Channel | Failure behavior |
| --- | --- | --- |
| `service_token.minted` / `.rotated` / `.revoked` | Orchestrator funnel (`mas_events`) | Funnel failure surfaces as the route's 500 path, same as service-user routes — no success is reported unaudited |
| `service_token.denied` (Worker-side verify failure) | IAAA chain, best-effort + warn | Decision is already deny; an audit-store failure never converts it into an allow |
| Successful use | `lastUsedAtMs` stamp only | Per-use audit events would exhaust the #1760 22,000-event cap; use volume is a timestamp, not an event stream |

Denied verifies are indistinguishable to the caller (malformed,
unknown, expired, revoked, unprovisioned, and cross-tenant all read
as 401). The presented secret and its hash are never logged or
audited; audit records carry the token id/prefix only.

## Shared role model (consumed by #2688)

There is ONE role model, and this issue does not create a second one:

- **Catalog:** `Role` + `ALL_ROLES` in `src/security/authorization.ts`
  (platform-admin, tenant-admin, workspace-admin, member, approver,
  auditor). Service-token mint validates every requested role against
  `ALL_ROLES`; the mint form's checkbox list
  (`SERVICE_TOKEN_ROLE_OPTIONS` in `src/client/serviceTokensApi.ts`) is
  a presentation of that catalog minus workspace-admin, never an
  enforcement point.
- **Gates:** `canGrantRole()` (same PDP, same membership store) for
  every grant decision, and `authorize()` for every permission check.
  Human role grants (#2688) consume the same catalog and the same
  gates: a platform admin grants platform-admin or tenant-admin; a
  tenant admin grants tenant-admin within their own tenant only; a
  tenant admin can never grant platform admin or touch another tenant.
- **No default admin:** admin comes only from a live, unrevoked
  membership binding (`isPlatformAdmin` reads bindings, never IdP
  claims). A fresh login via any provider (#2686) holds no admin role
  until explicitly granted — the token mint gate inherits this: an
  unprovisioned caller cannot mint, and a caller cannot mint a token
  for itself as the service user.
- **Route-level self-check (pattern #2688 reuses):** `canGrantRole`
  itself does not compare granter to target — it denies grants the
  granter has no right to make, which already blocks self-escalation
  into scopes the granter does not hold. The explicit
  "granter ≠ target" refusal lives at the route, as the token mint
  route does (403 when the caller is the service user itself). #2688's
  grant endpoint must keep its own route-level self-grant refusal;
  that rule is not a second role system, it is the same gate plus one
  comparison.
- **Shared invariants on both surfaces:** default-deny, no
  self-grant, tenant-scoped, audited, immediate revocation (a revoked
  binding denies on the next check, 0 ms, because verification reads
  the store fresh).

## Provisioning UX

IAAA Admin → Overview → Service tokens (beside Service user, same
gate, no new tab, no duplicated panel). Mint form: label, scope
(platform|tenant), tenant id (tenant scope), roles (catalog
checkboxes), expiry in days (prefilled 90). List shows metadata only;
Rotate (with new expiry) and Revoke (with confirm) act per token;
the fresh secret shows once with copy + lost-means-replace copy.
Every button calls a real endpoint (`src/client/serviceTokensApi.ts`
via `apiFetch`).

## Orchestrator address migration (same issue)

The live shared-orchestrator address is `shared_orchestrator`
(`SHARED_ORCHESTRATOR_INSTANCE`). The legacy address survives only
as `LEGACY_SHARED_ORCHESTRATOR_INSTANCE` in
`src/security/serviceIdentity.ts` (migration source + deny guard for
in-flight queued messages naming it). Migration routes
(`src/agents/routes/orchestratorMigration.ts`, platform-admin only,
early `onRequest` branch so POSTs never async-queue):

1. `POST /admin/orchestrator-migration/migrate {"sourceAddress":
   "default_trader"}` on any instance — the driver pulls from the
   source instance and imports into the target (new-address) instance.
2. Export covers: SDK schedules, `paused_schedules`, all KV keys,
   and every user SQL table discovered via `sqlite_master`
   (excluding `sqlite_*`, `cf_agents_*` queue internals, and
   `cf_ai_*` chat session). In-flight `mas_async_jobs` rows
   (queued/running) are NOT copied — they drain on the source
   instance. Schedule re-arming uses fingerprint dedupe
   (callback + payload + cadence), so re-runs never double-arm;
   SDK ids do not survive a copy.
3. The driver verifies counts, writes receipt key
   `orchestrator-migration:receipt:<sourceAddress>` on the target,
   and audits `orchestrator_migration.completed`.
4. Order: copy → verify → flip the constant (deploy) → soak. The
   source instance is never deleted (no delete API exists); after
   the flip it receives no new work.

## Residuals (named, not hidden)

- Per-route PDP enforcement for token callers: #945 route wiring
  (see above).
- The legacy address string remains in exactly one src constant
  (migration source + deny guard) and in historical docs describing
  the pre-#1185 removal. Historical records stay as history; only
  live-behavior statements were updated.
- The old instance's pre-flip `mas_*` history that was not copied
  (SDK tables, chat session) stays on the source instance and is
  reachable only through another migration run.
