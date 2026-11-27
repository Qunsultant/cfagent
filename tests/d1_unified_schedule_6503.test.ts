// @vitest-environment node
/**
 * Issue #6503 (step 6b) — the D1 unified schedule store.
 *
 * Pinned contracts:
 *  - Migration 0092 owns the D1 `unified_schedules` DDL; the
 *    Drizzle schema maps it column-for-column, and the migration
 *    DDL and the Drizzle schema agree (the slice-1 pattern).
 *  - The D1 adapter honors the async `ScheduleStore` port contract
 *    unchanged: upsert by id, list created_at ascending, remove
 *    reports absence, clearPaused deletes paused rows only. The
 *    same contract suite runs against the D1 adapter and the
 *    in-memory adapter.
 *  - Schema-ensure is lazy and idempotent: the first operation
 *    applies the pending migrations; later operations apply none.
 *  - Fail-closed (owner decision 2026-11-25): the D1 factory
 *    throws when AGENT_DB is unbound — there is no DO fallback.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1UnifiedScheduleDb,
  D1UnifiedScheduleAdapter,
  ensureUnifiedScheduleSchema,
} from "../src/data/d1UnifiedScheduleAdapter";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import {
  createD1UnifiedSchedulePorts,
  createUnifiedSchedulePorts,
} from "../src/data/createUnifiedSchedulePorts";
import {
  MIGRATION_0092_UNIFIED_SCHEDULES_D1,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { unifiedSchedules } from "../src/data/drizzleSchema";
import type {
  ScheduleStore,
  UnifiedScheduleRecord,
} from "../src/data/unifiedSchedulePorts";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slice 1). */
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
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
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
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

function record(
  overrides: Partial<UnifiedScheduleRecord> & { id: string },
): UnifiedScheduleRecord {
  return {
    kind: "screen",
    state: "active",
    definition: { intervalSeconds: 2592000 },
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    ...overrides,
  };
}

async function makeD1Store(): Promise<{
  store: ScheduleStore;
  mock: MockD1Database;
}> {
  const mock = new MockD1Database();
  const db = createD1UnifiedScheduleDb(mock as unknown as D1Database);
  const store = new D1UnifiedScheduleAdapter(db);
  return { store, mock };
}

describe("migration 0092 (D1 unified_schedules)", () => {
  it("applies once, records _migrations, and a second apply is a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1UnifiedScheduleDb(mock as unknown as D1Database);
    const applied = await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0092_UNIFIED_SCHEDULES_D1,
    ]);
    expect(applied).toEqual([92]);
    const again = await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0092_UNIFIED_SCHEDULES_D1,
    ]);
    expect(again).toEqual([]);
    const tables = mock.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'unified_schedules'",
      )
      .all();
    expect(tables).toHaveLength(1);
    const indexes = mock.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'unified_schedules' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    // SQLite also creates an implicit autoindex for the TEXT PRIMARY
    // KEY; the migration owns the three named indexes.
    expect(
      indexes.map((row) => row.name).filter((name) => !name.startsWith("sqlite_")),
    ).toEqual([
      "unified_schedules_created_idx",
      "unified_schedules_kind_idx",
      "unified_schedules_state_idx",
    ]);
  });

  it("migration DDL and the Drizzle schema agree on columns", () => {
    // The slice-1 pattern: Drizzle column keys are camelCase, the
    // DDL column names are snake_case.
    const rawColumns = getTableConfig(unifiedSchedules).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) =>
          s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        );
    const ddl = MIGRATION_0092_UNIFIED_SCHEDULES_D1.sql;
    const block = ddl
      .split("CREATE TABLE IF NOT EXISTS unified_schedules (")[1]
      .split("\n);")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
    expect(ddlColumns.sort()).toEqual(schemaColumns.sort());
  });
});

