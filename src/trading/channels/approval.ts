/**
 * Issue #1262 Phase 3 — the shared channel approval engine.
 *
 * The ledger preview→approve→execute flow (and its cancel sibling) used
 * to exist in three near-verbatim copies — email, Slack, and voice —
 * each with its own tier gate, draft lookup, executeOrder /
 * placeOrderRemote fallback, and DID stamping. A fix to one (e.g. an
 * approval-security fix) did not propagate to the others. This module
 * is the single copy. Channel services keep only inbound parsing and
 * result rendering (HTML email, Block Kit, TTS text).
 *
 * Behaviour pins (carried verbatim from the pre-extraction services):
 *  - Tier gates come from Phase 1 (src/trading/channels/intake):
 *    approve requires the trade tier, cancel requires preview or above.
 *    A null principal is refused (routes refuse unmapped senders
 *    before calling, but the engine fails closed on its own too); an
 *    undefined principal means internal construction with no channel
 *    assertion, and is not tier-gated.
 *  - Draft lookup: by explicit id, else the most recent previewed
 *    draft — except Slack button approvals, which approve exactly the
 *    button's order id (allowLatestFallback: false).
 *  - executeOrder success performs NO extra ledger write (the platform
 *    persists itself). Only the placeOrderRemote fallback writes the
 *    executed/rejected status + authorizerDid + orderRef + updatedAt.
 *  - A missing draft and a non-previewed draft are distinct outcomes;
 *    services render their own pre-existing copy for each.
 *  - Cancel modes: "previewed_only" (email/voice — only a previewed
 *    draft is touched) vs "by_id" (Slack — the draft id is updated
 *    unconditionally, no existence check, exactly as before).
 *  - The engine never constructs ETradeService itself: the caller
 *    passes an executor (the #290 construction ledger counts
 *    ETradeService sites, and this extraction must not move them).
 */

import { tierAtLeast, type ChannelPrincipal } from "./intake";
import { decodeOrderPriceSource } from "../quotePolicies";
import type { OrderPriceSource } from "../../types";

