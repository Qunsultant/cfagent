/**
 * Issue #359-09: E*TRADE broker routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move - no behavior change.
 *
 * Owns the E*TRADE broker route blocks:
 * 1. "Environment & E*TRADE Trading APIs": the environment switcher (#314,
 *    both spellings - /environment/switch and /broker/etrade/environment -
 *    delegate to the single-owner handleEnvironmentSwitch, moved here with
 *    the block), broker status, diagnostics, accounts, equity screener,
 *    quote, order preview/execute (with the autopilot policy envelope,
 *    expiration scheduling, and pre-trade Slack approval ticket), positions,
 *    portfolio-risk (aggregate / evaluate / correlation / size / bundle), think
 *    evaluation, hedge analysis, and orders listing / remote fetch / cancel.
 * 2. The broker account-activity block: transactions list + details, alerts
 *    inbox + details + delete, and product lookup. It was non-contiguous
 *    with block 1 (the omnichannel trading channels block sat between
 *    them), so this module exports TWO handlers - handleEtradeBrokerRoutes
 *    and handleEtradeBrokerActivityRoutes - each invoked from routeRequest
 *    at the EXACT position its block occupied in the sequential
 *    path.endsWith matching sequence.
 *
 * Each handler returns a Response when one of its paths matches, or null
 * when none does (the orchestrator then continues its sequential matching).
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Sibling slice (#359-11) owns the /etrade/options/* and
 * /trading/options/* blocks; those were NOT moved here.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * EtradeBrokerRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import {
  resolveBrokerEnvironmentFromSettings,
  handleBrokerEnvironmentGet,
  handleEnvironmentSwitch,
} from "./brokerEnvironment";
export { publishManualScreenerRun } from "./etradeBrokerPublish";
import {
  computePortfolioRisk,
  aggregatePortfolioRisk,
  resolvePositionsSnapshot,
  evaluatePostTradeTotals,
  type CandidateGreekContribution,
} from "../../services/portfolioRisk";
import { ETradeThinkHarness } from "../../services/thinkHarness";
import { parseStockScreenRequest, TradingPlatformRegistry, fetchQuoteLiveStrict } from "../../trading";
import { resolveEnvironmentConfig } from "../../config/environment";
import { assessPortfolioConcentration } from "../../services/portfolioConcentration";
import {
  sizeCandidateAgainstPortfolio,
  type SizingCandidate,
} from "../../services/positionSizing";
import { generateHedgeProposals } from "../../services/hedgeProposals";
import { normalizeBundleCandidates } from "../../services/recommendationBundle";
import { executeBundleRoute, type BundleRouteRequestBody } from "./etradeBrokerBundle";
import { orderPayloadHash, parseStrategyOrder } from "./orderPayloadHash";
import type { ScreeningChannel, ScreeningChannelResult } from "../../services/screeningDelivery";
import { sharedCorrelationService } from "../../services/correlationService";
import { ETradeService } from "../../services/etrade";
import { etradeIdentityFromLogin } from "../../security/etradeOAuth";
import { getUserDid } from "../did";
import {
  checkEtradeExecuteGate,
  checkEtradeExecuteImmutability,
  etradeGateErrorResponse,
} from "../../services/etradeExecutionGate";
import { resolveEtradeRestSwitch } from "../../config/etradeModes";
import { screenModeFieldsFromRequest, screenModeSelectionFromFields } from "../../workflows/screenerWorkflowRoutes";
import type { AgentName, Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ScreenerAgent } from "../screener-agent";
import { handleEtradeDiagnostics } from "./etradeBrokerDiagnostics";
import { executeEtradeScreen, executeEtradeScreenListings } from "./etradeBrokerScreen";
import { etradePositionsMcpEnvelope, etradeQuoteMcp, etradePreviewLocal } from "./etradeBrokerModes";
import {
  completeEtradeOrderPreview,
  completeEtradeOrderExecution,
  completeEtradeOrderRejection,
} from "./etradeBrokerOrders";
import {
  handleTradingSetupCatalog,
  handleLearningsList,
  handleLearningsCreate,
  handleReflectionRun,
} from "./etradeBrokerLearning";
import type {
  OrderIntent,
  PolicyVerdict,
  PolicyVerdictAttestation,
} from "../../services/riskPolicyEngine";
import type { Schedule } from "agents";

/** The subset of OrchestratorAgent surface the E*TRADE broker handlers need. */
export interface EtradeBrokerRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** Issue #1123: set when this request is executed as an async job —
   *  follow-ups then belong to the tracked pipeline, and inline
   *  publishers must defer (no double delivery). */
  asyncJobId?: string;
  /** Issue #1123 S5a: bridge a synchronously-completed screen into
   *  the tracked follow-up pipeline (main-job record + report +
   *  deliveries + notifications). Preferred over the inline
   *  publishers whenever the host provides it. */
  scheduleScreenerFollowups?: (
    outcome: import("../../services/screenerFollowups").ScreenerRunOutcome,
    userLogin: string,
  ) => Promise<void>;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Screening-settings reader (owner: OrchestratorAgent - was `this.readSettingRaw()`). */
  readSettingRaw(key: string): string | null;
  /** Issue #2482: settings writer for the persisted environment selection (optional; the switch fails closed without it). */
  writeSetting?(key: string, value: string): void;
  /** Audit writer (owner: OrchestratorAgent - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Screener agent (owner: OrchestratorAgent - was `this.getScreenerAgent()`). */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /** Canonical-copy screener persistence (owner: OrchestratorAgent - was `this.persistScreenerReportCanonical`). */
  persistScreenerReportCanonical(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    error?: string;
    trigger?: unknown;
    userLogin?: string;
  }): Promise<void>;
  /** Autopilot policy evaluation (owner: OrchestratorAgent - was `this.evaluateAndRecordAutopilotVerdict`). */
  evaluateAndRecordAutopilotVerdict(params: {
    userLogin: string;
    requestedEnv: unknown;
    sessionId: string;
    intent: OrderIntent;
    draftId?: string | null;
    dryRun?: boolean;
  }): Promise<{ verdict: PolicyVerdict; attestation: PolicyVerdictAttestation }>;
  /** Autopilot state (owner: OrchestratorAgent - was `this.getAutopilotState()`). */
  getAutopilotState(): { running: boolean };
  /** Autopilot order counter (owner: OrchestratorAgent - was `this.incrementAutopilotOrdersToday()`). */
  incrementAutopilotOrdersToday(): void;
  /** SDK scheduler (owner: OrchestratorAgent - was `this.schedule`). */
  schedule(when: number, callback: string, payload: any): Promise<Schedule>;
  /** SDK schedule cancellation (owner: OrchestratorAgent - was `this.cancelSchedule`). */
  cancelSchedule(id: string): Promise<boolean>;
  /** #1726: optional session/user carriers for the E*TRADE switches. */
  scopedEtradeModes?: import("../../config/etradeModes").EtradeScopedModes;
}

