/**
 * Issue #2903 — Data-layer SQLite adapter for `mas_recommendation_snapshots`.
 * Keeps all `sql.exec` calls inside `src/data/` per the global D-D census (#2356).
 */
import type { SqlStorage } from "../orm";

export function ensureRecommendationSnapshotsTableAdapter(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS mas_recommendation_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      user_login TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      recommendation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      symbols_json TEXT NOT NULL,
      thesis TEXT,
      captured_at_utc TEXT NOT NULL,
      data_as_of TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_mas_rec_snapshots_owner
    ON mas_recommendation_snapshots (tenant_id, user_login, captured_at_utc DESC)
  `);
}

export function insertRecommendationSnapshotIfAbsent(
  sql: SqlStorage,
  row: {
    snapshotId: string;
    runId: string;
    userLogin: string;
    tenantId: string;
    recommendationId: string;
    kind: string;
    symbolsJson: string;
    thesis: string | null;
    capturedAtUtc: string;
    dataAsOf: string;
    payloadJson: string;
  },
): boolean {
  ensureRecommendationSnapshotsTableAdapter(sql);
  const existing = Array.from(
    sql.exec(
      `SELECT snapshot_id FROM mas_recommendation_snapshots WHERE snapshot_id = ? LIMIT 1`,
      row.snapshotId,
    ),
  );
  if (existing.length > 0) return false;
  sql.exec(
    `INSERT INTO mas_recommendation_snapshots
      (snapshot_id, run_id, user_login, tenant_id, recommendation_id, kind, symbols_json, thesis, captured_at_utc, data_as_of, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.snapshotId,
    row.runId,
    row.userLogin,
    row.tenantId,
    row.recommendationId,
    row.kind,
    row.symbolsJson,
    row.thesis,
    row.capturedAtUtc,
    row.dataAsOf,
    row.payloadJson,
  );
  return true;
}

export function selectRecommendationSnapshotPayload(
  sql: SqlStorage,
  tenantId: string,
  userLogin: string,
  snapshotId: string,
): string | null {
  ensureRecommendationSnapshotsTableAdapter(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT payload_json FROM mas_recommendation_snapshots
       WHERE tenant_id = ? AND user_login = ? AND snapshot_id = ? LIMIT 1`,
      tenantId,
      userLogin,
      snapshotId,
    ),
  ) as Array<Record<string, unknown>>;
  return typeof rows[0]?.payload_json === "string" ? rows[0].payload_json : null;
}

export function listRecommendationSnapshotPayloads(
  sql: SqlStorage,
  tenantId: string,
  userLogin: string,
  limit: number,
): string[] {
  ensureRecommendationSnapshotsTableAdapter(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT payload_json FROM mas_recommendation_snapshots
       WHERE tenant_id = ? AND user_login = ?
       ORDER BY captured_at_utc DESC LIMIT ?`,
      tenantId,
      userLogin,
      limit,
    ),
  ) as Array<Record<string, unknown>>;
  return rows
    .map((r) => r.payload_json)
    .filter((p): p is string => typeof p === "string");
}
