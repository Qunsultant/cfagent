/** @vitest-environment jsdom */
/**
 * Issue #126 (PR-C): the ScannerPanel's ScanResultsView must offer
 * the RESULT SET of the run being viewed as downloadable files (CSV
 * of the fit/opportunity rows, JSON of the stored run) — #126's
 * matrix — beside the existing PDF report link.
 *
 * Pins:
 *  - a rendered result shows CSV/JSON export controls;
 *  - exports target the VIEWED run: viewing a non-latest historical
 *    run downloads THAT run's rows and filename — never the latest
 *    run's (the failure mode of the neighbouring keyless PDF
 *    fallback, which is PR-D's scope and is not repeated here);
 *  - a completed run with zero fits still exports (header-only CSV);
 *  - a fresh (live) result exports its own rows.
 *
 * Harness follows tests/screeners_hub_run_downloads.test.tsx (PR-B)
 * and tests/scanner_panel.test.ts: react-dom/client in jsdom,
 * downloads captured by stubbing URL.createObjectURL + anchor click;
 * the panel flow runs the real scannerApi against a stubbed fetch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScannerPanel, ScanResultsView } from "../src/client/ScannerPanel";
import type {
  OpportunityScanResponse,
  ScanMode,
  ScanRunDetail,
  StoredScanRun,
} from "../src/client/scannerApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures ---------------------------------------------------------------

function fitRow(symbol: string, label: string) {
  return {
    symbol,
    verdict: "pass",
    targetPrice: 300,
    targetSource: "thesis",
    targetEmUnits: 0.5,
    gateBucket: "fit",
    gateReasons: [],
    cells: [
      {
        strategyType: "iron_condor",
        best: {
          candidateId: `${symbol.toLowerCase()}-ic`, label, compositeScore: 66.4, score: 60,
          expirationDate: "2026-11-20", legs: [], netDebit: -2.1, maxLoss: 290,
          maxProfit: 210, maxProfitUnbounded: false, targetRewardRisk: 0.72,
          probabilityOfProfit: 0.61,
        },
        evaluatedCount: 5, passedCount: 2, rejectedCount: 3, rejectionReasons: {},
      },
    ],
  };
}

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

const olderFits = [fitRow("AAPL", "Iron Condor"), fitRow("OLDCO", "Iron Condor")];
const olderRun = {
  id: "older-run-id",
  generatedAt: "2026-10-15T14:00:00.000Z",
  mode: "strategy_fit",
  modelVersion: "1.2.0",
  gate: { fit: 2, borderline: 0, noFit: 0 },
  coverage: { considered: 2, scanned: 2, truncated: 0, evaluated: 2, errors: 0, withTrades: 2 },
  profileRef: null,
  result: scanResult({
    fits: olderFits,
    fitsTotal: 2,
    gate: { fit: 2, borderline: 0, noFit: 0 },
    matrix: olderFits,
    generatedAt: "2026-10-15T14:00:00.000Z",
  }),
} as unknown as StoredScanRun;

const newerFits = [fitRow("MSFT", "Iron Condor")];
const newerRun = {
  id: "newer-run-id",
  generatedAt: "2026-10-16T14:00:00.000Z",
  mode: "strategy_fit",
  modelVersion: "1.2.0",
  gate: { fit: 1, borderline: 0, noFit: 0 },
  coverage: { considered: 1, scanned: 1, truncated: 0, evaluated: 1, errors: 0, withTrades: 1 },
  profileRef: null,
  result: scanResult({
    fits: newerFits,
    fitsTotal: 1,
    gate: { fit: 1, borderline: 0, noFit: 0 },
    matrix: newerFits,
    generatedAt: "2026-10-16T14:00:00.000Z",
  }),
} as unknown as StoredScanRun;

const emptyRun = {
  ...olderRun,
  id: "empty-run-id",
  generatedAt: "2026-10-14T14:00:00.000Z",
  gate: { fit: 0, borderline: 2, noFit: 1 },
  result: scanResult({
    fits: [],
    fitsTotal: 0,
    gate: { fit: 0, borderline: 2, noFit: 1 },
    matrix: [],
    generatedAt: "2026-10-14T14:00:00.000Z",
  }),
} as unknown as StoredScanRun;

// Harness ------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;

interface CapturedDownload {
  filename: string;
  blob: Blob;
}
const downloads: CapturedDownload[] = [];
let pendingBlob: Blob | null = null;

function stubDownloads() {
  downloads.length = 0;
  pendingBlob = null;
  (URL as any).createObjectURL = vi.fn((blob: Blob) => {
    pendingBlob = blob;
    return "blob:mock-export";
  });
  (URL as any).revokeObjectURL = vi.fn(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (pendingBlob) downloads.push({ filename: this.download, blob: pendingBlob });
    pendingBlob = null;
  });
}

function stubPanelFetch() {
  const runs = [newerRun, olderRun];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/etrade/options/scans/")) {
      const id = decodeURIComponent(url.split("/api/etrade/options/scans/")[1].split(/[?]/)[0]);
      const run = runs.find((r) => r.id === id);
      return run
        ? Response.json(run)
        : Response.json({ error: "scan run not found" }, { status: 404 });
    }
    if (url.includes("/api/etrade/options/scans")) {
      const summaries = runs.map(({ result: _result, ...summary }) => summary);
      return Response.json({ count: summaries.length, scans: summaries });
    }
    if (url.endsWith("/api/etrade/options/profiles")) {
      return Response.json({ count: 0, profiles: [] });
    }
    if (url.includes("/api/trading/options/catalog")) {
      return Response.json({ strategies: [] });
    }
    return Response.json({ error: "unstubbed" }, { status: 404 });
  }) as typeof fetch;
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 500)}`);
}

function exportButtons() {
  // The export controls are Buttons now (the dead .scanner-export-*
  // classes are gone after the #3051 migration); pin them by their
  // title attributes, which name the run the export targets.
  return {
    csv: container.querySelector<HTMLButtonElement>('button[title="Download result rows for this run as CSV"]'),
    json: container.querySelector<HTMLButtonElement>('button[title="Download the full stored result for this run as JSON"]'),
  };
}

async function clickExport(button: HTMLButtonElement | null) {
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await flush();
}

beforeEach(() => {
  stubDownloads();
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  globalThis.fetch = realFetch;
  delete (URL as any).createObjectURL;
  delete (URL as any).revokeObjectURL;
  vi.restoreAllMocks();
});

// ScanResultsView (direct render) ------------------------------------------

async function renderView(result: unknown, storedRun: unknown, mode: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ScanResultsView, {
        result: result as OpportunityScanResponse,
        runContext: { mode: mode as ScanMode, profileLabel: null },
        storedRun: storedRun as ScanRunDetail | null,
      }),
    );
  });
  await flush();
}

describe("ScanResultsView result-set downloads (#126 PR-C)", () => {
  it("a viewed stored run shows CSV/JSON controls beside the PDF link", async () => {
    // Fixture adapted for #126 PR-D: this scenario is about the
    // controls coexisting with the run's OWN PDF link, so the result
    // carries its keyed reportUrl (as the server builds it). The
    // shared olderRun fixture has no reportUrl; before PR-D the PDF
    // label rendered anyway via the keyless latest-PDF fallback,
    // which PR-D removes — a run without a reportUrl now shows no
    // PDF link (pinned in tests/pdf_report_link_honesty.test.tsx).
    await renderView(
      { ...olderRun.result, reportUrl: "/api/options/report.pdf?key=options:pdf:scan-20261015.pdf" },
      olderRun,
      "strategy_fit",
    );
    const { csv, json } = exportButtons();
    expect(csv?.textContent).toContain("CSV results");
    expect(json?.textContent).toContain("JSON run");
    expect(container.textContent).toContain("Download PDF report");
  });

  it("the CSV export is the VIEWED (non-latest) run's rows — content and filename", async () => {
    await renderView(olderRun.result, olderRun, "strategy_fit");
    await clickExport(exportButtons().csv);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("scan-20261015-140000-fits.csv");
    const text = await blobText(downloads[0].blob);
    expect(text).toContain("OLDCO");
    expect(text).toContain("AAPL");
    expect(text).not.toContain("MSFT");
  });

  it("the JSON export is the viewed run's stored object", async () => {
    await renderView(olderRun.result, olderRun, "strategy_fit");
    await clickExport(exportButtons().json);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("scan-20261015-140000.json");
    const parsed = JSON.parse(await blobText(downloads[0].blob));
    expect(parsed.id).toBe("older-run-id");
    expect(parsed.generatedAt).toBe("2026-10-15T14:00:00.000Z");
    expect(parsed.result.fits.map((r: any) => r.symbol)).toEqual(["AAPL", "OLDCO"]);
  });

  it("a completed run with zero fits exports a header-only CSV", async () => {
    await renderView(emptyRun.result, emptyRun, "strategy_fit");
    await clickExport(exportButtons().csv);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("scan-20261014-140000-fits.csv");
    const text = await blobText(downloads[0].blob);
    expect(text).toContain("rows in this file: 0");
    expect(text).toContain("symbol,strategy,compositeScore");
    expect(text).not.toContain("OLDCO");
  });

  it("a fresh live result (no stored run) exports its own rows", async () => {
    const liveResult = {
      ...newerRun.result,
      action: "opportunities",
      success: true,
      scanRunId: "newer-run-id",
      persisted: true,
    };
    await renderView(liveResult, null, "strategy_fit");
    await clickExport(exportButtons().csv);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("scan-20261016-140000-fits.csv");
    const text = await blobText(downloads[0].blob);
    expect(text).toContain("MSFT");
    expect(text).toContain("run id: newer-run-id");
  });
});

// ScannerPanel history flow --------------------------------------------------

describe("ScannerPanel — viewing a saved run points the exports at it (#126 PR-C)", () => {
  it("View on the older history row → CSV/JSON downloads carry the older run", async () => {
    stubPanelFetch();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(ScannerPanel, { activeEnv: "TEST", userLogin: "trader1" }));
    });
    await flush(60);
    await waitForText("Diff vs previous");

    const section = [...container.querySelectorAll(".ui-page-section")].find(
      (el) => el.querySelector("h2")?.textContent === "Scan history",
    );
    expect(section).not.toBeNull();
    const rows = [...section!.querySelectorAll<HTMLElement>(".ui-card")];
    expect(rows).toHaveLength(2);
    const viewButton = [...rows[1].querySelectorAll("button")].find((b) =>
      b.textContent?.includes("View"),
    );
    expect(viewButton).toBeTruthy();
    await act(async () => {
      viewButton!.click();
    });
    await waitForText("viewing the stored result, not a new run");

    await clickExport(exportButtons().csv);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("scan-20261015-140000-fits.csv");
    const text = await blobText(downloads[0].blob);
    expect(text).toContain("OLDCO");
    expect(text).not.toContain("MSFT");

    await clickExport(exportButtons().json);
    expect(downloads).toHaveLength(2);
    const parsed = JSON.parse(await blobText(downloads[1].blob));
    expect(parsed.id).toBe("older-run-id");
  });
});
