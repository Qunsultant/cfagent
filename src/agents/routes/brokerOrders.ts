/**
 * Issue #3089 (S3): broker-routed order endpoints.
 *
 * The UI order path hardwires /api/etrade/* and the E*TRADE route
 * handlers construct an E*TRADE-only service, so a non-E*TRADE broker
 * selection could never preview or execute. These routes resolve the
 * platform from TradingPlatformRegistry instead:
 *
 *   POST /broker/order/preview — preview on the requested broker
 *   POST /broker/order/execute — execute the stored draft's broker
 *   GET  /broker/orders       — stored drafts, with their broker
 *
 * Binding rule: the broker is stamped on the stored draft at preview
 * time (mas_trades.broker). Execute derives the broker FROM THE
 * DRAFT — legacy rows without a broker default to etrade — and a
 * caller-supplied broker that disagrees with the draft is rejected
 * (409). A draft previewed on one broker can never execute on
 * another. The HITL door is unchanged: the same gate, immutability
 * check, 15-minute expiry scheduling, autopilot policy envelope,
 * rejection tail, and completion helpers as the E*TRADE routes.
 *
 * Deliberate limits: mode=local is rejected here (local preview
 * stays on the legacy E*TRADE route); remote orders and cancel stay
 * E*TRADE-only. The legacy /api/etrade/* routes are untouched.
 */
import { TradingPlatformRegistry } from "../../trading";
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import { unauthenticatedResponse } from "./routeIdentity";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";
import {
  completeEtradeOrderPreview,
  completeEtradeOrderRejection,
  completeEtradeOrderExecution,
} from "./etradeBrokerOrders";
import {
  checkEtradeExecuteGate,
  checkEtradeExecuteImmutability,
  etradeGateErrorResponse,
} from "../../services/etradeExecutionGate";
import { getUserDid } from "../../agents/did";
import { parseStrategyOrder, orderPayloadHash } from "./orderPayloadHash";

export type BrokerOrderRouteContext = EtradeBrokerRouteContext;

/** The broker ids the routed surface accepts — mirrors the client
 * BROKER_OPTIONS in src/client/tenantProviders.ts (etrade, alpaca).
 * "sandbox" is an E*TRADE environment, not a broker, and is not
 * accepted here. */
const ROUTED_BROKERS = ["etrade", "alpaca"] as const;

type RoutedBroker = (typeof ROUTED_BROKERS)[number];

function isRoutedBroker(value: unknown): value is RoutedBroker {
  return typeof value === "string" && (ROUTED_BROKERS as readonly string[]).includes(value.toLowerCase());
}

/**
 * Persist the previewed draft with its broker stamp. Platforms that
 * persist internally (E*TRADE) leave a row without a broker — stamp
 * it. Platforms that do not persist (Alpaca) leave no row — create
 * it from the draft fields, using the same mapping the E*TRADE
 * platform uses. A failure here fails the preview: an unstamped
 * draft must never reach the approvals queue.
 */
