/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — Drizzle D1
 * adapter for the approved-free quota port. This module is the ONLY
 * place approved-free-quota code touches a store client: all
 * SQL-adjacent code (the Drizzle query builder) lives here, behind
 * the port interface.
 *
 * Transactions: every operation is a single statement (one INSERT,
 * one SELECT, one upsert), which is atomic on any store. No
 * multi-statement transaction is used here, for the reason recorded
 * in migrationRunner.ts (drizzle-orm/d1's `db.transaction()` is
 * sequential BEGIN/COMMIT, not Postgres-equivalent atomicity on D1).
 *
 * The cap check lives in consumeQuotaRun: the cap and the current
 * count are read, and the increment is a single conditional upsert
 * (it applies only while used < cap, judged against the CURRENT
 * stored cap inside the statement). A consume whose increment did
 * not land — the boundary race, or a cap lowered between the read
 * and the write — reports allowed=false, so the gate never allows
 * a run it did not count, and the persisted count never exceeds
 * the cap.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  agentApprovedFreeQuotaCounts,
  agentApprovedFreeQuotas,
  agentApprovedFreeQuotaSettings,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0054_APPROVED_FREE_QUOTA,
  MIGRATION_0055_APPROVED_FREE_QUOTA_SEED,
  type MigrationDb,
} from "./migrationRunner";
import {
  ApprovedFreeQuotaError,
  assertApprovedFreeQuotaAtLimitAction,
  assertApprovedFreeQuotaCap,
  assertApprovedFreeQuotaFamily,
  assertApprovedFreeQuotaSettings,
  assertApprovedFreeQuotaWindowKind,
  assertTenantLogin,
  type ApprovedFreeQuota,
  type ApprovedFreeQuotaConsumption,
  type ApprovedFreeQuotaSettings,
  type ApprovedFreeQuotaUsageInput,
} from "./approvedFreeQuotaPorts";

