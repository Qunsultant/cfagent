/**
 * Issue #2362 (#1976 step 4f) — CHARACTERIZATION for the D1
 * regularization slice. Written against the LEGACY module paths
 * (src/services + src/telemetry) BEFORE the cutover; the same
 * file must stay green after the modules become delegates over
 * src/data ports, so every pin here is behaviour, never wiring.
 *
 * Pins, as found:
 *  - quote source: get NEVER creates the table and fails open
 *    to "auto" on unbound store / missing table / missing row /
 *    invalid value / throwing store; set creates the table
 *    (CREATE before INSERT) and normalizes; the self-created
 *    table shape is exact (PRAGMA-measured).
 *  - resource usage: record self-creates resource_sql_ops on
 *    the FIRST record per adapter instance only, and never
 *    throws; totals does NOT self-create and throws on DB
 *    error; the self-created shape is exact.
 *  - rollup store: ensure creates exactly three tables with
 *    exact shapes and is idempotent; the op paths do NOT
 *    self-ensure — they throw on a missing table (the
 *    goal-path contract: a failing goal stays due).
 *  - index helpers: the exact indexes (names + column
 *    sequences) exist after a call; both are idempotent.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  ensureQuoteSourceTable,
  getQuoteSource,
  setQuoteSource,
} from "../src/services/quoteSourceSetting";
import { createD1QuoteSourceDb } from "../src/data/d1QuoteSourceAdapter";
import { createD1ResourceDb, D1ResourceUsageAdapter } from "../src/telemetry/d1ResourceUsageAdapter";
import {
  ensureResourceRollupTables,
  getAlertState,
  latestCompletedRollupDay,
  readDailyRollup,
  writeDailyRollup,
} from "../src/telemetry/resourceRollupStore";
import { ensureMasRetentionIndexes } from "../src/services/masRetentionIndexes";
import {
  FRAMEWORK_QUEUE_INDEXES,
  ensureFrameworkQueueIndexes,
} from "../src/services/frameworkQueueIndexes";
import type { SqlStorage } from "../src/orm";

/** Real-SQLite-backed D1 shim implementing both structural
 *  shapes used by the three modules (bind -> first/run/all,
 *  plus a statement-level run). */
class SqliteD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    return {
      bind: (...args: unknown[]) => ({
        first: async () => (stmt.get(...(args as never[])) ?? null) as unknown,
        run: async () => {
          stmt.run(...(args as never[]));
          return {};
        },
        all: async () => ({ results: stmt.all(...(args as never[])) }),
        // drizzle-orm 0.45.4's select-with-fields path reads
        // array-mode rows via .raw(); without it every catalogued
        // select fails with ".raw is not a function".
        raw: async () =>
          stmt.all(...(args as never[])).map((row) => Object.values(row as Record<string, unknown>)),
      }),
      run: async () => {
        stmt.run();
        return {};
      },
    };
  }
}

/** Wraps a db and records every prepared SQL string, in order. */
function recording(inner: SqliteD1, log: string[]) {
  return {
    prepare(sql: string) {
      log.push(sql);
      return inner.prepare(sql);
    },
  };
}

interface ColInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function tableInfo(db: DatabaseSync, table: string): ColInfo[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).map(
    (r) => ({
      name: String(r.name),
      type: String(r.type),
      notnull: Number(r.notnull),
      pk: Number(r.pk),
    }),
  );
}

function indexColumns(db: DatabaseSync, table: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const list = db.prepare(`PRAGMA index_list(${table})`).all() as Array<Record<string, unknown>>;
  for (const row of list) {
    const name = String(row.name);
    const cols = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<Record<string, unknown>>)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((r) => String(r.name));
    out.set(name, cols);
  }
  return out;
}

function makeSql(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|EXPLAIN|PRAGMA|WITH)\b/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      stmt.run(...(args as never[]));
      return [];
    },
  };
}

