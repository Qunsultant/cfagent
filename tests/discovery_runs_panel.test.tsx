/** @vitest-environment jsdom */
/**
 * Issue #126 (PR-F): the Discovery runs section in Options Research
 * reviews the PERSISTED runs of the scheduled-discovery backend
 * (PR-E) — separate from the interactive StrategyDiscoveryPanel,
 * whose results are never stored.
 *
 * Harness follows tests/screeners_hub_auto_runs.test.tsx (PR-A): the
 * REAL apiFetch driven against a stubbed global fetch (the routes
 * answer 200 directly), the component rendered with react-dom/client
 * in jsdom, downloads captured via URL.createObjectURL + anchor
 * click (the PR-B pattern).
 *
 * Pins:
 *  - the run list renders every persisted run with time, trigger
 *    provenance (schedule id when present), the saved-request input
 *    label, status badge, symbols, and completion counts;
 *  - the latest run is the default selection; its detail renders the
 *    per-symbol saved view, the ranked candidates with the panel's
 *    headline metrics, the highlighted best trade, screened/excluded
 *    counts, and the failed symbol named with its reason;
 *  - a failed run renders its status + per-symbol reasons (never an
 *    empty table), offers its JSON diagnostic download, and offers
 *    NO candidate CSV;
 *  - downloads target the VIEWED run (filename carries its
 *    timestamp; CSV content names its failures);
 *  - no runs → an honest empty state, no fabricated sample data.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DiscoveryRunsPanel, formatConstraintSetLine, formatDerivationLine } from "../src/client/options/DiscoveryRunsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -----------------------------------------------------------------
// Shaped like the store's DiscoveryRunSummary / StoredDiscoveryRun
// (discoveryRunStore.ts) as the PR-E read routes return them, so a
// server shape change breaks these tests on purpose.

const candidate = (over: Record<string, unknown> = {}) => ({
  id: "cand-1",
  rank: 1,
  type: "long_call",
  label: "NVDA Long Call",
  symbol: "NVDA",
  underlyingPrice: 180,
  expirationDate: "2027-12-18",
  dataFreshness: "FRESH",
  legs: [],
  netDebit: 4.25,
  estimatedFees: 1.3,
  maxProfit: null,
  maxProfitUnbounded: true,
  maxLoss: 425,
  breakevens: [184.25],
  targetPnl: 850,
  targetRewardRisk: 2,
  modelImpliedProbabilityOfProfit: 0.42,
  netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1 },
  liquidityScore: 80,
  score: 77,
  payoffCurve: [],
  scenarios: [],
  explanations: [],
  warnings: [],
  assumptions: [],
  ...over,
});

const rankedEntry = (cand: Record<string, unknown>, rank: number, compositeScore: number) => ({
  candidate: cand,
  rank,
  compositeScore,
  components: { engineScore: 1, probability: 1, rewardRisk: 1, capitalSafety: 1, liquidity: 1 },
});

const REQUEST_NVDA = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
};
const REQUEST_MSFT = { ...REQUEST_NVDA, symbol: "MSFT", thesis: "bearish", targetPrice: 380 };
const REQUEST_AAPL = { ...REQUEST_NVDA, symbol: "AAPL", targetPrice: 260 };
const REQUEST_TSLA = { ...REQUEST_NVDA, symbol: "TSLA", targetPrice: 300 };

const NVDA_RANKED = [
  rankedEntry(candidate(), 1, 87.5),
  rankedEntry(candidate({ id: "cand-2", label: "NVDA Bull Call Spread", netDebit: 2.1, maxLoss: 210 }), 2, 71.25),
];

const RUN_PARTIAL = {
  id: "run-partial",
  createdAt: "2026-10-20T13:55:00.000Z",
  trigger: "scheduled",
  scheduleId: "sched-abc",
  inputModel: "saved-request",
  status: "partial",
  requestCount: 2,
  completedCount: 1,
  failedCount: 1,
  symbols: ["NVDA", "MSFT"],
  requests: [REQUEST_NVDA, REQUEST_MSFT],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      request: REQUEST_NVDA,
      ranked: NVDA_RANKED,
      riskReports: [],
      screenedOut: [{ id: "iron_condor", reason: "wing width" }],
      excluded: [{ reason: "insufficient liquidity", count: 3 }],
      bestTrade: {
        status: "recommended",
        riskProfile: "balanced",
        confidence: "HIGH",
        best: NVDA_RANKED[0],
        alternatives: [NVDA_RANKED[1]],
        rationale: ["NVDA Long Call ranks #1 for a balanced profile."],
        blockers: [],
        humanApprovalRequired: true,
        disclaimer: "research only",
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 1200, contractsMatched: 45 } },
    },
    { symbol: "MSFT", status: "failed", request: REQUEST_MSFT, error: "E*TRADE chain unavailable: session expired" },
  ],
};

const RUN_COMPLETED = {
  id: "run-completed",
  createdAt: "2026-10-20T13:50:00.000Z",
  trigger: "scheduled",
  inputModel: "saved-request",
  status: "completed",
  requestCount: 1,
  completedCount: 1,
  failedCount: 0,
  symbols: ["AAPL"],
  requests: [REQUEST_AAPL],
  outcomes: [
    {
      symbol: "AAPL",
      status: "completed",
      request: REQUEST_AAPL,
      ranked: [rankedEntry(candidate({ id: "aapl-1", label: "AAPL Long Call", symbol: "AAPL" }), 1, 66)],
      riskReports: [],
      screenedOut: [],
      excluded: [],
      bestTrade: {
        status: "no_trade",
        riskProfile: "balanced",
        confidence: "LOW",
        alternatives: [],
        rationale: ["No AAPL strategy satisfied the bullish thesis, risk cap and reward/risk minimum."],
        blockers: ["No qualifying candidates"],
        humanApprovalRequired: true,
        disclaimer: "research only",
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 900, contractsMatched: 12 } },
    },
  ],
};

const RUN_FAILED = {
  id: "run-failed",
  createdAt: "2026-10-20T13:45:00.000Z",
  trigger: "manual-trigger",
  inputModel: "saved-request",
  status: "failed",
  requestCount: 1,
  completedCount: 0,
  failedCount: 1,
  symbols: ["TSLA"],
  requests: [REQUEST_TSLA],
  outcomes: [
    { symbol: "TSLA", status: "failed", request: REQUEST_TSLA, error: "consumer credentials are not configured" },
  ],
};

const ALL_RUNS = [RUN_PARTIAL, RUN_COMPLETED, RUN_FAILED];
const SUMMARIES = ALL_RUNS.map(({ requests: _r, outcomes: _o, ...summary }) => summary);

// A profile-derived run (issue #533): NVDA derived + completed, MSFT
// abstained (no usable IV — no request, no target), AAPL derived then
// failed downstream. Shapes mirror what PR-533A's service persists.
const PROFILE_REF_533 = { id: "prof-1", name: "Income", version: 3 };

const DERIVATION_NVDA_533 = {
  source: "profile-derived",
  spot: 130,
  spotSource: "chain",
  atmIv: 0.45,
  expectedMovePct: 0.1311,
  windowExpiry: "2026-11-20",
  windowDays: 31,
  emMultiple: 0.6,
  thesis: "bullish",
  targetPrice: 140.23,
  profileRef: PROFILE_REF_533,
};

const REQUEST_NVDA_DERIVED = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 140.23,
  targetDate: "2026-11-20",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
};

const REQUEST_AAPL_DERIVED = {
  ...REQUEST_NVDA_DERIVED,
  symbol: "AAPL",
  thesis: "bearish",
  targetPrice: 246.35,
};

const RUN_DERIVED = {
  id: "run-derived",
  createdAt: "2026-10-20T14:05:00.000Z",
  trigger: "scheduled",
  scheduleId: "sched-derived",
  inputModel: "profile-derived",
  profileRef: PROFILE_REF_533,
  status: "partial",
  requestCount: 2,
  completedCount: 1,
  failedCount: 1,
  abstainedCount: 1,
  symbols: ["NVDA", "MSFT", "AAPL"],
  requests: [REQUEST_NVDA_DERIVED, REQUEST_AAPL_DERIVED],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      request: REQUEST_NVDA_DERIVED,
      derivation: DERIVATION_NVDA_533,
      ranked: NVDA_RANKED,
      riskReports: [],
      screenedOut: [],
      excluded: [],
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 1200, contractsMatched: 45 } },
    },
    {
      symbol: "MSFT",
      status: "abstained",
      error: "no usable IV in the live chain for MSFT — no expected move can be derived",
    },
    {
      symbol: "AAPL",
      status: "failed",
      request: REQUEST_AAPL_DERIVED,
      derivation: {
        ...DERIVATION_NVDA_533,
        spot: 260,
        atmIv: 0.3,
        expectedMovePct: 0.0875,
        emMultiple: -0.6,
        thesis: "bearish",
        targetPrice: 246.35,
      },
      error: "chain fetch failed",
    },
  ],
};

const RUN_DERIVED_SUMMARY = (() => {
  const { requests: _r, outcomes: _o, ...summary } = RUN_DERIVED;
  return summary;
})();

const DETAILS: Record<string, unknown> = {
  "run-partial": RUN_PARTIAL,
  "run-completed": RUN_COMPLETED,
  "run-failed": RUN_FAILED,
  "run-derived": RUN_DERIVED,
};

// Harness ------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;
let listPayload: { count: number; runs: unknown[] } = { count: SUMMARIES.length, runs: SUMMARIES };

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const detailMatch = url.match(/\/discovery-runs\/([^/?]+)/);
    if (detailMatch) {
      const detail = DETAILS[decodeURIComponent(detailMatch[1])];
      return detail
        ? Response.json(detail)
        : Response.json({ error: "discovery run not found" }, { status: 404 });
    }
    if (url.includes("/discovery-runs")) {
      return Response.json(listPayload);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }) as typeof fetch;
}

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
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
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

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DiscoveryRunsPanel activeEnv="PROD" userLogin="tester" />);
  });
  await flush();
}

function runItems(): HTMLElement[] {
  // Runs are now primitive Buttons (S-U2 #3051): each carries an
  // aria-label "Review discovery run from <locale date>" — no
  // bespoke .discovery-run-item class remains.
  return Array.from(
    container.querySelectorAll<HTMLElement>('button[aria-label^="Review discovery run from"]'),
  );
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent || "").includes(text),
  );
}

beforeEach(() => {
  listPayload = { count: SUMMARIES.length, runs: SUMMARIES };
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
  vi.restoreAllMocks();
});

// Component ------------------------------------------------------------------

describe("DiscoveryRunsPanel run list (#126 PR-F)", () => {
  it("renders every persisted run with provenance, input model, status, symbols and counts", async () => {
    await renderPanel();
    const items = runItems();
    expect(items).toHaveLength(3);

    const partial = items[0].textContent || "";
    expect(partial).toContain(new Date(RUN_PARTIAL.createdAt).toLocaleString());
    expect(partial).toContain("Scheduled · schedule sched-abc");
    expect(partial).toContain("Saved requests");
    expect(partial).toContain("Partial");
    expect(partial).toContain("NVDA, MSFT");
    expect(partial).toContain("1 of 2 requests completed");
    expect(partial).toContain("1 failed");

    const completed = items[1].textContent || "";
    expect(completed).toContain("Completed");
    expect(completed).toContain("AAPL");
    expect(completed).toContain("1 of 1 requests completed");

    const failed = items[2].textContent || "";
    expect(failed).toContain("Manual trigger");
    expect(failed).toContain("Failed");
    expect(failed).toContain("TSLA");
    expect(failed).toContain("0 of 1 requests completed");
  });

  it("defaults to the latest run and renders its per-symbol outcomes read-only", async () => {
    await renderPanel();
    const items = runItems();
    expect(items[0].getAttribute("aria-pressed")).toBe("true");
    expect(items[0].textContent).toContain("Viewing");

    const text = container.textContent || "";
    // The saved view the NVDA request ran with.
    expect(text).toContain("Saved view: bullish");
    expect(text).toContain("target $200.00 by 2027-12-18");
    expect(text).toContain("max planned loss $500.00");
    // Provenance of the underlying chain snapshot.
    expect(text).toContain("Live broker chain");
    expect(text).toContain("1,200 contracts evaluated");
    // Ranked candidates with the panel's headline metrics.
    expect(text).toContain("NVDA Long Call");
    expect(text).toContain("Composite 87.5");
    expect(text).toContain("POP 42%");
    expect(text).toContain("Max loss $425.00");
    expect(text).toContain("NVDA Bull Call Spread");
    expect(text).toContain("Composite 71.3"); // 71.25 renders at 1dp like the panel
    // Best trade highlighted.
    expect(text).toContain("★ Best trade");
    expect(text).toContain("confidence HIGH");
    // Screened-out / excluded counts.
    expect(text).toContain("Screened out: 1");
    expect(text).toContain("Excluded: 3");
    expect(text).toContain("insufficient liquidity ×3");
    // The failed symbol is named with its reason, in the detail header too.
    expect(text).toContain("Failed: MSFT");
    expect(text).toContain("E*TRADE chain unavailable: session expired");
    // Total ranked count across the run.
    expect(text).toContain("2 ranked candidates");
  });

  it("selecting the failed run renders its reasons — and JSON only, no candidate CSV", async () => {
    await renderPanel();
    const items = runItems();
    await act(async () => {
      items[2].click();
    });
    await flush();

    const text = container.textContent || "";
    expect(text).toContain("This run failed");
    expect(text).toContain("consumer credentials are not configured");
    expect(buttonByText("Candidates CSV")).toBeUndefined();
    expect(buttonByText("Run JSON")).toBeDefined();
    expect(items[2].getAttribute("aria-pressed")).toBe("true");
  });

  it("selecting the completed run renders its no-trade best pick honestly", async () => {
    await renderPanel();
    const items = runItems();
    await act(async () => {
      items[1].click();
    });
    await flush();

    const text = container.textContent || "";
    expect(text).toContain("AAPL Long Call");
    expect(text).toContain("No trade — No AAPL strategy satisfied the bullish thesis");
    expect(buttonByText("Candidates CSV")).toBeDefined();
    expect(buttonByText("Run JSON")).toBeDefined();
  });
});

describe("DiscoveryRunsPanel downloads (#126 PR-F)", () => {
  it("CSV targets the viewed run: filename carries its timestamp, content names its failures", async () => {
    await renderPanel();
    await act(async () => {
      buttonByText("Candidates CSV")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("discovery-20261020-135500.csv");
    const csv = await blobText(downloads[0].blob);
    expect(csv).toContain("# FAILED: MSFT — E*TRADE chain unavailable: session expired");
    expect(csv).toContain("NVDA Long Call");
  });

  it("JSON download is the viewed run's full record (round-trips, no scoping stamp)", async () => {
    await renderPanel();
    const items = runItems();
    await act(async () => {
      items[2].click();
    });
    await flush();
    await act(async () => {
      buttonByText("Run JSON")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("discovery-20261020-134500.json");
    const parsed = JSON.parse(await blobText(downloads[0].blob));
    expect(parsed.id).toBe("run-failed");
    expect(parsed.outcomes[0].error).toBe("consumer credentials are not configured");
    expect("userLogin" in parsed).toBe(false);
  });
});

describe("DiscoveryRunsPanel empty state (#126 PR-F)", () => {
  it("no runs → an honest empty state, no fabricated rows", async () => {
    listPayload = { count: 0, runs: [] };
    await renderPanel();
    expect(runItems()).toHaveLength(0);
    expect(container.textContent).toContain("No discovery runs yet");
    expect(container.textContent).not.toContain("NVDA");
  });
});

// Profile-derived runs (issue #533, PR-533B) -------------------------------

describe("DiscoveryRunsPanel — profile-derived runs (#533)", () => {
  beforeEach(() => {
    listPayload = { count: 1, runs: [RUN_DERIVED_SUMMARY] };
  });

  function outcomeBlock(symbol: string): HTMLElement {
    // Outcomes are now primitive Cards (S-U2 #3051): the outcome's
    // symbol is the header <strong> (exact text — ranked rows carry
    // "SYMBOL <label>", never the bare symbol), so the Card around
    // it is the outcome block. No .discovery-outcome class remains.
    const strong = Array.from(container.querySelectorAll("strong")).find(
      (el) => el.textContent === symbol,
    );
    const block = strong?.closest(".ui-card") as HTMLElement | null;
    if (!block) throw new Error(`outcome block for ${symbol} not found`);
    return block;
  }

  it("labels the run Profile-derived (never Saved requests) with per-symbol counts", async () => {
    await renderPanel();
    const items = runItems();
    expect(items).toHaveLength(1);
    const text = items[0].textContent || "";
    expect(text).toContain("Profile-derived");
    expect(text).not.toContain("Saved requests");
    expect(text).toContain("NVDA, MSFT, AAPL");
    expect(text).toContain("1 of 3 symbols completed");
    expect(text).toContain("1 failed");
    expect(text).toContain("1 abstained");
  });

  it("renders the profile stamp and the full DERIVED block beside the constructed view", async () => {
    await renderPanel();
    const text = container.textContent || "";
    // The run's profileRef (name + version) is shown in the detail head.
    expect(text).toContain("Profile-derived · profile Income v3");
    expect(text).toContain("targets derived at run time");
    // The constructed request is labelled a derived view, not a saved one.
    expect(text).toContain("Derived view: bullish");
    expect(text).not.toContain("Saved view:");
    expect(text).toContain("target $140.23 by 2026-11-20");
    // The DERIVED block, in the spec's format, with spot/EM/IV/window/profile.
    expect(text).toContain(
      "DERIVED target $140.23 = spot $130.00 × (1 + 0.6 × EM 13.11%) · IV 45% · window: expiry 2026-11-20 (31 days) · profile Income v3",
    );
    // The derived run still renders its ranked candidates.
    expect(text).toContain("NVDA Long Call");
    // The failed symbol that derived first shows its derivation AND its failure.
    const aapl = outcomeBlock("AAPL");
    expect(aapl.textContent).toContain(
      "DERIVED target $246.35 = spot $260.00 × (1 + -0.6 × EM 8.75%) · IV 30%",
    );
    expect(aapl.textContent).toContain("chain fetch failed");
  });

  it("renders an abstained outcome as an abstention with its reason — not as a failure", async () => {
    await renderPanel();
    const msft = outcomeBlock("MSFT");
    expect(msft.textContent).toContain(
      "Abstained — no usable IV in the live chain for MSFT — no expected move can be derived",
    );
    // The abstention uses its own alert box, not the failure box, and
    // the outcome carries no failure badge and no view line.
    expect(msft.querySelector(".ui-notice.tone-warning")).not.toBeNull();
    expect(msft.querySelector(".ui-notice.tone-danger")).toBeNull();
    expect(msft.textContent).not.toContain("Failed");
    expect(msft.textContent).not.toContain("Derived view");
    // The detail head names the abstention alongside the failure.
    const text = container.textContent || "";
    expect(text).toContain("Abstained: MSFT");
    expect(text).toContain("Failed: AAPL");
  });

  it("downloads for a derived run carry the DERIVED / ABSTAINED labelling", async () => {
    await renderPanel();
    await act(async () => {
      buttonByText("Candidates CSV")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("discovery-20261020-140500.csv");
    const csv = await blobText(downloads[0].blob);
    expect(csv).toContain("input model: profile-derived");
    expect(csv).toContain(
      "# DERIVED: NVDA target $140.23 = spot $130.00 × (1 + 0.6 × EM 13.11%) · window 2026-11-20 (31d) · profile Income v3",
    );
    expect(csv).toContain(
      "# ABSTAINED: MSFT — no usable IV in the live chain for MSFT — no expected move can be derived",
    );

    downloads.length = 0;
    await act(async () => {
      buttonByText("Run JSON")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    const parsed = JSON.parse(await blobText(downloads[0].blob));
    expect(parsed.outcomes[0].derivation.targetPrice).toBe(140.23);
    expect(parsed.outcomes[1].status).toBe("abstained");
    expect("request" in parsed.outcomes[1]).toBe(false);
  });
});

describe("formatDerivationLine (#533)", () => {
  it("renders the settled format, including a range-bound k of 0", () => {
    expect(formatDerivationLine(DERIVATION_NVDA_533 as any)).toBe(
      "DERIVED target $140.23 = spot $130.00 × (1 + 0.6 × EM 13.11%) · IV 45% · window: expiry 2026-11-20 (31 days) · profile Income v3",
    );
    expect(
      formatDerivationLine({
        ...DERIVATION_NVDA_533,
        emMultiple: 0,
        thesis: "range_bound",
        targetPrice: 130,
      } as any),
    ).toContain("DERIVED target $130.00 = spot $130.00 × (1 + 0 × EM 13.11%)");
  });
});

// No-view runs (issue #534, PR-534-C) --------------------------------------
// Shapes mirror what PR-534-B's service persists: every outcome
// carries its constraint set; NVDA ranked structures under it; MSFT
// COMPLETED with the abstained flag (chain loaded, nothing
// qualified); AAPL failed. The best pick is capped at research_only
// and carries the pinned no-view rationale verbatim.

const NO_VIEW_RATIONALE_534 =
  "No user view was supplied; this is the best-supported structure under the stated constraints, not a recommendation.";

const noViewCandidate = (over: Record<string, unknown> = {}) => ({
  id: "nv-1",
  rank: 1,
  type: "long_call",
  label: "NVDA Long Call",
  symbol: "NVDA",
  underlyingPrice: 180,
  expirationDate: "2026-11-20",
  dataFreshness: "FRESH",
  legs: [],
  netDebit: 4.25,
  estimatedFees: 1.3,
  maxProfit: null,
  maxProfitUnbounded: true,
  maxLoss: 425,
  breakevens: [184.25],
  modelImpliedProbabilityOfProfit: 0.42,
  netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1 },
  liquidityScore: 80,
  score: 74,
  structureRewardRisk: null,
  scoreModel: "no-view-v1",
  payoffCurve: [],
  scenarios: [],
  explanations: [],
  warnings: [],
  assumptions: [],
  ...over,
});

const noViewRankedEntry = (cand: Record<string, unknown>, rank: number, compositeScore: number) => ({
  candidate: cand,
  rank,
  compositeScore,
  components: { engineScore: 1, probability: 1, rewardRisk: 1, capitalSafety: 1, liquidity: 1 },
});

const CONSTRAINT_NVDA_534 = {
  symbol: "NVDA",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  minProbabilityOfProfit: 0.35,
  minDte: 7,
  maxDte: 45,
  riskProfile: "balanced",
};
const CONSTRAINT_MSFT_534 = { ...CONSTRAINT_NVDA_534, symbol: "MSFT" };
const CONSTRAINT_AAPL_534 = { symbol: "AAPL", maxPlannedLoss: 250, minRewardRisk: 2, riskProfile: "conservative" };

const csNv = (request: Record<string, unknown>) => ({
  source: "no-view",
  request,
  expectedIvDirection: "unchanged",
});

const NVDA_NOVIEW_RANKED = [
  noViewRankedEntry(noViewCandidate(), 1, 82.5),
  noViewRankedEntry(
    noViewCandidate({
      id: "nv-2",
      type: "bull_put_spread",
      label: "NVDA Bull Put Spread",
      netDebit: -1.8,
      maxProfit: 180,
      maxProfitUnbounded: false,
      maxLoss: 320,
      structureRewardRisk: 0.56,
    }),
    2,
    64,
  ),
];

const RUN_NOVIEW = {
  id: "run-noview",
  createdAt: "2026-10-20T14:15:00.000Z",
  trigger: "scheduled",
  scheduleId: "sched-noview",
  inputModel: "no-view",
  status: "partial",
  requestCount: 3,
  completedCount: 1,
  failedCount: 1,
  abstainedCount: 1,
  symbols: ["NVDA", "MSFT", "AAPL"],
  requests: [],
  constraintSets: [csNv(CONSTRAINT_NVDA_534), csNv(CONSTRAINT_MSFT_534), csNv(CONSTRAINT_AAPL_534)],
  outcomes: [
    {
      symbol: "NVDA",
      status: "completed",
      constraintSet: csNv(CONSTRAINT_NVDA_534),
      rankedNoView: NVDA_NOVIEW_RANKED,
      excluded: [{ reason: "max planned loss exceeded", count: 2 }],
      bestNoViewTrade: {
        status: "research_only",
        riskProfile: "balanced",
        confidence: "MEDIUM",
        best: NVDA_NOVIEW_RANKED[0],
        alternatives: [NVDA_NOVIEW_RANKED[1]],
        rationale: [NO_VIEW_RATIONALE_534, "NVDA Long Call ranks #1 for a balanced profile."],
        blockers: [],
        humanApprovalRequired: true,
        disclaimer: "research only",
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 1200, contractsMatched: 45 } },
    },
    {
      symbol: "MSFT",
      status: "completed",
      abstained: true,
      constraintSet: csNv(CONSTRAINT_MSFT_534),
      rankedNoView: [],
      excluded: [
        { reason: "insufficient liquidity", count: 3 },
        { reason: "probability of profit below the floor", count: 2 },
      ],
      bestNoViewTrade: {
        status: "no_trade",
        riskProfile: "balanced",
        confidence: "LOW",
        alternatives: [],
        rationale: [
          "No user view was supplied and no MSFT structure cleared the stated constraints (max planned loss, structure reward/risk, probability-of-profit floor); the mode abstains rather than manufacturing a pick.",
        ],
        blockers: ["No qualifying candidates"],
        humanApprovalRequired: true,
        disclaimer: "research only",
      },
      snapshot: { dataSource: "live", screen: { contractsEvaluated: 800, contractsMatched: 0 } },
    },
    {
      symbol: "AAPL",
      status: "failed",
      constraintSet: csNv(CONSTRAINT_AAPL_534),
      error: "E*TRADE chain unavailable: session expired",
    },
  ],
};

const RUN_NOVIEW_SUMMARY = (() => {
  const { requests: _r, outcomes: _o, constraintSets: _c, ...summary } = RUN_NOVIEW;
  return summary;
})();

describe("DiscoveryRunsPanel — no-view runs (#534)", () => {
  beforeEach(() => {
    listPayload = { count: 1, runs: [RUN_NOVIEW_SUMMARY] };
    DETAILS["run-noview"] = RUN_NOVIEW;
  });

  afterEach(() => {
    delete DETAILS["run-noview"];
  });

  function outcomeBlock(symbol: string): HTMLElement {
    // Outcomes are now primitive Cards (S-U2 #3051): the outcome's
    // symbol is the header <strong> (exact text — ranked rows carry
    // "SYMBOL <label>", never the bare symbol), so the Card around
    // it is the outcome block. No .discovery-outcome class remains.
    const strong = Array.from(container.querySelectorAll("strong")).find(
      (el) => el.textContent === symbol,
    );
    const block = strong?.closest(".ui-card") as HTMLElement | null;
    if (!block) throw new Error(`outcome block for ${symbol} not found`);
    return block;
  }

  it("labels the run No-view · constraints only (never Saved requests) with per-symbol counts", async () => {
    await renderPanel();
    const items = runItems();
    expect(items).toHaveLength(1);
    const text = items[0].textContent || "";
    expect(text).toContain("No-view · constraints only");
    expect(text).not.toContain("Saved requests");
    expect(text).toContain("NVDA, MSFT, AAPL");
    expect(text).toContain("1 of 3 symbols completed");
    expect(text).toContain("1 failed");
    expect(text).toContain("1 abstained");
  });

  it("renders the NO-VIEW run note and each outcome's stored constraint set in place of a view line", async () => {
    await renderPanel();
    const text = container.textContent || "";
    expect(text).toContain("No-view · constraints only — no thesis or target was supplied, derived, or assumed");
    expect(text).toContain("no-view-v1 score model");
    expect(text).toContain("2 ranked candidates across 1 completed symbol");
    expect(text).toContain("Failed: AAPL");
    expect(text).toContain("Abstained: MSFT");
    // No outcome in a no-view run renders a saved or derived view line.
    expect(text).not.toContain("Saved view:");
    expect(text).not.toContain("Derived view");
    // The constraint line: caps, floors, DTE window, the fixed IV assumption.
    const nvda = outcomeBlock("NVDA");
    expect(nvda.textContent).toContain("Constraints (no-view — no thesis, no target)");
    expect(nvda.textContent).toContain("max planned loss $500.00");
    expect(nvda.textContent).toContain("min reward/risk 1×");
    expect(nvda.textContent).toContain("min POP 35%");
    expect(nvda.textContent).toContain("DTE 7–45");
    expect(nvda.textContent).toContain("risk profile balanced");
    expect(nvda.textContent).toContain("IV expected unchanged");
    // Even the failed outcome shows the constraints it ran under.
    expect(outcomeBlock("AAPL").textContent).toContain("max planned loss $250.00");
  });

  it("renders ranked structures with the no-view-v1 model and structure R/R, and the pick as research only", async () => {
    await renderPanel();
    const nvda = outcomeBlock("NVDA");
    const text = nvda.textContent || "";
    expect(text).toContain("NVDA Long Call");
    expect(text).toContain("Composite 82.5");
    expect(text).toContain("score model no-view-v1");
    expect(text).toContain("POP 42%");
    expect(text).toContain("Structure R/R");
    expect(text).not.toContain("Target R/R");
    // The best-supported structure: research only, capped confidence,
    // the pinned rationale verbatim — never "Recommended".
    expect(text).toContain("Best-supported structure (no-view)");
    expect(text).toContain("Research only");
    expect(text).toContain("confidence MEDIUM");
    expect(text).toContain(NO_VIEW_RATIONALE_534);
    expect(text).toContain("Excluded: 2");
    expect(text).toContain("max planned loss exceeded ×2");
    expect(container.textContent || "").not.toContain("Recommended");
  });

  it("renders a flag abstention off the flag — as an abstention with gate reasons, not a failure", async () => {
    await renderPanel();
    const msft = outcomeBlock("MSFT");
    const text = msft.textContent || "";
    // Status badge stays Completed (the outcome completed) and the
    // abstention is badged separately off the flag.
    expect(text).toContain("Completed");
    expect(text).toContain("Abstained");
    // The abstention box (not the failure box) names the gate reasons.
    expect(msft.querySelector(".ui-notice.tone-warning")).not.toBeNull();
    expect(msft.querySelector(".ui-notice.tone-danger")).toBeNull();
    expect(text).toContain("Abstained — the chain loaded, but no structure qualified under the stated constraints");
    expect(text).toContain("insufficient liquidity ×3");
    expect(text).toContain("probability of profit below the floor ×2");
    expect(text).toContain("No pick was manufactured.");
    // No best-pick box and no ranked rows for an abstention.
    expect(text).not.toContain("Best-supported");
    expect(msft.querySelector('[aria-label*="ranked structures"]')).toBeNull();
  });

  it("renders the failed symbol with its reason and the constraints it ran under", async () => {
    await renderPanel();
    const aapl = outcomeBlock("AAPL");
    expect(aapl.querySelector(".ui-notice.tone-danger")).not.toBeNull();
    expect(aapl.textContent).toContain("E*TRADE chain unavailable: session expired");
    expect(aapl.textContent).toContain("Constraints (no-view");
  });

  it("downloads for a no-view run carry the NO-VIEW labelling, constraints and abstentions", async () => {
    await renderPanel();
    await act(async () => {
      buttonByText("Candidates CSV")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe("discovery-20261020-141500.csv");
    const csv = await blobText(downloads[0].blob);
    expect(csv).toContain("NO-VIEW (constraints only)");
    expect(csv).toContain("input model: no-view");
    expect(csv).toContain("# CONSTRAINTS: NVDA — max planned loss $500.00");
    expect(csv).toContain("# ABSTAINED: MSFT — no structure qualified under the stated constraints");
    expect(csv).toContain("scoreModel");
    expect(csv).toContain("no-view-v1");

    downloads.length = 0;
    await act(async () => {
      buttonByText("Run JSON")?.click();
    });
    await flush(1);
    expect(downloads).toHaveLength(1);
    const parsed = JSON.parse(await blobText(downloads[0].blob));
    expect(parsed.inputModel).toBe("no-view");
    expect(parsed.constraintSets).toHaveLength(3);
    expect(parsed.outcomes[1].abstained).toBe(true);
    expect(parsed.outcomes[0].bestNoViewTrade.status).toBe("research_only");
    expect("thesis" in parsed.constraintSets[0].request).toBe(false);
  });
});

describe("formatConstraintSetLine (#534)", () => {
  it("renders caps, floors, DTE window, risk profile and the fixed IV assumption", () => {
    expect(formatConstraintSetLine(csNv(CONSTRAINT_NVDA_534) as any)).toBe(
      "Constraints (no-view — no thesis, no target) · max planned loss $500.00 · min reward/risk 1× · min POP 35% · DTE 7–45 · risk profile balanced · IV expected unchanged",
    );
  });

  it("renders the default POP floor and no DTE part when the set omits them", () => {
    expect(formatConstraintSetLine(csNv(CONSTRAINT_AAPL_534) as any)).toBe(
      "Constraints (no-view — no thesis, no target) · max planned loss $250.00 · min reward/risk 2× · min POP 35% · risk profile conservative · IV expected unchanged",
    );
  });
});
