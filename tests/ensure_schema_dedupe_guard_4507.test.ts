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
 *
 * Issue #6101 (step 8): the seam test at the end moved to D1 —
 * the DO dedupe (which deleted the older row) has no D1
 * equivalent; D1 dedupe is a newest-wins lookup, the older row
 * stays. The five adapter pins above are unchanged (the DO
 * adapter still exists for the frozen table).
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
    // #3515 S3 batch 7: the dedupe log is now a structured event
    // (doSqliteCanonicalReportStore.deduped_generation_index_pair) on
    // the console-info JSON fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const store = new DoSqliteCanonicalReportStore(sql as never);
    expect(() => store.ensureSchema()).not.toThrow();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    expect(rowIds(sql).sort()).toEqual(["rep-new", "rep-tie-2"]);
    expect(store.findIdByGeneration("gen-dup", "alice")).toBe("rep-new");
    expect(store.findIdByGeneration("gen-tie", "alice")).toBe("rep-tie-2");
    const deduped = infoSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0]));
        } catch {
          return null;
        }
      })
      .filter(
        (e) =>
          e !== null &&
          e.operation ===
            "doSqliteCanonicalReportStore.deduped_generation_index_pair",
      );
    expect(deduped).toHaveLength(2);
    expect(deduped[0].level).toBe("error");
    const removed = deduped.flatMap((e) => e.fields?.removed ?? []);
    expect(removed).toContain("rep-old");
    expect(removed).toContain("rep-mid");
    expect(removed).toContain("rep-tie-1");
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
    // #3515 S3 batch 7: the index-creation failure is now a structured
    // event on the console-info JSON fallback, not a console.error line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const store = new DoSqliteCanonicalReportStore(refusing as never);
    expect(() => store.ensureSchema()).toThrow(
      /unique-index creation for idx_mas_reports_generation failed after dedupe/,
    );
    // The dedupe ran before the throw: the pair is already resolved.
    expect(rowIds(inner)).toEqual(["rep-2"]);
    const failed = infoSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0]));
        } catch {
          return null;
        }
      })
      .filter(
        (e) =>
          e !== null &&
          e.operation ===
            "doSqliteCanonicalReportStore.unique_index_creation_failed",
      );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].level).toBe("error");
  });

  it("seam green on D1 with duplicate generations: same generation dedupes to the newest, a new generation lands", async () => {
    // #6101 step 8: the seam writes D1 now — the DO dedupe above
    // (which DELETED the older row) has no D1 equivalent. D1 dedupe
    // is a lookup: latestReportByGeneration returns the newest row
    // for the generation and the redelivery adopts it (created:false);
    // the older row stays as its own report (nothing deletes it).
    const { MockD1Database } = await import("./mock-d1");
    const { createD1AuditReportDb, D1AuditReportAdapter, ensureAuditReportSchema } =
      await import("../src/data/d1AuditReportAdapter");
    const mock = new MockD1Database();
    const db = createD1AuditReportDb(mock as unknown as any);
    await ensureAuditReportSchema(db);
    const adapter = new D1AuditReportAdapter(db);
    const tenant = "primary";
    const base = {
      tenantId: tenant,
      workspaceId: tenant,
      runId: "run-seed",
      title: "Daily screen",
      source: "screener",
      summary: "10 scanned",
      body: "{}",
      createdAtMs: Date.parse("2026-10-30T09:00:00.000Z"),
      updatedAtMs: Date.parse("2026-10-30T09:00:00.000Z"),
      version: 1,
      provenanceWriter: "test",
      provenanceSourceDo: "Orchestrator",
      provenanceSourceVersion: "1",
      linkedJobRunId: null,
      userLogin: "alice",
      bodyR2Key: null,
    };
    await adapter.recordReport({ ...base, reportId: "rep-old", generationId: "gen-dup" });
    await adapter.recordReport({
      ...base,
      reportId: "rep-new",
      generationId: "gen-dup",
      createdAtMs: Date.parse("2026-10-30T10:00:00.000Z"),
      updatedAtMs: Date.parse("2026-10-30T10:00:00.000Z"),
    });
    const env = { AGENT_DB: mock as unknown as any };
    const deduped = await storeReportAtGeneration(
      {
        runId: "run-redeliver",
        generationId: "gen-dup",
        userLogin: "alice",
        title: "Daily screen",
        source: "screener",
        summary: "10 scanned",
        body: { hello: "world" },
      },
      env,
    );
    expect(deduped?.created).toBe(false);
    expect(deduped?.reportId).toBe("rep-new");
    const landed = await storeReportAtGeneration(
      {
        runId: "run-fresh",
        generationId: "gen-fresh",
        userLogin: "alice",
        title: "Fresh screen",
        source: "screener",
        summary: "10 scanned",
        body: { hello: "world" },
      },
      env,
    );
    expect(landed?.created).toBe(true);
    expect(landed?.reportId).not.toBe("rep-new");
    const ids = (await adapter.listReports(tenant, { limit: 100 })).map((r) => r.reportId);
    expect(ids).toContain("rep-new");
    expect(ids).toContain(landed!.reportId);
  });
});
