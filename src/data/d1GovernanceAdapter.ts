/**
 * Issue #1548 ([AGENTIC] Slice 0) — Drizzle D1 adapter for the
 * governance ports (R1/R2). This module is the ONLY place slice-0
 * code touches a store client: all SQL-adjacent code (the Drizzle
 * query builder) lives here, behind the port interfaces.
 *
 * Transactions: every slice-0 operation is a single statement
 * (one INSERT, one SELECT), which is atomic on any store. No
 * multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1). Cross-store consistency
 * is the R5 story (idempotent writes + reconciliation), not a
 * distributed transaction — see the ADR.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, desc, eq, isNull } from "drizzle-orm";
import { agentGovernance } from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  GovernanceHaltRow,
  GovernanceStore,
  HaltReadOptions,
} from "./governancePorts";

/** Drizzle D1 database object carrying the governance schema. */
export type GovernanceDb = DrizzleD1Database<{
  agentGovernance: typeof agentGovernance;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1GovernanceDb(d1: D1Database): GovernanceDb {
  return createDrizzleD1Db(d1, { schema: { agentGovernance } });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureGovernanceSchema(
  db: GovernanceDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

function toRow(raw: typeof agentGovernance.$inferSelect): GovernanceHaltRow {
  return {
    eventId: raw.id,
    tenantId: raw.tenantId,
    scope: raw.scope as GovernanceHaltRow["scope"],
    scopeId: raw.scopeId,
    state: raw.state as GovernanceHaltRow["state"],
    setBy: raw.setBy,
    setAtMs: raw.setAtMs,
    reason: raw.reason,
    version: raw.version,
    provenance: raw.provenance,
  };
}

/**
 * Governance store over D1 via Drizzle. Tenancy (R7) is enforced
 * here, not by callers: every query predicates on tenant_id, and
 * no unscoped read method exists on this class.
 */
export class D1GovernanceAdapter implements GovernanceStore {
  constructor(readonly db: GovernanceDb) {}

  async recordHalt(row: GovernanceHaltRow): Promise<void> {
    // INSERT OR IGNORE: replaying an event id is a no-op (R5).
    await this.db
      .insert(agentGovernance)
      .values({
        id: row.eventId,
        tenantId: row.tenantId,
        scope: row.scope,
        scopeId: row.scopeId,
        state: row.state,
        setBy: row.setBy,
        setAtMs: row.setAtMs,
        reason: row.reason,
        version: row.version,
        provenance: row.provenance,
      })
      .onConflictDoNothing();
  }

  async latestHalt(
    tenantId: string,
    opts: HaltReadOptions = {},
  ): Promise<GovernanceHaltRow | null> {
    const scope = opts.scope ?? "global";
    const scopeId = opts.scopeId ?? null;
    const rows = await this.db
      .select()
      .from(agentGovernance)
      .where(
        and(
          eq(agentGovernance.tenantId, tenantId),
          eq(agentGovernance.scope, scope),
          scopeId === null
            ? isNull(agentGovernance.scopeId)
            : eq(agentGovernance.scopeId, scopeId),
        ),
      )
      .orderBy(desc(agentGovernance.setAtMs), desc(agentGovernance.id))
      .limit(1);
    return rows.length === 0 ? null : toRow(rows[0]);
  }

  /**
   * Fail-closed read (R6): any read error reports halted. A halt
   * switch that cannot be read is treated as thrown, never
   * silently ignored — the same rule as the shipped
   * `isAdaptationHalted` DO-side read.
   */
  async isHalted(
    tenantId: string,
    opts: HaltReadOptions = {},
  ): Promise<boolean> {
    try {
      const latest = await this.latestHalt(tenantId, opts);
      return latest !== null && latest.state === "halted";
    } catch (err) {
      console.error(
        "[data-foundation] Governance halt read failed; failing closed:",
        err,
      );
      return true;
    }
  }
}
