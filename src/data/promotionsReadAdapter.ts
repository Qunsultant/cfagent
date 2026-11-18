/**
 * Issue #5034 — Data-layer read adapter for `mas_promotions` active-check (#1257, #4412).
 */
export interface PromotionsActiveCheckSnapshot {
  inFlight: Array<Record<string, unknown>>;
  byStage: Array<Record<string, unknown>>;
}

export function readPromotionsActiveCheck(sql: any): PromotionsActiveCheckSnapshot {
  const inFlight = Array.from(
    sql.exec(
      `SELECT id, candidate_id, stage, stage_started_at, created_at
       FROM mas_promotions
       WHERE stage IN ('shadow', 'partial', 'full')
       ORDER BY created_at ASC`,
    ),
  ) as Array<Record<string, unknown>>;
  const byStage = Array.from(
    sql.exec(`SELECT stage, COUNT(*) AS count FROM mas_promotions GROUP BY stage`),
  ) as Array<Record<string, unknown>>;
  return { inFlight, byStage };
}
