/** @vitest-environment jsdom */
/**
 * Issue 6406 — the Opportunity Hunt panel as a report-style view.
 *
 * Pins:
 * - the recommendation levels are externalized per strategy and derived
 *   from the latest close (never a literal in the panel or the hunt);
 * - a held symbol's exit fires from the evaluator with the cost basis,
 *   and an unheld symbol still enters;
 * - the trailing series is capped for the chart, and the summary carries
 *   the entry/exit split;
 * - the holdings read is broker-neutral and degrades visibly (never a
 *   silent drop of exits): options, shorts, unknown cost basis, and
 *   non-positive prices never become holdings;
 * - the chart is fed the trailing closes with trading-day labels and the
 *   recommendation levels as price lines;
 * - the panel groups one row per symbol with a pattern count, entry and
 *   exit recommendations, and a holdings notice when exits are unavailable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../src/data/createFeedDatasetPorts", () => ({
  createFeedDatasetAdapter: vi.fn(),
}));

vi.mock("../src/services/feedJobs", () => ({
  buildFeedJobRegistry: vi.fn(),
  readPersistedTechnicalsBars: vi.fn(),
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID: "yahoo-nasdaq100-technicals",
}));

vi.mock("../src/config/featureFlags", () => ({
  isFeatureEnabled: vi.fn(),
}));

vi.mock("../src/services/tenantProviders", () => ({
  resolveTenantBroker: vi.fn(),
}));

vi.mock("../src/trading", () => ({
  TradingPlatformRegistry: { getPlatform: vi.fn() },
  brokerSupports: vi.fn(),
}));

vi.mock("../src/agents/routes/brokerEnvironment", () => ({
  resolveBrokerEnvironmentFromSettings: vi.fn(() => "paper"),
}));

vi.mock("../src/agents/routes/brokerReads", () => ({
  BROKER_PANEL_CONTRACT_FLAG: "broker_panel_contract",
}));

vi.mock("../src/client/jobsApi", () => ({
  listAllRuns: vi.fn(),
  runOpportunityHuntNow: vi.fn(),
}));

// The panel test renders the REAL chart component: lightweight-charts
// itself is mocked below, and jsdom gets a ResizeObserver stub, so no
// canvas is ever created.
const { mockSeries, mockChart, mockCreateChart } = vi.hoisted(() => {
  const mockSeries = {
    setData: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
  };
  const mockChart = {
    addSeries: vi.fn(() => mockSeries),
    remove: vi.fn(),
    applyOptions: vi.fn(),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  };
  const mockCreateChart = vi.fn(() => mockChart);
  return { mockSeries, mockChart, mockCreateChart };
});

vi.mock("lightweight-charts", () => ({
  createChart: mockCreateChart,
  LineSeries: {},
  ColorType: { Solid: "solid" },
}));

import { isFeatureEnabled } from "../src/config/featureFlags";
import { resolveTenantBroker } from "../src/services/tenantProviders";
import {
  TradingPlatformRegistry,
  brokerSupports,
} from "../src/trading";
import {
  loadHuntHoldings,
  type OpportunityHuntRouteContext,
} from "../src/agents/routes/opportunityHunt";
import {
  OPPORTUNITY_HUNT_CHART_BARS,
  OPPORTUNITY_HUNT_LEVELS,
  deriveOpportunityHuntLevels,
} from "../src/config/opportunityHuntLevels";
import { runOpportunityHunt } from "../src/services/opportunityHunt";
import {
  formatHuntPct,
  formatHuntPrice,
  groupHuntSetupsBySymbol,
  huntTradingDayLabels,
  nextHuntSort,
  sortHuntRows,
} from "../src/client/opportunityHuntView";
import { OpportunityHuntChart } from "../src/client/OpportunityHuntChart";
import { OpportunityHuntPanel } from "../src/client/OpportunityHuntPanel";
import {
  listAllRuns,
  runOpportunityHuntNow,
} from "../src/client/jobsApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver; the chart observes its container on mount.
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const asMap = (entries: Record<string, number[]>) => new Map(Object.entries(entries));

/** 16 flat bars, then 5 higher ones: the fast SMA overtakes the slow one. */
const RISING = [...Array(16).fill(100), ...Array(5).fill(120)];

