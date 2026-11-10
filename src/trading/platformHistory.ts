/**
 * History through the platform (issue #1331) — the seam every
 * former yahooHistory consumer now uses.
 *
 * The old path fetched Yahoo daily bars directly (query1→query2,
 * acquisition-policy retry, null on failure) and computed
 * technicals from them. The new path fetches through the platform
 * historicalBars route (seeded: yahoo primary, freemium): the
 * adapter call is capture- and outcome-tracked under the caller's
 * run id, and the live-only rule from technicals.ts keeps the one
 * behavior the old path guarded most jealously — a failed live
 * fetch is "indicator unavailable" (null), never a synthetic
 * series, never zero.
 *
 * Two shapes, for two caller kinds:
 *   - Route-resolved (screener-agent, discovery, research-agent,
 *     backtest route): resolveYahooHistoryProvider runs the
 *     lifecycle (bootstrap, verify→enable when not enabled) and
 *     resolves the historicalBars route table, like the
 *     yahooQuoteProviderFromRoute pattern. Callers without a sql
 *     handle cannot use it — they bind the adapter directly (see
 *     the shard precedent below) and say so.
 *   - Direct bind (feedYahoo shard): the #1368 feedNasdaq
 *     precedent — bootstrap + adapter with capture + chain id as
 *     run id, no route-table check, no lifecycle mutation. The
 *     shard's route resolution is a follow-up, as for nasdaq.
 */

import type { SqlStorage } from "../orm";
import type { Env } from "../types";
import { YahooFinanceProvider } from "../services/marketDataResearch";
import { DEFAULT_PIPELINE_POLICY, type RetryPolicy } from "../services/pipelinePolicy";
import { withRetry } from "../services/resilience";
import { createYahooDataProvider, verifyYahooDataProvider } from "./dataProviders/adapters";
import { defaultBreakerRegistry } from "../breakers/createBreakerPorts";
import type { CaptureBlobStorage } from "./dataProviders/captureStore";
import { createCaptureFetchOutcomeRecorder } from "./dataProviders/captureStore";
import type { DataProvider, DataRunContext } from "./dataProviders/contract";
import { bootstrapDataProviders } from "./dataProviders/providerConfigStore";
import type {
  CapabilityRouteRecord,
  ProviderConfigRecord,
} from "./dataProviders/providerConfigStore";
import { getProviderConfig, listCapabilityRoutes, listProviderConfigs } from "./dataProviders/providerConfigStore";
import {
  transitionProvider,
  transitionProviderViaPort,
} from "./dataProviders/lifecycle";
import type { ProviderConfigStore } from "../data/providerConfigPorts";
import type { ProviderCaptureStore } from "../data/providerCapturePorts";
import { DataProviderRegistry } from "./dataProviders/registry";
import {
  computeTechnicals,
  marketDataResearchBarsToDailyBars,
  type YahooDailyBar,
  type YahooTechnicals,
} from "./technicals";

/**
 * Bars requested per symbol. The old path fetched the configured
 * 3mo range (~63 trading days); the market-data provider serves the last
 * `limit` bars of its range window (limit 60 → 6mo window, last 60
 * bars) — the closest faithful count that still clears the MACD
 * 27-bar minimum with headroom. barsUsed reports the actual count.
 */
export const HISTORY_BAR_LIMIT = 60;

/** Default batch concurrency: the old path's config default (fetchConcurrency 8). */
export const HISTORY_BATCH_CONCURRENCY = 8;

/** Inter-chunk pause from the old batch (throttle discipline, #1184 era). */
const HISTORY_BATCH_GAP_MS = 60;

/**
 * Issue #1331: resolve the bars provider from the platform route
 * table — the historicalBars route's primary assignment (seeded:
 * yahoo, freemium, no gap-fill). Same discipline as quote provider
 * resolution: the route must name yahoo as primary, yahoo's config
 * must be enabled (state and flag), and the registry must hold a
 * historicalBars-capable yahoo adapter. Anything else throws — no
 * silent substitution, no fallback to another provider.
 */
export function yahooBarsProviderFromRoute(
  registry: DataProviderRegistry,
  configs: readonly ProviderConfigRecord[],
  routes: readonly CapabilityRouteRecord[]
): DataProvider {
  const route = routes.find((r) => r.capability === "historicalBars");
  if (!route || route.primaryProviderId !== "yahoo") {
    throw new Error(
      "Yahoo-mode bars resolution failed: the historicalBars route does not name yahoo as primary."
    );
  }
  const config = configs.find((c) => c.id === "yahoo");
  if (!config || config.lifecycleState !== "enabled" || !config.enabled) {
    throw new Error(
      "Yahoo-mode bars resolution failed: the yahoo provider is not enabled (lifecycle state and flag)."
    );
  }
  const provider = registry.get("yahoo");
  if (!provider || !provider.capabilities.includes("historicalBars")) {
    throw new Error(
      "Yahoo-mode bars resolution failed: no historicalBars-capable yahoo adapter is registered."
    );
  }
  return provider;
}

