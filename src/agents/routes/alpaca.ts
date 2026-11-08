/**
 * Issue #359-13: alpaca routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the alpaca-named route blocks in two groups (invoked at their exact
 * original positions in routeRequest's sequential matching sequence).
 * #1906: each canonical /market-data/* path keeps its deprecated /foss/*
 * alias on the same handler and response; use canonical paths instead.
 * Alias removal is a follow-up.
 *
 * Group 1 (after the watchlists delegation): the "Alpaca Trading API v2
 * Endpoints" section —
 *   POST        /trading/alpaca/order
 *   GET         /trading/alpaca/account
 *   GET         /trading/alpaca/positions
 *   GET         /trading/alpaca/orders
 *
 * Group 2 (between the /market-data/research block and the /market-data/compare block):
 * the alpaca-named market-data routes (the non-alpaca /market-data/quote, /market-data/fundamentals,
 * /market-data/bars, /market-data/research and /market-data/compare blocks moved to slice
 * #359-14's market-data research module — src/agents/routes/marketDataResearch.ts) —
 *   GET         /market-data/snapshot
 *   GET         /market-data/alpaca/account
 *   GET         /market-data/alpaca/positions
 *   GET         /market-data/alpaca/orders
 *   POST        /market-data/alpaca/order
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * AlpacaRouteContext parameter; there are no new globals and no
 * back-references into the class. Audit events stay funneled through the
 * single-owner recordAudit() via ctx.audit (no behavior change to audit
 * semantics). Alpaca credential handling is byte-identical — the module
 * constructs MarketDataResearchService exactly as the inline blocks did.
 */

import { MarketDataResearchService } from "../../services/marketDataResearch";
import { codedMessage } from "../../outcomes/outcomeAspects";
import type { AgentName, Env } from "../../types";
import {
  resolveMarketDataRestSwitch,
  marketDataSnapshotAudit,
  marketDataReadsAuditEvent,
  normalizeMarketDataOrderInput,
  marketDataOrderAuditEvent,
  marketDataOrderAuditPayload,
} from "../../config/marketDataModes";

/** The subset of OrchestratorAgent surface the alpaca handlers need. */
export interface AlpacaRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `ctx.env`). */
  env: Env;
  /** Single-owner audit funnel (owner: OrchestratorAgent.recordAudit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** #1727: optional session/user carriers for the market-data switches (run comes from query `?mode=` / body `mode`, global env from `env`). Populated by the execution-context owner; unset carriers fall through to env. See src/config/marketDataModes.ts. */
  scopedMarketDataModes?: import("../../config/marketDataModes").MarketDataScopedModes;
}

/**
 * Issue #3197: Alpaca non-placement reads surface AOP outcome-encoded
 * errors, never raw provider messages. One code covers the read
 * surface: its business message already tells the user to verify
 * credentials, which covers both the unconfigured-keys and the
 * upstream-rejection cases without string-matching provider text.
 * The order-placement routes are #3158's domain and do NOT use this.
 */
function alpacaUpstreamOutcome(): { error: string; code: string } {
  return { error: codedMessage("FAILURE_ALPACA_UPSTREAM"), code: "FAILURE_ALPACA_UPSTREAM" };
}

/** Same mapping for a service result: a !success read keeps its shape and gains the outcome fields, with the raw provider message replaced. */
function withAlpacaOutcome<T extends { success: boolean; message?: string }>(
  result: T,
): T & { error?: string; code?: string } {
  if (result.success) return result;
  const outcome = alpacaUpstreamOutcome();
  return { ...result, message: outcome.error, error: outcome.error, code: outcome.code };
}

/** #1727: adapts this module's route context to the marketDataModes switch host (the ctx audit type is narrower than the host's, so it is wrapped rather than passed through). */
function marketDataSwitchHost(ctx: AlpacaRouteContext) {
  return {
    scopedMarketDataModes: ctx.scopedMarketDataModes,
    env: ctx.env,
    audit: (type: string, agent: any, payload: Record<string, unknown>) => ctx.audit(type, agent, payload),
  };
}

/**
 * Alpaca Trading API v2 Endpoints. Invoked from routeRequest at the exact position the original blocks occupied (after the watchlists delegation); returns a Response when one of the /trading/alpaca paths matches, or null to continue sequential matching.
 */
