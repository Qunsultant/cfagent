/**
 * Issue #389: SQLITE_ERROR "no such column: generation_id".
 *
 * Two DDL definitions of mas_reports existed; the ORM's own
 * initializeSchema() block created the unique index on generation_id
 * WITHOUT the migration guard that src/services/scheduledReports.ts
 * ensureScheduledReportsTable() has. On any Durable Object whose
 * mas_reports was created before #308 (no generation_id column), the
 * index statement threw on every schema init.
 *
 * The fix single-sources the DDL through ensureScheduledReportsTable().
 * This test simulates a pre-#308 DO and asserts the migration is safe.
 *
 * The strict double below reproduces the real-SQLite semantics that
 * plain MockSqlStorage does not model: ALTER TABLE ADD COLUMN updates
 * the schema map, and CREATE [UNIQUE] INDEX over a missing column
 * throws SQLITE_ERROR exactly like the DO runtime.
 */
import { describe, it, expect } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

const LEGACY_MAS_REPORTS_COLS = [
  { name: "id", type: "TEXT", pk: 1 },
  { name: "run_id", type: "TEXT", pk: 0 },
  { name: "title", type: "TEXT", pk: 0 },
  { name: "source", type: "TEXT", pk: 0 },
  { name: "summary", type: "TEXT", pk: 0 },
  { name: "body", type: "TEXT", pk: 0 },
  { name: "created_at", type: "TEXT", pk: 0 },
] as Array<{ name: string; type: string; pk: number }>;

// Issue #4412: the exact #760 mas_promotions columns (catalogue entry
// schema.orm.mas_promotions.create_table in
// src/data/schemaComponent/ormCatalogue.ts). initializeSchema() creates
// this table (ensureSharedTable) immediately before its candidate index
// (ensurePromotionsIndex), so real SQLite sees the columns; the double's
// schema map must too, or its strict CREATE INDEX check throws
// "no such column: candidate_id" on every init.
const MAS_PROMOTIONS_COLS = [
  { name: "id", type: "TEXT", pk: 1 },
  { name: "candidate_id", type: "TEXT", pk: 0 },
  { name: "stage", type: "TEXT", pk: 0 },
  { name: "stage_started_at", type: "TEXT", pk: 0 },
  { name: "baseline_json", type: "TEXT", pk: 0 },
  { name: "applied_json", type: "TEXT", pk: 0 },
  { name: "last_check_json", type: "TEXT", pk: 0 },
  { name: "created_at", type: "TEXT", pk: 0 },
] as Array<{ name: string; type: string; pk: number }>;

type SchemaMap = Map<string, Array<{ name: string; type: string; pk: number }>>;

class LegacyMasReportsSql extends MockSqlStorage {
  readonly createdIndexes: Array<{
    name: string;
    unique: boolean;
    table: string;
    column: string;
    columns: string[];
  }> = [];

  constructor() {
    super();
    // Simulate a DO whose mas_reports predates #308: the table exists
    // WITH a row, but has NO generation_id column.
    const schema = (this as unknown as { schema: SchemaMap }).schema;
    schema.set(
      "mas_reports",
      LEGACY_MAS_REPORTS_COLS.map((c) => ({ ...c }))
    );
    // Issue #4412: initializeSchema() creates mas_promotions before its
    // index, so the double models it too (see MAS_PROMOTIONS_COLS).
    schema.set(
      "mas_promotions",
      MAS_PROMOTIONS_COLS.map((c) => ({ ...c }))
    );
    this.exec(
      "INSERT INTO mas_reports (id, run_id, title, source, summary, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "rep_legacy_1",
      "run-legacy",
      "Legacy report",
      "screener",
      "pre-308 summary",
      "{}",
      "2026-01-01T00:00:00.000Z"
    );
  }

