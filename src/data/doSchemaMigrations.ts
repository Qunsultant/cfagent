/**
 * #1767 (parent #1717, slice F-37/F-38): the DO SQLite
 * implementation of the schema-migration port
 * (src/ports/schemaMigration.ts).
 *
 * Discipline (shared with src/data/doSchemaMarker.ts and the D1
 * runner in src/data/migrationRunner.ts, applied here per store):
 *  - The ledger table `mas_schema_migrations` is owned by this
 *    module, never by a migration: one row per (store, version),
 *    written LAST for each migration, so the row is the commit
 *    marker — no row means "not applied", regardless of how many
 *    of the migration's statements already landed.
 *  - Application is idempotent and re-runnable: a migration
 *    whose version is already recorded is skipped, and migration
 *    statements are IF NOT EXISTS / OR IGNORE shaped, so a
 *    partial apply (crash between statements) converges on retry
 *    instead of double-applying.
 *  - Deliberately NOT wrapped in a multi-statement transaction:
 *    DO SqlStorage exec is synchronous statement-at-a-time with
 *    no transaction primitive on this surface, and the ledger-last
 *    marker gives the same retry convergence the D1 runner gets
 *    from its marker-last rule. A future multi-statement atomicity
 *    need must use the store's atomic primitive explicitly, not
 *    an assumed transaction around exec calls.
 *  - Rollback is latest-only: only the highest applied version
 *    for a store may roll back, via its `down` statements run in
 *    reverse order, and the ledger row is deleted LAST (after
 *    `down` succeeds) so a failed rollback still reports the
 *    migration as applied and retries instead of vanishing.
 *  - The ledger is per-instance by construction: it lives in the
 *    instance's own SQL storage, so two instances of the same DO
 *    class each carry their own applied set, and drift across
 *    instances is read by comparing per-instance reports
 *    (aggregateDoSchemaDrift), not by assuming one shared ledger.
 *
 * What this module does NOT do (honest boundaries):
 *  - It does not migrate existing stores: only stores whose
 *    adapter opts into managed mode run through it. Every other
 *    adapter's legacy ensureSchema is untouched, and a store's
 *    first managed migration must be written IF NOT EXISTS so a
 *    legacy-created table converges instead of erroring.
 *  - It does not snapshot or export schema state: drift control
 *    is the ledger-vs-declared comparison, not a backup (the
 *    #1766 R2 snapshot leg owns recovery exports).
 *  - It does not touch the D1 `_migrations` runner or the DO
 *    generation marker: those keep owning their stores/counters.
 */

import {
  aggregateDoSchemaDriftReports,
  computeDoSchemaDrift,
  validateDoSchemaMigrations,
  type AppliedDoSchemaMigration,
  type DoSchemaDriftAggregate,
  type DoSchemaDriftReport,
  type DoSchemaMigration,
  type DoSchemaMigrationSql,
  type InstanceDoSchemaDrift,
} from "../ports/schemaMigration";

export type {
  AppliedDoSchemaMigration,
  DoSchemaDriftAggregate,
  DoSchemaDriftReport,
  DoSchemaMigration,
  DoSchemaMigrationSql,
  InstanceDoSchemaDrift,
} from "../ports/schemaMigration";

export { aggregateDoSchemaDriftReports as aggregateDoSchemaDrift };

/** The ledger table: owned by this module, never by a migration. */
export const SCHEMA_MIGRATIONS_LEDGER_TABLE = "mas_schema_migrations";

function ensureLedgerTable(sql: DoSchemaMigrationSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_LEDGER_TABLE} (
  store TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store, version)
)`,
  );
}

/** Applied migrations for a store, in version order. */
export function listAppliedDoSchemaMigrations(
  sql: DoSchemaMigrationSql,
  store: string,
): AppliedDoSchemaMigration[] {
  ensureLedgerTable(sql);
  const rows = [
    ...sql.exec(
      `SELECT version, name FROM ${SCHEMA_MIGRATIONS_LEDGER_TABLE} WHERE store = ? ORDER BY version ASC`,
      store,
    ),
  ] as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
  }));
}

/**
 * Applies every declared migration for a store that is not yet
 * recorded, in declaration order. Returns the versions actually
 * applied (empty on a fully-applied re-run). A throwing
 * migration leaves its ledger row unwritten, so the next call
 * retries it; migrations applied before the failure stay
 * recorded and are skipped on retry.
 */
export function applyDoSchemaMigrations(
  sql: DoSchemaMigrationSql,
  store: string,
  migrations: DoSchemaMigration[],
  nowMs: number = Date.now(),
): number[] {
  validateDoSchemaMigrations(migrations);
  ensureLedgerTable(sql);
  const applied = new Set(
    listAppliedDoSchemaMigrations(sql, store).map((m) => m.version),
  );
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    for (const statement of migration.up) {
      sql.exec(statement);
    }
    // Ledger LAST: this row is the commit marker.
    sql.exec(
      `INSERT INTO ${SCHEMA_MIGRATIONS_LEDGER_TABLE} (store, version, name, applied_at_ms) VALUES (?, ?, ?, ?)`,
      store,
      migration.version,
      migration.name,
      nowMs,
    );
    applied.add(migration.version);
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

/**
 * Rolls back one migration for a store. Only the latest applied
 * version may roll back (rolling back an older version under a
 * newer one would leave the newer migration's DDL depending on
 * reverted columns), and the migration must declare `down`
 * statements. The ledger row is deleted LAST, after `down`
 * succeeds. Returns true when a rollback ran.
 */
export function rollbackDoSchemaMigration(
  sql: DoSchemaMigrationSql,
  store: string,
  declared: DoSchemaMigration[],
  version: number,
  nowMs: number = Date.now(),
): boolean {
  void nowMs;
  validateDoSchemaMigrations(declared);
  ensureLedgerTable(sql);
  const applied = listAppliedDoSchemaMigrations(sql, store);
  const appliedVersions = applied.map((m) => m.version);
  if (!appliedVersions.includes(version)) {
    throw new Error(
      `schema migration v${version} for store ${store} is not applied and cannot be rolled back`,
    );
  }
  const latest = Math.max(...appliedVersions);
  if (version !== latest) {
    throw new Error(
      `only the latest applied migration (v${latest}) for store ${store} may be rolled back, not v${version}`,
    );
  }
  const migration = declared.find((m) => m.version === version);
  if (!migration) {
    throw new Error(
      `schema migration v${version} for store ${store} is applied but not declared, so it cannot be rolled back`,
    );
  }
  if (migration.down.length === 0) {
    throw new Error(
      `schema migration ${migration.name} (v${version}) declares no down statements and cannot be rolled back`,
    );
  }
  for (const statement of [...migration.down].reverse()) {
    sql.exec(statement);
  }
  // Ledger LAST: a failed `down` still reports the migration applied.
  sql.exec(
    `DELETE FROM ${SCHEMA_MIGRATIONS_LEDGER_TABLE} WHERE store = ? AND version = ?`,
    store,
    version,
  );
  return true;
}

/** Drift verdict for one store on this instance. */
export function checkDoSchemaDrift(
  sql: DoSchemaMigrationSql,
  store: string,
  declared: DoSchemaMigration[],
): DoSchemaDriftReport {
  validateDoSchemaMigrations(declared);
  const applied = listAppliedDoSchemaMigrations(sql, store);
  return computeDoSchemaDrift(store, declared, applied);
}
