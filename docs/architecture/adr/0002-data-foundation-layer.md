# 0002. Data foundation layer: port-first, Drizzle ORM, D1 as one adapter

- Status: accepted
- Date: 2026-10-25
- Deciders: owner, CAIO-quns
- Issue: #1548 (slice 0; design #1546)
- Implementing PR: #1553

## Context

The agentic program has no shared query surface. Each Durable
Object owns its own SQLite database; synthesized schedules and
goals live in ScheduledAgent `ctx.storage`, not SQL; and the bare
ScheduledAgent `*/30` tick carries no Orchestrator `mas_settings`
SQL, so a global halt thrown in the Orchestrator does not stop a
bare tick (the disclosed lane-1 gap from #1517). The D1 AgentDB
design (#1546, approved) and its binding (PR #1547, merged: the
owner-created `agentdb` database bound as `AGENT_DB`) supply the
shared store. What was missing was the layer that makes that store
safe to build on: one topology, one migration story, one tenancy
enforcement point, one transaction model — built cloud-native
(Workers runtime as deployed) and cloud-agnostic (no domain logic
knows which cloud it runs on).

## Decision

### R1 — Port-first architecture (non-negotiable)

Domain code depends only on interfaces in `src/data/*` port
modules (`HaltReader`, `GovernanceProjectionWriter`, and later
chain/schedule/job/audit/report ports). No domain file imports a
store client, references `env.AGENT_DB`, or writes SQL. The
composition root (`src/data/createGovernancePorts.ts`) wires
`env.AGENT_DB` → adapter → ports. The port test suite passes
unchanged against the D1 adapter and an in-memory adapter; a
structural test pins that port modules import no store client
and domain modules import no ORM.

### R2 — Dialect isolation in exactly one place

All query-builder code lives in adapter modules. The portable
subset is fixed: `?` positional parameters (rewritten per
adapter by the ORM), integer millisecond epoch timestamps (never
datetime strings, never dialect date functions), `ON CONFLICT`
upserts with `onConflictDoNothing` for idempotent replays, no
`RETURNING` in the portable path (read-back after write
instead). A dialect-conformance suite (one test file, run
against every adapter) pins this; a query passing on D1 but
failing on Postgres is a layer defect.

### R3 — Portable versioned migrations

Ordered migration files applied by a small runner
(`src/data/migrationRunner.ts`) that records applied versions in
a `_migrations` table owned by the runner. First-definition-wins
is abolished: a table's DDL lives in exactly one migration file,
and the Drizzle schema mapping is pinned to agree with it by
test (the migration file wins on drift). Rollback is a forward
compensating migration, never an edit to an applied file.
Migration SQL must not contain a semicolon inside a string
literal (the runner splits on `;`). Schema changes update the
registry/pin test in the same PR (the F1 pattern).

### R4 — Tables, with two corrections to #1546

Slice 0 ships `agent_governance` only (halt rows: `tenant_id`,
`scope`, `state`, `set_by`, `set_at_ms`, `reason`, plus
`version`/`provenance`). The remaining #1546 tables
(`agent_chains`, `agent_synthesized_schedules`,
`agent_shard_jobs`, `agent_chain_audit`, `agent_reports`) land in
later slices. Two corrections to #1546 are adopted now:
(i) `agent_chain_audit` will be row-per-event append-only —
never the single-key JSON-array log that made IAAA audit racy;
(ii) `agent_shard_jobs` will capture lane-2 executor outputs,
not just `mas_async_jobs` rows, because inline execution never
writes that table.

### R5 — Projection write path (the consistency contract)

Durable-object storage stays authoritative for execution;
AgentDB is written on state transitions only, never as a second
writer, and on conflict the durable-object state wins. Writes
are idempotent (deterministic event ids, `ON CONFLICT DO
NOTHING`), so at-least-once delivery is safe. Because no
transaction spans a durable object and D1, the contract is:
write durable-object state first, then project (never the
reverse), except for the halt ordering in R6. A projection
failure never fails the execution transition — it is recorded
and reconciled by a periodic job that re-projects any
durable-object state newer than its projection row. Reads may
lag one transition; any consumer that cannot tolerate lag must
read the durable object directly and say so.

### R6 — Cross-DO halt read as a first-class query

`HaltRead` is the single synchronous exception: the halt mirror
is written synchronously on halt-set, and a failed halt read
fails closed (treated as halted). "Synchronous" here means
same-call-path write and fresh read on the firing path — not
JavaScript-synchronous, since the D1 API is async. The safety
ordering (verified reasoning): the ordering protects the
tick-facing read path, because the tick is the safety-critical
firing path and the mirror is its source of truth. For SET,
mirror first then the durable-object setting: if the setting
write then fails, the error surfaces and the mirror already
reads halted, so the tick refuses to fire while the operator
reconciles. For CLEAR, setting first then the mirror: if the
mirror write then fails, the error surfaces and the mirror
still reads halted, so the tick stays halted. In both
directions a partial failure leaves the tick-facing read halted
or the system unchanged — never silently clear. Full
convergence after any partial failure is the R5 reconciliation
step, which is why a mirror failure must surface as an error,
never a log line.

### R7 — Tenancy enforced at the boundary

The adapter injects `tenant_id` into every query. There is no
unscoped read method on any store. Cross-tenant negative tests
ship with the layer. The tick's tenant defaults to `"primary"`
(the documented single-tenant default, same as IAAA) until a
tenant context is threaded through the tick; a multi-tenant
deployment must set it explicitly.

### R8 — Retention decided up front

Each projection table gets a retention rule in the PR that
creates it, reusing `src/security/storageRetention.ts` as the
single contract. Slice 0's line: `agent_governance` rows are
append-only audit history and are long-lived (no pruning in
this slice). The R2 lifecycle/orphan-sweep decision (#338) is
still open and is recorded as such, not assumed.

### R9 — What the layer is not

Not a replacement for durable-object SQLite (execution state
stays there), not a replacement for Vectorize (semantic recall
stays there; AgentDB answers exact queries), not a new
execution path (no chain runs *from* AgentDB), and never a
session/credential store — a projection writer that accepts a
session or credential row is a defect, pinned by test.

### ORM choice: Drizzle ORM (evaluated, not assumed)

Transactions in the foundation are managed through an ORM, not
hand-rolled SQL strings in domain code. Drizzle ORM 0.45.4 is
the foundation ORM, evaluated first against the slice-0
requirements:

- First-class D1 driver (`drizzle-orm/d1`), SQLite and Postgres
  drivers, one schema/query-builder across dialects.
- `db.transaction()` maps to each store's native transaction
  mechanism — with the D1 caveat below.
- Workers-friendly (no Node-only dependencies, small bundle).
- `drizzle-kit` SQL migrations exist, but slice 0 uses
  hand-written portable migration files + a small runner
  instead, because the runner must also serve the future
  Postgres adapter with identical files; drizzle-kit generation
  is a future option, not a slice-0 dependency.
- Proven in this slice by test: the real `drizzle-orm/d1`
  driver runs in CI against a mock `D1Database` interface
  backed by node:sqlite — no Cloudflare credentials, no live
  D1 calls from tests. The mock matches real D1's async
  `prepare`/`bind`/`run`/`all`/`first`/`raw`/`batch` surface
  (verified against `drizzle-orm/d1/session.js`).

Considered alternatives, with reasons recorded:

- Kysely: capable query builder, but D1 support is via a
  community dialect only, and its migrations story is weaker
  for the portable-files requirement.
- Prisma with driver adapters (`@prisma/adapter-d1`,
  `@prisma/adapter-pg`): heavier, with Workers cold-start and
  bundle risk, and weaker multi-dialect schema portability for
  the single-schema requirement.
- TypeORM / Sequelize / MikroORM: ruled out — Node-centric,
  not edge/Workers-friendly.
- Incumbent hand-rolled `src/orm` DatabaseORM/Repository: stays
  as the durable-object SQLite implementation detail. It is NOT
  the foundation ORM and is not replaced wholesale in this
  slice: it has no transaction management (no BEGIN/COMMIT in
  the codebase) and its schema evolution is the scattered
  `CREATE TABLE IF NOT EXISTS` pattern this layer abolishes.

### Transaction model (platform honesty)

No ORM can give one ACID transaction spanning a durable
object's SQLite and D1 — that is a platform fact, not a library
gap, and this ADR does not claim otherwise. The model is:

- Per-store ORM transactions for operations inside one store:
  D1 single statements (atomic by themselves), D1 `batch()`
  for multi-statement atomicity on D1, durable-object SQLite
  transactions and Postgres transactions via the ORM where
  the adapter supports them.
- Cross-store consistency via idempotent projection writes +
  reconciliation (R5), with the safety-directed halt ordering
  (R6) as the exception.
- Two D1-specific findings, verified against the driver source
  (`drizzle-orm/d1/session.js` in 0.45.4):
  - `db.transaction()` on D1 is implemented as sequential
    BEGIN/COMMIT statements, not as a single batch. On D1's
    request-per-statement API this is not Postgres-equivalent
    atomicity. Slice 0 therefore never relies on
    `db.transaction()` for atomicity on D1: migration safety
    comes from idempotent statements plus the `_migrations`
    row written last as the commit marker.
  - Test-fidelity caveat: the node:sqlite-backed mock DOES
    hold a real interactive transaction across BEGIN/COMMIT,
    so mock transactions are stronger than real D1's. Tests
    must not assert atomicity through `db.transaction()` on
    the mock as if it proved D1 atomicity.

### Seed procedure (one-time, at cutover)

The halt seed ships in slice 0 (`seedGovernanceHalt`): it reads
the current `mas_settings` `adaptation.killSwitch` value and
writes one mirror row (state halted or clear, provenance
`seed:cutover`). It never writes the durable-object setting,
and a second run is a no-op. It is a deliberate operator step,
never boot logic: the operator runs it once at cutover through
the same maintenance path used to manage the kill switch today
(no in-repo writer for that setting existed before this slice;
`setGovernedHalt` is now the canonical setter, and its first
route-level caller lands in a later slice). Without the seed, a
pre-existing halt is invisible to the new read path.

The canonical `mas_reports` seed is approved but ships with the
later reports slice; that table does not exist yet and is not
built here.

## Slice 1 addendum (issue #1651, chains + schedules projection)

- Status: accepted with slice 1; the R1–R9 contract above is
  unchanged and governs this slice.
- Tables (migration 0002, DDL in exactly one file): `agent_chains`
  and `agent_synthesized_schedules`. Every row carries
  `tenant_id`, `workspace_id`, `chain_id`, `version`,
  `created_at_ms`, `updated_at_ms`, and provenance
  (`provenance_writer`, `provenance_source_do`,
  `provenance_source_version`, the last being the row-shape
  version of the DO record mapping, 1 in slice 1). The `id`
  primary key is the deterministic replay key
  `<tenant_id>:<id>:<version>`; replaying the same version
  conflicts and is a no-op under `onConflictDoNothing` writes.
  Tenant/chain/version indexes serve the latest-row reads.
  Chain rows carry `goal` + `steps_json` (capability ids and
  stages only); schedule rows carry `kind` + `cron`. Neither
  row type carries auth material of any kind.
- Writer wiring points (the real transitions, no parallel
  paths): `ScheduledAgent.synthesizeSchedule`,
  `approveSynthesizedSchedule`, and `killSynthesizedSchedule`
  in `src/agents/scheduled-agent.ts`. Each saves DO state
  first, then best-effort projects via the composition root
  (`src/data/createChainSchedulePorts.ts`); a projection
  failure is logged and reported, never thrown to the
  transition. Honesty note: the pure compilers
  (`compileGoal`/`compileChain` in `src/orchestrate.ts`) and
  the registry produce no persisted identity, so no chain row
  is written at compile time — the chain row is created at
  synthesize (the first persisted transition) with `chainId`
  equal to the synthesized record id, and approve/kill advance
  it. Wiring a projection into the compiler would have
  fabricated an id and invented a parallel path; it was
  deliberately not done. `scheduleId` equals `chainId` in
  slice 1 because one synthesized record is one chain instance.
- Reconciliation design: `reconcileChainSchedules`
  (`src/data/chainScheduleProjection.ts`) compares each DO
  record's status against the latest projected chain and
  schedule rows; a missing or stale projection is re-projected
  as a new version row, a current one is left untouched, and
  per-record failures are collected in the report, never
  thrown. Invocation is a deliberate operator/maintenance
  step only: `ScheduledAgent.reconcileChainScheduleProjection`
  plus the admin-gated POST `/api/chains/reconcile` route
  (requireAuth → wired session → live platform-admin
  membership, the slice-0 seed pattern). It is never boot
  logic, never auto-run on deploy or tick — R5 justification:
  reconciliation is a repair pass over already-persisted
  state, not a firing path, so running it on a schedule would
  silently rewrite query state outside any operator decision.
  The operator invokes it after a recorded projection failure,
  and its report states exactly what changed.
- Query API: GET `/api/chains/status?chainId=` (requireAuth;
  tenant from IAAA resolution) reads the projection only via
  `readChainStatus` — never the durable object — and returns
  the latest chain + schedule rows for that tenant, or
  `projected:false` when nothing is projected. Unbound
  AgentDB answers 503. The route returns projection fields
  only (id, status, version, kind, cron, timestamps).
- Tenancy: the adapters inject `tenant_id` into every query;
  there is no unscoped list-all method. Tenant and workspace
  default to `"primary"` (the documented single-tenant
  default, same as the slice-0 tick) until a tenant context is
  threaded through ScheduledAgent; a multi-tenant deployment
  must set it explicitly.
- Retention: `agent_chains` and `agent_synthesized_schedules`
  are KEEP (versioned projection history; see
  `src/security/storageRetention.ts`, the single contract).
- Ports: `src/data/chainSchedulePorts.ts` (interfaces),
  `src/data/d1ChainScheduleAdapter.ts` +
  `src/data/inMemoryChainScheduleAdapter.ts` (adapters), with
  the port/dialect suite passing unchanged against both.

## Slice 2 addendum (issue #1676, shard jobs projection)

- Status: accepted with slice 2; the R1–R9 contract above is
  unchanged and governs this slice.
- Table (migration 0003, DDL in exactly one file):
  `agent_shard_jobs`. Every row carries `tenant_id`,
  `workspace_id`, `chain_id`, `version`, `created_at_ms`,
  `updated_at_ms`, and provenance (`provenance_writer`,
  `provenance_source_do`, `provenance_source_version`, the
  last being the row-shape version of the mapping, 1 in
  slice 2). Grain: one row per (chain, job, version); the
  composite primary key on
  `(tenant_id, chain_id, job_key, version)` is the
  idempotency guarantee, and replaying the same version is
  a no-op under `onConflictDoNothing` writes. `job_key` is
  an inline shard id (`chain-exec:*`) for completed legs, a
  rails job id for submitted legs, or `leg:<stepId>` for a
  failed leg with no job id. Rows carry `status`, `stage`,
  `capability_id`, `detail`, and a capped `result_json`
  (8000 chars + truncation marker). No row type carries auth
  material of any kind, and no submitted row carries a
  submission spec: a spec may carry operator identity or
  query text, so submitted rows store only the job id and
  detail.
- The key correction from the program spec: lane-2 inline
  execution never writes `mas_async_jobs`, so a projection
  fed only from that table would miss every inline outcome.
  The executor's completion callback is therefore a
  projection writer input: `runChain`
  (`src/mcp/goalChainCommands.ts`) accepts an optional
  `onLegOutcome` callback, invoked once per leg that
  actually ran (completed, submitted, failed) and never for
  skipped, blocked, or unimplemented legs, awaited inside a
  try/catch so a callback failure can never fail the run.
  The ScheduledAgent firing paths (`onCron` and
  `fireSynthesizedSchedule` in `src/agents/scheduled-agent.ts`)
  supply a projector bound to env/tenant via
  `executeChainForRecord` (writers
  `scheduled-agent:onCron` /
  `scheduled-agent:fireSynthesizedSchedule`; chain id is the
  synthesized record id, matching slice 1's chain rows).
  The MCP command context supplies no callback, so MCP legs
  stay `unimplemented` and project nothing — no execution
  is invented. Replaying an already-projected status is a
  no-op; a status change writes version+1 and preserves the
  first-seen timestamp.
- Reconciliation design: `reconcileShardJobs`
  (`src/data/shardJobProjection.ts`) converges rails state
  into the projection: a submitted row whose rails job
  reached a terminal state advances to that state
  (version+1, first-seen time preserved); a rails job the
  projector never saw creates a version-1 row; an
  already-current row is untouched; per-record failures are
  collected in the report, never thrown. Invocation is a
  deliberate operator/maintenance step only:
  `OrchestratorAgent.reconcileShardJobProjection` (execution
  in `src/agents/orchestrator/shardJobReconcile.ts`, the #992
  pattern) plus the admin-gated POST `/api/jobs/reconcile`
  route (requireAuth → wired session → live platform-admin
  membership, the slice-0 seed pattern; unbound AgentDB
  answers 503). It is never boot logic, never auto-run on
  deploy or tick. Honest limitation, recorded not hidden:
  reconciliation can only converge what it can see. Rails
  rows carry `chainId` (C3 consolidation), so terminal
  rails jobs join their chain's history; inline outcomes
  have no durable source beyond the run itself, so an inline
  outcome that was never projected at completion cannot be
  recovered by reconcile — which is why the run path
  projects synchronously at completion and why a projector
  failure is surfaced in the result, not swallowed.
  Bounded window: the rails list is session-filtered and
  clamped to 100 rows, so a reconcile pass covers the most
  recent rails jobs only.
- Query API: GET `/api/jobs/history?chainId=` (requireAuth;
  tenant from IAAA resolution) reads the projection only via
  `readJobHistory` — never the durable object — and returns
  the latest row per job for that chain, newest first.
  Unbound AgentDB answers 503. The route returns projection
  fields only (jobKey, status, stage, capabilityId, detail,
  version, timestamps).
- Tenancy: the adapters inject `tenant_id` into every query;
  there is no unscoped list-all method. Tenant and workspace
  default to `"primary"` (the documented single-tenant
  default, same as slices 0/1) until a tenant context is
  threaded through ScheduledAgent; a multi-tenant deployment
  must set it explicitly.
- Retention: `agent_shard_jobs` is BOUNDED, mirroring the
  `mas_async_jobs` discipline it projects (terminal rows 30d
  + 500-row cap; see `src/security/storageRetention.ts`,
  the single contract). Job rows are operational run
  history, not lifecycle audit: unlike `agent_chains`, whose
  versions are the audit trail the status read reasons
  about, a pruned job version destroys no lifecycle fact
  (the chain row keeps it), and the rails source already
  discards the same rows at 30d. Enforcement lands with the
  retention slice; until then rows accrue unbounded and the
  contract line is what that enforcement implements.
- Ports: `src/data/shardJobPorts.ts` (interfaces),
  `src/data/d1ShardJobAdapter.ts` +
  `src/data/inMemoryShardJobAdapter.ts` (adapters), with
  the port/dialect suite passing unchanged against both.

## Slice 3 addendum (issue #1688, audit + reports projection)

- Status: accepted with slice 3; the R1–R9 contract above is
  unchanged and governs this slice. Scope note: the Postgres
  adapter slice is deferred by the owner (2026-10-26,
  "for now do R1/sqlite"); this program proceeds R1
  port-first on SQLite (D1 + in-memory/local SQLite).
- Tables (migration 0004, DDL in exactly one file):
  `agent_chain_audit` and `agent_reports`. Every row carries
  `tenant_id`, `workspace_id`, `version`, `created_at_ms`,
  `updated_at_ms`, and provenance (`provenance_writer`,
  `provenance_source_do`, `provenance_source_version`, the
  last being the row-shape version of the mapping, 1 in
  slice 3).
- Audit grain (the correction to the original #1546 design):
  one row per event, never a JSON log blob. The id is the
  deterministic replay key `<tenant_id>:<eventId>`, so
  replaying the same event is a no-op under
  `onConflictDoNothing`. Audit rows are append-only;
  `version` is the row-shape version (always 1), not a
  per-subject counter. `chain_id` is nullable: tenant-wide
  events (reconcile, seed) have no single chain subject.
  Events recorded: chain/schedule transitions
  (synthesize/approve/kill, one event per subject, written
  by `projectAfterTransition` after the DO transition
  commits), job projections (one event per run that
  projected jobs, written by `projectRunLegs`), and
  reconcile passes (one tenant-wide event carrying the
  report counts, written by the reconcile invocation
  points). All audit writes are best-effort and never
  block the originating step; a lost audit write is a
  visible gap (a missing event id), never a wrong state.
- Authority matrix (`src/data/chainAuthority.ts`): the
  small, explicit, chain-scoped mapping — read for any
  signed-in role (the tenant predicate, not the role,
  scopes the rows), reconcile and seed for platform-admin
  only, project for the system writer only. Enforced at
  the boundary: the chains-reconcile route handler now
  derives its role from the admin check and consults the
  matrix (behavior unchanged, non-admin still 403), and
  canonical-report deletion takes the same platform-admin
  gravity. This is deliberately NOT a repo-wide authority
  system; it covers chain operations only.
- Canonical reports: `agent_reports` mirrors the
  `mas_reports` canonical copy. Grain: one row per
  (tenant, report, version) with a composite primary key.
  Rows are written only by the projection path
  (`seedCanonicalReports`); deletion happens ONLY via
  `deleteCanonicalReport` (platform-admin only), pinned
  by a source scan test. Bodies are capped at 8000 chars
  with a truncation marker; the durable object holds the
  full copy. `detail_json` on audit rows carries counts
  and statuses only, never payloads.
- The approved bounded mas_reports seed: one-time,
  idempotent, operator-step pattern (the slice-0 halt seed
  shape): `OrchestratorAgent.seedCanonicalReports`
  (execution in `src/agents/orchestrator/canonicalReportSeed.ts`,
  the #992 pattern) reads this instance's `mas_reports`
  via the ORM repository and mirrors exactly those rows;
  a second run seeds zero rows. Invoked deliberately only
  via the admin-gated POST `/api/reports/seed-canonical`
  route (requireAuth → wired session → live platform-admin
  membership, fail-closed; unbound AgentDB answers 503).
  It never writes the DO table and never auto-runs on
  boot, deploy, or tick. Scope is exactly the current
  `mas_reports` rows at invoke time — no historical
  backfill beyond that approved set. The seed invoke
  itself is a separate operator step after merge, not
  part of this slice's landing.
- Query API: GET `/api/audit/history?chainId=`
  (requireAuth; tenant from IAAA resolution) reads the
  audit projection only, newest first; GET
  `/api/reports/list[?reportId=]` reads the report
  projection only (latest per report, newest first, or
  the one report). Both answer 503 when AgentDB is
  unbound. The reports list shape omits bodies. All three
  new routes (including the seed route) are catalogued in
  `src/client/iaaaEndpointCatalog.ts`.
- Retention: both tables are KEEP in
  `src/security/storageRetention.ts` (the single contract);
  audit rows are the trail the audit read reasons about,
  and report rows mirror the KEEP discipline of
  `mas_reports` itself. Enforcement lands with the
  retention slice; until then rows accrue unbounded and
  the contract lines are what that enforcement implements.
- Honest limitation: audit is a trail of projection
  events, not a second source of truth — a projection
  failure that is never reconciled leaves a gap, and the
  seed mirrors only the rows present at invoke time
  (reports created later need the projection path, not
  another seed, to appear).
- Ports: `src/data/auditReportPorts.ts` (interfaces),
  `src/data/chainAuthority.ts` (matrix),
  `src/data/d1AuditReportAdapter.ts` +
  `src/data/inMemoryAuditReportAdapter.ts` (adapters),
  with the port/dialect suite passing unchanged against
  both.

## Slice 4 addendum (issue #1697, MCP read tools + dashboard routes)

- Status: accepted with slice 4; the R1–R9 contract above is
  unchanged and governs this slice. Scope note: the Postgres
  adapter slice is deferred by the owner (2026-10-26,
  "for now do R1/sqlite"); this program proceeds R1
  port-first on SQLite (D1 + in-memory/local SQLite).
- No new tables, no new migrations, no writes. The four
  tools (`src/mcp/agentDbReadCommands.ts`) reuse the
  slice-1/2/3 read helpers (`readChainStatus`,
  `readJobHistory`, `readAuditHistory`, `readReports`)
  behind the ports — query logic lives in exactly one
  place per read, and the result shapes mirror the
  dashboard route bodies (report bodies excluded, the
  durable object holding the full copy).
- Registration: the four commands join the McpToolFactory
  static block alongside `goal.compile` / `goal.schedule` /
  `chain.run`, so `tools/list` (derived from the factory),
  `tools/call`, and `createAgentMcpTools` (which dogfoods
  the factory) all pick them up with no further wiring.
  The MCP explorer catalog gains the four entries and
  its §7 size pin moves 30 → 34, per that pin's own
  growth rule.
- Tenancy (R7): the tenant comes from IAAA resolution of
  env — the same resolution the dashboard routes use. No
  tool accepts a tenant argument; a forged tenant value
  in the arguments is ignored (pinned by test), and
  cross-tenant reads return nothing. Auth rides the
  existing `/mcp` path (app session or valid per-user
  `cfk_` key) before any tool runs; the tools themselves
  authenticate nothing, like every other factory tool.
- Availability: an unbound store yields a clean
  unavailable error, never a crash. A read failure
  surfaces as a tool error, not partial data.
- Dashboard routes: verified on main before building —
  all four reads (`/api/chains/status`,
  `/api/jobs/history`, `/api/audit/history`,
  `/api/reports/list`) already exist from slices 1–3 and
  are already catalogued, so slice 4 adds no server
  route. The finding is pinned by a source test so a
  future reader can see the check, not just the claim.
- Explicitly out of scope: `chain.run` execution binding.
  The tool stays registered and still reports legs
  unimplemented with no executor; this slice adds reads
  only and projects nothing.
- Honest limitation: MCP reads share the projection's
  R5 lag — a transition committed a moment ago may not
  be visible yet. The tool descriptions say so, and any
  consumer that cannot tolerate lag reads the durable
  object directly.

## Slice 6 addendum (issue #1701, retention enforcement)

- Status: accepted with slice 6; the R1–R9 contract above is
  unchanged and governs this slice. This is the final code
  slice of the program: slices 0–4 landed the projections
  and reads, and this slice enforces the retention contract
  R8 declared for them. No new tables, no new migrations,
  no Postgres work (deferred by the owner 2026-10-26,
  "for now do R1/sqlite").
- What the contract actually declares, re-verified from
  `src/security/storageRetention.ts` rather than assumed:
  exactly one AgentDB table is BOUNDED — `agent_shard_jobs`
  (30d + 500-row cap, mirroring the rails async-jobs
  discipline) — and every other projection table is KEEP
  (chains, schedules, audit, reports). One gap found while
  verifying: `agent_governance` had no declared line at all,
  though R8 requires each table's rule up front. Slice 6
  adds it first (KEEP: one row per halt transition, not
  per request, so volume is transitions; pruning it would
  destroy the governance audit the halt read reasons
  about). `_migrations` is runner bookkeeping, not a domain
  table, and is out of purge scope by construction.
- Enforcement: a port-first purge (`src/data/retentionPorts.ts`
  + `retentionPurge.ts`, D1 + in-memory adapters behind the
  same port, dialect suite unchanged). Age phase deletes
  rows with `created_at_ms` strictly older than now − 30d,
  oldest first, in bounded batches (500) under a per-run cap
  (5000) — the loop shape mirrors `runStorageRetention`.
  Cap phase then trims a tenant holding more than 500
  shard-job rows oldest-first to 500. All versions of a job
  share `createdAtMs` (first projection time, slice 2), so
  an expired job purges whole; a live job keeps every
  version. Repeated purge is a no-op; window ≤ 0 skips
  everything. The purge allowlist is exactly
  `["agent_shard_jobs"]`, pinned by test, and the purge
  modules name no KEEP table and no `mas_*` table.
- Invocation is operator/maintenance only, following the
  established pattern: admin-gated `POST /api/retention/purge`
  (requireAuth → wired session → live platform-admin,
  fail-closed; unbound AgentDB → 503; decision order
  401 → 405 → 403 → 200/500), catalogued in the IAAA
  endpoint catalog. It needs no durable-object hop — the
  purge touches only the projection, so the server calls
  it directly, unlike reconciliation, which reads DO state.
  The governed job definition (`RETENTION_PURGE_JOB`,
  nightly `0 4 * * *` mirroring the mas pass) is the
  second invocation path: `runRetentionPurgeJob` skips
  without purging while halted and never throws a store
  failure into a firing path (logged and returned). The
  job is single-tenant per invocation; multi-tenant
  enumeration at activation is an operator step, and
  activation itself is an operator step — this slice
  creates no live scheduled job and changes no production
  schedule.
- R2 lifecycle/orphan-sweep decision (#338) — RECORDED:
  **accepted-unbounded, for now.** Evidence: #338 itself
  is closed (design-first sub-task); its design landed as
  the R2 pointer shape + `deleteCanonicalReport`, which
  deletes the R2 object in the same scope as the row and
  logs a stranded object as sweep-owned only when that
  delete fails or no bucket is bound. Stranding therefore
  requires a rare, deliberate admin delete of a KEEP row
  to coincide with an R2 failure — not a steady stream —
  and stranded objects are inert report JSON, not a cost
  cliff at this volume. A correct sweep would need
  cross-instance DO enumeration plus paginated R2
  listing, which is a design cycle of its own, not a
  slice-6 appendage. The slice-6 purge cannot strand
  anything (shard-job rows carry no R2 pointers). The
  "orphan sweep owns it" comments in `scheduledReports.ts`
  remain the pointer to the eventual sweep. Revisit
  triggers: the first stranded-object log line in
  production, or bucket object-count growth attributable
  to `reports/` objects. No sweep is scheduled by this
  slice, and no sweep body is implemented.
- Honest limitations: a purge report is returned per
  invocation but is not itself written as an audit event —
  no new audit table is created for purge runs, so the
  operator invocation is the record; if purge-run audit
  history is later wanted, it belongs in
  `agent_chain_audit` via the slice-3 event path, not in
  a new table. The per-tenant 500-row cap counts rows,
  not jobs, so a tenant with many versions of few jobs
  trims versions first (oldest rows go first). Purge
  failures surface as 500 to the operator; the firing
  paths never call the purge, so a failure cannot block a
  chain firing.
- Explicitly out of scope: the two production seed invokes
  (halt seed, canonical `mas_reports` seed) — they are
  operator steps after the program, and OpenAIMP/cfagent#1546
  stays open until they land. This slice does not close it.

## Consequences

- A new dependency: `drizzle-orm` (runtime). No `drizzle-kit`
  in this slice.
- The ScheduledAgent tick consults the mirrored halt when
  `AGENT_DB` is bound (via the durable object's own env — no
  env crosses the RPC boundary, per #1391) or when a caller
  injects a halt reader. The governed predicate
  (`shouldFireGoverned`) remains the decision-maker; the layer
  supplies a fact, not a new predicate. The direct one-shot
  firing path gets the same resolution for consistency.
- Migration 0001 applies via the adapter schema-ensure path
  (idempotent, `_migrations`-gated) on first use.
- Later slices, in order: chains + schedules projection,
  shard jobs with executor-output capture, audit + reports
  with the authority matrix, MCP read tools + dashboard
  routes, then retention enforcement. The Postgres adapter
  (proving cloud-agnosticism with the dialect-conformance
  suite) is deferred by the owner (2026-10-26, "for now do
  R1/sqlite") and is not in the current program order.

## Addendum — issue #4116: one system-of-record D1 for run ledgers (2026-11-12)

The DO-authoritative / D1-projection pattern this ADR establishes
now covers the run ledgers: `mas_reports` and `mas_async_jobs`
project into `agent_reports` and `agent_async_jobs`
(migrations 0059–0060), behind three carriers — queue
(`run-ledger.project` claim-check messages on `screener-events`),
direct ORM best-effort post, and a one-off sweep backfill
(`POST /api/ops/run-ledger-reconcile`). All three are
independently configurable per tenant (externalized, no defaults
in code; unconfigured = named refusal, fail closed) and all
three apply the ONE shared ordering rule identically:
idempotent upsert keyed on the natural key
(`ON CONFLICT DO NOTHING` for the new tables) + last-write-wins
by source `updated_at`. The existing versioned `agent_reports`
table reuses its read-before-write discipline (version+1 on
change, skip when already current) as the same rule's form.

Decisions pinned in this slice:

- **Instance / cursor:** no instance enumeration exists, so the
  sweep takes an optional instance hint (default: the shared
  orchestrator) and is single-shot restart-from-top with a
  100-row bound per ledger — no durable cursor.
- **Twin linkage:** the projection keys dedup to the #3121
  linkage — a pipeline run that generated a canonical report
  must not appear as both rows once projected. The link
  resolves only when exactly one candidate run window contains
  the row's `created_at`; otherwise NULL (the twin survives
  honestly). D1-only reads absorb linked job-run-record rows
  into the canonical row.
- **Owner scoping:** `agent_reports.user_login` (migration 0060)
  carries the DO row's owner so D1-only reads preserve the DO
  read's owner filter; async jobs stay session-scoped via the
  already-carried `session_id`. A re-projection that now knows
  the owner (or the twin link) when the stored row has null
  lands it as version+1; identical replays still skip.
- **Pointer bodies:** `agent_reports.body_r2_key` carries the
  R2 pointer for pointer rows; the D1-only read resolves it
  from R2, read-only — never the DO backfill, which would write
  to the DO in a read path.
- **Read cutover:** the three surfaces (`/api/runs`, Workflow
  Runs, `/api/runs/details`) read D1 alone when the tenant's
  `readMode` is `d1-only`; anything else keeps the Option B
  merged view. The response carries `ledgerReadMode`. Cutover
  is per tenant and reversible.
- **Explicitly not projected:** `mas_stage_claims` — no read
  surface consumes stage claims, claims live in multiple DOs
  with no instance enumeration, and claim semantics stay
  DO-authoritative (an owner decision for later, not a gap
  left untracked in this slice's design record).
