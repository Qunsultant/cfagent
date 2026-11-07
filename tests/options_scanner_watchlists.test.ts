import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import {
  DynamicOptionsScreener,
  sanitizeOptionScreenerFilter,
  MAX_SCAN_SYMBOLS,
  MAX_RETURNED_CONTRACTS,
  DEFAULT_MAX_DTE,
} from "../src/trading/optionsScreener";
import { ETradeRestClient } from "../src/trading/etrade/client";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import { ETradeService } from "../src/services/etrade";
import { DatabaseORM } from "../src/orm";
import { planNLQ, executeNLQQueryAsync } from "../src/agents/nlq";
import { ETradeVoiceTradingService } from "../src/trading/voice/agent";
import type { Env, ETradeOptionChain } from "../src/types";

describe("Options Scanner & Watchlist Capability Suite", () => {
  let mockSqlStore: any[];
  let mockSql: any;
  let orm: DatabaseORM;
  let mockEnv: Env;

  beforeEach(() => {
    mockSqlStore = [];
    const tables: Record<string, any[]> = {};

    mockSql = {
      exec: vi.fn((query: string, ...args: unknown[]) => {
        const q = query.trim().toUpperCase();

        if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) {
          const match = query.match(/CREATE TABLE IF NOT EXISTS ([a-zA-Z0-9_]+)/i);
          if (match && !tables[match[1]]) {
            tables[match[1]] = [];
          }
          return [];
        }

        if (q.startsWith("INSERT")) {
          const match = query.match(/INSERT (?:OR IGNORE )?INTO ([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
          if (match) {
            const table = match[1];
            const cols = match[2].split(",").map((c) => c.trim().toLowerCase());
            const row: Record<string, any> = {};
            cols.forEach((col, idx) => {
              row[col] = args[idx];
            });
            if (!tables[table]) tables[table] = [];
            tables[table].push(row);
          }
          return [];
        }

        if (q.startsWith("SELECT COUNT(*)")) {
          const match = query.match(/FROM ([a-zA-Z0-9_]+)/i);
          const table = match ? match[1] : "";
          const count = tables[table]?.length || 0;
          return [{ count }];
        }

        if (q.startsWith("SELECT")) {
          const match = query.match(/FROM ([a-zA-Z0-9_]+)/i);
          const table = match ? match[1] : "";
          const rows = tables[table] || [];

          if (query.includes("WHERE")) {
            if (query.includes("id = ?") || query.includes("key = ?")) {
              const idVal = args[0];
              const found = rows.find((r) => r.id === idVal || r.key === idVal);
              return found ? [found] : [];
            }
            if (query.includes("user_login = ?")) {
              const uVal = args[0];
              return rows.filter((r) => r.user_login === uVal);
            }
          }
          return rows;
        }

        if (q.startsWith("UPDATE")) {
          const match = query.match(/UPDATE ([a-zA-Z0-9_]+)/i);
          const table = match ? match[1] : "";
          const idVal = args[args.length - 1];
          const rows = tables[table] || [];
          const idx = rows.findIndex((r) => r.id === idVal);
          if (idx !== -1) {
            rows[idx] = { ...rows[idx], updated_at: new Date().toISOString() };
          }
          return [];
        }

        if (q.startsWith("DELETE")) {
          const match = query.match(/FROM ([a-zA-Z0-9_]+) WHERE [a-zA-Z0-9_]+ = \?/i);
          const table = match ? match[1] : "";
          const idVal = args[0];
          if (tables[table]) {
            tables[table] = tables[table].filter((r) => r.id !== idVal);
          }
          return [];
        }

        return [];
      }),
    };

    orm = new DatabaseORM(mockSql);
    orm.initializeSchema("test_session_user");

    mockEnv = {
      ETRADE_API_KEY: "sandbox_consumer_key",
      ETRADE_API_SECRET: "sandbox_consumer_secret",
      ETRADE_ENV: "SANDBOX",
      ETRADE_ACCOUNT_ID: "83321443",
    } as any;

    const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const quoteTimestamp = Date.now();
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: {
        symbol: "NVDA",
        underlyingPrice: 100,
        selectedExpiry: {
          year: expiryDate.getUTCFullYear(),
          month: expiryDate.getUTCMonth() + 1,
          day: expiryDate.getUTCDate(),
        },
        pairs: [{
          call: {
            timeStamp: quoteTimestamp,
            adjustedFlag: false,
            optionType: "CALL",
            strikePrice: 100,
            symbol: "NVDATESTC100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 500,
            openInterest: 1000,
            delta: 0.52,
            gamma: 0.04,
            theta: -0.06,
            impliedVolatility: 0.38,
          },
          put: {
            timeStamp: quoteTimestamp,
            adjustedFlag: false,
            optionType: "PUT",
            strikePrice: 100,
            symbol: "NVDATESTP100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 400,
            openInterest: 900,
            delta: 0.48,
            gamma: 0.04,
            theta: -0.05,
            impliedVolatility: 0.40,
          },
        }],
      },
    });
  });

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
    DynamicOptionsScreener.setTestListingsFixture(null);
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // 1. Dynamic Options Screener Engine
  // =========================================================================
  describe("DynamicOptionsScreener Engine", () => {
    beforeEach(() => {
      const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const expiry = {
        year: expiryDate.getUTCFullYear(),
        month: expiryDate.getUTCMonth() + 1,
        day: expiryDate.getUTCDate(),
      };
      const quoteTimestamp = Date.now();
      const chains = Object.fromEntries(["NVDA", "TSLA", "AAPL", "MSFT"].map((symbol) => [symbol, {
        symbol,
        underlyingPrice: 100,
        selectedExpiry: expiry,
        pairs: [{
          call: {
            timeStamp: quoteTimestamp,
            adjustedFlag: false,
            optionType: "CALL" as const,
            strikePrice: 100,
            symbol: `${symbol}TESTC100`,
            bid: 4.5,
            ask: 4.7,
            lastPrice: 4.6,
            volume: 5000,
            openInterest: 2000,
            delta: 0.52,
            gamma: 0.04,
            theta: -0.06,
            impliedVolatility: 0.38,
          },
          put: {
            timeStamp: quoteTimestamp,
            adjustedFlag: false,
            optionType: "PUT" as const,
            strikePrice: 100,
            symbol: `${symbol}TESTP100`,
            bid: 4.5,
            ask: 4.7,
            lastPrice: 4.6,
            volume: 5000,
            openInterest: 2000,
            delta: 0.48,
            gamma: 0.04,
            theta: -0.05,
            impliedVolatility: 0.40,
          },
        }],
      }]));
      DynamicOptionsScreener.setTestChainsFixture(chains);
    });

    it("screens CALL contracts for a specific underlying with delta and volume filters", async () => {
      const screener = new DynamicOptionsScreener();
      const result = await screener.screenOptions({
        underlyingSymbols: ["NVDA"],
        contractType: "CALL",
        minDelta: 0.40,
        maxDelta: 0.70,
        minVolume: 100,
      });

      expect(result.status).toBe("matches_found");
      expect(result.contracts.length).toBeGreaterThan(0);
      for (const contract of result.contracts) {
        expect(contract.underlyingSymbol).toBe("NVDA");
        expect(contract.optionType).toBe("CALL");
        expect(contract.delta).toBeGreaterThanOrEqual(0.40);
        expect(contract.delta).toBeLessThanOrEqual(0.70);
        expect(contract.volume).toBeGreaterThanOrEqual(100);
        expect(contract.strikePrice).toBeGreaterThan(0);
        expect(contract.technicalSignal).toBeDefined();
      }
    });

    it("filters PUT options with high implied volatility and near-the-money criteria", async () => {
      const screener = new DynamicOptionsScreener();
      const result = await screener.screenOptions({
        underlyingSymbols: ["TSLA"],
        contractType: "PUT",
        minImpliedVolatility: 0.35,
        maxStrikeDistancePct: 15,
      });

      expect(result.status).toBe("matches_found");
      for (const contract of result.contracts) {
        expect(contract.underlyingSymbol).toBe("TSLA");
        expect(contract.optionType).toBe("PUT");
        expect(contract.impliedVolatility).toBeGreaterThanOrEqual(0.35);
        expect(contract.strikeDistancePct).toBeLessThanOrEqual(15);
      }
    });

    it("evaluates DTE (Days to Expiration) boundary filters correctly", async () => {
      const screener = new DynamicOptionsScreener();
      // Should find matches within reasonable window
      const result = await screener.screenOptions({
        underlyingSymbols: ["AAPL"],
        minDte: 5,
        maxDte: 90,
      });

      expect(result.status).toBe("matches_found");
      for (const contract of result.contracts) {
        expect(contract.daysToExpiration).toBeGreaterThanOrEqual(5);
        expect(contract.daysToExpiration).toBeLessThanOrEqual(90);
        expect(contract.spreadPct).toBeLessThanOrEqual(10);
        expect(contract.quoteAgeSeconds).toBeLessThanOrEqual(60);
      }
    });

    it("fetches every expiration inside the default 14-60 DTE window", async () => {
      const expirationFor = (days: number) => {
        const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
      };
      const eligibleExpiry = expirationFor(30);
      const chain: ETradeOptionChain = {
        symbol: "MULTI",
        underlyingPrice: 100,
        selectedExpiry: eligibleExpiry,
        pairs: [{
          call: {
            timeStamp: Date.now(),
            adjustedFlag: false,
            optionType: "CALL",
            strikePrice: 100,
            symbol: "MULTITESTC100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 500,
            openInterest: 1000,
            delta: 0.5,
            impliedVolatility: 0.3,
          },
        }],
      };
      const client = {
        getOptionExpireDates: vi.fn(async () => [expirationFor(10), eligibleExpiry, expirationFor(70)]),
        getOptionChains: vi.fn(async () => chain),
      } as unknown as ETradeRestClient;

      const result = await new DynamicOptionsScreener(client).screenOptions({
        underlyingSymbols: ["MULTI"],
        contractType: "CALL",
        minDte: 14,
        maxDte: 60,
      });

      expect(result.status).toBe("matches_found");
      expect(result.totalUnderlyingsScanned).toBe(1);
      expect(result.contracts[0].daysToExpiration).toBeGreaterThanOrEqual(14);
      expect(result.contracts[0].daysToExpiration).toBeLessThanOrEqual(60);
      expect(client.getOptionChains).toHaveBeenCalledTimes(1);
      expect(client.getOptionChains).toHaveBeenCalledWith({
        symbol: "MULTI",
        expiryYear: eligibleExpiry.year,
        expiryMonth: eligibleExpiry.month,
        expiryDay: eligibleExpiry.day,
        includeWeekly: true,
      });
    });

    it("returns stale quotes marked stale while rejecting adjusted, crossed, zero-bid, and wide quotes", () => {
      const screener = new DynamicOptionsScreener();
      const chain = screener.fetchChainForSymbolSync("NVDA")!;
      const baseCall = chain.pairs[0].call!;
      DynamicOptionsScreener.setTestChainsFixture({
        NVDA: {
          ...chain,
          pairs: [
            { call: { ...baseCall, symbol: "ZERO_BID", bid: 0 } },
            { call: { ...baseCall, symbol: "CROSSED", bid: 2.3, ask: 2.2 } },
            { call: { ...baseCall, symbol: "WIDE", bid: 1, ask: 1.5 } },
            { call: { ...baseCall, symbol: "ADJUSTED", adjustedFlag: true } },
            { call: { ...baseCall, symbol: "STALE", timeStamp: Date.now() - 120_000 } },
          ],
        },
      });

      const result = screener.screenOptionsSync({
        underlyingSymbols: ["NVDA"],
        contractType: "CALL",
        maxSpreadPct: 10,
        maxQuoteAgeSeconds: 60,
      });

      expect(result.contracts).toHaveLength(1);
      expect(result.contracts[0].symbol).toBe("STALE");
      expect(result.contracts[0].quoteFreshness).toBe("STALE");
      expect(result.rejections?.map((item) => item.reason).join(" ")).toMatch(/Invalid bid\/ask/);
      expect(result.rejections?.map((item) => item.reason).join(" ")).toContain("Spread");
      expect(result.rejections?.map((item) => item.reason).join(" ")).toContain("Adjusted");
      expect(result.quoteQuality?.staleContractsReturned).toBe(1);
      expect(result.quoteQuality?.freshestStaleQuoteAgeSeconds).toBeGreaterThanOrEqual(120);
    });

    it("filters contracts by live Gamma and Theta values", async () => {
      const result = await new DynamicOptionsScreener().screenOptions({
        underlyingSymbols: ["NVDA"],
        contractType: "CALL",
        minGamma: 0.03,
        maxGamma: 0.05,
        minTheta: -0.1,
        maxTheta: -0.01,
      });

      expect(result.status).toBe("matches_found");
      expect(result.contracts[0].gamma).toBe(0.04);
      expect(result.contracts[0].theta).toBe(-0.06);
    });

    it("returns 'no_matches' with rejections when criteria are impossibly strict", async () => {
      const screener = new DynamicOptionsScreener();
      const result = await screener.screenOptions({
        underlyingSymbols: ["MSFT"],
        minVolume: 10000000, // Impossibly high volume
      });

      expect(result.status).toBe("no_matches");
      expect(result.contracts.length).toBe(0);
      expect(result.rejections).toBeDefined();
      expect(result.rejections!.length).toBeGreaterThan(0);
      expect(result.rejections![0].reason).toContain("below minimum");
    });

    it("does not invent a sector universe when E*TRADE discovery is unavailable", async () => {
      const screener = new DynamicOptionsScreener();
      const result = await screener.screenOptions({
        sector: "Technology",
        contractType: "CALL",
        minDelta: 0.30,
        limit: 10,
      });

      expect(result.status).toBe("error");
      expect(result.validationError).toContain("sector");
      expect(result.contracts).toHaveLength(0);
      expect(result.totalUnderlyingsScanned).toBe(0);
    });

    it("discovers option underlyings from all live listings and applies the visible cap", async () => {
      DynamicOptionsScreener.clearTestChainsFixture();
      const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const chain: ETradeOptionChain = {
        symbol: "LIVE",
        underlyingPrice: 100,
        selectedExpiry: {
          year: expiryDate.getUTCFullYear(),
          month: expiryDate.getUTCMonth() + 1,
          day: expiryDate.getUTCDate(),
        },
        pairs: [{
          call: {
            timeStamp: Date.now(),
            adjustedFlag: false,
            optionType: "CALL",
            strikePrice: 100,
            symbol: "LIVETESTC100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 500,
            openInterest: 1000,
            delta: 0.5,
            impliedVolatility: 0.3,
          },
        }],
      };
      const client = {
        getOptionChains: vi.fn(async () => chain),
      } as unknown as ETradeRestClient;
      const listings: NasdaqStockListing[] = [
        { symbol: "LIVE", companyName: "Live Corp", exchange: "nasdaq", lastPrice: 100, change: 1, changePercent: 1 },
        { symbol: "BANK", companyName: "Bank Corp", exchange: "nyse", lastPrice: 100, change: -1, changePercent: -1 },
      ];
      DynamicOptionsScreener.setTestListingsFixture(listings);

      const result = await new DynamicOptionsScreener(client).screenOptions({
        maxUnderlyings: 1,
        contractType: "CALL",
        minDte: 14,
        maxDte: 60,
      });
      expect(result.status).toBe("matches_found");
      expect(result.totalUnderlyingsScanned).toBe(1);
      // Discovery is deterministic: symbols are sorted alphabetically, so BANK (not LIVE)
      // is the first symbol under the cap of 1.
      expect(result.contracts[0].underlyingSymbol).toBe("BANK");
      expect(client.getOptionChains).toHaveBeenCalledWith({ symbol: "BANK" });
    });

    it("uses deterministic test fixtures when injected via setTestChainsFixture", async () => {
      const mockChain: ETradeOptionChain = {
        symbol: "CUSTOM",
        underlyingPrice: 100,
        selectedExpiry: { year: 2026, month: 11, day: 20 },
        pairs: [
          {
            call: {
              timeStamp: Date.now(),
              adjustedFlag: false,
              optionType: "CALL",
              strikePrice: 105,
              symbol: "CUSTOM261120C105000",
              bid: 4.5,
              ask: 4.7,
              lastPrice: 4.6,
              volume: 5000,
              openInterest: 2000,
              delta: 0.52,
              impliedVolatility: 0.38,
            },
          },
        ],
      };

      DynamicOptionsScreener.setTestChainsFixture({ CUSTOM: mockChain });
      const screener = new DynamicOptionsScreener();
      const res = screener.screenOptionsSync({ underlyingSymbols: ["CUSTOM"] });

      expect(res.status).toBe("matches_found");
      expect(res.contracts.length).toBe(1);
      expect(res.contracts[0].symbol).toBe("CUSTOM261120C105000");
      expect(res.contracts[0].volumeOiRatio).toBe(2.5); // 5000 / 2000 = 2.5x unusual volume!
      expect(res.contracts[0].technicalSignal).toContain("Unusual Volume Spike");
    });

    it("filters contracts by option premium (bid/ask midpoint)", async () => {
      const screener = new DynamicOptionsScreener();
      // Fixture NVDA call: bid 4.5 / ask 4.7 -> midpoint 4.6.
      const inside = await screener.screenOptions({
        underlyingSymbols: ["NVDA"],
        contractType: "CALL",
        minPrice: 4,
        maxPrice: 5,
      });
      expect(inside.status).toBe("matches_found");
      expect(inside.contracts.length).toBeGreaterThan(0);

      const tooCheap = await screener.screenOptions({
        underlyingSymbols: ["NVDA"],
        contractType: "CALL",
        maxPrice: 4.0,
      });
      expect(tooCheap.status).toBe("no_matches");
      expect(tooCheap.rejections?.[0].code).toBe("PREMIUM_OUT_OF_RANGE");

      const tooDear = await screener.screenOptions({
        underlyingSymbols: ["NVDA"],
        contractType: "CALL",
        minPrice: 10,
      });
      expect(tooDear.status).toBe("no_matches");
      expect(tooDear.rejections?.[0].code).toBe("PREMIUM_OUT_OF_RANGE");
    });

    it("sanitizes invalid filter inputs instead of silently matching nothing", () => {
      const { filter, warnings } = sanitizeOptionScreenerFilter({
        minDte: Number("not-a-number"),
        maxSpreadPct: Number.POSITIVE_INFINITY,
        contractType: "SIDEWAYS",
        moneyness: "SIDEWAYS",
        sortBy: "vibes",
        maxUnderlyings: 10_000,
        limit: 99_999,
      } as never);

      expect(filter.minDte).toBe(0);
      expect(filter.maxDte).toBe(DEFAULT_MAX_DTE);
      expect(filter.maxSpreadPct).toBeUndefined();
      expect(filter.contractType).toBeUndefined();
      expect(filter.moneyness).toBeUndefined();
      expect(filter.sortBy).toBeUndefined();
      expect(filter.maxUnderlyings).toBe(MAX_SCAN_SYMBOLS);
      expect(filter.limit).toBe(MAX_RETURNED_CONTRACTS);
      expect(warnings.join(" ")).toContain("Ignored invalid numeric filter 'minDte'");
      expect(warnings.join(" ")).toContain("maxUnderlyings capped");
      expect(warnings.join(" ")).toContain("No DTE window supplied");
    });

    it("swaps inverted min/max bounds with a warning", () => {
      const { filter, warnings } = sanitizeOptionScreenerFilter({ minDte: 60, maxDte: 14 });
      expect(filter.minDte).toBe(14);
      expect(filter.maxDte).toBe(60);
      expect(warnings.join(" ")).toContain("Swapped inverted");
    });

    it("reports status error with fetchErrors when all upstream fetches fail", async () => {
      const client = {
        getOptionExpireDates: vi.fn(async () => { throw new Error("upstream down"); }),
        getOptionChains: vi.fn(async () => null),
      } as unknown as ETradeRestClient;
      const result = await new DynamicOptionsScreener(client).screenOptions({
        underlyingSymbols: ["BROKEN"],
        minDte: 0,
        maxDte: 90,
      });
      expect(result.status).toBe("error");
      expect(result.contracts).toHaveLength(0);
      expect(result.fetchErrors?.[0]?.symbol).toBe("BROKEN");
      expect(result.fetchErrors?.[0]?.reason).toContain("upstream down");
    });

    it("caps discovered underlyings at the scan limit with a warning", async () => {
      const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const expiry = {
        year: expiryDate.getUTCFullYear(),
        month: expiryDate.getUTCMonth() + 1,
        day: expiryDate.getUTCDate(),
      };
      const chain: ETradeOptionChain = {
        symbol: "CAPPED",
        underlyingPrice: 100,
        selectedExpiry: expiry,
        pairs: [{
          call: {
            timeStamp: Date.now(),
            adjustedFlag: false,
            optionType: "CALL",
            strikePrice: 100,
            symbol: "CAPPEDTESTC100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 500,
            openInterest: 1000,
            delta: 0.5,
            impliedVolatility: 0.3,
          },
        }],
      };
      const client = {
        getOptionExpireDates: vi.fn(async () => [expiry]),
        getOptionChains: vi.fn(async () => chain),
      } as unknown as ETradeRestClient;
      const listings: NasdaqStockListing[] = Array.from({ length: 25 }, (_, i) => ({
        symbol: `SYM${String(i + 1).padStart(2, "0")}`,
        companyName: `Capped Corp ${i + 1}`,
        exchange: "nasdaq" as const,
        lastPrice: 100,
        change: 0,
        changePercent: 0,
      }));
      DynamicOptionsScreener.setTestListingsFixture(listings);

      // This test pins the symbol hard cap specifically; give the test
      // client enough fetch budget to reach that cap after #1545 lowered
      // the production default for Workers Free.
      const result = await new DynamicOptionsScreener(client, { subrequestBudget: 100 }).screenOptions({
        maxUnderlyings: 100,
        contractType: "CALL",
        minDte: 0,
        maxDte: 90,
      });
      expect(result.totalUnderlyingsScanned).toBe(MAX_SCAN_SYMBOLS);
      expect(result.filterApplied.maxUnderlyings).toBe(MAX_SCAN_SYMBOLS);
      expect(client.getOptionChains).toHaveBeenCalledTimes(MAX_SCAN_SYMBOLS);
      expect(result.warnings?.join(" ")).toContain("maxUnderlyings capped");
    });

    it("sorts by spread ascending when sortBy is spreadPct", () => {
      const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const expiry = {
        year: expiryDate.getUTCFullYear(),
        month: expiryDate.getUTCMonth() + 1,
        day: expiryDate.getUTCDate(),
      };
      const makeLeg = (symbol: string, bid: number, ask: number, volume: number) => ({
        timeStamp: Date.now(),
        adjustedFlag: false,
        optionType: "CALL" as const,
        strikePrice: 100,
        symbol,
        bid,
        ask,
        lastPrice: (bid + ask) / 2,
        volume,
        openInterest: 1000,
        delta: 0.5,
        impliedVolatility: 0.3,
      });
      DynamicOptionsScreener.setTestChainsFixture({
        SORT: {
          symbol: "SORT",
          underlyingPrice: 100,
          selectedExpiry: expiry,
          pairs: [
            { call: makeLeg("WIDE", 1, 1.5, 9000) },
            { call: makeLeg("TIGHT", 4, 4.05, 100) },
          ],
        },
      });

      const byVolume = new DynamicOptionsScreener().screenOptionsSync({
        underlyingSymbols: ["SORT"],
        contractType: "CALL",
      });
      expect(byVolume.contracts.map((c) => c.symbol)).toEqual(["WIDE", "TIGHT"]);

      const bySpread = new DynamicOptionsScreener().screenOptionsSync({
        underlyingSymbols: ["SORT"],
        contractType: "CALL",
        sortBy: "spreadPct",
      });
      expect(bySpread.contracts.map((c) => c.symbol)).toEqual(["TIGHT", "WIDE"]);
      expect(bySpread.contracts[0].spreadPct).toBeLessThan(bySpread.contracts[1].spreadPct);
    });

    it("counts every rejection and tags machine-readable codes", async () => {
      const result = await new DynamicOptionsScreener().screenOptions({
        underlyingSymbols: ["MSFT"],
        minVolume: 10000000, // Impossibly high volume
      });
      expect(result.status).toBe("no_matches");
      expect(result.rejectionCount).toBe(2);
      expect(result.rejections).toHaveLength(2);
      for (const rejection of result.rejections || []) {
        expect(rejection.code).toBe("VOLUME_TOO_LOW");
        expect(rejection.reason).toContain("below minimum");
      }
    });

    it("reports total matches and a truncation warning when limited", async () => {
      const result = await new DynamicOptionsScreener().screenOptions({
        underlyingSymbols: ["NVDA"],
        limit: 1,
      });
      expect(result.status).toBe("matches_found");
      expect(result.matchedCount).toBe(1);
      expect(result.totalMatches).toBe(2);
      expect(result.warnings?.join(" ")).toContain("Returned 1 of 2");
    });

    it("applies a default DTE window when none is supplied", async () => {
      const result = await new DynamicOptionsScreener().screenOptions({
        underlyingSymbols: ["NVDA"],
        contractType: "CALL",
        minDelta: 0.4,
      });
      expect(result.status).toBe("matches_found");
      expect(result.filterApplied.minDte).toBe(0);
      expect(result.filterApplied.maxDte).toBe(DEFAULT_MAX_DTE);
      expect(result.warnings?.join(" ")).toContain("DTE");
    });

    it("rejects synchronous screens without explicit symbols", () => {
      const result = new DynamicOptionsScreener().screenOptionsSync({});
      expect(result.status).toBe("error");
      expect(result.validationError).toContain("explicit underlying symbols");
    });
  });

  // =========================================================================
  // 2. E*TRADE Watchlist API Client Endpoints
  // =========================================================================
  describe("ETradeRestClient Watchlist API", () => {
    it("parses symbols from the live market-movers endpoint", async () => {
      const client = new ETradeRestClient(mockEnv, "test_user");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          MarketMoversResponse: {
            MarketMover: [
              { Product: { symbol: "abc" } },
              { Product: { symbol: "XYZ" } },
              { Product: { symbol: "ABC" } },
            ],
          },
        }),
      } as any);

      const symbols = await client.getMarketMovers("active");
      expect(symbols).toEqual(["ABC", "XYZ"]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/market/movers/active"),
        expect.any(Object)
      );
    });

    it("handles getWatchlists via authentic E*TRADE REST endpoints", async () => {
      const client = new ETradeRestClient(mockEnv, "test_user");
      const mockWatchlists = {
        WatchlistResponse: {
          watchlist: [
            {
              watchlistId: 1001,
              name: "Tech Giants",
              items: {
                item: [{ symbol: "NVDA" }, { symbol: "AAPL" }, { symbol: "MSFT" }],
              },
            },
          ],
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockWatchlists,
      } as any);

      const lists = await client.getWatchlists();
      expect(lists.length).toBe(1);
      expect(lists[0].name).toBe("Tech Giants");
      expect(lists[0].symbols).toEqual(["NVDA", "AAPL", "MSFT"]);
    });

    it("handles createWatchlist with signed OAuth and valid payload", async () => {
      const client = new ETradeRestClient(mockEnv, "test_user");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          CreateWatchlistResponse: {
            watchlistId: 2002,
          },
        }),
      } as any);

      const res = await client.createWatchlist({
        name: "Oversold Tech",
        symbols: ["NVDA", "INTC", "CRM"],
      });

      expect(res.success).toBe(true);
      expect(res.watchlistId).toBe(2002);
      expect(res.name).toBe("Oversold Tech");
      expect(res.symbols).toEqual(["NVDA", "INTC", "CRM"]);
    });

    it("handles addWatchlistItems to append new symbols", async () => {
      const client = new ETradeRestClient(mockEnv, "test_user");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as any);

      const res = await client.addWatchlistItems({
        watchlistId: 2002,
        symbols: ["AMD", "AVGO"],
      });

      expect(res.success).toBe(true);
      expect(res.symbolsAdded).toEqual(["AMD", "AVGO"]);
    });

    it("handles deleteWatchlist with DELETE method", async () => {
      const client = new ETradeRestClient(mockEnv, "test_user");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({}),
      } as any);

      const deleted = await client.deleteWatchlist(2002);
      expect(deleted).toBe(true);
    });
  });

  // =========================================================================
  // 3. Durable SQLite Watchlist Persistence & ETradeService
  // =========================================================================
  describe("ETradeService & Durable SQLite Watchlist Persistence", () => {
    it("durably saves screener results as a watchlist in local SQLite and records audit event", async () => {
      const etrade = new ETradeService(orm, mockEnv, "trader_alice");

      // Mock client createWatchlist so it simulates successful API call
      vi.spyOn(etrade.client, "createWatchlist").mockResolvedValue({
        success: true,
        watchlistId: "et_wl_9981",
        name: "Tech Momentum",
        symbols: ["NVDA", "PLTR", "AVGO"],
      });

      const res = await etrade.saveScanAsWatchlist("Tech Momentum", ["NVDA", "PLTR", "AVGO"]);

      expect(res.success).toBe(true);
      expect(res.name).toBe("Tech Momentum");
      expect(res.symbols).toEqual(["NVDA", "PLTR", "AVGO"]);
      expect(res.source).toBe("etrade_api");

      // Verify stored in local SQLite ORM
      const savedInDb = orm.getWatchlistByName("Tech Momentum", "trader_alice");
      expect(savedInDb).not.toBeNull();
      expect(JSON.parse(savedInDb!.symbolsJson)).toEqual(["NVDA", "PLTR", "AVGO"]);

      // Verify audit event recorded
      const events = orm.events.findMany({ where: { type: "WATCHLIST_SAVED" } });
      expect(events.length).toBeGreaterThan(0);
      // #2178 S1: stored payload is JSON text — parse the stored form.
      expect((JSON.parse(events[0].payload as unknown as string) as any).name).toBe("Tech Momentum");
    });

    it("merges remote E*TRADE watchlists and local SQLite watchlists seamlessly", async () => {
      const etrade = new ETradeService(orm, mockEnv, "trader_bob");

      // Add a local watchlist
      orm.saveWatchlist({
        name: "Local Pullbacks",
        userLogin: "trader_bob",
        symbols: ["AAPL", "MSFT"],
        source: "local_durable_sqlite",
      });

      // Mock remote watchlist from E*TRADE
      vi.spyOn(etrade.client, "getWatchlists").mockResolvedValue([
        {
          watchlistId: 8877,
          name: "Remote Dividends",
          symbols: ["JNJ", "PG"],
          source: "etrade_api",
        },
      ]);

      const all = await etrade.getWatchlists();
      expect(all.length).toBe(2);
      expect(all.some((w) => w.name === "Local Pullbacks")).toBe(true);
      expect(all.some((w) => w.name === "Remote Dividends")).toBe(true);
    });
  });

  // =========================================================================
  // 4. Natural Language Queries (NLQ) for Options & Watchlists
  // =========================================================================
  describe("NLQ Engine: Options Scanning & Watchlist Commands", () => {
    it("routes broad natural-language option screens to dynamic discovery", async () => {
      const plan = await planNLQ(
        mockEnv,
        "Screen liquid call options with delta above 0.35 and 20 to 45 DTE"
      );

      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("options_screen");
      expect(plan.tradingData?.filters?.underlyingSymbols).toBeUndefined();
      expect(plan.tradingData?.filters?.minDelta).toBe(0.35);
      expect(plan.tradingData?.filters?.minDte).toBe(20);
      expect(plan.tradingData?.filters?.maxDte).toBe(45);
    });

    it("parses Gamma, Theta, and DTE bounds from options scan requests", async () => {
      const plan = await planNLQ(
        mockEnv,
        "Screen call options for NVDA with gamma above 0.04 and theta below -0.05 within 5 to 30 DTE"
      );

      expect(plan.tradingData?.filters?.minGamma).toBe(0.04);
      expect(plan.tradingData?.filters?.maxTheta).toBe(-0.05);
      expect(plan.tradingData?.filters?.minDte).toBe(5);
      expect(plan.tradingData?.filters?.maxDte).toBe(30);
    });

    it("parses visible liquidity, spread, quote-age, underlying, and result limits", async () => {
      const plan = await planNLQ(
        mockEnv,
        "Screen call options with 20 to 45 DTE, volume over 100, open interest above 500, spread under 8%, quote age under 90 seconds, scan up to 7 underlyings, top 40 contracts"
      );

      expect(plan.tradingData?.action).toBe("options_screen");
      expect(plan.tradingData?.filters?.minDte).toBe(20);
      expect(plan.tradingData?.filters?.maxDte).toBe(45);
      expect(plan.tradingData?.filters?.minVolume).toBe(100);
      expect(plan.tradingData?.filters?.minOpenInterest).toBe(500);
      expect(plan.tradingData?.filters?.maxSpreadPct).toBe(8);
      expect(plan.tradingData?.filters?.maxQuoteAgeSeconds).toBe(90);
      expect(plan.tradingData?.filters?.maxUnderlyings).toBe(7);
      expect(plan.tradingData?.filters?.limit).toBe(40);
      expect(plan.tradingData?.filters?.underlyingSymbols).toBeUndefined();
    });

    it("plans and executes options screening query via NLQ", async () => {
      const query = "Screen call options for NVDA with delta over 0.40";
      const plan = await planNLQ(mockEnv, query);

      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("options_screen");
      expect(plan.tradingData?.filters?.contractType).toBe("CALL");
      expect(plan.tradingData?.filters?.minDelta).toBe(0.40);
      expect(plan.tradingData?.filters?.underlyingSymbols).toEqual(["NVDA"]);

      const res = await executeNLQQueryAsync(orm, "trader_user", plan, mockEnv, "trader_user");
      expect(res.domain).toBe("trading");
      expect(res.targetTable).toBe("etrade_options_screener");
      expect(res.count).toBeGreaterThan(0);
      expect(res.rows[0].underlying).toBe("NVDA");
      expect(res.rows[0].type).toBe("CALL");
    });

    it("plans and executes saving screened results to a named watchlist via NLQ", async () => {
      const query = "Save these screened stocks to watchlist Tech Winners";
      const plan = await planNLQ(mockEnv, query);

      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("watchlist_save");
      expect(plan.tradingData?.watchlistName).toBe("Tech Winners");

      const res = await executeNLQQueryAsync(orm, "trader_user", plan, mockEnv, "trader_user");
      expect(res.domain).toBe("trading");
      expect(res.targetTable).toBe("mas_watchlists");
      expect(res.summary).toContain("Tech Winners");
      expect(res.rows[0].status).toBe("SAVED");
    });

    it("plans and executes listing saved watchlists via NLQ", async () => {
      // Seed a watchlist
      orm.saveWatchlist({
        name: "AI Portfolio",
        userLogin: "trader_user",
        symbols: ["NVDA", "MSFT", "AMD"],
        source: "local_durable_sqlite",
      });

      const query = "Show my watchlists";
      const plan = await planNLQ(mockEnv, query);

      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("watchlist_list");

      const res = await executeNLQQueryAsync(orm, "trader_user", plan, mockEnv, "trader_user");
      expect(res.count).toBeGreaterThan(0);
      expect(res.rows.some((r) => r.name === "AI Portfolio")).toBe(true);
    });
  });

  // =========================================================================
  // 5. Voice Trading Agent: Options Screener & Watchlists
  // =========================================================================
  describe("ETradeVoiceTradingService: Verbal Options & Watchlists", () => {
    it("handles verbal options screening query and returns spoken audio script & markdown table", async () => {
      const voiceAgent = new ETradeVoiceTradingService(orm, mockEnv, "voice_session_1");

      const turn = await voiceAgent.processVoiceTurn({
        rawTranscript: "Screen call options on NVDA with delta above zero point four zero",
        authorizerDid: "did:key:user_voice",
      });

      expect(turn.success).toBe(true);
      expect(turn.actionType).toBe("options_screener");
      expect(turn.spokenText).toContain("option contracts");
      expect(turn.displayMarkdown).toContain("E*TRADE Options Screener");
      expect(turn.displayMarkdown).toContain("NVDA");
    });

    it("handles verbal watchlist saving and confirms persistence aloud", async () => {
      const voiceAgent = new ETradeVoiceTradingService(orm, mockEnv, "voice_session_2");

      const turn = await voiceAgent.processVoiceTurn({
        rawTranscript: "Save these stocks as watchlist Semiconductor Pullbacks",
        authorizerDid: "did:key:user_voice",
      });

      expect(turn.success).toBe(true);
      expect(turn.actionType).toBe("watchlist");
      expect(turn.spokenText).toContain("Semiconductor Pullbacks");
      expect(turn.displayMarkdown).toContain("E*TRADE Watchlists");
    });
  });
});
