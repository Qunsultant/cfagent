/**
 * Issue #3892 — notional sizing (fractional trading) and GTD.
 *
 * The wire body carries `notional` instead of `qty`, and `good_till_date` with
 * `time_in_force: gtd`. `qty` XOR `notional` is enforced by the registry, so a
 * request that carries both never reaches the broker.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import { validateAdvancedOrder } from "../src/trading";

const CREDS = {
  ALPACA_API_KEY: "key",
  ALPACA_SECRET_KEY: "secret",
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as any;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function capture() {
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return { ok: true, status: 200, json: async () => ({ id: "ord-1", status: "new", symbol: "AAPL" }) } as any;
    }),
  );
  return bodies;
}

describe("#3892 — notional sizing", () => {
  it("sends notional and omits qty", async () => {
    const bodies = capture();
    await new AlpacaMarketDataProvider(CREDS).placeOrder({
      symbol: "AAPL",
      qty: undefined as any,
      notional: 500,
      side: "buy",
      type: "market",
    } as any);
    expect(bodies[0]).toMatchObject({ notional: 500 });
    expect(bodies[0].qty).toBeUndefined();
  });

  it("the registry refuses qty together with notional", () => {
    const refused = validateAdvancedOrder({ type: "notional", broker: "alpaca", params: { qty: 2, notional: 500 } });
    expect(refused).toMatchObject({ ok: false, code: "conflicting_order_parameters" });
  });

  it("refuses notional on a broker that cannot size by notional", () => {
    const refused = validateAdvancedOrder({ type: "notional", broker: "etrade", params: { notional: 500 } });
    expect(refused).toMatchObject({ ok: false, code: "order_type_unsupported" });
  });
});

describe("#3892 — GTD", () => {
  it("sends good_till_date with gtd", async () => {
    const bodies = capture();
    await new AlpacaMarketDataProvider(CREDS).placeOrder({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "limit",
      limit_price: 100,
      time_in_force: "gtd",
      good_till_date: "2026-12-01T20:00:00Z",
      // #3782: a limit price needs provenance before it reaches the broker.
      priceSource: { kind: "user" },
    });
    expect(bodies[0]).toMatchObject({ time_in_force: "gtd", good_till_date: "2026-12-01T20:00:00Z" });
  });

  it("refuses gtd without a date", () => {
    expect(validateAdvancedOrder({ type: "gtd", broker: "alpaca", params: { time_in_force: "gtd" } })).toMatchObject({
      ok: false,
      code: "missing_order_parameter",
    });
  });
});
