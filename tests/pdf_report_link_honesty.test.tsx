/** @vitest-environment jsdom */
/**
 * Issue #126 (PR-D): a results view's PDF link must be the VIEWED
 * run's own PDF — or no link at all.
 *
 * Before PR-D, both results views fell back to the KEYLESS report
 * endpoint when the viewed run had no PDF of its own:
 *   - ScannerPanel ScanResultsView: `result.reportUrl ||
 *     "/api/options/report.pdf"` — the keyless endpoint serves the
 *     LATEST options PDF, so a historical run silently downloaded a
 *     newer run's report (the wrong-run class #297 fixed for the
 *     stock screener's keyed links).
 *   - ScreenerResultsView: `reportUrl || (pdfKey ? keyed :
 *     "/api/screener/report.pdf")` — the same keyless fallback for
 *     runs whose per-run PDF generation failed (pdfKey is set only
 *     on success) and for failed runs.
 *
 * Pins:
 *  - a run WITH its own reportUrl/pdfKey keeps its PDF link,
 *    byte-identical href (reportUrl wins over pdfKey, as before);
 *  - a run WITHOUT one renders NO anchor to any report.pdf URL and
 *    no "Download PDF report" label — in both views;
 *  - PR-C's / PR-B's CSV+JSON result-set exports are unaffected:
 *    present in exactly the cases they were present before.
 *
 * Harness follows tests/scanner_run_downloads.test.tsx (PR-C) and
 * tests/screeners_hub_run_downloads.test.tsx (PR-B): react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScanResultsView } from "../src/client/ScannerPanel";
import { ScreenerResultsView, type ScreenerResultData } from "../src/client/ScreenerResultsView";
import type { OpportunityScanResponse, ScanRunDetail } from "../src/client/scannerApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures ---------------------------------------------------------------

function scanResult(overrides: Record<string, unknown>) {
  return {
    scanned: 2,
    withTrades: 2,
    opportunities: [],
    skipped: [],
    truncatedSymbols: 0,
    assumptions: [],
    matrix: [],
    typeRollup: [],
    mode: "strategy_fit",
    fits: [],
    fitsTotal: 0,
    gate: { fit: 0, borderline: 0, noFit: 0 },
    borderline: [],
    gateParams: { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" },
    profileRef: null,
    generatedAt: "2026-10-15T14:00:00.000Z",
    modelVersion: "1.2.0",
    requestSnapshot: {
      template: { thesis: "bullish", targetDate: "2026-11-20", maxPlannedLoss: 750, minRewardRisk: 1.5, allowedStrategies: ["all"] },
      mode: "strategy_fit",
      riskProfile: "balanced",
      profile: null,
    },
    configSnapshot: { maxScanSymbols: 25, targetFactors: {}, targetEmMultiples: {} },
    coverage: { considered: 2, scanned: 2, truncated: 0, evaluated: 2, errors: 0, withTrades: 2 },
    ...overrides,
  };
}

function screenRun(overrides: Partial<ScreenerResultData>): ScreenerResultData {
  return {
    timestamp: "2026-10-20T13:55:00.000Z",
    trigger: "scheduled",
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 1,
    opportunities: [
      { symbol: "NVDA", companyName: "NVDA Inc", signal: "bullish", momentumScore: 91, lastPrice: 100, changePercent: 1.5 },
    ],
    allStocks: [],
    discoveryMessage: "",
    ...overrides,
  };
}

// Harness ------------------------------------------------------------------

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

function pdfAnchors(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).filter((a) =>
    (a.getAttribute("href") || "").includes("report.pdf"),
  );
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

// ScannerPanel ScanResultsView ----------------------------------------------

describe("ScanResultsView PDF link (#126 PR-D)", () => {
  it("a run WITH its own reportUrl keeps the PDF link with that exact href; exports beside it", async () => {
    const reportUrl = "/api/options/report.pdf?key=options:pdf:scan-20261015.pdf";
    await render(
      React.createElement(ScanResultsView, {
        result: scanResult({ reportUrl }) as unknown as OpportunityScanResponse,
        runContext: { mode: "strategy_fit", profileLabel: null },
        storedRun: null as ScanRunDetail | null,
      }),
    );
    const anchors = pdfAnchors();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe(reportUrl);
    expect(anchors[0].textContent).toContain("Download PDF report");
    // PR-C exports unaffected.
    expect(container.querySelector('button[title="Download result rows for this run as CSV"]')).not.toBeNull();
    expect(container.querySelector('button[title="Download the full stored result for this run as JSON"]')).not.toBeNull();
  });

  it("a run WITHOUT a reportUrl shows NO PDF link and no keyless-endpoint anchor; exports still present", async () => {
    await render(
      React.createElement(ScanResultsView, {
        result: scanResult({}) as unknown as OpportunityScanResponse,
        runContext: { mode: "strategy_fit", profileLabel: null },
        storedRun: null as ScanRunDetail | null,
      }),
    );
    expect(pdfAnchors()).toHaveLength(0);
    // No anchor anywhere points at the keyless latest-PDF endpoint.
    const allHrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(allHrefs).not.toContain("/api/options/report.pdf");
    expect(container.textContent).not.toContain("Download PDF report");
    // PR-C exports unaffected.
    expect(container.querySelector('button[title="Download result rows for this run as CSV"]')).not.toBeNull();
    expect(container.querySelector('button[title="Download the full stored result for this run as JSON"]')).not.toBeNull();
  });
});

// ScreenerResultsView --------------------------------------------------------

describe("ScreenerResultsView PDF link (#126 PR-D)", () => {
  it("a run with only a pdfKey links its per-run keyed PDF; exports beside it", async () => {
    const pdfKey = "screener:pdf:run-a.pdf";
    await render(React.createElement(ScreenerResultsView, { result: screenRun({ pdfKey }) }));
    const anchors = pdfAnchors();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe(
      `/api/screener/report.pdf?key=${encodeURIComponent(pdfKey)}`,
    );
    expect(container.querySelector("button[title=\"Download this run's standout opportunities as CSV\"]")).not.toBeNull();
    expect(container.querySelector("button[title=\"Download this run's full result as JSON\"]")).not.toBeNull();
  });

  it("a run's own reportUrl wins over its pdfKey (precedence unchanged)", async () => {
    const reportUrl = "/api/screener/report.pdf?key=screener%3Apdf%3Aexplicit.pdf";
    await render(
      React.createElement(ScreenerResultsView, {
        result: screenRun({ reportUrl, pdfKey: "screener:pdf:other.pdf" }),
      }),
    );
    const anchors = pdfAnchors();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe(reportUrl);
  });

  it("a successful run with NEITHER reportUrl nor pdfKey (its PDF generation failed) shows NO PDF link", async () => {
    await render(React.createElement(ScreenerResultsView, { result: screenRun({}) }));
    expect(pdfAnchors()).toHaveLength(0);
    const allHrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(allHrefs).not.toContain("/api/screener/report.pdf");
    expect(container.textContent).not.toContain("Download PDF report");
    // The result set itself is still downloadable (PR-B exports).
    expect(container.querySelector("button[title=\"Download this run's standout opportunities as CSV\"]")).not.toBeNull();
    expect(container.querySelector("button[title=\"Download this run's full result as JSON\"]")).not.toBeNull();
  });

  it("a FAILED run shows NO PDF link (previously the keyless latest-PDF)", async () => {
    await render(
      React.createElement(ScreenerResultsView, {
        result: screenRun({
          success: false,
          totalScanned: 0,
          matchedCount: 0,
          opportunities: [],
          error: "E*TRADE unavailable: session expired",
        }),
      }),
    );
    expect(pdfAnchors()).toHaveLength(0);
    expect(container.textContent).not.toContain("Download PDF report");
    expect(container.textContent).toContain("E*TRADE unavailable: session expired");
  });
});
