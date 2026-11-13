/**
 * Issue #3186 (step 3e) - the NLQ panel leg's swap pin: the
 * options_strategies action runs through the one pipeline (not the
 * direct runPanelPipelineRetired4068 call) and returns the same envelope shape.
 * The engine equivalence itself is pinned by
 * strategy_screen_workflow_3186.test.ts; this file pins the SWAP
 * wiring: the action executes end to end over fixture chains, the
 * envelope carries the symbol/thesis, and the run leaves all eight
 * stage artifacts in the host's storage.
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import { DynamicOptionsScreener } from "../src/trading";
import { runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { panelResultToPipelineResult } from "../src/workflows/strategyScreenPorts";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.05,
          ask: 1.1,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.05,
          ask: 1.1,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async <T>(key: string) => map.get(key) as T | undefined,
    keys: () => [...map.keys()],
  };
}

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("panelResultToPipelineResult (#3186 step 3e)", () => {
  it("maps a panel result through the retired direct panel's mapping", () => {
    const panel = {
      snapshot: {
        symbol: "AAPL",
        contracts: [{ underlyingSymbol: "AAPL" }],
        dataSource: "live",
        screen: { contractsEvaluated: 2 },
        rejections: [{ reason: "wide" }],
        validationError: undefined,
        chainProvenance: "live",
        underlyingPrice: 100,
      },
      candidates: [],
      rejected: [],
      attrition: { generated: 1, gatePassed: 1, priced: 1, falsified: 1 },
      limitations: [],
      ranked: [{ rank: 1 }],
      riskReports: [{ violation: false }],
      bestTrade: { status: "ready" },
      screenedOut: [],
      legacy: { evaluations: ["e1"], nameLedger: [], excluded: [], buildResult: { candidates: ["c1"] } },
    };
    const result = panelResultToPipelineResult(panel as never);
    expect(result.snapshot).toEqual({
      symbol: "AAPL",
      contracts: [{ underlyingSymbol: "AAPL" }],
      dataSource: "live",
      screen: { contractsEvaluated: 2 },
      rejections: [{ reason: "wide" }],
      validationError: undefined,
    });
    expect((result.strategies as unknown as { candidates: unknown[] }).candidates).toEqual(["c1"]);
    expect(result.ranked).toEqual([{ rank: 1 }]);
    expect(result.bestTrade).toEqual({ status: "ready" });
  });
});

describe("runOptionsStrategyAction panel leg through the pipeline (#3186 step 3e)", () => {
  it("returns the strategies envelope and leaves eight stage artifacts", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const storage = memoryStorage();
    const res = await runOptionsStrategyAction(
      {
        client: new DynamicOptionsScreener(undefined),
        fetchQuoteRemote: async () => ({ lastPrice: 100 }),
        getWatchlists: async () => [],
        screenMarketsAsync: async () => ({ stocks: [] }),
      },
      "options_strategies",
      {
        request: {
          symbol: "AAPL",
          thesis: "bullish",
          targetPrice: 105,
          expectedIvDirection: "rise",
          targetDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          maxPlannedLoss: 500,
          minRewardRisk: 1,
          allowedStrategies: ["bull_call_spread"],
          minDte: 21,
          maxDte: 60,
        },
        riskProfile: "balanced",
        strategyFilter: {},
        thesisInferred: false,
        targetPriceInferred: false,
      } as never,
      { userLogin: "owner@example.com", pipelineStorage: storage },
    );
    // The engine over a two-contract fixture may rank nothing; the
    // pin is the envelope shape + the staged run, not a candidate.
    expect(["ranked_candidates", "no_candidates"]).toContain(res.status);
    expect(Array.isArray(res.rows)).toBe(true);
    expect(res.summary).toContain("AAPL");
    expect(storage.keys()).toHaveLength(8);
    expect(storage.keys().every((key) => key.startsWith("options:nlq-panel:"))).toBe(true);
  });

  // CORRECTION (2026-11-05, #26 tests): without an identity the
  // panel still runs and returns its envelope - the composer skips
  // publishing, the stages run, the artifacts are the record. The
  // fail-closed asserted here before contradicted the pre-existing
  // #26 pins (runOptionsStrategyAction with no deps expects a panel
  // result); the panel leg writes no owner-scoped canonical record,
  // so there is nothing that needs an identity to be safe.
  it("without an identity the panel still runs (#26 discipline)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const storage = memoryStorage();
    const res = await runOptionsStrategyAction(
      {
        client: new DynamicOptionsScreener(undefined),
        fetchQuoteRemote: async () => ({ lastPrice: 100 }),
        getWatchlists: async () => [],
        screenMarketsAsync: async () => ({ stocks: [] }),
      },
      "options_strategies",
      {
        request: {
          symbol: "AAPL",
          thesis: "bullish",
          targetPrice: 105,
          expectedIvDirection: "rise",
          targetDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          maxPlannedLoss: 500,
          minRewardRisk: 1,
          allowedStrategies: ["bull_call_spread"],
        },
        riskProfile: "balanced",
        strategyFilter: {},
        thesisInferred: false,
        targetPriceInferred: false,
      } as never,
      { pipelineStorage: storage },
    );
    expect(["ranked_candidates", "no_candidates"]).toContain(res.status);
    expect(res.summary).toContain("AAPL");
    expect(storage.keys()).toHaveLength(8);
  });
});

describe("runOptionsStrategyAction scanner leg through the pipeline (#3186 step 3e)", () => {
  it("returns the opportunities envelope, persists the run, and leaves eight stage artifacts", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL"), MSFT: makeChain("MSFT") });
    const storage = memoryStorage();
    const saved: Array<Record<string, unknown>> = [];
    const scanRunStore = {
      save: async (result: unknown) => {
        saved.push(result as Record<string, unknown>);
        return { id: "scan-1" };
      },
    };
    const res = await runOptionsStrategyAction(
      {
        client: new DynamicOptionsScreener(undefined),
        fetchQuoteRemote: async () => ({ lastPrice: 100 }),
        getWatchlists: async () => [],
        screenMarketsAsync: async () => ({ stocks: [] }),
      },
      "options_opportunities",
      {
        request: {
          thesis: "bullish",
          targetDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 5_000,
          minRewardRisk: 0.1,
          allowedStrategies: ["long_call"],
          minDte: 14,
          maxDte: 60,
          contractLimit: 500,
          candidateLimit: 10,
          maxStrikesPerSide: 12,
          maxIronCondors: 100,
          maxQuoteAgeSeconds: 60,
          eventPolicy: "warn",
        },
        riskProfile: "balanced",
        strategyFilter: {},
        thesisInferred: false,
        targetPriceInferred: false,
        scope: { kind: "symbols", symbols: ["AAPL", "MSFT"] },
      } as never,
      { userLogin: "owner@example.com", pipelineStorage: storage, scanRunStore: scanRunStore as never },
    );
    // The engine over a two-contract fixture may rank nothing; the
    // pin is the envelope shape + the staged run + the persisted row,
    // not a candidate.
    expect(["ranked_opportunities", "no_opportunities"]).toContain(res.status);
    expect(Array.isArray(res.rows)).toBe(true);
    expect(res.summary).toContain("AAPL");
    // Both symbols were judged (the scan ran, not just returned empty).
    expect((res.matrix as Array<{ symbol: string }>).map((m) => m.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(storage.keys()).toHaveLength(8);
    expect(storage.keys().every((key) => key.startsWith("options:nlq-scan:"))).toBe(true);
    // The persist stage saved the run with the replayable request
    // record attached, and the envelope carries the save receipt.
    expect(saved).toHaveLength(1);
    expect(
      (saved[0].requestSnapshot as { request: { symbols: string[] } }).request.symbols,
    ).toEqual(["AAPL", "MSFT"]);
    expect((res as { scanRunId?: string }).scanRunId).toBe("scan-1");
    expect((res as { persisted?: boolean }).persisted).toBe(true);
  });

  it("without an identity the scan still runs and saves unscoped (#27 discipline)", async () => {
    const saved: { result: unknown; options: unknown }[] = [];
    const store = {
      save: async (result: unknown, options?: unknown) => {
        saved.push({ result, options });
        return { id: "scan-unscoped", createdAt: new Date().toISOString() };
      },
      list: async () => [],
      get: async () => null,
      updatePdfKey: async () => false,
      updateXlsxKey: async () => false,
      updateCsvKey: async () => false,
      prune: async () => 0,
    };
    const res = await runOptionsStrategyAction(
      {
        client: new DynamicOptionsScreener(undefined),
        fetchQuoteRemote: async () => ({ lastPrice: 100 }),
        getWatchlists: async () => [],
        screenMarketsAsync: async () => ({ stocks: [] }),
      },
      "options_opportunities",
      {
        request: {
          thesis: "bullish",
          targetDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 5_000,
          minRewardRisk: 0.1,
          allowedStrategies: ["long_call"],
        },
        riskProfile: "balanced",
        strategyFilter: {},
        thesisInferred: false,
        targetPriceInferred: false,
        scope: { kind: "symbols", symbols: ["AAPL"] },
      } as never,
      { scanRunStore: store as never },
    );
    // No identity: the run succeeds (the scanner leg does not fail
    // closed), the save lands unscoped - no userLogin is invented -
    // and the receipt still rides the envelope.
    expect(["ranked_opportunities", "no_opportunities"]).toContain(res.status);
    expect(saved).toHaveLength(1);
    expect((saved[0].options as { userLogin?: string }).userLogin).toBeUndefined();
    expect((res as { scanRunId?: string }).scanRunId).toBe("scan-unscoped");
    expect((res as { persisted?: boolean }).persisted).toBe(true);
  });
});
