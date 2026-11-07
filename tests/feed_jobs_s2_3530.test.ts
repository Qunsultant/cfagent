/**
 * Issue #3530 (one-of-everything, S2) — feed-job pins for the
 * remaining named sources. TDD Red first.
 *
 * Scope pinned here:
 * - Registry: the built-in registry now carries three jobs on the
 *   ONE S1 contract — yahoo (unchanged), etrade-nasdaq100-quotes,
 *   alpaca-nasdaq100-quotes — and still none for nasdaq (contract
 *   misfit, see the S2 design addendum) or public (out of scope).
 * - E*TRADE end-to-end through the REAL capture-wired adapter:
 *   success persists ETradeQuote rows verbatim + the run record,
 *   with one capture per sub-batch (rawKind "provider-response",
 *   screening's E*TRADE batch shape) under the job's run id;
 *   credential honesty — the REAL production construction over a
 *   sandbox env with no token anywhere ends in a typed
 *   FEED_NO_QUOTES_RETURNED failure (never fabricated rows, never
 *   an empty success), and a throwing surface (the live no-token
 *   shape) ends in FEED_FETCH_FAILED.
 * - Alpaca end-to-end: the wrapped provider gains the batch leg
 *   (AlpacaMarketDataProvider.getQuotes over the multi-symbol
 *   snapshots endpoint — the #1317 Yahoo precedent), the adapter
 *   factory picks it up, captures land as ONE provider-result row
 *   per batch call (screening's market-data shape); credential
 *   honesty — the REAL provider on an empty env fails the run
 *   FEED_FETCH_FAILED with the #923 no-substitute message, and no
 *   fetch is attempted.
 * - getQuotes unit pins: payload mapping (latestTrade price,
 *   prevDailyBar previousClose, dailyBar OHLCV, latestQuote
 *   bid/ask), omitted symbols stay absent, HTTP failure and empty
 *   payload throw, unconfigured throws before any fetch.
 * - Read path + status for the new sources; routes: etrade/alpaca
 *   feed blocks + runs (incl. the DEFAULT capture-wired wiring),
 *   nasdaq stays jobless (null block, typed 404s) — the misfit
 *   made visible at the surface.
 *
 * No secret-shaped literals: credential fixture values are
 * assembled from string fragments at runtime.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { IndexListStore } from "../src/data/indexListPorts";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  readFeedQuotes,
  runFeedJob,
  FEED_JOB_CODES,
} from "../src/services/feedJobs";
import type { DataProvider } from "../src/trading/dataProviders/contract";
import {
  createAlpacaDataProvider,
  createETradeDataProvider,
  createETradeDataProviderFromEnv,
  type ETradeDataSurface,
} from "../src/trading/dataProviders/adapters";
import {
  ensureCaptureTable,
  listCapturesByRun,
} from "../src/trading/dataProviders/captureStore";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import type { ETradeBrokerStatus, ETradeQuote, MarketDataResearchQuote } from "../src/types";
import type { Env } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA"];

async function universeStore(symbols: string[] = SYMBOLS): Promise<IndexListStore> {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: symbols.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  return store;
}

function blobStorageDouble() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function etradeQuote(symbol: string, price = 232.5): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Inc.`,
    lastPrice: price,
    change: 1.2,
    changePercent: 0.52,
    bid: price - 0.1,
    ask: price + 0.1,
    volume: 1_000_000,
    open: 230.0,
    high: 233.0,
    low: 229.0,
    timestamp: iso(T0),
  } as unknown as ETradeQuote;
}

function mdQuote(symbol: string, provider: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider,
    provenance: "live",
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    timestamp: iso(T0),
  } as MarketDataResearchQuote;
}

/**
 * The E*TRADE wrapped surface as a test double — the seam S1 used
 * for Yahoo (the provider's own surface under the REAL adapter).
 * fetchQuotesRemote honors the onWireResponse hook the way the
 * real client does: one call per sub-batch (≤2 symbols here so the
 * two-sub-batch capture shape is exercised), then the quotes.
 */
