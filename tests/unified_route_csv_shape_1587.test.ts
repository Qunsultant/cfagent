/**
 * Issue #1587: unified-route CSV built from opportunities-shaped data.
 *
 * `executeUnifiedOptions` (src/agents/routes/etradeOptionsScreen.ts) under
 * the `action === "opportunities"` gate passes `result.data` — an
 * OpportunityScanResult from UnifiedOptionsService.execute — straight into
 * `agent.generateAndStoreOptionsCsv`, but the generator
 * (`generateOptionsCsv`) reads `result.contracts`, which an
 * OpportunityScanResult does not carry. Pre-fix, unified CSVs are
 * headers-only on good runs — the CSV twin of the #1570 XLSX defect.
 *
 * This test was written FIRST (TDD red): it drives an
 * opportunities-shaped input through the live route with a stub screener
 * agent that runs the REAL CSV generator on the captured input, and
 * asserts data rows. Pre-fix it fails (headers only); post-fix it passes
 * (2 rows, AAPL first).
 *
 * Scope pins in this file:
 * - :423 seam: opportunities-shaped input yields a populated CSV.
 * - :409 XLSX seam still adapted (regression pin, fixed by #1570).
 * - :148 manual route unchanged: a contracts-carrying result passes
 *   through the adapter by reference.
 * - Scheduled path unchanged: verified by the change set (no scheduled
 *   files touched), not by a unit test here.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as XLSX from "@e965/xlsx";
import { executeUnifiedOptions } from "../src/agents/routes/etradeOptionsScreen";

// Issue #3186 step 3e - the opportunities action no longer calls
// service.execute(); it runs the one scanner pipeline. This seam
// test pins the downstream CSV adaptation, not the engine, so the
// pipeline composer is stubbed to a completed outcome and the
// storage stub serves the fixture scan as the shapeReport artifact.
// The real pipeline-through-handler path is pinned in
// tests/unified_options_pipeline_3186.test.ts.
const mockRunWorkflow = vi.hoisted(() =>
  vi.fn(async () => ({ outcome: "completed", runId: "mock-run", stages: [], published: [] })),
);
vi.mock("../src/workflows/optionsScreenWorkflow", async (importOriginal) => ({
  ...(await importOriginal()),
  runOptionsScreenWorkflow: mockRunWorkflow,
}));
import { UnifiedOptionsService } from "../src/trading";
import {
  adaptOpportunityScanToOptionScreenResult,
  generateOptionsXlsx,
  parseOptionsXlsx,
} from "../src/trading/optionsReportXlsx";
import type { OpportunityScanResult } from "../src/trading/options/opportunityScanner";
import { generateOptionsCsv, parseScreenerCsv } from "../src/trading/screenerReportCsv";

function leg(over: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL  261024C00250000",
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike: 250,
    expirationDate: "2026-11-13",
    daysToExpiration: 21,
    entryPrice: 3.2,
    bid: 3.1,
    ask: 3.3,
    impliedVolatility: 0.284,
    delta: 0.42,
    gamma: 0.03,
    theta: -0.05,
    vega: 0.12,
    openInterest: 21000,
    volume: 5400,
    spreadPct: 2.1,
    quoteTimestamp: "2026-10-24T09:05:00Z",
    quoteFreshness: "FRESH",
    multiplier: 100,
    ...over,
  };
}

function unifiedScan(): OpportunityScanResult {
  return {
    scanned: 4,
    withTrades: 2,
    opportunities: [
      {
        symbol: "AAPL",
        underlyingPrice: 248.1,
        targetPrice: 260,
        targetSource: "model",
        targetEmUnits: 0.6,
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "HIGH",
          best: {
            candidate: {
              id: "bull-call-spread",
              rank: 1,
              type: "BULL_CALL_SPREAD",
              label: "Bull Call Spread",
              symbol: "AAPL",
              underlyingPrice: 248.1,
              expirationDate: "2026-11-13",
              dataFreshness: "FRESH",
              legs: [leg()],
              netDebit: 3.2,
              estimatedFees: 1.3,
              maxProfit: 680,
              maxProfitUnbounded: false,
              maxLoss: 320,
              breakevens: [253.2],
              targetPnl: 680,
              targetRewardRisk: 2.1,
              modelImpliedProbabilityOfProfit: 0.55,
              netGreeks: { delta: 0.42, gamma: 0.03, theta: -0.05, vega: 0.12 },
              liquidityScore: 90,
              score: 87,
              scoreBreakdown: {},
              payoffCurve: [],
              scenarios: [],
              explanations: [],
              warnings: [],
              assumptions: [],
            },
            rank: 1,
            compositeScore: 87,
            components: {},
          },
          alternatives: [],
          rationale: [],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 87,
        gateBucket: "fit",
        gateReasons: [],
      },
      {
        symbol: "MSFT",
        underlyingPrice: 510.4,
        targetPrice: 530,
        targetSource: "model",
        targetEmUnits: 0.5,
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "MEDIUM",
          best: {
            candidate: {
              id: "bull-put-spread",
              rank: 1,
              type: "BULL_PUT_SPREAD",
              label: "Bull Put Spread",
              symbol: "MSFT",
              underlyingPrice: 510.4,
              expirationDate: "2026-11-13",
              dataFreshness: "FRESH",
              legs: [
                leg({
                  symbol: "MSFT  261024P00500000",
                  optionType: "PUT",
                  strike: 500,
                  bid: 2.1,
                  ask: 2.3,
                  entryPrice: 2.2,
                  impliedVolatility: 0.24,
                  delta: -0.3,
                }),
              ],
              netDebit: 2.2,
              estimatedFees: 1.3,
              maxProfit: 780,
              maxProfitUnbounded: false,
              maxLoss: 220,
              breakevens: [497.8],
              targetPnl: 780,
              targetRewardRisk: 3.5,
              modelImpliedProbabilityOfProfit: 0.6,
              netGreeks: { delta: -0.3, gamma: 0.02, theta: -0.04, vega: 0.1 },
              liquidityScore: 88,
              score: 82,
              scoreBreakdown: {},
              payoffCurve: [],
              scenarios: [],
              explanations: [],
              warnings: [],
              assumptions: [],
            },
            rank: 1,
            compositeScore: 82,
            components: {},
          },
          alternatives: [],
          rationale: [],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 82,
        gateBucket: "borderline",
        gateReasons: ["confidence"],
      },
      {
        // No best pick: no contract row for this name.
        symbol: "NVDA",
        underlyingPrice: 180.2,
        targetPrice: 190,
        targetSource: "model",
        targetEmUnits: 0.4,
        pick: {
          status: "no_trade",
          riskProfile: "balanced",
          confidence: "LOW",
          alternatives: [],
          rationale: ["No qualifying strategy"],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 0,
        gateBucket: "no_fit",
        gateReasons: ["No qualifying strategy"],
      },
    ],
    skipped: [{ symbol: "TSLA", reason: "Chain fetch failed" }],
    truncatedSymbols: 1,
    assumptions: ["Targets scoped to the stated thesis."],
    matrix: [],
    typeRollup: [],
    mode: "per_name_best",
    fits: [],
    fitsTotal: 0,
    gate: { fit: 1, borderline: 1, noFit: 1 },
    borderline: [],
    gateParams: {},
    profileRef: null,
    generatedAt: "2026-10-24T09:05:29Z",
    modelVersion: "1.2.0",
    requestSnapshot: {
      template: {
        thesis: "BULLISH",
        targetDate: "2026-11-13",
        maxPlannedLoss: 500,
        minRewardRisk: 2,
        allowedStrategies: [],
      },
      mode: "per_name_best",
      riskProfile: "balanced",
      profile: null,
    },
    configSnapshot: { maxScanSymbols: 20, targetFactors: {}, targetEmMultiples: {} },
    coverage: {
      considered: 5,
      scanned: 4,
      truncated: 1,
      evaluated: 3,
      errors: 1,
      withTrades: 2,
      eventCalendar: { covered: 4, total: 4, coveragePct: 100 },
    },
    partial: {
      evaluatedCount: 3,
      consideredCount: 5,
      coverageErrors: 1,
      truncatedCount: 1,
      topSkipReason: "Chain fetch failed",
      topSkipCount: 1,
    },
  } as unknown as OpportunityScanResult;
}

describe("unified-route CSV seam (#1587)", () => {
  let capturedXlsxInput: any;
  let capturedCsvInput: any;
  let capturedCsvText: string | undefined;

  const fakeAgent = {
    generateAndStoreOptionsXlsx: async (input: any) => {
      capturedXlsxInput = input;
      return { key: "xlsx-key", fileName: "options.xlsx" };
    },
    getOptionsXlsxByKey: async () => undefined,
    generateAndStoreOptionsCsv: async (input: any) => {
      capturedCsvInput = input;
      capturedCsvText = generateOptionsCsv(input);
      return { key: "csv-key", fileName: "options.csv" };
    },
    getOptionsCsvByKey: async () =>
      capturedCsvText
        ? { bytes: new TextEncoder().encode(capturedCsvText) }
        : undefined,
  };

  let currentScan: OpportunityScanResult | undefined;
  const ctxStub = (over: Record<string, unknown> = {}) => ({
    env: {},
    requestedEnv: undefined,
    getOrm: () => ({ storeCanonicalReport: () => {} }),
    agentCtx: {
      storage: {
        sql: {},
        put: async () => {},
        get: async (key: string) =>
          key.endsWith(":shapeReport") ? (currentScan as never) : undefined,
      },
    },
    getScreenerAgent: () => fakeAgent,
    ...over,
  });

  beforeEach(() => {
    capturedXlsxInput = undefined;
    capturedCsvInput = undefined;
    capturedCsvText = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runUnified(scan: OpportunityScanResult) {
    currentScan = scan;
    vi.spyOn(UnifiedOptionsService.prototype, "resolveEngineClient").mockResolvedValue({
      engineClient: {} as never,
      platformRunId: undefined,
    });
    const request = new Request("http://localhost/api/options/unified", {
      headers: { "x-user-login": "tester" },
    });
    const response = await executeUnifiedOptions({
      request,
      sessionId: "sess-1587",
      ctx: ctxStub() as any,
      reqData: { action: "opportunities", symbols: ["AAPL"], pushToSlack: false, thesis: "BULLISH" },
    });
    return response;
  }

  it("adapts opportunities-shaped input to a populated CSV", async () => {
    const response = await runUnified(unifiedScan());
    expect(mockRunWorkflow).toHaveBeenCalled();
    expect(response.status).toBe(200);
    // NOTE: the default (toUi) response carries xlsxUrl but no csvUrl —
    // csvUrl only appears on the webhook path (route line 499). That gap
    // is out of scope here; the defect evidence is the captured CSV input
    // and the generated CSV text below.
    await response.json();

    // The seam adapted: the generator received contracts, not raw scan rows.
    expect(Array.isArray(capturedCsvInput?.contracts)).toBe(true);
    expect(capturedCsvInput.contracts).toHaveLength(2);

    const rows = parseScreenerCsv(capturedCsvText!);
    expect(rows.length).toBeGreaterThan(1);
    const header = rows[0];
    expect(header[0]).toBe("Underlying");
    const dataRows = rows.slice(1);
    expect(dataRows).toHaveLength(2);
    expect(dataRows[0][0]).toBe("AAPL");
    expect(dataRows[1][0]).toBe("MSFT");
  });

  it("keeps the :409 XLSX seam adapted (regression pin, #1570)", async () => {
    await runUnified(unifiedScan());
    expect(Array.isArray(capturedXlsxInput?.contracts)).toBe(true);
    expect(capturedXlsxInput.contracts).toHaveLength(2);
  });

  it("a manual-shaped result passes through the adapter unchanged (:148 safety net)", () => {
    const manual = { contracts: [{ symbol: "AAPL" }], scannedAt: "2026-10-24T09:05:29Z" } as any;
    expect(adaptOpportunityScanToOptionScreenResult(manual as any)).toBe(manual);
  });
});
