/**
 * Issue #2362 (#1976 step 4f) — CONFORMANCE for the D1
 * regularization slice:
 *
 *  - migration 0022 is registered exactly once and every
 *    registry version is unique;
 *  - the Drizzle mappings and the 0022 DDL agree on columns
 *    for all five regularized tables (the step-0/3a idiom);
 *  - the SHAPE produced by migration 0022 is identical to
 *    the shape the legacy self-create produced (PRAGMA +
 *    stored-DDL comparison), and the two creation orders
 *    compose idempotently (self-create then migrate, and
 *    migrate then ensure) — the issue's named drift risk,
 *    measured rather than assumed;
 *  - the QuoteSourcePort and ResourceRollupStorePort
 *    contracts hold over BOTH adapters (D1 over real SQLite,
 *    and in-memory), the family conformance idiom;
 *  - the family's census surface, measured with the global
 *    pin's own patterns: the five legacy modules hold zero
 *    counted sites, and the statements live in the layer at
 *    exact counts.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  ALL_MIGRATIONS,
  MIGRATION_0022_D1_REGULARIZATION,
} from "../src/data/migrationRunner";
import {
  quoteSourceSetting,
  resourceAlertState,
  resourceComparisonReports,
  resourceDailyRollups,
  resourceSqlOps,
} from "../src/data/drizzleSchema";
import { D1QuoteSourceAdapter } from "../src/data/d1QuoteSourceAdapter";
import { InMemoryQuoteSourceAdapter } from "../src/data/inMemoryQuoteSourceAdapter";
import type { QuoteSourcePort } from "../src/data/quoteSourcePorts";
import { D1ResourceRollupStore } from "../src/data/d1ResourceRollupAdapter";
import { InMemoryResourceRollupStore } from "../src/data/inMemoryResourceRollupAdapter";
import type { ResourceRollupStorePort } from "../src/data/resourceRollupPorts";
import { D1ResourceUsageAdapter } from "../src/data/d1ResourceUsageAdapter";
import { ensureMasRetentionIndexes } from "../src/data/masRetentionIndexSchema";
import { ensureFrameworkQueueIndexes } from "../src/data/frameworkQueueIndexSchema";
import type { SqlStorage } from "../src/orm";

/** Real-SQLite-backed D1 shim (same shape as characterization). */
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
      }),
      run: async () => {
        stmt.run();
        return {};
      },
    };
  }
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

const TABLES = [
  "quote_source_setting",
  "resource_sql_ops",
  "resource_daily_rollups",
  "resource_alert_state",
  "resource_comparison_reports",
] as const;

function shapeOf(raw: DatabaseSync, table: string): unknown {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  const stored = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  return {
    cols,
    sql: (stored?.sql ?? "")
      .replace(/IF NOT EXISTS\s+/i, "")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

/** Create the five tables the legacy way: the adapters' own ensures. */
async function selfCreate(raw: DatabaseSync): Promise<void> {
  const db = new SqliteD1(raw);
  await new D1QuoteSourceAdapter(db as never).ensureSchema();
  const usage = new D1ResourceUsageAdapter(db as never);
  await usage.record({ ns: "n", op: "get", rowsRead: 0, rowsWritten: 0, timestampMs: 1 });
  await new D1ResourceRollupStore(db as never).ensureSchema();
}

describe("migration 0022 registration", () => {
  it("is registered exactly once; every registry version is unique", () => {
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions.filter((v) => v === 22)).toHaveLength(1);
    expect(MIGRATION_0022_D1_REGULARIZATION.version).toBe(22);
    expect(MIGRATION_0022_D1_REGULARIZATION.name).toBe("0022_d1_regularization");
    // #2428 appended migration 0023 (agent_mesh_trace_hops) after
    // 0022; 0022's registration is asserted by position-independent
    // containment now (the pin rule: the appending slice updates
    // the pin its change alters).
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0022_D1_REGULARIZATION);
  });
});

describe("migration 0022 DDL and the Drizzle schema agree on columns", () => {
  const cases: Array<[string, unknown]> = [
    ["quote_source_setting", quoteSourceSetting],
    ["resource_sql_ops", resourceSqlOps],
    ["resource_daily_rollups", resourceDailyRollups],
    ["resource_alert_state", resourceAlertState],
    ["resource_comparison_reports", resourceComparisonReports],
  ];
  for (const [table, schema] of cases) {
    it(table, () => {
      const rawColumns = getTableConfig(schema as never).columns as unknown;
      const schemaColumns = Array.isArray(rawColumns)
        ? rawColumns.map((c: { name: string }) => c.name)
        : Object.keys(rawColumns as Record<string, unknown>).map((s) =>
            s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
          );
      const block = MIGRATION_0022_D1_REGULARIZATION.sql
        .split(`CREATE TABLE IF NOT EXISTS ${table} (`)[1]
        .split("\n);")[0];
      const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)]
        .map((m) => m[1])
        .filter((name) => name !== "PRIMARY");
      expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
    });
  }
});

