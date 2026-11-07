/**
 * Issue #995: E*TRADE broker route sub-domain module, split out of
 * src/agents/routes/etradeBroker.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeBroker.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the order preview / execute completion (HITL tails)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { ETradeSlackTradingService } from "../../trading";
import { ETradeBrowserService } from "../../services/browserAgent";
import { orderPayloadHash } from "./orderPayloadHash";
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import type { PolicyVerdict } from "../../services/riskPolicyEngine";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/etradeBrokerOrders",
});

/**
 * #1726: the execute route's rejection tail, moved here from the
 * dispatcher (the #995 family home for execute completion tails).
 * Cancels the expiry timer, marks the draft rejected, and returns
 * the cancellation response. Rejecting moves no funds, so it runs
 * after the gate but before the immutability checks, exactly as the
 * dispatcher did.
 */
export async function completeEtradeOrderRejection(args: {
  ctx: EtradeBrokerRouteContext;
  orderId: string;
  userDid: string;
  existingRecord: any;
}): Promise<Response> {
  const { ctx, orderId, userDid, existingRecord } = args;
  if (existingRecord.expirationScheduleId) {
    try {
      await ctx.cancelSchedule(existingRecord.expirationScheduleId);
    } catch {
      // Ignore cancel error if already triggered
    }
  }
  if (ctx.getOrm().trades) {
    ctx.getOrm().trades.update(orderId, {
      status: "rejected",
      authorizerDid: userDid,
      updatedAt: new Date().toISOString(),
    });
  }
  return Response.json({
    success: true,
    orderId,
    status: "rejected",
    message: `Order draft '${orderId}' cancelled by user. No broker order submitted.`,
  });
}

