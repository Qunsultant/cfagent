# CBO API layer design

- Status: Accepted (owner decisions recorded 2026-11-18)
- Date: 2026-11-18
- Owner: Mars; author lane #CBO-mlops
- Issue: #5343
- ADR: [ADR 0034](../adr/0034-cbo-api-layer.md) (the decision record; this
  doc is the full detail behind it)
- Design base: `origin/main` at `46b6537d6` (2026-11-18). All file:line
  citations were re-verified against this base unless marked otherwise.
- Amendment 2026-11-18 (same day, before any slice builds on this
  design): §14 records the owner one-server alignment directive (one
  API server #5387, one MCP server #5386, one security model, Workers +
  Docker portability). §§3/5/6/7/10/13 carry the conforming edits the
  amendment required; the original decisions stand except where §14
  explicitly supersedes part of them.
- Amendment 2026-11-18 (same day, before any slice builds on this
  design): §15 records the owner canonical-endpoints directive (one MCP
  server at `https://mcp.openaimp.com/mcp`, one API server at
  `https://api.openaimp.com/api`). §§1/7/8/10/12/13/14 carry the
  conforming edits the amendment required; the original decisions stand,
  and §15 fixes the hostnames the shared servers answer at plus the
  mechanics of getting there.
- Amendment 2026-11-18 (same day, before any slice builds on this
  design): §16 records the CLO coordination flag (parent-verified):
  CBO sequences around the CLO-owned data-model issues #5023 and its
  adjacent sub-issues #5037/#5038/#5040/#5041, building none of them.
  §§1/10/12/13/14 carry the conforming edits the amendment required;
  the original decisions stand.
- Inventory basis: the 2026-11-18 parity inventory, basis `cd094b6f`.
  Where the design base drifted from the inventory basis, the drift is
  noted at the citation (handler line count, lifecycle route lines).

## 1. Purpose and reading guide

This doc fixes the shape of the CBO API layer: one security model, one
catalog, one auth module, one validation helper, one OpenAPI artifact.
It specifies; the slices build. It changes no runtime behavior, no UX
surface, and no data.

Reading rules:

- Every rule in §9 is re-derived from a real source, cited by file and
  section. The parity inventory's §G rule citations to three ADRs and
  four standards files were verified wrong on 2026-11-18 (the ADRs are
  about other subjects; the standards files do not exist). No slice body
  repeats those citations, and this doc cites only sources it re-verified
  from the files.
- Versions in §3 are the evaluated baseline of 2026-11-18. Each slice
  re-verifies the latest at build time and records the pinned version.
- §7 carries a REQUIRED, UNPERFORMED dashboard check with a STOP rule.
  It was not performed by the design author (no dashboard access) and
  must not be read as verified.
