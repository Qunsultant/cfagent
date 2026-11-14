# 0032. Drizzle is the data-access standard; the mini-ORM is the DO standard

- Status: proposed
- Date: 2026-11-14
- Deciders: owner (decisions recorded 2026-11-14; the mini-ORM decision corrected the same day — see Decision 2)
- Issue: #3260
- Implementing PR: this PR (main commit recorded on merge)

## Context

Plain version: the app talks to its databases through one port layer, but
underneath the ports there are two different ways of writing the actual
database code — Drizzle on D1, and a home-built mini-ORM on Durable
Object SQLite. This ADR picks one standard per plane, keeps the mini-ORM
as the DO standard, and names what stays different on purpose.

#1976 put one port layer over every store. Under it, the implementation
split two ways (measured on main `67a1c0d6`, 2026-11-14):

1. **Drizzle adapters** — 55 files in `src/` import `drizzle-orm`, all on
   the D1 plane. The schema lives in one file, `src/data/drizzleSchema.ts`
   (101 tables, the only `sqlite-core` importer in the repo). There is no
   Postgres anywhere: zero `pg-core` importers. D1 was Drizzle from
   day one.
2. **A bespoke mini-ORM** — 2,094 lines in six modules
   (`ormRepositoryCore.ts`, `ormFacade.ts`, `ormSchema.ts`,
   `createOrmPorts.ts`, `doSqliteOrmAdapters.ts`,
   `inMemoryOrmAdapters.ts`). It serves the generic repository-shaped
   families with one implementation running identically over Durable
   Object SQLite and in-memory stores.

Two corrections to the issue's framing, both verified on current main.
First, the mini-ORM's runtime is DO-only: its only D1 surface is shared
column maps that the Drizzle marketplace adapter borrows
(`d1MarketplaceAdapter.ts` imports `AD_COLUMN_MAP` and friends from
`doSqliteOrmAdapters.ts` — maps, not the ORM runtime). There is no
mini-ORM-to-Drizzle migration, because there is no mini-ORM on D1 to
migrate. Second, the DO plane itself is split: the ORM core serves 13
tables plus the dataset families, while 41 of 48 `doSqlite*.ts` files run
hand-written SQL through the DO storage seam (`this.sql.exec(...)`),
plus three D1 adapters still on the raw D1 `prepare` API. Nothing pins
the mix, so every new family re-decides.

(The issue's own numbers were measured on its base `07f6df65`,
2026-11-05 — 40 Drizzle files then, 55 now. The inventory below is
current main.)

## Inventory — families × mechanism (current main `67a1c0d6`)

