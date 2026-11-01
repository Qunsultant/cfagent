# DO SQLite schema-migration framework (#1767, parent #1717)

## Problem (scan rows F-37 partial / F-38 partial)

DO SQLite DDL lived as raw string queries scattered across one
`ensureSchema` per adapter (dozens of inline `CREATE TABLE IF NOT
EXISTS` blocks), with no versioned application, no rollback, and no
record of what schema generation any instance is on. That is the
manual-DDL drift risk the #1717 scan records under DATA-002
("manual DDL-tag migrations risk schema drift — no automated
migration framework") and INF-006 ("SQLite DDL via raw string
queries in `block_concurrency_while` — no ORM-managed migration
tooling"). Note on the historical name: no `block_concurrency_while`
exists on current main; DO schema setup today runs through each
adapter's `ensureSchema` (called lazily on first use), which is
where this framework hooks in.

## Mechanism (this slice is the mechanism, not a schema change)

Three layers, port-first (cloud-native but cloud-agnostic):

1. **Port** — `src/ports/schemaMigration.ts`: `DoSchemaMigration`
   (`version`, `name`, `up`, `down`), the drift-report and
   fleet-aggregate shapes, `validateDoSchemaMigrations`
   (strictly increasing versions, no silent sorting), and the
   pure drift computation.
2. **Runner** — `src/data/doSchemaMigrations.ts`: applies a
   store's declared migrations in order against a DO instance's
   synchronous SQL surface, skipping already-recorded versions,
   and records each application in the module-owned ledger table
   `mas_schema_migrations (store, version, name, applied_at_ms)`.
   The ledger row is written LAST per migration (marker-LAST
   discipline, shared with `src/data/doSchemaMarker.ts` and the
   D1 runner): no row means "not applied", so a throwing
   migration retries cleanly and a partial apply converges.
   Rollback is latest-applied-only, via the migration's `down`
   statements in reverse order, with the ledger row deleted
   LAST. Drift is `checkDoSchemaDrift` (declared vs applied
   for one store on one instance) plus the pure
   `aggregateDoSchemaDrift` rollup over per-instance reports —
   no new endpoint; a fleet consumer feeds it reports.
3. **Switch** — `src/config/schemaMigrationModes.ts`:
   `SCHEMA_MIGRATION_MODE` (`managed` | `legacy`), resolved
   run > session > user > global env > built-in `legacy`
   (current behavior; unset changes nothing). An unrecognized
   winning value fails closed to `legacy` with
   `schema.config_error`. No production value is set by this
   slice — production values are an owner action.

"ORM-managed" in substance: DDL is declared as data and executed
only by the runner, never hand-executed as scattered strings.
No Drizzle dialect for DO storage exists (DO SqlStorage is a
synchronous exec surface, not a Drizzle driver), so the runner
is the DO-side mechanism; the D1 Drizzle runner
(`src/data/migrationRunner.ts`, `_migrations` ledger) and the
per-instance generation marker (`src/data/doSchemaMarker.ts`)
are untouched and keep owning their stores/counters.

## Proof wiring (one store, both paths kept)

The screener's run-lock store is the first framework store:

- Its DDL lives in exactly one place
  (`SCREEN_RUN_LOCK_TABLE_DDL` in
  `src/data/doSqliteScreenRunLockAdapter.ts`); the legacy
  branch and migration v1 (`0001_screen_run_locks`) run the
  same statement, so the modes cannot drift apart.
- Managed mode records the ledger row; legacy mode (default)
  creates the table with no ledger row — byte-identical old
  behavior, pinned by the existing lock tests.
- `ScreenerAgent` composes the port with `{ env: this.env }`,
  so setting `SCHEMA_MIGRATION_MODE=managed` in Worker env
  activates managed mode for that store with no code change.
  The deprecated `src/services/screenRunLock.ts` delegate keeps
  composing without options (legacy), unchanged.

## How a new store opts in

1. Declare its migrations as `DoSchemaMigration[]` next to the
   adapter (DDL's one home stays the adapter file).
2. In `ensureSchema`, branch on the resolved mode: managed →
   `applyDoSchemaMigrations(sql, "<store>", migrations)`;
   legacy → the existing inline DDL, unchanged.
3. Resolve the mode at the composition root from Worker env
   (see `src/data/createScreenRunLockPorts.ts`); never from
   request input — the guard in `schemaMigrationModes.ts`
   forbids a caller flipping their own execution's DDL path.

## How a new schema change rides the framework

- Append a new migration with the next version number. NEVER
  edit an applied migration's `up`: applied instances never
  re-run it, so an edit would silently diverge new instances
  from old ones. A correction is a new migration.
- New tables/columns use `IF NOT EXISTS` / additive shapes so
  a legacy-created table converges on first managed ensure.
- Every migration that may need reverting declares `down`;
  a migration without `down` cannot roll back (the runner
  throws rather than half-reverting).
- Ship a drift pin: apply in a test, assert the ledger, and
  assert `checkDoSchemaDrift` is clean — the pattern in
  `tests/schema_migrations_1767.test.ts`.

## Boundaries (named, not hidden)

- Only opted-in stores run through the framework; every other
  adapter's legacy `ensureSchema` is untouched. Migrating the
  remaining stores is follow-up work, one store per slice, not
  smuggled into this mechanism PR.
- Cross-instance drift rollup needs a consumer that collects
  per-instance reports (e.g. via the fleet registry's existing
  version reporting); this slice provides the report shapes
  and the pure aggregator, not the collector or an endpoint.
- The framework does not snapshot or export schema state;
  recovery exports belong to the #1766 R2 snapshot leg.
- The framework is not a substitute for the D1 runner or the
  DO generation marker; each owns its own ledger/counter.
- The switch governs a schema-write mechanism, not an
  enforcement gate: no IAAA gate, no HITL gate, and no
  authorization check is switchable through it in any mode.