describe("recommendation levels (issue 6406)", () => {
  it("are externalized per strategy, never literals in the panel or hunt", () => {
    // sma_crossover: the copilot's 5% stop / 10% take-profit baseline.
    expect(OPPORTUNITY_HUNT_LEVELS.sma_crossover).toEqual({
      entryBandPct: 0.005,
      stopLossPct: 0.05,
      takeProfitPct: 0.1,
    });
    // The mean-reversion family: take-profit aligns with the evaluator's
    // own +3% exit rule; the stop is symmetric at 3%.
    for (const strategy of ["rsi_reversal", "mean_reversion", "breakout"] as const) {
      expect(OPPORTUNITY_HUNT_LEVELS[strategy]).toEqual({
        entryBandPct: 0.005,
        stopLossPct: 0.03,
        takeProfitPct: 0.03,
      });
    }
  });

  it("derives the entry range, stop, and take-profit from the latest close", () => {
    expect(deriveOpportunityHuntLevels("sma_crossover", 120)).toEqual({
      entryLow: 119.4,
      entryHigh: 120.6,
      stopLoss: 114,
      takeProfit: 132,
    });
    expect(deriveOpportunityHuntLevels("mean_reversion", 98)).toEqual({
      entryLow: 97.51,
      entryHigh: 98.49,
      stopLoss: 95.06,
      takeProfit: 100.94,
    });
  });
});

describe("runOpportunityHunt with holdings (issue 6406)", () => {
  it("exits a held symbol above its cost basis and still enters an unheld one", () => {
    const result = runOpportunityHunt({
      closesBySymbol: asMap({
        // 14 flat bars then 104: +4% above a 100 cost basis — the family exits.
        AAAA: [...Array(14).fill(100), 104],
        BBBB: RISING,
      }),
      holdings: new Map([["AAAA", 100]]),
      holdingsStatus: { available: true, broker: "alpaca" },
      now: () => new Date("2026-11-23T12:00:00.000Z"),
    });
    const exits = result.setups.filter((s) => s.direction === "exit");
    expect(exits.map((s) => s.strategy)).toEqual([
      "breakout",
      "mean_reversion",
      "rsi_reversal",
    ]);
    for (const exit of exits) {
      expect(exit.symbol).toBe("AAAA");
      expect(exit.lastClose).toBe(104);
      expect(exit.entryPrice).toBe(100);
      expect(exit.levels).toBeUndefined();
      expect(exit.detail).toContain("+3% from entry");
    }
    const entries = result.setups.filter((s) => s.direction === "entry");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      symbol: "BBBB",
      strategy: "sma_crossover",
      direction: "entry",
      lastClose: 120,
    });
    expect(entries[0].levels).toEqual({
      entryLow: 119.4,
      entryHigh: 120.6,
      stopLoss: 114,
      takeProfit: 132,
    });
    expect(result.holdingsStatus).toEqual({ available: true, broker: "alpaca" });
    expect(result.summary).toContain("4 setup(s) across 2 symbol(s), 1 entry, 3 exits");
  });

  it("carries the trailing series per symbol, capped for the chart", () => {
    const result = runOpportunityHunt({
      closesBySymbol: asMap({
        AAAA: [...Array(40).fill(100), 98],
        BBBB: Array(15).fill(100),
      }),
    });
    expect(result.seriesBySymbol.AAAA).toHaveLength(OPPORTUNITY_HUNT_CHART_BARS);
    expect(result.seriesBySymbol.AAAA[OPPORTUNITY_HUNT_CHART_BARS - 1]).toBe(98);
    expect(result.seriesBySymbol.BBBB).toBeUndefined();
  });

  it("defaults to holdings unavailable with a named reason when the caller says nothing", () => {
    const result = runOpportunityHunt({ closesBySymbol: asMap({ AAAA: RISING }) });
    expect(result.holdingsStatus).toEqual({
      available: false,
      reason: "holdings_not_loaded",
    });
    expect(result.setups.every((s) => s.direction === "entry")).toBe(true);
  });
});

