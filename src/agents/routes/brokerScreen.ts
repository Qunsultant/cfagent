/**
 * Issue #3272 (S2, programme #3216): the broker-neutral stock screen.
 *
 *   POST /broker/screen  { symbols: string[], filter?: StockScreenerFilter }
 *
 * Why a new route: `/etrade/screen` lives in the E*TRADE broker module, needs
 * an E*TRADE login, and gathers its universe through the E*TRADE client. That
 * is fine for E*TRADE and impossible for anyone else. Screening is declared
 * provider-side (#2144), and issue #3325 made the catalogue say so for both
 * brokers: neither offers a screener API, both screen their own quotes.
 * The platform does the math; only the quotes come from the selected broker.
 *
 * Honesty rules, identical to `/broker/options/*`:
 *   - a broker without a quote read answers `501 provider_unsupported` naming
 *     it, before any platform is constructed;
 *   - every symbol that could not be read is reported under its own name in
 *     `failures`; nothing is filled in from another source;
 *   - an empty universe is a `400` naming what is missing, never a silent
 *     "no matches".
 *
 * Scope (issue #4433): the screen runs through the one engine seam
 * (`runStockScreenViaEngine`) as a workflow run with a run record, with a
 * hard cap on symbols (`MAX_SCREEN_SYMBOLS`) because every quote is one
 * upstream subrequest. The fire-and-forget async screen and
 * the E*TRADE listings branch are deliberately out of scope — they are separate
 * data paths, not quote gathers.
 */
