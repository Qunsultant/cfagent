/** @vitest-environment jsdom */
/**
 * Consolidation C2 (issue #1246, epic #1151 R3/R4) — one nav entry,
 * one hub:
 *
 *  - NAVIGATION_ITEMS carries exactly ONE screening entry
 *    ("screeners", labeled "Screening"); the legacy screening tab
 *    ids still read as active on it and still deep-link into the hub.
 *  - The Trading Hub's screening subtabs render the hub itself on
 *    the equivalent tab — the S8 "Screening Moved" redirect notices
 *    are gone (these pins supersede the S8 redirect pins, which the
 *    C2 acceptance criteria explicitly retire).
 *  - ScreenersHub hosts Reports, Schedules, the proposal Review
 *    inbox, and the outcome Track record as tabs.
 *  - The Review inbox drives the EXISTING adaptation endpoints
 *    (evaluate / gate / approve / promote / rollback) and the goal
 *    store's proposed-only decisions; re-selection proposals are
 *    read-only.
 *  - The Track record renders the outcome ledger honestly:
 *    Unverified stays Unverified; unknown P&L is "Not recorded".
 *  - Discovery stays server-driven: StrategyDiscoveryPanel imports
 *    from strategyDiscoveryEngine are modeling-only (allowlist pin).
 *  - One exporter module: optionsDataExporter.tsx is gone; the
 *    options-data export functions live in runExport.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { NAVIGATION_ITEMS, isTabActive } from "../src/client/components/NavigationMenu";
import { ScreenersHub } from "../src/client/ScreenersHub";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { ScreeningReviewPanel } from "../src/client/ScreeningReviewPanel";
import { ScreeningOutcomesPanel } from "../src/client/ScreeningOutcomesPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = path.resolve(__dirname, "../src");
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const candidate = {
  id: "chl-1",
  kind: "active_set",
  title: "Reselection chop active set (2 strategies)",
  regime: "chop",
  spec: { activeStrategies: ["iron_condor", "bull_put_spread"] },
  criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
  evalSetVersion: "v2",
  sourceProposalId: "prop-1",
  status: "evaluated",
  evaluation: {
    datasetVersion: "v2",
    evaluatedAt: "2026-10-23T04:30:00.000Z",
    selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
    holdout: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
    verdict: "pass",
  },
  createdBy: "strategy-bank-reselection",
  createdAt: "2026-10-23T04:00:00.000Z",
};

const proposedGoal = {
  id: "goal-1",
  userLogin: "alice",
  kind: "income",
  title: "Covered-call income on SPY",
  status: "proposed",
  source: "discovered",
  payload: null,
  createdAt: "2026-10-23T04:00:00.000Z",
  updatedAt: "2026-10-23T04:00:00.000Z",
  scenarios: [
    {
      id: "scen-1",
      userLogin: "alice",
      goalId: "goal-1",
      portfolioRef: { kind: "hypothetical" },
      shocks: { spotPct: -5 },
      constraints: { maxLoss: 500 },
      status: "draft",
      createdAt: "2026-10-23T04:00:00.000Z",
      updatedAt: "2026-10-23T04:00:00.000Z",
    },
  ],
};

const reselection = {
  id: "sbp-1",
  regime: "bull",
  createdAt: "2026-10-23T04:00:00.000Z",
  proposal: {
    regime: "bull",
    generatedAt: "2026-10-23T04:00:00.000Z",
    governance: "proposal_only_not_promoted",
    overallWinRate: 0.55,
    activeSet: [{ strategy: "iron_condor", score: 0.8, winRate: 0.6, avgRMultiple: 1.2, evaluated: 12 }],
    log: [],
    evaluatedCount: 12,
    costUnitsUsed: 3,
    costCapUnits: 10,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

/** A fetch stub routing the inbox/outcome endpoints to fixtures and
 *  recording every call for contract assertions. */
