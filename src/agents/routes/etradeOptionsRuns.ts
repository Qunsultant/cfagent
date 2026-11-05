/**
 * Issue #995: E*TRADE options route sub-domain module, split out of
 * src/agents/routes/etradeOptions.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeOptions.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the persisted-runs and history reads (latest runs, scan runs, discovery runs, IV history)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { readOptionsRuns } from "../optionsRuns";
import {
  diffScanRuns,
  getIvHistoryEntry,
  flattenWatchlistSymbols,
  resolveTrackedSymbols,
} from "../../trading";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { brokerSupports } from "../../trading";
import {
  buildOptionsDiscoveryPorts,
  createOptionsDiscoveryPorts,
} from "../../data/createOptionsDiscoveryPorts";
import { getCuratedStockUniverse } from "../../config/curatedStockUniverse";
import type { SqlStorage } from "../../orm";
import type { EtradeOptionsRouteContext } from "./etradeOptions";

export async function handleOptionsLatestRuns(ctx: EtradeOptionsRouteContext): Promise<Response> {
  try {
    const runs = await readOptionsRuns((ctx.agentCtx as { storage?: unknown } | undefined)?.storage);
    return Response.json({
      count: runs.length,
      runs,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return Response.json(
      { error: err?.message || "Failed to load options runs", runs: [] },
      { status: 500 }
    );
  }
}

export async function handleOptionsScansList(
  request: Request,
  url: URL,
  sessionId: string,
  sql: SqlStorage,
  ctx: EtradeOptionsRouteContext,
): Promise<Response> {
  try {
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 25;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
    // Issue #103: history is scoped per user, like profiles —
    // runs the caller saved are theirs; legacy runs saved before
    // scoping (no user_login) remain visible to everyone.
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).scanRuns;
    // Issue #3327: history is the SELECTED broker's runs. Runs saved before
    // provenance existed were E*TRADE's (the only broker wired then), so they
    // read as `etrade` — never as another broker's evidence.
    const broker = await resolveTenantBroker(ctx.env);
    const scans = await store.list({ limit, offset, userLogin, broker });
    return Response.json({ broker, count: scans.length, scans });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to list scan runs" }, { status: 500 });
  }
}

export async function handleOptionsScansDiff(request: Request, url: URL, sessionId: string, sql: SqlStorage): Promise<Response> {
  try {
    const fromId = url.searchParams.get("from") || "";
    const toId = url.searchParams.get("to") || "";
    if (!fromId || !toId) {
      return Response.json({ error: "from and to scan run ids are required" }, { status: 400 });
    }
    // Issue #103: both runs must be visible to the caller — an
    // invisible run produces the same 404 as a missing one, so a
    // diff can never leak another user's run (or its existence).
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).scanRuns;
    const from = await store.get(fromId, { userLogin });
    const to = await store.get(toId, { userLogin });
    if (!from || !to) {
      return Response.json({ error: "scan run not found" }, { status: 404 });
    }
    return Response.json({
      from: { id: from.id, generatedAt: from.generatedAt },
      to: { id: to.id, generatedAt: to.generatedAt },
      diff: diffScanRuns(from.result, to.result),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to diff scan runs" }, { status: 500 });
  }
}

export async function handleOptionsScanRunById(request: Request, sessionId: string, sql: SqlStorage, scanRunIdMatch: RegExpMatchArray): Promise<Response> {
  try {
    // Issue #103: scoped like the list — another user's run is
    // indistinguishable from a pruned one (same 404).
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).scanRuns;
    const run = await store.get(decodeURIComponent(scanRunIdMatch[1]), { userLogin });
    if (!run) {
      return Response.json({ error: "scan run not found" }, { status: 404 });
    }
    return Response.json(run);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch scan run" }, { status: 500 });
  }
}

export async function handleOptionsDiscoveryRunsList(
  request: Request,
  url: URL,
  sessionId: string,
  sql: SqlStorage,
  ctx: EtradeOptionsRouteContext,
): Promise<Response> {
  try {
    // Issue #3374: discovery runs are produced by an engine wired to ONE
    // broker's chains, so the history is that broker's evidence. A broker
    // without the capability is refused by name before the store is read:
    // never another broker's runs, never an empty list that reads as "none".
    const broker = await resolveTenantBroker(ctx.env);
    if (!brokerSupports(broker, "optionsDiscovery")) {
      return Response.json(
        {
          code: "provider_unsupported",
          broker,
          message: `Options discovery is not available for the selected broker (${broker}); no other broker's runs are shown in its place.`,
          retryable: false,
        },
        { status: 501 },
      );
    }
    const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 25;
    const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).discoveryRuns;
    const runs = await store.list({ limit, offset, userLogin, broker });
    return Response.json({ count: runs.length, runs });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to list discovery runs" }, { status: 500 });
  }
}

export async function handleOptionsDiscoveryRunById(
  request: Request,
  sessionId: string,
  sql: SqlStorage,
  discoveryRunIdMatch: RegExpMatchArray,
  ctx: EtradeOptionsRouteContext,
): Promise<Response> {
  try {
    // Issue #3374: same rule as the list — a broker that cannot produce runs
    // is refused by name, not answered from another broker's store.
    const broker = await resolveTenantBroker(ctx.env);
    if (!brokerSupports(broker, "optionsDiscovery")) {
      return Response.json(
        {
          code: "provider_unsupported",
          broker,
          message: `Options discovery is not available for the selected broker (${broker}); no other broker's runs are shown in its place.`,
          retryable: false,
        },
        { status: 501 },
      );
    }
    // Issue #103: scoped like the list — another user's run is
    // indistinguishable from a pruned one (same 404).
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const store = createOptionsDiscoveryPorts({ sql }).discoveryRuns;
    const run = await store.get(decodeURIComponent(discoveryRunIdMatch[1]), { userLogin, broker });
    if (!run) {
      return Response.json({ error: "discovery run not found" }, { status: 404 });
    }
    return Response.json(run);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch discovery run" }, { status: 500 });
  }
}

/**
 * IV history for the SELECTED broker (issue #3326, programme #3292).
 *
 * The path keeps E*TRADE's legacy name, but the series is not E*TRADE's: every
 * observation records which broker's chain produced it, and this endpoint
 * answers with the selected broker's rows only. An Alpaca tenant therefore sees
 * Alpaca's own (possibly still warming up) series — never E*TRADE's relabelled.
 */