import type { Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { NasdaqStockListing } from "../../services/nasdaqListings";
import {
  brokerSupports,
  gatherQuotes,
  isStockScreenProvider,
  resolveUniverseSymbols,
  type StockScreenProvider,
} from "../../trading";
import { defaultUniverseId } from "../../config/defaultUniverse";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { resolveBrokerEnvironmentFromSettings } from "./brokerEnvironment";
import type { ScreenerAgent } from "../screener-agent";
import {
  runStockScreenViaEngine,
  type RunStockScreenViaEngine,
} from "../../workflows/runStockScreenViaEngine";
import type { StockScreenRunSpec } from "../../workflows/stockScreenRunSpec";
import { workflowStatusUrl, WorkflowError } from "../../workflows/workflowPorts";
import { screenAlreadyRunningDetails } from "../../services/screenInFlight";
import { quotaExceededDetails } from "../../security/userRequestQuota";

export interface BrokerScreenRouteContext {
  env: Env;
  getOrm: () => DatabaseORM | undefined;
  readSettingRaw: (key: string) => string | null | undefined;
  /**
   * Issue #4433: the agent the engine seam gates + reads back
   * through (the in-flight probe, the quota charge, the HISTORY
   * read-back). No default — a caller without one cannot gate.
   */
  getScreenerAgent: (userLogin?: string) => ScreenerAgent;
  /**
   * Issue #4433: the one engine seam (runStockScreenViaEngine)
   * this route's screen runs through. Optional: absent in
   * production construction, the route calls the real seam;
   * tests inject a fake. The field exists only so a test can
   * substitute the seam — it never selects a different engine.
   */
  runStockScreenViaEngine?: RunStockScreenViaEngine;
}

/** Hard cap: every symbol is one upstream quote read. */
export const MAX_SCREEN_SYMBOLS = 25;

/**
 * Issue #4433: the per-symbol quote failures the engine run
 * reported, flattened from its quote trace (one entry per
 * failed symbol, under its own name, with the trace's reason).
 * A run whose trace carries no failures reports none — the
 * trace is the run's own record, never re-derived here.
 */
function traceFailures(result: {
  quoteTrace?: {
    batches: Array<{ failures: Array<{ symbol: string; detail: string }> }>;
  };
}): Array<{ symbol: string; reason: string }> {
  const batches = result.quoteTrace?.batches ?? [];
  return batches.flatMap((batch) =>
    batch.failures.map((failure) => ({ symbol: failure.symbol, reason: failure.detail })),
  );
}

export async function handleBrokerScreenRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: BrokerScreenRouteContext,
): Promise<Response | null> {
  if (!path.endsWith("/broker/screen")) return null;
  if (request.method !== "POST") return null;

  const body = ((await request.json().catch(() => ({}))) as any) ?? {};
  const rawSymbols = Array.isArray(body.symbols) ? body.symbols : [];
  // Issue #3272 (stock UI): a named universe resolves through the LIVE listings
  // feed. No curated substitution: if the feed fails the answer is coded, not
  // a plausible-looking table (the rule #1554 set for listings).
  const requestedUniverse = typeof body.universe === "string" && body.universe.trim() ? body.universe.trim().toUpperCase() : null;
  const symbols: string[] = Array.from(
    new Set<string>(
      rawSymbols
        .filter((s: unknown): s is string => typeof s === "string")
        .map((s: string) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  let universe: string | null = null;
  let universeSize = 0;
  let truncated = false;
  // Issue #4433: the feed's own capped rows for a universe
  // screen — the run's membership, carried onto the shard.
  let universeListings: NasdaqStockListing[] | null = null;
  if (symbols.length === 0) {
    const id = requestedUniverse ?? defaultUniverseId();
    try {
      const resolved = await resolveUniverseSymbols(id, MAX_SCREEN_SYMBOLS);
      symbols.push(...resolved.symbols);
      universeSize = resolved.universeSize;
      truncated = resolved.truncated;
      universe = id;
      universeListings = resolved.listings;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the listings feed failed";
      return Response.json(
        {
          code: "LISTINGS_UNAVAILABLE",
          message: `The ${id} universe could not be resolved (${reason}). No curated table is substituted.`,
          retryable: true,
        },
        { status: 503 },
      );
    }
  }
  if (symbols.length === 0) {
    return Response.json(
      { code: "invalid_request", message: "No symbols resolved for this universe." },
      { status: 400 },
    );
  }
  if (symbols.length > MAX_SCREEN_SYMBOLS) {
    return Response.json(
      {
        code: "invalid_request",
        message: `At most ${MAX_SCREEN_SYMBOLS} symbols per neutral screen (${symbols.length} given); each symbol is one upstream quote read.`,
      },
      { status: 400 },
    );
  }

  const broker = await resolveTenantBroker(ctx.env);
  const readSetting = (key: string) => ctx.readSettingRaw(key) ?? null;
  const environment = resolveBrokerEnvironmentFromSettings(readSetting, ctx.env);

  if (!brokerSupports(broker, "quote")) {
    return Response.json(
      {
        code: "provider_unsupported",
        broker,
        message: `Stock screening needs a quote read, which the selected broker (${broker}) does not provide; no other broker's data is used in its place.`,
        retryable: false,
      },
      { status: 501 },
    );
  }

  // Issue #4433: the engine binds quote deps per screen provider,
  // and this route screens the selected broker's own quotes — so
  // the broker names the run's provider. A broker outside the
  // screen-provider vocabulary has no engine quote binding:
  // refuse by name before any start, never screen another
  // broker's data in its place.
  if (!isStockScreenProvider(broker)) {
    return Response.json(
      {
        code: "provider_unsupported",
        broker,
        message: `Stock screening through the engine has no quote binding for the selected broker (${broker}); no other broker's data is used in its place.`,
        retryable: false,
      },
      { status: 501 },
    );
  }
  const provider: StockScreenProvider = broker;

  // Issue #4433: the run's membership rows. A universe screen
  // rides the feed's own capped rows; an explicit list rides
  // minimal rows built from the requested symbols alone — the
  // symbol stands in as the company name (the live quote's name
  // wins downstream) and no membership is fetched, invented, or
  // substituted for it.
  const listings: NasdaqStockListing[] =
    universeListings ??
    symbols.map((symbol) => ({
      symbol,
      companyName: symbol,
      exchange: "nasdaq",
      change: 0,
      changePercent: 0,
    }));
  const userLogin = request.headers.get("x-user-login") || "";
  const spec: StockScreenRunSpec = {
    source: "broker",
    trigger: "manual",
    deliver: false,
    provider,
    filters: body.filter ?? {},
    universe: universe ?? "symbols",
    asyncRequested: false,
    delivery: {},
    userLogin,
  };
  const agent = ctx.getScreenerAgent(userLogin);
  let outcome;
  try {
    outcome = await (ctx.runStockScreenViaEngine ?? runStockScreenViaEngine)({
      env: ctx.env,
      spec,
      userLogin,
      environment,
      readSettingRaw: readSetting,
      agent,
      commandOverrides: {
        shards: [
          {
            shardId: "symbols",
            symbols: listings,
            ...(universe ? { universe } : {}),
          },
        ],
        maxItems: symbols.length,
        maxSymbols: symbols.length,
        broker,
      },
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
        { status: 429 },
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
        { status: 429 },
      );
    }
    if (error.includes("quota unavailable")) {
      return Response.json(
        { error: "Request quota unavailable", message: error, retryable: true },
        { status: 503 },
      );
    }
    // A workflow-start failure (port unavailable, start throw)
    // answers a coded 503 — no silent inline screen was run, and
    // none is started here: a screen is a workflow run or it
    // does not run.
    if (screenErr instanceof WorkflowError) {
      return Response.json(
        { code: screenErr.code, error, message: error, retryable: true },
        { status: 503 },
      );
    }
    throw screenErr;
  }
  const result = outcome.results[0];
  const statusUrl = workflowStatusUrl(outcome.jobId);
  if (!result.success) {
    // A failed result never reached the workflow's store step
    // with a screen — answer the honest failure naming the run
    // record, never a fabricated screen.
    return Response.json(
      {
        error: result.error || "The selected broker is unavailable.",
        broker,
        environment,
        universe,
        universeSize,
        truncated,
        requested: symbols,
        jobId: outcome.jobId,
        workflowId: outcome.workflowId,
        statusUrl,
      },
      { status: 502 },
    );
  }
  // Issue #4433: the engine result mapped back onto the wire
  // shape this route has always answered — the client contract
  // (stocks, totalScreened) plus the route's disclosure fields,
  // now joined to the run record. The quote trace is the run's
  // own failure record; without it, no failures are claimed.
  const screen = {
    totalScanned: result.totalScanned,
    totalScreened: result.totalScanned,
    matchedCount: result.matchedCount,
    filterApplied: result.criteria ?? body.filter ?? {},
    filterSummary: result.filterSummary ?? result.discoveryMessage ?? "",
    stocks: result.allStocks,
    scannedAt: result.timestamp,
  };
  return Response.json({
    ...screen,
    broker,
    environment,
    universe,
    universeSize,
    truncated,
    requested: symbols,
    quotesRead: result.quoteTrace?.quotesReceived ?? result.totalScanned,
    failures: traceFailures(result),
    ...(result.partial ? { partial: result.partial } : {}),
    result: screen,
    jobId: outcome.jobId,
    workflowId: outcome.workflowId,
    statusUrl,
  });
}

/** Re-exported so tests and callers can exercise the gather without a route. */
export { gatherQuotes };
