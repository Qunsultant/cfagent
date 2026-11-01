/** @vitest-environment jsdom */
/**
 * Issue #84 slice 1: Opportunity Scanner panel (mode switch #23 +
 * strategy profiles #28) and its API client.
 * Slice 2 additions: the fit matrix board (#22) + per-type screen
 * roll-up cards (#26) + the cell → HITL preview handoff, with the
 * board/rollup fixtures typed against the real server types so a
 * backend shape change breaks these tests on purpose.
 * Slice 3 additions: the trust layer — target-source chips on every
 * target, the labelled "Data as of" header + scan model version,
 * composite-score labelling, and borderline bucket chips.
 * Slice 5 additions: scan history (#27) — the history client against
 * the scans routes, the history list with provenance, View / Re-run /
 * Diff, with fixtures typed against the real store types.
 *
 * Harness follows the established panel tests: the REAL apiFetch is
 * driven against a stubbed global fetch, and — per the #71 lesson —
 * the transport contract is mocked, not just the payload: one test
 * runs the scan through the worker's actual 202 async-job stub →
 * poll statusUrl → completed flow. Component tests render with
 * react-dom/client in jsdom (the repo's render harness) and drive the
 * real form controls.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ScannerPanel,
  ScanResultsView,
  ScanDiffView,
  MODE_LABELS,
  buildScanRequest,
  buildProfileSpec,
  buildRerunRequest,
  profileSummary,
  profileToForm,
  emptyProfileForm,
  bestFitCell,
  noFitMessage,
  matrixStrategyTypes,
  topRejectionReason,
  matrixCellTradeContext,
  shortenRunId,
  TargetSourceChip,
  TARGET_SOURCE_LABELS,
  type ProfileFormState,
} from "../src/client/ScannerPanel";
import type {
  OpportunityScanResult,
  ScanMatrixCellBest,
  ScanMatrixRow,
  ScanTargetSource,
  ScanTypeRollup,
} from "../src/trading/options/opportunityScanner";
import type { StrategyLeg } from "../src/trading/options/strategyEngine";
import type { TradeOrderContext } from "../src/client/trading/tradeOrderContext";
import {
  runOpportunityScan,
  listProfiles,
  listScanRuns,
  getScanRun,
  getScanRunDiff,
  coerceScanResponse,
  type OpportunityScanResponse,
  type ScanRunDiffResult,
} from "../src/client/scannerApi";
import type {
  ScanRunDiff,
  ScanRunSummary,
  StoredScanRun,
} from "../src/trading/options/scanRunStore";
import type { StrategyProfile } from "../src/trading/options/strategyProfile";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -----------------------------------------------------------------

const incomeProfile: StrategyProfile = {
  id: "prof-1",
  userLogin: "trader1",
  name: "Income",
  version: 2,
  createdAt: "2026-10-10T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z",
  thesis: "range_bound",
  maxPlannedLoss: 500,
  allowedStrategies: ["put_credit_spread", "iron_condor"],
  fitGate: { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" },
};

const growthProfile: StrategyProfile = {
  id: "prof-2",
  userLogin: "trader1",
  name: "Growth",
  version: 1,
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
  thesis: "bullish",
};

const perNameEnvelope = {
  action: "opportunities",
  success: true,
  scanned: 2,
  withTrades: 1,
  opportunities: [
    {
      symbol: "AAPL",
      underlyingPrice: 250,
      targetPrice: 262.5,
      targetSource: "thesis",
      targetEmUnits: 0.6,
      score: 71.2,
      gateBucket: "fit",
      gateReasons: [],
      pick: {
        status: "recommended",
        riskProfile: "balanced",
        confidence: "HIGH",
        alternatives: [],
        rationale: [],
        blockers: [],
        humanApprovalRequired: true,
        disclaimer: "",
        best: {
          rank: 1,
          compositeScore: 71.2,
          components: {},
          candidate: {
            label: "Bull Call Spread",
            type: "call_debit_spread",
            netDebit: 3.25,
            maxLoss: 325,
            maxProfit: 675,
            modelImpliedProbabilityOfProfit: 0.42,
          },
        },
      },
    },
  ],
  skipped: [{ symbol: "ZZZ", reason: "no chain data" }],
  truncatedSymbols: 0,
  assumptions: [
    "Stated target $500 applies to SPY only.",
    'Strategy profile "Income" (v2) applied — thesis range_bound, max planned loss $500.',
  ],
  matrix: [],
  typeRollup: [],
  mode: "per_name_best",
  fits: [],
  fitsTotal: 0,
  gate: { fit: 1, borderline: 1, noFit: 0 },
  borderline: [],
  gateParams: { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" },
  profileRef: { id: "prof-1", name: "Income", version: 2 },
  generatedAt: "2026-10-16T14:00:00.000Z",
  modelVersion: "1.1.2",
  requestSnapshot: {},
  configSnapshot: {},
  coverage: { considered: 3, scanned: 2, truncated: 0, evaluated: 2, errors: 1, withTrades: 1 },
} as any;

const fitRow = {
  symbol: "MSFT",
  verdict: "pass",
  targetPrice: 420,
  targetSource: "thesis",
  targetEmUnits: 0.55,
  gateBucket: "fit",
  gateReasons: [],
  cells: [
    {
      strategyType: "iron_condor",
      best: {
        candidateId: "c1", label: "Iron Condor", compositeScore: 66.4, score: 60,
        expirationDate: "2026-11-20", legs: [], netDebit: -2.1, maxLoss: 290,
        maxProfit: 210, maxProfitUnbounded: false, targetRewardRisk: 0.72,
        probabilityOfProfit: 0.61,
      },
      evaluatedCount: 5, passedCount: 2, rejectedCount: 3, rejectionReasons: {},
    },
  ],
} as any;

const fitEnvelope = {
  ...perNameEnvelope,
  mode: "strategy_fit",
  opportunities: [],
  fits: [fitRow],
  fitsTotal: 1,
  gate: { fit: 1, borderline: 1, noFit: 0 },
  borderline: [{ ...fitRow, symbol: "NVDA", gateBucket: "borderline", cells: [] }],
  profileRef: null,
  assumptions: [],
  coverage: { considered: 3, scanned: 3, truncated: 0, evaluated: 2, errors: 1, withTrades: 1 },
} as any;

const noFitEnvelope = {
  ...perNameEnvelope,
  mode: "strategy_fit",
  opportunities: [],
  fits: [],
  fitsTotal: 0,
  gate: { fit: 0, borderline: 2, noFit: 1 },
  borderline: [],
  profileRef: null,
  assumptions: [],
  coverage: { considered: 4, scanned: 4, truncated: 0, evaluated: 3, errors: 1, withTrades: 0 },
} as any;

// Fetch stub ---------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
  headers?: Record<string, string>;
}

interface StubState {
  profiles: StrategyProfile[];
  unifiedEnvelope: any;
  unifiedViaJob: boolean;
  createError?: string;
  nextId: number;
  /** Persisted scan runs the scans routes serve (slice 5). */
  scanRuns: StoredScanRun[];
  /** Canned diffs for the diff route, keyed `${fromId}|${toId}`;
   *  a pair with no entry diffs as all-empty. */
  scanDiffs: Record<string, ScanRunDiff>;
}

const EMPTY_SCAN_DIFF: ScanRunDiff = {
  newFits: [], droppedFits: [], stillFitting: [], bucketChanges: [], addedSymbols: [], removedSymbols: [],
};

