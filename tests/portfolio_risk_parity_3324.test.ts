/**
 * Issue #3324: portfolio risk is one model, fed by the selected broker.
 *
 * These tests defend the parity claim that #3296 could not make:
 *   1. An Alpaca option position is resolvable — its OCC symbol carries the
 *      contract detail Alpaca's payload omits.
 *   2. The model runs on a neutral source, so the SAME aggregation serves both
 *      brokers and cannot read one broker's chain for another's book.
 *   3. The neutral route serves Alpaca and names it; a broker the catalogue says
 *      cannot risk-report answers 501 before any platform is constructed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

// The beta service fetches price history; every scenario here states its own
// resolution so no test depends on the network.
vi.mock("../src/services/betaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/betaService")>();
  return {
    ...actual,
    sharedBetaService: {
      resolve: async () => ({ beta: 1.2, source: "computed-live", observations: 250, asOf: "2026-11-05T00:00:00.000Z" }),
    },
  };
});

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));

import { parseOccSymbol } from "../src/trading/alpaca/occSymbol";
import { mapAlpacaPosition } from "../src/trading/alpaca/platform";
import { platformPortfolioRiskSource } from "../src/trading/portfolioRiskSource";
import { computePortfolioRisk } from "../src/services/portfolioRisk";
import { BROKER_CATALOG, brokerSupports } from "../src/trading/brokerCatalog";
import { handleBrokerRiskRoutes, type BrokerRiskRouteContext } from "../src/agents/routes/brokerRisk";
import { TradingPlatformRegistry } from "../src/trading/registry";

describe("an Alpaca option position carries its contract detail (#3324)", () => {
  it("parses a call from the end of the OCC symbol", () => {
    expect(parseOccSymbol("AAPL260116C00150000")).toEqual({
      root: "AAPL",
      expirationDate: "2026-01-16",
      optionType: "CALL",
      strikePrice: 150,
    });
  });

  it("parses a put with a fractional-free strike", () => {
    expect(parseOccSymbol("SPY261218P00432500")).toMatchObject({
      root: "SPY",
      optionType: "PUT",
      strikePrice: 432.5,
    });
  });

  it("parses an adjusted root that ends in a digit", () => {
    // Reading left-to-right would mistake "AAPL1" for part of the date.
    expect(parseOccSymbol("AAPL1260116C00150000")).toMatchObject({ root: "AAPL1", strikePrice: 150 });
  });

  it("refuses a symbol that is not an OCC option rather than guessing", () => {
    expect(parseOccSymbol("AAPL")).toBeNull();
    expect(parseOccSymbol("AAPL26011XC00150000")).toBeNull();
    expect(parseOccSymbol("")).toBeNull();
  });

  it("maps an Alpaca option position into the neutral option fields", () => {
    const position = mapAlpacaPosition({
      symbol: "AAPL260116C00150000",
      asset_class: "us_option",
      qty: "2",
      side: "long",
      avg_entry_price: "5.10",
      cost_basis: "1020",
      current_price: "6.20",
      market_value: "1240",
      unrealized_pl: "220",
      unrealized_plpc: "0.2157",
    });
    expect(position.securityType).toBe("OPTN");
    expect(position.optionType).toBe("CALL");
    expect(position.strikePrice).toBe(150);
    expect(position.expirationDate).toBe("2026-01-16");
  });

  it("leaves an equity position without option fields", () => {
    const position = mapAlpacaPosition({
      symbol: "AAPL",
      asset_class: "us_equity",
      qty: "10",
      side: "long",
      avg_entry_price: "180",
      cost_basis: "1800",
      current_price: "190",
      market_value: "1900",
      unrealized_pl: "100",
      unrealized_plpc: "0.0555",
    });
    expect(position.securityType).toBe("EQ");
    expect(position.optionType).toBeUndefined();
  });
});

describe("the risk model runs on the selected broker's book (#3324)", () => {
  it("resolves Alpaca option Greeks and includes them in the totals", async () => {
    const platform = {
      getPositions: async () => ({
        account: { accountId: "a1", accountKey: "a1", accountDesc: "Alpaca", accountType: "MARGIN", netAccountValue: 100000 },
        positions: [
          mapAlpacaPosition({
            symbol: "AAPL260116C00150000",
            asset_class: "us_option",
            qty: "2",
            side: "long",
            avg_entry_price: "5.10",
            cost_basis: "1020",
            current_price: "6.20",
            market_value: "1240",
            unrealized_pl: "220",
            unrealized_plpc: "0.2157",
          }),
        ],
      }),
      getOptionChains: async () => ({
        symbol: "AAPL",
        underlyingPrice: 190,
        pairs: [
          {
            call: {
              optionType: "CALL",
              strikePrice: 150,
              symbol: "AAPL260116C00150000",
              bid: 40,
              ask: 40.4,
              lastPrice: 40.2,
              delta: 0.9,
              gamma: 0.01,
              theta: -0.02,
              vega: 0.1,
              rho: 0.01,
            },
          },
        ],
      }),
      getQuote: async () => ({ symbol: "SPY", lastPrice: 600 }),
    } as any;

    const source = platformPortfolioRiskSource(platform);
    expect(source).not.toBeNull();
    const report = await computePortfolioRisk(source!);

    expect(report.rows).toHaveLength(1);
    // 2 contracts × 100 × 0.9 delta = 180 shares.
    expect(report.totals.deltaShares).toBeCloseTo(180, 2);
    expect(report.excluded).toHaveLength(0);
    expect(report.spyPrice).toBe(600);
  });

  it("a platform without a chain read is not a risk source", () => {
    expect(platformPortfolioRiskSource({ getPositions: async () => ({ account: {}, positions: [] }), getQuote: async () => ({}) } as any)).toBeNull();
  });

  it("Alpaca declares the capability it now has", () => {
    expect(brokerSupports("alpaca", "portfolioRisk")).toBe(true);
    expect(brokerSupports("etrade", "portfolioRisk")).toBe(true);
    expect(typeof BROKER_CATALOG.alpaca.supports.portfolioRisk).toBe("boolean");
  });
});

describe("/broker/portfolio-risk serves the selected broker (#3324)", () => {
  const BASE = "https://example.test/api";
  const platform = {
    getPositions: vi.fn(async () => ({
      account: { accountId: "a1", accountKey: "a1", accountDesc: "Alpaca Paper", accountType: "MARGIN", netAccountValue: 50000 },
      positions: [{ symbol: "AAPL", description: "Apple", quantity: 10, pricePaid: 180, costBasis: 1800, currentPrice: 190, marketPrice: 190 }],
    })),
    getOptionChains: vi.fn(async () => null),
    getQuote: vi.fn(async () => ({ symbol: "SPY", lastPrice: 600 })),
  };

  function ctx(vars: Record<string, string> = { FEATURE_BROKER_PANEL_CONTRACT: "1" }): BrokerRiskRouteContext {
    return {
      env: { APP_ENV: "TEST", ...vars } as any,
      getOrm: () => undefined,
      readSettingRaw: (key: string) => (key === "etrade:environment" ? "TEST" : null),
    };
  }

  function req(path: string, method = "GET", body?: unknown) {
    const url = new URL(`${BASE}${path}`);
    return {
      request: new Request(url.toString(), {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json", "x-user-login": "user-1" } }),
        ...(body === undefined ? { headers: { "x-user-login": "user-1" } } : {}),
      }),
      url,
    };
  }

  let getPlatform: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tenant.broker = "alpaca";
    vi.clearAllMocks();
    getPlatform = vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(() => platform as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not capture other paths", async () => {
    const { request, url } = req("/broker/positions");
    expect(await handleBrokerRiskRoutes(request, url, url.pathname, "sid", ctx())).toBeNull();
  });

  it("reports the Alpaca book and names the broker", async () => {
    const { request, url } = req("/broker/portfolio-risk");
    const res = await handleBrokerRiskRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.environment).toBe("TEST");
    // 10 shares × delta 1 × 190.
    expect(body.totals.deltaShares).toBeCloseTo(10, 2);
    expect(getPlatform.mock.calls[0][0]).toBe("alpaca");
  });

  it("answers 501 by name when the catalogue says no, without constructing a platform", async () => {
    const original = BROKER_CATALOG.alpaca.supports.portfolioRisk;
    try {
      (BROKER_CATALOG.alpaca.supports as { portfolioRisk: boolean }).portfolioRisk = false;
      const { request, url } = req("/broker/portfolio-risk");
      const res = await handleBrokerRiskRoutes(request, url, url.pathname, "sid", ctx());
      expect(res!.status).toBe(501);
      const body = await res!.json();
      expect(body).toMatchObject({ code: "provider_unsupported", broker: "alpaca" });
      expect(getPlatform).not.toHaveBeenCalled();
    } finally {
      (BROKER_CATALOG.alpaca.supports as { portfolioRisk: boolean }).portfolioRisk = original;
    }
  });

  it("requires an identity, because the book is per-user", async () => {
    const url = new URL(`${BASE}/broker/portfolio-risk`);
    const request = new Request(url.toString(), { method: "GET" });
    const res = await handleBrokerRiskRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(401);
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("honours the panel flag before reading anything", async () => {
    const { request, url } = req("/broker/portfolio-risk");
    const res = await handleBrokerRiskRoutes(request, url, url.pathname, "sid", ctx({ FEATURE_BROKER_PANEL_CONTRACT: "0" }));
    expect(res!.status).toBe(503);
    expect(platform.getPositions).not.toHaveBeenCalled();
  });

  it("evaluates a candidate against the same book", async () => {
    const { request, url } = req("/broker/portfolio-risk/evaluate", "POST", {
      candidate: { deltaShares: 100, deltaDollars: 19000, betaWeightedDeltaDollars: 22800, gammaSharesPerDollar: 0, thetaDollarsPerDay: -5, vegaDollarsPerVolPoint: 2, rhoDollarsPerRatePoint: 0, definedMaxLoss: 500 },
    });
    const res = await handleBrokerRiskRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.current).toBeDefined();
    expect(body.postTradeTotals.deltaShares).toBeCloseTo(110, 2);
  });

  it("refuses an evaluate request with no candidate", async () => {
    const { request, url } = req("/broker/portfolio-risk/evaluate", "POST", {});
    const res = await handleBrokerRiskRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(400);
  });
});
