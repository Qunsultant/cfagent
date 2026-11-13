/**
 * Issue #3247 (sub-issue of #3241), slice 1 — Drizzle D1 adapter
 * for the free-access grant port. This module is the ONLY place
 * free-access-grant code touches a store client: all
 * SQL-adjacent code (the Drizzle query builder) lives here,
 * behind the port interface. Every operation is a single
 * statement, which is atomic on any store (same rule as the
 * other D1 adapters; see migrationRunner.ts). The port's grant
 * sequences two single statements (revoke-old, then insert) —
 * it does not build a multi-statement transaction.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { agentFreeAccessGrants } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0064_FREE_ACCESS_GRANTS,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertFreeAccessGrantInput,
  assertFreeAccessGrantKind,
  type FreeAccessGrantPort,
  type FreeAccessGrantRecord,
} from "./freeAccessGrantPorts";

/** Drizzle D1 database object carrying the free-access-grant schema. */
export type FreeAccessGrantDb = DrizzleD1Database<{
  agentFreeAccessGrants: typeof agentFreeAccessGrants;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1FreeAccessGrantDb(d1: D1Database): FreeAccessGrantDb {
  return drizzle(d1, {
    schema: {
      agentFreeAccessGrants,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0064 (the
 * agent_free_access_grants table) alone. The table is
 * standalone — no prerequisite chain: it references no other
 * table, and the grant routes ensure the commercial schema
 * separately before reading the target account row. applyMigrations
 * sorts by version, so this ensure is safe on a fresh DB and
 * a no-op on a migrated one.
 */
export async function ensureFreeAccessGrantSchema(db: FreeAccessGrantDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0064_FREE_ACCESS_GRANTS]);
}

function toRecord(row: typeof agentFreeAccessGrants.$inferSelect): FreeAccessGrantRecord {
  return {
    id: row.id,
    login: row.login,
    kind: assertFreeAccessGrantKind(row.kind),
    grantedBy: row.grantedBy,
    grantedAtMs: row.grantedAtMs,
    expiresAtMs: row.expiresAtMs,
    revokedAtMs: row.revokedAtMs,
    reason: row.reason,
  };
}

/** The active-grant filter, in SQL: unrevoked, unexpired. Mirrors isFreeAccessGrantActive. */
function activeFilter(nowMs: number) {
  return and(
    isNull(agentFreeAccessGrants.revokedAtMs),
    or(isNull(agentFreeAccessGrants.expiresAtMs), gt(agentFreeAccessGrants.expiresAtMs, nowMs)),
  );
}

/** Free-access grants over D1 via Drizzle. */
export class D1FreeAccessGrantAdapter implements FreeAccessGrantPort {
  constructor(readonly db: FreeAccessGrantDb) {}

  async getActiveGrant(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null> {
    const rows = await this.db
      .select()
      .from(agentFreeAccessGrants)
      .where(and(eq(agentFreeAccessGrants.login, login), activeFilter(nowMs)))
      .orderBy(desc(agentFreeAccessGrants.grantedAtMs), desc(agentFreeAccessGrants.id))
      .limit(1);
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async listGrants(login: string): Promise<FreeAccessGrantRecord[]> {
    const rows = await this.db
      .select()
      .from(agentFreeAccessGrants)
      .where(eq(agentFreeAccessGrants.login, login))
      .orderBy(desc(agentFreeAccessGrants.grantedAtMs), desc(agentFreeAccessGrants.id));
    return rows.map(toRecord);
  }

  async grant(input: {
    login: string;
    kind: FreeAccessGrantRecord["kind"];
    expiresAtMs: number | null;
    reason: string;
    grantedBy: string;
    nowMs: number;
  }): Promise<{ granted: FreeAccessGrantRecord; replaced: FreeAccessGrantRecord | null }> {
    const validated = assertFreeAccessGrantInput(input, input.nowMs);
    const nowMs = input.nowMs;
    // Replace semantics: revoke the active grant first (a single
    // conditional UPDATE, guarded on the row still being
    // unrevoked), then insert the new row. History is preserved
    // in the revoked row.
    let replaced: FreeAccessGrantRecord | null = null;
    const active = await this.getActiveGrant(validated.login, nowMs);
    if (active) {
      const rows = await this.db
        .update(agentFreeAccessGrants)
        .set({ revokedAtMs: nowMs })
        .where(and(eq(agentFreeAccessGrants.id, active.id), isNull(agentFreeAccessGrants.revokedAtMs)))
        .returning();
      replaced = rows.length > 0 ? toRecord(rows[0]) : { ...active, revokedAtMs: nowMs };
    }
    const record: FreeAccessGrantRecord = {
      id: `freeaccess-${crypto.randomUUID().slice(0, 8)}`,
      login: validated.login,
      kind: validated.kind,
      grantedBy: validated.grantedBy,
      grantedAtMs: nowMs,
      expiresAtMs: validated.expiresAtMs,
      revokedAtMs: null,
      reason: validated.reason,
    };
    await this.db.insert(agentFreeAccessGrants).values({
      id: record.id,
      login: record.login,
      kind: record.kind,
      grantedBy: record.grantedBy,
      grantedAtMs: record.grantedAtMs,
      expiresAtMs: record.expiresAtMs,
      revokedAtMs: record.revokedAtMs,
      reason: record.reason,
    });
    return { granted: record, replaced };
  }

  /**
   * Revoke the active grant: a single conditional UPDATE (the
   * row must still be unrevoked and unexpired) with RETURNING,
   * so the transition is atomic — an empty result means another
   * revoker won the race (or the grant lapsed), and the caller
   * sees null instead of revoking twice.
   */
  async revokeActive(login: string, nowMs: number): Promise<FreeAccessGrantRecord | null> {
    const active = await this.getActiveGrant(login, nowMs);
    if (!active) return null;
    const rows = await this.db
      .update(agentFreeAccessGrants)
      .set({ revokedAtMs: nowMs })
      .where(
        and(
          eq(agentFreeAccessGrants.id, active.id),
          isNull(agentFreeAccessGrants.revokedAtMs),
          or(isNull(agentFreeAccessGrants.expiresAtMs), gt(agentFreeAccessGrants.expiresAtMs, nowMs)),
        ),
      )
      .returning();
    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }
}