function installFetch(state: StubState) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, headers: init.headers });

    if (url.includes("/api/jobs/")) {
      return Response.json({
        jobId: "job-scan",
        capability: "http.request",
        status: "completed",
        statusUrl: "/api/jobs/job-scan",
        responseStatus: 200,
        result: { body: JSON.stringify(state.unifiedEnvelope), headers: { "content-type": "application/json" } },
      });
    }
    if (url.endsWith("/api/trading/options/unified")) {
      if (state.unifiedViaJob) {
        return Response.json({ jobId: "job-scan", status: "queued", statusUrl: "/api/jobs/job-scan" }, { status: 202 });
      }
      return Response.json(state.unifiedEnvelope);
    }
    // Scan-history routes (issue #27), declared in the orchestrator's
    // own order: list → diff → by-id (the diff route must win over the
    // by-id pattern). A run id the state no longer holds is the
    // route's 404, exactly like a pruned run server-side.
    if (url.includes("/api/etrade/options/scans/diff")) {
      const params = new URL(url, "http://stub").searchParams;
      const from = state.scanRuns.find((r) => r.id === params.get("from"));
      const to = state.scanRuns.find((r) => r.id === params.get("to"));
      if (!params.get("from") || !params.get("to")) {
        return Response.json({ error: "from and to scan run ids are required" }, { status: 400 });
      }
      if (!from || !to) return Response.json({ error: "scan run not found" }, { status: 404 });
      return Response.json({
        from: { id: from.id, generatedAt: from.generatedAt },
        to: { id: to.id, generatedAt: to.generatedAt },
        diff: state.scanDiffs[`${from.id}|${to.id}`] ?? EMPTY_SCAN_DIFF,
      });
    }
    if (url.includes("/api/etrade/options/scans")) {
      const scanIdMatch = url.match(/\/api\/etrade\/options\/scans\/([^/?]+)/);
      if (scanIdMatch) {
        const run = state.scanRuns.find((r) => r.id === decodeURIComponent(scanIdMatch[1]));
        if (!run) return Response.json({ error: "scan run not found" }, { status: 404 });
        return Response.json(run);
      }
      const limitParam = new URL(url, "http://stub").searchParams.get("limit");
      const summaries = state.scanRuns.map(({ result: _result, ...summary }) => summary);
      return Response.json({
        count: summaries.length,
        scans: limitParam ? summaries.slice(0, Number(limitParam)) : summaries,
      });
    }
    if (url.endsWith("/api/etrade/options/profiles")) {
      if (method === "GET") return Response.json({ count: state.profiles.length, profiles: state.profiles });
      if (method === "POST") {
        if (state.createError) return Response.json({ error: state.createError }, { status: 400 });
        const { name, ...spec } = body;
        const created: StrategyProfile = {
          id: `prof-new-${state.nextId++}`,
          userLogin: "trader1",
          name,
          version: 1,
          createdAt: "2026-10-16T15:00:00.000Z",
          updatedAt: "2026-10-16T15:00:00.000Z",
          ...spec,
        };
        state.profiles = [...state.profiles, created];
        return Response.json(created, { status: 201 });
      }
    }
    const profileMatch = url.match(/\/api\/etrade\/options\/profiles\/([^/]+)$/);
    if (profileMatch) {
      const id = decodeURIComponent(profileMatch[1]);
      const existing = state.profiles.find((p) => p.id === id);
      if (!existing) return Response.json({ error: "profile not found" }, { status: 404 });
      if (method === "GET") return Response.json(existing);
      if (method === "PUT") {
        const { name, ...spec } = body;
        const updated: StrategyProfile = {
          ...existing, ...spec, name: name ?? existing.name,
          version: existing.version + 1, updatedAt: "2026-10-16T15:05:00.000Z",
        };
        state.profiles = state.profiles.map((p) => (p.id === id ? updated : p));
        return Response.json(updated);
      }
      if (method === "DELETE") {
        state.profiles = state.profiles.filter((p) => p.id !== id);
        return Response.json({ deleted: true });
      }
    }
    return Response.json({ error: `unstubbed ${method} ${url}` }, { status: 500 });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

function freshState(overrides: Partial<StubState> = {}): StubState {
  return {
    profiles: [incomeProfile, growthProfile],
    unifiedEnvelope: perNameEnvelope,
    unifiedViaJob: false,
    nextId: 1,
    scanRuns: [],
    scanDiffs: {},
    ...overrides,
  };
}

// DOM helpers ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

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

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ScannerPanel, { activeEnv: "TEST", userLogin: "trader1" }));
  });
  await flush(60);
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(40);
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush(60);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

// API client + transport contract -------------------------------------------

describe("scannerApi vs the async-job transport (issue #71 contract)", () => {
  it("runOpportunityScan polls the 202 job stub and resolves the real scan envelope", async () => {
    const calls = installFetch(freshState({ unifiedViaJob: true }));
    const result = await runOpportunityScan("TEST", "trader1", {
      action: "opportunities", symbols: ["AAPL"], mode: "per_name_best",
    });
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0].symbol).toBe("AAPL");
    expect(result.profileRef).toEqual({ id: "prof-1", name: "Income", version: 2 });
    // The transport really was job-polled, not direct JSON.
    expect(calls.some((c) => c.url.includes("/api/jobs/"))).toBe(true);
    const post = calls.find((c) => c.url.endsWith("/api/trading/options/unified"));
    expect(post?.method).toBe("POST");
    expect(post?.headers?.["x-environment"]).toBe("TEST");
    expect(post?.headers?.["x-user-login"]).toBe("trader1");
  });

  it("surfaces the unified service's error field (failed profile resolution) as a throw", async () => {
    installFetch(freshState({
      unifiedEnvelope: { action: "opportunities", success: false, error: 'No saved profile named "Nope".' },
    }));
    await expect(
      runOpportunityScan("TEST", "trader1", { action: "opportunities", profileName: "Nope" }),
    ).rejects.toThrow('No saved profile named "Nope".');
  });

  it("listProfiles reads the { count, profiles } envelope and sends the user header", async () => {
    const calls = installFetch(freshState());
    const profiles = await listProfiles("PROD", "trader1");
    expect(profiles.map((p) => p.name)).toEqual(["Income", "Growth"]);
    expect(calls[0].headers?.["x-user-login"]).toBe("trader1");
    expect(calls[0].headers?.["x-environment"]).toBe("PROD");
  });

  it("coerceScanResponse fills missing arrays and rejects a non-object body", () => {
    const coerced = coerceScanResponse({ action: "opportunities", success: true });
    expect(coerced.opportunities).toEqual([]);
    expect(coerced.fits).toEqual([]);
    expect(coerced.assumptions).toEqual([]);
    expect(() => coerceScanResponse("nope")).toThrow(/response shape/);
  });
});

// Pure view-model helpers ------------------------------------------------------

describe("buildScanRequest (mode is explicit on every run)", () => {
  it("per_name_best sends mode, normalized symbols, thesis and risk profile — no limit, no profile", () => {
    const body = buildScanRequest({
      symbolsText: "aapl, msft AAPL", thesis: "bullish", riskProfile: "balanced",
      mode: "per_name_best", profileId: "", fitLimit: 25,
    });
    expect(body.action).toBe("opportunities");
    expect(body.mode).toBe("per_name_best");
    expect(body.symbols).toEqual(["AAPL", "MSFT"]);
    expect(body.thesis).toBe("bullish");
    expect(body.riskProfile).toBe("balanced");
    expect(body.profileId).toBeUndefined();
    expect(body.limit).toBeUndefined();
  });

  it("strategy_fit sends the fit limit and the chosen profileId", () => {
    const body = buildScanRequest({
      symbolsText: "MSFT", thesis: "range_bound", riskProfile: "conservative",
      mode: "strategy_fit", profileId: "prof-1", fitLimit: 50,
    });
    expect(body.mode).toBe("strategy_fit");
    expect(body.limit).toBe(50);
    expect(body.profileId).toBe("prof-1");
  });
});

describe("buildProfileSpec (empty optionals are omitted, never null/'')", () => {
  it("a name-only form produces an empty spec", () => {
    const { spec, problems } = buildProfileSpec({ ...emptyProfileForm(), name: "Bare" });
    expect(spec).toEqual({});
    expect(problems).toEqual([]);
  });

  it("parses numbers, splits strategy types, and includes the gate only when enabled", () => {
    const form: ProfileFormState = {
      ...emptyProfileForm(),
      name: "Income",
      thesis: "range_bound",
      allowedStrategies: "put_credit_spread, iron_condor",
      maxPlannedLoss: "500",
      minDte: "20",
      maxDte: "45",
      gateEnabled: true,
      gateMinCompositeScore: "55",
      gateMinProbabilityOfProfit: "0.35",
      gateRequireFresh: true,
      gateMinConfidence: "MEDIUM",
    };
    const { spec, problems } = buildProfileSpec(form);
    expect(problems).toEqual([]);
    expect(spec.thesis).toBe("range_bound");
    expect(spec.allowedStrategies).toEqual(["put_credit_spread", "iron_condor"]);
    expect(spec.maxPlannedLoss).toBe(500);
    expect(spec.minDte).toBe(20);
    expect(spec.maxDte).toBe(45);
    expect(spec.minRewardRisk).toBeUndefined();
    expect(spec.fitGate).toEqual({
      requireFresh: true, minCompositeScore: 55, minProbabilityOfProfit: 0.35, minConfidence: "MEDIUM",
    });
  });

  it("reports non-numeric numeric fields as problems instead of sending NaN", () => {
    const { spec, problems } = buildProfileSpec({ ...emptyProfileForm(), maxPlannedLoss: "abc" });
    expect(spec.maxPlannedLoss).toBeUndefined();
    expect(problems).toEqual(["Max planned loss must be a number."]);
  });

  it("profileToForm round-trips a stored profile into the editor", () => {
    const form = profileToForm(incomeProfile);
    expect(form.name).toBe("Income");
    expect(form.maxPlannedLoss).toBe("500");
    expect(form.allowedStrategies).toBe("put_credit_spread, iron_condor");
    expect(form.gateEnabled).toBe(true);
    expect(form.gateMinProbabilityOfProfit).toBe("0.35");
    const { spec } = buildProfileSpec(form);
    expect(spec.maxPlannedLoss).toBe(500);
    expect(spec.fitGate?.minCompositeScore).toBe(55);
  });
});

