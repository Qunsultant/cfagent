# ADR 0034: CBO API layer — one security model, one catalog, one auth module

- Status: Accepted (owner decisions recorded 2026-11-18)
- Date: 2026-11-18
- Deciders: owner (Mars); #CBO-mlops (author, issue #5343)
- Issue: #5343
- Implementing PR: this PR (number and main commit recorded on merge)
- Design doc: `docs/architecture/application/cbo-api-layer-design.md` (the full
  record: inventory, decision table, standards matrix, gateway rollout,
  mapping and granularity policy, slice plan)
- Extends: ADR 0002 (port-first data foundation), ADR 0012 (MCP tool
  permissions), ADR 0032 (Drizzle D1 / mini-ORM DO data-access standard),
  ADR 0033 (cross-store consistency contract)
- Related: #1024 (repo-wide framework-adapter design — boundary in D6),
  #945 (IAAA epic, CISO-owned), #2846 (commercial URL catalog),
  #1185 (service identity), #4282 (DDL catalogues), #3515 (module logger
  seam), #2218 (platform management program, parent), #2012
  (commercialization program), #4514 (BizCopilot — MCP tools reuse these
  routes), CISO coordination issues #5348 (money/ledger permission),
  #5349 (system-principal binding), #5350 (PDP + ExecutionContext wiring
  seams), #5387 (one API server, CDO lane), #5386 (one MCP server, CDO
  lane), #5277 (Docker/portability shape, CAIO lane — owner of the
  container shape #5387 requires the server to fit), #5023 (system data
  model, CLO lane) + #5037/#5038/#5040/#5041 (adjacent CLO sub-issues —
  coordination in D13; CBO builds none of them)
- Amendment 2026-11-18 (same day, before any slice builds on this ADR):
  D11 records the owner one-server alignment directive (see D11). D1–D10
  stand as decided; where D11 supersedes part of D4/D7, D11 says so
  explicitly. Amending PR: this PR (number and main commit recorded on
  merge).
- Amendment 2026-11-18 (same day, before any slice builds on this ADR):
  D12 records the owner canonical-endpoints directive (one MCP server
  at `https://mcp.openaimp.com/mcp`, one API server at
  `https://api.openaimp.com/api`). D1–D11 stand as decided; D12 fixes
  the hostnames the shared servers answer at and the mechanics of
  getting there. Amending PR: this PR (number and main commit recorded
  on merge).
- Amendment 2026-11-18 (same day, before any slice builds on this ADR):
  D13 records the CLO coordination flag (parent-verified 2026-11-18):
  CBO sequences around the CLO-owned data-model issues #5023 and its
  adjacent sub-issues #5037/#5038/#5040/#5041, building none of them.
  D1–D12 stand as decided. Amending PR: this PR (number and main commit
  recorded on merge).

## Context

The CBO commercial/platform HTTP surface grew slice by slice with no
designed API layer. The 2026-11-18 parity inventory (basis `cd094b6f`)
verified the shape: 150 CBO-scope routes in 12 groups, served by a
hand-rolled dispatcher (sequential if-chains plus a path-only catalog),
authorization gates re-implemented per route file, no shared request
validation, no shared schemas, and one handler module
(`src/agents/routes/agenticPayments.ts`, 9,043 lines measured on the
design base `46b6537d6`) mixing routes, services, and store access.
There is no router dependency, no versioning, and no designed
domain-to-module-to-API mapping: 104 discrete user flows, a 21-domain
issue taxonomy (D-1–D-21, a classification taxonomy, not a code
structure), and fine-grained action/RPC-style granularity (one POST per
action; composition lives in the caller).

The inventory ranked 15 gaps (G-1–G-15). The most consequential is G-1:
the three ledger write-through routes (`POST .../ledger/record`,
`record-cfpay`, `record-native`, `agenticPayments.ts:508–763`) contain no
handler authorization check and trust body `userId`/`tenantId`/`priceUSD`.
Re-verified on the design base: the range 508–763 contains no gate
reference at all. The dispatcher blocks anonymous callers only
(`src/server/routes/platform.ts:472–479`: `requireAuth`, then
`x-user-login` minted from `session.githubLogin`), so the exposure is
any-authenticated-user, not anonymous.

The owner direction (2026-11-18) is: build the best designed API layer,
fully AOP-compliant and fully ADD.md-compliant, holistic, reusing /
enhancing / optimizing / extending before creating anything new, under
ONE security model with no new, parallel, or duplicate mechanism, and
following CDO's ORM and adapter approach on the data side. Design + ADR
first, then slices.

Two corrections to the record this ADR rests on. First, there is no
single ENFORCED security model today: there is one DESIGNED model
(IAAA) with staged, incomplete enforcement. This ADR does not claim
otherwise; the layer wires the existing IAAA modules into live
enforcement. Second, the parity inventory's §G rule citations to three
ADRs and four standards files were verified wrong on 2026-11-18. This
ADR and the design doc cite only sources re-verified from the files at
the design base; every rule is re-derived from a real source (see the
design doc §9).

## Decision

### D1 — One designed security model: IAAA, reused and enhanced

