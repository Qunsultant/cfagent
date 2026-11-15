/**
 * Preview-body builder (issue #4573) — the ONE place the ticket turns its
 * selection into a `/api/broker/order/preview` body.
 *
 * Two rules live here, so neither the hub nor the panel can drift from them:
 *  1. the body always carries `timeInForce`;
 *  2. a combination the broker/mode does not support is refused BEFORE the
 *     request — the UI disables it, and this is the second gate at the send
 *     boundary. An unsupported order never leaves the client.
 */
import {
  orderCapabilitiesFor,
  supportsOrderType,
  supportsTimeInForce,
  type OrderAssetClass,
  type OrderTimeInForce,
  type OrderType,
} from "../../config/orderCapabilities";

export interface OrderPreviewInput {
  brokerId: string;
  mode: "paper" | "live";
  assetClass: OrderAssetClass;
  symbol: string;
  orderAction: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType: OrderType;
  timeInForce: OrderTimeInForce;
  limitPrice?: string;
  optionLegs?: unknown[];
  strategyNetDebit?: number;
}

export type OrderPreviewBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: "BROKER_UNSUPPORTED" | "ORDER_TYPE_UNSUPPORTED" | "TIME_IN_FORCE_UNSUPPORTED" };

/**
 * Build the preview body, or refuse. Refusal reasons are stable strings the
 * caller turns into a message; no message text lives here.
 */
export function buildOrderPreviewBody(input: OrderPreviewInput): OrderPreviewBodyResult {
  const caps = orderCapabilitiesFor({
    brokerId: input.brokerId,
    mode: input.mode,
    assetClass: input.assetClass,
  });
  if (!caps.supported) return { ok: false, reason: "BROKER_UNSUPPORTED" };
  if (!supportsOrderType(caps, input.orderType)) return { ok: false, reason: "ORDER_TYPE_UNSUPPORTED" };
  if (!supportsTimeInForce(caps, input.timeInForce)) return { ok: false, reason: "TIME_IN_FORCE_UNSUPPORTED" };

  return {
    ok: true,
    body: {
      broker: input.brokerId,
      assetClass: input.assetClass,
      symbol: input.symbol.toUpperCase(),
      orderAction: input.orderAction,
      action: input.orderAction,
      quantity: Number(input.quantity),
      orderType: input.orderType,
      timeInForce: input.timeInForce,
      limitPrice: input.orderType === "LIMIT" ? input.limitPrice : undefined,
      optionLegs: input.optionLegs?.map((leg) => ({
        ...(leg as Record<string, unknown>),
        underlyingSymbol: input.symbol.toUpperCase(),
        quantity:
          Number((leg as { quantity?: number }).quantity ?? 0) * Number(input.quantity),
      })),
      strategyNetDebit:
        input.strategyNetDebit === undefined ? undefined : input.strategyNetDebit * Number(input.quantity),
    },
  };
}

/** The message for a refusal — one place, so both call sites say the same thing. */
export function orderPreviewRefusalMessage(
  reason: Extract<OrderPreviewBodyResult, { ok: false }>["reason"],
  brokerLabel: string,
): string {
  switch (reason) {
    case "BROKER_UNSUPPORTED":
      return `${brokerLabel} has no order-entry contract for this asset class in this mode. Nothing was sent.`;
    case "ORDER_TYPE_UNSUPPORTED":
      return `This order type is not available for ${brokerLabel} on this asset class. Choose a supported type — nothing was sent.`;
    case "TIME_IN_FORCE_UNSUPPORTED":
      return `This time-in-force is not available for ${brokerLabel} on this asset class. Choose a supported value — nothing was sent.`;
  }
}
