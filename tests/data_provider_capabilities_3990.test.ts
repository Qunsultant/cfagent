/**
 * Issue #3990 — capability matrix: declared == servable.
 *
 * TDD Red: these FAIL on the pre-#3990 tree —
 *  - the Alpaca data adapter declares fundamentals it cannot serve
 *    (its getFundamentals throws; ADR 0019: Yahoo-covered) and does
 *    NOT declare optionsChains, although Alpaca's API provides it and
 *    the repo already implements it (src/trading/alpaca/optionsData.ts);
 *  - the options-gate map is a parallel hand-maintained copy of the
 *    adapter declarations (already stale: news, Yahoo chains);
 *  - the default pair is etrade data + alpaca broker.
 *
 * Green when: the Alpaca adapter declares exactly what it serves
 * (quotes + historicalBars + optionsChains), fundamentals is an
 * opt-in seam (absent by default on Alpaca, present on Yahoo), the
 * gate map equals the adapters' declared capabilities (pinned here),
 * and the default pair is alpaca/alpaca.
 *
 * No live network: the options source is a stub; the default (real)
 * source is exercised only through declaration, never called here.
 */
import { describe, it, expect } from "vitest";
import {
  createAlpacaDataProvider,
  createETradeDataProviderFromEnv,
  createNasdaqDataProvider,
  createPublicDataProviderFromEnv,
  createYahooDataProvider,
} from "../src/trading/dataProviders/adapters";
import { runDataProviderConformance } from "../src/trading/dataProviders/conformance";
import { DATA_PROVIDER_CAPABILITIES } from "../src/trading/dataProviders/contract";
import {
  dataCapabilityUnavailable,
  dataProviderSupportsCapability,
} from "../src/services/optionsProviderContext";
import { DEFAULT_TENANT_PROVIDERS } from "../src/data/commercialPorts";
import { DEFAULT_TENANT_PROVIDERS_STATE } from "../src/client/tenantProviders";
import { AlpacaMarketDataProvider, YahooFinanceProvider } from "../src/services/marketDataResearch";
import type { MarketDataResearchQuote } from "../src/types";
import type { IMarketDataProvider } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

const RUN = { runId: "run-3990", tenantId: "test-tenant", userLogin: "tester" };

function liveQuote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "alpaca",
    provenance: "live",
    companyName: `${symbol} Inc.`,
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    bid: price - 0.05,
    ask: price + 0.05,
    volume: 1000,
    open: price,
    high: price,
    low: price,
    previousClose: price - 1,
    timestamp: "2026-10-24T00:00:00.000Z",
    currency: "USD",
  };
}

function fixtureMarketData(): IMarketDataProvider {
  return {
    providerId: "alpaca",
    name: "fixture",
    isConfigured: () => true,
    getQuote: async (s: string) => liveQuote(s),
    getFundamentals: async (s: string) => ({
      provenance: "live",
      symbol: s,
      companyName: `${s} Inc.`,
      sector: "Technology",
      industry: "Software",
      description: "fixture",
      marketCap: 1_000_000,
      fiftyTwoWeekHigh: 300,
      fiftyTwoWeekLow: 200,
    }),
    getHistoricalBars: async (s: string, _tf?: string, limit?: number) => {
      const n = limit ?? 5;
      return Array.from({ length: n }, (_, i) => ({
        provenance: "live" as const,
        timestamp: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 1000,
      }));
    },
  };
}

const stubChain = {
  symbol: "AAPL",
  underlyingPrice: 100,
  pairs: [
    {
      call: {
        optionType: "CALL",
        strikePrice: 100,
        symbol: "AAPL260320C00100000",
        bid: 1,
        ask: 1.2,
        lastPrice: 1.1,
      },
    },
  ],
};

const stubOptionsChain = {
  getChain: async () => stubChain,
  getExpiryDates: async () => [{ year: 2026, month: 3, day: 20 }],
};

