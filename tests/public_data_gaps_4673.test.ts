// @vitest-environment node
/**
 * Issue #4673 (matrix gap 19) — Public.com data gaps.
 *
 * Red on the pre-#4673 tree:
 *  - the data allow-list never calls get_price_history, so the adapter
 *    declares no historicalBars capability;
 *  - the trading allow-list never calls get_history / get_tax_lots*,
 *    so the platform has no getAccountActivity / getPositionLots;
 *  - the catalog declares positionLots and accountActivity false;
 *  - getPositions calls get_portfolio with no account id even though the
 *    live schema marks account_id required.
 *
 * Green when the four capabilities the live MCP surface actually offers
 * (verified by the #4668 tools/list probe, 46 tools) are wired, and the
 * gaps it does not offer (alerts, watchlists, fundamentals, dividends,
 * corporate-action feed) stay declared false instead of being invented.
 *
 * No live network: every MCP call goes through an injected fake fetch.
 */
import { describe, it, expect } from "vitest";
import { PUBLIC_DATA_TOOL_ALLOWLIST, PublicMcpClient } from "../src/mcps/public/publicMcp";
import {
  PUBLIC_TRADING_TOOL_ALLOWLIST,
  PublicTradingMcpClient,
} from "../src/mcps/public/publicTradingMcp";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import { BROKER_CATALOG } from "../src/trading";
import { createPublicDataProvider } from "../src/trading/dataProviders/adapters";
import { parsePublicActivity, parsePublicTaxLots } from "../src/services/publicTrading";
import { parsePublicPriceHistory } from "../src/services/publicData";
import { publicActivityPageSize, resolvePublicBarsRequest } from "../src/config/publicData";
import type { Env } from "../src/types";

/* ------------------------- fake MCP transport ------------------------- */

type RpcCall = { method: string; tool?: string; args?: Record<string, unknown> };

const TOOL_SCHEMAS: Record<string, { properties: Record<string, unknown>; required: string[] }> = {
  get_accounts: { properties: {}, required: [] },
  get_portfolio: {
    properties: { account_id: { type: "string" } },
    required: ["account_id"],
  },
  get_history: {
    properties: {
      account_id: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      page_size: { type: "integer" },
      next_token: { type: "string" },
    },
    required: ["account_id"],
  },
  get_tax_lots_for_symbol: {
    properties: {
      symbol: { type: "string" },
      account_id: { type: "string" },
      price: { type: "string" },
    },
    required: ["symbol", "account_id"],
  },
  get_price_history: {
    properties: {
      symbol: { type: "string" },
      period: { type: "string" },
      instrument_type: { type: "string" },
      aggregation: { type: "string" },
    },
    required: ["symbol", "period"],
  },
  get_quotes: { properties: { symbols: { type: "array" } }, required: ["symbols"] },
};

const TOOL_RESULTS: Record<string, unknown> = {
  get_accounts: {
    accounts: [{ account_id: "acc-1", account_number: "P-1234", account_type: "BROKERAGE" }],
  },
  get_portfolio: {
    positions: [{ symbol: "AAPL", quantity: 10, market_value: 1705, average_cost: 150 }],
    buying_power: 5000,
  },
  get_history: {
    transactions: [
      {
        transaction_id: "tx-1",
        type: "TRADE",
        timestamp: "2026-11-05T14:30:00Z",
        symbol: "AAPL",
        quantity: "2",
        price: "180.5",
        amount: "-361",
        order_id: "ord-1",
      },
      {
        transaction_id: "tx-2",
        type: "DIVIDEND",
        timestamp: "2026-11-06T00:00:00Z",
        amount: "12.4",
      },
      // no id: not a row the neutral shape can key, skipped rather than invented.
      { type: "TRADE", timestamp: "2026-11-07T00:00:00Z", symbol: "MSFT" },
      // no timestamp: skipped, never stamped with the fetch instant.
      { transaction_id: "tx-3", type: "TRADE" },
    ],
  },
  get_tax_lots_for_symbol: {
    tax_lots: [
      {
        lot_id: "lot-1",
        symbol: "AAPL",
        quantity: "10",
        cost_basis: "1500",
        cost_basis_per_share: "150",
        acquired_date: "2026-01-15",
        unrealized_gain_loss: "205",
        unrealized_gain_loss_percent: "13.67",
        market_value: "1705",
        term: "LONG",
      },
      { quantity: 5 },
      { lot_id: "lot-2" },
    ],
  },
  get_price_history: {
    preMarket: [
      {
        time: "2026-11-03T12:00:00Z",
        open: 178,
        high: 179,
        low: 177,
        close: 178.5,
        volume: 200,
      },
    ],
    regular: [
      {
        time: "2026-11-03T14:30:00Z",
        open: "180",
        high: "182",
        low: "179",
        close: "181",
        volume: "1000",
      },
    ],
    afterHours: [
      { time: "2026-11-03T21:00:00Z", o: 181, h: 182, l: 180, c: 181.5, v: 300 },
      // a row with no close is not a bar; skipped rather than zero-filled.
      { time: "2026-11-03T22:00:00Z", open: 181, high: 182, low: 180, volume: 10 },
    ],
  },
};

