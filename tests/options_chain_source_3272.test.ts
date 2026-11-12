/**
 * Issue #3272 (S1): the option chain source port.
 *
 * What these tests defend:
 *   1. `DynamicOptionsScreener` no longer knows E*TRADE exists — a structural
 *      test fails if the client import returns.
 *   2. Any source drives the screener: the same orchestration runs over a
 *      stub Alpaca platform and over a plain test double.
 *   3. A platform without an options data plane adapts to `null`, so the
 *      caller must refuse the surface — never an empty result.
 *   4. The neutral route serves the SELECTED broker's chains and keeps the
 *      `/broker/options/*` honesty rules (501 naming the broker).
 *
 * Fixture note: expiries must sit inside the default 0–90 day window,
 * otherwise the screener correctly fetches no chains and this suite would
 * prove nothing. Today is fixed at the test run; the window is relative, so
 * the fixture date is computed from "now" rather than hardcoded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { isOptionChainSource, platformChainSource, type OptionChainSource } from "../src/trading/optionChainSource";
import type { BrokerOptionChain, BrokerOptionExpireDate } from "../src/types";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

import { handleBrokerOptionsRoutes, type BrokerOptionsRouteContext } from "../src/agents/routes/brokerOptions";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";

/** An expiry inside the default DTE window: 30 days out, noon UTC. */
function soonExpiry(): BrokerOptionExpireDate {
  const when = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return { year: when.getUTCFullYear(), month: when.getUTCMonth() + 1, day: when.getUTCDate() } as BrokerOptionExpireDate;
}

function chain(symbol: string, underlyingPrice = 200): BrokerOptionChain {
  return {
    symbol,
    underlyingPrice,
    pairs: [
      {
        call: {
          optionType: "CALL",
          strikePrice: 200,
          symbol: `${symbol}260116C00200000`,
          bid: 5.1,
          ask: 5.3,
          lastPrice: 5.2,
          volume: 1200,
          openInterest: 3400,
        },
      },
    ],
  };
}

function stubSource(symbols: string[] = ["AAPL"]): OptionChainSource & { calls: string[]; expiryCalls: string[] } {
  const calls: string[] = [];
  const expiryCalls: string[] = [];
  return {
    supportsOptionRequestBudget: true,
    calls,
    expiryCalls,
    getOptionChains: async (params) => {
      calls.push(params.symbol);
      return symbols.includes(params.symbol) ? chain(params.symbol) : null;
    },
    getOptionExpireDates: async (symbol) => {
      expiryCalls.push(symbol);
      return [soonExpiry()];
    },
  };
}

describe("the screener holds a port, not a broker client (#3272)", () => {
  it("imports no E*TRADE client", () => {
    const source = readFileSync(new URL("../src/trading/optionsScreener.ts", import.meta.url), "utf8");
    expect(source).not.toContain("etrade/client");
    expect(source).not.toContain("ETradeRestClient");
  });

  it("recognises a source structurally", () => {
    expect(isOptionChainSource(stubSource())).toBe(true);
    expect(isOptionChainSource({ getOptionChains: async () => null })).toBe(false);
    expect(isOptionChainSource(null)).toBe(false);
    expect(isOptionChainSource({})).toBe(false);
  });

  it("adapts a platform with an options data plane", async () => {
    const platform = {
      getOptionChains: vi.fn(async () => chain("MSFT")),
      getOptionExpireDates: vi.fn(async () => [soonExpiry()]),
      getLastError: () => "last",
    } as any;
    const source = platformChainSource(platform)!;
    expect(source).toBeTruthy();
    expect(source.lastError).toBe("last");
    expect(await source.getOptionChains({ symbol: "MSFT" })).toMatchObject({ symbol: "MSFT" });
    expect(platform.getOptionChains).toHaveBeenCalledWith({ symbol: "MSFT" }, undefined);
  });

  it("returns null for a platform without an options plane", () => {
    expect(platformChainSource({} as any)).toBeNull();
    expect(platformChainSource({ getOptionChains: async () => null } as any)).toBeNull();
    expect(platformChainSource(null)).toBeNull();
  });
});

