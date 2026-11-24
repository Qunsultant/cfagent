# ADR 0022: Data foundation repo-wide — one data-access layer behind ports, AOP transactions, dialect portability, intelligence substrate

- Status: Accepted (user build directive 2026-10-29: "let's build the data foundation and then sentinel program" — G-1 and G-2 ruled as recommended below; the remaining gates stay open with their owners)
- Date: 2026-10-29
- Deciders: #CDO-mha7 (design); owner ratification required for the gates in "Open gates"
- Issue: #1976 (design survey: `SURVEY.md` in the issue record; section citations below are to it)
- Extends: ADR 0002 (data foundation layer, R1–R9), ADR 0020 (DO/D1/R2 topology)
- Related: #1969 (AOP programme), #817 (aspect wrappers + catalog), #1824 (AOP fit-gap analysis), #1116 (data-provider platform + conformance kit), #2225 G13 / #798 (RSI loop), #945 Q7 (audit chain), #786 (retention record), #2279 (Sentinel programme — first proving consumer of the published plane)

## Context (shared)

ADR 0002 built one port-first data layer — over D1 only. The rest of the
repo kept writing data three other ways, and the survey (§1) measured the
result: ~90 tables across the codebase; 94 `.sql.exec(` call sites in 16
files plus a larger indirect surface of store modules that receive
`ctx.storage.sql` as a parameter; 101 `CREATE TABLE` statements in 38
files. Three data-access idioms coexist:

1. `src/data/` — per-aggregate ports with D1 + in-memory adapters over
   Drizzle (27 schema tables; migrations 0001–0012 + 0015 — 13
   registered, versions 13/14 absent; survey §1.1, discrepancy D2).
2. `src/orm/` — a hand-rolled `DatabaseORM` + generic `Repository<T>`
   over DO SQLite owning the shared `mas_*` tables, imported by the
   orchestrator, NLQ, async jobs, autopilot, and most routes (§1.2).
   ADR 0002 explicitly left it as an implementation detail; it has no
   transaction management and scattered schema evolution.
3. Per-surface store modules on a raw `SqlStorage` seam (options/
   discovery stores, #1116 platform stores, ~25 satellite service
   stores), each self-creating tables at first use (§1.3–§1.4).

Transactions are essentially absent as a mechanism: `transactionSync`
has zero usages in `src/`, D1 `batch()` has zero usages, and the only
transactional code is one KV `storage.transaction(...)` claim with a
racy get-then-put fallback (survey §3.1, discrepancy D4). Multi-write
atomicity today is idempotency-by-design, not a mechanism — and the
riskiest multi-write sites (canonical report fan-out, champion/
challenger promotion, IAAA chain append, cross-DO payments ledger)
are exactly where idempotency is weakest (§3.2).

Separately, the agentic intelligence layer and the RSI loop have no
substrate to stand on: events, traces, evidence, proposals, and the
fleet registry are fragmented across four stores with no unified
trace record, no principal attribution on the main event table, and
no proposal ledger (survey §5).

