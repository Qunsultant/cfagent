/**
 * Strategy auto-build for the Fast Order Ticket (issue #3090).
 *
 * Maps a STRATEGY_LIBRARY definition to the ticket's TradeOrderLeg[]
 * shape. The mapping is deliberately lossy and honest:
 * - side, optionType (STOCK -> EQ), strike, quantity, expirationDate
 *   carry over; everything else (id, dte, entryPrice, bid/ask,
 *   greeks, IV) is dropped. Ticket legs carry no IV by design
 *   (#3125: IV-less legs are excluded from Greek sums), so the
 *   broker preview prices the built structure from live quotes,
 *   never from the library's Black-Scholes model prices.
 * - MODEL_IV mirrors discovery's default builder IV (27.5%). It
 *   feeds only the model prices/greeks that this mapping discards;
 *   it never reaches the broker preview and there is no IV input
 *   on the ticket because the order does not need one.
 */
import type { StrategyDefinition } from "../options/strategyLibrary";
import type { TradeOrderLeg } from "./tradeOrderContext";

/** Model-only IV, mirroring discovery's default (27.5%). Discarded by the mapping. */
export const STRATEGY_AUTOBUILD_MODEL_IV = 0.275;

/** Whole days from today (local) to an expiry date (YYYY-MM-DD), floored at 0. */
export function dteForExpiry(expiryDate: string, today: Date = new Date()): number {
  const [year, month, day] = expiryDate.split("-").map(Number);
  const expiry = Date.UTC(year, (month || 1) - 1, day || 1);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((expiry - start) / 86_400_000));
}

/** Map one library leg to a ticket leg. STOCK legs become EQ legs. */
export function mapStrategyLegToTradeLeg(
  leg: { side: "BUY" | "SELL"; optionType: "CALL" | "PUT" | "STOCK"; strike: number; quantity: number; expirationDate: string },
): TradeOrderLeg {
  if (leg.optionType === "STOCK") {
    return { securityType: "EQ", side: leg.side, quantity: leg.quantity };
  }
  return {
    securityType: "OPTN",
    side: leg.side,
    quantity: leg.quantity,
    optionType: leg.optionType,
    strike: leg.strike,
    expirationDate: leg.expirationDate,
  };
}

/** Build a strategy's ticket legs for one shared expiration date. */
export function buildTradeLegs(
  definition: StrategyDefinition,
  spot: number,
  expiryDate: string,
): { legs: TradeOrderLeg[]; dte: number } {
  const dte = dteForExpiry(expiryDate);
  const built = definition.buildLegs(spot, dte, expiryDate, STRATEGY_AUTOBUILD_MODEL_IV);
  return { legs: built.map(mapStrategyLegToTradeLeg), dte };
}

/** One-line description of a ticket leg, for the context's legs text. */
export function describeTradeLeg(leg: TradeOrderLeg): string {
  if (leg.securityType === "EQ") {
    return `${leg.side} ${leg.quantity} shares`;
  }
  return `${leg.side} ${leg.quantity} ${leg.optionType} $${leg.strike} exp ${leg.expirationDate}`;
}
