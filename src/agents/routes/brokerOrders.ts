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
import { orderCapabilitiesFor } from "../../config/orderCapabilities";
import { ACCOUNT_BINDING_CONFIG, maskAccountId } from "../../config/accountBindings";
import { codedMessage, getOutcome } from "../../outcomes/outcomeAspects";
import {
  accountBindingAuditFields,
  resolveValidatedExecutionAccountContext,
  type ExecutionAccountContext,
} from "../../services/accountBindings";
// Issue #4654/#4656: one derivation of the draft's approved terms for both
// execute routes.
import { deriveOrderExecutionTerms } from "./orderExecutionTerms";
import {
  TradingPlatformRegistry,
  ROUTED_BROKER_IDS,
  brokerSupports,
  BROKER_CATALOG,
  BROKER_UNAVAILABLE_CODE,
  normalizeTimeInForce,
  hasTimeInForce,
  TIME_IN_FORCE_VALUES,
  type BrokerId,
  type NormalizedTimeInForce,
} from "../../trading";
import type { BrokerAccount } from "../../types";
import { handleBrokerLimitRoutes } from "./brokerLimits";
import {
  cancelAllOrders,
  cancelSingleOrder,
  cancelTickerOrders,
  createCancelBrokerPort,
  markDraftRowCancelledIfPresent,
  recordCancelOutcome,
  recordScopedCancelOutcome,
} from "../../services/orderCancellation";
import {
  cancelPortForBroker,
  scopedCancelLedger,
} from "../../services/brokerOrderCancel";
import { createSqlCancelPreviewStore } from "../../services/cancelPreviewStore";
import { resolveTradingLimits } from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import { unauthenticatedResponse } from "./routeIdentity";
import { resolveTradeEnvironmentFromSettings } from "./brokerEnvironment";
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

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/brokerOrders",
});

export type BrokerOrderRouteContext = EtradeBrokerRouteContext;

/**
 * Issue #3937: the cancel port for the selected broker. The service-port
 * broker keeps its service port — the bracket-leg semantics live in that
 * broker's row shape, so the engine must keep reading those rows for
 * that broker. Every other broker with the orderCancel capability runs
 * the same engine over its platform adapter (list via getOrderHistory,
 * cancel via cancelOrderRemote). Null when the adapter omits a method
 * the engine needs: the caller answers
 * BROKER_CAPABILITY_NOT_IMPLEMENTED, never provider_unsupported — the
 * capability is declared, the implementation is what is missing.
 */
function modeFromEnvironment(requestedEnv: "TEST" | "PROD" | undefined): "live" | "paper" {
  return requestedEnv === "PROD" ? "live" : "paper";
}

/**
 * Issue #3232 (program #3216): the routed brokers come from the one broker
 * catalog. This used to be a second, hand-written copy whose own comment
 * admitted it "mirrors the client BROKER_OPTIONS" — the exact drift the
 * catalog exists to end. "sandbox" is E*TRADE's test environment, not a
 * broker, and is still refused here.
 */
const ROUTED_BROKERS = ROUTED_BROKER_IDS;

type RoutedBroker = (typeof ROUTED_BROKERS)[number];

function isRoutedBroker(value: unknown): value is RoutedBroker {
  return typeof value === "string" && (ROUTED_BROKERS as readonly string[]).includes(value.toLowerCase());
}

/** Issue #4656: the canonical time-in-force vocabulary lives in the trading
 * surface (`src/trading/timeInForce.ts`), so this route, the legacy route and
 * every platform map one token. Nothing is redefined here. */

/**
 * Persist the previewed draft with its broker stamp. Platforms that
 * persist internally (E*TRADE) leave a row without a broker — stamp
 * it. Platforms that do not persist (Alpaca) leave no row — create
 * it from the draft fields, using the same mapping the E*TRADE
 * platform uses. A failure here fails the preview: an unstamped
 * draft must never reach the approvals queue.
 *
 * Issue #4532 (slice 2): the mode is stamped alongside the broker,
 * from the resolved trading environment of this preview. A draft
 * re-previewed under another environment takes the new mode — the
 * stamp records the environment the draft was last previewed under,
 * which is the environment it would execute in.
 *
 * Issue #5100 (F3 of #5094): the resolved binding tuple is stamped
 * alongside them, from the validated preview resolution. Execute
 * re-resolves and compares against this stamp (409 on mismatch);
 * legacy rows without a stamp are refused with a re-preview message.
 */
