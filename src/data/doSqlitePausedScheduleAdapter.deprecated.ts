/**
 * @deprecated Issue #3121 Phase 2 (#3123) — retired by deprecation
 * rename only (gitops §22: never deleted). Superseded by
 * `src/data/doSqliteUnifiedScheduleAdapter.ts`. Successor:
 * `src/data/doSqliteUnifiedScheduleAdapter.ts`. This file is FROZEN:
 * no new features, no new consumers; delete only when it has zero
 * consumers and the owner decides (see
 * `docs/architecture/transition/deprecations.md`).
 *
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the paused-schedule port: the legacy SqlPausedScheduleStore
 * (issue #273), moved verbatim into the data layer.
 * src/services/scheduleManagement.ts keeps its pure domain
 * code and re-exports this module's store surface.
 *
 * The module carries TWO surfaces over the same table:
 *  - SqlPausedScheduleStore — the legacy SYNCHRONOUS class,
 *    preserved verbatim (same statements, same row mapping)
 *    for the existing call sites; and
 *  - DoSqlitePausedScheduleStore — the async port adapter,
 *    whose save() runs the DELETE + INSERT upsert pair through
 *    withTransaction (DO leg) when constructed with the
 *    transaction-capable storage object, and sequentially
 *    otherwise.
 * The table is ensured lazily on every operation, exactly as
 * the legacy module did (CREATE TABLE IF NOT EXISTS).
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import { getTransactionRunner } from "./transactionRunnerProvider";
import type { SqlStorage } from "../orm";
import {
  PAUSED_SCHEDULES_TABLE,
  type PausedScheduleRecord,
  type PausedScheduleStore,
} from "./pausedSchedulePorts.deprecated";
import { doTableSql } from "./schemaComponent/doCatalogue";

function ensureTable(sql: SqlStorage): void {
  sql.exec(doTableSql("paused_schedules"));
}

function saveSync(sql: SqlStorage, record: PausedScheduleRecord): void {
  ensureTable(sql);
  // Upsert as delete + insert: portable across SQLite and the test
  // mock, and the table is single-row-per-job so the cost is trivial.
  sql.exec(`DELETE FROM ${PAUSED_SCHEDULES_TABLE} WHERE id = ?`, record.id);
  sql.exec(
    `INSERT INTO ${PAUSED_SCHEDULES_TABLE}
         (id, callback, payload_json, sched_type, cron, interval_seconds, time, delay_seconds, paused_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.callback,
    record.payload === undefined ? null : JSON.stringify(record.payload),
    record.type,
    record.cron ?? null,
    record.intervalSeconds ?? null,
    record.time ?? null,
    record.delayInSeconds ?? null,
    record.pausedAt
  );
}

function getSync(sql: SqlStorage, id: string): PausedScheduleRecord | undefined {
  ensureTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM ${PAUSED_SCHEDULES_TABLE} WHERE id = ?`, id)
  ) as Array<Record<string, unknown>>;
  return rows.length ? rowToRecord(rows[0]) : undefined;
}

function listSync(sql: SqlStorage): PausedScheduleRecord[] {
  ensureTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM ${PAUSED_SCHEDULES_TABLE} ORDER BY paused_at ASC`)
  ) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

function removeSync(sql: SqlStorage, id: string): boolean {
  ensureTable(sql);
  const existing = getSync(sql, id);
  if (!existing) return false;
  sql.exec(`DELETE FROM ${PAUSED_SCHEDULES_TABLE} WHERE id = ?`, id);
  return true;
}

function clearSync(sql: SqlStorage): void {
  ensureTable(sql);
  sql.exec(`DELETE FROM ${PAUSED_SCHEDULES_TABLE}`);
}

function rowToRecord(row: Record<string, unknown>): PausedScheduleRecord {
  let payload: unknown;
  try {
    payload = row.payload_json != null ? JSON.parse(String(row.payload_json)) : undefined;
  } catch {
    payload = undefined;
  }
  return {
    id: String(row.id),
    callback: String(row.callback),
    payload,
    type: String(row.sched_type) as PausedScheduleRecord["type"],
    ...(row.cron != null ? { cron: String(row.cron) } : {}),
    ...(row.interval_seconds != null ? { intervalSeconds: Number(row.interval_seconds) } : {}),
    ...(row.time != null ? { time: Number(row.time) } : {}),
    ...(row.delay_seconds != null ? { delayInSeconds: Number(row.delay_seconds) } : {}),
    pausedAt: String(row.paused_at),
  };
}

/**
 * The legacy synchronous store over DO SQLite. Kept as the
 * shim surface for existing call sites; new code should use
 * the port adapter below.
 */
export class SqlPausedScheduleStore {
  constructor(private sql: SqlStorage) {}

  save(record: PausedScheduleRecord): void {
    saveSync(this.sql, record);
  }

  get(id: string): PausedScheduleRecord | undefined {
    return getSync(this.sql, id);
  }

  list(): PausedScheduleRecord[] {
    return listSync(this.sql);
  }

  remove(id: string): boolean {
    return removeSync(this.sql, id);
  }

  clear(): void {
    clearSync(this.sql);
  }
}

/** The port adapter (async surface) over DO SQLite. */
export class DoSqlitePausedScheduleStore implements PausedScheduleStore {
  constructor(
    private readonly sql: SqlStorage,
    /** The transaction-capable storage object (ctx.storage) and the process registered the transaction runner (src/server.ts; see transactionRunnerProvider.ts),
     *  when the host supplies it — enables the withTransaction
     *  wrap on save. */
    private readonly txStorage?: DoTransactionStorage,
  ) {}

  async save(record: PausedScheduleRecord): Promise<void> {
    // The DELETE + INSERT upsert pair is one unit when the host
    // supplied the transaction-capable storage (ADR D-C).
    const runner = this.txStorage ? getTransactionRunner() : null;
    if (this.txStorage && runner) {
      await runner.run(
        this.txStorage,
        { operationName: "pausedSchedules.save", domain: "options-discovery" },
        () => saveSync(this.sql, record),
      );
    } else {
      saveSync(this.sql, record);
    }
  }

  async get(id: string): Promise<PausedScheduleRecord | undefined> {
    return getSync(this.sql, id);
  }

  async list(): Promise<PausedScheduleRecord[]> {
    return listSync(this.sql);
  }

  async remove(id: string): Promise<boolean> {
    return removeSync(this.sql, id);
  }

  async clear(): Promise<void> {
    clearSync(this.sql);
  }
}
