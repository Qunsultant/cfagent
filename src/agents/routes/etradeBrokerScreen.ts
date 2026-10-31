/**
 * Issue #995: E*TRADE broker route sub-domain module, split out of
 * src/agents/routes/etradeBroker.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeBroker.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the equity screen execution (post-parse tail)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { parseStockScreenRequest, shardableUniverses } from "../../trading";
import { screenerOutcomeFromRunResult } from "../../services/screenerFollowups";
import { isPortfolioContextEnabled } from "../../services/screeningFlags";
import type { ETradeService } from "../../services/etrade";
import {
  manualWorkflowJobId,
  tryStartScreenerWorkflow,
  workflowAcceptedResponse,
  workflowTenantId,
} from "../../workflows/screenerWorkflowRoutes";
import { publishManualScreenerRun } from "./etradeBroker";
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import type { ScreenerAgent } from "../screener-agent";

/**
 * Issue #1123: one publication decision for a finished manual screen —
 * job-run screens defer entirely (the tracked pipeline owns the run);
 * synchronous screens bridge into the pipeline when the host provides
 * the bridge; the legacy inline publishers remain only as the
 * fallback for hosts that provide neither.
 */
async function publishOrBridge(
  ctx: EtradeBrokerRouteContext,
  userLogin: string,
  result: unknown,
  emailTo?: string,
): Promise<void> {
  if (ctx.asyncJobId) return;
  const enriched = emailTo && result && typeof result === "object"
    ? { ...(result as Record<string, unknown>), emailTo }
    : result;
  if (ctx.scheduleScreenerFollowups) {
    await ctx.scheduleScreenerFollowups(
      screenerOutcomeFromRunResult("stock", enriched as Record<string, unknown>, ctx.env.APP_BASE_URL),
      userLogin,
    );
    return;
  }
  await publishManualScreenerRun(ctx.env, ctx.getOrm(), userLogin, enriched as any);
}

type StockScreenValue = Extract<ReturnType<typeof parseStockScreenRequest>, { ok: true }>["value"];

/**
 * #1726 E01: the REST /etrade/screen listings branch body. The
 * dispatcher owns the condition and the ETradeService construction
 * (the #995 ledger); this function only runs the listings engine
 * (the MCP scan engine) and audits market_scanned. It never
 * constructs the ScreenerAgent. Takes the constructed service as a
 * parameter so this split module constructs no ETradeService.
 */
export async function executeEtradeScreenListings(args: {
  ctx: EtradeBrokerRouteContext;
  etrade: ETradeService;
  filters: any;
}): Promise<Response> {
  const { ctx, etrade, filters } = args;
  const result = await etrade.screenMarketsAsync({
    exchange: filters.exchange,
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
    minMarketCap: filters.minMarketCap,
    gainersOnly: filters.gainersOnly,
    losersOnly: filters.losersOnly,
    search: filters.search,
    limit: filters.limit,
  });
  ctx.audit("etrade.market_scanned", "trading", {
    matchedCount: (result as any).matchedCount,
    exchange: filters.exchange,
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
  });
  return Response.json(result);
}

