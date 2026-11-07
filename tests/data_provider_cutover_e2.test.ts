/**
 * Issue #1157 (E2 of epic #1116) — screening cutover pins.
 *
 * E2 routes the two production screening paths through the data-
 * provider platform built by P1 (#1118) and E1 (#1133):
 *
 *  - Batch quotes end-to-end: ETradeRestClient.fetchQuotes gains an
 *    opt-in onWireResponse hook (the parsed sub-batch payload, before
 *    normalization discards it); ETradeService.fetchQuotesRemote
 *    forwards it; the contract gains getQuotesBatch and the E*TRADE
 *    adapter captures ONE record per sub-batch (rawKind
 *    "provider-response") while returning the normalized quotes with
 *    no raw attached.
 *  - Expiry dates join the platform: the adapter's
 *    getOptionExpiryDates serves them under the optionsChains
 *    capability, captured with request params kind=expiryDates.
 *  - bootstrapDataProviders: seeds configs+routes and enables etrade
 *    ONLY, idempotently — before it, route resolution throws; after
 *    it, quotes/optionsChains resolve to etrade and every other
 *    provider stays non-enabled.
 *  - UnifiedOptionsService with platform deps runs its engines
 *    through the adapter (captures carry the run id that becomes the
 *    persisted scan-run id); without deps the scan output is
 *    identical and nothing is captured.
 *  - The stock screener's quote binding (bindEtradeQuoteDeps)
 *    routes batch + single quotes through the adapter with the run
 *    context and the QuoteTrace plumbing preserved.
 *
 * Fixtures are deterministic (fake surfaces / mocked fetch in the
 * E1 + #168 patterns). No live market data, no network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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

import { MockSqlStorage } from "./mock-sql";
import { makeFakeSessionStore } from "./fake-session-store";
import { ETradeRestClient } from "../src/trading/etrade/client";
import { ETradeService } from "../src/services/etrade";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { createETradeDataProvider } from "../src/trading/dataProviders/adapters";
import { bindEtradeQuoteDeps } from "../src/trading/screenerPipeline";
import { bootstrapDataProviders } from "../src/trading/dataProviders/providerConfigStore";
import {
  listProviderConfigs,
  listCapabilityRoutes,
} from "../src/trading/dataProviders/providerConfigStore";
import {
  DataProviderRegistry,
  DataProviderNotFoundError,
} from "../src/trading/dataProviders/registry";
import {
  listCapturesByRun,
  readCaptureRaw,
} from "../src/trading/dataProviders/captureStore";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { InMemoryScanRunStore } from "../src/trading/options/scanRunStore";
import type { Env, ETradeQuote } from "../src/types";

// ---------------------------------------------------------------------------
// Shared fixtures / fakes
// ---------------------------------------------------------------------------

const BATCH_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META",
  "TSLA", "AMD", "NFLX", "INTC", "CRM", "ORCL",
];

function quoteFixture(symbol: string, price = 100): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Corp`,
    lastPrice: price,
    price,
    change: 1,
    changePercent: 1,
    bid: price - 0.5,
    ask: price + 0.5,
    volume: 1000,
    open: price,
    high: price + 1,
    low: price - 1,
    week52High: price + 50,
    week52Low: price - 50,
    timestamp: "2026-10-23T13:30:00.000Z",
  } as unknown as ETradeQuote;
}

/** The parsed QuoteResponse wire payload for one sub-batch — carries
 *  a wireOnlySentinel field normalization drops, so bytes captured
 *  from it provably are the wire object, not the normalized result. */
function batchWirePayload(symbols: string[]) {
  return {
    QuoteResponse: {
      QuoteData: symbols.map((symbol, i) => ({
        Product: { symbol, securityType: "EQ" },
        All: {
          symbol,
          companyName: `${symbol} Corp`,
          lastTrade: 100 + i,
          changeClose: 1,
          changeClosePercentage: 0.5,
          bid: 99.5,
          ask: 100.5,
          totalVolume: 1000,
          open: 99,
          high: 101,
          low: 98,
          high52: 150,
          low52: 50,
          wireOnlySentinel: `wire-${symbol}`,
        },
        dateTime: "23 Oct 2026 13:30:00 EDT",
        quoteStatus: "REALTIME",
      })),
    },
  };
}

function fakeBlobStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function freshSql(): any {
  return new MockSqlStorage() as any;
}

function captureDeps(sql: any, storage: any = fakeBlobStorage()) {
  return { sql, blobStorage: storage, env: {} };
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const EXPIRY_DATES_FIXTURE = [
  { year: 2026, month: 12, day: 18, expiryType: "MONTHLY" },
  { year: 2027, month: 1, day: 15, expiryType: "MONTHLY" },
];

/** Fake ETradeDataSurface with the E2 members: fetchQuotesRemote
 *  simulates the client's sub-batching (10 per request) and fires
 *  the wire callback per sub-batch exactly as the real client does. */
function fakeETradeSurface() {
  const batchCalls: Array<{ symbols: string[]; trace: unknown; onWire: unknown }> = [];
  return {
    batchCalls,
    getQuoteAsync: async (symbol: string, options?: any) => {
      const quote = quoteFixture(symbol);
      if (options?.includeRawResponse) {
        return { ...quote, raw: batchWirePayload([symbol]) } as ETradeQuote;
      }
      return quote;
    },
    getOptionChains: async () => null,
    getOptionExpireDates: async (_symbol: string) => EXPIRY_DATES_FIXTURE,
    getStatus: () => ({ broker: "etrade", configured: true }) as any,
    fetchQuotesRemote: async (symbols: string[], trace?: any, onWire?: any) => {
      batchCalls.push({ symbols, trace, onWire });
      const out: ETradeQuote[] = [];
      for (let i = 0; i < symbols.length; i += 10) {
        const batch = symbols.slice(i, i + 10);
        onWire?.(batch, batchWirePayload(batch));
        out.push(...batch.map((s) => quoteFixture(s)));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// A1 — the client wire hook
// ---------------------------------------------------------------------------

describe("fetchQuotes onWireResponse hook (issue #1157)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function hookEnv() {
    const userLogin = `e2_batch_trader_${Math.random().toString(36).slice(2, 8)}`;
    const kvStorage: Record<string, string> = {};
    const mockKv = {
      get: async (k: string) => kvStorage[k] || null,
      put: async (k: string, v: string) => {
        kvStorage[k] = v;
      },
      delete: async (k: string) => {
        delete kvStorage[k];
      },
    } as any;
    const { namespace: sessionStoreNs } = makeFakeSessionStore();
    const env = {
      APP_NAME: "cfagent-test",
      APP_BASE_URL: "https://agent.openaimp.com",
      SESSION_SECRET: "test-session-secret",
      GITHUB_CLIENT_ID: "gh_id",
      GITHUB_CLIENT_SECRET: "gh_secret",
      AI_SEARCH_ENDPOINT: "https://ai.example.com",
      SESSION_STORE: sessionStoreNs,
      ETRADE_KV: mockKv,
      ORCHESTRATOR_AGENT: {} as any,
      ASSETS: {} as any,
      AI: {} as any,
      APP_ENV: "TEST",
      ET_API_KEY: "test_api_key",
      ET_API_SECRET: "test_api_secret",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_ACCOUNT_ID_KEY: "ACCOUNT_KEY_XYZ999",
    } as unknown as Env;
    return { env, userLogin };
  }

  function stubBatchFetch() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      const tail = url.split("/market/quote/")[1] ?? "";
      const symbols = decodeURIComponent(tail.split("?")[0].replace(/\.json$/, ""))
        .split(",")
        .filter(Boolean);
      return new Response(JSON.stringify(batchWirePayload(symbols)), { status: 200 });
    });
  }

  it("fires once per sub-batch with that sub-batch's symbols and the full parsed payload; quotes are unchanged by the hook", async () => {
    const { env, userLogin } = hookEnv();
    await storeAccessTokens(env, userLogin, "valid_token", "valid_secret");
    stubBatchFetch();
    const client = new ETradeRestClient(env, userLogin);

    const seen: Array<{ symbols: string[]; payload: any }> = [];
    const hooked = await client.fetchQuotes(BATCH_SYMBOLS, {
      onWireResponse: (symbols, payload) => {
        seen.push({ symbols, payload });
      },
    });

    // 12 symbols → sub-batches of 10 + 2, one callback each.
    expect(seen).toHaveLength(2);
    expect(seen[0].symbols).toEqual(BATCH_SYMBOLS.slice(0, 10));
    expect(seen[1].symbols).toEqual(BATCH_SYMBOLS.slice(10));
    // The payload is the full wire object — wrapper and the fields
    // normalization drops included.
    expect(seen[0].payload).toEqual(batchWirePayload(BATCH_SYMBOLS.slice(0, 10)));
    expect(
      seen[0].payload.QuoteResponse.QuoteData[0].All.wireOnlySentinel
    ).toBe("wire-AAPL");
    expect(hooked.map((q) => q.symbol)).toEqual(BATCH_SYMBOLS);

    // Without the option: no callback exists to fire, and the quotes
    // are identical to the hooked run's.
    const plain = await client.fetchQuotes(BATCH_SYMBOLS);
    expect(plain).toEqual(hooked);
  });

  it("service: fetchQuotesRemote forwards onWireResponse to the client; a default call passes no options object (the #495 pin shape)", async () => {
    const liveEnv = { ETRADE_ENVIRONMENT: "live" } as Env;
    const service = new ETradeService(liveEnv, undefined, "test-user");
    const fetchQuotes = vi.fn(async (symbols: string[], _options?: any) =>
      symbols.map((s) => quoteFixture(s))
    );
    service.client = {
      getEnvConfig: () => ({ isLive: true }),
      fetchQuotes,
    } as any;

    const onWire = vi.fn();
    const quotes = await service.fetchQuotesRemote(["aapl", "MSFT"], undefined, onWire);
    expect(quotes.map((q) => q.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(fetchQuotes.mock.calls[0][0]).toEqual(["AAPL", "MSFT"]);
    expect(fetchQuotes.mock.calls[0][1]).toEqual({ onWireResponse: onWire });

    fetchQuotes.mockClear();
    await service.fetchQuotesRemote(["AAPL"]);
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(fetchQuotes.mock.calls[0]).toEqual([["AAPL"]]);
  });
});

// ---------------------------------------------------------------------------
// A1/A2 — the adapter: getQuotesBatch capture + getOptionExpiryDates
// ---------------------------------------------------------------------------

describe("etrade adapter batch quotes + expiry dates (issue #1157)", () => {
  it("getQuotesBatch captures exactly one provider-response record per sub-batch; raw reads back byte-identical; caller quotes carry no raw", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const surface = fakeETradeSurface();
    const provider = createETradeDataProvider(surface as any, { capture: deps });

    const envelope = await provider.getQuotesBatch!(BATCH_SYMBOLS, {
      runId: "run-batch",
      tenantId: "tenant-a",
      userLogin: "trader1",
    });
    expect(envelope.providerId).toBe("etrade");
    expect(envelope.capability).toBe("quotes");
    expect(envelope.result.map((q) => q.symbol)).toEqual(BATCH_SYMBOLS);
    for (const q of envelope.result) {
      expect((q as any).raw).toBeUndefined();
    }

    const captures = listCapturesByRun(sql, "tenant-a", "run-batch");
    expect(captures).toHaveLength(2);
    const expectedBatches = [BATCH_SYMBOLS.slice(0, 10), BATCH_SYMBOLS.slice(10)];
    for (const [i, record] of captures.entries()) {
      expect(record.capability).toBe("quotes");
      expect(record.status).toBe("captured");
      expect(record.rawKind).toBe("provider-response");
      expect(record.requestParams).toEqual({ symbols: expectedBatches[i] });
      const expectedBytes = encodeJson(batchWirePayload(expectedBatches[i]));
      expect(record.rawSha256).toBe(await sha256HexOf(expectedBytes));
      const read = await readCaptureRaw(
        sql,
        { storage: deps.blobStorage, env: {} },
        "tenant-a",
        record.id
      );
      expect(read!.rawBytes).toEqual(expectedBytes);
    }
  });

  it("without capture deps, getQuotesBatch is the plain parity path: no wire callback is supplied and the trace option is forwarded", async () => {
    const surface = fakeETradeSurface();
    const traceSentinel = { traceId: "trace-sentinel" };
    const provider = createETradeDataProvider(surface as any, {
      trace: traceSentinel,
    } as any);
    const envelope = await provider.getQuotesBatch!(BATCH_SYMBOLS);
    expect(envelope.result.map((q) => q.symbol)).toEqual(BATCH_SYMBOLS);
    expect(surface.batchCalls).toHaveLength(1);
    expect(surface.batchCalls[0].trace).toBe(traceSentinel);
    expect(surface.batchCalls[0].onWire).toBeUndefined();
  });

  it("getOptionExpiryDates is captured under optionsChains with kind=expiryDates in the request params", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const provider = createETradeDataProvider(fakeETradeSurface() as any, {
      capture: deps,
    });
    const envelope = await provider.getOptionExpiryDates!("AAPL", {
      runId: "run-expiry",
      tenantId: "tenant-a",
    });
    expect(envelope.providerId).toBe("etrade");
    expect(envelope.capability).toBe("optionsChains");
    expect(envelope.result).toEqual(EXPIRY_DATES_FIXTURE);

    const captures = listCapturesByRun(sql, "tenant-a", "run-expiry");
    expect(captures).toHaveLength(1);
    expect(captures[0].capability).toBe("optionsChains");
    expect(captures[0].requestParams).toEqual({
      symbol: "AAPL",
      kind: "expiryDates",
    });
  });
});

