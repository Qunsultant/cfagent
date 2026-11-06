/**
 * Issue #3422 — Stock Copilot chat-tab surface: data-layer + cycle pins.
 *
 * Pins:
 * - The extended port family (closed positions listable, bounded
 *   cycle-activity log, per-instance pause control) behaves
 *   identically over the in-memory and DO-SQLite adapters.
 * - The cycle respects the pause control: paused ⇒ exits still
 *   evaluated, entries blocked, and the paused firing is NOT
 *   recorded as a cycle.
 * - Cycles that evaluate the market write exactly one activity
 *   record — traded (entries/exits with symbols + exit reasons),
 *   no-trade (with its reason), and guard-refusal outcomes.
 *   Outside-hours and flag-off firings write none.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotControlPort,
  createInMemoryStockCopilotPositionPort,
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
  createStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import {
  COPILOT_ACTIVITY_RETENTION,
  type CopilotPositionRecord,
  type StockCopilotActivityPort,
  type StockCopilotControlPort,
  type StockCopilotPositionPort,
} from "../src/data/stockCopilotStorePorts";
import {
  runStockCopilotCycle,
  STOCK_COPILOT_MODE_MISMATCH,
  type StockCopilotDeps,
} from "../src/services/stockCopilot";
import { StockCopilotPositionStore } from "../src/services/stockCopilotStore";

/** Minimal SqlStorage shim over node:sqlite (same shape as #2528's harness). */
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

interface PortFamily {
  positions: StockCopilotPositionPort;
  activity: StockCopilotActivityPort;
  control: StockCopilotControlPort;
}

function memoryFamily(): PortFamily {
  return {
    positions: createInMemoryStockCopilotPositionPort(),
    activity: createInMemoryStockCopilotActivityPort(),
    control: createInMemoryStockCopilotControlPort(),
  };
}

function doFamily(): PortFamily {
  const sql = new SqliteTestStorage() as never;
  return {
    positions: createStockCopilotPositionPort(sql),
    activity: createStockCopilotActivityPort(sql),
    control: createStockCopilotControlPort(sql),
  };
}