describe("profileSummary + bestFitCell + noFitMessage", () => {
  it("summarizes only the constraints a profile sets", () => {
    expect(profileSummary(incomeProfile)).toContain("thesis range_bound");
    expect(profileSummary(incomeProfile)).toContain("max loss $500");
    expect(profileSummary(incomeProfile)).toContain("gate: score ≥55, POP ≥35%, fresh only, ≥MEDIUM");
    expect(profileSummary({ ...growthProfile, thesis: undefined })).toBe("No constraints set");
  });

  it("bestFitCell picks the highest-composite passing cell, null when none passed", () => {
    expect(bestFitCell(fitRow)?.label).toBe("Iron Condor");
    expect(bestFitCell({ ...fitRow, cells: [{ ...fitRow.cells[0], best: null }] })).toBeNull();
  });

  it("noFitMessage carries the gate accounting verbatim", () => {
    expect(noFitMessage(noFitEnvelope as OpportunityScanResponse)).toBe(
      "No names fit under the current gate — 3 evaluated, 2 borderline, 1 skipped.",
    );
  });
});

// Component behavior (jsdom) ---------------------------------------------------

describe("ScannerPanel — mode switch + scan run", () => {
  it("runs per_name_best by default: body carries the mode, header names it, rows + badge + assumptions render", async () => {
    const calls = installFetch(freshState());
    await renderPanel();
    await waitForText("Income (v2)"); // profile picker populated from listProfiles

    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Bull Call Spread");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body.mode).toBe("per_name_best");
    expect(post?.body.symbols).toEqual(["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"]);
    expect(container.textContent).toContain(`Mode: ${MODE_LABELS.per_name_best}`);
    expect(container.textContent).toContain("AAPL");
    expect(container.textContent).toContain("71.2");
    expect(container.textContent).toContain("42.0%"); // POP rendered from the 0.42 fraction
    expect(container.textContent).toContain("Profile: Income v2"); // server profileRef badge
    expect(container.textContent).toContain("Stated target $500 applies to SPY only.");
    expect(container.textContent).toContain('Strategy profile "Income" (v2) applied');
    expect(container.textContent).toContain("2 scanned · 2 evaluated · 1 skipped");
  });

  it("switching to strategy_fit sends that mode + limit and renders ALL fits with the borderline accounted", async () => {
    const calls = installFetch(freshState({ unifiedEnvelope: fitEnvelope }));
    await renderPanel();
    await waitForText("Income (v2)");

    await click(buttonByText(container, "Names that fit my strategy"));
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Iron Condor");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body.mode).toBe("strategy_fit");
    expect(post?.body.limit).toBe(25);
    expect(container.textContent).toContain(`Mode: ${MODE_LABELS.strategy_fit}`);
    expect(container.textContent).toContain("1 fits");
    expect(container.textContent).toContain("MSFT");
    expect(container.textContent).toContain("66.4");
    expect(container.textContent).toContain("Borderline (evaluated, below the gate): NVDA");
  });

  it("selecting a profile in the picker sends its profileId on the run", async () => {
    const calls = installFetch(freshState());
    await renderPanel();
    await waitForText("Income (v2)");

    const picker = container.querySelector<HTMLSelectElement>("#scp-profile")!;
    await act(async () => {
      setValue(picker, "prof-1");
    });
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Bull Call Spread");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body.profileId).toBe("prof-1");
    expect(post?.body.profileName).toBeUndefined();
  });

  it("strategy_fit with zero fits renders the explicit no-fit state, not a table", async () => {
    installFetch(freshState({ unifiedEnvelope: noFitEnvelope }));
    await renderPanel();

    await click(buttonByText(container, "Names that fit my strategy"));
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("No names fit under the current gate");

    expect(container.textContent).toContain("No names fit under the current gate — 3 evaluated, 2 borderline, 1 skipped.");
    const results = container.querySelector(".scp-results");
    expect(results?.querySelector("table")).toBeNull();
  });

  it("a malformed scan payload (all arrays missing) renders without throwing", async () => {
    installFetch(freshState({ unifiedEnvelope: { action: "opportunities", success: true } }));
    await renderPanel();
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("No qualifying trades were returned for this scan.");
    expect(container.textContent).toContain(`Mode: ${MODE_LABELS.per_name_best}`);
    expect(container.querySelector(".scp-error")).toBeNull();
  });

  it("a server error message from the scan renders in the error box", async () => {
    installFetch(freshState({
      unifiedEnvelope: { action: "opportunities", success: false, error: 'No saved profile named "Ghost".' },
    }));
    await renderPanel();
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText('No saved profile named "Ghost".');
    expect(container.querySelector(".scp-error")?.textContent).toContain('No saved profile named "Ghost".');
  });
});

describe("ScannerPanel — strategy profiles manager (surface 4)", () => {
  it("create POSTs { name, ...spec } with empty optionals omitted, refreshes list + picker, shows the new version", async () => {
    const calls = installFetch(freshState({ profiles: [] }));
    await renderPanel();
    await waitForText("No saved profiles yet.");

    await click(buttonByText(container, "New profile"));
    const form = container.querySelector<HTMLFormElement>("#scp-profile-form")!;
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-name")!, "Income");
      setValue(form.querySelector<HTMLSelectElement>("#scp-pf-thesis")!, "range_bound");
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-maxloss")!, "500");
    });
    // Enable the fit gate and set its min score.
    await click(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-gate-score")!, "55");
    });
    await submitForm(form);
    await waitForText('Saved profile "Income" — now v1.');

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/etrade/options/profiles"));
    expect(post?.body).toEqual({
      name: "Income",
      thesis: "range_bound",
      maxPlannedLoss: 500,
      fitGate: { requireFresh: true, minCompositeScore: 55 },
    });
    // List refreshed and the picker now offers the new profile.
    const picker = container.querySelector<HTMLSelectElement>("#scp-profile")!;
    expect([...picker.options].map((o) => o.textContent)).toContain("Income (v1)");
    expect(container.textContent).toContain("max loss $500");
  });

  it("edit PUTs the full spec to /profiles/:id and shows the bumped version", async () => {
    const calls = installFetch(freshState({ profiles: [incomeProfile] }));
    await renderPanel();
    await waitForText("Income");

    await click(buttonByText(container, "Edit"));
    const form = container.querySelector<HTMLFormElement>("#scp-profile-form")!;
    expect(form.querySelector<HTMLInputElement>("#scp-pf-name")!.value).toBe("Income");
    expect(form.querySelector<HTMLInputElement>("#scp-pf-maxloss")!.value).toBe("500");
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-maxloss")!, "750");
    });
    await submitForm(form);
    await waitForText('Saved profile "Income" — now v3.');

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/api/etrade/options/profiles/prof-1");
    expect(put?.body.name).toBe("Income");
    expect(put?.body.maxPlannedLoss).toBe(750);
    expect(put?.body.fitGate).toEqual({
      requireFresh: true, minCompositeScore: 55, minProbabilityOfProfit: 0.35, minConfidence: "MEDIUM",
    });
  });

  it("delete is a two-step inline confirm: first click arms, second click DELETEs", async () => {
    const calls = installFetch(freshState({ profiles: [incomeProfile] }));
    await renderPanel();
    await waitForText("Income");

    await click(buttonByText(container, "Delete"));
    expect(container.textContent).toContain("Confirm delete?");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await click(buttonByText(container, "Confirm delete?"));
    await waitForText('Deleted profile "Income".');
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/api/etrade/options/profiles/prof-1");
    expect(container.textContent).toContain("No saved profiles yet.");
  });

  it("a 400 from create renders the server's message verbatim in the form", async () => {
    installFetch(freshState({ profiles: [], createError: 'A profile named "Income" already exists' }));
    await renderPanel();
    await waitForText("No saved profiles yet.");

    await click(buttonByText(container, "New profile"));
    const form = container.querySelector<HTMLFormElement>("#scp-profile-form")!;
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-name")!, "Income");
    });
    await submitForm(form);
    await waitForText('A profile named "Income" already exists');
    expect(form.querySelector(".scp-error")?.textContent).toBe('A profile named "Income" already exists');
    // The form stays open so the user can fix the name.
    expect(container.querySelector("#scp-profile-form")).not.toBeNull();
  });
});

