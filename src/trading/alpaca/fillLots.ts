/**
 * Issue #3328 (programme #3292): tax lots for Alpaca, derived from fills.
 *
 * `positionLots` was declared permanently unavailable for Alpaca on the
 * grounds that it exposes no tax-lot endpoint. That is true and beside the
 * point: it exposes account activities of type FILL, each with the executed
 * quantity, price and transaction time. FIFO over those fills answers the same
 * question the lot surface asks, and the derivation is honest about the one
 * thing it cannot know — quantity whose fills are older than the retained
 * window.
 *
 * The rules this module keeps:
 *   - FIFO, oldest fill first; a closing fill consumes the oldest open lot.
 *   - Long and short books are derived symmetrically: a short position's lots
 *     are the sells that opened it, consumed by covering buys.
 *   - A quantity with no matching fill is reported as `unmatchedQuantity`,
 *     never as a lot at price 0 and never silently dropped.
 *   - Fees are not folded into the lot price: Alpaca reports them separately,
 *     and a lot price that quietly included them would not reconcile with the
 *     fills a user can see.
 */

export interface AlpacaFill {
  readonly id?: string;
  readonly symbol: string;
  /** Alpaca reports `buy` / `sell` (lower case in activities). */
  readonly side: string;
  readonly quantity: number;
  readonly price: number;
  /** ISO timestamp of the transaction. */
  readonly transactionTime: string;
}

export interface DerivedLot {
  readonly quantity: number;
  readonly price: number;
  readonly acquiredAt: string;
  readonly fillId?: string;
}

export interface DerivedLots {
  readonly method: "fifo_from_fills";
  readonly lots: DerivedLot[];
  /** Position quantity that no retained fill explains (0 when fully covered). */
  readonly unmatchedQuantity: number;
  /** True when any fill was unreadable and therefore excluded. */
  readonly incomplete: boolean;
}

/** Normalize one activity row; null when it is not a usable fill. */
export function parseAlpacaFill(raw: Record<string, unknown>): AlpacaFill | null {
  const symbol = typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  const side = typeof raw.side === "string" ? raw.side.trim().toLowerCase() : "";
  const quantity = Number(raw.qty);
  const price = Number(raw.price);
  const transactionTime =
    typeof raw.transaction_time === "string"
      ? raw.transaction_time
      : typeof raw.transactionTime === "string"
        ? (raw.transactionTime as string)
        : "";
  if (!symbol || (side !== "buy" && side !== "sell")) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(price) || price < 0) return null;
  if (!transactionTime) return null;
  return {
    symbol,
    side,
    quantity,
    price,
    transactionTime,
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
  };
}

/**
 * FIFO lots for one position, in fill order.
 *
 * `positionQuantity` is the SIGNED position size (negative for short). The
 * sign selects which side opens lots: buys for a long book, sells for a short.
 */
export function deriveLotsFromFills(
  fills: AlpacaFill[],
  positionQuantity: number,
): DerivedLots {
  const wantsLong = positionQuantity >= 0;
  const openingSide = wantsLong ? "buy" : "sell";
  const closingSide = wantsLong ? "sell" : "buy";

  const ordered = [...fills].sort(
    (a, b) => Date.parse(a.transactionTime) - Date.parse(b.transactionTime),
  );

  const open: DerivedLot[] = [];
  for (const fill of ordered) {
    if (fill.side === openingSide) {
      open.push({
        quantity: fill.quantity,
        price: fill.price,
        acquiredAt: fill.transactionTime,
        ...(fill.id ? { fillId: fill.id } : {}),
      });
      continue;
    }
    if (fill.side !== closingSide) continue;
    let remaining = fill.quantity;
    while (remaining > 1e-9 && open.length > 0) {
      const lot = open[0];
      const consumed = Math.min(lot.quantity, remaining);
      remaining -= consumed;
      if (consumed >= lot.quantity - 1e-9) {
        open.shift();
      } else {
        open[0] = { ...lot, quantity: lot.quantity - consumed };
      }
    }
    // A closing fill with nothing to close is not a lot; it is history that
    // predates the retained window, and the unmatched count below says so.
  }

  const covered = open.reduce((sum, lot) => sum + lot.quantity, 0);
  const unmatchedQuantity = Math.max(0, Math.abs(positionQuantity) - covered);

  return {
    method: "fifo_from_fills",
    lots: open.map((lot) => ({ ...lot, quantity: Number(lot.quantity.toFixed(6)) })),
    unmatchedQuantity: Number(unmatchedQuantity.toFixed(6)),
    incomplete: false,
  };
}
