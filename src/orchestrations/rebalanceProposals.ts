/**
 * #1771 (parent #1717) slice C: autonomous rebalancing, enabled as
 * DRAFT-only drift proposals — the "autonomous" part of F-45 that
 * can ship without bypassing any control.
 *
 * Given current holdings (shares × price) and target weights, this
 * pure module computes, per target symbol, current weight, target
 * weight, drift, and the buy/sell quantity that would restore the
 * target. It is deliberately NOT an execution engine:
 *
 * - DRAFTS ONLY. A proposal is data for the existing HITL
 *   order-preview / approval workflow; nothing here places,
 *   previews, or submits an order (same pattern as
 *   repairProposals.ts, #355).
 * - Unlisted holdings are NAMED in `unlisted` and get NO proposal
 *   — a partial target list must never silently liquidate
 *   everything it does not mention.
 * - Target weights must sum to ~1 (tolerance 0.01) or the call
 *   throws naming the sum: a mis-specified target must fail
 *   loud, never normalize silently into a different portfolio.
 * - Zero/negative prices and negative shares throw; a target
 *   symbol with no price input gets no quantity (priceUnknown)
 *   rather than a fabricated price.
 * - Drift below minDrift (default 0.01 = 1pp of portfolio) is a
 *   "hold" proposal, not a trade: rebalancing must not churn on
 *   noise. The threshold is a caller input, not a switch — the
 *   caller owns its rebalance policy; the approval workflow
 *   owns execution.
 */

export interface RebalanceHolding {
  symbol: string;
  shares: number;
  price: number;
}

export interface RebalanceTarget {
  symbol: string;
  targetWeight: number;
}

export type RebalanceAction = "buy" | "sell" | "hold";

export interface RebalanceProposal {
  status: "DRAFT";
  symbol: string;
  action: RebalanceAction;
  /** Signed shares: positive = buy, negative = sell, 0 = hold. */
  shares: number;
  /** Signed notional: positive = buy value, negative = sell value. */
  notional: number;
  currentWeight: number;
  targetWeight: number;
  /** currentWeight - targetWeight (signed). */
  drift: number;
  /** True when the target symbol has no holding price to size from. */
  priceUnknown?: boolean;
}

export interface RebalanceResult {
  status: "DRAFT";
  totalValue: number;
  proposals: RebalanceProposal[];
  /** Holding symbols absent from the target list: named, never proposed, never sold. */
  unlisted: string[];
}

export function computeRebalanceProposals(
  holdings: RebalanceHolding[],
  targets: RebalanceTarget[],
  opts: { minDrift?: number } = {},
): RebalanceResult {
  const minDrift = opts.minDrift ?? 0.01;
  if (!(minDrift >= 0)) throw new Error(`rebalance: minDrift must be >= 0, got ${minDrift}`);
  const targetSum = targets.reduce((a, t) => a + t.targetWeight, 0);
  if (targets.length === 0) throw new Error("rebalance: at least one target weight is required");
  if (Math.abs(targetSum - 1) > 0.01) {
    throw new Error(`rebalance: target weights sum to ${targetSum}, expected 1 within 0.01 — refusing to normalize silently`);
  }
  const holdingBySymbol = new Map<string, RebalanceHolding>();
  for (const h of holdings) {
    if (h.shares < 0) throw new Error(`rebalance: negative shares for ${h.symbol}`);
    if (h.price <= 0) throw new Error(`rebalance: non-positive price for ${h.symbol}`);
    holdingBySymbol.set(h.symbol, h);
  }
  const totalValue = holdings.reduce((a, h) => a + h.shares * h.price, 0);
  const targetSymbols = new Set(targets.map((t) => t.symbol));
  const unlisted = holdings
    .map((h) => h.symbol)
    .filter((s) => !targetSymbols.has(s))
    .sort();
  const proposals: RebalanceProposal[] = targets.map((t) => {
    const h = holdingBySymbol.get(t.symbol);
    const currentValue = h ? h.shares * h.price : 0;
    const currentWeight = totalValue > 0 ? currentValue / totalValue : 0;
    const drift = currentWeight - t.targetWeight;
    if (!h) {
      // No holding and no price: cannot size a buy without inventing one.
      return {
        status: "DRAFT" as const,
        symbol: t.symbol,
        action: "hold" as const,
        shares: 0,
        notional: 0,
        currentWeight,
        targetWeight: t.targetWeight,
        drift,
        priceUnknown: true,
      };
    }
    if (Math.abs(drift) < minDrift) {
      return {
        status: "DRAFT" as const, symbol: t.symbol, action: "hold" as const,
        shares: 0, notional: 0, currentWeight, targetWeight: t.targetWeight, drift,
      };
    }
    // Negative drift = underweight = buy; positive drift = overweight = sell.
    const notional = -drift * totalValue;
    const shares = notional / h.price;
    return {
      status: "DRAFT" as const,
      symbol: t.symbol,
      action: notional > 0 ? ("buy" as const) : ("sell" as const),
      shares,
      notional,
      currentWeight,
      targetWeight: t.targetWeight,
      drift,
    };
  });
  return { status: "DRAFT", totalValue, proposals, unlisted };
}
