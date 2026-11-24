# Data Studio — read-only data viewer over the data-layer APIs

Scope drafted 2026-11-14 (CDO lane). Status: **scope, not filed, not built.**
Parent: #3774 (Platform of Platforms operator surface — Data Studio is
defined there as "Manage the data foundation and knowledge services",
status Filed, not built). Related: #798 (data programme), #3260
(ADR 0032, mechanism standard), #1546 (D1 projection + MCP read tools).

## The correction this scope rests on

"There are no APIs at all in the data foundation" is **not** true, and
the scope is written against what actually exists. There are APIs at
three layers today:

1. **In-process ports — the CRUD API agents use.** An agent inside a DO
   does not need HTTP or MCP to do CRUD: it calls the port objects the
   composition root wires from its storage handle.
   `src/agents/mas.ts:49` — `createOrmPorts(sql)`; `src/agents/
   orchestrator.ts:2414` — `createOrmPorts(sql).messages.create({...})`;
   `src/agents/orchestrator/chatTurnHelpers.ts:212` —
   `createOrmPorts(sql).memory.listRecent(8)`. The port contract
   (`RepositoryPort`: `findMany` / `findById` / `findOne` / `count` /
   `create` / `update` / `upsert` / `delete`, plus per-family
   extensions like `MemoryPort`'s `clear` / `search` / `listRecent`)
   is the CRUD API, implemented three ways (Drizzle on D1, mini-ORM
   on DO SQLite, in-memory twins) and proven identical by the
   conformance suites. There is no standalone "DataAgent" class in
   the repo — data work happens inside the orchestrator/MAS through
   these ports.
2. **Per-domain REST reads.** `POST /api/memory/search`,
   `GET /api/reports/list`, `GET /api/jobs/history`,
   `GET /api/audit/history`, `GET /api/traces`, `GET /api/agents/
   registry` — each family hand-wired its own endpoint.
3. **Per-domain MCP reads.** Four read-only MCP tools over the D1
   projection (#1697, sub-issue of #1546:
   `src/mcps/openaimp/agentDbReadCommands.ts` — chain status, jobs
   history, audit history, reports list), plus
   `manage_session_memory` for memory. Read-only, projection-only,
   per-domain.

What does **not** exist — and what this scope builds — is a **unified
data-layer API**: one endpoint family covering every port family, so a
DataStudio UI (or any external data agent) can read DO SQLite, D1, and
Vectorize without a new hand-wired route or tool per family. That is
the gap the user named ("not acceptable"), and it is real at this
layer, not at the port layer.

## What exists today for viewing (verified 2026-11-14, main `67a1c0d6`)

- DO SQLite: Memory Browser (session facts via `POST /api/memory/
  search`); per-domain panels for everything else; Data Lifecycle
  panel (clean-state / bootstrap / recreate) plus a pre-wipe export
  bundle (`GET /api/data-lifecycle/export` — a download, not a
  browser). No SQL console in the app.
- D1: no browser UI; server routes read the `AGENT_DB` projection per
  domain. Rows are viewed via wrangler (`d1 execute`) or the
  Cloudflare dashboard.
- Vectorize: nothing to browse, by construction — an index, not a
  table. Recall only (chat turns inject top 8 chunks; messaging
  routes and the report index query it the same way).
- No generic `/:table` rows route exists (verified by grep).

## Issue body (gitops §5 form — file as a sub-issue of #3774)

### Problem

Data Studio is defined in the Platform of Platforms table
(`docs/architecture/agentic/agents-workflows-schedules-queues-
platforms-lifecycle.md`, "Data Studio | Manage the data foundation
and knowledge services | Filed | #3774") and is the operator surface
over §2 area 7's foundation and §12.2's knowledge product — but it
is Filed, not built, and there is no unified read API underneath it.
Each family exposes its own endpoint or tool by hand, so viewing data
means knowing which per-domain surface owns which family, and an
external data agent has no uniform way to read the layer at all.
The in-process port API serves agents inside the DOs; nothing serves
the operator or an external agent uniformly.

### Outcome

A read-only Data Studio (v1): a uniform read API over the port
registry, exposed over REST and MCP, plus the DataStudio UI on the
operator surface, covering DO SQLite, D1, and Vectorize
(recall-only). The operator (and any authorized external agent) can
browse, search, and download any port family's rows without a new
route per family. The data layer gains the API surface the platform
of platforms assumes it has.

### Scope

- **S1 — Uniform read API (REST).** One route family driven by the
  port registry: list / get / search / count per family, paginated,
  tenancy-scoped (login), read-only by construction (GET only; no
  write method on the API surface). Reads go through ports only —
  no SQL above the layer, no raw-table access. Families: the
  mini-ORM DO families first (13 tables + dataset families), then
  the Drizzle D1 families. Vectorize: recall endpoint (query by
  text, top-K) — no listing, by construction.
- **S2 — MCP projection of the same read API.** The S1 read
  operations as MCP tools, following the #1697 pattern (read-only,
  projection-or-port reads, same resolution as the REST routes).
  Extends — never duplicates — the four existing projection tools.
- **S3 — DataStudio UI.** Operator surface (Platform Admin pattern):
  family picker, row table with search + pagination, per-row detail,
  Vectorize recall view (query + top-K chunks), download of the
  result set as a file from the UI surface (per the delivery
  standard: results downloadable as a result set).
- **S4 — Pins.** Tenancy pin (login A cannot read login B's rows —
  the leak that would break DO isolation by construction); read-only
  pin (no write route or tool exists on the API surface — a write
  addition fails CI); exactness pin (the API returns exactly what
  the port returns for the same query — no extra/missing rows).

### Requirements

- Read-only v1 by construction, not by convention: GET-only routes,
  no `create`/`update`/`delete` on the API; the pin enforces it.
- Tenancy: every read is login-scoped; platform scope (cross-login)
  is founder-gated the way the recreate route is (`CLEAN PLATFORM`
  pattern), not silently available.
- No SQL above the layer; no generic `/:table` raw access — the API
  reads through named port families from the registry only.
- Pagination + hard limits on every list (DO/D1 row-read limits);
  bounded search (the `MemoryPort.search` shape, not unbounded
  scans).
- Vectorize is recall-only: query-by-text + top-K; the UI says so
  instead of faking a table.
- Audit: every DataStudio read is attributable (who read which
  family, when) — mechanism decided in S1 (recommendation: the
  existing audit substrate; if it cannot carry read events, that is
  an S1 finding, not a silent skip).
- UI from `src/client/components/ui/` primitives with token-only
  styling (gitops §20 definition of done); no parallel viewer
  implementations — Memory Browser's search becomes a consumer of
  the S1 API, not a second implementation (or is named as the
  exception with its reason).

### Acceptance criteria

- S1: every port family readable through the uniform API; a family
  with no API coverage fails the registry-coverage pin.
- S2: MCP tools return the same rows as the REST routes for the
  same query (one conformance check, both projections).
- S3: a signed-in operator browses a DO family, a D1 family, and a
  Vectorize recall from one surface; the result set downloads as a
  file.
- S4: tenancy pin red on a cross-login read attempt; read-only pin
  red if any write route/tool is added; exactness pin green on all
  families.
- Full suite exact-delta accounting per slice; no new SQL above the
  layer (census surfaces unchanged).

### Test plan

- Conformance: per-family suite asserting API ≡ port for
  list/get/search/count (including empty, boundary, and
  over-limit cases).
- Tenancy: login A vs login B matrix over every family; platform
  scope without the founder gate refused.
- Read-only: static pin over the route/tool registry (no POST/PUT/
  DELETE/PATCH on the data API surface).
- Regression: existing per-domain endpoints unchanged (Memory
  Browser, reports list, jobs history still green).
- Live proof (closes the issue): a signed-in session browses all
  three stores from DataStudio and downloads a result set.

### Dependencies

- #3774 (parent — the Studios epic; this issue is its Data Studio
  slice).