describe("characterization: quote source setting (legacy surface)", () => {
  it("fails open to auto with no store at all", async () => {
    expect(await getQuoteSource(undefined)).toBe("auto");
    expect(await getQuoteSource(null)).toBe("auto");
  });

  it("get on a store whose table does not exist returns auto and does NOT create the table", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("auto");
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'quote_source_setting'")
      .all();
    expect(tables).toHaveLength(0);
  });

  it("get issues no CREATE — a throwing store still fails open to auto", async () => {
    const prepared: string[] = [];
    const throwing = {
      prepare(sql: string) {
        prepared.push(sql);
        throw new Error("no such table: quote_source_setting");
      },
    };
    expect(await getQuoteSource(createD1QuoteSourceDb(throwing as never))).toBe("auto");
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatch(/^\s*SELECT/i);
  });

  it("get with the table present but no row returns auto; an invalid stored value returns auto", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    await ensureQuoteSourceTable(createD1QuoteSourceDb(db as never));
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("auto");
    raw
      .prepare("INSERT INTO quote_source_setting (id, source, updated_at) VALUES (1, 'bogus', 1)")
      .run();
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("auto");
  });

  it("set creates the table before inserting, normalizes, and reads back", async () => {
    const raw = new DatabaseSync(":memory:");
    const log: string[] = [];
    const db = recording(new SqliteD1(raw), log);
    expect(await setQuoteSource(createD1QuoteSourceDb(db as never), "yahoo")).toBe("yahoo");
    const createAt = log.findIndex((s) => /CREATE TABLE/i.test(s));
    const insertAt = log.findIndex((s) => /INSERT INTO/i.test(s));
    expect(createAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(createAt);
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("yahoo");
    expect(await setQuoteSource(createD1QuoteSourceDb(db as never), "nope" as never)).toBe("auto");
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("auto");
  });

  it("the self-created quote_source_setting shape is exact", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    await ensureQuoteSourceTable(createD1QuoteSourceDb(db as never));
    await ensureQuoteSourceTable(createD1QuoteSourceDb(db as never)); // idempotent
    expect(tableInfo(raw, "quote_source_setting")).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "source", type: "TEXT", notnull: 1, pk: 0 },
      { name: "updated_at", type: "INTEGER", notnull: 1, pk: 0 },
    ]);
    const sqlRow = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quote_source_setting'")
      .get() as { sql: string };
    expect(sqlRow.sql).toContain("CHECK (id = 1)");
  });
});

