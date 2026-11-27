// @vitest-environment node
/**
 * Issue #2398 — the mas_reports generation UNIQUE index is
 * tenant-scoped: UNIQUE (user_login, generation_id), matching
 * the canonical-report seam's dedupe lookup, which was always
 * scoped on that pair.
 *
 * The bug (pinned as-found by #2359, inverted there and here):
 * the index was GLOBAL on (generation_id), so a second tenant
 * storing a report whose generation id another tenant had
 * already used missed the tenant-scoped dedupe, threw on the
 * INSERT, and the seam returned null (REPORT_FANOUT_FAILED)
 * with no row landed — a legitimate report silently lost.
 *
 * This file pins:
 *  - the index's shape on a FRESH instance (tenant-scoped);
 *  - the ensureSchema shape reconciliation over the three
 *    existing-instance shapes: (a) fresh, (b) carrying the
 *    pre-#2398 global index (swap; rows untouched), (c)
 *    already carrying the tenant-scoped index (no-op);
 *  - the #4507 dedupe guard: a degraded table holding
 *    same-tenant duplicate pairs gets deduped (newest row
 *    survives per pair, the #2863 read rule) and the index
 *    built — never a silent degradation, never a thrown
 *    ensure for the duplicate case; an unreconcilable schema
 *    throws a named error instead.
 *  - the seam end-to-end over D1 (#6101 step 8): both tenants'
 *    reports land, retrievable by their owners. The pre-#2398
 *    DO-instance premise is gone — DO rows are not visible to
 *    the D1 seam (replacement ruling: history restarts at
 *    cutover) — so the seam pins land on D1 rows, and the
 *    recorded fan-out outcome is null on every D1 read (the
 *    #2347 recorded-outcome contract ends with the DO row;
 *    the store result still carries the outcome).
 *
 * Port-level conformance over BOTH adapters (insert-or-throw
 * within a tenant, land across tenants) lives in the inverted
 * pin in orchestrator_tables_step4d_conformance_2359.test.ts;
 * the seam-level dedupe inversion lives in
 * orchestrator_tables_step4d_characterization_2359.test.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockD1Database } from "./mock-d1";
import { DoSqliteCanonicalReportStore } from "../src/data/doSqliteCanonicalReportStoreAdapter";
import type { InsertCanonicalReportRow } from "../src/data/canonicalReportStorePorts";
import {
  getCanonicalReport,
  listScheduledReports,
  storeReportAtGeneration,
  storeReportAtGenerationWithR2,
} from "../src/services/scheduledReports";

type D1Database = any;

/** Fresh D1 env per test (#6101 step 8: the seam reads/writes D1). */
function d1Env(extra: Record<string, unknown> = {}) {
  const mock = new MockD1Database();
  const env = {
    AGENT_DB: mock as unknown as D1Database,
    IAAA_TENANT_ID: "tenant-2398",
    ...extra,
  };
  return { mock, env };
}

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

function row(id: string, over: Partial<InsertCanonicalReportRow> = {}): InsertCanonicalReportRow {
  return {
    id,
    runId: `run-${id}`,
    title: `Title ${id}`,
    source: "screener",
    summary: "s",
    body: "{}",
    createdAt: "2026-10-30T10:00:00.000Z",
    generationId: "gen-1",
    owner: "alice",
    bodyR2Key: null,
    fanoutOutcomeJson: "{}",
    ...over,
  };
}

/** The pre-#2398 instance shape: base table + user_login, the
 *  GLOBAL generation index, and one stored alice row. */
