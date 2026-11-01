/**
 * #1767 (parent #1717, slice F-37/F-38): the port for the DO
 * SQLite schema-migration framework.
 *
 * The problem this port closes: DO SQLite DDL today lives as raw
 * string queries scattered across one ensureSchema per adapter
 * (dozens of inline CREATE TABLE IF NOT EXISTS blocks), with no
 * versioned application, no rollback, and no record of what
 * schema generation any instance is on — the scan's F-37/F-38
 * drift risk. The D1 side already has a versioned runner
 * (src/data/migrationRunner.ts, `_migrations` ledger) and the
 * DO side already has a single-version marker
 * (src/data/doSchemaMarker.ts, marker-LAST discipline); neither
 * is a per-store migration framework for DO instances. This port
 * is that framework's contract, and src/data/doSchemaMigrations.ts
 * is its DO SQLite implementation. Neither existing mechanism is
 * replaced or deleted: the D1 runner keeps owning D1, the marker
 * keeps owning the per-instance generation counter, and this
 * ledger owns per-store applied migrations inside a DO instance.
 *
 * "ORM-managed" here means what the assessment asks for in
 * substance: DDL declared as data (versioned migration objects)
 * and executed only by the runner, never hand-executed as
 * scattered strings — not a Drizzle dialect for DO storage,
 * which does not exist (DO SqlStorage is a synchronous exec
 * surface, not a Drizzle driver; the D1 Drizzle runner is a
 * different store's mechanism and stays untouched).
 *
 * Pure module: no Cloudflare imports, no I/O, no network.
 * Drift computation is pure so it is testable without a database
 * and reusable by any fleet-level rollup: per-instance reports
 * aggregate across instances without any new endpoint.
 */

/** Minimal synchronous SQL surface the runner needs from a DO instance. */
export interface DoSchemaMigrationSql {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

/**
 * One versioned schema migration for one store. `up` runs in
 * array order; `down` must undo `up` in reverse order (the
 * runner reverses it) and may be empty only for migrations
 * that are never rolled back — rollback of such a migration
 * throws rather than silently half-reverting.
 */
export interface DoSchemaMigration {
  version: number;
  name: string;
  up: string[];
  down: string[];
}

/** One ledger row: a migration recorded as applied for a store. */
export interface AppliedDoSchemaMigration {
  version: number;
  name: string;
}

/**
 * Drift verdict for one store on one instance: the declared set
 * vs the ledger's applied set. `missing` = declared but not
 * applied (a pending migration); `unexpected` = applied but not
 * declared (a migration the code no longer knows — the drift
 * signal that matters most, since it means an instance ran DDL
 * the current code cannot reproduce or roll back).
 */
export interface DoSchemaDriftReport {
  store: string;
  declared: number[];
  applied: number[];
  missing: number[];
  unexpected: number[];
  drifted: boolean;
}

/** One instance's drift report, keyed for fleet aggregation. */
export interface InstanceDoSchemaDrift {
  instance: string;
  report: DoSchemaDriftReport;
}

/** Fleet rollup: which instances drifted, never a silent pass. */
export interface DoSchemaDriftAggregate {
  instances: number;
  drifted: boolean;
  driftedInstances: string[];
}

/**
 * Validates a declared migration set: versions must be positive
 * integers, names non-blank, `up` non-empty, and versions
 * strictly increasing in declaration order (the runner applies
 * in declaration order, so an unordered set is a declaration
 * bug, not something to sort silently — sorting would hide a
 * mis-ordered DDL dependency).
 */
export function validateDoSchemaMigrations(
  migrations: DoSchemaMigration[],
): void {
  let previous = 0;
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new Error(
        `schema migration version must be a positive integer, got ${String(m.version)} (${m.name})`,
      );
    }
    if (seen.has(m.version)) {
      throw new Error(`duplicate schema migration version ${m.version}`);
    }
    seen.add(m.version);
    if (m.version <= previous) {
      throw new Error(
        `schema migrations must be declared in strictly increasing version order (got ${m.version} after ${previous})`,
      );
    }
    previous = m.version;
    if (!m.name || !m.name.trim()) {
      throw new Error(
        `schema migration version ${m.version} must have a non-blank name`,
      );
    }
    if (m.up.length === 0) {
      throw new Error(
        `schema migration ${m.name} (v${m.version}) must declare at least one up statement`,
      );
    }
  }
}

/** Pure drift computation: declared set vs applied ledger rows. */
export function computeDoSchemaDrift(
  store: string,
  declared: DoSchemaMigration[],
  applied: AppliedDoSchemaMigration[],
): DoSchemaDriftReport {
  const declaredVersions = declared.map((m) => m.version);
  const appliedVersions = applied.map((m) => m.version);
  const appliedSet = new Set(appliedVersions);
  const declaredSet = new Set(declaredVersions);
  const missing = declaredVersions.filter((v) => !appliedSet.has(v));
  const unexpected = appliedVersions.filter((v) => !declaredSet.has(v));
  return {
    store,
    declared: declaredVersions,
    applied: appliedVersions,
    missing,
    unexpected,
    drifted: missing.length > 0 || unexpected.length > 0,
  };
}

/** Pure fleet rollup over per-instance drift reports. */
export function aggregateDoSchemaDriftReports(
  reports: InstanceDoSchemaDrift[],
): DoSchemaDriftAggregate {
  const driftedInstances = reports
    .filter((r) => r.report.drifted)
    .map((r) => r.instance);
  return {
    instances: reports.length,
    drifted: driftedInstances.length > 0,
    driftedInstances,
  };
}
