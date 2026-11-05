/**
 * Issue #3272 (stock UI): the neutral screen can resolve a named universe.
 *
 * Defect this closes: `/api/etrade/screen` picks a universe server-side, while
 * the neutral route demanded an explicit symbol list — so the UI could not be
 * repointed without turning a working screen into a `400`.
 *
 * Rules pinned here:
 *   1. No symbols + a universe name → resolve through the LIVE listings feed.
 *   2. The scan is bounded (MAX_SCREEN_SYMBOLS quote reads) and the response
 *      SAYS it was bounded (`universe`, `universeSize`, `truncated`) — a partial
 *      scan is disclosed, never passed off as the whole universe.
 *   3. A failed listings feed is `503 LISTINGS_UNAVAILABLE`; no curated table
 *      is substituted (#1554's rule for listings).
 *   4. The wire shape keeps the client contract (`stocks`, `totalScreened`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));
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
    }));
  },
}));

import { handleBrokerScreenRoutes, MAX_SCREEN_SYMBOLS, type BrokerScreenRouteContext } from "../src/agents/routes/brokerScreen";
import { TradingPlatformRegistry } from "../src/trading/registry";
import type { BrokerQuote } from "../src/types";

function quote(symbol: string): BrokerQuote {
  return { symbol, lastPrice: 100, changePercent: 1, volume: 1_000_000, week52High: 120, week52Low: 80 } as BrokerQuote;
}

function ctx(): BrokerScreenRouteContext {
  return { env: { APP_ENV: "TEST" } as any, getOrm: () => undefined, readSettingRaw: () => null };
}

function post(body: unknown) {
  const url = new URL("https://example.test/api/broker/screen");
  const request = new Request(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    .mockImplementation(() => ({ getQuote: async (s: string) => quote(s) }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a named universe resolves, bounded and disclosed (#3272)", () => {
  it("defaults to NASDAQ100, scans only what it can afford, and says so", async () => {
    const { request, url } = post({});
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.universe).toBe("NASDAQ100");
    expect(body.requested).toHaveLength(MAX_SCREEN_SYMBOLS);
    expect(body.universeSize).toBe(40);
    expect(body.truncated).toBe(true);
    expect(body.quotesRead).toBe(MAX_SCREEN_SYMBOLS);
  });

  it("keeps the client contract: stocks and totalScreened are top-level", async () => {
    const { request, url } = post({ universe: "NASDAQ100" });
    const body = await (await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx()))!.json();
    expect(Array.isArray(body.stocks)).toBe(true);
    expect(typeof body.totalScreened).toBe("number");
  });

  it("does not claim truncation when the universe fits", async () => {
    listingsState.size = 5;
    const { request, url } = post({});
    const body = await (await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx()))!.json();
    expect(body.universeSize).toBe(5);
    expect(body.truncated).toBe(false);
  });

  it("fails coded when the listings feed fails — no curated substitution", async () => {
    listingsState.fail = true;
    const { request, url } = post({});
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.code).toBe("LISTINGS_UNAVAILABLE");
    expect(body.message).toContain("No curated table is substituted");
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("still prefers an explicit symbol list", async () => {
    const { request, url } = post({ symbols: ["AAPL"], universe: "SP500" });
    const body = await (await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx()))!.json();
    expect(body.requested).toEqual(["AAPL"]);
    expect(body.universe).toBeNull();
  });
});
