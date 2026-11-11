/**
 * Issue #4036 — Public.com option-chain conformance at E*TRADE/Alpaca parity.
 *
 * The chain mapper had never been compared to the brokers it claims parity
 * with. Two rules were missing (both already true for Alpaca, see
 * src/trading/alpaca/optionsData.ts):
 *
 *  - a contract needs a TWO-SIDED quote (bid AND ask) to enter the chain; a
 *    last trade alone cannot be priced or traded;
 *  - `lastPrice` is the printed trade when there is one, else the bid/ask
 *    midpoint — a documented derivation, never an invented print.
 *
 * Greeks and IV appear only where Public sends them: absent stays absent,
 * never zero.
 */
import { describe, it, expect } from "vitest";
import { mapPublicChainPayload } from "../src/services/publicData";

function row(overrides: Record<string, unknown>) {
  return {
    option_details: {
      strike_price: 100,
      expiration_date: "2027-12-17",
    },
    symbol: "QBTS261217C00100000",
    bid: 5.1,
    ask: 5.3,
    last: 5.2,
    volume: 42,
    open_interest: 900,
    greeks: { delta: 0.61, gamma: 0.02, theta: -0.03, vega: 0.11, implied_volatility: 0.48 },
    ...overrides,
  };
}

describe("Issue #4036 — Public chain conformance", () => {
  it("maps a two-sided, greeked contract into the broker chain shape", () => {
    const chain = mapPublicChainPayload(
      { calls: [row({})], puts: [] },
      "QBTS",
      "2027-12-17",
      9.5,
    );
    expect(chain).not.toBeNull();
    expect(chain!.symbol).toBe("QBTS");
    expect(chain!.underlyingPrice).toBe(9.5);
    expect(chain!.selectedExpiry).toEqual({ year: 2027, month: 12, day: 17 });
    const call = chain!.pairs[0].call!;
    expect(call.optionType).toBe("CALL");
    expect(call.strikePrice).toBe(100);
    expect(call.bid).toBe(5.1);
    expect(call.ask).toBe(5.3);
    expect(call.lastPrice).toBe(5.2);
    expect(call.delta).toBe(0.61);
    expect(call.impliedVolatility).toBe(0.48);
  });

  it("omits a contract that has only a last trade (no two-sided quote)", () => {
    const chain = mapPublicChainPayload(
      { calls: [row({ bid: undefined, ask: undefined, last: 5.2 })], puts: [] },
      "QBTS",
      "2027-12-17",
      9.5,
    );
    expect(chain).toBeNull();
  });

  it("derives lastPrice from the midpoint when no trade printed", () => {
    const chain = mapPublicChainPayload(
      { calls: [row({ last: undefined })], puts: [] },
      "QBTS",
      "2027-12-17",
      9.5,
    );
    expect(chain!.pairs[0].call!.lastPrice).toBe(5.2);
  });

  it("leaves greeks absent, never zero, when Public sends none", () => {
    const chain = mapPublicChainPayload(
      { calls: [row({ greeks: undefined })], puts: [] },
      "QBTS",
      "2027-12-17",
      9.5,
    );
    const call = chain!.pairs[0].call!;
    expect(call.delta).toBeUndefined();
    expect(call.gamma).toBeUndefined();
    expect(call.impliedVolatility).toBeUndefined();
    expect("delta" in call).toBe(false);
  });

  it("pairs calls and puts by strike, ascending", () => {
    const chain = mapPublicChainPayload(
      {
        calls: [
          row({ option_details: { strike_price: 110 }, symbol: "C110" }),
          row({ option_details: { strike_price: 100 }, symbol: "C100" }),
        ],
        puts: [row({ option_details: { strike_price: 105 }, symbol: "P105" })],
      },
      "QBTS",
      "2027-12-17",
      9.5,
    );
    expect(chain!.pairs.map((p) => p.call?.strikePrice ?? p.put?.strikePrice)).toEqual([
      100, 105, 110,
    ]);
    expect(chain!.pairs[1].put?.symbol).toBe("P105");
    expect(chain!.pairs[1].call).toBeUndefined();
  });

  it("omits selectedExpiry when the expiry is unparseable", () => {
    const chain = mapPublicChainPayload({ calls: [row({})], puts: [] }, "QBTS", "nope", 9.5);
    expect(chain!.selectedExpiry).toBeUndefined();
  });

  it("refuses to invent an underlying price", () => {
    expect(() =>
      mapPublicChainPayload({ calls: [row({})], puts: [] }, "QBTS", "2027-12-17", undefined),
    ).toThrow(/no underlying price/i);
  });
});
