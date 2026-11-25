/**
 * Shared risk mathematics — THE single source of truth (issue #38, gap G5).
 *
 * Before this module existed, the server strategy engine and the client
 * risk/discovery code each carried their own copies of the normal CDF,
 * Black-Scholes, and probability-of-profit math, with divergent constants
 * (client POP default rate 0.045 vs server 0.04, a hardcoded 0.5 POP for
 * 3+ breakevens on the client, flat IV/rate literals in the client risk
 * engine). The same trade could therefore show different risk numbers on
 * different surfaces. Now:
 *
 *  - normalCdf / normalPdf / Black-Scholes / probability-of-profit live
 *    HERE, once. Server and client both delegate; neither keeps a copy.
 *  - The shared constants (risk-free rate, dividend yield) live HERE,
 *    once. Config defaults import them. There is NO missing-IV fallback
 *    constant anywhere in this module (issue #926).
 *
 * INTENTIONAL DIFFERENCES REGISTER (the only sanctioned divergences):
 *  1. Client risk ANATOMY (riskManagementEngine) adds presentation-only
 *     composites the server does not compute: a 0–100 risk score, tail-shock
 *     table, probability-of-touch heuristic, defense playbooks, and — for
 *     subjects with no legs at all — name-based Greek heuristics and a
 *     placeholder POP. Those outputs are labeled via greeksSource /
 *     popSource so no surface can mistake them for engine numbers.
 *  2. There is no IV fallback anywhere (issue #926, S8). Client anatomy
 *     and the server pipeline both require chain IV: a leg without chain
 *     IV is excluded from IV-dependent math and counted (client
 *     missingIvLegs, server missing-IV rejection), and IV-dependent
 *     outputs are marked unavailable — never computed with a constant.
 *  3. The server's acceptance ledger, scoring weights, and candidate
 *     ranking are server-only policy, not math — they live in the engine
 *     and etapiConfig, and intentionally have no client counterpart.
 */

export const RISK_MATH = {
  /** Canonical risk-free rate (matches the etapiConfig default, which imports this). */
  riskFreeRate: 0.04,
  /** Canonical continuous dividend yield assumption. */
  dividendYield: 0,
} as const;

// ---------------------------------------------------------------------------
// Normal distribution (Abramowitz–Stegun erf approximation — the formula both
// engines historically carried identical copies of).
// ---------------------------------------------------------------------------

export function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

export function normalPdf(x: number): number {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

// ---------------------------------------------------------------------------
// Black-Scholes price + Greeks (the full implementation the client carried;
// the server's price-only copy was the same formula and now delegates here).
// ---------------------------------------------------------------------------

export interface OptionGreeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  vanna: number;
  charm: number;
  vomma: number;
}

interface BlackScholesTerms {
  d1: number;
  d2: number;
  expRt: number;
  expQt: number;
  sqrtT: number;
}

function blackScholesTerms(
  s: number,
  k: number,
  t: number,
  v: number,
  r: number,
  q: number,
): BlackScholesTerms {
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + 0.5 * v * v) * t) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  return { d1, d2, expRt: Math.exp(-r * t), expQt: Math.exp(-q * t), sqrtT };
}

/**
 * European Black-Scholes price, price-only.
 *
 * Contract (issue #6529): `NaN` for non-positive/non-finite spot, strike,
 * years, or sigma, or non-finite rate/dividend; no volatility clamp and no
 * near-zero-expiry shortcut. That is the research-economics contract this
 * function replaces. `blackScholesGreeks` keeps its own clamp/short-expiry
 * behaviour at its entry.
 */
export function blackScholesPrice(
  s: number,
  k: number,
  t: number,
  v: number,
  r: number = RISK_MATH.riskFreeRate,
  q: number = RISK_MATH.dividendYield,
  type: "CALL" | "PUT" = "CALL",
): number {
  if (!(s > 0) || !(k > 0) || !(t > 0) || !(v > 0) || !Number.isFinite(s + k + t + r + q + v)) {
    return NaN;
  }
  const { d1, d2, expRt, expQt } = blackScholesTerms(s, k, t, v, r, q);
  return type === "CALL"
    ? s * expQt * normalCdf(d1) - k * expRt * normalCdf(d2)
    : k * expRt * normalCdf(-d2) - s * expQt * normalCdf(-d1);
}

