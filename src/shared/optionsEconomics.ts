/**
 * Issue #6506 — the one pure options-economics calculation layer.
 *
 * OODA's research pipeline (`services/researchEconomics.ts`) and the screen
 * strategy engine (`trading/options/strategyEngine.ts`) previously carried
 * separate copies of the same arithmetic: mid premium, net open cost,
 * intrinsic/payoff, breakeven search, grid extremes, and expected move.
 * They agreed by convention; this module makes them agree by construction.
 *
 * Boundaries kept deliberately:
 * - This module knows nothing about fees, scoring, gates, rankings, brokers,
 *   or report shapes. Callers fold those in before/after the pure math.
 * - Callers choose their own payoff function and sample grid. The research
 *   grid prices all legs at expiry; the screen engine prices later-dated
 *   legs with Black-Scholes. The search and extremes are shared; the payoff
 *   model stays with the engine that owns it.
 */

/** Option kind in the shared calculation vocabulary. */
export type EconomicsOptionType = "call" | "put";

/** One priced leg: what net cost and payoff arithmetic actually need. */
export interface PricedEconomicsLeg {
  /** Signed position: positive long, negative short. */
  quantity: number;
  /** Per-share premium the leg is priced at (mid or entry). */
  price: number;
}

/** One option leg in the shared calculation vocabulary. */
export interface EconomicsLeg extends PricedEconomicsLeg {
  optionType: EconomicsOptionType;
  strike: number;
}

/** Mid premium from a bid/ask pair. */
export function midPrice(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

/** Net cash flow to open: positive = debit paid, negative = credit received. */
export function netOpenCost(legs: PricedEconomicsLeg[]): number {
  return legs.reduce((sum, leg) => sum + leg.quantity * leg.price, 0);
}

/** Intrinsic value of one option at expiry. */
export function intrinsicValue(
  optionType: EconomicsOptionType,
  spot: number,
  strike: number,
): number {
  return optionType === "call"
    ? Math.max(spot - strike, 0)
    : Math.max(strike - spot, 0);
}

/** Structure value at expiry before open costs (sum of signed intrinsic values). */
export function expiryPayoff(legs: EconomicsLeg[], spot: number): number {
  return legs.reduce(
    (sum, leg) => sum + leg.quantity * intrinsicValue(leg.optionType, spot, leg.strike),
    0,
  );
}

/** One-standard-deviation expected move over `years` at volatility `sigma`. */
export function expectedMove(spot: number, sigma: number, years: number): number {
  if (!(spot > 0) || !(sigma > 0) || !(years > 0)) return NaN;
  return spot * sigma * Math.sqrt(years);
}

/** Min/max of a payoff over the supplied sample grid. */
export function gridExtreme(
  payoff: (spot: number) => number,
  samples: number[],
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const spot of samples) {
    const pnl = payoff(spot);
    if (pnl < min) min = pnl;
    if (pnl > max) max = pnl;
  }
  return { min, max };
}

export interface BreakevenSearchOptions {
  /**
   * `bisection` (default) refines each sign change on the continuous payoff;
   * `linear` interpolates between the supplied samples. Both callers use the
   * mode that matches their historical precision.
   */
  refine?: "bisection" | "linear";
  /** Decimal places to report; default 2. */
  precision?: number;
  /** Roots closer than this are the same root; default exact equality. */
  dedupeTolerance?: number;
  /**
   * Slope of the payoff beyond the last sample. When supplied, a tail root
   * after the grid is extrapolated from the last point (the screen engine's
   * unbounded-tail handling).
   */
  tailSlope?: number;
}

/**
 * Roots of a payoff function over a caller-supplied sample grid.
 *
 * Handles zeros exactly on a sample, sign changes between samples, and an
 * optional linear tail. The caller owns the grid bounds and the payoff model;
 * this function owns the search so two engines cannot implement it twice.
 */
export function findBreakevensFromPayoff(
  payoff: (spot: number) => number,
  samples: number[],
  options: BreakevenSearchOptions = {},
): number[] {
  if (samples.length === 0) return [];
  const refine = options.refine ?? "bisection";
  const precision = options.precision ?? 2;
  const tolerance = options.dedupeTolerance ?? 0;
  const out: number[] = [];

  const record = (raw: number): void => {
    if (!Number.isFinite(raw)) return;
    const rounded = Number(raw.toFixed(precision));
    if (out.some((existing) => Math.abs(existing - rounded) <= tolerance)) return;
    out.push(rounded);
  };

  let previousSpot = samples[0];
  let previousPayoff = payoff(previousSpot);
  if (previousPayoff === 0) record(previousSpot);

  for (let index = 1; index < samples.length; index++) {
    const spot = samples[index];
    const pnl = payoff(spot);

    if (previousPayoff !== 0 && pnl !== 0 &&
        ((previousPayoff < 0 && pnl > 0) || (previousPayoff > 0 && pnl < 0))) {
      if (refine === "linear") {
        record(previousSpot + (-previousPayoff * (spot - previousSpot)) / (pnl - previousPayoff));
      } else {
        let low = previousSpot;
        let high = spot;
        const lowSide = payoff(low) <= 0;
        for (let step = 0; step < 40; step++) {
          const mid = (low + high) / 2;
          if ((payoff(mid) <= 0) === lowSide) low = mid;
          else high = mid;
        }
        record((low + high) / 2);
      }
    } else if (pnl === 0) {
      record(spot);
    }

    previousSpot = spot;
    previousPayoff = pnl;
  }

  if (options.tailSlope !== undefined && options.tailSlope !== 0) {
    const lastSpot = samples[samples.length - 1];
    const lastPayoff = payoff(lastSpot);
    if (lastPayoff !== 0) {
      const tailRoot = lastSpot - lastPayoff / options.tailSlope;
      if (tailRoot > lastSpot) record(tailRoot);
    }
  }

  return out.sort((a, b) => a - b);
}
