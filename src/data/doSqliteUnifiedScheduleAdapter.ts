/**
 * Issue #3121 Phase 2 (#3123, reuse) — the DO-SQLite implementation
 * of the unified schedule port: one table, `unified_schedules`,
 * over the host Durable Object's own SQLite.
 *
 * Mirrors the paused-schedule adapter's shape (issue #2337): the
 * table is ensured lazily on every operation (CREATE TABLE IF NOT
 * EXISTS), rows map through rowToRecord, and save() is a DELETE +
 * INSERT upsert pair. All sql.exec sites live here, inside
 * src/data/ — never above the layer (global D-D census surface 1).
 *
 * The module carries TWO surfaces over the same table:
 *  - SqlUnifiedScheduleStore — the SYNCHRONOUS class, for the
 *    route call sites (the orchestrator routes are sync over DO
 *    SQLite, like the paused store before it); and
 *  - DoSqliteUnifiedScheduleStore — the async port adapter, whose
 *    save() runs the upsert pair through withTransaction (DO leg)
 *    when constructed with the transaction-capable storage object,
 *    and sequentially otherwise.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import { getTransactionRunner } from "./transactionRunnerProvider";
import type { SqlStorage } from "../orm";
import {
  UNIFIED_SCHEDULES_TABLE,
  type ScheduleStore,
  type SyncScheduleStore,
  type UnifiedScheduleKind,
  type UnifiedScheduleRecord,
  type UnifiedScheduleState,
} from "./unifiedSchedulePorts";
import { ensureUnifiedScheduleIndexes } from "./unifiedScheduleIndexSchema";

function ensureTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${UNIFIED_SCHEDULES_TABLE} (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      callback TEXT,
      operation TEXT,
      definition_json TEXT NOT NULL,
      owner_login TEXT,
      provenance_json TEXT,
      alarm_id TEXT,
      paused_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${UNIFIED_SCHEDULES_TABLE}_kind_idx ON ${UNIFIED_SCHEDULES_TABLE} (kind, created_at ASC, id ASC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${UNIFIED_SCHEDULES_TABLE}_state_idx ON ${UNIFIED_SCHEDULES_TABLE} (state, created_at ASC, id ASC)`);
  // Issue #3121 Phase 2 (#3124) — the unfiltered-list ordering index
  // (src/data/unifiedScheduleIndexSchema.ts, #2280 pattern).
  ensureUnifiedScheduleIndexes(sql);
}

function saveSync(sql: SqlStorage, record: UnifiedScheduleRecord): void {
  ensureTable(sql);
  // Upsert as delete + insert: portable across SQLite and the test
  // mock, and the table is single-row-per-id so the cost is trivial.
  sql.exec(`DELETE FROM ${UNIFIED_SCHEDULES_TABLE} WHERE id = ?`, record.id);
  sql.exec(
    `INSERT INTO ${UNIFIED_SCHEDULES_TABLE}
         (id, kind, state, callback, operation, definition_json, owner_login, provenance_json, alarm_id, paused_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.kind,
    record.state,
    record.callback ?? null,
    record.operation ?? null,
    JSON.stringify(record.definition),
    record.ownerLogin ?? null,
    record.provenance === undefined ? null : JSON.stringify(record.provenance),
    record.alarmId ?? null,
    record.pausedAt ?? null,
    record.createdAt,
    record.updatedAt,
  );
}

function rowToRecord(row: Record<string, unknown>): UnifiedScheduleRecord {
  let definition: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.definition_json ?? "{}"));
    definition =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    definition = {};
  }
  let provenance: unknown;
  try {
    provenance =
      row.provenance_json != null ? JSON.parse(String(row.provenance_json)) : undefined;
  } catch {
    provenance = undefined;
  }
  return {
    id: String(row.id),
    kind: String(row.kind) as UnifiedScheduleRecord["kind"],
    state: String(row.state) as UnifiedScheduleRecord["state"],
    ...(row.callback != null ? { callback: String(row.callback) } : {}),
    ...(row.operation != null ? { operation: String(row.operation) } : {}),
    definition,
    ...(row.owner_login != null ? { ownerLogin: String(row.owner_login) } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(row.alarm_id != null ? { alarmId: String(row.alarm_id) } : {}),
    ...(row.paused_at != null ? { pausedAt: String(row.paused_at) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function getSync(sql: SqlStorage, id: string): UnifiedScheduleRecord | undefined {
  ensureTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM ${UNIFIED_SCHEDULES_TABLE} WHERE id = ?`, id),
  ) as Array<Record<string, unknown>>;
  return rows.length ? rowToRecord(rows[0]) : undefined;
}

function listSync(
  sql: SqlStorage,
  where = "",
  ...params: unknown[]
): UnifiedScheduleRecord[] {
  ensureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${UNIFIED_SCHEDULES_TABLE} ${where} ORDER BY created_at ASC, id ASC`,
      ...params,
    ),
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

function removeSync(sql: SqlStorage, id: string): boolean {
  ensureTable(sql);
  const existing = getSync(sql, id);
  if (!existing) return false;
  sql.exec(`DELETE FROM ${UNIFIED_SCHEDULES_TABLE} WHERE id = ?`, id);
  return true;
}

function clearSync(sql: SqlStorage): void {
  ensureTable(sql);
  sql.exec(`DELETE FROM ${UNIFIED_SCHEDULES_TABLE}`);
}

function clearPausedSync(sql: SqlStorage): number {
  ensureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT COUNT(*) AS n FROM ${UNIFIED_SCHEDULES_TABLE} WHERE state = ?`,
      "paused",
    ),
  ) as Array<{ n?: unknown }>;
  const count = Number(rows[0]?.n ?? 0);
  sql.exec(`DELETE FROM ${UNIFIED_SCHEDULES_TABLE} WHERE state = ?`, "paused");
  return count;
}

/** The synchronous store over DO SQLite. */
export class SqlUnifiedScheduleStore implements SyncScheduleStore {
  constructor(private sql: SqlStorage) {}