export function blackScholesGreeks(
  s: number,
  k: number,
  t: number,
  v: number,
  r: number = RISK_MATH.riskFreeRate,
  q: number = RISK_MATH.dividendYield,
  type: "CALL" | "PUT" = "CALL",
): OptionGreeks {
  if (t <= 0.0001) {
    const intrinsic = type === "CALL" ? Math.max(0, s - k) : Math.max(0, k - s);
    const delta = type === "CALL" ? (s > k ? 1 : 0) : (s < k ? -1 : 0);
    return { price: intrinsic, delta, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0 };
  }

  const vol = Math.max(0.01, v);
  const { d1, d2, expRt, expQt, sqrtT } = blackScholesTerms(s, k, t, vol, r, q);
  const pdfD1 = normalPdf(d1);

  const gamma = (expQt * pdfD1) / (s * vol * sqrtT);
  const vega = (s * expQt * sqrtT * pdfD1) / 100; // per 1% IV change
  const vanna = (-expQt * pdfD1 * d2) / (vol * 100);
  const vomma = (vega * d1 * d2) / (vol * 100);

  if (type === "CALL") {
    const cdfD1 = normalCdf(d1);
    const cdfD2 = normalCdf(d2);
    const price = blackScholesPrice(s, k, t, vol, r, q, "CALL");
    const delta = expQt * cdfD1;
    const thetaYears = -((s * vol * expQt * pdfD1) / (2 * sqrtT)) - r * k * expRt * cdfD2 + q * s * expQt * cdfD1;
    const rho = (k * t * expRt * cdfD2) / 100;
    const charmYears = q * expQt * cdfD1 - expQt * pdfD1 * ((2 * (r - q) * t - d2 * vol * sqrtT) / (2 * t * vol * sqrtT));
    return {
      price: Math.max(0, price),
      delta,
      gamma,
      theta: thetaYears / 365,
      vega,
      rho,
      vanna,
      charm: charmYears / 365,
      vomma,
    };
  }

  const cdfNegD1 = normalCdf(-d1);
  const cdfNegD2 = normalCdf(-d2);
  const price = blackScholesPrice(s, k, t, vol, r, q, "PUT");
  const delta = -expQt * cdfNegD1;
  const thetaYears = -((s * vol * expQt * pdfD1) / (2 * sqrtT)) + r * k * expRt * cdfNegD2 - q * s * expQt * cdfNegD1;
  const rho = (-k * t * expRt * cdfNegD2) / 100;
  const charmYears = -q * expQt * cdfNegD1 - expQt * pdfD1 * ((2 * (r - q) * t - d2 * vol * sqrtT) / (2 * t * vol * sqrtT));
  return {
    price: Math.max(0, price),
    delta,
    gamma,
    theta: thetaYears / 365,
    vega,
    rho,
    vanna,
    charm: charmYears / 365,
    vomma,
  };
}

// ---------------------------------------------------------------------------
// Probability of profit — the general segment-integration method the server
// engine used, parameterized so both surfaces share it exactly.
// ---------------------------------------------------------------------------

/** Lognormal CDF of the terminal price: P(S_T <= price). */
export function terminalPriceCdf(
  price: number,
  spot: number,
  dteDays: number,
  rate: number,
  dividend: number,
  volatility: number,
): number {
  if (price <= 0) return 0;
  if (!Number.isFinite(price)) return 1;
  const time = dteDays / 365;
  if (time <= 0 || volatility <= 0) return price >= spot ? 1 : 0;
  const z = (Math.log(price / spot) - (rate - dividend - (volatility * volatility) / 2) * time) / (volatility * Math.sqrt(time));
  return normalCdf(z);
}

export interface ProbabilityOfProfitInput {
  spot: number;
  dteDays: number;
  volatility: number;
  rate?: number;
  dividend?: number;
  breakevens: number[];
  /** Sign oracle: is the position profitable at this terminal price? */
  isProfitAt: (terminalPrice: number) => boolean;
}

/**
 * Integrates the lognormal terminal distribution over every breakeven
 * segment, summing the segments where the payoff is profitable. Works for
 * any breakeven count — no special cases, no placeholder values.
 */
export function probabilityOfProfit(input: ProbabilityOfProfitInput): number {
  const rate = input.rate ?? RISK_MATH.riskFreeRate;
  const dividend = input.dividend ?? RISK_MATH.dividendYield;
  const { spot, dteDays, volatility, breakevens, isProfitAt } = input;
  if (dteDays <= 0) return isProfitAt(spot) ? 1 : 0;
  const boundaries = [0, ...breakevens.filter((point) => point > 0), Infinity].sort((a, b) => a - b);
  let probability = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const lower = boundaries[index];
    const upper = boundaries[index + 1];
    const testSpot = Number.isFinite(upper) ? (lower + upper) / 2 : lower + Math.max(spot, 1);
    if (isProfitAt(testSpot)) {
      probability +=
        terminalPriceCdf(upper, spot, dteDays, rate, dividend, volatility) -
        terminalPriceCdf(lower, spot, dteDays, rate, dividend, volatility);
    }
  }
  return Math.min(1, Math.max(0, probability));
}

export interface ProbabilityOfProfitFlagsInput {
  spot: number;
  breakevens: number[];
  /** Is the payoff profitable far below the lowest breakeven / far above the highest? */
  payoffAtLimits: { lowProfit: boolean; highProfit: boolean };
  timeToExpiryYears: number;
  volatility: number;
  riskFreeRate?: number;
  dividendYield?: number;
}

/**
 * POP from breakevens + payoff-at-the-limits flags (the client surface's
 * historical signature). The profit sign alternates at each breakeven —
 * the same assumption the old 1/2-breakeven special cases encoded — but the
 * integration itself is the shared general method, so any breakeven count
 * works and results equal the server's for identical inputs.
 */
export function probabilityOfProfitFromFlags(input: ProbabilityOfProfitFlagsInput): number {
  const sorted = [...new Set(input.breakevens.filter((b) => b > 0))].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return input.payoffAtLimits.lowProfit && input.payoffAtLimits.highProfit ? 1 : 0;
  }
  const isProfitAt = (testSpot: number): boolean => {
    let crossings = 0;
    for (const be of sorted) if (testSpot > be) crossings++;
    if (crossings === 0) return input.payoffAtLimits.lowProfit;
    if (crossings === sorted.length) return input.payoffAtLimits.highProfit;
    // Interior segments alternate, starting from the low region's sign.
    return crossings % 2 === 0 ? input.payoffAtLimits.lowProfit : !input.payoffAtLimits.lowProfit;
  };
  return probabilityOfProfit({
    spot: input.spot,
    dteDays: input.timeToExpiryYears * 365,
    volatility: input.volatility,
    rate: input.riskFreeRate,
    dividend: input.dividendYield,
    breakevens: sorted,
    isProfitAt,
  });
}
