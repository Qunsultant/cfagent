// @vitest-environment node
/**
 * Issue #4204 ([Out-of-Scope] of #3124, sub-issue of #3121) — the D1
 * residency of `job_run_records` gets the recent-read index the
 * #3124 evaluation scan needs.
 *
 * The DO-SQLite half already has it (#3124, `jobRunRecordIndexSchema.ts`:
 * `job_run_records_recent_idx` on `(started DESC, id DESC)`); the D1
 * half (migration 0047, `src/data/d1JobRunRecordAdapter.ts`) has only
 * the `(job_id, started DESC, id DESC)` index, so `listRecent` walks
 * the whole D1 table and sorts it on every call. #3124 indexed only
 * the DO-SQLite halves because the D1 index needs a NEW migration —
 * never an edit to 0047.
 *
 * Numbering: migration 0073. (The 2026-11-12 WIP snapshot used 0062;
 * main has since taken 0062–0072 — 0062 is
 * `MIGRATION_0062_OFFER_SUPPRESSIONS_RANK`, latest is 0072 — so the
 * new migration is 0073. Its statement text lives in the D1
 * catalogue (`src/data/schemaComponent/d1Catalogue.ts`, #4282 P1
 * delegation) and the const assembles it via `d1MigrationSql(73)`.)
 *
 * - 4204-M1 registration: migration 0073 is registered, versioned,
 *   and carries the index DDL.
 * - 4204-M2 0047 untouched: migration 0047 still has no recent
 *   index (the no-edit rule, pinned).
 * - 4204-D1 ensure lands the index: `ensureJobRunRecordsSchema`
 *   applies 0047 + 0072 + 0073, idempotently.
 * - 4204-P1 EXPLAIN QUERY PLAN (#2280 / #3124 pattern): the exact
 *   recent-read query walks `job_run_records_recent_idx`, no temp
 *   b-tree.
 * - 4204-P2 two-residency parity: the D1 migration's single
 *   statement is the DO half's index SQL — one index, two
 *   residencies.
 * - 4204-B1 behavior: `listRecent` still returns newest-first
 *   through the D1 store.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import {
  ALL_MIGRATIONS,
  MIGRATION_0047_JOB_RUN_RECORDS,
  MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
} from "../src/data/migrationRunner";
import {
  JOB_RUN_RECORD_INDEXES,
  JOB_RUN_RECORDS_RECENT_SQL,
} from "../src/data/jobRunRecordIndexSchema";
import { buildJobRunRecord } from "../src/services/jobRunRecords";

/** Minimal D1Database stand-in over node:sqlite (the foundation tests' double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

/** EXPLAIN QUERY PLAN detail lines for a statement, joined (the #3124-P06 shape). */
function plan(db: DatabaseSync, sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join("\n");
}

/** The migration SQL's single statement, shape wrapper stripped. */
function singleStatement(sql: string): string {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(";");
}

describe("4204 migration 0073 — D1 job_run_records recent-read index", () => {
  it("4204-M1 is registered, versioned 73, and carries the index DDL", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX);
    expect(MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX.version).toBe(73);
    expect(MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX.name).toBe(
      "0073_job_run_records_recent_idx",
    );
    expect(MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX.sql).toContain(
      "CREATE INDEX IF NOT EXISTS job_run_records_recent_idx ON job_run_records (started DESC, id DESC)",
    );
  });

  it("4204-M2 migration 0047 is untouched — no recent index in its DDL", () => {
    expect(MIGRATION_0047_JOB_RUN_RECORDS.sql).not.toContain(
      "job_run_records_recent_idx",
    );
    expect(MIGRATION_0047_JOB_RUN_RECORDS.sql).toContain(
      "job_run_records_job_idx",
    );
  });

  it("4204-D1 ensure applies 0047 + 0072 + 0073 (and #5887's 0076, and #6099's 0081) and lands the index, idempotently", async () => {
    const mock = new MockD1Database();
    const db = createD1JobRunRecordDb(mock as any);
    const applied = await ensureJobRunRecordsSchema(db);
    // Issue #5887 adds 0076 (the definition-version stamp) to the same store.
    // Issue #6099 adds 0081 (tenant_id + projected_at_ms + the unique
    // identity index) to the same store.
    expect(applied).toEqual([47, 72, 73, 76, 81]);
    const indexes = mock.sqlite
      .prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'job_run_records'",
      )
      .all() as Array<{ name: string; tbl_name: string; sql: string }>;
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "job_run_records_identity_idx",
      "job_run_records_job_idx",
      "job_run_records_recent_idx",
    ]);
    const recent = indexes.find((i) => i.name === "job_run_records_recent_idx");
    expect(recent?.sql).toContain("(started DESC, id DESC)");
    // Second ensure: nothing left to apply.
    expect(await ensureJobRunRecordsSchema(db)).toEqual([]);
  });

  it("4204-P1 the exact recent-read query walks the recent index, not the table", async () => {
    const mock = new MockD1Database();
    const db = createD1JobRunRecordDb(mock as any);
    const store = new D1JobRunRecordStore(db);
    for (let i = 0; i < 50; i++) {
      const started = new Date(Date.now() - i * 60_000).toISOString();
      await store.record(
        buildJobRunRecord({
          system: "job-pipeline",
          jobId: `job-${i % 10}`,
          operation: "feed",
          started,
          finished: started,
          outcome: "success",
          triggeredBy: "manual",
        }),
      );
    }
    // The exact query both residencies share (DO helper constant).
    const p = plan(mock.sqlite, JOB_RUN_RECORDS_RECENT_SQL, 50);
    // Same index-walk shape as #3124-P06: "SCAN ... USING INDEX" in
    // started order, LIMIT stops the walk at 50 rows, no temp
    // b-tree. Before #4204: "SCAN job_run_records | USE TEMP
    // B-TREE FOR ORDER BY" — the whole table, sorted, per call.
    expect(p).toContain("USING INDEX job_run_records_recent_idx");
    expect(p).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("4204-P2 the D1 migration's index SQL is the DO half's index SQL", () => {
    const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();
    expect(JOB_RUN_RECORD_INDEXES).toHaveLength(1);
    // The runner SQL wraps the one statement in the catalogue shape
    // (leading newline, trailing semicolon); the statement itself
    // must be the DO half's statement, verbatim after normalization.
    const statements = MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX.sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(1);
    expect(normalize(statements[0])).toBe(normalize(JOB_RUN_RECORD_INDEXES[0].sql));
    expect(normalize(singleStatement(MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX.sql))).toBe(
      normalize(JOB_RUN_RECORD_INDEXES[0].sql),
    );
  });

  it("4204-B1 listRecent still returns newest-first through the D1 store", async () => {
    const mock = new MockD1Database();
    const db = createD1JobRunRecordDb(mock as any);
    const store = new D1JobRunRecordStore(db);
    for (const started of [
      "2026-11-12T09:00:00.000Z",
      "2026-11-12T09:02:00.000Z",
      "2026-11-12T09:01:00.000Z",
    ]) {
      await store.record(
        buildJobRunRecord({
          system: "job-pipeline",
          jobId: "job-a",
          operation: "feed",
          started,
          finished: started,
          outcome: "success",
          triggeredBy: "manual",
        }),
      );
    }
    const recent = await store.listRecent(2);
    expect(recent.map((r) => r.started)).toEqual([
      "2026-11-12T09:02:00.000Z",
      "2026-11-12T09:01:00.000Z",
    ]);
  });
});
