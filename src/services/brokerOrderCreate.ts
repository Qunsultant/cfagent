/**
 * Issue #5767 — create an order from chat, on any routed broker, in one call.
 *
 * "Create" here means exactly what the platform already means by it: the
 * broker's own proposal for the acting user's account, submitted to the
 * durable approval workflow. It PLACES NOTHING. Placement stays behind the
 * approval door, where `decide_trade_approval` delivers a human decision and
 * the workflow's settle step executes — the gate that the broker-tool mode
 * config records as not switchable.
 *
 * This composes the two door calls the platform already exposes
 * (`proposeStockTradeViaDoor`, `startTradeApprovalViaDoor`); it introduces no
 * second proposal path and no placement path of its own.
 */
import {
  proposeStockTradeViaDoor,
  startTradeApprovalViaDoor,
} from "../agents/orchestrator/meshDoors";
import { resolveTenantBrokerSelection } from "./tenantProviders";
import type { Env } from "../types";

const ACTIONS = ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"] as const;

export interface BrokerOrderCreateInput {
  env: Env;
  userLogin: string;
  symbol: string;
  action: string;
  quantity: number;
  orderType?: string;
  limitPrice?: number;
  stopPrice?: number;
  /** Optional routed broker; omitted ⇒ the tenant's selected broker. */
  provider?: string;
}

export interface BrokerOrderCreateResult {
  success: boolean;
  provider?: string;
  /** The pending-approval proposal the broker returned. */
  proposal?: unknown;
  /** The approval run awaiting the human decision. */
  approval?: unknown;
  code?: string;
  message: string;
}

function refusal(code: string, message: string): BrokerOrderCreateResult {
  return { success: false, code, message };
}

export async function createOrderViaSelectedBroker(
  input: BrokerOrderCreateInput,
): Promise<BrokerOrderCreateResult> {
  const login =
    typeof input.userLogin === "string" ? input.userLogin.trim() : "";
  if (!login) {
    return refusal(
      "identity_required",
      "Creating an order needs the acting login; nothing was proposed.",
    );
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  if (!symbol) return refusal("invalid_symbol", "An order needs a symbol; nothing was proposed.");
  const action = String(input.action ?? "").toUpperCase().trim();
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return refusal(
      "invalid_action",
      `Unsupported action: ${action || "(missing)"}. Supported: ${ACTIONS.join(", ")}.`,
    );
  }
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return refusal("invalid_quantity", "quantity must be a positive number; nothing was proposed.");
  }
  for (const [field, value] of [
    ["limitPrice", input.limitPrice],
    ["stopPrice", input.stopPrice],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      return refusal(`invalid_${field}`, `${field} must be a positive number when supplied.`);
    }
  }

  const provider =
    (typeof input.provider === "string" && input.provider.trim()
      ? input.provider.trim()
      : undefined) ??
    (await resolveTenantBrokerSelection(input.env)) ??
    undefined;

  try {
    const proposal = await proposeStockTradeViaDoor(
      input.env,
      login,
      {
        symbol,
        action: action as never,
        quantity,
        ...(input.orderType !== undefined ? { orderType: input.orderType as never } : {}),
        ...(input.limitPrice !== undefined ? { limitPrice: input.limitPrice } : {}),
        ...(input.stopPrice !== undefined ? { stopPrice: input.stopPrice } : {}),
        ...(provider ? { provider } : {}),
      } as never,
    );
    const orderId = (proposal as { proposal?: { orderId?: unknown } })?.proposal?.orderId;
    if (typeof orderId !== "string" || !orderId) {
      return {
        success: false,
        ...(provider ? { provider } : {}),
        proposal,
        code: "proposal_refused",
        message:
          ((proposal as { note?: unknown }).note as string | undefined) ??
          `The broker returned no proposal (status: ${String((proposal as { status?: unknown }).status ?? "unknown")}); nothing was submitted for approval.`,
      };
    }

    const approval = await startTradeApprovalViaDoor(input.env, login, {
      orderId,
      ...(provider ? { provider } : {}),
    });
    return {
      success: true,
      ...(provider ? { provider } : {}),
      proposal,
      approval,
      message: `Created order ${orderId} and submitted it for approval (run ${approval.workflowId}). NOTHING IS PLACED until a human decides; nothing was sent to the broker beyond the proposal.`,
    };
  } catch (err) {
    return refusal(
      "create_failed",
      err instanceof Error ? err.message : "Failed to create the order",
    );
  }
}