describe("migration shape equals self-created shape (the drift risk, measured)", () => {
  it("all five tables: identical PRAGMA shape and stored DDL, either creation order", async () => {
    const migrated = new DatabaseSync(":memory:");
    migrated.exec(MIGRATION_0022_D1_REGULARIZATION.sql);
    migrated.exec(MIGRATION_0022_D1_REGULARIZATION.sql); // re-apply is a no-op

    const selfCreated = new DatabaseSync(":memory:");
    await selfCreate(selfCreated);

    for (const table of TABLES) {
      expect(shapeOf(migrated, table), table).toEqual(shapeOf(selfCreated, table));
    }

    // Self-create first, then migrate: no error, shape unchanged.
    const composed = new DatabaseSync(":memory:");
    await selfCreate(composed);
    const before = TABLES.map((t) => shapeOf(composed, t));
    composed.exec(MIGRATION_0022_D1_REGULARIZATION.sql);
    expect(TABLES.map((t) => shapeOf(composed, t))).toEqual(before);

    // Migrate first, then the adapters' ensures: no error either.
    const composed2 = new DatabaseSync(":memory:");
    composed2.exec(MIGRATION_0022_D1_REGULARIZATION.sql);
    await selfCreate(composed2);
    for (const table of TABLES) {
      expect(shapeOf(composed2, table), table).toEqual(shapeOf(selfCreated, table));
    }
  });
});

describe("QuoteSourcePort contract (both adapters)", () => {
  const makers: Array<[string, () => Promise<QuoteSourcePort>]> = [
    [
      "D1",
      async () => new D1QuoteSourceAdapter(new SqliteD1(new DatabaseSync(":memory:")) as never),
    ],
    ["in-memory", async () => new InMemoryQuoteSourceAdapter()],
  ];
  for (const [name, make] of makers) {
    describe(name, () => {
      it("fails open to auto before any write; set/get round-trips; set normalizes", async () => {
        const port = await make();
        await port.ensureSchema();
        await port.ensureSchema(); // idempotent
        expect(await port.get()).toBe("auto");
        expect(await port.set("yahoo")).toBe("yahoo");
        expect(await port.get()).toBe("yahoo");
        expect(await port.set("alpaca")).toBe("alpaca");
        expect(await port.get()).toBe("alpaca");
        expect(await port.set("bogus" as never)).toBe("auto");
        expect(await port.get()).toBe("auto");
      });
    });
  }

  it("D1 adapter: get over a broken store still fails open; set propagates the failure", async () => {
    const broken = {
      prepare() {
        throw new Error("d1 unavailable");
      },
    };
    const port = new D1QuoteSourceAdapter(broken as never);
    expect(await port.get()).toBe("auto");
    await expect(port.set("yahoo")).rejects.toThrow();
  });
});

describe("ResourceRollupStorePort contract (both adapters)", () => {
  const makers: Array<[string, () => Promise<ResourceRollupStorePort>]> = [
    [
      "D1",
      async () => new D1ResourceRollupStore(new SqliteD1(new DatabaseSync(":memory:")) as never),
    ],
    ["in-memory", async () => new InMemoryResourceRollupStore()],
  ];
  const row = {
    day: "2026-10-26",
    ns: "sessions",
    op: "get",
    caller: "requireAuth",
    trigger: "user",
    ops: 5,
    rowsRead: 5,
    rowsWritten: 0,
  };
  for (const [name, make] of makers) {
    describe(name, () => {
      it("round-trips rollups, alert state, and comparison reports", async () => {
        const store = await make();
        await store.ensureSchema();
        await store.ensureSchema(); // idempotent
        expect(await store.latestCompletedRollupDay()).toBeNull();
        expect(await store.readComparisonReport("2026-10-26")).toBeNull();
        expect(await store.getAlertState("rowsRead", "2026-10-26")).toBeNull();

        await store.writeDailyRollup("2026-10-26", [row]);
        await store.writeDailyRollup("2026-10-26", [{ ...row, ops: 7, rowsRead: 7 }]);
        const rows = await store.readDailyRollup("2026-10-26");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ops: 7, rowsRead: 7 });
        expect(await store.latestCompletedRollupDay()).toBe("2026-10-26");

        await store.markAlerted("rowsRead", "2026-10-26", true, "delivered via webhook");
        expect(await store.getAlertState("rowsRead", "2026-10-26")).toMatchObject({
          delivered: 1,
          note: "delivered via webhook",
        });
        await store.markAlerted("rowsWritten", "2026-10-26", false, null);
        expect(await store.getAlertState("rowsWritten", "2026-10-26")).toMatchObject({
          delivered: 0,
          note: null,
        });

        await store.writeComparisonReport("2026-10-26", { day: "2026-10-26", ok: true });
        expect(await store.readComparisonReport("2026-10-26")).toEqual({
          day: "2026-10-26",
          ok: true,
        });
      });
    });
  }

  it("D1 adapter: ops before ensure throw (the declared goal-path direction)", async () => {
    const store = new D1ResourceRollupStore(
      new SqliteD1(new DatabaseSync(":memory:")) as never,
    );
    await expect(store.readDailyRollup("2026-10-26")).rejects.toThrow();
    await expect(store.latestCompletedRollupDay()).rejects.toThrow();
  });
});

