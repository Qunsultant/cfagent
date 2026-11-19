/**
 * Issue #3305 (sub-issue of #3241) — Drizzle D1 adapter for the
 * free-run counter port. This module is the ONLY place
 * free-run-counter code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder) lives here, behind the port
 * interface.
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT, one upsert), which is atomic on any store.
 * No multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1).
 *
 * The cap check lives in consumeFreeRun: the allowance and the
 * current count are read, and the increment is a single
 * conditional upsert (it applies only while used < allowance,
 * judged against the CURRENT stored allowance inside the
 * statement). A consume whose increment did not land — the
 * boundary race, or an allowance lowered between the read and
 * the write — reports allowed=false, so the gate never allows
 * a run it did not count, and the persisted count never
 * exceeds the allowance.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, eq, lt } from "drizzle-orm";
import { agentFreeRunAllowances, agentFreeRunCounts } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0043_FREE_RUN_COUNTER,
  MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertFreeRunAllowance,
  type FreeRunConsumption,
  type FreeRunCounter,
  type FreeRunUsageInput,
} from "./freeRunCounterPorts";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { dmlFragment } from "./schemaComponent/dmlExecutor";
import { assertPriceFamily } from "./priceCataloguePorts";
import { BusinessError } from "../outcomes/outcomeAspects";

/** Drizzle D1 database object carrying the free-run counter schema. */
export type FreeRunCounterDb = DrizzleD1Database<{
  agentFreeRunAllowances: typeof agentFreeRunAllowances;
  agentFreeRunCounts: typeof agentFreeRunCounts;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1FreeRunCounterDb(d1: D1Database): FreeRunCounterDb {
  return createDrizzleD1Db(d1, {
    schema: {
      agentFreeRunAllowances,
      agentFreeRunCounts,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migrations 0043 (tables)
 * and 0044 (allowance seed rows, INSERT OR IGNORE — re-ensure
 * is a no-op, so an operator-edited allowance is never
 * overwritten by a later ensure). The seed value lives only
 * in migration 0044's rows, never in code.
 */
export async function ensureFreeRunCounterSchema(db: FreeRunCounterDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0043_FREE_RUN_COUNTER,
    MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED,
  ]);
}

export class D1FreeRunCounterAdapter implements FreeRunCounter {
  constructor(readonly db: FreeRunCounterDb) {}

  async getAllowance(family: string): Promise<number | null> {
    const rows = await this.db
      .select()
      .from(agentFreeRunAllowances)
      .where(eq(agentFreeRunAllowances.family, family))
      .limit(1);
    const raw = rows[0]?.runs;
    // Fail-closed read (#3305, same shape as the catalogue): a
    // missing row or an invalid stored value reads as null, and
    // the gate treats null as "no allowance configured".
    if (raw === undefined || !Number.isInteger(raw) || raw < 0) return null;
    return raw;
  }

  async getUsed(input: FreeRunUsageInput): Promise<number> {
    const family = assertPriceFamily(input.family);
    const rows = await this.db
      .select()
      .from(agentFreeRunCounts)
      .where(
        and(
          eq(agentFreeRunCounts.userLogin, input.login),
          eq(agentFreeRunCounts.family, family),
          eq(agentFreeRunCounts.month, input.month),
        ),
      )
      .limit(1);
    const raw = rows[0]?.used;
    if (raw === undefined) return 0;
    if (!Number.isInteger(raw) || raw < 0) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    return raw;
  }

  async consumeFreeRun(input: FreeRunUsageInput): Promise<FreeRunConsumption> {
    const family = assertPriceFamily(input.family);
    const allowance = await this.getAllowance(family);
    if (allowance === null || allowance <= 0) {
      return { allowed: false, used: await this.getUsed({ ...input, family }), allowance };
    }
    const used = await this.getUsed({ ...input, family });
    if (used >= allowance) return { allowed: false, used, allowance };
    const now = Date.now();
    await this.db
      .insert(agentFreeRunCounts)
      .values({ userLogin: input.login, family, month: input.month, used: 1, updatedAtMs: now })
      .onConflictDoUpdate({
        target: [agentFreeRunCounts.userLogin, agentFreeRunCounts.family, agentFreeRunCounts.month],
        set: {
          used: dmlFragment(
            DML_CATALOGUE,
            "dml.d1.agent_free_run_counts.increment_used",
          ),
          updatedAtMs: now,
        },
        where: lt(
          agentFreeRunCounts.used,
          this.db
            .select({ runs: agentFreeRunAllowances.runs })
            .from(agentFreeRunAllowances)
            .where(
              eq(agentFreeRunAllowances.family, agentFreeRunCounts.family),
            ),
        ),
      });
    // Applied-check: the increment landed exactly when the
    // count grew by one. When the conditional upsert did not
    // apply (boundary race, or an allowance lowered between
    // the read and the write), the run is not counted and not
    // allowed — the gate falls through to the paid path.
    const after = await this.getUsed({ ...input, family });
    return { allowed: after === used + 1, used: after, allowance };
  }

  async setAllowance(input: { family: unknown; runs: unknown }): Promise<number> {
    const family = assertPriceFamily(input.family);
    const runs = assertFreeRunAllowance(input.runs);
    await this.db
      .insert(agentFreeRunAllowances)
      .values({ family, runs, updatedAtMs: Date.now() })
      .onConflictDoUpdate({
        target: agentFreeRunAllowances.family,
        set: { runs, updatedAtMs: Date.now() },
      });
    return runs;
  }
}