describe("characterization: D1 resource usage adapter (legacy surface)", () => {
  const event = {
    ns: "sessions",
    op: "get",
    rowsRead: 1,
    rowsWritten: 0,
    timestampMs: 1_000,
  };

  it("record self-creates on the first record per instance only", async () => {
    const prepared: string[] = [];
    const stub = {
      prepare(sql: string) {
        prepared.push(sql);
        return {
          bind: () => ({
            run: async () => ({}),
            all: async () => ({ results: [] }),
          }),
        };
      },
    };
    const adapter = new D1ResourceUsageAdapter(createD1ResourceDb(stub as never));
    await adapter.record(event);
    await adapter.record(event);
    expect(prepared.filter((s) => /CREATE TABLE/i.test(s))).toHaveLength(1);
    expect(prepared.filter((s) => /INSERT INTO/i.test(s))).toHaveLength(2);
    const second = new D1ResourceUsageAdapter(createD1ResourceDb(stub as never));
    await second.record(event);
    expect(prepared.filter((s) => /CREATE TABLE/i.test(s))).toHaveLength(2);
  });

  it("record never throws when the store fails (warns and drops)", async () => {
    // #3515 S3 batch 7: the warn rides the S2 structured logger —
    // the console-info JSON fallback carries the
    // d1ResourceUsageAdapter.d1_record_failed warn event.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const broken = {
      prepare() {
        throw new Error("d1 unavailable");
      },
    };
    const adapter = new D1ResourceUsageAdapter(createD1ResourceDb(broken as never));
    await expect(adapter.record(event)).resolves.toBeUndefined();
    const events = info.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as {
            operation?: unknown;
            level?: unknown;
            fields?: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      })
      .filter((e) => e?.operation === "d1ResourceUsageAdapter.d1_record_failed");
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("warn");
    // The DML executor wraps the store failure, so fields.error is
    // its "Failed to run the query ..." text naming the statement that
    // failed (the underlying "d1 unavailable" cause is not chained into
    // the message); the warn still names the failure and the op/ns.
    expect(events[0]?.fields?.message).toBe("[resource-usage] D1 record failed:");
    expect(String(events[0]?.fields?.error ?? "")).toContain("Failed to run the query");
    expect(String(events[0]?.fields?.error ?? "")).toContain("resource_sql_ops");
    expect(events[0]?.fields?.op).toBe(event.op);
    expect(events[0]?.fields?.ns).toBe(event.ns);
    info.mockRestore();
  });

  it("totals does NOT self-create and throws on DB error", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    const adapter = new D1ResourceUsageAdapter(createD1ResourceDb(db as never));
    await expect(adapter.totals(0, 3_600_000, 3_600_000)).rejects.toThrow();
  });

  it("the self-created resource_sql_ops shape is exact, and record->totals round-trips", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    const adapter = new D1ResourceUsageAdapter(createD1ResourceDb(db as never));
    await adapter.record(event);
    await adapter.record({ ...event, timestampMs: 2_000, rowsRead: 3 });
    expect(tableInfo(raw, "resource_sql_ops")).toEqual([
      { name: "ts_ms", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "ns", type: "TEXT", notnull: 1, pk: 0 },
      { name: "op", type: "TEXT", notnull: 1, pk: 0 },
      { name: "rows_read", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "rows_written", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "caller", type: "TEXT", notnull: 0, pk: 0 },
      { name: "trigger", type: "TEXT", notnull: 0, pk: 0 },
      { name: "statement", type: "TEXT", notnull: 0, pk: 0 },
      { name: "tenant_id", type: "TEXT", notnull: 0, pk: 0 },
      { name: "run_id", type: "TEXT", notnull: 0, pk: 0 },
      { name: "session_ref", type: "TEXT", notnull: 0, pk: 0 },
    ]);
    const totals = await adapter.totals(0, 3_600_000, 3_600_000);
    expect(totals).toEqual([
      {
        bucketStartMs: 0,
        ns: "sessions",
        op: "get",
        caller: "unknown",
        trigger: "unknown",
        ops: 2,
        rowsRead: 4,
        rowsWritten: 0,
      },
    ]);
  });
});

