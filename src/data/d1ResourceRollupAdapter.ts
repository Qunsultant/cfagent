/**
 * Issue #2362 (#1976 step 4f) — the D1 adapter for the
 * resource rollup store port.
 *
 * The statements are the legacy module's, verbatim
 * (src/telemetry/resourceRollupStore.ts before this slice;
 * the module is now a delegate over this adapter). The
 * CREATE statements are migration 0022's DDL, so
 * `ensureSchema()` is a no-op where the runner has applied
 * 0022; the conformance suite pins the shapes identical.
 *
 * - resource_daily_rollups: one row per (day, ns, op,
 *   caller, trigger), written by the daily rollup goal,
 *   replaced idempotently on re-run (INSERT OR REPLACE), so
 *   a forced re-evaluation reproduces the scheduled run
 *   exactly.
 * - resource_alert_state: one row per (budget, day), written
 *   when a breach is first delivered (or first found
 *   undeliverable). This is the alert dedup: the hourly goal
 *   never stamps lastRun (isDue's 23h guard would otherwise
 *   suppress hourly evaluation), so dedup lives here, not in
 *   goal state.
 * - resource_comparison_reports: one row per day, the
 *   comparison report JSON for the latest completed rollup
 *   day.
 */
import type { ResourceD1Db } from "./d1ResourceUsageAdapter";
import type { AlertState, ResourceRollupStorePort } from "./resourceRollupPorts";
import type { DailyRollupRow } from "../telemetry/resourceRollup";
import { d1TableSql } from "./schemaComponent/d1Catalogue";

export type { ResourceD1Db };

const CREATE_TABLES_SQL = [
  d1TableSql("resource_daily_rollups"),
  d1TableSql("resource_alert_state"),
  d1TableSql("resource_comparison_reports"),
];

export class D1ResourceRollupStore implements ResourceRollupStorePort {
  constructor(private readonly db: ResourceD1Db) {}

  async ensureSchema(): Promise<void> {
    for (const sql of CREATE_TABLES_SQL) {
      await this.db.prepare(sql).bind().run();
    }
  }

  async writeDailyRollup(day: string, rows: readonly DailyRollupRow[]): Promise<void> {
    for (const row of rows) {
      await this.db
        .prepare(
          `INSERT OR REPLACE INTO resource_daily_rollups
         (day, ns, op, caller, trigger, ops, rows_read, rows_written)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(row.day, row.ns, row.op, row.caller, row.trigger, row.ops, row.rowsRead, row.rowsWritten)
        .run();
    }
  }

  async readDailyRollup(day: string): Promise<DailyRollupRow[]> {
    const result = await this.db
      .prepare(
        `SELECT day, ns, op, caller, trigger, ops, rows_read, rows_written
       FROM resource_daily_rollups WHERE day = ? ORDER BY ns, op, caller, trigger`
      )
      .bind(day)
      .all();
    return (result.results as Array<Record<string, unknown>>).map((r) => ({
      day: String(r.day),
      ns: String(r.ns),
      op: String(r.op),
      caller: String(r.caller),
      trigger: String(r.trigger),
      ops: Number(r.ops),
      rowsRead: Number(r.rows_read),
      rowsWritten: Number(r.rows_written),
    }));
  }

  /** Latest day with any rollup row, or null before the first rollup lands. */
  async latestCompletedRollupDay(): Promise<string | null> {
    const result = await this.db
      .prepare(`SELECT MAX(day) AS day FROM resource_daily_rollups`)
      .bind()
      .all();
    const day = (result.results[0] as { day?: unknown } | undefined)?.day;
    return typeof day === "string" ? day : null;
  }

  async getAlertState(budget: string, day: string): Promise<AlertState | null> {
    const result = await this.db
      .prepare(
        `SELECT budget, day, alerted_at, delivered, note FROM resource_alert_state
       WHERE budget = ? AND day = ?`
      )
      .bind(budget, day)
      .all();
    const row = result.results[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      budget: String(row.budget),
      day: String(row.day),
      alerted_at: Number(row.alerted_at),
      delivered: Number(row.delivered),
      note: row.note == null ? null : String(row.note),
    };
  }

  async markAlerted(
    budget: string,
    day: string,
    delivered: boolean,
    note: string | null
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO resource_alert_state
       (budget, day, alerted_at, delivered, note) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(budget, day, Date.now(), delivered ? 1 : 0, note)
      .run();
  }

  async writeComparisonReport(day: string, report: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO resource_comparison_reports
       (day, generated_at, report_json) VALUES (?, ?, ?)`
      )
      .bind(day, Date.now(), JSON.stringify(report))
      .run();
  }

  async readComparisonReport(day: string): Promise<unknown | null> {
    const result = await this.db
      .prepare(`SELECT report_json FROM resource_comparison_reports WHERE day = ?`)
      .bind(day)
      .all();
    const row = result.results[0] as { report_json?: unknown } | undefined;
    if (!row || typeof row.report_json !== "string") return null;
    return JSON.parse(row.report_json) as unknown;
  }
}