- #3260 / ADR 0032 (mechanism standard — the read API reads through
  the standard mechanisms: Drizzle on D1, mini-ORM on DO).
- #1546 (projection pattern + the four existing MCP read tools).
- #1976 ports (done — the API is a projection of the port layer,
  not a new data layer).

### Rollout

One slice, one PR, merge, post-merge verify — S1 → S2 → S3 → S4.
S1 must land before S2/S3 (they are projections/consumers of it).
Each slice ships independently with its own value + UX harvest
statement in the PR body.

### Risks

- **Cross-login read leak** — the single biggest risk: a uniform
  reader is exactly the surface that could break DO tenancy
  isolation. Mitigated by the tenancy pin + founder-gated platform
  scope, and by scoping every read through the per-login instance.
- **Read limits** — unbounded lists against D1/DO row-read limits;
  mitigated by hard pagination + limits in S1.
- **Vectorize misread as a table** — mitigated by recall-only design
  and explicit UI copy.
- **Scope creep into writes** — v1 is read-only; any write demand
  is a new issue, not an S1 stretch.

### Traceability

- Size: Large. Priority: Medium. (Proposed — the user confirms.)
- Parent: #3774. Related: #798, #3260, #1546.
- #CDO-mha7

## Open decisions for the user (not in the issue body)

