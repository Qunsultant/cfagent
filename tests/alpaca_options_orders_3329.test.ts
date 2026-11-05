/**
 * Issue #3329: Alpaca options orders at parity with the equity path.
 *
 * Both brokers are declared to support the `options` asset class, but the
 * Alpaca adapter refused every option order: `previewOrder` threw and
 * `placeOrderRemote` failed any leg. The catalogue was claiming a capability
 * the adapter did not have.
 *
 * What these tests defend:
 *   1. A two-leg vertical previews with a net debit/credit, names both OCC
 *      contracts, and states that the price is computed locally (Alpaca has no
 *      mleg preview endpoint).
 *   2. Placement submits `order_class: "mleg"` with ratio, side and position
 *      intent, and reports success ONLY with a broker order id.
 *   3. The refusals are named: no legs, an equity leg, more than four legs, a
 *      market order, a missing limit price, an unnameable contract.
 *   4. Equity behaviour is unchanged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { formatOccSymbol, parseOccSymbol } from "../src/trading/alpaca/occSymbol";
import type { PlaceOrderParams, TradingOrderLeg } from "../src/trading/interfaces";

const ENV = { ALPACA_API_KEY: "key", ALPACA_SECRET_KEY: "secret" } as any;

const VERTICAL: TradingOrderLeg[] = [
  { underlyingSymbol: "AAPL", securityType: "OPTN", side: "BUY", quantity: 1, optionType: "CALL", strike: 150, expirationDate: "2026-01-16" },
  { underlyingSymbol: "AAPL", securityType: "OPTN", side: "SELL", quantity: 1, optionType: "CALL", strike: 160, expirationDate: "2026-01-16" },
];

function platform() {
  const p = new AlpacaTradingPlatform(ENV, undefined, "user-1", "TEST");
  vi.spyOn(p, "getQuote").mockResolvedValue({ symbol: "AAPL", lastPrice: 155 } as any);
  return p;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OCC symbols round-trip (#3329)", () => {
  it("formats the symbol the parser reads", () => {
    const symbol = formatOccSymbol({ root: "AAPL", expirationDate: "2026-01-16", optionType: "CALL", strikePrice: 150 });
    expect(symbol).toBe("AAPL260116C00150000");
    expect(parseOccSymbol(symbol)).toMatchObject({ root: "AAPL", optionType: "CALL", strikePrice: 150 });
  });

  it("refuses a contract it cannot name", () => {
    expect(() => formatOccSymbol({ root: "", expirationDate: "2026-01-16", optionType: "CALL", strikePrice: 150 })).toThrow(/root/);
    expect(() => formatOccSymbol({ root: "AAPL", expirationDate: "16/01/2026", optionType: "CALL", strikePrice: 150 })).toThrow(/expiry/);
    expect(() => formatOccSymbol({ root: "AAPL", expirationDate: "2026-01-16", optionType: "PUT", strikePrice: 0 })).toThrow(/strike/);
  });
});

describe("a multi-leg option strategy previews (#3329)", () => {
  it("prices a vertical from its net limit and names both contracts", async () => {
    const draft = await platform().previewOrder({
      assetClass: "options",
      symbol: "AAPL",
      action: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      limitPrice: 4.2,
      strategyNetDebit: 420,
      optionLegs: VERTICAL,
    });
    expect(draft.orderId).toMatch(/^alp_mleg_/);
    expect(draft.orderType).toBe("LIMIT");
    expect(draft.estimatedTotal).toBe(420);
    expect(draft.previewMessage).toContain("AAPL260116C00150000");
    expect(draft.previewMessage).toContain("AAPL260116C00160000");
    expect(draft.previewMessage).toContain("2 legs");
    expect(draft.previewMessage.toLowerCase()).toContain("priced locally");
  });

  it("refuses a market option order by name", async () => {
    await expect(
      platform().previewOrder({ assetClass: "options", symbol: "AAPL", quantity: 1, orderType: "MARKET", optionLegs: VERTICAL }),
    ).rejects.toThrow(/limit price/);
  });

  it("refuses an equity leg inside a strategy", async () => {
    await expect(
      platform().previewOrder({
        assetClass: "options",
        symbol: "AAPL",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 4,
        strategyNetDebit: 400,
        optionLegs: [...VERTICAL, { underlyingSymbol: "AAPL", securityType: "EQ", side: "SELL", quantity: 100 }],
      }),
    ).rejects.toThrow(/option legs only/);
  });

  it("refuses more than four legs, and a leg with no contract detail", async () => {
    const five = [...VERTICAL, ...VERTICAL, VERTICAL[0]];
    await expect(
      platform().previewOrder({ assetClass: "options", symbol: "AAPL", quantity: 1, orderType: "LIMIT", limitPrice: 4, strategyNetDebit: 400, optionLegs: five }),
    ).rejects.toThrow(/at most 4/);

    const incomplete: TradingOrderLeg[] = [{ underlyingSymbol: "AAPL", securityType: "OPTN", side: "BUY", quantity: 1 }];
    await expect(
      platform().previewOrder({ assetClass: "options", symbol: "AAPL", quantity: 1, orderType: "LIMIT", limitPrice: 4, strategyNetDebit: 400, optionLegs: incomplete }),
    ).rejects.toThrow(/strike/);
  });
});

describe("a multi-leg option strategy places (#3329)", () => {
  const order: PlaceOrderParams = {
    orderId: "ord-1",
    symbol: "AAPL",
    action: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 4.2,
    strategyNetDebit: 420,
    userLogin: "user-1",
    optionLegs: VERTICAL,
  };

  it("submits an mleg order and reports success only with a broker id", async () => {
    const p = platform();
    const placeOptionOrder = vi
      .spyOn((p as any).alpacaData, "placeOptionOrder")
      .mockResolvedValue({ success: true, orderId: "broker-9", status: "accepted" });

    const result = await p.placeOrderRemote(order);
    expect(result.success).toBe(true);
    expect(result.brokerOrderRef).toBe("broker-9");
    expect(result.status).toBe("submitted");

    const payload = placeOptionOrder.mock.calls[0][0];
    expect(payload.qty).toBe("1");
    expect(payload.limit_price).toBe("4.2");
    expect(payload.legs).toEqual([
      { symbol: "AAPL260116C00150000", ratio_qty: "1", side: "buy", position_intent: "buy_to_open" },
      { symbol: "AAPL260116C00160000", ratio_qty: "1", side: "sell", position_intent: "sell_to_open" },
    ]);
  });

  it("a broker response without an order id is a failure, never a fill", async () => {
    const p = platform();
    vi.spyOn((p as any).alpacaData, "placeOptionOrder").mockResolvedValue({ success: true } as any);
    const result = await p.placeOrderRemote(order);
    expect(result.success).toBe(false);
    expect(result.brokerOrderRef).toBe("");
  });

  it("an upstream rejection is reported as a failure naming the broker", async () => {
    const p = platform();
    vi.spyOn((p as any).alpacaData, "placeOptionOrder").mockResolvedValue({ success: false, httpStatus: 422 });
    const result = await p.placeOrderRemote(order);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Alpaca/);
  });

  it("a leg without contract detail is refused before submission", async () => {
    const p = platform();
    const spy = vi.spyOn((p as any).alpacaData, "placeOptionOrder");
    const result = await p.placeOrderRemote({ ...order, optionLegs: [{ underlyingSymbol: "AAPL", securityType: "OPTN", side: "BUY", quantity: 1 }] });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/strike/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("equity placement is unchanged", async () => {
    const p = platform();
    const spy = vi.spyOn((p as any).alpacaData, "placeOrder").mockResolvedValue({ success: true, orderId: "eq-1" });
    const result = await p.placeOrderRemote({ orderId: "ord-2", symbol: "AAPL", action: "BUY", quantity: 5, orderType: "MARKET", userLogin: "user-1" });
    expect(result.success).toBe(true);
    expect(spy.mock.calls[0][0]).toMatchObject({ symbol: "AAPL", qty: 5, side: "buy", type: "market" });
  });
});