export async function handleAlpacaTradingRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AlpacaRouteContext
): Promise<Response | null> {
  // ==========================================
  // Alpaca Trading API v2 Endpoints
  // ==========================================

  // Place Alpaca Live / Paper Order
  // #1727 F05: order mode (run body `mode` > session > user > env >
  // trading legacy). The route's own 400 wording ("Stock symbol is
  // required") and the trading normalization stay the default; market-data
  // mode selects /market-data normalization + full audit, mcp mode selects
  // verbatim input + alpaca.order.place. No HITL gate exists on this
  // path; the switch changes normalization + audit only.
  if (path.endsWith("/trading/alpaca/order") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "order", body.mode, "trading");
      const normalized = normalizeMarketDataOrderInput(body, orderMode);

      if (!normalized.symbol || !String(normalized.symbol).trim()) {
        return Response.json({ error: "Stock symbol is required" }, { status: 400 });
      }

      const marketDataResearch = new MarketDataResearchService(ctx.env);
      // Issue #3782: the REST caller supplies the limit price in the
      // request body, so the placement declares user provenance for
      // the guard in placeOrder.
      const orderResult = await marketDataResearch.placeAlpacaOrder({ ...normalized, priceSource: { kind: "user" } });

      ctx.audit(marketDataOrderAuditEvent(orderMode), "trading", marketDataOrderAuditPayload(orderMode, normalized, orderResult));
      return Response.json(orderResult);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to place Alpaca order" }, { status: 500 });
    }
  }

  // Get Alpaca Account & Buying Power
  // #1727 F04: reads mode, default none (this route's legacy: no
  // read audit). An explicit mode selects the mcp (query) or rest
  // (queried) audit; #1733 keeps the twin default question.
  if (path.endsWith("/trading/alpaca/account") && request.method === "GET") {
    try {
      const readsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "reads", url.searchParams.get("mode"), "none");
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const account = await marketDataResearch.getAlpacaAccount();
      const event = marketDataReadsAuditEvent(readsMode, "account");
      if (event) {
        ctx.audit(event, "trading", {
          success: account.success,
          accountId: account.account?.id,
          buyingPower: account.account?.buying_power,
          portfolioValue: account.account?.portfolio_value,
        });
      }
      return Response.json(withAlpacaOutcome(account));
    } catch (err: any) {
      return Response.json(alpacaUpstreamOutcome(), { status: 500 });
    }
  }

  // Get Alpaca Open Positions
  if (path.endsWith("/trading/alpaca/positions") && request.method === "GET") {
    try {
      const readsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "reads", url.searchParams.get("mode"), "none");
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const positions = await marketDataResearch.getAlpacaPositions();
      const event = marketDataReadsAuditEvent(readsMode, "positions");
      if (event) {
        ctx.audit(event, "trading", {
          success: positions.success,
          count: positions.positions?.length || 0,
          symbols: positions.positions?.map((p: any) => p.symbol) || [],
        });
      }
      return Response.json(withAlpacaOutcome(positions));
    } catch (err: any) {
      return Response.json(alpacaUpstreamOutcome(), { status: 500 });
    }
  }

  // Get Alpaca Orders List
  if (path.endsWith("/trading/alpaca/orders") && request.method === "GET") {
    try {
      const readsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "reads", url.searchParams.get("mode"), "none");
      const status = (url.searchParams.get("status") || "open") as any;
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const orders = await marketDataResearch.getAlpacaOrders(status);
      const event = marketDataReadsAuditEvent(readsMode, "orders");
      if (event) {
        ctx.audit(event, "trading", {
          status,
          count: orders.orders?.length || 0,
        });
      }
      return Response.json(withAlpacaOutcome(orders));
    } catch (err: any) {
      return Response.json(alpacaUpstreamOutcome(), { status: 500 });
    }
  }

  return null;
}
/**
 * Alpaca-named market-data routes. Invoked from routeRequest at the exact position the original blocks occupied (between /market-data/research and /market-data/compare); returns a Response when one of the alpaca market-data paths matches, or null to continue sequential matching.
 */
export async function handleAlpacaMarketDataRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AlpacaRouteContext
): Promise<Response | null> {
  // Alpaca real-time market snapshot & NBBO spread
  // #1727 F03: snapshot mode (run `?mode=` > session > user > env
  // > rest legacy). mcp = required symbol (400 when missing) +
  // alpaca.snapshot audit; rest = NVDA default +
  // alpaca.snapshot_queried audit.
  if ((path.endsWith("/market-data/snapshot") || path.endsWith("/foss/snapshot")) && request.method === "GET") {
    try {
      const snapshotMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "snapshot", url.searchParams.get("mode"), "rest");
      const symbol = snapshotMode === "mcp" ? (url.searchParams.get("symbol") || "") : (url.searchParams.get("symbol") || "NVDA");
      if (snapshotMode === "mcp" && !symbol.trim()) {
        return Response.json({ error: "symbol is required" }, { status: 400 });
      }
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const snapshot = await marketDataResearch.getAlpacaSnapshot(symbol);
      const [event, payload] = marketDataSnapshotAudit(snapshotMode, symbol, snapshot);
      ctx.audit(event, "trading", payload);
      return Response.json(snapshot);
    } catch (err) {
      return Response.json(alpacaUpstreamOutcome(), { status: 500 });
    }
  }

  // Alpaca Trading v2: Account Status & Balance with Agentic Tracing
  // #1727 F04: reads mode, default rest (this route's legacy
  // *_queried audit). mcp selects the *.query audit, none silences.
  if ((path.endsWith("/market-data/alpaca/account") || path.endsWith("/foss/alpaca/account")) && request.method === "GET") {
    try {
      const readsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "reads", url.searchParams.get("mode"), "rest");
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const result = await marketDataResearch.getAlpacaAccount();
      const event = marketDataReadsAuditEvent(readsMode, "account");
      if (event) {
        ctx.audit(event, "trading", {
          success: result.success,
          accountId: result.account?.id,
          buyingPower: result.account?.buying_power,
          portfolioValue: result.account?.portfolio_value,
        });
      }
      return Response.json(withAlpacaOutcome(result));
    } catch (err) {
      return Response.json(alpacaUpstreamOutcome(), { status: 500 });
    }
  }

  // Alpaca Trading v2: Portfolio Positions with Agentic Tracing
  if ((path.endsWith("/market-data/alpaca/positions") || path.endsWith("/foss/alpaca/positions")) && request.method === "GET") {
    try {
      const readsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "reads", url.searchParams.get("mode"), "rest");
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const result = await marketDataResearch.getAlpacaPositions();
      const event = marketDataReadsAuditEvent(readsMode, "positions");
      if (event) {
        ctx.audit(event, "trading", {
          success: result.success,
          count: result.positions?.length || 0,
          symbols: result.positions?.map((p: any) => p.symbol) || [],
        });
      }
      return Response.json(withAlpacaOutcome(result));
    } catch (err) {
      return Response.json(alpacaUpstreamOutcome(), { status: 500 });
    }
  }

  // Alpaca Trading v2: Order History Ledger with Agentic Tracing
  if ((path.endsWith("/market-data/alpaca/orders") || path.endsWith("/foss/alpaca/orders")) && request.method === "GET") {
    try {
      const readsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "reads", url.searchParams.get("mode"), "rest");
      const status = (url.searchParams.get("status") || "open") as "open" | "closed" | "all";
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const result = await marketDataResearch.getAlpacaOrders(status);
      const event = marketDataReadsAuditEvent(readsMode, "orders");
      if (event) {
        ctx.audit(event, "trading", {
          status,
          count: result.orders?.length || 0,
        });
      }
      return Response.json(withAlpacaOutcome(result));
    } catch (err) {
      return Response.json(alpacaUpstreamOutcome(), { status: 500 });
    }
  }

  // Alpaca Trading v2: Place Order with Agent DID Attestation & Agentic Tracing
  // #1727 F05: order mode (run body `mode` > session > user > env >
  // market-data legacy). The route's own 400 wording ("Symbol is
  // required") stays in every mode; trading mode selects /trading
  // normalization + minimal audit, mcp mode selects verbatim input
  // + alpaca.order.place.
  if ((path.endsWith("/market-data/alpaca/order") || path.endsWith("/foss/alpaca/order")) && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "order", body.mode, "market-data");
      const normalized = normalizeMarketDataOrderInput(body, orderMode);

      if (!normalized.symbol || !String(normalized.symbol).trim()) {
        return Response.json({ error: "Symbol is required" }, { status: 400 });
      }

      const marketDataResearch = new MarketDataResearchService(ctx.env);
      // Issue #3782: the REST caller supplies the limit price in the
      // request body, so the placement declares user provenance for
      // the guard in placeOrder.
      const result = await marketDataResearch.placeAlpacaOrder({ ...normalized, priceSource: { kind: "user" } });

      ctx.audit(marketDataOrderAuditEvent(orderMode), "trading", marketDataOrderAuditPayload(orderMode, normalized, result));

      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to place Alpaca order" }, { status: 500 });
    }
  }
  return null;
}
