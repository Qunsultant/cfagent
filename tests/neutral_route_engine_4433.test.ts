/**
 * Issue #4433 ([One engine] #3550 S5b): the neutral route runs on the engine.
 *
 * POST /api/broker/screen executes as a ScreenerScreenWorkflow run through
 * runStockScreenViaEngine and writes a run record — ending the
 * neutrality/observability mutual exclusion on that surface. The route's
 * contract is unchanged:
 *   - the tenant broker is resolved and named on the run (provider + broker);
 *   - a broker without a quote read answers 501 provider_unsupported naming
 *     it, before any platform is constructed and before any run starts;
 *   - a broker the engine has no quote binding for is refused the same way
 *     (loud, coded, before any start) — never screened on another
 *     broker's data;
 *   - no substitution, no curated fallback, and the MAX_SCREEN_SYMBOLS cap
 *     stays (25 quote reads per request, enforced before the seam).
 * The wire shape keeps the client contract (stocks, totalScreened) and
 * gains the run-record linkage (jobId, workflowId, statusUrl).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as string }));
const listingsState = vi.hoisted(() => ({ fail: false, size: 40 }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

vi.mock("../src/services/nasdaqListings", () => ({
  fetchAllUsStockListings: async () => {
    if (listingsState.fail) throw new Error("listings upstream down");
    return Array.from({ length: listingsState.size }, (_, i) => ({
      symbol: `SYM${i}`,
      companyName: `Company ${i}`,
      marketCap: 1_000_000 - i,
      exchange: "NASDAQ",
      change: 0,
      changePercent: 0,
    }));
  },
}));

import {
  handleBrokerScreenRoutes,
  MAX_SCREEN_SYMBOLS,
  type BrokerScreenRouteContext,
} from "../src/agents/routes/brokerScreen";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";
import { WorkflowError } from "../src/workflows/workflowPorts";

function fakeResult(overrides: Record<string, unknown> = {}): any {
  return {
    timestamp: "2026-11-18T00:00:00.000Z",
    trigger: "manual",
    provider: "alpaca",
    broker: "alpaca",
    universe: "NASDAQ100",
    sector: "ALL",
    success: true,
    totalScanned: 2,
    matchedCount: 1,
    opportunities: [{ symbol: "AAPL" }],
    allStocks: [
      { symbol: "AAPL", companyName: "Apple Inc" },
      { symbol: "MSFT", companyName: "Microsoft Corp" },
    ],
    discoveryMessage: "screened 2 symbols",
    ...overrides,
  };
}

function ctx(seam: any): BrokerScreenRouteContext {
  const agent = {
    isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
    chargeScreenQuota: async () => {},
    getHistory: async () => [],
  };
  return {
    env: { APP_ENV: "TEST" } as any,
    getOrm: () => undefined,
    readSettingRaw: () => null,
    getScreenerAgent: () => agent as any,
    runStockScreenViaEngine: seam,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  const url = new URL("https://example.test/api/broker/screen");
  const request = new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-login": "trader1", ...headers },
    body: JSON.stringify(body),
  });
  return { request, url };
}

let getPlatform: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tenant.broker = "alpaca";
  listingsState.fail = false;
  listingsState.size = 40;
  getPlatform = vi
    .spyOn(TradingPlatformRegistry, "getPlatform")
    .mockImplementation(() => ({ getQuote: async () => ({}) }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the neutral route runs through the one engine seam (#4433)", () => {
  it("calls the seam with the tenant-resolved broker as provider + broker, a symbols shard, and the caps", async () => {
    const seam = vi.fn(async () => ({
      results: [fakeResult()],
      collation: null,
      jobId: "screener:manual:symbols:1",
      workflowId: "wf-1",
    }));
    const { request, url } = post({ symbols: ["AAPL", "MSFT"], filter: { sector: "technology" } });
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(seam));
    expect(res!.status).toBe(200);
    expect(seam).toHaveBeenCalledTimes(1);
    const input = seam.mock.calls[0][0];
    expect(input.spec.source).toBe("broker");
    expect(input.spec.trigger).toBe("manual");
    expect(input.spec.deliver).toBe(false);
    expect(input.spec.provider).toBe("alpaca");
    expect(input.spec.filters).toEqual({ sector: "technology" });
    expect(input.spec.universe).toBe("symbols");
    expect(input.spec.userLogin).toBe("trader1");
    expect(input.environment).toBe("TEST");
    expect(input.commandOverrides.broker).toBe("alpaca");
    expect(input.commandOverrides.maxSymbols).toBe(2);
    expect(input.commandOverrides.maxItems).toBe(2);
    expect(input.commandOverrides.shards).toHaveLength(1);
    expect(input.commandOverrides.shards[0].shardId).toBe("symbols");
    expect(input.commandOverrides.shards[0].symbols.map((s: any) => s.symbol)).toEqual(["AAPL", "MSFT"]);
    // The engine binds the platform — the route constructs none.
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("a named universe resolves through the live feed and rides the shard with its real listings", async () => {
    const seam = vi.fn(async () => ({
      results: [fakeResult({ totalScanned: MAX_SCREEN_SYMBOLS })],
      collation: null,
      jobId: "screener:manual:NASDAQ100:1",
      workflowId: "wf-2",
    }));
    const { request, url } = post({});
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(seam));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.universe).toBe("NASDAQ100");
    expect(body.universeSize).toBe(40);
    expect(body.truncated).toBe(true);
    expect(body.requested).toHaveLength(MAX_SCREEN_SYMBOLS);
    const input = seam.mock.calls[0][0];
    expect(input.spec.universe).toBe("NASDAQ100");
    expect(input.commandOverrides.shards[0].universe).toBe("NASDAQ100");
    const shardSymbols = input.commandOverrides.shards[0].symbols;
    expect(shardSymbols).toHaveLength(MAX_SCREEN_SYMBOLS);
    // Real feed listings ride — company names from the feed, not invented.
    expect(shardSymbols[0]).toMatchObject({ symbol: "SYM0", companyName: "Company 0" });
  });

  it("keeps the client contract and links the run record", async () => {
    const seam = vi.fn(async () => ({
      results: [
        fakeResult({
          criteria: { sector: "technology" },
          filterSummary: "technology filter",
          quoteTrace: {
            traceId: "t1",
            symbolCount: 2,
            batchCount: 1,
            quotesReceived: 2,
            quotesFailed: 0,
            failuresByCategory: {},
            batches: [{ batchIndex: 0, symbolCount: 2, httpStatus: 200, quotesReceived: 2, failures: [], durationMs: 5 }],
          },
        }),
      ],
      collation: null,
      jobId: "screener:manual:symbols:9",
      workflowId: "wf-9",
    }));
    const { request, url } = post({ symbols: ["AAPL", "MSFT"] });
    const body = await (await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(seam)))!.json();
    expect(Array.isArray(body.stocks)).toBe(true);
    expect(body.stocks).toHaveLength(2);
    expect(body.totalScreened).toBe(2);
    expect(body.totalScanned).toBe(2);
    expect(body.matchedCount).toBe(1);
    expect(body.filterApplied).toEqual({ sector: "technology" });
    expect(body.filterSummary).toBe("technology filter");
    expect(body.quotesRead).toBe(2);
    expect(body.failures).toEqual([]);
    expect(body.broker).toBe("alpaca");
    expect(body.environment).toBe("TEST");
    expect(body.jobId).toBe("screener:manual:symbols:9");
    expect(body.workflowId).toBe("wf-9");
    expect(body.statusUrl).toBe("/api/jobs/history?chainId=screener%3Amanual%3Asymbols%3A9");
    expect(body.result.stocks).toEqual(body.stocks);
    expect(body.result.totalScreened).toBe(2);
  });

  it("surfaces per-symbol quote failures from the engine's trace, under their own names", async () => {
    const seam = vi.fn(async () => ({
      results: [
        fakeResult({
          totalScanned: 1,
          quoteTrace: {
            traceId: "t2",
            symbolCount: 2,
            batchCount: 1,
            quotesReceived: 1,
            quotesFailed: 1,
            failuresByCategory: { unknown_symbol: 1 },
            batches: [
              {
                batchIndex: 0,
                symbolCount: 2,
                httpStatus: 200,
                quotesReceived: 1,
                failures: [{ symbol: "NOPE", category: "unknown_symbol", detail: "no such symbol" }],
                durationMs: 5,
              },
            ],
          },
        }),
      ],
      collation: null,
      jobId: "j",
      workflowId: "w",
    }));
    const { request, url } = post({ symbols: ["AAPL", "NOPE"] });
    const body = await (await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(seam)))!.json();
    expect(body.quotesRead).toBe(1);
    expect(body.failures).toEqual([{ symbol: "NOPE", reason: "no such symbol" }]);
  });

  it("refuses a broker with no quote read before any start, naming it", async () => {
    const seam = vi.fn(async () => ({ results: [fakeResult()], collation: null, jobId: "j", workflowId: "w" }));
    const original = BROKER_CATALOG.alpaca.supports.quote;
    try {
      (BROKER_CATALOG.alpaca.supports as { quote: boolean }).quote = false;
      const { request, url } = post({ symbols: ["AAPL"] });
      const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(seam));
      expect(res!.status).toBe(501);
      expect(await res!.json()).toMatchObject({ code: "provider_unsupported", broker: "alpaca" });
      expect(seam).not.toHaveBeenCalled();
      expect(getPlatform).not.toHaveBeenCalled();
    } finally {
      (BROKER_CATALOG.alpaca.supports as { quote: boolean }).quote = original;
    }
  });

  it("refuses a broker the engine has no quote binding for, before any start — never another broker's data", async () => {
    tenant.broker = "tastytrade";
    const seam = vi.fn(async () => ({ results: [fakeResult()], collation: null, jobId: "j", workflowId: "w" }));
    const { request, url } = post({ symbols: ["AAPL"] });
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(seam));
    expect(res!.status).toBe(501);
    const body = await res!.json();
    expect(body.code).toBe("provider_unsupported");
    expect(body.broker).toBe("tastytrade");
    expect(body.message).toContain("no other broker");
    expect(seam).not.toHaveBeenCalled();
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("keeps the 25-symbol cap, enforced before the seam", async () => {
    const seam = vi.fn(async () => ({ results: [fakeResult()], collation: null, jobId: "j", workflowId: "w" }));
    const tooMany = post({ symbols: Array.from({ length: MAX_SCREEN_SYMBOLS + 1 }, (_, i) => `S${i}`) });
    const res = await handleBrokerScreenRoutes(tooMany.request, tooMany.url, tooMany.url.pathname, "sid", ctx(seam));
    expect(res!.status).toBe(400);
    expect((await res!.json()).message).toContain(String(MAX_SCREEN_SYMBOLS));
    expect(seam).not.toHaveBeenCalled();
  });

  it("answers a failed engine result with 502 naming the run, not a fabricated screen", async () => {
    const seam = vi.fn(async () => ({
      results: [fakeResult({ success: false, error: "the quote leg failed" })],
      collation: null,
      jobId: "screener:manual:symbols:7",
      workflowId: "wf-7",
    }));
    const { request, url } = post({ symbols: ["AAPL"] });
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(seam));
    expect(res!.status).toBe(502);
    const body = await res!.json();
    expect(body.error).toBe("the quote leg failed");
    expect(body.jobId).toBe("screener:manual:symbols:7");
    expect(body.broker).toBe("alpaca");
  });

  it("maps the seam's gate refusals to the routed sites' 429s", async () => {
    const running = vi.fn(async () => {
      throw new Error("Screen already running for symbols (run screener:manual:symbols:3)");
    });
    const { request, url } = post({ symbols: ["AAPL"] });
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(running));
    expect(res!.status).toBe(429);
    expect((await res!.json()).error).toBe("Screen already running");
  });

  it("maps a workflow-start failure to a coded 503, never a silent inline screen", async () => {
    const failing = vi.fn(async () => {
      throw new WorkflowError("start_failed", "Stock screen workflow start failed for job j: boom.");
    });
    const { request, url } = post({ symbols: ["AAPL"] });
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx(failing));
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.code).toBe("start_failed");
    expect(body.retryable).toBe(true);
  });
});