export interface ApprovalTrade {
  id: string;
  symbol: string;
  action: string;
  quantity: number;
  price: number;
  orderType: string;
  totalValue: number;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApprovalTradeStore {
  findById(id: string): ApprovalTrade | null | undefined;
  findMany(args: { where: { status: string }; orderBy: string; limit: number }): ApprovalTrade[];
  update(id: string, patch: Record<string, unknown>): unknown;
}

/** The ETradeService surface the engine needs (structural — no import). */
export interface ApprovalExecutor {
  executeOrder(orderId: string, authorizerDid: string, decision: "approved"): unknown;
  placeOrderRemote(args: {
    orderId: string;
    symbol: string;
    action: string;
    quantity: number;
    orderType: string;
    limitPrice: number;
    /** Issue #3782: the stored draft's provenance, forwarded so placeOrder's guard can verify the price. */
    priceSource?: OrderPriceSource;
    userLogin: string;
  }): Promise<unknown>;
}

export type ApproveOutcome =
  | { kind: "tier_refused"; reason: string }
  | { kind: "not_found"; orderId?: string }
  | { kind: "not_previewed"; trade: ApprovalTrade }
  | { kind: "executed"; trade: ApprovalTrade; execId: string | undefined; execRes: any }
  | { kind: "failed"; trade: ApprovalTrade; execId: string | undefined; message: string; execRes: any };

export type CancelOutcome =
  | { kind: "tier_refused"; reason: string }
  | { kind: "cancelled"; trade?: ApprovalTrade; orderId?: string }
  | { kind: "not_found"; orderId?: string }
  | { kind: "not_previewed"; trade: ApprovalTrade };

function tierRefusal(
  principal: ChannelPrincipal | null | undefined,
  required: "trade" | "preview",
  verb: string
): string | null {
  if (principal === undefined) return null;
  if (principal === null) {
    return `No resolved channel principal — ${verb} requires a linked principal. Nothing was changed.`;
  }
  if (required === "trade" && !tierAtLeast(principal.tier, "trade")) {
    return (
      `Approval refused: principal (${principal.userLogin}) has ${principal.tier} access, ` +
      `and executing an order requires the trade tier. Nothing was executed.` +
      (principal.notice ? ` ${principal.notice}` : "")
    );
  }
  if (required === "preview" && !tierAtLeast(principal.tier, "preview")) {
    return (
      `Cancellation refused: principal (${principal.userLogin}) has ${principal.tier} access, ` +
      `and cancelling an order draft requires the preview tier or above. The draft was left unchanged.` +
      (principal.notice ? ` ${principal.notice}` : "")
    );
  }
  return null;
}

function findDraft(
  trades: ApprovalTradeStore | null | undefined,
  orderId: string | undefined,
  allowLatestFallback: boolean
): ApprovalTrade | null {
  if (!trades) return null;
  if (orderId) return trades.findById(orderId) ?? null;
  if (!allowLatestFallback) return null;
  const pending = trades.findMany({ where: { status: "previewed" }, orderBy: "created_at DESC", limit: 1 });
  return pending.length > 0 ? pending[0] : null;
}

/**
 * Issue #2178 (Q7 S2) — blocking audit sink for trade approvals.
 * Same injected-writer pattern as the obligations audit-before-allow:
 * when provided, the decision audit runs before execution and the
 * result audit after success; a throwing sink blocks (no execution
 * on a decision-audit throw, no success report on a result-audit
 * throw). Callers with an ORM pass a recordBlockingAudit-backed
 * writer. Absent = today's behavior, unchanged.
 */
export type ApprovalAuditSink = (record: {
  id: string;
  sessionId: string;
  type: string;
  agent: "trading";
  payload: Record<string, unknown>;
  createdAt: string;
}) => void;

export async function approvePreviewedOrder(args: {
  trades: ApprovalTradeStore | null | undefined;
  executor: ApprovalExecutor;
  principal?: ChannelPrincipal | null;
  authorizerDid: string;
  userLogin: string;
  orderId?: string;
  /** Slack button approvals pass false: exactly the button's id, never the latest draft. */
  allowLatestFallback?: boolean;
  timestamp: string;
  audit?: ApprovalAuditSink;
}): Promise<ApproveOutcome> {
  const refusal = tierRefusal(args.principal, "trade", "approval");
  if (refusal) return { kind: "tier_refused", reason: refusal };

  const targetTrade = findDraft(args.trades, args.orderId, args.allowLatestFallback !== false);
  if (!targetTrade) return { kind: "not_found", orderId: args.orderId };
  if (targetTrade.status !== "previewed") return { kind: "not_previewed", trade: targetTrade };

  // Issue #2178 (Q7 S2): decision audit BEFORE execution. A throwing
  // sink propagates, so an unaudited approval never executes.
  if (args.audit) {
    args.audit({
      id: crypto.randomUUID(),
      sessionId: args.userLogin,
      type: "trade.approval_decision",
      agent: "trading",
      payload: {
        orderId: targetTrade.id,
        authorizerDid: args.authorizerDid,
        decision: "approved",
      },
      createdAt: args.timestamp,
    });
  }

  let execRes: any;
  try {
    // #2389: the platform executor's executeOrder is async now that
    // approval places through the real broker client — awaiting it
    // here also means a rejected promise lands in the same fallback
    // as a synchronous throw, instead of being misread as a result.
    execRes = await args.executor.executeOrder(targetTrade.id, args.authorizerDid, "approved");
  } catch {
    execRes = await args.executor.placeOrderRemote({
      orderId: targetTrade.id,
      symbol: targetTrade.symbol,
      action: targetTrade.action,
      quantity: targetTrade.quantity,
      orderType: targetTrade.orderType,
      limitPrice: targetTrade.price,
      // Issue #3782: forward the stored draft's provenance (persisted
      // at preview time as JSON) so placeOrder's guard can verify the
      // price.
      priceSource: decodeOrderPriceSource((targetTrade as any)?.priceSourceJson),
      userLogin: args.userLogin,
    });
    if (args.trades) {
      args.trades.update(targetTrade.id, {
        status: execRes.success ? "executed" : "rejected",
        authorizerDid: args.authorizerDid,
        orderRef: execRes.executionId || execRes.brokerOrderRef,
        updatedAt: args.timestamp,
      });
    }
  }

  const execId = execRes?.executionId || execRes?.brokerOrderRef || undefined;
  if (execRes?.success) {
    // Issue #2178 (Q7 S2): result audit AFTER success. Execution
    // already happened and cannot be undone — but a failed audit
    // write must surface as a throw naming the unrecorded execution,
    // never as an executed outcome.
    if (args.audit) {
      try {
        args.audit({
          id: crypto.randomUUID(),
          sessionId: args.userLogin,
          type: "trade.order_executed",
          agent: "trading",
          payload: {
            orderId: targetTrade.id,
            authorizerDid: args.authorizerDid,
            execId,
          },
          createdAt: args.timestamp,
        });
      } catch (err) {
        throw new Error(
          `Trade execution for order ${targetTrade.id} completed but the execution audit write failed; the execution may be unrecorded: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { kind: "executed", trade: targetTrade, execId, execRes };
  }
  return {
    kind: "failed",
    trade: targetTrade,
    execId,
    message: execRes?.message || "Unknown error",
    execRes,
  };
}

export function cancelPreviewedOrder(args: {
  trades: ApprovalTradeStore | null | undefined;
  principal?: ChannelPrincipal | null;
  orderId?: string;
  /** "by_id": unconditional update (Slack). "previewed_only": only a previewed draft moves (email/voice). */
  lookup: "by_id" | "previewed_only";
  /** Slack event cancel stamps the authorizer; email/voice/interaction cancel do not. */
  stampAuthorizerDid?: string;
  timestamp: string;
}): CancelOutcome {
  const refusal = tierRefusal(args.principal, "preview", "cancellation");
  if (refusal) return { kind: "tier_refused", reason: refusal };

  if (args.lookup === "by_id") {
    if (!args.orderId) return { kind: "not_found", orderId: args.orderId };
    if (args.trades) {
      args.trades.update(args.orderId, {
        status: "rejected",
        updatedAt: args.timestamp,
        ...(args.stampAuthorizerDid ? { authorizerDid: args.stampAuthorizerDid } : {}),
      });
    }
    return { kind: "cancelled", orderId: args.orderId };
  }

  const targetTrade = findDraft(args.trades, args.orderId, true);
  if (!targetTrade) return { kind: "not_found", orderId: args.orderId };
  if (targetTrade.status !== "previewed") return { kind: "not_previewed", trade: targetTrade };
  if (args.trades) {
    args.trades.update(targetTrade.id, {
      status: "rejected",
      updatedAt: args.timestamp,
      ...(args.stampAuthorizerDid ? { authorizerDid: args.stampAuthorizerDid } : {}),
    });
  }
  return { kind: "cancelled", trade: targetTrade, orderId: targetTrade.id };
}