| Plane / family | Mechanism today | Standard under this ADR |
| --- | --- | --- |
| D1 adapters | Drizzle — 55 `src/` files import `drizzle-orm`; schema 101 tables in `src/data/drizzleSchema.ts` | **Drizzle (the standard)** — no change |
| D1 raw-`prepare` adapters (3) | `d1ResourceRollupAdapter.ts`, `d1ResourceUsageAdapter.ts`, `d1QuoteSourceAdapter.ts` — 0 Drizzle imports, `this.db.prepare(...)` | Move to Drizzle, or a named exemption with the reason recorded in the pin |
| DO SQLite via the mini-ORM | 13 tables bound through the generic `Repository` in `src/data/doSqliteOrmAdapters.ts` (5 adapter classes + 8 factories: messages, events, memory, transactions, reports, categories, referrals, ads, external ads, webhook nonces, trades, watchlists, options-chain cache); the settings family (`mas_settings`) is implemented directly in the same file; 6 `doSqlite*` dataset/job-pipeline/marketplace adapters + 6 `inMemory*` counterparts | **Mini-ORM (the DO standard)** — kept; all agents use it |
| DO SQLite, hand-written SQL | Raw SQL via `this.sql.exec(...)` — 41 of 48 `doSqlite*.ts` files; the other 7 delegate to a shared executor or are deprecated/infra. Includes the StockCopilot store family (positions, activity, control, memory — `doSqliteStockCopilot*Adapter`s) | **Migrate onto the mini-ORM**, or a named exemption with the reason recorded in the pin |
| DO, not SQL at all | Session family (KV-backed over the SessionStore DO, bucket `"sessions"`), audit family (the DO's own `audit-append` op), bucket family (KV-backed) | Stay as-is — named, not SQL |
| In-memory twins | `inMemoryOrmAdapters.ts` + 6 `inMemory*` dataset adapters; 254 test files import the in-memory adapter modules | Test/dev only — never a production store; each family's twin is rebuilt on its new mechanism as part of that family's slice |
| Non-SQL stores | R2 bucket `screener` (`REPORTS_BUCKET`), Vectorize index `vector-memory` (`VECTOR_MEMORY`), AI Search instance `screener-search`, namespace `default` (`AI_SEARCH`) | Named exceptions, outside Drizzle scope — not migrations |
| Workers KV | No binding declared in `wrangler.jsonc` (two namespaces still exist in the account, unbound and unused) | Not a store |

## Decision

User decisions, recorded 2026-11-14:

1. **Drizzle ORM is the standard for data access.** Where a Drizzle
   dialect exists, adapters use typed Drizzle behind the port. Today that
   means D1; a future Postgres adapter would use Drizzle too (ADR 0022
   D-H).
2. **The mini-ORM is kept as the DO standard — the standard way of
   abstracting DO SQLite, used by all agents.** Correction, recorded
   the same day: an earlier ruling the same day said "retire the
   mini-ORM". That ruling was wrong on the facts and is superseded
   here. D1 was Drizzle from day one, so there is no mini-ORM on D1 to
   migrate; the mini-ORM's runtime is DO-only, and retiring it would
   remove the one shared abstraction over DO storage with nothing to
   replace it — Drizzle cannot reach DO storage (see "Why Drizzle
   cannot go behind DO SQLite" below). The six modules stay. The
   hand-written DO adapters migrate onto the mini-ORM slice by slice,
   or get a named exemption with the reason recorded in the pin.
3. **The DO-plane mechanism is the mini-ORM over DO SQLite, behind
   ports.** Raw SQL lives inside the layer (the ORM core builds it from
   the column maps; the hand-written adapters hold it directly) and
   never above the port boundary — ADR 0022 D-B's "raw SQL behind
   ports" ruling, with the standard abstraction now named. Revisit
   trigger only: a time-boxed custom-driver spike if the conformance
   suite shows DO-adapter drift costing more than driver maintenance
   (ADR 0022 D-B).
4. **The three raw-`prepare` D1 adapters move to Drizzle**, or get a
   named exemption with the reason recorded in the pin.
5. **Vectorize, R2, and AI Search are non-SQL stores outside Drizzle
   scope** — named exceptions, not migrations. Drizzle is a SQL ORM; it
   has no Vectorize dialect.
6. **A mechanism-mix pin** (extension of
   `tests/global_dd_census_2356.test.ts` or a sibling) counts the
   mechanism mix per family, so re-divergence fails CI the way
   above-layer SQL already does.
7. **Out of scope:** port contract changes; #3251; the Postgres
   question; DO residency itself. No Postgres exists in the repo today;
   any future Postgres move covers the D1 plane only — DO SQLite cannot
   move, it is platform storage. Residency — which families earn DO
   storage at all — is ADR 0022 D-0 / D-I's question, already recorded:
   a family earns DO residency by consuming a property from the (a)–(f)
   menu (agent-runtime identity, per-instance serialization, alarms,
   live connections, colocated consistency, tenancy isolation); families
   consuming none migrate to D1 at their D-I step.

## Why Drizzle cannot go behind DO SQLite

Drizzle does support SQLite as a family — its D1 driver is SQLite under
the hood. What it does not have is a first-class driver for Durable
Object `ctx.storage.sql`. Same engine family, different product and
access path. Drizzle binds to driver APIs, not the engine: its SQLite
drivers speak better-sqlite3 / `node:sqlite` / D1 prepare-bind / Turso
shapes, while DO exposes `ctx.storage.sql.exec(sql, ...params)` returning
a cursor (see `src/actors/cfAgentsAdapter.ts:54`,
`src/agents/orchestrator.ts:778`). Bridging that gap is the custom-driver
option (i) ADR 0022 D-B rejected as unproven infrastructure this
programme would own forever, bought before any evidence the ports leak;
sqlite-proxy (option (ii)) assumes a request/response SQL endpoint shape
that per-instance DO storage does not naturally expose. This is why the
mini-ORM stays: it is the abstraction Drizzle cannot be for DO storage.

## Why DOs cannot just use D1 instead of SQLite

DOs already use D1 where the data is shared — the orchestrator reads
the `AGENT_DB` projection for cross-agent queries (#1546). What D1
cannot replace is the per-instance state: a DO's SQLite sits with its
compute (read-your-writes, no network hop), its single-threaded
serialization gives lock-free atomic read-modify-write over its own
state, its alarms and live connections belong to the instance, and a
per-login instance physically cannot read another login's rows.
D1 is a separate service over a network hop with none of those
properties, and the Agents SDK stores chat state in the agent DO by
framework design. A family earns DO residency by consuming a property
from the (a)–(f) menu (Decision 7); families consuming none are already
named D1-migration candidates under D-I (provider configuration,
`resource_*` rollups). DO SQLite is the per-instance execution-state
substrate; D1 is the shared projection. They are two homes, each earned.

## The two memories — do not conflate them

Agent memory is two things, and this ADR touches neither's purpose:

- **Session facts** are the `mas_memory` table in DO SQLite behind
  `MemoryPort` — key-addressed, keyword `LIKE` search, `listRecent`,
  clear, and a retention selector; read by MCP `manage_session_memory`
  and REST `GET /memory`. Per-instance, by ADR 0022 D-0. The memory
  adapter is one of the 13 DO tables served by the mini-ORM. Moving
  facts off DO SQLite is possible in principle (a D1 adapter would have
  to be built — none exists; Vectorize cannot do exact key CRUD,
  clear, or retention), but it would trade construction-level tenancy
  isolation and colocated consistency for query discipline plus network
  hops, and the SDK's chat state cannot move at all. That move, if ever
  wanted, is a D-I slice with its audit — not this ADR.
- **Vector memory** is long-term semantic recall: text is embedded with
  Workers AI model `@cf/baai/bge-base-en-v1.5` and upserted into the
  Vectorize `vector-memory` index; `recallForPlan` embeds the query and
  returns the top 8 chunks injected into the orchestrator prompt so
  planning is grounded in past outcomes
  (`src/memory/vector-memory.ts`). The same index and model also serve
  the report semantic index (#1775). Recall failure is fail-soft — it
  never breaks compilation. Vectorize is also one of the 5 uncreatable
  layers in the #4282 P5 recreate (no re-index flow). Vectorize is used
  by the orchestrator's chat turns, goal chains, the retrieval/search
  ports, messaging routes, and the report index — not only through
  StockCopilot. StockCopilot's own door does not call VectorMemory
  directly; its state (positions, activity, control, memory) lives in
  DO SQLite via hand-written adapters, and Vectorize cannot hold that
  state: it is similarity search, not transactional per-instance state.

## Migration list

1. **The 41 hand-written DO adapters → onto the mini-ORM**, slice by
   slice, each passing the family's existing conformance suite
   unmodified (a suite that must change is a finding to stop and report,
   not an edit to make quietly) — or a named exemption with the reason
   recorded in the pin. The StockCopilot store family is part of this
   list.
2. **The three raw-`prepare` D1 adapters** → Drizzle, or a named
   exemption in the pin.
3. **The mechanism-mix pin** (Decision 6), landing with the first
   migration slice so the standard is enforced from the start.
4. **D-I residency audits** (ADR 0022 D-0/D-I), already scheduled:
   families consuming no DO property migrate to D1 at their step.

Each slice: the family's conformance suite unmodified + targeted
regression + full-suite exact-delta accounting, candidate vs pristine
control, as in the #1976 slices. Sabotage check: reintroduce a
non-standard mechanism in a migrated family → the mix pin goes red.

## Acceptance criteria

From #3260, restated against this ADR:

- This ADR merged, recording the per-plane standard and the mini-ORM's
  standing as the DO standard.
- The inventory above matches the code; the mix pin reproduces it in CI.
- Each accidental-divergence family migrated onto its plane's standard
  or formally exempted in the pin with its reason.
- All conformance suites green unmodified across every migration slice;
  census surfaces unchanged (surface 1/2/3 counts do not grow).

## Consequences

- One idiom per plane: Drizzle on D1, the mini-ORM on DO, and named
  non-SQL stores outside both. Reviews, conformance suites, and future
  families all get cheaper; a semantic quirk can only live in one
  mechanism per plane.
- The DO plane keeps its own abstraction permanently unless the
  Decision 3 trigger fires. That is a deliberate, recorded asymmetry —
  not a gap to close quietly later.
- Keeping the mini-ORM unblocks #4282 P6 (DML externalization): the DML
  moves now have a known target mechanism per plane instead of three
  candidates.
- The in-memory twin is rebuilt per family, not carried over. A slice
  that cannot keep its family's suite green in plain Node (no
  `ctx.storage.sql` there) stops and says so instead of weakening the
  suite.

## Alternatives considered

- **Retire the mini-ORM (migrate-then-delete).** Ruled the same day
  this ADR was drafted, then corrected by the user the same day:
  wrong on the facts. D1 was Drizzle from day one, so there is no
  mini-ORM on D1 to migrate, and the mini-ORM is the only shared
  abstraction over DO storage. Recorded here so the reversal is visible,
  not buried.
- **Delete the mini-ORM now, migrate later.** Rejected: deleting first
  would leave the 13 DO tables and the dataset families with no
  implementation behind their ports.
- **Write a custom Drizzle driver over `ctx.storage.sql`.** Rejected by
  ADR 0022 D-B and confirmed here: unproven infrastructure owned
  forever, bought before any evidence the ports leak.
- **Drizzle `sqlite-proxy` against DO storage.** Rejected by ADR 0022
  D-B: it assumes a request/response SQL endpoint shape that
  per-instance DO storage does not naturally expose.
- **Keep the mini-ORM, bounded to exactly the generic families, and
  leave the hand-written DO adapters as-is.** Rejected in part: the
  mini-ORM is kept, but "all agents will use it" — the hand-written
  adapters migrate onto it (or a named exemption), so the standard is
  one abstraction, not two coexisting ones.