function etradeSurfaceDouble(
  behaviour: "quotes" | "empty" | "throws",
): ETradeDataSurface {
  const wirePayload = (symbols: string[]) => ({
    QuoteResponse: {
      QuoteData: symbols.map((s) => ({ Product: { symbol: s } })),
    },
  });
  return {
    getStatus: () =>
      ({ broker: "etrade", configured: true }) as unknown as ETradeBrokerStatus,
    getQuoteAsync: async (symbol: string) => etradeQuote(symbol),
    getOptionChains: async () => null,
    getOptionExpireDates: async () => [],
    fetchQuotesRemote: async (
      symbols: string[],
      _trace?: unknown,
      onWireResponse?: (batchSymbols: string[], payload: unknown) => void,
    ) => {
      if (behaviour === "throws") {
        throw new Error("E*TRADE request failed: no stored session token for the login");
      }
      if (behaviour === "empty") return [];
      for (let i = 0; i < symbols.length; i += 2) {
        const batch = symbols.slice(i, i + 2);
        onWireResponse?.(batch, wirePayload(batch));
      }
      return symbols.map((s) => etradeQuote(s));
    },
  } as unknown as ETradeDataSurface;
}

/** The Alpaca wrapped market-data surface (IMarketDataProvider + the batch leg). */
function alpacaInnerDouble(quotes: MarketDataResearchQuote[] | Error) {
  return {
    providerId: "alpaca" as const,
    name: "fixture",
    isConfigured: () => true,
    getQuote: async (s: string) => mdQuote(s, "alpaca"),
    getFundamentals: async (s: string) => {
      throw new Error(`no fundamentals fixture for ${s}`);
    },
    getHistoricalBars: async () => [],
    getQuotes: async (_symbols: string[]) => {
      if (quotes instanceof Error) throw quotes;
      return quotes;
    },
  };
}

const ALPACA_KEY = ["test", "key"].join("-");
const ALPACA_SECRET = ["test", "secret"].join("-");
const alpacaEnv = {
  ALPACA_API_KEY: ALPACA_KEY,
  ALPACA_SECRET_KEY: ALPACA_SECRET,
} as unknown as Env;

function snapshotPayload() {
  return {
    snapshots: {
      AAPL: {
        latestTrade: { p: 232.5, s: 100, t: iso(T0) },
        latestQuote: { bp: 232.4, bs: 3, ap: 232.6, as: 2, t: iso(T0) },
        dailyBar: { o: 230.0, h: 233.0, l: 229.0, c: 232.5, v: 1_000_000, vw: 231.8, t: iso(T0) },
        prevDailyBar: { o: 228.0, h: 231.0, l: 227.5, c: 231.3, v: 900_000, vw: 230.1, t: iso(T0 - 86400_000) },
      },
      MSFT: {
        latestTrade: { p: 410.25, s: 50, t: iso(T0) },
        latestQuote: { bp: 410.2, bs: 1, ap: 410.3, as: 1, t: iso(T0) },
        dailyBar: { o: 405.0, h: 411.0, l: 404.0, c: 410.25, v: 500_000, vw: 408.9, t: iso(T0) },
        prevDailyBar: { o: 400.0, h: 406.0, l: 399.0, c: 405.1, v: 450_000, vw: 403.2, t: iso(T0 - 86400_000) },
      },
      // NVDA deliberately absent: Alpaca omits it, the caller diffs.
    },
  };
}

