/** @vitest-environment jsdom */
/**
 * Issue 6273 — Opportunity Hunt UX surface: the on-demand run seam
 * (POST /opportunity-hunt/run), the Stock Hub sub-tab, and the panel.
 *
 * Route tests run the REAL hunt evaluator over mocked persisted bars,
 * so the setups asserted here are the evaluator's own answers, not
 * fixtures of the route: a 2% dip on the latest bar enters the three
 * mean-reversion-family strategies; a flat series enters nothing; a
 * short series is skipped.
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

vi.mock("../src/client/jobsApi", () => ({
  listAllRuns: vi.fn(),
  runOpportunityHuntNow: vi.fn(),
}));

// Issue 6406 — the panel renders a lightweight-charts detail chart, and
// jsdom has neither canvas nor matchMedia. The chart is mocked at the
// library boundary (the 6406 suite pins the chart wiring itself), and
// ResizeObserver is stubbed so the component's mount effect runs.
vi.mock("lightweight-charts", () => {
  const series = {
    setData: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
  };
  const chart = {
    addSeries: vi.fn(() => series),
    remove: vi.fn(),
    applyOptions: vi.fn(),
    timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  };
  return { createChart: vi.fn(() => chart), LineSeries: {}, ColorType: { Solid: "solid" } };
});

(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { createFeedDatasetAdapter } from "../src/data/createFeedDatasetPorts";
import {
  buildFeedJobRegistry,
  readPersistedTechnicalsBars,
} from "../src/services/feedJobs";
import {
  handleOpportunityHuntRoutes,
  type OpportunityHuntRouteContext,
} from "../src/agents/routes/opportunityHunt";
import { SUB_MENU_CONFIGS } from "../src/client/navConfig";
import {
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";
import { STOCK_HUB_TABS } from "../src/client/StockHub";
import { OpportunityHuntPanel } from "../src/client/OpportunityHuntPanel";
import {
  listAllRuns,
  runOpportunityHuntNow,
} from "../src/client/jobsApi";
import type { YahooDailyBar } from "../src/trading/technicals";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ctx: OpportunityHuntRouteContext = {
  env: { AGENT_DB: {} },
  getOrm: () => undefined,
  readSettingRaw: () => null,
};

const req = (method: string, path: string) =>
  new Request(`https://agent.internal${path}`, { method });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

function bars(closes: number[]): YahooDailyBar[] {
  return closes.map((close, i) => ({
    date: `2026-11-${String(i + 1).padStart(2, "0")}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

function mockBars(
  bySymbol: Map<string, YahooDailyBar[]>,
  stale = false,
) {
  vi.mocked(readPersistedTechnicalsBars).mockResolvedValue({
    barsBySymbol: bySymbol,
    label: "Persisted technicals bars",
    asOf: "2026-11-23T00:00:00.000Z",
    universeIndex: "NASDAQ-100",
    universeLabel: "Nasdaq-100",
    ageSeconds: 60,
    stale,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFeedDatasetAdapter).mockReturnValue({} as never);
  vi.mocked(buildFeedJobRegistry).mockReturnValue(new Map() as never);
});

describe("POST /opportunity-hunt/run (issue 6273)", () => {
  it("runs the hunt over the persisted bars and returns the full result", async () => {
    mockBars(
      new Map([
        // 2% dip on the latest bar: enters the three family strategies.
        ["AAAA", bars([...Array(14).fill(100), 98])],
        // Flat series: scanned, no setups.
        ["BBBB", bars(Array(15).fill(100))],
        // Too few bars: skipped.
        ["CCCC", bars([100, 101, 102])],
      ]),
    );
    const res = await handleOpportunityHuntRoutes(
      req("POST", "/opportunity-hunt/run"),
      urlOf("/opportunity-hunt/run"),
      "/opportunity-hunt/run",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.scanned).toBe(2);
    expect(body.skipped).toBe(1);
    // Issue 6406 — a setup carries its direction, latest close, the
    // evaluator's reason, and the entry recommendation's price range
    // (the family on a 98 close: entry 97.51–98.49, stop 95.06,
    // take-profit 100.94 — the externalized 0.5%/3%/3% levels).
    const familyLevels = {
      entryLow: 97.51,
      entryHigh: 98.49,
      stopLoss: 95.06,
      takeProfit: 100.94,
    };
    expect(body.setups).toEqual([
      {
        symbol: "AAAA",
        strategy: "breakout",
        direction: "entry",
        lastClose: 98,
        detail: "(dip >1.5% below prior bar)",
        levels: familyLevels,
      },
      {
        symbol: "AAAA",
        strategy: "mean_reversion",
        direction: "entry",
        lastClose: 98,
        detail: "(dip >1.5% below prior bar)",
        levels: familyLevels,
      },
      {
        symbol: "AAAA",
        strategy: "rsi_reversal",
        direction: "entry",
        lastClose: 98,
        detail: "(dip >1.5% below prior bar)",
        levels: familyLevels,
      },
    ]);
    expect(body.summary).toContain("3 setup(s) across 2 symbol(s)");
    expect(typeof body.asOf).toBe("string");
    // Issue 6406 — the trailing closes ride along for the panel's chart,
    // and the holdings read is reported, not silently absent: this test's
    // env has no broker plumbing, so holdings are unavailable and the
    // hunt runs flat (entries only), with the reason attached.
    expect(body.seriesBySymbol.AAAA).toEqual([
      ...Array(14).fill(100),
      98,
    ]);
    expect(body.holdingsStatus.available).toBe(false);
    expect(typeof body.holdingsStatus.reason).toBe("string");
  });

  it("fails named when the store is unbound", async () => {
    // The loader names the unbound store; executeOpportunityHunt wraps
    // any loader failure as bar_source_failed, exactly as the scheduled
    // handler records it — the inner reason stays in the message.
    vi.mocked(createFeedDatasetAdapter).mockReturnValue(null);
    const res = await handleOpportunityHuntRoutes(
      req("POST", "/opportunity-hunt/run"),
      urlOf("/opportunity-hunt/run"),
      "/opportunity-hunt/run",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("opportunity_hunt_bar_source_failed");
    expect(body.error).toContain("opportunity_hunt_store_unbound");
  });

  it("fails named when no bars are available", async () => {
    vi.mocked(readPersistedTechnicalsBars).mockResolvedValue(undefined as never);
    const res = await handleOpportunityHuntRoutes(
      req("POST", "/opportunity-hunt/run"),
      urlOf("/opportunity-hunt/run"),
      "/opportunity-hunt/run",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("opportunity_hunt_no_bars");
  });

  it("fails named when the persisted copy is stale", async () => {
    mockBars(new Map([["AAAA", bars(Array(15).fill(100))]]), true);
    const res = await handleOpportunityHuntRoutes(
      req("POST", "/opportunity-hunt/run"),
      urlOf("/opportunity-hunt/run"),
      "/opportunity-hunt/run",
      "s1",
      ctx,
    );
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("opportunity_hunt_no_bars");
  });

  it("returns null for non-owned paths and methods", async () => {
    expect(
      await handleOpportunityHuntRoutes(
        req("GET", "/nope"),
        urlOf("/nope"),
        "/nope",
        "s1",
        ctx,
      ),
    ).toBeNull();
    expect(
      await handleOpportunityHuntRoutes(
        req("GET", "/opportunity-hunt/run"),
        urlOf("/opportunity-hunt/run"),
        "/opportunity-hunt/run",
        "s1",
        ctx,
      ),
    ).toBeNull();
  });
});

describe("Opportunity Hunt nav (issue 6273)", () => {
  it("adds the sub-tab to the Stock Hub tab set", () => {
    expect(STOCK_HUB_TABS).toContain("opportunity-hunt");
  });

  it("adds the sub-menu entry with a resolvable icon and deep link", () => {
    const subs = SUB_MENU_CONFIGS["stock-hub"];
    const entry = subs.find((s) => s.id === "opportunity-hunt");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Opportunity Hunt");
    expect(entry!.description.length).toBeGreaterThan(0);
    expect(deepLinkForNavNode("stock-hub", "opportunity-hunt")).toEqual({
      tab: "stock-hub",
      view: "opportunity-hunt",
    });
    expect(deepLinkHrefForNavNode("stock-hub", "opportunity-hunt")).toBe(
      "?tab=stock-hub&view=opportunity-hunt",
    );
  });
});

describe("OpportunityHuntPanel (issue 6273)", () => {
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

  it("runs the hunt on demand and shows the setups", async () => {
    vi.mocked(listAllRuns).mockResolvedValue({ runs: [], partial: false });
    vi.mocked(runOpportunityHuntNow).mockResolvedValue({
      ok: true,
      scanned: 2,
      skipped: 1,
      setups: [
        {
          symbol: "AAAA",
          strategy: "rsi_reversal",
          direction: "entry",
          lastClose: 98,
          detail: "(dip >1.5% below prior bar)",
          levels: { entryLow: 97.51, entryHigh: 98.49, stopLoss: 95.06, takeProfit: 100.94 },
        },
      ],
      summary:
        "Opportunity hunt: 1 setup(s) across 2 symbol(s), 1 entry, 0 exits — AAAA:rsi_reversal",
      asOf: "2026-11-23T12:00:00.000Z",
      holdingsStatus: { available: false, reason: "holdings_not_loaded" },
      seriesBySymbol: { AAAA: [...Array(14).fill(100), 98] },
    } as never);
    await act(async () => {
      root!.render(<OpportunityHuntPanel />);
    });
    expect(container!.textContent).toContain("Run hunt now");
    expect(container!.textContent).toContain("No scheduled run yet");
    const button = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Run hunt now"),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });
    expect(vi.mocked(runOpportunityHuntNow)).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("AAAA");
    expect(container!.textContent).toContain("rsi_reversal");
    expect(container!.textContent).toContain("Scanned 2 symbol(s)");
  });

  it("shows the named failure when the run fails", async () => {
    vi.mocked(listAllRuns).mockResolvedValue({ runs: [], partial: false });
    vi.mocked(runOpportunityHuntNow).mockRejectedValue(
      new Error("opportunity_hunt_no_bars: no live persisted technicals bars"),
    );
    await act(async () => {
      root!.render(<OpportunityHuntPanel />);
    });
    const button = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Run hunt now"),
    );
    await act(async () => {
      button!.click();
    });
    expect(container!.textContent).toContain("opportunity_hunt_no_bars");
  });

  it("classifies a 408 poll outcome structurally and names the job (issue 6293)", async () => {
    vi.mocked(listAllRuns).mockResolvedValue({ runs: [], partial: false });
    const err = new Error(
      "The request is still processing. The job will continue in the background.",
    ) as Error & { status?: number; data?: unknown };
    err.status = 408;
    err.data = {
      error: "The request is still processing. The job will continue in the background.",
      jobId: "job-6293",
      statusUrl: "/api/jobs/job-6293",
    };
    vi.mocked(runOpportunityHuntNow).mockRejectedValue(err);
    await act(async () => {
      root!.render(<OpportunityHuntPanel />);
    });
    const button = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Run hunt now"),
    );
    await act(async () => {
      button!.click();
    });
    // The catalog message for the code, never the raw transport text.
    expect(container!.textContent).toContain("FAILURE_ASYNC_JOB_STILL_PROCESSING");
    expect(container!.textContent).not.toContain(
      "The request is still processing. The job will continue in the background.",
    );
    // The job id rides along so the run can be found in the ledger.
    expect(container!.textContent).toContain("job-6293");
  });

  it("shows a running status line while the run is pending (issue 6293)", async () => {
    vi.mocked(listAllRuns).mockResolvedValue({ runs: [], partial: false });
    let resolveRun!: (value: unknown) => void;
    vi.mocked(runOpportunityHuntNow).mockImplementation(
      () => new Promise((resolve) => { resolveRun = resolve; }) as never,
    );
    await act(async () => {
      root!.render(<OpportunityHuntPanel />);
    });
    const button = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Run hunt now"),
    );
    await act(async () => {
      button!.click();
    });
    expect(container!.textContent).toContain("Running");
    await act(async () => {
      resolveRun({
        ok: true,
        scanned: 1,
        skipped: 0,
        setups: [],
        summary: "Opportunity hunt: 0 setup(s) across 1 symbol(s)",
        asOf: "2026-11-23T12:00:00.000Z",
        holdingsStatus: { available: false, reason: "holdings_not_loaded" },
        seriesBySymbol: {},
      });
    });
    expect(container!.textContent).toContain("No setups");
  });
});