  exec(query: string, ...args: unknown[]): Iterable<unknown> {
    const q = query.trim();

    // ALTER TABLE <tbl> ADD COLUMN <col> <type> — update the schema map.
    const alterMatch = q.match(
      /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)\s+(\w+)/i
    );
    if (alterMatch) {
      const schema = (this as unknown as { schema: SchemaMap }).schema;
      const cols = schema.get(alterMatch[1]);
      if (cols && !cols.some((c) => c.name === alterMatch[2])) {
        cols.push({ name: alterMatch[2], type: alterMatch[3], pk: 0 });
      }
      return [];
    }

    // CREATE [UNIQUE] INDEX <name> ON <tbl> (<col>, ...) — fail
    // like real SQLite when ANY indexed column does not exist
    // (issue #389). ADAPTED for #2398 (§7): the generation index
    // is composite now — (user_login, generation_id) — so the
    // double parses the full column list instead of only the
    // first token, exactly as real SQLite does; the recorded
    // entry carries every column.
    const idxMatch = q.match(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([\w\s,]+)\)/i
    );
    if (idxMatch) {
      const schema = (this as unknown as { schema: SchemaMap }).schema;
      const cols = schema.get(idxMatch[3]) || [];
      const columns = idxMatch[4]
        .split(",")
        .map((s) => s.trim().split(/\s+/)[0])
        .filter(Boolean);
      for (const col of columns) {
        if (!cols.some((c) => c.name === col)) {
          throw new Error(`no such column: ${col} at offset 0: SQLITE_ERROR`);
        }
      }
      if (!this.createdIndexes.some((i) => i.name === idxMatch[2])) {
        this.createdIndexes.push({
          name: idxMatch[2],
          unique: !!idxMatch[1],
          table: idxMatch[3],
          column: columns[0],
          columns,
        });
      }
      return [];
    }

    return super.exec(query, ...args);
  }
}

describe("mas_reports migration (issue #389)", () => {
  it("initializeSchema does not throw on a pre-#308 table and adds generation_id + unique index, preserving rows", () => {
    const sql = new LegacyMasReportsSql();
    const orm = new DatabaseORM(sql);

    // This threw SQLITE_ERROR before the fix (the ORM's duplicate DDL
    // created the unique index with no column guard).
    expect(() => orm.initializeSchema("legacy_do_session")).not.toThrow();

    const cols = Array.from(
      sql.exec("PRAGMA table_info(mas_reports)")
    ) as Array<{ name?: unknown }>;
    expect(cols.map((c) => String(c?.name))).toContain("generation_id");

    const uniqueIdx = sql.createdIndexes.find(
      (i) => i.name === "idx_mas_reports_generation"
    );
    expect(uniqueIdx).toBeDefined();
    expect(uniqueIdx?.unique).toBe(true);
    // Issue #2398: the index is tenant-scoped — its columns are
    // the (user_login, generation_id) pair, not generation_id
    // alone (the pre-#2398 global shape this assertion pinned).
    expect(uniqueIdx?.columns).toEqual(["user_login", "generation_id"]);

    // Pre-existing row survives the migration.
    const legacy = orm.reports.findById("rep_legacy_1");
    expect(legacy).toBeDefined();
    expect(legacy?.title).toBe("Legacy report");
  });

  it("initializeSchema is idempotent on the migrated table (second init does not throw)", () => {
    const sql = new LegacyMasReportsSql();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("legacy_do_session");
    expect(() => orm.initializeSchema("legacy_do_session")).not.toThrow();
  });

  it("storeCanonicalReport works through the migrated table, idempotent on generation id", () => {
    const sql = new LegacyMasReportsSql();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("legacy_do_session");

    const first = orm.storeCanonicalReport({
      runId: "run-new",
      generationId: "gen-1",
      title: "New report",
      source: "screener",
      summary: "after migration",
      body: { key: "value" },
      userLogin: "tenant@example.com",
    });
    expect(first).not.toBeNull();
    expect(first?.created).toBe(true);

    const second = orm.storeCanonicalReport({
      runId: "run-new",
      generationId: "gen-1",
      title: "New report",
      source: "screener",
      summary: "after migration",
      body: { key: "value" },
      userLogin: "tenant@example.com",
    });
    expect(second).not.toBeNull();
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);
  });
});
