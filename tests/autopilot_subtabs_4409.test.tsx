/** @vitest-environment jsdom */
/**
 * Issue #4409 — the Autopilot page's sections become sub-tabs.
 *
 * The page's seven content blocks (#3140) were all rendered at once, so
 * the page was one long scroll with a wrapping action column, an
 * untitled Status section, an Edit-limits button stranded below its
 * title, and source lines wrapping across lines. This slice gives each
 * section its own sub-tab, driven by the shared `view` param (the #4168
 * pattern, extended from one addressable target to six), with the KPI
 * ribbon staying the persistent `kpiRibbon` slot — page chrome, not
 * content.
 *
 * Composition test, not a source-text pin: it mounts the panel (and,
 * for the h1 pin, the composed hub) and asserts what the user sees —
 * exactly one section per sub-tab, one h1, the URL round-tripping per
 * sub-tab, single-line cells and source lines, Edit limits adjacent to
 * its title, sortable columns, and both-axis scrolling on every table.
 *
 * The red drivers: the tab row, the per-view panels, the SortHeader
 * buttons, the scroll-frame containers, and the single-line classes
 * do not exist before this slice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AutopilotControlCenter } from "../src/client/components/AutopilotControlCenter";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  DEEP_LINK_OVERRIDES,
  deepLinkHref,
  SURFACE_TAB_CATALOG,
} from "../src/client/deepLinks";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

const DEFAULT_LIMITS = {
  maxPositionPct: 10.0,
  cashReservePct: 5.0,
  ordersPerDay: 10,
  drawdownAlertPct: 20.0,
  universe: "Default large caps/ETFs",
  riskProfile: "moderate",
};

/** Two jobs out of chronological order, so a time sort is observable. */
const JOBS = [
  {
    id: "job-1",
    kind: "stock",
    trigger: "scheduled",
    status: "completed",
    scanned: 10,
    matched: 2,
    codedError: null,
    reportUrl: null,
    pdfKey: null,
    xlsxKey: null,
    csvKey: null,
    deliveryStates: {},
    origin: "daily-watch",
    createdAt: "2026-11-14T10:00:00.000Z",
  },
  {
    id: "job-2",
    kind: "options",
    trigger: "manual",
    status: "failed",
    scanned: null,
    matched: null,
    codedError: "FAILURE_AUTH_NO_SESSION",
    reportUrl: null,
    pdfKey: null,
    xlsxKey: null,
    csvKey: null,
    deliveryStates: {},
    origin: "intraday",
    createdAt: "2026-11-13T09:00:00.000Z",
  },
];

/** Two verdicts with distinct notionals, so a notional sort is observable. */
const VERDICTS = [
  {
    id: "v-1",
    symbol: "SPY",
    action: "BUY",
    quantity: 10,
    notional: 500,
    mode: "paper",
    dry_run: 1,
    passed: 1,
    execution_allowed: 1,
    requires_approval: 0,
    binding_rule: "max-position",
    detail: "Within limits",
    signature: "sig_abc",
    created_at: "2026-11-14T10:00:00.000Z",
  },
  {
    id: "v-2",
    symbol: "QQQ",
    action: "SELL",
    quantity: 5,
    notional: 100,
    mode: "paper",
    dry_run: 1,
    passed: 0,
    execution_allowed: 0,
    requires_approval: 1,
    binding_rule: "cash-reserve",
    detail: "Needs approval",
    signature: null,
    created_at: "2026-11-13T09:00:00.000Z",
  },
];

