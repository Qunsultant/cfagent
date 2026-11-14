/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the usage-event port: the usage_events statements from
 * src/services/scheduledReports.ts (ensure, insert, per-
 * tenant list), moved into the data layer
 * statement-for-statement. usage_events is the accepted
 * metering store of record (#792 determination recorded in
 * the seam module); it stays in whichever instance's seam
 * records the event.
 */
import type {
  CanonicalReportStoreSqlExecutor,
  InsertUsageEventRow,
  UsageEventPort,
  UsageEventRow,
} from "./canonicalReportStorePorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

const TABLE = "usage_events";

export class DoSqliteUsageEventStore implements UsageEventPort {
  constructor(private readonly sql: CanonicalReportStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(doTableSql("usage_events"));
    this.sql.exec(
      doIndexSql("idx_usage_events_user")
    );
  }

  insertEvent(row: InsertUsageEventRow): void {
    this.sql.exec(
      `INSERT INTO ${TABLE} (id, user_login, run_id, category, created_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      row.userLogin,
      row.runId,
      row.category,
      row.createdAt,
      row.detailJson
    );
  }

  listByUser(userLogin: string, limit: number): UsageEventRow[] {
    const rows = Array.from(
      this.sql.exec(
        `SELECT id, user_login, run_id, category, created_at FROM ${TABLE} WHERE user_login = ? ORDER BY created_at DESC LIMIT ?`,
        userLogin,
        limit
      )
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      userLogin: String(r.user_login ?? ""),
      runId: String(r.run_id ?? ""),
      category: String(r.category ?? ""),
      createdAt: String(r.created_at ?? ""),
    }));
  }
}