export async function executeEtradeScreen(args: {
  ctx: EtradeBrokerRouteContext;
  sessionId: string;
  requestedEnv: "TEST" | "PROD" | undefined;
  userLogin: string;
  agent: ScreenerAgent;
  universe: StockScreenValue["universe"];
  validatedFilters: StockScreenValue["filters"];
  /** Issue #1737: opt-in async path — start a workflow, return 202, never await the scan. */
  asyncRequested?: boolean;
  emailTo?: string;
  /**
   * Issue #2530: an admitted ND selection (validated at the
   * route by screenModeSelectionFromFields); rides the async
   * workflow command. The route guarantees asyncRequested
   * when this is present.
   */
  screenMode?: "non-deterministic";
  screenIntent?: string;
}): Promise<Response> {
  const { ctx, sessionId, requestedEnv, userLogin, agent, universe, validatedFilters, emailTo } = args;
  // Issue #17: the portfolio-context flag is read here (orchestrator
  // storage owns mas_settings; the screener agent cannot read it) and
  // rides the run request — runSharded spreads it onto every shard.
  const portfolioContext = isPortfolioContextEnabled(ctx.readSettingRaw);
  // Issue #1737: async path. Shards mirror runSharded (ALL →
  // shardableUniverses, else one shard); the workflow owns
  // store + deliver per shard, so nothing is persisted,
  // published, or audited-as-complete here. Unbound → null
  // → fall through to the synchronous path below.
  if (args.asyncRequested) {
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
      deliver: true,
      filters: validatedFilters as unknown as Record<string, unknown>,
      environment: requestedEnv,
      portfolioContext,
      ...(args.screenMode
        ? { screenMode: args.screenMode, screenIntent: args.screenIntent }
        : {}),
    });
    if (handle) {
      ctx.audit("etrade.screen_enqueued", "trading", {
        jobId,
        workflowId: handle.workflowId,
        universe,
        shards: shards.length,
      });
      return workflowAcceptedResponse(handle);
    }
  }
  if (universe === "ALL") {
    const shards = await agent.runSharded({ trigger: "manual", filters: validatedFilters, userLogin, environment: requestedEnv, portfolioContext });
    for (const shard of shards) {
      await publishOrBridge(ctx, userLogin, shard, emailTo);
    }
    const failed = shards.filter((r) => !r.success);
    if (failed.length === shards.length) {
      return Response.json({ error: failed[0]?.error || "E*TRADE unavailable" }, { status: 502 });
    }
    ctx.audit("etrade.screened", "trading", {
      filterSummary: `ALL (sharded: ${shards.length} universes)`,
      count: shards.reduce((n, r) => n + r.allStocks.length, 0),
      success: true,
    });
    // Issue #307/#308: store each shard's canonical report copy
    // (one row per generation) so manual screens are searchable.
    // Issue #911: pass userLogin for correct user scoping.
    for (const r of shards) await ctx.persistScreenerReportCanonical({ ...r, userLogin });
    return Response.json({
      sharded: true,
      universes: shards.map((r) => ({
        universe: r.universe,
        totalScanned: r.totalScanned,
        matchedCount: r.matchedCount,
        opportunities: r.opportunities,
        stocks: r.allStocks,
        discoveryMessage: r.discoveryMessage,
        scannedAt: r.timestamp,
        reportUrl: r.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(r.pdfKey)}` : undefined,
        success: r.success,
        error: r.error,
      })),
    });
  }
  // Issue #424: if runScreen throws (instead of returning a failed
  // result), publish the failure notification before propagating.
  let result;
  try {
    result = await agent.runScreen({
      trigger: "manual",
      filters: validatedFilters,
      universe: universe as any,
      userLogin,
      // The screener runs in its own Durable Object, so it cannot infer the
      // environment selected on this orchestrator request. Carry the same
      // authenticated account context into the shared manual/scheduled
      // screening pipeline.
      environment: requestedEnv,
      portfolioContext,
    });
  } catch (screenErr) {
    const error = screenErr instanceof Error ? screenErr.message : String(screenErr);
    // Issue #832: "already running" is not a failure — return 429, don't spam Slack.
    if (error.includes("already running")) {
      return Response.json(
        { error: "Screen already running", message: error, retryable: true },
        { status: 429 }
      );
    }
    await publishOrBridge(ctx, userLogin, {
      success: false,
      error,
      timestamp: new Date().toISOString(),
      universe: universe as any,
    }, emailTo);
    throw screenErr;
  }
  ctx.audit("etrade.screened", "trading", {
    filterSummary: result.discoveryMessage,
    count: result.allStocks.length,
    success: result.success,
  });
  // Issue #307/#308: store the canonical report copy (one row per
  // generation) so manual screens are searchable like scheduled ones.
  // Issue #911: pass userLogin so the report is stored under the
  // correct user scope (not "default").
  await ctx.persistScreenerReportCanonical({ ...result, userLogin });
  await publishOrBridge(ctx, userLogin, result, emailTo);
  if (!result.success) {
    return Response.json({ error: result.error || "E*TRADE unavailable" }, { status: 502 });
  }
  return Response.json({
    universe: result.universe,
    totalScanned: result.totalScanned,
    matchedCount: result.matchedCount,
    opportunities: result.opportunities,
    stocks: result.allStocks,
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
}
