/**
 * Issue #5766 — replace ONE open order on whichever routed broker holds it.
 *
 * The neutral route (`src/agents/routes/brokerOrders.ts`, `POST
 * /broker/order/replace`) and the MCP tool both call this function: one
 * validation, one routing rule, so the two surfaces cannot give different
 * answers about one order.
 *
 * The rule, unchanged from the route:
 *  - the broker is RESOLVED (tenant selection), never supplied by the caller
 *    or the model — an order stays on the broker that holds it;
 *  - the broker must be place-capable AND expose `replaceOrderRemote`, else
 *    the refusal names it: nothing is cancelled and re-placed behind the
 *    user's back (that would drop queue position and detach bracket legs);
 *  - only the fields the caller states are sent, so an unstated term keeps
 *    its broker value;
 *  - at least one change is required — an empty replace is a refusal, not a
 *    no-op request to the broker.
 */
import {
  brokerSupports,
  TradingPlatformRegistry,
  normalizeTimeInForce,
  hasTimeInForce,
  TIME_IN_FORCE_VALUES,
  type BrokerId,
} from "../trading";
import { resolveTenantBroker } from "./tenantProviders";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";

export interface BrokerOrderReplaceInput {
  env: Env;
  orm?: DatabaseORM;
  /** The acting login; control is never anonymous. */
  userLogin: string;
  orderId: string;
  quantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: string;
  trailPrice?: number;
  trailPercent?: number;
  /** The resolved trade environment (TEST / LIVE), as the routes resolve it. */
  requestedEnv?: string;
}

export interface BrokerOrderReplaceResult {
  success: boolean;
  broker: BrokerId | "unknown";
  orderId: string;
  code?: string;
  message: string;
  /** The broker's own receipt, unflattened. */
  receipt: unknown;
}

function refusal(
  broker: BrokerId | "unknown",
  orderId: string,
  code: string,
  message: string,
): BrokerOrderReplaceResult {
  return { success: false, broker, orderId, code, message, receipt: null };
}

function positive(value: number | undefined): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  return Number.isFinite(value) && value > 0 ? value : "invalid";
}

export async function replaceOrderViaSelectedBroker(
  input: BrokerOrderReplaceInput,
): Promise<BrokerOrderReplaceResult> {
  const login =
    typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  if (!login) {
    return refusal(
      "unknown",
      String(input.orderId ?? ""),
      "identity_required",
      "A replace needs the acting login; nothing was sent.",
    );
  }
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) {
    return refusal(
      "unknown",
      "",
      "invalid_order_id",
      "A replace needs an order id; nothing was sent.",
    );
  }

  const quantity = positive(input.quantity);
  const limitPrice = positive(input.limitPrice);
  const stopPrice = positive(input.stopPrice);
  const trailPrice = positive(input.trailPrice);
  const trailPercent = positive(input.trailPercent);
  for (const [field, value] of [
    ["quantity", quantity],
    ["limitPrice", limitPrice],
    ["stopPrice", stopPrice],
    ["trailPrice", trailPrice],
    ["trailPercent", trailPercent],
  ] as const) {
    if (value === "invalid") {
      return refusal(
        "unknown",
        orderId,
        `invalid_${field}`,
        `${field} must be a positive number when supplied; nothing was sent.`,
      );
    }
  }

  const timeInForce = normalizeTimeInForce(input.timeInForce);
  if (hasTimeInForce(input.timeInForce) && !timeInForce) {
    return refusal(
      "unknown",
      orderId,
      "invalid_time_in_force",
      `Unsupported timeInForce: ${String(input.timeInForce)}. Supported values: ${TIME_IN_FORCE_VALUES.map((v) => v.toUpperCase()).join(", ")}.`,
    );
  }

  if (
    quantity === undefined &&
    limitPrice === undefined &&
    stopPrice === undefined &&
    timeInForce === undefined &&
    trailPrice === undefined &&
    trailPercent === undefined
  ) {
    return refusal(
      "unknown",
      orderId,
      "no_change",
      "A replace needs at least one change: quantity, limitPrice, stopPrice, timeInForce, trailPrice or trailPercent.",
    );
  }

  const broker = await resolveTenantBroker(input.env);
  const platform = brokerSupports(broker, "orderPlace")
    ? TradingPlatformRegistry.getPlatform(
        broker,
        input.env,
        input.orm,
        login,
        input.requestedEnv,
      )
    : null;
  if (!platform || typeof platform.replaceOrderRemote !== "function") {
    return refusal(
      broker,
      orderId,
      "provider_unsupported",
      `${broker} cannot replace an open order here; it was not cancelled and re-placed either.`,
    );
  }

  // Only the stated fields are sent; the typeof guards also narrow the
  // "invalid" sentinel away for the type system.
  const receipt = await platform.replaceOrderRemote({
    orderId,
    ...(typeof quantity === "number" ? { quantity } : {}),
    ...(typeof limitPrice === "number" ? { limitPrice } : {}),
    ...(typeof stopPrice === "number" ? { stopPrice } : {}),
    ...(typeof timeInForce === "string" ? { timeInForce } : {}),
    ...(typeof trailPrice === "number" ? { trailPrice } : {}),
    ...(typeof trailPercent === "number" ? { trailPercent } : {}),
  });
  const success = (receipt as { success?: unknown }).success === true;
  const message =
    typeof (receipt as { message?: unknown }).message === "string"
      ? ((receipt as { message: string }).message)
      : success
        ? `Replaced order ${orderId} on ${broker}.`
        : `${broker} refused to replace order ${orderId}.`;
  return {
    success,
    broker,
    orderId,
    ...(success ? {} : { code: "replace_refused" }),
    message,
    receipt,
  };
}
