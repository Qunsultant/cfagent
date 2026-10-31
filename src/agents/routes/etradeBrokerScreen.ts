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
 * Issue #2545: the manual screen's delivery selection — the scheduled
 * market screen's delivery envelope (the schedule payload's
 * deliveryFields) plus the report-artifact flag, as parsed from the
 * request by parseStockScreenRequest. Every field optional: a caller
 * that sends none gets today's behavior exactly.
 */
export interface ManualScreenDelivery {
  emailTo?: string;
  pushToSlack?: boolean;
  slackChannel?: string;
  webhookUrl?: string;
  generatePdf?: boolean;
}

/**
 * Issue #2545: the fields a delivery selection stamps onto a finished
 * run's result before publication — the bridge's outcome projection
 * (screenerOutcomeFromRunResult) reads exactly these names, the same
 * per-task overrides the scheduled path's bus events carry.
 * Conventions mirror the schedule payload builders: slackChannel
 * rides only when Slack push is not off; blank recipients are
 * omitted, never stamped empty. pushToSlack present (either value)
 * means the caller made an explicit channel selection, so the
 * outcome also carries the #1236 deliveryChannels allowlist built
 * from the selection — without it, env-configured channels and
 * overrides decide, as today.
 */
export function manualScreenDeliveryEnrichment(
  delivery?: ManualScreenDelivery,
): Record<string, unknown> {
  if (!delivery) return {};
  const enriched: Record<string, unknown> = {};
  if (delivery.emailTo?.trim()) enriched.emailTo = delivery.emailTo.trim();
  if (delivery.pushToSlack !== false && delivery.slackChannel?.trim()) {
    enriched.slackChannel = delivery.slackChannel.trim();
  }
  if (delivery.webhookUrl?.trim()) enriched.webhookUrl = delivery.webhookUrl.trim();
  if (delivery.generatePdf !== undefined) enriched.generatePdf = delivery.generatePdf;
  if (delivery.pushToSlack !== undefined) {
    const channels: string[] = [];
    if (delivery.pushToSlack) channels.push("slack");
    if (enriched.emailTo) channels.push("email");
    if (enriched.webhookUrl) channels.push("webhook");
    enriched.deliveryChannels = channels;
  }
  return enriched;
}

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
  delivery?: ManualScreenDelivery,
): Promise<void> {
  if (ctx.asyncJobId) return;
  const enrichment = manualScreenDeliveryEnrichment(delivery);
  const enriched = Object.keys(enrichment).length > 0 && result && typeof result === "object"
    ? { ...(result as Record<string, unknown>), ...enrichment }
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
  /** Issue #2545: the caller's delivery selection (subsumes the
   *  former bare emailTo). The synchronous paths publish it
   *  through publishOrBridge; the async workflow path's command
   *  carries no per-channel delivery fields (its deliver step
   *  is boolean), so it is not forwarded there. */
  delivery?: ManualScreenDelivery;
  /**
   * Issue #2530: an admitted ND selection (validated at the
   * route by screenModeSelectionFromFields); rides the async
   * workflow command. The route guarantees asyncRequested
   * when this is present.
   */
  screenMode?: "non-deterministic";
  screenIntent?: string;
}): Promise<Response> {
  const { ctx, sessionId, requestedEnv, userLogin, agent, universe, validatedFilters, delivery } = args;
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
      await publishOrBridge(ctx, userLogin, shard, delivery);
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
    }, delivery);
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
  await publishOrBridge(ctx, userLogin, result, delivery);
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
