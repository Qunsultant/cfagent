/**
 * Issue #2288 (#1976 step 0, ADR 0022 D-A.4) — the per-instance
 * DO schema-version marker.
 *
 * D1 has `_migrations`; DO storage had nothing — schema evolution
 * inside a DO was "the code is the migration", unaudited (survey
 * §4.2). This module is the DO analogue, kept to migrationRunner
 * discipline even though the mechanism differs:
 *  - versioned: one integer per instance, monotonically recorded;
 *  - idempotent: reading is a plain SELECT, recording the same
 *    version twice is the same state, and running a migration
 *    whose version is already recorded is a no-op;
 *  - marker-LAST: `runDoSchemaMigration` writes the marker only
 *    AFTER the migration body completes. If the body throws, the
 *    marker is untouched, so a later run retries the migration —
 *    the marker row is the commit record, exactly as `_migrations`
 *    is on D1.
 *
 * The marker lives in the instance's own SQL storage, in a
 * single-row table owned by this module. It is read through
 * `reportDoSchemaVersion` into the shape the fleet-registry
 * family consumes (agentKey + doSchemaVersion), so the registry
 * read model can carry each agent's DO schema generation
 * (ADR 0022 D-F.5).
 */

import { doTableSql } from "./schemaComponent/doCatalogue";
/** Minimal SQL surface the marker needs from a DO instance. */
export interface DoSchemaSql {
  exec(query: string, ...params: unknown[]): Iterable<Record<string, unknown>>;
}

/** The marker table: one row (id = 1) per DO instance. */
export const DO_SCHEMA_MARKER_TABLE = "mas_do_schema_marker";

/** The shape the fleet-registry family consumes (D-F.5). */
export interface DoSchemaVersionReport {
  agentKey: string;
  doSchemaVersion: number;
  reportedAtMs: number;
}

function ensureMarkerTable(sql: DoSchemaSql): void {
  sql.exec(
    doTableSql("mas_do_schema_marker"),
  );
}

/**
 * The instance's recorded schema version, or 0 when no migration
 * has ever been recorded on it. Read-only apart from the
 * idempotent CREATE IF NOT EXISTS that makes first use safe.
 */
export function readDoSchemaVersion(sql: DoSchemaSql): number {
  ensureMarkerTable(sql);
  const rows = [
    ...sql.exec(`SELECT version FROM ${DO_SCHEMA_MARKER_TABLE} WHERE id = 1`),
  ];
  if (rows.length === 0) return 0;
  const version = rows[0].version;
  return typeof version === "number" ? version : Number(version ?? 0);
}

/**
 * Record `version` as the instance's schema version. Idempotent:
 * recording the same version again leaves the same state (the
 * timestamp refresh is bookkeeping, not a state change).
 */
export function recordDoSchemaVersion(
  sql: DoSchemaSql,
  version: number,
  nowMs: number = Date.now(),
): void {
  ensureMarkerTable(sql);
  sql.exec(
    `INSERT OR REPLACE INTO ${DO_SCHEMA_MARKER_TABLE} (id, version, updated_at_ms) VALUES (1, ?, ?)`,
    version,
    nowMs,
  );
}

/**
 * Run one DO schema migration under marker discipline: if the
 * recorded version is already >= `targetVersion`, the body does
 * not run (applied: false). Otherwise the body runs FIRST and
 * the marker is written LAST; a throwing body leaves the marker
 * untouched and the error propagates, so the migration is
 * retried by the next caller instead of being half-recorded.
 */
export function runDoSchemaMigration(
  sql: DoSchemaSql,
  targetVersion: number,
  apply: () => void,
  nowMs: number = Date.now(),
): { applied: boolean; fromVersion: number } {
  const fromVersion = readDoSchemaVersion(sql);
  if (fromVersion >= targetVersion) {
    return { applied: false, fromVersion };
  }
  apply();
  recordDoSchemaVersion(sql, targetVersion, nowMs);
  return { applied: true, fromVersion };
}

/** Report the instance's schema version in the registry family's shape. */
export function reportDoSchemaVersion(
  sql: DoSchemaSql,
  agentKey: string,
  nowMs: number = Date.now(),
): DoSchemaVersionReport {
  return {
    agentKey,
    doSchemaVersion: readDoSchemaVersion(sql),
    reportedAtMs: nowMs,
  };
}