1. **Parent:** #3774 (recommended — Data Studio is defined and
   tracked there) vs #798 (data programme epic). The issue is written
   for #3774.
2. **Size/Priority:** Large / Medium proposed. Large because it is a
   new API surface + UI + pins across three stores; Medium because
   the per-domain surfaces already cover the urgent viewing needs
   and this is the unification, not the first viewer.
3. **Read audit mechanism:** S1 decides (audit substrate vs new
   read-event log). If the audit substrate cannot carry read events,
   S1 reports it as a finding.
4. **Memory Browser:** fold it into an S1 consumer in S3, or name it
   as a standing exception. Recommendation: fold it in.
5. **Queue position:** after ADR 0032 ships (#3260) — the read API
   should read through the standard mechanisms, not pre-empt them.
   P6a–d (#4384–#4387) and this issue both depend on #3260; they are
   file-disjoint, so they can proceed in parallel once the ADR
   merges.

## Evidence (verified 2026-11-14, main `67a1c0d6`)

- Data Studio defined: `docs/architecture/agentic/agents-workflows-
  schedules-queues-platforms-lifecycle.md` lines 1357–1400 (Platform
  of Platforms table, #3774; "Filed, not built").
- #3774 comments: empty — no lane claim.
- No `DataStudio`/`data-studio` string anywhere in `src/` or `docs/`
  (grep, 2026-11-14) — greenfield name, no duplicate.
- In-process CRUD: `src/agents/mas.ts:49`,
  `src/agents/orchestrator.ts:2414`,
  `src/agents/orchestrator/chatTurnHelpers.ts:212`.
- Port contract: `src/data/repositoryPorts.ts` (`findMany` /
  `findById` / `findOne` / `count` / `create` / `update` /
  `upsert` / `delete`).
- MCP reads: `src/mcps/openaimp/agentDbReadCommands.ts` (#1697 —
  four read-only tools over the D1 projection).
- REST reads: `POST /api/memory/search`,
  `GET /api/reports/list`, `GET /api/jobs/history`,
  `GET /api/audit/history`.
- No generic `/:table` rows route (grep over
  `src/server/routes` + `src/agents/routes`).
- No `DataAgent` class exists in `src/` (only passing mentions).

## Addendum 2026-11-14 — data products + codegen (user directive)

### Transaction management as an aspect — verified state

Yes, it IS implemented as an aspect: `src/aspects/transactionAspect.ts`
(`withTransaction(backend, context, fn)` over a `TransactionBackend`
with two legs — `DoSqlTransactionBackend` over DO `transactionSync`
and `D1BatchTransactionBackend` over D1 `batch()`; ambient unit via
`AsyncLocalStorage` with a nested join rule; every unit emits a
`TransactionOutcome` code/operation/domain/duration through structured
logging, and emission failure never breaks the unit). It supports the
ADD.md standards shape (`docs/architecture/ADD.md`, Standards
conformance: AOP — Exception Handling, Coded Messages, Logging,
Externalized Configuration, Security, Transaction Management — plus
Contract-First, API-native, and the ACID ilities): one atomic unit per
backend, honest outcome codes, cross-cutting rather than per-adapter.

Two honest limits, both verified: **(a) adoption is partial, not
enforced.** The aspect is used by real adapters
(`createOptionsDiscoveryPorts`, `createUnifiedSchedulePorts`,
`d1ProviderConfigAdapter`, `d1TraceRecordAdapter`,
`doSqliteDiscoveryRunAdapter`, `doSqliteDiscoverySetupAdapter`,
`doSqliteFeedSnapshotAdapter`; tests incl.
`mas_transactions_tenant_3182.test.ts`) — the old "zero usages,
platform proof only" note is stale. But three D1 adapters still call
raw `this.d1.batch(...)` with no aspect import
(`d1ProductBundleAdapter`, `d1ProfileAdapter`,
`d1ProposalLedgerAdapter`), and no pin forces multi-write paths
through `withTransaction`. **(b) a unit spans ONE backend.** There is
no cross-backend (DO + D1) atomicity — a write touching both stores
cannot be one unit through this aspect. Both limits are findings, not
blockers: S4 gains a pin candidate ("all multi-write paths through
`withTransaction`"), and cross-store atomicity is recorded as
out-of-scope for v1.

### Data products — the missing layer (user directive)

Data products are a documented platform concept but have **no code
definition**: `docs/agentic-org/platforms.md` defines the CDO platform
on "DAMA-DMBOK as the foundation; … domain-oriented data products;
provenance and semantic modeling" with artifacts "Catalog; glossary;
lineage graph; data contracts; quality rules; evidence repository"
and measures "freshness, completeness, reconciliation accuracy,
provenance coverage, and retrieval correctness" — but `src/` contains
no `DataProduct` type, no data-contract module, no product registry
(grep, 2026-11-14). Data services exist (`src/services/*` domain
services over ports) and data APIs exist (per-domain REST/MCP), but
nothing binds store + service + API together as a named product.

New requirement, folded into this scope: **every data product is
defined in the data layer with its stores, its APIs, its contract,
its owner, and its quality measures — and DataStudio reads that
definition.** Concretely:

- A product registry in code (one module, the single source of truth):
  each product names its port families, the stores behind them
  (DO SQLite / D1 / Vectorize / R2 / AI Search), the API surface
  over them (S1 REST + S2 MCP operations), the data contract
  (schema + freshness/SLA + permitted use), the owner lane, and the
  quality measures from platforms.md.
- The S1 read API and the S3 UI are driven by the registry: the
  family picker in DataStudio IS the product catalog — no
  hand-maintained second list. A family with no product entry is
  not readable (registry-coverage pin, S4).
- Seed products (first pass, from the existing families): session
  memory (facts + vector recall), reports, jobs/audit, marketplace,
  provider captures, screening datasets. Each seed product's stores
  + APIs are verified against the code in its slice, not asserted
  from the docs.

### Codegen from the ORM layer — S0 spike (user question)

Nothing generates services/APIs from the ORM layer today: the only
generator in the repo is `scripts/generate-strategy-pages.mjs`
(client pages); no drizzle-kit, no ORM codegen (grep,
2026-11-14). **Can we? Yes — as a spike, not an assertion.** The
ingredients exist: `ormSchema.ts` + column maps define tables and
columns; `drizzleSchema.ts` defines the D1 tables; `RepositoryPort`
defines CRUD; `createOrmPorts` is the family registry. A generator
could emit port interfaces, S1 REST routes, S2 MCP tools, registry
entries, and the mix pin's family list from those schemas.

What it cannot generate: family-specific operations
(`MemoryPort.search`, retention selectors, custom semantics),
tenancy rules, and the business logic in `src/services/*` — those
stay hand-written, with generated code as scaffolding plus
hand-written extensions. One decision the spike must settle:
checked-in generated code vs build-time generation (the repo's
no-hard-coding / externalized-config rules apply to the generator
itself, and generated files must be identifiable + the generator
versioned).

**S0 — two-stage codegen spike (new, first).** The question is
whether generation runs in two stages — services first, APIs over
them — and the answer is yes, with the second stage's foundation
already in the repo:

- **Stage 1 — generate the data service from the ORM layer.** One
  typed service per family, generated from `ormSchema.ts` + column
  maps (+ `drizzleSchema.ts` for D1 families): a thin CRUD wrapper
  over the family's port (`findMany` / `findById` / `findOne` /
  `count` / `create` / `update` / `upsert` / `delete`) plus the
  family's extended operations as hand-written extensions on the
  generated class. The port interface is the service contract; the
  generator emits the wrapper, not the contract.
- **Stage 2 — generate the APIs from the service, on standards.**
  OpenAPI 3.x for REST — and the repo already serves it:
  `src/security/openapiSpec.ts` generates an OpenAPI 3.x document
  (served at `GET /openapi.json` + `GET /api/docs`, session-gated),
  and `src/api/openApiDrift.ts` (#1768) pins it: the spec must be
  structurally valid and every route in the ingress table must
  appear in the spec, or CI fails. What is missing is the *source*:
  today the spec is generated from a hand-maintained static catalog
  (`src/client/iaaaEndpointCatalog.ts`) with hand-written schemas
  for a pilot set only. The spike replaces the hand-maintained data
  entries with generated ones derived from the Stage-1 services.
  MCP tools come from the same source: tools already carry JSON
  Schema inputs (`McpToolFactory.getToolDefinitions` →
  `inputSchema: tool.jsonSchema`), so the generator emits the tool
  schema from the same Zod definitions. **Single schema source:
  Zod** (already the repo's request-shape language, `zod@^4.1.8`) —
  Zod → JSON Schema feeds both OpenAPI 3.1 (fully JSON-Schema
  compatible) and MCP tool schemas. **"Or better":** OpenAPI is the
  right standard for the REST surface (already served + pinned);
  GraphQL is rejected — a second query paradigm with no repo
  precedent that would duplicate the REST surface; AsyncAPI is
  out of scope for a read API (no event surface in v1).
- **Spike shape (time-boxed):** one family end-to-end — generated
  service + generated OpenAPI paths + generated MCP tool + registry
  entry + pin list entry — proving the generated output behaves
  byte-identically to the hand-written equivalent (conformance suite
  green unmodified). It also settles the layering note in
  `openapiSpec.ts`: the generated catalog gets a shared home
  (`src/api/`) instead of the client-side catalog import. S1's
  implementation follows the verdict — if generation wins, S1 routes
  are generated; if not, S1 is hand-written and the finding is
  recorded. S0 does not block the product-registry definition (that
  is hand-written in S1 either way).

### Codegen rules — how partial generation is managed (user questions, answered 2026-11-14)

Verified repo facts first: the repo already practices partial
generation — `src/client/designTokens.ts:76` carries
`/* BEGIN GENERATED TOKENS — scripts/gen-design-tokens.mjs — do not
edit by hand */`, a generated section delimited inside a hand-written
file with the generator named. There are two generators today
(`gen-design-tokens.mjs`, `generate-strategy-pages.mjs`, whose output
is checked in). There is NO regen-check CI job yet, and Zod 4's native
`toJSONSchema()` is confirmed working in the installed `zod@^4.1.8`
— the single-source pipeline needs zero new dependencies.

- **How do we know the gaps?** Three detectors, strongest first.
  (1) The type system: the generator emits the contract (interface /
  abstract base) declaring every operation the family must provide,
  including the extended ops declared in the schema/registry; the
  hand-written extension implements them — a missing one is a `tsc`
  error, not a checklist item. (2) The gap manifest: the generator
  emits a per-family manifest of generated vs hand-written-required
  items, and a CI pin fails while gaps are unfilled — the same
  "return problem strings, test pins the result empty" pattern as
  `openApiDrift.ts`. (3) The family's unmodified conformance suite:
  a generated op that behaves wrong fails the suite. The gap is
  visible in the file itself (generated block vs hand-written code
  around it, per the design-tokens marker convention).
- **Schema changes:** regeneration is the workflow, and it is
  versioned with the schema. A schema change lands as a numbered
  migration (the existing `migrationRunner` discipline) AND its
  regeneration in the same PR — main never holds a stale generated
  file. CI gains a regen-check job (new): run the generator, `git
  diff --exit-code` — any difference fails. That one check covers
  both staleness and hand edits (a hand edit makes the file differ
  from fresh output). Breaking changes (renamed/removed field) are
  caught by typecheck + the conformance suite + the migration
  discipline, exactly as hand-written changes are today. Generated
  output is checked in (the repo's existing pattern), so diffs are
  reviewable and the build never depends on running the generator.
- **Generated code is imported, never touched.** The rule, enforced
  by the marker header (generator named + "do not edit by hand") and
  the regen-check: hand-written code lives in separate files /
  sections (subclass / extension, or the code outside the GENERATED
  markers) and imports the generated module. The standard approaches
  this follows: schema-first generation (protobuf / gRPC, Thrift,
  Prisma Client, OpenAPI Generator — schema is the source of truth,
  generated code is a black box you import); partial generation
  (generated base + hand-written extension); regen-check in CI;
  gap-manifest + drift pin; breaking-change detection via the
  existing typecheck + conformance + migration discipline.
- **Should we use codegen? Recommendation: yes, bounded — and decided
  by S0 evidence, not asserted.** Generate only the mechanical
  scaffolding (CRUD service wrappers, route + tool shapes, registry
  entries, pin lists). Never business logic, tenancy rules, or
  family-specific semantics. **Risks:** (a) the generator becomes a
  product you own forever — the same argument that rejected the
  custom Drizzle driver; a buggy generator stamps its bug
  everywhere; (b) generated code is harder to debug; (c) regen
  churn makes schema-touching PRs noisy; (d) the generated /
  hand-written boundary can rot if hand edits creep into generated
  sections (the regen-check is the guard); (e) if the generator is
  abandoned, the generated code still works — it is just code — so
  the exit is clean and the risk is bounded. S0's verdict criteria:
  generated == hand-written behavior on one family; gap manifest +
  regen-check work; the output is readable/debuggable; and the
  maintenance cost is smaller than the drift cost it removes. If any
  criterion fails, S1 is hand-written and the finding is recorded.

### Revised slice order

S0 (codegen spike, decision) → S1 (read API + product registry) →
S2 (MCP) → S3 (UI) → S4 (pins: tenancy, read-only, exactness,
registry-coverage, transaction-path). S0 is the only new slice; the
rest are unchanged.
