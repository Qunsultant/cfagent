/**
 * Issue #6102 — the D1 implementation of the mas_events event log.
 *
 * Replacement, not projection: after cutover the D1 row IS the
 * audit record (no projected_at_ms, no backfill of DO rows). The
 * adapter implements the async twin port (AsyncEventLogPort) —
 * the D1 adapter cannot literally implement the sync EventLogPort
 * because DO SQLite is synchronous and D1 is async.
 *
 * Chain (G-5 frozen: six fields hashed, envelope columns NOT
 * hashed — see src/data/ormRepositoryCore.ts ChainedAuditRepository):
 * every create links onto the table's current tail. One DO instance
 * used to own its chain, so a sync tail-read + insert could not
 * interleave; the replacement merges every instance into one
 * global D1 chain, so two instances CAN interleave. The mechanism
 * is therefore two layers:
 * - a module-level promise-chain mutex (per-isolate contention
 *   reduction: one in-flight create per isolate), PLUS
 * - a single-statement conditional insert (catalogued as
 *   dml.d1.mas_events.insert_chained): the row lands only while
 *   the tail is still the tail the writer read; meta.changes 0
 *   means another writer landed first, so the adapter re-reads
 *   the tail, re-links, and retries (bounded). Genesis works
 *   because an empty table's tail is NULL and NULL IS NULL.
 * A duplicate id throws (PRIMARY KEY) — never a silent 0.
 *
 * Read contract: payload reads back as the stored JSON TEXT
 * string, exactly as the DO repository returned it (its fromDbRow
 * never parsed payload). The table is migration 0089's, declared
 * in src/data/drizzleSchema.ts; the schema is ensured through the
 * versioned migration runner. The rowid-dependent statements
 * (tail read, chain window, conditional insert) live in the DML
 * catalogue — the builder cannot express rowid — per the #4384
 * pin; everything else goes through the Drizzle builder.
 */
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { masEvents } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0089_MAS_EVENTS,
  type MigrationDb,
} from "./migrationRunner";
import { linkAuditRow } from "../security/auditChain";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDmlSql } from "./schemaComponent/dmlExecutor";
import type {
  AsyncAuditEventQueryOptions,
  AsyncEventLogPort,
  AuditChainWindowRow,
  AuditEventWhere,
} from "./asyncEventLogPorts";
import type { AuditEvent } from "../types";

/** Drizzle D1 database object carrying the mas_events table. */
export type AuditEventDb = DrizzleD1Database<{
  masEvents: typeof masEvents;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1AuditEventDb(d1: D1Database): AuditEventDb {
  return createDrizzleD1Db(d1, { schema: { masEvents } });
}

/** Idempotent schema-ensure: applies migration 0089 if unapplied. */
export async function ensureAuditEventSchema(db: AuditEventDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0089_MAS_EVENTS]);
}

type MasEventsRow = typeof masEvents.$inferSelect;

/**
 * The DO port's read shape: payload is the stored JSON TEXT
 * string (never parsed), envelope columns absent when null.
 */
function rowToRecord(row: MasEventsRow): AuditEvent {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    agent: row.agent as AuditEvent["agent"],
    payload: row.payload as unknown as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.previousEventHash != null
      ? { previousEventHash: row.previousEventHash }
      : {}),
    ...(row.eventHash != null ? { eventHash: row.eventHash } : {}),
    ...(row.platformId != null ? { platformId: row.platformId } : {}),
    ...(row.tenantId != null ? { tenantId: row.tenantId } : {}),
    ...(row.principalId != null ? { principalId: row.principalId } : {}),
    ...(row.correlationId != null ? { correlationId: row.correlationId } : {}),
    ...(row.traceId != null ? { traceId: row.traceId } : {}),
  };
}

/** The orders the moved reads use; anything else fails closed. */
const SUPPORTED_ORDERS = new Set(["created_at DESC", "created_at ASC"]);

const WHERE_COLUMNS: Record<keyof AuditEventWhere, AnySQLiteColumn> = {
  id: masEvents.id,
  sessionId: masEvents.sessionId,
  type: masEvents.type,
  agent: masEvents.agent,
};

/** Chain-contention retries before the create fails loud. */
const MAX_CHAIN_ATTEMPTS = 10;

/**
 * Per-isolate append serialization: one in-flight create per
 * isolate. Cross-isolate contention is still possible (and is
 * what the conditional insert + retry exists for); the mutex
 * only keeps one isolate from racing itself.
 */
let appendQueue: Promise<void> = Promise.resolve();

function withAppendMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = appendQueue.then(fn, fn);
  appendQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The D1 audit-event store (async surface over the async port). */
export class D1AuditEventStore implements AsyncEventLogPort {
  private ensured: Promise<void> | null = null;