/** Drizzle D1 database object carrying the approved-free quota schema. */
export type ApprovedFreeQuotaDb = DrizzleD1Database<{
  agentApprovedFreeQuotas: typeof agentApprovedFreeQuotas;
  agentApprovedFreeQuotaCounts: typeof agentApprovedFreeQuotaCounts;
  agentApprovedFreeQuotaSettings: typeof agentApprovedFreeQuotaSettings;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ApprovedFreeQuotaDb(d1: D1Database): ApprovedFreeQuotaDb {
  return drizzle(d1, {
    schema: {
      agentApprovedFreeQuotas,
      agentApprovedFreeQuotaCounts,
      agentApprovedFreeQuotaSettings,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migrations 0054 (tables) and 0055
 * (seed rows, INSERT OR IGNORE — re-ensure is a no-op, so an
 * operator-edited cap or setting is never overwritten by a later
 * ensure). The defaults live only in migration 0055's rows, never
 * in code.
 */
export async function ensureApprovedFreeQuotaSchema(db: ApprovedFreeQuotaDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0054_APPROVED_FREE_QUOTA,
    MIGRATION_0055_APPROVED_FREE_QUOTA_SEED,
  ]);
}

/** The single settings row id. */
export const APPROVED_FREE_QUOTA_SETTINGS_ID = "default";

export class D1ApprovedFreeQuotaAdapter implements ApprovedFreeQuota {
  constructor(readonly db: ApprovedFreeQuotaDb) {}

  /** Port method: apply migrations 0054+0055 idempotently (see ensureApprovedFreeQuotaSchema). */
  async ensureSchema(): Promise<number[]> {
    return ensureApprovedFreeQuotaSchema(this.db);
  }

  async getCap(family: string): Promise<number | null> {
    const rows = await this.db
      .select()
      .from(agentApprovedFreeQuotas)
      .where(eq(agentApprovedFreeQuotas.family, family))
      .limit(1);
    const raw = rows[0]?.capRuns;
    // Fail-closed read (#3263, same shape as the free-run counter):
    // a missing row or an invalid stored value reads as null, and
    // the gate treats null as "no quota configured".
    if (raw === undefined || !Number.isInteger(raw) || raw < 0) return null;
    return raw;
  }

  async getUsed(input: ApprovedFreeQuotaUsageInput): Promise<number> {
    assertTenantLogin(input);
    const family = assertApprovedFreeQuotaFamily(input.family);
    const rows = await this.db
      .select()
      .from(agentApprovedFreeQuotaCounts)
      .where(
        and(
          eq(agentApprovedFreeQuotaCounts.tenantId, input.tenantId),
          eq(agentApprovedFreeQuotaCounts.userLogin, input.login),
          eq(agentApprovedFreeQuotaCounts.family, family),
          eq(agentApprovedFreeQuotaCounts.period, input.period),
        ),
      )
      .limit(1);
    const raw = rows[0]?.used;
    if (raw === undefined) return 0;
    if (!Number.isInteger(raw) || raw < 0) {
      throw new ApprovedFreeQuotaError("corrupt_count", {
        tenantId: input.tenantId,
        login: input.login,
        family,
        period: input.period,
      });
    }
    return raw;
  }

  async getSettings(): Promise<ApprovedFreeQuotaSettings | null> {
    const rows = await this.db
      .select()
      .from(agentApprovedFreeQuotaSettings)
      .where(eq(agentApprovedFreeQuotaSettings.id, APPROVED_FREE_QUOTA_SETTINGS_ID))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const settings = assertApprovedFreeQuotaSettings({ windowKind: row.windowKind, atLimitAction: row.atLimitAction });
    return {
      ...settings,
      updatedAtMs: row.updatedAtMs,
      updatedBy: row.updatedBy,
    };
  }

  async consumeQuotaRun(input: ApprovedFreeQuotaUsageInput): Promise<ApprovedFreeQuotaConsumption> {
    assertTenantLogin(input);
    const family = assertApprovedFreeQuotaFamily(input.family);
    const cap = await this.getCap(family);
    if (cap === null || cap <= 0) {
      return { allowed: false, used: await this.getUsed({ ...input, family }), cap, period: input.period };
    }
    const used = await this.getUsed({ ...input, family });
    if (used >= cap) return { allowed: false, used, cap, period: input.period };
    const now = Date.now();
    await this.db
      .insert(agentApprovedFreeQuotaCounts)
      .values({ tenantId: input.tenantId, userLogin: input.login, family, period: input.period, used: 1, updatedAtMs: now })
      .onConflictDoUpdate({
        target: [
          agentApprovedFreeQuotaCounts.tenantId,
          agentApprovedFreeQuotaCounts.userLogin,
          agentApprovedFreeQuotaCounts.family,
          agentApprovedFreeQuotaCounts.period,
        ],
        set: { used: sql`${agentApprovedFreeQuotaCounts.used} + 1`, updatedAtMs: now },
        where: sql`${agentApprovedFreeQuotaCounts.used} < (SELECT ${agentApprovedFreeQuotas.capRuns} FROM ${agentApprovedFreeQuotas} WHERE ${agentApprovedFreeQuotas.family} = ${agentApprovedFreeQuotaCounts.family})`,
      });
    // Applied-check: the increment landed exactly when the count
    // grew by one. When the conditional upsert did not apply (the
    // boundary race, or a cap lowered between the read and the
    // write), the run is not counted and not allowed — the gate
    // falls through to the at-limit decision.
    const after = await this.getUsed({ ...input, family });
    return { allowed: after === used + 1, used: after, cap, period: input.period };
  }

  async setCap(input: { family: unknown; capRuns: unknown; updatedBy?: unknown }): Promise<number> {
    const family = assertApprovedFreeQuotaFamily(input.family);
    const capRuns = assertApprovedFreeQuotaCap(input.capRuns);
    const updatedBy = typeof input.updatedBy === "string" ? input.updatedBy : null;
    await this.db
      .insert(agentApprovedFreeQuotas)
      .values({ family, capRuns, updatedAtMs: Date.now(), updatedBy })
      .onConflictDoUpdate({
        target: agentApprovedFreeQuotas.family,
        set: { capRuns, updatedAtMs: Date.now(), updatedBy },
      });
    return capRuns;
  }

  async setSettings(input: {
    windowKind?: unknown;
    atLimitAction?: unknown;
    updatedBy?: unknown;
  }): Promise<ApprovedFreeQuotaSettings> {
    const current = await this.getSettings();
    const windowKind =
      input.windowKind === undefined
        ? current?.windowKind
        : assertApprovedFreeQuotaWindowKind(input.windowKind);
    const atLimitAction =
      input.atLimitAction === undefined
        ? current?.atLimitAction
        : assertApprovedFreeQuotaAtLimitAction(input.atLimitAction);
    if (windowKind === undefined || atLimitAction === undefined) {
      throw new ApprovedFreeQuotaError("invalid_settings");
    }
    const updatedBy = typeof input.updatedBy === "string" ? input.updatedBy : (current?.updatedBy ?? null);
    await this.db
      .insert(agentApprovedFreeQuotaSettings)
      .values({ id: APPROVED_FREE_QUOTA_SETTINGS_ID, windowKind, atLimitAction, updatedAtMs: Date.now(), updatedBy })
      .onConflictDoUpdate({
        target: agentApprovedFreeQuotaSettings.id,
        set: { windowKind, atLimitAction, updatedAtMs: Date.now(), updatedBy },
      });
    return {
      windowKind,
      atLimitAction,
      updatedAtMs: Date.now(),
      updatedBy,
    };
  }
}