describe("loadHuntHoldings (issue 6406)", () => {
  const ctx: OpportunityHuntRouteContext = {
    env: {},
    getOrm: () => undefined,
    readSettingRaw: () => null,
  };
  const req = () => new Request("https://agent.internal/opportunity-hunt/run", { method: "POST" });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
    vi.mocked(resolveTenantBroker).mockResolvedValue("alpaca" as never);
    vi.mocked(brokerSupports).mockReturnValue(true);
  });

  it("returns long equity holdings with a known cost basis, uppercased", async () => {
    vi.mocked(TradingPlatformRegistry.getPlatform).mockReturnValue({
      getPositions: async () => ({
        account: {},
        positions: [
          { symbol: "AAAA", securityType: "EQ", positionType: "LONG", costBasisKnown: true, pricePaid: 100 },
          { symbol: "bbbb", securityType: "EQ", positionType: "LONG", costBasisKnown: true, pricePaid: 50 },
          // Options are not the hunt's long-only universe.
          { symbol: "CCCC", securityType: "OPTN", positionType: "LONG", costBasisKnown: true, pricePaid: 5 },
          // Shorts are not held longs.
          { symbol: "DDDD", securityType: "EQ", positionType: "SHORT", costBasisKnown: true, pricePaid: 20 },
          // An unknown cost basis is not an entry price.
          { symbol: "EEEE", securityType: "EQ", positionType: "LONG", costBasisKnown: false, pricePaid: 0 },
          // A non-positive price is not an entry price.
          { symbol: "FFFF", securityType: "EQ", positionType: "LONG", costBasisKnown: true, pricePaid: 0 },
        ],
      }),
    } as never);
    const { holdings, status } = await loadHuntHoldings(req(), ctx);
    expect([...holdings.entries()]).toEqual([
      ["AAAA", 100],
      ["BBBB", 50],
    ]);
    expect(status).toEqual({ available: true, broker: "alpaca" });
  });

  it("is unavailable with a named reason when the positions read is disabled", async () => {
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    const { holdings, status } = await loadHuntHoldings(req(), ctx);
    expect(holdings.size).toBe(0);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("FEATURE_DISABLED");
  });

  it("is unavailable with a named reason when the broker has no positions capability", async () => {
    vi.mocked(brokerSupports).mockReturnValue(false);
    const { holdings, status } = await loadHuntHoldings(req(), ctx);
    expect(holdings.size).toBe(0);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("provider_unsupported");
    expect(status.broker).toBe("alpaca");
  });

  it("is unavailable with a coded reason when the positions read fails", async () => {
    vi.mocked(TradingPlatformRegistry.getPlatform).mockReturnValue({
      getPositions: async () => {
        throw new Error("broker down");
      },
    } as never);
    const { holdings, status } = await loadHuntHoldings(req(), ctx);
    expect(holdings.size).toBe(0);
    expect(status.available).toBe(false);
    expect(status.reason).toContain("BROKER_POSITIONS_FAILED");
  });
});

describe("report view helpers (issue 6406)", () => {
  const result = {
    scanned: 2,
    skipped: 0,
    setups: [
      { symbol: "BBBB", strategy: "sma_crossover", direction: "entry", lastClose: 120, detail: "(Fast SMA 116.00 > Slow 104.00)", levels: { entryLow: 119.4, entryHigh: 120.6, stopLoss: 114, takeProfit: 132 } },
      { symbol: "AAAA", strategy: "mean_reversion", direction: "exit", lastClose: 104, detail: "(+3% from entry)", entryPrice: 100 },
      { symbol: "AAAA", strategy: "rsi_reversal", direction: "entry", lastClose: 104, detail: "(dip >1.5% below prior bar)", levels: { entryLow: 103.48, entryHigh: 104.52, stopLoss: 100.88, takeProfit: 107.12 } },
    ],
    summary: "Opportunity hunt: 3 setup(s) across 2 symbol(s), 2 entries, 1 exit",
    asOf: "2026-11-23T12:00:00.000Z",
    holdingsStatus: { available: true, broker: "alpaca" },
    seriesBySymbol: { AAAA: [100, 104], BBBB: [100, 120] },
  } as never;

  it("groups one row per symbol with a pattern count and rolled-up ranges", () => {
    const rows = groupHuntSetupsBySymbol(result);
    expect(rows.map((r) => r.symbol)).toEqual(["AAAA", "BBBB"]);
    const aaaa = rows[0];
    expect(aaaa.patternCount).toBe(2);
    expect(aaaa.entries.map((s) => s.strategy)).toEqual(["rsi_reversal"]);
    expect(aaaa.exits.map((s) => s.strategy)).toEqual(["mean_reversion"]);
    expect(aaaa.entryLow).toBe(103.48);
    expect(aaaa.entryHigh).toBe(104.52);
    expect(aaaa.stopLoss).toBe(100.88);
    expect(aaaa.takeProfit).toBe(107.12);
    expect(aaaa.exitPrice).toBe(104);
    expect(aaaa.exitGainPct).toBeCloseTo(0.04);
    expect(rows[1].exits).toEqual([]);
    expect(rows[1].exitPrice).toBeNull();
  });

  it("sorts by symbol, pattern count, and last close", () => {
    const rows = groupHuntSetupsBySymbol(result);
    expect(sortHuntRows(rows, { key: "patterns", dir: "desc" }).map((r) => r.symbol)).toEqual([
      "AAAA",
      "BBBB",
    ]);
    expect(sortHuntRows(rows, { key: "lastClose", dir: "desc" }).map((r) => r.symbol)).toEqual([
      "BBBB",
      "AAAA",
    ]);
    expect(sortHuntRows(rows, { key: "symbol", dir: "desc" }).map((r) => r.symbol)).toEqual([
      "BBBB",
      "AAAA",
    ]);
    expect(nextHuntSort({ key: "symbol", dir: "asc" }, "symbol")).toEqual({
      key: "symbol",
      dir: "desc",
    });
    expect(nextHuntSort({ key: "symbol", dir: "asc" }, "patterns")).toEqual({
      key: "patterns",
      dir: "desc",
    });
  });

  it("labels trading days, stepping over weekends", () => {
    // 2026-11-23 is a Monday.
    expect(huntTradingDayLabels("2026-11-23T12:00:00.000Z", 3)).toEqual([
      "2026-11-19",
      "2026-11-20",
      "2026-11-23",
    ]);
    // 2026-11-22 is a Sunday: the last label is still Friday.
    expect(huntTradingDayLabels("2026-11-22T12:00:00.000Z", 2)).toEqual([
      "2026-11-19",
      "2026-11-20",
    ]);
    expect(huntTradingDayLabels("not-a-date", 3)).toEqual([]);
  });

  it("formats prices and percents, with an em dash for unknown", () => {
    expect(formatHuntPrice(120)).toBe("$120.00");
    expect(formatHuntPrice(null)).toBe("—");
    expect(formatHuntPct(0.04)).toBe("+4.0%");
    expect(formatHuntPct(-0.025)).toBe("-2.5%");
    expect(formatHuntPct(undefined)).toBe("—");
  });
});