The API layer wires the existing IAAA modules into live enforcement for
CBO routes. It redesigns no policy, adds no handler-gate N+1, and builds
no CISO-owned piece. The inventory, verified 2026-11-18 and recorded in
full in the design doc §2, is:

- Identity: IAAA Slice 1 `(issuer, subject)` to stable internal id
  (`src/security/identityBinding.ts`); sessions carry `internalUserId`
  (`docs/architecture/security/authn.md`); the dispatcher mints
  `x-user-login` only from the verified session
  (`platform.ts:472–479`); `SERVICE_USER_LOGIN` via `getServiceUserLogin`
  (`src/security/serviceIdentity.ts`, #1185) for unattended work only,
  fail-closed when unconfigured; per-user API keys, `cfk_` prefix
  (`src/security/apiKeys.ts:32`).
- APIs: dispatcher session gate plus per-file handler checks today;
  `authorize()` in `src/security/authorization.ts` is pure policy,
  deliberately not live enforcement, called by no route handler (the PDP
  seam `src/security/iaaaPdpSeam.ts:51` `checkPermission` wraps it via
  `authorizeWithPolicy`). The 17 permissions in `PERMISSIONS`
  (`authorization.ts:62–80`) include no money/ledger/commercial
  permission. Live enforcement for service actors is
  `enforceServiceDispatch` (`src/security/serviceDispatch.ts`, #2331
  slice 2): service-ness by equality with the configured login plus a
  live platform-scope member binding — a membership check, deliberately
  not `authorize()`.
- MCPs: ADR 0012 port-first permissions — six scopes
  (`src/mcps/openaimp/mcpPermissionPorts.ts:96–101`), one scope per tool,
  `executeWithPermissionGate` authorizes before execution. Defaults are
  permissive (system/session/api-key/agent-turn principals hold every
  scope); the IAAA role-to-scope adapter is an explicitly future seam
  (`mcpPermissionPorts.ts:508`).
- Agents: `createAgentPdpChecker` in `src/security/agentAccess.ts`
  (#2171); `ExecutionContext` (`src/security/executionContext.ts:74`,
  #1078) as the one validated context contract, with live wiring
  deliberately staged; G-AUD-3 (system-principal login threading)
  explicitly not closed.

The five verified gaps are closed by enhancement slices on the existing
modules (GAP-1 PDP wiring, GAP-2 money/ledger permission, GAP-3 system
principal, GAP-4 MCP role-to-scope seam, GAP-5 ExecutionContext wiring),
coordinated via the CISO issues #5348/#5349/#5350 with CISO review on the
enhancement PRs. Waiting applies only on a real collision with in-flight
CISO work, never as the default. CISO decides the permission name and
bindings; CBO invents no policy.

The session-scoping rule stands (owner correction 2026-10-29): scope
always derives from the verified session identity, resolved server-side;
client-supplied `tenantId`/`userId` are untrusted input, never identity.

### D2 — No interim fix for G-1; the hole stays open until the full fix lands

Owner decision, stated plainly: "fix it fully and holistically... no
interim solution." No dispatch-gate interim ships, ever. The G-1 hole
stays open until the IAAA-conformant ledger gate slice lands, sequenced
after the gap-closing foundation (GAP-1–GAP-5). That is the owner's
explicit choice, recorded here so no later reader mistakes the open hole
for an oversight. The ledger gate slice changes no write path: it gates
the handlers in place, consulting the PDP through the seam for the
money/ledger permission over the system actor's binding.

### D3 — One catalog, one auth module, one validation helper

- The catalog: extend the existing `src/data/commercialUrlCatalog.ts`
  (#2846) to the platform families and pair it with shared
  request/response schemas. The route-to-role registry idea is REJECTED
  (owner): no registry, no new auth scheme, no API-key layer for CBO
  routes, no parallel gate.
- The auth module: hoist the per-file gates (`commercialLogin` /
  `isStoreOperator` / `canAccessAccount`, `agenticPayments.ts:841/875/907`,
  plus the re-implementations in the platform route files) onto one
  shared module over the existing IAAA modules. The shared module
  consolidates; it invents no new gate.
- The validation helper: one shared request-validation helper extending
  the existing validators `validateProfileInput`
  (`src/services/userProfile.ts:151`) and `validateStrictAuditWrite`
  (`src/config/restTwinsModes.ts:250`), on zod schemas once Hono lands
  (D5). The lifecycle preference routes
  (`agenticPayments.ts:8761–8815`) are fixed in the same motion to derive
  `tenantId` from resolved session identity, never from query/body.
- Errors and logging follow the existing mechanisms: the outcome catalog
  (`src/outcomes/outcomeCatalog.json` + `src/outcomes/outcomeAspects.ts`,
  `codedMessage` at `outcomeAspects.ts:136`, `codedOutcomeResponse` in the
  handler) for coded errors, the module logger seam
  (`src/observability/structuredLogger.ts`, #3515) for logging, the D1
  batch leg (`d1BatchTransactionBackend`,
  `src/aspects/transactionAspect.ts:390`) for multi-write atomicity, and
  the OpenAPI spike (`src/security/openapiSpec.ts`, #1024 Phase 1)
  extended for CBO routes only.

### D4 — FOSS-first, with the existing capability always winning

Selection rule (binding, owner): best-fit FOSS first for every
layer/component; custom code only where no best-fit FOSS piece exists,
with the gap documented. Guardrail (unchanged): an existing working repo
capability always wins over both FOSS-new and custom-new — a FOSS piece
that duplicates an existing repo capability is out. No auth framework,
no sidecar gateway. The decision table with versions, rationale, and
rejected alternatives is in the design doc §3; the decided pieces are:

- Routing: Hono 4.13.19 (MIT), used fully — routing + middleware +
  ecosystem, not a shim (D5).
- Validation: zod (already a dependency, `^4.1.8`) +
  `@hono/zod-validator` 0.9.1.
- Tokens/JWT: jose 6.2.17 behind a token-verification port — chosen over
  Hono's built-in JWT middleware (recorded algorithm-confusion history,
  minimal JOSE coverage, Hono-coupled).
- OpenAPI generation: chanfana 3.4.0 (Cloudflare, `fromHono` wrapper)
  over `@hono/zod-openapi` 1.6.3 — the incremental strangler fit wins.
- OAuth 2.1 provider: `@cloudflare/workers-oauth-provider` v1.2.4
  evaluated, NOT adopted in v1 — issuance is a future surface (own issue
  plus the owner's call); the validation side is defined now.
  AMENDED BY D11: the piece is OUT for the shared-server role
  (Workers-only + KV-bound); the portable provider is an open survey
  evaluation — see D11.
- Reused, never replaced: zod, Drizzle, MCP SDK, OpenTelemetry, the
  module logger seam, the outcome catalog, the ingress throttle
  (`src/api/ingress.ts` + `src/config/apiIngressModes.ts`), the audit
  funnel, IAAA, and the CDO ports/adapters.

Versions are the evaluated baseline of 2026-11-18. Each slice re-verifies
the latest at build time and records the pinned version; "latest/fastest"
is judged at slice time, never assumed from this ADR. Hono v5
(5.0.0-rc.1) is rejected as pre-release; re-evaluate at GA.

JWT is adopted for stateless tokens only, with exactly three roles
(design doc §5): R-JWT-1 service-to-service, R-JWT-2 MCP resource-server
access tokens (RFC 9068 + DPoP), R-JWT-3 delegation exchange (RFC 8693).
Explicitly out: browser sessions (IAAA stays), `cfk_` user keys
(stateful, 0ms revocation), webhook HMAC, cfagent-minted ID Tokens.

All associated standards are adopted and mapped per surface in the
design doc §6 (JOSE RFC 7515–7518, JWT RFC 7519, OAuth 2.1 + OIDC Core,
RFC 9068, PKCE, DPoP, mTLS-bound tokens RFC 8705, introspection RFC 7662
+ revocation RFC 7009, PAR, RAR, token exchange RFC 8693, AS metadata
RFC 8414, protected-resource metadata RFC 9728, JAR RFC 9101). No blanket
adoption, no silent skips: every N/A carries a reason, and where a
decided FOSS piece lacks a required standard at adoption time, the slice
documents the gap and the adoption decision returns to the owner.

### D5 — Hono fully, sequenced after the #1024 Phase 2 adapter design

The framework CHOICE is settled by the owner (Hono, fully). The
repo-wide adapter design and strangler pattern stay #1024's (CEO lane):
H-0 is the #1024 Phase 2 dependency; H-1 is the CBO foundation slice
following that design (Hono app behind the gateway port, pilot family,
dual-run, identity-stripping middleware first, catalog parity tests);
H-2..H-n migrate families money-first; H-last decommissions the if-chain
only when the catalog proves full coverage. Handlers stay portable — no
Hono imports in handler logic; Hono is the adapter. Ports/adapters is
the repo's own pattern (ADR 0002): the gateway is a port in `src/` with
Worker + in-memory adapters, and FOSS libraries plug in behind the port.
No library supplies "ports/adapters for Cloudflare."

### D6 — The #1024 boundary

This design keeps the hand-rolled router until the Hono migration slices
run, extends the #1024 Phase 1 spike module for CBO routes only, and
keeps handlers portable per the #1024 Phase 0 direction. It does not fork
the #1024 design and does not fold #1024 work in. If Phase 2 has not
landed, the H-1 foundation slice sequences after it (dependency, not
fork).

### D7 — Cloudflare API Shield schema validation on the free tier, with ports/adapters

Owner decision: use API Shield schema validation on the free tier,
configured as code (Terraform provider or Cloudflare API calls in CI/CD,
versioned in the repo, applied post-build). Free-tier facts as verified
from Cloudflare's own docs and blog on 2026-11-18: 100 saved endpoints,
5 uploaded schemas enabled for validation, 200 KiB schema size,
Block-only action (no Log mode); JWT validation + discovery are
Enterprise-only and out; mTLS with the Cloudflare-managed CA is on every
plan; 1 rate-limit rule. One OpenAPI spec artifact (generated by chanfana
from the zod schemas, feeding the `openapiSpec.ts` extension) drives both
the edge validation and the in-Worker zod schemas — derive, don't
duplicate. Rollout is money paths first, split into at most 5 schemas per
family, with a staging validation step BEFORE enabling Block on any
endpoint (Block-only means no log-first mode on Free). Edge validation is
shape/schema only; authorization stays in-Worker — the gateway never
replaces handler authorization. AMENDED BY D11: the gateway is an
OPTIONAL edge adapter only — the server is fully functional without it,
and no slice may depend on edge validation being present.

REQUIRED, UNPERFORMED: dashboard verification. The free-tier limits and
that schema validation is enabled for the zone must be confirmed in the
Cloudflare dashboard during design — one third-party summary disagrees
with the docs, and the dashboard is the authority. This check was NOT
performed: the design author had no dashboard access. STOP rule: if the
dashboard contradicts the docs, report the exact requirement; a plan
decision is the owner's, not a code decision. No slice enables Block on
any endpoint until the dashboard check is recorded. See design doc §7.

### D8 — CDO data approach (binding)

ADR 0002 port-first (R1: domain code depends only on interfaces in
`src/data/*`; R2 dialect isolation; R3 portable versioned migrations; R5
projection-write contract). All data access goes through ports in
`src/data/*` with Drizzle D1 + in-memory adapters behind composition
roots (exemplar: `NativeLedgerPort` + `D1NativeLedgerAdapter` +
in-memory adapter + `createNativeLedgerPorts.ts`, #2192). Handlers never
touch the ORM directly. The `mas_*` DDL single source is
`src/data/schemaComponent/ormCatalogue.ts` (#4282 P2a) — the path
`src/data/ormCatalogue.ts` does not exist. D1 migration text lives in
`src/data/schemaComponent/d1Catalogue.ts`, executed by
`src/data/migrationRunner.ts` (strictly-increasing registry, D1 only,
marker-last, forward compensating migrations only). ADR 0032 names
Drizzle as the D1 standard and the mini-ORM as the DO standard; ADR 0033
states the cross-store consistency contract (idempotent projection
writes, DO authoritative). If a needed port does not exist, extend the
existing port/adapter pattern; never a new data-access pattern, store
client, or DDL site. CDO-owned changes get separate CDO-lane issues. If
any part of the CDO approach is unclear from code/docs, the slice stops
and reports the question — no improvised data pattern.

### D9 — Mapping and granularity policy

The design doc §8 defines the domain-to-module-to-API mapping and the
granularity policy (none exists today). In short: families map to
catalog entries, handler modules, and ports through one mapping table;
granularity stays fine-grained and action/RPC-style (one POST per
action), composition stays in the caller, and new routes enter through
the catalog with schemas. The internal API stays unversioned per
`docs/architecture/code/09-api-standards.md` J7 (additive change +
deprecation discipline; a versioned path family needs its own ADR).

### D10 — Slice plan

GAP-1–GAP-5 (foundation) then hardening slices 1–13 (G-1–G-15) then
Hono migration slices H-1–H-last, each one sub-issue under #5343 and one
PR, queue merge, §18 receipts on the landing SHA. The full plan with
reuse evidence per slice is in the design doc §10. AOP aspects and ADD.md
are binding on every slice; each slice's completion note states its
compliance evidence.

### D11 — One shared server alignment (amendment 2026-11-18, owner directive)

ONE API server, ONE MCP server, both secure, ONE security model. The
CDO filings #5387 ("One API server", open, #CDO-mha7) and #5386 ("One
MCP server", open, #CDO-mha7) — both read live by the amending author
2026-11-18 — define the shared servers. This decision aligns the CBO
API layer with them. It changes no owner decision in D1–D10 except
where it explicitly supersedes a part of D4/D7 below.

- NO SEPARATE CBO SERVER. The CBO API layer is the commercial surface
  ON the one shared servers: the CBO routes land on the one API server
  (#5387: one router, one IAAA middleware chain, one OpenAPI spec, one
  validation layer), and future BizCopilot MCP tools (#4741–#4743,
  file-only, no build directed) register on the ONE registry under the
  ONE IAAA model (#5386) when built. No parallel router, registry, auth
  chain, or validation layer is built by any CBO slice.
- SURVEY-FIRST ALIGNMENT. #5387/#5386 are survey-first: the surveys
  decide the shared-server shape (framework confirmation, registry
  shape, validation-layer home, duplication inventory) against ADD.md
  (and ADR 0012 for #5386). The CBO design CONSUMES and aligns with the
  CDO surveys — it runs no competing framework survey, and the CBO
  framework/library conclusions in D4–D5 are not independent of the
  surveys. The owner decisions (Hono fully, JWT, FOSS-first, standards
  adoption) stand as owner decisions; the surveys confirm and sequence
  the shared-server shape they land in. Where CBO decisions overlap
  survey territory (framework, registry shape, validation-layer home),
  CBO slices sequence after the survey conclusions. #5387 records that
  it follows #5343's Hono decision and does not re-decide the CBO
  surface; #5387's going-in recommendation is Hono, with the survey to
  confirm or pick the better alternative.
- IAAA CHAIN. The CBO IAAA enhancements (CISO #5348 money permission,
  #5349 system principal, #5350 PDP seams) plug INTO the one IAAA chain
  #5387/#5386 define: session, API key, and x402 payment proof resolve
  to IAAA principals (session, api-key, scanner-payment) in one place.
  The ledger gate (D2, slice 1) is enforced through that chain — no
  CBO-only auth path. The paid caller is the scanner-payment principal
  holding only `mcp:payments` (#5386; the permission gate already
  defines the kind).
- PORTABILITY RULE (binding). The shared server runs on Cloudflare
  Workers AND in Docker (multi-cloud, cloud-agnostic, per #5277, which
  owns the container shape); NO new Cloudflare-proprietary API surface
  in the new layer. The standing source is the agentic-SaaS
  cross-cutting rule (cloud-agnostic AND cloud-native; build only on
  existing storage seams, no new cloud-proprietary API surface) plus
  the owner's 2026-11-18 direction — #5387 verified the requirement is
  NOT in ADD.md. Per decided piece:
  - Hono: portable (Web-standards runtime API) — COMPLIANT.
  - zod, OpenTelemetry, Drizzle, MCP SDK: portable — COMPLIANT.
    Drizzle stays behind the CDO ports/adapters (D8); the store behind
    a port is what makes the Docker shape possible.
  - jose: portable (zero-dependency ESM) — COMPLIANT.
  - chanfana: generates the spec from zod schemas; the artifact is
    portable — COMPLIANT, with the survey confirming the generator
    choice for the one spec.
  - Cloudflare API Shield (D7): stays ONLY as an OPTIONAL edge adapter
    — config-as-code, never a required dependency. The server must be
    FULLY FUNCTIONAL without it. D7 is amended accordingly: the gateway
    is an edge adapter that may validate shape where deployed, never a
    layer the server depends on. The dashboard-verification requirement
    and STOP rule in D7 stand unchanged.
  - `@cloudflare/workers-oauth-provider`: OUT for the shared-server
    OAuth-provider role — Workers-only and KV-bound, which violates the
    portability rule. This SUPERSEDES the D4 evaluation entry (which
    recorded it as evaluated-not-adopted): it is not adopted in any
    future issuance surface for the shared server either. The portable
    OAuth-provider piece is an OPEN SURVEY EVALUATION: the requirement
    is runtime-agnostic, store behind the existing port/adapter
    pattern, OAuth 2.1 + OIDC, PAR/RAR/DPoP per the standards matrix.
    No replacement library is named here — naming one without
    verification would repeat the error this amendment corrects; the
    survey evaluates candidates. Issuance remains a FUTURE surface (own
    issue + the owner's call). The validation side (RFC 9728, jose,
    the token-verification port) is unaffected.
- SHARED VALIDATION. The CBO G-4 zod schemas land in the SHARED
  validation layer (door/service layer per #5386), not a CBO-only
  layer. The #5387 duplication inventory governs; CBO slices
  consolidate into it (one implementation per rule, called by all
  surfaces). Slice 3's shared helper is the CBO contribution to that
  layer, not a second layer.
- SEQUENCING. CBO slices sequence WITH/AFTER the shared-server work,
  never as a competing implementation. GAP-1–GAP-5 plug into the one
  IAAA chain as #5387/#5386 define it; the Hono migration (§4 of the
  design doc) lands the CBO families on the one router. #5387/#5386
  record a dev-work stop blocking building (not the survey) pending
  the owner's resume word; CBO slice builds sequence accordingly.
- SCOPE BOUNDARIES (unchanged). #5277 owns the container shape; #1024
  owns the repo-wide framework-adapter design; #5386 owns the MCP
  consolidation; #5387 owns the whole-layer consolidation including
  data endpoints. #5343 owns the commercial-surface design + ADR and
  its slices. Nothing in D11 folds another lane's work into CBO issues.

### D12 — Canonical endpoints (amendment 2026-11-18, owner directive)

HARD design constraints, fixed by the owner 2026-11-18 09:08 EST. The
one MCP server answers at `https://mcp.openaimp.com/mcp` (CDO #5386);
the one API server answers at `https://api.openaimp.com/api`, base
path `/api` (CDO #5387). These are the two single canonical URLs,
replacing the current `/mcp`, `/api/mcp`, `/mcp/scanner` paths on the
main domain and the scattered API entry points. The full record —
transport, collapse mechanics, CORS/cookie policy, routing mechanism,
prerequisites, and the required DNS check — is design doc §15.

- MCP TRANSPORT (verified, not invented). The canonical endpoint keeps
  the transport the MCP server already implements: Streamable HTTP —
  the SDK low-level `Server` composed with
  `WebStandardStreamableHTTPServerTransport` in the stateless idiom
  (`sessionIdGenerator: undefined`, `enableJsonResponse: true`),
  JSON-RPC 2.0 over HTTP
  (`src/mcps/openaimp/handler.ts`, issue #2494;
  `@modelcontextprotocol/sdk` 1.32.2). No transport change.
- SCANNER COLLAPSE BY PRINCIPAL, NOT BY PATH. The scanner surface
  collapses into the one endpoint: scanner access is distinguished by
  the PAID PRINCIPAL (the IAAA scanner-payment principal, holding only
  `mcp:payments`), never by a separate path or server. The one
  registry serves all tools; scope denial pins the paid principal to
  the scanner tools. The scanner keeps exactly its current tool set
  and price ($0.05); tool behaviour is unchanged.
- PATH-COLLAPSE MECHANICS (settled by the design; no silent breakage).
  (1) The canonical endpoint goes live. (2) Dual-serve window: the old
  paths (`/mcp`, `/api/mcp`, `/mcp/scanner*` on the main domain; the
  `/api/*` and bare-alias API paths on the old host) keep serving with
  a `Deprecation` response header and a published migration note; the
  window length is operator configuration decided at cutover — the
  design requires a window, the length is an operator call recorded in
  the cutover slice, never a hard-coded constant. (3) Redirect: old
  paths answer 308 Permanent Redirect to the canonical URL (308
  preserves method and body for POST JSON-RPC). (4) Removal only on an
  explicit owner call after the window and redirect phases. The
  scanner path carries a verification gate: whether a 308 preserves a
  valid x402 payment is verified by the cutover slice against the x402
  implementation BEFORE redirect is enabled for `/mcp/scanner`; if
  verification fails, the scanner path dual-serves until clients
  migrate, with no redirect. Existing clients (the in-app explorer,
  API-key scripts) re-point via configuration, never by a hard-coded
  URL change.
- API BASE AND SPEC PATHS (settled by the design). The canonical URL
  of a route is its catalog path on the new host
  (`https://api.openaimp.com` + catalog path). The router strips the
  `/api` base before dispatch — the mechanism the dispatcher already
  uses (`platform.ts:476,504`, `subPath` strip) — so handlers see the
  same suffixes and the move changes NO handler logic. The ~80 handler
  files move by the route-table mapping (§8 of the design doc): every
  catalog route maps to exactly one canonical URL. Bare aliases
  (`/payments/...`, `/trading/...`) are NOT canonical on the new host;
  the canonical form is the `/api` twin. The OpenAPI spec is served
  FROM the API server at `/api/openapi.json`, with the Swagger UI at
  `/api/docs` — today's relative names (`core.ts:136`) under the new
  base. The OAuth metadata well-known paths (RFC 8414, RFC 9728) are
  the only root-level paths on the API host; everything else lives
  under `/api`.
- CORS / ORIGIN POLICY (settled by the design; the same-origin
  assumption ends). Today the client uses relative `/api` fetches and
  CORS is per-branch `Access-Control-Allow-Origin: *` with no
  credentials. The decided policy: allowed origin exactly
  `https://agent.openaimp.com`, held in operator configuration; the
  server echoes that single origin with credentials (never `*` with
  credentials — browsers forbid it) and `Vary: Origin`; ONE preflight
  handler in the Hono chain (Hono's CORS middleware), with allowed
  methods/headers derived from the one OpenAPI spec, never a second
  list; the MCP host additionally carries the x402 payment headers.
  The session cookie gains `Domain=.openaimp.com` (same-site;
  `SameSite=Lax`, `Secure`, `HttpOnly` retained) so the app's session
  carries to the API subdomain — today the cookie is host-only
  (`session.ts:106`, no `Domain` attribute) and would not be sent.
  The cookie change lands in the cutover slice, CISO-reviewed: it
  widens cookie scope to all `openaimp.com` subdomains including the
  MCP host, stated explicitly; the MCP host's IAAA chain gates every
  call, and the cookie alone never authorizes a scanner-principal
  call.
- ROUTING + PREREQUISITES (build scope). The DNS/custom-domain/route
  setup is part of the build scope. The mechanism, verified from repo
  config, is the `wrangler.jsonc` `routes` entry with
  `custom_domain: true` — the precedent is the single existing entry
  `agent.openaimp.com` (`wrangler.jsonc:27`), deployed by
  `npx wrangler deploy`. Each subdomain is added as such an entry; the
  Docker shape's ingress is #5277's (no Dockerfile exists in the repo
  at the amendment base). Whether the two hostnames bind one Worker or
  two is settled by the #5387/#5386 surveys, constrained: both answer
  from the one router / one registry, no forked code. Prerequisites
  before either hostname can answer: a DNS record in the
  `openaimp.com` zone, an active custom-domain binding, a matching
  route pattern, and active (Cloudflare-managed) TLS. REQUIRED,
  UNPERFORMED: the authoritative dashboard check (Cloudflare
  dashboard DNS + custom-domain state for the zone) — same STOP rule
  as D7. A probe of `api.openaimp.com` from proxy DNS is a hint only,
  not evidence of public DNS; this ADR claims nothing about DNS
  existence from it. No cutover slice enables the hostnames until the
  check is recorded with evidence.
- GATEWAY NOTE. The `api` subdomain is a separate hostname in the same
  zone; API Shield endpoints are per-zone, so the api hostname shares
  the zone's 100-endpoint / 5-schema budget with the main hostname.
  The D7 rollout budget covers both hostnames combined, and the
  endpoint inventory lists host + path. No dashboard state is claimed;
  the D7 dashboard check confirms the zone setup including the new
  hostname.

### D13 — CLO coordination: sequence around the data-model issues (amendment 2026-11-18, parent-verified flag)

Issue #5023 "[Data model] System data model" is CLO-lane owned
(`lane:clo-arsi`) with 23 sub-issues, ALL CLO-lane, ALL open — verified
by the amending author 2026-11-18 via the sub-issues API. CBO works on
NONE of them. Four sub-issues are adjacent to the API-layer/ledger
work (all verified open, all `lane:clo-arsi`, by direct read
2026-11-18). The CBO design SEQUENCES AROUND them — linked as Related
/ Dependencies, never built, never duplicated, never pre-empted. The
full record is design doc §16.

- #5037 "[Fix] Payment confirm reports success when the ledger write
  fails" — high-severity integrity defect, SAME code neighborhood as
  the G-1 ledger fix: `confirmDraft` (`src/agents/mas.ts:275–385`)
  swallows the `findById` failure, executes the gateway charge/refund,
  swallows the `transactions.update` failures, and writes the
  `payment.confirmed` / `payment.rejected` audit entries regardless —
  a payment can be charged while the ledger never records it. CLO owns
  the fix. The ledger-gate slice (slice 1, D2) accounts for it and
  sequences around CLO's fix: the gate slice gates the write-through
  routes only and fixes NOTHING in `confirmDraft`; at slice start it
  re-verifies #5037's live state, and if CLO's fix is in-flight the
  slice waits/sequences rather than colliding on the shared ledger
  neighborhood. The gate slice's tests account for #5037's state as
  found at slice start (see §16.3).
- #5040 "One store per family: schedules, payments, reports, report
  assets — decision first" — overlaps the journal/ledger store
  architecture: which home is canonical per family is UNVERIFIED,
  including whether both payment ledgers (DO `mas_transactions` + D1
  `agent_payments`) are live and which is authoritative. Decision-first;
  CLO owns the decision and the fix. CBO builds NO store-architecture
  decision: slice 11 (G-10 remediation behind ports) and the journal
  projection posture follow CLO's decision once made, and sequence
  around it until then. Nothing in this ADR assumes the answer beyond
  what ADR 0033 already states.
- #5038 "Tenant isolation gaps: substrate, job pipeline, mas_events,
  SessionStore" — decision-first, then the fix; CLO owns both.
  Overlaps slice 2 only at the boundary: slice 2 fixes the lifecycle
  preference routes to derive `tenantId` from resolved session
  identity and touches NOTHING in the substrate, the job-pipeline
  tables, `mas_events`, or SessionStore. Coordinate, never build the
  CLO fix.
- #5041 "MCP registry completeness: sync-set pin, paid-tool queueing,
  and table-read gating" — overlaps the one-MCP-server work (#5386)
  and the GAP-4 seam: the sync-set allowlist, the queued-paid-tool
  charging guarantee, and the ungated table-read tools. CLO owns the
  fix (coordinated with CISO #3748's programme, which is not CBO's
  scope either). CBO builds no registry-completeness fix; MCP-adjacent
  slices coordinate and sequence around it.

SEQUENCE RULE (binding). If any of the four is in-flight in CLO, the
overlapping CBO slice waits/sequences — never collides, never
duplicates, never pre-empts. "In-flight" means an open CLO claim,
branch, or PR touching the shared modules, as found by the live check
below — not merely an open issue. An open-but-unclaimed CLO issue does
not block a CBO slice; an in-flight one does, until it lands or the
lanes agree a sequence in the open.

SLICE-START RE-CHECK (standing requirement, not a design-time note).
Every slice builder re-checks for in-flight CLO work on the shared
modules at slice start — live issue state + open branches/PRs touching
the modules the slice will touch — before claiming or building, and
records the check (date, issues checked, result) in the slice's claim
or body. The check is repeated if the slice stalls: a check from
design time never substitutes for a check at build time.

## Consequences

- The G-1 hole stays open until the full fix lands (D2). No interim gate
  closes it sooner. Any reader, reviewer, or auditor must treat the open
  hole as the owner's explicit, recorded choice — not as a missed fix.
- CBO builds no CISO-owned enforcement: the money/ledger permission, the
  system-principal binding, and PDP route wiring advance only through the
  CISO coordination issues with CISO review. CBO enhancement slices
  proceed on the CISO-owned specs; a real collision sequences the work,
  never a parallel mechanism.
- The Hono migration cannot start before #1024 Phase 2 lands (H-0). The
  design, the GAP slices, and the hardening slices proceed independently
  of it.
- No slice enables API Shield Block until the dashboard verification (D7)
  is recorded. If the dashboard contradicts the documented free-tier
  limits, the rollout plan returns to the owner for a plan decision.
- Every slice re-verifies FOSS versions at build time; the versions in
  this ADR are a dated baseline, not pins.
- The catalog becomes the choke point for new routes: a route with no
  catalog entry and no schema is a review finding, not a local choice.
- Handlers stay portable behind the gateway port, so a future framework
  change re-touches adapters, not handler logic.
- Docs-only consequence: this ADR + the design doc change no runtime
  behavior, no UX surface, and no data. Slice PRs carry their own
  behavior, pins, and §18 receipts.
- Alignment consequence (D11): no CBO slice builds a second router,
  registry, auth chain, or validation layer; the CBO surfaces land on
  the shared servers. The API Shield gateway is optional — a deployment
  without it is fully functional, and no slice may depend on edge
  validation being present. The OAuth-provider piece for any future
  issuance surface is undecided pending the survey evaluation; no slice
  names or adopts a provider library before the survey concludes. CBO
  slice builds sequence with/after the shared-server surveys and the
  resume word recorded in #5387/#5386.
- Endpoints consequence (D12): the shared servers answer only at the
  canonical hostnames. No cutover slice enables either hostname until
  the DNS/custom-domain dashboard check (§15.5 of the design doc) is
  recorded. Old paths are never removed silently: dual-serve window,
  then 308 redirect, then removal only on an explicit owner call. The
  session-cookie `Domain` change is a CISO-reviewed cutover item, not
  a silent config tweak. The API Shield budget (§7) covers both
  hostnames combined.
- CLO consequence (D13): no CBO slice builds, duplicates, or pre-empts
  a CLO-owned fix. A CBO slice overlapping in-flight CLO work waits or
  sequences; the slice-start re-check is a standing requirement on
  every slice builder, and a design-time check never substitutes for
  one at build time.

## Alternatives considered

- **Route-to-role registry** (floated by the inventory as genuinely
  new): REJECTED by the owner. Replaced by extending the existing
  `commercialUrlCatalog`. A registry would be a second authorization
  mechanism beside the PDP.
- **Dispatch-gate interim for G-1** (an in-file operator gate closing
  the hole before the foundation lands): REJECTED by the owner ("no
  interim solution"). The full IAAA-conformant fix is the only fix.
- **New auth scheme / API-key layer for CBO routes / parallel gate**:
  REJECTED by the owner. One security model; the existing mechanisms are
  enhanced, never paralleled.
- **itty-router / hand-rolled dispatch / Hono v5**: settled by the owner
  decision for Hono fully (D5); v5 rejected as pre-release.
- **Hono's built-in JWT middleware as the verifier**: REJECTED (recorded
  algorithm-confusion history, minimal JOSE coverage, Hono-coupled).
  jose verifies behind the port; a thin Hono middleware calls the port.
- **`@hono/zod-openapi` for OpenAPI generation**: REJECTED in favor of
  chanfana — the `fromHono` wrapper extends the existing app without
  touching old routes (strangler fit); hand-written OpenAPI was rejected
  as duplicating the zod schemas.
- **Sidecar gateways (Kong, Envoy, Tyk, APISIX, KrakenD)**: REJECTED —
  separate services that duplicate the Worker edge; the gateway IS a
  Worker. The managed edge (API Shield) plus in-Worker enforcement is
  the shape.
- **Auth frameworks / FOSS identity / FOSS logging / FOSS audit / other
  ORMs**: REJECTED — each duplicates an existing working repo capability
  (IAAA, logger seam, audit funnel, CDO adapters). The FOSS-first guardrail
  (D4) excludes them.
- **Building an OAuth authorization server by hand**: REJECTED —
  FOSS-first when the issuance surface is approved; issuance itself is
  deferred to a future surface with its own issue and owner call.
- **A separate CBO API/MCP server** (own router, registry, auth chain,
  or validation layer): REJECTED by the owner one-server directive
  (D11). The CBO surfaces land on the shared servers.
- **`@cloudflare/workers-oauth-provider` for the shared-server
  OAuth-provider role**: OUT (D11) — Workers-only and KV-bound, against
  the portability rule. The portable provider is an open survey
  evaluation; no replacement is named without verification.
- **A competing CBO framework survey**: REJECTED (D11). The CDO surveys
  (#5387/#5386) decide the shared-server shape; the CBO design consumes
  and aligns with them.
- **Keeping the single-host MCP/API paths as canonical**: REJECTED by
  the owner endpoints directive (D12). The canonical URLs are the two
  subdomains; the old paths are a migration surface, never the target.
- **Host-only session cookie + a same-origin proxy for API calls**:
  REJECTED (D12). A proxy reintroduces the single-host coupling the
  split exists to end. The cookie gains `Domain=.openaimp.com`,
  CISO-reviewed.
- **301/302 redirects for the old paths**: REJECTED (D12). Only 308
  preserves method and body for POST JSON-RPC; a 301/302 risks
  downgrading a tool call to a GET.
- **Wildcard CORS with credentials**: REJECTED (D12) — browsers forbid
  `Access-Control-Allow-Origin: *` with credentials. The API server
  echoes the single allowed origin.
- **Building the CLO-owned fixes inside CBO slices** (the #5037
  confirm defect, the #5040 store decision, the #5038 isolation gaps,
  the #5041 registry gaps): REJECTED (D13). Lane ownership is the
  rule: CLO owns them, CBO sequences around them. A CBO slice that
  needs a CLO decision waits for it or sequences with it; it never
  decides it locally.
- **Custom idempotency-key layer**: DEFERRED to slice evaluation —
  adopted only if no FOSS piece fits behind the existing ports, with the
  gap documented; per-subsystem dedupe stays until then.
