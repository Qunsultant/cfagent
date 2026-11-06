/**
 * Issue #1385 (Alpaca provider slice, epic #1116) — the slice's NEW
 * behaviour. TDD Red: these pins FAIL on the pre-slice tree (there
 * is no verifyAlpacaDataProvider and no binding in
 * buildDataProviderVerifier) and pass after the slice.
 *
 * What is genuinely NEW here is only the verifier + its binding.
 * Everything else in this file is characterization of behaviour
 * that already exists (the shared market-data factory's capture seam from
 * #1317, the seeded alpaca record, the generic routes GET, the
 * session gate) — those pins PASS on pristine control and are
 * disclosed as precondition pins, NOT claimed as Red. Their value
 * is guarding the slice: they prove the alpaca adapter inherits the
 * factory's capture/outcome semantics field-for-field and that
 * existing consumers did not move.
 *
 * Pins:
 *  - adapter shape: id/name/capabilities, tagged quote envelope
 *    field-for-field, getQuotesBatch present exactly when the
 *    wrapped provider offers getQuotes (absent for the fixture;
 *    present for the real provider since #3530 S2 added its batch
 *    leg — see the adapted pin), isConfigured delegating to the
 *    real provider (key AND secret required);
 *  - capture (E1/E7 semantics, inherited from the shared factory):
 *    capture-wired constructions write one row per capability,
 *    run-linked, rawKind "provider-result"; blob failure writes a
 *    capture_failed marker and the fetch still returns; throwing
 *    fetches write fetch_failed and rethrow identically;
 *  - verifier: verifyAlpacaDataProvider shapes — unconfigured
 *    (honest ok:false, nothing fetched), configured + conformant
 *    (ok:true), kit failure (ok:false with the failure list, never
 *    a silent pass), throwing provider + sql-derived recorder
 *    (ok:false + one fetch_failed row per capability), production
 *    construction with an empty env (honest ok:false);
 *  - binding: buildDataProviderVerifier binds alpaca; unknown ids
 *    stay unbound; the routes-API verify for alpaca stops failing
 *    with "no adapter" and fails honestly with "not configured"
 *    when unconfigured; session-gated mutations keep the exact
 *    401 body;
 *  - lifecycle + routes: verify → enable through transitionProvider
 *    with the alpaca verifier; GET serves alpaca enabled with a
 *    health block; NO seeded route changes (quotes/etrade+yahoo,
 *    historicalBars/yahoo, fundamentals/yahoo, screenUniverse/
 *    nasdaq, optionsChains/etrade); GET provider order unchanged;
 *  - seed: alpaca configured/disabled, precedence 5, credential
 *    reference env:ALPACA_API_KEY.
 *
 * No secret-shaped literals: key/secret fixture values below are
 * assembled from string fragments at runtime, so no secret-shaped
 * literal ever enters the file.
 */
import { describe, it, expect } from "vitest";
import {
  createAlpacaDataProvider,
  verifyAlpacaDataProvider,
  type MarketDataProviderOptions,
} from "../src/trading/dataProviders/adapters";
import {
  ensureCaptureTable,
  listCapturesByRun,
  listCapturesByProvider,
  listCaptureFailures,
  listFetchFailures,
} from "../src/trading/dataProviders/captureStore";
import {
  getProviderConfig,
  listCapabilityRoutes,
  seedProviderConfigs,
} from "../src/trading/dataProviders/providerConfigStore";
import { transitionProvider } from "../src/trading/dataProviders/lifecycle";
import { runDataProviderConformance } from "../src/trading/dataProviders/conformance";
import { buildDataProviderVerifier } from "../src/agents/routes/dataProviders";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import { MockSqlStorage } from "./mock-sql";
import type { MarketDataResearchQuote } from "../src/types";
import type { IMarketDataProvider } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

const RUN = { runId: "run-alpaca-1385", tenantId: "test-tenant", userLogin: "tester" };
const LOGIN = "tester";

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

type FixtureMarketData = IMarketDataProvider;