describe("D1UnifiedScheduleAdapter (ScheduleStore contract)", () => {
  // The same contract suite runs against the D1 adapter and the
  // in-memory adapter: the port contract is backend-independent.
  const backends: Array<{
    name: string;
    make: () => Promise<ScheduleStore>;
  }> = [
    {
      name: "D1",
      // #6503 RECREATE: the first operation lazily ensures the schema,
      // and migration 0092's goals seed lands 9 rows — the contract
      // suite runs against an empty store, so clear the seeded rows
      // first. The seed itself is pinned by the agreement test, not here.
      make: async () => {
        const { store } = await makeD1Store();
        await store.clear();
        return store;
      },
    },
    {
      name: "in-memory",
      make: async () => new InMemoryUnifiedScheduleStore(),
    },
  ];

  for (const backend of backends) {
    describe(backend.name, () => {
      it("save/get round-trips a record, JSON fields included", async () => {
        const store = await backend.make();
        await store.save(
          record({
            id: "schedule-watchdog",
            kind: "internal",
            state: "paused",
            callback: "schedule-watchdog",
            operation: "run-schedule-watchdog",
            definition: { intervalSeconds: 2592000, note: "monthly" },
            ownerLogin: "system",
            provenance: { source: "seed" },
            alarmId: "alarm-1",
            pausedAt: "2026-11-25T01:00:00.000Z",
          }),
        );
        const found = await store.get("schedule-watchdog");
        expect(found).toBeDefined();
        expect(found?.kind).toBe("internal");
        expect(found?.state).toBe("paused");
        expect(found?.callback).toBe("schedule-watchdog");
        expect(found?.definition).toEqual({
          intervalSeconds: 2592000,
          note: "monthly",
        });
        expect(found?.ownerLogin).toBe("system");
        expect(found?.provenance).toEqual({ source: "seed" });
        expect(found?.alarmId).toBe("alarm-1");
        expect(found?.pausedAt).toBe("2026-11-25T01:00:00.000Z");
        expect(await store.get("missing")).toBeUndefined();
      });

      it("save overwrites the same id (upsert)", async () => {
        const store = await backend.make();
        await store.save(record({ id: "a", state: "active" }));
        await store.save(
          record({ id: "a", state: "paused", alarmId: null as never }),
        );
        const found = await store.get("a");
        expect(found?.state).toBe("paused");
        expect(await store.list()).toHaveLength(1);
      });

      it("lists in created_at, id order and filters by kind and state", async () => {
        const store = await backend.make();
        await store.save(record({ id: "b", kind: "goal", createdAt: "2026-11-25T00:00:02.000Z" }));
        await store.save(record({ id: "a", kind: "screen", createdAt: "2026-11-25T00:00:01.000Z" }));
        await store.save(record({ id: "c", kind: "screen", state: "paused", createdAt: "2026-11-25T00:00:01.000Z" }));
        expect((await store.list()).map((r) => r.id)).toEqual(["a", "c", "b"]);
        expect((await store.listByKind("screen")).map((r) => r.id)).toEqual([
          "a",
          "c",
        ]);
        expect((await store.listByKind("goal")).map((r) => r.id)).toEqual(["b"]);
        expect((await store.listByState("paused")).map((r) => r.id)).toEqual([
          "c",
        ]);
        expect((await store.listByState("active")).map((r) => r.id)).toEqual([
          "a",
          "b",
        ]);
      });

      it("remove reports absence; clearPaused deletes paused rows only", async () => {
        const store = await backend.make();
        await store.save(record({ id: "a", state: "active" }));
        await store.save(record({ id: "b", state: "paused" }));
        await store.save(record({ id: "c", state: "paused" }));
        expect(await store.remove("missing")).toBe(false);
        expect(await store.remove("a")).toBe(true);
        expect(await store.remove("a")).toBe(false);
        expect(await store.clearPaused()).toBe(2);
        expect(await store.list()).toHaveLength(0);
        expect(await store.clearPaused()).toBe(0);
      });

      it("clear removes every row", async () => {
        const store = await backend.make();
        await store.save(record({ id: "a" }));
        await store.save(record({ id: "b" }));
        await store.clear();
        expect(await store.list()).toHaveLength(0);
      });
    });
  }

  it("schema-ensure is lazy and idempotent across operations", async () => {
    const { store, mock } = await makeD1Store();
    await store.save(record({ id: "a" }));
    await store.list();
    await store.get("a");
    const rows = mock.sqlite
      .prepare("SELECT COUNT(*) AS n FROM _migrations")
      .all() as Array<{ n: number }>;
    // #6101 adds migration 0093 (job_run_records identity columns):
    // 92 → 93.
    expect(rows[0].n).toBe(93);
  });

  it("ensureUnifiedScheduleSchema applies all pending migrations", async () => {
    const mock = new MockD1Database();
    const db = createD1UnifiedScheduleDb(mock as unknown as D1Database);
    const applied = await ensureUnifiedScheduleSchema(db);
    expect(applied).toContain(92);
    // #6101 adds migration 0093 (job_run_records identity columns):
    // 92 → 93.
    expect(applied).toHaveLength(93);
    const again = await ensureUnifiedScheduleSchema(db);
    expect(again).toEqual([]);
  });
});

describe("createD1UnifiedSchedulePorts (fail-closed)", () => {
  it("throws when AGENT_DB is unbound — no DO fallback", () => {
    expect(() =>
      createD1UnifiedSchedulePorts({ d1: undefined }),
    ).toThrow(/AGENT_DB is not bound/);
    expect(() => createD1UnifiedSchedulePorts({ d1: null })).toThrow(
      /AGENT_DB is not bound/,
    );
  });

  it("returns a working D1 store when AGENT_DB is bound", async () => {
    const mock = new MockD1Database();
    const { unifiedSchedules } = createD1UnifiedSchedulePorts({
      d1: mock as unknown as D1Database,
    });
    await unifiedSchedules.save(record({ id: "a" }));
    expect((await unifiedSchedules.get("a"))?.id).toBe("a");
  });

  it("the DO factory is unchanged (legacy retained-unused surface)", async () => {
    // The DO factory still builds — it is the retained DO adapter,
    // not a live-store fallback (#6503 NO-COPY: no row migration;
    // no live call site reads or writes the DO tables).
    const ports = createUnifiedSchedulePorts({
      sql: { exec: () => [] } as never,
    });
    expect(ports.unifiedSchedules).toBeDefined();
    expect(ports.unifiedSchedulesSync).toBeDefined();
  });
});
