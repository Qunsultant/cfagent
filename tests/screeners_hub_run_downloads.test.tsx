/** @vitest-environment jsdom */
/**
 * Issue #125 (PR-B) / #126: the ScreenerResultsView must offer the
 * RESULT SET of the run being viewed as downloadable files (CSV of the
 * standouts, CSV of the full scanned set, JSON of the run) — #126's
 * matrix — beside the existing per-run PDF link.
 *
 * Harness follows tests/screeners_hub_auto_runs.test.tsx (PR-A): the
 * real apiFetch against a stubbed global fetch, hub rendered with
 * react-dom/client in jsdom. Downloads are captured by stubbing
 * URL.createObjectURL and the anchor click: the captured Blob's text
 * and the anchor's download filename pin WHICH run an export targets.
 *
 * Pins:
 *  - a successful run shows CSV/JSON controls (plus the all-screened
 *    CSV when the run carries allStocks);
 *  - exports target the VIEWED run: switching the PR-A run selection
 *    re-points the downloads (filename + content) at the newly
 *    selected run;
 *  - a partial run's CSV carries its #462 qualification;
 *  - a failed run offers NO result-set download.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StockHub } from "../src/client/StockHub";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures (same shapes as the PR-A test) -------------------------------

const opp = (symbol: string, momentumScore: number) => ({
  symbol,
  companyName: `${symbol} Inc`,
  signal: "bullish",
  momentumScore,
  lastPrice: 100,
  changePercent: 1.5,
});

const RUN_LATEST = {
  timestamp: "2026-10-20T13:55:00.000Z",
  trigger: "scheduled",
  universe: "TECH",
  sector: "Technology",
  success: true,
  totalScanned: 100,
  matchedCount: 12,
  opportunities: [opp("NVDA", 91), opp("PLTR", 88)],
  allStocks: [
    { ...opp("NVDA", 91), rsi14: 62, source: "E*TRADE live" },
    { ...opp("PLTR", 88), rsi14: 58, source: "E*TRADE live" },
  ],
  discoveryMessage: "",
  pdfKey: "screener:pdf:latest-run.pdf",
};

const RUN_PARTIAL = {
  timestamp: "2026-10-20T13:50:00.000Z",
  trigger: "scheduled",
  universe: "TECH",
  sector: "Technology",
  success: true,
  totalScanned: 47,
  matchedCount: 5,
  opportunities: [opp("MSFT", 84)],
  allStocks: [{ ...opp("MSFT", 84), rsi14: 51, source: "E*TRADE live" }],
  discoveryMessage: "",
  partial: {
    quotedCount: 47,
    requestedCount: 100,
    failedSymbols: ["XYZ"],
    failureReasons: { other: 53 },
  },
  pdfKey: "screener:pdf:partial-run.pdf",
};

const RUN_FAILED = {
  timestamp: "2026-10-20T13:45:00.000Z",
  trigger: "scheduled",
  universe: "TECH",
  sector: "Technology",
  success: false,
  totalScanned: 0,
  matchedCount: 0,
  opportunities: [],
  allStocks: [],
  discoveryMessage: "",
  error: "E*TRADE unavailable: session expired",
};

const RUN_QUIET = {
  timestamp: "2026-10-20T13:40:00.000Z",
  trigger: "scheduled",
  universe: "NASDAQ100",
  sector: "ALL",
  success: true,
  totalScanned: 80,
  matchedCount: 0,
  opportunities: [],
  allStocks: [],
  discoveryMessage: "",
  pdfKey: "screener:pdf:quiet-run.pdf",
};

const FIXTURE_RUNS = [RUN_LATEST, RUN_PARTIAL, RUN_FAILED, RUN_QUIET];

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

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/screener/latest")) {
      return Response.json({ count: FIXTURE_RUNS.length, runs: FIXTURE_RUNS, latest: RUN_LATEST });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
}

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

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderHub() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<StockHub activeEnv="PROD" userLogin="tester" />);
  });
  await flush();
  await flush();
}

async function selectRun(index: number) {
  // Runs are now primitive Buttons (S-U2 #3051) in the
  // aria-labelled run-history list — no .screener-run-item class
  // remains.
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[aria-label="Screener run history"] button'),
  );
  await act(async () => {
    items[index].click();
  });
  await flush();
}

function exportButtons() {
  // Result-set downloads are now classless primitive Buttons (S-U2
  // #3051) — no .screener-export-* classes remain — so find them by
  // their visible label.
  const byText = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      (b.textContent || "").includes(text),
    ) ?? null;
  return {
    csv: byText("CSV standouts"),
    csvAll: byText("CSV all screened"),
    json: byText("JSON run"),
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
  stubFetch();
  stubDownloads();
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

// Component ----------------------------------------------------------------

describe("StockHub run result-set downloads (#125 PR-B / #126, moved by #2896)", () => {
  it("a successful run shows CSV standouts, CSV all-screened and JSON controls", async () => {
    await renderHub();
    const { csv, csvAll, json } = exportButtons();
    expect(csv?.textContent).toContain("CSV standouts");
    expect(csvAll?.textContent).toContain("CSV all screened");
    expect(json?.textContent).toContain("JSON run");
  });

  it("the default (latest) run's CSV targets that run — filename and content", async () => {
    await renderHub();
    await clickExport(exportButtons().csv);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("screen-20261020-135500-technology-standouts.csv");
    const text = await blobText(downloads[0].blob);
    expect(text).toContain("NVDA");
    expect(text).toContain("PLTR");
    expect(text).not.toContain("MSFT");
  });

  it("the JSON export is the viewed run's full result object", async () => {
    await renderHub();
    await clickExport(exportButtons().json);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("screen-20261020-135500-technology.json");
    const parsed = JSON.parse(await blobText(downloads[0].blob));
    expect(parsed.timestamp).toBe(RUN_LATEST.timestamp);
    expect(parsed.opportunities.map((o: any) => o.symbol)).toEqual(["NVDA", "PLTR"]);
  });

  it("switching the selected run re-points the downloads at the newly selected run", async () => {
    await renderHub();
    await selectRun(1); // the partial run
    await clickExport(exportButtons().csv);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("screen-20261020-135000-technology-standouts.csv");
    const text = await blobText(downloads[0].blob);
    expect(text).toContain("MSFT");
    expect(text).not.toContain("NVDA");
    // The partial qualification travels with the file.
    expect(text).toContain("# PARTIAL RUN: 47 of 100 symbols quoted");
    expect(text).toContain("other=53");
  });

  it("a failed run offers no result-set download", async () => {
    await renderHub();
    await selectRun(2); // the failed run
    const { csv, csvAll, json } = exportButtons();
    expect(csv).toBeNull();
    expect(csvAll).toBeNull();
    expect(json).toBeNull();
    expect(downloads).toHaveLength(0);
  });

  it("a quiet successful run offers CSV/JSON but no all-screened CSV (empty set)", async () => {
    await renderHub();
    await selectRun(3); // the quiet run — sector ALL, nothing scanned into allStocks
    const { csv, csvAll, json } = exportButtons();
    expect(csv).not.toBeNull();
    expect(json).not.toBeNull();
    expect(csvAll).toBeNull();

    await clickExport(csv);
    expect(downloads).toHaveLength(1);
    // No sector scope in the filename — none was selected (#421).
    expect(downloads[0].filename).toBe("screen-20261020-134000-standouts.csv");
    const text = await blobText(downloads[0].blob);
    expect(text).toContain("standouts: 0");
  });
});
