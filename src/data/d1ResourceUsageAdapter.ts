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
 *
 * #4282 P6a (#4384): the insert + totals read are catalogue
 * entries (dml.d1.resource_sql_ops.insert / .read_totals),
 * executed through the DML executor. The CREATE stays the DDL
 * catalogue's text, issued via db.run(sql.raw(...)).
 */
import { sql } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import {
  type ResourceBucketTotal,
  type ResourceUsageEvent,
  type ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";
import {
  resourceAlertState,
  resourceComparisonReports,
  resourceDailyRollups,
  resourceSqlOps,
} from "./drizzleSchema";
import { d1TableSql } from "./schemaComponent/d1Catalogue";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDml } from "./schemaComponent/dmlExecutor";

import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

/** Drizzle D1 database object carrying the resource schemas. */
export type ResourceD1Db = DrizzleD1Database<{
  resourceSqlOps: typeof resourceSqlOps;
  resourceDailyRollups: typeof resourceDailyRollups;
  resourceAlertState: typeof resourceAlertState;
  resourceComparisonReports: typeof resourceComparisonReports;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ResourceDb(d1: D1Database): ResourceD1Db {
  return createDrizzleD1Db(d1, {
    schema: {
      resourceSqlOps,
      resourceDailyRollups,
      resourceAlertState,
      resourceComparisonReports,
    },
  });
}

const CREATE_TABLE_SQL = d1TableSql("resource_sql_ops");

export class D1ResourceUsageAdapter implements ResourceUsagePort {
  private ensured = false;
  // #3515 S3 batch 7 — optional sink injection (d1QueryLogger precedent);
  // env-constructed sink from the composition root when it holds env,
  // else the structured console fallback (never a `{}` sink, #5587).
  private readonly log: StructuredLogger;
  constructor(
    private readonly db: ResourceD1Db,
    options?: { sink?: ObservabilitySink },
  ) {
    this.log = createStructuredLogger(
      options?.sink ?? new ConsoleObservabilitySink(),
      { component: "data/d1ResourceUsageAdapter" },
    );
  }

  async record(event: ResourceUsageEvent): Promise<void> {
    try {
      if (!this.ensured) {
        await this.db.run(sql.raw(CREATE_TABLE_SQL));
        this.ensured = true;
      }
      await executeDml(DML_CATALOGUE, this.db, "dml.d1.resource_sql_ops.insert", {
        values: {
          tsMs: event.timestampMs,
          ns: event.ns,
          op: event.op,
          rowsRead: event.rowsRead,
          rowsWritten: event.rowsWritten,
          caller: event.caller ?? null,
          trigger: event.trigger ?? null,
          statement: event.statement ?? null,
          tenantId: event.tenantId ?? null,
          runId: event.runId ?? null,
          sessionRef: event.sessionRef ?? null,
        },
      });
    } catch (error) {
      this.log.warn("d1ResourceUsageAdapter.d1_record_failed", {
        message: "[resource-usage] D1 record failed:",
        error: error instanceof Error ? error.message : String(error),
        op: event.op,
        ns: event.ns,
      });
    }
  }

  async totals(fromMs: number, toMs: number, bucketMs: number): Promise<ResourceBucketTotal[]> {
    const rows = (await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.resource_sql_ops.read_totals",
      { bucketMs, fromMs, toMs },
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
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
