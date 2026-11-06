/**
 * Issue #3391 — Stock Copilot v1 (Alpaca paper loop).
 *
 * Pins:
 * - patternSignals reproduces the sandbox strategy set's rules exactly
 *   (the sandbox backtest's own outputs are the parity baseline,
 *   captured from the pre-extraction implementation).
 * - The copilot cycle: mode guard (#3451 — the resolved selection
 *   governs; a contradicting pin refuses), flag-off no-op, entry ⇒
 *   tracked position WITH exit plan, exit evaluation, sizing refusal,
 *   no-signal ⇒ no orders.
 * - The scheduled-task declaration gates on the flag + instance login.
 */
import { describe, it, expect } from "vitest";
import { createInMemoryStockCopilotPositionPort } from "../src/data/createStockCopilotStorePorts";
import {
  evaluateLatestPatternSignal,
  evaluatePatternSignalAt,
} from "../src/services/patternSignals";
import { ETradeSandboxService } from "../src/services/sandboxAgent";
import {
  isStockCopilotPaperEnabled,
  runStockCopilotCycle,
  STOCK_COPILOT_MODE_MISMATCH,
  type StockCopilotDeps,
} from "../src/services/stockCopilot";
import { StockCopilotPositionStore } from "../src/services/stockCopilotStore";
import { COPILOT_SESSIONS } from "../src/services/stockCopilotSessions";
import { declareStockCopilotTasks } from "../src/agents/orchestrator/scheduledTasksCopilot";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakePlatform {
  platform: any;
  placed: Array<Record<string, unknown>>;
  calls: { getPositions: number; getQuote: number; placeOrderRemote: number };
}

