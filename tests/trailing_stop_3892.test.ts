/**
 * Issue #3892 — trailing stops reach the broker as trailing stops.
 *
 * Native on Alpaca (`trail_price` / `trail_percent`), refused by name on
 * E*TRADE. These pins read the wire body: a trailing stop that arrived as a
 * plain stop would be a silent downgrade, which the issue forbids.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import { validateAdvancedOrder } from "../src/trading";

const CREDS = {
  ALPACA_API_KEY: "key",
  ALPACA_SECRET_KEY: "secret",
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as any;

function capture() {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ord-trail-1", status: "new", symbol: "AAPL", qty: "10", side: "sell" }),
      } as any;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("#3892 — trailing stops", () => {
  it("sends trail_percent instead of a stop price", async () => {
    const calls = capture();
    const result = await new AlpacaMarketDataProvider(CREDS).placeOrder({
      symbol: "AAPL",
      qty: 10,
      side: "sell",
      type: "trailing_stop",
      trail_percent: 5,
      time_in_force: "gtc",
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("ord-trail-1");
    expect(calls[0].url).toContain("/v2/orders");
    expect(calls[0].body).toMatchObject({ type: "trailing_stop", trail_percent: 5, time_in_force: "gtc" });
    expect(calls[0].body.stop_price).toBeUndefined();
    expect(calls[0].body.limit_price).toBeUndefined();
  });

  it("sends trail_price for a dollar trailing stop", async () => {
    const calls = capture();
    await new AlpacaMarketDataProvider(CREDS).placeOrder({
      symbol: "MSFT",
      qty: 5,
      side: "sell",
      type: "trailing_stop",
      trail_price: 2.5,
    });
    expect(calls[0].body).toMatchObject({ trail_price: 2.5 });
    expect(calls[0].body.trail_percent).toBeUndefined();
  });

  it("a basic order's body is unchanged", async () => {
    const calls = capture();
    await new AlpacaMarketDataProvider(CREDS).placeOrder({ symbol: "AAPL", qty: 1, side: "buy", type: "market" });
    expect(calls[0].body.trail_price).toBeUndefined();
    expect(calls[0].body.trail_percent).toBeUndefined();
    expect(calls[0].body.notional).toBeUndefined();
    expect(calls[0].body.good_till_date).toBeUndefined();
  });

  it("E*TRADE refuses it by name instead of placing a plain stop", () => {
    const refused = validateAdvancedOrder({ type: "trailing_stop", broker: "etrade", params: { trail_percent: 5 } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("order_type_unsupported");
  });
});