describe("characterization: resource rollup store (legacy surface)", () => {
  it("ensure creates exactly the three rollup tables with exact shapes, idempotently", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    await ensureResourceRollupTables(createD1ResourceDb(db as never));
    await ensureResourceRollupTables(createD1ResourceDb(db as never));
    const tables = (
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'resource_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual([
      "resource_alert_state",
      "resource_comparison_reports",
      "resource_daily_rollups",
    ]);
    expect(tableInfo(raw, "resource_daily_rollups")).toEqual([
      { name: "day", type: "TEXT", notnull: 1, pk: 1 },
      { name: "ns", type: "TEXT", notnull: 1, pk: 2 },
      { name: "op", type: "TEXT", notnull: 1, pk: 3 },
      { name: "caller", type: "TEXT", notnull: 1, pk: 4 },
      { name: "trigger", type: "TEXT", notnull: 1, pk: 5 },
      { name: "ops", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "rows_read", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "rows_written", type: "INTEGER", notnull: 1, pk: 0 },
    ]);
    expect(tableInfo(raw, "resource_alert_state")).toEqual([
      { name: "budget", type: "TEXT", notnull: 1, pk: 1 },
      { name: "day", type: "TEXT", notnull: 1, pk: 2 },
      { name: "alerted_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "delivered", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "note", type: "TEXT", notnull: 0, pk: 0 },
    ]);
    expect(tableInfo(raw, "resource_comparison_reports")).toEqual([
      { name: "day", type: "TEXT", notnull: 0, pk: 1 },
      { name: "generated_at", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "report_json", type: "TEXT", notnull: 1, pk: 0 },
    ]);
  });

  it("the op paths do NOT self-ensure: reads and writes throw before ensure (goal-path contract)", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    await expect(readDailyRollup(createD1ResourceDb(db as never), "2026-10-26")).rejects.toThrow();
    await expect(
      writeDailyRollup(createD1ResourceDb(db as never), "2026-10-26", [
        { day: "2026-10-26", ns: "sessions", op: "get", caller: "c", trigger: "t", ops: 1, rowsRead: 1, rowsWritten: 0 },
      ]),
    ).rejects.toThrow();
    await expect(getAlertState(createD1ResourceDb(db as never), "rowsRead", "2026-10-26")).rejects.toThrow();
    await expect(latestCompletedRollupDay(createD1ResourceDb(db as never))).rejects.toThrow();
  });

  it("readDailyRollup returns rows ordered by ns, op, caller, trigger", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteD1(raw);
    await ensureResourceRollupTables(createD1ResourceDb(db as never));
    await writeDailyRollup(createD1ResourceDb(db as never), "2026-10-26", [
      { day: "2026-10-26", ns: "sessions", op: "put", caller: "b", trigger: "t", ops: 1, rowsRead: 0, rowsWritten: 1 },
      { day: "2026-10-26", ns: "sessions", op: "get", caller: "a", trigger: "t", ops: 2, rowsRead: 2, rowsWritten: 0 },
      { day: "2026-10-26", ns: "auth", op: "get", caller: "a", trigger: "t", ops: 3, rowsRead: 3, rowsWritten: 0 },
    ]);
    const rows = await readDailyRollup(createD1ResourceDb(db as never), "2026-10-26");
    expect(rows.map((r) => `${r.ns}/${r.op}/${r.caller}`)).toEqual([
      "auth/get/a",
      "sessions/get/a",
      "sessions/put/b",
    ]);
  });
});

describe("characterization: index helpers (legacy surface)", () => {
  it("ensureMasRetentionIndexes creates exactly the two (created_at, id) covering indexes", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`CREATE TABLE mas_messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, agent TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    raw.exec(`CREATE TABLE mas_events (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      agent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      previous_event_hash TEXT, event_hash TEXT
    )`);
    const sql = makeSql(raw);
    ensureMasRetentionIndexes(sql);
    ensureMasRetentionIndexes(sql); // idempotent
    expect(indexColumns(raw, "mas_messages").get("idx_mas_messages_created")).toEqual([
      "created_at",
      "id",
    ]);
    expect(indexColumns(raw, "mas_events").get("idx_mas_events_created")).toEqual([
      "created_at",
      "id",
    ]);
  });

  it("ensureFrameworkQueueIndexes creates exactly the three seek indexes with exact columns", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`CREATE TABLE cf_agents_jobs (
      id TEXT PRIMARY KEY NOT NULL, capability TEXT NOT NULL, fn TEXT NOT NULL,
      time INTEGER NOT NULL, payload TEXT, retry_options TEXT,
      singleflight INTEGER NOT NULL DEFAULT 0, hung_timeout_seconds INTEGER,
      exclusive INTEGER NOT NULL DEFAULT 0, recovery_loop INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0, execution_started_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    ) WITHOUT ROWID`);
    const sql = makeSql(raw);
    ensureFrameworkQueueIndexes(sql);
    const names = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_cf_agents_jobs%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names.sort()).toEqual(FRAMEWORK_QUEUE_INDEXES.map((i) => i.name).sort());
    const byTable = indexColumns(raw, "cf_agents_jobs");
    expect(byTable.get("idx_cf_agents_jobs_time")).toEqual(["time"]);
    expect(byTable.get("idx_cf_agents_jobs_exclusive_time")).toEqual(["exclusive", "time"]);
    expect(byTable.get("idx_cf_agents_jobs_singleflight_running")).toEqual([
      "singleflight",
      "running",
      "execution_started_at",
      "hung_timeout_seconds",
    ]);
  });
});
