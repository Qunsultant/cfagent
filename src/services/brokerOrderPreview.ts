/**
 * Issue #5767 — preview ONE order on the selected broker, from chat.
 *
 * This is the broker-side preview (`platform.previewOrder`): the broker's
 * own computed terms for the order the caller describes. It PLACES NOTHING
 * and it stores no draft — the route's preview additionally hashes the
 * payload, attests a proposer DID, records the autopilot verdict and writes
 * the `mas_trades` draft row, and those steps need the route's host context.
 * So this tool answers "what would this order look like at my broker?", not
 * "create an approvable draft". Creating one stays on the ticket/route path
 * and on `propose_stock_trade` -> approval, which keeps the execute gate
 * exactly where the broker-tool mode config records it: not switchable.
 */
import {
  ROUTED_BROKER_IDS,
  TradingPlatformRegistry,
  normalizeTimeInForce,
  hasTimeInForce,
  TIME_IN_FORCE_VALUES,
  BROKER_CATALOG,
  BROKER_UNAVAILABLE_CODE,
  type BrokerId,
} from "../trading";
import { resolveTenantBroker } from "./tenantProviders";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";

const ACTIONS = ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"] as const;
const ORDER_TYPES = ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"] as const;

export interface BrokerOrderPreviewInput {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
  sessionId: string;
  /** Optional: omitted ⇒ the tenant's selected broker. */
  broker?: string;
  symbol: string;
  orderAction: string;
  quantity: number;
  orderType: string;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: string;
  assetClass?: string;
  optionLegs?: unknown[];
  strategyNetDebit?: number;
  requestedEnv?: string;
}

export interface BrokerOrderPreviewResult {
  success: boolean;
  broker: BrokerId | "unknown";
  code?: string;
  message: string;
  /** The broker's own preview terms; present only on success. */
  draft?: unknown;
}

function refusal(
  broker: BrokerId | "unknown",
  code: string,
  message: string,
): BrokerOrderPreviewResult {
  return { success: false, broker, code, message };
}

export async function previewOrderViaSelectedBroker(
  input: BrokerOrderPreviewInput,
): Promise<BrokerOrderPreviewResult> {
  const login =
    typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  if (!login) {
    return refusal("unknown", "identity_required", "A preview needs the acting login; nothing was sent.");
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    return refusal("unknown", "invalid_symbol", "A preview needs a symbol; nothing was sent.");
  }
  const action = String(input.orderAction ?? "").toUpperCase().trim();
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return refusal(
      "unknown",
      "invalid_order_action",
      `Unsupported order action: ${action || "(missing)"}. Supported: ${ACTIONS.join(", ")}.`,
    );
  }
  const orderType = String(input.orderType ?? "").toUpperCase().trim();
  if (!(ORDER_TYPES as readonly string[]).includes(orderType)) {
    return refusal(
      "unknown",
      "invalid_order_type",
      `Unsupported order type: ${orderType || "(missing)"}. Supported: ${ORDER_TYPES.join(", ")}.`,
    );
  }
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return refusal("unknown", "invalid_quantity", "quantity must be a positive whole number; nothing was sent.");
  }
  for (const [field, value] of [
    ["limitPrice", input.limitPrice],
    ["stopPrice", input.stopPrice],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      return refusal("unknown", `invalid_${field}`, `${field} must be a positive number when supplied; nothing was sent.`);
    }
  }
  const timeInForce = normalizeTimeInForce(input.timeInForce);
  if (hasTimeInForce(input.timeInForce) && !timeInForce) {
    return refusal(
      "unknown",
      "invalid_time_in_force",
      `Unsupported timeInForce: ${String(input.timeInForce)}. Supported values: ${TIME_IN_FORCE_VALUES.map((v) => v.toUpperCase()).join(", ")}.`,
    );
  }

  const optionLegs = Array.isArray(input.optionLegs) ? input.optionLegs : undefined;
  const hasOptionLegs = optionLegs?.some(
    (leg) => (leg as { securityType?: unknown })?.securityType === "OPTN",
  );
  const assetClass =
    input.assetClass === undefined
      ? hasOptionLegs
        ? "options"
        : "equity"
      : String(input.assetClass).toLowerCase();
  if (assetClass !== "equity" && assetClass !== "options") {
    return refusal("unknown", "invalid_asset_class", `Unsupported order asset class: ${assetClass}.`);
  }
  if (assetClass === "options" && !hasOptionLegs) {
    return refusal("unknown", "invalid_option_legs", "Options orders require at least one complete option contract leg.");
  }
  if (assetClass === "equity" && hasOptionLegs) {
    return refusal("unknown", "invalid_option_legs", "Option contract legs must be routed as an options order.");
  }

  const requestedBroker =
    typeof input.broker === "string" && input.broker.trim()
      ? input.broker.trim().toLowerCase()
      : undefined;
  if (requestedBroker && !(ROUTED_BROKER_IDS as readonly string[]).includes(requestedBroker)) {
    return refusal(
      "unknown",
      "unsupported_broker",
      `Unsupported broker: ${requestedBroker}. Routed brokers: ${ROUTED_BROKER_IDS.join(", ")}.`,
    );
  }
  const broker = (requestedBroker as BrokerId | undefined) ?? (await resolveTenantBroker(input.env));

  try {
    const platform = TradingPlatformRegistry.getPlatform(
      broker,
      input.env,
      input.orm,
      login,
      input.requestedEnv,
    );
    const preview = await platform.previewOrder({
      assetClass,
      sessionId: input.sessionId,
      symbol,
      orderAction: action,
      quantity,
      orderType,
      ...(input.limitPrice !== undefined ? { limitPrice: input.limitPrice } : {}),
      ...(input.stopPrice !== undefined ? { stopPrice: input.stopPrice } : {}),
      ...(timeInForce !== undefined ? { timeInForce } : {}),
      ...(optionLegs ? { optionLegs } : {}),
      ...(input.strategyNetDebit !== undefined ? { strategyNetDebit: input.strategyNetDebit } : {}),
    } as never);
    return {
      success: true,
      broker,
      message: `Previewed ${action} ${quantity} ${symbol} on ${broker}; nothing was placed and no draft was stored.`,
      draft: preview,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to preview the order";
    if (/not configured/i.test(message)) {
      const label = BROKER_CATALOG[broker as keyof typeof BROKER_CATALOG]?.label ?? broker;
      return {
        success: false,
        broker,
        code: BROKER_UNAVAILABLE_CODE,
        message: `${label} credentials are not configured, so the preview was refused. Connect ${label} before previewing; no other broker was used.`,
      };
    }
    return refusal(broker, "preview_failed", message);
  }
}
