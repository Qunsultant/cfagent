/**
 * Issue #1769 (parent #1717) — stock-screener gate completion, group A.
 * TDD red→green: MA death-cross rejection, ORB breakout gate, and the
 * pre-market gap gate that completes the pre-market momentum trio
 * (gap + RVOL + ATR%; RVOL and ATR% already gate in evaluateUniverse).
 *
 * Death cross (screener-rules.md §1.1): SMA50 crossing below SMA200 is
 * a hard rejection when the cross falls within the last 20 sessions.
 * ORB (screener-rules.md §1.4): breakout trigger (price strictly above
 * OR_H × 1.001 with time-prorated RVOL ≥ 1.5) AND session-VWAP hold
 * ≥ 70% of completed 15-min bars. Gap (screener-rules.md §1.4):
 * |Gap%| ≥ 2.0% by default when the gate is requested.
 * Every requested gate fail-closes on missing attached data.
 */
import { describe, it, expect } from "vitest";
import {
  detectDeathCrossWithinSessions,
  evaluateOrbBreakout,
  type IntradayBar,
  type YahooDailyBar,
} from "../src/trading/technicals";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ScreenedStockItem } from "../src/types";

function dailyBar(close: number, date = "2026-01-01"): YahooDailyBar {
  return { date, open: close, high: close, low: close, close, volume: 1000 };
}

function makeItem(overrides: Partial<ScreenedStockItem> = {}): ScreenedStockItem {
  return {
    symbol: "TEST",
    companyName: "Test Co",
    lastPrice: 100,
    price: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    timestamp: "2026-10-26T00:00:00.000Z",
    macdSignal: "MACD unavailable from listing feed",
    signal: "RANGE_BOUND",
    technicalSignal: "RSI neutral",
    momentumScore: 50,
    highlightReason: "Test Co market listing",
    ...overrides,
  } as ScreenedStockItem;
}

function screen(items: ScreenedStockItem[], filter: Record<string, unknown>) {
  return new DynamicMarketScreener(items).screenStocks(filter as never);
}

/** 210 closes: 200 flat at 100, then a fall to 80 that drags SMA50 under SMA200. */
function deathCrossCloses(): number[] {
  const closes: number[] = [];
  for (let i = 0; i < 200; i++) closes.push(100);
  for (let i = 0; i < 10; i++) closes.push(80);
  return closes;
}

describe("detectDeathCrossWithinSessions (#1769)", () => {
  it("detects a death cross inside the last 20 sessions", () => {
    const result = detectDeathCrossWithinSessions(deathCrossCloses().map(dailyBar));
    expect(result).not.toBeNull();
    expect(result!.crossedWithinSessions).toBe(true);
    expect(result!.latestSma50).toBeLessThan(result!.latestSma200);
  });

  it("does not flag an old death cross outside the window", () => {
    const closes: number[] = [];
    for (let i = 0; i < 200; i++) closes.push(100);
    for (let i = 0; i < 10; i++) closes.push(80);
    // 30 flat recovery bars: the cross is now > 20 sessions old, and
    // SMA50 has climbed back above SMA200 by the end.
    for (let i = 0; i < 30; i++) closes.push(100);
    const result = detectDeathCrossWithinSessions(closes.map(dailyBar));
    expect(result).not.toBeNull();
    expect(result!.crossedWithinSessions).toBe(false);
  });

  it("returns null on fewer than 200 closes or non-finite input", () => {
    expect(detectDeathCrossWithinSessions(deathCrossCloses().slice(0, 199).map(dailyBar))).toBeNull();
    const bad = deathCrossCloses().map(dailyBar);
    bad[150] = dailyBar(Number.NaN);
    expect(detectDeathCrossWithinSessions(bad)).toBeNull();
  });

  it("reports no cross for a flat series", () => {
    const result = detectDeathCrossWithinSessions(Array.from({ length: 210 }, () => dailyBar(100)));
    expect(result).not.toBeNull();
    expect(result!.crossedWithinSessions).toBe(false);
    expect(result!.sessionsSinceCross).toBeNull();
  });
});

describe("evaluateUniverse death-cross gate (#1769)", () => {
  it("rejects a recent death cross when the gate is requested, passes otherwise", () => {
    const flagged = screen([makeItem({ deathCrossWithin20: true })], { requireNoRecentDeathCross: true });
    expect(flagged.stocks).toHaveLength(0);
    expect(flagged.ledger.rejections[0].reason).toMatch(/death cross/i);
    expect(screen([makeItem({ deathCrossWithin20: true })], {}).stocks).toHaveLength(1);
    expect(screen([makeItem({ deathCrossWithin20: false })], { requireNoRecentDeathCross: true }).stocks).toHaveLength(1);
  });

  it("fail-closes when the gate is requested but no death-cross data is attached", () => {
    const result = screen([makeItem()], { requireNoRecentDeathCross: true });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/unavailable/i);
  });
});

