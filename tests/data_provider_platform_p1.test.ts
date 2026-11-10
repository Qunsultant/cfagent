/**
 * Issue #1118 (P1 of epic #1116) — data-provider platform foundation pins.
 *
 *  - ONE vocabulary: the platform provider ids are exactly the five
 *    owner-set providers (epic #1116, decision comment 6358627401) —
 *    etrade, public, yahoo, nasdaq, alpaca — and the capability list is
 *    exactly quotes / optionsChains / screenUniverse / historicalBars /
 *    fundamentals / news. No fourth spelling creeps in.
 *  - The provider-config store (mas_data_providers) round-trips a config
 *    record (write → read, update → read, §17.3), holds credential
 *    REFERENCES only, and seeds the five providers in the owner
 *    precedence order (etrade 1, public 2, yahoo 3, nasdaq 4, alpaca 5)
 *    with lifecycle states reflecting reality: the existing four are
 *    "configured", public is "registered" (descriptor only, no adapter).
 *  - The registry resolves a capability to the highest-precedence
 *    provider whose config-store state is "enabled" (state AND flag),
 *    and fails EXPLICITLY (DataProviderNotFoundError) otherwise — the
 *    #1103 no-silent-fallback rule applied to data. The public provider
 *    never resolves in this slice: it has no adapter, and its seeded
 *    "registered" state is not an enabled state.
 *  - Adapters wrap the existing implementations and return their results
 *    UNCHANGED (reference parity, the #1103 adapter method): E*TRADE via
 *    ETradeService, Yahoo/Alpaca via IMarketDataProvider, Nasdaq via
 *    nasdaqListings. Results travel in a provenance envelope
 *    ({ providerId, capability, result }) — the #1103 tagging idiom — so
 *    every element a run consumes names the provider that supplied it.
 *  - Screening COMPOSES providers in one run (owner correction, comment
 *    6358714200 on #1116): the config store carries a capability
 *    ROUTING table (primary + optional DECLARED gap-fill per
 *    capability), the registry's resolveRoute returns the full routed
 *    assignment, and the seeds encode today's composition — universe ←
 *    nasdaq, bars ← yahoo, quotes ← etrade primary + yahoo gap-fill,
 *    chains ← etrade, fundamentals ← yahoo. Precedence remains only as
 *    the default order where no route is declared. A gap-fill is never
 *    invented and never silently promoted to primary.
 *  - The conformance kit passes the four real adapters on every
 *    capability they declare, and FAILS a deliberately non-conformant
 *    stub (mutation evidence that the kit actually checks shapes).
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  DATA_PROVIDER_IDS,
  DATA_PROVIDER_CAPABILITIES,
} from "../src/trading/dataProviders/contract";
import type {
  DataProvider,
  DataProviderCapability,
} from "../src/trading/dataProviders/contract";
import {
  DataProviderRegistry,
  DataProviderNotFoundError,
} from "../src/trading/dataProviders/registry";
import {
  PROVIDER_CONFIG_TABLE,
  PROVIDER_ROUTING_TABLE,
  ensureProviderConfigTable,
  ensureProviderRoutingTable,
  upsertProviderConfig,
  getProviderConfig,
  listProviderConfigs,
  setProviderLifecycleState,
  setProviderEnabled,
  seedProviderConfigs,
  upsertCapabilityRoute,
  getCapabilityRoute,
  listCapabilityRoutes,
  seedCapabilityRoutes,
} from "../src/trading/dataProviders/providerConfigStore";
import type { ProviderConfigRecord } from "../src/trading/dataProviders/providerConfigStore";
import {
  createETradeDataProvider,
  createYahooDataProvider,
  createAlpacaDataProvider,
  createNasdaqDataProvider,
} from "../src/trading/dataProviders/adapters";
import { runDataProviderConformance } from "../src/trading/dataProviders/conformance";
import type {
  ETradeQuote,
  ETradeOptionChain,
  ETradeBrokerStatus,
  MarketDataResearchQuote,
  MarketDataResearchHistoricalBar,
  MarketDataResearchCompanyFundamentals,
} from "../src/types";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { IMarketDataProvider } from "../src/patterns/interfaces";

// ---------------------------------------------------------------------------
// Fixtures — recorded-shape results the wrapped implementations return.
// Adapters must hand these back by reference, untouched.
// ---------------------------------------------------------------------------

const etradeQuoteFixture = {
  symbol: "AAPL",
  companyName: "Apple Inc.",
  lastPrice: 232.5,
  change: 1.2,
  changePercent: 0.52,
  bid: 232.4,
  ask: 232.6,
  volume: 1_000_000,
  open: 230.0,
  high: 233.0,
  low: 229.0,
  timestamp: "2026-10-23T13:30:00.000Z",
} as unknown as ETradeQuote;

const etradeChainFixture = {
  symbol: "AAPL",
  underlyingPrice: 232.5,
  pairs: [
    {
      call: {
        optionType: "CALL",
        strikePrice: 230,
        symbol: "AAPL",
        bid: 4.1,
        ask: 4.3,
        lastPrice: 4.2,
      },
    },
  ],
} as unknown as ETradeOptionChain;

const marketDataQuoteFixture = {
  symbol: "AAPL",
  provider: "yfinance",
  provenance: "live",
  price: 232.5,
  change: 1.2,
  changePercent: 0.52,
  bid: 232.4,
  ask: 232.6,
  volume: 1_000_000,
  open: 230.0,
  high: 233.0,
  low: 229.0,
  previousClose: 231.3,
  timestamp: "2026-10-23T13:30:00.000Z",
} as unknown as MarketDataResearchQuote;

const marketDataBarsFixture = [
  {
    provenance: "live",
    timestamp: "2026-10-22T00:00:00.000Z",
    open: 228.0,
    high: 231.0,
    low: 227.5,
    close: 230.4,
    volume: 900_000,
  },
] as unknown as MarketDataResearchHistoricalBar[];

const marketDataFundamentalsFixture = {
  provenance: "live",
  symbol: "AAPL",
  companyName: "Apple Inc.",
  sector: "Technology",
  industry: "Consumer Electronics",
  description: "Designs and sells consumer electronics.",
  marketCap: 3_500_000_000_000,
  fiftyTwoWeekHigh: 260.0,
  fiftyTwoWeekLow: 170.0,
} as unknown as MarketDataResearchCompanyFundamentals;

const nasdaqListingsFixture: NasdaqStockListing[] = [
  {
    symbol: "AAPL",
    companyName: "Apple Inc.",
    exchange: "nasdaq",
    change: 0,
    changePercent: 0,
  },
  {
    symbol: "MSFT",
    companyName: "Microsoft Corporation",
    exchange: "nasdaq",
    change: 0,
    changePercent: 0,
  },
];

// ---------------------------------------------------------------------------
// Fake wrapped implementations — the adapters under test wrap these.
// ---------------------------------------------------------------------------

function fakeETradeService(configured = true) {
  return {
    getQuoteAsync: async (_symbol: string) => etradeQuoteFixture,
    getOptionChains: async (_params: unknown) => etradeChainFixture,
    getStatus: () =>
      ({ broker: "etrade", configured }) as unknown as ETradeBrokerStatus,
  };
}

function fakeMarketDataProvider(
  providerId: "yfinance" | "alpaca"
): IMarketDataProvider {
  return {
    providerId,
    name: `fake-${providerId}`,
    isConfigured: () => true,
    getQuote: async (_symbol: string) => marketDataQuoteFixture,
    getFundamentals: async (_symbol: string) => marketDataFundamentalsFixture,
    getHistoricalBars: async (_symbol: string) => marketDataBarsFixture,
  };
}

function freshSql() {
  return new MockSqlStorage() as any;
}

function seededStore() {
  const sql = freshSql();
  seedProviderConfigs(sql);
  return sql;
}

/** Promote a provider to the only state the registry will resolve: state "enabled" AND flag on. */
function enableProvider(sql: any, id: string): ProviderConfigRecord[] {
  setProviderLifecycleState(sql, id, "enabled");
  setProviderEnabled(sql, id, true);
  return listProviderConfigs(sql);
}

