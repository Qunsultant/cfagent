/**
 * D1 ResourceUsagePort adapter (issue #1819), homed in the
 * data layer by issue #2362 (#1976 step 4f).
 *
 * The table's DDL authority is migration 0022
 * (src/data/migrationRunner.ts). The adapter KEEPS its
 * ensure-on-first-use as DECLARED port behaviour: the record
 * path is best-effort measurement that must land in any
 * environment the composition root builds it in — including
 * ones where the migration runner has not run — and must
 * never couple its landing to a cross-cutting migration
 * change (the #1819 reasoning, preserved). The CREATE it
 * issues is migration 0022's DDL verbatim, so where the
 * runner has applied 0022 the ensure is a no-op; the
 * conformance suite pins the two shapes identical.
 *
 * Recording never throws: a failed insert warns and drops the
 * event rather than breaking the store op it measures (the
 * same best-effort contract as #1743's Safe sink). Totals are
 * a query path, not an op path, so they do throw on DB
 * errors — a failed comparison query must be visible, not
 * silently empty. Totals do NOT self-create (characterized).
 */
import {
  type ResourceBucketTotal,
  type ResourceUsageEvent,
  type ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";
import { d1TableSql } from "./schemaComponent/d1Catalogue";

/** Minimal D1 surface the adapter needs (structural, so fakes can stand in). */
export interface ResourceD1Db {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      run(): Promise<unknown>;
      all(): Promise<{ results: unknown[] }>;
    };
  };
}

const CREATE_TABLE_SQL = d1TableSql("resource_sql_ops");

const INSERT_SQL = `INSERT INTO resource_sql_ops
  (ts_ms, ns, op, rows_read, rows_written, caller, trigger, statement, tenant_id, run_id, session_ref)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const TOTALS_SQL = `SELECT (CAST(ts_ms / ? AS INTEGER)) AS bucket, ns, op, caller, trigger,
  COUNT(*) AS ops, SUM(rows_read) AS rows_read, SUM(rows_written) AS rows_written
  FROM resource_sql_ops WHERE ts_ms >= ? AND ts_ms < ?
  GROUP BY bucket, ns, op, caller, trigger ORDER BY bucket, ns, op, caller, trigger`;

export class D1ResourceUsageAdapter implements ResourceUsagePort {
  private ensured = false;

  constructor(private readonly db: ResourceD1Db) {}

  async record(event: ResourceUsageEvent): Promise<void> {
    try {
      if (!this.ensured) {
        await this.db.prepare(CREATE_TABLE_SQL).bind().run();
        this.ensured = true;
      }
      await this.db
        .prepare(INSERT_SQL)
        .bind(
          event.timestampMs,
          event.ns,
          event.op,
          event.rowsRead,
          event.rowsWritten,
          event.caller ?? null,
          event.trigger ?? null,
          event.statement ?? null,
          event.tenantId ?? null,
          event.runId ?? null,
          event.sessionRef ?? null
        )
        .run();
    } catch (error) {
      console.warn(
        "[resource-usage] D1 record failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async totals(fromMs: number, toMs: number, bucketMs: number): Promise<ResourceBucketTotal[]> {
    const result = await this.db.prepare(TOTALS_SQL).bind(bucketMs, fromMs, toMs).all();
    return (result.results as Array<Record<string, unknown>>).map((row) => ({
      bucketStartMs: Number(row.bucket) * bucketMs,
      ns: String(row.ns),
      op: String(row.op),
      caller: row.caller == null ? "unknown" : String(row.caller),
      trigger: row.trigger == null ? "unknown" : String(row.trigger),
      ops: Number(row.ops),
      rowsRead: Number(row.rows_read),
      rowsWritten: Number(row.rows_written),
    }));
  }
}
