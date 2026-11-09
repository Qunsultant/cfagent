/**
 * Issue #3812 — deterministic percent bracket exits.
 *
 * A user asks for "a limit buy order for 10 AAPL with +4% take-profit and
 * -2% stop-loss bracket exits". Before this module the only bracket
 * parameters the platform accepted were ABSOLUTE prices, so the model had
 * to fetch a quote, do percentage arithmetic itself, and round — an
 * unverifiable step on a money path (the #3782 price-provenance rule
 * forbids presenting a price without a named source + timestamp).
 *
 * This helper is the one place percent exits are converted to absolute
 * prices. It is pure: the caller supplies the entry the draft is priced
 * from (a user limit, or a live quote already fetched by the adapter),
 * and the helper returns the two leg prices rounded to cents, or throws
 * a coded refusal. No ambient quote is read here, so the result carries
 * exactly the provenance of its entry.
 *
 * Rounding is half-up to 2 decimals (monetary cents). The validation is
 * side-aware: a BUY bracket needs TP > entry > SL; a SELL bracket needs
 * TP < entry < SL. Percentages must be finite, positive, and below 100 —
 * a 0% or 100% leg is a malformed request, not a trade.
 */

export type BracketSide = "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";

export interface BracketPercentInput {
  side: BracketSide;
  /** The draft's entry price: a user limit or a live quote. Must be > 0. */
  entryPrice: number;
  /** Take-profit distance in percent, e.g. 4 for +4%. */
  takeProfitPercent: number;
  /** Stop-loss distance in percent, e.g. 2 for -2%. */
  stopLossPercent: number;
}

export interface BracketPercentExits {
  takeProfit: { limitPrice: number };
  stopLoss: { stopPrice: number };
  /** Echo of the resolved percents, for the receipt and audit trail. */
  takeProfitPercent: number;
  stopLossPercent: number;
}

export type BracketPercentErrorCode =
  | "invalid_bracket_entry"
  | "invalid_bracket_percent"
  | "invalid_bracket_prices";

export class BracketPercentError extends Error {
  readonly code: BracketPercentErrorCode;
  constructor(code: BracketPercentErrorCode, message: string) {
    super(message);
    this.name = "BracketPercentError";
    this.code = code;
  }
}

/** Half-up to cents; avoids binary float artefacts such as 342.37000000000006. */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function validPercent(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 100;
}

/**
 * Convert percent exits to absolute bracket leg prices.
 *
 * BUY / BUY_TO_COVER: TP = entry × (1 + tp/100), SL = entry × (1 − sl/100).
 * SELL / SELL_SHORT:  TP = entry × (1 − tp/100), SL = entry × (1 + sl/100).
 */
export function computeBracketExits(input: BracketPercentInput): BracketPercentExits {
  const { side, entryPrice, takeProfitPercent, stopLossPercent } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new BracketPercentError(
      "invalid_bracket_entry",
      `Bracket exits need a positive entry price; received ${String(entryPrice)}.`,
    );
  }
  if (!validPercent(takeProfitPercent) || !validPercent(stopLossPercent)) {
    throw new BracketPercentError(
      "invalid_bracket_percent",
      `Bracket percentages must be finite, greater than 0 and below 100; received take-profit ${String(takeProfitPercent)}% and stop-loss ${String(stopLossPercent)}%.`,
    );
  }

  const isBuy = side === "BUY" || side === "BUY_TO_COVER";
  const takeProfit = roundCents(
    isBuy
      ? entryPrice * (1 + takeProfitPercent / 100)
      : entryPrice * (1 - takeProfitPercent / 100),
  );
  const stopLoss = roundCents(
    isBuy
      ? entryPrice * (1 - stopLossPercent / 100)
      : entryPrice * (1 + stopLossPercent / 100),
  );

  const ordered = isBuy
    ? takeProfit > entryPrice && entryPrice > stopLoss && takeProfit > stopLoss
    : takeProfit < entryPrice && entryPrice < stopLoss && takeProfit < stopLoss;
  if (!ordered) {
    throw new BracketPercentError(
      "invalid_bracket_prices",
      `Computed bracket legs are not ordered for a ${side}: entry $${entryPrice.toFixed(2)}, take-profit $${takeProfit.toFixed(2)}, stop-loss $${stopLoss.toFixed(2)}.`,
    );
  }

  return {
    takeProfit: { limitPrice: takeProfit },
    stopLoss: { stopPrice: stopLoss },
    takeProfitPercent,
    stopLossPercent,
  };
}
