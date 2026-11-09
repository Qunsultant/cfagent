/**
 * Issue #3887 — the base-breakout continuation ladder.
 *
 * #3673 shipped a fixed grid: `basePrice`, `stepIncrement`, `tiers`, all
 * placed at once. What a breakout trader actually asks for is different —
 * *place buy brackets progressively as a symbol trends up out of a base,
 * without a human re-issuing rungs*. That is a state machine, not a bigger
 * grid, and this module is it:
 *
 *   detectBase      — is the symbol coiling? (a window whose range and volume
 *                     define "base"; the detector publishes its inputs so a
 *                     refusal can cite them)
 *   planBaseBreakout— the rung plan (prices, sizes, cumulative spend) inside
 *                     the money budget, the tier cap and the order-count cap
 *   BaseBreakoutLadder — the machine: rung 1 on base confirmation, rung N+1
 *                     only after a continuation step, and a named stop when a
 *                     cap or a cancel ends it
 *
 * Nothing here places an order: the caller injects `placeRung`, so the plan is
 * testable without a broker and a dry run is the same code path with a
 * no-op placement.
 *
 * Caps are CONFIGURED (#3888), never literals: an unset `maxRungsPerLadder` or
 * `maxNotionalPerTicker` refuses the plan with `limit_not_configured` instead
 * of running unbounded. `fixedGrid` (#3673) is untouched — this mode is opt-in
 * and defaults away from it.
 */

import type { TradingLimitsSnapshot } from "./limits";
import { formatTradingLimitAmount, tradingLimitEnvVar } from "./limits";

export type BaseBreakoutRefusalCode =
  | "base_not_formed"
  | "budget_exhausted"
  | "order_cap_reached"
  | "tier_cap_reached"
  | "price_below_base"
  | "outside_session"
  | "ladder_cancelled"
  | "rung_place_failed"
  | "limit_not_configured"
  | "invalid_ladder_parameters";

export interface PriceBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BaseDefinition {
  /** How many bars the base window spans. */
  bars: number;
  /** "Coiling": the window's range as a percent of its close must not exceed this. */
  maxRangePercent: number;
  /** The confirmation bar's volume must be at least this multiple of the window average. */
  minVolumeRatio: number;
}

export const DEFAULT_BASE_DEFINITION: BaseDefinition = {
  bars: 20,
  maxRangePercent: 4,
  minVolumeRatio: 1,
};

export interface BaseDetectionInputs {
  bars: number;
  maxRangePercent: number;
  minVolumeRatio: number;
  barCount: number;
  windowHigh: number | null;
  windowLow: number | null;
  rangePercent: number | null;
  averageVolume: number | null;
  confirmationClose: number | null;
  confirmationVolume: number | null;
}

export interface BaseDetection {
  formed: boolean;
  inputs: BaseDetectionInputs;
  code?: BaseBreakoutRefusalCode;
  message: string;
}

