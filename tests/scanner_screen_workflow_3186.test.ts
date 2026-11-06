/**
 * Issue #3186 step 3e - the scanner leg's pipeline equivalence pin:
 * the one options pipeline, over the scanner ports, reproduces
 * OpportunityScanner.scan exactly (same agents, same template, same
 * clock). The direct scan is the oracle; the pipeline must match it
 * field for field, with the two documented tolerances: the skipped
 * list is compared as a map (scan() pushes skips in fetch-completion
 * order; the pipeline's collation sorts them by batch index), and
 * the shapeReport artifact carries the save receipt (scanRunId /
 * persisted) the direct result never has.
 *
 * Also pinned: the persist stage NEVER fails the run (a store error
 * is recorded, the result still returns), and the plan stage fails
 * closed on an empty batch and on the no-view mode.
 *
 * Fixtures reuse the options_scanner.test.ts pattern (fake screener
 * with canned chains keyed by symbol); the ports run over the REAL
 * data/risk/recommender agents, so the pin covers the real engine.
 */
import { describe, expect, it } from "vitest";
import { OpportunityScanner, type ScanRequestTemplate } from "../src/trading/options/opportunityScanner";
import { OptionsDataAgent } from "../src/trading/options/optionsDataAgent";
import { StrategyRiskAgent } from "../src/trading/options/strategyRiskAgent";
import { RecommendationAgent } from "../src/trading/options/recommendationAgent";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";
import { runOptionsScreenWorkflow } from "../src/workflows/optionsScreenWorkflow";
import { createScannerScreenPorts } from "../src/workflows/strategyScreenPorts";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import type { ScanRunStore } from "../src/data/scanRunPorts";

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const NOW = new Date("2026-11-05T00:00:00.000Z");

function baseTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: expiryDate,
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
    ...overrides,
  };
}

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

function makeContracts(symbol: string, spot: number): ScreenedOptionContractItem[] {
  // Fixed quote clock: both runs build identical contracts (a
  // Date.now() stamp here would differ between the two runs by
  // milliseconds and fail the equivalence comparison on noise).
  const now = NOW.getTime();
  return [0.95, 1, 1.05].flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `${symbol}${strike}C`, osiKey: `${symbol}-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `${symbol}${strike}P`, osiKey: `${symbol}-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

type SymbolBehavior =
  | { kind: "trade"; spot: number }
  | { kind: "empty"; validationError?: string };

function fakeScreener(behaviors: Record<string, SymbolBehavior>): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const behavior = behaviors[symbol] ?? { kind: "trade", spot: 100 };
      if (behavior.kind === "empty") {
        return {
          contracts: [],
          matchedCount: 0,
          totalContractsEvaluated: 0,
          totalUnderlyingsScanned: 1,
          scannedAt: new Date().toISOString(),
          rejections: [],
          ...(behavior.validationError ? { validationError: behavior.validationError } : {}),
        } as unknown as OptionScreenResult;
      }
      const contracts = makeContracts(symbol, behavior.spot);
      return {
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        totalUnderlyingsScanned: 1,
        scannedAt: new Date().toISOString(),
        rejections: [],
      } as unknown as OptionScreenResult;
    },
  } as unknown as DynamicOptionsScreener;
}

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    store: map,
    storage: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { map.set(key, value); },
    },
  };
}

function memoryClaims() {
  const claimed = new Set<string>();
  return {
    has: (key: string) => claimed.has(key),
    add: (key: string) => { claimed.add(key); },
  };
}

