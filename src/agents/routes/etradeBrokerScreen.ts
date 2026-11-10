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

import { parseStockScreenRequest } from "../../trading";
import type {
  StockScreenDelivery,
  StockScreenRunSpec,
} from "../../workflows/stockScreenRunSpec";
import { specCanonicalFields } from "../../workflows/stockScreenRunSpec";
import { screenerOutcomeFromRunResult } from "../../services/screenerFollowups";
import { isPortfolioContextEnabled } from "../../services/screeningFlags";
import type { ETradeService } from "../../services/etrade";
import { workflowAcceptedResponse } from "../../workflows/screenerWorkflowRoutes";
import { startStockScreenWorkflowOrNull } from "../../workflows/screenExecutionBroker";
import { persistThenDeliverAll } from "../../workflows/screenRunFinalize";
import { publishManualScreenerRun } from "./etradeBroker";
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import type { ScreenerAgent } from "../screener-agent";
import { screenAlreadyRunningDetails } from "../../services/screenInFlight";
import { quotaExceededDetails } from "../../security/userRequestQuota";

/**
 * Issue #2545: the manual screen's delivery selection — the scheduled
 * market screen's delivery envelope (the schedule payload's
 * deliveryFields) plus the report-artifact flag, as parsed from the
 * request by parseStockScreenRequest. Every field optional: a caller
 * that sends none gets today's behavior exactly.
 */
/**
 * Issue #2809: the delivery envelope is defined once in
 * stockScreenRunSpec.ts (StockScreenDelivery); this name is kept
 * as an alias so existing importers keep working. Do not add
 * fields here — add them to StockScreenDelivery.
 */
