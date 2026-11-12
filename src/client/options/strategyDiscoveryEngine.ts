/**
 * #1639 (D7 disposition, parent #1638, doc §1) — CLIENT MODELING LAYER
 * ONLY, not an engine of record. The functions here (analyzeStrategy,
 * evaluateStrategyPnL, calculateNetGreeks, payoff matrices, leg edits)
 * model legs the user is actively editing in the Builder: pure,
 * synchronous math over caller-supplied legs, with no server fetch,
 * no chain load, and no ranking of record. Discovery ranking is the
 * server panel path — POST /api/trading/options/strategies via
 * runOptionsPanelViaEngine → RecommendationService.discoverPanel — reached
 * from the client through serverDiscovery.fetchServerDiscovery, which
 * maps the server-ranked candidates back into this module's view
 * types. Nothing here may call the server or rank a discovery: if a
 * Builder change ever needs a ranked recommendation, it goes through
 * serverDiscovery, never through a local ranker in this module.
 */
import { blackScholes, calculateProbabilityOfProfit, normalCdf } from "./blackScholes";

export type SentimentType =
  | "all"
  | "very_bearish"
  | "bearish"
  | "neutral"
  | "directional"
  | "bullish"
  | "very_bullish";

export interface StrategyLegItem {
  id: string;
  side: "BUY" | "SELL";
  optionType: "CALL" | "PUT" | "STOCK";
  strike: number;
  quantity: number;
  expirationDate: string;
  dte: number;
  entryPrice: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho?: number;
  vanna?: number;
  charm?: number;
  vomma?: number;
  /** Custom entered cost-basis per unit; shows blue dollar icon when set */
  customCostBasis?: number;
  /** When true, excluded from all P&L and Greeks calculations; displays crossed-out eye */
  isExcluded?: boolean;
  /** When true, position has been closed to lock in realized profit/loss; displays blue checkmark */
  isClosed?: boolean;
  /** Execution exit price when leg was closed */
  closingPrice?: number;
  /** Market trading volume */
  volume?: number;
  /** Open interest contracts */
  openInterest?: number;
}

export interface NetOptionGreeks {
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  netRho: number;
  netVanna?: number;
  netCharm?: number;
  netVomma?: number;
  weightedIv?: number;
}

export interface RealizedUnrealizedPnl {
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  hasCustomCostBasis: boolean;
  hasClosedPositions: boolean;
}

export interface Matrix2dCell {
  price: number;
  dateStr: string;
  dteRemaining: number;
  pnlDollar: number;
  pnlPercent: number;
  riskPercent: number;
  contractValue: number;
}

export interface Matrix2dColumn {
  dateStr: string;
  label: string;
  dteRemaining: number;
  isExDiv?: boolean;
  isEarnings?: boolean;
}

export interface Matrix2dRow {
  price: number;
  priceLabel: string;
  isAtSpot: boolean;
  cells: Matrix2dCell[];
}

export interface Payoff2dMatrixResult {
  columns: Matrix2dColumn[];
  rows: Matrix2dRow[];
  minPnl: number;
  maxPnl: number;
}

export interface StrategyEvaluationFactors {
  /** Return on Risk / Target Profit score (0 - 100) */
  returnScore: number;
  /** Probability of Profit score (0 - 100) */
  chanceScore: number;
  /** Breakeven safety buffer % vs current spot */
  cushionPct: number;
  /** Margin of safety / cushion score (0 - 100) */
  cushionScore: number;
  /** Capital efficiency score (0 - 100) */
  capitalEfficiencyScore: number;
  /** Overall composite match score (0 - 100) given the active bias */
  compositeScore: number;
}

export interface StrategyDiscoveryConfig {
  riskFreeRate?: number;
  feePerContract?: number;
  maxCombinations?: number;
  detailLimit?: number;
  maxLegs?: number;
}

export interface OptimizationBiasFactors {
  /** Weight applied to Return & Leverage (0 - 100) */
  returnWeight: number;
  /** Weight applied to Probability of Profit (0 - 100) */
  chanceWeight: number;
  /** Weight applied to Breakeven Safety Cushion (0 - 100) */
  safetyWeight: number;
  /** Weight applied to Capital Efficiency (0 - 100) */
  capitalWeight: number;
  /** Optimization regime descriptor */
  regime: "Max Return (High Leverage / OTM)" | "Balanced EV (Risk-Adjusted)" | "Max Chance (High Win-Rate / ITM)";
  regimeDescription: string;
}