- §14 carries the one-server alignment: the CBO layer is the commercial
  surface ON the one shared API/MCP servers (#5387/#5386). No CBO slice
  builds a second server, router, registry, auth chain, or validation
  layer.
- §15 fixes the canonical endpoints the shared servers answer at
  (`https://mcp.openaimp.com/mcp`, `https://api.openaimp.com/api`), the
  transport, the path-collapse mechanics, the CORS/origin policy, and
  the routing prerequisites — including a REQUIRED, UNPERFORMED DNS /
  custom-domain dashboard check with a STOP rule (§15.5).
- §16 records the CLO coordination: CBO sequences around the CLO-owned
  data-model issues (#5023 + #5037/#5038/#5040/#5041), building none
  of them. The slice-start re-check for in-flight CLO work is a
  standing requirement on every slice builder (§10).
- §12 records exactly what was verified and what was not. Nothing in
  this doc claims a live, runtime, or signed-in verification.

The problem, in one paragraph: the CBO commercial/platform HTTP surface
(150 routes inventoried 2026-11-18) grew slice by slice with no designed
API layer — a hand-rolled dispatcher, a path-only catalog covering only
the commercial family, authorization gates re-implemented per file, no
shared request validation, no shared schemas, and one 9,043-line handler
mixing routes, services, and store access. The inventory ranked 15 gaps
(G-1–G-15); §10 sequences their fixes. The most consequential, G-1, is an
ungated ledger write surface (see §2.5 and §10, slice 1).

## 2. Security model inventory (verified 2026-11-18)

One DESIGNED model (IAAA) with STAGED, incomplete enforcement. There is
no single enforced model today; this design does not claim otherwise.
The API layer WIRES the existing IAAA modules into live enforcement for
CBO routes. It does NOT redesign authorization and does NOT add
handler-gate N+1. Missing pieces are CISO-owned (#945 follow-ups #5348 /
#5349 / #5350); CBO slices build no CISO-owned enforcement.

### 2.1 Identity (live)

- IAAA Slice 1: `(issuer, subject)` maps to a stable internal user id
  (`src/security/identityBinding.ts`); sessions carry `internalUserId`
  (`docs/architecture/security/authn.md`).
- The dispatcher mints `x-user-login` ONLY from the verified session
  (`src/server/routes/platform.ts:472–479`: `requireAuth`, then the
  header set from `session.githubLogin`; caller-supplied headers are
  overwritten). Handlers trust `x-user-login` because the dispatcher is
  the single minting point. The standard going forward — caller-supplied
  identity headers are stripped unless validated — is stated in
  `docs/architecture/code/09-api-standards.md` J3 and in
  `docs/architecture/security/api-security.md` §1–§2 (dispatch order is a
  security property; a future framework adapter must preserve the order
  exactly).
- `SERVICE_USER_LOGIN` via `getServiceUserLogin`
  (`src/security/serviceIdentity.ts`, #1185) is documented for
  UNATTENDED work only (background execution, session-less entry
  points), fail-closed when unconfigured. The service login must be a
  dedicated non-user value, never a real user's login.
- Per-user API keys, `cfk_` prefix (`src/security/apiKeys.ts:32`).

### 2.2 APIs (ad-hoc today)

- Dispatcher session gate + PER-FILE handler checks (operator list env
  UNION store, own-or-operator) re-implemented per route file. The gates
  `commercialLogin` / `isStoreOperator` / `canAccessAccount` exist only
  as closures in `src/agents/routes/agenticPayments.ts:841/875/907`
  while `platformAccounts.ts`, `platformChannels.ts`,
  `platformTenants.ts`, `platformUsers.ts`, `dlq.ts`, and
  `dataLifecycle.ts` each re-implement the operator check.
- `authorize()` in `src/security/authorization.ts` is PURE POLICY,
  deliberately NOT live enforcement, called by NO route handler. The PDP
  enforces only `integration:connect` at the gates named in
  `docs/architecture/security/authz.md` §6; session-gated routes never
  consult it. The 17 permissions in `PERMISSIONS`
  (`authorization.ts:62–80`) include NO money/ledger/commercial
  permission. The PDP seam (`src/security/iaaaPdpSeam.ts:51`,
  `checkPermission`) wraps the policy via `authorizeWithPolicy`; the PEP
  gateway is `src/security/pepGateway.ts` (#1755).
- The service user holds member bindings only (provisioned via
  `src/agents/routes/serviceUser.ts`, #2331 slice 1, `service:<login>`
  internal id) and carries NO PDP permission at platform scope —
  `authorize()` grants platform-scope permissions only to platform-admin
  bindings, so a PDP check would deny every legitimate platform dispatch
  (`src/security/serviceDispatch.ts` header, #2331 slice 2).
- The live enforcement for service actors is `enforceServiceDispatch`
  (`src/security/serviceDispatch.ts`, #2331 slice 2; live callers
  `src/agents/orchestrator/asyncJobs.ts:2079` and
  `src/agents/orchestrator/scheduledCallbacks.ts:116`): service-ness by
  equality with the configured login, PLUS a live platform-scope MEMBER
  binding for the service id (a membership check, deliberately not
  `authorize()`); a platform-admin binding for the service id is an
  anomaly, denied and audited; the tenant tier adds a PDP `task:create`
  check. The same-file `lifecycleDigestRunDue` gate
  (`agenticPayments.ts:8949`, service-identity-only) is an OUTLIER — one
  route whose caller is the 30-minute digest cron tick — not the pattern;
  the pattern is `serviceDispatch`.
- Never trust client-supplied `tenantId`/`userId` for scoping (owner
  correction 2026-10-29, session-scoping rule): scope always derives
  from the verified session identity, resolved server-side; client-supplied
  tenant/user values are untrusted input, never identity. The standing
  violation is the lifecycle preference GET/POST
  (`agenticPayments.ts:8761–8815`; inventory basis cited 8688–8730):
  they check `canAccessAccount(login, userId)` only while the
  client-supplied `tenantId` is used as the store key unverified.
  Low-sensitivity data (digest/welcome preferences), real
  tenant-isolation violation. Fixed by slice 2 (§10).

### 2.3 MCPs (ADR 0012, accepted)

Port-first permissions: six scopes (`mcp:read/write/execute/trade/
payments/admin`, `src/mcps/openaimp/mcpPermissionPorts.ts:96–101`), one
scope per tool, `executeWithPermissionGate` authorizes before execution.
DEFAULTS ARE PERMISSIVE: system/session/api-key/agent-turn principals
hold every scope (`defaultScopesForKind`, `mcpPermissionPorts.ts:448`);
the IAAA role-to-scope adapter is an explicitly FUTURE seam
(`mcpPermissionPorts.ts:508`). Scanner-payment holds only `mcp:payments`;
unknown holds nothing. Every MCP tool carries exactly one scope,
completeness-pinned (`docs/architecture/code/05-security-and-tenancy.md`
E6).

### 2.4 Agents

- `src/security/agentAccess.ts` (#2171): permission-bearing grants
  decided through the PDP seam (`createAgentPdpChecker` over
  `src/security/iaaaPdpSeam.ts`); delegations re-checked at every
  invocation; obligations opt-in; audit-as-condition. The service-login
  to agent-id mapping is `agentIdForServiceLogin`
  (`agentAccess.ts:222`).
- `ExecutionContext` (`src/security/executionContext.ts:74`, #1078) is
  the ONE validated context contract across APIs/jobs/agents/tools (PDP
  decision embedded, frozen, revalidated at boundaries, delegation
  narrows-never-widens) — live wiring DELIBERATELY STAGED.
- G-AUD-3 (system-principal login threading) is explicitly NOT closed
  (`docs/architecture/security/tool-attribution-audit-1763.md` G-AUD-3;
  `docs/architecture/security/agent-access-2171.md` R4); `system:` actors
  exist only as provenance strings (e.g. `system:bootstrap` in
  `authz.md` §3).

### 2.5 The G-1 hole, stated plainly

The three ledger write-through routes (`POST .../ledger/record`,
`record-cfpay`, `record-native`, `agenticPayments.ts:508–763`) contain no
handler authorization check and trust body `userId`/`tenantId`/`priceUSD`.
Re-verified on the design base: the range contains no gate reference of
any kind. Any signed-in user can post ledger rows naming another user.
The dispatcher blocks anonymous callers only.

Owner decision (2026-11-18): fix it fully and holistically, NO interim
solution. No dispatch-gate interim ships, ever. The G-1 hole stays open
until the full IAAA-conformant fix lands (slice 1, §10, sequenced after
GAP-1–GAP-5). That is the owner's explicit choice.

### 2.6 Design direction (binding)

Each CBO slice wires the existing IAAA modules above into enforcement
for its routes (PDP seam / `ExecutionContext` / permission ports as the
route's surface requires) instead of adding another hand-rolled handler
gate. The shared auth-module slice consolidates the per-file gates onto
the existing modules; it does not invent a new gate.

REJECTED (owner): any route-to-role registry, any new auth scheme, any
API-key layer for CBO routes, any parallel gate. The inventory's
"genuinely new" registry item is DROPPED — replaced by extending the
existing `commercialUrlCatalog`.

## 3. FOSS-first decisions (owner decisions 2026-11-18)

SELECTION RULE (binding): best-fit FOSS first for EVERY layer/component;
custom code ONLY where no best-fit FOSS piece exists, with the gap
documented here. GUARDRAIL (unchanged): an EXISTING working repo
capability always wins over both FOSS-new and custom-new (IAAA
identity/PDP, MCP SDK, zod, Drizzle, OpenTelemetry, CDO adapters) — a
FOSS piece that DUPLICATES an existing repo capability is OUT. FOSS
replaces custom-new solutions; it never replaces working modules and
never becomes a second implementation. No auth framework, no sidecar
gateway.

Baseline verified from `package.json` on the design base: 27
dependencies. PRESENT: `zod` ^4.1.8, `@modelcontextprotocol/sdk` 1.32.2,
`@modelcontextprotocol/server` 2.4.0, `drizzle-orm` ^0.45.4, `agents`
0.32.0, `@opentelemetry/*` (api, context-async-hooks, otlp-transformer,
sdk-logs, sdk-metrics, sdk-trace). ABSENT: `hono`, `itty-router`,
`jose`, `@cloudflare/workers-oauth-provider`. No router dependency
exists today; dispatch is sequential if-chains + the path catalog.

### 3.1 Decision table

| Layer | Chosen piece + version | Why best-fit | Rejected alternative | Custom-code justification |
|---|---|---|---|---|
| Routing | Hono 4.13.19 (MIT, 2026-11-16; ~7.9 KB gzip) — DECIDED by owner ("use hono fully": routing + middleware + ecosystem, not a shim) | Web-standards framework built for Workers; middleware + OpenAPI ecosystem; tiny bundle; actively maintained | itty-router (settled by the owner decision; minimal, no middleware/OpenAPI ecosystem depth); hand-rolled dispatch (replaced by the migration); Hono v5 (5.0.0-rc.1 — REJECTED, pre-release; re-evaluate at GA) | None — FOSS wins. Handlers stay portable behind the gateway port (no Hono imports in handler logic). |
| Validation | zod ^4.1.8 (ALREADY a dependency) + `@hono/zod-validator` 0.9.1 (MIT; requires hono >=4.11.2, zod ^4.2.1 — slice checks the peer fit; a zod minor bump may be needed) | zod is already imported across `src/`; the validator is the official Hono integration | Hand-rolled validators (replaced by the G-4 slice); zod without Hono integration (duplicates the middleware) | None — reuse wins. The G-4 slice extends the existing validators onto zod schemas. |
| Tokens / JWT | jose 6.2.17 (MIT, 2026-11-09; zero deps, tree-shakeable ESM, Workers-listed) behind the token-verification port | Full JOSE (JWS/JWE/JWK/JWT/JWKS), production-grade, Workers-safe, actively maintained; algorithm-pinned verification | Hono's built-in JWT middleware (REJECTED as the verifier: reported algorithm-confusion history, CVE-2026-22817/22818, fixed 4.11.4+; minimal JOSE coverage; Hono-coupled). A thin Hono middleware calls the port; jose verifies. | None — FOSS wins. One verification implementation (the port adapter). |
| OAuth 2.1 provider | OPEN SURVEY EVALUATION — no piece named (amendment 2026-11-18, §14): the portable provider must be runtime-agnostic, keep its store behind the existing port/adapter pattern, and cover OAuth 2.1 + OIDC, PAR/RAR/DPoP per the §6 matrix. `@cloudflare/workers-oauth-provider` v1.2.4 (MIT; requires KV namespace `OAUTH_KV`; reported caveats: KV eventual-consistency — double code exchange under concurrency, revocation not final; 1.2.0 broke some clients) was EVALUATED and is OUT for the shared-server role (Workers-only + KV-bound — violates the portability rule, §14). | Only for the "being an OAuth provider" role (issuing tokens to third-party/MCP clients). External OAuth access is OUT of the API-layer program's scope; issuance is a future surface (own issue + the owner's call). The validation side (RFC 9728) is defined now. | Any Workers-only or store-coupled OAuth server library (violates the portability rule); building an AS by hand (rejected — FOSS-first when the surface is approved) | None. Issuance deferred; no custom AS code; no provider library named or adopted before the survey concludes. |
| OpenAPI generation | chanfana 3.4.0 (MIT, Cloudflare; Zod v4, OpenAPI 3/3.1, `fromHono` wrapper; production-proven on the Radar 2.0 public API) | Cloudflare-maintained, Workers-first; `fromHono` extends the existing app WITHOUT touching old routes (strangler fit); generates the ONE spec artifact from the zod schemas | `@hono/zod-openapi` 1.6.3 (Hono-native; requires the OpenAPIHono app shape wholesale; less incremental for the strangler migration); hand-written OpenAPI (duplicates the zod schemas — rejected) | None — FOSS wins. The generator feeds the ONE spec artifact (the `openapiSpec.ts` spike extension), never a second spec. |
| Logging / telemetry | EXISTING wins: OpenTelemetry SDKs (already dependencies) + module logger seam (`src/observability/structuredLogger.ts`, #3515) + outcome catalog | Working capability present; a FOSS logging library would duplicate it | Any new FOSS log formatting/transport library (duplicates the working seam — OUT) | None — existing wins. |
| Coded errors / messages | EXISTING wins: outcome catalog (`src/outcomes/outcomeCatalog.json` + `outcomeAspects.ts`) + `codedOutcomeResponse` (the coded-message AOP aspect) | The aspect pattern + mechanism already exist and are the design's rule | Any FOSS error-format library (duplicates the aspect — OUT) | None — existing wins. The aspect pattern stays; slices extend the catalog. |
| Rate limiting / throttling | Edge (API Shield free tier: 1 rule — coarse protection) + EXISTING in-Worker ingress throttle (`src/api/ingress.ts` + `src/config/apiIngressModes.ts`) | Working in-Worker mechanism exists; edge rule complements it | Any new FOSS rate-limit middleware (duplicates the working throttle — OUT unless the slice proves a gap: per-route/per-tenant needs the ingress mechanism cannot cover, evaluated at slice time against Hono middleware with the gap documented) | None — existing wins; gap evaluation deferred to the slice with criteria stated. |
| Idempotency | EXISTING patterns win for current paths (ledger dedupe-safe writes; job/turn dedupe present — slice verifies); a SHARED idempotency-key layer is EVALUATED at slice time | No verified shared idempotency-key layer exists; per-subsystem dedupe is working | FOSS idempotency-key middleware (evaluated at slice time against the DO/D1 store shape; adopted only if it fits behind the existing ports, else custom-behind-ports wins with the gap documented) | Deferred: custom-behind-ports ONLY if no FOSS piece fits the store shape; gap documented in the slice. |
| Audit | EXISTING wins: audit funnel (`ctx.audit`, orchestrator funnel) + obligations (`src/security/obligations.ts`, audit-as-condition) | Working capability present | Any FOSS audit library (duplicates the funnel — OUT) | None — existing wins. |
| Identity / authorization | EXISTING wins: IAAA (identityBinding, authorization/PDP, memberships, ExecutionContext, agentAccess) — enhanced by the GAP slices, never replaced | The designed model; FOSS identity would duplicate it | Any auth framework (better-auth, Clerk, Auth0 — OUT, duplicates IAAA) | None — existing wins; gaps closed by enhancement (GAP-1–GAP-5). |
| Data access | EXISTING wins: CDO ports/adapters (ADR 0002, Drizzle D1 + in-memory adapters, catalogues, migration runner) | The binding data approach | Any other ORM/query builder (duplicates the CDO foundation — OUT) | None — existing wins. |
| Edge gateway | Cloudflare API Shield schema validation, FREE tier (see §7) — DECIDED by owner, with ports/adapters, as an OPTIONAL edge adapter only (§14): the server is fully functional without it | Managed edge schema validation; config-as-code via API/Terraform in CI/CD | Sidecar gateways (Kong, Envoy, Tyk, APISIX, KrakenD — OUT: separate services, duplicate the Worker edge, wrong fit) | None — managed service + config-as-code; no gateway logic in handlers; never a required dependency. |

Architecture point: ports/adapters is the REPO'S OWN pattern (ADR 0002)
— the gateway is a port in `src/` with Worker + in-memory adapters;
FOSS libraries plug in BEHIND the port. No library supplies
"ports/adapters for Cloudflare."

## 4. Hono migration sequence

The framework CHOICE is settled by the owner decision; the repo-wide
adapter design stays #1024's (CEO lane).

- H-0 (dependency): #1024 Phase 2 adapter design (CEO lane). The CBO
  Hono foundation slice FOLLOWS that design; if Phase 2 has not landed,
  the foundation slice sequences after it (dependency, not fork). The
  owner decision settles WHAT (Hono); #1024 owns the repo-wide HOW
  (adapter design + strangler pattern).
- H-1 (foundation): add `hono` 4.13.19 + `@hono/zod-validator` 0.9.1;
  create the Hono app behind the gateway port (Worker adapter +
  in-memory adapter); mount a pilot family with dual-run (Hono serves
  pilot routes, the if-chain serves the rest); identity-stripping
  middleware FIRST (dispatcher behavior preserved: the session gate
  mints identity before Hono sees the request; Hono middleware strips
  caller identity headers as defense-in-depth); catalog parity tests
  prove identical behavior.
- H-2..H-n (family migration): money paths + ledger + checkout + billing
  FIRST (same priority as the API Shield rollout), then platform
  families, then the rest. Each slice: routes moved, middleware wired
  (zod validation, CORS, throttle), catalog pins updated, parity tests.
- H-last (decommission): remove the if-chain dispatch ONLY when the
  catalog proves full coverage (aligns with #1024 Phase 4); verified by
  grep + the catalog pin, in one slice.
- Throughout: handlers stay portable (no Hono imports in handler logic
  — Hono is the adapter); the OpenAPI spec generated by chanfana from
  the zod schemas feeds the ONE spec artifact → API Shield upload via
  CI. Dispatch order is preserved exactly through the migration
  (`api-security.md` §1; `09-api-standards.md` J1): a route that moves
  above the session check has silently become public, and that is a
  security change, not a cleanup.

## 5. JWT roles

JWT is the token format for STATELESS tokens — DECIDED; sessions stay
IAAA.

- R-JWT-1 Service-to-service tokens: short-lived, audience-bound,
  JWS-signed (algorithm pinned; CISO confirms the algorithm), verified
  via the token-verification port (jose) with local JWKS. Used for
  Worker-to-Worker/DO HTTP calls and A2A dispatches (replacing the
  static `A2A_API_TOKEN` Bearer token in a sequenced slice — replace,
  never parallel). Sender-constraining: mTLS-bound (RFC 8705) where the
  transport supports client certificates; DPoP N/A (confidential
  clients). Introspection for revocation-sensitive money dispatches;
  otherwise local verification + short expiry.
- R-JWT-2 MCP resource-server access tokens: JWT access-token profile
  (RFC 9068), `mcp:payments` scope for the payment surface, DPoP
  sender-constraining (RFC 9449), validated at the MCP transport (jose +
  JWKS), protected-resource metadata (RFC 9728) advertised. Issuance
  (portable provider — open survey evaluation, §14) is a FUTURE surface
  (own issue + the owner's call); the validation side is defined now.
- R-JWT-3 Delegation tokens (agents): token exchange (RFC 8693)
  down-scoped from the actor's authority, carrying RAR (RFC 9396)
  payment-scope details where the delegation authorizes payment; JWE
  where claims are confidential; introspectable/revocable; evaluated
  through the PDP seam (delegation stays an IAAA record — the token is
  its HTTP presentation, not a second authorization system). Shape
  reviewed under CISO coordination #5350.
- EXPLICITLY OUT: browser sessions (IAAA cookies + `internalUserId`
  stay — JWT does not become a second identity system); user API keys
  (`cfk_` stateful keys stay — the 0ms revocation property is
  load-bearing; JWT does not replace them); webhook authentication
  (provider HMAC stays); ID Tokens minted by cfagent (the IdPs issue
  them; cfagent consumes them via `src/security/providers.ts`).

## 6. Standards × surface matrix (full adoption, owner decision 2026-11-18)

Every standard mapped to every surface; N/A only with reason.

Legend: ✓ = applies (how/where stated) · ◐ = applies narrowly (condition
stated) · N/A = does not apply (reason stated). Surfaces: HTTP = HTTP
APIs (150 CBO routes + premium/saga/webhook families) · MCP = MCP tools
(all scopes) · AGT = agents (OrchestratorAgent turns, PortThink,
delegations) · CHT = chat (BizCopilot + StockCopilot money paths) · UX =
UX panels (checkout/billing/payment-assurance) · WH = webhooks
(Stripe/x402/cfpay) · JOB = scheduled + background jobs · A2A = A2A
dispatches.

| Standard | HTTP | MCP | AGT | CHT | UX | WH | JOB | A2A | Via |
|---|---|---|---|---|---|---|---|---|---|
| JWS (RFC 7515) | ✓ sign S2S tokens | ✓ sign access tokens | ✓ sign delegation tokens | N/A: chat session is IAAA, no tokens | N/A: sessions stay IAAA | N/A: provider HMAC, not JWS | ◐ sign tokens only where a job presents one over HTTP | ✓ sign S2S tokens | jose |
| JWE (RFC 7516) | ◐ where S2S claims are confidential (default JWS) | ◐ where tool-token claims are confidential | ◐ delegation tokens with sensitive claims | N/A: no tokens | N/A: no tokens | N/A: HMAC | N/A: no confidential token claims | ◐ where dispatch claims are confidential | jose |
| JWK (RFC 7517) | ✓ JWKS for local verification | ✓ JWKS at the transport | ✓ JWKS for delegation verification | N/A: no tokens | N/A: no tokens | N/A: HMAC | ◐ JWKS where a job verifies a token | ✓ JWKS for dispatch verification | jose (local/remote JWKS) |
| JWA (RFC 7518) | ✓ pinned algorithms | ✓ pinned algorithms | ✓ pinned algorithms | N/A: no tokens | N/A: no tokens | N/A: HMAC | ◐ pinned algorithms where tokens are used | ✓ pinned algorithms | jose (CISO confirms the algorithm set) |
| JWT (RFC 7519) | ✓ R-JWT-1 | ✓ R-JWT-2 | ✓ R-JWT-3 | N/A: session, not JWT | N/A: session, not JWT | N/A: HMAC | ◐ R-JWT-1 where a job calls HTTP | ✓ R-JWT-1 | jose |
| OAuth 2.1 | ◐ validation side now (RFC 9728); issuance future | ◐ validation side now; issuance future | ◐ validation side now; issuance future | N/A: no OAuth flow in chat | N/A: no OAuth flow in panels | N/A: provider HMAC, no OAuth | N/A: no OAuth flow; service identity | N/A: S2S tokens, no OAuth flow | portable OAuth 2.1 provider — open survey evaluation (future issuance); jose + Hono (validation) |
| OIDC Core | N/A: APIs consume access tokens/sessions, not ID Tokens | N/A: tools consume access tokens, not ID Tokens | N/A: agents don't authenticate users; the human's OIDC login is upstream | N/A: chat session is IAAA | N/A: login is upstream (providers.ts) | N/A: HMAC | N/A: no user login | N/A: no user login | Consumed only: IdPs issue ID Tokens, `providers.ts` consumes |
| JWT access-token profile (RFC 9068) | ✓ R-JWT-1 aligned to the profile | ✓ R-JWT-2 | ◐ delegation tokens aligned where presented as access tokens | N/A: no tokens | N/A: no tokens | N/A: HMAC | ◐ where a job presents an access token | ✓ R-JWT-1 aligned to the profile | jose + the token-verification port |
| PKCE (RFC 7636) | N/A: PKCE constrains the code flow at the AS, not API calls | ◐ public MCP clients at the AS (future issuance) | N/A: agents are confidential clients | N/A: no code flow | N/A: no code flow | N/A: HMAC | N/A: no code flow | N/A: confidential clients | portable OAuth 2.1 provider — open survey evaluation (future issuance) |
| DPoP (RFC 9449) | ◐ money tokens presented by public clients | ✓ sender-constraining on money tokens (mcp:payments) | ✓ agent-presented money tokens over HTTP | N/A: no tokens presented | N/A: no tokens presented | N/A: HMAC | N/A: no public-client presentation | N/A: confidential clients (mTLS instead) | Token-verification port (jose primitives; slice verifies DPoP coverage at build time) |
| mTLS-bound tokens (RFC 8705) | ◐ S2S money tokens where client certs are supported | ◐ confidential MCP clients where client certs are supported | ◐ agent→HTTP money calls where client certs are supported | N/A: no tokens | N/A: no tokens | N/A: HMAC | N/A: in-process dispatch (membership check) | ✓ S2S money dispatches over HTTP | Cloudflare managed-CA mTLS (every plan) + jose (confirmation claim) |
| Token introspection (RFC 7662) | ✓ money paths (revocation-sensitive); local JWKS otherwise | ✓ money tools (revocation-sensitive) | ✓ delegation tokens | N/A: no tokens | N/A: no tokens | N/A: no tokens | ◐ job-presented money tokens | ✓ money dispatches | AS introspection endpoint (future issuance) + the token-verification port |
| Revocation (RFC 7009) | ◐ revocation endpoint at the AS (future issuance) | ◐ same | ◐ delegation revocation via the IAAA store + AS endpoint | N/A: no tokens (session revocation is the IAAA path) | N/A: no tokens (session revocation is the IAAA path) | N/A: no tokens | N/A: no tokens (membership revocation is the path) | ◐ S2S token revocation via the AS endpoint | portable OAuth 2.1 provider — open survey evaluation (future issuance); IAAA stores for delegations/memberships; `cfk_` deletion stays the user-key path |
| PAR (RFC 9126) | N/A: PAR shapes authorization requests to the AS, not API calls | ◐ payment-scope authorization requests at the AS | ◐ agent-initiated payment-scope requests at the AS | N/A: no authorization request originates in chat | N/A: no authorization request originates in panels | N/A: HMAC | N/A: no authorization requests | N/A: no authorization requests | portable OAuth 2.1 provider — open survey evaluation (future issuance; support verified at adoption time) |
| RAR (RFC 9396) | N/A: RAR details travel in authorization/delegation requests, not API calls | ✓ payment-scope authorization details | ✓ delegation payment-scope details (R-JWT-3) | N/A: HITL approval, not RAR | N/A: HITL approval, not RAR | N/A: HMAC | N/A: no authorization details | ◐ dispatch payment-scope details where a dispatch carries payment scope | jose + the PDP seam (RAR details evaluated as the permission/scope claim) |
| Token exchange (RFC 8693) | ◐ S2S acting on behalf of a user/delegator (down-scoped exchange) | ◐ tool acting on behalf of a delegator | ✓ delegation exchange (R-JWT-3) | N/A: no token exchange in chat | N/A: no token exchange in panels | N/A: HMAC | N/A: jobs act as the service identity, no exchange | ◐ dispatch acting on behalf of a delegator | IAAA delegation enhancement + jose |
| AS metadata (RFC 8414) | ✓ clients discover the AS | ✓ clients discover the AS | ✓ clients discover the AS | N/A: no OAuth clients | N/A: no OAuth clients | N/A: HMAC | N/A: no OAuth clients | ◐ dispatch clients discover the AS | portable OAuth 2.1 provider — open survey evaluation (future issuance) |
| Protected-resource metadata (RFC 9728) | ✓ APIs advertise as protected resources | ✓ MCP transport advertises | N/A: agents are clients, not resources | N/A: chat is not an OAuth resource | N/A: panels are not OAuth resources | N/A: HMAC | N/A: jobs are not OAuth resources | ◐ dispatch endpoints advertise where they accept access tokens | Hono routes (metadata endpoints) |
| JAR (RFC 9101) | N/A: JAR signs authorization requests, not API calls | ◐ signed authorization requests at the AS (payment scope) | ✓ agent-initiated payment-scope requests signed | N/A: no authorization requests | N/A: no authorization requests | N/A: HMAC | N/A: no authorization requests | N/A: no authorization requests | jose (request-object signing/verification; AS support verified at adoption time) |

Security bar (binding): every applicable standard applied —
sender-constraining (DPoP/mTLS) on money tokens, introspection/revocation
wired, PAR/RAR where authorization requests carry payment scope.
Adoption goes THROUGH the decided pieces (Hono, jose, the surveyed
portable OAuth provider for any future issuance surface, the optional
API Shield edge adapter) + the IAAA enhancements — no
parallel token/authorization implementations. Where a decided FOSS piece
lacks a required standard at adoption time, the slice documents the gap
and the adoption decision returns to the owner — no silent skip, no
custom re-implementation without a decision.

## 7. Cloudflare API Shield gateway (owner decision 2026-11-18)

DECIDED: use API Shield schema validation on the free tier, with
ports/adapters — as an OPTIONAL edge adapter only (§14). The server
must be FULLY FUNCTIONAL without it: the adapter is config-as-code that
may validate shape where deployed, never a required dependency, and no
slice may depend on edge validation being present. Spec upload via CI
(§4) happens only where the adapter is deployed.

Free-tier facts (verified from Cloudflare's own docs + blog,
2026-11-18; RE-VERIFY in the dashboard — see §7.1): Free = 100 saved
endpoints, 5 uploaded schemas enabled for validation, 200 KiB schema
size, Block-only action (no Log mode). JWT validation + API Discovery +
sequence protection are ENTERPRISE API Shield subscription only
(quote-based) — out. mTLS with Cloudflare-managed CA is on every plan.
Rate limiting: 1 rule on Free. Cloudflare's blog (July 2026): "any
Cloudflare customer can use Schema Validation"; recommends "Cloudflare's
API or Terraform provider to add endpoints... as part of your post-build
CI/CD process."

Ports/adapters shape: the gateway is an EDGE adapter, configured as
code — Terraform provider or Cloudflare API calls in CI/CD, versioned
in the repo, applied post-build. The OpenAPI schema is the SHARED
CONTRACT: one spec artifact (generated by chanfana from the zod schemas,
feeding the `openapiSpec.ts` extension) drives BOTH the edge validation
AND the in-Worker zod schemas (derive, don't duplicate). The Worker
code keeps its port structure; no gateway logic inside handlers.

Limits shape the rollout: 150 CBO routes > 100 saved endpoints —
prioritize: money paths + ledger + checkout + billing FIRST; the rest
sequenced. Split the spec into at most 5 uploaded schemas (per family).
Block-only means NO log-first mode on Free: the design includes a
staging validation step (validate the schema against staging traffic /
a shadow check) BEFORE enabling Block on any endpoint, so a bad schema
cannot block legitimate traffic.

Per-zone budget (§15): the `api` subdomain is a separate hostname in
the same zone, and API Shield endpoints are per-zone — so the api
hostname SHARES the zone's 100-endpoint / 5-schema budget with the main
hostname. The rollout budget above covers BOTH hostnames combined, and
the endpoint inventory lists host + path. No dashboard state is claimed
for the new hostname; the §7.1 check confirms the zone setup including
it. Whether the MCP endpoint enters the Shield inventory is decided by
the #5386 survey together with the dashboard check, not assumed here.

Split of duties: edge validation = shape/schema only (positive security
model on requests). Authorization stays IN-WORKER (IAAA/PDP wiring) —
the gateway NEVER replaces handler authorization. Defense in depth,
fail-closed at both layers.

The FOSS routing evaluation continues INDEPENDENTLY — the gateway does
not replace the in-Worker router decision (Hono, §4).

### 7.1 Dashboard verification — REQUIRED, UNPERFORMED

Confirm the Free limits + that schema validation is enabled for the zone
in the Cloudflare dashboard. One third-party summary disagrees with the
docs; the dashboard is the authority.

- Status: NOT PERFORMED. The design author had no browser/dashboard
  access. Nothing in this doc claims the check was done.
- STOP rule: if the dashboard contradicts the docs, STOP and report the
  exact requirement. A plan decision is the owner's, not a code
  decision. No slice enables Block on any endpoint until the dashboard
  check is recorded with its evidence (zone, limits observed, date,
  observer).
- The check is a design-phase gate, not a slice-phase afterthought: the
  rollout in §7 (endpoint prioritization, schema split) is conditional
  on the confirmed limits.

## 8. Domain-to-module-to-API mapping + granularity policy

Verified 2026-11-18: NO designed mapping exists. 104 discrete user
FLOWS (not APIs); 150 CBO-scope HTTP routes in 12 groups, 41 with no
client caller, 9 legacy, no versioning, no router — sequential if-chains
+ path catalog only; 21 domains in the issue taxonomy (D-1–D-21), a
classification taxonomy, NOT a code structure; modules by file count:
307 services, 82 route files, 434 data files, 80 security, 28 MCP
openaimp, 44 agents, 384 client files; no module manifest. Granularity
today is FINE-grained, action/RPC-style (one POST per action;
composition lives in the caller).

### 8.1 The mapping (target state; slices build toward it)

Each route family maps to exactly one catalog home, one handler module,
and its data ports. The catalog is the choke point: a route with no
catalog entry and no schema is a review finding.

| Family (routes) | Catalog home | Handler module | Data access today (inventory §H) |
|---|---|---|---|
| Wallet + ledger (10) | Extend `commercialUrlCatalog` | `src/agents/routes/agenticPayments.ts` | Mixed route/service/store in one module (G-10) |
| Catalogued commercial (87) + parameterized uncatalogued (10) | `src/data/commercialUrlCatalog.ts` (#2846); the 10 parameterized routes enter the catalog pattern | `agenticPayments.ts` | Mixed (G-10); ledger writes move behind existing ports (slice 11) |
| Legacy payments (9) | Extend the catalog pattern | `src/agents/routes/payments.ts` | Direct store/ORM use in route code (gap) |
| Platform accounts (7) | Extend the catalog pattern | `src/agents/routes/platformAccounts.ts` | Port-first compliant |
| Tenants (4) | Extend the catalog pattern | `src/agents/routes/platformTenants.ts` | Port-first compliant |
| Channels (6) | Extend the catalog pattern | `src/agents/routes/platformChannels.ts` | Port-first compliant |
| Users (2) | Extend the catalog pattern | `src/agents/routes/platformUsers.ts` | Port-first compliant |
| Assurance (4) | Extend the catalog pattern | `src/agents/routes/paymentAssuranceLive.ts` | Port-first compliant |
| Premium (6) | Extend the catalog pattern | `src/agents/routes/premiumHandlers.ts` | Not verified (G-7 prices hardcoded) |
| Saga (4) | Extend the catalog pattern | `sagaJourneyHandlers.ts`, `paymentSagaHandlers.ts`, `gateHandlers.ts` | Via saga stores (CAIO surfaces) |
| Meter (1) | Extend the catalog pattern | `src/agents/routes/premiumMeters.ts:23` | Internal-only |

Domain mapping: the owning domain is D-5 (CBO — Business architecture
and commercial platform). The layer also touches D-3 (Payment — the
routes are the subject; no money-behavior change in the design), D-6
(CPO — `api-mcp.md` conformance), D-8 (CTO — layer shape and standards),
D-9 (CDO — data approach adopted), D-16 (CISO — the one security model),
D-18 (CQO — §18 receipts per slice). All other D-domains: no. The
21-domain taxonomy stays a classification; it is not turned into a code
structure — the mapping above (family → catalog → handler → ports) is
the code structure.

### 8.2 Granularity policy

- RETAIN fine-grained, action/RPC-style granularity: one POST per
  action. Composition lives in the caller (UX, chat executor, MCP tool,
  saga leg). No coarse aggregate endpoints are introduced by this
  program; a coarse endpoint is a design change needing its own ADR.
- New routes enter through the catalog with request/response schemas
  (slice 9). Path shape follows `09-api-standards.md` J4 (plural,
  canonical, alias-free; an alias only as a `*.deprecated` disposition
  with a removal issue) — applied to new routes; existing alias families
  are baseline rows, shrink-only, cleared on touch.
- Envelopes follow J5 (error `{ error, code }`, success payload
  unwrapped, collections `{ items, nextCursor }`) and J6 (catalog codes
  at outcome boundaries). Pagination follows J9 (cursor, one envelope).
  Idempotency follows J8 (mutating calls a client may retry accept and
  honour a client-supplied idempotency key).
- The internal API stays UNVERSIONED per J7: no `/api/v<N>` prefix, no
  version header; compatibility by additive change + deprecation
  discipline. A versioned path family needs an ADR + an amendment to
  `09-api-standards.md`, not a local choice in a route PR.
- Canonical host (§15.3): the catalog path IS the URL path on the API
  host (`https://api.openaimp.com` + catalog path). The router strips
  the `/api` base before dispatch — the mechanism the dispatcher
  already uses (`platform.ts:476,504`, `subPath` strip) — so the move
  changes no handler logic. Bare aliases are not canonical on the new
  host; the canonical form is the `/api` twin.
- The OpenAPI document is generated from the endpoint catalog (J10:
  `buildOpenApiSpec()`, served session-gated at `/openapi.json` and
  `/api/docs` today — the canonical serving paths on the API host are
  settled in §15.3; schemas hand-written for pilot paths only, read from the
  handlers, never guessed). The chanfana generator (§3) feeds the ONE
  spec artifact; the spike's "not yet specified" marker stays the honest
  state for uncovered paths until their schemas land.

## 9. AOP / ADD.md conformance rules (re-derived from real sources)

`docs/architecture/ADD.md` (153 lines) is a CONTAINER doc only — "holds
the section structure and links… duplicates nothing." It names AOP once
(ADD.md:111: Exception Handling, Coded Messages, Logging, Externalized
Configuration, Security, Transaction Management) and defines none of it.
The enforceable rules live in the code standards, the security docs, the
ADRs, and the code itself. The rules below are re-derived from those
real sources; each names its source. They are binding on every slice;
each slice's completion note states its compliance evidence.

### 9.1 Exception Handling

- The Worker entrypoint is wrapped in `withErrorBoundary`: an escaped
  throw becomes a real 5xx with a machine-readable code, never an edge
  error page and never a stack trace (`api-security.md` §4;
  `09-api-standards.md` J2).
- Error codes are externalized (`src/aspects/errorCodes.ts`) so a
  message never has to carry internals to be actionable
  (`api-security.md` §4).
- Error shape: `Response.json({ error, code }, { status })` — the error
  string is the business message, `code` is from the single catalog (J5);
  API errors at outcome boundaries carry catalog codes, not ad-hoc
  strings invented at the route (J6).
- Exception detail never reaches the caller: the real error is logged
  server-side; responses carry a generic message only (the `logError`
  pattern, `paymentAssuranceLive.ts:103–112` — the G9 pattern slice 5
  reuses). No raw `err.message` passthrough to clients, no regex
  classification of error text.

### 9.2 Coded Messages

- User-facing messages use coded messages via `codedMessage`
  (`src/outcomes/outcomeAspects.ts:136`) + the outcome catalog
  (`src/outcomes/outcomeCatalog.json`, resolver in
  `src/outcomes/outcomeAspects.ts`), and coded responses via
  `codedOutcomeResponse` in the handler — never inline literals, never
  technical detail to the user (J5/J6; the standing guardrail that
  user-facing messages carry business errors, with technical detail in
  logs).
- Slices extend the catalog; no slice invents a second message catalog
  or a second coded-response helper.

### 9.3 Logging

- All logging goes through the module logger seam
  (`src/observability/structuredLogger.ts`, #3515): module loggers,
  structured events, entry/outcome/failure events on route handlers. No
  ad-hoc console logging in route code; no new logging library (§3).
- Secrets never appear in code, logs, or URLs
  (`05-security-and-tenancy.md` E5). No caller PII in logs beyond what
  audit requires; error detail is server-side only (§9.1).
- Telemetry rides the existing OpenTelemetry SDKs (already dependencies)
  + the outcome catalog (§3); no new telemetry mechanism.

### 9.4 Externalized Configuration

- Defaults are externalized in operator-managed config, never code
  constants; missing data fails closed (owner directive 2026-10-28;
  ADD.md standards list names Externalized Configuration). Mechanisms:
  the `COMMERCIAL_DEFAULTS` module (slice 10 moves pagination literals
  onto it), the price catalogue + approval mechanism (#2547; slice 8
  routes premium prices through `getApprovedPrice`), and the existing
  config modules (`src/config/*`, e.g. `src/config/apiIngressModes.ts`).
- No slice hard-codes a price, limit, default, or threshold that an
  operator must be able to change. Seeded values are proposed operator
  data, never approval.

### 9.5 Security

- Authorization is server-side, through the central PDP seam
  (`iaaaPdpSeam.ts`); an endpoint making its own ad-hoc authorization
  decision beside the seam is a violation (`05-security-and-tenancy.md`
  E1). Default-deny: nothing is permitted unless a rule grants it
  (`authz.md` §1).
- Tenant isolation is enforced across every surface, with negative
  tests — a test that a tenant cannot reach another tenant's data
  through that path (E2). Session-scoping (§2.2) is the mechanism for
  CBO routes.
- Agent authority is an intersection, rechecked before execution (E3);
  established libraries, no custom cryptography (E4 — jose, §3, is the
  JOSE implementation; no hand-rolled crypto anywhere in this program);
  every MCP tool carries exactly one scope, completeness-pinned (E6);
  HITL for consequential actions, deterministic caps for loops (E7);
  session tokens live in SQLite Durable Objects, never unencrypted KV
  (E8).
- Dispatch order is a security property (§2.1); caller-supplied identity
  headers are stripped unless validated (J3); per-route throttling is a
  load control, never cited as an authorization control
  (`api-security.md` §2).

### 9.6 Transaction Management

- Multi-statement D1 writes are atomic via the D1 batch leg
  (`d1BatchTransactionBackend`, `transactionAspect.ts:390`) — slice 4
  wires the multi-write routes (journal post, activate-subscription
  pair, settings PATCH, bulk move) onto it. `db.transaction()` is not
  relied on for D1 atomicity.
- Projection writes follow ADR 0002 R5 (DO authoritative, D1 projected,
  idempotent, reconcile-never-correct) and ADR 0033 R-1 (a projection
  write is a no-op under redelivery, including concurrent redelivery).
  Cross-store atomicity is explicitly unclaimed (ADR 0033): cross-store
  steps keep the loud-log + reconcile posture, never silent partial
  success.

### 9.7 ADD.md rules

- Port-first (ADR 0002 R1, non-negotiable): domain code depends only on
  interfaces in `src/data/*`; no store client, no `env.AGENT_DB`, no SQL
  in domain code. See §11.
- Layering: routes → services → ports → adapters. No group fully honors
  it today (inventory §H); the 9,043-line handler is the standing
  violation (G-10, slice 11). Slices move route code toward the layering
  on touch; no slice adds a new layer violation.
- API-first: the path catalog exists and the client uses it (compliant
  at the path level); schema-first is the gap slice 9 closes (shared
  request/response schemas + OpenAPI extension). Contract-first: the ONE
  OpenAPI spec artifact (§7) is the shared contract.
- One codebase / one implementation: no duplicate implementations; the
  no-drift rule (`docs/compliance/anti-drift.md`) makes reuse mandatory.
  The rejected-alternatives list (ADR 0034) enforces it for this
  program.
- `docs/architecture/application/api-mcp.md` is the CPO-lane API/MCP
  architecture assessment this design conforms to; any change to it is
  CPO-lane. `09-api-standards.md` records that it is an October-2026
  assessment whose counts are stale, and that the current operational
  standard is `api-security.md` + `09-api-standards.md` itself — this
  design follows those for current rules and cites `api-mcp.md` for
  architecture, never for counts.
- 15-factor: ADD.md's standards list names the 15-factor methodology;
  the issue's L-1–L-11 layer rows map factors to layers (L-3 Application
  carries factors 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15; L-8 Security
  carries 5, 6, 14, 15). Slice issues carry their own full-stack ledgers.

## 10. Slice plan

Each slice = one sub-issue under #5343, one PR, queue merge, §18 on the
landing SHA. AOP aspects (§9) and ADD.md (§9.7) are binding on every
slice. Slices may be FILED in parallel with the design PR, but no slice
PR opens before the design lands, so slice bodies can cite the merged
ADR number.

Standing requirement — slice-start re-check for in-flight CLO work
(§16): before claiming or building, every slice builder re-checks for
in-flight CLO work on the shared modules — live issue state of the
adjacent CLO issues (#5037/#5038/#5040/#5041) plus open branches/PRs
touching the modules the slice will touch — and records the check
(date, issues checked, result) in the slice's claim or body. If an
overlapping CLO fix is in-flight, the slice waits/sequences — never
collides, never duplicates, never pre-empts. The check is repeated if
the slice stalls; a design-time check never substitutes for one at
build time. An open-but-unclaimed CLO issue does not block a slice.

### 10.1 Gap-closing foundation (first; CISO-coordinated)

| Slice | Gap | Work | Reuse |
|---|---|---|---|
| GAP-1 | PDP unwired | Wire `authorize()` into live route handlers through the existing seam (`checkPermission`, `iaaaPdpSeam.ts:51`; `createAgentPdpChecker` pattern), fail-closed. CISO coordination: #5350. CISO review on the PR. | iaaaPdpSeam.ts, pepGateway.ts, agentAccess.ts |
| GAP-2 | No money permission | ADD the money/ledger permission to the SAME 17-permission table with role bindings per the existing pattern (CISO decides name + bindings). CISO coordination: #5348. CISO review on the PR. | authorization.ts, pdpPorts.ts |
| GAP-3 | System principal open (G-AUD-3) | Define + wire the system-principal binding story (`service:<login>`, `agentIdForServiceLogin`) through the existing modules; G-AUD-3 threading advanced. CISO coordination: #5349. CISO review on the PR. | serviceIdentity.ts, agentAccess.ts, iaaaMembershipStore.ts, serviceDispatch.ts |
| GAP-4 | MCP role-to-scope seam | Plug the IAAA role-to-scope adapter into the ADR 0012 seam (`mcpPermissionPorts.ts:508`), replacing permissive defaults with role-derived scopes where specified (`mcp:payments` for the payment surface). CISO coordination: #5350. CISO review on the PR. Re-check the file at slice start (recent feature commits). CLO coordination (§16): sequence around #5041 (registry completeness — sync-set pin, paid-tool queueing, table-read gating); build no registry-completeness fix. | mcpPermissionPorts.ts (ADR 0012) |
| GAP-5 | ExecutionContext staged wiring | Advance the staged wiring for the commercial path: one validated context through the workflow-to-handler path, PDP decision embedded, revalidated at boundaries. CISO coordination: #5350. CISO review on the PR. | executionContext.ts (#1078) |

Sequencing rule: the GAP slices proceed on the CISO-owned specs with
CISO review requested. Waiting applies ONLY on a real collision with
in-flight CISO work, never as the default. Alignment (§14): the GAP
slices plug into the ONE IAAA chain #5387/#5386 define (session,
api-key, scanner-payment principals resolved in one place) — no
CBO-only auth path — and sequence with/after the shared-server survey
conclusions where they overlap (chain shape, registry shape).

### 10.2 Hardening slices (G-1–G-15)

| Slice | Gap | Work | Reuse |
|---|---|---|---|
| 1 | G-1 | LEDGER GATE — IAAA-CONFORMANT (no interim, per §2.5): the gate consults the PDP through seam A (GAP-1/GAP-5) for the money/ledger permission (GAP-2) over the system actor's binding (GAP-3); sequences after the gap slices land; waits ONLY on a real collision, never idle. REMOVE `record-native` only after re-verifying zero production callers by repo-wide grep (workflow step `record-native-ledger` calls the native PORT, not HTTP — verified at filing); if any caller is found, gate it identically instead and say so. Tests must prove: both legitimate server-side callers (`src/payments/ledger.ts` `ledgerFetch`, `src/services/cfpayLedger.ts` `cfpayLedgerFetch`) succeed through the IAAA path, a forged user request is denied, and the permission/denial is audited. No write-path change. The G-1 hole stays open until this slice lands, by the owner's explicit choice. CLO SEQUENCING RULE (§16.3, binding): #5037 (CLO-owned fix for `confirmDraft` reporting success when the ledger write fails, `src/agents/mas.ts:275–385`) is the SAME ledger neighborhood — this slice gates the write-through routes ONLY and fixes NOTHING in `confirmDraft`. At slice start the builder re-verifies #5037's live state; if CLO's fix is in-flight, this slice waits/sequences rather than colliding. The slice's tests account for #5037's state as found at slice start: if CLO's fix has landed, the tests prove the gate against the fixed confirm semantics; if it has not, the tests pin the gate's behaviour without assuming the fix. | IAAA modules (authorization.ts, iaaaPdpSeam.ts, executionContext.ts), `serviceDispatch` identity derivation, existing fetchers |
| 2 | G-4 hole + auth consolidation | Hoist the gates to ONE shared auth module; convert `agenticPayments.ts` + the platform route files to it (no behavior change, pins updated). Fix lifecycle preference GET/POST (`agenticPayments.ts:8761–8815`) to derive `tenantId` from resolved session identity, never from query/body. CLO coordination (§16): #5038 owns the substrate / job-pipeline / `mas_events` / SessionStore isolation gaps — this slice touches none of them; sequence around #5038's decision-first work. | Existing gate closures, identity-resolution pattern |
| 3 | G-4 validation | ONE shared request-validation helper, extending `validateProfileInput` / `validateStrictAuditWrite` onto zod schemas (zod arrives with H-1, §4; before H-1 the helper extends the existing validators without a second catalog). The schemas land in the SHARED validation layer (door/service layer per #5386), not a CBO-only layer; the #5387 duplication inventory governs. No second catalog. | Existing validators |
| 4 | G-2 | D1 batch atomicity for multi-write routes (journal post, activate-subscription pair, settings PATCH, bulk move) via the existing batch leg. Cross-store steps keep the loud-log + reconcile posture (ADR 0002 non-goal). | `d1BatchTransactionBackend` / `withTransaction` |
| 5 | G-3 | Coded error responses: replace raw `err.message` passthrough + regex classification with catalog-coded responses + server-side logging. | G9 pattern (`paymentAssuranceLive.ts:103–112`), outcome catalog |
| 6 | G-5/G-6 | Module logging + coded messages across the platform families. | #3515 logger seam, outcome catalog, `codedOutcomeResponse` |
| 7 | G-11 | Channel audit funnel wiring at the `routeRequest` call site. Audit-before-write is an OWNER decision — carried, not assumed. | G2 wiring precedent |
| 8 | G-7 | Premium prices via `getApprovedPrice`. Owner decision on seeds required before build — file, do not build until called. | Price catalogue + approval (#2547) |
| 9 | G-8 | Catalog extension (platform families into the catalog pattern) + shared request/response schemas + OpenAPI extension for CBO routes. The CBO schemas feed the ONE OpenAPI spec (#5387 requirement 5), generated from the route schemas. No registry (rejected). | `commercialUrlCatalog`, `openapiSpec.ts` spike |
| 10 | G-9/G-14 | Log/audit the operator-list degrade; pagination literals via `COMMERCIAL_DEFAULTS`. Fold into the nearest slice PR if small, else its own. | Existing defaults module |
| 11 | G-10 | Route-layer ORM / `.db` reach-through remediation behind existing ports (CDO approach, §11). CDO-lane issues for any CDO-owned change. CLO coordination (§16): #5040 owns the one-store-per-family decision (including which payment ledger is authoritative) — this slice builds no store-architecture decision and follows CLO's decision once made; sequence around it until then. | Existing ledger/marketplace/audit ports |
| 12 | G-12 | Doc-only: AOP section for ADD.md re-derived from real sources (this design's §9 rules). | ADR/standards sources as verified |
| 13 | G-13/G-15 | Verify-first: live default check for `POST /audit` legacy mode; follow-up reads (`src/services/payments.ts`, gate + claim/release, ads modes). File build issues only after verification. | — |

### 10.3 Hono migration slices

H-0–H-last per §4, sequenced after #1024 Phase 2. The Hono slices are
filed under #5343 alongside the GAP and hardening slices, each stating
its #1024 dependency. Alignment (§14): the migration lands the CBO
families on the ONE router of the one API server (#5387) — the Hono app
is the shared server's app, not a CBO-only app — and sequences with the
#5387 survey conclusions on the shared-server shape. Endpoints (§15):
the one router answers at the canonical API host
`https://api.openaimp.com/api`; the cutover slices carry the
DNS/custom-domain/route setup (§15.5) and the old-path dual-serve /
redirect mechanics (§15.2–§15.3).

## 11. CDO data approach (binding — owner direction 2026-11-18)

Follow CDO's ORM and adapter approach. Do NOT invent data-side
solutions.

- ADR 0002 (`docs/architecture/adr/data/0002-data-foundation-layer.md`):
  port-first (R1 — domain code depends only on interfaces in
  `src/data/*`; no store client, no `env.AGENT_DB`, no SQL in domain
  code), dialect isolation (R2), portable versioned migrations (R3),
  projection-write contract (R5 — DO authoritative, D1 projected,
  idempotent, reconcile-never-correct), tenancy at the boundary (R7).
- All data access through ports in `src/data/*` with Drizzle D1 +
  in-memory adapters behind composition roots (exemplar:
  `NativeLedgerPort` + `D1NativeLedgerAdapter` + in-memory adapter +
  `createNativeLedgerPorts.ts`, #2192). ADR 0032: Drizzle is the D1
  standard, the mini-ORM is the DO standard.
- `mas_*` DDL lives in exactly one place:
  `src/data/schemaComponent/ormCatalogue.ts` (#4282 P2a). NOTE: the path
  `src/data/ormCatalogue.ts` does not exist — the catalogue moved under
  `schemaComponent/`; cite the real path. No inline DDL anywhere; D1
  migration text lives in `src/data/schemaComponent/d1Catalogue.ts` and
  is executed by `src/data/migrationRunner.ts` (strictly-increasing
  registry, D1 only, marker-last, forward compensating migrations only).
- Handlers must NOT touch the ORM directly. The ledger handlers'
  `ctx.getOrm()` calls (finding G-10) are remediated in their own slice
  by moving behind the EXISTING ledger ports/helpers — never by
  inventing a new write path. The slice 1 gate fix changes NO write
  path: it gates the handlers in place.
- If a needed port does not exist, EXTEND the existing port/adapter
  pattern (enhancement of the CDO approach), never a new data-access
  pattern, new store client, or new DDL site. If a slice needs a change
  to CDO-owned capability, file a SEPARATE CDO-lane issue. If any part
  of the CDO approach is unclear from code/docs, STOP that slice and
  report the question — do not improvise a data pattern.

## 12. Verification record

Verified by direct read against the design base `46b6537d6`
(2026-11-18):

- ADR numbering: 0034 free; 0004 duplicated (both records stand);
  index in `docs/architecture/adr/README.md` ends at 0033.
- `package.json`: 27 dependencies; zod/MCP SDK/Drizzle/agents/OTel
  present; hono/jose/itty-router/workers-oauth-provider absent.
- Dispatcher mint: `platform.ts:472–479`. Gates:
  `agenticPayments.ts:841/875/907`. Ledger range 508–763: no gate
  reference. Lifecycle prefs: 8761–8815, `tenantId` from query/body,
  `canAccessAccount` only. Handler: 9,043 lines.
- `PERMISSIONS`: 17 entries, no money/ledger permission. No route
  handler calls `authorize()`; the seam wraps the policy.
  `checkPermission` at `iaaaPdpSeam.ts:51`. `ExecutionContext` interface
  at `executionContext.ts:74`. MCP scopes at
  `mcpPermissionPorts.ts:96–101`; permissive defaults at :448; future
  seam at :508. `cfk_` prefix at `apiKeys.ts:32`. Batch leg at
  `transactionAspect.ts:390`. Validators at `userProfile.ts:151` and
  `restTwinsModes.ts:250`. `codedMessage` at `outcomeAspects.ts:136`.
  `ormCatalogue.ts` under `schemaComponent/`; `src/data/ormCatalogue.ts`
  absent. `apiIngressModes.ts` under `src/config/`.
- Docs re-read: `api-security.md`, `authn.md`, `authz.md`, ADD.md,
  `api-mcp.md`, `05-security-and-tenancy.md`, `09-api-standards.md`
  (J1–J11), ADR 0002 (R1–R9), ADR 0012, ADR 0032, ADR 0033,
  `standards.md` (§4.1 IAAA), G-AUD-3 records.
- Design-doc path `docs/architecture/application/cbo-api-layer-design.md`
  free at build time; the parallel integrated-domain doc was absent from
  the tree at build time and is not cited here.

Amendment verification (2026-11-18, same day): the live bodies, titles,
and states of #5387 and #5386 were re-read via the connector by the
amending author (both open; #5387 "One API server: consolidate the
entire API layer — one router, one IAAA chain, one OpenAPI spec, one
validation layer, no duplicated rules"; #5386 "One MCP server:
consolidate the platform and scanner MCP servers behind one registry
and one IAAA security model"; both #CDO-mha7, parent #798 as stated in
their bodies). #5343's live body was re-read at the same time: still
75,730 chars, no alignment section present yet — the coordinator's body
amendment had not landed; this amendment records the owner's directive
as received, and the issue-body amendment is the coordinator's work,
not this doc's. No replacement OAuth-provider library is named anywhere
in the amendment: the survey evaluates candidates, and naming one
unverified would be invention.

Endpoints verification (2026-11-18, same day; amendment base
`3e8f9dfa` — `src/` unchanged from `0483b1bce`, the intervening commit
touched docs only): MCP transport verified from
`src/mcps/openaimp/handler.ts` (SDK `Server` +
`WebStandardStreamableHTTPServerTransport`, stateless idiom) and
`package.json:36` (SDK 1.32.2). Current MCP dispatch verified in
`src/server/routes/platform.ts:332–413` (`/mcp` + `/api/mcp`
session-or-API-key, forwarded to the orchestrator agent;
`/mcp/scanner*` x402, no session auth, scanner DO, affinity headers).
Session cookie verified in `src/security/session.ts:36,106`
(`session_id`, `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`
attribute — host-only). CORS today verified as per-branch
`Access-Control-Allow-Origin: *` with no credentials
(`platform.ts:334/363/376/413/445/483/519`, `core.ts:67`) and per-branch
OPTIONS handling; the client uses relative `/api` fetches
(`src/client/`). The `/api` strip verified at `platform.ts:476,504`.
OpenAPI serving verified at `src/server/routes/core.ts:136`
(`/openapi.json` + `/api/docs`). Routing mechanism verified in
`wrangler.jsonc:26–27` (`workers_dev: false`, one `routes` entry,
`agent.openaimp.com`, `custom_domain: true`) and
`.github/workflows/deploy.yml:141` (`npx wrangler deploy`). Zero
references to `api.openaimp.com` / `mcp.openaimp.com` exist in `src/`,
`docs/`, `wrangler.jsonc`, or `.github/` at the amendment base, and no
Dockerfile exists in the repo — the hostnames exist only in this
design and the owner directive until the routing work lands. #5343's
live body was re-read at amendment time: 82,509 chars, the alignment
section present (lines 74–91), NO endpoints section and NO subdomain
URLs present yet — the coordinator's endpoints amendment had not
landed; this amendment records the owner's directive as received.

CLO verification (2026-11-18, same day): the live bodies, titles,
states, and labels of #5023, #5037, #5038, #5040, and #5041 were read
via the connector by the amending author — all open, all
`lane:clo-arsi` (#5037 additionally `fix`; the rest `enhancement`).
#5023's sub-issue list was read via the API: 23 sub-issues, ALL open,
ALL `lane:clo-arsi` (verified count, not copied). The four bodies were
skimmed for scope: #5037 `confirmDraft` (`src/agents/mas.ts:275–385`,
swallowed failures at :292–293/:339/:365, gateway charge at :310–330);
#5040 four families with more than one store home, payments
authoritativeness UNVERIFIED; #5038 four gaps (append substrate,
job-pipeline tables, `mas_events`, SessionStore — no tenant columns);
#5041 three registry gaps (sync-set pin, paid-tool queueing,
table-read gating) plus the #3748 coordination note. #5343's live body
was re-read at amendment time: 85,931 chars, the alignment and
canonical-endpoints sections present, NO CLO-coordination section and
no #5023/#5037/#5038/#5040/#5041 references present yet — the
coordinator's fourth amendment had not landed; this amendment records
the parent-verified flag as received, and the issue-body amendment is
the coordinator's work, not this doc's.

NOT verified (no claim is made):

- The Cloudflare dashboard check (§7.1) — required, unperformed.
- The DNS / custom-domain dashboard check (§15.5) — required,
  unperformed. A probe of `api.openaimp.com` from proxy DNS is a hint
  only, not evidence of public DNS; nothing here claims DNS exists or
  does not exist from it.
- Any live, runtime, or signed-in behavior. All findings are static
  code + doc reads.
- FOSS versions beyond the 2026-11-18 evaluated baseline — each slice
  re-verifies at build time.
- The G-15 follow-up reads and the G-13 live default — slice 13's
  verify-first work.
- The `record-native` zero-caller grep at slice-1 time — slice 1
  re-verifies by repo-wide grep before removing anything.

## 13. Owner-gated and open items (carried, not decided here)

- Audit-before-write (slice 7): owner decision required.
- Premium price seeds (slice 8): owner decision required before build.
- OAuth issuance surface (portable provider — open survey evaluation,
  §14): future surface, own issue + owner call. The Workers-only
  provider evaluated in §3 is OUT for the shared-server role.
- API Shield plan decision if the dashboard contradicts the docs (§7.1).
- DNS / custom-domain state for the canonical hostnames (§15.5):
  required dashboard check, unperformed; zone/plan decisions are the
  owner's if the dashboard contradicts the assumptions.
- Whether a 308 redirect preserves a valid x402 payment (§15.2):
  cutover-slice verification gate for the scanner path; no redirect on
  that path until verified.
- Dual-serve window length (§15.2): operator call at cutover,
  externalized configuration, recorded in the cutover slice.
- Session-cookie `Domain` change (§15.4): CISO review on the cutover
  slice.
- CLO decisions awaited (§16): the #5040 one-store-per-family decision
  (slice 11 sequences around it); the #5038 tenant-isolation decision
  (slice 2 touches none of its gaps); #5037's fix state at slice-1
  start (the ledger-gate tests account for it as found); #5041's
  registry-completeness state for MCP-adjacent slices. None is decided
  by CBO; the slice-start re-check (§10) is the standing mechanism.
- Price-approval, refund-execution, and other owner-gated decisions:
  carried on the parity tracker, not decided here.
- CISO decisions: money/ledger permission name + bindings (GAP-2),
  system-principal binding shape (GAP-3), JWT algorithm set (§6 JWA row),
  delegation-token shape review (R-JWT-3, #5350).

## 14. One-server alignment (amendment 2026-11-18, owner directive)

ONE API server, ONE MCP server, both secure, ONE security model. This
section records the owner alignment directive of 2026-11-18, received
after the design first landed (PR #5384, landing `5fc9a0c0`) and
recorded here before the design is finalized. The corresponding ADR
decision is D11 in ADR 0034. The CDO filings below were read live by
the amending author (see §12); their states are as verified then.

### 14.1 The shared servers

- #5387 "One API server" (open, #CDO-mha7, parent #798 as stated in
  its body): one router, one IAAA middleware chain, one OpenAPI spec,
  one validation layer, no duplicated rules. All routes (8 top-level
  route files, ~80 handler files, every data endpoint). The IAAA
  middleware chain resolves session, API key, and x402 payment proof
  to IAAA principals (session, api-key, scanner-payment) in one place.
  The survey produces a duplication inventory (validation rules,
  per-file auth gates, hand catalogs, error/response shapes, logging)
  and slices consolidate each family into one implementation, schedule
  patch first. No behaviour change, pinned by conformance tests.
- #5386 "One MCP server" (open, #CDO-mha7, parent #798 as stated in
  its body): one registry, one security model (IAAA), one
  implementation of every shared rule. The two servers (`/mcp`,
  `/api/mcp` and `/mcp/scanner`) collapse to one server surface. A paid
  caller is an IAAA principal — the scanner-payment principal kind the
  permission gate already knows, holding only `mcp:payments` — so
  payment proof is a credential under IAAA, not a parallel auth path.
  REST, MCP, and chat validate through the same shared validators in
  the door/service layer. The scanner keeps exactly its current tool
  set and price; tool behaviour is unchanged. The canonical endpoint
  and the path-collapse mechanics are §15.2.

### 14.2 No separate CBO server

The CBO API layer is the commercial surface ON the one shared servers.
CBO routes land on the one API server; future BizCopilot MCP tools
(#4741–#4743, file-only, no build directed) register on the ONE
registry under the ONE IAAA model when built. No CBO slice builds a
parallel router, registry, auth chain, or validation layer. CBO slices
sequence WITH/AFTER the shared-server work, never as a competing
implementation.

### 14.3 Survey-first alignment

#5387/#5386 are survey-first: the surveys decide the shared-server
shape (framework confirmation, registry shape, validation-layer home,
duplication inventory) against ADD.md (and ADR 0012 for #5386). The
CBO design CONSUMES and aligns with the CDO surveys. It runs no
competing framework survey, and the CBO framework/library conclusions
(§3–§4) are not independent of the surveys: the owner decisions (Hono
fully, JWT, FOSS-first, standards adoption) stand as owner decisions,
and the surveys confirm and sequence the shared-server shape they land
in. Where CBO decisions overlap survey territory (framework, registry
shape, validation-layer home), CBO slices sequence after the survey
conclusions. #5387's going-in recommendation is Hono, with the survey
to confirm or pick the better alternative; #5387 records that it
follows #5343's Hono decision and does not re-decide the CBO surface.

### 14.4 The one IAAA chain

The CBO IAAA enhancements (GAP-1–GAP-5; CISO #5348 money permission,
#5349 system principal, #5350 PDP seams) plug INTO the one IAAA chain
#5387/#5386 define. Session, API key, and x402 payment proof resolve
to IAAA principals in one place; auth, permission, and audit run once
per request for every caller type; no route checks auth inline; no
route bypasses the gate. The ledger gate (§2.5, slice 1) is enforced
through that chain — no CBO-only auth path. The paid principal holds
only `mcp:payments`, with scope denial pinned for anything outside it.

### 14.5 Portability rule (binding)

The shared server runs on Cloudflare Workers AND in Docker
(multi-cloud, cloud-agnostic, per #5277, which owns the container
shape — workerd in a container, CI running the engine suite against
it); NO new Cloudflare-proprietary API surface in the new layer. The
standing source is the agentic-SaaS cross-cutting rule (cloud-agnostic
AND cloud-native; build only on existing storage seams, no new
cloud-proprietary API surface) plus the owner's 2026-11-18 direction;
#5387 verified the requirement is NOT in ADD.md. This issue does not
design the container shape — #5277 owns it; the API server must fit it
and must not hard-code Cloudflare-only assumptions while #5277's
design matures.

Per decided piece (§3), how each complies:

| Piece | Portability verdict |
|---|---|
| Hono 4.13.19 | COMPLIANT — Web-standards runtime API; runs on Workers and in Docker behind the gateway port. |
| zod, OpenTelemetry, Drizzle, MCP SDK | COMPLIANT — portable libraries; Drizzle stays behind the CDO ports/adapters (§11), and the store-behind-a-port shape is what makes the Docker shape possible. |
| jose 6.2.17 | COMPLIANT — zero-dependency ESM; verification is runtime-agnostic. |
| chanfana 3.4.0 | COMPLIANT — generates the spec artifact from zod schemas; the artifact is portable. The survey confirms the generator choice for the one spec. |
| Cloudflare API Shield (free tier) | OPTIONAL EDGE ADAPTER ONLY — config-as-code, never a required dependency; the server is FULLY FUNCTIONAL without it (§7). Never a layer the server depends on. |
| OAuth 2.1 provider | OPEN SURVEY EVALUATION — no piece named. Requirement: runtime-agnostic, store behind the existing port/adapter pattern, OAuth 2.1 + OIDC, PAR/RAR/DPoP per the §6 matrix. The evaluated Workers-only provider is OUT for the shared-server role (Workers-only + KV-bound). Issuance remains a FUTURE surface (own issue + the owner's call). |

### 14.6 Shared validation

The CBO G-4 zod schemas land in the SHARED validation layer
(door/service layer per #5386), not a CBO-only layer. The #5387
duplication inventory governs: one implementation per rule, called by
all surfaces (REST route, MCP command, chat), verified by tests that
the surfaces refuse/answer identically. Slice 3's shared helper is
the CBO contribution to that layer. The schedule-patch duplication
(the rule written word-for-word in the REST route and the MCP module)
is the first consolidation family; the CBO slices consolidate their
families into the same inventory.

### 14.7 MCP: one registry

No separate CBO MCP server. When the BizCopilot tools (#4741–#4743)
are built, they register on the ONE registry (#5386), carry one scope
each under ADR 0012, execute through `executeWithPermissionGate`, and
keep the AOP audit event per call. The MCP permission defaults
(§2.3) are replaced by role-derived scopes through the GAP-4 seam,
plugged into the one chain (§14.4). The registry answers at the
canonical endpoint §15.2.

### 14.8 Sequencing and boundaries

- CBO slices sequence with/after the shared-server survey conclusions
  where they overlap, and with/after the shared-server work — never as
  a competing implementation.
- #5387/#5386 record a dev-work stop blocking building (not the
  survey) pending the owner's resume word; CBO slice builds sequence
  accordingly.
- Boundaries: #5277 owns the container shape; #1024 owns the repo-wide
  framework-adapter design; #5386 owns the MCP consolidation; #5387
  owns the whole-layer consolidation including data endpoints; #5343
  owns the commercial-surface design + ADR and its slices. Nothing here
  folds another lane's work into CBO issues. CLO boundary (§16): #5023
  owns the system data model and its 23 sub-issues; CBO sequences
  around #5037/#5038/#5040/#5041 and builds none of them.
- The one OpenAPI spec (#5387 requirement 5) is generated from the
  route schemas and covers every data endpoint; the CBO schemas (§8,
  slice 9) feed it. The spec artifact (§7) is the shared contract for
  the edge adapter where deployed — derive, don't duplicate.

## 15. Canonical endpoints (amendment 2026-11-18, owner directive)

HARD design constraints, fixed by the owner 2026-11-18 09:08 EST. This
section records the owner canonical-endpoints directive, received after
the alignment amendment landed (PR #5388, landing `3e8f9dfa`) and
recorded here before the design is finalized. The corresponding ADR
decision is D12 in ADR 0034. The coordinator is amending #5343 with a
canonical-endpoints section and posting endpoint comments on #5386
(MCP) and #5387 (API); at amendment time #5343's body carried no
endpoints section yet (see §12) — this section records the directive as
received.

### 15.1 The two canonical URLs

| Server | Canonical URL | Owner |
|---|---|---|
| One MCP server | `https://mcp.openaimp.com/mcp` | CDO #5386 |
| One API server | `https://api.openaimp.com/api` (base path `/api`) | CDO #5387 |

These are the two single canonical URLs. They replace the current
`/mcp`, `/api/mcp`, `/mcp/scanner` paths on the main domain and the
scattered API entry points. No other hostname or path is canonical for
either server. The app stays at `https://agent.openaimp.com` and calls
the API server cross-origin (§15.4).

### 15.2 MCP: transport, principal collapse, path mechanics

Transport — verified from code, not invented. The MCP server's HTTP
handler is the SDK low-level `Server` composed with
`WebStandardStreamableHTTPServerTransport` in the established stateless
idiom (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), so
responses keep the plain-JSON shape existing clients consume
(`src/mcps/openaimp/handler.ts`, issue #2494;
`@modelcontextprotocol/sdk` 1.32.2, `package.json:36`). The wire shape
is JSON-RPC 2.0 over HTTP. The canonical endpoint KEEPS this transport:
no transport change, no second framing, no SSE lane. The handler
composition (SDK `Server` + Streamable HTTP transport + the existing
catalog/execution layer in `src/mcps/openaimp/index.ts`) is the
implementation the one registry runs; the endpoint move changes where
it answers, not how it frames.

Current paths — verified. The dispatcher serves three MCP surfaces
(`src/server/routes/platform.ts:332–413`): `/mcp` and `/api/mcp`
(JSON-RPC 2.0 + discovery; session-or-API-key auth, forwarded to the
orchestrator agent with `x-user-login` / `x-principal-kind`), and
`/mcp/scanner` + `/mcp/scanner/*` (x402 pay-per-use options scanner;
no session auth — payment IS the access control; the scanner DO serves
it, with `x-scanner-session` affinity and the `public_scanner`
instance by default).

Collapse by principal, not by path. The scanner surface collapses INTO
the one endpoint: scanner access is distinguished by the PAID
PRINCIPAL — the IAAA scanner-payment principal holding only
`mcp:payments` (§14.4) — never by a separate path or server. The one
registry serves every tool; the permission gate denies the paid
principal anything outside the scanner tools, pinned by tests. The
scanner keeps exactly its current tool set and price ($0.05 USDC via
the x402 flow); the `PAYMENT-SIGNATURE` / `PAYMENT-REQUIRED` request
headers and the `PAYMENT-RESPONSE` / `PAYMENT-REQUIRED` exposed headers
today's scanner branch carries move to the canonical endpoint
unchanged. Payment proof resolves to the principal in the one IAAA
chain (§14.4) — it is a credential under IAAA, not a parallel auth
path.

Path-collapse mechanics — settled by this design. No silent breakage;
every step below is a recorded cutover-slice behaviour:

1. Canonical live. `https://mcp.openaimp.com/mcp` answers from the one
   registry under the one IAAA chain. The migration note (new URL,
   principal model, client re-pointing) is published with the cutover
   slice, in docs and in the release notes of the cutover PR.
2. Dual-serve window. The old paths (`/mcp`, `/api/mcp`,
   `/mcp/scanner*` on `agent.openaimp.com`) keep serving, each response
   carrying a `Deprecation` header pointing at the migration note. The
   window length is OPERATOR CONFIGURATION decided at cutover: the
   design REQUIRES a window, the length is an operator call recorded
   in the cutover slice, never a hard-coded constant (§9.4).
3. Redirect. After the window, old paths answer 308 Permanent
   Redirect to the canonical URL. 308 — not 301/302 — because only 308
   guarantees method + body preservation for POST JSON-RPC calls; a
   301/302 risks downgrading a tool call to a GET.
4. Removal only on an explicit owner call, after the window and
   redirect phases, with the removal recorded in the deprecation
   ledger. No path disappears silently.
5. Scanner-path verification gate. Whether a 308 preserves a valid
   x402 payment is VERIFIED by the cutover slice against the x402
   implementation BEFORE redirect is enabled for `/mcp/scanner`. This
   design claims nothing about x402 signature binding — it was not
   verified. If verification fails, the scanner path dual-serves until
   clients migrate, with NO redirect; the gate result is recorded in
   the cutover slice either way.
6. Clients re-point via configuration. The in-app explorer's MCP base
   URL and API-key scripts' endpoint are configuration, not hard-coded
   strings; the cutover slice moves the configured default to the
   canonical URL and the migration note tells external clients to do
   the same.

### 15.3 API: base path, spec paths, route-table mapping

Base path `/api`. The canonical URL of a route is its catalog path on
the new host: `https://api.openaimp.com` + catalog path (for example,
the catalog path `/api/payments/agentic/ledger/record` answers at
`https://api.openaimp.com/api/payments/agentic/ledger/record`). The
router strips the `/api` base before dispatch — the mechanism the
dispatcher already uses today (`platform.ts:476,504`:
`subPath = path.replace(/^\/api/, "")`, forwarding the suffix to the
agent) — so every handler sees exactly the suffix it sees today. The
move changes NO handler logic: no handler is edited to learn the new
host, no matching rule changes, no behaviour changes.

Route-table mapping. Every one of the 150 catalog routes (§8) maps to
exactly one canonical URL by the rule above; the mapping table IS the
catalog (§8.1) plus the host — no second table is maintained. The ~80
handler files (82 route files counted in §8) move by the route table:
families land on the one router (§10.3) family by family, money-first,
each move pinned by the catalog-parity tests. Bare aliases
(`/payments/...`, `/trading/...`, `/payments/webhook`) are NOT
canonical on the new host: the canonical form is the `/api` twin (the
dispatcher already treats the bare form as "alias, not a second route",
`platform.ts:458`). Bare forms exist only on the old host during the
dual-serve window, then 308-redirect to their `/api` canonical URL,
then removal on owner call — the same four phases as §15.2. Existing
alias families stay baseline rows, shrink-only, cleared on touch
(J4, §8.2).

Spec paths — settled by this design. The OpenAPI spec is served FROM
the API server:

- Spec JSON: `https://api.openaimp.com/api/openapi.json`
- Swagger UI: `https://api.openaimp.com/api/docs`

Today's relative names are preserved (`core.ts:136` serves
`/openapi.json` and `/api/docs`); `/openapi.json` moves under `/api`
because the API server's canonical surface is `/api/*`. Session-gated
serving stays (J10, §8.2): the spec is the one artifact (§7, #5387
requirement 5), generated from the route schemas, and the spike's "not
yet specified" marker stays the honest state for uncovered paths.

Root-level exception. The OAuth metadata well-known paths — AS
metadata (RFC 8414) and protected-resource metadata (RFC 9728) — are
the ONLY root-level paths on the API host: their locations are fixed
by the RFCs, so they cannot live under `/api`. Everything else on that
host lives under `/api`. On the MCP host, `/mcp` is the only canonical
path; OAuth metadata discovery for MCP follows the MCP authorization
specification current at build time, confirmed by the #5386 survey —
no second MCP path is canonical, and the exact well-known shape is
survey-confirmed, not invented here.

The app calls the canonical host. The app at `agent.openaimp.com`
calls `https://api.openaimp.com/api/...` with a configured API base
URL (operator configuration, not a hard-coded string); the cutover
slice moves the configured default from the relative `/api` fetches
the client uses today (`src/client/`) to the canonical host.

### 15.4 CORS / origin policy and the session cookie

Current state — verified. The same-origin assumption holds today: the
client calls relative `/api` paths, so no credentialed cross-origin
traffic exists. CORS is per-branch, ad hoc: `Access-Control-Allow-Origin:
*` with no credentials on the MCP branches, the premium/payments
OPTIONS branch, and the public well-known document
(`platform.ts:334/363/376/413/445/483/519`, `core.ts:67`), with OPTIONS
handled inside each branch. No global CORS middleware exists. The
session cookie is `session_id`, `HttpOnly; Secure; SameSite=Lax;
Path=/`, with NO `Domain` attribute (`src/security/session.ts:36,106`)
— a host-only cookie for `agent.openaimp.com`, which browsers will NOT
send to `api.openaimp.com` as-is.

Decided policy — settled by this design. The same-origin assumption
ends; the policy is explicit:

- Allowed origins: exactly `https://agent.openaimp.com`. The origin
  list is OPERATOR CONFIGURATION (externalized, §9.4); the one origin
  is the configured default, never a code constant. No other origin is
  allowed for credentialed browser calls; adding one is an operator
  decision, recorded.
- Credentials mode: `include`. The server echoes the single allowed
  origin (`Access-Control-Allow-Origin: <origin>`, never `*` —
  browsers forbid `*` with credentials) with
  `Access-Control-Allow-Credentials: true` and `Vary: Origin`.
- Preflight: ONE OPTIONS handler in the Hono chain — Hono's CORS
  middleware from the ecosystem (`hono/cors`, a decided FOSS piece
  under D4/D5), calling no handler logic. Allowed methods and headers
  are DERIVED from the one OpenAPI spec (the methods/headers the spec
  declares), never a second list that can drift. The MCP host
  additionally allows the x402 payment headers
  (`PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED`) and exposes
  `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`, as today's scanner branch
  does.
- The `*` wildcard ENDS for credentialed browser traffic on both
  hosts. Non-browser clients (API-key scripts, MCP clients, server
  callers) are unaffected: CORS is a browser mechanism, and their auth
  (API key, x402 proof, service identity) does not pass through it.
- Session cookie — decided, security-relevant. The cookie gains
  `Domain=.openaimp.com` (same-site; `SameSite=Lax`, `Secure`,
  `HttpOnly` retained) so the app's session carries to the API
  subdomain. The change lands in the cutover slice, CISO-REVIEWED: it
  widens cookie scope to ALL `openaimp.com` subdomains, including the
  MCP host — stated explicitly, not buried. The mitigation is the one
  IAAA chain: the MCP host gates every call through it, a session
  principal is never a scanner-payment principal, and the cookie alone
  never authorizes a scanner-principal call. Rejected: a host-only
  cookie plus a same-origin proxy — a proxy reintroduces the
  single-host coupling the split exists to end.

### 15.5 Routing, prerequisites, and the DNS check

Mechanism — verified from repo config. The Worker is routed by the
`routes` array in `wrangler.jsonc` with `custom_domain: true`: the
single existing entry is `agent.openaimp.com` (`wrangler.jsonc:27`),
with `workers_dev: false` (`:26`), Worker name `ai-search-agent`, main
`src/server.ts`, deployed by `npx wrangler deploy`
(`.github/workflows/deploy.yml:141`). Each canonical subdomain is added
as a `routes` entry with `custom_domain: true` in the Worker config,
in the same shape as the existing entry. The Docker shape's ingress is
#5277's: no Dockerfile exists in the repo at the amendment base, #5277
owns the container shape and its ingress, and this design does not
prescribe it. Whether the two hostnames bind one Worker deployment or
two is settled by the #5387/#5386 surveys, constrained: both hostnames
answer from the ONE router / ONE registry — no forked code, no second
deployment of divergent logic. The DNS/custom-domain/route setup is
BUILD SCOPE: it is part of the cutover slices, not an ops afterthought,
and its config-as-code lives versioned in the repo beside the existing
`wrangler.jsonc` entry.

Prerequisites — what must exist before the server can answer at either
hostname:

1. A DNS record for the subdomain in the `openaimp.com` zone.
2. An active custom-domain binding for the Worker (or the container
   ingress equivalent per #5277).
3. A route pattern matching the hostname.
4. Active TLS for the hostname (Cloudflare-managed certificates on
   custom domains — the mechanism to confirm in the check below).

Each is a pre-cutover checklist item owned by the cutover slice; the
cutover slice records each item's evidence before enabling the
hostname.

DNS / custom-domain dashboard check — REQUIRED, UNPERFORMED.

- What: confirm, in the Cloudflare dashboard, the DNS state and the
  custom-domain state for the `openaimp.com` zone: whether the zone is
  on Cloudflare, whether records for `api` and `mcp` exist, whether
  custom-domain bindings can be added, and the TLS state. Record what
  is missing once verified.
- Status: NOT PERFORMED. The design author had no browser/dashboard
  access. Nothing in this doc claims the check was done.
- The probe is not evidence. A probe of `api.openaimp.com` from this
  environment's proxy DNS is a HINT ONLY, not evidence of public DNS.
  This doc claims nothing about DNS existence — or non-existence —
  from it. The dashboard is the authority.
- STOP rule: if the dashboard contradicts the assumptions (zone not on
  Cloudflare, records absent, binding limits, TLS blocked), STOP and
  report the exact requirement. A zone/plan decision is the owner's,
  not a code decision. No cutover slice enables either hostname until
  the check is recorded with its evidence (zone, records observed,
  date, observer).
- The check is a design-phase gate alongside §7.1, not a slice-phase
  afterthought: the cutover plan in this section is conditional on the
  confirmed zone state.

### 15.6 Gateway note (per-zone)

The `api` subdomain is a separate hostname in the same zone, and API
Shield endpoints are per-zone: the api hostname shares the zone's
100-endpoint / 5-schema budget with the main hostname (§7). The
rollout budget covers both hostnames combined; the endpoint inventory
lists host + path. No dashboard state is claimed for the new hostname;
the §7.1 check confirms the zone setup including it. Whether the MCP
endpoint enters the Shield inventory is decided by the #5386 survey
together with the dashboard check, not assumed here.

### 15.7 Sequencing and boundaries

- The endpoints land WITH the shared-server work: the Hono migration
  (§4, §10.3) lands the one router answering at the canonical API host;
  the MCP consolidation (#5386) lands the one registry at the canonical
  MCP host. The endpoint cutover is sequenced with those landings, not
  ahead of them.
- The dev-work stop recorded in #5387/#5386 (blocking building, not
  the survey, pending the owner's resume word) applies to the cutover
  slices as to all other slice builds.
- Boundaries (unchanged): #5387 owns the API consolidation, #5386 owns
  the MCP consolidation, #5277 owns the container shape and its
  ingress, #1024 owns the repo-wide framework-adapter design, #5343
  owns the commercial-surface design + ADR and its slices. Nothing here
  folds another lane's work into CBO issues.
- The coordinator's #5343 body amendment (canonical-endpoints section)
  and endpoint comments on #5386/#5387 are the coordinator's work, not
  this doc's; this section records the owner's directive as received.

## 16. CLO coordination: sequence around the data-model issues (amendment 2026-11-18, parent-verified flag)

Do not build, do not collide. This section records the parent
coordination flag of 2026-11-18, received after the endpoints
amendment landed (PR #5400, landing `9d22aeb30`) and recorded here
before the design is finalized. The corresponding ADR decision is D13
in ADR 0034. The coordinator is adding a fourth amendment (CLO
coordination) to #5343's body; at amendment time the body carried no
CLO-coordination section yet (see §12) — this section records the flag
as received, with every state verified live by the amending author.

### 16.1 The CLO program and the four adjacent issues

Issue #5023 "[Data model] System data model: conceptual, logical,
physical and subject-area views + improvement backlog" is CLO-lane
owned (`lane:clo-arsi`). It carries 23 sub-issues, ALL CLO-lane, ALL
open (verified via the sub-issues API, 2026-11-18 — counted, not
copied). CBO works on NONE of them. Four are adjacent to the
API-layer/ledger work. All four were verified open and `lane:clo-arsi`
by direct read, 2026-11-18:

| Issue | Title (as filed) | Overlap with this design |
|---|---|---|
| #5037 | [Fix] Payment confirm reports success when the ledger write fails | SAME code neighborhood as the G-1 ledger fix (slice 1). High-severity integrity defect. CLO owns the fix. |
| #5040 | [Enhancement] One store per family: schedules, payments, reports, report assets — decision first | Journal/ledger store architecture (slice 11, §11). Decision-first; CLO owns the decision and the fix. |
| #5038 | [Enhancement] Tenant isolation gaps: substrate, job pipeline, mas_events, SessionStore — decision first, then the fix | Lifecycle tenantId hole (slice 2) at the boundary only. CLO owns the decision and the fix. |
| #5041 | [Enhancement] MCP registry completeness: sync-set pin, paid-tool queueing, and table-read gating | One-MCP-server work (#5386) and the GAP-4 seam. CLO owns the fix. |

The remaining 19 sub-issues have no overlap with this design; they are
not listed here, and no CBO slice touches them. If a later slice finds
an overlap with any of the 19, the sequence rule (§16.2) applies to it
in the same way — the rule is by lane ownership, not by this table.

### 16.2 The sequence rule and the slice-start re-check

SEQUENCE RULE (binding). If any of the four is in-flight in CLO, the
overlapping CBO slice waits/sequences — never collides, never
duplicates, never pre-empts. "In-flight" means an open CLO claim,
branch, or PR touching the shared modules, as found by the live check
below — not merely an open issue. An open-but-unclaimed CLO issue does
not block a CBO slice; an in-flight one does, until it lands or the
lanes agree a sequence in the open (on the issues, not in a side
channel). A CBO slice that needs a CLO decision waits for it or
sequences with it; it never decides it locally, and it never folds the
CLO fix into its own diff "while it is there."

SLICE-START RE-CHECK (standing requirement, §10). Every slice builder
re-checks for in-flight CLO work on the shared modules at slice start
— live issue state of the adjacent CLO issues plus open branches/PRs
touching the modules the slice will touch — before claiming or
building, and records the check (date, issues checked, result) in the
slice's claim or body. The check is repeated if the slice stalls: a
design-time check never substitutes for a check at build time. The
four issues are linked as Related/Dependencies on the slice bodies
that overlap them, so the check has a stable starting point.

### 16.3 Per-issue sequencing

#5037 — ledger neighborhood (slice 1). `confirmDraft`
(`src/agents/mas.ts:275–385`) reports success when the ledger write
fails: the `findById` failure is swallowed (`mas.ts:292–293`), the
gateway charge/refund executes (`mas.ts:310–330`), the
`transactions.update` failures to `completed`/`rejected` are swallowed
(`mas.ts:339`, `:365`), and the `payment.confirmed` /
`payment.rejected` audit entries are written regardless. A payment can
be charged while the ledger never records it — the two ledgers diverge
silently. This is the same failure SHAPE as the G-1 hole (ledger
writes the caller cannot trust) on a different, synchronous payment
path — which is exactly why the sequencing must be explicit:

- Slice 1 (the ledger gate) gates the three write-through routes ONLY
  (`agenticPayments.ts:508–763`). It fixes NOTHING in `confirmDraft`:
  no swallowed-failure repair, no confirm-semantics change, no audit
  correction. That fix is CLO's, in #5037.
- At slice start the builder re-verifies #5037's live state. If CLO's
  fix is in-flight, slice 1 waits/sequences rather than colliding on
  the shared ledger neighborhood (shared modules, shared tests,
  shared audit assertions).
- The slice's tests account for #5037's state as found at slice start.
  If CLO's fix has landed, the tests prove the gate against the fixed
  confirm semantics. If it has not, the tests pin the gate's behaviour
  without assuming the fix — and the slice body says so, so no later
  reader mistakes the un-fixed confirm path for a gate gap.
- The G-1 hole stays open until slice 1 lands (D2, owner's explicit
  choice). #5037's defect stays open until CLO's fix lands. Neither
  wait is the other's: the two landings are independent, sequenced
  only against collision.

#5040 — store architecture (slice 11, §11). Four families each have
more than one store home with no decision stating which is canonical:
schedules (`mas_schedules` D1 + `scheduled_tasks` DO), payments (DO
`mas_transactions` + D1 `agent_payments` — whether both are live, and
which is authoritative, is UNVERIFIED), reports (`mas_reports` DO +
`agent_reports` D1), report assets (three homes), plus the KV fallback
shape. Decision-first: CLO owns the decision, then the fix. CBO
consequences:

- Slice 11 (G-10 remediation behind ports) builds NO store-architecture
  decision. It remediates reach-through behind the EXISTING ports
  (§11) and follows CLO's decision once made; until then it sequences
  around #5040 and touches no canonical-home question.
- The journal projection posture in this design (DO authoritative,
  ADR 0033; D1 journal as projection, §11) is stated as ADR 0033
  states it. Nothing here assumes #5040's answer: if CLO's decision
  changes the authoritative-home picture for payments, the affected
  slices follow the decision — a follow-up, not a local override.
- The D1 `agent_payments` / DO `mas_transactions` duality is NOT
  resolved by any CBO slice. A slice that finds itself depending on
  the answer stops and sequences with #5040.

#5038 — tenant isolation (slice 2, boundary only). Four gaps, each a
different shape, decision-first: the append-substrate isolation
question (`SessionStore.appendAuditEvent`, `agentAuditLog`), the
job-pipeline tables with no tenant column, `mas_events` with no tenant
column, and SessionStore's 27 tables with no tenant column. CLO owns
the decision and the fix. Slice 2's scope is deliberately narrower:
derive `tenantId` from resolved session identity in the lifecycle
preference routes, and nothing else. Slice 2 touches NO substrate,
job-pipeline, `mas_events`, or SessionStore code; if its builder finds
the lifecycle fix depending on one of those gaps, the slice sequences
with #5038 instead of widening. The session-scoping rule (D1) stands
independently of #5038's decision.

#5041 — MCP registry completeness (GAP-4, §14.7). Three gaps: the
sync-set allowlist has no completeness pin (`SYNCHRONOUS_MCP_TOOLS`,
`src/mcps/asyncJobModes.ts:301` — a new tool silently queues), paid
tools that queue still charge (whether any paid tool is currently
queued is UNVERIFIED; the guarantee is missing), and the generic
table-read tools expose arbitrary table reads with no gating
(including `mas_events` and `mas_transactions`). CLO owns the fix,
coordinated with CISO #3748's MCP scoping/security programme — which
is not CBO's scope either. CBO consequences:

- GAP-4 (the role-to-scope seam) plugs the adapter into the ADR 0012
  seam and replaces permissive defaults with role-derived scopes. It
  builds NO sync-set pin, NO queueing/charging guarantee, and NO
  table-read gating. Those are #5041's.
- MCP-adjacent slices coordinate with #5041's state at slice start
  (§16.2) and sequence around in-flight registry work. The one-registry
  consolidation (#5386) is the shared-server work; #5041's
  completeness fixes land in it or alongside it under CLO ownership,
  never inside a CBO slice.

### 16.4 Boundaries

- #5023 owns the system data model and its 23 sub-issues. #5343 owns
  the commercial-surface design + ADR and its slices. Neither lane
  folds the other's work into its own issues.
- The CLO issues are linked as Related/Dependencies wherever this
  design overlaps them (§10 slice rows, §13, D13). Linking is
  coordination, not ownership: a link never authorizes building the
  linked fix.
- If a CBO slice discovers a data-model defect beyond the four
  (including among the other 19 sub-issues), it files or links a
  CLO-lane issue and sequences — it does not fix it in passing. One
  implementation owner per issue, per the cross-lane rule.