// ---------------------------------------------------------------------------
// A3 — bootstrap: seed + enable etrade only, idempotent
// ---------------------------------------------------------------------------

describe("bootstrapDataProviders (issue #1157)", () => {
  it("before bootstrap route resolution throws; after it, quotes and optionsChains resolve to etrade and nothing else is enabled; a second call changes nothing", () => {
    const sql = freshSql();
    const registry = new DataProviderRegistry();
    registry.register(createETradeDataProvider(fakeETradeSurface() as any));

    // No config rows exist yet — resolution fails explicitly.
    expect(() =>
      registry.resolveRoute("quotes", listProviderConfigs(sql), listCapabilityRoutes(sql))
    ).toThrow(DataProviderNotFoundError);
    expect(() =>
      registry.resolveRoute("optionsChains", listProviderConfigs(sql), listCapabilityRoutes(sql))
    ).toThrow(DataProviderNotFoundError);

    bootstrapDataProviders(sql);

    const quotes = registry.resolveRoute(
      "quotes",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql)
    );
    expect(quotes.primary.id).toBe("etrade");
    // The declared yahoo gap-fill is not enabled, so it is omitted —
    // never promoted, never substituted.
    expect(quotes.gapFill).toBeUndefined();
    const chains = registry.resolveRoute(
      "optionsChains",
      listProviderConfigs(sql),
      listCapabilityRoutes(sql)
    );
    expect(chains.primary.id).toBe("etrade");

    const configs = listProviderConfigs(sql);
    const etrade = configs.find((c) => c.id === "etrade")!;
    expect(etrade.lifecycleState).toBe("enabled");
    expect(etrade.enabled).toBe(true);
    for (const other of configs.filter((c) => c.id !== "etrade")) {
      expect(other.enabled).toBe(false);
      expect(other.lifecycleState).not.toBe("enabled");
    }

    // Idempotent: a second bootstrap writes nothing — the stored
    // records (timestamps included) are byte-identical.
    const before = JSON.stringify({
      configs: listProviderConfigs(sql),
      routes: listCapabilityRoutes(sql),
    });
    bootstrapDataProviders(sql);
    const after = JSON.stringify({
      configs: listProviderConfigs(sql),
      routes: listCapabilityRoutes(sql),
    });
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// B — UnifiedOptionsService cutover
// ---------------------------------------------------------------------------

describe("UnifiedOptionsService platform cutover (issue #1157)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Expiry ~35 days out — inside the default 0–90 DTE window.
  const expiry = new Date(Date.now() + 35 * 86_400_000);
  const expiryParts = {
    year: expiry.getUTCFullYear(),
    month: expiry.getUTCMonth() + 1,
    day: expiry.getUTCDate(),
  };
  const targetDate = expiry.toISOString().slice(0, 10);

  function chainWirePayload() {
    const nowSec = Math.floor(Date.now() / 1000);
    const strikes = [225, 237.5, 250, 262.5, 275];
    const pair = (strike: number) => {
      const callMid = Math.max(0.5, 250 - strike + 2.5);
      const putMid = Math.max(0.5, strike - 250 + 2.5);
      const contract = (type: "Call" | "Put", mid: number, delta: number) => ({
        symbol: `AAPL---${type === "Call" ? "C" : "P"}${strike}`,
        strikePrice: strike,
        bid: Math.max(0.05, mid - 0.1),
        ask: mid + 0.1,
        lastPrice: mid,
        volume: 500,
        openInterest: 1500,
        timeStamp: nowSec,
        OptionGreeks: { delta, gamma: 0.02, theta: -0.03, vega: 0.1, iv: 0.25 },
      });
      return { Call: contract("Call", callMid, 0.5), Put: contract("Put", putMid, -0.5) };
    };
    return {
      OptionChainResponse: {
        OptionPair: strikes.map(pair),
        nearPrice: 250,
        SelectedED: expiryParts,
        timeStamp: nowSec,
      },
    };
  }

  function optionsEnv() {
    const kvStorage: Record<string, string> = {};
    const mockKv = {
      get: async (k: string) => kvStorage[k] || null,
      put: async (k: string, v: string) => {
        kvStorage[k] = v;
      },
      delete: async (k: string) => {
        delete kvStorage[k];
      },
    } as any;
    const { namespace: sessionStoreNs } = makeFakeSessionStore();
    return {
      APP_NAME: "cfagent-test",
      APP_BASE_URL: "https://agent.openaimp.com",
      SESSION_SECRET: "test-session-secret",
      GITHUB_CLIENT_ID: "gh_id",
      GITHUB_CLIENT_SECRET: "gh_secret",
      AI_SEARCH_ENDPOINT: "https://ai.example.com",
      SESSION_STORE: sessionStoreNs,
      ETRADE_KV: mockKv,
      ORCHESTRATOR_AGENT: {} as any,
      ASSETS: {} as any,
      AI: {} as any,
      APP_ENV: "TEST",
      ET_API_KEY: "test_api_key",
      ET_API_SECRET: "test_api_secret",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_ACCOUNT_ID_KEY: "ACCOUNT_KEY_XYZ999",
    } as unknown as Env;
  }

  function stubOptionsFetch() {
    const chainPayload = chainWirePayload();
    const expirePayload = {
      OptionExpireDateResponse: { ExpirationDate: [expiryParts] },
    };
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = String(input);
      if (url.includes("optionexpiredate")) {
        return new Response(JSON.stringify(expirePayload), { status: 200 });
      }
      if (url.includes("optionchains")) {
        return new Response(JSON.stringify(chainPayload), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
  }

  it("with platform deps, chains are fetched through the adapter and the captures' runId is the persisted scan run id; without deps the scan output is identical and nothing is captured", async () => {
    const env = optionsEnv();
    const depsLogin = "e2_options_deps_trader";
    const plainLogin = "e2_options_plain_trader";
    await storeAccessTokens(env, depsLogin, "valid_token", "valid_secret");
    await storeAccessTokens(env, plainLogin, "valid_token", "valid_secret");
    stubOptionsFetch();

    // --- with platform deps ---
    const sql = freshSql();
    const deps = captureDeps(sql);
    const store = new InMemoryScanRunStore();
    const service = new UnifiedOptionsService(
      env,
      depsLogin,
      undefined,
      undefined,
      store,
      undefined,
      undefined,
      deps
    );
    const result = await service.execute({
      action: "opportunities",
      symbols: ["AAPL"],
      targetDate,
    });
    expect(result.success).toBe(true);
    const scanRunId = (result.data as any).scanRunId as string;
    expect(typeof scanRunId).toBe("string");
    expect((result.data as any).persisted).toBe(true);

    // The persisted run IS the pre-minted run: the store holds it
    // under the same id the captures carry.
    const stored = await store.get(scanRunId, { userLogin: depsLogin });
    expect(stored).not.toBeNull();
    const captures = listCapturesByRun(sql, "default", scanRunId);
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.every((c) => c.capability === "optionsChains")).toBe(true);
    expect(captures.every((c) => c.providerId === "etrade")).toBe(true);
    // Both chain-shaped fetches went through the adapter: the expiry
    // lookup (kind=expiryDates) and at least one chain fetch.
    expect(
      captures.some((c) => (c.requestParams as any).kind === "expiryDates")
    ).toBe(true);
    expect(
      captures.some((c) => (c.requestParams as any).kind === undefined)
    ).toBe(true);

    // --- without deps: identical scan output, zero captures ---
    const plainStore = new InMemoryScanRunStore();
    const plainService = new UnifiedOptionsService(
      env,
      plainLogin,
      undefined,
      undefined,
      plainStore
    );
    const plainResult = await plainService.execute({
      action: "opportunities",
      symbols: ["AAPL"],
      targetDate,
    });
    expect(plainResult.success).toBe(true);
    const plainData = plainResult.data as any;
    const depsData = result.data as any;
    expect(plainData.scanned).toBe(depsData.scanned);
    expect(plainData.withTrades).toBe(depsData.withTrades);
    expect(plainData.gate).toEqual(depsData.gate);
    expect(plainData.scanRunId).toBeTruthy();
    expect(plainData.scanRunId).not.toBe(scanRunId);
    expect(listCapturesByRun(sql, "default", plainData.scanRunId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C — stock screener deps binding
// ---------------------------------------------------------------------------

describe("bindEtradeQuoteDeps (issues #1157, #1356)", () => {
  it("binds batch + single quotes to the adapter: captures land under the run context, the QuoteTrace reaches the batch call, and results carry no raw", async () => {
    const sql = freshSql();
    const deps = captureDeps(sql);
    const surface = fakeETradeSurface();
    const traceSentinel = { traceId: "trace-stock" };
    // #1356: the E2 binding is now the pipeline's QuoteScreenerDeps
    // binding over an adapter constructed with the same capture +
    // QuoteTrace options the retired bindETradeScreenerDeps took.
    const provider = createETradeDataProvider(surface as any, {
      capture: deps,
      trace: traceSentinel as any,
    });
    const quoteDeps = bindEtradeQuoteDeps(provider, {
      runId: "run-stock",
      userLogin: "trader1",
    });

    const quotes = await quoteDeps.fetchQuotes!(BATCH_SYMBOLS);
    expect(quotes.map((q) => q.symbol)).toEqual(BATCH_SYMBOLS);
    // The existing trace plumbing reaches the service batch call.
    expect(surface.batchCalls).toHaveLength(1);
    expect(surface.batchCalls[0].trace).toBe(traceSentinel);
    expect(typeof surface.batchCalls[0].onWire).toBe("function");

    let captures = listCapturesByRun(sql, "default", "run-stock");
    expect(captures).toHaveLength(2);
    expect(captures.every((c) => c.capability === "quotes")).toBe(true);
    expect(captures.every((c) => c.rawKind === "provider-response")).toBe(true);

    const single = await quoteDeps.fetchQuote("AAPL");
    expect(single.symbol).toBe("AAPL");
    expect((single as any).raw).toBeUndefined();
    captures = listCapturesByRun(sql, "default", "run-stock");
    expect(captures).toHaveLength(3);
    expect(captures.every((c) => c.userLogin === "trader1")).toBe(true);
  });
});