function stubFetch(calls: Array<{ method: string; url: string; body: any }>) {
  let approvals: any[] = [];
  return vi.fn(async (input: unknown, init?: any) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.includes("/api/adaptation/candidates") && !url.includes("?") && method === "GET") {
      return jsonResponse({ candidates: [candidate] });
    }
    if (url.includes("/api/adaptation/candidates/evaluations")) {
      return jsonResponse({
        evaluations: [
          {
            datasetVersion: "v2",
            evaluatedAt: "2026-10-23T04:30:00.000Z",
            selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
            holdout: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
            verdict: "pass",
            criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
          },
        ],
      });
    }
    if (url.includes("/api/adaptation/candidates/approvals")) {
      if (method === "GET") return jsonResponse({ approvals });
      return jsonResponse({}); // not routed here
    }
    if (url.includes("/api/adaptation/candidates/verdicts")) {
      return jsonResponse({
        verdicts: [
          {
            id: "chl-1",
            challengerId: "chl-1",
            passed: true,
            reasons: ["Holdout edge 0.1000 >= minimum 0.0005.", "Holdout evaluated 2 >= minimum 1."],
            evaluatedAt: "2026-10-23T04:30:00.000Z",
          },
        ],
      });
    }
    if (url.includes("/api/adaptation/candidates/approve")) {
      const approval = {
        id: "appr-1",
        challengerId: "chl-1",
        approver: "alice",
        decision: body?.decision ?? "approved",
        createdAt: "2026-10-23T05:00:00.000Z",
      };
      approvals = [approval];
      return jsonResponse({ success: true });
    }
    if (url.includes("/api/adaptation/candidates/evaluate")) {
      return jsonResponse({
        success: true,
        evaluation: {
          datasetVersion: "v2",
          evaluatedAt: "2026-10-23T04:30:00.000Z",
          selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
          holdout: { championScore: 0.1, challengerScore: 0.2, evaluated: 2 },
          verdict: "pass",
          criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
        },
      });
    }
    if (url.includes("/api/adaptation/candidates/gate")) {
      return jsonResponse({
        success: true,
        verdict: { passed: true, reasons: ["Holdout edge 0.1000 >= minimum 0.0005.", "Holdout evaluated 2 >= minimum 1."] },
      });
    }
    if (url.includes("/api/adaptation/candidates/generate")) {
      return jsonResponse({ success: true, created: [candidate], skipped: [] });
    }
    if (url.includes("/api/adaptation/promotions/promote")) {
      return jsonResponse({ success: true });
    }
    if (url.includes("/api/adaptation/promotions/rollback")) {
      return jsonResponse({ success: true });
    }
    if (url.includes("/api/adaptation/promotions") && method === "GET") {
      return jsonResponse({ promotions: [] });
    }
    if (url.includes("/api/adaptation/weights")) {
      return jsonResponse({
        weights: { iron_condor: 1.2, cash_secured_put: 0.8 },
        evaluation: {
          generatedAt: "2026-10-23T04:00:00.000Z",
          unweightedWinRate: 0.5,
          weightedWinRate: 0.57,
          proposals: [],
          lowSample: ["cash_secured_put"],
        },
      });
    }
    if (url.includes("/api/screening/goals/decide")) {
      return jsonResponse({ success: true, goal: { ...proposedGoal, status: body?.decision === "activate" ? "active" : "archived", scenarios: undefined } });
    }
    if (url.includes("/api/screening/goals")) {
      return jsonResponse({ goals: [proposedGoal] });
    }
    if (url.includes("/api/screening/reselection-proposals")) {
      return jsonResponse({ proposals: [reselection] });
    }
    if (url.includes("/api/screening/outcomes")) {
      return jsonResponse({
        outcomes: [
          {
            recommendationRef: "rec-verified",
            status: "expired",
            quality: "verified",
            provenance: { screenRunRef: "run-1", goalId: "goal-1", scenarioId: null, weightsVersion: 3, evalSetVersion: "v2", expiryDate: "2026-11-01" },
            pnlAfterCost: 12.5,
            trackedAt: "2026-10-20T00:00:00.000Z",
            terminalAt: "2026-10-22T00:00:00.000Z",
          },
          {
            recommendationRef: "rec-unverified",
            status: "expired",
            quality: "unverified",
            provenance: { screenRunRef: null, goalId: null, scenarioId: null, weightsVersion: null, evalSetVersion: null, expiryDate: null },
            pnlAfterCost: null,
            trackedAt: "2026-10-20T00:00:00.000Z",
            terminalAt: "2026-10-22T00:00:00.000Z",
          },
        ],
      });
    }
    return jsonResponse({}, 500);
  });
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(btn, `button containing "${text}"`).toBeTruthy();
  return btn as HTMLButtonElement;
}

