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
 *
 * #4282 P6a (#4384): the reads + upserts are catalogue
 * entries (dml.d1.resource_daily_rollups.*,
 * dml.d1.resource_alert_state.*,
 * dml.d1.resource_comparison_reports.*), executed through the
 * DML executor. INSERT OR REPLACE becomes
 * insert().onConflictDoUpdate() setting every column (row
 * content identical). The CREATEs stay the DDL catalogue's
 * text, issued via db.run(sql.raw(...)).
 */
import { sql } from "drizzle-orm";
import type { ResourceD1Db } from "./d1ResourceUsageAdapter";
import type { AlertState, ResourceRollupStorePort } from "./resourceRollupPorts";
import type { DailyRollupRow } from "../telemetry/resourceRollup";
import { d1TableSql } from "./schemaComponent/d1Catalogue";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDml } from "./schemaComponent/dmlExecutor";

export type { ResourceD1Db };

const CREATE_TABLES_SQL = [
  d1TableSql("resource_daily_rollups"),
  d1TableSql("resource_alert_state"),
  d1TableSql("resource_comparison_reports"),
];

export class D1ResourceRollupStore implements ResourceRollupStorePort {
  constructor(private readonly db: ResourceD1Db) {}

  async ensureSchema(): Promise<void> {
    for (const createSql of CREATE_TABLES_SQL) {
      await this.db.run(sql.raw(createSql));
    }
  }

  async writeDailyRollup(day: string, rows: readonly DailyRollupRow[]): Promise<void> {
    for (const row of rows) {
      await executeDml(DML_CATALOGUE, this.db, "dml.d1.resource_daily_rollups.upsert", {
        values: {
          day: row.day,
          ns: row.ns,
          op: row.op,
          caller: row.caller,
          trigger: row.trigger,
          ops: row.ops,
          rowsRead: row.rowsRead,
          rowsWritten: row.rowsWritten,
        },
      });
    }
  }

  async readDailyRollup(day: string): Promise<DailyRollupRow[]> {
    const rows = (await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.resource_daily_rollups.read_day",
      { day },
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
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
    const rows = (await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.resource_daily_rollups.latest_day",
      {},
    )) as Array<{ day?: unknown }>;
    const day = rows[0]?.day;
    return typeof day === "string" ? day : null;
  }

  async getAlertState(budget: string, day: string): Promise<AlertState | null> {
    const rows = (await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.resource_alert_state.read",
      { budget, day },
    )) as Array<Record<string, unknown>>;
    const row = rows[0];
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
    await executeDml(DML_CATALOGUE, this.db, "dml.d1.resource_alert_state.upsert", {
      values: {
        budget,
        day,
        alertedAt: Date.now(),
        delivered: delivered ? 1 : 0,
        note,
      },
    });
  }

  async writeComparisonReport(day: string, report: unknown): Promise<void> {
    await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.resource_comparison_reports.upsert",
      {
        values: {
          day,
          generatedAt: Date.now(),
          reportJson: JSON.stringify(report),
        },
      },
    );
  }

  async readComparisonReport(day: string): Promise<unknown | null> {
    const rows = (await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.resource_comparison_reports.read",
      { day },
    )) as Array<{ report_json?: unknown }>;
    const row = rows[0];
    if (!row || typeof row.report_json !== "string") return null;
    return JSON.parse(row.report_json) as unknown;
  }
}
