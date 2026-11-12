import type { OptionThesis, StrategyCandidate, TradeAssetClass } from "../../trading";

/** Asset-aware handoff from research and portfolio tools to the shared order ticket.
 * Add a new asset class here together with its ticket fields and broker adapter;
 * unsupported classes must not be routed through the equity/options payload.
 */
export type { TradeAssetClass };

export interface TradeOrderLeg {
  securityType: "EQ" | "OPTN";
  side: "BUY" | "SELL";
  quantity: number;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expirationDate?: string;
}

export interface TradeOrderContext {
  assetClass: TradeAssetClass;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  underlyingPrice?: number;
  label: string;
  legs: string[];
  optionLegs?: TradeOrderLeg[];
  /** Positive is net debit; negative is net credit. */
  strategyNetDebit?: number;
}

/**
 * Build the HITL-preview handoff for a screening candidate.
 *
 * The canonical candidate → order-context mapping, field-for-field
 * the same as OptionsResearchPanel.toTradeContext (and
 * ScannerPanel.matrixCellTradeContext for the flattened matrix shape):
 * the symbol comes from the candidate, the action follows the run's
 * thesis (bearish → SELL_SHORT, anything else → BUY), quantity is 1,
 * the label carries the expiry and max loss, and the legs map
 * optionType STOCK → EQ (no strike/expiry) and anything else → OPTN.
 * The underlying price is the caller's spot when known; an unknown
 * price is omitted, never invented — the research panel's value comes
 * from its own screened chain, not from the candidate, and inventing
 * one here would misstate the preview.
 *
 * Issue #3361 (#3121 S2 follow-up): the de-hubbed schedules home
 * hands the live-result preview candidate to the order ticket through
 * this converter. The hub-era call passed the raw candidate straight
 * to the hub's order handler (hidden by the `(candidate: any)` prop type),
 * so the ticket got symbol + limit price but no side, quantity, or
 * legs; this converter is the prefill as intended. Unifying the three
 * copies of this mapping (here, OptionsResearchPanel, ScannerPanel)
 * into one is out of scope for #3361 — see the PR body.
 */
export function candidateToTradeContext(
  candidate: StrategyCandidate,
  thesis: OptionThesis | "neutral" | "directional",
  underlyingPrice?: number,
): TradeOrderContext {
  const optionLegs = candidate.legs.map((leg) => ({
    securityType: leg.optionType === "STOCK" ? ("EQ" as const) : ("OPTN" as const),
    side: leg.side,
    quantity: leg.quantity,
    optionType: leg.optionType === "STOCK" ? undefined : leg.optionType,
    strike: leg.optionType === "STOCK" ? undefined : leg.strike,
    expirationDate: leg.optionType === "STOCK" ? undefined : leg.expirationDate,
  }));
  return {
    assetClass: optionLegs.some((leg) => leg.securityType === "OPTN") ? "options" : "equity",
    symbol: candidate.symbol,
    action: thesis === "bearish" ? "SELL_SHORT" : "BUY",
    quantity: 1,
    underlyingPrice,
    label: `${candidate.label} (${candidate.expirationDate}), max loss ${candidate.maxLoss === null ? "unlimited" : `$${candidate.maxLoss}`}`,
    legs: candidate.legs.map(
      (leg) => `${leg.side} ${leg.quantity} ${leg.symbol} @ $${leg.entryPrice.toFixed(2)}`,
    ),
    optionLegs,
    strategyNetDebit: candidate.netDebit,
  };
}