describe("3990: Alpaca data adapter declares exactly what it serves", () => {
  it("declares quotes, historicalBars, optionsChains — and no fundamentals", () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData());
    expect(adapter.id).toBe("alpaca");
    expect([...adapter.capabilities]).toEqual(["quotes", "historicalBars", "optionsChains"]);
  });

  it("has getOptionsChain/getOptionExpiryDates and no getFundamentals by default", () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData());
    expect(typeof adapter.getOptionsChain).toBe("function");
    expect(typeof adapter.getOptionExpiryDates).toBe("function");
    expect(adapter.getFundamentals).toBeUndefined();
  });

  it("getOptionsChain serves the injected source through the tagged envelope", async () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData(), undefined, {
      optionsChain: stubOptionsChain as never,
    });
    const out = await adapter.getOptionsChain!({ symbol: "AAPL", chainType: "CALLPUT" }, RUN);
    expect(out.providerId).toBe("alpaca");
    expect(out.capability).toBe("optionsChains");
    expect(out.result).toEqual(stubChain);
  });

  it("getOptionExpiryDates serves the injected source through the tagged envelope", async () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData(), undefined, {
      optionsChain: stubOptionsChain as never,
    });
    const out = await adapter.getOptionExpiryDates!("AAPL", RUN);
    expect(out.providerId).toBe("alpaca");
    expect(out.capability).toBe("optionsChains");
    expect(out.result).toEqual([{ year: 2026, month: 3, day: 20 }]);
  });

  it("conformance passes over the stubbed options source", async () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData(), undefined, {
      optionsChain: stubOptionsChain as never,
    });
    const report = await runDataProviderConformance(adapter);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.capability)).toEqual([
      "quotes",
      "historicalBars",
      "optionsChains",
    ]);
  });

  it("fundamentals is an opt-in seam: an explicit source declares and serves it", async () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData(), undefined, {
      fundamentals: (async (symbol: string) => ({
        provenance: "live",
        symbol,
        companyName: `${symbol} Inc.`,
        sector: "Technology",
        industry: "Software",
        description: "fixture",
        marketCap: 1_000_000,
        fiftyTwoWeekHigh: 300,
        fiftyTwoWeekLow: 200,
      })) as never,
    });
    expect([...adapter.capabilities]).toEqual([
      "quotes",
      "historicalBars",
      "fundamentals",
      "optionsChains",
    ]);
    const out = await adapter.getFundamentals!("AAPL", RUN);
    expect(out.providerId).toBe("alpaca");
    expect(out.capability).toBe("fundamentals");
    expect((out.result as { symbol: string }).symbol).toBe("AAPL");
  });
});

describe("3990: Yahoo still declares quotes, bars, fundamentals, news", () => {
  it("capabilities are unchanged by the wrapper rework", () => {
    const adapter = createYahooDataProvider(new YahooFinanceProvider({} as Env), {} as Env);
    expect([...adapter.capabilities]).toEqual([
      "quotes",
      "historicalBars",
      "fundamentals",
      "news",
    ]);
    expect(typeof adapter.getFundamentals).toBe("function");
    expect(typeof adapter.getNews).toBe("function");
  });
});

describe("3990: the options-gate map equals the adapters' declared capabilities", () => {
  it("every adapter's declaration matches the gate map, capability by capability", () => {
    const env = {} as Env;
    const adapters = [
      createETradeDataProviderFromEnv(env, "tester"),
      createPublicDataProviderFromEnv(env, "tester"),
      createYahooDataProvider(new YahooFinanceProvider(env), env),
      createNasdaqDataProvider(),
      createAlpacaDataProvider(new AlpacaMarketDataProvider(env), env),
    ];
    expect(adapters.map((a) => a.id).sort()).toEqual([
      "alpaca",
      "etrade",
      "nasdaq",
      "public",
      "yahoo",
    ]);
    for (const adapter of adapters) {
      for (const capability of DATA_PROVIDER_CAPABILITIES) {
        expect(
          dataProviderSupportsCapability(adapter.id, capability),
          `${adapter.id} / ${capability}`
        ).toBe(adapter.capabilities.includes(capability));
      }
    }
  });

  it("alpaca declares optionsChains; yahoo declares news; alpaca declares no fundamentals", () => {
    expect(dataProviderSupportsCapability("alpaca", "optionsChains")).toBe(true);
    expect(dataProviderSupportsCapability("alpaca", "fundamentals")).toBe(false);
    expect(dataProviderSupportsCapability("yahoo", "news")).toBe(true);
    expect(dataProviderSupportsCapability("yahoo", "optionsChains")).toBe(false);
    expect(dataProviderSupportsCapability("etrade", "optionsChains")).toBe(true);
    expect(dataProviderSupportsCapability("public", "optionsChains")).toBe(true);
    expect(dataProviderSupportsCapability("nasdaq", "screenUniverse")).toBe(true);
  });
});