describe("OpportunityHuntChart (issue 6406)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    root = null;
    container = null;
  });

  it("plots the trailing closes with trading-day times and the level lines", async () => {
    await act(async () => {
      root!.render(
        <OpportunityHuntChart
          symbol="AAAA"
          closes={[100, 101, 104]}
          labels={["2026-11-19", "2026-11-20", "2026-11-23"]}
          entryLow={103.48}
          entryHigh={104.52}
          stopLoss={100.88}
          takeProfit={107.12}
          entryPrice={null}
          lastClose={104}
        />,
      );
    });
    expect(mockCreateChart).toHaveBeenCalledTimes(1);
    expect(mockChart.addSeries).toHaveBeenCalledTimes(1);
    expect(mockSeries.setData).toHaveBeenCalledWith([
      { time: "2026-11-19", value: 100 },
      { time: "2026-11-20", value: 101 },
      { time: "2026-11-23", value: 104 },
    ]);
    const linePrices = vi
      .mocked(mockSeries.createPriceLine)
      .mock.calls.map((call) => (call[0] as { price: number }).price);
    expect(linePrices).toEqual([103.48, 104.52, 100.88, 107.12]);
    const lineTitles = vi
      .mocked(mockSeries.createPriceLine)
      .mock.calls.map((call) => (call[0] as { title: string }).title);
    expect(lineTitles).toEqual(["Entry low", "Entry high", "Stop-loss", "Take-profit"]);
  });

  it("draws the cost-basis line for an exit instead of the entry levels", async () => {
    await act(async () => {
      root!.render(
        <OpportunityHuntChart
          symbol="AAAA"
          closes={[100, 101, 104]}
          labels={["2026-11-19", "2026-11-20", "2026-11-23"]}
          entryLow={null}
          entryHigh={null}
          stopLoss={null}
          takeProfit={null}
          entryPrice={100}
          lastClose={104}
        />,
      );
    });
    const lineTitles = vi
      .mocked(mockSeries.createPriceLine)
      .mock.calls.map((call) => (call[0] as { title: string }).title);
    expect(lineTitles).toEqual(["Cost basis"]);
  });
});

