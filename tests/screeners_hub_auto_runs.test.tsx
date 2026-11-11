/** @vitest-environment jsdom */
/**
 * Issue #125 (PR-A): the Autonomous Screen panel in ScreenersHub must let
 * the user REVIEW retained runs, not just the latest. The ScreenerAgent
 * persists up to 20 runs and GET /api/screener/latest returns them all
 * ({ count, runs, latest }, newest first); before this change the hub
 * rendered only runs[0] and dismissed the rest as inert text
 * ("N earlier runs retained").
 *
 * Harness follows the established panel tests (scanner_panel.test.ts):
 * the REAL apiFetch is driven against a stubbed global fetch (the route
 * answers 200 directly, so no 202 job-stub flow is involved), and the
 * component renders with react-dom/client in jsdom.
 *
 * Pins:
 *  - every retained run renders in the list with time, scope, counts and
 *    a status badge (success / partial / failed, derived from the fields
 *    ScreenerRunResult carries: success + the #462 partial qualification);
 *  - the latest run is the default selection;
 *  - selecting another run swaps the ScreenerResultsView input — and the
 *    per-run PDF link follows the SELECTED run's own pdfKey (#297);
 *  - quiet runs (success, zero standouts) and failed runs appear as runs
 *    in the list — history, not notifications.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  StockHub,
  screenRunStatus,
  resolveSelectedRun,
  SCREEN_RUN_STATUS_LABELS,
} from "../src/client/StockHub";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -----------------------------------------------------------------
// Shaped like the ScreenerRunResult objects GET /api/screener/latest
// returns in `runs` (newest first), so a server shape change breaks these
// tests on purpose.

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

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/screener/latest")) {
      return Response.json({ count: FIXTURE_RUNS.length, runs: FIXTURE_RUNS, latest: RUN_LATEST });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
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

function runItems(): HTMLElement[] {
  // Runs are now primitive Buttons (S-U2 #3051) in the
  // aria-labelled run-history list — no .screener-run-item class
  // remains. The status badge inside each is a ui-badge.
  return Array.from(
    container.querySelectorAll<HTMLElement>('[aria-label="Screener run history"] button'),
  );
}

function pdfHref(): string | null {
  const anchor = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((a) =>
    (a.getAttribute("href") || "").includes("/api/screener/report.pdf"),
  );
  return anchor?.getAttribute("href") ?? null;
}

beforeEach(() => {
  stubFetch();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// Pure logic -----------------------------------------------------------------

describe("screenRunStatus (#125)", () => {
  it("derives status from the fields ScreenerRunResult carries", () => {
    expect(screenRunStatus({ success: true })).toBe("success");
    expect(
      screenRunStatus({
        success: true,
        partial: { quotedCount: 47, requestedCount: 100, failedSymbols: ["XYZ"], failureReasons: { other: 53 } },
      }),
    ).toBe("partial");
    expect(screenRunStatus({ success: false })).toBe("failed");
    // A failed run is failed even if a partial qualification is present.
    expect(
      screenRunStatus({
        success: false,
        partial: { quotedCount: 0, requestedCount: 100, failedSymbols: [], failureReasons: {} },
      }),
    ).toBe("failed");
    expect(SCREEN_RUN_STATUS_LABELS).toEqual({ success: "Success", partial: "Partial", failed: "Failed" });
  });
});

describe("resolveSelectedRun (#125)", () => {
  const runs = [{ timestamp: "t3" }, { timestamp: "t2" }, { timestamp: "t1" }];
  it("defaults to the latest (first) run", () => {
    expect(resolveSelectedRun(runs, null)?.timestamp).toBe("t3");
  });
  it("returns the run matching the selected timestamp", () => {
    expect(resolveSelectedRun(runs, "t1")?.timestamp).toBe("t1");
  });
  it("falls back to the latest when the selection aged out of history", () => {
    expect(resolveSelectedRun(runs, "gone")?.timestamp).toBe("t3");
  });
  it("is undefined for an empty history", () => {
    expect(resolveSelectedRun([], null)).toBeUndefined();
  });
});

// Component ------------------------------------------------------------------

describe("StockHub autonomous run history (#125, moved by #2896)", () => {
  it("renders every retained run in the list with time, scope, counts and status badge", async () => {
    await renderHub();
    const items = runItems();
    expect(items).toHaveLength(FIXTURE_RUNS.length);

    FIXTURE_RUNS.forEach((run, i) => {
      const text = items[i].textContent || "";
      expect(text).toContain(new Date(run.timestamp).toLocaleString());
      expect(text).toContain(`${run.totalScanned} scanned`);
      expect(text).toContain(`${run.matchedCount} matched`);
      expect(text).toContain(`${run.opportunities.length} standout`);
      expect(items[i].querySelector(".ui-badge")?.textContent).toBe(
        SCREEN_RUN_STATUS_LABELS[screenRunStatus(run)],
      );
    });

    // Scope: universe always; sector only when one was actually selected
    // (the #421 convention — sector "ALL" makes no sector claim).
    expect(items[0].textContent).toContain("TECH");
    expect(items[0].textContent).toContain("Technology sector");
    expect(items[3].textContent).toContain("NASDAQ100");
    expect(items[3].textContent).not.toContain("ALL sector");

    // Status badges across the outcome spectrum.
    expect(items[0].querySelector(".ui-badge")?.textContent).toBe("Success");
    expect(items[1].querySelector(".ui-badge")?.textContent).toBe("Partial");
    expect(items[2].querySelector(".ui-badge")?.textContent).toBe("Failed");
    // The quiet run is a run in the list — with its (zero) counts shown.
    expect(items[3].querySelector(".ui-badge")?.textContent).toBe("Success");
    expect(items[3].textContent).toContain("0 standout");
  });

  it("defaults to the latest run: view + per-run PDF link + selection marker", async () => {
    await renderHub();
    const items = runItems();
    expect(items[0].getAttribute("aria-pressed")).toBe("true");
    expect(items[0].textContent).toContain("Viewing");
    for (const item of items.slice(1)) {
      expect(item.getAttribute("aria-pressed")).toBe("false");
    }
    // The results view shows the latest run…
    expect(container.textContent).toContain("NVDA");
    expect(container.textContent).toContain(new Date(RUN_LATEST.timestamp).toLocaleString());
    // …and the PDF link keys off the latest run's own pdfKey (#297).
    expect(pdfHref()).toContain(encodeURIComponent(RUN_LATEST.pdfKey));
  });

  it("selecting the partial run swaps the results view and the PDF key follows the selection", async () => {
    await renderHub();
    const items = runItems();
    await act(async () => {
      items[1].click();
    });
    await flush();

    expect(container.textContent).toContain("Partial screen — qualified results: 47 of 100 symbols quoted");
    expect(container.textContent).toContain("MSFT");
    expect(pdfHref()).toContain(encodeURIComponent(RUN_PARTIAL.pdfKey));
    expect(items[1].getAttribute("aria-pressed")).toBe("true");
    expect(items[1].textContent).toContain("Viewing");
    expect(items[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("selecting the failed run shows its recorded failure in the view", async () => {
    await renderHub();
    const items = runItems();
    await act(async () => {
      items[2].click();
    });
    await flush();

    expect(container.textContent).toContain("⚠️ Failed:");
    expect(container.textContent).toContain("E*TRADE unavailable: session expired");
    expect(items[2].getAttribute("aria-pressed")).toBe("true");
  });
});

// Truth in the panel (#2075) ------------------------------------------------
// The panel used to claim a "5 min" cadence it cannot prove and to hide the
// one field that tells a manual run from a scheduled one: the trigger.
// Regression pins for the observed case (TECH card whose latest — and only
// retained — run was manual): the card must carry the run's true trigger,
// the panel must state no cadence it cannot prove, and the counts must be
// defined where they are printed.

const RUN_MANUAL_TECH = {
  timestamp: "2026-10-27T23:11:17.000Z",
  trigger: "manual",
  universe: "TECH",
  sector: "Technology",
  success: true,
  totalScanned: 50,
  matchedCount: 50,
  opportunities: [opp("NVDA", 91), opp("PLTR", 88), opp("MSFT", 84), opp("AAPL", 82), opp("AMD", 80)],
  allStocks: [
    { ...opp("NVDA", 91), rsi14: 62, source: "E*TRADE live" },
    { ...opp("PLTR", 88), rsi14: 58, source: "E*TRADE live" },
  ],
  discoveryMessage: "",
  pdfKey: "screener:pdf:manual-tech.pdf",
};

function stubRuns(runs: unknown[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/screener/latest")) {
      return Response.json({ count: runs.length, runs, latest: runs[0] ?? null });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
}

function panelEl(): HTMLElement {
  // The autonomous panel is now a primitive Card (S-U2 #3051) headed
  // "🤖 Autonomous Screen" — no .screener-feed-callout class remains.
  const el = Array.from(container.querySelectorAll<HTMLElement>(".ui-card")).find((c) =>
    (c.textContent || "").includes("Autonomous Screen"),
  );
  if (!el) throw new Error("autonomous panel not rendered");
  return el as HTMLElement;
}

function universeCard(universe: string): HTMLElement {
  const btn = Array.from(panelEl().querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes(universe.toUpperCase()),
  );
  if (!btn) throw new Error(`no universe card for ${universe}`);
  return btn as HTMLElement;
}

describe("StockHub autonomous panel truth (#2075, moved by #2896)", () => {
  it("labels a manual latest run's card Manual, never as a scheduled run", async () => {
    stubRuns([RUN_MANUAL_TECH]);
    await renderHub();
    const card = universeCard("TECH");
    expect(card.textContent).toContain("Manual");
    expect(card.textContent).not.toContain("Scheduled");
  });

  it("labels a scheduled latest run's card Scheduled", async () => {
    stubRuns([RUN_LATEST]);
    await renderHub();
    const card = universeCard("TECH");
    expect(card.textContent).toContain("Scheduled");
  });

  it("states no false cadence, states the retention cap and refresh, and defines the counts", async () => {
    stubRuns([RUN_MANUAL_TECH]);
    await renderHub();
    const text = panelEl().textContent || "";
    expect(text).not.toMatch(/5 min|5-minute/);
    expect(text).toContain("up to 20 runs");
    expect(text).toContain("60 seconds");
    expect(text).toContain("passed the screen's filters");
  });

  it("empty state makes no tick claim", async () => {
    stubRuns([]);
    await renderHub();
    const text = panelEl().textContent || "";
    expect(text).not.toMatch(/5 min|5-minute|tick/);
    expect(text).toContain("No screener runs recorded yet");
  });
});