export async function handleOptionsIvHistory(url: URL, ctx: EtradeOptionsRouteContext, sql: SqlStorage): Promise<Response> {
  try {
    const broker = await resolveTenantBroker(ctx.env);
    if (!brokerSupports(broker, "ivHistory")) {
      return Response.json(
        {
          code: "provider_unsupported",
          broker,
          message: `IV history is not available for the selected broker (${broker}); no other broker's series is shown in its place.`,
          retryable: false,
        },
        { status: 501 },
      );
    }
    // Issue #2337 cutover (R-2): IV reads serve through the
    // env-aware build — the D1 store when AGENT_DB is bound,
    // the DO store only on the explicit rollback lever or an
    // unbound environment.
    const store = (await buildOptionsDiscoveryPorts(ctx.env, { sql })).ivHistory;
    const symbolParam = url.searchParams.get("symbol");
    if (symbolParam) {
      const entry = await getIvHistoryEntry(store, symbolParam, broker);
      // ?series=true includes the full time series for charting.
      if (url.searchParams.get("series") === "true") {
        const series = await store.listSeries(symbolParam.toUpperCase(), { limit: 365, broker });
        return Response.json({
          broker,
          ...entry,
          series: series.reverse().map((r) => ({
            date: r.date,
            atmIv: r.atmIv,
            spot: r.spot,
          })),
        });
      }
      return Response.json({ broker, ...entry });
    }
    let watchlistSymbols: string[] = [];
    try {
      watchlistSymbols = flattenWatchlistSymbols(ctx.getOrm().watchlists.findMany({}));
    } catch {
      // Watchlist read failure → curated universe only.
    }
    const tracked = resolveTrackedSymbols(
      getCuratedStockUniverse().map((s) => s.symbol),
      watchlistSymbols
    );
    const recorded = await store.listSymbols({ broker });
    const names = [...new Set([...tracked, ...recorded])].sort();
    const entries = [];
    for (const symbol of names) {
      entries.push(await getIvHistoryEntry(store, symbol, broker));
    }
    return Response.json({ broker, count: entries.length, names: entries });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch IV history" }, { status: 500 });
  }
}