/**
 * Issue #1331: lifecycle-managed yahoo bars provider — bootstrap,
 * verify→enable when not already enabled, registry + adapter,
 * route resolution. The adapter carries capture when a blob
 * handle is supplied; without one it carries the sql-derived
 * outcome recorder, so probes still leave outcome rows (capture
 * rows need the handle — callers without one disclose that gap).
 */
export async function resolveYahooHistoryProvider(args: {
  sql: SqlStorage;
  env: Env;
  userLogin: string;
  blobStorage?: CaptureBlobStorage;
  /**
   * #2303 (#1976 step 1): the data-layer ports. When supplied,
   * bootstrap/transitions/route reads run on D1 through the
   * config port and captures/outcomes land through the capture
   * port; otherwise the sql path runs unchanged.
   */
  configPort?: ProviderConfigStore | null;
  capturePort?: ProviderCaptureStore | null;
}): Promise<DataProvider> {
  const configPort = args.configPort ?? null;
  if (configPort) await configPort.bootstrapDataProviders();
  else bootstrapDataProviders(args.sql);
  const config = configPort
    ? await configPort.getProviderConfig("yahoo")
    : getProviderConfig(args.sql, "yahoo");
  if (!config || config.lifecycleState !== "enabled" || !config.enabled) {
    const verifyDeps = {
      verifier: async () => verifyYahooDataProvider(args.env),
    };
    if (configPort) {
      await transitionProviderViaPort(configPort, "yahoo", "verify", args.userLogin, verifyDeps);
      await transitionProviderViaPort(configPort, "yahoo", "enable", args.userLogin, {});
    } else {
      await transitionProvider(args.sql, "yahoo", "verify", args.userLogin, verifyDeps);
      await transitionProvider(args.sql, "yahoo", "enable", args.userLogin, {});
    }
  }
  const registry = new DataProviderRegistry();
  const adapter = createYahooDataProvider(new YahooFinanceProvider(args.env), args.env, {
    ...(args.blobStorage
      ? {
          capture: {
            sql: args.sql,
            blobStorage: args.blobStorage,
            env: args.env,
            ...(args.capturePort ? { capturePort: args.capturePort } : {}),
          },
        }
      : {
          outcomeRecorder: args.capturePort
            ? args.capturePort.createFetchOutcomeRecorder()
            : createCaptureFetchOutcomeRecorder(args.sql),
        }),
    // Issue #1745: platform Yahoo history runs behind the yahoo breaker.
    breaker: defaultBreakerRegistry().breakerFor("yahoo"),
  });
  registry.register(adapter);
  return yahooBarsProviderFromRoute(
    registry,
    configPort
      ? await configPort.listProviderConfigs()
      : listProviderConfigs(args.sql),
    configPort
      ? await configPort.listCapabilityRoutes()
      : listCapabilityRoutes(args.sql)
  );
}

/** The history seam — mirrors YahooScreenerDeps: an injected per-symbol bars fetcher. */
export interface YahooHistoryDeps {
  /**
   * Fetch daily bars for a symbol through the platform. Returns
   * null when history is unavailable (live fetch failed, or the
   * provider fell back to generated bars) — never synthesized bars,
   * never a throw: per-symbol failures stay per-symbol.
   */
  fetchBars: (symbol: string) => Promise<YahooDailyBar[] | null>;
  /**
   * #3931 — the source label for the bars fetchBars would return
   * for a symbol (the label computeTechnicals carries onto the
   * technicals, so the UX names the source). Absent ⇒ the live
   * default ("Yahoo Finance"). The persisted-first wrapper sets
   * this for symbols served from the persisted technicals dataset.
   */
  originFor?: (symbol: string) => string | null;
}

/**
 * #3931 — persisted-first history deps: the persisted technicals
 * dataset is the PRIMARY source, the live fetch the fallback.
 * A symbol the persisted map carries is served from the map (no
 * live call at all) and labelled with the persisted label; every
 * other symbol falls through to the live deps unchanged. The live
 * implementation is NOT deleted — it is the fallback, and the
 * only source when no persisted map is supplied.
 */
export interface PersistedTechnicalsBars {
  barsBySymbol: Map<string, YahooDailyBar[]>;
  /** Label for persisted bars, e.g. "Persisted Yahoo daily bars (as of 2026-11-07)". */
  label: string;
}

export function withPersistedBarsFirst(
  live: YahooHistoryDeps,
  persisted: PersistedTechnicalsBars,
): YahooHistoryDeps {
  const key = (symbol: string) => symbol.toUpperCase().trim();
  return {
    fetchBars: async (symbol: string) =>
      persisted.barsBySymbol.get(key(symbol)) ?? live.fetchBars(symbol),
    originFor: (symbol: string) =>
      persisted.barsBySymbol.has(key(symbol)) ? persisted.label : null,
  };
}