/** Two seeded actions, Zulu before Alpha, so a summary sort is observable. */
const ACTIONS = [
  {
    id: "act-z",
    timestamp: "11/14/2026, 10:00:00 AM",
    actionType: "order",
    symbol: "SPY",
    summary: "Zulu order summary",
    policyCheckRule: "Max position rule text that must not wrap",
    policyCheckPassed: true,
    status: "executed",
    didAttestation: { did: "did:user:github:alice", signature: "sig_zulu_1234567890" },
    source: "live",
  },
  {
    id: "act-a",
    timestamp: "11/13/2026, 9:00:00 AM",
    actionType: "policy_check",
    symbol: "QQQ",
    summary: "Alpha policy summary",
    policyCheckRule: "Cash reserve rule text that must not wrap",
    policyCheckPassed: true,
    status: "verified",
    didAttestation: { did: "did:user:github:alice", signature: "" },
    source: "simulated",
  },
];

function stubFetch() {
  return vi.fn(async (input: unknown, init?: any) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.startsWith("/api/autopilot/jobs")) return jsonResponse({ jobs: JOBS });
    if (url === "/api/autopilot") {
      return jsonResponse({
        running: false,
        killSwitch: false,
        limits: DEFAULT_LIMITS,
        recentVerdicts: VERDICTS,
      });
    }
    if (url.startsWith("/api/autopilot/")) return jsonResponse({});
    if (url.startsWith("/api/broker/orders")) return jsonResponse({ trades: [], orders: [] });
    if (url.startsWith("/api/audit")) return jsonResponse({ items: [], entries: [] });
    if (method === "POST" || method === "PUT") return jsonResponse({ success: true });
    return jsonResponse({});
  });
}

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

async function teardown() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
  }
  if (container) {
    container.remove();
    container = undefined;
  }
}

async function mountAutopilot(search: string, seedActions = false) {
  await teardown();
  window.history.pushState(null, "", `/${search}`);
  if (seedActions) {
    localStorage.setItem("nextgen_autopilot_actions", JSON.stringify(ACTIONS));
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <AutopilotControlCenter user={{ login: "alice" }} />
      </ToastProvider>,
    );
  });
  await flush();
}

async function mountHub(search: string) {
  await teardown();
  window.history.pushState(null, "", `/${search}`);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <ETradeTradingHub activeSubTab={"autopilot" as any} user={{ login: "alice" }} />
      </ToastProvider>,
    );
  });
  await flush();
}

function h1s(): string[] {
  return [...container!.querySelectorAll("h1")].map((h) => h.textContent?.trim() ?? "");
}

