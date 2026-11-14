/**
 * Issue #2913 (G6) — the data-layer home for delivery claims.
 *
 * The suppression DEFINITION (what a duplicate is, the key
 * shape, the claim/release discipline) lives in
 * src/workflows/screenDeliverySuppression.ts; this module
 * owns only the SQL: one row per claimed (runId,
 * destination) pair in the DO SQLite store, so a claim
 * survives an instance eviction and a resubmitted deliver
 * job is suppressed across instances. It lives here, not in
 * the workflow module, because the global D-D census
 * (tests/global_dd_census_2356.test.ts) pins storage-shaped
 * exec sites above the data layer as a shrink-only
 * allow-list — new SQL belongs in src/data/.
 *
 * Lazily ensured on first use, so wiring a context never
 * eagerly touches SQL. Check-then-act is correct under the
 * per-instance serialization the DO residency provides
 * (repositoryPorts D-0(b)); INSERT OR IGNORE additionally
 * makes a re-add a no-op instead of a throw, so a claim
 * can never fail on a key that is already present.
 */
import type { SqlStorage } from "./repositoryPorts";
import type { DeliverySuppressionStore } from "../workflows/screenDeliverySuppression";
import { remainderTableSql } from "./schemaComponent/remainderCatalogue";

/** One row per claimed (runId, destination) pair. */
export const DELIVERY_CLAIMS_TABLE = "mas_delivery_claims";

export function ensureDeliveryClaimsTable(sql: SqlStorage): void {
  sql.exec(remainderTableSql("mas_delivery_claims"));
}

/**
 * A DeliverySuppressionStore backed by the claims table. The
 * sql getter is lazy (same shape as ensureTables on the job
 * contexts), so the table is ensured only on first use.
 */
export function createSqlDeliverySuppressionStore(
  getSql: () => SqlStorage,
): DeliverySuppressionStore {
  let ensured = false;
  const sql = (): SqlStorage => {
    const s = getSql();
    if (!ensured) {
      ensureDeliveryClaimsTable(s);
      ensured = true;
    }
    return s;
  };
  return {
    has: (key) =>
      [...sql().exec(
        `SELECT key FROM ${DELIVERY_CLAIMS_TABLE} WHERE key = ?`,
        key,
      )].length > 0,
    add: (key) => {
      sql().exec(
        `INSERT OR IGNORE INTO ${DELIVERY_CLAIMS_TABLE} (key, claimed_at) VALUES (?, ?)`,
        key,
        new Date().toISOString(),
      );
    },
    delete: (key) => {
      sql().exec(`DELETE FROM ${DELIVERY_CLAIMS_TABLE} WHERE key = ?`, key);
    },
  };
}