function fakePublicFetch(calls: RpcCall[]) {
  return async (_url: string, init?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (body.method === "tools/list") {
      calls.push({ method: "tools/list" });
      return Response.json({
        result: {
          tools: Object.entries(TOOL_SCHEMAS).map(([name, inputSchema]) => ({ name, inputSchema })),
        },
      });
    }
    if (body.method === "tools/call") {
      calls.push({ method: "tools/call", tool: body.params?.name, args: body.params?.arguments });
      const text = JSON.stringify(TOOL_RESULTS[body.params?.name ?? ""] ?? {});
      return Response.json({ result: { content: [{ type: "text", text }] } });
    }
    return Response.json({ error: { code: -32601, message: "unknown method " + body.method } });
  };
}

const tokenProvider = async () => "test-token-1234";

function makePlatform(calls: RpcCall[]) {
  return new PublicTradingPlatform({} as Env, undefined, "test-login", "TEST", {
    accessTokenProvider: tokenProvider,
    fetchImpl: fakePublicFetch(calls) as typeof fetch,
    dataProvider: {
      getQuote: async () => ({ providerId: "public", capability: "quotes", result: null }),
    } as never,
  });
}

/* ------------------------------- tests ------------------------------- */

describe("#4673 — the allow-lists carry the verified read tools only", () => {
  it("the data client may call get_price_history (bars) and still refuses writes", () => {
    expect([...PUBLIC_DATA_TOOL_ALLOWLIST]).toContain("get_price_history");
    expect([...PUBLIC_DATA_TOOL_ALLOWLIST]).not.toContain("get_history");
    expect([...PUBLIC_DATA_TOOL_ALLOWLIST]).not.toContain("place_order");
  });

  it("the trading client may read history and tax lots, never place by accident", () => {
    for (const tool of ["get_history", "get_tax_lots", "get_tax_lots_for_symbol"]) {
      expect([...PUBLIC_TRADING_TOOL_ALLOWLIST]).toContain(tool);
    }
    expect([...PUBLIC_TRADING_TOOL_ALLOWLIST]).not.toContain("get_price_history");
  });
});

describe("#4673 — bars request is configuration, not a hardcoded period", () => {
  it("maps a daily bar count onto the provider's own period vocabulary", () => {
    const req = resolvePublicBarsRequest("1D", 60);
    expect(req).toEqual({ period: "QUARTER", aggregation: "ONE_DAY", limit: 60 });
  });

  it("keeps intraday aggregations on the provider's day window", () => {
    const req = resolvePublicBarsRequest("5Min", 30);
    expect(req).toEqual({ period: "DAY", aggregation: "FIVE_MINUTES", limit: 30 });
  });

  it("refuses a limit past the configured ceiling instead of truncating silently", () => {
    expect(() => resolvePublicBarsRequest("1D", 1_000_000)).toThrow(/ceiling/i);
  });
});

describe("#4673 — account activity maps the broker's own rows", () => {
  it("maps trades and money movements, skips rows without an id or a date", () => {
    const rows = parsePublicActivity(TOOL_RESULTS.get_history);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      activityId: "tx-1",
      activityType: "TRADE",
      activityDate: Date.parse("2026-11-05T14:30:00Z"),
      symbol: "AAPL",
      quantity: 2,
      price: 180.5,
      netAmount: -361,
      orderId: "ord-1",
    });
    expect(rows[1].activityType).toBe("DIVIDEND");
    expect(rows[1].symbol).toBeUndefined();
    expect(rows[1].netAmount).toBe(12.4);
  });

  it("filters by the broker's own type word", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls);
    const rows = await platform.getAccountActivity!("DIVIDEND");
    expect(rows.map((r) => r.activityId)).toEqual(["tx-2"]);
  });
});

