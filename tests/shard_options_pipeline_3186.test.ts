/**
 * Issue #3186 step 3e - the per-symbol options shard scan runs
 * through the one scanner pipeline instead of the direct
 * UnifiedOptionsService.scanOpportunities call. Pin: executeShardJob
 * for one symbol returns exactly what the direct call returns (same
 * engine, same template, same chain-timestamp `now` override), and
 * the skipped-verdict retry contract is preserved (a symbol with no
 * chain throws so the acquisition bucket retries it).
 */
import { describe, expect, it, vi } from "vitest";
import { executeShardJob, type ShardExecutorDeps } from "../src/services/shardExecutors";
import { DatabaseORM } from "../src/orm";
import { UnifiedOptionsService } from "../src/trading";
import type { ETradeOptionChain } from "../src/trading/etrade/client";
import type { ShardPayload } from "../src/services/shardJobs";

const CHAIN_TIMESTAMP = "2026-11-05T12:00:00.000Z";
const TARGET_DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().split("T")[0];
const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

function chainFor(symbol: string, spot: number) {
  const expiry = `${expiryObj.year}-${String(expiryObj.month).padStart(2, "0")}-${String(expiryObj.day).padStart(2, "0")}`;
  const leg = (type: "CALL" | "PUT", strike: number) => ({
    symbol,
    optionType: type,
    strike,
    expirationDate: expiry,
    bid: 4.9,
    ask: 5.1,
    lastPrice: 5,
    volume: 1_000,
    openInterest: 2_000,
    delta: type === "CALL" ? 0.5 : -0.5,
    gamma: 0.02,
    theta: -0.03,
    impliedVolatility: 0.3,
  });
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

/** Strip volatile / pipeline-added fields before equivalence compare. */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "scannedAt" && k !== "persisted")
        .map(([k, v]) => [k, stripVolatile(v)]),
    );
  }
  return value;
}

function makeDeps(client: unknown): ShardExecutorDeps {
  const mockOrm = new DatabaseORM({ exec: vi.fn(() => []) } as any);
  return {
    sql: { exec: () => [] as unknown as Iterable<Record<string, unknown>> },
    env: {},
    orm: mockOrm,
    storage: {},
    createETradeService: () => ({ client }) as never,
    sessionId: "test",
  };
}

function makePayload(): ShardPayload {
  return {
    shard: { stage: "feed", key: "AAPL" },
    chain: {
      chainId: "chain-1",
      universe: "symbols",
      userLogin: "test_trader",
      trigger: "scheduled",
      timestamp: CHAIN_TIMESTAMP,
      channels: [],
      screenType: "options",
      options: {
        symbols: ["AAPL"],
        thesis: "bullish",
        targetDate: TARGET_DATE,
        riskProfile: "balanced",
        allowedStrategies: ["all"],
      },
    },
    inputs: { eventCalendar: { covered: false } },
  };
}

describe("options shard scan through the pipeline (#3186 step 3e)", () => {
  it("a per-symbol shard returns exactly the direct scanOpportunities result", async () => {
    const client = {
      getOptionExpireDates: async () => [expiryObj],
      getOptionChains: async (args: { symbol: string }) =>
        args.symbol === "AAPL" ? chainFor("AAPL", 150) : null,
    };
    const deps = makeDeps(client);
    const payload = makePayload();

    const viaPipeline = (await executeShardJob(deps, payload)) as any;

    const direct = await UnifiedOptionsService.scanOpportunities(
      client as never,
      ["AAPL"],
      {
        thesis: "bullish",
        targetDate: TARGET_DATE,
        expectedIvDirection: "unchanged",
        maxPlannedLoss: 1000,
        minRewardRisk: 1.5,
        allowedStrategies: ["all"],
      },
      {
        riskProfile: "balanced",
        maxSymbols: 1,
        eventCalendarBySymbol: { AAPL: { covered: false } as never },
        now: new Date(CHAIN_TIMESTAMP),
      },
    );

    // The chain-timestamp `now` override survives the pipeline:
    // deterministic provenance, not the wall clock.
    expect(viaPipeline.generatedAt).toBe(new Date(CHAIN_TIMESTAMP).toISOString());
    expect(viaPipeline.matrix).toHaveLength(1);
    expect(viaPipeline.matrix[0].symbol).toBe("AAPL");
    expect(viaPipeline.coverage).toMatchObject({ considered: 1, scanned: 1, errors: 0 });
    expect(stripVolatile(viaPipeline)).toEqual(stripVolatile(direct));
  });

  it("a symbol with no chain throws, so the acquisition bucket retries it", async () => {
    const client = {
      getOptionExpireDates: async () => [expiryObj],
      getOptionChains: async () => null,
    };
    const deps = makeDeps(client);
    // The scanner converts the missing chain into a skipped row whose
    // skipReason names the fetch failure; the shard re-throws it so
    // the acquisition bucket retries the symbol (same reason the
    // direct call produced - the fallback text only fires when the
    // row carries no reason at all).
    await expect(executeShardJob(deps, makePayload())).rejects.toThrow(/expiration fetches returned no/);
  });
});
