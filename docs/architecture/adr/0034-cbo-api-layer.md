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
  seams)

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
replaces handler authorization.

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
- **Custom idempotency-key layer**: DEFERRED to slice evaluation —
  adopted only if no FOSS piece fits behind the existing ports, with the
  gap documented; per-subsystem dedupe stays until then.