This ADR extends ADR 0002's contract from the D1 projection to the
whole repo. Where it restates or extends an 0002 rule, it says so;
nothing in 0002 is silently revised (per #1976's own rule).

---

## D-0 — Durable Objects: retained where justified, per capability

### Context
The rest of this ADR could be read as assuming Durable Objects:
ADR 0020's topology and R9's "DO authoritative for execution
state" predate the inventory. The survey (§1) counts more than 50
tables resident in DOs, and its placement finding (§1.5) shows
residency is often an accident of construction — the same store
code runs against screener or orchestrator storage depending on
which caller passes the SQL handle. Residency by accident is not
a ruling. The user's DO review point on the issue (2026-10-29)
therefore requires this ADR to justify DO per capability: name
the DO property each resident family actually consumes, and name
the families that consume none as D1-migration candidates rather
than grandfathering them. This decision is the evidence base for
D-G: the restated R9's "execution state" means what the matrix
below verifies — execution state and runtime — and nothing else.

### Decision

**1. The properties menu.** A DO earns its residency by consuming
one or more of:
- **(a) Agent-runtime identity** — Agents SDK / Think agent
  classes *are* Durable Objects; the instance is the agent's
  addressable, stateful runtime identity.
- **(b) Per-instance serialization** — one instance processes one
  request at a time, giving lock-free atomic read-modify-write
  over its own state with no cross-instance coordination.
- **(c) Per-instance alarms/scheduling** — the instance wakes
  itself and holds its own schedule.
- **(d) Live connections + hibernation** — the instance holds
  WebSocket connections (chat turns, ticker streams) and
  hibernates around them.
- **(e) Colocated strongly-consistent storage** — the instance's
  SQLite sits with its compute: read-your-writes, no network hop,
  no eventual consistency.
- **(f) Tenancy isolation by construction** — a per-login instance
  physically cannot read another login's rows; isolation is the
  addressing scheme, not a query discipline.

**2. The per-capability matrix.**

| Family (survey) | Properties actually consumed | Verdict |
|---|---|---|
| Agent runtime — Think/Agents SDK classes; SDK storage `cf_ai_chat_agent_messages` (§1.5) | (a); (d) — live chat connections are held by agent instances (the SDK chat store inside each agent DO is the residue, §1.5) | **DO-justified, definitionally.** Not a data-placement choice; the settled ThinkAgents direction runs on DOs. |
| Orchestrator ORM core — shared `mas_*` tables (§1.2) | (f) the tables live in the per-login instance; (b) chat/NLQ/jobs/autopilot writers funnel through that one instance; (e) built on the orchestrator's own SQL handle (`orchestrator.ts:658`) | **DO-justified** for the execution-state core. Lookup-shaped members (categories, external ads) show no proven (b)/(e) consumption — *unproven*, audited table-by-table at D-I step 3; the family verdict does not grandfather them. |
| Orchestrator execution machinery — `mas_async_jobs`, `mas_autopilot`, `mas_screener_presets`, `mas_report_confirmations` (§1.4, §2.1) | (b) job-tree and stage transitions are the instance's own producers writing lock-step; (e); (f) | **DO-justified.** |
| Scheduled execution — ScheduledAgent goals in `ctx.storage`; ScreenerAgent scheduled claim (§2.1, §3.1) | (c) the agent's own scheduling drives its tick (§3.2.7); (b) the claim is a check-and-set that only works serialized — its racy fallback is the standing counterexample (§3.1) | **DO-justified.** |
| Per-surface seam stores — scan / discovery (run, setup, alert) / IV history / enrichment / feed snapshots / strategy profiles (§1.3) | (e) the store is written by the run executing in the placing instance; (b) *unproven* — no store in the family uses a transaction today (§3.1); placement is caller-chosen (§1.5) | **Judgement call.** Deciding factor, ruled by the D-I step-2 audit: whether any member is read cross-instance, and whether run execution stays in the placing instance. A store another instance must *see* flips to the §3.2.7 projection pattern — `scheduleManagement`'s pause state is the named suspect. |
| #1116 provider configuration — `providerConfigStore` (§1.3, §2.3) | None of (a)–(f) by construction: fleet-global configuration in one *shared* instance — not per-login, no connections, no alarms; writes are rare administrative mutations | **D1-sufficient — migration candidate**, actioned at D-I step 1. |
| #1116 captures — `captureStore` (§1.3, §2.3) | (e) at write time only — appends happen where the fetch ran; the read side (health/cost aggregation over captures) is cross-run in shape (§5.1) but its locality is not proven by the survey | **Judgement call.** Deciding factor, ruled by the D-I step-1 audit: read locality — fleet-wide aggregation reads → D1; per-run reads → DO colocation stands. |
| Strategy-state satellites — champion/challenger set, strategy weights v2, policy state, strategy reviews, bank reselection, goals/scenarios, screen-run locks, screening activity, policy verdicts (§1.4) | (b) guarded transitions and locks mean anything only inside the instance's serialization (§3.2.2); (e) written by the deciding instance's own flows; (f) | **DO-justified.** (Chained-evidence hosting is D-F.3/G-5's question; it does not move these records by itself.) |
| Append-mostly evidence satellites — adaptation audit, job outcomes, learnings, outcome tracking, comparison-arm outcomes (§1.4, §2.4) | (e) at write time only; their durable readers are cross-run (the loop, §5) | **Judgement call, leaning D1.** Deciding factor: whether D-F's substrate families absorb them at their D-I step-4 audit; a record whose only durable reader is cross-run does not earn DO residency. |
| Config & telemetry satellites — `mas_settings`, `quote_source_setting`, `resource_*` rollups (§1.4) | None proven; the rollups duplicate the D1 telemetry path (§5.1) | **Mixed.** `resource_*` rollups: **D1-sufficient** (D-F.1 already retires the duplicate into the D1 read model). `mas_settings`, `quote_source_setting`: consumption *unproven — audit at migration time*; `mas_settings` is independently blocked by the D-A.5 single-owner ruling (G-7). |
| ResearchAgent tables — `research_settings`, `research_runs`, `research_evaluations`, `research_task_store` (§1.5) | (a) the agent is a DO; (e) the tables are its own working state, written by its runs; (f) the instance is per-login | **DO-justified** — an agent's private working state is the menu's home case. |
| SessionStore / durableKv — sessions, OAuth tokens, API keys, payment drafts (§1.5, §1.6) | (e) a session/token read must see the write that just happened; every consumer funnels through the one instance (§1.6). Explicitly **not** (f): buckets are logical — isolation inside the instance is by key discipline, not construction | **DO-justified**, on consistency and funnel grounds. The exception that proves the rule: the most availability-critical data in the system (§1.6, #1819 history); migrates last (D-I step 5). |
| IAAA audit store — whole-log JSON array on durableKv (§1.6, §3.3) | (b) its correctness today leans entirely on the single-instance funnel's serialization (§3.3) | **Judgement call on residency; the mechanism is replaced regardless** (D-F.3). Deciding factor: where D-F.3's single-writer append port is hosted — the port's contract can be honoured on either substrate; G-5 rules the wiring ownership. |
| Workflow step state (ThinkWorkflow) | — | **Out of scope.** Held by the Workflows platform, not application schema in any DO (cf. SDK-owned storage, §1.5). Nothing to justify or migrate. |

**3. The counterweight.** What does **not** justify DO residency:
fleet-global data (a single configuration for the whole platform
gains nothing from sitting in a "shared" DO instance that D1 does
not give it); cross-run analytics (the loop's questions are
fleet-shaped by definition — §5 — which is why D-F puts the
substrate on D1); single-writer lookup tables with no
serialization, alarm, or liveness need (a keyed read is the same
read in D1); and append-mostly records whose only durable readers
are cross-run. A table earns DO residency by consuming a menu
property, not by having been created inside a DO. The satellite
stores (§1.4) are the scrutiny population this paragraph is aimed
at.

**4. The ruling.**
- DO is **retained** — as the agent runtime (definitional, row 1)
  and as the execution + per-instance state substrate for the
  families the matrix verifies. That is the whole of DO's
  authority under this ADR.
- **DO is not the default home for new tables.** A new table lands
  in a DO only with a named property from the (a)–(f) menu that
  the table itself consumes, recorded in the slice that creates
  it; otherwise it lands in D1.
- "Judgement call" and "unproven" verdicts are **not
  grandfathering**: each D-I migration slice must deliver the
  audit its matrix row names, and a family whose audit finds no
  consumed property migrates to D1 at that step. "D1-sufficient"
  rows are candidates named here, actioned at their D-I step —
  this ADR migrates nothing by itself.

### Consequences
- D-A's composition roots place per this matrix, not per
  convenience (D-A.3 as amended).
- The satellite population (~25 tables, §1.4) shrinks by audit,
  not by blanket migration — several families stay, on evidence.
- If G-1 refuses the R9 restatement, point 4's new-table default
  still stands: it is a placement discipline, not part of the
  gate.

## D-A — The layer's shape: per-aggregate ports, per-store adapters, per-DO composition roots

### Context
The survey's port catalogue (§2) groups ~35 aggregates across
execution state, reports/content, config, audit/evidence, and
intelligence read models. The `src/data` pattern (11 port families,
each with D1 + in-memory adapters, wired by `create*Ports.ts`
composition roots) is proven. The alternative — one data facade —
would recreate the `DatabaseORM` monolith ("knows every table", §6.3).

### Decision
1. **One layer, per-aggregate ports.** Every aggregate in the §2
   catalogue gets a port in domain terms; callers depend only on
   ports. Composition roots are per DO (mirroring `create*Ports.ts`),
   wiring that DO's adapters. One port may have several adapters
   (DO-SQLite, D1, in-memory; Postgres per D-H).
2. **All three existing idioms consolidate behind the layer.**
   `src/data/` is the template and stays. `src/orm/` and the
   per-surface stores are migrated behind ports per D-I; `src/orm/`
   does **not** survive as a fourth idiom — its repositories become
   DO-SQLite adapters or are retired into them (ADR 0002 already
   ruled it is not the foundation ORM). A store module that takes a
   raw `SqlStorage` seam from a caller is, by definition, not yet
   migrated.
3. **Store→DO placement is data, not a property of the store
   module.** The same store code today runs against screener or
   orchestrator storage depending on the call site (§1.5); ports are
   placement-neutral, composition roots decide placement.
   Placement is justified per family by D-0: a composition root
   places a store in a DO only where the D-0 matrix (or its
   migration-step audit) names a DO property that family
   consumes; the default for a new family is D1.
4. **DO schema state becomes queryable.** The first DO migration
   slice lands a per-instance schema-version marker (the DO analogue
   of D1's `_migrations`, §4.2) before moving any table; DO schema
   evolution thereafter follows migrationRunner discipline
   (versioned, idempotent, marker-last) even where the mechanism
   differs.
5. **One owner per table.** A port has exactly one owning module per
   table. `mas_settings` — written today by at least three modules
   (§7 R-2) — gets a single-owner ruling before its port is written;
   until then its migration is blocked, not improvised.

### Consequences
- Callers (orchestrator, NLQ, routes, workflows) change imports, not
  behaviour; each migration slice is behaviour-pinned (D-I).
- The layer's directories are the unit the D-D enforcement pin
  allow-lists.
- The unversioned D1 telemetry table (`resource_sql_ops`, self-created
  outside the runner, §1.1) is an existing violation of the shape; it
  is regularized (brought under the runner) in an early slice, not
  grandfathered silently.

## D-B — The dialect ruling: raw SQL behind ports for DO SQLite; Drizzle for D1 and Postgres

### Context
Drizzle has no DO-SQLite dialect (ADR 0020). The issue's question (a)
offered three options (§6.1): (i) a custom Drizzle driver over
`ctx.storage.sql`; (ii) Drizzle sqlite-proxy against DO storage;
(iii) raw SQL behind ports for DO, Drizzle where a dialect exists.
Every DO store already sits behind a `SqlStorage`-shaped seam, and
the highest-value DO surface already abstracts execution behind
`Repository<T>` — the port contract, not the query builder, is where
DO-side discipline is missing.

### Decision
**Option (iii).** Ports own the contract everywhere. DO-SQLite
adapters keep SQL — externalized into the layer per D-D, typed at the
port boundary, conformance-tested like every other adapter.
D1 adapters use Drizzle (status quo). A future Postgres adapter uses
Drizzle (D-H). The recorded direction's phrase "CRUD as typed
Drizzle" is therefore scoped: typed Drizzle behind ports **on the
dialects that have it**; on DO SQLite the equivalent property is
typed ports + encapsulated SQL + the shared conformance suite. (This
scoping follows the survey's verified facts over the direction's
wording; it is flagged here, not buried.)

Schema derivation contract: shared column definitions are the single
source; per-dialect table modules (sqlite-core today, pg-core later)
are built from **shared column-definition factories**, so the two
dialect schemas cannot drift silently. The binding derivation rules
are the portable subset already recorded in ADR 0002 R2 and the
migration headers: `?`-style parameters, epoch-ms integer timestamps,
no dialect date functions, no `RETURNING` in the portable path,
`ON CONFLICT` idempotent upserts. New schema must satisfy them.

Rejected: (i) a custom driver is unproven infrastructure this
programme would own forever, bought before any evidence the ports
leak; (ii) sqlite-proxy assumes a request/response SQL endpoint
shape that per-instance DO storage does not naturally expose.
Revisit (i) only as a time-boxed spike if the conformance suite
shows DO-adapter drift costing more than driver maintenance (§6.1).

### Consequences
- "One implementation" is enforced at the port + conformance level,
  not the query-builder level; the conformance suite (D-H) is what
  makes a DO adapter and a D1 adapter interchangeable in fact.
- The issue body's acceptance escape hatch ("recorded single-adapter
  exception with reason") is exercised here as a per-store-class
  exception, recorded once, in this ADR.

## D-C — The transaction aspect: an AOP aspect at the port boundary

### Context
The user direction (issue comments 6494857135, 6494975721) requires
transaction management as AOP, aligned with the #1969 AOP programme:
an aspect in the established idiom, outcomes catalog-emitted. The
survey found the idiom is split (discrepancy D3): the higher-order
wrappers (`withLogging`/`withSecurity`/`withExceptionHandling`,
#817) live in `src/errors/errorAspects.ts`; `src/aspects/` holds
`loggingAspect.ts` (aspect events + `AspectContext`) and
`errorCodes.ts` (the catalog family). The fit-gap analysis (#1824)
scores no transaction aspect — this ADR adds the row.

### Decision
1. **Home: `src/aspects/`.** `withTransaction` lives beside the
   catalog family in `src/aspects/`, implemented as a higher-order
   wrapper in the `errorAspects` shape (context object + wrapped
   call). This ADR explicitly names the `src/aspects/` vs
   `src/errors/errorAspects.ts` split as a pre-existing inconsistency;
   a future consolidation may unify the two homes, but no slice in
   this programme moves the older wrappers.
2. **Mechanics.** The aspect wraps a port call as one unit of work:
   open → commit on success → roll back on throw. Nested calls join
   the ambient unit of work. Callers and repositories contain no
   begin/commit logic. Per store, the unit is implemented with that
   store's real primitive: DO SQLite via the storage transaction
   primitive, D1 via `batch()` (never `db.transaction()`, which
   ADR 0002 verified is sequential BEGIN/COMMIT and not
   Postgres-equivalent atomicity on D1).
3. **The contract is the least-common unit of work** every store can
   honour: atomic application of the writes in one wrapped port
   call, or honest failure. A store that cannot honour a declared
   scope **fails honestly with a typed catalog code** — the
   screener-claim pattern of silently degrading to a racy fallback
   (§3.1) is the named anti-pattern and is forbidden for in-scope
   multi-writes. Cross-store atomicity is not claimed (ADR 0002's
   platform fact stands): cross-DO/cross-store operations (e.g. the
   payments ledger, §3.2.4) are atomic-or-honestly-failed **at the
   port level** via idempotency + recorded outcomes, not via a
   distributed transaction.
4. **Outcomes are catalog-emitted** (the #1969 rule): commit,
   rollback, and cannot-honour outcomes carry codes/messages from
   the single catalog, emitted by the aspect; success outcomes
   included. No inline outcome strings at call sites.
   (Emission of these outcomes into the trace substrate is part
   of the publication decision, D-F2.)
5. **Precondition — prove the primitives first.** Both primitives
   the contract rests on are unexercised in this codebase today:
   `transactionSync` zero usages, D1 `batch()` zero usages (§3.1,
   D4). The first implementation slice is a platform proof: pins
   demonstrating real atomicity/rollback through the Agents SDK
   storage facade on DO, and through `batch()` on D1 (with the
   ADR 0002 test-fidelity caveat: the node:sqlite mock's interactive
   transactions are stronger than real D1's and prove nothing about
   it). **No catalogue migration may rest on the aspect until the
   proof slice is green.** If DO transaction semantics differ from
   the documented shape under the SDK facade, the contract's DO leg
   is redesigned before proceeding (§7 R-4) — that is a stop-line,
   not a footnote.

### Consequences
- The aspect's first consumers are the §3.2 ranked sites in order:
  canonical report fan-out (row↔R2-body pair first), champion/
  challenger promotion, then the remaining in-scope multi-writes.
  The IAAA chain append is substrate work (D-F), sequenced with its
  ownership gate (Open gates).
- Every multi-write port operation declares its scope; the
  declaration is reviewable surface, like a route's auth gate.

## D-D — No naked SQL above the layer, enforced by a shrink-only pin

### Context
The recorded end state (comment 6495004422): no call site holds SQL;
externalization means location/ownership into the layer, not string
files. The survey corrected the census (discrepancy D1): 94
`.sql.exec(` sites across **16** files — the direction said 14; the
two extra files are pass-through shims (`src/actors/cfAgentsAdapter.ts`,
`src/mcp/commands.ts`) — plus the indirect seam surface (§1).

### Decision
1. **Rule:** SQL (string literals, template SQL, `.sql.exec(` calls,
   storage-client imports) exists only inside the layer: adapter
   modules, the migration runner, schema modules, and recorded SDK
   shims. Above the layer — services, agents, routes, commands —
   zero. Migrations remain SQL by nature, inside the runner.
2. **Enforcement:** a source-scan conformance test in the repo's
   existing pin style (ADR 0002 R1's structural test is the
   precedent; §6.4). It fails if a SQL execution call or storage
   client import appears outside the allow-listed directories. The
   allow-list lives in the test, is **shrink-only** (entries are
   removed as surfaces migrate; an addition requires amending this
   ADR), and rolls out **warn-first over the current 16 files**,
   turning red per surface as it migrates. No big-bang.
3. **Inside the layer** is defined by directory + role, not by file
   name: `src/data/` (existing), the layer's DO-adapter homes named
   by each migration slice, `src/orm/` only while it is being
   migrated (its allow-list entries shrink to zero at D-I step 3).

### Consequences
- The rule is mechanical from day one, so "after Drizzle, no naked
  SQL" is a tested property of the tree, not a completion claim.
- The 14-vs-16 discrepancy is settled in favour of the survey's
  measurement; the direction comment's number is superseded.

## D-E — CRUD rules behind the ports

### Context
Recorded direction (comment 6495004422), confirmed against the
codebase's existing idempotency discipline (§3.1).

### Decision
CRUD is typed code behind per-aggregate ports (Drizzle query
builder where D-B applies; encapsulated SQL in DO adapters):
1. **Creates declare their conflict policy explicitly** — insert vs
   upsert is a stated property of the port operation wherever
   redelivery/idempotency applies (the migration-0003 pattern:
   composite PK + `ON CONFLICT DO NOTHING` as the at-least-once
   guarantee).
2. **Updates verify affected-row counts** and fail honestly
   (typed catalog code) when the count is not what the operation
   declared — no silent no-op updates.
3. **Deletes are explicit domain operations** (revocation is the
   everyday case), distinct from retention-driven removal, which
   follows the `storageRetention.ts` contract (ADR 0002 R8) and is
   extended per table family by the slice that migrates it.
4. **No naked CRUD:** there is no generic "run this SQL" port
   method; a port that degenerates into a query passthrough is a
   layer defect, reviewable as such.

### Consequences
- Behaviour differences from today are confined to cases that were
  silently wrong (no-op updates, unstated conflict policies) — each
  such discovery in a migration slice is disclosed on its PR, not
  absorbed silently.

## D-F — The intelligence substrate: five data-model commitments

### Context
Requirement source: issue comment 6495037697. Evidence: survey §5.
Boundary, recorded and kept: the foundation supplies the substrate;
the loop's brains (eval harness, proposal generation, self-healing
analysis) stay with #2225 G13 / #798 and are not designed here.
The mechanism by which DO-resident data reaches these families —
publication, not sharing — is decided in D-F2 (below).

### Decision
1. **Analytical read models are enumerated, not accidental.** D1
   hosts the projection/read-model families (§5.1: governance,
   chains, schedules, shard jobs, audit reports, market graph,
   thesis/calibration, commercial/journal/ledger). The ADR's slice
   plan names the mandatory additions: a **unified cost/latency
   read model** across agents and workflows (today fragmented
   across telemetry rollups and `mas_transactions`), and retirement
   of the duplicate rollup path (DO-side rollups vs D1
   `resource_sql_ops`) into one implementation.
2. **A unified trace substrate is a new D1 table family.** One
   record per cross-agent call / workflow step: correlation id,
   causation (parent) id, acting agent, principal, operation,
   outcome code (catalog, per #1969), latency, cost fields.
   `mas_events` cannot serve (§5.2: per-DO, session-scoped, opaque
   payload, no correlation fields); Analytics Engine cannot serve
   (fire-and-forget, no in-repo read port). Writes follow the #1133
   capture discipline: never throw into the caller's path; failures
   recorded with stable codes (the `captureStore` pattern).
3. **Append-only evidence carries two-part attribution.** Every
   loop-relevant family (events, traces, proposals, ledger) records
   **acting agent + principal** in the #2225 G14 shape, generalizing
   the `mas_transactions` proposer/authorizer seed (§5.3).
   Concretely: `mas_events` gains a principal column and
   correlation fields (it has acting-agent only today), and chained
   evidence gets a real append substrate — an append-only table
   behind a single-writer port — replacing the whole-log JSON array
   store (`iaaaAuditStore`, §3.3) for new evidence. The Q7-ratified
   hash chain (#945) is the mechanism the substrate hosts; wiring
   `mas_events` through it is gated (Open gates), not assumed done.
4. **A proposal ledger is a foundation state machine.**
   proposed → approved → applied → verified, as one table family +
   port, with the gate recorded as data (approver, under which
   issue/PR) so no-self-merge / no-silent-promotion is enforced by
   the substrate: a transition without a recorded gate does not
   exist. The shape generalizes the champion/challenger guards
   (self-approval and system-actor prohibitions, §5.4) as substrate
   rules; domain evaluation (whether a proposal *should* pass)
   stays in the domains.
5. **The fleet registry and conformance matrix are data.** A D1
   read model + port: one record per agent (class, binding,
   instance scheme, migration tag, card operations, G14 identity
   record) and per-cell matrix status (IMPLEMENTED /
   NOT-APPLICABLE / GAP + slice reference), read by the UI and the
   loop alike (§5.5). Population duty is gated (Open gates).
   Per-instance DO schema versions (D-A.4) report into it.

### Consequences
- The substrate families are new D1 tables — additive, no migration
  risk to live surfaces — and land early (D-I), so loop consumers
  are not blocked on the DO migrations.
- Retention for the trace family is not decidable inside this ADR
  (Open gates); until ruled, trace rows follow the strictest
  existing analogue and the volume risk (§7 R-5) is carried openly.

## D-F2 — Publication: how DO-resident data becomes foundation data

### Context
D-0 deliberately leaves data resident in agent DOs, and D-F builds
the intelligence substrate on D1. Neither decision, by itself,
moves a single fact from one side to the other. Left undecided,
the mechanism defaults to the worst available shape: a consumer
that needs fleet-level truth addresses agent DOs at query time
and merges what it finds — coupling analytical reads to instance
availability, cardinality, and latency, and reintroducing
cross-tenant reads through whoever can address instances. The
user's review point on the issue (2026-10-29, recorded as comment
6496149783) requires the mechanism to be an explicit decision.
The Sentinel programme (#2279) is the forcing consumer: its
consumption contract (S-0) reads only the published plane and
files a substrate gap for anything not published — never a
workaround read against an agent's storage.

Precedents in the record: the projection pattern (§3.2.7 — the
halt fix: execution state stays in DO, cross-instance truth moves
to a D1 projection with honest, fail-closed read semantics); the
corpus sync (#1169 S4-4: scheduled sync riding an existing tick,
with integrity legs reconciling source against projection); the
#1133 capture discipline (D-F.2); and the report fan-out legs
(§3.2.1), which are publication in ad-hoc, best-effort form —
this decision gives that shape a contract.

### Decision
1. **Publication, not sharing.** No substrate consumer reads an
   agent's tables. A DO-resident fact becomes foundation data by
   being published into the plane; agents do not share tables,
   they publish facts. Two publication kinds, by data shape:
   - **Event- and trace-shaped facts are emitted at write time.**
     The emission points are the AOP aspects: the transaction
     aspect (D-C) emits its catalog outcomes into the trace
     family as part of the wrapped call, and the audit path emits
     evidence records the same way. Emission rides the write; it
     is not a second system bolted on afterwards. This binds D-C
     to D-F: an operation wrapped by the aspect is, by that
     wrapping, published.
   - **State-shaped data is projected by scheduled sync.** Where
     the truth is a current value rather than a fact stream, a
     sync projects DO state into its D1 read model, following the
     corpus-sync pattern (#1169 S4-4): it rides an existing
     scheduler tick (no new cron is created for projection),
     reconciles source against projection with divergences
     recorded — never silently healed — and carries honest read
     semantics on the projection (§3.2.7). Each state family's
     sync cadence is declared in the slice that migrates it;
     cadence and ownership are settled here as mechanism, and are
     not a gate.
2. **Anti-pattern: query-time fan-out.** Analytical and
   fleet-level reads never fan out across agent DOs at query
   time; a read path that enumerates instances to answer a
   question is a design defect under this ADR. The stated
   exception is narrow: addressed single-instance reads for a
   point lookup by an operator or user surface — the SearchHub
   MAS precedent (one addressed orchestrator instance read for a
   single query and merged with index results for presentation).
   That is a read of one known instance, not a scan across
   instances, and it does not generalize into a substrate access
   path.
3. **Publication honesty is a hard requirement.** Emission and
   sync follow the #1133 discipline: publishing never throws into
   the caller's path, and a failed publication is recorded with a
   stable catalog code — never dropped silently. The consequence
   is stated plainly because consumers depend on it: a silently
   lost projection is a blind spot in the intelligence layer's
   evidence base. Substrate consumers therefore treat a missing
   signal as a filed substrate gap, never as evidence that
   nothing happened (the Sentinel's S-0 rule, adopted here as the
   general consumer discipline for the plane). Absence of
   evidence is a defect report, not a finding.
4. **Work-item events are a substrate family.** GitHub issues,
   PRs, and check-runs are projected into the plane as events
   (opened / commented / closed / merged / check outcomes, with
   actor, timestamps, and links to the work records), specified
   by #2279 S-1 with the Sentinel as specifying consumer. The
   family is D1-native like the other substrate families (D-G's
   restated text covers it) and is populated by sync: GitHub
   remains the system of record; the projection is the queryable
   copy. This family is what "the sentinel learns from its own
   issues" literally reads — the fleet's issue corpus, the
   sentinel's own proposals, and their ledger outcomes (D-F.4),
   in one event plane.
5. **The consumer rule is general.** The Sentinel's S-0 contract
   is adopted for every consumer of the plane, not just the
   Sentinel: read only the published plane; a signal that is not
   published becomes a #1976 substrate gap, filed — never a
   direct read against agent storage.

### Consequences
- D-F's families now have an arrival mechanism: traces and
  evidence arrive by aspect emission, read models and work-item
  events by integrity-checked sync. D-I step 0 creates the
  work-item family alongside the other substrate families.
- The aspects gain a second duty — publication — and their
  conformance expectations change with it: a wrapped operation
  that does not emit is a defect, reviewable in the D-C proof
  slice's terms.
- Projections are eventually consistent by design; a caller
  needing read-your-writes stays on the DO (D-0 property (e)).
  The plane carries cross-instance truth, not the writer's own
  next read.

## D-G — GATE: the R9 restatement

### Context
ADR 0002 R9 and ADR 0020 decision 2 rule that D1 is not a
replacement for DO storage: execution state stays DO-authoritative;
D1 is projection/read-model. The intelligence requirements (D-F)
make D1 the native home of families that are not projections of DO
state at all (traces, proposals, registry). The survey recommends
re-ratifying R9 with that extension named (§6.6); nothing in the
recorded direction asks to move execution authority.

### Decision — RATIFIED 2026-10-29 (user build directive)
Restated text, **ratified**:

> "D1 hosts projections, read models, and the intelligence
> substrate; DO storage remains authoritative for execution state.
> "Execution state" means what D-0 verifies: the agent runtime
> itself and the per-instance families that consume a named
> Durable Object property; DO residency is not a default home
> for new tables (D-0).
> Substrate families (trace, proposal ledger, fleet registry) are
> D1-native: D1 is their authority, not their projection. No
> execution state moves to D1 under this ADR."

### Consequences if ratified / if refused
Ratified: D-F proceeds as written. Refused (R9 kept verbatim): the
substrate families need a different authority story before D-F
slices are filed — the rest of this ADR is unaffected.

## D-H — GATE: Postgres — designed-for vs build-now

### Context
The recorded direction requires Postgres portability by design:
no SQL above the ports (D-D), dialect schema behind one seam (D-B),
dialect-neutral transaction contract (D-C). ADR 0002's slice-3 note
records the owner's 2026-10-26 deferral ("for now do R1/sqlite"),
and its acceptance logic: a dialect is proven by the conformance
suite passing unchanged against a second adapter.

### Decision — RULED 2026-10-29: designed-for (the recommendation), not built now
**Designed-for, not built now.** The conformance
trio that proves the seam today is **D1 + in-memory + DO-SQLite**:
the same per-port suite passes unchanged against all three (the
two-adapter pattern already exists in `src/data`; DO-SQLite is the
third leg this programme adds). A real Postgres adapter is filed as
designed-for: pg-core schema module derived from the shared column
factories, a pg implementation of the migration runner's store
surface, Hyperdrive as the connection path. The tenancy/sharding
mapping (per-instance DO → centralized PG) is switch-time design,
named here and deliberately not designed in this ADR.

### Consequences
- If the owner directs build-now instead: it becomes one additional
  slice after the D-C proof slice, scoped to the port catalogue's
  D1 families first; no other decision in this ADR changes.
- Either way, "Postgres won't be a problem later" is a property the
  conformance suite tests continuously, not a claim this ADR makes
  on faith.

## D-I — Migration sequencing and explicit outs

### Context
Sequencing evidence: §6.5. Principles: prove the pattern on bounded,
already-conformance-tested surfaces before touching the chat hot
path; substrate is additive and goes early; auth/evidence-critical
surfaces go last, flag-gated.

### Decision — sequence
0. **Proof slice** (D-C.5): transaction primitives proven on DO and
   D1; DO schema-version marker (D-A.4); trace/proposal/registry/
   work-item table families created (D-F, D-F2) — additive, no
   live surface moves.
1. **Data-provider platform stores** (`providerConfigStore`,
   `captureStore`) — already seam-shaped, already covered by the
   #1116 conformance kit; proves the port + aspect pattern
   end-to-end. Per D-0, provider configuration is the programme's
   first D1-migration candidate (actioned here), and the capture
   store's residency is ruled by this step's audit.
2. **Options/discovery store family** (scanRun, discovery run/setup/
   alert, ivHistory, strategyProfile) — pure seam stores; retires
   66 of the 94 exec sites.
3. **The ORM core** (shared `mas_*` tables) — highest value, highest
   blast radius (orchestrator + NLQ + routes, §7 R-1); the pattern
   is proven twice by now. Includes the canonical report fan-out
   under the aspect (§3.2.1) and champion/challenger promotion
   (§3.2.2).
4. **Satellite service stores** — mechanical follow-ons, grouped by
   table owner; `mas_settings` waits for its D-A.5 ruling.
5. **Session/durableKv + IAAA store last** — availability- and
   evidence-critical (#1819 history); parallel-run / flag gating
   per the issue's failure/recovery criterion.
The D-D pin turns red per surface as each step lands; the allow-list
only shrinks.

**Explicitly out** (§6.8): R2 (referenced via projection ports,
not absorbed), Vectorize, the AI Search instance, Analytics Engine
(stays a telemetry sink; the trace substrate is a table family, not
an AE read layer), Think SDK storage (`cf_ai_chat_agent_messages`,
SDK-owned), and the RSI loop's machinery (#2225 G13 / #798).

### Consequences
- No big-bang: every step is independently mergeable under the
  gitops one-issue-one-PR discipline, and the programme can stop
  after any step with the tree in a coherent, pin-enforced state.

---

## Open gates

Decisions this draft could not settle, with the owner of each.
Implementation slices that depend on a gate do not start until it
clears; the rest of the programme is not blocked by any single gate.

| # | Gate | Owner | Blocks |
|---|---|---|---|
| G-1 | **R9 restatement** (D-G) | User / repo owner | **RULED 2026-10-29: ratified as written (D-0-scoped).** D-F slices unblocked. |
| G-2 | **Postgres timing** (D-H) | Repo owner | **RULED 2026-10-29: designed-for.** The pg adapter stays a filed-for-later slice. |
| G-3 | **D1 migration versions 13/14** (§1.1, §7 Q-3): registered sequence is 1–12 + 15. Reserved, withdrawn, or lost? The migration story needs the answer recorded. | Repo owner / CAIO | Nothing builds on it; the record itself |
| G-4 | **Trace retention + sampling economics** (§7 R-5/Q-4): per-call trace writes multiply D1 volume (the #1819 rows-read lesson). What volume does the loop need retained, for how long? | Repo owner | Trace family retention line; substrate write volume |
| G-5 | **Q7 chain-wiring ownership** (§7 Q-5): does wiring `mas_events` through the IAAA hash chain + a verify entry point ride D-F's evidence slice, or stay a separate security-lane slice the foundation merely hosts? | CDO vs CISO (lane ruling) | D-F.3 chain wiring |
| G-6 | **Registry-as-data writer** (§7 Q-6): which production job owns populating the registry/matrix read model — deploy-time seed or scheduled sync (the S4-4 pattern)? | CDO (design) + owner (activation) | D-F.5 population |
| G-7 | **`mas_settings` single owner** (D-A.5, §7 R-2): which module owns the table before its port is written? | CDO (design) | D-I step 4 (settings only) |

## Consequences (overall)

- ADR 0002's R1–R8 stand unchanged; R9 stands until G-1 rules.
  This ADR's authority, once accepted, is the repo-wide extension:
  ports everywhere, the transaction aspect, the enforcement pin,
  and the intelligence substrate.
- The programme's honest centre of risk is not design but proof:
  two never-executed platform primitives (D-C.5) and one
  high-blast-radius migration (D-I step 3). Both are sequenced
  accordingly.
- Nothing in this ADR claims a capability the code does not have:
  where the recorded direction and the survey's measurements
  conflicted (file census, aspect home, exercised transactions,
  migration range), the survey governs and the conflict is named
  in the decision it touches (D-B, D-C, D-D).