function fixtureMarketData(over: Partial<FixtureMarketData> = {}): FixtureMarketData {
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
    ...over,
  };
}

function throwingMarketData(): FixtureMarketData {
  const boom = () => {
    throw new Error("alpaca feed down");
  };
  return {
    providerId: "alpaca",
    name: "throwing-fixture",
    isConfigured: () => true,
    getQuote: async () => boom(),
    getFundamentals: async () => boom(),
    getHistoricalBars: async () => boom(),
  };
}

function fakeBlobStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function failingBlobStorage() {
  return {
    get: async (_key: string) => undefined,
    put: async (_key: string, _value: unknown) => {
      throw new Error("forced blob put failure");
    },
  };
}

function captureDeps(
  sql: MockSqlStorage,
  storage: unknown = fakeBlobStorage()
): MarketDataProviderOptions["capture"] {
  ensureCaptureTable(sql as never);
  return { sql: sql as never, blobStorage: storage as never, env: {} as never };
}

function makeRouteCtx(sql: MockSqlStorage, overrides: Partial<DataProviderRoutesContext> = {}) {
  // No buildVerifier override: the routes handler must exercise the
  // real buildDataProviderVerifier binding for alpaca.
  const ctx: DataProviderRoutesContext = {
    env: {} as Env,
    sql: sql as never,
    userLogin: LOGIN,
    recordAudit: () => ({ id: "audit-1", type: "t", agent: "a", payload: {}, created_at: "" }) as never,
    ...overrides,
  };
  return { ctx };
}

function callRoute(
  ctx: DataProviderRoutesContext,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const url = new URL(`https://agent.internal${path}`);
  const request = new Request(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleDataProviderRoutes(request, url, path, "session-1", ctx) as Promise<Response>;
}

describe("adapter: alpaca declares quotes/bars/fundamentals; batch rides the wrapped provider's getQuotes", () => {
  it("id/name/capabilities match the seed; getQuote returns the tagged envelope field-for-field", async () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData());
    expect(adapter.id).toBe("alpaca");
    expect(adapter.name).toBe("Alpaca Markets");
    expect([...adapter.capabilities]).toEqual(["quotes", "historicalBars", "fundamentals"]);
    const out = await adapter.getQuote!("AAPL", RUN);
    expect(out.providerId).toBe("alpaca");
    expect(out.capability).toBe("quotes");
    expect(out.result).toEqual(liveQuote("AAPL"));
  });

  it("getQuotesBatch exists exactly when the wrapped provider offers getQuotes — the fixture does not; the real one does since #3530 S2", () => {
    // S2 adaptation (#3530 S2, disclosed): this pin originally
    // asserted the REAL AlpacaMarketDataProvider also had no
    // batch method. S2 deliberately adds getQuotes to it (the
    // multi-symbol snapshots leg, the #1317 Yahoo precedent) so
    // the feed job can run end-to-end; by the factory's standing
    // rule the adapter then exposes getQuotesBatch. The fixture
    // half of the original pin — a wrapped provider WITHOUT
    // getQuotes yields no batch method — stands unchanged.
    const noBatch = createAlpacaDataProvider(fixtureMarketData());
    expect(noBatch.getQuotesBatch).toBeUndefined();
    const real = createAlpacaDataProvider(new AlpacaMarketDataProvider({} as Env), {} as Env);
    expect(typeof real.getQuotesBatch).toBe("function");
  });

  it("isConfigured delegates to the real provider: key AND secret required", () => {
    // The adapter passes ITS env (second arg) to the provider's
    // isConfigured, which prefers it over the constructor env — so
    // the key/secret fixtures ride on the adapter env here.
    const empty = createAlpacaDataProvider(new AlpacaMarketDataProvider(), {} as Env);
    expect(empty.isConfigured()).toBe(false);
    const keyOnly = createAlpacaDataProvider(
      new AlpacaMarketDataProvider(),
      { ALPACA_API_KEY: ["test", "key"].join("-") } as unknown as Env
    );
    expect(keyOnly.isConfigured()).toBe(false);
    const configured = createAlpacaDataProvider(
      new AlpacaMarketDataProvider(),
      {
        ALPACA_API_KEY: ["test", "key"].join("-"),
        ALPACA_SECRET_KEY: ["test", "secret"].join("-"),
      } as unknown as Env
    );
    expect(configured.isConfigured()).toBe(true);
  });
});