describe("#4673 — tax lots are real lots, not a re-derived average", () => {
  it("maps each lot and skips a row without an id or a quantity", () => {
    const lots = parsePublicTaxLots(TOOL_RESULTS.get_tax_lots_for_symbol);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      positionLotId: "lot-1",
      originalQty: 10,
      remainingQty: 10,
      totalCost: 1500,
      adjPrice: 150,
      acquiredDate: Date.parse("2026-01-15"),
      totalGain: 205,
      totalGainPct: 13.67,
      marketValue: 1705,
    });
    // A word term is not E*TRADE's numeric code; it is not invented here.
    expect(lots[0].termCode).toBeUndefined();
  });

  it("passes the position's symbol and the account id to the broker tool", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls);
    const lots = await platform.getPositionLots!("acc-1", "AAPL");
    expect(lots).toHaveLength(1);
    const call = calls.find((c) => c.tool === "get_tax_lots_for_symbol");
    expect(call?.args).toMatchObject({ symbol: "AAPL", account_id: "acc-1" });
  });
});

describe("#4673 — bars map into the neutral historical bar shape", () => {
  it("merges the provider's session buckets in time order and drops malformed rows", () => {
    const bars = parsePublicPriceHistory(TOOL_RESULTS.get_price_history, 10);
    expect(bars.map((b) => b.close)).toEqual([178.5, 181, 181.5]);
    expect(bars[0]).toMatchObject({
      provenance: "live",
      timestamp: "2026-11-03T12:00:00.000Z",
      open: 178,
      high: 179,
      low: 177,
      volume: 200,
    });
    expect(bars[2].volume).toBe(300);
  });

  it("the adapter declares historicalBars and calls get_price_history with configured args", async () => {
    const calls: RpcCall[] = [];
    const provider = createPublicDataProvider(
      new PublicMcpClient({
        accessTokenProvider: tokenProvider,
        fetchImpl: fakePublicFetch(calls) as typeof fetch,
      })
    );
    expect(provider.capabilities).toContain("historicalBars");
    const result = await provider.getHistoricalBars!("AAPL", "1D", 60);
    expect(result.providerId).toBe("public");
    expect(result.capability).toBe("historicalBars");
    expect(result.result).toHaveLength(3);
    const call = calls.find((c) => c.tool === "get_price_history");
    expect(call?.args).toMatchObject({
      symbol: "AAPL",
      period: "QUARTER",
      aggregation: "ONE_DAY",
      instrument_type: "EQUITY",
    });
  });
});

describe("#4673 — positions read with the account id the live schema requires", () => {
  it("getPositions resolves the account first and passes account_id", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls);
    const { positions, account } = await platform.getPositions();
    expect(account.accountId).toBe("acc-1");
    expect(positions[0].symbol).toBe("AAPL");
    const call = calls.find((c) => c.tool === "get_portfolio");
    expect(call?.args).toEqual({ account_id: "acc-1" });
  });

  it("the activity read asks for the configured page size", async () => {
    const calls: RpcCall[] = [];
    const platform = makePlatform(calls);
    await platform.getAccountActivity!();
    const call = calls.find((c) => c.tool === "get_history");
    expect(call?.args).toMatchObject({
      account_id: "acc-1",
      page_size: publicActivityPageSize(),
    });
  });
});

describe("#4673 — the catalog states exactly what the surface now serves", () => {
  it("declares activity and position lots, and keeps the unverified gaps false", () => {
    const entry = BROKER_CATALOG.public;
    expect(entry.supports.accountActivity).toBe(true);
    expect(entry.supports.positionLots).toBe(true);
    // Verified absent from the 46-tool tools/list probe (2026-11-17).
    expect(entry.supports.alerts).toBe(false);
    expect(entry.supports.watchlists).toBe(false);
    // The copilot's bar read still rides the market-data facade; the
    // Public adapter now serves bars for the data-provider registry.
    expect(entry.copilot.barsProvider).toBe("hybrid");
  });
});