describe("family census surface (the global pin's own patterns)", () => {
  const PREPARE_PATTERN = /\.prepare\s*\(/g;
  const STORAGE_EXEC_PATTERN =
    /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;
  const count = (pattern: RegExp, file: string) =>
    (readFileSync(file, "utf8").match(pattern) ?? []).length;

  it("the five legacy modules hold zero counted sites", () => {
    for (const file of [
      "src/services/quoteSourceSetting.ts",
      "src/telemetry/d1ResourceUsageAdapter.ts",
      "src/telemetry/resourceRollupStore.ts",
    ]) {
      expect(count(PREPARE_PATTERN, file), file).toBe(0);
    }
    for (const file of [
      "src/services/masRetentionIndexes.ts",
      "src/services/frameworkQueueIndexes.ts",
    ]) {
      expect(count(STORAGE_EXEC_PATTERN, file), file).toBe(0);
    }
  });

  it("the statements live in the layer at exact counts", () => {
    expect(count(PREPARE_PATTERN, "src/data/d1QuoteSourceAdapter.ts")).toBe(3);
    expect(count(PREPARE_PATTERN, "src/data/d1ResourceUsageAdapter.ts")).toBe(3);
    expect(count(PREPARE_PATTERN, "src/data/d1ResourceRollupAdapter.ts")).toBe(8);
    expect(count(STORAGE_EXEC_PATTERN, "src/data/masRetentionIndexSchema.ts")).toBe(3);
    expect(count(STORAGE_EXEC_PATTERN, "src/data/frameworkQueueIndexSchema.ts")).toBe(1);
    for (const file of [
      "src/data/quoteSourcePorts.ts",
      "src/data/resourceRollupPorts.ts",
      "src/data/createQuoteSourcePorts.ts",
      "src/data/createResourceRollupPorts.ts",
      "src/data/inMemoryQuoteSourceAdapter.ts",
      "src/data/inMemoryResourceRollupAdapter.ts",
    ]) {
      expect(count(PREPARE_PATTERN, file), file).toBe(0);
    }
  });

  it("the layer schema modules produce the pinned indexes (module-level smoke)", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(`CREATE TABLE mas_messages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`);
    raw.exec(`CREATE TABLE mas_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL)`);
    raw.exec(`CREATE TABLE cf_agents_jobs (id TEXT PRIMARY KEY NOT NULL, time INTEGER NOT NULL,
      singleflight INTEGER NOT NULL DEFAULT 0, exclusive INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0, execution_started_at INTEGER,
      hung_timeout_seconds INTEGER) WITHOUT ROWID`);
    const sql = makeSql(raw);
    ensureMasRetentionIndexes(sql);
    ensureFrameworkQueueIndexes(sql);
    const names = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      // Only the modules' own indexes: the minimal test DDL's
      // PRIMARY KEYs also mint sqlite_autoindex_* entries,
      // which are SQLite's, not the modules'.
      .filter((n) => n.startsWith("idx_"));
    expect(names).toEqual([
      "idx_cf_agents_jobs_exclusive_time",
      "idx_cf_agents_jobs_singleflight_running",
      "idx_cf_agents_jobs_time",
      "idx_mas_events_created",
      "idx_mas_events_session_type",
      "idx_mas_messages_created",
    ]);
  });
});