async function click(container: HTMLElement, text: string) {
  const btn = buttonByText(container, text);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/* ------------------------------------------------------------------ */
/* Nav collapse                                                        */
/* ------------------------------------------------------------------ */

describe("C2 nav collapse", () => {
  it("NAVIGATION_ITEMS carries exactly one screening entry — the Screening hub", () => {
    const screeningIds = ["screeners", "scanner", "options", "reports", "schedules"];
    const present = NAVIGATION_ITEMS.filter((i) => screeningIds.includes(i.id)).map((i) => i.id);
    expect(present).toEqual(["screeners"]);
    const entry = NAVIGATION_ITEMS.find((i) => i.id === "screeners")!;
    expect(entry.label).toBe("Stock Screener");
  });

  it("screening tab ids still read as active on their host entry (deep links)", () => {
    expect(isTabActive("screeners", "screeners")).toBe(true);
    expect(isTabActive("options-screener", "options")).toBe(true);
    expect(isTabActive("options-screener", "scanner")).toBe(true);
    expect(isTabActive("workflow-runs", "reports")).toBe(true);
    expect(isTabActive("platform-admin", "schedules")).toBe(true);
    expect(isTabActive("screeners", "portfolio")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Source pins                                                         */
/* ------------------------------------------------------------------ */

describe("C2 source pins", () => {
  it("the Trading Hub renders the hub directly for its screening subtabs — no moved notices", () => {
    const tradingHub = readSrc("client/ETradeTradingHub.tsx");
    expect(tradingHub).not.toContain("ScreeningMovedNotice");
    expect(tradingHub).not.toContain("Screening Moved to the Screeners Hub");
    for (const tab of ["options", "scanner", "iv-history", "reports", "schedules"]) {
      expect(tradingHub).toContain(`renderScreenersHub("${tab}")`);
    }
    // Reports/Schedules are hosted by the hub now, not mounted here.
    expect(tradingHub).not.toContain("<ReportsPanel");
    expect(tradingHub).not.toContain("<SchedulesPanel");
  });

  it("the hub hosts reports, schedules, the review inbox, and the track record", () => {
    const hub = readSrc("client/ScreenersHub.tsx");
    expect(hub).toContain("<ReportsPanel");
    expect(hub).toContain("<SchedulesPanel");
    expect(hub).toContain("<ScreeningReviewPanel");
    expect(hub).toContain("<ScreeningOutcomesPanel");
    for (const tab of ['"reports"', '"schedules"', '"review"', '"track-record"']) {
      expect(hub).toContain(tab);
    }
  });

  it("discovery stays server-driven: panel imports from the local engine are modeling-only", () => {
    const panel = readSrc("client/options/StrategyDiscoveryPanel.tsx");
    expect(panel).toContain("fetchServerDiscovery");
    const importBlock = panel.match(/import\s*\{([\s\S]*?)\}\s*from\s*"\.\/strategyDiscoveryEngine"/);
    expect(importBlock, "the panel imports the modeling engine").toBeTruthy();
    const names = importBlock![1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    const modelingOnly = new Set([
      // Builder modeling (payoff / greeks / strike & expiry editing)
      "generateExpirations",
      "generateStrikeLadder",
      "evaluateStrategyPnL",
      "getOptimizationFactors",
      "updateLegStrike",
      "updateLegsExpiration",
      "analyzeStrategy",
      "calculateNetGreeks",
      "calculateRealizedAndUnrealizedPnl",
      "evaluate2dPayoffMatrix",
      "shiftAllStrikes",
      "shiftSymmetricStrikes",
      // Types
      "DiscoveredStrategy",
      "ExpirationOption",
      "SentimentType",
      "StrategyLegItem",
      "StrategyDiscoveryConfig",
      "NetOptionGreeks",
      "RealizedUnrealizedPnl",
      "Matrix2dCell",
      "Matrix2dRow",
    ]);
    for (const name of names) {
      expect(modelingOnly.has(name), `"${name}" must be a modeling-only import`).toBe(true);
    }
  });

  it("one exporter module: optionsDataExporter.tsx is gone, its functions live in runExport.ts", () => {
    expect(fs.existsSync(path.join(SRC, "client/options/optionsDataExporter.tsx"))).toBe(false);
    const runExport = readSrc("client/runExport.ts");
    expect(runExport).toContain("export async function fetchOptionsDataForExport");
    expect(runExport).toContain("export function buildExportInput");
    expect(runExport).toContain("export async function downloadRawOptionsData");
    expect(runExport).toContain("export async function downloadNormalizedOptionsData");
    expect(runExport).toContain("export async function downloadBothOptionsData");
    const dropdown = readSrc("client/options/OptionsDataDownloadDropdown.tsx");
    expect(dropdown).toContain("OptionsDataDownloadDropdown");
    expect(dropdown).toContain('from "../runExport"');
    for (const importer of [
      "client/ETradeDynamicMenu.tsx",
      "client/options/OptionsResearchPanel.tsx",
      "client/options/RawContractsScreener.tsx",
      "client/options/StrategyDiscoveryPanel.tsx",
    ]) {
      expect(readSrc(importer)).not.toContain("optionsDataExporter");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Render pins                                                         */
/* ------------------------------------------------------------------ */

describe("C2 hub + panels (render)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ method: string; url: string; body: any }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", stubFetch(calls));
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

  it("the hub's tab bar carries Reports, Schedules, Review, and Track Record", async () => {
    await act(async () => {
      root.render(<ScreenersHub activeEnv="PROD" userLogin="alice" />);
    });
    await flush();
    for (const label of ["Reports", "Schedules", "Review", "Track Record"]) {
      expect(container.textContent).toContain(label);
    }
  });

  it("the Trading Hub renders the hub itself for the folded options subtab — no notice", async () => {
    await act(async () => {
      root.render(<ToastProvider><ETradeTradingHub activeSubTab="options" user={{ login: "alice" }} /></ToastProvider>);
    });
    await flush();
    expect(container.textContent).not.toContain("Screening Moved to the Screeners Hub");
    expect(container.textContent).toContain("Strategy Discovery & Payoff Analyzer");
  });

  it("the hub opens on the Review tab via initialTab", async () => {
    await act(async () => {
      root.render(<ScreenersHub activeEnv="PROD" userLogin="alice" initialTab="review" />);
    });
    await flush();
    expect(container.textContent).toContain("Proposal Review");
    expect(container.textContent).toContain("Covered-call income on SPY");
  });

  it("the review inbox shows challengers, goals, read-only re-selections, and weights", async () => {
    await act(async () => {
      root.render(<ScreeningReviewPanel userLogin="alice" />);
    });
    await flush();
    // Challenger with its title and spec summary.
    expect(container.textContent).toContain("Reselection chop active set (2 strategies)");
    expect(container.textContent).toContain("Target active set: iron_condor, bull_put_spread.");
    // Goal proposal with its scenario.
    expect(container.textContent).toContain("Covered-call income on SPY");
    expect(container.textContent).toContain("Activate goal");
    // Re-selection proposal: rendered, labeled proposal-only, no action buttons in its section.
    expect(container.textContent).toContain("proposal only");
    const reselectionSection = [...container.querySelectorAll("section, div")].find((el) =>
      el.textContent?.includes("Strategy-bank re-selection"),
    );
    expect(reselectionSection!.textContent).toContain("iron_condor");
    // Weights summary.
    expect(container.textContent).toContain("iron_condor");
  });

  it("the challenger flow drives the existing endpoints: approve → promote", async () => {
    await act(async () => {
      root.render(<ScreeningReviewPanel userLogin="alice" />);
    });
    await flush();
    await click(container, "Review challenger");
    // The gate verdict (frozen evidence) is visible beside the decision controls.
    expect(container.textContent).toContain("Holdout edge 0.1000 >= minimum 0.0005.");
    await click(container, "Approve");
    const approveCall = calls.find((c) => c.url.includes("/api/adaptation/candidates/approve"));
    expect(approveCall?.method).toBe("POST");
    expect(approveCall?.body).toEqual({ candidateId: "chl-1", decision: "approved" });
    await click(container, "Promote challenger");
    const promoteCall = calls.find((c) => c.url.includes("/api/adaptation/promotions/promote"));
    expect(promoteCall?.method).toBe("POST");
    expect(promoteCall?.body).toEqual({ candidateId: "chl-1" });
  });

  it("a goal decision posts to the goal decide route", async () => {
    await act(async () => {
      root.render(<ScreeningReviewPanel userLogin="alice" />);
    });
    await flush();
    await click(container, "Activate goal");
    const decide = calls.find((c) => c.url.includes("/api/screening/goals/decide"));
    expect(decide?.method).toBe("POST");
    expect(decide?.body).toEqual({ id: "goal-1", decision: "activate" });
  });

  it("the track record renders verified and Unverified outcomes honestly", async () => {
    await act(async () => {
      root.render(<ScreeningOutcomesPanel userLogin="alice" />);
    });
    await flush();
    expect(container.textContent).toContain("Recommendation Track Record");
    expect(container.textContent).toContain("rec-verified");
    expect(container.textContent).toContain("12.50");
    expect(container.textContent).toContain("rec-unverified");
    expect(container.textContent).toContain("Unverified");
    expect(container.textContent).toContain("Not recorded");
  });
});