export type ManualScreenDelivery = StockScreenDelivery;

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
    const outcome = screenerOutcomeFromRunResult("stock", enriched as Record<string, unknown>, ctx.env.APP_BASE_URL);
    // Issue #2913 (G6): stamp the stable deliveryId the legacy
    // fallback already uses (`manual:<timestamp>:<universe>`)
    // when the outcome has none, so a bridge delivery and a
    // legacy-fallback delivery for one run share one
    // (runId, destination) suppression key instead of two —
    // and a resubmitted deliver job is matched across
    // instances. Left unstamped when timestamp or universe
    // is missing: the jobId keying then stands, unchanged.
    // (Stamped here, not in screenerOutcomeFromRunResult: that
    // builder also serves options + workflow callers, and this
    // stock REST route must not change their key space.)
    if (
      !outcome.deliveryId &&
      typeof (enriched as Record<string, unknown>).timestamp === "string" &&
      typeof (enriched as Record<string, unknown>).universe === "string"
    ) {
      outcome.deliveryId = `manual:${(enriched as Record<string, unknown>).timestamp as string}:${(enriched as Record<string, unknown>).universe as string}`;
    }
    await ctx.scheduleScreenerFollowups(outcome, userLogin);
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
  /**
   * Issue #2809: the normalized run spec, built once by
   * buildStockScreenRunSpec. When present it is the single
   * source for universe/filters/async/delivery/mode; the
   * legacy fields below are kept only as the backward-
   * compatible construction path (existing pins call with
   * them) and are normalized to the same spec at the top
   * of this function.
   */
  spec?: StockScreenRunSpec;
  universe?: StockScreenValue["universe"];
  validatedFilters?: StockScreenValue["filters"];
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
  const { ctx, sessionId, requestedEnv, userLogin, agent } = args;
  // Issue #2809: normalize both call shapes to one spec. The
  // legacy path pins deliver=true / source "etrade", exactly
  // what the E*TRADE route's spec carries.
  const spec: StockScreenRunSpec = args.spec ?? {
    source: "etrade",
    // Issue #2908 (G1): the legacy construction path carries
    // the same provenance the builder sets (trigger + login).
    trigger: "manual",
    userLogin,
    deliver: true,
    filters: args.validatedFilters as StockScreenValue["filters"],
    universe: args.universe as StockScreenValue["universe"],
    asyncRequested: args.asyncRequested ?? false,
    delivery: args.delivery ?? {},
    ...(args.screenMode
      ? { screenMode: args.screenMode, screenIntent: args.screenIntent }
      : {}),
  };
  const universe = spec.universe;
  const validatedFilters = spec.filters;
  const delivery = spec.delivery;
  const asyncRequested = spec.asyncRequested;
  // Issue #17: the portfolio-context flag is read here (orchestrator
  // storage owns mas_settings; the screener agent cannot read it) and
  // rides the run request — runSharded spreads it onto every shard.
  const portfolioContext = isPortfolioContextEnabled(ctx.readSettingRaw);
  // Issue #2827: async path via ScreenExecutionBroker. The
  // workflow owns store + deliver per shard, so nothing is
  // persisted, published, or audited-as-complete here.
  // Broker null (unbound / start failure) -> fall through
  // to the synchronous path below. ND throw propagates
  // (fail-closed, never a sync fallback).
  if (asyncRequested) {
    const started = await startStockScreenWorkflowOrNull({
      env: ctx.env,
      spec,
      userLogin,
      environment: requestedEnv,
      portfolioContext,
      readSettingRaw: ctx.readSettingRaw,
    });
    if (started) {
      ctx.audit("etrade.screen_enqueued", "trading", {
        jobId: started.jobId,
        workflowId: started.handle.workflowId,
        universe,
        shards: started.shards.length,
      });
      return workflowAcceptedResponse(started.handle);
    }
  }
  if (universe === "ALL") {
    const shards = await agent.runSharded({ trigger: "manual", filters: validatedFilters, userLogin, environment: requestedEnv, portfolioContext });
    // Issue #2861: persist-then-deliver, unified with the single-run
    // path below — previously this block delivered every shard
    // before persisting any of them.
    await persistThenDeliverAll({
      results: shards,
      // Issue #2863: record the run's criteria with each shard's
      // canonical copy, so future replays can show them.
      persist: (r) => ctx.persistScreenerReportCanonical({ ...r, userLogin, criteria: spec.filters, ...specCanonicalFields(spec) }),
      deliver: (shard) => publishOrBridge(ctx, userLogin, shard, delivery),
    });
    const failed = shards.filter((r) => !r.success);
    if (failed.length === shards.length) {
      return Response.json({ error: failed[0]?.error || "E*TRADE unavailable" }, { status: 502 });
    }
    ctx.audit("etrade.screened", "trading", {
      filterSummary: `ALL (sharded: ${shards.length} universes)`,
      count: shards.reduce((n, r) => n + r.allStocks.length, 0),
      success: true,
    });
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
  // Issue #2912 (G5): one persist + one deliver definition for the
  // single-run path — the success site below and the runScreen-throw
  // site share them, so a thrown failure persists-then-delivers
  // exactly like a returned result, through the #2861 finalizer.
  const persistCanonical = (r: Parameters<EtradeBrokerRouteContext["persistScreenerReportCanonical"]>[0]) =>
    ctx.persistScreenerReportCanonical({ ...r, userLogin, criteria: spec.filters, ...specCanonicalFields(spec) });
  const deliverResult = (r: unknown) => publishOrBridge(ctx, userLogin, r, delivery);
  // Issue #424: if runScreen throws (instead of returning a failed
  // result), persist-then-deliver the failure before propagating.
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
    // #2840: the 429 also names the in-flight run (id + status)
    // so the second submitter knows what it is waiting on.
    if (error.includes("already running")) {
      const details = screenAlreadyRunningDetails(screenErr);
      return Response.json(
        { error: "Screen already running", message: error, retryable: true, runId: details?.runId ?? null, status: details?.status ?? "running" },
        { status: 429 }
      );
    }
    // Issue #2842: a quota refusal is not a run result — it
    // returns 429 with limit, usage, and reset time and is never
    // persisted as a failed run; a counter failure fails closed
    // as 503, never as an uncounted run.
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
    // Issue #2912 (G5): the thrown failure is not a persistable run
    // result as thrown, so fabricate the failed-run shape a returned
    // failure carries (zero counts, empty sets, the thrown error) and
    // run it through the same persist-then-deliver finalizer. The
    // canonical store dedupes on generationId `screener:<timestamp>`,
    // so persisting this result again never creates a second row.
    // The throw still propagates: the route contract is unchanged,
    // only the previously invisible run is now visible in Reports.
    const failedResult = {
      timestamp: new Date().toISOString(),
      trigger: "manual" as const,
      universe,
      sector: (validatedFilters as { sector?: string } | undefined)?.sector ?? "ALL",
      success: false,
      totalScanned: 0,
      matchedCount: 0,
      opportunities: [],
      allStocks: [],
      discoveryMessage: "",
      error,
    };
    await persistThenDeliverAll({
      results: [failedResult],
      persist: persistCanonical,
      deliver: deliverResult,
    });
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
  // Issue #2861: same persist-then-deliver finalizer as the
  // sharded path above; order unchanged here, now pinned.
  await persistThenDeliverAll({
    results: [result],
    persist: persistCanonical,
    deliver: deliverResult,
  });
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
