/**
 * Issue #5086 (S7, observability program #5080) — the D1 store
 * for the OTel runtime overrides (table `otel_config_overrides`,
 * migration 0070).
 *
 * The SQL lives HERE, in the data layer, and nowhere else: the
 * global D-D census (#2356, surface 3) pins D1 `prepare()`
 * sites outside src/data/ to an exact allow-list — the surface
 * is fully regularized (the only entry is the transaction
 * aspect's own D1 leg) — so the config port (src/config/) must
 * not call prepare() itself. The port owns the allow-list, the
 * normalization, the versioning, and the audit; this store
 * owns the two statements (read all rows, insert one row).
 *
 * The store never throws on reads: a missing table (migration
 * not yet applied) or an unavailable D1 fails closed to empty
 * overrides — the deploy-time values govern. A write with no
 * D1 throws; the port guards that case before calling and
 * reports "D1 is unbound".
 */

/** The D1 table holding the runtime overrides (migration 0070). */
export const OTEL_CONFIG_OVERRIDES_TABLE = "otel_config_overrides" as const;

/** One stored override row (value_json null = tombstone / cleared). */
export interface OtelConfigOverridesRow {
  config_key: string;
  value_json: string | null;
  version: number;
  updated_by: string;
  updated_at_ms: number;
  reason: string;
}

/** The minimal D1 handle the store needs (the Worker binding shape). */
export interface OtelConfigOverridesD1 {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export interface OtelConfigOverridesStore {
  readAllRows(): Promise<OtelConfigOverridesRow[]>;
  insertRow(row: OtelConfigOverridesRow): Promise<void>;
}

export function createOtelConfigOverridesStore(
  d1: OtelConfigOverridesD1 | null,
): OtelConfigOverridesStore {
  async function readAllRows(): Promise<OtelConfigOverridesRow[]> {
    if (!d1) return [];
    try {
      const result = await d1
        .prepare(
          `SELECT config_key, value_json, version, updated_by, updated_at_ms, reason FROM ${OTEL_CONFIG_OVERRIDES_TABLE}`,
        )
        .bind()
        .all<OtelConfigOverridesRow>();
      return result.results;
    } catch {
      // A missing table (migration not yet applied) or an
      // unavailable D1 fails closed to empty overrides — the
      // deploy-time values govern, and the read never throws
      // into the caller.
      return [];
    }
  }

  async function insertRow(row: OtelConfigOverridesRow): Promise<void> {
    if (!d1) {
      throw new Error("D1 is unbound: the runtime override store is unavailable");
    }
    await d1
      .prepare(
        `INSERT INTO ${OTEL_CONFIG_OVERRIDES_TABLE} (config_key, value_json, version, updated_by, updated_at_ms, reason) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.config_key,
        row.value_json,
        row.version,
        row.updated_by,
        row.updated_at_ms,
        row.reason,
      )
      .run();
  }

  return { readAllRows, insertRow };
}
