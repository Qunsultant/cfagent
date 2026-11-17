/**
 * Issue #2288 (#1976 step 0) — Drizzle D1 adapter for the
 * trace-record port (ADR 0002 R1/R2). All SQL-adjacent code for
 * the family lives here, behind the port interface.
 *
 * Transactions: append is a single INSERT (atomic on any store);
 * no multi-statement transaction is used, for the reason recorded
 * in migrationRunner.ts. When a caller needs a trace append to be
 * atomic WITH other writes, that is the transaction aspect's job
 * (src/aspects/transactionAspect.ts), not this adapter's.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { asc, desc, eq } from "drizzle-orm";
import { agentTraceRecords } from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type { TraceRecord, TraceRecordStore } from "./traceRecordPorts";

/** Drizzle D1 database object carrying the trace schema. */
export type TraceRecordDb = DrizzleD1Database<{
  agentTraceRecords: typeof agentTraceRecords;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1TraceRecordDb(d1: D1Database): TraceRecordDb {
  return createDrizzleD1Db(d1, { schema: { agentTraceRecords } });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureTraceRecordSchema(
  db: TraceRecordDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

function toRecord(raw: typeof agentTraceRecords.$inferSelect): TraceRecord {
  return {
    id: raw.id,
    correlationId: raw.correlationId,
    causationId: raw.causationId,
    actingAgent: raw.actingAgent,
    principal: raw.principal,
    operation: raw.operation,
    outcomeCode: raw.outcomeCode,
    latencyMs: raw.latencyMs,
    costUnits: raw.costUnits,
    costDetailJson: raw.costDetailJson,
    occurredAtMs: raw.occurredAtMs,
  };
}

/** Trace store over D1 via Drizzle. Append-only by port design. */
export class D1TraceRecordAdapter implements TraceRecordStore {
  constructor(readonly db: TraceRecordDb) {}

  async appendTrace(record: TraceRecord): Promise<void> {
    // INSERT OR IGNORE: replaying a record id is a no-op.
    await this.db
      .insert(agentTraceRecords)
      .values({
        id: record.id,
        correlationId: record.correlationId,
        causationId: record.causationId,
        actingAgent: record.actingAgent,
        principal: record.principal,
        operation: record.operation,
        outcomeCode: record.outcomeCode,
        latencyMs: record.latencyMs,
        costUnits: record.costUnits,
        costDetailJson: record.costDetailJson,
        occurredAtMs: record.occurredAtMs,
        createdAtMs: Date.now(),
      })
      .onConflictDoNothing();
  }

  async listByCorrelation(correlationId: string): Promise<TraceRecord[]> {
    const rows = await this.db
      .select()
      .from(agentTraceRecords)
      .where(eq(agentTraceRecords.correlationId, correlationId))
      .orderBy(asc(agentTraceRecords.occurredAtMs), asc(agentTraceRecords.id));
    return rows.map(toRecord);
  }

  async listByAgent(
    actingAgent: string,
    limit: number = 100,
  ): Promise<TraceRecord[]> {
    const rows = await this.db
      .select()
      .from(agentTraceRecords)
      .where(eq(agentTraceRecords.actingAgent, actingAgent))
      .orderBy(desc(agentTraceRecords.occurredAtMs), desc(agentTraceRecords.id))
      .limit(limit);
    return rows.map(toRecord);
  }
}