export interface DiscoveredStrategy {
  id: string;
  name: string;
  category: string;
  subtitle: string;
  theses: SentimentType[];
  legs: StrategyLegItem[];
  netDebit: number; // positive = debit, negative = credit
  estMargin: number;
  maxProfit: number | null; // null = unlimited
  maxLoss: number | null; // null = infinite
  targetProfit: number;
  riskOrCollateral: number;
  returnOnRiskPct: number | null;
  returnOnCollateralPct: number | null;
  rewardRiskRatio?: number | null; // e.g. 2.5 or null if uncapped
  chanceOfProfit: number; // 0 to 100
  breakevens: number[];
  breakevenText: string;
  miniPayoffPoints: Array<{ price: number; pnl: number }>;
  expirationDate: string;
  dte: number;
  description: string;
  tag?: string;
  factors?: StrategyEvaluationFactors;
}

export interface ExpirationOption {
  date: string;
  label: string;
  monthGroup?: string;
  dayLabel: string;
  dte: number;
  isStandardMonthly?: boolean;
}

/**
 * Generates standard option expiration schedule starting from now.
 */
export function generateExpirations(referenceDate: Date = new Date()): ExpirationOption[] {
  const result: ExpirationOption[] = [];
  const start = new Date(referenceDate);

  // Near-term cycles (days / weeks)
  const daysOffsets = [0.5, 2, 4, 7, 9, 11, 18, 25, 32, 39, 46, 60, 90, 120, 180, 270, 365, 450, 540, 720];
  const seenDates = new Set<string>();

  for (const offset of daysOffsets) {
    const d = new Date(start.getTime() + offset * 24 * 60 * 60 * 1000);
    // Align to Friday if > 14 days
    if (offset > 7 && d.getDay() !== 5) {
      const diffToFriday = (5 - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + diffToFriday);
    }
    const iso = d.toISOString().slice(0, 10);
    if (seenDates.has(iso)) continue;
    seenDates.add(iso);

    const monthShort = d.toLocaleString("en-US", { month: "short" });
    const day = d.getDate();
    const year = d.getFullYear();
    const isNextYears = year > start.getFullYear();
    const yearLabel = isNextYears ? ` '${String(year).slice(-2)}` : "";
    const group = isNextYears ? `${monthShort}${yearLabel}` : monthShort;

    result.push({
      date: iso,
      label: `${monthShort} ${day}${yearLabel}`,
      monthGroup: group,
      dayLabel: String(day),
      dte: Math.max(0.5, Math.round(offset)),
    });
  }

  return result;
}

/**
 * Calculates standard strike ladder around underlying price.
 */
export function generateStrikeLadder(spot: number): number[] {
  let step = 1;
  if (spot > 500) step = 10;
  else if (spot > 200) step = 5;
  else if (spot > 100) step = 2.5;
  else if (spot > 50) step = 1;
  else if (spot > 20) step = 0.5;
  else step = 0.25;

  const center = Math.round(spot / step) * step;
  const count = 35;
  const strikes: number[] = [];
  for (let i = -count; i <= count; i++) {
    const strike = Number((center + i * step).toFixed(2));
    if (strike > 0) strikes.push(strike);
  }
  return strikes;
}

/**
 * Computes PnL at price `s` for a collection of legs at time `tRemainingYears`.
 * When tRemainingYears === 0, evaluates exact expiration payoff.
 */
