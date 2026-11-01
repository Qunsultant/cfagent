/** @vitest-environment jsdom */
/**
 * Consolidation C1 (issue #1201, epic #1151 R1) — the hub's Goal
 * Screen surface: renders the panel, runs a goal-driven screen
 * through the (stubbed) route, shows the honesty status verbatim
 * (complete / PARTIAL with failed classes + reasons), and backtests
 * the stock hits in place with provenance + limitations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GoalScreenPanel } from "../src/client/GoalScreenPanel";
import { ScreenersHub } from "../src/client/ScreenersHub";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const goalResult = {
  goalKind: "income",
  outlook: "bullish",
  status: "complete",
  hits: [
    { assetClass: "stocks", providerId: "etrade-yahoo-stocks", symbol: "AAPL" },
    { assetClass: "options", providerId: "dynamic-options", symbol: "NVDA", structures: ["cash_secured_put"] },
  ],
  counts: { stocksScanned: 100, stocksMatched: 1, optionsUnderlyingsScanned: 40, optionsContractsMatched: 3, hits: 2 },
  completedAt: "2026-10-23T12:00:00.000Z",
};

const backtestResult = {
  success: true,
  provenance: "live",
  aggregate: { totalTrades: 4, totalNetPnl: 1250.5, totalReturnPct: 1.25, winRate: 0.75, maxDrawdown: 0, maxDrawdownPct: 0.5 },
  limitations: ["Fills are assumed at bar closes."],
  folds: [],
};

describe("C1 GoalScreenPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let goalResponse: { status: number; body: unknown };

  beforeEach(() => {
    goalResponse = { status: 200, body: { success: true, executed: true, result: goalResult } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/screening/goal-screen")) {
          return {
            ok: goalResponse.status < 300,
            status: goalResponse.status,
            json: async () => goalResponse.body,
          };
        }
        if (url.includes("/api/screening/backtest")) {
          return { ok: true, status: 200, json: async () => backtestResult };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      })
    );
    Element.prototype.scrollIntoView = vi.fn() as any;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  async function submitRun() {
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("runs a goal screen and renders the complete result with provider provenance", async () => {
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await submitRun();
    expect(container.textContent).toContain("Complete — income (bullish)");
    expect(container.textContent).toContain("AAPL");
    expect(container.textContent).toContain("etrade-yahoo-stocks");
    expect(container.textContent).toContain("NVDA");
    expect(container.textContent).toContain("cash_secured_put");
  });

  it("backtests the stock hits in place, showing provenance and limitations", async () => {
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await submitRun();
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Backtest the 1 stock hit")
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(container.textContent).toContain("Backtest (provenance: live)");
    expect(container.textContent).toContain("Fills are assumed at bar closes.");
  });

  it("renders a PARTIAL run with the failed classes and reasons — never as complete", async () => {
    goalResponse = {
      status: 200,
      body: {
        success: true,
        executed: true,
        result: {
          ...goalResult,
          status: "partial",
          partial: { failedClasses: ["options"], reasons: { options: "E*TRADE options chain unavailable" } },
        },
      },
    };
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await submitRun();
    expect(container.textContent).toContain("PARTIAL — options failed: E*TRADE options chain unavailable");
    expect(container.textContent).not.toContain("Complete — income");
  });

  it("hides the Candidate structures column when no hit carries structures (#1963)", async () => {
    goalResponse = {
      status: 200,
      body: {
        success: true,
        executed: true,
        result: {
          ...goalResult,
          hits: [
            { assetClass: "stocks", providerId: "etrade-yahoo-stocks", symbol: "AAPL" },
            { assetClass: "stocks", providerId: "etrade-yahoo-stocks", symbol: "MSFT" },
          ],
          counts: {
            stocksScanned: 6594,
            stocksMatched: 6594,
            optionsUnderlyingsScanned: 0,
            optionsContractsMatched: 0,
            hits: 2,
          },
        },
      },
    };
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await submitRun();
    expect(container.textContent).toContain("AAPL");
    expect(container.textContent).not.toContain("Candidate structures");
  });

  it("renders PDF, XLSX, and CSV download links when artifact keys are present (#2625)", async () => {
    goalResponse = {
      status: 200,
      body: {
        success: true,
        executed: true,
        result: {
          ...goalResult,
          pdfKey: "goal_screen:pdf:test1234",
          xlsxKey: "goal_screen:xlsx:test1234",
          csvKey: "goal_screen:csv:test1234",
        },
      },
    };
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await submitRun();

    const pdfLink = container.querySelector("a.goal-screen-download-pdf") as HTMLAnchorElement;
    const xlsxLink = container.querySelector("a.goal-screen-download-xlsx") as HTMLAnchorElement;
    const csvLink = container.querySelector("a.goal-screen-download-csv") as HTMLAnchorElement;

    expect(pdfLink).not.toBeNull();
    expect(pdfLink.href).toContain("/api/screening/goal-screen/report.pdf?key=goal_screen%3Apdf%3Atest1234");
    expect(pdfLink.textContent).toContain("Download PDF");

    expect(xlsxLink).not.toBeNull();
    expect(xlsxLink.href).toContain("/api/screening/goal-screen/report.xlsx?key=goal_screen%3Axlsx%3Atest1234");
    expect(xlsxLink.textContent).toContain("Download XLSX");

    expect(csvLink).not.toBeNull();
    expect(csvLink.href).toContain("/api/screening/goal-screen/report.csv?key=goal_screen%3Acsv%3Atest1234");
    expect(csvLink.textContent).toContain("Download CSV");
  });

  it("the hub hosts the panel under its goal-screen tab", async () => {
    await act(async () => {
      root.render(<ScreenersHub activeEnv="PROD" userLogin="alice" initialTab="goal-screen" />);
    });
    expect(container.textContent).toContain("Run goal screen");
    expect(container.textContent).toContain("Goal Screen");
  });
});