// ---------------------------------------------------------------------------
// One vocabulary
// ---------------------------------------------------------------------------

describe("data provider vocabulary (issue #1118)", () => {
  it("pins the five owner-set provider ids in precedence order", () => {
    expect(DATA_PROVIDER_IDS).toEqual([
      "etrade",
      "public",
      "yahoo",
      "nasdaq",
      "alpaca",
    ]);
  });

  it("pins the capability vocabulary", () => {
    expect(DATA_PROVIDER_CAPABILITIES).toEqual([
      "quotes",
      "optionsChains",
      "screenUniverse",
      "historicalBars",
      "fundamentals",
      "news",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Provider-config store
// ---------------------------------------------------------------------------

describe("provider-config store (issue #1118)", () => {
  it("creates the mas_data_providers table", () => {
    const sql = freshSql();
    const executed: string[] = [];
    const recording = {
      exec: (q: string, ...args: any[]) => {
        executed.push(q);
        return sql.exec(q, ...args);
      },
    };
    ensureProviderConfigTable(recording as any);
    expect(PROVIDER_CONFIG_TABLE).toBe("mas_data_providers");
    expect(
      executed.some((q) =>
        /CREATE TABLE IF NOT EXISTS mas_data_providers\b/i.test(q)
      )
    ).toBe(true);
  });

  it("config write → read round-trip, credential reference only", () => {
    const sql = freshSql();
    const written = upsertProviderConfig(sql, {
      id: "etrade",
      adapterKind: "etrade-service",
      lifecycleState: "configured",
      enabled: false,
      precedence: 1,
      credentialRef: "sessionstore:etrade:token",
      config: { tokenNamespace: "etrade", environments: ["TEST", "PROD"] },
    });
    const back = getProviderConfig(sql, "etrade");
    expect(back).not.toBeNull();
    expect(back).toEqual(written);
    expect(back?.adapterKind).toBe("etrade-service");
    expect(back?.lifecycleState).toBe("configured");
    expect(back?.enabled).toBe(false);
    expect(back?.precedence).toBe(1);
    expect(back?.credentialRef).toBe("sessionstore:etrade:token");
    expect(back?.config).toEqual({
      tokenNamespace: "etrade",
      environments: ["TEST", "PROD"],
    });
  });

  it("upsert updates in place — still one row, created_at preserved", () => {
    const sql = freshSql();
    const first = upsertProviderConfig(sql, {
      id: "yahoo",
      adapterKind: "yahoo-finance",
      lifecycleState: "configured",
      precedence: 3,
    });
    const second = upsertProviderConfig(sql, {
      id: "yahoo",
      adapterKind: "yahoo-finance",
      lifecycleState: "verified",
      precedence: 3,
    });
    expect(listProviderConfigs(sql)).toHaveLength(1);
    expect(second.lifecycleState).toBe("verified");
    expect(second.createdAt).toBe(first.createdAt);
    expect(getProviderConfig(sql, "yahoo")?.lifecycleState).toBe("verified");
  });

  it("seeds the five providers in owner precedence order with honest lifecycle states", () => {
    const sql = seededStore();
    const rows = listProviderConfigs(sql);
    expect(rows.map((r) => r.id)).toEqual([
      "etrade",
      "public",
      "yahoo",
      "nasdaq",
      "alpaca",
    ]);
    expect(rows.map((r) => r.precedence)).toEqual([1, 2, 3, 4, 5]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Existing providers exist and are configured; none is silently "enabled".
    for (const id of ["etrade", "yahoo", "nasdaq", "alpaca"] as const) {
      expect(byId.get(id)?.lifecycleState).toBe("configured");
      expect(byId.get(id)?.enabled).toBe(false);
    }
    // public is a descriptor only in this slice.
    expect(byId.get("public")?.lifecycleState).toBe("registered");
    expect(byId.get("public")?.enabled).toBe(false);
    // Credential references, never values.
    expect(byId.get("etrade")?.credentialRef).toBe("sessionstore:etrade:token");
    expect(byId.get("alpaca")?.credentialRef).toBe("env:ALPACA_API_KEY");
    expect(byId.get("yahoo")?.credentialRef).toBeNull();
    expect(byId.get("nasdaq")?.credentialRef).toBeNull();
    expect(byId.get("public")?.credentialRef).toBeNull();
  });

  it("seeding is idempotent", () => {
    const sql = seededStore();
    seedProviderConfigs(sql);
    expect(listProviderConfigs(sql)).toHaveLength(5);
  });

  it("lifecycle + enabled transitions read back", () => {
    const sql = seededStore();
    setProviderLifecycleState(sql, "yahoo", "verified");
    expect(getProviderConfig(sql, "yahoo")?.lifecycleState).toBe("verified");
    setProviderEnabled(sql, "yahoo", true);
    expect(getProviderConfig(sql, "yahoo")?.enabled).toBe(true);
    expect(setProviderLifecycleState(sql, "public", "configured")?.id).toBe(
      "public"
    );
    expect(setProviderEnabled(sql, "missing" as any, true)).toBeNull();
  });

  it("creates the mas_data_provider_routes table", () => {
    const sql = freshSql();
    const executed: string[] = [];
    const recording = {
      exec: (q: string, ...args: any[]) => {
        executed.push(q);
        return sql.exec(q, ...args);
      },
    };
    ensureProviderRoutingTable(recording as any);
    expect(PROVIDER_ROUTING_TABLE).toBe("mas_data_provider_routes");
    expect(
      executed.some((q) =>
        /CREATE TABLE IF NOT EXISTS mas_data_provider_routes\b/i.test(q)
      )
    ).toBe(true);
  });

  it("capability route write → read round-trip", () => {
    const sql = freshSql();
    const written = upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: "yahoo",
    });
    expect(getCapabilityRoute(sql, "quotes")).toEqual(written);
    expect(written.primaryProviderId).toBe("etrade");
    expect(written.gapFillProviderId).toBe("yahoo");
    // Re-route in place: still one row for the capability.
    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "yahoo",
      gapFillProviderId: null,
    });
    expect(listCapabilityRoutes(sql)).toHaveLength(1);
    expect(getCapabilityRoute(sql, "quotes")?.primaryProviderId).toBe("yahoo");
    expect(getCapabilityRoute(sql, "quotes")?.gapFillProviderId).toBeNull();
    expect(getCapabilityRoute(sql, "news")).toBeNull();
  });

  it("seeds TODAY's screening composition as capability routes", () => {
    const sql = seededStore();
    const routes = listCapabilityRoutes(sql);
    const byCapability = new Map(routes.map((r) => [r.capability, r]));
    // The stock screener composes: Nasdaq listings + Yahoo bars +
    // E*TRADE quotes/chains (owner correction, comment 6358714200 on
    // #1116). No Yahoo quote gap-fill: live quote rows are never
    // gap-filled (owner ruling, issue #2144).
    expect(byCapability.get("screenUniverse")?.primaryProviderId).toBe("nasdaq");
    expect(byCapability.get("screenUniverse")?.gapFillProviderId).toBeNull();
    expect(byCapability.get("historicalBars")?.primaryProviderId).toBe("yahoo");
    expect(byCapability.get("historicalBars")?.gapFillProviderId).toBeNull();
    expect(byCapability.get("quotes")?.primaryProviderId).toBe("etrade");
    expect(byCapability.get("quotes")?.gapFillProviderId).toBeNull();
    expect(byCapability.get("optionsChains")?.primaryProviderId).toBe("etrade");
    expect(byCapability.get("optionsChains")?.gapFillProviderId).toBeNull();
    expect(byCapability.get("fundamentals")?.primaryProviderId).toBe("yahoo");
    expect(byCapability.get("fundamentals")?.gapFillProviderId).toBeNull();
    // Nothing serves news yet — no route is invented for it.
    expect(byCapability.has("news")).toBe(false);
    expect(routes).toHaveLength(5);
  });

  it("route seeding is idempotent and separable", () => {
    const sql = freshSql();
    seedCapabilityRoutes(sql);
    seedCapabilityRoutes(sql);
    expect(listCapabilityRoutes(sql)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Registry: precedence, lifecycle gating, explicit failure
// ---------------------------------------------------------------------------

describe("data provider registry (issue #1118)", () => {
  function registryWithRealAdapters() {
    const registry = new DataProviderRegistry();
    registry.register(createETradeDataProvider(fakeETradeService() as any));
    registry.register(createYahooDataProvider(fakeMarketDataProvider("yfinance")));
    registry.register(createAlpacaDataProvider(fakeMarketDataProvider("alpaca")));
    registry.register(
      createNasdaqDataProvider(async () => nasdaqListingsFixture)
    );
    return registry;
  }

  it("duplicate registration throws — provenance ids stay unambiguous", () => {
    const registry = new DataProviderRegistry();
    registry.register(createYahooDataProvider(fakeMarketDataProvider("yfinance")));
    expect(() =>
      registry.register(createYahooDataProvider(fakeMarketDataProvider("yfinance")))
    ).toThrow(/already registered/);
  });

  it("resolves a capability to the highest-precedence ENABLED provider", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    enableProvider(sql, "yahoo");
    expect(registry.resolve("quotes", listProviderConfigs(sql)).id).toBe(
      "yahoo"
    );
    // etrade outranks yahoo once enabled (precedence 1 < 3).
    enableProvider(sql, "etrade");
    const configs = enableProvider(sql, "nasdaq");
    expect(registry.resolve("quotes", configs).id).toBe("etrade");
    expect(registry.resolve("optionsChains", configs).id).toBe("etrade");
    // nasdaq is the only screenUniverse declarer; it resolves once enabled.
    expect(registry.resolve("screenUniverse", configs).id).toBe("nasdaq");
  });

  it("skips a disabled provider and falls to the next precedence — by config, never silently", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    enableProvider(sql, "etrade");
    enableProvider(sql, "yahoo");
    setProviderEnabled(sql, "etrade", false);
    expect(registry.resolve("quotes", listProviderConfigs(sql)).id).toBe(
      "yahoo"
    );
  });

  it("lifecycle gating: configured / verified states never resolve", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    // Seeded state: everything "configured" — nothing may resolve.
    expect(() => registry.resolve("quotes", listProviderConfigs(sql))).toThrow(
      DataProviderNotFoundError
    );
    // "verified" + flag on is still not "enabled".
    setProviderLifecycleState(sql, "yahoo", "verified");
    setProviderEnabled(sql, "yahoo", true);
    expect(() => registry.resolve("quotes", listProviderConfigs(sql))).toThrow(
      DataProviderNotFoundError
    );
    // State "enabled" with the flag OFF does not resolve either.
    setProviderLifecycleState(sql, "yahoo", "enabled");
    setProviderEnabled(sql, "yahoo", false);
    expect(() => registry.resolve("quotes", listProviderConfigs(sql))).toThrow(
      DataProviderNotFoundError
    );
  });

  it("explicit failure for a capability nobody enabled serves — typed error, no fallback", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    enableProvider(sql, "etrade");
    enableProvider(sql, "yahoo");
    enableProvider(sql, "alpaca");
    // #3932: "news" is no longer the unserved capability — the
    // Yahoo adapter declares it now, so resolving it succeeds
    // with yahoo enabled. "screenUniverse" is served only by
    // nasdaq, which stays disabled here, so it is the unserved
    // capability this test pins.
    let caught: unknown;
    try {
      registry.resolve("screenUniverse", listProviderConfigs(sql));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataProviderNotFoundError);
    expect((caught as DataProviderNotFoundError).capability).toBe("screenUniverse");
    expect((caught as Error).message).toMatch(/screenUniverse/);
  });

  // Premise updated by #1247 (disclosed): a production Public adapter
  // now EXISTS and is registered by the platform surfaces — the
  // protective assertion is unchanged: public still cannot resolve
  // while its lifecycle state is not "enabled". (This test-local
  // registry registers no public adapter, exactly as before.)
  it("public never resolves while not enabled — the registered lifecycle state gates it", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    // Every real provider enabled; public still cannot resolve anything.
    for (const id of ["etrade", "yahoo", "nasdaq", "alpaca"]) {
      enableProvider(sql, id);
    }
    expect(registry.get("public")).toBeUndefined();
    // Even with a stub adapter registered under public's id, its seeded
    // "registered" lifecycle state keeps it out of resolution.
    const stub: DataProvider = {
      id: "public",
      name: "Public (stub)",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuote: async () => ({
        providerId: "public",
        capability: "quotes",
        result: etradeQuoteFixture,
      }),
    };
    registry.register(stub);
    expect(registry.resolve("quotes", listProviderConfigs(sql)).id).toBe(
      "etrade"
    );
    // And an artificially enabled public config with NO adapter registered
    // fails explicitly instead of inventing a provider.
    const bare = new DataProviderRegistry();
    const pubSql = seededStore();
    enableProvider(pubSql, "public");
    expect(() =>
      bare.resolve("quotes", listProviderConfigs(pubSql))
    ).toThrow(DataProviderNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Capability routing: composition, not a single winner
// ---------------------------------------------------------------------------

describe("capability routing resolution (issue #1118, owner correction)", () => {
  function registryWithRealAdapters() {
    const registry = new DataProviderRegistry();
    registry.register(createETradeDataProvider(fakeETradeService() as any));
    registry.register(createYahooDataProvider(fakeMarketDataProvider("yfinance")));
    registry.register(createAlpacaDataProvider(fakeMarketDataProvider("alpaca")));
    registry.register(
      createNasdaqDataProvider(async () => nasdaqListingsFixture)
    );
    return registry;
  }

  function enableAll(sql: any) {
    for (const id of ["etrade", "yahoo", "nasdaq", "alpaca"]) {
      enableProvider(sql, id);
    }
    return { configs: listProviderConfigs(sql), routes: listCapabilityRoutes(sql) };
  }

  it("returns the full routed assignment per capability — primary + declared gap-fill", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    const { configs, routes } = enableAll(sql);

    const quotes = registry.resolveRoute("quotes", configs, routes);
    expect(quotes.capability).toBe("quotes");
    expect(quotes.primary.id).toBe("etrade");
    // Issue #2144: quotes never gap-fill, even when a stored route
    // declares one.
    expect(quotes.gapFill).toBeUndefined();

    const universe = registry.resolveRoute("screenUniverse", configs, routes);
    expect(universe.primary.id).toBe("nasdaq");
    expect(universe.gapFill).toBeUndefined();

    const bars = registry.resolveRoute("historicalBars", configs, routes);
    expect(bars.primary.id).toBe("yahoo");
    expect(bars.gapFill).toBeUndefined();

    const chains = registry.resolveRoute("optionsChains", configs, routes);
    expect(chains.primary.id).toBe("etrade");
    expect(chains.gapFill).toBeUndefined();

    const fundamentals = registry.resolveRoute("fundamentals", configs, routes);
    expect(fundamentals.primary.id).toBe("yahoo");
    expect(fundamentals.gapFill).toBeUndefined();
  });

  it("gap-fill appears ONLY where declared — and never for quotes (issue #2144)", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    const { configs } = enableAll(sql);
    // Quotes: a stored route DOES declare yahoo as gap-fill, but the
    // owner ruling suppresses it — live quote rows are never
    // gap-filled. The policy is quotes-scoped: historicalBars still
    // has no gap-fill declared at all despite multiple enabled
    // providers existing. Fundamentals: a stored route DOES declare
    // alpaca as gap-fill, but alpaca no longer serves fundamentals
    // (#3990: the declaration was false — its getFundamentals throws,
    // ADR 0019 — so the registry omits the unservable gap-fill,
    // never fatal). No provider other than the yahoo primary declares
    // fundamentals, so there is no servable gap-fill for it at all.
    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "etrade",
      gapFillProviderId: "yahoo",
    });
    upsertCapabilityRoute(sql, {
      capability: "fundamentals",
      primaryProviderId: "yahoo",
      gapFillProviderId: "alpaca",
    });
    const routes = listCapabilityRoutes(sql);
    expect(registry.resolveRoute("quotes", configs, routes).gapFill).toBeUndefined();
    expect(
      registry.resolveRoute("fundamentals", configs, routes).gapFill
    ).toBeUndefined();
    expect(
      registry.resolveRoute("historicalBars", configs, routes).gapFill
    ).toBeUndefined();
  });

  it("a declared route overrides precedence for the primary slot", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    const { configs } = enableAll(sql);
    // Re-route quotes primary to yahoo (precedence still says etrade=1).
    upsertCapabilityRoute(sql, {
      capability: "quotes",
      primaryProviderId: "yahoo",
      gapFillProviderId: null,
    });
    const assignment = registry.resolveRoute(
      "quotes",
      configs,
      listCapabilityRoutes(sql)
    );
    expect(assignment.primary.id).toBe("yahoo");
    expect(assignment.gapFill).toBeUndefined();
    // ... while the precedence-only resolve() still answers etrade.
    expect(registry.resolve("quotes", configs).id).toBe("etrade");
  });

  it("an unservable gap-fill is omitted from the assignment, visibly — not fatal, not substituted", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    enableProvider(sql, "yahoo");
    // alpaca (the declared fundamentals gap-fill) stays "configured" —
    // not enabled. (Quotes no longer exercises this path: its gap-fill
    // is suppressed by policy, issue #2144, whether servable or not.)
    upsertCapabilityRoute(sql, {
      capability: "fundamentals",
      primaryProviderId: "yahoo",
      gapFillProviderId: "alpaca",
    });
    const assignment = registry.resolveRoute(
      "fundamentals",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql)
    );
    expect(assignment.primary.id).toBe("yahoo");
    expect(assignment.gapFill).toBeUndefined();
  });

  it("an unservable routed primary fails EXPLICITLY — the gap-fill is never silently promoted", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    enableProvider(sql, "yahoo"); // gap-fill enabled, primary (etrade) not
    expect(() =>
      registry.resolveRoute(
        "quotes",
        listProviderConfigs(sql),
        listCapabilityRoutes(sql)
      )
    ).toThrow(DataProviderNotFoundError);
  });

  it("with no route declared, precedence is the routing default (primary only, no gap-fill)", () => {
    const sql = freshSql();
    // Configs without any routes (seedCapabilityRoutes never called).
    upsertProviderConfig(sql, {
      id: "etrade",
      adapterKind: "etrade-service",
      precedence: 1,
    });
    upsertProviderConfig(sql, {
      id: "yahoo",
      adapterKind: "yahoo-finance",
      precedence: 3,
    });
    enableProvider(sql, "etrade");
    enableProvider(sql, "yahoo");
    const registry = registryWithRealAdapters();
    const assignment = registry.resolveRoute(
      "quotes",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql)
    );
    expect(assignment.primary.id).toBe("etrade");
    expect(assignment.gapFill).toBeUndefined();
  });

  it("a routed provider that does not declare the capability fails explicitly", () => {
    const sql = seededStore();
    const registry = registryWithRealAdapters();
    const { configs } = enableAll(sql);
    // Mis-route screenUniverse to etrade, which declares no such capability.
    upsertCapabilityRoute(sql, {
      capability: "screenUniverse",
      primaryProviderId: "etrade",
      gapFillProviderId: null,
    });
    expect(() =>
      registry.resolveRoute(
        "screenUniverse",
        configs,
        listCapabilityRoutes(sql)
      )
    ).toThrow(DataProviderNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Adapters: declared capabilities + provenance-tagged reference parity
// ---------------------------------------------------------------------------

describe("data provider adapters (issue #1118)", () => {
  it("declare the capabilities their wrapped implementations actually serve", () => {
    expect(
      createETradeDataProvider(fakeETradeService() as any).capabilities
    ).toEqual(["quotes", "optionsChains"]);
    expect(
      createYahooDataProvider(fakeMarketDataProvider("yfinance")).capabilities
    ).toEqual(["quotes", "historicalBars", "fundamentals", "news"]);
    // #3932: the Yahoo adapter declares news (Yahoo News search);
    // Alpaca declares none — no news fetcher is supplied for it.
    // #3990: Alpaca declares optionsChains (the repo's own Alpaca
    // options read path) and NOT fundamentals — its getFundamentals
    // throws (ADR 0019: Yahoo covers fundamentals, never faked).
    expect(
      createAlpacaDataProvider(fakeMarketDataProvider("alpaca")).capabilities
    ).toEqual(["quotes", "historicalBars", "optionsChains"]);
    expect(
      createNasdaqDataProvider(async () => nasdaqListingsFixture).capabilities
    ).toEqual(["screenUniverse"]);
  });

  it("etrade adapter returns the wrapped service's results unchanged, provenance-tagged", async () => {
    const provider = createETradeDataProvider(fakeETradeService() as any);
    const quote = await provider.getQuote!("AAPL");
    expect(quote.providerId).toBe("etrade");
    expect(quote.capability).toBe("quotes");
    expect(quote.result).toBe(etradeQuoteFixture);
    const chain = await provider.getOptionsChain!({
      symbol: "AAPL",
      chainType: "CALLPUT",
    });
    expect(chain.providerId).toBe("etrade");
    expect(chain.capability).toBe("optionsChains");
    expect(chain.result).toBe(etradeChainFixture);
  });

  it("etrade adapter isConfigured reflects the service status", () => {
    expect(
      createETradeDataProvider(fakeETradeService(true) as any).isConfigured()
    ).toBe(true);
    expect(
      createETradeDataProvider(fakeETradeService(false) as any).isConfigured()
    ).toBe(false);
  });

  it("yahoo + alpaca adapters return the wrapped market-data results unchanged, provenance-tagged", async () => {
    for (const [provider, id] of [
      [createYahooDataProvider(fakeMarketDataProvider("yfinance")), "yahoo"],
      [createAlpacaDataProvider(fakeMarketDataProvider("alpaca")), "alpaca"],
    ] as const) {
      const quote = await provider.getQuote!("AAPL");
      expect(quote.providerId).toBe(id);
      expect(quote.result).toBe(marketDataQuoteFixture);
      const bars = await provider.getHistoricalBars!("AAPL");
      expect(bars.providerId).toBe(id);
      expect(bars.capability).toBe("historicalBars");
      expect(bars.result).toBe(marketDataBarsFixture);
      // #3990: fundamentals is declared only where served — Yahoo
      // declares it, Alpaca does not (its getFundamentals throws, so
      // the method is absent, not a throwing stub).
      if (provider.capabilities.includes("fundamentals")) {
        const fundamentals = await provider.getFundamentals!("AAPL");
        expect(fundamentals.providerId).toBe(id);
        expect(fundamentals.result).toBe(marketDataFundamentalsFixture);
      }
    }
  });

  it("nasdaq adapter returns the listings unchanged, provenance-tagged", async () => {
    const provider = createNasdaqDataProvider(
      async () => nasdaqListingsFixture
    );
    const universe = await provider.getScreenUniverse!();
    expect(universe.providerId).toBe("nasdaq");
    expect(universe.capability).toBe("screenUniverse");
    expect(universe.result).toBe(nasdaqListingsFixture);
  });
});

// ---------------------------------------------------------------------------
// Conformance kit: green on the real adapters, red on a bad stub
// ---------------------------------------------------------------------------

describe("data provider conformance kit (issue #1118)", () => {
  it("passes all four real adapters on every capability they declare", async () => {
    const adapters: DataProvider[] = [
      createETradeDataProvider(fakeETradeService() as any),
      // #3932: the Yahoo adapter's news capability is served by
      // the live Yahoo News fetch in production — in tests the
      // fetcher is injected (a live fetch is blocked, #411), so
      // the conformance kit probes the stub, not the network.
      createYahooDataProvider(fakeMarketDataProvider("yfinance"), undefined, {
        news: async (symbol: string) => [
          {
            headline: `${symbol} surges on strong earnings`,
            source: "Yahoo Finance",
            publishedAt: new Date().toISOString(),
            symbol,
          },
        ],
      }),
      // #3990: the Alpaca adapter declares optionsChains, so the kit
      // probes it — the default (real) source would call Alpaca's live
      // API (blocked in tests, #411), so the chain source is injected
      // (a conformant chain: symbol echo + pairs array), mirroring the
      // Yahoo news injection above.
      createAlpacaDataProvider(fakeMarketDataProvider("alpaca"), undefined, {
        optionsChain: {
          getChain: async () => ({
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
          }),
          getExpiryDates: async () => [{ year: 2026, month: 3, day: 20 }],
        } as never,
      }),
      createNasdaqDataProvider(async () => nasdaqListingsFixture),
    ];
    for (const adapter of adapters) {
      const report = await runDataProviderConformance(adapter);
      expect(report.providerId).toBe(adapter.id);
      expect(
        report.checks.map((c) => c.capability).sort()
      ).toEqual([...adapter.capabilities].sort());
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    }
  });

  it("FAILS a deliberately non-conformant stub (mutation evidence)", async () => {
    const bad: DataProvider = {
      id: "alpaca",
      name: "Broken stub",
      capabilities: ["quotes", "screenUniverse"],
      isConfigured: () => true,
      getQuote: async () =>
        ({
          providerId: "alpaca",
          capability: "quotes",
          result: { bogus: true },
        }) as unknown as Awaited<ReturnType<NonNullable<DataProvider["getQuote"]>>>,
      getScreenUniverse: async () =>
        ({
          providerId: "alpaca",
          capability: "screenUniverse",
          result: [{ nope: 1 }],
        }) as unknown as Awaited<
          ReturnType<NonNullable<DataProvider["getScreenUniverse"]>>
        >,
    };
    const report = await runDataProviderConformance(bad);
    expect(report.ok).toBe(false);
    const quotes = report.checks.find(
      (c: { capability: DataProviderCapability }) => c.capability === "quotes"
    );
    expect(quotes?.ok).toBe(false);
    expect(quotes!.failures.length).toBeGreaterThan(0);
    const universe = report.checks.find(
      (c: { capability: DataProviderCapability }) =>
        c.capability === "screenUniverse"
    );
    expect(universe?.ok).toBe(false);
  });

  it("FAILS a stub whose provenance tag mislabels the serving provider", async () => {
    const mislabeled: DataProvider = {
      id: "yahoo",
      name: "Mislabeled stub",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuote: async () =>
        ({
          providerId: "etrade", // claims etrade served it; the provider is yahoo
          capability: "quotes",
          result: marketDataQuoteFixture,
        }) as unknown as Awaited<ReturnType<NonNullable<DataProvider["getQuote"]>>>,
    };
    const report = await runDataProviderConformance(mislabeled);
    expect(report.ok).toBe(false);
    expect(report.checks[0].failures.join(" ")).toMatch(/provenance|providerId/i);
  });

  it("FAILS a stub returning an untagged (non-envelope) result", async () => {
    const raw: DataProvider = {
      id: "yahoo",
      name: "Raw stub",
      capabilities: ["quotes"],
      isConfigured: () => true,
      getQuote: async () =>
        marketDataQuoteFixture as unknown as Awaited<
          ReturnType<NonNullable<DataProvider["getQuote"]>>
        >,
    };
    const report = await runDataProviderConformance(raw);
    expect(report.ok).toBe(false);
    expect(report.checks[0].failures.join(" ")).toMatch(/envelope|provenance/i);
  });

  it("FAILS a provider that declares a capability it does not implement", async () => {
    const hollow: DataProvider = {
      id: "yahoo",
      name: "Hollow stub",
      capabilities: ["news"],
      isConfigured: () => true,
      // no getNews method
    };
    const report = await runDataProviderConformance(hollow);
    expect(report.ok).toBe(false);
    expect(report.checks[0].capability).toBe("news");
    expect(report.checks[0].failures.join(" ")).toMatch(/not implement|missing/i);
  });
});