  save(record: UnifiedScheduleRecord): void {
    saveSync(this.sql, record);
  }

  get(id: string): UnifiedScheduleRecord | undefined {
    return getSync(this.sql, id);
  }

  list(): UnifiedScheduleRecord[] {
    return listSync(this.sql);
  }

  listByKind(kind: UnifiedScheduleKind): UnifiedScheduleRecord[] {
    return listSync(this.sql, "WHERE kind = ?", kind);
  }

  listByState(state: UnifiedScheduleState): UnifiedScheduleRecord[] {
    return listSync(this.sql, "WHERE state = ?", state);
  }

  remove(id: string): boolean {
    return removeSync(this.sql, id);
  }

  clear(): void {
    clearSync(this.sql);
  }

  clearPaused(): number {
    return clearPausedSync(this.sql);
  }
}

/** The port adapter (async surface) over DO SQLite. */
export class DoSqliteUnifiedScheduleStore implements ScheduleStore {
  constructor(
    private readonly sql: SqlStorage,
    /** The transaction-capable storage object (ctx.storage) when the
     *  host supplies it — enables the withTransaction wrap on save. */
    private readonly txStorage?: DoTransactionStorage,
  ) {}

  async save(record: UnifiedScheduleRecord): Promise<void> {
    // The DELETE + INSERT upsert pair is one unit when the host
    // supplied the transaction-capable storage (ADR D-C).
    const runner = this.txStorage ? getTransactionRunner() : null;
    if (this.txStorage && runner) {
      await runner.run(
        this.txStorage,
        { operationName: "unifiedSchedules.save", domain: "scheduling" },
        () => saveSync(this.sql, record),
      );
    } else {
      saveSync(this.sql, record);
    }
  }

  async get(id: string): Promise<UnifiedScheduleRecord | undefined> {
    return getSync(this.sql, id);
  }

  async list(): Promise<UnifiedScheduleRecord[]> {
    return listSync(this.sql);
  }

  async listByKind(kind: UnifiedScheduleKind): Promise<UnifiedScheduleRecord[]> {
    return listSync(this.sql, "WHERE kind = ?", kind);
  }

  async listByState(state: UnifiedScheduleState): Promise<UnifiedScheduleRecord[]> {
    return listSync(this.sql, "WHERE state = ?", state);
  }

  async remove(id: string): Promise<boolean> {
    return removeSync(this.sql, id);
  }

  async clear(): Promise<void> {
    clearSync(this.sql);
  }

  async clearPaused(): Promise<number> {
    return clearPausedSync(this.sql);
  }
}