function intradayBar(timestamp: string, close: number, high?: number, low?: number, volume = 1000): IntradayBar {
  return { timestamp, open: close, high: high ?? close, low: low ?? close, close, volume };
}

describe("evaluateOrbBreakout (#1769)", () => {
  // 2026-11-02 is EST (UTC-5): 09:30 ET = 14:30Z, 09:45 ET = 14:45Z.
  const session = "2026-11-02";
  const bars: IntradayBar[] = [
    intradayBar("2026-11-02T14:30:00.000Z", 100, 101, 99),
    intradayBar("2026-11-02T14:45:00.000Z", 102, 103, 101),
    intradayBar("2026-11-02T15:00:00.000Z", 102, 103, 101),
    intradayBar("2026-11-02T15:15:00.000Z", 102, 103, 101),
  ];

  it("confirms a breakout above OR_H x 1.001 with RVOL >= 1.5 and VWAP hold >= 70%", () => {
    const result = evaluateOrbBreakout({
      bars,
      sessionDate: session,
      price: 102,
      sessionVolume: 15000,
      avgDailyVolume: 20000,
      elapsedMinutes: 45,
      asOf: "2026-11-02T15:30:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result!.orHigh).toBe(101);
    expect(result!.triggered).toBe(true);
    expect(result!.vwapConfirmed).toBe(true);
    expect(result!.breakoutConfirmed).toBe(true);
  });

  it("does not confirm when price fails to clear the trigger", () => {
    const result = evaluateOrbBreakout({
      bars,
      sessionDate: session,
      price: 101,
      sessionVolume: 15000,
      avgDailyVolume: 20000,
      elapsedMinutes: 45,
      asOf: "2026-11-02T15:30:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result!.breakoutConfirmed).toBe(false);
  });

  it("returns null with no opening-range bars", () => {
    expect(evaluateOrbBreakout({
      bars: [],
      sessionDate: session,
      price: 102,
      sessionVolume: 15000,
      avgDailyVolume: 20000,
      elapsedMinutes: 45,
      asOf: "2026-11-02T15:30:00.000Z",
    })).toBeNull();
  });
});

describe("evaluateUniverse ORB gate (#1769)", () => {
  it("passes only confirmed breakouts when the gate is requested", () => {
    expect(screen([makeItem({ orbTriggered: true, orbVwapConfirmed: true })], { requireOrbBreakout: true }).stocks).toHaveLength(1);
    expect(screen([makeItem({ orbTriggered: true, orbVwapConfirmed: false })], { requireOrbBreakout: true }).stocks).toHaveLength(0);
    expect(screen([makeItem({ orbTriggered: false, orbVwapConfirmed: true })], { requireOrbBreakout: true }).stocks).toHaveLength(0);
    expect(screen([makeItem({ orbTriggered: true, orbVwapConfirmed: true })], {}).stocks).toHaveLength(1);
  });

  it("fail-closes when the gate is requested but no ORB data is attached", () => {
    const result = screen([makeItem()], { requireOrbBreakout: true });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/unavailable/i);
  });
});

describe("evaluateUniverse pre-market gap gate (#1769)", () => {
  it("passes |Gap%| >= 2.0 by default and rejects smaller gaps", () => {
    expect(screen([makeItem({ gapPercent: 2.5 })], { minAbsGapPct: undefined, requirePreMarketMomentumGap: true }).stocks).toHaveLength(1);
    expect(screen([makeItem({ gapPercent: -2.0 })], { requirePreMarketMomentumGap: true }).stocks).toHaveLength(1);
    const small = screen([makeItem({ gapPercent: 1.5 })], { requirePreMarketMomentumGap: true });
    expect(small.stocks).toHaveLength(0);
    expect(small.ledger.rejections[0].reason).toMatch(/gap/i);
    expect(screen([makeItem({ gapPercent: 3.0 })], { minAbsGapPct: 5 }).stocks).toHaveLength(0);
    expect(screen([makeItem({ gapPercent: 6.0 })], { minAbsGapPct: 5 }).stocks).toHaveLength(1);
  });

  it("fail-closes when the gate is requested but no gap data is attached", () => {
    const result = screen([makeItem()], { requirePreMarketMomentumGap: true });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/unavailable/i);
  });
});
