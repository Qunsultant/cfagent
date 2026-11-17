/**
 * Issue #2288 (#1976 step 0) — Drizzle D1 adapter for the
 * work-item event port (ADR 0002 R1/R2). All SQL-adjacent code
 * for the family lives here, behind the port interface.
 *
 * The upsert is a single statement (atomic on any store) using
 * the portable ON CONFLICT form over the (source, external_id)
 * primary key; created_at_ms is written only on insert, so a
 * redelivery refreshes state without moving first-sighting
 * time. `inserted` is resolved by a read-before-write existence
 * check — the same read the caller would do — never guessed.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, desc, eq } from "drizzle-orm";
import { agentWorkItemEvents } from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  WorkItemEvent,
  WorkItemEventRow,
  WorkItemEventStore,
  WorkItemKind,
} from "./workItemEventPorts";

/** Drizzle D1 database object carrying the work-item schema. */
export type WorkItemEventDb = DrizzleD1Database<{
  agentWorkItemEvents: typeof agentWorkItemEvents;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1WorkItemEventDb(d1: D1Database): WorkItemEventDb {
  return createDrizzleD1Db(d1, { schema: { agentWorkItemEvents } });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureWorkItemEventSchema(
  db: WorkItemEventDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

function toRow(
  raw: typeof agentWorkItemEvents.$inferSelect,
): WorkItemEventRow {
  return {
    source: raw.source,
    externalId: raw.externalId,
    kind: raw.kind as WorkItemKind,
    state: raw.state,
    actor: raw.actor,
    occurredAtMs: raw.occurredAtMs,
    payloadDigest: raw.payloadDigest,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Work-item projection over D1 via Drizzle. */
export class D1WorkItemEventAdapter implements WorkItemEventStore {
  constructor(readonly db: WorkItemEventDb) {}

  async upsertWorkItemEvent(
    event: WorkItemEvent,
    deliveredAtMs: number = Date.now(),
  ): Promise<{ inserted: boolean }> {
    const existing = await this.getWorkItemEvent(
      event.source,
      event.externalId,
    );
    await this.db
      .insert(agentWorkItemEvents)
      .values({
        source: event.source,
        externalId: event.externalId,
        kind: event.kind,
        state: event.state,
        actor: event.actor,
        occurredAtMs: event.occurredAtMs,
        payloadDigest: event.payloadDigest,
        createdAtMs: deliveredAtMs,
        updatedAtMs: deliveredAtMs,
      })
      .onConflictDoUpdate({
        target: [
          agentWorkItemEvents.source,
          agentWorkItemEvents.externalId,
        ],
        set: {
          kind: event.kind,
          state: event.state,
          actor: event.actor,
          occurredAtMs: event.occurredAtMs,
          payloadDigest: event.payloadDigest,
          updatedAtMs: deliveredAtMs,
        },
      });
    return { inserted: existing === null };
  }

  async getWorkItemEvent(
    source: string,
    externalId: string,
  ): Promise<WorkItemEventRow | null> {
    const rows = await this.db
      .select()
      .from(agentWorkItemEvents)
      .where(
        and(
          eq(agentWorkItemEvents.source, source),
          eq(agentWorkItemEvents.externalId, externalId),
        ),
      );
    return rows.length === 0 ? null : toRow(rows[0]);
  }

  async listWorkItemEvents(
    kind?: WorkItemKind,
  ): Promise<WorkItemEventRow[]> {
    const query = this.db.select().from(agentWorkItemEvents);
    const rows = kind
      ? await query
          .where(eq(agentWorkItemEvents.kind, kind))
          .orderBy(
            desc(agentWorkItemEvents.occurredAtMs),
            desc(agentWorkItemEvents.externalId),
          )
      : await query.orderBy(
          desc(agentWorkItemEvents.occurredAtMs),
          desc(agentWorkItemEvents.externalId),
        );
    return rows.map(toRow);
  }
}