/** The tab buttons in the Autopilot sections tablist. */
function tabButtons(): HTMLButtonElement[] {
  return [...container!.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
}

function tabByLabel(label: string): HTMLButtonElement | undefined {
  return tabButtons().find((b) => b.textContent?.trim() === label);
}

/** The visible tab panel (inactive panels render nothing). */
function activePanel(): HTMLElement | null {
  return container!.querySelector('[role="tabpanel"]:not([hidden])');
}

/** First data row's text for the table in the active panel. */
function firstRowText(): string {
  const table = activePanel()?.querySelector("table");
  const row = table?.querySelector("tbody tr");
  return row?.textContent?.trim() ?? "";
}

/** Sort buttons (aria-label "Sort by …") in the active panel's table. */
function sortButtons(): HTMLButtonElement[] {
  return [...(activePanel()?.querySelectorAll('button[aria-label^="Sort by"]') ?? [])] as HTMLButtonElement[];
}

beforeEach(() => {
  vi.stubGlobal("fetch", stubFetch());
  localStorage.clear();
  localStorage.setItem("nextgen_autopilot_running", "false");
});

afterEach(async () => {
  await teardown();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const SUB_TABS: Array<{ view: string; label: string; title: string }> = [
  { view: "performance", label: "Performance", title: "Strategy Equity vs S&P 500 Benchmark" },
  { view: "status", label: "Autopilot Status", title: "Autopilot Status" },
  { view: "limits", label: "Live policy limits", title: "Live policy limits" },
  { view: "job-outcomes", label: "Job outcomes", title: "Job outcomes" },
  { view: "actions", label: "Recent autonomous actions", title: "Recent autonomous actions" },
  { view: "policy-decisions", label: "Policy decisions", title: "Policy decisions" },
];

describe("autopilot sections as sub-tabs (#4409)", () => {
  it("the tab row lists all six sections; the default view shows the Performance panel only", async () => {
    await mountAutopilot("?tab=autopilot");
    expect(tabButtons().map((b) => b.textContent?.trim())).toEqual(
      SUB_TABS.map((t) => t.label),
    );
    expect(tabByLabel("Performance")?.getAttribute("aria-selected")).toBe("true");
    // The Performance panel is the only section in the DOM. The tab
    // row carries every section's label, so "only this section" is
    // scoped to the visible panel, not the page text.
    expect(activePanel()?.textContent).toContain("Strategy Equity vs S&P 500 Benchmark");
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });

  it.each(SUB_TABS)(
    "mounting with ?view=$view selects its sub-tab and renders only that section",
    async ({ view, label, title }) => {
      await mountAutopilot(`?tab=autopilot&view=${view}`);
      expect(tabByLabel(label)?.getAttribute("aria-selected")).toBe("true");
      // The tab row carries every section's label, so "only this
      // section" is scoped to the visible panel, not the page text.
      expect(activePanel()?.textContent).toContain(title);
      expect(container.querySelectorAll("section")).toHaveLength(1);
    },
  );

  it("an unknown view falls back to the Performance panel", async () => {
    await mountAutopilot("?tab=autopilot&view=not-a-section");
    expect(tabByLabel("Performance")?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Strategy Equity vs S&P 500 Benchmark");
  });

  it("clicking a tab updates the URL and switches the panel", async () => {
    await mountAutopilot("?tab=autopilot&view=performance");
    expect(tabByLabel("Performance")?.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      tabByLabel("Job outcomes")!.click();
    });
    await flush();
    expect(window.location.search).toBe("?tab=autopilot&view=job-outcomes");
    expect(tabByLabel("Job outcomes")?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Job outcomes");
    expect(container.textContent).not.toContain("Strategy Equity vs S&P 500 Benchmark");
  });

  it("navigating (back/forward) while mounted switches the tab", async () => {
    await mountAutopilot("?tab=autopilot&view=performance");
    await act(async () => {
      window.history.pushState(null, "", "/?tab=autopilot&view=policy-decisions");
      window.dispatchEvent(new Event("routechange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect(tabByLabel("Policy decisions")?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Policy decisions");
    expect(container.textContent).not.toContain("Strategy Equity vs S&P 500 Benchmark");
  });

  it("the composed hub page carries exactly one h1 with a deep-linked sub-tab", async () => {
    await mountHub("?tab=autopilot&view=actions");
    expect(h1s()).toEqual(["Autopilot"]);
    expect(tabByLabel("Recent autonomous actions")?.getAttribute("aria-selected")).toBe("true");
    expect(activePanel()?.textContent).toContain("Recent autonomous actions");
    expect(activePanel()?.textContent).not.toContain("Job outcomes");
  });

  it("the Status section is named Autopilot Status", async () => {
    await mountAutopilot("?tab=autopilot&view=status");
    const panel = activePanel();
    expect(panel?.querySelector("h2")?.textContent?.trim()).toBe("Autopilot Status");
    expect(container.textContent).toContain("Paused");
  });

  it("Edit limits sits in the same card header as the Live policy limits title", async () => {
    await mountAutopilot("?tab=autopilot&view=limits");
    const panel = activePanel();
    // The title moved into the DetailCard so it shares a row with the
    // button — the PageSection above it is untitled, so no h2 carries
    // the name on this panel.
    expect(panel?.querySelector("h2")).toBeNull();
    const header = panel?.querySelector(".ui-card-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector("h4")?.textContent?.trim()).toBe("Live policy limits");
    const editButton = [...(header?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes("Edit limits"),
    );
    expect(editButton).toBeDefined();
  });

  it("every source line is a single line (nowrap + ellipsis, full text on hover)", async () => {
    const expected: Array<[string, string]> = [
      ["job-outcomes", "Source: GET /api/autopilot/jobs — mas_job_outcomes (one outcome sink); rows labeled by origin."],
      ["actions", "Source: GET /api/audit (mas_events) + /api/broker/orders (mas_trades). Simulated rows are labeled Sim, never live."],
      ["policy-decisions", "Source: GET /api/autopilot — mas_policy_verdicts, signed by RiskPolicyEngine. Dry-run verdicts are labeled simulated. Scheduled dry-run checks come from the monthly Autopilot evaluation schedule (Schedules home)."],
    ];
    for (const [view, text] of expected) {
      await mountAutopilot(`?tab=autopilot&view=${view}`);
      // Exact match: the ribbon source also contains "Source:" and
      // sits earlier in the DOM, so a substring find would pick it.
      const source = [...container!.querySelectorAll(".ui-single-line")].find((el) =>
        el.textContent?.trim() === text,
      );
      expect(source).toBeDefined();
      expect(source?.getAttribute("title")).toBe(text);
    }
    // The Status source and the ribbon source are single-line too.
    await mountAutopilot("?tab=autopilot&view=status");
    const statusSource = [...container!.querySelectorAll(".ui-single-line")].find((el) =>
      el.textContent?.trim() ===
      "Source: GET /api/autopilot — OrchestratorAgent state (run state, kill switch, limits, verdicts).",
    );
    expect(statusSource).toBeDefined();
    const ribbonSource = [...container!.querySelectorAll(".ui-single-line")].find((el) =>
      el.textContent?.trim() ===
      "Source: GET /api/autopilot — verdict count from mas_policy_verdicts. NAV and drawdown have no live source — shown as —.",
    );
    expect(ribbonSource).toBeDefined();
  });

  it("every table cell renders on one line: summary spans truncate, plain cells do not wrap", async () => {
    await mountAutopilot("?tab=autopilot&view=actions", true);
    const panel = activePanel();
    // The long action summary is a truncating span, not a wrapping one.
    const summary = [...(panel?.querySelectorAll(".ui-single-line") ?? [])].find((el) =>
      el.textContent?.includes("Zulu order summary"),
    );
    expect(summary).toBeDefined();
    expect(summary?.getAttribute("title")).toBe("Zulu order summary");
    // The long policy-rule badge sits in a nowrap cell.
    const policyCell = [...(panel?.querySelectorAll("td") ?? [])].find((td) =>
      td.textContent?.includes("Max position rule text"),
    );
    expect(policyCell?.className).toContain("ui-cell-nowrap");
    // The time cell is nowrap too (the existing .time-cell treatment).
    const timeCell = panel?.querySelector("td.time-cell");
    expect(timeCell).not.toBeNull();

    await mountAutopilot("?tab=autopilot&view=job-outcomes");
    const jobDetail = [...(activePanel()?.querySelectorAll(".ui-single-line") ?? [])].find((el) =>
      el.textContent?.includes("FAILURE_AUTH_NO_SESSION"),
    );
    expect(jobDetail).toBeDefined();

    await mountAutopilot("?tab=autopilot&view=policy-decisions");
    const verdictPanel = activePanel();
    const intent = [...(verdictPanel?.querySelectorAll(".ui-single-line") ?? [])].find((el) =>
      el.textContent?.includes("BUY 10 SPY"),
    );
    expect(intent).toBeDefined();
    const detail = [...(verdictPanel?.querySelectorAll(".ui-single-line") ?? [])].find((el) =>
      el.textContent?.includes("Within limits"),
    );
    expect(detail).toBeDefined();
    const notionalCell = [...(verdictPanel?.querySelectorAll("td") ?? [])].find((td) =>
      td.textContent?.trim() === "$500",
    );
    expect(notionalCell?.className).toContain("ui-cell-nowrap");
  });

  it("all columns are sortable: every table carries a Sort by button per column", async () => {
    await mountAutopilot("?tab=autopilot&view=job-outcomes");
    expect(sortButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Sort by DATE & TIME",
      "Sort by JOB",
      "Sort by OUTCOME",
      "Sort by DETAIL",
    ]);
    await mountAutopilot("?tab=autopilot&view=actions", true);
    expect(sortButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Sort by DATE & TIME",
      "Sort by ACTION & TRIGGER",
      "Sort by ASSET",
      "Sort by POLICY CHECK",
      "Sort by STATUS",
      "Sort by DID ATTESTATION",
    ]);
    await mountAutopilot("?tab=autopilot&view=policy-decisions");
    expect(sortButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Sort by DATE & TIME",
      "Sort by INTENT",
      "Sort by NOTIONAL",
      "Sort by OUTCOME",
      "Sort by BINDING RULE",
      "Sort by DETAIL",
    ]);
  });

  it("sorting reorders the job rows by time", async () => {
    await mountAutopilot("?tab=autopilot&view=job-outcomes");
    // Stub order: job-1 (11/14, daily-watch) first.
    expect(firstRowText()).toContain("daily-watch");
    await act(async () => {
      sortButtons().find((b) => b.getAttribute("aria-label") === "Sort by DATE & TIME")!.click();
    });
    await flush();
    // Ascending: job-2 (11/13, intraday) first.
    expect(firstRowText()).toContain("intraday");
    await act(async () => {
      sortButtons().find((b) => b.getAttribute("aria-label") === "Sort by DATE & TIME")!.click();
    });
    await flush();
    // Descending again: job-1 first.
    expect(firstRowText()).toContain("daily-watch");
  });

  it("sorting reorders the action rows by summary", async () => {
    await mountAutopilot("?tab=autopilot&view=actions", true);
    expect(firstRowText()).toContain("Zulu order summary");
    await act(async () => {
      sortButtons().find((b) => b.getAttribute("aria-label") === "Sort by ACTION & TRIGGER")!.click();
    });
    await flush();
    expect(firstRowText()).toContain("Alpha policy summary");
  });

  it("sorting reorders the verdict rows by notional", async () => {
    await mountAutopilot("?tab=autopilot&view=policy-decisions");
    expect(firstRowText()).toContain("$500");
    await act(async () => {
      sortButtons().find((b) => b.getAttribute("aria-label") === "Sort by NOTIONAL")!.click();
    });
    await flush();
    expect(firstRowText()).toContain("$100");
  });

  it("every table scrolls on both axes with a sticky header", async () => {
    for (const view of ["job-outcomes", "actions", "policy-decisions"] as const) {
      await mountAutopilot(`?tab=autopilot&view=${view}`, view === "actions");
      const panel = activePanel();
      const table = panel?.querySelector("table");
      expect(table).not.toBeNull();
      const frame = table?.closest("div");
      expect(frame?.className).toContain("ui-scroll-frame");
      expect(frame?.className).toContain("autopilot-table-container");
      expect([...(table?.querySelectorAll("th") ?? [])].every((th) => th.className.includes("sticky-head"))).toBe(true);
    }
  });

  it("deep links resolve for all six sub-tabs and the surface catalog carries them", () => {
    for (const { view } of SUB_TABS) {
      expect(DEEP_LINK_OVERRIDES[`autopilot:${view}`]).toEqual({
        tab: "autopilot",
        view,
      });
      expect(deepLinkHref(DEEP_LINK_OVERRIDES[`autopilot:${view}`] as any)).toBe(
        `?tab=autopilot&view=${view}`,
      );
      const entry = SURFACE_TAB_CATALOG.find(
        (e) => e.surface === "autopilot" && e.value === view,
      );
      expect(entry).toBeDefined();
      expect(entry?.page).toBe("autopilot");
      expect(entry?.param).toBe("view");
      expect(entry?.href).toBe(`?tab=autopilot&view=${view}`);
    }
  });
});
