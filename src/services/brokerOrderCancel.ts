/**
 * Issue #5765 — cancel ONE order on whichever routed broker holds it.
 *
 * The neutral route (`src/agents/routes/brokerOrders.ts`, `POST
 * /broker/order/cancel`) and the new MCP tool both call this function:
 * one routing rule, two surfaces, so they cannot give different answers
 * about one order (#3883's concern, extended past Alpaca).
 *
 * The rule, unchanged from the route:
 *  - the broker is RESOLVED (tenant selection), never supplied by a
 *    caller or a model — an order stays on the broker that holds it;
 *  - the broker must declare the `orderCancel` capability, else the
 *    refusal names it and no other broker is asked to cancel;
 *  - Alpaca runs the shared cancellation engine (`cancelSingleOrder`:
 *    bracket/OCO family semantics, leg detection, a filled order's
 *    refusal) — the same engine `alpaca_cancel_order` runs;
 *  - every other broker goes through its platform adapter;
 *  - a cancel is recorded through `recordCancelOutcome` either way.
 */
import {
  brokerSupports,
  TradingPlatformRegistry,
  type BrokerId,
} from "../trading";
import { resolveTenantBroker } from "./tenantProviders";
import {
  cancelSingleOrder,
  createCancelBrokerPort,
  markDraftRowCancelledIfPresent,
  recordCancelOutcome,
} from "./orderCancellation";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";

export interface BrokerOrderCancelInput {
  env: Env;
  orm?: DatabaseORM;
  /** The acting login; control is never anonymous. */
  userLogin: string;
  orderId: string;
  /** A caller's note, audited and never sent to the broker. */
  reason?: string;
  /** The resolved trade environment (TEST / LIVE), as the routes resolve it. */
  requestedEnv?: string;
}

export interface BrokerOrderCancelResult {
  success: boolean;
  /** The broker that was asked (never a caller-supplied one). */
  broker: BrokerId | "unknown";
  orderId: string;
  code?: string;
  message: string;
  /** The broker's/engine's own receipt, unflattened. */
  receipt: unknown;
}

function refusal(
  broker: BrokerId | "unknown",
  orderId: string,
  code: string,
  message: string,
): BrokerOrderCancelResult {
  return { success: false, broker, orderId, code, message, receipt: null };
}

export async function cancelOrderViaSelectedBroker(
  input: BrokerOrderCancelInput,
): Promise<BrokerOrderCancelResult> {
  const login =
    typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  if (!login) {
    return refusal(
      "unknown",
      String(input.orderId ?? ""),
      "identity_required",
      "A cancel needs the acting login; nothing was sent.",
    );
  }
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) {
    return refusal(
      "unknown",
      "",
      "invalid_order_id",
      "A cancel needs an order id; nothing was sent.",
    );
  }

  const broker = await resolveTenantBroker(input.env);
  const platform = brokerSupports(broker, "orderCancel")
    ? TradingPlatformRegistry.getPlatform(
        broker,
        input.env,
        input.orm,
        login,
        input.requestedEnv,
      )
    : null;
  if (!platform) {
    return refusal(
      broker,
      orderId,
      "provider_unsupported",
      `${broker} does not declare the orderCancel capability here; no other broker was asked to cancel it.`,
    );
  }

  const sql = input.orm?.getSql?.();

  if (broker === "alpaca") {
    const receipt = await cancelSingleOrder(createCancelBrokerPort(input.env), {
      orderId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    recordCancelOutcome(sql, receipt, "broker_order_cancel", input.env);
    if (receipt.success) {
      markDraftRowCancelledIfPresent(input.orm as never, receipt.target?.orderId ?? orderId);
    }
    return {
      success: receipt.success,
      broker,
      orderId: receipt.target?.orderId ?? orderId,
      ...(receipt.code ? { code: receipt.code } : {}),
      message: receipt.message,
      receipt,
    };
  }

  if (typeof platform.cancelOrderRemote !== "function") {
    return refusal(
      broker,
      orderId,
      "provider_unsupported",
      `${broker} exposes no remote cancel; no other broker was asked to cancel it.`,
    );
  }
  const cancelled = await platform.cancelOrderRemote(orderId);
  if (cancelled.success) {
    markDraftRowCancelledIfPresent(input.orm as never, orderId);
  }
  return {
    success: cancelled.success === true,
    broker,
    orderId,
    ...(cancelled.success ? {} : { code: "cancel_refused" }),
    message:
      typeof (cancelled as { message?: unknown }).message === "string"
        ? ((cancelled as { message: string }).message)
        : cancelled.success
          ? `Cancelled order ${orderId} on ${broker}.`
          : `${broker} refused to cancel order ${orderId}.`,
    receipt: cancelled,
  };
}