describe("ScanResultsView (pure render)", () => {
  it("fit mode names the mode, the profile badge, and every fit row", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(
      React.createElement(ScanResultsView, {
        result: fitEnvelope as OpportunityScanResponse,
        runContext: { mode: "strategy_fit" as const, profileLabel: null },
      }),
    ).replace(/<!-- -->/g, ""); // SSR inserts comment markers between text nodes
    expect(html).toContain("Mode: Names that fit my strategy");
    expect(html).toContain("Iron Condor");
    expect(html).toContain("MSFT");
  });

  it("does not throw on a payload with every array missing", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(
      React.createElement(ScanResultsView, {
        result: coerceScanResponse({ action: "opportunities", success: true }),
        runContext: { mode: "strategy_fit" as const, profileLabel: null },
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("No names fit under the current gate — 0 evaluated, 0 borderline, 0 skipped.");
  });
});

// Slice 2 fixtures — typed against the REAL server types ---------------------

function makeLeg(partial: Partial<StrategyLeg>): StrategyLeg {
  return {
    symbol: "AAPL261120P00230000",
    optionType: "PUT",
    side: "SELL",
    quantity: 1,
    strike: 230,
    expirationDate: "2026-11-20",
    entryPrice: 1.85,
    bid: 1.8,
    ask: 1.9,
    impliedVolatility: 0.28,
    delta: -0.22,
    gamma: 0.01,
    theta: -0.03,
    vega: 0.12,
    openInterest: 1200,
    volume: 340,
    spreadPct: 0.05,
    quoteTimestamp: "2026-10-16T14:00:00.000Z",
    quoteFreshness: "FRESH",
    multiplier: 100,
    ...partial,
  };
}

const condorLegs: StrategyLeg[] = [
  makeLeg({ symbol: "AAPL261120P00230000", side: "SELL", optionType: "PUT", strike: 230, entryPrice: 1.85 }),
  makeLeg({ symbol: "AAPL261120P00225000", side: "BUY", optionType: "PUT", strike: 225, entryPrice: 1.2 }),
  makeLeg({ symbol: "AAPL261120C00270000", side: "SELL", optionType: "CALL", strike: 270, entryPrice: 1.6 }),
  makeLeg({ symbol: "AAPL261120C00275000", side: "BUY", optionType: "CALL", strike: 275, entryPrice: 1.05 }),
];

const condorBest: ScanMatrixCellBest = {
  candidateId: "aapl-ic-1",
  label: "Iron Condor",
  compositeScore: 66.4,
  score: 61.2,
  expirationDate: "2026-11-20",
  legs: condorLegs,
  netDebit: -2.1,
  maxLoss: 290,
  maxProfit: 210,
  maxProfitUnbounded: false,
  targetRewardRisk: 0.72,
  probabilityOfProfit: 0.61,
};

const boardRows: ScanMatrixRow[] = [
  {
    symbol: "AAPL",
    verdict: "pass",
    targetPrice: 262.5,
    targetSource: "thesis",
    targetEmUnits: 0.6,
    gateBucket: "fit",
    gateReasons: [],
    cells: [
      {
        strategyType: "iron_condor", best: condorBest,
        evaluatedCount: 5, passedCount: 2, rejectedCount: 3,
        rejectionReasons: { "spread too wide": 3 },
      },
      {
        strategyType: "call_debit_spread", best: null,
        evaluatedCount: 6, passedCount: 0, rejectedCount: 6,
        rejectionReasons: { "max loss exceeds limit": 4, "spread too wide": 2 },
      },
    ],
  },
  {
    symbol: "MSFT",
    verdict: "no_pass",
    targetPrice: 420,
    targetSource: "thesis",
    targetEmUnits: 0.55,
    gateBucket: "no_fit",
    gateReasons: ["no screen-passing pick"],
    cells: [
      {
        strategyType: "iron_condor", best: null,
        evaluatedCount: 4, passedCount: 0, rejectedCount: 4,
        rejectionReasons: { "iv rank too low": 4 },
      },
      {
        strategyType: "put_credit_spread", best: null,
        evaluatedCount: 3, passedCount: 0, rejectedCount: 3,
        rejectionReasons: { "reward/risk below minimum": 2, "iv rank too low": 1 },
      },
    ],
  },
  {
    symbol: "ZZZ",
    verdict: "skipped",
    skipReason: "no chain data",
    targetPrice: null,
    targetSource: null,
    targetEmUnits: null,
    gateBucket: null,
    gateReasons: [],
    cells: [],
  },
];

const boardRollup: ScanTypeRollup[] = [
  {
    strategyType: "iron_condor",
    symbolsEvaluated: 2,
    symbolsPassed: 1,
    evaluatedCount: 9,
    passedCount: 2,
    rejectedCount: 7,
    rejectionReasons: { "spread too wide": 3, "iv rank too low": 4 },
    bestOverall: { symbol: "AAPL", ...condorBest },
  },
  {
    strategyType: "call_debit_spread",
    symbolsEvaluated: 1,
    symbolsPassed: 0,
    evaluatedCount: 6,
    passedCount: 0,
    rejectedCount: 6,
    rejectionReasons: { "max loss exceeds limit": 4, "spread too wide": 2 },
    bestOverall: null,
  },
  {
    strategyType: "put_credit_spread",
    symbolsEvaluated: 1,
    symbolsPassed: 0,
    evaluatedCount: 3,
    passedCount: 0,
    rejectedCount: 3,
    rejectionReasons: { "reward/risk below minimum": 2, "iv rank too low": 1 },
    bestOverall: null,
  },
];

const boardEnvelope = {
  ...perNameEnvelope,
  matrix: boardRows,
  typeRollup: boardRollup,
} as any;

async function renderResults(
  result: OpportunityScanResponse,
  runContext: { mode: "per_name_best" | "strategy_fit"; profileLabel: string | null; thesis?: "bullish" | "bearish" },
  onPreviewTrade?: (ctx: TradeOrderContext) => void,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ScanResultsView, { result, runContext, onPreviewTrade }));
  });
  await flush(30);
}

// Slice 2 pure helpers ---------------------------------------------------------

describe("slice 2 helpers — matrixStrategyTypes / topRejectionReason", () => {
  it("column order is the union of types in first-appearance order across rows", () => {
    expect(matrixStrategyTypes(boardRows)).toEqual(["iron_condor", "call_debit_spread", "put_credit_spread"]);
    expect(matrixStrategyTypes([])).toEqual([]);
  });

  it("topRejectionReason picks the highest count and is null when nothing was rejected", () => {
    expect(topRejectionReason({ "spread too wide": 2, "max loss exceeds limit": 4 }))
      .toEqual({ reason: "max loss exceeds limit", count: 4 });
    expect(topRejectionReason({})).toBeNull();
    expect(topRejectionReason(undefined)).toBeNull();
  });
});

describe("slice 2 helper — matrixCellTradeContext (research-panel mapping, replicated)", () => {
  const row = boardRows[0];
  const cell = boardRows[0].cells[0];

  it("maps the cell best to the same context shape toTradeContext produces", () => {
    const ctx = matrixCellTradeContext(row, cell, "bullish");
    expect(ctx.symbol).toBe("AAPL");
    expect(ctx.assetClass).toBe("options");
    expect(ctx.action).toBe("BUY");
    expect(ctx.quantity).toBe(1);
    expect(ctx.strategyNetDebit).toBe(-2.1);
    expect(ctx.underlyingPrice).toBeUndefined();
    expect(ctx.label).toBe("Iron Condor (2026-11-20), max loss $290");
    expect(ctx.legs).toEqual([
      "SELL 1 AAPL261120P00230000 @ $1.85",
      "BUY 1 AAPL261120P00225000 @ $1.20",
      "SELL 1 AAPL261120C00270000 @ $1.60",
      "BUY 1 AAPL261120C00275000 @ $1.05",
    ]);
    expect(ctx.optionLegs).toHaveLength(4);
    expect(ctx.optionLegs?.[0]).toEqual({
      securityType: "OPTN", side: "SELL", quantity: 1,
      optionType: "PUT", strike: 230, expirationDate: "2026-11-20",
    });
  });

  it("a bearish run thesis flips the action to SELL_SHORT, exactly like the research panel", () => {
    expect(matrixCellTradeContext(row, cell, "bearish").action).toBe("SELL_SHORT");
    expect(matrixCellTradeContext(row, cell, undefined).action).toBe("BUY");
  });

  it("a stock leg maps to an EQ leg and an equity asset class", () => {
    const stockCell = {
      strategyType: "long_stock",
      best: {
        ...condorBest,
        label: "Long Stock",
        legs: [makeLeg({ symbol: "AAPL", optionType: "STOCK", side: "BUY", strike: 0, entryPrice: 250 })],
      },
      evaluatedCount: 1, passedCount: 1, rejectedCount: 0, rejectionReasons: {},
    };
    const ctx = matrixCellTradeContext(row, stockCell, "bullish");
    expect(ctx.assetClass).toBe("equity");
    expect(ctx.optionLegs?.[0].securityType).toBe("EQ");
    expect(ctx.optionLegs?.[0].optionType).toBeUndefined();
    expect(ctx.optionLegs?.[0].strike).toBeUndefined();
  });
});

// Slice 2 board + roll-up rendering ---------------------------------------------

