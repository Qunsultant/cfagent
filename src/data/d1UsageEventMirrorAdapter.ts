/**
 * Issue #3185 (bridge slice) — D1 adapter for the usage_events
 * mirror (the D1 side of the DO → D1 projection). The ONLY module
 * (with its in-memory test double) that may import drizzle-orm for
 * the agent_usage_events rows, and the only module that knows their
 * column names.
 *
 * Ordering rule: one row per meter id; usage rows are immutable
 * once written, so the projector is INSERT OR IGNORE — a replay
 * is a no-op, never a rewrite. The single exception is the
 * backfill's NULL-tenant stamp (stampTenantIfUnattributed): a
 * write-time NULL filled from the paid transaction's login, which
 * only ever fills NULL, never overwrites a stamp.
 */
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { agentUsageEvents } from "./drizzleSchema";
import {
  MIGRATION_0077_USAGE_EVENTS_MIRROR,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type { UsageEventDetailRow } from "./canonicalReportStorePorts";

export type D1UsageEventMirrorDb = ReturnType<typeof createD1UsageEventMirrorDb>;

export function createD1UsageEventMirrorDb(d1: unknown) {
  return createDrizzleD1Db(d1 as never, {
    schema: { agentUsageEvents },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0077 if unapplied.
 */
export async function ensureUsageEventMirrorSchema(
  db: D1UsageEventMirrorDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0077_USAGE_EVENTS_MIRROR,
  ]);
}

export interface MirrorUsageEventRow {
  id: string;
  userLogin: string;
  runId: string;
  category: string;
  createdAt: string;
  detailJson: string | null;
  tenantId: string | null;
  sourceInstance: string | null;
  projectedAt: string;
}

export function toMirrorRow(
  record: typeof agentUsageEvents.$inferSelect,
): MirrorUsageEventRow {
  return {
    id: record.id,
    userLogin: record.userLogin,
    runId: record.runId,
    category: record.category,
    createdAt: record.createdAt,
    detailJson: record.detailJson,
    tenantId: record.tenantId,
    sourceInstance: record.sourceInstance,
    projectedAt: record.projectedAt,
  };
}

/** A mirror row as the meter readers consume it (UsageEventDetailRow). */
export function toUsageEventDetailRow(row: MirrorUsageEventRow): UsageEventDetailRow {
  return {
    id: row.id,
    userLogin: row.userLogin,
    runId: row.runId,
    category: row.category,
    createdAt: row.createdAt,
    detailJson: row.detailJson,
    tenantId: row.tenantId,
  };
}

/**
 * Issue #3185 (bridge slice) — union the DO-half meter rows with
 * the D1 mirror rows, deduped by id (the DO row wins a collision:
 * the mirror is its projection). The mirror carries the
 * ResearchAgent half a DO instance cannot see; the DO rows cover
 * anything not yet projected.
 */
export function mergeMeterRows(
  doRows: UsageEventDetailRow[],
  mirrorRows: MirrorUsageEventRow[],
): UsageEventDetailRow[] {
  const merged = [...doRows];
  const seen = new Set(doRows.map((r) => r.id));
  for (const mirrored of mirrorRows) {
    if (!seen.has(mirrored.id)) {
      seen.add(mirrored.id);
      merged.push(toUsageEventDetailRow(mirrored));
    }
  }
  return merged;
}

export class D1UsageEventMirrorAdapter {
  constructor(readonly db: D1UsageEventMirrorDb) {}

  private ensured: Promise<number[]> | null = null;
  private ensure(): Promise<number[]> {
    if (!this.ensured) this.ensured = ensureUsageEventMirrorSchema(this.db);
    return this.ensured;
  }

  /**
   * Project one DO row. INSERT OR IGNORE: a replay is a no-op.
   * Returns true when the row landed and false when it was
   * already present. The adapter stamps projectedAt from nowMs —
   * callers never stamp projection time themselves.
   */
  async recordUsageEvent(
    row: UsageEventDetailRow,
    opts: { sourceInstance?: string | null; nowMs: number },
  ): Promise<boolean> {
    await this.ensure();
    const result = (await this.db
      .insert(agentUsageEvents)
      .values({
        id: row.id,
        userLogin: row.userLogin,
        runId: row.runId,
        category: row.category,
        createdAt: row.createdAt,
        detailJson: row.detailJson,
        tenantId: row.tenantId,
        sourceInstance: opts.sourceInstance ?? null,
        projectedAt: new Date(opts.nowMs).toISOString(),
      })
      .onConflictDoNothing()) as unknown as { meta?: { changes?: number } };
    const changes = result?.meta?.changes;
    return typeof changes === "number" ? changes > 0 : true;
  }

  /**
   * The backfill's NULL-tenant stamp: fills a write-time NULL
   * from the paid transaction's login. Only ever fills NULL —
   * a stamped row is authoritative and is never overwritten.
   * Returns true when a NULL was filled.
   */
  async stampTenantIfUnattributed(id: string, tenantId: string): Promise<boolean> {
    await this.ensure();
    const result = (await this.db
      .update(agentUsageEvents)
      .set({ tenantId })
      .where(
        and(eq(agentUsageEvents.id, id), isNull(agentUsageEvents.tenantId)),
      )) as unknown as { meta?: { changes?: number } };
    const changes = result?.meta?.changes;
    return typeof changes === "number" ? changes > 0 : true;
  }

  async getUsageEvent(id: string): Promise<MirrorUsageEventRow | null> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(agentUsageEvents)
      .where(eq(agentUsageEvents.id, id))
      .limit(1);
    return rows.length === 0 ? null : toMirrorRow(rows[0]);
  }

  /** Tenant-scoped read, newest first — the mirror's cross-DO reader. */
  async listByTenant(tenantId: string, limit: number): Promise<MirrorUsageEventRow[]> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(agentUsageEvents)
      .where(eq(agentUsageEvents.tenantId, tenantId))
      .orderBy(desc(agentUsageEvents.createdAt), desc(agentUsageEvents.id))
      .limit(Math.max(1, limit));
    return rows.map(toMirrorRow);
  }

  /** All mirror rows, oldest first (the reconcile sweep's order). */
  async listAll(): Promise<MirrorUsageEventRow[]> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(agentUsageEvents)
      .orderBy(desc(agentUsageEvents.createdAt), desc(agentUsageEvents.id));
    return rows.map(toMirrorRow);
  }

  async countByUser(userLogin: string): Promise<number> {
    await this.ensure();
    const rows = await this.db
      .select({ id: agentUsageEvents.id })
      .from(agentUsageEvents)
      .where(eq(agentUsageEvents.userLogin, userLogin));
    return rows.length;
  }

  /**
   * Retention prune (365d, PRUNE-CLASS): deletes mirror rows
   * older than the cutoff. Returns the deleted count. The mirror
   * prunes in the same pass as the DO tables — a partial prune
   * would misstate tenant totals.
   */
  async pruneBefore(cutoffIso: string): Promise<number> {
    await this.ensure();
    const result = (await this.db
      .delete(agentUsageEvents)
      .where(lt(agentUsageEvents.createdAt, cutoffIso))) as unknown as {
      meta?: { changes?: number };
    };
    const changes = result?.meta?.changes;
    if (typeof changes === "number") return changes;
    return -1;
  }

  /** DSAR erasure for one login. Returns the deleted count. */
  async deleteByUser(userLogin: string): Promise<number> {
    await this.ensure();
    const result = (await this.db
      .delete(agentUsageEvents)
      .where(eq(agentUsageEvents.userLogin, userLogin))) as unknown as {
      meta?: { changes?: number };
    };
    const changes = result?.meta?.changes;
    if (typeof changes === "number") return changes;
    return -1;
  }
}
