/**
 * Issue #3328: Alpaca position lots, derived from fills.
 *
 * `positionLots: false` recorded "Alpaca exposes no tax-lot endpoint" as a
 * permanent gap. Fills answer the same question: each carries quantity, price
 * and transaction time, and FIFO over them yields the lots a holder needs.
 *
 * What these tests defend:
 *   1. FIFO is real FIFO: a second buy does not overwrite the first, and a sell
 *      consumes the oldest lot first.
 *   2. A short book is derived symmetrically (sells open lots, buys cover).
 *   3. Quantity no retained fill explains is a stated coverage gap, never a
 *      lot at price 0 and never a silent drop.
 *   4. The adapter serves the contract method, and the catalogue says so.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { deriveLotsFromFills, parseAlpacaFill } from "../src/trading/alpaca/fillLots";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { brokerSupports } from "../src/trading/brokerCatalog";
import { TradingPlatformRegistry } from "../src/trading";

const ENV = { ALPACA_API_KEY: "key", ALPACA_SECRET_KEY: "secret" } as any;

function fill(side: string, qty: string, price: string, time: string, symbol = "AAPL") {
  return { id: `fill-${time}`, symbol, side, qty, price, transaction_time: time };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FIFO lots from fills (#3328)", () => {
  it("keeps both buys and consumes the oldest on a sell", () => {
    const fills = [
      parseAlpacaFill(fill("buy", "3", "100", "2026-01-02T15:00:00Z"))!,
      parseAlpacaFill(fill("buy", "2", "110", "2026-02-02T15:00:00Z"))!,
      parseAlpacaFill(fill("sell", "4", "120", "2026-03-02T15:00:00Z"))!,
    ];
    const derived = deriveLotsFromFills(fills, 1);
    expect(derived.method).toBe("fifo_from_fills");
    // 3 @100 and 2 @110; selling 4 leaves 1 @110.
    expect(derived.lots).toHaveLength(1);
    expect(derived.lots[0]).toMatchObject({ quantity: 1, price: 110 });
    expect(derived.unmatchedQuantity).toBe(0);
  });

  it("derives a short book symmetrically", () => {
    const fills = [
      parseAlpacaFill(fill("sell", "5", "90", "2026-01-02T15:00:00Z"))!,
      parseAlpacaFill(fill("buy", "2", "80", "2026-02-02T15:00:00Z"))!,
    ];
    const derived = deriveLotsFromFills(fills, -3);
    expect(derived.lots).toHaveLength(1);
    expect(derived.lots[0]).toMatchObject({ quantity: 3, price: 90 });
  });

  it("states a coverage gap instead of inventing a lot", () => {
    const fills = [parseAlpacaFill(fill("buy", "2", "100", "2026-01-02T15:00:00Z"))!];
    const derived = deriveLotsFromFills(fills, 5);
    expect(derived.lots).toHaveLength(1);
    expect(derived.lots[0].quantity).toBe(2);
    expect(derived.unmatchedQuantity).toBe(3);
  });

  it("refuses a row that is not a usable fill", () => {
    expect(parseAlpacaFill({ symbol: "AAPL", side: "buy", qty: "0", price: "10", transaction_time: "2026-01-02T15:00:00Z" })).toBeNull();
    expect(parseAlpacaFill({ symbol: "", side: "buy", qty: "1", price: "10", transaction_time: "2026-01-02T15:00:00Z" })).toBeNull();
    expect(parseAlpacaFill({ symbol: "AAPL", side: "dividend", qty: "1", price: "10", transaction_time: "2026-01-02T15:00:00Z" })).toBeNull();
  });
});

describe("the Alpaca adapter serves position lots (#3328)", () => {
  const platform = () => new AlpacaTradingPlatform(ENV, undefined, "user-1", "TEST");

  it("declares the capability it now has", () => {
    expect(brokerSupports("alpaca", "positionLots")).toBe(true);
    expect(typeof AlpacaTradingPlatform.prototype.getPositionLots).toBe("function");
    expect(typeof AlpacaTradingPlatform.prototype.derivePositionLots).toBe("function");
  });

  it("derives lots for an open position through the broker's own fills", async () => {
    const p = platform();
    vi.spyOn(p, "getPositions").mockResolvedValue({
      account: { accountId: "a1", accountKey: "a1", accountDesc: "Alpaca", accountType: "MARGIN" } as any,
      positions: [{ symbol: "AAPL", description: "AAPL", quantity: 4, pricePaid: 100, costBasis: 400, currentPrice: 120, marketPrice: 120 } as any],
    });
    const provider = (p as any).alpacaData;
    vi.spyOn(provider, "getFills").mockResolvedValue({
      success: true,
      fills: [fill("buy", "4", "100", "2026-01-02T15:00:00Z")],
    });

    const lots = await p.getPositionLots("a1", "AAPL");
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ positionId: "AAPL", price: 100, remainingQty: 4, availableQty: 4 });
    expect(lots[0].acquiredDate).toBe(Date.parse("2026-01-02T15:00:00Z"));

    const detailed = await p.derivePositionLots("AAPL");
    expect(detailed).toMatchObject({ method: "fifo_from_fills", unmatchedQuantity: 0, incomplete: false });
  });

  it("a failed fills read is a failure, not an empty lot list", async () => {
    const p = platform();
    vi.spyOn(p, "getPositions").mockResolvedValue({
      account: { accountId: "a1", accountKey: "a1", accountDesc: "Alpaca", accountType: "MARGIN" } as any,
      positions: [{ symbol: "AAPL", description: "AAPL", quantity: 4, pricePaid: 100, costBasis: 400, currentPrice: 120, marketPrice: 120 } as any],
    });
    vi.spyOn((p as any).alpacaData, "getFills").mockResolvedValue({ success: false, httpStatus: 401 });

    await expect(p.getPositionLots("a1", "AAPL")).rejects.toThrow(/credentials/i);
  });

  it("a symbol with no open position is refused by name", async () => {
    const p = platform();
    vi.spyOn(p, "getPositions").mockResolvedValue({
      account: { accountId: "a1", accountKey: "a1", accountDesc: "Alpaca", accountType: "MARGIN" } as any,
      positions: [],
    });
    await expect(p.getPositionLots("a1", "MSFT")).rejects.toThrow(/no open position for MSFT/);
  });

  it("the registry still hands out the platform the declaration describes", () => {
    const registered = TradingPlatformRegistry.getPlatform("alpaca", ENV, undefined, "user-1", "TEST");
    expect(typeof registered.getPositionLots).toBe("function");
  });
});