function positionRecord(overrides: Partial<CopilotPositionRecord>): CopilotPositionRecord {
  return {
    id: "pos-1",
    userLogin: "owner",
    symbol: "TEST",
    strategy: "mean_reversion",
    quantity: 10,
    entryPrice: 100,
    stopPrice: 95,
    targetPrice: 110,
    brokerOrderRef: "alpaca-entry",
    status: "open",
    openedAt: "2026-11-04T14:00:00.000Z",
    closedAt: null,
    exitBrokerOrderRef: null,
    exitPrice: null,
    exitReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Port family behavior — identical over both adapters
// ---------------------------------------------------------------------------

describe.each([
  ["in-memory", memoryFamily],
  ["do-sqlite", doFamily],
])("copilot surface ports (%s)", (_name, makeFamily) => {
  it("control record round-trips and overwrites (absent ⇒ null)", () => {
    const { control } = makeFamily();
    control.ensureSchema();
    expect(control.getControl("owner")).toBeNull();
    control.setControl({
      userLogin: "owner",
      paused: true,
      updatedAt: "2026-11-04T15:00:00.000Z",
      updatedBy: "owner",
    });
    expect(control.getControl("owner")).toEqual({
      userLogin: "owner",
      paused: true,
      updatedAt: "2026-11-04T15:00:00.000Z",
      updatedBy: "owner",
    });
    control.setControl({
      userLogin: "owner",
      paused: false,
      updatedAt: "2026-11-04T15:30:00.000Z",
      updatedBy: "owner",
    });
    expect(control.getControl("owner")?.paused).toBe(false);
    // Per-login scoping: another login has no record.
    expect(control.getControl("other")).toBeNull();
  });

  it("closed positions are listable, newest close first, scoped per login", () => {
    const { positions } = makeFamily();
    positions.ensureSchema();
    positions.insertPosition(positionRecord({ id: "p1", symbol: "AAA" }));
    positions.insertPosition(positionRecord({ id: "p2", symbol: "BBB" }));
    positions.insertPosition(positionRecord({ id: "p3", symbol: "CCC", userLogin: "other" }));
    positions.closePosition("p1", {
      exitBrokerOrderRef: "alpaca-exit-1",
      exitPrice: 103,
      exitReason: "strategy_exit",
      closedAt: "2026-11-04T15:00:00.000Z",
    });
    positions.closePosition("p2", {
      exitBrokerOrderRef: "alpaca-exit-2",
      exitPrice: 94,
      exitReason: "stop_loss",
      closedAt: "2026-11-04T16:00:00.000Z",
    });
    const closed = positions.listClosedPositions("owner", 10);
    expect(closed.map((p) => p.symbol)).toEqual(["BBB", "AAA"]);
    expect(closed[0]).toMatchObject({ status: "closed", exitReason: "stop_loss", exitPrice: 94 });
    expect(closed[1]).toMatchObject({ status: "closed", exitReason: "strategy_exit" });
    expect(positions.listOpenPositions("owner")).toEqual([]);
    // The limit applies.
    expect(positions.listClosedPositions("owner", 1)).toHaveLength(1);
  });

  it("activity log lists newest first and round-trips entries/exits/detail", () => {
    const { activity } = makeFamily();
    activity.ensureSchema();
    activity.appendActivity({
      id: "a1",
      userLogin: "owner",
      cycleAt: "2026-11-04T15:00:00.000Z",
      outcome: "no_trade",
      entries: [],
      exits: [],
      detail: "no_entry_signals",
    });
    activity.appendActivity({
      id: "a2",
      userLogin: "owner",
      cycleAt: "2026-11-04T15:30:00.000Z",
      outcome: "traded",
      entries: ["TEST"],
      exits: [{ symbol: "OLD", reason: "take_profit" }],
      detail: null,
    });
    const listed = activity.listActivity("owner", 10);
    expect(listed.map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(listed[0]).toMatchObject({
      outcome: "traded",
      entries: ["TEST"],
      exits: [{ symbol: "OLD", reason: "take_profit" }],
      detail: null,
    });
    expect(listed[1]).toMatchObject({ outcome: "no_trade", detail: "no_entry_signals" });
    expect(activity.listActivity("other", 10)).toEqual([]);
  });

  it("activity retention keeps only the newest ~100 records per login", () => {
    const { activity } = makeFamily();
    activity.ensureSchema();
    const total = COPILOT_ACTIVITY_RETENTION + 5;
    for (let i = 0; i < total; i++) {
      activity.appendActivity({
        id: `a${i}`,
        userLogin: "owner",
        cycleAt: new Date(Date.UTC(2026, 10, 4, 15, 0, i)).toISOString(),
        outcome: "no_trade",
        entries: [],
        exits: [],
        detail: "no_entry_signals",
      });
    }
    const listed = activity.listActivity("owner", total + 10);
    expect(listed).toHaveLength(COPILOT_ACTIVITY_RETENTION);
    // The oldest five were pruned; the newest record is retained.
    expect(listed[0].id).toBe(`a${total - 1}`);
    expect(listed.map((r) => r.id)).not.toContain("a0");
    expect(listed.map((r) => r.id)).not.toContain("a4");
  });
});

// ---------------------------------------------------------------------------
// Cycle: pause control + activity records
// ---------------------------------------------------------------------------

interface FakePlatform {
  platform: any;
  placed: Array<Record<string, unknown>>;
}

function createFakePlatform(): FakePlatform {
  const placed: Array<Record<string, unknown>> = [];
  const platform = {
    platformId: "alpaca",
    name: "Alpaca (fake)",
    async getPositions() {
      return { account: { netAccountValue: 100_000, totalAccountValue: 100_000 }, positions: [] };
    },
    async getQuote(symbol: string) {
      return { symbol, lastPrice: 500 };
    },
    async placeOrderRemote(params: Record<string, unknown>) {
      placed.push(params);
      return {
        success: true,
        orderId: params.orderId,
        executionId: `alpaca-${placed.length}`,
        brokerOrderRef: `alpaca-${placed.length}`,
        status: "submitted",
        symbol: params.symbol,
        action: params.action,
        quantity: params.quantity,
        executionPrice: 0,
        totalSettled: 0,
        message: "submitted (fake)",
        timestamp: new Date().toISOString(),
      };
    },
  };
  return { platform, placed };
}

/** A Wednesday inside market hours (15:00 UTC = 10:00 ET, EST). */
const MARKET_OPEN_NOW = () => new Date("2026-11-04T15:00:00Z");
/** A Saturday — market closed all day. */
const MARKET_CLOSED_NOW = () => new Date("2026-11-07T15:00:00Z");

/** Sawtooth series whose latest bar is a mean-reversion entry signal. */
function sawtoothCloses(): number[] {
  const closes: number[] = [];
  for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
  closes.push(100, 98);
  return closes;
}

/** Held-position series whose latest bar triggers the strategy exit. */
const EXIT_CLOSES = [...Array.from({ length: 15 }, () => 99), 101];

function surfaceDeps(overrides: Partial<StockCopilotDeps>): StockCopilotDeps {
  const family = memoryFamily();
  return {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    positions: family.positions,
    activity: family.activity,
    control: family.control,
    userLogin: "owner",
    platform: createFakePlatform().platform,
    // #3451: the resolved selection (Alpaca active, paper mode).
    selection: {
      resolved: true,
      selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
    },
    loadBars: async () => sawtoothCloses(),
    now: MARKET_OPEN_NOW,
    ...overrides,
  };
}

describe("stock copilot cycle — pause + activity (#3422)", () => {
  it("paused: exits still evaluated, entries blocked, status paused, NO activity record", async () => {
    const family = memoryFamily();
    const store = new StockCopilotPositionStore(family.positions);
    await store.openPosition({
      userLogin: "owner",
      symbol: "TEST",
      strategy: "mean_reversion",
      quantity: 10,
      entryPrice: 98,
      stopPrice: 93.1,
      targetPrice: 107.8,
      brokerOrderRef: "alpaca-entry",
    });
    family.control.ensureSchema();
    family.control.setControl({
      userLogin: "owner",
      paused: true,
      updatedAt: "2026-11-04T14:59:00.000Z",
      updatedBy: "owner",
    });
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      surfaceDeps({
        positions: family.positions,
        activity: family.activity,
        control: family.control,
        platform: fake.platform,
        universe: ["NEW", "TEST"],
        strategies: ["mean_reversion"],
        loadBars: async (symbol: string) => (symbol === "TEST" ? EXIT_CLOSES : sawtoothCloses()),
      }),
    );
    expect(result.status).toBe("paused");
    // The held position's exit still fired (capital protection).
    expect(result.exitsPlaced).toBe(1);
    expect(fake.placed).toHaveLength(1);
    expect(fake.placed[0]).toMatchObject({ symbol: "TEST", action: "SELL" });
    // The fresh entry signal on NEW was NOT traded.
    expect(result.entriesPlaced).toBe(0);
    expect(fake.placed.some((p) => p.action === "BUY")).toBe(false);
    // A paused firing is not recorded as a cycle.
    expect(family.activity.listActivity("owner", 10)).toEqual([]);
  });

  it("resume: clearing the pause restores entries on the next cycle", async () => {
    const family = memoryFamily();
    family.control.ensureSchema();
    family.control.setControl({
      userLogin: "owner",
      paused: true,
      updatedAt: "2026-11-04T14:59:00.000Z",
      updatedBy: "owner",
    });
    const fake = createFakePlatform();
    const deps = surfaceDeps({
      positions: family.positions,
      activity: family.activity,
      control: family.control,
      platform: fake.platform,
      universe: ["TEST"],
      strategies: ["mean_reversion"],
    });
    const pausedRun = await runStockCopilotCycle(deps);
    expect(pausedRun.status).toBe("paused");
    expect(pausedRun.entriesPlaced).toBe(0);

    family.control.setControl({
      userLogin: "owner",
      paused: false,
      updatedAt: "2026-11-04T15:29:00.000Z",
      updatedBy: "owner",
    });
    const resumed = await runStockCopilotCycle(deps);
    expect(resumed.status).toBe("ok");
    expect(resumed.entriesPlaced).toBe(1);
    expect(fake.placed.some((p) => p.action === "BUY" && p.symbol === "TEST")).toBe(true);
  });

  it("traded cycle writes exactly one activity record with the entered symbols", async () => {
    const family = memoryFamily();
    const result = await runStockCopilotCycle(
      surfaceDeps({
        positions: family.positions,
        activity: family.activity,
        control: family.control,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(1);
    const records = family.activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "traded",
      entries: ["TEST"],
      exits: [],
      detail: null,
    });
    expect(records[0].cycleAt).toBe("2026-11-04T15:00:00.000Z");
  });

  it("exit cycle records the exit with its reason in the activity record", async () => {
    const family = memoryFamily();
    const store = new StockCopilotPositionStore(family.positions);
    await store.openPosition({
      userLogin: "owner",
      symbol: "TEST",
      strategy: "mean_reversion",
      quantity: 10,
      entryPrice: 98,
      stopPrice: 93.1,
      targetPrice: 107.8,
      brokerOrderRef: "alpaca-entry",
    });
    const result = await runStockCopilotCycle(
      surfaceDeps({
        positions: family.positions,
        activity: family.activity,
        control: family.control,
        universe: [],
        loadBars: async () => EXIT_CLOSES,
      }),
    );
    expect(result.exitsPlaced).toBe(1);
    const records = family.activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "traded",
      entries: [],
      exits: [{ symbol: "TEST", reason: "strategy_exit" }],
    });
  });

  it("no-trade cycle writes a no_trade record carrying the reason", async () => {
    const family = memoryFamily();
    const result = await runStockCopilotCycle(
      surfaceDeps({
        positions: family.positions,
        activity: family.activity,
        control: family.control,
        universe: ["TEST"],
        strategies: ["mean_reversion", "sma_crossover"],
        loadBars: async () => Array.from({ length: 40 }, () => 100),
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(0);
    const records = family.activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("no_trade");
    expect(records[0].entries).toEqual([]);
    expect(typeof records[0].detail).toBe("string");
    expect((records[0].detail ?? "").length).toBeGreaterThan(0);
  });

  it("guard refusal writes a refused activity record naming the refusal", async () => {
    const family = memoryFamily();
    const result = await runStockCopilotCycle(
      surfaceDeps({
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          ALPACA_TRADING_TYPE: "live",
        } as any,
        positions: family.positions,
        activity: family.activity,
        control: family.control,
      }),
    );
    expect(result.status).toBe("refused_mode_mismatch");
    const records = family.activity.listActivity("owner", 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "refused", detail: STOCK_COPILOT_MODE_MISMATCH });
  });

  it("outside-hours and flag-off firings write no activity record", async () => {
    const family = memoryFamily();
    const closed = await runStockCopilotCycle(
      surfaceDeps({
        positions: family.positions,
        activity: family.activity,
        control: family.control,
        now: MARKET_CLOSED_NOW,
      }),
    );
    expect(closed.status).toBe("skipped_outside_market_hours");
    const disabled = await runStockCopilotCycle(
      surfaceDeps({
        env: {} as any,
        positions: family.positions,
        activity: family.activity,
        control: family.control,
      }),
    );
    expect(disabled.status).toBe("disabled");
    expect(family.activity.listActivity("owner", 10)).toEqual([]);
  });

  it("the host composition (DO ports over one sql handle) carries a full cycle", async () => {
    const family = doFamily();
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      surfaceDeps({
        positions: family.positions,
        activity: family.activity,
        control: family.control,
        platform: fake.platform,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.entriesPlaced).toBe(1);
    expect(family.activity.listActivity("owner", 10)).toHaveLength(1);
    expect(family.positions.listOpenPositions("owner")).toHaveLength(1);
  });
});