  constructor(private readonly db: AuditEventDb) {}

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureAuditEventSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  /** The chain tail's event_hash, or null on an empty table (genesis). */
  private async readTailHash(): Promise<string | null> {
    const rows = (await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      "dml.d1.mas_events.read_tail_hash",
      {},
    )) as Array<{ event_hash?: string | null }>;
    return rows[0]?.event_hash ?? null;
  }

  async create(record: AuditEvent): Promise<AuditEvent> {
    await this.ensure();
    return withAppendMutex(async () => {
      // G-5 frozen: the payload is stored as JSON text (a Record
      // insert previously coerced to "[object Object]" — #1968),
      // and the hash input is exactly these six fields.
      const payloadText =
        typeof record.payload === "string"
          ? record.payload
          : JSON.stringify(record.payload ?? {});
      const createdAt = record.createdAt;
      for (let attempt = 1; attempt <= MAX_CHAIN_ATTEMPTS; attempt++) {
        const tail = await this.readTailHash();
        const chained = linkAuditRow(
          {
            id: record.id,
            sessionId: record.sessionId,
            type: record.type,
            agent: record.agent,
            payload: payloadText,
            createdAt,
          },
          tail,
        );
        const result = (await executeDmlSql(
          DML_CATALOGUE,
          this.db,
          "dml.d1.mas_events.insert_chained",
          {
            id: record.id,
            sessionId: record.sessionId,
            type: record.type,
            agent: record.agent,
            payload: payloadText,
            createdAt,
            previousEventHash: chained.previousEventHash,
            eventHash: chained.eventHash,
            // Issue #6100: envelope dimensions bind explicitly —
            // null when unresolvable, never undefined, never invented.
            platformId: record.platformId ?? null,
            tenantId: record.tenantId ?? null,
            principalId: record.principalId ?? null,
            correlationId: record.correlationId ?? null,
            traceId: record.traceId ?? null,
            expectedTail: tail,
          },
        )) as { meta?: { changes?: number } };
        const changes = result?.meta?.changes;
        if (typeof changes === "number" && changes === 0) {
          // Another writer landed first: re-read the tail and retry.
          continue;
        }
        if (typeof changes === "number" && changes > 0) {
          return chainedRecord(record, payloadText, chained);
        }
        // A store that reports no change count: verify by re-read
        // rather than assuming the row landed (or did not).
        const landed = await this.findById(record.id);
        if (
          landed &&
          (landed as { eventHash?: string }).eventHash === chained.eventHash
        ) {
          return chainedRecord(record, payloadText, chained);
        }
        // Not landed and no count to explain why: treat as
        // contention and retry (the next attempt re-reads the tail).
      }
      throw new Error(
        `D1 audit event chain contention: ${record.id} could not append after ${MAX_CHAIN_ATTEMPTS} attempts`,
      );
    });
  }

  async findMany(
    options: AsyncAuditEventQueryOptions = {},
  ): Promise<AuditEvent[]> {
    await this.ensure();
    const where = options.where ?? {};
    for (const key of Object.keys(where)) {
      if (!(key in WHERE_COLUMNS)) {
        throw new Error(
          `D1 audit event findMany: unsupported where key "${key}"`,
        );
      }
    }
    if (options.orderBy !== undefined && !SUPPORTED_ORDERS.has(options.orderBy)) {
      throw new Error(
        `D1 audit event findMany: unsupported orderBy "${options.orderBy}"`,
      );
    }
    const conditions = (Object.entries(where) as [keyof AuditEventWhere, string][])
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => eq(WHERE_COLUMNS[key], value));
    const query = this.db.select().from(masEvents).$dynamic();
    if (conditions.length > 0) query.where(and(...conditions));
    if (options.orderBy === "created_at DESC") query.orderBy(desc(masEvents.createdAt));
    if (options.orderBy === "created_at ASC") query.orderBy(asc(masEvents.createdAt));
    if (options.limit !== undefined) query.limit(options.limit);
    if (options.offset !== undefined) query.offset(options.offset);
    const rows = await query;
    return rows.map(rowToRecord);
  }

  async findById(id: string): Promise<AuditEvent | null> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(masEvents)
      .where(eq(masEvents.id, id))
      .limit(1);
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
  }

  async idsCreatedBefore(cutoffIso: string, limit: number): Promise<string[]> {
    await this.ensure();
    const rows = await this.db
      .select({ id: masEvents.id })
      .from(masEvents)
      .where(lt(masEvents.createdAt, cutoffIso))
      .orderBy(asc(masEvents.createdAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensure();
    const result = (await this.db
      .delete(masEvents)
      .where(eq(masEvents.id, id))) as unknown as {
      meta?: { changes?: number };
    };
    const changes = result?.meta?.changes;
    if (typeof changes === "number") return changes > 0;
    return (await this.findById(id)) === null;
  }

  async readChainWindow(
    afterRowId: number,
    limit?: number,
  ): Promise<AuditChainWindowRow[]> {
    await this.ensure();
    const rows = (await executeDmlSql(
      DML_CATALOGUE,
      this.db,
      "dml.d1.mas_events.read_chain_window",
      { afterRowId, ...(limit !== undefined ? { limit } : {}) },
    )) as Array<{
      rowid: number;
      id: string;
      session_id: string;
      type: string;
      agent: string;
      payload: string;
      created_at: string;
      previous_event_hash: string | null;
      event_hash: string | null;
    }>;
    return rows.map((row) => ({
      rowid: row.rowid,
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      agent: row.agent,
      payload: row.payload,
      createdAt: row.created_at,
      previousEventHash: row.previous_event_hash,
      eventHash: row.event_hash ?? "",
    }));
  }
}

/** The chained record as the DO create returned it (payload TEXT, nulls explicit). */
function chainedRecord(
  record: AuditEvent,
  payloadText: string,
  chained: { previousEventHash: string | null; eventHash: string },
): AuditEvent {
  return {
    ...record,
    payload: payloadText as unknown as Record<string, unknown>,
    previousEventHash: chained.previousEventHash,
    eventHash: chained.eventHash,
    platformId: record.platformId ?? null,
    tenantId: record.tenantId ?? null,
    principalId: record.principalId ?? null,
    correlationId: record.correlationId ?? null,
    traceId: record.traceId ?? null,
  } as AuditEvent;
}
