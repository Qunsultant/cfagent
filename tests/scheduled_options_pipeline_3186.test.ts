/**
 * Issue #3186 step 3e - the scheduled monolithic options scan runs
 * through the one scanner pipeline instead of
 * UnifiedOptionsService.execute(). Pin: a small (2-symbol) scheduled
 * run completes end to end - the shared opportunities summary, the
 * coverage the downstream gates read, and the persist stage's
 * scanRunStore save (request record + platform-free save receipt).
 *
 * The E*TRADE client is stubbed at the ETradeRestClient prototype
 * (expire dates + chains per symbol); everything else is the real
 * service - auth pre-flight and the scheduled-trigger claim are
 * stubbed exactly as the sharding tests stub them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";
import { ETradeRestClient } from "../src/trading/etrade/client";
import type { ETradeOptionChain } from "../src/trading/etrade/client";
import { InMemoryScanRunStore } from "../src/trading/options/scanRunStore";

const NOW = Date.now();
const expiryDateObj = new Date(NOW + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

function chainFor(symbol: string, spot: number) {
  const expiry = `${expiryObj.year}-${String(expiryObj.month).padStart(2, "0")}-${String(expiryObj.day).padStart(2, "0")}`;
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const deltaMag = 0.5;
    const mid = 5;
    return {
      symbol,
      optionType: type,
      strike,
      expirationDate: expiry,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiry,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

describe("scheduled monolithic options scan through the pipeline (#3186 step 3e)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a small scheduled scan completes with the shared summary, coverage and a persisted run", async () => {
    const spots: Record<string, number> = { AAPL: 150, MSFT: 250 };
    vi.spyOn(ETradeRestClient.prototype, "getOptionExpireDates").mockImplementation(async () => [expiryObj] as never);
    vi.spyOn(ETradeRestClient.prototype, "getOptionChains").mockImplementation(async (args: { symbol: string }) =>
      spots[args.symbol] !== undefined ? chainFor(args.symbol, spots[args.symbol]) : null,
    );

    const mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    const mockSql = { exec: vi.fn(() => []) };
    const mockOrm = new DatabaseORM(mockSql as any);
    const store = new InMemoryScanRunStore();
    const service = new ScheduledTasksService(
      mockEnv, mockOrm, "test_trader",
      store, undefined, undefined, undefined, undefined, undefined,
    );
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ claimScheduledExecution: async () => true });
    (service as any).publishScreenerEvent = vi.fn(async () => {});

    const result = await service.autonomousOptionsAnalysis({
      symbols: ["AAPL", "MSFT"],
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.totalScanned).toBe(2);
    expect(data.symbols).toEqual(["AAPL", "MSFT"]);
    expect(Array.isArray(data.opportunities)).toBe(true);
    // The shared opportunities-case summary (mode label + gate segment).
    expect(String(data.summary)).toMatch(/Opportunity scan across 2 symbols/);
    expect(String(data.summary)).toMatch(/Gate: \d+ fit, \d+ borderline, \d+ no fit\./);

    // The persist stage saved the run: one row, replayable request
    // record, coverage the downstream gates read.
    const listed = await store.list({ userLogin: "test_trader" });
    expect(listed).toHaveLength(1);
    // list() returns projections; the full run rides get().
    const saved = await store.get(listed[0].id, { userLogin: "test_trader" });
    expect(saved).not.toBeNull();
    expect(saved!.result.requestSnapshot.request.symbols).toEqual(["AAPL", "MSFT"]);
    expect(saved!.result.requestSnapshot.request.thesis).toBe("bullish");
    expect(saved!.result.coverage).toMatchObject({ considered: 2, scanned: 2, errors: 0 });
    expect(saved!.result.mode).toBe("per_name_best");
  });
});
