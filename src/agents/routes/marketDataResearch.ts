/**
 * Issue #359-14: market-data research routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the non-alpaca market-data research & quoting routes in two groups
 * (invoked at their exact original positions in routeRequest's sequential
 * matching sequence).
 * #1906: each canonical /market-data/* path keeps its deprecated /foss/*
 * alias on the same handler and response; use canonical paths instead.
 * Alias removal is a follow-up.
 *
 * Group 1 (before the slice #359-13 handleAlpacaMarketDataRoutes delegation):
 *   GET         /market-data/quote
 *   GET         /market-data/fundamentals
 *   GET         /market-data/bars
 *   GET         /market-data/research
 *
 * Group 2 (after the slice #359-13 handleAlpacaMarketDataRoutes delegation):
 *   POST|GET    /market-data/compare
 *   GET         /market-data/providers
 *   POST|GET    /market-data/screen, /yfinance/screen
 *
 * The alpaca-named market-data routes (/market-data/snapshot, /market-data/alpaca/*) stay owned
 * by slice #359-13's handleAlpacaMarketDataRoutes - this module never handles
 * them.
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * MarketDataResearchRouteContext parameter; there are no new globals and no
 * back-references into the class. Audit events stay funneled through the
 * single-owner recordAudit() via ctx.audit (no behavior change to audit
 * semantics). Issue #1007: the screen block now stores its canonical
 * report through the #308 seam via ctx.persistScreenerReportCanonical
 * (the REST idiom), like the E*TRADE screen route;
 * generateResearchReport still carries its own persistence inside the
 * service.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { MarketDataResearchService, marketDataResearchBarsSourceLabel } from "../../services/marketDataResearch";
import {
  resolveMarketDataRestSwitch,
  marketDataQuoteAuditEvent,
  marketDataFundamentalsAuditEvent,
  marketDataResearchAuditEvent,
  marketDataBarsAuditEvent,
} from "../../config/marketDataModes";
import { parseStockScreenRequest, shardableUniverses } from "../../trading";
import {
  manualWorkflowJobId,
  screenModeFieldsFromRequest,
  screenModeSelectionFromFields,
  tryStartScreenerWorkflow,
  workflowAcceptedResponse,
  workflowTenantId,
} from "../../workflows/screenerWorkflowRoutes";
import type { ScreenerAgent } from "../screener-agent";
import type { AgentName, Env } from "../../types";

/** The subset of OrchestratorAgent surface the market-data research handlers need. */
export interface MarketDataResearchRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `ctx.env`). */
  env: Env;
  /** Single-owner audit funnel (owner: OrchestratorAgent.recordAudit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** #1727: optional session/user carriers for the market-data switches (run comes from query `?mode=`, global env from `env`). Populated by the execution-context owner; unset carriers fall through to env. See src/config/marketDataModes.ts. */
  scopedMarketDataModes?: import("../../config/marketDataModes").MarketDataScopedModes;
  /** Screener agent (owner: OrchestratorAgent.getScreenerAgent) — issue #1007: the market-data screen runs through the one pipeline via this agent, with the Yahoo data-source adapter as its provider. */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /** Canonical-copy screener persistence (owner: OrchestratorAgent.persistScreenerReportCanonical) — the REST idiom the E*TRADE screen route stores through. */
  persistScreenerReportCanonical(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    provider?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    pdfKey?: string;
    error?: string;
    trigger?: unknown;
    userLogin?: string;
  }): Promise<void>;
}

/** #1727: adapts this module's route context to the marketDataModes switch host (the ctx audit type is narrower than the host's, so it is wrapped rather than passed through). */
function marketDataSwitchHost(ctx: MarketDataResearchRouteContext) {
  return {
    scopedMarketDataModes: ctx.scopedMarketDataModes,
    env: ctx.env,
    audit: (type: string, agent: any, payload: Record<string, unknown>) => ctx.audit(type, agent, payload),
  };
}

/**
 * Non-alpaca market-data research & quoting routes (quote, fundamentals,
 * bars, research). Invoked from routeRequest at the exact position the
 * original blocks occupied (before the handleAlpacaMarketDataRoutes delegation);
 * returns a Response when one of the owned paths matches, or null to
 * continue sequential matching.
 */
export async function handleMarketDataQuoteResearchRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: MarketDataResearchRouteContext
): Promise<Response | null> {
  // Real-time quote (Yahoo Finance, Alpaca, or Hybrid)
  // #1727 F01: quote mode (run `?mode=` > session > user > env >
  // rest legacy). mcp mode = the MCP command's contract (symbol
  // required, 400 when missing, market_data.quote.fetched audit); rest
  // mode = this route's legacy (NVDA default, no audit).
  if ((path.endsWith("/market-data/quote") || path.endsWith("/foss/quote")) && request.method === "GET") {
    try {
      const quoteMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "quote", url.searchParams.get("mode"), "rest");
      const symbol = quoteMode === "mcp" ? (url.searchParams.get("symbol") || "") : (url.searchParams.get("symbol") || "NVDA");
      if (quoteMode === "mcp" && !symbol.trim()) {
        return Response.json({ error: "symbol is required" }, { status: 400 });
      }
      const provider = (url.searchParams.get("provider") || "hybrid") as any;
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const quote = await marketDataResearch.getQuote(symbol, provider);
      const event = marketDataQuoteAuditEvent(quoteMode);
      if (event) ctx.audit(event, "research", { symbol, provider: quote.provider, price: quote.price, provenance: quote.provenance });
      return Response.json(quote);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch market-data quote" }, { status: 500 });
    }
  }

  // Company fundamentals & valuation metrics (yfinance)
  // #1727 F01: fundamentals mode, same shape as quote (mcp =
  // required + market_data.fundamentals.fetched audit; rest = NVDA
  // default, no audit).
  if ((path.endsWith("/market-data/fundamentals") || path.endsWith("/foss/fundamentals")) && request.method === "GET") {
    try {
      const fundamentalsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "fundamentals", url.searchParams.get("mode"), "rest");
      const symbol = fundamentalsMode === "mcp" ? (url.searchParams.get("symbol") || "") : (url.searchParams.get("symbol") || "NVDA");
      if (fundamentalsMode === "mcp" && !symbol.trim()) {
        return Response.json({ error: "symbol is required" }, { status: 400 });
      }
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const fundamentals = await marketDataResearch.getFundamentals(symbol);
      const event = marketDataFundamentalsAuditEvent(fundamentalsMode);
      if (event) ctx.audit(event, "research", { symbol, marketCap: fundamentals.marketCap, pe: fundamentals.peTrailing, provenance: fundamentals.provenance });
      return Response.json(fundamentals);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch fundamentals" }, { status: 500 });
    }
  }

  // Historical OHLCV bars (yfinance / Alpaca)
  // #1727 F02: bars mode. mcp = the MCP command's contract (no
  // provider input — service default — small envelope, audit
  // market_data.bars.fetched); rest = this route's legacy (explicit
  // provider default yfinance, fuller envelope, no audit).
  // Issue #1888: the bars route's canonical path is now
  // /market-data/bars; the legacy /market-data/bars path is retained as a
  // backwards-compatible alias (same handler, same response).
  if ((path.endsWith("/market-data/bars") || path.endsWith("/foss/bars")) && request.method === "GET") {
    try {
      const barsMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "bars", url.searchParams.get("mode"), "rest");
      const symbol = barsMode === "mcp" ? (url.searchParams.get("symbol") || "") : (url.searchParams.get("symbol") || "NVDA");
      if (barsMode === "mcp" && !symbol.trim()) {
        return Response.json({ error: "symbol is required" }, { status: 400 });
      }
      const timeframe = url.searchParams.get("timeframe") || "1D";
      const limit = Number(url.searchParams.get("limit") || "30");
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      if (barsMode === "mcp") {
        const bars = await marketDataResearch.getHistoricalBars(symbol, timeframe, limit);
        const provenance = bars[0]?.provenance ?? "generated";
        const event = marketDataBarsAuditEvent("mcp");
        if (event) ctx.audit(event, "research", { symbol, count: bars.length, provenance });
        return Response.json({ symbol: symbol.toUpperCase(), count: bars.length, provenance, bars });
      }
      const provider = (url.searchParams.get("provider") || "yfinance") as "yfinance" | "alpaca" | "hybrid";
      const bars = await marketDataResearch.getHistoricalBars(symbol, timeframe, limit, provider);
      // Issue #117: `source` is stamped from the bars' actual provenance —
      // a provider API name only when the bars were really fetched live;
      // generated/static fallback bars are labelled as such, and the
      // provenance rides in the response alongside the per-bar fields.
      const provenance = bars[0]?.provenance ?? "generated";
      return Response.json({
        symbol: symbol.toUpperCase(),
        provider,
        timeframe,
        count: bars.length,
        bars,
        provenance,
        source: marketDataResearchBarsSourceLabel(provider, provenance),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch historical bars" }, { status: 500 });
    }
  }

  // Comprehensive equity research report with Agent DID stamp
  // #1727 F01: research mode. mcp = market_data.research.generated audit
  // + required symbol; rest = market_data.research_generated audit (the
  // canonical spelling, see src/config/marketDataModes.ts) + NVDA
  // default. The payload shape is identical in both modes.
  if ((path.endsWith("/market-data/research") || path.endsWith("/foss/research")) && request.method === "GET") {
    try {
      const researchMode = resolveMarketDataRestSwitch(marketDataSwitchHost(ctx), "research", url.searchParams.get("mode"), "rest");
      const symbol = researchMode === "mcp" ? (url.searchParams.get("symbol") || "") : (url.searchParams.get("symbol") || "NVDA");
      if (researchMode === "mcp" && !symbol.trim()) {
        return Response.json({ error: "symbol is required" }, { status: 400 });
      }
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const report = await marketDataResearch.generateResearchReport(symbol);
      ctx.audit(marketDataResearchAuditEvent(researchMode), "research", { symbol, rating: report.analystRating, did: report.agentAttestation.did, provenance: report.provenance });
      return Response.json(report);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to generate research report" }, { status: 500 });
    }
  }

  return null;
}

