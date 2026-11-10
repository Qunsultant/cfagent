/** @vitest-environment jsdom */
/**
 * Issue #3356 — portfolio-risk parity for the selected broker.
 *
 * What these tests defend:
 *   1. The risk report, the post-trade evaluator, concentration and sizing read
 *      the SELECTED broker: an Alpaca tenant never touches `/api/etrade/*`.
 *   2. The E*TRADE-only drafts (hedge, repair, recommendation bundle, guardrail
 *      check) are never requested for another broker, and say why they are
 *      absent instead of rendering an empty section or a failed call.
 *   3. E*TRADE is untouched: same endpoints, same sections.
 *   4. The hub gates on the catalogue's declaration, not on a broker name.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PortfolioRiskPanel } from "../src/client/PortfolioRiskPanel";
import { riskApiPath } from "../src/client/portfolioRiskApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

interface RecordedCall {
  url: string;
  method: string;
}

let calls: RecordedCall[] = [];
let container: HTMLDivElement;
let root: Root | null = null;

const RISK_REPORT = {
  rows: [],
  totals: {
    deltaDollars: 0,
    betaWeightedDeltaDollars: 0,
    gammaSharesPerDollar: 0,
    thetaDollarsPerDay: 0,
    vegaDollarsPerVolPoint: 0,
    rhoDollarsPerRatePoint: 0,
    definedMaxLoss: 0,
    undefinedRiskCount: 0,
  },
  excluded: [],
  partial: [],
  undefinedRiskPositions: [],
  spyPrice: null,
};

beforeEach(() => {
  calls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: (init?.method || "GET").toUpperCase() });
    const body = url.includes("portfolio-risk") ? RISK_REPORT : {};
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
  vi.restoreAllMocks();
});

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("which backend serves a risk read (#3356)", () => {
  it("keeps E*TRADE on its own routes", () => {
    expect(riskApiPath("etrade", "/portfolio-risk")).toBe("/api/etrade/portfolio-risk");
    expect(riskApiPath("etrade", "/portfolio-risk/size")).toBe("/api/etrade/portfolio-risk/size");
  });

  it("sends every other broker to the neutral routes", () => {
    expect(riskApiPath("alpaca", "/portfolio-risk")).toBe("/api/broker/portfolio-risk");
    expect(riskApiPath("alpaca", "/portfolio-risk/correlation")).toBe(
      "/api/broker/portfolio-risk/correlation",
    );
    expect(riskApiPath("alpaca", "/portfolio-risk/evaluate")).toBe("/api/broker/portfolio-risk/evaluate");
  });
});

describe("the panel follows the broker (#3356)", () => {
  it("an Alpaca panel reads the neutral report and requests no E*TRADE draft", async () => {
    act(() => root!.render(<PortfolioRiskPanel activeEnv="TEST" onPreviewHedge={() => {}} broker="alpaca" />));
    await flush();

    const urls = calls.map((call) => call.url);
    expect(urls.some((url) => url === "/api/broker/portfolio-risk" || url.endsWith("/api/broker/portfolio-risk"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/etrade/"))).toBe(false);
    expect(urls.some((url) => url.includes("hedge/analyze"))).toBe(false);
    expect(urls.some((url) => url.includes("portfolio-repair"))).toBe(false);

    // The E*TRADE-only halves are named, not silently missing.
    expect(container.querySelector('[data-broker-surface="hedge-repair"]')?.textContent).toContain(
      "E*TRADE features",
    );
    expect(container.querySelector('[data-broker-surface="bundle"]')?.textContent).toContain(
      "E*TRADE features",
    );
    expect(container.textContent).not.toContain("Hedge Proposals");
    expect(container.textContent).not.toContain("Repair Proposals");
  });

  it("an E*TRADE panel is byte-identical in behaviour: same routes, same sections", async () => {
    act(() => root!.render(<PortfolioRiskPanel activeEnv="TEST" onPreviewHedge={() => {}} broker="etrade" />));
    await flush();

    const urls = calls.map((call) => call.url);
    expect(urls.some((url) => url.endsWith("/api/etrade/portfolio-risk"))).toBe(true);
    expect(urls.some((url) => url.includes("hedge/analyze"))).toBe(true);
    expect(urls.some((url) => url.includes("portfolio-repair"))).toBe(true);
    expect(urls.some((url) => url.includes("/api/broker/portfolio-risk"))).toBe(false);

    expect(container.textContent).toContain("Hedge Proposals");
    expect(container.textContent).toContain("Repair Proposals");
    expect(container.querySelector('[data-broker-surface="hedge-repair"]')).toBeNull();
  });
});

describe("the hub gates on the catalogue (#3356)", () => {
  it("asks the catalogue whether the broker can risk-report, and passes the broker", () => {
    // #3050 PR5: the portfolio sub-tab moved out of the hub into PortfolioPanel;
    // the catalogue gate travels with it. Same assertions, new host.
    const hub = readFileSync("src/client/ETradeTradingHub.tsx", "utf8");
    const panel = readFileSync("src/client/PortfolioPanel.tsx", "utf8");
    const src = hub + panel;
    expect(src).toContain('brokerSupports(riskBroker, "portfolioRisk")');
    expect(src).toContain("broker={riskBroker}");
    // The removed defect: a broker name standing in for a capability.
    expect(src).not.toContain('selectedBroker === "etrade" ? (\n              <PortfolioRiskPanel');
  });
});