describe("capture: capture-wired alpaca constructions write rows per capability", () => {
  it("one run, three calls → three rows, one per capability, rawKind provider-result, run-linked", async () => {
    const sql = new MockSqlStorage();
    const adapter = createAlpacaDataProvider(fixtureMarketData(), undefined, {
      capture: captureDeps(sql),
    });
    await adapter.getQuote!("AAPL", RUN);
    await adapter.getHistoricalBars!("AAPL", undefined, undefined, RUN);
    await adapter.getFundamentals!("AAPL", RUN);
    const byRun = listCapturesByRun(sql as never, "test-tenant", "run-alpaca-1385");
    expect(byRun.length).toBe(3);
    expect(byRun.map((r) => r.capability).sort()).toEqual([
      "fundamentals",
      "historicalBars",
      "quotes",
    ]);
    expect(byRun.every((r) => r.providerId === "alpaca" && r.rawKind === "provider-result")).toBe(true);
    const byProvider = listCapturesByProvider(sql as never, "test-tenant", "alpaca");
    expect(byProvider.length).toBe(3);
  });

  it("a blob failure writes a capture_failed marker and the fetch still returns", async () => {
    const sql = new MockSqlStorage();
    const adapter = createAlpacaDataProvider(fixtureMarketData(), undefined, {
      capture: captureDeps(sql, failingBlobStorage()),
    });
    const out = await adapter.getQuote!("AAPL", RUN);
    expect(out.result).toEqual(liveQuote("AAPL"));
    const failures = listCaptureFailures(sql as never, "test-tenant");
    expect(failures.length).toBe(1);
    expect(failures[0].providerId).toBe("alpaca");
    expect(failures[0].capability).toBe("quotes");
  });

  it("a throwing quote fetch writes fetch_failed and rethrows the identical error", async () => {
    const sql = new MockSqlStorage();
    const boom = new Error("alpaca feed down");
    const adapter = createAlpacaDataProvider(fixtureMarketData({ getQuote: async () => { throw boom; } }), undefined, {
      capture: captureDeps(sql),
    });
    let caught: unknown;
    try {
      await adapter.getQuote!("AAPL", RUN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    const failed = listFetchFailures(sql as never, "test-tenant");
    expect(failed.length).toBe(1);
    expect(failed[0].providerId).toBe("alpaca");
    expect(failed[0].capability).toBe("quotes");
    expect(failed[0].failureKind).toBe("unknown");
  });

  it("a throwing bars fetch writes fetch_failed under historicalBars (per-capability outcomes)", async () => {
    const sql = new MockSqlStorage();
    const boom = new Error("alpaca feed down");
    const adapter = createAlpacaDataProvider(
      fixtureMarketData({ getHistoricalBars: async () => { throw boom; } }),
      undefined,
      { capture: captureDeps(sql) }
    );
    let caught: unknown;
    try {
      await adapter.getHistoricalBars!("AAPL", undefined, undefined, RUN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    const failed = listFetchFailures(sql as never, "test-tenant");
    expect(failed.length).toBe(1);
    expect(failed[0].capability).toBe("historicalBars");
  });
});

describe("verifier: verifyAlpacaDataProvider shapes", () => {
  it("unconfigured provider → honest ok:false, and nothing was fetched (zero outcome rows)", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql as never);
    const { createCaptureFetchOutcomeRecorder } = await import(
      "../src/trading/dataProviders/captureStore"
    );
    const result = await verifyAlpacaDataProvider(undefined, {
      provider: fixtureMarketData({ isConfigured: () => false }),
      outcomeRecorder: createCaptureFetchOutcomeRecorder(sql as never),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not configured/);
    expect(listFetchFailures(sql as never, "default").length).toBe(0);
    expect(listCapturesByProvider(sql as never, "default", "alpaca").length).toBe(0);
  });

  it("configured + conformant provider → ok:true naming all three capabilities", async () => {
    const result = await verifyAlpacaDataProvider(undefined, { provider: fixtureMarketData() });
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/conformance passed for quotes, historicalBars, fundamentals/);
  });

  it("kit failure → ok:false with the failure list, never a silent pass", async () => {
    const bad = fixtureMarketData({
      getFundamentals: async (s: string) => ({
        provenance: "live",
        symbol: "WRONG",
        companyName: `${s} Inc.`,
        sector: "Technology",
        industry: "Software",
        description: "fixture",
        marketCap: 1_000_000,
        fiftyTwoWeekHigh: 300,
        fiftyTwoWeekLow: 200,
      }),
    });
    const result = await verifyAlpacaDataProvider(undefined, { provider: bad });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/conformance failed/);
    expect(result.summary).toMatch(/fundamentals/);
  });

  it("throwing provider + sql-derived recorder → ok:false and one fetch_failed row per capability", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql as never);
    const { createCaptureFetchOutcomeRecorder } = await import(
      "../src/trading/dataProviders/captureStore"
    );
    const result = await verifyAlpacaDataProvider(undefined, {
      provider: throwingMarketData(),
      outcomeRecorder: createCaptureFetchOutcomeRecorder(sql as never),
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/conformance failed/);
    // The kit probes without a run context, so resolveRunContext
    // defaults the tenant to "default" — the probe rows live there.
    const failed = listFetchFailures(sql as never, "default");
    expect(failed.length).toBe(3);
    expect(failed.map((r) => r.capability).sort()).toEqual([
      "fundamentals",
      "historicalBars",
      "quotes",
    ]);
    expect(failed.every((r) => r.providerId === "alpaca")).toBe(true);
  });

  it("production construction with an empty env → honest ok:false (no keys, no crash)", async () => {
    const result = await verifyAlpacaDataProvider({} as Env);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not configured/);
  });

  it("conformance parity field-for-field over the injected provider", async () => {
    const adapter = createAlpacaDataProvider(fixtureMarketData());
    const report = await runDataProviderConformance(adapter);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.capability)).toEqual([
      "quotes",
      "historicalBars",
      "fundamentals",
    ]);
  });
});

