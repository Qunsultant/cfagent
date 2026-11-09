/**
 * Issue #3892 — every advanced/complex order type behind ONE declarative
 * registry.
 *
 * The platform's order path grew type by type: basic types in `placeOrder`,
 * brackets as `order_class`, percent exits in #3812, the ladder in #3673,
 * multi-leg options in #3329. Each addition taught its own callers its own
 * rules, so a tool schema, a validator and the copilot's enumeration could
 * disagree about what is possible.
 *
 * This module is the single table they all read:
 *   - what each type NEEDS (required params, mutual exclusions, allowed TIF),
 *   - which broker supports it (`native` / `emulated` / `none`),
 *   - the exact refusal code when it does not.
 *
 * "No silent downgrade" is the rule: a request that cannot be honoured refuses
 * with `order_type_unsupported (trailing_stop @ etrade; supported: market,
 * limit, …)` — it never lands as a simpler order that happens to be placeable.
 *
 * The builders here (named option strategies, protective exits, scale-outs)
 * are deterministic: they produce the legs/orders a caller then submits, so a
 * test can assert the exact strikes, ratios and quantities without a broker.
 */

export type AdvancedBrokerId = "alpaca" | "etrade";
export type AdvancedSupport = "native" | "emulated" | "none";

export type AdvancedOrderTypeId =
  | "market"
  | "limit"
  | "stop"
  | "stop_limit"
  | "bracket"
  | "oco"
  | "oto"
  | "trailing_stop"
  | "trailing_stop_limit"
  | "notional"
  | "gtd"
  | "session_timed"
  | "mleg"
  | "vertical"
  | "straddle"
  | "strangle"
  | "condor"
  | "butterfly"
  | "calendar"
  | "covered_call"
  | "cash_secured_put"
  | "protective_exit"
  | "scale_out"
  | "replace";

export interface AdvancedOrderType {
  id: AdvancedOrderTypeId;
  label: string;
  /** Per-broker support. `none` is a named refusal, never a downgrade. */
  broker: Record<AdvancedBrokerId, AdvancedSupport>;
  /** Parameter names the request must carry. */
  requires: readonly string[];
  /** Parameter groups where at most one member may be present. */
  excludes: ReadonlyArray<readonly string[]>;
  /** Allowed time-in-force values, when the type constrains them. */
  tif?: readonly string[];
  /** The refusal code when this type is unsupported at the target broker. */
  refusalCode: string;
  notes?: string;
}