export async function completeEtradeOrderPreview(args: {
  ctx: EtradeBrokerRouteContext;
  sessionId: string;
  preview: any;
  userLogin: string;
  requestedEnv: "TEST" | "PROD" | undefined;
}): Promise<Response> {
  const { ctx, sessionId, preview, userLogin, requestedEnv } = args;
  // Issue #1703 (A3-a): record the approved payload version at preview
  // time, so the execute-time version can be compared against it.
  const previewPayloadHash = await orderPayloadHash({
    symbol: preview.symbol,
    action: preview.orderAction,
    quantity: preview.quantity,
    orderType: preview.orderType,
    price: preview.estimatedPrice,
    totalValue: preview.estimatedTotal,
    optionLegs: preview.optionLegs,
    strategyNetDebit: preview.strategyNetDebit,
  });
  ctx.audit("etrade.order_previewed", "trading", {
    orderId: preview.orderId,
    symbol: preview.symbol,
    orderAction: preview.orderAction,
    quantity: preview.quantity,
    estimatedTotal: preview.estimatedTotal,
    proposerDid: preview.proposerDid,
    payloadHash: previewPayloadHash,
    broker: (preview as any).broker ?? undefined,
  });

  // Autopilot policy envelope (autopilot Phase 1). Evaluated server-side
  // and recorded with a signed verdict. Paused ⇒ advisory (the human
  // authorizer still decides); running ⇒ hard gate, re-checked at execute.
  try {
    const evaluated = await ctx.evaluateAndRecordAutopilotVerdict({
      userLogin,
      requestedEnv,
      sessionId,
      draftId: preview.orderId,
      intent: {
        symbol: preview.symbol,
        action: preview.orderAction,
        quantity: preview.quantity,
        orderType: preview.orderType,
        estimatedPrice: typeof preview.estimatedPrice === "number" ? preview.estimatedPrice : null,
        estimatedTotal: typeof preview.estimatedTotal === "number" ? preview.estimatedTotal : null,
      },
    });
    (preview as any).policyVerdict = evaluated.verdict;
    if (!evaluated.verdict.executionAllowed) {
      return Response.json(
        {
          error: `Autopilot policy blocked this order: ${evaluated.verdict.detail}`,
          bindingRule: evaluated.verdict.bindingRule,
          policyVerdict: evaluated.verdict,
        },
        { status: 409 }
      );
    }
  } catch (policyErr) {
    structuredLog.warn("etradeBrokerOrders.autopilot_policy_evaluation_failed", {
      message: "[OrchestratorAgent] Autopilot policy evaluation failed at preview:",
      stage: "preview",
      orderId: preview.orderId,
      error: policyErr instanceof Error ? policyErr.message : String(policyErr),
    });
    ctx.audit("autopilot.policy_check_failed", "trading", {
      stage: "preview",
      orderId: preview.orderId,
      error: policyErr instanceof Error ? policyErr.message : String(policyErr),
    });
    if (ctx.getAutopilotState().running) {
      return Response.json(
        { error: "Autopilot policy check could not be completed; refusing to preview while autopilot is running." },
        { status: 503 }
      );
    }
  }

  // Schedule a 15-minute expiration timer (900 seconds) for this draft
  try {
    const expSchedule = await ctx.schedule(900, "expireStaleOrderDraft", { orderId: preview.orderId, userLogin });
    if (expSchedule?.id) {
      preview.expirationScheduleId = expSchedule.id;
      preview.expiresAt = new Date(Date.now() + 900 * 1000).toISOString();
      ctx.getOrm().trades?.update(preview.orderId, {
        expirationScheduleId: expSchedule.id,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (schedErr) {
    structuredLog.warn("etradeBrokerOrders.expiration_timer_schedule_failed", {
      message: "[OrchestratorAgent] Note: could not schedule expiration timer:",
      orderId: preview.orderId,
      error: schedErr instanceof Error ? schedErr.message : String(schedErr),
    });
  }

  // Dispatch Pre-Trade Approval Ticket Block Kit card to Slack (Strict HITL Gate)
  try {
    const slackService = new ETradeSlackTradingService(ctx.env, ctx.getOrm(), sessionId);
    await slackService.sendPreTradeApprovalTicket({
      orderId: preview.orderId,
      symbol: preview.symbol,
      action: preview.orderAction as any,
      quantity: preview.quantity,
      orderType: preview.orderType as any,
      limitPrice: preview.limitPrice,
      estimatedPrice: preview.estimatedPrice,
      estimatedTotal: preview.estimatedTotal,
      proposerDid: preview.proposerDid,
      expiresAt: preview.expiresAt,
    });
  } catch (slackErr) {
    structuredLog.warn("etradeBrokerOrders.slack_pre_trade_ticket_dispatch_failed", {
      message: "[OrchestratorAgent] Note: could not dispatch Slack pre-trade ticket:",
      orderId: preview.orderId,
      error: slackErr instanceof Error ? slackErr.message : String(slackErr),
    });
  }

  return Response.json(preview);
}

export async function completeEtradeOrderExecution(args: {
  ctx: EtradeBrokerRouteContext;
  sessionId: string;
  body: any;
  orderId: string;
  decision: "approved" | "rejected" | undefined;
  userLogin: string;
  userDid: string;
  existingRecord: any;
  symbol: string;
  action: any;
  quantity: number;
  orderType: string;
  limitPrice: number | undefined;
  strategyOrder: any;
  executionVerdict: PolicyVerdict | null;
  /**
   * Issue #3089: the execution backend. The E*TRADE route passes its
   * ETradeService; the broker route passes the draft's resolved
   * platform. Only the two methods below are used: an optional
   * remote-submit path and the platform HITL execute path.
   */
  executor: {
    placeOrderRemote?: (params: any) => Promise<any>;
    executeOrder: (orderId: string, authorizerDid: string, decision: any, expectedTerms?: any) => any;
  };
}): Promise<Response> {
  const { ctx, sessionId, body, orderId, decision, userLogin, userDid, existingRecord, symbol, action, quantity, orderType, limitPrice, strategyOrder, executionVerdict, executor } = args;
  let result: any;

  // Issue #3089: the draft's broker decides the backend. For E*TRADE
  // the remote-submit path still requires configured credentials
  // (the pre-S3 condition, unchanged); any other broker with a
  // remote-submit method uses it, otherwise the platform HITL
  // execute path runs — which for a broker without a placement
  // client fails honestly instead of fabricating a fill.
  const broker = ((existingRecord as any)?.broker as string | undefined) || "etrade";
  const remoteConfigured =
    broker === "etrade"
      ? Boolean(ctx.env.ETRADE_CONSUMER_KEY || ctx.env.ETRADE_MCP_SERVER_URL || ctx.env.ET_API_KEY)
      : true;
  if (typeof executor.placeOrderRemote === "function" && remoteConfigured) {
    result = await executor.placeOrderRemote({
      orderId,
      symbol,
      action,
      quantity,
      orderType,
      limitPrice,
      previewId: body.previewId && String(body.previewId).trim() !== ""
        ? String(body.previewId).trim()
        : existingRecord?.orderRef && String(existingRecord.orderRef).trim() !== ""
        ? String(existingRecord.orderRef).trim()
        : undefined,
      optionLegs: strategyOrder?.optionLegs,
      strategyNetDebit: strategyOrder?.strategyNetDebit,
      userLogin,
    });
    if (result.success && ctx.getOrm().trades) {
      ctx.getOrm().trades.update(orderId, {
        status: "executed",
        orderRef: result.executionId,
        authorizerDid: userDid,
        updatedAt: new Date().toISOString(),
      });
      ctx.incrementAutopilotOrdersToday();
    }
  } else {
    result = await executor.executeOrder(orderId, userDid, decision);
  }

  // Cancel the scheduled expiration timer since the order has been executed
  if (existingRecord.expirationScheduleId) {
    try {
      await ctx.cancelSchedule(existingRecord.expirationScheduleId);
    } catch {
      // Ignore cancel error if already triggered
    }
  }

  // Issue #1703 (A3-a): the executed payload version, computed from
  // the stored draft fields execution actually read — comparable with
  // the preview-time version in the preview audit event.
  const executedPayloadHash = await orderPayloadHash({
    symbol,
    action,
    quantity,
    orderType,
    price: existingRecord.price,
    totalValue: existingRecord.totalValue,
    optionLegs: strategyOrder?.optionLegs,
    strategyNetDebit: strategyOrder?.strategyNetDebit,
    previewNotes: existingRecord.previewNotes,
  });
  ctx.audit("etrade.order_executed", "trading", {
    orderId,
    decision,
    authorizerDid: userDid,
    status: result.status,
    executionId: result.executionId,
    policyVerdictId: executionVerdict?.verdictId ?? null,
    payloadHash: executedPayloadHash,
    broker,
  });

  // Automatically dispatch official transaction snap to Slack via ETradeBrowserService
  if (result.status === "executed" || result.success) {
    try {
      const browserService = new ETradeBrowserService(ctx.env);
      await browserService.sendTransactionSnapToSlack({
        transactionId: orderId,
        symbol,
        action,
        quantity,
        price: existingRecord.price || (typeof limitPrice === "number" ? limitPrice : 0),
        orderType,
        status: "EXECUTED",
        totalValue: existingRecord.totalValue || (quantity * (existingRecord.price || 0)),
        environment: (ctx.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
        timestamp: new Date().toISOString(),
        // This route is the HITL authorize/execute gate: execution
        // here means the session user submitted decision "approved"
        // for this draft (issue #120).
        humanApproved: decision === "approved",
      });
    } catch (snapErr) {
      structuredLog.warn("etradeBrokerOrders.slack_transaction_snap_failed", {
        message: "[OrchestratorAgent] Note: could not send transaction snap to Slack:",
        orderId,
        error: snapErr instanceof Error ? snapErr.message : String(snapErr),
      });
    }
  }

  return Response.json({ ...result, broker });
}