describe("slice 2 — fit matrix board (issue #22 surface)", () => {
  it("renders rows, verdict chips, the gate badge, targets, and the screen-pass legend", async () => {
    await renderResults(boardEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const board = container.querySelector("#scanner-matrix-board");
    expect(board).not.toBeNull();
    expect(board!.textContent).toContain("Fit matrix");
    expect(board!.textContent).toContain("Pass = screen pass only");
    expect(board!.textContent).toContain("Qualification is the fit gate's job");

    const headers = [...board!.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers).toEqual(["Symbol", "iron_condor", "call_debit_spread", "put_credit_spread"]);

    const text = board!.textContent ?? "";
    expect(text).toContain("AAPL");
    expect(text).toContain("MSFT");
    expect(text).toContain("ZZZ");
    expect(text).toContain("PASS");
    expect(text).toContain("NO PASS");
    expect(text).toContain("SKIPPED");
    expect(text).toContain("fit"); // AAPL gate badge
    expect(text).toContain("no_fit"); // MSFT gate badge
    expect(text).toContain("$262.50 · +0.60 EM"); // target price + EM units (fmtTarget format)
    expect(text).toContain("thesis-derived target"); // the source is a chip since slice 3, not a parenthetical
    expect(text).toContain("no screen-passing pick"); // MSFT gate reasons
    expect(text).toContain("Skipped — no chain data"); // skipped row carries its reason, not cells
  });

  it("cells show counts + best score, the top rejection reason, and an em dash for absent types", async () => {
    await renderResults(boardEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const board = container.querySelector("#scanner-matrix-board")!;
    const rows = [...board.querySelectorAll("tbody tr")];
    const aaplCells = [...rows[0].querySelectorAll("td")];
    // [symbol, iron_condor, call_debit_spread, put_credit_spread]
    expect(aaplCells[1].textContent).toContain("66.4");
    expect(aaplCells[1].textContent).toContain("2/5 passed");
    expect(aaplCells[1].textContent).toContain("Iron Condor");
    expect(aaplCells[2].textContent).toContain("0/6 passed · 6 rejected");
    expect(aaplCells[2].textContent).toContain("max loss exceeds limit");
    expect(aaplCells[2].querySelector(".scp-cell-reason")?.getAttribute("title")).toBe("max loss exceeds limit");
    expect(aaplCells[3].textContent?.trim()).toBe("—"); // AAPL has no put_credit_spread cell

    const msftCells = [...rows[1].querySelectorAll("td")];
    expect(msftCells[1].textContent).toContain("0/4 passed · 4 rejected");
    expect(msftCells[1].textContent).toContain("iv rank too low");
    expect(msftCells[3].textContent).toContain("reward/risk below minimum");
  });

  it("renders nothing when the scan carried no matrix", async () => {
    await renderResults(perNameEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    expect(container.querySelector("#scanner-matrix-board")).toBeNull();
  });
});

describe("slice 2 — strategy-type roll-up cards (issue #26 surface)", () => {
  it("renders per-type screen counts and the cross-universe best pick, labelled as the risk screen", async () => {
    await renderResults(boardEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const text = container.textContent ?? "";
    expect(text).toContain("By strategy type");
    expect(text).toContain("Risk-screen roll-up");
    expect(text).toContain("not a fit-gate qualification");

    const cards = [...container.querySelectorAll(".scp-rollup-card")];
    expect(cards).toHaveLength(3);
    const condor = cards.find((c) => c.textContent?.includes("iron_condor"))!;
    expect(condor.textContent).toContain("1 of 2 symbols passed the screen");
    expect(condor.textContent).toContain("2 passed · 7 rejected of 9 candidates");
    expect(condor.textContent).toContain("AAPL");
    expect(condor.textContent).toContain("Iron Condor");
    expect(condor.textContent).toContain("66.4");
    expect(condor.textContent).toContain("61.0%"); // POP of the best pick
    const debit = cards.find((c) => c.textContent?.includes("call_debit_spread"))!;
    expect(debit.textContent).toContain("0 of 1 symbols passed the screen");
    expect(debit.textContent).toContain("No passing candidate");
  });

  it("never presents screen passes as accepted trades", async () => {
    await renderResults(boardEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\baccepted\b/i);
    expect(text).not.toMatch(/qualified trade/i);
  });

  it("renders nothing when the roll-up is empty", async () => {
    await renderResults(perNameEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    expect(container.querySelector(".scp-rollup")).toBeNull();
    expect(container.textContent).not.toContain("By strategy type");
  });
});

// Slice 2 handoff -----------------------------------------------------------------

describe("slice 2 — cell → HITL preview handoff", () => {
  it("clicking a best cell calls onPreviewTrade once with the cell's context; no-best cells are not buttons", async () => {
    const spy = vi.fn();
    await renderResults(
      boardEnvelope as OpportunityScanResponse,
      { mode: "per_name_best", profileLabel: null, thesis: "bullish" },
      spy,
    );
    const board = container.querySelector("#scanner-matrix-board")!;
    const buttons = [...board.querySelectorAll("button")];
    expect(buttons).toHaveLength(1); // exactly one cell in the fixture has a best
    expect(buttons[0].textContent).toContain("66.4");

    await click(buttons[0]);
    expect(spy).toHaveBeenCalledTimes(1);
    const ctx = spy.mock.calls[0][0] as TradeOrderContext;
    expect(ctx.symbol).toBe("AAPL");
    expect(ctx.strategyNetDebit).toBe(-2.1);
    expect(ctx.quantity).toBe(1);
    expect(ctx.action).toBe("BUY");
    expect(ctx.legs).toHaveLength(4);
    expect(ctx.legs[0]).toBe("SELL 1 AAPL261120P00230000 @ $1.85");
    expect(ctx.optionLegs?.[2]).toEqual({
      securityType: "OPTN", side: "SELL", quantity: 1,
      optionType: "CALL", strike: 270, expirationDate: "2026-11-20",
    });
  });

  it("without onPreviewTrade the board renders no buttons but still shows the best score", async () => {
    await renderResults(boardEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const board = container.querySelector("#scanner-matrix-board")!;
    expect(board.querySelectorAll("button")).toHaveLength(0);
    expect(board.textContent).toContain("66.4");
  });
});

describe("slice 2 — board appears in a full panel run", () => {
  it("a scan whose payload carries matrix + rollup renders the roll-up cards and the board", async () => {
    installFetch(freshState({ unifiedEnvelope: boardEnvelope }));
    await renderPanel();
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Fit matrix");
    expect(container.textContent).toContain("By strategy type");
    expect(container.textContent).toContain("1 of 2 symbols passed the screen");
    expect(container.querySelector("#scanner-matrix-board")).not.toBeNull();
    expect(container.textContent).toContain("Skipped — no chain data");
  });
});

// Slice 3 fixtures — typed matrix rows carrying every target source ---------

const trustRows: ScanMatrixRow[] = [
  { symbol: "STATEDCO", verdict: "pass", targetPrice: 300, targetSource: "stated", targetEmUnits: 1.2, gateBucket: "fit", gateReasons: [], cells: [] },
  { symbol: "PCTCO", verdict: "pass", targetPrice: 110, targetSource: "percent", targetEmUnits: 0.4, gateBucket: "fit", gateReasons: [], cells: [] },
  { symbol: "THESISCO", verdict: "pass", targetPrice: 262.5, targetSource: "thesis", targetEmUnits: 0.6, gateBucket: "fit", gateReasons: [], cells: [] },
  { symbol: "EMCO", verdict: "pass", targetPrice: 275, targetSource: "em", targetEmUnits: 1.0, gateBucket: "borderline", gateReasons: [], cells: [] },
  { symbol: "ZZZ", verdict: "skipped", skipReason: "no chain data", targetPrice: null, targetSource: null, targetEmUnits: null, gateBucket: null, gateReasons: [], cells: [] },
];

const trustEnvelope = {
  ...perNameEnvelope,
  matrix: trustRows,
  typeRollup: [],
} as any;

// Slice 3 trust layer -----------------------------------------------------------

describe("slice 3 — TargetSourceChip (target provenance, issues #19/#23/#25)", () => {
  it("renders the plain-language label for each of the four sources, as a chip element", async () => {
    const { renderToString } = await import("react-dom/server");
    const render = (source: ScanTargetSource) =>
      renderToString(React.createElement(TargetSourceChip, { source })).replace(/<!-- -->/g, "");
    expect(render("stated")).toContain("stated target");
    expect(render("percent")).toContain("stated % target");
    expect(render("thesis")).toContain("thesis-derived target");
    expect(render("em")).toContain("expected-move target");
    expect(render("stated")).toContain("scp-chip-target"); // a chip, not bare text
    expect(TARGET_SOURCE_LABELS).toEqual({
      stated: "stated target",
      percent: "stated % target",
      thesis: "thesis-derived target",
      em: "expected-move target",
    });
  });

  it("renders no chip when the source is null or absent — provenance is never guessed", async () => {
    const { renderToString } = await import("react-dom/server");
    expect(renderToString(React.createElement(TargetSourceChip, { source: null }))).toBe("");
    expect(renderToString(React.createElement(TargetSourceChip, { source: undefined }))).toBe("");
  });

  it("every board row with a target carries its source chip; the skipped row carries neither target nor chip", async () => {
    await renderResults(trustEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const board = container.querySelector("#scanner-matrix-board")!;
    const rows = [...board.querySelectorAll("tbody tr")];
    const bySymbol = new Map(rows.map((tr) => [tr.querySelector("strong")?.textContent, tr]));
    expect(bySymbol.get("STATEDCO")!.querySelector(".scp-chip-target")?.textContent).toBe("stated target");
    expect(bySymbol.get("PCTCO")!.querySelector(".scp-chip-target")?.textContent).toBe("stated % target");
    expect(bySymbol.get("THESISCO")!.querySelector(".scp-chip-target")?.textContent).toBe("thesis-derived target");
    expect(bySymbol.get("EMCO")!.querySelector(".scp-chip-target")?.textContent).toBe("expected-move target");
    const skipped = bySymbol.get("ZZZ")!;
    expect(skipped.querySelector(".scp-chip-target")).toBeNull();
    expect(skipped.textContent).not.toContain("Target");
  });

  it("the per-name results table renders the chip next to the target price", async () => {
    await renderResults(perNameEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const chip = container.querySelector(".scp-results .scp-chip-target");
    expect(chip?.textContent).toBe("thesis-derived target");
  });

  it("the fits table renders the chip next to the target price", async () => {
    await renderResults(fitEnvelope as OpportunityScanResponse, { mode: "strategy_fit", profileLabel: null });
    const chip = container.querySelector(".scp-results .scp-chip-target");
    expect(chip?.textContent).toBe("thesis-derived target");
  });
});

describe("slice 3 — data as-of + scan model version (issue #27 provenance)", () => {
  it("labels the header timestamp 'Data as of' and shows the scan model version the result carries", async () => {
    await renderResults(perNameEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const head = container.querySelector(".scp-results-head")!;
    const expectedTime = new Date(perNameEnvelope.generatedAt).toLocaleString();
    expect(head.textContent).toContain(`Data as of ${expectedTime}`);
    expect(head.textContent).toContain("scan model v1.1.2");
    expect(head.textContent).not.toContain("generated"); // the bare pre-slice-3 phrasing is gone
  });

  it("omits the model-version element when the payload carries none, keeping the as-of label", async () => {
    const noVersion = { ...perNameEnvelope, modelVersion: undefined } as any;
    await renderResults(noVersion as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const head = container.querySelector(".scp-results-head")!;
    expect(head.textContent).not.toContain("scan model v");
    expect(head.textContent).toContain("Data as of");
  });
});

describe("slice 3 — normalized-score labelling (issue #25)", () => {
  it("the per-name table heads the column 'Composite score' and the legend states cross-name comparability", async () => {
    await renderResults(perNameEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const headers = [...container.querySelectorAll(".scp-results table th")].map((th) => th.textContent);
    expect(headers).toContain("Composite score");
    expect(headers).not.toContain("Score");
    expect(container.textContent).toContain("Composite scores are normalized 0–100 and comparable across names");
    expect(container.textContent).toContain("expected-move (EM) units where the target is EM-based");
  });

  it("the fits table uses the same 'Composite score' header", async () => {
    await renderResults(fitEnvelope as OpportunityScanResponse, { mode: "strategy_fit", profileLabel: null });
    const headers = [...container.querySelectorAll(".scp-results table th")].map((th) => th.textContent);
    expect(headers).toContain("Composite score");
    expect(headers).not.toContain("Score");
  });

  it("roll-up cards label the best pick 'composite' and matrix cells carry a composite caption", async () => {
    await renderResults(boardEnvelope as OpportunityScanResponse, { mode: "per_name_best", profileLabel: null });
    const condor = [...container.querySelectorAll(".scp-rollup-card")].find((c) => c.textContent?.includes("iron_condor"))!;
    expect(condor.textContent).toContain("composite 66.4");
    expect(condor.textContent).not.toContain("· score");
    const caption = container.querySelector("#scanner-matrix-board .scp-cell-caption");
    expect(caption?.textContent).toBe("composite");
  });
});

describe("slice 3 — borderline bucket chips", () => {
  it("fit mode renders each borderline symbol as a borderline-bucket chip under the same prefix", async () => {
    await renderResults(fitEnvelope as OpportunityScanResponse, { mode: "strategy_fit", profileLabel: null });
    const notes = [...container.querySelectorAll(".scp-borderline")];
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain("Borderline (evaluated, below the gate): NVDA");
    const chips = [...notes[0].querySelectorAll(".scp-badge-borderline")].map((c) => c.textContent);
    expect(chips).toEqual(["NVDA"]);
  });
});

// Slice 5 fixtures — typed against the REAL store/result types --------------
// NOTE: since issue #103 ScanRunSummary (the list projection) DOES
// carry profileRef — the same stamp as the full result
// (result.profileRef) — so history rows label the profile straight
// from the summary. These literals pin that shape: a summary missing
// the field would not compile.

function historyRow(symbol: string, gateBucket: "fit" | "borderline" | "no_fit"): ScanMatrixRow {
  return {
    symbol,
    verdict: "pass",
    targetPrice: 300,
    targetSource: "thesis",
    targetEmUnits: 0.5,
    gateBucket,
    gateReasons: [],
    cells: [
      {
        strategyType: "iron_condor",
        best: {
          candidateId: `${symbol.toLowerCase()}-ic`, label: "Iron Condor", compositeScore: 66.4, score: 60,
          expirationDate: "2026-11-20", legs: [], netDebit: -2.1, maxLoss: 290,
          maxProfit: 210, maxProfitUnbounded: false, targetRewardRisk: 0.72,
          probabilityOfProfit: 0.61,
        },
        evaluatedCount: 5, passedCount: 2, rejectedCount: 3, rejectionReasons: {},
      },
    ],
  };
}

const historyGateParams = { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" as const };
const historyConfigSnapshot = {
  maxScanSymbols: 25,
  targetFactors: { bullish: 1.1, bearish: 0.9, range_bound: 1, large_move: 1.15 },
  targetEmMultiples: { bullish: 0.6, bearish: -0.6, range_bound: 0, large_move: 1.2 },
};

const olderAapl = historyRow("AAPL", "fit");
const olderMsft = historyRow("MSFT", "borderline");
const olderOldco = historyRow("OLDCO", "fit");

const olderResult: OpportunityScanResult = {
  scanned: 3,
  withTrades: 2,
  opportunities: [],
  skipped: [],
  truncatedSymbols: 0,
  assumptions: [],
  matrix: [olderAapl, olderMsft, olderOldco],
  typeRollup: [],
  mode: "strategy_fit",
  fits: [olderAapl, olderOldco],
  fitsTotal: 2,
  gate: { fit: 2, borderline: 1, noFit: 0 },
  borderline: [olderMsft],
  gateParams: historyGateParams,
  profileRef: { id: "prof-1", name: "Income", version: 2 },
  generatedAt: "2026-10-15T14:00:00.000Z",
  modelVersion: "1.1.2",
  requestSnapshot: {
    template: {
      thesis: "bullish",
      targetDate: "2026-11-20",
      minDte: 20,
      maxDte: 45,
      maxPlannedLoss: 750,
      minRewardRisk: 1.5,
      allowedStrategies: ["all"],
      statedTarget: { price: 500, symbol: "SPY" },
      perSymbol: { MSFT: { target: { kind: "percent", pct: 5 } } },
    },
    mode: "strategy_fit",
    riskProfile: "balanced",
    profile: incomeProfile,
  },
  configSnapshot: historyConfigSnapshot,
  coverage: { considered: 3, scanned: 3, truncated: 0, evaluated: 3, errors: 0, withTrades: 2 },
};

const newerAapl = historyRow("AAPL", "fit");
const newerMsft = historyRow("MSFT", "fit");

const newerResult: OpportunityScanResult = {
  scanned: 2,
  withTrades: 2,
  opportunities: [],
  skipped: [],
  truncatedSymbols: 0,
  assumptions: [],
  matrix: [newerAapl, newerMsft],
  typeRollup: [],
  mode: "strategy_fit",
  fits: [newerAapl, newerMsft],
  fitsTotal: 2,
  gate: { fit: 2, borderline: 0, noFit: 0 },
  borderline: [],
  gateParams: historyGateParams,
  profileRef: { id: "prof-1", name: "Income", version: 2 },
  generatedAt: "2026-10-16T14:00:00.000Z",
  modelVersion: "1.1.2",
  requestSnapshot: {
    template: {
      thesis: "bullish",
      targetDate: "2026-11-20",
      maxPlannedLoss: 750,
      minRewardRisk: 1.5,
      allowedStrategies: ["all"],
    },
    mode: "strategy_fit",
    riskProfile: "balanced",
    profile: incomeProfile,
  },
  configSnapshot: historyConfigSnapshot,
  coverage: { considered: 2, scanned: 2, truncated: 0, evaluated: 2, errors: 0, withTrades: 2 },
};

const olderRun: StoredScanRun = {
  id: "3f9c1e2a-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  generatedAt: olderResult.generatedAt,
  profileRef: olderResult.profileRef,
  mode: olderResult.mode,
  modelVersion: olderResult.modelVersion,
  gate: olderResult.gate,
  coverage: olderResult.coverage,
  result: olderResult,
};

const newerRun: StoredScanRun = {
  id: "7b2d4f6a-1c3e-4a5b-9d8e-2f4a6b8c0d1e",
  generatedAt: newerResult.generatedAt,
  profileRef: newerResult.profileRef,
  mode: newerResult.mode,
  modelVersion: newerResult.modelVersion,
  gate: newerResult.gate,
  coverage: newerResult.coverage,
  result: newerResult,
};

/** A run whose stored result is missing its array fields — the shape
 *  guard in getScanRun must fill them before anything renders it. */
const sparseRun = {
  id: "sparse-run",
  generatedAt: "2026-10-14T14:00:00.000Z",
  mode: "per_name_best",
  modelVersion: "1.1.2",
  gate: { fit: 0, borderline: 0, noFit: 0 },
  coverage: { considered: 1, scanned: 1, truncated: 0, evaluated: 0, errors: 1, withTrades: 0 },
  result: { mode: "per_name_best", generatedAt: "2026-10-14T14:00:00.000Z", modelVersion: "1.1.2" },
} as unknown as StoredScanRun;

/** A run recorded since issue #103: its snapshot carries the original
 *  request (requestSnapshot.request). Note the request's fields
 *  deliberately DIFFER from the snapshot template's merged values
 *  (template statedTarget is SPY $500, minDte 20 — the record says
 *  NVDA $300, minDte 10): the record is what the caller asked, and a
 *  re-run must replay the record, not the merged template. */
const recordedRun: StoredScanRun = {
  ...olderRun,
  id: "9c8b7a6f-5e4d-3c2b-1a09-8f7e6d5c4b3a",
  generatedAt: "2026-10-17T09:30:00.000Z",
  result: {
    ...olderResult,
    generatedAt: "2026-10-17T09:30:00.000Z",
    requestSnapshot: {
      ...olderResult.requestSnapshot,
      request: {
        symbols: ["NVDA", "PLTR"],
        thesis: "bullish",
        targetDate: "2026-11-20",
        statedTarget: { price: 300, symbol: "NVDA" },
        minDte: 10,
        maxDte: 45,
        profileId: "prof-1",
        limit: 5,
      },
    },
  },
};

const historyDiff: ScanRunDiff = {
  newFits: ["MSFT"],
  droppedFits: ["OLDCO"],
  stillFitting: ["AAPL"],
  bucketChanges: [{ symbol: "MSFT", from: "borderline", to: "fit" }],
  addedSymbols: [],
  removedSymbols: ["OLDCO"],
};

function historyState(overrides: Partial<StubState> = {}): StubState {
  return freshState({
    scanRuns: [newerRun, olderRun], // the list route is newest-first
    scanDiffs: { [`${olderRun.id}|${newerRun.id}`]: historyDiff },
    ...overrides,
  });
}

function historyRows(): HTMLElement[] {
  const section = container.querySelector(".scp-history");
  if (!section) throw new Error("history section not rendered");
  return [...section.querySelectorAll<HTMLElement>(".scp-row")];
}

// Slice 5 client ----------------------------------------------------------------

describe("slice 5 — scan history client (issue #27 read API)", () => {
  it("listScanRuns reads the { count, scans } envelope with env + user headers; summaries carry no result", async () => {
    const calls = installFetch(historyState());
    const summaries = await listScanRuns("PROD", "trader1");
    expect(summaries.map((s) => s.id)).toEqual([newerRun.id, olderRun.id]);
    expect(summaries[0]).not.toHaveProperty("result");
    expect(summaries[0].modelVersion).toBe("1.1.2");
    const get = calls.find((c) => c.url.includes("/api/etrade/options/scans"));
    expect(get?.method).toBe("GET");
    expect(get?.headers?.["x-environment"]).toBe("PROD");
    expect(get?.headers?.["x-user-login"]).toBe("trader1");
  });

  it("listScanRuns forwards an explicit limit as the route's limit param", async () => {
    const calls = installFetch(historyState());
    const summaries = await listScanRuns("TEST", "trader1", 1);
    expect(summaries).toHaveLength(1);
    const get = calls.find((c) => c.url.includes("/api/etrade/options/scans"));
    expect(get?.url).toContain("limit=1");
  });

  it("getScanRun returns the stored run with its result coerced through the scan shape guard", async () => {
    installFetch(historyState({ scanRuns: [sparseRun] }));
    const detail = await getScanRun("TEST", "trader1", "sparse-run");
    expect(detail.id).toBe("sparse-run");
    expect(detail.result.opportunities).toEqual([]);
    expect(detail.result.fits).toEqual([]);
    expect(detail.result.matrix).toEqual([]);
    expect(detail.result.modelVersion).toBe("1.1.2");
  });

  it("getScanRun surfaces the route's 404 message verbatim for a pruned run", async () => {
    installFetch(historyState());
    await expect(getScanRun("TEST", "trader1", "pruned-away")).rejects.toThrow("scan run not found");
  });

  it("getScanRunDiff calls the diff route with from/to params and returns the server diff verbatim", async () => {
    const calls = installFetch(historyState());
    const result = await getScanRunDiff("TEST", "trader1", olderRun.id, newerRun.id);
    const call = calls.find((c) => c.url.includes("/api/etrade/options/scans/diff"));
    expect(call?.url).toContain(`from=${olderRun.id}`);
    expect(call?.url).toContain(`to=${newerRun.id}`);
    expect(result.from).toEqual({ id: olderRun.id, generatedAt: olderRun.generatedAt });
    expect(result.to).toEqual({ id: newerRun.id, generatedAt: newerRun.generatedAt });
    expect(result.diff).toEqual(historyDiff);
  });

  it("getScanRunDiff surfaces the server's error when either run is gone", async () => {
    installFetch(historyState());
    await expect(getScanRunDiff("TEST", "trader1", olderRun.id, "pruned-away")).rejects.toThrow("scan run not found");
  });
});

// Slice 5 helpers -----------------------------------------------------------------

describe("slice 5 helpers — buildRerunRequest / shortenRunId", () => {
  it("replays exactly what the snapshot carries: matrix symbols, template fields, mode, profile id", () => {
    const { body } = buildRerunRequest(olderRun);
    expect(body.action).toBe("opportunities");
    expect(body.symbols).toEqual(["AAPL", "MSFT", "OLDCO"]); // the scanned batch, in matrix order
    expect(body.thesis).toBe("bullish");
    expect(body.targetDate).toBe("2026-11-20");
    expect(body.maxPlannedLoss).toBe(750);
    expect(body.minRewardRisk).toBe(1.5);
    expect(body.allowedStrategies).toEqual(["all"]);
    expect(body.perSymbol).toEqual({ MSFT: { target: { kind: "percent", pct: 5 } } });
    expect(body.mode).toBe("strategy_fit");
    expect(body.riskProfile).toBe("balanced");
    expect(body.profileId).toBe("prof-1");
  });

  it("names the snapshot fields the unified body cannot carry instead of dropping them silently", () => {
    const { dropped } = buildRerunRequest(olderRun);
    expect(dropped).toEqual(["stated target", "DTE bounds (min/max DTE)"]);
  });

  it("a snapshot without stated target or DTE bounds drops nothing", () => {
    const { body, dropped } = buildRerunRequest(newerRun);
    expect(dropped).toEqual([]);
    expect(body.symbols).toEqual(["AAPL", "MSFT"]);
    expect(body.profileId).toBe("prof-1");
  });

  it("shortenRunId truncates long ids and leaves short ones whole", () => {
    expect(shortenRunId(olderRun.id)).toBe("3f9c1e2a…");
    expect(shortenRunId("sparse-run")).toBe("sparse-run");
  });
});

// Slice 5 diff view (pure render) ---------------------------------------------------

describe("slice 5 — ScanDiffView (server diff, rendered verbatim)", () => {
  const diffData: ScanRunDiffResult = {
    from: { id: olderRun.id, generatedAt: olderRun.generatedAt },
    to: { id: newerRun.id, generatedAt: newerRun.generatedAt },
    diff: historyDiff,
  };

  it("renders new fits, dropped fits, still fitting, bucket changes, and removed symbols", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(React.createElement(ScanDiffView, { data: diffData })).replace(/<!-- -->/g, "");
    expect(html).toContain("Scan diff");
    expect(html).toContain(new Date(olderRun.generatedAt).toLocaleString());
    expect(html).toContain(new Date(newerRun.generatedAt).toLocaleString());
    expect(html).toContain("New fits:");
    expect(html).toContain("Dropped fits:");
    expect(html).toContain("Still fitting (1):");
    expect(html).toContain("Bucket changes:");
    expect(html).toContain("MSFT");
    expect(html).toContain("OLDCO");
    expect(html).toContain("AAPL");
    expect(html).toContain("Removed symbols:");
    expect(html).toContain("scp-badge-borderline"); // the from-bucket badge
    expect(html).toContain("scp-badge-fit"); // fit chips + the to-bucket badge
    expect(html).not.toContain("No changes between these runs.");
  });

  it("an all-empty diff renders the explicit no-changes state", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(
      React.createElement(ScanDiffView, { data: { ...diffData, diff: EMPTY_SCAN_DIFF } }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("No changes between these runs.");
    expect(html).not.toContain("New fits:");
  });

  it("identical fits with no changes still state 'no changes' and list who is still fitting", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(
      React.createElement(ScanDiffView, { data: { ...diffData, diff: { ...EMPTY_SCAN_DIFF, stillFitting: ["AAPL"] } } }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("No changes between these runs.");
    expect(html).toContain("Still fitting (1):");
  });
});

// Slice 5 history UI ------------------------------------------------------------------

describe("slice 5 — scan history (surface 5)", () => {
  it("lists saved runs with their provenance: time, mode label, model, coverage, gate, run id", async () => {
    installFetch(historyState());
    await renderPanel();
    await waitForText("Diff vs previous");

    const rows = historyRows();
    expect(rows).toHaveLength(2);
    const [newer, older] = rows;
    expect(newer.textContent).toContain(new Date(newerRun.generatedAt).toLocaleString());
    expect(newer.textContent).toContain(MODE_LABELS.strategy_fit);
    expect(newer.textContent).toContain("model v1.1.2");
    expect(newer.textContent).toContain("2 scanned · 2 evaluated");
    expect(newer.textContent).toContain("gate: 2 fit / 0 borderline / 0 no fit");
    expect(older.textContent).toContain(new Date(olderRun.generatedAt).toLocaleString());
    expect(older.textContent).toContain("3 scanned · 3 evaluated");
    expect(older.textContent).toContain("gate: 2 fit / 1 borderline / 0 no fit");
    // The full id stays on the row (title attribute); display is shortened.
    const meta = older.querySelector(".scp-row-meta");
    expect(meta?.getAttribute("title")).toBe(olderRun.id);
    expect(meta?.textContent).toContain("3f9c1e2a…");
    // Only the newer row can diff against a previous run.
    expect(buttonByText(newer, "Diff vs previous")).toBeTruthy();
    expect([...older.querySelectorAll("button")].some((b) => b.textContent?.includes("Diff vs previous"))).toBe(false);
  });

  it("renders the empty state naming that runs save automatically", async () => {
    installFetch(freshState());
    await renderPanel();
    await waitForText("No saved scan runs yet.");
    expect(container.textContent).toContain("Runs are saved automatically when a scan completes");
  });

  it("View renders the stored result under the saved-scan banner and issues no scan POST", async () => {
    const calls = installFetch(historyState());
    await renderPanel();
    await waitForText("Diff vs previous");

    await click(buttonByText(historyRows()[0], "View"));
    await waitForText("viewing the stored result, not a new run");
    expect(container.textContent).toContain(
      `Saved scan from ${new Date(newerRun.generatedAt).toLocaleString()} — viewing the stored result, not a new run.`,
    );
    // The stored result renders through the normal results view.
    expect(container.textContent).toContain("Iron Condor");
    expect(container.textContent).toContain("Profile: Income v2");
    // Viewing is read-only: no unified scan request was issued.
    expect(calls.some((c) => c.url.endsWith("/api/trading/options/unified"))).toBe(false);

    // A fresh run replaces the view — the banner must not linger.
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Bull Call Spread");
    expect(container.textContent).not.toContain("viewing the stored result");
  });

  it("Re-run replays the saved request through the unified path and names what was not replayed", async () => {
    const calls = installFetch(historyState());
    await renderPanel();
    await waitForText("Diff vs previous");

    await click(buttonByText(historyRows()[1], "Re-run"));
    await waitForText("Re-ran the scan from");
    expect(container.textContent).toContain(`Re-ran the scan from ${new Date(olderRun.generatedAt).toLocaleString()}.`);
    expect(container.textContent).toContain("Not replayed");
    expect(container.textContent).toContain("stated target");
    expect(container.textContent).not.toContain("viewing the stored result");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body.symbols).toEqual(["AAPL", "MSFT", "OLDCO"]);
    expect(post?.body.thesis).toBe("bullish");
    expect(post?.body.targetDate).toBe("2026-11-20");
    expect(post?.body.maxPlannedLoss).toBe(750);
    expect(post?.body.minRewardRisk).toBe(1.5);
    expect(post?.body.allowedStrategies).toEqual(["all"]);
    expect(post?.body.perSymbol).toEqual({ MSFT: { target: { kind: "percent", pct: 5 } } });
    expect(post?.body.mode).toBe("strategy_fit");
    expect(post?.body.riskProfile).toBe("balanced");
    expect(post?.body.profileId).toBe("prof-1");
  });

  it("Diff vs previous renders the server diff in place of the results", async () => {
    const calls = installFetch(historyState());
    await renderPanel();
    await waitForText("Diff vs previous");

    await click(buttonByText(historyRows()[0], "Diff vs previous"));
    await waitForText("Scan diff");
    const diff = container.querySelector(".scp-diff");
    expect(diff).not.toBeNull();
    expect(diff!.textContent).toContain("New fits:");
    expect(diff!.textContent).toContain("MSFT");
    expect(diff!.textContent).toContain("Dropped fits:");
    expect(diff!.textContent).toContain("OLDCO");
    expect(diff!.textContent).toContain("Still fitting (1):");
    expect(diff!.textContent).toContain("Bucket changes:");
    const call = calls.find((c) => c.url.includes("/api/etrade/options/scans/diff"));
    expect(call?.url).toContain(`from=${olderRun.id}`);
    expect(call?.url).toContain(`to=${newerRun.id}`);
  });

  it("an all-empty diff renders the explicit no-changes state", async () => {
    installFetch(historyState({ scanDiffs: {} }));
    await renderPanel();
    await waitForText("Diff vs previous");

    await click(buttonByText(historyRows()[0], "Diff vs previous"));
    await waitForText("No changes between these runs.");
  });

  it("compare picks diff any two runs (older becomes the diff's from)", async () => {
    const calls = installFetch(historyState());
    await renderPanel();
    await waitForText("Diff vs previous");

    // Pick the OLDER run first on purpose: ordering is by timestamp.
    // (#2177: the Compare row is a Checkbox label now, not .scp-compare.)
    for (const row of [historyRows()[1], historyRows()[0]]) {
      const box = row.querySelector<HTMLInputElement>(".ui-checkbox-label input")!;
      await click(box);
    }
    await waitForText("Comparing 2 of 2 runs picked.");
    await click(buttonByText(container, "Show diff"));
    await waitForText("Scan diff");
    expect(container.querySelector(".scp-diff")!.textContent).toContain("New fits:");
    const call = calls.find((c) => c.url.includes("/api/etrade/options/scans/diff"));
    expect(call?.url).toContain(`from=${olderRun.id}`);
    expect(call?.url).toContain(`to=${newerRun.id}`);
  });

  it("a diff against a run pruned since the list loaded surfaces the server's message", async () => {
    const state = historyState();
    installFetch(state);
    await renderPanel();
    await waitForText("Diff vs previous");

    state.scanRuns = [newerRun]; // the older run is pruned server-side
    await click(buttonByText(historyRows()[0], "Diff vs previous"));
    await waitForText("scan run not found");
    expect(container.querySelector(".scp-error")?.textContent).toContain("scan run not found");
  });
});

// Issue #103 — history profile chip + recorded-request replay ---------------

describe("issue #103 — history rows label the profile; recorded runs replay verbatim", () => {
  it("history rows render the profile chip from the summary's profileRef", async () => {
    installFetch(historyState());
    await renderPanel();
    await waitForText("Diff vs previous");

    const rows = historyRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toContain("Profile: Income v2");
      expect(row.querySelector(".scp-badge-profile")?.textContent).toBe("Profile: Income v2");
    }
  });

  it("buildRerunRequest prefers the recorded request: exact body, nothing dropped", () => {
    const { body, dropped } = buildRerunRequest(recordedRun);
    expect(dropped).toEqual([]);
    expect(body).toEqual({
      action: "opportunities",
      symbols: ["NVDA", "PLTR"],
      thesis: "bullish",
      targetDate: "2026-11-20",
      statedTarget: { price: 300, symbol: "NVDA" },
      minDte: 10,
      maxDte: 45,
      profileId: "prof-1",
      limit: 5,
    });
  });

  it("Re-run of a recorded run posts exactly the recorded fields and shows no dropped-fields note", async () => {
    const calls = installFetch(historyState({ scanRuns: [recordedRun] }));
    await renderPanel();
    await waitForText("Profile: Income v2"); // the history row's chip — the list has loaded
    const row = historyRows()[0];
    expect(row.textContent).toContain(new Date(recordedRun.generatedAt).toLocaleString());

    await click(buttonByText(row, "Re-run"));
    await waitForText("Re-ran the scan from");
    expect(container.textContent).toContain(`Re-ran the scan from ${new Date(recordedRun.generatedAt).toLocaleString()}.`);
    expect(container.textContent).not.toContain("Not replayed");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body).toEqual({
      action: "opportunities",
      symbols: ["NVDA", "PLTR"],
      thesis: "bullish",
      targetDate: "2026-11-20",
      statedTarget: { price: 300, symbol: "NVDA" },
      minDte: 10,
      maxDte: 45,
      profileId: "prof-1",
      limit: 5,
      pushToSlack: true,
    });
  });
});
