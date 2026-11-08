# 02 — Data access

**Purpose.** How code reads and writes stored data: ADR 0022 operationalized.
SQL lives behind ports; transactions are an aspect at the port boundary;
migrations are owned by exactly one "latest" test.

**Canonical sources.** ADR 0022 (`docs/architecture/adr/0022-data-foundation.md`
— linked directly; the ADR index is stale and omits it, see the README's
known-conflicts table), ADR 0002, gitops §7 pin rule 5.

**The ports home (ruling, 2026-11-08).** `src/data/` is the home for ports
and their adapters — 371 files at `9925ead8`. `src/ports/` holds exactly one
file (`schemaMigration.ts`) and is dispositioned into `src/data/`; the
directory ceases to exist. Inside `src/data/`, ports and adapters are
organized into **domain subdirectories** with per-domain files, composed by
one index (README, domain-breakdown principle). Per-domain port files that
currently live beside their domains (e.g. `src/workflows/*Ports.ts`,
`src/mcps/openaimp/mcpPermissionPorts.ts`) are dispositioned by the same
principle when their areas are next touched; `src/data/` is the destination
home. The home and layout end state is decided; the moves are
ADOPTED-PENDING-IMPLEMENTATION and proceed by slice and on touch — no bulk
move is implied by this document.

## B1 — No naked SQL above the data layer

**Definition.** SQL text exists only behind ports, in named templates inside
the data layer. Above-layer SQL sites exist only as an exact allow-list that
only shrinks; any new above-layer SQL site is a violation. For ported tables,
the set of files that write the table is pinned (per-table writer sets).
**Status.** ENFORCED — `tests/global_dd_census_2356.test.ts` (three surfaces
plus writer sets, shrink-only) and the per-family step censuses
(`orm_step3a_census_2345`, `strategy_cluster_step4b_census_2357`,
`async_jobs_step4a_census_2358`, `orchestrator_tables_step4d_census_2359`).
**Conformance at `9925ead8`.** Baseline: the census allow-list at base,
shrink-only, cleared on touch. The census counts SQL sites; it does not
distinguish dialect misuse (B2).

## B2 — Dialect ruling

**Definition.** Where a dialect exists, adapters use typed Drizzle behind the
port (D1, Postgres). Durable Object SQLite adapters use raw SQL behind the
port. Dialect code never appears above the port boundary.
**Status.** DOCUMENTED — ADR 0022 D-B. The B1 census does not distinguish
dialect misuse; review enforces the distinction.
**Conformance at `9925ead8`.** Not mechanically measured separately from B1.

## B3 — Transactions are an aspect at the port boundary

**Definition.** A multi-write operation is one wrapped call at the port
boundary: it completes atomically or fails honestly with a typed refusal —
never silently partial. A store that cannot honour the transaction scope
refuses before any write. On D1 the mechanism is `batch()`, never
`db.transaction()`. Nested calls join the ambient unit; only the outermost
unit emits an outcome. The implementation idiom is in `14` (Q3).
**Status.** DOCUMENTED here as the data-access rule — ADR 0022 D-C. The
transaction aspect itself is ENFORCED by its proof pins and the per-port
conformance suites (`14` Q3).
**Conformance at `9925ead8`.** See `14` Q3: `tests/transaction_proof_2288.test.ts`
plus the conformance suites exercise the wrapped semantics.

## B4 — Migration "latest" is owned by exactly one test

**Definition.** The migration registry's `latest` assertion lives in exactly
one test: `tests/migration_registry.test.ts`. Per-feature migration tests
assert only their own registration (position-independent) and their own
DDL/schema parity. A per-feature test that asserts `latest`, or a second
owner of the `latest` assertion, is a violation.
**Status.** ENFORCED — `scripts/check-migration-pins.sh`, run in
`scripts/verify-before-merge.sh` and in the CI Fast gates step.
**Conformance at `9925ead8`.** Lint green at base. Note the carve-out: this
rule qualifies pin rule 1 (`07` G2) — adding a migration updates the identity
assertions it touches, but never another test's `latest` assertion.

## B5 — Every port's conformance suite runs unchanged against every adapter

**Definition.** For each port, one conformance suite exists and runs
unchanged against every adapter family for that port (production and
in-memory alike). Adding an adapter without running the suite against it is
incomplete work.
**Status.** DOCUMENTED — ADR 0002 / ADR 0022. Suites exist per family;
nothing meta-enforces coverage of a newly added adapter. This is the
data-access form of `01` A2, and the gap is the same one.
**Conformance at `9925ead8`.** Not mechanically measured at the meta level;
per-family suites are green at base.
