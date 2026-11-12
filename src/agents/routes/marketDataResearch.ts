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
import { workflowAcceptedResponse } from "../../workflows/screenerWorkflowRoutes";
import { extractCheckoutEmail, submitPaidStockScreenOrNull } from "./paidStockScreenSeam";
import { startStockScreenWorkflowOrNull } from "../../workflows/screenExecutionBroker";
import { runStockScreenViaEngine } from "../../workflows/runStockScreenViaEngine";
import { persistThenDeliverAll } from "../../workflows/screenRunFinalize";
import { buildStockScreenRunSpec, specCanonicalFields, withRunProvenance } from "../../workflows/stockScreenRunSpec";
import type { ScreenerAgent } from "../screener-agent";
import { screenAlreadyRunningDetails } from "../../services/screenInFlight";
import { quotaExceededDetails } from "../../security/userRequestQuota";
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
  /**
   * Issue #3922: optional per-login settings reader (owner:
   * OrchestratorAgent — the readSettingRaw idiom), forwarded
   * to the spec builder's mode admission and the execution
   * broker so the screener ND gate's stored layer resolves on
   * this route too. Absent → env-only admission, as before.
   */
  readSettingRaw?: ((key: string) => string | null) | undefined;
  /** Screener agent (owner: OrchestratorAgent.getScreenerAgent) — issue #1007: the market-data screen runs through the one pipeline via this agent, with the Yahoo data-source adapter as its provider. */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /**
   * Issue #4278: the one engine seam (runStockScreenViaEngine)
   * this route's sync screen runs through. Optional: absent in
   * production construction, the route calls the real seam;
   * tests inject a fake. The field exists only so a test can
   * substitute the seam — it never selects a different engine.
   */
  runStockScreenViaEngine?: import("../../workflows/runStockScreenViaEngine").RunStockScreenViaEngine;
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
    /** Issue #2863: replay criteria/refs (additive; older readers ignore). */
    criteria?: unknown;
    patternRef?: unknown;
    presetRef?: unknown;
    /** Issue #2773: Pareto evaluation (additive). */
    pareto?: unknown;
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
      // Issue #2373 (Slice A): the checkout contact for the paid
      // path only, read before spec building (the seam module
      // strips it like `async` so the strict schema never sees
      // it). Required when monetization is ON; ignored OFF.
      const checkoutEmail = extractCheckoutEmail(request.method, filters, url.searchParams);
      // Issue #2809: dual-mode admission (#2530) and the ONE shared
      // stock-screen schema (#959) are built once here by the
      // single spec builder — ND refuses 400 before any execution
      // path, sync included (never a silent deterministic
      // substitution); the universe/minScore envelope fields are
      // accepted and split out by the builder's parse step.
      const specResult = buildStockScreenRunSpec({
        env: ctx.env,
        method: request.method,
        rawFilters: filters,
        query: url.searchParams,
        asyncRequested,
        source: "market-data",
        readSettingRaw: ctx.readSettingRaw,
      });
      if (!specResult.ok) {
        return Response.json({ error: specResult.error }, { status: 400 });
      }
      const universe = specResult.spec.universe;
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      // Issue #2908 (G1): the builder runs before auth here, so
      // the login is overlaid after it (same spec, no rebuild).
      const spec = withRunProvenance(specResult.spec, { userLogin });
      // Issue #2373 (Slice A): monetization ON routes the
      // screen through the paid seam (sibling module); null =
      // flag OFF, so the broker-or-sync path below runs
      // unchanged.
      const paid = await submitPaidStockScreenOrNull({
        env: ctx.env,
        userLogin,
        checkoutEmail,
        spec,
        auditType: "market_data.screener.payment_started",
        auditAgent: "research",
        audit: ctx.audit,
      });
      if (paid) return paid;
      const agent = ctx.getScreenerAgent(userLogin);
      // Issue #2827: async path via ScreenExecutionBroker
      // (store only, no deliver — the market-data route has
      // no deliver step). Broker null -> fall through to sync.
      // ND throw propagates (fail-closed).
      if (asyncRequested) {
        const started = await startStockScreenWorkflowOrNull({
          env: ctx.env,
          spec,
          readSettingRaw: ctx.readSettingRaw,
          // Market-data previously passed no environment /
          // portfolioContext keys; broker omits them here.
          userLogin,
        });
        if (started) {
          ctx.audit("market_data.screener.enqueued", "research", {
            jobId: started.jobId,
            workflowId: started.handle.workflowId,
            universe,
            provider: "yahoo",
          });
          return workflowAcceptedResponse(started.handle);
        }
      }
      if (universe === "ALL") {
        // Issue #4278: the sharded sync screen runs through the
        // one engine seam (was agent.runSharded). The workflow's
        // own store step owns every SUCCESS shard; a FAILED shard
        // never reached it, so it keeps the #2861 persist-only
        // finalizer (market-data has no deliver step).
        const { results: shards } = await (ctx.runStockScreenViaEngine ?? runStockScreenViaEngine)({
          env: ctx.env,
          spec,
          userLogin,
          readSettingRaw: ctx.readSettingRaw,
          agent,
        });
        await persistThenDeliverAll({
          results: shards.filter((r) => !r.success),
          // Issue #2863: record the run's criteria with each shard's canonical copy.
          persist: (r) => ctx.persistScreenerReportCanonical({ ...r, userLogin, criteria: spec.filters, ...specCanonicalFields(spec) }),
        });
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
        // Issue #4278: the sync screen runs through the one engine
        // seam (was agent.runScreen) — same spec (the provider
        // rides the command), same agent, same throw contract
        // below (429s, quota, rethrow).
        const outcome = await (ctx.runStockScreenViaEngine ?? runStockScreenViaEngine)({
          env: ctx.env,
          spec,
          userLogin,
          readSettingRaw: ctx.readSettingRaw,
          agent,
        });
        result = outcome.results[0];
      } catch (screenErr) {
        // Issue #832 parity with /etrade/screen: "already running" is
        // not a failure — a 429 the client can retry.
        // #2840: the 429 also names the in-flight run (id + status).
        const error = screenErr instanceof Error ? screenErr.message : String(screenErr);
        if (error.includes("already running")) {
          const details = screenAlreadyRunningDetails(screenErr);
          return Response.json(
            { error: "Screen already running", message: error, retryable: true, runId: details?.runId ?? null, status: details?.status ?? "running" },
            { status: 429 }
          );
        }
        // Issue #2842: quota refusal (429 with limit/usage/reset)
        // and counter failure (fail-closed 503) — never a run
        // result, never an uncounted run.
        if (error.includes("quota exceeded")) {
          const details = quotaExceededDetails(screenErr);
          return Response.json(
            { error: "Request quota exceeded", message: error, retryable: true, limit: details?.limit ?? null, usage: details?.usage ?? null, window: details?.window ?? null, resetAt: details?.resetAtIso ?? null, resetAtMs: details?.resetAtMs ?? null },
            { status: 429 }
          );
        }
        if (error.includes("quota unavailable")) {
          return Response.json(
            { error: "Request quota unavailable", message: error, retryable: true },
            { status: 503 }
          );
        }
        throw screenErr;
      }
      // Issue #4278: a SUCCESS result was already stored by the
      // workflow's own store step — persisting it here would twin
      // the row. A FAILED result never reached that step, so it
      // keeps the #307/#308 + #1007 canonical-copy persist (one
      // row per generation, provider provenance in the body).
      if (!result.success) {
        await persistThenDeliverAll({
          results: [result],
          // Issue #2863: record the run's criteria with the canonical copy.
          persist: (r) => ctx.persistScreenerReportCanonical({ ...r, userLogin, criteria: spec.filters, ...specCanonicalFields(spec) }),
        });
      }
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
        filterApplied: spec.filters,
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
