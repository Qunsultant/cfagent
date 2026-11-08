/**
 * Issue #3673 — TOS-Style Multi-Bracket Ladder & Grid Orders Engine.
 *
 * Implements tiered multi-bracket scale-in / scale-out grid orders
 * (ThinkorSwim 1st Triggers Multi-OCO / Bracket Ladder).
 *
 * Allows submitting a series of bracket orders with fixed or percentage
 * step increments (e.g. $1.00 intervals), where each entry order rung
 * carries its own independent take-profit limit and stop-loss stops,
 * with optional pattern-range bounding and batch lifecycle cancellation.
 */

import type { Env } from "../types";
import { MarketDataResearchService } from "./marketDataResearch";

export interface BracketLadderRung {
  rungIndex: number;
  side: "buy" | "sell";
  limitPrice: number;
  quantity: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  clientOrderId: string;
}

export interface BracketLadderSpec {
  symbol: string;
  side: "buy" | "sell";
  basePrice: number;
  stepIncrement: number;
  tiers: number;
  quantityPerTier?: number;
  quantities?: number[];
  takeProfitDelta: number;
  stopLossDelta: number;
  direction?: "ascending" | "descending";
  timeInForce?: "day" | "gtc";
  extendedHours?: boolean;
  ladderId?: string;
}

export interface BracketLadderValidationResult {
  valid: boolean;
  message?: string;
  refusal?: string;
}

export interface BracketLadderReceipt {
  success: boolean;
  ladderId: string;
  symbol: string;
  side: "buy" | "sell";
  totalQuantity: number;
  tiersRequested: number;
  tiersPlaced: number;
  rungs: Array<{
    rungIndex: number;
    orderId?: string;
    clientOrderId?: string;
    limitPrice: number;
    quantity: number;
    takeProfitPrice: number;
    stopLossPrice: number;
    status: string;
    error?: string;
  }>;
  message: string;
}

export interface CancelBracketLadderSpec {
  ladderId?: string;
  symbol?: string;
  orderIds?: string[];
}

export interface CancelBracketLadderReceipt {
  success: boolean;
  ladderId?: string;
  symbol?: string;
  cancelledCount: number;
  orderIds: string[];
  message: string;
}