/**
 * Non-alpaca market-data comparison, provider status, and screening routes.
 * Invoked from routeRequest at the exact position the original blocks
 * occupied (after the handleAlpacaMarketDataRoutes delegation); returns a
 * Response when one of the owned paths matches, or null to continue
 * sequential matching.
 */
export async function handleMarketDataCompareScreenRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: MarketDataResearchRouteContext
): Promise<Response | null> {
  // Multi-ticker valuation comparison
  if ((path.endsWith("/market-data/compare") || path.endsWith("/foss/compare")) && (request.method === "POST" || request.method === "GET")) {
    try {
      let symbols = ["NVDA", "AAPL", "MSFT"];
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as any;
        if (Array.isArray(body.symbols) && body.symbols.length > 0) {
          symbols = body.symbols;
        }
      } else {
        const symParam = url.searchParams.get("symbols");
        if (symParam) symbols = symParam.split(",").map(s => s.trim());
      }
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const comparison = await marketDataResearch.compareStocks(symbols);
      return Response.json({ count: comparison.length, comparison });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to compare stocks" }, { status: 500 });
    }
  }

  // market-data provider statuses (Yahoo Finance + Alpaca)
  if ((path.endsWith("/market-data/providers") || path.endsWith("/foss/providers")) && request.method === "GET") {
    try {
      const marketDataResearch = new MarketDataResearchService(ctx.env);
      const statuses = marketDataResearch.getProviderStatuses();
      return Response.json({ providers: statuses });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch market-data providers" }, { status: 500 });
    }
  }

  // Dedicated Yahoo Finance Market Screener
  // Issue #1007 (consolidation S3): this route no longer runs a second
  // screening engine. It executes through the ONE stock pipeline via
  // ScreenerAgent with provider "yahoo" (the Yahoo data-source adapter
  // inside screenerPipeline.acquireUniverse), so scoring, result shape
  // and persistence are the pipeline's — identical to the E*TRADE
  // screen — and the run stores a canonical mas_reports report in the
  // REST idiom (persistScreenerReportCanonical, the seam the
  // /etrade/screen route uses), with provider provenance in the body.
  // Yahoo unavailable → the run fails visibly (502, the REST screen
  // idiom); no fallback to E*TRADE data, no fabricated rows.
  if ((path.endsWith("/market-data/screen") || path.endsWith("/foss/screen") || path.endsWith("/yfinance/screen")) && (request.method === "POST" || request.method === "GET")) {
    try {
      const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
      if (request.method === "GET") {
        if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
        if (url.searchParams.get("search")) filters.search = url.searchParams.get("search");
        if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
        if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
        if (url.searchParams.get("maxPeRatio")) filters.maxPeRatio = Number(url.searchParams.get("maxPeRatio"));
        if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
        if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
        if (url.searchParams.get("universe")) filters.universe = url.searchParams.get("universe");
      }
      // Issue #1737: the async flag rides the POST body or the
      // GET query; stripped before schema validation.
      const asyncRequested =
        request.method === "POST"
          ? (filters as { async?: unknown }).async === true
          : url.searchParams.get("async") === "1";
      if (request.method === "POST") delete (filters as { async?: unknown }).async;
      // Issue #2530: dual-mode fields, stripped like `async`
      // and validated here: ND refuses 400 before any
      // execution path — sync included (never a silent
      // deterministic substitution).
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
      // Issue #959: the market-data screen takes the same StockScreenerFilter
      // shape as the E*TRADE screen — validate through the ONE shared
      // stock-screen schema (the universe/minScore envelope fields are
      // accepted and split out).
      const parsedScreen = parseStockScreenRequest(filters);
      if (!parsedScreen.ok) {
        return Response.json({ error: parsedScreen.error }, { status: 400 });
      }
      const universe = parsedScreen.value.universe;
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      const agent = ctx.getScreenerAgent(userLogin);
      // Issue #1737: async path (store only, no deliver — the
      // market-data route has no deliver step). Unbound → fall
      // through to the synchronous path below.
      if (asyncRequested) {
        const jobId = manualWorkflowJobId(universe);
        const shards =
          universe === "ALL"
            ? shardableUniverses().map((u) => ({ shardId: u, universe: u }))
            : [{ shardId: universe, universe }];
        const handle = await tryStartScreenerWorkflow(ctx.env, {
          jobId,
          type: "run-screen",
          source: "manual",
          trigger: "manual",
          userLogin,
          role: "parent",
          tenantId: workflowTenantId(ctx.env),
          shards,
          provider: "yahoo",
          deliver: false,
          filters: parsedScreen.value.filters as unknown as Record<string, unknown>,
          ...(modeSelection.screenMode
            ? { screenMode: modeSelection.screenMode, screenIntent: modeSelection.screenIntent }
            : {}),
        });
        if (handle) {
          ctx.audit("market_data.screener.enqueued", "research", {
            jobId,
            workflowId: handle.workflowId,
            universe,
            provider: "yahoo",
          });
          return workflowAcceptedResponse(handle);
        }
      }
      if (universe === "ALL") {
        const shards = await agent.runSharded({
          trigger: "manual",
          provider: "yahoo",
          filters: parsedScreen.value.filters,
          userLogin,
        });
        for (const r of shards) await ctx.persistScreenerReportCanonical({ ...r, userLogin });
        const failedShards = shards.filter((r) => !r.success);
        ctx.audit("market_data.screener.executed", "research", {
          filterSummary: `ALL (sharded: ${shards.length} universes)`,
          count: shards.reduce((n, r) => n + r.allStocks.length, 0),
          provider: "yahoo",
          success: failedShards.length < shards.length,
        });
        if (failedShards.length === shards.length) {
          return Response.json({ error: failedShards[0]?.error || "Yahoo Finance unavailable" }, { status: 502 });
        }
        return Response.json({
          sharded: true,
          provider: "yahoo",
          universes: shards.map((r) => ({
            universe: r.universe,
            provider: r.provider,
            totalScanned: r.totalScanned,
            matchedCount: r.matchedCount,
            opportunities: r.opportunities,
            stocks: r.allStocks,
            results: r.allStocks,
            discoveryMessage: r.discoveryMessage,
            scannedAt: r.timestamp,
            reportUrl: r.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(r.pdfKey)}` : undefined,
            success: r.success,
            error: r.error,
          })),
        });
      }
      let result;
      try {
        result = await agent.runScreen({
          trigger: "manual",
          provider: "yahoo",
          filters: parsedScreen.value.filters,
          universe: universe as any,
          userLogin,
        });
      } catch (screenErr) {
        // Issue #832 parity with /etrade/screen: "already running" is
        // not a failure — a 429 the client can retry.
        const error = screenErr instanceof Error ? screenErr.message : String(screenErr);
        if (error.includes("already running")) {
          return Response.json(
            { error: "Screen already running", message: error, retryable: true },
            { status: 429 }
          );
        }
        throw screenErr;
      }
      // Issue #307/#308 + #1007: store the canonical report copy (one
      // row per generation) so market-data runs are visible in GET /api/reports
      // and Reports history, with provider provenance in the body.
      await ctx.persistScreenerReportCanonical({ ...result, userLogin });
      ctx.audit("market_data.screener.executed", "research", {
        filterSummary: result.filterSummary,
        count: result.allStocks.length,
        provider: "yahoo",
        success: result.success,
      });
      if (!result.success) {
        return Response.json({ error: result.error || "Yahoo Finance unavailable" }, { status: 502 });
      }
      return Response.json({
        universe: result.universe,
        provider: "yahoo",
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunities: result.opportunities,
        stocks: result.allStocks,
        results: result.allStocks,
        filterApplied: parsedScreen.value.filters,
        filterSummary: result.filterSummary,
        discoveryMessage: result.discoveryMessage,
        scannedAt: result.timestamp,
        pdfKey: result.pdfKey,
        pdfStatus: result.pdfStatus,
        pdfError: result.pdfError,
        reportUrl: result.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}` : undefined,
        xlsxKey: result.xlsxKey,
        xlsxStatus: result.xlsxStatus,
        xlsxUrl: result.xlsxKey ? `/api/screener/report.xlsx?key=${encodeURIComponent(result.xlsxKey)}` : undefined,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to run Yahoo Finance screener" }, { status: 500 });
    }
  }

  return null;
}