function stubFetch(handler: (url: string) => Promise<unknown>) {
  const mock = vi.fn(async (input: unknown) => handler(String(input)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function fetchResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (_h: string) => null },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Registry — three jobs, one contract
// ---------------------------------------------------------------------------

describe("feed job registry (#3530 S2)", () => {
  it("carries the Yahoo job unchanged plus the E*TRADE and Alpaca Nasdaq-100 quotes jobs", () => {
    const registry = buildFeedJobRegistry({});
    // Composed with #3535 (pipeline J2): the registry also carries the J2 jobs
    // (yahoo fundamentals, yahoo SP100, public quotes) on the same contract —
    // the S2 jobs below are asserted unchanged within the composed list.
    expect(registry.list().map((j) => j.id).sort()).toEqual([
      "alpaca-nasdaq100-quotes",
      "etrade-nasdaq100-quotes",
      "public-nasdaq100-quotes",
      "yahoo-nasdaq100-fundamentals",
      "yahoo-nasdaq100-quotes",
      "yahoo-sp100-quotes",
    ]);
    for (const [id, sourceId] of [
      ["etrade-nasdaq100-quotes", "etrade"],
      ["alpaca-nasdaq100-quotes", "alpaca"],
    ] as const) {
      const job = registry.get(id)!;
      expect(job.sourceId).toBe(sourceId);
      expect(job.dataset).toBe("quotes");
      expect(job.elements).toEqual(["quotes"]);
      expect(job.universe).toMatchObject({ kind: "index", index: "nasdaq100", label: "Nasdaq-100" });
      expect(job.cadenceMinutes).toBe(60);
      expect(job.staleAfterMinutes).toBe(180);
      expect(registry.forSource(sourceId)?.id).toBe(id);
    }
  });

  it("nasdaq still has no feed job (the S2 contract misfit); public gained one in #3535", () => {
    const registry = buildFeedJobRegistry({});
    expect(registry.forSource("nasdaq")).toBeUndefined();
    // #3535 (pipeline J2, epic #3533) scopes Public in: its quotes legs allow it.
    expect(registry.forSource("public")?.id).toBe("public-nasdaq100-quotes");
  });

  it("the new jobs' cadence/staleness knobs resolve through the same env scheme", () => {
    const registry = buildFeedJobRegistry({
      FEED_JOB_ETRADE_NASDAQ100_QUOTES_CADENCE_MINUTES: "240",
      FEED_JOB_ALPACA_NASDAQ100_QUOTES_STALE_MINUTES: "720",
    });
    expect(registry.get("etrade-nasdaq100-quotes")?.cadenceMinutes).toBe(240);
    expect(registry.get("etrade-nasdaq100-quotes")?.staleAfterMinutes).toBe(180);
    expect(registry.get("alpaca-nasdaq100-quotes")?.cadenceMinutes).toBe(60);
    expect(registry.get("alpaca-nasdaq100-quotes")?.staleAfterMinutes).toBe(720);
  });
});

// ---------------------------------------------------------------------------
// E*TRADE runs — through the REAL capture-wired adapter
// ---------------------------------------------------------------------------

describe("runFeedJob — etrade (#3530 S2)", () => {
  const registry = buildFeedJobRegistry({});

  function captureWired(behaviour: "quotes" | "empty" | "throws") {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql);
    const provider = createETradeDataProvider(etradeSurfaceDouble(behaviour), {
      capture: { sql, blobStorage: blobStorageDouble(), env: {} },
    });
    return { sql, provider };
  }

  it("happy path: persists the E*TRADE quotes verbatim + run record; captures land per sub-batch in screening's shape", async () => {
    const { sql, provider } = captureWired("quotes");
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "etrade-nasdaq100-quotes",
      { runId: "feed-run-etrade-ok", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    expect(result.requested).toBe(3);
    expect(result.received).toBe(3);
    const artifact = await datasetStore.latest("etrade", "quotes");
    expect(artifact?.providerId).toBe("etrade");
    expect(artifact?.jobId).toBe("etrade-nasdaq100-quotes");
    expect(artifact?.quotes.map((q) => (q as ETradeQuote).symbol)).toEqual(SYMBOLS);
    expect(artifact?.quotes[0]).toMatchObject({ lastPrice: 232.5 });

    const captures = listCapturesByRun(sql, "default", "feed-run-etrade-ok");
    expect(captures).toHaveLength(2); // two sub-batches of ≤2 symbols
    for (const row of captures) {
      expect(row).toMatchObject({
        providerId: "etrade",
        capability: "quotes",
        status: "captured",
        rawKind: "provider-response",
        runId: "feed-run-etrade-ok",
        tenantId: "default",
      });
    }
    const capturedSymbols = captures
      .flatMap((r) => (r.requestParams as { symbols: string[] }).symbols)
      .sort();
    expect(capturedSymbols).toEqual([...SYMBOLS].sort());
  });

  it("no live token (REAL production construction, sandbox env, no token anywhere): typed FEED_NO_QUOTES_RETURNED failure, nothing usable persisted", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql);
    const provider = createETradeDataProviderFromEnv(
      { ETRADE_ENVIRONMENT: "sandbox" } as Env,
      "boss",
      { capture: { sql, blobStorage: blobStorageDouble(), env: {} } },
    );
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "etrade-nasdaq100-quotes",
      { runId: "feed-run-etrade-notoken", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.noQuotesReturned);
    expect(result.received).toBe(0);
    const artifact = await datasetStore.latest("etrade", "quotes");
    expect(artifact?.run.status).toBe("failed");
    expect(artifact?.run.codedError).toBe(FEED_JOB_CODES.noQuotesReturned);
    expect(await datasetStore.latestUsable("etrade", "quotes")).toBeUndefined();
    // The attempt still leaves its audit capture (the adapter's
    // no-wire-response path): one provider-result row, never a
    // fabricated wire payload.
    const captures = listCapturesByRun(sql, "default", "feed-run-etrade-notoken");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      providerId: "etrade",
      capability: "quotes",
      rawKind: "provider-result",
    });
  });

  it("live-shape token failure (the surface throws): typed FEED_FETCH_FAILED failure, scrubbed, never rethrown", async () => {
    const { provider } = captureWired("throws");
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "etrade-nasdaq100-quotes",
      { runId: "feed-run-etrade-throws", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.fetchFailed);
    const artifact = await datasetStore.latest("etrade", "quotes");
    expect(artifact?.run.codedError).toBe(FEED_JOB_CODES.fetchFailed);
    expect(await datasetStore.latestUsable("etrade", "quotes")).toBeUndefined();
  });

  it("reads + status serve the E*TRADE copy with its provenance after a run", async () => {
    const { provider } = captureWired("quotes");
    const datasetStore = new InMemoryFeedDatasetStore();
    await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "etrade-nasdaq100-quotes",
      { runId: "feed-run-etrade-read", now: () => new Date(T0) },
    );
    const read = await readFeedQuotes(datasetStore, {
      sourceId: "etrade",
      dataset: "quotes",
      symbols: ["AAPL"],
      nowMs: T0 + 60_000,
    });
    expect(read.status).toBe("hit");
    if (read.status !== "hit") throw new Error("unreachable");
    expect(read.provenance).toMatchObject({
      providerId: "etrade",
      jobId: "etrade-nasdaq100-quotes",
      runId: "feed-run-etrade-read",
    });
    const status = await buildFeedStatus(
      datasetStore,
      registry.get("etrade-nasdaq100-quotes")!,
      T0 + 60_000,
    );
    expect(status.state).toBe("ready");
    expect(status.snapshot).toMatchObject({ rowsPersisted: 3 });
  });
});