function createFakePlatform(opts?: { nav?: number }): FakePlatform {
  const placed: Array<Record<string, unknown>> = [];
  const calls = { getPositions: 0, getQuote: 0, placeOrderRemote: 0 };
  const platform = {
    platformId: "alpaca",
    name: "Alpaca (fake)",
    async getPositions() {
      calls.getPositions += 1;
      return {
        account: { netAccountValue: opts?.nav ?? 100_000, totalAccountValue: opts?.nav ?? 100_000 },
        positions: [],
      };
    },
    async getQuote(symbol: string) {
      calls.getQuote += 1;
      return { symbol, lastPrice: 500 };
    },
    async placeOrderRemote(params: Record<string, unknown>) {
      calls.placeOrderRemote += 1;
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
  return { platform, placed, calls };
}

/** A Wednesday inside market hours (15:00 UTC = 10:00 ET, EST). */
const MARKET_OPEN_NOW = () => new Date("2026-11-04T15:00:00Z");
/** A Saturday — market closed all day. */
const MARKET_CLOSED_NOW = () => new Date("2026-11-07T15:00:00Z");

/** Sawtooth series the mean-reversion family trades profitably in-series:
 *  dips to 98 (entry) recover to 101 (its +3% exit), repeatedly; the final
 *  two bars open a fresh dip so the latest bar is an entry signal. */
function sawtoothCloses(): number[] {
  const closes: number[] = [];
  for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
  closes.push(100, 98);
  return closes;
}

function baseDeps(overrides: Partial<StockCopilotDeps>): StockCopilotDeps {
  return {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    positions: createInMemoryStockCopilotPositionPort(),
    userLogin: "owner",
    platform: createFakePlatform().platform,
    // #3451: the resolved selection (Alpaca active, paper mode) —
    // the full mode matrix lives in stock_copilot_modes_3451.test.ts.
    selection: {
      resolved: true,
      selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
    },
    loadBars: async () => sawtoothCloses(),
    now: MARKET_OPEN_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// patternSignals — the sandbox rules, faithfully
// ---------------------------------------------------------------------------

describe("patternSignals — sandbox strategy rules", () => {
  it("SMA crossover: entry when the fast window crosses above the slow window", () => {
    // 20 declining closes, then a rise: at the last index the fast
    // window (prior 5) sits above the slow window (prior 20).
    const closes = [
      ...Array.from({ length: 20 }, (_, i) => 120 - i),
      ...Array.from({ length: 19 }, (_, i) => 101 + i),
      125,
    ];
    const signal = evaluateLatestPatternSignal("sma_crossover", closes, { holding: false, entryPrice: 0 });
    expect(signal.action).toBe("enter_long");
    expect(signal.fastSma).toBeGreaterThan(signal.slowSma!);
  });

  it("SMA crossover: exit when the fast window crosses below while holding", () => {
    const closes = [
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
      ...Array.from({ length: 19 }, (_, i) => 119 - i),
      95,
    ];
    const signal = evaluateLatestPatternSignal(
      "sma_crossover",
      closes,
      { holding: true, entryPrice: 110 },
    );
    expect(signal.action).toBe("exit_long");
  });

  it("SMA crossover: no signal before the slow window exists", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(
      evaluateLatestPatternSignal("sma_crossover", closes, { holding: false, entryPrice: 0 }).action,
    ).toBe("none");
  });

  it("mean-reversion family: entry on a >1.5% dip below the prior bar", () => {
    const closes = [...Array.from({ length: 15 }, () => 100), 98];
    const signal = evaluateLatestPatternSignal("mean_reversion", closes, {
      holding: false,
      entryPrice: 0,
    });
    expect(signal.action).toBe("enter_long");
    expect(signal.detail).toContain("dip >1.5% below prior bar");
  });

  it("mean-reversion family: exit on a +3% rise from entry", () => {
    const closes = [...Array.from({ length: 15 }, () => 100), 104];
    const signal = evaluateLatestPatternSignal("mean_reversion", closes, {
      holding: true,
      entryPrice: 100,
    });
    expect(signal.action).toBe("exit_long");
    expect(signal.detail).toContain("+3% from entry");
  });

  it("rsi_reversal and breakout are the same rule as mean_reversion (sandbox disclosure)", () => {
    const closes = sawtoothCloses();
    const state = { holding: false, entryPrice: 0 };
    const a = evaluateLatestPatternSignal("rsi_reversal", closes, state);
    const b = evaluateLatestPatternSignal("mean_reversion", closes, state);
    const c = evaluateLatestPatternSignal("breakout", closes, state);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.action).toBe("enter_long");
  });

  it("per-bar evaluation matches the sandbox loop's indexing (windows exclude bar i)", () => {
    // Fifteen gently declining closes, then a sharp rise into bar 20:
    // at i=20 the fast window (bars 15..19) sits above the slow
    // window (bars 0..19); at i=19 the slow window does not exist yet.
    const closes = [
      ...Array.from({ length: 15 }, (_, i) => 120 - i * 0.5),
      118, 120, 122, 124, 126,
      127,
    ];
    const at20 = evaluatePatternSignalAt("sma_crossover", closes, 20, {
      holding: false,
      entryPrice: 0,
    });
    expect(at20.action).toBe("enter_long");
    const at19 = evaluatePatternSignalAt("sma_crossover", closes, 19, {
      holding: false,
      entryPrice: 0,
    });
    expect(at19.action).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Sandbox parity — the extraction must not move the demo's numbers
// (baseline captured from the pre-extraction implementation)
// ---------------------------------------------------------------------------

describe("sandbox backtest parity after signal extraction", () => {
  it("keeps the pre-extraction metrics for every strategy", async () => {
    const svc = new ETradeSandboxService();
    const sma = await svc.runQuantBacktest({ symbol: "NVDA", strategy: "sma_crossover" } as any);
    expect(sma.totalTrades).toBe(3);
    expect(sma.winRate).toBe(0);
    expect(sma.sharpeRatio).toBe(-3.6);
    expect(sma.maxDrawdownPct).toBe(31.1);
    expect(sma.netReturnPct).toBe(-31.1);
    expect(sma.logs).toContain("Bar 20: BUY NVDA at $144.70 (Fast SMA 143.46 > Slow 136.24)");
    expect(sma.logs).toContain("Bar 87: SELL NVDA at $124.39");

    for (const strategy of ["rsi_reversal", "mean_reversion", "breakout"] as const) {
      const r = await svc.runQuantBacktest({ symbol: "NVDA", strategy } as any);
      expect(r.totalTrades).toBe(3);
      expect(r.winRate).toBe(66.7);
      expect(r.profitFactor).toBe(0.77);
      expect(r.sharpeRatio).toBe(-0.11);
      expect(r.netReturnPct).toBe(-3);
      expect(r.logs).toContain("Bar 23: BUY NVDA at $139.72 (dip >1.5% below prior bar)");
      expect(r.logs).toContain("Bar 41: SELL NVDA at $144.60 PnL: $4.88 (+3% from entry)");
    }
  });
});

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

describe("stock copilot cycle", () => {
  it("flag: absence means OFF, '1' means ON (house idiom)", () => {
    expect(isStockCopilotPaperEnabled({})).toBe(false);
    expect(isStockCopilotPaperEnabled({ STOCK_COPILOT_PAPER_ENABLED: "0" })).toBe(false);
    expect(isStockCopilotPaperEnabled({ STOCK_COPILOT_PAPER_ENABLED: "1" })).toBe(true);
    expect(isStockCopilotPaperEnabled({ STOCK_COPILOT_PAPER_ENABLED: " on " })).toBe(true);
  });

  it("flag OFF: no cycle work, zero platform calls", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      baseDeps({ env: {} as any, platform: fake.platform }),
    );
    expect(result.status).toBe("disabled");
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
  });

  it("mode guard: a live base URL does NOT refuse a paper selection — the selection outranks inference (#3451/#3272)", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      baseDeps({
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          ALPACA_BASE_URL: "https://api.alpaca.markets",
        } as any,
        platform: fake.platform,
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.refusal).toBeUndefined();
  });

  it("mode guard: an explicit live pin contradicts the paper selection and refuses with zero orders", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      baseDeps({
        env: { STOCK_COPILOT_PAPER_ENABLED: "1", ALPACA_TRADING_TYPE: "live" } as any,
        platform: fake.platform,
      }),
    );
    expect(result.status).toBe("refused_mode_mismatch");
    expect(result.refusal).toBe(STOCK_COPILOT_MODE_MISMATCH);
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
  });

  it("outside the enabled sessions (default: regular only, #3398): the named outside state, platform untouched", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      baseDeps({ platform: fake.platform, now: MARKET_CLOSED_NOW }),
    );
    expect(result.status).toBe("outside_enabled_sessions");
    expect(result.session).toBeNull();
    expect(result.enabledSessions).toEqual(COPILOT_SESSIONS);
    expect(fake.calls.placeOrderRemote).toBe(0);
    expect(fake.calls.getPositions).toBe(0);
  });

  it("entry signal: exactly one BUY through the platform, position tracked WITH its exit plan", async () => {
    const fake = createFakePlatform();
    const positions = createInMemoryStockCopilotPositionPort();
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        positions,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(1);
    expect(fake.placed).toHaveLength(1);
    expect(fake.placed[0]).toMatchObject({ symbol: "TEST", action: "BUY", userLogin: "owner" });
    // Sizing: concentration cap binds — 15% of $100k NAV / $98 = 153 shares.
    expect(fake.placed[0].quantity).toBe(153);

    const store = new StockCopilotPositionStore(positions);
    const open = await store.listOpenPositions("owner");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      symbol: "TEST",
      strategy: "mean_reversion",
      quantity: 153,
      entryPrice: 98,
      status: "open",
    });
    // The exit plan is part of the tracked position, not an afterthought.
    expect(open[0].stopPrice).toBeCloseTo(93.1, 5);
    expect(open[0].targetPrice).toBeCloseTo(107.8, 5);
    expect(open[0].brokerOrderRef).toBe("alpaca-1");
  });

  it("second cycle with the position already open places no duplicate entry", async () => {
    const fake = createFakePlatform();
    const deps = baseDeps({
      platform: fake.platform,
      universe: ["TEST"],
      strategies: ["mean_reversion"],
    });
    await runStockCopilotCycle(deps);
    const again = await runStockCopilotCycle(deps);
    expect(again.entriesPlaced).toBe(0);
    expect(fake.placed).toHaveLength(1);
  });

  it("exit evaluation: a held position hitting the strategy exit is sold and closed", async () => {
    const fake = createFakePlatform();
    const positions = createInMemoryStockCopilotPositionPort();
    const store = new StockCopilotPositionStore(positions);
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
    // Latest close 101 > 98 × 1.03 → the family's own exit rule fires.
    const closes = [...Array.from({ length: 15 }, () => 99), 101];
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        positions,
        universe: [],
        loadBars: async () => closes,
      }),
    );
    expect(result.exitsPlaced).toBe(1);
    expect(fake.placed).toHaveLength(1);
    expect(fake.placed[0]).toMatchObject({ symbol: "TEST", action: "SELL", quantity: 10 });
    const open = await store.listOpenPositions("owner");
    expect(open).toHaveLength(0);
  });

  it("exit evaluation: a held position breaching its stop is sold even without a strategy signal", async () => {
    const fake = createFakePlatform();
    const positions = createInMemoryStockCopilotPositionPort();
    const store = new StockCopilotPositionStore(positions);
    await store.openPosition({
      userLogin: "owner",
      symbol: "TEST",
      strategy: "sma_crossover",
      quantity: 5,
      entryPrice: 100,
      stopPrice: 95,
      targetPrice: 110,
      brokerOrderRef: "alpaca-entry",
    });
    const closes = [...Array.from({ length: 30 }, () => 100), 94];
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        positions,
        universe: [],
        loadBars: async () => closes,
      }),
    );
    expect(result.exitsPlaced).toBe(1);
    expect(fake.placed[0]).toMatchObject({ action: "SELL", quantity: 5 });
  });

  it("sizing refusal: an account too small for one share under the caps places no order", async () => {
    const fake = createFakePlatform({ nav: 200 });
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
      }),
    );
    expect(result.entriesPlaced).toBe(0);
    expect(fake.placed).toHaveLength(0);
    expect(result.rejections.length).toBeGreaterThan(0);
    expect(result.rejections[0].symbol).toBe("TEST");
    expect(result.rejections[0].reason).toContain("sizing refused");
  });

  it("no signal: flat bars produce no orders", async () => {
    const fake = createFakePlatform();
    const result = await runStockCopilotCycle(
      baseDeps({
        platform: fake.platform,
        universe: ["TEST"],
        strategies: ["mean_reversion", "sma_crossover"],
        loadBars: async () => Array.from({ length: 40 }, () => 100),
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.entriesPlaced).toBe(0);
    expect(fake.placed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scheduled-task declaration
// ---------------------------------------------------------------------------

describe("stock copilot scheduled-task declaration", () => {
  const ctxBase = {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    agentCtx: {} as any,
    getOrm: () => undefined,
    readSettingRaw: () => null,
    audit: () => {},
  };

  it("declares nothing while the flag is off", async () => {
    const tasks = await declareStockCopilotTasks({
      ...ctxBase,
      env: {} as any,
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    expect(tasks).toEqual({});
  });

  it("declares nothing on an instance without a login context", async () => {
    const tasks = await declareStockCopilotTasks({
      ...ctxBase,
      getScreenerExecutionContext: async () => undefined,
    });
    expect(tasks).toEqual({});
  });

  it("declares the 30-minute cycle task when flag and login are present", async () => {
    const tasks = await declareStockCopilotTasks({
      ...ctxBase,
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    const ids = Object.keys(tasks);
    expect(ids).toHaveLength(1);
    expect(tasks[ids[0]].schedule).toBe("every 30 minutes");
    expect(typeof tasks[ids[0]].handler).toBe("function");
  });
});
