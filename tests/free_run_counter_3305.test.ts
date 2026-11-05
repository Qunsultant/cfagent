// @vitest-environment node
/**
 * Issue #3305 (sub-issue of #3241) — free-run counter port.
 *
 * The decided Free allowance (10 runs per product per UTC
 * calendar month, operator-managed, changeable) as durable
 * D1 state: migrations 0043 (tables) + 0044 (seed rows), the
 * port contract (month key, allowance read/change, consume
 * increments, cap, monthly reset), and the D1 adapter
 * round-trip. The gate's use of the counter lives in
 * tests/native_monetization_gate.test.ts. The seed value lives
 * only as migration 0044's rows — no code constant holds it
 * (#3315); the in-memory fixture below passes its allowances
 * explicitly for exactly that reason.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  ALL_MIGRATIONS,
  MIGRATION_0043_FREE_RUN_COUNTER,
  MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import {
  agentFreeRunAllowances,
  agentFreeRunCounts,
} from "../src/data/drizzleSchema";
import {
  freeRunMonthKey,
  type FreeRunCounter,
} from "../src/data/freeRunCounterPorts";
import {
  createD1FreeRunCounterDb,
  D1FreeRunCounterAdapter,
  ensureFreeRunCounterSchema,
} from "../src/data/d1FreeRunCounterAdapter";
import { InMemoryFreeRunCounterAdapter } from "../src/data/inMemoryFreeRunCounterAdapter";

const NOV_15 = Date.UTC(2026, 10, 15, 12, 0, 0);
const NOV_30_LATE = Date.UTC(2026, 10, 30, 23, 59, 59);
const DEC_1 = Date.UTC(2026, 11, 1, 0, 0, 0);

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
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
}

describe("free-run counter: month key (#3305)", () => {
  it("is the UTC calendar month, YYYY-MM, with the boundary at 00:00 UTC", () => {
    expect(freeRunMonthKey(NOV_15)).toBe("2026-11");
    expect(freeRunMonthKey(NOV_30_LATE)).toBe("2026-11");
    expect(freeRunMonthKey(DEC_1)).toBe("2026-12");
    expect(freeRunMonthKey(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01");
  });
});

describe("free-run counter: migration 0044 seed rows (#3315)", () => {
  it("is registered (position-independent containment)", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED);
    expect(MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED.version).toBe(44);
    expect(MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED.name).toBe("0044_free_run_allowance_seed");
  });

  it("seeds every family with INSERT OR IGNORE (operator edits survive)", () => {
    const sql = MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED.sql;
    expect(sql).toContain("INSERT OR IGNORE INTO agent_free_run_allowances");
    for (const family of ["stock", "goal", "options", "strategy"]) {
      expect(sql).toContain(`('${family}', 10, 0)`);
    }
  });
});

describe("free-run counter: migration 0043 registration", () => {
  it("is registered (position-independent containment)", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0043_FREE_RUN_COUNTER);
    expect(MIGRATION_0043_FREE_RUN_COUNTER.version).toBe(43);
    expect(MIGRATION_0043_FREE_RUN_COUNTER.name).toBe("0043_free_run_counter");
  });

  it("DDL and the Drizzle schema agree on tables and columns", () => {
    expect(MIGRATION_0043_FREE_RUN_COUNTER.sql).toContain("agent_free_run_allowances");
    expect(MIGRATION_0043_FREE_RUN_COUNTER.sql).toContain("agent_free_run_counts");
    const allowanceColumns = Object.keys(getTableColumns(agentFreeRunAllowances));
    expect(allowanceColumns).toEqual(["family", "runs", "updatedAtMs"]);
    const countColumns = Object.keys(getTableColumns(agentFreeRunCounts));
    expect(countColumns).toEqual(["userLogin", "family", "month", "used", "updatedAtMs"]);
  });
});

async function consumeTimes(
  counter: FreeRunCounter,
  n: number,
  input: { login: string; family: string; month: string },
): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    out.push((await counter.consumeFreeRun(input)).allowed);
  }
  return out;
}

interface CounterFixture {
  counter: FreeRunCounter;
  setup?: () => Promise<unknown>;
}

describe.each([
  // The in-memory adapter starts empty (#3315: no hardcoded
  // defaults), so the fixture passes the decided allowances
  // explicitly; the D1 fixture seeds them via migration 0044.
  ["in-memory", (): CounterFixture => ({ counter: new InMemoryFreeRunCounterAdapter({ stock: 10, goal: 10, options: 10, strategy: 10 }) })],
  [
    "D1",
    (): CounterFixture => {
      const mock = new MockD1Database();
      const db = createD1FreeRunCounterDb(mock as unknown as D1Database);
      return { counter: new D1FreeRunCounterAdapter(db), setup: () => ensureFreeRunCounterSchema(db) };
    },
  ],
])("free-run counter: port contract (%s)", (_label, make) => {
  it("seeds the allowance at 10 per family and reads 0 used for a fresh account", async () => {
    const { counter, setup } = make();
    if (setup) await setup();
    expect(await counter.getAllowance("goal")).toBe(10);
    expect(await counter.getAllowance("stock")).toBe(10);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(0);
  });

  it("consumes up to the allowance, then blocks at the cap without writing", async () => {
    const { counter, setup } = make();
    if (setup) await setup();
    const input = { login: "u1", family: "goal", month: "2026-11" };
    expect(await consumeTimes(counter, 10, input)).toEqual(Array(10).fill(true));
    expect(await counter.getUsed(input)).toBe(10);
    expect(await counter.consumeFreeRun(input)).toEqual({ allowed: false, used: 10, allowance: 10 });
    expect(await counter.getUsed(input)).toBe(10);
  });

  it("counts per login, per family, per month — never across them", async () => {
    const { counter, setup } = make();
    if (setup) await setup();
    await counter.consumeFreeRun({ login: "u1", family: "goal", month: "2026-11" });
    await counter.consumeFreeRun({ login: "u1", family: "goal", month: "2026-11" });
    await counter.consumeFreeRun({ login: "u1", family: "stock", month: "2026-11" });
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-11" })).toBe(2);
    expect(await counter.getUsed({ login: "u1", family: "stock", month: "2026-11" })).toBe(1);
    expect(await counter.getUsed({ login: "u2", family: "goal", month: "2026-11" })).toBe(0);
    expect(await counter.getUsed({ login: "u1", family: "goal", month: "2026-12" })).toBe(0);
  });

  it("the allowance is operator-changeable without code", async () => {
    const { counter, setup } = make();
    if (setup) await setup();
    await counter.setAllowance({ family: "goal", runs: 2 });
    expect(await counter.getAllowance("goal")).toBe(2);
    const input = { login: "u1", family: "goal", month: "2026-11" };
    expect(await consumeTimes(counter, 3, input)).toEqual([true, true, false]);
    expect(await counter.getAllowance("stock")).toBe(10);
  });

  it("rejects an invalid family and an invalid allowance", async () => {
    const { counter, setup } = make();
    if (setup) await setup();
    await expect(counter.getUsed({ login: "u1", family: "nope", month: "2026-11" })).rejects.toThrow(
      /Invalid price family/,
    );
    await expect(counter.setAllowance({ family: "goal", runs: -1 })).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(counter.setAllowance({ family: "goal", runs: 1.5 })).rejects.toThrow(
      /non-negative integer/,
    );
  });
});

describe("free-run counter: no allowance configured (fail-closed)", () => {
  it("an empty counter reads null and consumes nothing", async () => {
    const empty = new InMemoryFreeRunCounterAdapter({});
    expect(await empty.getAllowance("goal")).toBeNull();
    expect(await empty.consumeFreeRun({ login: "u1", family: "goal", month: "2026-11" })).toEqual({
      allowed: false,
      used: 0,
      allowance: null,
    });
  });
});

describe("free-run counter: D1 ensure", () => {
  it("creates both tables and seeds allowances without overwriting an operator edit", async () => {
    const mock = new MockD1Database();
    const db = createD1FreeRunCounterDb(mock as unknown as D1Database);
    await ensureFreeRunCounterSchema(db);
    const tables = mock.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_free_run%'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["agent_free_run_allowances", "agent_free_run_counts"]);
    const counter = new D1FreeRunCounterAdapter(db);
    expect(await counter.getAllowance("goal")).toBe(10);
    // An operator edit survives re-ensure (INSERT OR IGNORE seeding).
    await counter.setAllowance({ family: "goal", runs: 25 });
    await ensureFreeRunCounterSchema(db);
    expect(await counter.getAllowance("goal")).toBe(25);
    // The ensure applies migrations 0043+0044 through the shared runner.
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0043_FREE_RUN_COUNTER,
      MIGRATION_0044_FREE_RUN_ALLOWANCE_SEED,
    ]);
  });
});
