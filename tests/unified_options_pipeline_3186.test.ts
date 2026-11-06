/**
 * Issue #3186 step 3e - the unified handler's opportunities action
 * runs through the one scanner pipeline instead of
 * UnifiedOptionsService.execute(). Pin: a live route invocation
 * with fixture chains returns the pipeline's scan (same shape the
 * downstream PDF/XLSX/CSV/canonical-report code reads), the
 * persist stage's save receipt rides the body, and the XLSX/CSV
 * seams receive the adapted contracts.
 *
 * Chains come from DynamicOptionsScreener's static test fixture
 * (the same seam the manual-entry pin uses); storage is the
 * Map-backed memory store + MockSqlStorage, so the durable claims
 * and the scan-run save both run for real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeUnifiedOptions } from "../src/agents/routes/etradeOptionsScreen";
import { DynamicOptionsScreener } from "../src/trading";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { ETradeOptionChain } from "../src/trading/etrade/client";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

// Same economics as the scanner suites' fixture (tests/options_scanner.test.ts):
// intrinsic + time value per strike, so the engine's candidate
// scoring sees realistic reward/risk. A flat mid for every strike
// produces no qualifying pick (the gate rejects the nonsense
// economics) and the adapter then yields zero contracts.
function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

// Chain fixture in the shape the real screener parses (copied from
// tests/options_scan_persistence.test.ts): legs carry strikePrice /
// timeStamp / adjustedFlag and NO expirationDate; the chain carries
// selectedExpiry as a {year, month, day} OBJECT. A string expiry or
// a `strike` field parses to daysToExpiration null and the engine
// silently no-passes every symbol (caught by probe 2026-11-05).
function makeChain(symbol: string, spot: number) {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: mid - 0.1,
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? delta : -delta,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiryObj,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

describe("unified opportunities through the pipeline (#3186 step 3e)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
    vi.restoreAllMocks();
  });

  it("returns the pipeline scan with its save receipt, and the XLSX/CSV seams get adapted contracts", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      AAPL: makeChain("AAPL", 150),
      MSFT: makeChain("MSFT", 250),
    });
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as never);
    const storage = memoryStorage();
    let capturedXlsxInput: any;
    let capturedCsvInput: any;
    const fakeAgent = {
      generateAndStoreOptionsXlsx: async (input: any) => {
        capturedXlsxInput = input;
        return { key: "xlsx-key-1", fileName: "options.xlsx" };
      },
      generateAndStoreOptionsCsv: async (input: any) => {
        capturedCsvInput = input;
        return { key: "csv-key-1", fileName: "options.csv" };
      },
      getPdfByKey: async () => null,
      getOptionsXlsxByKey: async () => ({ bytes: new Uint8Array([1]), fileName: "options.xlsx" }),
      getOptionsCsvByKey: async () => ({ bytes: new Uint8Array([1]), fileName: "options.csv" }),
    };
    const ctx = {
      env: {},
      requestedEnv: undefined,
      getOrm: () => orm,
      agentCtx: { storage: { ...storage, sql } },
      getScreenerAgent: () => fakeAgent,
    } as never;

    const request = new Request("http://localhost/api/options/unified", {
      headers: { "x-user-login": "tester" },
    });
    const response = await executeUnifiedOptions({
      request,
      sessionId: "sess-3186-unified",
      ctx,
      reqData: {
        action: "opportunities",
        symbols: ["AAPL", "MSFT"],
        thesis: "bullish",
        riskProfile: "balanced",
        // The permissive template the scanner suites use for a
        // qualifying pick (a single strategy type keeps the
        // candidate build cheap).
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
        pushToSlack: false,
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.success).toBe(true);
    expect(body.scanned).toBe(2);
    expect(Array.isArray(body.opportunities)).toBe(true);
    expect(body.coverage).toMatchObject({ considered: 2, scanned: 2, errors: 0 });
    // The persist stage's save receipt rides the UI body.
    expect(typeof body.scanRunId).toBe("string");
    expect(body.persisted).toBe(true);
    // The downstream seams ran on the pipeline's data.
    expect(body.xlsxUrl).toContain("/api/options/report.xlsx");
    expect(body.csvUrl).toContain("/api/options/report.csv");
    expect(Array.isArray(capturedXlsxInput?.contracts)).toBe(true);
    expect(capturedXlsxInput.contracts).toHaveLength(2);
    // The adapter's contracts carry OSI symbols, not underlyings,
    // and are not in symbol order - sort before asserting.
    const xlsxSymbols = capturedXlsxInput.contracts.map((c: any) => c.symbol).sort();
    expect(xlsxSymbols[0]).toContain("AAPL");
    expect(xlsxSymbols[1]).toContain("MSFT");
    expect(Array.isArray(capturedCsvInput?.contracts)).toBe(true);
    expect(capturedCsvInput.contracts).toHaveLength(2);
    const csvSymbols = capturedCsvInput.contracts.map((c: any) => c.symbol).sort();
    expect(csvSymbols[0]).toContain("AAPL");
    expect(csvSymbols[1]).toContain("MSFT");
    // The pipeline's 8 stage artifacts are in the DO storage.
    expect(storage.keys().filter((k) => k.startsWith("options:options_scanner:unified:"))).toHaveLength(8);
  });
});