describe("binding: buildDataProviderVerifier binds alpaca; unknown ids stay unbound", () => {
  it("alpaca is bound; etrade/public/yahoo/nasdaq stay bound; unknown ids return undefined", () => {
    const env = {} as Env;
    expect(buildDataProviderVerifier(env, LOGIN, "alpaca")).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "etrade")).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "public", null)).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "yahoo")).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "nasdaq")).toBeDefined();
    expect(buildDataProviderVerifier(env, LOGIN, "no-such-provider")).toBeUndefined();
  });

  it("routes POST verify for alpaca no longer fails with 'no adapter' — it fails honestly as not configured", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const { ctx } = makeRouteCtx(sql);
    const res = await callRoute(ctx, "POST", "/data-providers/alpaca/verify", {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).not.toMatch(/no adapter/);
    expect(body.error).toMatch(/not configured/);
    expect(getProviderConfig(sql as never, "alpaca")?.lifecycleState).toBe("configured");
  });

  it("routes mutations for alpaca without a session keep the exact 401 body", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const { ctx } = makeRouteCtx(sql, { userLogin: "" });
    for (const action of ["verify", "enable"]) {
      const res = await callRoute(ctx, "POST", `/data-providers/alpaca/${action}`, {});
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized: Please log in." });
    }
    expect(getProviderConfig(sql as never, "alpaca")?.lifecycleState).toBe("configured");
  });

  it("routes GET /data-providers/alpaca serves the seeded record", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const { ctx } = makeRouteCtx(sql);
    const res = await callRoute(ctx, "GET", "/data-providers/alpaca");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.provider.id).toBe("alpaca");
    expect(body.provider.lifecycleState).toBe("configured");
    expect(body.provider.enabled).toBe(false);
  });
});