function finite(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Detect a base from a bar series: the FIRST `definition.bars` bars are the
 * base window, the next bar is the confirmation. A base is formed when
 *   - the window's high-low range is at most `maxRangePercent` of its close,
 *   - the confirmation closes ABOVE the window high (the breakout), and
 *   - the confirmation's volume is at least `minVolumeRatio` × the window's
 *     average.
 * Every input is returned, so a `base_not_formed` refusal can say exactly
 * which condition failed rather than "no setup".
 */
export function detectBase(
  bars: readonly PriceBar[],
  definition: Partial<BaseDefinition> = {},
): BaseDetection {
  const config: BaseDefinition = {
    bars: finite(definition.bars) ?? DEFAULT_BASE_DEFINITION.bars,
    maxRangePercent: finite(definition.maxRangePercent) ?? DEFAULT_BASE_DEFINITION.maxRangePercent,
    minVolumeRatio: finite(definition.minVolumeRatio) ?? DEFAULT_BASE_DEFINITION.minVolumeRatio,
  };
  const window = bars.slice(0, Math.max(1, Math.floor(config.bars)));
  const confirmation = bars[window.length];
  const inputs: BaseDetectionInputs = {
    bars: config.bars,
    maxRangePercent: config.maxRangePercent,
    minVolumeRatio: config.minVolumeRatio,
    barCount: bars.length,
    windowHigh: null,
    windowLow: null,
    rangePercent: null,
    averageVolume: null,
    confirmationClose: finite(confirmation?.close),
    confirmationVolume: finite(confirmation?.volume),
  };

  if (window.length < 2 || !confirmation) {
    return {
      formed: false,
      inputs,
      code: "base_not_formed",
      message:
        `base_not_formed: a ${config.bars}-bar base needs ${config.bars + 1} bars and the read returned ${bars.length}. ` +
        `No rung was planned.`,
    };
  }

  const highs = window.map((bar) => finite(bar.high));
  const lows = window.map((bar) => finite(bar.low));
  const closes = window.map((bar) => finite(bar.close));
  const volumes = window.map((bar) => finite(bar.volume));
  if (highs.some((value) => value === null) || lows.some((value) => value === null) || closes.some((value) => value === null)) {
    return {
      formed: false,
      inputs,
      code: "base_not_formed",
      message: "base_not_formed: the base window contains a bar without a usable high/low/close, so no base is claimed.",
    };
  }

  const windowHigh = Math.max(...(highs as number[]));
  const windowLow = Math.min(...(lows as number[]));
  const lastClose = (closes as number[])[(closes as number[]).length - 1] as number;
  const rangePercent = lastClose > 0 ? ((windowHigh - windowLow) / lastClose) * 100 : null;
  const volumeValues = volumes.filter((value): value is number => value !== null && value >= 0);
  const averageVolume = volumeValues.length > 0 ? volumeValues.reduce((sum, value) => sum + value, 0) / volumeValues.length : null;
  inputs.windowHigh = windowHigh;
  inputs.windowLow = windowLow;
  inputs.rangePercent = rangePercent;
  inputs.averageVolume = averageVolume;

  const reasons: string[] = [];
  if (rangePercent === null || rangePercent > config.maxRangePercent) {
    reasons.push(
      `the ${config.bars}-bar range is ${rangePercent === null ? "unmeasurable" : `${rangePercent.toFixed(2)}%`} ` +
        `against a ${config.maxRangePercent}% ceiling`,
    );
  }
  if ((finite(confirmation.close) ?? 0) <= windowHigh) {
    reasons.push(`the confirmation bar closed at ${finite(confirmation.close) ?? "no price"}, not above the base high ${windowHigh}`);
  }
  if (
    averageVolume !== null &&
    (finite(confirmation.volume) ?? 0) < config.minVolumeRatio * averageVolume
  ) {
    reasons.push(
      `the confirmation volume ${finite(confirmation.volume) ?? 0} is below ` +
        `${config.minVolumeRatio}× the base average ${Math.round(averageVolume)}`,
    );
  }

  if (reasons.length > 0) {
    return {
      formed: false,
      inputs,
      code: "base_not_formed",
      message: `base_not_formed: ${reasons.join("; ")}. No rung was planned.`,
    };
  }

  return {
    formed: true,
    inputs,
    message:
      `Base formed over ${config.bars} bars (range ${rangePercent?.toFixed(2)}%, ` +
      `high ${windowHigh}, volume ${finite(confirmation.volume) ?? 0} vs average ${Math.round(averageVolume ?? 0)}); ` +
      `confirmation closed at ${finite(confirmation.close)}.`,
  };
}

export interface BaseBreakoutSpec {
  symbol: string;
  side: "buy" | "sell";
  base: BaseDefinition;
  /** Price advance from the last placed rung needed to place the next one. */
  continuationIncrement: number;
  /** Distance between rung prices. */
  stepIncrement: number;
  /** The caller's own tier ceiling; the configured cap can only lower it. */
  tiers: number;
  quantityPerRung: number;
  takeProfitDelta: number;
  stopLossDelta: number;
  /** The caller's money budget; the configured per-ticker cap can only lower it. */
  budget: number;
  /** The caller's own rung ceiling (#3888's maxRungsPerLadder may lower it). */
  maxRungs?: number;
  timeInForce?: "day" | "gtc";
  extendedHours?: boolean;
  ladderId?: string;
}

export interface BaseBreakoutRung {
  rungIndex: number;
  side: "buy" | "sell";
  limitPrice: number;
  quantity: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  notional: number;
  cumulativeNotional: number;
  clientOrderId: string;
}

export interface BaseBreakoutCaps {
  /** The tier ceiling actually applied, and where it came from. */
  tierCap: number;
  tierCapSource: string;
  /** The money budget actually applied, and where it came from. */
  budget: number;
  budgetSource: string;
}

export interface BaseBreakoutPlan {
  /** True when at least one rung fits inside every cap. */
  planable: boolean;
  code?: BaseBreakoutRefusalCode;
  rungs: BaseBreakoutRung[];
  committedNotional: number;
  remainingBudget: number;
  caps: BaseBreakoutCaps | null;
  message: string;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The configured caps, or a refusal when one is unset (#3888: never unbounded). */
export function resolveBaseBreakoutCaps(
  spec: Pick<BaseBreakoutSpec, "tiers" | "maxRungs" | "budget">,
  limits: TradingLimitsSnapshot | undefined,
): { ok: true; caps: BaseBreakoutCaps } | { ok: false; code: BaseBreakoutRefusalCode; message: string } {
  const rungField = limits?.limits.maxRungsPerLadder;
  const notionalField = limits?.limits.maxNotionalPerTicker;

  if (!limits || !rungField || rungField.value === null) {
    return {
      ok: false,
      code: "limit_not_configured",
      message:
        `maxRungsPerLadder is not configured, so a base-breakout ladder was refused rather than run unbounded. ` +
        `Set it in trading:limits or ${tradingLimitEnvVar("maxRungsPerLadder")}.`,
    };
  }
  if (!notionalField || notionalField.value === null) {
    return {
      ok: false,
      code: "limit_not_configured",
      message:
        `maxNotionalPerTicker is not configured, so a base-breakout ladder has no money budget and was refused. ` +
        `Set it in trading:limits or ${tradingLimitEnvVar("maxNotionalPerTicker")}.`,
    };
  }

  const callerTiers = Math.max(1, Math.floor(spec.maxRungs ?? spec.tiers));
  const tierCap = Math.min(callerTiers, rungField.value);
  const budget = Math.min(Math.max(0, spec.budget), notionalField.value);
  return {
    ok: true,
    caps: {
      tierCap,
      tierCapSource:
        callerTiers <= rungField.value ? "caller (within maxRungsPerLadder)" : `maxRungsPerLadder ${rungField.value}`,
      budget,
      budgetSource:
        spec.budget <= notionalField.value ? "caller (within maxNotionalPerTicker)" : `maxNotionalPerTicker ${formatTradingLimitAmount("maxNotionalPerTicker", notionalField.value)}`,
    },
  };
}

/**
 * Build the rung plan from the breakout price. Pure: the same function backs a
 * dry run and a live placement, so a dry run cannot promise a plan the live
 * path would not produce.
 *
 * `breakoutPrice` is the confirmation close (or the base high, whichever the
 * caller uses as the first rung's anchor).
 */
export function planBaseBreakout(
  spec: BaseBreakoutSpec,
  breakoutPrice: number,
  limits: TradingLimitsSnapshot | undefined,
): BaseBreakoutPlan {
  const ladderId = spec.ladderId ?? `bo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const capsResult = resolveBaseBreakoutCaps(spec, limits);
  if (!capsResult.ok) {
    return {
      planable: false,
      code: capsResult.code,
      rungs: [],
      committedNotional: 0,
      remainingBudget: 0,
      caps: null,
      message: capsResult.message,
    };
  }
  const caps = capsResult.caps;

  if (!Number.isFinite(breakoutPrice) || breakoutPrice <= 0) {
    return {
      planable: false,
      code: "invalid_ladder_parameters",
      rungs: [],
      committedNotional: 0,
      remainingBudget: caps.budget,
      caps,
      message: `invalid_ladder_parameters: the breakout price (${breakoutPrice}) is not a usable positive number.`,
    };
  }
  if (!Number.isFinite(spec.continuationIncrement) || spec.continuationIncrement <= 0) {
    return {
      planable: false,
      code: "invalid_ladder_parameters",
      rungs: [],
      committedNotional: 0,
      remainingBudget: caps.budget,
      caps,
      message: "invalid_ladder_parameters: continuationIncrement must be greater than 0.",
    };
  }

  const rungs: BaseBreakoutRung[] = [];
  let committed = 0;
  let stoppedBy: BaseBreakoutRefusalCode | null = null;

  for (let index = 0; index < caps.tierCap; index += 1) {
    const limitPrice = roundToCents(breakoutPrice + index * spec.stepIncrement);
    const quantity = spec.quantityPerRung;
    const notional = roundToCents(limitPrice * quantity);
    if (committed + notional > caps.budget + 1e-9) {
      stoppedBy = "budget_exhausted";
      break;
    }
    const takeProfitPrice =
      spec.side === "buy" ? roundToCents(limitPrice + spec.takeProfitDelta) : roundToCents(limitPrice - spec.takeProfitDelta);
    const stopLossPrice =
      spec.side === "buy" ? roundToCents(limitPrice - spec.stopLossDelta) : roundToCents(limitPrice + spec.stopLossDelta);
    committed = roundToCents(committed + notional);
    rungs.push({
      rungIndex: index + 1,
      side: spec.side,
      limitPrice,
      quantity,
      takeProfitPrice,
      stopLossPrice,
      notional,
      cumulativeNotional: committed,
      clientOrderId: `${ladderId}-r${index + 1}`,
    });
  }

  if (rungs.length === 0) {
    return {
      planable: false,
      code: "budget_exhausted",
      rungs: [],
      committedNotional: 0,
      remainingBudget: caps.budget,
      caps,
      message:
        `budget_exhausted: one rung costs ${formatTradingLimitAmount("maxNotionalPerTicker", roundToCents(breakoutPrice * spec.quantityPerRung))} ` +
        `and the budget is ${formatTradingLimitAmount("maxNotionalPerTicker", caps.budget)} (${caps.budgetSource}). Nothing was planned.`,
    };
  }

  const message = stoppedBy
    ? `Plan: ${rungs.length} rung(s), ${formatTradingLimitAmount("maxNotionalPerTicker", committed)} committed; ` +
      `budget_exhausted at ${formatTradingLimitAmount("maxNotionalPerTicker", caps.budget)} (${caps.budgetSource}).`
    : `Plan: ${rungs.length} rung(s), ${formatTradingLimitAmount("maxNotionalPerTicker", committed)} committed ` +
      `(budget ${formatTradingLimitAmount("maxNotionalPerTicker", caps.budget)}, ${caps.budgetSource}; tier cap ${caps.tierCap}, ${caps.tierCapSource}).`;

  return {
    planable: true,
    ...(stoppedBy ? { code: stoppedBy } : {}),
    rungs,
    committedNotional: committed,
    remainingBudget: roundToCents(caps.budget - committed),
    caps,
    message,
  };
}

/** One observation of the market, as the driver sees it. */
export interface LadderStep {
  /** ISO instant of the observation (recorded; never used as a timer). */
  at: string;
  /** The price the driver observed. */
  price: number;
  /** Minutes after midnight ET, when the driver knows the clock. */
  minuteEt?: number;
}

export interface LadderDecision {
  action: "place" | "hold" | "stop";
  rung?: BaseBreakoutRung;
  code?: BaseBreakoutRefusalCode;
  message: string;
  rungsPlaced: number;
  committedNotional: number;
  remainingBudget: number;
}

export interface BaseBreakoutDeps {
  /** Places one rung. A dry run passes a no-op that reports success. */
  placeRung: (rung: BaseBreakoutRung) => Promise<{ success: boolean; orderId?: string; message?: string }>;
  /** True once the ladder's orders were cancelled (#3884/#3886). */
  isLadderCancelled?: () => boolean | Promise<boolean>;
  /** Live orders for the symbol, for the order-count cap. */
  openOrdersForTicker?: () => number | Promise<number>;
}

export interface BaseBreakoutSessionWindow {
  startMinuteEt: number;
  endMinuteEt: number;
  extendedHours: boolean;
}

function inWindow(step: LadderStep, window: BaseBreakoutSessionWindow | undefined): boolean {
  if (!window || window.extendedHours) return true;
  if (step.minuteEt === undefined) return true;
  return step.minuteEt >= window.startMinuteEt && step.minuteEt <= window.endMinuteEt;
}

/**
 * The continuation machine.
 *
 * rung 1 is placed on the FIRST step whose price is above the base high (the
 * confirmation the detector already validated). rung N+1 is placed only on a
 * step whose price has advanced `continuationIncrement` beyond the last placed
 * rung. There is no timer: a step that does not advance the price returns
 * `hold` and places nothing.
 *
 * Stops are named, not implied: the money budget (`budget_exhausted`), the
 * configured live-order ceiling (`order_cap_reached`), the tier cap
 * (`tier_cap_reached`), a cancelled ladder (`ladder_cancelled`), a price back
 * under the base (`price_below_base`) and a session window
 * (`outside_session`).
 */
export class BaseBreakoutLadder {
  private readonly placed: BaseBreakoutRung[] = [];
  private lastPlacedPrice: number | null = null;
  private stopped: { code: BaseBreakoutRefusalCode; message: string } | null = null;
  private readonly pending: BaseBreakoutRung[];

  constructor(
    private readonly spec: BaseBreakoutSpec,
    private readonly plan: BaseBreakoutPlan,
    private readonly detection: BaseDetection,
    private readonly deps: BaseBreakoutDeps,
    private readonly sessionWindow?: BaseBreakoutSessionWindow,
    private readonly maxOpenOrders?: number | null,
    preplaced: readonly BaseBreakoutRung[] = [],
  ) {
    this.pending = [...plan.rungs];
    // Issue #3887: a resumed ladder keeps the rungs the broker already took,
    // so the continuation threshold and the budget start where they ended.
    for (const rung of preplaced) {
      this.placed.push(rung);
      this.lastPlacedPrice = rung.limitPrice;
    }
  }

  /** Rebuild a ladder from persisted state (same plan, same placed rungs). */
  static resume(
    spec: BaseBreakoutSpec,
    plan: BaseBreakoutPlan,
    detection: BaseDetection,
    deps: BaseBreakoutDeps,
    preplaced: readonly BaseBreakoutRung[],
    sessionWindow?: BaseBreakoutSessionWindow,
    maxOpenOrders?: number | null,
  ): BaseBreakoutLadder {
    return new BaseBreakoutLadder(spec, plan, detection, deps, sessionWindow, maxOpenOrders, preplaced);
  }

  get placedRungs(): readonly BaseBreakoutRung[] {
    return this.placed;
  }

  get committedNotional(): number {
    return roundToCents(this.placed.reduce((sum, rung) => sum + rung.notional, 0));
  }

  get remainingBudget(): number {
    return this.plan.caps ? roundToCents(this.plan.caps.budget - this.committedNotional) : 0;
  }

  /** The base the plan was built from — published so a refusal can cite it. */
  get detectionInputs(): BaseDetectionInputs {
    return this.detection.inputs;
  }

  private decision(action: LadderDecision["action"], message: string, code?: BaseBreakoutRefusalCode, rung?: BaseBreakoutRung): LadderDecision {
    return {
      action,
      ...(rung ? { rung } : {}),
      ...(code ? { code } : {}),
      message,
      rungsPlaced: this.placed.length,
      committedNotional: this.committedNotional,
      remainingBudget: this.remainingBudget,
    };
  }

  private stopWith(code: BaseBreakoutRefusalCode, message: string): LadderDecision {
    this.stopped = { code, message };
    return this.decision("stop", message, code);
  }

  async next(step: LadderStep): Promise<LadderDecision> {
    if (this.stopped) {
      return this.decision("stop", this.stopped.message, this.stopped.code);
    }
    if (!this.plan.planable) {
      return this.stopWith(this.plan.code ?? "invalid_ladder_parameters", this.plan.message);
    }
    if (!this.detection.formed) {
      return this.stopWith("base_not_formed", this.detection.message);
    }

    if (this.deps.isLadderCancelled && (await this.deps.isLadderCancelled())) {
      return this.stopWith(
        "ladder_cancelled",
        `ladder_cancelled: ${this.plan.rungs[0]?.clientOrderId.split("-r")[0] ?? "the ladder"} was cancelled, so no further rung is placed.`,
      );
    }

    if (!inWindow(step, this.sessionWindow)) {
      return this.decision(
        "hold",
        `outside_session: ${step.at} is outside the ${this.sessionWindow?.startMinuteEt}–${this.sessionWindow?.endMinuteEt} minute ET window and extendedHours is not set. No rung placed.`,
        "outside_session",
      );
    }

    if (!Number.isFinite(step.price) || step.price <= 0) {
      return this.decision("hold", `A step without a usable price (${step.price}) places nothing.`);
    }

    const baseHigh = this.detection.inputs.windowHigh;
    const baseLow = this.detection.inputs.windowLow;

    if (this.placed.length === 0) {
      if (baseHigh === null || step.price <= baseHigh) {
        return this.decision(
          "hold",
          `base_not_formed: the price ${step.price} has not cleared the base high ${baseHigh ?? "unknown"}, so rung 1 waits.`,
          "base_not_formed",
        );
      }
      return this.placeNext("base confirmation cleared");
    }

    if (baseLow !== null && step.price < baseLow) {
      return this.stopWith(
        "price_below_base",
        `price_below_base: the price ${step.price} fell under the base low ${baseLow}; the continuation is void and no further rung is placed.`,
      );
    }

    if (this.placed.length >= (this.plan.caps?.tierCap ?? this.spec.tiers)) {
      return this.stopWith(
        "tier_cap_reached",
        `tier_cap_reached: ${this.placed.length} rungs placed, the tier cap is ${this.plan.caps?.tierCap} (${this.plan.caps?.tierCapSource}).`,
      );
    }

    const threshold = roundToCents((this.lastPlacedPrice ?? 0) + this.spec.continuationIncrement);
    if (step.price < threshold) {
      return this.decision(
        "hold",
        `Continuation waits: ${step.price} has not advanced to ${threshold} (` +
          `${this.spec.continuationIncrement} above the last rung at ${this.lastPlacedPrice}). No rung placed.`,
      );
    }

    return this.placeNext(`continuation cleared ${threshold}`);
  }

  private async placeNext(reason: string): Promise<LadderDecision> {
    const rung = this.pending[this.placed.length];
    if (!rung) {
      // The plan ended. WHY matters: a plan truncated by the money budget is a
      // budget stop, not a tier stop, and the receipt must say which.
      if (this.plan.code === "budget_exhausted") {
        return this.stopWith("budget_exhausted", this.plan.message);
      }
      return this.stopWith(
        "tier_cap_reached",
        `tier_cap_reached: the plan has no rung ${this.placed.length + 1} (${this.plan.caps?.tierCap} planned).`,
      );
    }

    if (this.plan.caps && rung.notional > this.remainingBudget + 1e-9) {
      return this.stopWith(
        "budget_exhausted",
        `budget_exhausted: rung ${rung.rungIndex} costs ${formatTradingLimitAmount("maxNotionalPerTicker", rung.notional)} ` +
          `and ${formatTradingLimitAmount("maxNotionalPerTicker", this.remainingBudget)} of the ` +
          `${formatTradingLimitAmount("maxNotionalPerTicker", this.plan.caps.budget)} budget remains (${this.plan.caps.budgetSource}).`,
      );
    }

    const liveOrders = this.deps.openOrdersForTicker ? await this.deps.openOrdersForTicker() : null;
    if (
      this.maxOpenOrders !== null &&
      this.maxOpenOrders !== undefined &&
      liveOrders !== null &&
      liveOrders >= this.maxOpenOrders
    ) {
      return this.stopWith(
        "order_cap_reached",
        `order_cap_reached: ${this.maxOpenOrders} live orders already exist for ${this.spec.symbol} (maxOpenOrdersPerTicker), ` +
          `so rung ${rung.rungIndex} was not placed.`,
      );
    }

    const placedResult = await this.deps.placeRung(rung);
    if (!placedResult.success) {
      // A rung that fails to place does not strand the ladder: the plan's
      // remaining rungs stay available and the receipt reports the gap.
      return this.decision(
        "hold",
        `rung_place_failed: rung ${rung.rungIndex} was not placed (${placedResult.message ?? "the broker returned no reason"}); ` +
          `${this.placed.length} rung(s) remain placed and the plan continues.`,
        "rung_place_failed",
      );
    }

    this.placed.push(rung);
    this.lastPlacedPrice = rung.limitPrice;
    return this.decision(
      "place",
      `Placed rung ${rung.rungIndex} at ${rung.limitPrice} (${reason}); ` +
        `${formatTradingLimitAmount("maxNotionalPerTicker", this.committedNotional)} committed, ` +
        `${formatTradingLimitAmount("maxNotionalPerTicker", this.remainingBudget)} left.`,
      undefined,
      rung,
    );
  }
}
