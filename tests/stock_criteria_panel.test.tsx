/** @vitest-environment jsdom */
/**
 * Issue #1496 (#940-B): stock criteria UI — view the effective criteria
 * for a manual stock run, modify thresholds, and toggle a criterion off
 * so it is omitted from the run request without losing its value.
 *
 * Verification behind this panel (code-read, 2026-10-25): every field it
 * exposes genuinely filters on the manual path. ScreenerAgent.runScreen
 * funnels both providers through screenUniverse -> screenWithQuotes ->
 * evaluateUniverse, where minRsi (screener.ts:288), maxRsi (300),
 * rsiFilter (389-406), momentum (352-373), minVolume (342),
 * minMarketCap (259), and maxPeRatio (275) each reject with a reason.
 * The provider flag only changes quote acquisition, not the filter
 * stage — so no per-provider gating is needed here, and no field is
 * accepted-but-ignored. (The listing-feed screenLive refusal path for
 * technical/volume/P/E criteria is unwired for manual runs.)
 *
 * Pins:
 *  - stockCriteriaToFilter: default/empty -> {}; enabled numerics ->
 *    numbers; minMarketCapB converts billions -> dollars (x1e9);
 *    a toggled-off criterion is omitted even with a value; a select
 *    left on "any" is omitted (server treats "any" as no constraint)
 *  - panel renders all seven criterion rows; a toggled-off row's input
 *    is disabled; toggling it on enables the input
 *  - last-run view shows sent values and "Not set" for unset fields;
 *    with no run yet it says so honestly
 *  - ScreenersHub wires the panel into the run form (source pin)
 *
 * Harness follows tests/trading_approvals_queue.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import {
  StockCriteriaPanel,
  defaultStockCriteria,
  stockCriteriaToFilter,
  type StockCriteriaState,
} from "../src/client/StockCriteriaPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderPanel(
  criteria: StockCriteriaState,
  lastSentFilters: Record<string, unknown> | null = null
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <StockCriteriaPanel
        criteria={criteria}
        onChange={() => {}}
        lastSentFilters={lastSentFilters}
      />
    );
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("Issue #1496 — stockCriteriaToFilter", () => {
  it("default criteria send nothing (existing behavior unchanged)", () => {
    expect(stockCriteriaToFilter(defaultStockCriteria)).toEqual({});
  });

  it("enabled numerics send numbers; market cap converts $B to dollars", () => {
    const criteria: StockCriteriaState = {
      ...defaultStockCriteria,
      minRsi: { enabled: true, value: "30" },
      maxRsi: { enabled: true, value: "70" },
      minVolume: { enabled: true, value: "100000" },
      minMarketCapB: { enabled: true, value: "10" },
      maxPeRatio: { enabled: true, value: "25" },
    };
    expect(stockCriteriaToFilter(criteria)).toEqual({
      minRsi: 30,
      maxRsi: 70,
      minVolume: 100000,
      minMarketCap: 10000000000,
      maxPeRatio: 25,
    });
  });

  it("a toggled-off criterion is omitted even with a value", () => {
    const criteria: StockCriteriaState = {
      ...defaultStockCriteria,
      minRsi: { enabled: false, value: "30" },
      maxRsi: { enabled: true, value: "70" },
    };
    expect(stockCriteriaToFilter(criteria)).toEqual({ maxRsi: 70 });
  });

  it("a select left on 'any' is omitted; a chosen band/momentum is sent", () => {
    const anySelected: StockCriteriaState = {
      ...defaultStockCriteria,
      rsiFilter: { enabled: true, value: "any" },
      momentum: { enabled: true, value: "any" },
    };
    expect(stockCriteriaToFilter(anySelected)).toEqual({});
    const chosen: StockCriteriaState = {
      ...defaultStockCriteria,
      rsiFilter: { enabled: true, value: "oversold" },
      momentum: { enabled: true, value: "bullish_breakout" },
    };
    expect(stockCriteriaToFilter(chosen)).toEqual({
      rsiFilter: "oversold",
      momentum: "bullish_breakout",
    });
  });

  it("an enabled but empty or non-numeric value is omitted, never NaN", () => {
    const criteria: StockCriteriaState = {
      ...defaultStockCriteria,
      minRsi: { enabled: true, value: "" },
      maxRsi: { enabled: true, value: "abc" },
    };
    expect(stockCriteriaToFilter(criteria)).toEqual({});
  });
});

describe("Issue #1496 — StockCriteriaPanel", () => {
  it("renders all seven criterion rows, toggled-off inputs disabled", () => {
    const el = renderPanel(defaultStockCriteria);
    for (const label of [
      "Min RSI",
      "Max RSI",
      "Min daily volume",
      "Min market cap",
      "Max P/E",
      "RSI band",
      "Momentum",
    ]) {
      expect(el.textContent).toContain(label);
    }
    const minRsi = el.querySelector("#stock-criteria-minRsi") as HTMLInputElement;
    expect(minRsi.disabled).toBe(true);
  });

  it("toggling a criterion on enables its input", () => {
    let current = defaultStockCriteria;
    const onChange = vi.fn((next: StockCriteriaState) => {
      current = next;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <StockCriteriaPanel criteria={current} onChange={onChange} lastSentFilters={null} />
      );
    });
    const toggle = container.querySelector('button[aria-label="Toggle Min RSI"]');
    expect(toggle).toBeDefined();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].minRsi.enabled).toBe(true);
  });

  it("last-run view shows sent values and 'Not set' for unset fields", () => {
    const el = renderPanel(defaultStockCriteria, {
      minRsi: 30,
      maxRsi: 70,
      universe: "TECH",
    });
    expect(el.textContent).toContain("30");
    expect(el.textContent).toContain("70");
    expect(el.textContent).toContain("Not set");
  });

  it("with no run yet the view says so instead of inventing criteria", () => {
    const el = renderPanel(defaultStockCriteria, null);
    expect(el.textContent).toMatch(/no run yet/i);
  });

  it("StockHub wires the panel into the stock run form (source pin, #2896)", () => {
    const src = readFileSync("src/client/StockHub.tsx", "utf8");
    expect(src).toContain("StockCriteriaPanel");
    expect(src).toContain("stockCriteriaToFilter(stockCriteria)");
    expect(src).toContain("lastSentStockFilters");
  });
});
