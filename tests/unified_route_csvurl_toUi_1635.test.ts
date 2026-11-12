/**
 * Issue #1635: unified-route default UI response omits csvUrl (toUi path).
 *
 * In `src/agents/routes/etradeOptionsScreen.ts`, the webhook path (line 503)
 * returns `{ ...result.toWebhook(), reportUrl, xlsxUrl, csvUrl }`, but the
 * default path (line 508) returns `{ ...result.toUi(), reportUrl, xlsxUrl }`
 * — no `csvUrl`, so a UI client on the default path cannot discover the
 * unified CSV download, even though the CSV itself is generated correctly
 * (see #1587).
 *
 * This test was written FIRST (TDD red): it drives an opportunities-shaped
 * input through the live route with a stub screener agent that runs the REAL
 * CSV generator on the captured input, and asserts the default-path response
 * carries `csvUrl` (+ `csvKey`) pointing at the generated CSV. Pre-fix it
 * fails (csvUrl undefined); post-fix it passes. The webhook path is pinned
 * as changed by #1786: it now carries csvKey alongside csvUrl + xlsxUrl.
 *
 * Scope pins in this file:
 * - Default (toUi) path: response carries csvUrl + csvKey for the CSV the
 *   route just generated, and xlsxUrl is still present.
 * - Webhook path (#1786): response carries csvUrl + xlsxUrl + csvKey for the
 *   CSV the route just generated (previously csvUrl + xlsxUrl only).
 * - CSV generation itself unchanged: verified by the change set (no
 *   generator files touched) and by #1587's pins, not re-proven here.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { executeUnifiedOptions } from "../src/agents/routes/etradeOptionsScreen";

// Issue #3186 step 3e - the opportunities action no longer calls
// service.execute(); it runs the one scanner pipeline. These seam
// tests pin the response shape, not the engine, so the engine dispatch is stubbed to a completed outcome and the storage stub
// serves the fixture scan as the shapeReport artifact. The real
// pipeline-through-handler path is pinned in
// tests/unified_options_pipeline_3186.test.ts.
const mockRunWorkflow = vi.hoisted(() =>
  vi.fn(async () => ({ outcome: "completed", runId: "mock-run", stages: [], published: [] })),
);
// Issue #4068: the route now dispatches through the engine
// (runOptionsScreenViaEngine), so the stub rides the engine module —
// the composer stub this mocked is no longer called by the route.
vi.mock("../src/workflows/optionsScreenEngine", async (importOriginal) => ({
  ...(await importOriginal()),
  runOptionsScreenViaEngine: mockRunWorkflow,
}));
import { UnifiedOptionsService } from "../src/trading";
import type { OpportunityScanResult } from "../src/trading/options/opportunityScanner";
import { generateOptionsCsv } from "../src/trading/screenerReportCsv";

function miniScan(): OpportunityScanResult {
  const leg = (symbol: string, strike: number) => ({
    symbol,
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike,
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
  });
  return {
    scanned: 2,
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
          best: { candidate: { legs: [leg("AAPL  261024C00250000", 250)] } },
        },
      },
      {
        symbol: "MSFT",
        underlyingPrice: 510.0,
        targetPrice: 530,
        targetSource: "model",
        targetEmUnits: 0.5,
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "HIGH",
          best: { candidate: { legs: [leg("MSFT  261024C00510000", 510)] } },
        },
      },
    ],
    coverage: { considered: 2, scanned: 2, evaluated: 2, withTrades: 2 },
    generatedAt: "2026-10-24T09:05:29Z",
    // Issue #3186 step 3e - the handler now builds the summary from
    // the scan via the shared builder, so the fixture carries the
    // fields it reads (mode + gate); previously the mocked execute()
    // returned a canned summary and these were never read.
    mode: "per_name_best",
    fitsTotal: 0,
    gate: { fit: 2, borderline: 0, noFit: 0 },
  } as unknown as OpportunityScanResult;
}

describe("unified-route default UI response csvUrl (#1635)", () => {
  let capturedCsvText: string | undefined;

  const fakeAgent = {
    generateAndStoreOptionsXlsx: async () => ({ key: "xlsx-key", fileName: "options.xlsx" }),
    getOptionsXlsxByKey: async () => undefined,
    generateAndStoreOptionsCsv: async (input: any) => {
      capturedCsvText = generateOptionsCsv(input);
      return { key: "csv-key", fileName: "options.csv" };
    },
    getOptionsCsvByKey: async (key: string) =>
      key === "csv-key" && capturedCsvText
        ? { bytes: new TextEncoder().encode(capturedCsvText) }
        : undefined,
  };

  let currentScan: ReturnType<typeof miniScan> | undefined;
  const ctxStub = () => ({
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    capturedCsvText = undefined;
  });

  async function runUnified(reqData: Record<string, unknown>) {
    currentScan = miniScan();
    vi.spyOn(UnifiedOptionsService.prototype, "resolveEngineClient").mockResolvedValue({
      engineClient: {} as never,
      platformRunId: undefined,
    });
    const request = new Request("http://localhost/api/options/unified", {
      headers: { "x-user-login": "tester" },
    });
    return executeUnifiedOptions({
      request,
      sessionId: "sess-1635",
      ctx: ctxStub() as any,
      reqData: { action: "opportunities", symbols: ["AAPL"], pushToSlack: false, thesis: "BULLISH", ...reqData },
    });
  }

  it("default (toUi) path carries csvUrl + csvKey for the generated CSV", async () => {
    const response = await runUnified({});
    expect(mockRunWorkflow).toHaveBeenCalled();
    expect(response.status).toBe(200);
    const body: any = await response.json();
    // xlsxUrl was already present on the default path; it must stay.
    expect(body.xlsxUrl).toBe("/api/options/report.xlsx?key=xlsx-key");
    // The defect: pre-fix both of these are undefined.
    expect(body.csvUrl).toBe("/api/options/report.csv?key=csv-key");
    expect(body.csvKey).toBe("csv-key");
    // The URL must resolve to the CSV the route just generated.
    const stored = await fakeAgent.getOptionsCsvByKey(body.csvKey);
    expect(stored).toBeDefined();
    const text = new TextDecoder().decode(stored!.bytes);
    expect(text).toContain("AAPL");
  });

  it("webhook path carries csvUrl + xlsxUrl + csvKey (#1786)", async () => {
    const response = await runUnified({ channel: "webhook" });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.xlsxUrl).toBe("/api/options/report.xlsx?key=xlsx-key");
    expect(body.csvUrl).toBe("/api/options/report.csv?key=csv-key");
    // #1786: the webhook channel previously omitted csvKey while the ui
    // channel carried it; pre-fix this is undefined.
    expect(body.csvKey).toBe("csv-key");
    const stored = await fakeAgent.getOptionsCsvByKey(body.csvKey);
    expect(stored).toBeDefined();
    const text = new TextDecoder().decode(stored!.bytes);
    expect(text).toContain("AAPL");
  });
});