function ensureDraftStored(
  ctx: BrokerOrderRouteContext,
  sessionId: string,
  preview: any,
  broker: RoutedBroker,
): void {
  const orm = ctx.getOrm();
  if (!orm?.trades) return;
  const existing = orm.trades.findById(preview.orderId);
  if (existing) {
    orm.trades.update(preview.orderId, { broker, updatedAt: new Date().toISOString() });
    return;
  }
  orm.trades.create({
    id: preview.orderId,
    sessionId,
    symbol: preview.symbol,
    action: preview.orderAction || preview.action,
    orderType: preview.orderType,
    quantity: preview.quantity,
    price: preview.estimatedPrice,
    totalValue: preview.estimatedTotal,
    status: "previewed",
    orderRef: preview.previewId,
    proposerDid: preview.proposerDid,
    authorizerDid: preview.authorizerDid,
    proofSignature: preview.proofSignature,
    previewNotes: preview.previewNotes ?? preview.previewMessage,
    broker,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export async function handleBrokerOrderRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerOrderRouteContext,
): Promise<Response | null> {
  const requestedEnv: "TEST" | "PROD" | undefined =
    resolveBrokerEnvironmentFromSettings(ctx.readSettingRaw, ctx.env);

  // Broker-routed order preview
  if (path.endsWith("/broker/order/preview") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const brokerRaw = String(body.broker || "").toLowerCase();
      if (!isRoutedBroker(brokerRaw)) {
        return Response.json({ error: `Unsupported broker: ${brokerRaw || "(missing)"}. Routed brokers: ${ROUTED_BROKERS.join(", ")}.` }, { status: 400 });
      }
      const broker = brokerRaw;
      if (body.mode === "local") {
        return Response.json({ error: "Local preview is available only on the legacy E*TRADE route (/api/etrade/order/preview)." }, { status: 400 });
      }
      const symbol = (body.symbol || "").trim().toUpperCase();
      const quantity = Number(body.quantity) || 1;
      const rawAction = String(body.orderAction || body.action || "BUY").toUpperCase().trim();
      const validActions = ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"];
      const orderAction = (validActions.includes(rawAction) ? rawAction : "BUY") as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
      const orderType = body.orderType || "MARKET";
      const limitPrice = body.limitPrice !== undefined ? Number(body.limitPrice) : undefined;
      const stopPrice = body.stopPrice !== undefined ? Number(body.stopPrice) : undefined;
      const optionLegs = Array.isArray(body.optionLegs) ? body.optionLegs : undefined;
      const inferredAssetClass = optionLegs?.some((leg: any) => leg.securityType === "OPTN") ? "options" : "equity";
      const rawAssetClass = body.assetClass === undefined ? inferredAssetClass : String(body.assetClass).toLowerCase();
      if (rawAssetClass !== "equity" && rawAssetClass !== "options") {
        return Response.json({ error: `Unsupported order asset class: ${rawAssetClass}.` }, { status: 400 });
      }
      const assetClass = rawAssetClass as "equity" | "options";
      if (assetClass === "options" && !optionLegs?.some((leg: any) => leg.securityType === "OPTN")) {
        return Response.json({ error: "Options orders require at least one complete option contract leg." }, { status: 400 });
      }
      if (assetClass === "equity" && optionLegs?.some((leg: any) => leg.securityType === "OPTN")) {
        return Response.json({ error: "Option contract legs must be routed as an options order." }, { status: 400 });
      }
      if (!symbol) {
        return Response.json({ error: "Order symbol is required" }, { status: 400 });
      }

      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();

      const platform = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, requestedEnv);
      const preview = await platform.previewOrder({
        assetClass,
        sessionId,
        symbol,
        orderAction,
        quantity,
        orderType,
        limitPrice,
        stopPrice,
        optionLegs,
        strategyNetDebit: body.strategyNetDebit !== undefined ? Number(body.strategyNetDebit) : undefined,
      });
      ensureDraftStored(ctx, sessionId, preview, broker);
      return await completeEtradeOrderPreview({
        ctx,
        sessionId,
        preview: { ...preview, broker },
        userLogin,
        requestedEnv,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to preview trade order" }, { status: 500 });
    }
  }

  // Broker-routed order execution (HITL authorize/execute gate)
  if (path.endsWith("/broker/order/execute") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderId = (body.orderId || body.draftId || "").trim();
      const decision = body.decision;

      if (!orderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }
      if (decision !== "approved" && decision !== "rejected") {
        return Response.json({ error: "decision must be either 'approved' or 'rejected'" }, { status: 400 });
      }

      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const userDid = getUserDid(sessionId);

      let existingRecord: any;
      try {
        existingRecord = checkEtradeExecuteGate(ctx.getOrm(), { orderId, authorizerDid: userDid });
      } catch (gateErr) {
        const gateResponse = etradeGateErrorResponse(gateErr);
        if (gateResponse) return gateResponse;
        throw gateErr;
      }

      if (decision === "rejected") {
        return await completeEtradeOrderRejection({ ctx, orderId, userDid, existingRecord });
      }

      const reqAction = (body.action || body.orderAction || "").toUpperCase().trim();
      const reqSymbol = (body.symbol || "").toUpperCase().trim();
      try {
        checkEtradeExecuteImmutability(existingRecord, { action: reqAction, symbol: reqSymbol, quantity: body.quantity });
      } catch (gateErr) {
        const gateResponse = etradeGateErrorResponse(gateErr);
        if (gateResponse) return gateResponse;
        throw gateErr;
      }

      // Draft binding: the broker comes from the stored draft, never
      // from the caller's current selection. A supplied broker that
      // disagrees with the draft is a 409, not a re-route.
      const draftBroker = ((existingRecord.broker as string | undefined) || "etrade").toLowerCase() as RoutedBroker;
      if (body.broker !== undefined && String(body.broker).toLowerCase() !== draftBroker) {
        return Response.json({ error: `Order draft was previewed on ${draftBroker} and cannot execute on ${String(body.broker)}. A fresh preview is required.` }, { status: 409 });
      }

      const symbol = existingRecord.symbol.toUpperCase();
      const action = existingRecord.action as any;
      const quantity = Number(existingRecord.quantity);
      const orderType = existingRecord.orderType || "MARKET";
      const limitPrice = existingRecord.orderType === "LIMIT" ? existingRecord.price : undefined;
      const parsedStrategy = parseStrategyOrder(existingRecord.previewNotes);
      const strategyOrder = parsedStrategy.optionLegs.length > 0 ? parsedStrategy : undefined;

      // Autopilot policy envelope gate, re-evaluated at execution
      // time (same block as the E*TRADE route).
      let executionVerdict: any = null;
      try {
        const evaluated = await ctx.evaluateAndRecordAutopilotVerdict({
          userLogin,
          requestedEnv,
          sessionId,
          draftId: orderId,
          intent: {
            symbol,
            action,
            quantity,
            orderType,
            estimatedPrice: typeof existingRecord.price === "number" ? existingRecord.price : null,
            estimatedTotal: typeof existingRecord.totalValue === "number" ? existingRecord.totalValue : null,
          },
        });
        executionVerdict = evaluated.verdict;
        if (!evaluated.verdict.executionAllowed) {
          return Response.json(
            {
              error: `Autopilot policy blocked execution: ${evaluated.verdict.detail}`,
              bindingRule: evaluated.verdict.bindingRule,
              policyVerdict: evaluated.verdict,
            },
            { status: 409 },
          );
        }
      } catch (policyErr) {
        console.warn("[OrchestratorAgent] Autopilot policy evaluation failed at execute:", policyErr);
        ctx.audit("autopilot.policy_check_failed", "trading", {
          stage: "execute",
          orderId,
          error: policyErr instanceof Error ? policyErr.message : String(policyErr),
        });
        if (ctx.getAutopilotState().running) {
          return Response.json(
            { error: "Autopilot policy check could not be completed; refusing to execute while autopilot is running." },
            { status: 503 },
          );
        }
      }

      const platform = TradingPlatformRegistry.getPlatform(draftBroker, ctx.env, ctx.getOrm(), userLogin, requestedEnv);
      return await completeEtradeOrderExecution({
        ctx,
        sessionId,
        body,
        orderId,
        decision,
        userLogin,
        userDid,
        existingRecord,
        symbol,
        action,
        quantity,
        orderType,
        limitPrice,
        strategyOrder,
        executionVerdict,
        executor: platform,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to execute trade order" }, { status: 500 });
    }
  }

  // Broker-routed stored-draft listing (the approvals queue source)
  if (path.endsWith("/broker/orders") && request.method === "GET") {
    try {
      const orm = ctx.getOrm();
      const trades = orm.trades.findMany({ orderBy: "created_at DESC", limit: 50 });
      const tradesWithVersions = await Promise.all(
        trades.map(async (trade: any) => ({ ...trade, payloadHash: await orderPayloadHash(trade) })),
      );
      return Response.json({ count: tradesWithVersions.length, trades: tradesWithVersions });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch order history" }, { status: 500 });
    }
  }

  return null;
}
