/**
 * Issue #2869 (G8) — the data-layer home for stage claims.
 *
 * The claim DEFINITION (what a duplicate is, the key shape,
 * the claim/release discipline) lives in
 * src/workflows/stageReportConsumer.ts; this module owns
 * only the SQL: one row per claimed (runId, stageId) pair
 * in the DO SQLite store, so a claim survives an instance
 * eviction and a redelivered stage message is suppressed
 * across instances. It lives here, not in the workflow
 * module, because the global D-D census
 * (tests/global_dd_census_2356.test.ts) pins
 * storage-shaped exec sites above the data layer as a
 * shrink-only allow-list — new SQL belongs in src/data/
 * (the same move G6 made for delivery claims).
 *
 * Unlike delivery claims, a stage claim is NEVER released
 * on success: exactly-once EFFECT means a generated stage
 * output is never regenerated. It IS released when
 * generation itself throws (see the consumer): a failed
 * generation has no effect to deduplicate, so a retry —
 * including #1278 regeneration of a run whose PDF failed
 * — must be allowed to generate.
 *
 * Lazily ensured on first use, so wiring a context never
 * eagerly touches SQL. Check-then-act is correct under
 * the per-instance serialization the DO residency
 * provides (repositoryPorts D-0(b)); INSERT OR IGNORE
 * additionally makes a re-add a no-op instead of a throw.
 */
import type { SqlStorage } from "./repositoryPorts";
import type { StageClaimStore } from "../workflows/stageReportConsumer";
import { remainderTableSql } from "./schemaComponent/remainderCatalogue";

/** One row per claimed (runId, stageId) pair. */
export const STAGE_CLAIMS_TABLE = "mas_stage_claims";

export function ensureStageClaimsTable(sql: SqlStorage): void {
  sql.exec(remainderTableSql("mas_stage_claims"));
}

/**
 * A StageClaimStore backed by the claims table. The sql
 * getter is lazy (same shape as ensureTables on the job
 * contexts), so the table is ensured only on first use.
 */
export function createSqlStageClaimStore(
  getSql: () => SqlStorage,
): StageClaimStore {
  let ensured = false;
  const sql = (): SqlStorage => {
    const s = getSql();
    if (!ensured) {
      ensureStageClaimsTable(s);
      ensured = true;
    }
    return s;
  };
  return {
    has: (key) =>
      [...sql().exec(
        `SELECT key FROM ${STAGE_CLAIMS_TABLE} WHERE key = ?`,
        key,
      )].length > 0,
    add: (key) => {
      sql().exec(
        `INSERT OR IGNORE INTO ${STAGE_CLAIMS_TABLE} (key, claimed_at) VALUES (?, ?)`,
        key,
        new Date().toISOString(),
      );
    },
    delete: (key) => {
      sql().exec(
        `DELETE FROM ${STAGE_CLAIMS_TABLE} WHERE key = ?`,
        key,
      );
    },
  };
}
