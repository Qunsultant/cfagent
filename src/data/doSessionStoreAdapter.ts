/**
 * Issue #2436 (#1976 step 5e, ADR 0022 D-I.5) — the
 * SessionStore DO's statement adapter: the data-layer owner
 * of every kv_store statement the SessionStore class
 * executes.
 *
 * Until this slice, the class in src/security/sessionStore.ts
 * held the census's last step-5 surface-1 entry: its
 * constructor DDL and its single statement funnel
 * (execCounted) executed storage SQL from above the layer.
 * The statements now live here, in the layer: the class
 * keeps the wire protocol, the list restriction, the
 * audit-append chaining/rotation/cap policy and the
 * expired-read delete decision — every BEHAVIOUR — and
 * delegates statement execution (plus the DDL and the D-A.4
 * schema-marker recording) to this adapter over the DO's
 * own SqlStorage handle. kv_store's writer set and DDL
 * ensurer, pinned by the census's by-table rule, are this
 * file alone.
 *
 * The statement templates are CONTRACT (#1819): every op
 * reply carries the parameterized template that produced it
 * (bound values never appear), and the templates' text is
 * unchanged from the class's — the class imports them back
 * from here for its replies.
 *
 * #CDO-mha7
 */
import { runDoSchemaMigration } from "./doSchemaMarker";
import { doTableSql } from "./schemaComponent/doCatalogue";

/** Parameterized statement templates (placeholders only, never bound values). */
export const STMT_POINT_GET =
  "SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?";
export const STMT_EXPIRES_GET =
  "SELECT expires_at FROM kv_store WHERE ns = ? AND key = ?";
export const STMT_LIST =
  "SELECT key, value FROM kv_store WHERE ns = ? AND key LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key";
export const STMT_UPSERT =
  "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at";
export const STMT_DELETE = "DELETE FROM kv_store WHERE ns = ? AND key = ?";
export const STMT_ARCHIVE_LIST =
  "SELECT key, value FROM kv_store WHERE ns = ? AND key LIKE ? ORDER BY key";
export const STMT_ARCHIVE_INSERT =
  "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, NULL)";

export interface Measured<T> {
  rows: T[];
  rowsRead: number;
  rowsWritten: number;
}

/**
 * The minimal SqlStorage surface the adapter uses — the DO
 * runtime's handle (ctx.storage.sql) and the test mocks
 * both satisfy it structurally.
 */
export interface SessionStoreSqlHandle {
  exec(
    query: string,
    ...params: unknown[]
  ): {
    toArray(): unknown[];
    rowsRead?: number;
    rowsWritten?: number;
  };
}

export class DoSessionStoreAdapter {
  /**
   * The handle is a RESOLVER, not the handle itself: the
   * SessionStore class resolved `this.ctx.storage.sql` per
   * op before this extraction, and callers (including suites
   * that substitute the storage handle after construction)
   * observe exactly that behaviour — the adapter resolves
   * the current handle on every statement.
   */
  constructor(
    private readonly resolveSql: () => SessionStoreSqlHandle,
    private readonly schemaVersion: number,
  ) {}

  /**
   * The generation-1 DDL plus the D-A.4 marker recording —
   * moved verbatim from the class's constructor (#2432): the
   * table creation stays unconditional and idempotent
   * exactly as before; the migration call only records that
   * the generation is in place (marker written last, and
   * only when the recorded version is older). The write is
   * additive and idempotent: it touches only the marker
   * module's own table, never kv_store, and no op's
   * behaviour depends on it.
   *
   * The marker module is served through this adapter's exec
   * rather than the raw handle: exec's toArray() is the
   * cursor surface every statement here standardises on
   * (#1819), while the marker's DoSchemaSql contract
   * iterates the exec result — an adapter over exec satisfies
   * it without a second cursor idiom.
   */
  ensureSchema(): void {
    const sql = this.resolveSql();
    sql.exec(
      doTableSql("kv_store"),
    );
    runDoSchemaMigration(
      {
        exec: (query: string, ...params: unknown[]) =>
          this.exec<Record<string, unknown>>(query, ...params).rows,
      },
      this.schemaVersion,
      () => {},
    );
  }

  /**
   * Execute one statement and capture the platform-measured
   * cursor totals. The cursor must be fully consumed
   * (toArray) before rowsRead/rowsWritten are final —
   * reading them off a partially iterated cursor understates.
   */
  exec<T>(statement: string, ...params: unknown[]): Measured<T> {
    const sql = this.resolveSql();
    const cursor = sql.exec(statement, ...params);
    const rows = cursor.toArray() as T[];
    return {
      rows,
      rowsRead: cursor.rowsRead ?? 0,
      rowsWritten: cursor.rowsWritten ?? 0,
    };
  }
}