describe("3990: default pair is alpaca data + alpaca broker", () => {
  it("server default and client mirror agree", () => {
    expect(DEFAULT_TENANT_PROVIDERS).toEqual({ dataProviderId: "alpaca", brokerId: "alpaca" });
    expect(DEFAULT_TENANT_PROVIDERS_STATE).toEqual({
      dataProviderId: "alpaca",
      brokerId: "alpaca",
    });
  });

  it("the options gate passes for the default data provider and refuses yahoo/nasdaq by name", () => {
    expect(dataCapabilityUnavailable("alpaca", "optionsChains")).toBeNull();
    expect(dataCapabilityUnavailable("yahoo", "optionsChains")).toEqual({
      code: "FAILURE_DATA_PROVIDER_UNAVAILABLE",
      providerId: "yahoo",
      capability: "optionsChains",
    });
    expect(dataCapabilityUnavailable("nasdaq", "optionsChains")).toEqual({
      code: "FAILURE_DATA_PROVIDER_UNAVAILABLE",
      providerId: "nasdaq",
      capability: "optionsChains",
    });
  });
});

// ── Slice B — taxonomy split (issue #3990) ─────────────────────────────

describe("taxonomy: the kind map splits brokers from pure data providers", () => {
  it("every provider id carries exactly one kind, and the derived lists partition the ids", async () => {
    const { DATA_PROVIDER_IDS, DATA_PROVIDER_KINDS, BROKER_DATA_PROVIDER_IDS, PURE_DATA_PROVIDER_IDS } = await import(
      "../src/trading/dataProviders/contract"
    );
    expect(Object.keys(DATA_PROVIDER_KINDS).sort()).toEqual([...DATA_PROVIDER_IDS].sort());
    expect(DATA_PROVIDER_KINDS.etrade).toBe("broker");
    expect(DATA_PROVIDER_KINDS.public).toBe("broker");
    expect(DATA_PROVIDER_KINDS.alpaca).toBe("broker");
    expect(DATA_PROVIDER_KINDS.yahoo).toBe("pure");
    expect(DATA_PROVIDER_KINDS.nasdaq).toBe("pure");
    expect([...BROKER_DATA_PROVIDER_IDS]).toEqual(["etrade", "public", "alpaca"]);
    expect([...PURE_DATA_PROVIDER_IDS]).toEqual(["yahoo", "nasdaq"]);
    expect([...BROKER_DATA_PROVIDER_IDS, ...PURE_DATA_PROVIDER_IDS].sort()).toEqual([...DATA_PROVIDER_IDS].sort());
  });

  it("the client data-provider options are derived from the same kind map, one entry per id", async () => {
    const { DATA_PROVIDER_OPTIONS } = await import("../src/client/tenantProviders");
    const { DATA_PROVIDER_IDS, DATA_PROVIDER_KINDS } = await import("../src/trading/dataProviders/contract");
    expect(DATA_PROVIDER_OPTIONS.map((o) => o.id).sort()).toEqual([...DATA_PROVIDER_IDS].sort());
    for (const opt of DATA_PROVIDER_OPTIONS) {
      expect(opt.kind).toBe(DATA_PROVIDER_KINDS[opt.id as keyof typeof DATA_PROVIDER_KINDS]);
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("Settings lists data sources under Data provider, with the kind visible, next to the Broker list", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/client/BrokerDynamicMenu.tsx", "utf8");
    expect(src).toContain("DATA_PROVIDER_OPTIONS");
    expect(src).toContain("Data provider");
    expect(src).toContain("handleSetTenantProviders({ ...tenantProviders, dataProviderId: v })");
  });
});