export function evaluateStrategyPnL(
  legs: StrategyLegItem[],
  price: number,
  tRemainingYears: number,
  volatility: number,
  r: number = 0.04
): number {
  let totalPnL = 0;

  for (const leg of legs) {
    // 1. Excluded legs do not contribute to P&L
    if (leg.isExcluded) continue;

    const effectiveCost = leg.customCostBasis !== undefined ? leg.customCostBasis : leg.entryPrice;
    const multiplier = leg.optionType === "STOCK" ? 1 : 100;

    // 2. Closed legs lock in realized P&L based on exit closingPrice
    if (leg.isClosed && leg.closingPrice !== undefined) {
      const closedGain = leg.side === "BUY"
        ? (leg.closingPrice - effectiveCost) * multiplier * leg.quantity
        : (effectiveCost - leg.closingPrice) * multiplier * leg.quantity;
      totalPnL += closedGain;
      continue;
    }

    if (leg.optionType === "STOCK") {
      const perSharePnL = price - effectiveCost;
      const legPnL = (leg.side === "BUY" ? 1 : -1) * leg.quantity * perSharePnL;
      totalPnL += legPnL;
      continue;
    }

    const vol = leg.impliedVolatility || volatility;

    let currentOptionValue: number;
    if (tRemainingYears <= 0.0001) {
      // Expiration intrinsic value
      currentOptionValue =
        leg.optionType === "CALL" ? Math.max(0, price - leg.strike) : Math.max(0, leg.strike - price);
    } else {
      // Black-Scholes theoretical value
      const bs = blackScholes(price, leg.strike, tRemainingYears, vol, r, 0, leg.optionType);
      currentOptionValue = bs.price;
    }

    const perContractPnL =
      leg.side === "BUY"
        ? (currentOptionValue - effectiveCost) * multiplier
        : (effectiveCost - currentOptionValue) * multiplier;

    totalPnL += perContractPnL * leg.quantity;
  }

  return totalPnL;
}

/**
 * Helper to build a standard single leg with Black-Scholes pricing.
 */
