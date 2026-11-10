/**
 * Issue #4027 — the introspection surface reports the universe resolution the
 * cycle runs, not the sync preset.
 *
 * Before this, a copilot configured with an index preset described 12
 * hand-picked symbols (or a bare preset name) while the cycle scanned the
 * stored membership; the status surface was fixed in #3936, the introspection
 * surface kept the sync read because its deps carried no SQL executor.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { introspectStockCopilot } from "../src/services/stockCopilotIntrospection";
import {
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import { SqlIndexListStore } from "../src/data/doSqliteIndexListAdapter";
import type { IndexMember } from "../src/trading";
import type { Env } from "../src/types";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
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

function members(count: number): IndexMember[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: `N${String(i + 1).padStart(3, "0")}`,
  }));
}

function deps(sql: SqliteTestStorage, universeSetting: string, withSql = true) {
  const positionPort = createStockCopilotPositionPort(sql as never);
  const activityPort = createStockCopilotActivityPort(sql as never);
  const controlPort = createStockCopilotControlPort(sql as never);
  positionPort.ensureSchema?.();
  activityPort.ensureSchema?.();
  controlPort.ensureSchema?.();
  return {
    env: {} as unknown as Env,
    userLogin: "owner@example.com",
    readSettingRaw: (key: string) =>
      key === "stock_copilot:universe" ? universeSetting : null,
    positionPort,
    activityPort,
    controlPort,
    commercial: null,
    ...(withSql ? { sql } : {}),
  };
}

describe("Issue #4027 — introspection universe parity", () => {
  it("reports the stored index membership with its snapshot date", async () => {
    const sql = new SqliteTestStorage();
    const snapshotDate = new Date().toISOString().slice(0, 10);
    await new SqlIndexListStore(sql as never).store({
      index: "nasdaq100",
      snapshotDate,
      symbols: members(100),
      source: "wikipedia",
      sourceLabel: "Wikipedia NASDAQ-100",
      derivedFromHoldings: false,
    });

    const result = await introspectStockCopilot(deps(sql, "NASDAQ100"));

    expect(result.configuration.universeSource).toBe("stored-index");
    expect(result.configuration.universePreset).toBe("NASDAQ100");
    expect(result.configuration.universe).toHaveLength(100);
    expect(result.configuration.universeSnapshotDate).toBe(snapshotDate);
    expect(result.configuration.universeFallbackReason).toBeNull();
  });

  it("names the labelled fallback when no stored list exists", async () => {
    const sql = new SqliteTestStorage();
    const result = await introspectStockCopilot(deps(sql, "SP500"));

    expect(result.configuration.universeSource).toBe("preset-fallback");
    expect(result.configuration.universePreset).toBe("SP500");
    expect(result.configuration.universe).toEqual(["SPY"]);
    expect(result.configuration.universeFallbackReason).toMatch(/no stored index list/i);
  });

  it("keeps the sync preset read when no SQL is supplied", async () => {
    const sql = new SqliteTestStorage();
    const result = await introspectStockCopilot(deps(sql, "NASDAQ100", false));

    expect(result.configuration.universeSource).toBeUndefined();
    expect(result.configuration.universePreset).toBe("NASDAQ100");
    expect(result.configuration.universe.length).toBeGreaterThan(0);
  });
});