/**
 * Issue #314 — the environment switcher delegates to the single-owner
 * handler in ./brokerEnvironment (moved there under #2482: the switch
 * block is a coherent unit, and etradeBroker.ts sits at the #359
 * 50 KB module target). Both spellings share one contract, and the
 * handler persists the selection — it never returns success while
 * storing nothing.
 */

/**
 * Handles the E*TRADE broker routes (Environment & E*TRADE Trading APIs
 * block). Returns a Response on match, null when no broker path matches
 * (the orchestrator then continues its sequential matching).
 */
export async function handleEtradeBrokerRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: EtradeBrokerRouteContext
): Promise<Response | null> {
  // ==========================================
  // Environment & E*TRADE Trading APIs
  // ==========================================

  // Issue #2482: broker data resolves from the persisted per-login
  // selection, never the header or ?env= param (unset: deployment default).
  const requestedEnv: "TEST" | "PROD" | undefined =
    resolveBrokerEnvironmentFromSettings(ctx.readSettingRaw, ctx.env);

  // Environment Switcher API (allows client to toggle between Sandbox TEST and Live PROD)
  // Issue #314: the advertised /api/broker/etrade/environment spelling
  // (ETradeDynamicMenu.tsx fallback) delegates to the same single-owner
  // handler, so both spellings share one contract.
  // Issue #2482: POST persists the selection; GET reads it back.
  if (path.endsWith("/environment/switch") && request.method === "POST") {
    return handleEnvironmentSwitch(request, ctx);
  }
  if (path.endsWith("/broker/etrade/environment") && request.method === "POST") {
    return handleEnvironmentSwitch(request, ctx);
  }
  if (path.endsWith("/environment/switch") && request.method === "GET") {
    return handleBrokerEnvironmentGet(ctx);
  }
  if (path.endsWith("/broker/etrade/environment") && request.method === "GET") {
    return handleBrokerEnvironmentGet(ctx);
  }

  // Broker status & account metadata
  if (path.endsWith("/etrade/status") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // #1726 E06: mcp ignores env override.
      const statusMode = resolveEtradeRestSwitch(ctx, "status", url.searchParams.get("mode"), "rest");
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, statusMode === "mcp" ? undefined : requestedEnv);
      const status = await etrade.getStatusAsync();
      return Response.json(status);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch broker status" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API Diagnostics
  if (path.endsWith("/etrade/diagnostics") && request.method === "GET") {
    return handleEtradeDiagnostics(request, sessionId, ctx, requestedEnv);
  }

  // Broker Accounts List (Real E*TRADE REST / OAuth 1.0a)
  if (path.endsWith("/etrade/accounts") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // #1726 E06: mcp discovery envelope.
      const discoveryMode = resolveEtradeRestSwitch(ctx, "discovery", url.searchParams.get("mode"), "rest");
      // Issue #2441: resolve the route-trusted login to its session
      // identity via the alias record, so portfolio reads see the same
      // token the panel seam sees. No record yields an empty identity,
      // which keeps exactly today's login-only behavior.
      const identity = await etradeIdentityFromLogin(ctx.env, userLogin);
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv, undefined, { identity });
      const accounts = await etrade.fetchAccountsRemote();
      if (accounts.length === 0) {
        // Issue #243: an empty list with a recorded client error is an
        // upstream failure (expired OAuth, missing credentials, network),
        // not "you have no accounts" — surface it as a 502 naming the
        // cause instead of an ambiguous empty 200 (the #155 pattern).
        // A genuine empty leaves lastError unset and keeps the exact
        // previous 200 payload.
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          return Response.json({ error: upstreamError }, { status: 502 });
        }
      }
      if (discoveryMode === "mcp") {
        return Response.json({ count: accounts.length, accounts, asOf: new Date().toISOString() });
      }
      return Response.json({ count: accounts.length, accounts });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch accounts" }, { status: 500 });
    }
  }

  // Market Screener & Scanning — delegated to ScreenerAgent (#261).
  // One agent, E*TRADE-only market data, honest failure when unavailable.
  // (The Nasdaq-listings screenLive path is kept in the repo, unwired.)
  if (path.endsWith("/etrade/screen") && (request.method === "POST" || request.method === "GET")) {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
      if (request.method === "GET") {
        if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
        if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
        if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
        if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
        if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
        if (url.searchParams.get("universe")) filters.universe = url.searchParams.get("universe");
      }
      // Issue #270: universe selection; "ALL" auto-shards into parallel runs.
      // Issue #289: default to NASDAQ100 (deterministic top-100) instead of
      // TECH (fuzzy keyword match with unpredictable symbol count).
      // Issue #1737: the async flag rides the POST body or the
      // GET query; it is stripped before schema validation so
      // it can never leak into the screen filters.
      const asyncRequested =
        request.method === "POST"
          ? (filters as { async?: unknown }).async === true
          : url.searchParams.get("async") === "1";
      if (request.method === "POST") delete (filters as { async?: unknown }).async;
      // Issue #2530: dual-mode fields (distinct from the E01
      // `mode` switch below): ND refuses 400 before any path.
      const modeSelection = screenModeSelectionFromFields(
        ctx.env,
        screenModeFieldsFromRequest(request.method, filters, url.searchParams),
        { asyncRequested },
      );
      if (request.method === "POST") {
        delete (filters as { screenMode?: unknown }).screenMode;
        delete (filters as { screenIntent?: unknown }).screenIntent;
      }
      if (!modeSelection.ok) {
        return Response.json({ error: modeSelection.error }, { status: 400 });
      }
      // #1726 E01: listings in etradeBrokerScreen.ts.
      const screenMode = resolveEtradeRestSwitch(ctx, "scan", request.method === "POST" ? (filters as { mode?: unknown }).mode : url.searchParams.get("mode"), "screened");
      if (modeSelection.screenMode && screenMode === "listings") {
        return Response.json(
          { error: "screenMode \"non-deterministic\" runs only as an async workflow screen (scan path), not on listings." },
          { status: 400 },
        );
      }
      if (screenMode === "listings") {
        const listingsEtrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
        return await executeEtradeScreenListings({ ctx, etrade: listingsEtrade, filters });
      }
      // Issue #959: the body (POST) or assembled params (GET) validate
      // through the ONE shared stock-screen schema — a mis-shaped
      // filter is a 400 naming the field, never a silent engine run.
      const parsedScreen = parseStockScreenRequest(filters);
      if (!parsedScreen.ok) {
        return Response.json({ error: parsedScreen.error }, { status: 400 });
      }
      const { universe, filters: validatedFilters, emailTo } = parsedScreen.value;
      const agent = ctx.getScreenerAgent(userLogin);
      return await executeEtradeScreen({ ctx, sessionId, requestedEnv, userLogin, agent, universe, validatedFilters, asyncRequested, emailTo, ...(modeSelection.screenMode ? { screenMode: modeSelection.screenMode, screenIntent: modeSelection.screenIntent } : {}) });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to screen equities" }, { status: 500 });
    }
  }

  // Real-time equity quote (Real E*TRADE REST / OAuth 1.0a)
  if (path.endsWith("/etrade/quote") && request.method === "GET") {
    try {
      // #1726 E02: mcp in etradeBrokerModes.ts.
      const quoteMode = resolveEtradeRestSwitch(ctx, "quote", url.searchParams.get("mode"), "rest");
      const rawSym = quoteMode === "mcp" ? (url.searchParams.get("symbol") || "") : (url.searchParams.get("symbol") || "NVDA");
      const symbol = rawSym.toUpperCase().trim() || (quoteMode === "mcp" ? "" : "NVDA");
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      let quote: unknown;
      if (quoteMode === "mcp") {
        if (!symbol) {
          return Response.json({ error: "symbol is required" }, { status: 400 });
        }
        quote = await etradeQuoteMcp({ ctx, userLogin, symbol });
      } else {
        // #291 Q3: registry-resolved platform + the LIVE_STRICT policy.
        const platform = TradingPlatformRegistry.getPlatform("etrade", ctx.env, ctx.getOrm(), userLogin, requestedEnv);
        quote = await fetchQuoteLiveStrict(platform, symbol, {
          isLive: resolveEnvironmentConfig(ctx.env, requestedEnv).isLive,
        });
      }
      return Response.json(quote, {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch quote" }, { status: 500 });
    }
  }

  // Order Proposal & Preview with DID Attestation (HITL)
  if (path.endsWith("/etrade/order/preview") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
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
      // #1726 E03: local in etradeBrokerModes.ts.
      const previewMode = resolveEtradeRestSwitch(ctx, "preview", body.mode, "broker");
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      if (previewMode === "local") {
        if (optionLegs && optionLegs.length > 0) {
          return Response.json({ error: "Local preview rejects option legs; use broker preview." }, { status: 400 });
        }
        return Response.json(etradePreviewLocal({ etrade, symbol, orderAction, quantity, orderType, limitPrice, stopPrice, sessionId }));
      }
      const preview = await etrade.previewOrderRemote({
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

      return await completeEtradeOrderPreview({ ctx, sessionId, preview, userLogin, requestedEnv });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to preview trade order" }, { status: 500 });
    }
  }

  // Authorize & Execute Confirmed Order Draft (HITL Execution via OAuth 1.0a)
  if (path.endsWith("/etrade/order/execute") && request.method === "POST") {
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

      // #1726 E04: shared gate.
      let existingRecord: any;
      try {
        existingRecord = checkEtradeExecuteGate(ctx.getOrm(), { orderId, authorizerDid: userDid });
      } catch (gateErr) {
        const gateResponse = etradeGateErrorResponse(gateErr);
        if (gateResponse) return gateResponse;
        throw gateErr;
      }

      // Handle user rejection / cancellation immediately (tail in
      // etradeBrokerOrders.ts).
      if (decision === "rejected") {
        return await completeEtradeOrderRejection({ ctx, orderId, userDid, existingRecord });
      }

      // Strict Immutability Verification (shared gate module).
      const reqAction = (body.action || body.orderAction || "").toUpperCase().trim();
      const reqSymbol = (body.symbol || "").toUpperCase().trim();
      try {
        checkEtradeExecuteImmutability(existingRecord, { action: reqAction, symbol: reqSymbol, quantity: body.quantity });
      } catch (gateErr) {
        const gateResponse = etradeGateErrorResponse(gateErr);
        if (gateResponse) return gateResponse;
        throw gateErr;
      }

      const symbol = existingRecord.symbol.toUpperCase();
      const action = existingRecord.action as any;
      const quantity = Number(existingRecord.quantity);
      const orderType = existingRecord.orderType || "MARKET";
      const limitPrice = existingRecord.orderType === "LIMIT" ? existingRecord.price : undefined;
      // #1726: dedup — the stored strategy-order parse already lives
      // in orderPayloadHash.ts; only optionLegs/strategyNetDebit are
      // consumed downstream, and both match the inline parse.
      const parsedStrategy = parseStrategyOrder(existingRecord.previewNotes);
      const strategyOrder = parsedStrategy.optionLegs.length > 0 ? parsedStrategy : undefined;

      // Autopilot policy envelope gate (autopilot Phase 1). Re-evaluated at
      // execution time because orders/day, drawdown, and exposure may have
      // moved since the draft was previewed.
      let executionVerdict: PolicyVerdict | null = null;
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
            { status: 409 }
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
            { status: 503 }
          );
        }
      }

      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      return await completeEtradeOrderExecution({ ctx, sessionId, body, orderId, decision, userLogin, userDid, existingRecord, symbol, action, quantity, orderType, limitPrice, strategyOrder, executionVerdict, etrade });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to execute trade order" }, { status: 500 });
    }
  }

  // Positions & Account Holdings (Real E*TRADE OAuth 1.0a)
  if (path.endsWith("/etrade/positions") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // #1726 E05: mcp in etradeBrokerModes.ts.
      const positionsMode = resolveEtradeRestSwitch(ctx, "positions", url.searchParams.get("mode"), "rest");
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      if (positionsMode === "mcp") {
        return Response.json(await etradePositionsMcpEnvelope(etrade));
      }
      const holdings = await etrade.fetchPortfolioRemote(undefined, true);
      const lastError = etrade.getLastError();
      return Response.json({
        ...holdings,
        error: lastError && holdings.account.accountId === "unconnected" ? lastError : undefined,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch positions" }, { status: 500 });
    }
  }

  // Portfolio-level risk aggregation (issue #34, gap G1): aggregate Greeks,
  // SPY beta-weighted Delta, and total defined max loss from open positions.
  if (path.endsWith("/etrade/portfolio-risk") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const report = await computePortfolioRisk(etrade);
      return Response.json(report);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to compute portfolio risk" }, { status: 500 });
    }
  }

  // Post-trade evaluation (issue #34): current portfolio totals plus a
  // candidate's Greek contribution, without executing anything.
  if (path.endsWith("/etrade/portfolio-risk/evaluate") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { candidate?: CandidateGreekContribution };
      if (!body.candidate) {
        return Response.json({ error: "candidate Greek contribution is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const { account, positions } = await etrade.fetchPortfolioRemote(undefined, true);
      const resolved = await resolvePositionsSnapshot(etrade, positions);
      const spyChain = await etrade.getOptionChains({ symbol: "SPY" }).catch(() => null);
      const report = aggregatePortfolioRisk(resolved, {
        nav: account.netAccountValue || account.totalAccountValue || 0,
        spyPrice: spyChain?.underlyingPrice ?? null,
        asOf: new Date().toISOString(),
      });
      return Response.json({ current: report, postTradeTotals: evaluatePostTradeTotals(report, body.candidate) });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to evaluate post-trade totals" }, { status: 500 });
    }
  }

  // Correlation & concentration assessment (issue #35, gap G2): pairwise
  // correlations among held names plus, for an optional candidate, flags
  // naming the correlated/concentrated positions it would duplicate.
  // Correlations are measured from live history, proxied by sector, or
  // reported unknown — never silently zero.
  if (path.endsWith("/etrade/portfolio-risk/correlation") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { candidateSymbol?: string };
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const report = await computePortfolioRisk(etrade);
      const concentration = await assessPortfolioConcentration(
        report,
        (a, b) => sharedCorrelationService.estimate(a, b),
        body.candidateSymbol,
      );
      return Response.json(concentration);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to assess concentration" }, { status: 500 });
    }
  }

  // Portfolio-aware position sizing (issue #36, gap G3): size a candidate
  // against the current book's risk budgets; the response names the
  // binding constraint.
  if (path.endsWith("/etrade/portfolio-risk/size") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { candidate?: SizingCandidate };
      if (!body.candidate?.symbol || !body.candidate?.perContract) {
        return Response.json({ error: "candidate with symbol and perContract contributions is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const report = await computePortfolioRisk(etrade);
      return Response.json(sizeCandidateAgainstPortfolio(report, body.candidate));
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to size candidate" }, { status: 500 });
    }
  }

  // Recommendation Bundle — Best Trade v2 (issue #1135, Phase 4 of epic
  // #1096): a strategy candidate becomes a bundle (trade + falsification +
  // post-trade risk + optimizer verdict + hedge/repair + alternatives
  // incl. no-trade), built by recommendationBundle over the live book.
  // Drafts only — this endpoint never places or previews an order.
  //
  // Issue #1162 (Phase 6): the body also accepts `candidates[]` (the
  // builder was always multi-candidate; the first entry is the primary
  // the concentration assessment describes), opt-in `persist: true`
  // (record the bundle as a paper outcome in mas_outcomes via the
  // Phase 4 persistence seam — the ORM satisfies its SqlStorage
  // contract), and opt-in `deliver: { channels, emailTo }` (send the
  // bundle text over the existing Slack/email/signed-webhook
  // transports via screeningDelivery). Both are off unless requested:
  // the Phase 4 response shape is unchanged for existing callers.
  // C5 (#1361): opt-in `persistReport` stores the bundle via the
  // shared store seam (source "bundle"); completion (persist +
  // persistReport + deliver + response) lives in etradeBrokerBundle.
  if (path.endsWith("/etrade/portfolio-risk/bundle") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as BundleRouteRequestBody;
      const normalized = normalizeBundleCandidates(body);
      if (!normalized.ok) {
        return Response.json({ error: normalized.error }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const { generateRepairProposals } = await import("../../services/repairProposals");
      const repairAnalysis = await generateRepairProposals(etrade).catch(() => null);

      // C5 (#1361): completion lives in etradeBrokerBundle (the #995
      // split pattern) so this file stays under the #359 50 KB target.
      return executeBundleRoute(ctx, etrade, body, normalized.candidates, repairAnalysis, userLogin);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to build recommendation bundle" }, { status: 500 });
    }
  }

  // Hedge proposals (issue #54): DRAFT hedging proposals sized from the
  // portfolio aggregates — for the HITL order-preview flow only; this
  // endpoint never places or previews an order itself.
  // Think-harness guardrail verdicts (issue #67): the same evaluation the
  // agent/MCP tool runs (issue #37), exposed over HTTP for the UI. Inputs
  // resolve caller-provided -> live broker state -> unavailable, and the
  // harness fails closed (INPUTS_UNAVAILABLE) rather than inventing state.
  if (path.endsWith("/etrade/think/evaluate") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { symbol?: string; action?: "BUY" | "SELL"; quantity?: number; orderType?: "MARKET" | "LIMIT" | "STOP"; price?: number; accountBalanceUSD?: number };
      if (!body.symbol || (body.action !== "BUY" && body.action !== "SELL") || !body.quantity || body.quantity <= 0) {
        return Response.json({ error: "symbol, action (BUY|SELL) and a positive quantity are required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const harness = new ETradeThinkHarness(ctx.getOrm(), ctx.env);
      const result = await harness.evaluateTradeWithThinking({
        symbol: body.symbol.toUpperCase(),
        action: body.action,
        quantity: body.quantity,
        orderType: body.orderType || "MARKET",
        price: body.price,
        accountBalanceUSD: body.accountBalanceUSD,
        userLogin,
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Think evaluation failed" }, { status: 500 });
    }
  }

  if (path.endsWith("/etrade/hedge/analyze") && request.method === "POST") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const analysis = await generateHedgeProposals(etrade);
      return Response.json(analysis);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to generate hedge proposals" }, { status: 500 });
    }
  }

  // Issue #355: portfolio repair proposals (1x2 call ratios on underwater
  // longs). Drafts only — HITL-gated via the existing preview flow; no order
  // path is reachable from this endpoint.
  if (path.endsWith("/etrade/portfolio-repair/analyze") && request.method === "POST") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const { generateRepairProposals } = await import("../../services/repairProposals");
      const analysis = await generateRepairProposals(etrade);
      return Response.json(analysis);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to generate repair proposals" }, { status: 500 });
    }
  }

  // Order History & Trade Audit Ledger
  if (path.endsWith("/etrade/orders") && request.method === "GET") {
    try {
      const orm = ctx.getOrm();
      const trades = orm.trades.findMany({ orderBy: "created_at DESC", limit: 50 });
      // Issue #1703 (A3-a): each listed draft carries its payload
      // version, computed server-side from the stored fields — the same
      // fields execution reads — so the approval card shows exactly
      // what will execute. Existing fields pass through untouched.
      const tradesWithVersions = await Promise.all(
        trades.map(async (trade: any) => ({ ...trade, payloadHash: await orderPayloadHash(trade) }))
      );
      return Response.json({ count: tradesWithVersions.length, trades: tradesWithVersions });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch order history" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Remote Orders on Exchange
  if (path.endsWith("/etrade/orders/remote") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const status = url.searchParams.get("status") || undefined;
      const marker = url.searchParams.get("marker") || undefined;
      const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
      const symbol = url.searchParams.get("symbol") || undefined;
      const orders = await etrade.fetchOrdersRemote(undefined, { status, marker, count, symbol });
      if (orders.length === 0) {
        // Issue #243: empty + recorded client error = upstream failure,
        // not "no orders" — 502 naming the cause (#155 pattern). A
        // genuine empty keeps the exact previous 200 payload.
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          return Response.json({ error: upstreamError }, { status: 502 });
        }
      }
      return Response.json({ count: orders.length, orders });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch exchange orders" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Cancel Order on Exchange
  if (path.endsWith("/etrade/orders/cancel") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderId = body.orderId;
      if (!orderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const result = await etrade.cancelOrderRemote(orderId);
      ctx.audit("etrade.order_cancelled", "trading", { orderId, success: result.success });
      return Response.json(result, { status: result.success ? 200 : 400 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel order" }, { status: 500 });
    }
  }

  return null;
}

/**
 * Handles the E*TRADE broker account-activity routes (transactions,
 * alerts, product lookup block). Returns a Response on match, null when
 * no activity path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handleEtradeBrokerActivityRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: EtradeBrokerRouteContext
): Promise<Response | null> {
  // Issue #2482: same single source as the broker block.
  const requestedEnv: "TEST" | "PROD" | undefined =
    resolveBrokerEnvironmentFromSettings(ctx.readSettingRaw, ctx.env);

  // Real E*TRADE REST API: Account Transactions
  if (path.endsWith("/etrade/transactions") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // Issue #2441: alias-record identity for the portfolio read (see
      // the accounts route above).
      const identity = await etradeIdentityFromLogin(ctx.env, userLogin);
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv, undefined, { identity });
      const startDate = url.searchParams.get("startDate") || undefined;
      const endDate = url.searchParams.get("endDate") || undefined;
      const sortOrder = (url.searchParams.get("sortOrder") as "ASC" | "DESC") || undefined;
      const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
      const transactions = await etrade.fetchTransactions(undefined, { startDate, endDate, sortOrder, count });
      if (transactions.length === 0) {
        // Issue #517: empty + recorded client error = upstream failure,
        // not "no transactions" — 502 naming the cause (#155 pattern,
        // as #243 did for the sibling routes). A genuine empty keeps
        // the exact previous 200 payload.
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          return Response.json({ error: upstreamError }, { status: 502 });
        }
      }
      return Response.json({ count: transactions.length, transactions });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Transaction Details
  if (path.includes("/etrade/transactions/") && request.method === "GET") {
    try {
      const transactionId = path.split("/etrade/transactions/")[1].split("/")[0].split("?")[0];
      const storeId = url.searchParams.get("storeId") || undefined;
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // Issue #2441: alias-record identity for the portfolio read (see
      // the accounts route above).
      const identity = await etradeIdentityFromLogin(ctx.env, userLogin);
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv, undefined, { identity });
      const details = await etrade.fetchTransactionDetails(transactionId, undefined, storeId);
      if (!details) {
        // Issue #517: null + recorded client error = upstream failure,
        // not "not found" — 502 naming the cause (#155 pattern, as
        // #243 did for watchlist/details). A genuine not-found (null,
        // no recorded error) keeps the exact previous 404.
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          return Response.json({ error: upstreamError }, { status: 502 });
        }
        return Response.json({ error: "Transaction not found" }, { status: 404 });
      }
      return Response.json(details);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transaction details" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: User Alerts Inbox
  if (path.endsWith("/etrade/alerts") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // Issue #2441: alias-record identity for the portfolio read (see
      // the accounts route above).
      const identity = await etradeIdentityFromLogin(ctx.env, userLogin);
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv, undefined, { identity });
      const category = url.searchParams.get("category") || undefined;
      const status = (url.searchParams.get("status") as "READ" | "UNREAD" | "DELETED") || undefined;
      const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
      const alerts = await etrade.fetchAlerts({ category, status, count });
      if (alerts.length === 0) {
        // Issue #243: empty + recorded client error = upstream failure,
        // not "no alerts" — 502 naming the cause (#155 pattern). A
        // genuine empty keeps the exact previous 200 payload.
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          return Response.json({ error: upstreamError }, { status: 502 });
        }
      }
      return Response.json({ count: alerts.length, alerts });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alerts" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Alert Details & Delete
  if (path.includes("/etrade/alerts/") && request.method === "GET") {
    try {
      const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // Issue #2441: alias-record identity for the portfolio read (see
      // the accounts route above).
      const identity = await etradeIdentityFromLogin(ctx.env, userLogin);
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv, undefined, { identity });
      const details = await etrade.fetchAlertDetails(alertId);
      if (!details) {
        // Issue #517: null + recorded client error = upstream failure,
        // not "not found" — 502 naming the cause (#155 pattern, as
        // #243 did for watchlist/details). A genuine not-found (null,
        // no recorded error) keeps the exact previous 404.
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          return Response.json({ error: upstreamError }, { status: 502 });
        }
        return Response.json({ error: "Alert not found" }, { status: 404 });
      }
      return Response.json(details);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alert details" }, { status: 500 });
    }
  }

  if (path.includes("/etrade/alerts/") && request.method === "DELETE") {
    try {
      const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const result = await etrade.deleteAlert(alertId);
      return Response.json(result, { status: result.success ? 200 : 400 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to delete alert" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Product Lookup
  if (path.endsWith("/etrade/lookup") && request.method === "GET") {
    try {
      const search = url.searchParams.get("search") || url.searchParams.get("q") || "";
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const items = await etrade.lookupProduct(search);
      if (items.length === 0) {
        // Issue #243: empty + recorded client error = upstream failure,
        // not "no matches" — 502 naming the cause (#155 pattern). A
        // genuine no-match keeps the exact previous 200 payload.
        const upstreamError = etrade.getLastError();
        if (upstreamError) {
          return Response.json({ error: upstreamError }, { status: 502 });
        }
      }
      return Response.json({ count: items.length, items });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to lookup products" }, { status: 500 });
    }
  }

  // Issue #650: setup catalog browser endpoint.
  if (path.endsWith("/trading/setup-catalog") && request.method === "GET") {
    return handleTradingSetupCatalog();
  }

  // Issue #706: learning store endpoints.
  if (path.endsWith("/learnings") && request.method === "GET") {
    return handleLearningsList(request, url, ctx);
  }
  if (path.endsWith("/learnings") && request.method === "POST") {
    return handleLearningsCreate(request, ctx);
  }

  // Issue #705: reflection job trigger. The weekly guard lives in
  // runReflection (Sunday-only, idempotent per week).
  if (path.endsWith("/reflection/run") && request.method === "POST") {
    return handleReflectionRun(ctx);
  }

  return null;
}
