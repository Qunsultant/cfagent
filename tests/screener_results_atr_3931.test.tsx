/** @vitest-environment jsdom */
/**
 * Issue #3931 (sub-issue of #3929) — the screener results view
 * reads RSI(14)/MACD/ATR(14) from the persisted technicals as its
 * primary source and renders ATR as its own column.
 *
 * Pins:
 * - The all-stocks table has an ATR(14) column rendering the
 *   persisted ATR value (2 decimals), with the persisted source
 *   named in the cell tooltip.
 * - A row with no technicals renders "—" for ATR, never a zero.
 * - The RSI(14) header names the persisted primary source.
 *
 * Harness follows tests/pdf_report_link_honesty.test.tsx:
 * react-dom/client in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScreenerResultsView, type ScreenerResultData } from "../src/client/ScreenerResultsView";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function screenRun(overrides: Partial<ScreenerResultData>): ScreenerResultData {
  return {
    timestamp: "2026-11-07T12:00:00.000Z",
    trigger: "manual",
    sector: "Technology",
    success: true,
    totalScanned: 2,
    matchedCount: 1,
    opportunities: [
      { symbol: "AAPL", companyName: "Apple Inc", signal: "bullish", momentumScore: 91, lastPrice: 110, changePercent: 1.5 },
    ],
    allStocks: [
      {
        symbol: "AAPL",
        companyName: "Apple Inc",
        signal: "bullish",
        momentumScore: 91,
        lastPrice: 110,
        changePercent: 1.5,
        rsi14: 100,
        source: "E*TRADE live",
        technicals: {
          rsi14: 100,
          macdLine: 6.5,
          macdSignalLine: 5.33,
          macdHistogram: 1.17,
          macdSignal: "Bullish MACD Crossover (Line > Signal)",
          atr14: 2,
          gapPercent: 1.25,
          gapDirection: "up",
          historyBars: 30,
          historySource: "Persisted Yahoo daily bars (as of 2026-11-07)",
        },
      },
      {
        symbol: "MSFT",
        companyName: "Microsoft Corp",
        signal: "neutral",
        momentumScore: 40,
        lastPrice: 210,
        changePercent: 0.5,
        rsi14: null,
        source: "E*TRADE live",
        technicals: {
          rsi14: null,
          macdLine: null,
          macdSignalLine: null,
          macdHistogram: null,
          macdSignal: null,
          atr14: null,
          gapPercent: null,
          gapDirection: null,
          historyBars: 0,
          historySource: null,
        },
      },
    ],
    discoveryMessage: "",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.restoreAllMocks();
});

describe("ScreenerResultsView ATR column (#3931)", () => {
  it("renders an ATR(14) column with the persisted value and source", async () => {
    await render(React.createElement(ScreenerResultsView, { result: screenRun({}) }));
    const text = container.textContent ?? "";
    expect(text).toContain("ATR(14)");
    // The persisted ATR cell, found by its tooltip, renders the
    // value with 2 decimals.
    const atrCell = Array.from(container.querySelectorAll("span")).find((s) =>
      (s.getAttribute("title") ?? "").includes("ATR(14) from Persisted Yahoo daily bars"),
    );
    expect(atrCell).toBeDefined();
    expect(atrCell?.textContent).toBe("2.00");
    // The RSI header names the persisted primary source (the
    // title rides on the header's inner sort label).
    const rsiTitle = container.querySelector('[title*="Real RSI(14) from persisted"]');
    expect(rsiTitle).not.toBeNull();
  });

  it("renders — for ATR when history is unavailable, never a zero", async () => {
    await render(React.createElement(ScreenerResultsView, { result: screenRun({}) }));
    // The MSFT row has no technicals: its ATR cell is "—".
    const dashes = Array.from(container.querySelectorAll("span")).filter(
      (s) => s.textContent === "—" && (s.getAttribute("title") ?? "").includes("No history — ATR unavailable"),
    );
    expect(dashes.length).toBe(1);
  });
});