describe("scanner leg pipeline (issue #3186 step 3e)", () => {
  it("reproduces OpportunityScanner.scan exactly", async () => {
    const symbols = ["AAA", "BBB", "CCC"];
    const template = baseTemplate();
    const screener = fakeScreener({ AAA: { kind: "trade", spot: 100 }, BBB: { kind: "empty", validationError: "no chains" }, CCC: { kind: "trade", spot: 40 } });
    const direct = await new OpportunityScanner(screener).scan(symbols, template, { now: NOW });

    const { store, storage } = memoryStorage();
    const saved: unknown[] = [];
    const scanRunStore = {
      save: async (result: unknown) => { saved.push(result); return { id: "scan-1" }; },
    } as unknown as ScanRunStore;
    const agents = {
      data: new OptionsDataAgent(screener),
      risk: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
    };
    const runId = "scanner-pin-1";
    const published: Array<{ stageId: string; family?: string }> = [];
    const outcome = await runOptionsScreenWorkflow(
      {
        runId,
        userLogin: "tester",
        request: {
          assetClass: "options",
          trigger: "manual",
          classInput: { scan: { symbols, template, options: { now: NOW } } },
        } as never,
      },
      {
        stages: createScannerScreenPorts({ agents, storage, scanRunStore }),
        claims: memoryClaims(),
        queue: {
          send: async (message: { stageId: string; family?: string }) => { published.push(message); },
        },
      },
    );

    expect(outcome.outcome).toBe("completed");
    expect(published.map((m) => m.stageId)).toEqual([
      "plan", "chainFetch", "enrich", "screen", "risk", "persistCanonicalResults", "shapeReport", "deliver",
    ]);
    expect(published.every((m) => m.family === "options")).toBe(true);
    for (const stage of ["plan", "chainFetch", "enrich", "screen", "risk", "persistCanonicalResults", "shapeReport", "deliver"]) {
      expect(store.has(optionsArtifactKey(runId, stage))).toBe(true);
    }

    const shape = store.get(optionsArtifactKey(runId, "shapeReport")) as Record<string, unknown>;
    expect(shape.persisted).toBe(true);
    expect(shape.scanRunId).toBe("scan-1");
    const { scanRunId: _id, persisted: _persisted, ...shapeResult } = shape;
    const { skipped: directSkipped, ...directRest } = direct as unknown as Record<string, unknown>;
    const { skipped: shapeSkipped, ...shapeRest } = shapeResult as Record<string, unknown>;
    expect(shapeRest).toEqual(directRest);
    // Skipped order is completion order in scan(), batch order in the
    // pipeline: compare as a map, the same tolerance the scanner
    // suites already use.
    expect(new Map((shapeSkipped as Array<{ symbol: string; reason: string }>).map((k) => [k.symbol, k.reason]))).toEqual(
      new Map((directSkipped as Array<{ symbol: string; reason: string }>).map((k) => [k.symbol, k.reason])),
    );
    // The store received the same collated result the pipeline shaped.
    expect(saved).toHaveLength(1);
    const { skipped: savedSkipped, ...savedRest } = saved[0] as Record<string, unknown>;
    expect(savedRest).toEqual(directRest);
    expect(new Map((savedSkipped as Array<{ symbol: string; reason: string }>).map((k) => [k.symbol, k.reason]))).toEqual(
      new Map((directSkipped as Array<{ symbol: string; reason: string }>).map((k) => [k.symbol, k.reason])),
    );
  });

  it("persist never fails the run: a store error is recorded, the result still returns", async () => {
    const symbols = ["AAA"];
    const template = baseTemplate();
    const screener = fakeScreener({ AAA: { kind: "trade", spot: 100 } });
    const { store, storage } = memoryStorage();
    const failingStore = {
      save: async () => { throw new Error("store down"); },
    } as unknown as ScanRunStore;
    const agents = {
      data: new OptionsDataAgent(screener),
      risk: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
    };
    const runId = "scanner-pin-2";
    const outcome = await runOptionsScreenWorkflow(
      {
        runId,
        userLogin: "tester",
        request: {
          assetClass: "options",
          trigger: "manual",
          classInput: { scan: { symbols, template, options: { now: NOW } } },
        } as never,
      },
      { stages: createScannerScreenPorts({ agents, storage, scanRunStore: failingStore }), claims: memoryClaims(), queue: null },
    );
    expect(outcome.outcome).toBe("completed");
    const persistArtifact = store.get(optionsArtifactKey(runId, "persistCanonicalResults")) as Record<string, unknown>;
    expect(persistArtifact.saved).toBe(false);
    expect(persistArtifact.persisted).toBe(false);
    const shape = store.get(optionsArtifactKey(runId, "shapeReport")) as Record<string, unknown>;
    expect(shape.persisted).toBe(false);
    expect(shape.withTrades).toBe(1);
  });

  it("fails closed on an empty batch and on the no-view mode", async () => {
    const screener = fakeScreener({});
    const agents = {
      data: new OptionsDataAgent(screener),
      risk: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
    };
    const { storage } = memoryStorage();
    const empty = await runOptionsScreenWorkflow(
      { runId: "scanner-pin-3", userLogin: "tester", request: { assetClass: "options", trigger: "manual", classInput: { scan: { symbols: [], template: baseTemplate() } } } as never },
      { stages: createScannerScreenPorts({ agents, storage }), claims: memoryClaims(), queue: null },
    );
    expect(empty.outcome).toBe("failed");
    expect(empty.failedStage).toBe("plan");
    expect(empty.reason).toMatch(/missing symbols/);
    const noView = await runOptionsScreenWorkflow(
      { runId: "scanner-pin-4", userLogin: "tester", request: { assetClass: "options", trigger: "manual", classInput: { scan: { symbols: ["AAA"], template: baseTemplate({ strategyMode: "no-view" }) } } } as never },
      { stages: createScannerScreenPorts({ agents, storage }), claims: memoryClaims(), queue: null },
    );
    expect(noView.outcome).toBe("failed");
    expect(noView.failedStage).toBe("plan");
    expect(noView.reason).toMatch(/no-view/);
  });
});
