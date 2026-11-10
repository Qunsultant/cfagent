/**
 * Issue #3936 — index-backed universe presets.
 *
 * RED pins (written before the resolver change, each fails on pristine main):
 *
 * - `stock_copilot:universe = sp100 | sp500 | dow` resolved a 12-symbol
 *   hand-written array while the label claimed an index: the resolver must
 *   read that index's stored membership (`source: "stored-index"`), and a
 *   missing/stale/empty/unreadable list must yield the LABELLED fallback
 *   with a reason — never a silent subset wearing the index's name.
 * - The status surface resolved the sync preset, so it reported 12 symbols
 *   for a cycle that scanned 100. The status must report the resolution the
 *   cycle runs, with source, member count and snapshot date.
 * - `PRESET_UNIVERSES` kept a hand-written NASDAQ100/SP100 array that could
 *   drift from the index it claimed; the invariant pin below forbids it.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  INDEX_PRESETS,
  INDEX_PRESET_FALLBACKS,
  PRESET_UNIVERSES,
  SYMBOL_PRESETS,
  resolveCopilotUniverse,
  resolveCopilotUniverseFull,
} from "../src/services/stockCopilotConfiguration";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { SqlIndexListStore } from "../src/data/doSqliteIndexListAdapter";
import {
  controlStockCopilotViaDoor,
  getStockCopilotStatusViaDoor,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
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

const INDEX_PRESET_CASES = [
  { preset: "NASDAQ100", index: "nasdaq100" },
  { preset: "SP100", index: "sp100" },
  { preset: "SP500", index: "sp500" },
  { preset: "DOW", index: "dow" },
] as const;

function indexMembers(count: number): IndexMember[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: `IDX${String(i + 1).padStart(3, "0")}`,
    name: `Member ${i + 1}`,
  }));
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function presetReader(preset: string) {
  return (key: string) => (key === "stock_copilot:universe" ? preset : null);
}

describe("Issue #3936 — index presets resolve stored membership", () => {
  for (const { preset, index } of INDEX_PRESET_CASES) {
    it(`${preset} resolves the stored ${index} membership`, async () => {
      const store = new InMemoryIndexListStore();
      const snapshotDate = daysAgoIso(0);
      await store.store({
        index,
        snapshotDate,
        symbols: indexMembers(100),
        source: "wikipedia",
        sourceLabel: `Wikipedia ${preset}`,
        derivedFromHoldings: false,
      });

      const resolved = await resolveCopilotUniverseFull({
        readSettingRaw: presetReader(preset),
        env: {} as unknown as Env,
        indexListStore: store,
      });

      expect(resolved.source).toBe("stored-index");
      expect(resolved.preset).toBe(preset);
      expect(resolved.index).toBe(index);
      expect(resolved.symbols).toHaveLength(100);
      expect(resolved.snapshotDate).toBe(snapshotDate);
      expect(resolved.reason).toBeNull();
    });

    it(`${preset} falls back to its labelled preset when no list is stored`, async () => {
      const resolved = await resolveCopilotUniverseFull({
        readSettingRaw: presetReader(preset),
        env: {} as unknown as Env,
        indexListStore: new InMemoryIndexListStore(),
      });

      expect(resolved.source).toBe("preset-fallback");
      expect(resolved.preset).toBe(preset);
      expect(resolved.index).toBe(index);
      expect(resolved.symbols).toEqual([...INDEX_PRESET_FALLBACKS[preset]]);
      expect(resolved.reason).toContain(index);
      expect(resolved.reason).toMatch(/no stored index list/i);
    });
  }

  it("a stale list falls back with stale=true and the snapshot date", async () => {
    const store = new InMemoryIndexListStore();
    const snapshotDate = daysAgoIso(30);
    await store.store({
      index: "sp500",
      snapshotDate,
      symbols: indexMembers(100),
      source: "wikipedia",
      sourceLabel: "Wikipedia S&P 500",
      derivedFromHoldings: false,
    });

    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: presetReader("SP500"),
      env: {} as unknown as Env,
      indexListStore: store,
    });

    expect(resolved.source).toBe("preset-fallback");
    expect(resolved.stale).toBe(true);
    expect(resolved.snapshotDate).toBe(snapshotDate);
    expect(resolved.symbols).toEqual([...INDEX_PRESET_FALLBACKS.SP500]);
    expect(resolved.reason).toMatch(/stale/i);
  });

  it("an empty list falls back and names emptiness, not freshness", async () => {
    const store = new InMemoryIndexListStore();
    await store.store({
      index: "dow",
      snapshotDate: daysAgoIso(0),
      symbols: [],
      source: "wikipedia",
      sourceLabel: "Wikipedia DJIA",
      derivedFromHoldings: false,
    });

    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: presetReader("DOW"),
      env: {} as unknown as Env,
      indexListStore: store,
    });

    expect(resolved.source).toBe("preset-fallback");
    expect(resolved.symbols).toEqual([...INDEX_PRESET_FALLBACKS.DOW]);
    expect(resolved.reason).toMatch(/empty/i);
  });

  it("an unreadable store falls back with the failure named", async () => {
    const throwingStore = {
      async latest(): Promise<never> {
        throw new Error("sqlite exploded");
      },
      async store(): Promise<never> {
        throw new Error("sqlite exploded");
      },
    };

    const resolved = await resolveCopilotUniverseFull({
      readSettingRaw: presetReader("NASDAQ100"),
      env: {} as unknown as Env,
      indexListStore: throwingStore as never,
    });

    expect(resolved.source).toBe("preset-fallback");
    expect(resolved.symbols).toEqual([...INDEX_PRESET_FALLBACKS.NASDAQ100]);
    expect(resolved.reason).toContain("sqlite exploded");
  });

  it("sync and async agree when there is no stored list (one pin, both paths)", async () => {
    for (const { preset } of INDEX_PRESET_CASES) {
      const syncSymbols = resolveCopilotUniverse({
        readSettingRaw: presetReader(preset),
        env: {} as unknown as Env,
      });
      const asyncResolution = await resolveCopilotUniverseFull({
        readSettingRaw: presetReader(preset),
        env: {} as unknown as Env,
        indexListStore: null,
      });

      expect(asyncResolution.source).toBe("preset-fallback");
      expect(asyncResolution.symbols).toEqual(syncSymbols);
    }
  });

  it("a symbol preset stays configured and never reads the index store", async () => {
    const throwingStore = {
      async latest(): Promise<never> {
        throw new Error("store must not be read for MEGA_TECH");
      },
      async store(): Promise<never> {
        throw new Error("store must not be written");
      },
    };

    for (const preset of ["MEGA_TECH", "SEMIS"]) {
      const resolved = await resolveCopilotUniverseFull({
        readSettingRaw: presetReader(preset),
        env: {} as unknown as Env,
        indexListStore: throwingStore as never,
      });

      expect(resolved.source).toBe("configured");
      expect(resolved.index).toBeNull();
      expect(resolved.symbols).toEqual([...SYMBOL_PRESETS[preset]]);
    }

    const explicit = await resolveCopilotUniverseFull({
      readSettingRaw: presetReader("aapl, msft"),
      env: {} as unknown as Env,
      indexListStore: throwingStore as never,
    });
    expect(explicit.source).toBe("configured");
    expect(explicit.symbols).toEqual(["AAPL", "MSFT"]);
  });

  it("the status surface reports the resolution the cycle runs", async () => {
    const sql = new SqliteTestStorage();
    const listStore = new SqlIndexListStore(sql as never);
    const snapshotDate = daysAgoIso(0);
    await listStore.store({
      index: "sp500",
      snapshotDate,
      symbols: indexMembers(100),
      source: "wikipedia",
      sourceLabel: "Wikipedia S&P 500",
      derivedFromHoldings: false,
    });

    const settings = new Map<string, string>([
      ["stock_copilot:universe", "SP500"],
    ]);
    const ctx = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "true" } as unknown as Env,
      sql: sql as never,
      readSettingRaw: (key: string) => settings.get(key) ?? null,
      writeSetting: (key: string, value: string) => {
        settings.set(key, value);
      },
    };

    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.universeSource).toBe("stored-index");
    expect(status.universePreset).toBe("SP500");
    expect(status.universe).toHaveLength(100);
    expect(status.universeSnapshotDate).toBe(snapshotDate);
    expect(status.universeFallbackReason).toBeNull();

    const control = await controlStockCopilotViaDoor(ctx, "owner", {});
    expect(control.universeSource).toBe("stored-index");
    expect(control.universePreset).toBe("SP500");
    expect(control.universe).toHaveLength(100);
  });

  it("the status surface names the fallback when no list exists", async () => {
    const sql = new SqliteTestStorage();
    const settings = new Map<string, string>([["stock_copilot:universe", "DOW"]]);
    const ctx = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "true" } as unknown as Env,
      sql: sql as never,
      readSettingRaw: (key: string) => settings.get(key) ?? null,
      writeSetting: (key: string, value: string) => {
        settings.set(key, value);
      },
    };

    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.universeSource).toBe("preset-fallback");
    expect(status.universePreset).toBe("DOW");
    expect(status.universe).toEqual([...INDEX_PRESET_FALLBACKS.DOW]);
    expect(status.universeFallbackReason).toMatch(/no stored index list/i);
  });

  it("no preset claims an index name while shipping a hand-written subset", () => {
    for (const [preset, index] of Object.entries(INDEX_PRESETS)) {
      expect(PRESET_UNIVERSES[preset]).toEqual(INDEX_PRESET_FALLBACKS[preset]);
      // A fallback is a labelled stand-in, never a claim of full membership.
      expect(PRESET_UNIVERSES[preset].length).toBeLessThan(100);
      expect(PRESET_UNIVERSES[preset].length).toBeLessThanOrEqual(20);
      expect(index.length).toBeGreaterThan(0);
    }

    const indexPresetKeys = new Set(Object.keys(INDEX_PRESETS));
    for (const key of Object.keys(PRESET_UNIVERSES)) {
      if (indexPresetKeys.has(key)) continue;
      expect(Object.values(INDEX_PRESETS)).not.toContain(key.toLowerCase());
    }
  });
});
