/**
 * Issue #6503 — Drizzle D1 adapter for the unified schedule port.
 * The one unified schedule store lives in D1 ONLY (owner direction
 * 2026-11-25): schedule data is in D1 and nowhere else — not in
 * Durable Object SQLite. This module is the ONLY place slice code
 * touches the D1 schedule store: all query-builder code lives here,
 * behind the async `ScheduleStore` port (the interface is unchanged;
 * D1 is async-only, so there is no sync surface here).
 *
 * Pattern: `D1ChainScheduleAdapter` (#1651) — Drizzle over
 * `env.AGENT_DB` via `createD1ChainScheduleDb` + `createDrizzleD1Db`,
 * schema-ensure = `applyMigrations(db, ALL_MIGRATIONS)`, called
 * lazily and memoized per adapter instance (one adapter per host).
 *
 * Fail-closed (owner decision 2026-11-25, FAIL CLOSED tap): there is
 * no DO fallback. The factory in createUnifiedSchedulePorts.ts
 * throws when AGENT_DB is unbound; this adapter never reads a DO
 * table. Deploy must bind AGENT_DB on both DO hosts.
 *
 * The D1 table mirrors the DO `unified_schedules` table
 * column-for-column (migration 0092), so the row mapping is shared
 * with the DO adapter (`unifiedScheduleRowToRecord`). No rows are
 * copied — D1 starts empty (NO-COPY, owner direction 2026-11-25).
 *
 * Transactions: every operation is a single statement (one upsert,
 * one SELECT, one DELETE), which is atomic on any store — the same
 * reasoning as the slice-1 chain adapter. `clearPaused` is a
 * list-then-delete pair, like the DO adapter's count-then-delete.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { asc, eq } from "drizzle-orm";
import { unifiedSchedules } from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import { unifiedScheduleRowToRecord } from "./doSqliteUnifiedScheduleAdapter";
import {
  type ScheduleStore,
  type UnifiedScheduleKind,
  type UnifiedScheduleRecord,
  type UnifiedScheduleState,
} from "./unifiedSchedulePorts";

/** Drizzle D1 database object carrying the schedule schema. */
export type UnifiedScheduleDb = DrizzleD1Database<{
  unifiedSchedules: typeof unifiedSchedules;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1UnifiedScheduleDb(d1: D1Database): UnifiedScheduleDb {
  return createDrizzleD1Db(d1, {
    schema: { unifiedSchedules },
  });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureUnifiedScheduleSchema(
  db: UnifiedScheduleDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

function toValues(record: UnifiedScheduleRecord) {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    callback: record.callback ?? null,
    operation: record.operation ?? null,
    definitionJson: JSON.stringify(record.definition),
    ownerLogin: record.ownerLogin ?? null,
    provenanceJson:
      record.provenance === undefined ? null : JSON.stringify(record.provenance),
    alarmId: record.alarmId ?? null,
    pausedAt: record.pausedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Drizzle returns rows keyed by the mapping's camelCase property
 * names; the shared row mapper reads the DO table's snake_case
 * column names. Translate once, here — the D1 adapter owns its
 * Drizzle-shape knowledge, the mapper stays the one table reader.
 */
function drizzleRowToRaw(
  row: typeof unifiedSchedules.$inferSelect,
): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    callback: row.callback,
    operation: row.operation,
    definition_json: row.definitionJson,
    owner_login: row.ownerLogin,
    provenance_json: row.provenanceJson,
    alarm_id: row.alarmId,
    paused_at: row.pausedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toRecord(row: typeof unifiedSchedules.$inferSelect): UnifiedScheduleRecord {
  return unifiedScheduleRowToRecord(drizzleRowToRaw(row));
}

/** The unified schedule store over D1 via Drizzle. */
export class D1UnifiedScheduleAdapter implements ScheduleStore {
  private ensured: Promise<number[]> | null = null;

  constructor(readonly db: UnifiedScheduleDb) {}

  /** Lazy schema-ensure, memoized: one applyMigrations per instance. */
  private ensureSchema(): Promise<number[]> {
    if (!this.ensured) {
      this.ensured = ensureUnifiedScheduleSchema(this.db);
    }
    return this.ensured;
  }

  async save(record: UnifiedScheduleRecord): Promise<void> {
    await this.ensureSchema();
    const values = toValues(record);
    await this.db
      .insert(unifiedSchedules)
      .values(values)
      .onConflictDoUpdate({
        target: unifiedSchedules.id,
        set: {
          kind: values.kind,
          state: values.state,
          callback: values.callback,
          operation: values.operation,
          definitionJson: values.definitionJson,
          ownerLogin: values.ownerLogin,
          provenanceJson: values.provenanceJson,
          alarmId: values.alarmId,
          pausedAt: values.pausedAt,
          createdAt: values.createdAt,
          updatedAt: values.updatedAt,
        },
      });
  }

  async get(id: string): Promise<UnifiedScheduleRecord | undefined> {
    await this.ensureSchema();
    const rows = await this.db
      .select()
      .from(unifiedSchedules)
      .where(eq(unifiedSchedules.id, id))
      .limit(1);
    return rows.length === 0 ? undefined : toRecord(rows[0]);
  }

  async list(): Promise<UnifiedScheduleRecord[]> {
    await this.ensureSchema();
    const rows = await this.db
      .select()
      .from(unifiedSchedules)
      .orderBy(asc(unifiedSchedules.createdAt), asc(unifiedSchedules.id));
    return rows.map(toRecord);
  }

  async listByKind(kind: UnifiedScheduleKind): Promise<UnifiedScheduleRecord[]> {
    await this.ensureSchema();
    const rows = await this.db
      .select()
      .from(unifiedSchedules)
      .where(eq(unifiedSchedules.kind, kind))
      .orderBy(asc(unifiedSchedules.createdAt), asc(unifiedSchedules.id));
    return rows.map(toRecord);
  }

  async listByState(
    state: UnifiedScheduleState,
  ): Promise<UnifiedScheduleRecord[]> {
    await this.ensureSchema();
    const rows = await this.db
      .select()
      .from(unifiedSchedules)
      .where(eq(unifiedSchedules.state, state))
      .orderBy(asc(unifiedSchedules.createdAt), asc(unifiedSchedules.id));
    return rows.map(toRecord);
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureSchema();
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db
      .delete(unifiedSchedules)
      .where(eq(unifiedSchedules.id, id));
    return true;
  }

  async clear(): Promise<void> {
    await this.ensureSchema();
    await this.db.delete(unifiedSchedules);
  }

  async clearPaused(): Promise<number> {
    await this.ensureSchema();
    const paused = await this.listByState("paused");
    await this.db
      .delete(unifiedSchedules)
      .where(eq(unifiedSchedules.state, "paused"));
    return paused.length;
  }
}
