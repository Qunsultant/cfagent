/** @vitest-environment jsdom */
/**
 * Issue #2438 (ScreenersHub redesign, ScreenersHub first):
 *  - one flow: digest → ONE detail Card → compact run list (grouped
 *    universe cards go away); manual form in a clearly-headed secondary
 *    placement; fields never reshape by provider; result paths collapse
 *    to ScreenerResultsView (legacy auto-column Table goes away);
 *  - Planned tabs leave the primary bar until implemented;
 *  - header shows the selected run's identity or nothing (no manual-run
 *    leftovers);
 *  - errors render via Notice, never .options-error divs;
 *  - digest→detail keeps a back-to-digest control.
 *
 * Harness follows tests/screeners_hub_auto_runs.test.tsx: the REAL
 * apiFetch is driven against a stubbed global fetch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { StockHub } from "../src/client/StockHub";
import { ScreenersHub } from "../src/client/ScreenersHub";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement scrollIntoView; the tab bar centers the active chip.
Element.prototype.scrollIntoView = vi.fn() as any;

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
  opportunities: [opp("NVDA", 91)],
  allStocks: [{ ...opp("NVDA", 91), rsi14: 62, source: "E*TRADE live" }],
  pdfKey: "screener:pdf:latest-run.pdf",
};

const RUN_FAILED = {
  timestamp: "2026-10-20T13:45:00.000Z",
  trigger: "manual",
  universe: "NASDAQ100",
  sector: "ALL",
  success: false,
  totalScanned: 0,
  matchedCount: 0,
  opportunities: [],
  allStocks: [],
  error: "E*TRADE unavailable: session expired",
};

const FIXTURE_RUNS = [RUN_LATEST, RUN_FAILED];

function providerHealth(status: string) {
  return {
    status,
    totalCaptures: 10,
    capturedCount: 9,
    failedCount: 1,
    failureRate: 0.1,
    lastSuccessAt: "2026-10-30T11:00:00.000Z",
    lastFailureAt: "2026-10-30T10:00:00.000Z",
    consecutiveFailures: 0,
    totalRawBytes: 2048,
    capturesLast24h: 5,
    failuresLast24h: 1,
    byCapability: {},
  };
}

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ? String(input.url) : String(input);
    if (url.includes("/api/screener/latest")) {
      return Response.json({ count: FIXTURE_RUNS.length, runs: FIXTURE_RUNS, latest: RUN_LATEST });
    }
    if (url.includes("/api/data-providers")) {
      return Response.json({
        providers: [
          {
            id: "etrade",
            adapterKind: "etrade",
            lifecycleState: "enabled",
            enabled: true,
            precedence: 1,
            credentialRef: "env:ETRADE_API_KEY",
            config: {},
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-30T00:00:00.000Z",
            declaredCapabilities: ["quotes"],
            verification: null,
            serving: true,
            health: providerHealth("healthy"),
          },
        ],
        routes: [],
      });
    }
    if (url.includes("/api/etrade/oauth/status")) {
      return Response.json({
        authenticated: true,
        environment: "PROD",
        tokenScopes: { loginScoped: true, unscoped: false, internalId: false, aliasLogin: false },
      });
    }
    if (url.includes("/api/trading/reports/confirmations")) {
      return Response.json({ confirmations: [] });
    }
    if (url.includes("/api/trading/reports/pending")) {
      return Response.json({ pending: [] });
    }
    if (url.includes("/api/etrade/screen")) {
      return Response.json({ error: "Screening request failed: upstream down" }, { status: 500 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderHub(props: Partial<React.ComponentProps<typeof StockHub>> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<StockHub activeEnv="PROD" userLogin="tester" {...props} />);
  });
  await flush();
  await flush();
}

// The old hub still hosts the planned-asset bar; its default options tab
// needs toast context (#2896: stocks left the old hub for StockHub).
async function renderOldHub() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider><ScreenersHub activeEnv="PROD" userLogin="tester" /></ToastProvider>);
  });
  await flush();
  await flush();
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

describe("StockHub redesign (#2438, moved by #2896)", () => {
  it("shows the Planned tabs in the primary bar (#2783 supersedes the #2438 exclusion)", async () => {
    // Planned asset tabs still live on the old hub's asset bar.
    await renderOldHub();
    const barButtons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent || "");
    for (const planned of ["Forex", "Futures", "Commodities", "Bonds"]) {
      expect(barButtons.some((t) => t.includes(planned))).toBe(true);
    }
    // Stocks left the old hub for StockHub (#2896): its tab bar carries it.
    await act(async () => {
      root.unmount();
    });
    container.remove();
    await renderHub();
    const hubButtons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent || "");
    expect(hubButtons.some((t) => t.includes("Stocks"))).toBe(true);
  });

  it("drops the grouped universe cards and keeps the compact run list", async () => {
    await renderHub();
    expect(container.querySelector('[aria-label="Scheduled jobs by universe"]')).toBeNull();
    // The compact run list is now primitive Buttons (S-U2 #3051) in
    // the aria-labelled run-history list — no .screener-run-item
    // class remains.
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[aria-label="Screener run history"] button'),
    );
    expect(items).toHaveLength(2);
  });

  it("renders the selected run detail as ONE card with a back-to-digest control", async () => {
    await renderHub();
    const detail = container.querySelector("#selected-run-detail");
    expect(detail).not.toBeNull();
    const headings = Array.from(detail!.querySelectorAll("h3")).filter((h) => h.textContent === "Run detail");
    expect(headings).toHaveLength(1);
    expect(detail!.textContent || "").toContain("Scheduled");
    expect(detail!.textContent || "").toContain("12 matched of 100 scanned");
    const back = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Back to digest"),
    );
    expect(back).toBeDefined();
  });

  it("shows the selected run's identity in the header, never manual-run leftovers", async () => {
    await renderHub();
    const text = container.textContent || "";
    expect(text).not.toContain("Last scan:");
    expect(text).toContain("TECH");
  });

  it("keeps every manual form field rendered for both providers (no reshaping)", async () => {
    await renderHub({ initialTab: "new-screen" });
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    const labels = Array.from(form!.querySelectorAll("label")).map((l) => l.textContent || "");
    for (const label of ["Ticker or company search", "Exchange", "Min price", "Max price", "Daily trend", "Max results"]) {
      expect(labels.some((t) => t.includes(label))).toBe(true);
    }
    expect(container.textContent || "").toContain("Run a new screen");
  });

  it("renders manual errors via Notice, never an .options-error div", async () => {
    await renderHub({ initialTab: "new-screen" });
    const form = container.querySelector("form")!;
    const submit = Array.from(form.querySelectorAll("button")).find((b) => b.type === "submit")!;
    await act(async () => {
      submit.click();
    });
    await flush();
    await flush();
    expect(container.querySelector(".options-error")).toBeNull();
    const notices = Array.from(container.querySelectorAll(".ui-notice"));
    const manualNotice = notices.find((n) => (n.textContent || "").includes("upstream down"));
    expect(manualNotice).toBeDefined();
  });

  it("hosts the provider dashboard section in the stocks panel", async () => {
    await renderHub();
    const dashboard = container.querySelector("#provider-dashboard");
    expect(dashboard).not.toBeNull();
    expect(dashboard!.textContent || "").toContain("Provider connectivity");
  });

  it("source pin: no legacy auto-column table, no .options-error div, no grouped-cards block", () => {
    const src = readFileSync("src/client/ScreenersHub.tsx", "utf8");
    expect(src).not.toContain('className="options-error"');
    expect(src).not.toContain("Scheduled jobs by universe");
    expect(src).not.toContain("Object.keys(rows[0])");
    expect(src).not.toContain("Last scan:");
  });
});