function ensureDraftStored(
  ctx: BrokerOrderRouteContext,
  sessionId: string,
  preview: any,
  broker: RoutedBroker,
  mode: "live" | "paper",
  timeInForce?: NormalizedTimeInForce,
  binding?: ExecutionAccountContext | null,
): void {
  const orm = ctx.getOrm();
  if (!orm?.trades) return;
  // Issue #5100: the binding tuple rides the row in both branches.
  const bindingStamp = binding
    ? {
        accountId: binding.accountId ?? null,
        accountType: binding.accountType ?? null,
        bindingScope: binding.scope ?? null,
        bindingSource: binding.source ?? null,
      }
    : {};
  const existing = orm.trades.findById(preview.orderId);
  if (existing) {
    // Issue #4654: the draft row is the only carrier of the stop price from
    // preview to execute, so a platform that persisted its own row gets it
    // stamped here (the platform's row is created before this call).
    const stopPrice = typeof (preview as { stopPrice?: unknown }).stopPrice === "number"
      ? (preview as { stopPrice: number }).stopPrice
      : undefined;
    orm.trades.update(preview.orderId, {
      broker,
      mode,
      ...(stopPrice !== undefined ? { stopPrice } : {}),
      // Issue #4656: the approved time-in-force rides the same row.
      ...(timeInForce !== undefined ? { timeInForce } : {}),
      ...bindingStamp,
      updatedAt: new Date().toISOString(),
    });
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
    mode,
    stopPrice:
      typeof (preview as { stopPrice?: unknown }).stopPrice === "number"
        ? (preview as { stopPrice: number }).stopPrice
        : undefined,
    timeInForce,
    ...bindingStamp,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export function markDraftCancelledIfPresent(
  ctx: { getOrm?: () => { trades?: { update?: (id: string, patch: { status: "cancelled" }) => unknown } } },
  orderId: string,
): void {
  markDraftRowCancelledIfPresent(ctx.getOrm?.(), orderId);
}

export async function handleBrokerOrderRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerOrderRouteContext,
): Promise<Response | null> {
  const requestedEnv: "TEST" | "PROD" | undefined =
    resolveTradeEnvironmentFromSettings(ctx.readSettingRaw, ctx.env);

  // Issue #3888: the externalized trading limits — one read/change
  // surface, resolved by src/trading/limits.ts so the engine, the
  // tool and the copilot all quote the same configuration.
  const limitResponse = await handleBrokerLimitRoutes(request, url, path, {
    env: ctx.env,
    readSettingRaw: (key) => ctx.readSettingRaw(key),
    writeSetting: ctx.writeSetting ? (key, value) => ctx.writeSetting!(key, value) : undefined,
    audit: (type, agent, payload) => ctx.audit(type, agent as never, payload),
  });
  if (limitResponse) return limitResponse;

  // Broker-routed order preview
  if (path.endsWith("/broker/order/preview") && request.method === "POST") {
    // Issue #3669: hoisted so the catch can name the broker it refused.
    let broker: RoutedBroker | undefined;
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const brokerRaw = String(body.broker || "").toLowerCase();
      if (!isRoutedBroker(brokerRaw)) {
        return Response.json({ error: `Unsupported broker: ${brokerRaw || "(missing)"}. Routed brokers: ${ROUTED_BROKERS.join(", ")}.` }, { status: 400 });
      }
      broker = brokerRaw;
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
      // Issue #4656 (matrix gap 5): the ticket's time-in-force used to die here.
      const timeInForce = normalizeTimeInForce(body.timeInForce);
      if (hasTimeInForce(body.timeInForce) && !timeInForce) {
        return Response.json(
          {
            error: `Unsupported timeInForce: ${String(body.timeInForce)}. Supported values: ${TIME_IN_FORCE_VALUES.map((v) => v.toUpperCase()).join(", ")}.`,
          },
          { status: 400 },
        );
      }
      const optionLegs = Array.isArray(body.optionLegs) ? body.optionLegs : undefined;
      const inferredAssetClass = optionLegs?.some((leg: any) => leg.securityType === "OPTN") ? "options" : "equity";
      const rawAssetClass = body.assetClass === undefined ? inferredAssetClass : String(body.assetClass).toLowerCase();
      if (rawAssetClass !== "equity" && rawAssetClass !== "options") {
        return Response.json({ error: `Unsupported order asset class: ${rawAssetClass}.` }, { status: 400 });
      }
      const assetClass = rawAssetClass as "equity" | "options";
      // Issue #4656 (matrix gap 5): refuse a time-in-force this broker's own
      // capability matrix does not list, before the platform sees it — the same
      // table the ticket renders from, so the UI and the route cannot disagree
      // about what a broker accepts. A broker with NO matrix entry (Public) is
      // left to its own named refusal instead of being refused everything here.
      if (timeInForce) {
        const caps = orderCapabilitiesFor({
          brokerId: broker,
          mode: modeFromEnvironment(requestedEnv),
          assetClass,
        });
        if (caps.supported && !caps.timeInForce.includes(timeInForce.toUpperCase() as never)) {
          return Response.json(
            {
              error: `${BROKER_CATALOG[broker].label} does not accept ${timeInForce.toUpperCase()} for a ${assetClass} order; choose ${caps.timeInForce.join(", ")}. Nothing was sent.`,
            },
            { status: 400 },
          );
        }
      }
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

      // Issue #5100 (F3 of #5094): the preview resolves the account through
      // the validated wrapper — an unbound preview is refused with the coded
      // failure, and a body-supplied accountId is validated against the
      // broker's enumerated accounts, never accepted verbatim. The
      // platform is constructed first so the enumeration can run before
      // any preview is produced.
      const platform = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, requestedEnv);
      const explicitAccountId = body.accountId ?? body.accountKey;
      let availableAccounts: readonly BrokerAccount[] | undefined;
      if (explicitAccountId !== undefined && explicitAccountId !== null && `${explicitAccountId}`.trim() !== "") {
        try {
          availableAccounts = await platform.getAccounts();
        } catch (enumErr) {
          // Issue #3669 keeps its own mapping: an unconfigured broker is
          // the coded 409, not a generic enumeration failure.
          if (enumErr instanceof Error && /not configured/i.test(enumErr.message)) throw enumErr;
          return Response.json(
            { ok: false, error: `Could not enumerate ${broker} accounts to validate the requested account; the preview was refused.` },
            { status: 502 },
          );
        }
      }
      const accountCtx = await resolveValidatedExecutionAccountContext(ctx.env, userLogin, {
        broker,
        mode: modeFromEnvironment(requestedEnv),
        accountType: body.accountType ?? (assetClass === "options" ? "options" : "stock"),
        scope: body.bindingScope ?? "copilot",
        explicitAccountId,
        availableAccounts,
      });
      if (!accountCtx.ok) {
        return Response.json({ ok: false, code: accountCtx.code, error: accountCtx.error }, { status: accountCtx.status });
      }
      ctx.audit("broker.account_binding_resolved", "trading", accountBindingAuditFields(accountCtx.context));
      const preview = await platform.previewOrder({
        assetClass,
        sessionId,
        symbol,
        orderAction,
        quantity,
        orderType,
        limitPrice,
        stopPrice,
        timeInForce,
        optionLegs,
        strategyNetDebit: body.strategyNetDebit !== undefined ? Number(body.strategyNetDebit) : undefined,
      });
      ensureDraftStored(ctx, sessionId, preview, broker, modeFromEnvironment(requestedEnv), timeInForce, accountCtx.context);
      return await completeEtradeOrderPreview({
        ctx,
        sessionId,
        preview: { ...preview, broker },
        userLogin,
        requestedEnv,
      });
    } catch (err) {
      // Issue #3669: an unconfigured broker fails loud and coded, never
      // as a raw 500 string. The Alpaca platform throws "credentials are
      // not configured" (platform.ts getAccounts/getOrderHistory/
      // getActivity/getWatchlists, and the same wording surfaces from a
      // preview whose quote read has no pair); the refusal names the
      // selected broker and the shared FAILURE_BROKER_UNAVAILABLE code
      // (catalog httpStatus 409, retryable false), so the client can
      // show the broker's own connect flow instead of a generic error.
      const message = err instanceof Error ? err.message : "Failed to preview trade order";
      if (broker && /not configured/i.test(message)) {
        const label = BROKER_CATALOG[broker].label;
        return Response.json(
          {
            code: BROKER_UNAVAILABLE_CODE,
            broker,
            message: `${label} credentials are not configured, so the order preview was refused. Connect ${label} before previewing; no other broker was used.`,
            retryable: false,
          },
          { status: 409 },
        );
      }
      return Response.json({ error: message }, { status: 500 });
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
      // Issue #4654 / #4656: the draft's approved terms (limit for LIMIT and
      // STOP_LIMIT, trigger for a stop type, the stored time-in-force) come from
      // ONE derivation, shared with the legacy route.
      const terms = deriveOrderExecutionTerms(existingRecord);
      const limitPrice = terms.limitPrice;
      const stopPrice = terms.stopPrice;
      const timeInForce = terms.timeInForce;
      const parsedStrategy = parseStrategyOrder(existingRecord.previewNotes);
      const strategyOrder = parsedStrategy.optionLegs.length > 0 ? parsedStrategy : undefined;

      // Issue #5100 (F3 of #5094): execute proves the draft's account.
      // The binding is re-resolved now and compared with the tuple
      // stamped at preview; a re-bound account is a 409, an unbound
      // tenant or a legacy draft without a stamp is refused with the
      // coded failure and a re-preview message. Nothing executes
      // against any account other than the previewed one.
      const draftAccountType =
        (existingRecord.accountType as string | undefined) ??
        (parsedStrategy.optionLegs.length > 0 ? "options" : "stock");
      const draftMode =
        (existingRecord.mode as "live" | "paper" | undefined) ?? modeFromEnvironment(requestedEnv);
      const bindingRes = await resolveValidatedExecutionAccountContext(ctx.env, userLogin, {
        broker: draftBroker,
        mode: draftMode,
        accountType: draftAccountType,
        scope: "copilot",
      });
      if (!bindingRes.ok) {
        return Response.json(
          { ok: false, code: bindingRes.code, error: bindingRes.error },
          { status: bindingRes.status },
        );
      }
      const resolvedBinding = bindingRes.context;
      const draftAccountId = (existingRecord.accountId as string | undefined) ?? null;
      if (!draftAccountId) {
        const code = ACCOUNT_BINDING_CONFIG.failureCodes.bindingMissing;
        return Response.json(
          {
            ok: false,
            code,
            error: codedMessage(
              code,
              "Order draft was previewed before account binding enforcement and carries no bound account. A fresh preview is required.",
            ),
          },
          { status: getOutcome(code)?.httpStatus ?? 404 },
        );
      }
      if (resolvedBinding.accountId !== draftAccountId) {
        return Response.json(
          {
            error: `Order draft was previewed on account ${maskAccountId(draftAccountId)} and the bound account is now ${maskAccountId(resolvedBinding.accountId ?? "")}. A fresh preview is required.`,
          },
          { status: 409 },
        );
      }

      // Autopilot policy envelope gate, re-evaluated at execution
      // time (same block as the E*TRADE route).
      let executionVerdict: any = null;
      try {
        const evaluated = await ctx.evaluateAndRecordAutopilotVerdict({
          userLogin,
          requestedEnv,
          sessionId,
          draftId: orderId,
          binding: resolvedBinding,
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
        structuredLog.warn("brokerOrders.autopilot_policy_evaluation_failed", {
          message: "[OrchestratorAgent] Autopilot policy evaluation failed at execute:",
          stage: "execute",
          orderId,
          error: policyErr instanceof Error ? policyErr.message : String(policyErr),
        });
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
        stopPrice,
        timeInForce,
        strategyOrder,
        executionVerdict,
        executor: platform,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to execute trade order" }, { status: 500 });
    }
  }

  // Issue #4670 (matrix gap 16): neutral replace. Same rule as cancel — the
  // order belongs to the broker that took it (the tenant's selection), and a
  // broker without the capability is refused by name rather than asked to
  // modify someone else's order or to cancel-and-replace behind the caller.
  if (path.endsWith("/broker/order/replace") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const replaceOrderId = String(body.orderId ?? body.id ?? "").trim();
      if (!replaceOrderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();

      const quantity = body.quantity === undefined ? undefined : Number(body.quantity);
      if (quantity !== undefined && (!Number.isFinite(quantity) || quantity <= 0)) {
        return Response.json({ error: "quantity must be a positive number when supplied." }, { status: 400 });
      }
      const limitPrice = body.limitPrice === undefined ? undefined : Number(body.limitPrice);
      if (limitPrice !== undefined && (!Number.isFinite(limitPrice) || limitPrice <= 0)) {
        return Response.json({ error: "limitPrice must be a positive number when supplied." }, { status: 400 });
      }
      const stopPrice = body.stopPrice === undefined ? undefined : Number(body.stopPrice);
      if (stopPrice !== undefined && (!Number.isFinite(stopPrice) || stopPrice <= 0)) {
        return Response.json({ error: "stopPrice must be a positive number when supplied." }, { status: 400 });
      }
      // Issue #4670 reuses the canonical time-in-force vocabulary (#4656): an
      // unknown token is a 400 here, never a silently dropped field.
      const timeInForce = normalizeTimeInForce(body.timeInForce);
      if (hasTimeInForce(body.timeInForce) && !timeInForce) {
        return Response.json(
          {
            error: `Unsupported timeInForce: ${String(body.timeInForce)}. Supported values: ${TIME_IN_FORCE_VALUES.map((v) => v.toUpperCase()).join(", ")}.`,
          },
          { status: 400 },
        );
      }
      const trailPrice = body.trailPrice === undefined ? undefined : Number(body.trailPrice);
      const trailPercent = body.trailPercent === undefined ? undefined : Number(body.trailPercent);
      if (
        quantity === undefined &&
        limitPrice === undefined &&
        stopPrice === undefined &&
        timeInForce === undefined &&
        trailPrice === undefined &&
        trailPercent === undefined
      ) {
        return Response.json(
          { error: "A replace needs at least one change: quantity, limitPrice, stopPrice, timeInForce, trailPrice or trailPercent." },
          { status: 400 },
        );
      }

      const broker = await resolveTenantBroker(ctx.env);
      const platform = brokerSupports(broker, "orderPlace")
        ? TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, requestedEnv)
        : null;
      if (!platform || typeof platform.replaceOrderRemote !== "function") {
        return Response.json(
          {
            code: "provider_unsupported",
            broker,
            message: `${broker} cannot replace an open order here; it was not cancelled and re-placed either.`,
            retryable: false,
          },
          { status: 501 },
        );
      }

      const receipt = await platform.replaceOrderRemote({
        orderId: replaceOrderId,
        quantity,
        limitPrice,
        stopPrice,
        timeInForce,
        trailPrice,
        trailPercent,
      });
      return Response.json(
        { ...receipt, timestamp: new Date().toISOString() },
        { status: receipt.success ? 200 : 409 },
      );
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to replace order" },
        { status: 500 },
      );
    }
  }

  // Issue #4672 (matrix gap 18): neutral option exercise endpoint.
  if (path.endsWith("/broker/position/exercise") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const symbolOrContractId = String(body.symbolOrContractId ?? body.symbol ?? body.contractId ?? "").trim();
      if (!symbolOrContractId) {
        return Response.json({ error: "symbolOrContractId is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();

      const broker = await resolveTenantBroker(ctx.env);
      const platform = brokerSupports(broker, "orderPlace")
        ? TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, requestedEnv)
        : null;
      if (!platform || typeof platform.exerciseOption !== "function") {
        return Response.json(
          {
            code: "provider_unsupported",
            broker,
            message: `${broker} does not support option exercise here.`,
            retryable: false,
          },
          { status: 501 },
        );
      }

      const receipt = await platform.exerciseOption(symbolOrContractId);
      return Response.json(
        { ...receipt, timestamp: new Date().toISOString() },
        { status: receipt.success ? 200 : 409 },
      );
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to exercise option" },
        { status: 500 },
      );
    }
  }

  // Issue #3390: neutral cancel. A remote order belongs to the broker that took
  // it, not to a stored draft, so the broker is the tenant's selection — and a
  // broker without the capability is refused by name, never asked to cancel
  // someone else's order.
  if (path.endsWith("/broker/order/cancel") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const cancelOrderId = String(body.orderId ?? body.id ?? "").trim();
      if (!cancelOrderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();

      const broker = await resolveTenantBroker(ctx.env);
      const platform = brokerSupports(broker, "orderCancel")
        ? TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, requestedEnv)
        : null;
      if (!platform || typeof platform.cancelOrderRemote !== "function") {
        return Response.json(
          {
            code: "provider_unsupported",
            broker,
            message: `${broker} does not provide order cancellation here; no other broker was asked to cancel it.`,
            retryable: false,
          },
          { status: 501 },
        );
      }

      // Issue #3883: on this broker the route runs the SAME engine the
      // `alpaca_cancel_order` tool runs, so the two surfaces cannot give
      // different answers about one order (bracket cascade, a filled
      // order's refusal, the leg semantics). Other brokers keep their
      // own cancel through the platform seam, untouched.
      if (broker === "alpaca") {
        const receipt = await cancelSingleOrder(createCancelBrokerPort(ctx.env), {
          orderId: cancelOrderId,
          reason: typeof body.reason === "string" ? body.reason : undefined,
        });
        recordCancelOutcome(ctx.getOrm()?.getSql?.(), receipt, "broker_order_cancel", ctx.env);
        if (receipt.success) {
          markDraftCancelledIfPresent(ctx, receipt.target?.orderId ?? cancelOrderId);
        }
        return Response.json(
          { ...receipt, orderId: receipt.target?.orderId ?? cancelOrderId, timestamp: new Date().toISOString() },
          { status: receipt.success ? 200 : 409 },
        );
      }

      const cancelled = await platform.cancelOrderRemote(cancelOrderId);
      if (cancelled.success) {
        markDraftCancelledIfPresent(ctx, cancelOrderId);
      }
      return Response.json(cancelled, { status: cancelled.success ? 200 : 409 });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to cancel order" },
        { status: 500 },
      );
    }
  }

  // Issue #3884/#3886: cancel every open order for one ticker, with the
  // shared class/side/ladder filter. The SELECTED broker serves it (#3937):
  // Alpaca through its service port, any other broker with the orderCancel
  // capability through its platform adapter — and a broker without the
  // capability is refused by name rather than asked to cancel someone
  // else's orders.
  if (path.endsWith("/broker/orders/cancel-ticker") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const symbol = String(body.symbol ?? "").trim().toUpperCase();
      if (!symbol) {
        return Response.json({ code: "no_orders_matched", message: "A ticker cancel needs a symbol. Nothing was cancelled." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();

      const broker = await resolveTenantBroker(ctx.env);
      if (!brokerSupports(broker, "orderCancel")) {
        return Response.json(
          {
            code: "provider_unsupported",
            broker,
            message: `${broker} does not expose a per-symbol open-order cancel here; no other broker was asked to cancel ${symbol}.`,
            retryable: false,
          },
          { status: 501 },
        );
      }

      const port = cancelPortForBroker(broker, ctx.env, ctx.getOrm(), userLogin, requestedEnv);
      if (!port) {
        return Response.json(
          {
            code: "BROKER_CAPABILITY_NOT_IMPLEMENTED",
            broker,
            message: `${broker} declares order cancellation but does not implement the reads it needs; no other broker was asked to cancel ${symbol}.`,
            retryable: false,
          },
          { status: 501 },
        );
      }

      const limits = resolveTradingLimits({
        symbol,
        env: ctx.env,
        readSetting: (key) => ctx.readSettingRaw(key),
      });
      const receipt = await cancelTickerOrders(port, {
        symbol,
        orderClass: body.orderClass,
        orderSide: body.orderSide,
        ladderId: body.ladderId,
        placedAfter: body.placedAfter,
        dryRun: body.dryRun === true,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        limits,
      });
      if (!receipt.dryRun) {
        if (broker === "alpaca") {
          recordScopedCancelOutcome(ctx.getOrm()?.getSql?.(), receipt, "broker_orders_cancel_ticker", ctx.env);
        } else {
          recordScopedCancelOutcome(
            ctx.getOrm()?.getSql?.(),
            receipt,
            "broker_orders_cancel_ticker",
            ctx.env,
            undefined,
            scopedCancelLedger(broker, requestedEnv),
          );
        }
      }
      const status = receipt.success ? 200 : receipt.code === "cancel_read_failed" ? 502 : 409;
      return Response.json(receipt, { status });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel the ticker's orders" }, { status: 500 });
    }
  }

  // Issue #3885: cancel every open order. Always two steps — a bare call
  // returns the preview and a single-use token (code cancel_all_needs_preview),
  // and only a call carrying that token cancels. The SELECTED broker serves
  // it (#3937), through the same per-broker port as the ticker cancel.
  if (path.endsWith("/broker/orders/cancel-all") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();

      const broker = await resolveTenantBroker(ctx.env);
      if (!brokerSupports(broker, "orderCancel")) {
        return Response.json(
          {
            code: "provider_unsupported",
            broker,
            message: `${broker} does not expose a cancel-all here; no other broker was asked to cancel every open order.`,
            retryable: false,
          },
          { status: 501 },
        );
      }

      const port = cancelPortForBroker(broker, ctx.env, ctx.getOrm(), userLogin, requestedEnv);
      if (!port) {
        return Response.json(
          {
            code: "BROKER_CAPABILITY_NOT_IMPLEMENTED",
            broker,
            message: `${broker} declares order cancellation but does not implement the reads it needs; no other broker was asked to cancel every open order.`,
            retryable: false,
          },
          { status: 501 },
        );
      }

      const sql = ctx.getOrm()?.getSql?.();
      if (!sql) {
        return Response.json(
          { code: "cancel_preview_store_unavailable", message: "The preview store is unavailable, so cancel-all refused rather than cancel unbounded." },
          { status: 503 },
        );
      }

      const limits = resolveTradingLimits({
        env: ctx.env,
        readSetting: (key) => ctx.readSettingRaw(key),
      });
      const receipt = await cancelAllOrders(
        port,
        {
          token: typeof body.confirm === "string" ? body.confirm : undefined,
          dryRun: body.dryRun === true,
          reason: typeof body.reason === "string" ? body.reason : undefined,
          limits,
        },
        createSqlCancelPreviewStore(sql),
      );
      if (receipt.success || receipt.cancelled.length > 0 || receipt.refused.length > 0) {
        if (broker === "alpaca") {
          recordScopedCancelOutcome(
            sql,
            receipt,
            "broker_orders_cancel_all",
            ctx.env,
            `cancel_all:${receipt.preview?.expiresAt ?? new Date().toISOString()}`,
          );
        } else {
          recordScopedCancelOutcome(
            sql,
            receipt,
            "broker_orders_cancel_all",
            ctx.env,
            `cancel_all:${receipt.preview?.expiresAt ?? new Date().toISOString()}`,
            scopedCancelLedger(broker, requestedEnv),
          );
        }
      }
      const status = receipt.success ? 200 : receipt.code === "cancel_read_failed" ? 502 : 409;
      return Response.json(receipt, { status });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel every open order" }, { status: 500 });
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