describe("screening runs over any source (#3272)", () => {
  it("screens the chains the source returns", async () => {
    const source = stubSource();
    const screener = new DynamicOptionsScreener(source);
    const result = await screener.screenOptions({ underlyingSymbols: ["AAPL"] });
    expect(source.expiryCalls).toEqual(["AAPL"]);
    expect(source.calls).toEqual(["AAPL"]);
    expect(result.status).not.toBe("error");
    // Matching rules belong to the screener (its own suite covers them).
    expect(result.filterApplied.underlyingSymbols).toEqual(["AAPL"]);
    expect(result.scannedAt).toEqual(expect.any(String));
  });

  it("refuses to pretend when no source is configured", async () => {
    const screener = new DynamicOptionsScreener(undefined);
    const result = await screener.screenOptions({ underlyingSymbols: ["AAPL"] });
    expect(result.status).toBe("error");
    expect(result.fetchErrors?.[0]?.reason).toContain("No option chain source");
  });
});

describe("the neutral screen route serves the selected broker (#3272)", () => {
  function ctx(): BrokerOptionsRouteContext {
    return {
      env: { APP_ENV: "TEST" } as any,
      getOrm: () => undefined,
      readSettingRaw: (key: string) => (key === "etrade:environment" ? "TEST" : null),
    };
  }

  function post(body: unknown) {
    const url = new URL("https://example.test/api/broker/options/screen");
    const request = new Request(url.toString(), {
      method: "POST",
      // Issue #4068: the broker screen now runs through the engine-routed
      // plain screen, whose ports are owner-scoped — the route fails closed
      // with a 401 when the login header is absent, so these requests carry
      // one; what the suite pins (selected broker, 501 refusal) is unchanged.
      headers: { "content-type": "application/json", "x-user-login": "test-login" },
      body: JSON.stringify(body),
    });
    return { request, url };
  }

  let getPlatform: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tenant.broker = "alpaca";
    getPlatform = vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(
      () =>
        ({
          getOptionChains: async (params: { symbol: string }) => chain(params.symbol),
          getOptionExpireDates: async () => [soonExpiry()],
        }) as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("screens with the selected broker and names it", async () => {
    const { request, url } = post({ filter: { underlyingSymbols: ["AAPL"] } });
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.environment).toBe("TEST");
    expect(body.result.filterApplied.underlyingSymbols).toEqual(["AAPL"]);
    expect(body.result.scannedAt).toEqual(expect.any(String));
    expect(getPlatform.mock.calls[0][0]).toBe("alpaca");
  });

  it("refuses a broker whose catalog says it cannot screen, naming it", async () => {
    const original = BROKER_CATALOG.alpaca.supports.optionChains;
    try {
      (BROKER_CATALOG.alpaca.supports as { optionChains: boolean }).optionChains = false;
      const { request, url } = post({ filter: { underlyingSymbols: ["AAPL"] } });
      const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
      expect(res!.status).toBe(501);
      const body = await res!.json();
      expect(body).toMatchObject({ code: "provider_unsupported", broker: "alpaca" });
      expect(body).not.toHaveProperty("result");
      expect(getPlatform).not.toHaveBeenCalled();
    } finally {
      (BROKER_CATALOG.alpaca.supports as { optionChains: boolean }).optionChains = original;
    }
  });

  it("refuses when the platform omits the chains method at runtime", async () => {
    getPlatform.mockImplementation(() => ({}) as any);
    const { request, url } = post({ filter: { underlyingSymbols: ["AAPL"] } });
    const res = await handleBrokerOptionsRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(501);
    expect((await res!.json()).code).toBe("provider_unsupported");
  });

  it("keeps the screen off the single-symbol paths and GET", async () => {
    const url = new URL("https://example.test/api/broker/options/screen");
    const get = new Request(url.toString(), { method: "GET" });
    expect(await handleBrokerOptionsRoutes(get, url, url.pathname, "sid", ctx())).toBeNull();

    const other = new URL("https://example.test/api/broker/options/nope");
    const otherReq = new Request(other.toString(), { method: "POST", body: "{}" });
    expect(await handleBrokerOptionsRoutes(otherReq, other, other.pathname, "sid", ctx())).toBeNull();
  });
});
