/**
 * Phase 5 Slice 1 (issue #2000) — Drizzle D1 adapter for the
 * dead-letter store port. This module is the ONLY place
 * dead-letter code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder) lives here, behind the port
 * interface.
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT, one UPDATE), which is atomic on any
 * store. No multi-statement transaction is used here, for the
 * reason recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1).
 *
 * Guarded claims (markReplayed, claimDepthIncident) never
 * rely on affected-row counts — not portable across the D1
 * client and the node:sqlite test stand-in. Each claim writes
 * a caller token under a NULL guard, then re-reads the row:
 * the claim won iff the stored token is the caller's.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { agentDeadLetterRecords, dlqDepthState } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0033_DEAD_LETTER_STORE,
  type MigrationDb,
} from "./migrationRunner";
import {
  newDeadLetterRecordId,
  type DeadLetterStore,
  type DeadLetterStoreInsert,
  type DeadLetterStoreRecord,
} from "../messaging/deadLetterStorePorts";

/** Drizzle D1 database object carrying the dead-letter schema. */
export type DeadLetterStoreDb = DrizzleD1Database<{
  agentDeadLetterRecords: typeof agentDeadLetterRecords;
  dlqDepthState: typeof dlqDepthState;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1DeadLetterStoreDb(d1: D1Database): DeadLetterStoreDb {
  return drizzle(d1, {
    schema: {
      agentDeadLetterRecords,
      dlqDepthState,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0033 if
 * unapplied. No seeding: an empty store means no dead letters
 * yet, which is the normal state.
 */
export async function ensureDeadLetterStoreSchema(db: DeadLetterStoreDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0033_DEAD_LETTER_STORE]);
}

/** The single depth-incident row's id. */
const DEPTH_STATE_ID = "depth";

function toRecord(row: typeof agentDeadLetterRecords.$inferSelect): DeadLetterStoreRecord {
  return {
    id: row.id,
    queue: row.queue,
    reason: row.reason as DeadLetterStoreRecord["reason"],
    messageId: row.messageId,
    runId: row.runId,
    unitId: row.unitId,
    actorLogin: row.actorLogin,
    actorKind: row.actorKind,
    subscriber: row.subscriber,
    detail: row.detail,
    envelopeJson: row.envelopeJson,
    createdAtMs: row.createdAtMs,
    replayedAtMs: row.replayedAtMs,
    replayOutcome: row.replayOutcome,
    replayToken: row.replayToken,
  };
}

/** Dead-letter store over D1 via Drizzle. */
export class D1DeadLetterStoreAdapter implements DeadLetterStore {
  constructor(readonly db: DeadLetterStoreDb) {}

  async insert(input: DeadLetterStoreInsert): Promise<DeadLetterStoreRecord> {
    const createdAtMs = input.createdAtMs ?? Date.now();
    const record: DeadLetterStoreRecord = {
      id: newDeadLetterRecordId(createdAtMs),
      queue: input.queue,
      reason: input.reason,
      messageId: input.messageId ?? null,
      runId: input.runId ?? null,
      unitId: input.unitId ?? null,
      actorLogin: input.actorLogin ?? null,
      actorKind: input.actorKind ?? null,
      subscriber: input.subscriber ?? null,
      detail: input.detail ?? null,
      envelopeJson: input.envelope ? JSON.stringify(input.envelope) : null,
      createdAtMs,
      replayedAtMs: null,
      replayOutcome: null,
      replayToken: null,
    };
    await this.db.insert(agentDeadLetterRecords).values({
      id: record.id,
      queue: record.queue,
      reason: record.reason,
      messageId: record.messageId,
      runId: record.runId,
      unitId: record.unitId,
      actorLogin: record.actorLogin,
      actorKind: record.actorKind,
      subscriber: record.subscriber,
      detail: record.detail,
      envelopeJson: record.envelopeJson,
      createdAtMs: record.createdAtMs,
      replayedAtMs: record.replayedAtMs,
      replayOutcome: record.replayOutcome,
      replayToken: record.replayToken,
    });
    return record;
  }

  async listUnreplayed(limit: number): Promise<DeadLetterStoreRecord[]> {
    const rows = await this.db
      .select()
      .from(agentDeadLetterRecords)
      .where(isNull(agentDeadLetterRecords.replayedAtMs))
      .orderBy(desc(agentDeadLetterRecords.createdAtMs), asc(agentDeadLetterRecords.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<DeadLetterStoreRecord | null> {
    const rows = await this.db
      .select()
      .from(agentDeadLetterRecords)
      .where(eq(agentDeadLetterRecords.id, id))
      .limit(1);
    return rows.length > 0 ? toRecord(rows[0]) : null;
  }

  async markReplayed(input: { id: string; outcome: string; atMs: number; token: string }): Promise<boolean> {
    await this.db
      .update(agentDeadLetterRecords)
      .set({ replayedAtMs: input.atMs, replayOutcome: input.outcome, replayToken: input.token })
      .where(
        and(
          eq(agentDeadLetterRecords.id, input.id),
          isNull(agentDeadLetterRecords.replayedAtMs),
        ),
      );
    const row = await this.getById(input.id);
    return row !== null && row.replayToken === input.token;
  }

  async unreplayedCount(): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(agentDeadLetterRecords)
      .where(isNull(agentDeadLetterRecords.replayedAtMs));
    return rows.length > 0 ? Number(rows[0].n) : 0;
  }

  async claimDepthIncident(input: { depth: number; atMs: number; token: string }): Promise<boolean> {
    await this.db
      .insert(dlqDepthState)
      .values({ id: DEPTH_STATE_ID, alertedAtMs: null, depthAtAlert: null, claimToken: null })
      .onConflictDoNothing();
    await this.db
      .update(dlqDepthState)
      .set({ alertedAtMs: input.atMs, depthAtAlert: input.depth, claimToken: input.token })
      .where(and(eq(dlqDepthState.id, DEPTH_STATE_ID), isNull(dlqDepthState.alertedAtMs)));
    const rows = await this.db
      .select()
      .from(dlqDepthState)
      .where(eq(dlqDepthState.id, DEPTH_STATE_ID))
      .limit(1);
    return rows.length > 0 && rows[0].claimToken === input.token;
  }

  async clearDepthIncident(): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(dlqDepthState)
      .where(eq(dlqDepthState.id, DEPTH_STATE_ID))
      .limit(1);
    if (rows.length === 0 || rows[0].alertedAtMs === null) return false;
    await this.db
      .update(dlqDepthState)
      .set({ alertedAtMs: null, depthAtAlert: null, claimToken: null })
      .where(eq(dlqDepthState.id, DEPTH_STATE_ID));
    return true;
  }
}