/**
 * Issue #1331: bind a platform historicalBars provider to the
 * history seam. The adapter call runs under the acquisition retry
 * policy (the old path's #1184 resilience: a throttle storm must
 * not zero technicals for a whole run) with the run context riding
 * along, so every fetch is captured/outcome-tracked under the
 * caller's run id. A non-live result counts as a failed attempt
 * and is retried like a throw; exhaustion yields null.
 */
export function bindYahooHistoryDeps(
  provider: DataProvider,
  runContext: DataRunContext,
  opts: {
    retryPolicy?: RetryPolicy;
    retrySleep?: (ms: number) => Promise<void>;
  } = {}
): YahooHistoryDeps {
  const policy = opts.retryPolicy ?? DEFAULT_PIPELINE_POLICY.retry.acquisition;
  return {
    fetchBars: async (symbol: string) => {
      const clean = symbol.toUpperCase().trim();
      try {
        return await withRetry(
          async () => {
            const res = await provider.getHistoricalBars!(symbol, "1D", HISTORY_BAR_LIMIT, runContext);
            const bars = marketDataResearchBarsToDailyBars(res.result);
            if (!bars) {
              throw new Error(`Yahoo history unavailable for ${clean} (non-live bars)`);
            }
            return bars;
          },
          policy,
          {
            label: `platform-history:${clean}`,
            ...(opts.retrySleep ? { sleep: opts.retrySleep } : {}),
          }
        );
      } catch {
        return null;
      }
    },
  };
}

/**
 * Issue #1331 (fix): degrading history resolution for the technicals
 * leg. The old yahooHistory contract was "missing history means
 * indicator unavailable, never zero" — a resolution failure (store
 * unavailable, route unconfigured, verification down) must degrade
 * the caller to honestly-null technicals, never fail the caller's
 * own job (quote refresh, screen, report, backtest). The strict
 * resolveYahooHistoryProvider above still throws for callers that
 * REQUIRE history; this wrapper is only for the technicals leg.
 * The degradation is visible, not silent: a console warning plus
 * null technicals (the screener's coverage counters show it).
 */
export async function resolveYahooHistoryDeps(args: {
  sql: SqlStorage;
  env: Env;
  userLogin: string;
  blobStorage?: CaptureBlobStorage;
  runId: string;
  /** #2303: threaded to resolveYahooHistoryProvider. */
  configPort?: ProviderConfigStore | null;
  capturePort?: ProviderCaptureStore | null;
}): Promise<YahooHistoryDeps | undefined> {
  try {
    const provider = await resolveYahooHistoryProvider(args);
    return bindYahooHistoryDeps(provider, { runId: args.runId, userLogin: args.userLogin });
  } catch (err) {
    console.warn("[platformHistory] History resolution failed — technicals degrade to null:", err);
    return undefined;
  }
}

/**
 * Issue #1331: fetch history + compute technicals for many symbols
 * — the old fetchTechnicalsBatch shape over the platform seam.
 * Chunked by concurrency with the 60ms inter-chunk pause and the
 * onBatch progress hook (the #624 heartbeat contract: the
 * screener-agent passes its throttled beat as onBatch). Failures
 * are per-symbol; the rest still resolve.
 */
export async function fetchPlatformTechnicalsBatch(
  deps: YahooHistoryDeps,
  symbols: string[],
  opts: {
    concurrency?: number;
    onBatch?: (completed: number, total: number) => void | Promise<void>;
  } = {}
): Promise<Map<string, YahooTechnicals>> {
  const out = new Map<string, YahooTechnicals>();
  const conc = opts.concurrency ?? HISTORY_BATCH_CONCURRENCY;
  const onBatch = opts.onBatch;
  for (let i = 0; i < symbols.length; i += conc) {
    const batch = symbols.slice(i, i + conc);
    const results = await Promise.all(
      batch.map(async (sym) => {
        try {
          const bars = await deps.fetchBars(sym);
          // #3931: the origin label rides onto the technicals so
          // the UX names the persisted source; absent ⇒ the live
          // default ("Yahoo Finance").
          return computeTechnicals(sym, bars, undefined, deps.originFor?.(sym) ?? undefined);
        } catch {
          return computeTechnicals(sym, null);
        }
      })
    );
    for (const t of results) out.set(t.symbol, t);
    // Issue #624: optional progress hook (e.g. task heartbeats during
    // long batches); absent for existing callers.
    if (onBatch) await onBatch(Math.min(i + conc, symbols.length), symbols.length);
    if (i + conc < symbols.length) {
      await new Promise((r) => setTimeout(r, HISTORY_BATCH_GAP_MS));
    }
  }
  return out;
}