function preFixStorage(): SqliteTestStorage {
  const sql = new SqliteTestStorage();
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
  sql.sqlite.exec(
    `CREATE UNIQUE INDEX ${INDEX} ON mas_reports (generation_id)`
  );
  sql.sqlite
    .prepare(
      `INSERT INTO mas_reports (id, run_id, title, source, summary, body, created_at, generation_id, user_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "rep-alice",
      "run-alice",
      "Alice report",
      "screener",
      "alice summary",
      "{}",
      "2026-10-30T09:00:00.000Z",
      "gen-1",
      "alice"
    );
  return sql;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#2398 [shapes]: ensureSchema index reconciliation", () => {
  it("(a) fresh instance: the index is built tenant-scoped and is idempotent", () => {
    const sql = new SqliteTestStorage();
    const store = new DoSqliteCanonicalReportStore(sql as never);
    store.ensureSchema();
    store.ensureSchema();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);

    store.insertRow(row("r-alice"));
    // Another tenant, same generation id: a different report — lands.
    store.insertRow(row("r-bob", { owner: "bob" }));
    expect(store.findIdByGeneration("gen-1", "alice")).toBe("r-alice");
    expect(store.findIdByGeneration("gen-1", "bob")).toBe("r-bob");
    // Same tenant, same generation id: the backstop still throws.
    expect(() => store.insertRow(row("r-alice-2"))).toThrow();
    // A NULL generation id never conflicts (no dedupe key).
    store.insertRow(row("r-nul-1", { generationId: null }));
    store.insertRow(row("r-nul-2", { generationId: null }));
  });

  it("(b) pre-#2398 global index: ensure swaps it; stored rows are untouched", () => {
    const sql = preFixStorage();
    expect(generationIndexColumns(sql)).toEqual(["generation_id"]);
    const store = new DoSqliteCanonicalReportStore(sql as never);
    store.ensureSchema();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    // The pre-existing row survived the swap byte-identical.
    const alice = store.getRowById("rep-alice");
    expect(alice?.title).toBe("Alice report");
    expect(store.findIdByGeneration("gen-1", "alice")).toBe("rep-alice");
    // And the collision that used to lose bob's report now lands.
    store.insertRow(row("r-bob", { owner: "bob" }));
    expect(store.findIdByGeneration("gen-1", "bob")).toBe("r-bob");
    expect(() => store.insertRow(row("r-alice-2"))).toThrow();
    // A second ensure keeps the swapped shape (no oscillation).
    store.ensureSchema();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
  });

  it("(c) already tenant-scoped: ensure leaves the index and rows exactly as found", () => {
    const sql = new SqliteTestStorage();
    const store = new DoSqliteCanonicalReportStore(sql as never);
    store.ensureSchema();
    store.insertRow(row("r-alice"));
    const ddlBefore = sql.sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(INDEX) as { sql: string };
    store.ensureSchema();
    const ddlAfter = sql.sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(INDEX) as { sql: string };
    expect(ddlAfter.sql).toBe(ddlBefore.sql);
    expect(store.getRowById("r-alice")?.title).toBe("Title r-alice");
  });

  it("(d) degraded table (same-tenant duplicate pairs, no index): ensure dedupes (newest survives) and builds the index", () => {
    const sql = new SqliteTestStorage();
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
    const insert = sql.sqlite.prepare(
      `INSERT INTO mas_reports (id, run_id, title, source, summary, body, created_at, generation_id, user_login)
       VALUES (?, ?, 'T', 'screener', 's', '{}', '2026-10-30T09:00:00.000Z', 'gen-dup', 'alice')`
    );
    insert.run("rep-dup-1", "run-1");
    insert.run("rep-dup-2", "run-2");
    // #3515 S3 batch 7: the dedupe + index-creation logs are now
    // structured events on the console-info JSON fallback, not
    // console.error lines.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const store = new DoSqliteCanonicalReportStore(sql as never);
    expect(() => store.ensureSchema()).not.toThrow();
    const events = infoSpy.mock.calls
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
          String(e.operation ?? "").startsWith(
            "doSqliteCanonicalReportStore.",
          ),
      );
    const messages = events
      .map((e) => String(e.fields?.message ?? ""))
      .join("\n");
    expect(messages).toContain(INDEX);
    const removed = events.flatMap((e) => e.fields?.removed ?? []);
    expect(removed).toContain("rep-dup-1");
    // Issue #4507: the silent degradation is gone — the duplicate
    // pair is resolved (newest survives; the two rows share a
    // created_at, so the greatest id wins) and the index is built.
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    const rows = store.listRows(undefined, undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("rep-dup-2");
    // A second ensure is a no-op: the index stays, the survivor stays.
    store.ensureSchema();
    expect(generationIndexColumns(sql)).toEqual(["user_login", "generation_id"]);
    expect(store.listRows(undefined, undefined, 10)).toHaveLength(1);
  });
});

describe("#2398 [seam]: cross-tenant stores land", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    runId: "run-1",
    generationId: "gen-1",
    userLogin: "alice",
    title: "Daily screen",
    source: "screener",
    summary: "10 scanned",
    body: { hello: "world" },
    ...over,
  });

  it("both tenants store the same generation id; each lands, retrievable by its owner", async () => {
    const { env } = d1Env();
    const alice = await storeReportAtGeneration(input(), env as never);
    expect(alice?.created).toBe(true);
    expect(alice?.fanout.outcome).toBe("stored_inline");
    const bob = await storeReportAtGeneration(
      input({ userLogin: "bob", title: "Bob screen" }),
      env as never,
    );
    expect(bob?.created).toBe(true);
    expect(bob?.fanout.outcome).toBe("stored_inline");
    expect(bob?.reportId).not.toBe(alice?.reportId);
    // Each tenant's report is retrievable by its owner alone.
    expect((await getCanonicalReport(env as never, alice!.reportId))?.title).toBe("Daily screen");
    expect((await getCanonicalReport(env as never, bob!.reportId))?.title).toBe("Bob screen");
    expect((await listScheduledReports(env as never, { userLogin: "alice" })).map((h) => h.id)).toEqual([
      alice!.reportId,
    ]);
    expect((await listScheduledReports(env as never, { userLogin: "bob" })).map((h) => h.id)).toEqual([
      bob!.reportId,
    ]);
    // #6101 step 8 (named loss): no fan-out outcome is recorded on D1 rows.
    expect((await getCanonicalReport(env as never, alice!.reportId))?.fanoutOutcome).toBeNull();
    expect((await getCanonicalReport(env as never, bob!.reportId))?.fanoutOutcome).toBeNull();
  });

  it("over the R2 seam: both tenants store the same generation id, each with its own object", async () => {
    const objects = new Map<string, string>();
    const bucket = {
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
      get: async (key: string) => {
        const text = objects.get(key);
        return text === undefined ? null : { text: async () => text };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    };
    const { env } = d1Env({ REPORTS_BUCKET: bucket as never });
    const alice = await storeReportAtGenerationWithR2(env as never, input());
    const bob = await storeReportAtGenerationWithR2(
      env as never,
      input({ userLogin: "bob", runId: "run-2", title: "Bob screen" })
    );
    expect(alice?.created).toBe(true);
    expect(alice?.fanout.outcome).toBe("stored_r2");
    expect(bob?.created).toBe(true);
    expect(bob?.fanout.outcome).toBe("stored_r2");
    expect(bob?.reportId).not.toBe(alice?.reportId);
    expect(objects.size).toBe(2);
    expect((await getCanonicalReport(env as never, alice!.reportId))?.bodyR2Key).toBe(`reports/${alice!.reportId}.json`);
    expect((await getCanonicalReport(env as never, bob!.reportId))?.bodyR2Key).toBe(`reports/${bob!.reportId}.json`);
  });
});