// ---------------------------------------------------------------------------
// Alpaca — the batch leg + runs through the REAL adapter
// ---------------------------------------------------------------------------

describe("AlpacaMarketDataProvider.getQuotes (#3530 S2 batch leg)", () => {
  it("maps the multi-symbol snapshots payload onto quote rows; omitted symbols stay absent", async () => {
    const seen: string[] = [];
    stubFetch(async (url) => {
      seen.push(url);
      return fetchResponse(true, 200, snapshotPayload());
    });
    const provider = new AlpacaMarketDataProvider(alpacaEnv);
    const quotes = await provider.getQuotes(["AAPL", "MSFT", "NVDA"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/v2/stocks/snapshots");
    expect(seen[0]).toContain(encodeURIComponent("AAPL,MSFT,NVDA"));
    expect(quotes.map((q) => q.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(quotes[0]).toMatchObject({
      symbol: "AAPL",
      provider: "alpaca",
      provenance: "live",
      price: 232.5,
      lastPrice: 232.5,
      previousClose: 231.3,
      change: 1.2,
      bid: 232.4,
      ask: 232.6,
      volume: 1_000_000,
      open: 230.0,
      high: 233.0,
      low: 229.0,
      currency: "USD",
    });
    expect(quotes[0].changePercent).toBeCloseTo(0.52, 2);
  });

  it("unconfigured (no key/secret): throws the #923 no-substitute error BEFORE any fetch", async () => {
    const fetchMock = stubFetch(async () => fetchResponse(true, 200, snapshotPayload()));
    const provider = new AlpacaMarketDataProvider({} as Env);
    await expect(provider.getQuotes(["AAPL"])).rejects.toThrow(
      /no static, generated, or synthetic substitute is served/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP failure throws (the batch idiom); a payload with no usable rows throws instead of returning an empty success", async () => {
    stubFetch(async () => fetchResponse(false, 500, { message: "boom" }));
    const provider = new AlpacaMarketDataProvider(alpacaEnv);
    await expect(provider.getQuotes(["AAPL"])).rejects.toThrow(/Alpaca batch quotes HTTP 500/);

    stubFetch(async () => fetchResponse(true, 200, { snapshots: {} }));
    await expect(provider.getQuotes(["AAPL"])).rejects.toThrow(/returned no results/);
  });

  it("an empty symbol list returns [] without fetching", async () => {
    const fetchMock = stubFetch(async () => fetchResponse(true, 200, snapshotPayload()));
    const provider = new AlpacaMarketDataProvider(alpacaEnv);
    expect(await provider.getQuotes([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("runFeedJob — alpaca (#3530 S2)", () => {
  const registry = buildFeedJobRegistry({});

  it("the adapter factory picks up the real provider's batch leg (getQuotesBatch exists for the REAL provider now)", () => {
    const adapter = createAlpacaDataProvider(new AlpacaMarketDataProvider(alpacaEnv), alpacaEnv);
    expect(typeof adapter.getQuotesBatch).toBe("function");
  });

  it("happy path: persists quotes verbatim; ONE provider-result capture for the batch call under the job's run id", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql);
    const provider = createAlpacaDataProvider(
      alpacaInnerDouble(SYMBOLS.map((s) => mdQuote(s, "alpaca"))) as never,
      {} as Env,
      { capture: { sql, blobStorage: blobStorageDouble(), env: {} } },
    );
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "alpaca-nasdaq100-quotes",
      { runId: "feed-run-alpaca-ok", now: () => new Date(T0) },
    );
    expect(result.status).toBe("completed");
    expect(result.received).toBe(3);
    const artifact = await datasetStore.latest("alpaca", "quotes");
    expect(artifact?.providerId).toBe("alpaca");
    expect(artifact?.quotes.map((q) => (q as MarketDataResearchQuote).symbol)).toEqual(SYMBOLS);

    const captures = listCapturesByRun(sql, "default", "feed-run-alpaca-ok");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      providerId: "alpaca",
      capability: "quotes",
      status: "captured",
      rawKind: "provider-result",
      runId: "feed-run-alpaca-ok",
    });
    expect((captures[0].requestParams as { symbols: string[] }).symbols).toEqual(SYMBOLS);
  });

  it("partial: symbols the provider omitted are named missing and the rest persist", async () => {
    const provider = createAlpacaDataProvider(
      alpacaInnerDouble([mdQuote("AAPL", "alpaca")]) as never,
      {} as Env,
    );
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "alpaca-nasdaq100-quotes",
      { runId: "feed-run-alpaca-partial", now: () => new Date(T0) },
    );
    expect(result.status).toBe("partial");
    expect(result.missingSymbols).toEqual(["MSFT", "NVDA"]);
    expect((await datasetStore.latest("alpaca", "quotes"))?.quotes).toHaveLength(1);
  });

  it("missing credentials (REAL provider, empty env): the run fails FEED_FETCH_FAILED carrying the no-substitute honesty, nothing usable persisted", async () => {
    const provider = createAlpacaDataProvider(
      new AlpacaMarketDataProvider({} as Env),
      {} as Env,
    );
    const datasetStore = new InMemoryFeedDatasetStore();
    const result = await runFeedJob(
      registry,
      { provider, universeStore: await universeStore(), datasetStore },
      "alpaca-nasdaq100-quotes",
      { runId: "feed-run-alpaca-nocreds", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.fetchFailed);
    const artifact = await datasetStore.latest("alpaca", "quotes");
    expect(artifact?.run.errorMessage ?? "").toMatch(/no static, generated, or synthetic substitute/);
    expect(await datasetStore.latestUsable("alpaca", "quotes")).toBeUndefined();

    const status = await buildFeedStatus(
      datasetStore,
      registry.get("alpaca-nasdaq100-quotes")!,
      T0,
    );
    expect(status.state).toBe("ready"); // a run exists…
    expect(status.lastRun).toMatchObject({ status: "failed", codedError: FEED_JOB_CODES.fetchFailed });
    expect(status.snapshot).toBeNull(); // …but no usable copy is claimed
  });
});

// ---------------------------------------------------------------------------
// Routes — the new sources on the surface; nasdaq stays jobless
// ---------------------------------------------------------------------------

describe("feed routes (#3530 S2)", () => {
  async function makeCtx(overrides?: Partial<DataProviderRoutesContext>) {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql);
    ensureCaptureTable(sql);
    const datasetStore = new InMemoryFeedDatasetStore();
    const universeStore = new InMemoryIndexListStore();
    await universeStore.store({
      index: "nasdaq100",
      snapshotDate: "2026-11-02",
      symbols: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
      source: "wikipedia",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      derivedFromHoldings: false,
    });
    const auditRows: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx: DataProviderRoutesContext = {
      env: {} as Env,
      sql,
      userLogin: "octocat",
      recordAudit: (type, _agent, payload) => {
        auditRows.push({ type, payload });
        return { id: "audit-1" };
      },
      feedDatasetStore: datasetStore,
      feedUniverseStore: universeStore,
      blobStorage: blobStorageDouble(),
      ...overrides,
    };
    return { ctx, datasetStore, auditRows };
  }

  function callRoute(
    ctx: DataProviderRoutesContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`https://agent.internal${path}`);
    const request = new Request(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return handleDataProviderRoutes(request, url, url.pathname, "session-1", ctx) as Promise<Response>;
  }

  it("GET /data-providers carries never-run feed blocks for etrade + alpaca, and null for nasdaq (no job — the misfit)", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    for (const [id, jobId] of [
      ["etrade", "etrade-nasdaq100-quotes"],
      ["alpaca", "alpaca-nasdaq100-quotes"],
    ] as const) {
      const view = body.providers.find((p: any) => p.id === id);
      expect(view.feed).toMatchObject({ jobId, state: "never-run", lastRun: null, snapshot: null });
    }
    const nasdaq = body.providers.find((p: any) => p.id === "nasdaq");
    expect(nasdaq.feed).toBeNull();
  });

  it("POST /data-providers/nasdaq/feed-run is still a typed 404 — no job exists to run", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "POST", "/data-providers/nasdaq/feed-run", {});
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("FEED_JOB_NOT_FOUND");
  });

  it("POST etrade feed-run through an injected provider runs end-to-end and audits", async () => {
    const provider = createETradeDataProvider(etradeSurfaceDouble("quotes"), {});
    const { ctx, auditRows } = await makeCtx({ feedProviderFor: () => provider });
    const res = await callRoute(ctx, "POST", "/data-providers/etrade/feed-run", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.run).toMatchObject({ status: "completed", requested: 2, received: 2 });
    expect(body.feed.snapshot).toMatchObject({ rowsPersisted: 2 });
    expect(
      auditRows.some(
        (r) => r.type === "data_provider.feed_run" && r.payload.providerId === "etrade",
      ),
    ).toBe(true);
  });

  it("POST etrade feed-run through the DEFAULT wiring (no provider injection): the sandbox/no-token reality surfaces as a recorded failed run, not an error or a fake success", async () => {
    // Explicit sandbox env: an empty env would resolve to PROD via
    // environment.config.json and the run would attempt a live call.
    const { ctx } = await makeCtx({
      env: { ETRADE_ENVIRONMENT: "sandbox" } as Env,
    });
    const res = await callRoute(ctx, "POST", "/data-providers/etrade/feed-run", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.run).toMatchObject({
      status: "failed",
      codedError: FEED_JOB_CODES.noQuotesReturned,
    });
    expect(body.feed.lastRun).toMatchObject({ status: "failed" });
    expect(body.feed.snapshot).toBeNull();
  });

  it("POST alpaca feed-run through the DEFAULT wiring with no credentials configured: recorded FEED_FETCH_FAILED run", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "POST", "/data-providers/alpaca/feed-run", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.run).toMatchObject({
      status: "failed",
      codedError: FEED_JOB_CODES.fetchFailed,
    });
    expect(body.feed.snapshot).toBeNull();
  });

  it("GET /data-providers/alpaca/feed reports missing before any run (typed state in a 200 body)", async () => {
    const { ctx } = await makeCtx();
    const res = await callRoute(ctx, "GET", "/data-providers/alpaca/feed?symbols=AAPL");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.feed.state).toBe("never-run");
    expect(body.quotes.status).toBe("missing");
  });
});