describe("lifecycle + routes: alpaca verifies, enables, and serves with health; no route changes", () => {
  it("verify → enable through transitionProvider; GET serves alpaca enabled with a health block", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    expect(getProviderConfig(sql as never, "alpaca")?.lifecycleState).toBe("configured");
    const verifier = () => verifyAlpacaDataProvider(undefined, { provider: fixtureMarketData() });
    const verified = await transitionProvider(sql as never, "alpaca", "verify", "tester", {
      verifier: verifier as never,
    });
    expect(verified.lifecycleState).toBe("verified");
    const enabled = await transitionProvider(sql as never, "alpaca", "enable", "tester", {});
    expect(enabled.lifecycleState).toBe("enabled");
    expect(enabled.enabled).toBe(true);

    // A capture under the run gives the health block activity to report.
    const adapter = createAlpacaDataProvider(fixtureMarketData(), undefined, {
      capture: captureDeps(sql),
    });
    await adapter.getQuote!("AAPL", RUN);

    const { ctx } = makeRouteCtx(sql);
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const alpaca = body.providers.find((p: any) => p.id === "alpaca");
    expect(alpaca.lifecycleState).toBe("enabled");
    expect(alpaca.enabled).toBe(true);
    expect(alpaca.health).toBeDefined();
    expect(typeof alpaca.health.status).toBe("string");
  });

  it("no seeded route names alpaca, and every seeded route is unchanged except quotes gap-fill (issue #2144)", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const routes = listCapabilityRoutes(sql as never);
    expect(routes.map((r) => r.capability).sort()).toEqual([
      "fundamentals",
      "historicalBars",
      "optionsChains",
      "quotes",
      "screenUniverse",
    ]);
    const byCap = new Map(routes.map((r) => [r.capability, r]));
    expect(byCap.get("quotes")?.primaryProviderId).toBe("etrade");
    // Issue #2144: the seed names no quotes gap-fill.
    expect(byCap.get("quotes")?.gapFillProviderId).toBeNull();
    expect(byCap.get("historicalBars")?.primaryProviderId).toBe("yahoo");
    expect(byCap.get("historicalBars")?.gapFillProviderId).toBeNull();
    expect(byCap.get("fundamentals")?.primaryProviderId).toBe("yahoo");
    expect(byCap.get("fundamentals")?.gapFillProviderId).toBeNull();
    expect(byCap.get("screenUniverse")?.primaryProviderId).toBe("nasdaq");
    expect(byCap.get("screenUniverse")?.gapFillProviderId).toBeNull();
    expect(byCap.get("optionsChains")?.primaryProviderId).toBe("etrade");
    expect(byCap.get("optionsChains")?.gapFillProviderId).toBeNull();
    expect(routes.every((r) => r.minTier === "freemium")).toBe(true);
    expect(routes.some((r) => r.primaryProviderId === "alpaca" || r.gapFillProviderId === "alpaca")).toBe(false);
  });

  it("GET provider order is unchanged (precedence order, alpaca last)", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const { ctx } = makeRouteCtx(sql);
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.providers.map((p: any) => p.id)).toEqual([
      "etrade",
      "public",
      "yahoo",
      "nasdaq",
      "alpaca",
    ]);
  });
});

describe("seed: alpaca record is configured/disabled, precedence 5, reference-only credential", () => {
  it("seeded alpaca record matches the epic's provider set (last in precedence order)", () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const record = getProviderConfig(sql as never, "alpaca");
    expect(record?.lifecycleState).toBe("configured");
    expect(record?.enabled).toBe(false);
    expect(record?.precedence).toBe(5);
    expect(record?.credentialRef).toBe("env:ALPACA_API_KEY");
    expect(record?.adapterKind).toBe("alpaca-market-data");
  });
});