const BASIC: AdvancedOrderType[] = [
  {
    id: "market",
    label: "Market",
    broker: { alpaca: "native", etrade: "native" },
    requires: [],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "limit",
    label: "Limit",
    broker: { alpaca: "native", etrade: "native" },
    requires: ["limit_price"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "stop",
    label: "Stop",
    broker: { alpaca: "native", etrade: "native" },
    requires: ["stop_price"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "stop_limit",
    label: "Stop limit",
    broker: { alpaca: "native", etrade: "native" },
    requires: ["stop_price", "limit_price"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
];

const COMPOUND: AdvancedOrderType[] = [
  {
    id: "bracket",
    label: "Bracket (entry + take-profit + stop-loss)",
    broker: { alpaca: "native", etrade: "native" },
    requires: ["take_profit", "stop_loss"],
    excludes: [["qty", "notional"]],
    // Issue #3839: a bracket is day-only on both brokers.
    tif: ["day"],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "oco",
    label: "OCO (one cancels the other)",
    broker: { alpaca: "native", etrade: "emulated" },
    requires: ["take_profit", "stop_loss"],
    excludes: [],
    refusalCode: "order_type_unsupported",
    notes: "E*TRADE emulates OCO with two linked exits; the platform submits them as one bracket exit pair.",
  },
  {
    id: "oto",
    label: "OTO (one triggers the other)",
    broker: { alpaca: "native", etrade: "native" },
    requires: ["take_profit"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
];

const ADVANCED: AdvancedOrderType[] = [
  {
    id: "trailing_stop",
    label: "Trailing stop",
    broker: { alpaca: "native", etrade: "none" },
    requires: [],
    excludes: [["trail_price", "trail_percent"], ["qty", "notional"]],
    refusalCode: "order_type_unsupported",
    notes: "Native on Alpaca via trail_price / trail_percent.",
  },
  {
    id: "trailing_stop_limit",
    label: "Trailing stop limit",
    broker: { alpaca: "native", etrade: "none" },
    requires: ["limit_price"],
    excludes: [["trail_price", "trail_percent"]],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "notional",
    label: "Notional / fractional sizing",
    broker: { alpaca: "native", etrade: "none" },
    requires: ["notional"],
    excludes: [["qty", "notional"]],
    refusalCode: "order_type_unsupported",
    notes: "Alpaca accepts `notional` instead of `qty` when the account has fractional trading.",
  },
  {
    id: "gtd",
    label: "Good-till-date",
    broker: { alpaca: "native", etrade: "native" },
    requires: ["good_till_date"],
    excludes: [],
    tif: ["gtc", "gtd"],
    refusalCode: "order_tif_unsupported",
  },
  {
    id: "session_timed",
    label: "Session-timed (MOO/MOC/LOO/LOC)",
    broker: { alpaca: "none", etrade: "none" },
    requires: ["time_in_force"],
    excludes: [],
    tif: ["opg", "cls"],
    refusalCode: "order_type_unsupported",
    notes: "No configured broker exposes exchange-native MOO/MOC/LOO/LOC here; refused by name, not emulated.",
  },
  {
    id: "mleg",
    label: "Multi-leg option order",
    broker: { alpaca: "native", etrade: "native" },
    requires: ["legs"],
    excludes: [],
    tif: ["day", "gtc"],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "vertical",
    label: "Vertical spread",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["optionType", "strikes", "expiry"],
    excludes: [],
    refusalCode: "order_type_unsupported",
    notes: "Built by buildNamedOptionStrategy, then submitted as one mleg.",
  },
  {
    id: "straddle",
    label: "Straddle",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["strikes", "expiry"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "strangle",
    label: "Strangle",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["strikes", "expiry"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "condor",
    label: "Condor",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["strikes", "expiry"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "butterfly",
    label: "Butterfly",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["strikes", "expiry"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "calendar",
    label: "Calendar spread",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["strikes", "expiry", "longExpiry"],
    excludes: [],
    refusalCode: "order_type_unsupported",
  },
  {
    id: "covered_call",
    label: "Covered call",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["shares", "contracts", "strike", "expiry"],
    excludes: [],
    refusalCode: "covered_call_shares_missing",
    notes: "Refuses when the account does not hold the shares (no naked-call downgrade).",
  },
  {
    id: "cash_secured_put",
    label: "Cash-secured put",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["buyingPower", "strike", "contracts", "expiry"],
    excludes: [],
    refusalCode: "cash_secured_put_collateral_short",
    notes: "Refuses when buying power < strike × 100 × contracts.",
  },
  {
    id: "protective_exit",
    label: "Protective exit on an existing position",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["position"],
    excludes: [["stop_price", "trail_percent"]],
    refusalCode: "protective_exit_without_shares",
  },
  {
    id: "scale_out",
    label: "Multi-rung scale-out",
    broker: { alpaca: "emulated", etrade: "emulated" },
    requires: ["qty", "targets"],
    excludes: [],
    refusalCode: "scale_out_exceeds_position",
  },
  {
    id: "replace",
    label: "Replace / modify",
    broker: { alpaca: "native", etrade: "none" },
    requires: ["orderId"],
    excludes: [],
    refusalCode: "replace_not_supported",
    notes: "PATCH /v2/orders/{id} on Alpaca; a compound parent is refused rather than detached from its legs.",
  },
];

/** The whole table. Schema, validation and refusals read THIS. */
export const ADVANCED_ORDER_TYPES: readonly AdvancedOrderType[] = [...BASIC, ...COMPOUND, ...ADVANCED];

export function advancedOrderType(id: string): AdvancedOrderType | null {
  return ADVANCED_ORDER_TYPES.find((entry) => entry.id === id) ?? null;
}

export interface AdvancedOrderCatalog {
  broker: AdvancedBrokerId;
  available: Array<{ id: AdvancedOrderTypeId; label: string; support: "native" | "emulated"; tif?: readonly string[] }>;
  refused: Array<{ id: AdvancedOrderTypeId; label: string; code: string; reason: string }>;
}

/** What a broker can and cannot do — the copilot's enumeration (#3892/#3889). */
export function describeAdvancedOrderTypes(broker: AdvancedBrokerId): AdvancedOrderCatalog {
  const available: AdvancedOrderCatalog["available"] = [];
  const refused: AdvancedOrderCatalog["refused"] = [];
  for (const entry of ADVANCED_ORDER_TYPES) {
    const support = entry.broker[broker];
    if (support === "none") {
      refused.push({
        id: entry.id,
        label: entry.label,
        code: entry.refusalCode,
        reason: `${entry.label} is not available on ${broker}.`,
      });
      continue;
    }
    available.push({
      id: entry.id,
      label: entry.label,
      support,
      ...(entry.tif ? { tif: entry.tif } : {}),
    });
  }
  return { broker, available, refused };
}

export type AdvancedOrderRefusalCode =
  | "order_type_unknown"
  | "order_type_unsupported"
  | "order_tif_unsupported"
  | "missing_order_parameter"
  | "conflicting_order_parameters"
  | "replace_parent_unsupported"
  | "replace_not_supported"
  | "covered_call_shares_missing"
  | "cash_secured_put_collateral_short"
  | "protective_exit_without_shares"
  | "scale_out_exceeds_position";

export interface AdvancedOrderRequest {
  type: string;
  broker: AdvancedBrokerId;
  params?: Record<string, unknown>;
}

export type AdvancedOrderValidation =
  | { ok: true; type: AdvancedOrderType; support: "native" | "emulated" }
  | { ok: false; code: AdvancedOrderRefusalCode; message: string; supported: AdvancedOrderTypeId[] };

function has(params: Record<string, unknown>, key: string): boolean {
  const value = params[key];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Validate one advanced-order request against the registry. The refusal names
 * the supported set, so "cannot be honoured" is actionable rather than vague.
 */
export function validateAdvancedOrder(request: AdvancedOrderRequest): AdvancedOrderValidation {
  const entry = advancedOrderType(String(request.type ?? ""));
  if (!entry) {
    return {
      ok: false,
      code: "order_type_unknown",
      message: `Unknown order type '${String(request.type)}'. Known: ${ADVANCED_ORDER_TYPES.map((candidate) => candidate.id).join(", ")}.`,
      supported: ADVANCED_ORDER_TYPES.map((candidate) => candidate.id),
    };
  }

  const support = entry.broker[request.broker];
  if (support === "none") {
    const supportedHere = ADVANCED_ORDER_TYPES.filter((candidate) => candidate.broker[request.broker] !== "none").map(
      (candidate) => candidate.id,
    );
    return {
      ok: false,
      code: (entry.refusalCode as AdvancedOrderRefusalCode) ?? "order_type_unsupported",
      message: `${entry.refusalCode} (${entry.id} @ ${request.broker}; supported: ${supportedHere.join(", ")})`,
      supported: supportedHere,
    };
  }

  const params = request.params ?? {};
  for (const required of entry.requires) {
    if (!has(params, required)) {
      return {
        ok: false,
        code: "missing_order_parameter",
        message: `${entry.id} needs '${required}' and the request did not carry it. Nothing was placed.`,
        supported: [entry.id],
      };
    }
  }

  for (const group of entry.excludes) {
    const present = group.filter((key) => has(params, key));
    if (present.length > 1) {
      return {
        ok: false,
        code: "conflicting_order_parameters",
        message: `${entry.id} accepts only one of ${group.join(" / ")}; the request carried ${present.join(" and ")}. Nothing was placed.`,
        supported: [entry.id],
      };
    }
  }

  const tif = params.time_in_force;
  if (entry.tif && tif !== undefined && tif !== null) {
    if (!entry.tif.includes(String(tif))) {
      return {
        ok: false,
        code: "order_tif_unsupported",
        message: `${entry.id} is ${entry.tif.join("/")}-only; '${String(tif)}' was requested. Nothing was placed.`,
        supported: [entry.id],
      };
    }
  }

  if (entry.id === "gtd" && !has(params, "good_till_date")) {
    return {
      ok: false,
      code: "missing_order_parameter",
      message: "gtd needs 'good_till_date' and the request did not carry it. Nothing was placed.",
      supported: [entry.id],
    };
  }

  return { ok: true, type: entry, support };
}

/* ------------------------------------------------------------------ options */

export type NamedOptionStrategy = "vertical" | "straddle" | "strangle" | "condor" | "butterfly" | "calendar";

export interface OptionLegSpec {
  action: "buy" | "sell";
  optionType: "call" | "put";
  strike: number;
  expiry: string;
  ratio: number;
}

export interface NamedStrategyParams {
  underlying: string;
  /** Leg expiry (the near month for a calendar). */
  expiry: string;
  /** Strikes in ascending order; how many are needed depends on the strategy. */
  strikes: number[];
  /** Calendar only: the far-month expiry. */
  longExpiry?: string;
  /** Vertical only: call or put. */
  optionType?: "call" | "put";
}

export type NamedStrategyResult =
  | { ok: true; strategy: NamedOptionStrategy; underlying: string; legs: OptionLegSpec[] }
  | { ok: false; code: AdvancedOrderRefusalCode | "invalid_strategy_parameters"; message: string };

/**
 * Compose the legs for a named strategy. The result is submitted as ONE mleg
 * order, so the strategy's identity survives to the broker instead of arriving
 * as unrelated single-leg orders.
 */
export function buildNamedOptionStrategy(
  strategy: NamedOptionStrategy,
  params: NamedStrategyParams,
): NamedStrategyResult {
  const strikes = [...(params.strikes ?? [])].map(Number);
  const expiry = String(params.expiry ?? "").trim();
  const underlying = String(params.underlying ?? "").trim().toUpperCase();
  const fail = (message: string, code: NamedStrategyResult extends { ok: false; code: infer C } ? C : never = "invalid_strategy_parameters" as never) => ({
    ok: false as const,
    code,
    message,
  });

  if (!underlying) return fail("A named strategy needs an underlying symbol.");
  if (!expiry) return fail("A named strategy needs an expiry.");

  const leg = (action: "buy" | "sell", optionType: "call" | "put", strike: number, legExpiry = expiry, ratio = 1): OptionLegSpec => ({
    action,
    optionType,
    strike,
    expiry: legExpiry,
    ratio,
  });

  switch (strategy) {
    case "vertical": {
      if (strikes.length !== 2) return fail("A vertical needs exactly two strikes (buy the first, sell the second).");
      const optionType = params.optionType ?? "call";
      return { ok: true, strategy, underlying, legs: [leg("buy", optionType, strikes[0]), leg("sell", optionType, strikes[1])] };
    }
    case "straddle": {
      if (strikes.length !== 1) return fail("A straddle needs exactly one strike.");
      return { ok: true, strategy, underlying, legs: [leg("buy", "call", strikes[0]), leg("buy", "put", strikes[0])] };
    }
    case "strangle": {
      if (strikes.length !== 2) return fail("A strangle needs exactly two strikes (put below, call above).");
      return { ok: true, strategy, underlying, legs: [leg("buy", "put", strikes[0]), leg("buy", "call", strikes[1])] };
    }
    case "condor": {
      if (strikes.length !== 4) return fail("A condor needs four strikes (long put, short put, short call, long call).");
      return {
        ok: true,
        strategy,
        underlying,
        legs: [
          leg("buy", "put", strikes[0]),
          leg("sell", "put", strikes[1]),
          leg("sell", "call", strikes[2]),
          leg("buy", "call", strikes[3]),
        ],
      };
    }
    case "butterfly": {
      if (strikes.length !== 3) return fail("A butterfly needs three strikes (buy the wings, sell two bodies).");
      return {
        ok: true,
        strategy,
        underlying,
        legs: [leg("buy", "call", strikes[0]), leg("sell", "call", strikes[1], expiry, 2), leg("buy", "call", strikes[2])],
      };
    }
    case "calendar": {
      if (strikes.length !== 1) return fail("A calendar needs exactly one strike.");
      const longExpiry = String(params.longExpiry ?? "").trim();
      if (!longExpiry) return fail("A calendar needs 'longExpiry' (the far month).");
      if (longExpiry === expiry) return fail("A calendar's two expiries must differ.");
      return {
        ok: true,
        strategy,
        underlying,
        legs: [leg("sell", "call", strikes[0], expiry), leg("buy", "call", strikes[0], longExpiry)],
      };
    }
    default:
      return fail(`Unknown named strategy '${String(strategy)}'.`);
  }
}

/* ------------------------------------------------------- collateral checks */

export type CollateralCheck =
  | { ok: true; coveredContracts: number; requiredCollateral?: number }
  | { ok: false; code: AdvancedOrderRefusalCode; message: string };

/** A covered call must actually be covered — no naked-call downgrade. */
export function validateCoveredCall(input: { shares: number; contracts: number; strike: number }): CollateralCheck {
  const shares = Number(input.shares);
  const contracts = Number(input.contracts);
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(contracts) || contracts <= 0) {
    return {
      ok: false,
      code: "covered_call_shares_missing",
      message: `covered_call needs held shares: ${Number.isFinite(shares) ? shares : 0} shares cover 0 contracts. Nothing was placed.`,
    };
  }
  const covered = Math.floor(shares / 100);
  if (covered < contracts) {
    return {
      ok: false,
      code: "covered_call_shares_missing",
      message:
        `covered_call refused: ${contracts} contract(s) need ${contracts * 100} shares and the account holds ${shares} ` +
        `(${covered} covered). Nothing was placed.`,
    };
  }
  return { ok: true, coveredContracts: covered };
}

/** A cash-secured put must be fully cash secured. */
export function validateCashSecuredPut(input: { buyingPower: number; strike: number; contracts: number }): CollateralCheck {
  const buyingPower = Number(input.buyingPower);
  const strike = Number(input.strike);
  const contracts = Number(input.contracts);
  if (!Number.isFinite(buyingPower) || !Number.isFinite(strike) || !Number.isFinite(contracts) || strike <= 0 || contracts <= 0) {
    return {
      ok: false,
      code: "cash_secured_put_collateral_short",
      message: "cash_secured_put needs a positive buying power, strike and contract count. Nothing was placed.",
    };
  }
  const required = strike * 100 * contracts;
  if (buyingPower < required) {
    return {
      ok: false,
      code: "cash_secured_put_collateral_short",
      message:
        `cash_secured_put refused: ${contracts} contract(s) at ${strike} need $${required.toLocaleString("en-US")} of cash and ` +
        `buying power is $${buyingPower.toLocaleString("en-US")}. Nothing was placed.`,
    };
  }
  return { ok: true, coveredContracts: contracts, requiredCollateral: required };
}

/* --------------------------------------------------------- protective exits */

export interface ProtectiveExitOrder {
  symbol: string;
  side: "sell";
  type: "stop" | "stop_limit" | "trailing_stop";
  qty: number;
  stop_price?: number;
  limit_price?: number;
  trail_percent?: number;
  time_in_force: "gtc" | "day";
}

export type ProtectiveExitResult =
  | { ok: true; order: ProtectiveExitOrder }
  | { ok: false; code: AdvancedOrderRefusalCode | "invalid_protective_exit"; message: string };

/**
 * Attach a stop to an existing long position: the quantity is the position's
 * own, so a protective exit can never open a short by accident.
 */
export function protectiveExitForPosition(
  position: { symbol: string; quantity: number; averageEntryPrice?: number | null },
  options: { percent?: number; stopPrice?: number; trailPercent?: number; timeInForce?: "gtc" | "day" } = {},
): ProtectiveExitResult {
  const symbol = String(position.symbol ?? "").trim().toUpperCase();
  const quantity = Number(position.quantity);
  if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
    return {
      ok: false,
      code: "protective_exit_without_shares",
      message: `protective_exit refused: ${symbol || "that symbol"} holds ${Number.isFinite(quantity) ? quantity : 0} shares, so there is nothing to protect.`,
    };
  }

  const timeInForce = options.timeInForce ?? "gtc";
  if (options.trailPercent !== undefined) {
    return {
      ok: true,
      order: { symbol, side: "sell", type: "trailing_stop", qty: quantity, trail_percent: Number(options.trailPercent), time_in_force: timeInForce },
    };
  }

  const entry = Number(position.averageEntryPrice ?? 0);
  let stopPrice = options.stopPrice !== undefined ? Number(options.stopPrice) : undefined;
  if (stopPrice === undefined) {
    const percent = Number(options.percent);
    if (!Number.isFinite(percent) || percent <= 0 || entry <= 0) {
      return {
        ok: false,
        code: "invalid_protective_exit",
        message:
          "protective_exit needs a stopPrice, or a percent with the position's average entry price to compute one. Nothing was placed.",
      };
    }
    stopPrice = Math.round(entry * (1 - percent / 100) * 100) / 100;
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return { ok: false, code: "invalid_protective_exit", message: `protective_exit computed an unusable stop (${stopPrice}). Nothing was placed.` };
  }
  return {
    ok: true,
    order: { symbol, side: "sell", type: "stop", qty: quantity, stop_price: stopPrice, time_in_force: timeInForce },
  };
}

/* --------------------------------------------------------------- scale-out */

export interface ScaleOutTarget {
  price: number;
  quantity: number;
}

export interface ScaleOutLeg {
  symbol: string;
  side: "sell";
  type: "limit";
  qty: number;
  limit_price: number;
  time_in_force: "gtc" | "day";
}

export type ScaleOutResult =
  | { ok: true; legs: ScaleOutLeg[]; totalQuantity: number }
  | { ok: false; code: AdvancedOrderRefusalCode | "invalid_scale_out"; message: string };

/** Several take-profits on one entry, never exceeding the position. */
export function buildScaleOutPlan(
  input: { symbol: string; quantity: number; targets: ScaleOutTarget[]; timeInForce?: "gtc" | "day" },
): ScaleOutResult {
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const quantity = Number(input.quantity);
  const targets = input.targets ?? [];
  if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, code: "invalid_scale_out", message: "A scale-out needs a symbol and a positive position quantity." };
  }
  if (targets.length === 0) {
    return { ok: false, code: "invalid_scale_out", message: "A scale-out needs at least one target." };
  }
  const total = targets.reduce((sum, target) => sum + Number(target.quantity), 0);
  if (targets.some((target) => !(Number(target.quantity) > 0) || !(Number(target.price) > 0))) {
    return { ok: false, code: "invalid_scale_out", message: "Every scale-out target needs a positive price and quantity." };
  }
  if (total > quantity) {
    return {
      ok: false,
      code: "scale_out_exceeds_position",
      message: `scale_out refused: the targets sell ${total} shares but the position is ${quantity}. Nothing was placed.`,
    };
  }
  const timeInForce = input.timeInForce ?? "gtc";
  return {
    ok: true,
    legs: targets.map((target) => ({ symbol, side: "sell", type: "limit", qty: Number(target.quantity), limit_price: Number(target.price), time_in_force: timeInForce })),
    totalQuantity: total,
  };
}

/* ----------------------------------------------------------------- replace */

export type ReplaceValidation =
  | { ok: true }
  | { ok: false; code: AdvancedOrderRefusalCode; message: string };

/**
 * Replace is allowed for a simple order. A compound parent is REFUSED rather
 * than replaced and divorced from its legs — a silent detach would leave
 * unprotected shares behind.
 */
export function validateReplaceOrder(input: { broker: AdvancedBrokerId; orderClass: string }): ReplaceValidation {
  const entry = advancedOrderType("replace")!;
  if (entry.broker[input.broker] === "none") {
    return {
      ok: false,
      code: "replace_not_supported",
      message: `replace_not_supported (replace @ ${input.broker}); the order path here can only cancel and re-place.`,
    };
  }
  const orderClass = String(input.orderClass ?? "simple").toLowerCase();
  if (orderClass === "bracket" || orderClass === "oco" || orderClass === "oto") {
    return {
      ok: false,
      code: "replace_parent_unsupported",
      message:
        `replace_parent_unsupported: order class '${orderClass}' carries held legs; replacing the parent here would detach them. ` +
        `Cancel the parent (which cancels its legs) and place a fresh bracket.`,
    };
  }
  return { ok: true };
}