describe("OpportunityHuntPanel report view (issue 6406)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  const renderPanel = async (runResult: unknown) => {
    vi.mocked(listAllRuns).mockResolvedValue({ runs: [], partial: false });
    vi.mocked(runOpportunityHuntNow).mockResolvedValue(runResult as never);
    await act(async () => {
      root!.render(<OpportunityHuntPanel />);
    });
    const button = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Run hunt now"),
    );
    await act(async () => {
      button!.click();
    });
  };

  it("shows one row per symbol with pattern count, entries, exits, and ranges", async () => {
    await renderPanel({
      ok: true,
      scanned: 2,
      skipped: 0,
      setups: [
        { symbol: "AAAA", strategy: "mean_reversion", direction: "exit", lastClose: 104, detail: "(+3% from entry)", entryPrice: 100 },
        { symbol: "AAAA", strategy: "rsi_reversal", direction: "entry", lastClose: 104, detail: "(dip >1.5% below prior bar)", levels: { entryLow: 103.48, entryHigh: 104.52, stopLoss: 100.88, takeProfit: 107.12 } },
        { symbol: "BBBB", strategy: "sma_crossover", direction: "entry", lastClose: 120, detail: "(Fast SMA 116.00 > Slow 104.00)", levels: { entryLow: 119.4, entryHigh: 120.6, stopLoss: 114, takeProfit: 132 } },
      ],
      summary: "Opportunity hunt: 3 setup(s) across 2 symbol(s), 2 entries, 1 exit",
      asOf: "2026-11-23T12:00:00.000Z",
      holdingsStatus: { available: true, broker: "alpaca" },
      seriesBySymbol: { AAAA: [100, 104], BBBB: [100, 120] },
    });
    const text = container!.textContent ?? "";
    // One row per symbol: AAAA appears once in the table (plus once in the
    // selected-symbol detail), BBBB once in the table.
    expect(text).toContain("AAAA");
    expect(text).toContain("BBBB");
    // Pattern counts and ranges render.
    expect(text).toContain("$103.48 – $104.52");
    expect(text).toContain("$100.88");
    expect(text).toContain("$107.12");
    // Grouped recommendations for the selected symbol (AAAA, first row).
    expect(text).toContain("Entry recommendations");
    expect(text).toContain("Exit recommendations");
    expect(text).toContain("entered at $100.00");
    expect(text).toContain("(+4.0%)");
    // The detail chart is mounted for the selected symbol (AAAA, first row).
    const chartImg = container!.querySelector('[role="img"]');
    expect(chartImg?.getAttribute("aria-label")).toContain("AAAA");
  });

  it("states the reason when exits are unavailable instead of dropping them silently", async () => {
    await renderPanel({
      ok: true,
      scanned: 1,
      skipped: 0,
      setups: [
        { symbol: "AAAA", strategy: "rsi_reversal", direction: "entry", lastClose: 98, detail: "(dip >1.5% below prior bar)", levels: { entryLow: 97.51, entryHigh: 98.49, stopLoss: 95.06, takeProfit: 100.94 } },
      ],
      summary: "Opportunity hunt: 1 setup(s) across 1 symbol(s), 1 entry, 0 exits",
      asOf: "2026-11-23T12:00:00.000Z",
      holdingsStatus: { available: false, reason: "FEATURE_DISABLED: the broker positions read is disabled" },
      seriesBySymbol: { AAAA: [100, 98] },
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("Exit signals unavailable");
    expect(text).toContain("FEATURE_DISABLED");
    expect(text).toContain("AAAA");
  });

  it("sorts the table by pattern count when the header is clicked", async () => {
    await renderPanel({
      ok: true,
      scanned: 2,
      skipped: 0,
      setups: [
        { symbol: "AAAA", strategy: "rsi_reversal", direction: "entry", lastClose: 98, detail: "(dip >1.5% below prior bar)", levels: { entryLow: 97.51, entryHigh: 98.49, stopLoss: 95.06, takeProfit: 100.94 } },
        { symbol: "BBBB", strategy: "sma_crossover", direction: "entry", lastClose: 120, detail: "(Fast SMA 116.00 > Slow 104.00)", levels: { entryLow: 119.4, entryHigh: 120.6, stopLoss: 114, takeProfit: 132 } },
        { symbol: "BBBB", strategy: "mean_reversion", direction: "entry", lastClose: 120, detail: "(dip >1.5% below prior bar)", levels: { entryLow: 119.4, entryHigh: 120.6, stopLoss: 116.4, takeProfit: 123.6 } },
      ],
      summary: "Opportunity hunt: 3 setup(s) across 2 symbol(s), 3 entries, 0 exits",
      asOf: "2026-11-23T12:00:00.000Z",
      holdingsStatus: { available: true, broker: "alpaca" },
      seriesBySymbol: { AAAA: [100, 98], BBBB: [100, 120] },
    });
    // Default sort is symbol A→Z: AAAA's row precedes BBBB's.
    const rowsBefore = [...container!.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
    expect(rowsBefore[0]).toContain("AAAA");
    expect(rowsBefore[1]).toContain("BBBB");
    const sortButton = [...container!.querySelectorAll("button")].find((b) =>
      b.getAttribute("aria-label")?.startsWith("Sort by Patterns"),
    );
    expect(sortButton).toBeDefined();
    await act(async () => {
      sortButton!.click();
    });
    const rowsAfter = [...container!.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
    // Patterns desc: BBBB (2 patterns) first.
    expect(rowsAfter[0]).toContain("BBBB");
    expect(rowsAfter[1]).toContain("AAAA");
  });
});