function roundToCents(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Validates a bracket ladder specification with fail-closed checks.
 */
export function validateBracketLadderSpec(spec: BracketLadderSpec): BracketLadderValidationResult {
  if (!spec.symbol || typeof spec.symbol !== "string" || spec.symbol.trim().length === 0) {
    return {
      valid: false,
      refusal: "invalid_ladder_parameters",
      message: "Symbol must be a valid non-empty string.",
    };
  }

  if (spec.side !== "buy" && spec.side !== "sell") {
    return {
      valid: false,
      refusal: "invalid_ladder_parameters",
      message: "Side must be 'buy' or 'sell'.",
    };
  }

  if (typeof spec.basePrice !== "number" || isNaN(spec.basePrice) || spec.basePrice <= 0) {
    return {
      valid: false,
      refusal: "invalid_ladder_parameters",
      message: "basePrice must be a positive number.",
    };
  }

  if (typeof spec.stepIncrement !== "number" || isNaN(spec.stepIncrement) || spec.stepIncrement <= 0) {
    return {
      valid: false,
      refusal: "invalid_ladder_parameters",
      message: "stepIncrement must be greater than 0.",
    };
  }

  if (!Number.isInteger(spec.tiers) || spec.tiers < 1 || spec.tiers > 20) {
    return {
      valid: false,
      refusal: "invalid_ladder_parameters",
      message: "tiers must be between 1 and 20.",
    };
  }

  if (typeof spec.takeProfitDelta !== "number" || isNaN(spec.takeProfitDelta) || spec.takeProfitDelta <= 0) {
    return {
      valid: false,
      refusal: "invalid_bracket_parameters",
      message: "takeProfitDelta must be greater than 0.",
    };
  }

  if (typeof spec.stopLossDelta !== "number" || isNaN(spec.stopLossDelta) || spec.stopLossDelta <= 0) {
    return {
      valid: false,
      refusal: "invalid_bracket_parameters",
      message: "stopLossDelta must be greater than 0.",
    };
  }

  if (spec.quantities) {
    if (!Array.isArray(spec.quantities) || spec.quantities.length !== spec.tiers) {
      return {
        valid: false,
        refusal: "invalid_ladder_parameters",
        message: `quantities array length (${spec.quantities?.length}) must match tiers count (${spec.tiers}).`,
      };
    }
    for (const q of spec.quantities) {
      if (typeof q !== "number" || q <= 0) {
        return {
          valid: false,
          refusal: "invalid_ladder_parameters",
          message: "All quantities in quantities array must be positive numbers.",
        };
      }
    }
  } else if (typeof spec.quantityPerTier !== "number" || spec.quantityPerTier <= 0) {
    return {
      valid: false,
      refusal: "invalid_ladder_parameters",
      message: "quantityPerTier must be a positive number.",
    };
  }

  // Pre-calculate rungs to check price boundary sanity
  const dummyId = "check";
  const rungs = generateBracketLadderRungs(spec, dummyId);
  for (const rung of rungs) {
    if (rung.limitPrice <= 0) {
      return {
        valid: false,
        refusal: "invalid_bracket_prices",
        message: `Limit price ($${rung.limitPrice}) on rung ${rung.rungIndex} must be greater than 0.`,
      };
    }
    if (rung.takeProfitPrice <= 0) {
      return {
        valid: false,
        refusal: "invalid_bracket_prices",
        message: `Take-profit price ($${rung.takeProfitPrice}) on rung ${rung.rungIndex} must be greater than 0.`,
      };
    }
    if (rung.stopLossPrice <= 0) {
      return {
        valid: false,
        refusal: "invalid_bracket_prices",
        message: `Stop-loss price ($${rung.stopLossPrice}) on rung ${rung.rungIndex} must be greater than 0.`,
      };
    }

    if (spec.side === "buy") {
      if (rung.takeProfitPrice <= rung.limitPrice || rung.stopLossPrice >= rung.limitPrice) {
        return {
          valid: false,
          refusal: "invalid_bracket_prices",
          message: `On BUY rung ${rung.rungIndex}: take-profit ($${rung.takeProfitPrice}) must be > entry ($${rung.limitPrice}) and stop-loss ($${rung.stopLossPrice}) must be < entry.`,
        };
      }
    } else {
      if (rung.takeProfitPrice >= rung.limitPrice || rung.stopLossPrice <= rung.limitPrice) {
        return {
          valid: false,
          refusal: "invalid_bracket_prices",
          message: `On SELL rung ${rung.rungIndex}: take-profit ($${rung.takeProfitPrice}) must be < entry ($${rung.limitPrice}) and stop-loss ($${rung.stopLossPrice}) must be > entry.`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Pure generator for tiered bracket ladder rungs.
 */
export function generateBracketLadderRungs(
  spec: BracketLadderSpec,
  ladderId: string,
): BracketLadderRung[] {
  const rungs: BracketLadderRung[] = [];
  const direction = spec.direction || "ascending";

  for (let i = 0; i < spec.tiers; i++) {
    const rungIndex = i + 1;
    const priceOffset = i * spec.stepIncrement;
    const limitPrice = roundToCents(
      direction === "ascending"
        ? spec.basePrice + priceOffset
        : spec.basePrice - priceOffset,
    );

    const quantity = spec.quantities ? spec.quantities[i] : (spec.quantityPerTier ?? 1);

    let takeProfitPrice: number;
    let stopLossPrice: number;

    if (spec.side === "buy") {
      takeProfitPrice = roundToCents(limitPrice + spec.takeProfitDelta);
      stopLossPrice = roundToCents(limitPrice - spec.stopLossDelta);
    } else {
      takeProfitPrice = roundToCents(limitPrice - spec.takeProfitDelta);
      stopLossPrice = roundToCents(limitPrice + spec.stopLossDelta);
    }

    rungs.push({
      rungIndex,
      side: spec.side,
      limitPrice,
      quantity,
      takeProfitPrice,
      stopLossPrice,
      clientOrderId: `${ladderId}-r${rungIndex}`,
    });
  }

  return rungs;
}

/**
 * Convenience builder anchoring ladder tiers inside a detected technical pattern range.
 */
export function buildLadderFromPatternRange(params: {
  symbol: string;
  side: "buy" | "sell";
  support: number;
  resistance: number;
  tiers: number;
  quantityPerTier?: number;
  quantities?: number[];
  stopLossPadding?: number;
}): BracketLadderSpec {
  const { symbol, side, support, resistance, tiers, quantityPerTier, quantities } = params;
  const padding = params.stopLossPadding ?? 1.0;

  if (side === "buy") {
    const stepIncrement = roundToCents((resistance - support) / Math.max(1, tiers - 1));
    return {
      symbol,
      side: "buy",
      basePrice: roundToCents(support),
      stepIncrement,
      tiers,
      quantityPerTier,
      quantities,
      takeProfitDelta: stepIncrement,
      stopLossDelta: roundToCents(padding),
      direction: "ascending",
    };
  } else {
    const stepIncrement = roundToCents((resistance - support) / Math.max(1, tiers - 1));
    return {
      symbol,
      side: "sell",
      basePrice: roundToCents(resistance),
      stepIncrement,
      tiers,
      quantityPerTier,
      quantities,
      takeProfitDelta: stepIncrement,
      stopLossDelta: roundToCents(padding),
      direction: "descending",
    };
  }
}

/**
 * Executes a bracket ladder across the active broker via MarketDataResearchService.
 */
export async function executeBracketLadder(
  spec: BracketLadderSpec,
  env: Env,
): Promise<BracketLadderReceipt> {
  const validation = validateBracketLadderSpec(spec);
  const ladderId = spec.ladderId || `lad_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  if (!validation.valid) {
    return {
      success: false,
      ladderId,
      symbol: spec.symbol,
      side: spec.side,
      totalQuantity: 0,
      tiersRequested: spec.tiers,
      tiersPlaced: 0,
      rungs: [],
      message: validation.message || "Invalid bracket ladder specifications.",
    };
  }

  const rungs = generateBracketLadderRungs(spec, ladderId);
  const service = new MarketDataResearchService(env);
  const placedRungs: BracketLadderReceipt["rungs"] = [];
  let totalQuantity = 0;

  for (const rung of rungs) {
    totalQuantity += rung.quantity;
    // Issue #3782: rung prices derive from the user-submitted ladder
    // spec (entry price + tier offsets), so the placement declares
    // user provenance for the guard in placeOrder.
    const orderResult = await service.placeAlpacaOrder({
      symbol: spec.symbol,
      qty: rung.quantity,
      side: rung.side,
      type: "limit",
      limit_price: rung.limitPrice,
      time_in_force: spec.timeInForce || "day",
      extended_hours: spec.extendedHours,
      order_class: "bracket",
      take_profit: { limit_price: rung.takeProfitPrice },
      stop_loss: { stop_price: rung.stopLossPrice },
      priceSource: { kind: "user" },
    });

    if (orderResult.success) {
      placedRungs.push({
        rungIndex: rung.rungIndex,
        orderId: orderResult.orderId,
        clientOrderId: rung.clientOrderId,
        limitPrice: rung.limitPrice,
        quantity: rung.quantity,
        takeProfitPrice: rung.takeProfitPrice,
        stopLossPrice: rung.stopLossPrice,
        status: orderResult.status || "accepted",
      });
    } else {
      placedRungs.push({
        rungIndex: rung.rungIndex,
        clientOrderId: rung.clientOrderId,
        limitPrice: rung.limitPrice,
        quantity: rung.quantity,
        takeProfitPrice: rung.takeProfitPrice,
        stopLossPrice: rung.stopLossPrice,
        status: "failed",
        error: orderResult.message,
      });
    }
  }

  const tiersPlaced = placedRungs.filter((r) => r.status !== "failed").length;

  return {
    success: tiersPlaced > 0,
    ladderId,
    symbol: spec.symbol,
    side: spec.side,
    totalQuantity,
    tiersRequested: spec.tiers,
    tiersPlaced,
    rungs: placedRungs,
    message: `Bracket ladder ${ladderId}: placed ${tiersPlaced} of ${spec.tiers} rungs for ${spec.symbol} ${spec.side.toUpperCase()}.`,
  };
}

/**
 * Cancels multiple orders belonging to a ladder or order ID set.
 */
export async function cancelBracketLadder(
  spec: CancelBracketLadderSpec,
  env: Env,
): Promise<CancelBracketLadderReceipt> {
  const service = new MarketDataResearchService(env);
  const cancelledOrderIds: string[] = [];

  let targetOrderIds: string[] = spec.orderIds ? [...spec.orderIds] : [];

  if (targetOrderIds.length === 0 && (spec.ladderId || spec.symbol)) {
    const openOrdersRes = await service.getAlpacaOrders("open");
    if (openOrdersRes.success && Array.isArray(openOrdersRes.orders)) {
      for (const order of openOrdersRes.orders) {
        const matchesLadder = spec.ladderId && (
          order.client_order_id?.startsWith(spec.ladderId) ||
          order.id === spec.ladderId
        );
        const matchesSymbol = spec.symbol && order.symbol?.toUpperCase() === spec.symbol.toUpperCase();

        if (spec.ladderId && matchesLadder) {
          targetOrderIds.push(order.id);
        } else if (!spec.ladderId && matchesSymbol) {
          targetOrderIds.push(order.id);
        }
      }
    }
  }

  for (const orderId of targetOrderIds) {
    const cancelRes = await service.cancelAlpacaOrder(orderId);
    if (cancelRes.success) {
      cancelledOrderIds.push(orderId);
    }
  }

  return {
    success: cancelledOrderIds.length > 0 || targetOrderIds.length === 0,
    ladderId: spec.ladderId,
    symbol: spec.symbol,
    cancelledCount: cancelledOrderIds.length,
    orderIds: cancelledOrderIds,
    message: `Cancelled ${cancelledOrderIds.length} orders for bracket ladder.`,
  };
}