function makeLeg(
  side: "BUY" | "SELL",
  optionType: "CALL" | "PUT",
  strike: number,
  spot: number,
  dte: number,
  expirationDate: string,
  iv: number,
  quantity: number = 1,
  r: number = 0.04
): StrategyLegItem {
  const t = Math.max(0.5, dte) / 365;
  const bs = blackScholes(spot, strike, t, iv, r, 0, optionType);
  const mid = bs.price;
  const spreadHalf = Math.max(0.05, mid * 0.03);
  const bid = Math.max(0.01, Number((mid - spreadHalf).toFixed(2)));
  const ask = Number((mid + spreadHalf).toFixed(2));
  const entryPrice = side === "BUY" ? ask : bid;

  return {
    id: `${optionType}_${strike}_${side}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    side,
    optionType,
    strike,
    quantity,
    expirationDate,
    dte,
    entryPrice,
    bid,
    ask,
    impliedVolatility: iv,
    delta: bs.delta,
    gamma: bs.gamma,
    theta: bs.theta,
    vega: bs.vega,
    rho: bs.rho,
    vanna: bs.vanna,
    charm: bs.charm,
    vomma: bs.vomma,
  };
}

function makeStockLeg(
  side: "BUY" | "SELL",
  spot: number,
  quantity: number = 100,
  expirationDate: string = "",
  dte: number = 0
): StrategyLegItem {
  return {
    id: `STOCK_${side}_${quantity}`,
    side,
    optionType: "STOCK",
    strike: spot,
    quantity,
    expirationDate,
    dte,
    entryPrice: spot,
    bid: spot - 0.02,
    ask: spot + 0.02,
    impliedVolatility: 0,
    delta: side === "BUY" ? 1 : -1,
    gamma: 0,
    theta: 0,
    vega: 0,
    rho: 0,
    vanna: 0,
    charm: 0,
    vomma: 0,
  };
}

/**
 * Dynamic factor weightings evaluated by the ← Max Return | Max Chance → optimizer.
 */
export function getOptimizationFactors(optimizationBias: number = 50): OptimizationBiasFactors {
  const biasPct = Math.max(0, Math.min(100, optimizationBias));
  const chanceRatio = biasPct / 100; // 0 to 1
  const returnRatio = 1 - chanceRatio; // 1 to 0

  const returnWeight = Math.round(10 + returnRatio * 50); // 10% to 60%
  const chanceWeight = Math.round(10 + chanceRatio * 50); // 10% to 60%
  const safetyWeight = Math.round(10 + chanceRatio * 15); // 10% to 25%
  const capitalWeight = Math.round(10 + returnRatio * 10); // 10% to 20%

  let regime: OptimizationBiasFactors["regime"] = "Balanced EV (Risk-Adjusted)";
  let regimeDescription = "Balancing win-rate probability with risk/reward payoff multiplier.";

  if (biasPct < 35) {
    regime = "Max Return (High Leverage / OTM)";
    regimeDescription =
      "Prioritizing maximum Return-on-Risk (RoR%), leverage, and asymmetric upside multiple at the target price.";
  } else if (biasPct > 65) {
    regime = "Max Chance (High Win-Rate / ITM)";
    regimeDescription =
      "Prioritizing high Probability of Profit (POP > 70%), maximizing breakeven margin of safety and downside buffer.";
  }

  return {
    returnWeight,
    chanceWeight,
    safetyWeight,
    capitalWeight,
    regime,
    regimeDescription,
  };
}

/**
 * Recomputes pricing and Greeks for a single leg when its strike price slider moves in Builder.
 */
export function updateLegStrike(
  leg: StrategyLegItem,
  newStrike: number,
  spot: number,
  dte: number,
  iv: number,
  r: number = 0.04
): StrategyLegItem {
  if (leg.optionType === "STOCK") {
    return { ...leg, strike: spot, entryPrice: spot };
  }
  const t = Math.max(0.5, dte) / 365;
  const bs = blackScholes(spot, newStrike, t, iv, r, 0, leg.optionType);
  const mid = bs.price;
  const spreadHalf = Math.max(0.05, mid * 0.03);
  const bid = Math.max(0.01, Number((mid - spreadHalf).toFixed(2)));
  const ask = Number((mid + spreadHalf).toFixed(2));
  const entryPrice = leg.side === "BUY" ? ask : bid;

  return {
    ...leg,
    strike: newStrike,
    entryPrice,
    bid,
    ask,
    delta: bs.delta,
    gamma: bs.gamma,
    theta: bs.theta,
    vega: bs.vega,
    rho: bs.rho,
    vanna: bs.vanna,
    charm: bs.charm,
    vomma: bs.vomma,
  };
}

/**
 * Recomputes pricing and Greeks for all legs when a different expiration date is selected in Builder.
 */
export function updateLegsExpiration(
  legs: StrategyLegItem[],
  newDte: number,
  newExpirationDate: string,
  spot: number,
  iv: number,
  r: number = 0.04
): StrategyLegItem[] {
  return legs.map((leg) => {
    if (leg.optionType === "STOCK") {
      return { ...leg, expirationDate: newExpirationDate, dte: newDte };
    }
    const t = Math.max(0.5, newDte) / 365;
    const bs = blackScholes(spot, leg.strike, t, iv, r, 0, leg.optionType);
    const mid = bs.price;
    const spreadHalf = Math.max(0.05, mid * 0.03);
    const bid = Math.max(0.01, Number((mid - spreadHalf).toFixed(2)));
    const ask = Number((mid + spreadHalf).toFixed(2));
    const entryPrice = leg.side === "BUY" ? ask : bid;

    return {
      ...leg,
      expirationDate: newExpirationDate,
      dte: newDte,
      entryPrice,
      bid,
      ask,
      delta: bs.delta,
      gamma: bs.gamma,
      theta: bs.theta,
      vega: bs.vega,
      rho: bs.rho,
      vanna: bs.vanna,
      charm: bs.charm,
      vomma: bs.vomma,
    };
  });
}

/**
 * Calculates net Greeks for all active (non-excluded, non-closed) option legs.
 */
export function calculateNetGreeks(
  legs: StrategyLegItem[],
  spot: number,
  dte: number,
  iv: number,
  r: number = 0.04
): NetOptionGreeks {
  let netDelta = 0;
  let netGamma = 0;
  let netTheta = 0;
  let netVega = 0;
  let netRho = 0;
  let netVanna = 0;
  let netCharm = 0;
  let netVomma = 0;
  let sumWeightedIv = 0;
  let totalOptionQty = 0;

  const t = Math.max(0.5, dte) / 365;

  for (const leg of legs) {
    if (leg.isExcluded || leg.isClosed) continue;
    const sign = leg.side === "BUY" ? 1 : -1;
    const qty = leg.quantity;

    if (leg.optionType === "STOCK") {
      netDelta += sign * qty * 1.0;
      continue;
    }

    const vol = leg.impliedVolatility || iv;
    const bs = blackScholes(spot, leg.strike, t, vol, r, 0, leg.optionType);

    netDelta += sign * qty * bs.delta * 100;
    netGamma += sign * qty * bs.gamma * 100;
    netTheta += sign * qty * bs.theta * 100;
    netVega += sign * qty * bs.vega * 100;
    netRho += sign * qty * bs.rho * 100;
    netVanna += sign * qty * bs.vanna * 100;
    netCharm += sign * qty * bs.charm * 100;
    netVomma += sign * qty * bs.vomma * 100;
    totalOptionQty += qty;
    sumWeightedIv += vol * qty;
  }

  const weightedIv = totalOptionQty > 0 ? Number((sumWeightedIv / totalOptionQty).toFixed(4)) : iv;

  return {
    netDelta: Number(netDelta.toFixed(2)),
    netGamma: Number(netGamma.toFixed(4)),
    netTheta: Number(netTheta.toFixed(2)),
    netVega: Number(netVega.toFixed(2)),
    netRho: Number(netRho.toFixed(2)),
    netVanna: Number(netVanna.toFixed(3)),
    netCharm: Number(netCharm.toFixed(3)),
    netVomma: Number(netVomma.toFixed(3)),
    weightedIv,
  };
}

/**
 * Calculates realized profit/loss from closed positions and unrealized profit/loss against custom cost-basis.
 */
export function calculateRealizedAndUnrealizedPnl(
  legs: StrategyLegItem[],
  spot: number,
  dte: number,
  iv: number,
  r: number = 0.04
): RealizedUnrealizedPnl {
  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let hasCustomCostBasis = false;
  let hasClosedPositions = false;

  const t = Math.max(0.5, dte) / 365;

  for (const leg of legs) {
    if (leg.isExcluded) continue;
    const mult = leg.optionType === "STOCK" ? 1 : 100;
    const cost = leg.customCostBasis !== undefined ? leg.customCostBasis : leg.entryPrice;
    if (leg.customCostBasis !== undefined) hasCustomCostBasis = true;

    if (leg.isClosed && leg.closingPrice !== undefined) {
      hasClosedPositions = true;
      const gain = leg.side === "BUY"
        ? (leg.closingPrice - cost) * mult * leg.quantity
        : (cost - leg.closingPrice) * mult * leg.quantity;
      realizedPnl += gain;
      continue;
    }

    // Open position unrealized P&L
    let currentMark = 0;
    if (leg.optionType === "STOCK") {
      currentMark = spot;
    } else {
      const vol = leg.impliedVolatility || iv;
      const bs = blackScholes(spot, leg.strike, t, vol, r, 0, leg.optionType);
      currentMark = bs.price;
    }

    const openGain = leg.side === "BUY"
      ? (currentMark - cost) * mult * leg.quantity
      : (cost - currentMark) * mult * leg.quantity;
    unrealizedPnl += openGain;
  }

  return {
    realizedPnl: Number(realizedPnl.toFixed(2)),
    unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    totalPnl: Number((realizedPnl + unrealizedPnl).toFixed(2)),
    hasCustomCostBasis,
    hasClosedPositions,
  };
}

/**
 * Generates an OptionStrat-grade 2D Profit/Loss Matrix Table across prices and future calendar dates.
 */
export function evaluate2dPayoffMatrix(
  legs: StrategyLegItem[],
  spot: number,
  expirationDte: number,
  expirationDate: string,
  iv: number,
  rangePct: number = 20,
  priceSteps: number = 19,
  dateSteps: number = 7,
  riskOrCollateral: number = 1000,
  r: number = 0.04
): Payoff2dMatrixResult {
  const minPrice = Math.max(1, spot * (1 - rangePct / 100));
  const maxPrice = spot * (1 + rangePct / 100);
  const pStep = (maxPrice - minPrice) / Math.max(1, priceSteps - 1);

  // Generate date columns from Today (t=0 elapsed) to Expiration (t=expirationDte)
  const columns: Matrix2dColumn[] = [];
  const now = new Date();
  const totalDte = Math.max(1, expirationDte);

  for (let c = 0; c < dateSteps; c++) {
    const fraction = c / Math.max(1, dateSteps - 1);
    const dteRemaining = Math.max(0, Math.round(totalDte * (1 - fraction)));
    const daysElapsed = Math.round(totalDte * fraction);
    const targetDay = new Date(now.getTime() + daysElapsed * 86400000);
    const isoDate = targetDay.toISOString().slice(0, 10);
    const monthShort = targetDay.toLocaleString("en-US", { month: "short" });
    const day = targetDay.getDate();

    const isExDiv = c === Math.floor(dateSteps / 2);
    const isEarnings = c === Math.floor(dateSteps * 0.75);

    columns.push({
      dateStr: isoDate,
      label: fraction === 1 ? `Exp (${monthShort} ${day})` : fraction === 0 ? "Today" : `${monthShort} ${day}`,
      dteRemaining,
      isExDiv,
      isEarnings,
    });
  }

  let minPnl = Infinity;
  let maxPnl = -Infinity;
  const rows: Matrix2dRow[] = [];

  // Generate rows sorted from highest price to lowest price
  for (let i = priceSteps - 1; i >= 0; i--) {
    const price = Number((minPrice + i * pStep).toFixed(2));
    const isAtSpot = Math.abs(price - spot) < pStep * 0.6;
    const cells: Matrix2dCell[] = [];

    for (const col of columns) {
      const tYears = col.dteRemaining / 365;
      const pnlDollar = Number(evaluateStrategyPnL(legs, price, tYears, iv, r).toFixed(2));
      const pnlPercent = riskOrCollateral > 0 ? Number(((pnlDollar / riskOrCollateral) * 100).toFixed(1)) : 0;
      const riskPercent = pnlPercent;
      const contractValue = Number(Math.max(0, pnlDollar + riskOrCollateral).toFixed(2));

      if (pnlDollar < minPnl) minPnl = pnlDollar;
      if (pnlDollar > maxPnl) maxPnl = pnlDollar;

      cells.push({
        price,
        dateStr: col.dateStr,
        dteRemaining: col.dteRemaining,
        pnlDollar,
        pnlPercent,
        riskPercent,
        contractValue,
      });
    }

    rows.push({
      price,
      priceLabel: `$${price.toFixed(2)}`,
      isAtSpot,
      cells,
    });
  }

  return {
    columns,
    rows,
    minPnl: isFinite(minPnl) ? minPnl : -100,
    maxPnl: isFinite(maxPnl) ? maxPnl : 100,
  };
}

/**
 * Shifts all option leg strikes simultaneously up or down by N steps (Shift+Drag / Move All Strikes).
 */
export function shiftAllStrikes(
  legs: StrategyLegItem[],
  strikeStepDelta: number,
  spot: number,
  dte: number,
  iv: number,
  r: number = 0.04
): StrategyLegItem[] {
  const ladder = generateStrikeLadder(spot);
  const step = ladder.length > 1 ? Number((ladder[1] - ladder[0]).toFixed(2)) : 1;

  return legs.map((leg) => {
    if (leg.optionType === "STOCK") return leg;
    const currentIdx = ladder.findIndex((k) => Math.abs(k - leg.strike) < step * 0.5);
    const targetIdx = Math.max(0, Math.min(ladder.length - 1, (currentIdx >= 0 ? currentIdx : 0) + strikeStepDelta));
    return updateLegStrike(leg, ladder[targetIdx], spot, dte, iv, r);
  });
}

/**
 * Shifts opposing wings in opposite directions for iron condors, butterflies, and strangles (Symmetric move).
 */
export function shiftSymmetricStrikes(
  legs: StrategyLegItem[],
  spreadWidthDelta: number,
  spot: number,
  dte: number,
  iv: number,
  r: number = 0.04
): StrategyLegItem[] {
  const ladder = generateStrikeLadder(spot);
  const step = ladder.length > 1 ? Number((ladder[1] - ladder[0]).toFixed(2)) : 1;

  return legs.map((leg) => {
    if (leg.optionType === "STOCK") return leg;
    const direction = leg.optionType === "PUT" ? -spreadWidthDelta : spreadWidthDelta;
    const currentIdx = ladder.findIndex((k) => Math.abs(k - leg.strike) < step * 0.5);
    const targetIdx = Math.max(0, Math.min(ladder.length - 1, (currentIdx >= 0 ? currentIdx : 0) + direction));
    return updateLegStrike(leg, ladder[targetIdx], spot, dte, iv, r);
  });
}

/**
 * Derives comprehensive metrics and payoff curves for any set of legs.
 */
export function analyzeStrategy(
  name: string,
  category: string,
  subtitle: string,
  theses: SentimentType[],
  legs: StrategyLegItem[],
  spot: number,
  targetPrice: number,
  dte: number,
  expirationDate: string,
  volatility: number,
  description: string = "",
  optimizationBias: number = 50,
  config?: Partial<StrategyDiscoveryConfig>
): DiscoveredStrategy {
  const r = config?.riskFreeRate ?? 0.04;
  const tExpiryYears = Math.max(0.5, dte) / 365;

  // Generate range of prices for payoff curve (e.g. from spot * 0.2 to spot * 1.8)
  const minPrice = Math.max(0.01, spot * 0.2);
  const maxPrice = spot * 2.0;
  const stepCount = 50;
  const priceStep = (maxPrice - minPrice) / (stepCount - 1);

  const miniPayoffPoints: Array<{ price: number; pnl: number }> = [];
  const breakevens: number[] = [];

  let prevPnl: number | null = null;
  let prevPrice: number | null = null;
  let minPnl = Infinity;
  let maxPnl = -Infinity;

  for (let i = 0; i < stepCount; i++) {
    const p = Number((minPrice + i * priceStep).toFixed(2));
    const pnl = evaluateStrategyPnL(legs, p, 0, volatility);
    miniPayoffPoints.push({ price: p, pnl: Number(pnl.toFixed(2)) });

    if (pnl < minPnl) minPnl = pnl;
    if (pnl > maxPnl) maxPnl = pnl;

    // Detect zero-crossing for breakevens
    if (prevPnl !== null && prevPrice !== null) {
      if ((prevPnl < 0 && pnl >= 0) || (prevPnl >= 0 && pnl < 0)) {
        const be = prevPrice + (0 - prevPnl) * ((p - prevPrice) / (pnl - prevPnl));
        breakevens.push(Number(be.toFixed(2)));
      }
    }
    prevPnl = pnl;
    prevPrice = p;
  }

  // Net debit / credit
  let netCost = 0;
  for (const leg of legs) {
    const mult = leg.optionType === "STOCK" ? 1 : 100;
    const sign = leg.side === "BUY" ? 1 : -1;
    netCost += sign * leg.entryPrice * mult * leg.quantity;
  }
  const netDebit = Number(netCost.toFixed(2));

  // Modeled target profit at targetPrice
  const targetProfit = Number(evaluateStrategyPnL(legs, targetPrice, 0, volatility).toFixed(2));

  const lowPayoff = miniPayoffPoints[0]?.pnl ?? 0;
  const highPayoff = miniPayoffPoints[miniPayoffPoints.length - 1]?.pnl ?? 0;

  // Determine Max Loss & Max Profit using asymptotic exposure
  let netHighSlope = 0;
  for (const leg of legs) {
    if (leg.optionType === "CALL") {
      netHighSlope += (leg.side === "BUY" ? 1 : -1) * leg.quantity * 100;
    } else if (leg.optionType === "STOCK") {
      netHighSlope += (leg.side === "BUY" ? 1 : -1) * leg.quantity;
    }
  }

  const hasUnboundedGain = netHighSlope > 0;
  const hasInfiniteLoss = netHighSlope < 0;

  const maxLoss = hasInfiniteLoss ? null : Math.abs(Math.min(0, minPnl));
  const maxProfit = hasUnboundedGain ? null : Math.max(0, maxPnl);

  // Est Margin / Collateral
  let estMargin = 0;
  const isCreditSpread = netDebit < 0;
  if (hasInfiniteLoss) {
    estMargin = spot * 0.2 * 100; // standard approx for naked options
  } else if (maxLoss !== null) {
    estMargin = Math.max(Math.abs(netDebit), maxLoss);
  }

  // Check specific strategies for collateral conventions
  const hasShortPutOnly = legs.length === 1 && legs[0].optionType === "PUT" && legs[0].side === "SELL";
  const hasCoveredCall = legs.some((l) => l.optionType === "STOCK") && legs.some((l) => l.optionType === "CALL");

  if (hasShortPutOnly) {
    estMargin = legs[0].strike * 100;
  } else if (hasCoveredCall) {
    estMargin = spot * 100;
  }

  // Risk or collateral stat
  const riskOrCollateral = maxLoss !== null && maxLoss > 0 ? maxLoss : estMargin;

  // Returns on risk and collateral
  let returnOnRiskPct: number | null = null;
  let returnOnCollateralPct: number | null = null;

  if (riskOrCollateral > 0) {
    const gainToMeasure = targetProfit > 0 ? targetProfit : (maxProfit ?? 0);
    const ret = (gainToMeasure / riskOrCollateral) * 100;
    if (hasShortPutOnly || hasCoveredCall || isCreditSpread) {
      returnOnCollateralPct = Number(ret.toFixed(1));
    } else {
      returnOnRiskPct = Number(ret.toFixed(0));
    }
  }

  // POP Chance of profit
  const lowProfit = lowPayoff > 0;
  const highProfit = highPayoff > 0;
  const pop = calculateProbabilityOfProfit(spot, breakevens, { lowProfit, highProfit }, tExpiryYears, volatility);
  const chanceOfProfit = Math.round(pop * 100);

  // Breakeven text
  let breakevenText = "None";
  if (breakevens.length === 1) {
    const be = breakevens[0];
    const pctDiff = (((be - spot) / spot) * 100).toFixed(0);
    const sign = Number(pctDiff) >= 0 ? `+${pctDiff}%` : `${pctDiff}%`;
    breakevenText = highProfit ? `Above $${be.toFixed(2)} (${sign})` : `Below $${be.toFixed(2)} (${sign})`;
  } else if (breakevens.length >= 2) {
    breakevenText = breakevens.map((b) => `$${b.toFixed(2)}`).join(" · ");
  }

  // Factors evaluation
  const cushionPct = breakevens.length > 0
    ? Number(((Math.min(...breakevens.map((b) => Math.abs(b - spot))) / spot) * 100).toFixed(1))
    : 0;

  const retVal = returnOnRiskPct ?? returnOnCollateralPct ?? 25;
  const returnScore = Math.min(100, Math.max(5, Math.round((retVal / 250) * 100)));
  const chanceScore = Math.min(100, Math.max(5, chanceOfProfit));
  const cushionScore = Math.min(100, Math.max(5, Math.round(cushionPct * 4)));
  const capitalEfficiencyScore = riskOrCollateral > 0
    ? Math.min(100, Math.max(10, Math.round((targetProfit / Math.max(100, riskOrCollateral)) * 100)))
    : 50;

  const optFactors = getOptimizationFactors(optimizationBias);
  const compositeScore = Math.round(
    (returnScore * optFactors.returnWeight +
      chanceScore * optFactors.chanceWeight +
      cushionScore * optFactors.safetyWeight +
      capitalEfficiencyScore * optFactors.capitalWeight) /
      100
  );

  const factors: StrategyEvaluationFactors = {
    returnScore,
    chanceScore,
    cushionPct,
    cushionScore,
    capitalEfficiencyScore,
    compositeScore,
  };

  const rewardRiskRatio =
    maxLoss !== null && maxLoss > 0 && maxProfit !== null
      ? Number((maxProfit / maxLoss).toFixed(2))
      : null;

  return {
    id: `${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${Date.now()}`,
    name,
    category,
    subtitle,
    theses,
    legs,
    netDebit,
    estMargin: Math.round(estMargin),
    maxProfit: maxProfit !== null ? Number(maxProfit.toFixed(2)) : null,
    maxLoss: maxLoss !== null ? Number(maxLoss.toFixed(2)) : null,
    targetProfit,
    riskOrCollateral: Math.round(riskOrCollateral),
    returnOnRiskPct,
    returnOnCollateralPct,
    rewardRiskRatio,
    chanceOfProfit,
    breakevens,
    breakevenText,
    miniPayoffPoints,
    expirationDate,
    dte,
    description,
    factors,
  };
}
