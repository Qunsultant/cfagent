/**
 * Issue #1651 ([AGENTIC] Slice 1) — Drizzle D1 adapter for the
 * chain/schedule ports (R1/R2). This module is the ONLY place
 * slice-1 code touches a store client: all query-builder code
 * lives here, behind the port interfaces.
 *
 * Transactions: every slice-1 operation is a single statement
 * (one upsert, one SELECT), which is atomic on any store — the
 * same reasoning as the slice-0 governance adapter. Cross-store
 * consistency is the R5 story (idempotent writes +
 * reconciliation), not a distributed transaction.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, desc, eq } from "drizzle-orm";
import {
  agentChains,
  agentGovernance,
  agentSynthesizedSchedules,
} from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  ChainRow,
  ChainScheduleStore,
  ScheduleRow,
} from "./chainSchedulePorts";

/** Drizzle D1 database object carrying the foundation schema. */
export type ChainScheduleDb = DrizzleD1Database<{
  agentGovernance: typeof agentGovernance;
  agentChains: typeof agentChains;
  agentSynthesizedSchedules: typeof agentSynthesizedSchedules;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ChainScheduleDb(d1: D1Database): ChainScheduleDb {
  return createDrizzleD1Db(d1, {
    schema: { agentGovernance, agentChains, agentSynthesizedSchedules },
  });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureChainScheduleSchema(
  db: ChainScheduleDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

/** Deterministic replay key: same version replays conflict and no-op. */
export function chainRowId(row: ChainRow): string {
  return `${row.tenantId}:${row.chainId}:${row.version}`;
}

export function scheduleRowId(row: ScheduleRow): string {
  return `${row.tenantId}:${row.scheduleId}:${row.version}`;
}

function toChainRow(raw: typeof agentChains.$inferSelect): ChainRow {
  return {
    tenantId: raw.tenantId,
    workspaceId: raw.workspaceId,
    chainId: raw.chainId,
    version: raw.version,
    status: raw.status as ChainRow["status"],
    goal: raw.goal,
    stepsJson: raw.stepsJson,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
    provenanceWriter: raw.provenanceWriter,
    provenanceSourceDo: raw.provenanceSourceDo,
    provenanceSourceVersion: raw.provenanceSourceVersion,
  };
}

function toScheduleRow(
  raw: typeof agentSynthesizedSchedules.$inferSelect,
): ScheduleRow {
  return {
    tenantId: raw.tenantId,
    workspaceId: raw.workspaceId,
    scheduleId: raw.scheduleId,
    chainId: raw.chainId,
    version: raw.version,
    status: raw.status as ScheduleRow["status"],
    kind: raw.kind as ScheduleRow["kind"],
    cron: raw.cron,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
    provenanceWriter: raw.provenanceWriter,
    provenanceSourceDo: raw.provenanceSourceDo,
    provenanceSourceVersion: raw.provenanceSourceVersion,
  };
}

/**
 * Chain/schedule store over D1 via Drizzle. Tenancy (R7) is
 * enforced here, not by callers: every query predicates on
 * tenant_id, and no unscoped read method exists on this class.
 */
export class D1ChainScheduleAdapter implements ChainScheduleStore {
  constructor(readonly db: ChainScheduleDb) {}

  async recordChain(row: ChainRow): Promise<void> {
    await this.db
      .insert(agentChains)
      .values({
        id: chainRowId(row),
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        chainId: row.chainId,
        version: row.version,
        status: row.status,
        goal: row.goal,
        stepsJson: row.stepsJson,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
        provenanceWriter: row.provenanceWriter,
        provenanceSourceDo: row.provenanceSourceDo,
        provenanceSourceVersion: row.provenanceSourceVersion,
      })
      .onConflictDoNothing();
  }

  async recordSchedule(row: ScheduleRow): Promise<void> {
    await this.db
      .insert(agentSynthesizedSchedules)
      .values({
        id: scheduleRowId(row),
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        scheduleId: row.scheduleId,
        chainId: row.chainId,
        version: row.version,
        status: row.status,
        kind: row.kind,
        cron: row.cron,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
        provenanceWriter: row.provenanceWriter,
        provenanceSourceDo: row.provenanceSourceDo,
        provenanceSourceVersion: row.provenanceSourceVersion,
      })
      .onConflictDoNothing();
  }

  async latestChain(
    tenantId: string,
    chainId: string,
  ): Promise<ChainRow | null> {
    const rows = await this.db
      .select()
      .from(agentChains)
      .where(
        and(
          eq(agentChains.tenantId, tenantId),
          eq(agentChains.chainId, chainId),
        ),
      )
      .orderBy(desc(agentChains.version), desc(agentChains.id))
      .limit(1);
    return rows.length === 0 ? null : toChainRow(rows[0]);
  }

  async latestSchedule(
    tenantId: string,
    scheduleId: string,
  ): Promise<ScheduleRow | null> {
    const rows = await this.db
      .select()
      .from(agentSynthesizedSchedules)
      .where(
        and(
          eq(agentSynthesizedSchedules.tenantId, tenantId),
          eq(agentSynthesizedSchedules.scheduleId, scheduleId),
        ),
      )
      .orderBy(
        desc(agentSynthesizedSchedules.version),
        desc(agentSynthesizedSchedules.id),
      )
      .limit(1);
    return rows.length === 0 ? null : toScheduleRow(rows[0]);
  }
}
