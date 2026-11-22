// @vitest-environment node
/**
 * Issue #6072 (#4437 slice 6d-a) — the D1-resident screener task
 * ledger: migration 0079 creates `agent_screener_task_entries`, and
 * `D1ScreenerTaskStore` round-trips the ledger's port over it.
 *
 * - 6072-M1 registration: migration 0079 is registered, versioned,
 *   and carries the CREATE TABLE DDL.
 * - 6072-D1 ensure lands the table, idempotently.
 * - 6072-D2 store round-trip: set/get/list/delete + upsert overwrite;
 *   list returns the keys as written (the `screener:` namespace the
 *   DO-storage implementation prefixes with is stripped on read).
 * - 6072-D3 key parity: the stored rows carry the `screener:` prefix,
 *   so a row copied between the D1 store and the DO-storage store
 *   keeps its key.
 * - 6072-D4 ledger over D1: the ScreenerTaskLedger's create/claim/
 *   start/complete transitions run on the D1 store (the ledger the
 *   goal composition's claim/complete steps write to).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1ScreenerTaskStoreDb,
  D1ScreenerTaskStore,
  ensureScreenerTaskEntriesSchema,
} from "../src/data/d1ScreenerTaskStoreAdapter";
import {
  ALL_MIGRATIONS,
  MIGRATION_0079_SCREENER_TASK_ENTRIES,
} from "../src/data/migrationRunner";
import { ScreenerTaskLedger } from "../src/services/screenerTaskLedger";

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

describe("6072 migration 0079 — D1 screener task entries", () => {
  it("6072-M1 is registered, versioned 79, and carries the CREATE TABLE DDL", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0079_SCREENER_TASK_ENTRIES);
    expect(MIGRATION_0079_SCREENER_TASK_ENTRIES.version).toBe(79);
    expect(MIGRATION_0079_SCREENER_TASK_ENTRIES.name).toBe(
      "0079_screener_task_entries",
    );
    expect(MIGRATION_0079_SCREENER_TASK_ENTRIES.sql).toContain(
      "CREATE TABLE IF NOT EXISTS agent_screener_task_entries",
    );
  });

  it("6072-D1 ensure applies 0079 and lands the table, idempotently", async () => {
    const mock = new MockD1Database();
    const db = createD1ScreenerTaskStoreDb(mock as any);
    const applied = await ensureScreenerTaskEntriesSchema(db);
    expect(applied).toEqual([79]);
    const appliedAgain = await ensureScreenerTaskEntriesSchema(db);
    expect(appliedAgain).toEqual([]);
    const tables = mock.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_screener_task_entries'",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(["agent_screener_task_entries"]);
  });

  it("6072-D2 set/get/list/delete round-trips, with upsert overwrite", async () => {
    const mock = new MockD1Database();
    const store = new D1ScreenerTaskStore(createD1ScreenerTaskStoreDb(mock as any));
    await store.set("task:stask-1", JSON.stringify({ id: "stask-1", status: "queued" }));
    await store.set("idem:run-1", "stask-1");
    expect(await store.get("task:stask-1")).toBe(
      JSON.stringify({ id: "stask-1", status: "queued" }),
    );
    expect(await store.get("idem:run-1")).toBe("stask-1");
    expect(await store.get("task:missing")).toBeNull();
    const listed = await store.list("task:");
    expect(listed).toEqual([
      { key: "task:stask-1", value: JSON.stringify({ id: "stask-1", status: "queued" }) },
    ]);
    // Upsert: the ledger overwrites a record on every transition.
    await store.set("task:stask-1", JSON.stringify({ id: "stask-1", status: "running" }));
    expect(await store.get("task:stask-1")).toBe(
      JSON.stringify({ id: "stask-1", status: "running" }),
    );
    expect((await store.list("task:")).length).toBe(1);
    await store.delete("idem:run-1");
    expect(await store.get("idem:run-1")).toBeNull();
  });

  it("6072-D3 the stored rows carry the screener: namespace (DO parity)", async () => {
    const mock = new MockD1Database();
    const store = new D1ScreenerTaskStore(createD1ScreenerTaskStoreDb(mock as any));
    await store.set("task:stask-1", "{}");
    const rows = mock.sqlite
      .prepare("SELECT key FROM agent_screener_task_entries")
      .all() as Array<{ key: string }>;
    expect(rows.map((r) => r.key)).toEqual(["screener:task:stask-1"]);
  });

  it("6072-D4 the ledger's transitions run on the D1 store", async () => {
    const mock = new MockD1Database();
    const store = new D1ScreenerTaskStore(createD1ScreenerTaskStoreDb(mock as any));
    const ledger = new ScreenerTaskLedger(store, { newId: () => "stask-6072" });
    const created = await ledger.create({
      trigger: "manual",
      universe: "goal:directional",
      sector: "bullish",
      userLogin: "owner",
      idempotencyKey: "run-6072",
    });
    expect(created.created).toBe(true);
    expect(created.task.id).toBe("stask-6072");
    expect(created.task.status).toBe("queued");
    const claimed = await ledger.claim("stask-6072");
    expect(claimed.status).toBe("claimed");
    const started = await ledger.start("stask-6072");
    expect(started.status).toBe("running");
    const completed = await ledger.complete("stask-6072", {
      runTimestamp: new Date().toISOString(),
      totalScanned: 1,
      matchedCount: 1,
      opportunitiesCount: 1,
      partial: false,
      evaluation: { verdict: "pass", evaluatedAt: new Date().toISOString(), checks: [] },
    });
    expect(completed.status).toBe("completed");
    const tasks = await ledger.list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("stask-6072");
  });
});
