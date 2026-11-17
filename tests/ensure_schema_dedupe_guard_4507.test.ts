// @vitest-environment node
/**
 * Issue #4507 — the production ensure path's silent-degrade guard
 * (dedupe-or-report decision).
 *
 * The problem: `DoSqliteCanonicalReportStore.ensureSchema` used to
 * swallow a failed `CREATE UNIQUE INDEX idx_mas_reports_generation`
 * (legacy duplicate (user_login, generation_id) pairs) — logged loudly
 * and continued without the index, so the idempotency backstop was
 * silently gone (survey §4.8; the #876 guard's degraded mode).
 *
 * The decision (recorded in plan.md before the fix): DEDUPE.
 * - The duplicates are the same logical report stored twice: a
 *   generation id is a tenant-local idempotency key, and
 *   storeReportAtGeneration writes at most one row per generation id.
 * - Surviving-row rule: per pair with both columns non-NULL, keep
 *   the row with the greatest created_at; ties break on the greatest
 *   id (deterministic total order) — the newest row, matching the
 *   #2863 read rule (duplicates resolve to the newest row).
 * - NULL pairs are never touched: SQLite UNIQUE treats NULLs as
 *   distinct, so they can never block the index.
 * - The dedupe is idempotent (a second run finds no pairs) and the
 *   CREATE is IF NOT EXISTS, so an interrupted ensure self-heals.
 * - If the CREATE still fails after dedupe + one retry, the ensure
 *   throws a named error instead of silently continuing — every seam
 *   caller fails closed on it. That throw is NOT the bare rethrow
 *   the issue rules out: it fires only after dedupe was attempted.
 *
 * This pin fails while the silent path survives: on the old code
 * every case below that expects an index (or a throw) sees no
 * index and two rows instead.
 *
 * The P4 recreate path is unchanged and stays the honesty
 * reference; the recreate planner's phased order, the schema
 * catalogues, and every other adapter's ensure path are untouched.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DoSqliteCanonicalReportStore } from "../src/data/doSqliteCanonicalReportStoreAdapter";
import type { InsertCanonicalReportRow } from "../src/data/canonicalReportStorePorts";
import { storeReportAtGeneration } from "../src/services/scheduledReports";

/** SqlStorage-shaped executor over node:sqlite (real semantics). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] & { rowsWritten?: number } {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

const INDEX = "idx_mas_reports_generation";

function generationIndexColumns(sql: SqliteTestStorage): string[] {
  return (
    sql.sqlite.prepare(`PRAGMA index_info(${INDEX})`).all() as Array<{
      seqno: number;
      name: string;
    }>
  )
    .sort((a, b) => a.seqno - b.seqno)
    .map((r) => r.name);
}

function createTable(sql: SqliteTestStorage): void {
  sql.sqlite.exec(`CREATE TABLE mas_reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    generation_id TEXT,
    user_login TEXT
  )`);
}

function insertRaw(
  sql: SqliteTestStorage,
  id: string,
  runId: string,
  createdAt: string,
  generationId: string | null,
  owner: string | null,
): void {
  sql.sqlite
    .prepare(
      `INSERT INTO mas_reports (id, run_id, title, source, summary, body, created_at, generation_id, user_login)
       VALUES (?, ?, 'T', 'screener', 's', '{}', ?, ?, ?)`
    )
    .run(id, runId, createdAt, generationId, owner);
}

function rowIds(sql: SqliteTestStorage): string[] {
  return (
    sql.sqlite.prepare(`SELECT id FROM mas_reports ORDER BY id`).all() as Array<{ id: string }>
  ).map((r) => r.id);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#4507 [pin]: ensure dedupes legacy duplicate pairs and builds the index", () => {
  it("newest row survives per pair (created_at DESC, greatest id on ties)", () => {
    const sql = new SqliteTestStorage();
    createTable(sql);
    // Three rows, one pair: newest (10:00) must survive.
    insertRaw(sql, "rep-old", "run-old", "2026-10-30T08:00:00.000Z", "gen-dup", "alice");
    insertRaw(sql, "rep-mid", "run-mid", "2026-10-30T09:00:00.000Z", "gen-dup", "alice");
    insertRaw(sql, "rep-new", "run-new", "2026-10-30T10:00:00.000Z", "gen-dup", "alice");
    // Tie pair: same created_at, greatest id wins.
    insertRaw(sql, "rep-tie-1", "run-t1", "2026-10-30T09:00:00.000Z", "gen-tie", "alice");
    insertRaw(sql, "rep-tie-2", "run-t2", "2026-10-30T09:00:00.000Z", "gen-tie", "alice");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new DoSqliteCanonicalReportStore(sql as never);
    expect(() => store.ensureSchema()).not.toThrow();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    expect(rowIds(sql).sort()).toEqual(["rep-new", "rep-tie-2"]);
    expect(store.findIdByGeneration("gen-dup", "alice")).toBe("rep-new");
    expect(store.findIdByGeneration("gen-tie", "alice")).toBe("rep-tie-2");
    const logged = errSpy.mock.calls
      .map((args) => args.map((a) => String(a)).join(" "))
      .join("\n");
    expect(logged).toContain("rep-old");
    expect(logged).toContain("rep-mid");
    expect(logged).toContain("rep-tie-1");
    // The backstop is restored: a same-tenant duplicate INSERT throws again.
    expect(() =>
      store.insertRow({
        id: "rep-again",
        runId: "run-again",
        title: "T",
        source: "screener",
        summary: "s",
        body: "{}",
        createdAt: "2026-10-30T11:00:00.000Z",
        generationId: "gen-dup",
        owner: "alice",
        bodyR2Key: null,
        fanoutOutcomeJson: "{}",
      } satisfies InsertCanonicalReportRow),
    ).toThrow();
  });

  it("NULL pairs are never touched and never block the index", () => {
    const sql = new SqliteTestStorage();
    createTable(sql);
    // Legacy rows that predate #308 (no generation id) and #584 (no
    // owner): NULL pairs can never conflict under SQLite UNIQUE.
    insertRaw(sql, "rep-nul-gen-1", "run-1", "2026-10-30T09:00:00.000Z", null, "alice");
    insertRaw(sql, "rep-nul-gen-2", "run-2", "2026-10-30T09:00:00.000Z", null, "alice");
    insertRaw(sql, "rep-nul-own-1", "run-3", "2026-10-30T09:00:00.000Z", "gen-x", null);
    insertRaw(sql, "rep-nul-own-2", "run-4", "2026-10-30T09:00:00.000Z", "gen-x", null);
    const store = new DoSqliteCanonicalReportStore(sql as never);
    expect(() => store.ensureSchema()).not.toThrow();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    expect(rowIds(sql).sort()).toEqual([
      "rep-nul-gen-1",
      "rep-nul-gen-2",
      "rep-nul-own-1",
      "rep-nul-own-2",
    ]);
  });

  it("cross-tenant same generation id: both tenants survive; only the duplicate pair is deduped", () => {
    const sql = new SqliteTestStorage();
    createTable(sql);
    insertRaw(sql, "rep-alice-1", "run-a1", "2026-10-30T09:00:00.000Z", "gen-1", "alice");
    insertRaw(sql, "rep-alice-2", "run-a2", "2026-10-30T10:00:00.000Z", "gen-1", "alice");
    insertRaw(sql, "rep-bob-1", "run-b1", "2026-10-30T09:00:00.000Z", "gen-1", "bob");
    const store = new DoSqliteCanonicalReportStore(sql as never);
    store.ensureSchema();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    expect(rowIds(sql).sort()).toEqual(["rep-alice-2", "rep-bob-1"]);
    expect(store.findIdByGeneration("gen-1", "alice")).toBe("rep-alice-2");
    expect(store.findIdByGeneration("gen-1", "bob")).toBe("rep-bob-1");
  });

  it("a second ensure is a no-op (dedupe is idempotent)", () => {
    const sql = new SqliteTestStorage();
    createTable(sql);
    insertRaw(sql, "rep-1", "run-1", "2026-10-30T09:00:00.000Z", "gen-dup", "alice");
    insertRaw(sql, "rep-2", "run-2", "2026-10-30T10:00:00.000Z", "gen-dup", "alice");
    const store = new DoSqliteCanonicalReportStore(sql as never);
    store.ensureSchema();
    const afterFirst = rowIds(sql);
    store.ensureSchema();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    expect(rowIds(sql)).toEqual(afterFirst);
    expect(afterFirst).toEqual(["rep-2"]);
  });

  it("unreconcilable schema: ensure throws a named error AFTER the dedupe already ran", () => {
    const inner = new SqliteTestStorage();
    createTable(inner);
    insertRaw(inner, "rep-1", "run-1", "2026-10-30T09:00:00.000Z", "gen-dup", "alice");
    insertRaw(inner, "rep-2", "run-2", "2026-10-30T10:00:00.000Z", "gen-dup", "alice");
    // The CREATE always fails, even after the pairs are gone.
    const refusing = {
      exec: (query: string, ...params: unknown[]) => {
        if (/CREATE UNIQUE INDEX/i.test(query) && query.includes(INDEX)) {
          throw new Error("boom: CREATE UNIQUE INDEX refused");
        }
        return inner.exec(query, ...params);
      },
      sqlite: inner.sqlite,
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new DoSqliteCanonicalReportStore(refusing as never);
    expect(() => store.ensureSchema()).toThrow(
      /unique-index creation for idx_mas_reports_generation failed after dedupe/,
    );
    // The dedupe ran before the throw: the pair is already resolved.
    expect(rowIds(inner)).toEqual(["rep-2"]);
    expect(errSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("seam green on a deduped DO: same generation dedupes to the survivor, a new generation lands", () => {
    const sql = new SqliteTestStorage();
    createTable(sql);
    insertRaw(sql, "rep-old", "run-old", "2026-10-30T09:00:00.000Z", "gen-dup", "alice");
    insertRaw(sql, "rep-new", "run-new", "2026-10-30T10:00:00.000Z", "gen-dup", "alice");
    const base = {
      runId: "run-redeliver",
      generationId: "gen-dup",
      userLogin: "alice",
      title: "Daily screen",
      source: "screener",
      summary: "10 scanned",
      body: { hello: "world" },
    };
    const deduped = storeReportAtGeneration(sql as never, base);
    expect(deduped?.created).toBe(false);
    expect(deduped?.reportId).toBe("rep-new");
    const landed = storeReportAtGeneration(sql as never, {
      ...base,
      runId: "run-fresh",
      generationId: "gen-fresh",
      title: "Fresh screen",
    });
    expect(landed?.created).toBe(true);
    expect(landed?.reportId).not.toBe("rep-new");
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    expect(rowIds(sql).sort()).toEqual(["rep-new", landed!.reportId].sort());
  });
});
