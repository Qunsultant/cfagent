/**
 * Shard execution (issue #1355): one mas_async_jobs row's work.
 *
 * This module executes a single shard. It does NOT own a job
 * model, a retry implementation, or a report pipeline:
 *   - retry is withRetry under the pipeline policy (the bucket
 *     comes from SHARD_RETRY_BUCKET in shardJobs.ts);
 *   - PDF generation is runReportPipeline (ReportAssetAgent, the
 *     #680/#914 single owner);
 *   - XLSX/CSV generation is the existing trading generator +
 *     the reportBlobStore seam (the persistRun blocks' pattern);
 *   - store is orm.storeCanonicalReport + a blob read-back;
 *   - serve/deliver are NOT executed here — serve is the existing
 *     followup.report job, deliver the existing followup.deliver
 *     jobs, both planned by the completion hooks.
 * Sibling datasets are read from sibling rows' result_json (the
 * chain's shared state), never from memory — a Worker restart
 * between shards loses nothing.
 */

import type { DatabaseORM } from "../orm";
import type { ETradeService } from "./etrade";
import type { ShardChainContext } from "../types";
import type { OptionChainSource } from "../trading";
import { isBrokerId } from "./tenantProviders";
import { TradingPlatformRegistry, platformChainSource } from "../trading";
import type { ShardPayload, ShardRow } from "./shardJobs";
import {
  assessFeedGate,
  chainRowsFromSql,
  SHARD_RETRY_BUCKET,
  shardProvenanceIds,
} from "./shardJobs";
import { resolvePipelinePolicy } from "./pipelinePolicy";
import {
  buildDataProviderPorts,
  type DataProviderPorts,
} from "../data/buildDataProviderPorts";
import { defaultBreakerRegistry } from "../breakers/createBreakerPorts";
import { withRetry, type WithRetryOptions } from "./resilience";
import {
  DynamicOptionsScreener,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  type OpportunityScanResult,
} from "../trading";
import {
  createScannerScreenPorts,
  type ScannerPipelineRequest,
} from "../workflows/strategyScreenPorts";
import {
  memoryStageClaims,
  memoryStageStorage,
} from "../workflows/optionsScreenWorkflow";
import { optionsEngineStoresFromSql, runStrategyScreenViaEngine } from "../workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../workflows/optionsScreenPorts";
import type { StageQueueSend } from "../workflows/stageQueueTransport";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/shardExecutors",
});

/**
 * Issue #4417: the retry options every shard executor uses — the same opts the
 * call passed, plus the durable attempt recorder when the host provided one.
 */
function retryWithHistory(deps: ShardExecutorDeps, opts: WithRetryOptions = {}): WithRetryOptions {
  return {
    ...opts,
    onAttempt: (attempt, error) => deps.recordAttempt?.(attempt, error),
  };
}
export interface ShardExecutorDeps {
  sql: {
    exec: (query: string, ...params: unknown[]) => Iterable<Record<string, unknown>>;
  };
  env: Record<string, unknown>;
  orm: DatabaseORM;
  /** Durable Object storage: the blob seam + capture deps. */
  storage: any;
  createETradeService: (userLogin: string, environment?: string) => ETradeService;
  /**
   * Issue #4417: records one failed attempt of this shard (the async job row
   * owns the durable history). Absent in unit callers — history is optional.
   */
  recordAttempt?: (attempt: number, error: unknown) => void;
  /**
   * Issue #3655: broker-aware chain-source resolver, mirroring
   * UnifiedOptionsService.resolveEngineClient (tenant broker →
   * Alpaca platform chain source / etrade client / throw
   * provider_unsupported). executeOptionsSymbol prefers this over
   * createETradeService. When absent (legacy callers/tests), the
   * executor falls back to the E*TRADE-only factory — the host
   * (asyncJobs) always binds the resolver, so production never
   * takes the fallback.
   */
  resolveChainSource?: (
    chain: ShardChainContext
  ) => Promise<OptionChainSource>;
  sessionId: string;
  /**
   * Issue #1368: test seam for the nasdaq feed shard — the listings
   * fetcher the platform nasdaq adapter wraps. Production leaves it
   * unset and the shard uses the listings module, exactly as before.
   */
  fetchListings?: () => Promise<unknown>;
}

/**
 * #2303 (#1976 step 1): the data-provider platform ports for
 * the shard executors, built from deps.env (AGENT_DB) via the
 * shared production build and memoized per env object. When
 * bound, bootstraps/route reads run on D1 through the config
 * port and captures land through the capture port; unbound,
 * the executors keep the deps.sql path unchanged.
 */
const shardPortsByEnv = new WeakMap<object, Promise<DataProviderPorts>>();

function shardPorts(deps: ShardExecutorDeps): Promise<DataProviderPorts> {
  let pending = shardPortsByEnv.get(deps.env);
  if (!pending) {
    pending = buildDataProviderPorts(deps.env as { AGENT_DB?: never });
    shardPortsByEnv.set(deps.env, pending);
  }
  return pending;
}

async function shardBootstrap(deps: ShardExecutorDeps): Promise<DataProviderPorts> {
  const ports = await shardPorts(deps);
  if (ports.config) await ports.config.bootstrapDataProviders();
  return ports;
}

function chainRows(deps: ShardExecutorDeps, chainId: string): ShardRow[] {
  return chainRowsFromSql(deps.sql, chainId, deps.sessionId);
}

/**
 * Issue #3655: the broker-aware chain source for one options shard,
 * mirroring UnifiedOptionsService.resolveEngineClient. The broker
 * recorded on the chain at submission wins — a chain executes under
 * the broker it was submitted with, never a fresh read that could
 * disagree mid-chain. Without a recorded broker, the tenant broker
 * is read fail-closed (readTenantBrokerSelection): unconfigured or
 * unreadable refuses loudly instead of defaulting to E*TRADE.
 * Non-etrade broker → that broker's platform chain source; no chain
 * source → throws provider_unsupported, never a silent E*TRADE
 * substitution. Test seam: deps.getChainSourceForBroker overrides
 * the registry lookup (production leaves it unset).
 */
export async function resolveShardChainSource(
  deps: Pick<
    ShardExecutorDeps,
    "env" | "orm" | "createETradeService"
  > & {
    getChainSourceForBroker?: (
      broker: string,
      args: { env: unknown; userLogin: string; environment?: string }
    ) => OptionChainSource | null;
  },
  chain: ShardChainContext
): Promise<OptionChainSource> {
  const broker =
    chain.brokerId ??
    (await (async () => {
      // Issue #3655: lazy import of providerConnections — it sits on
      // a load cycle with the trading barrel (providerConnections →
      // ../trading → unifiedOptionsService → providerConnections); a
      // static import here would bind unifiedOptionsService to the
      // real reader instead of a test's vi.mock of it.
      const { readTenantBrokerSelection } = await import("./providerConnections");
      const read = await readTenantBrokerSelection(
        deps.env as unknown as import("../types").Env
      );
      if (read.status !== "ok") throw new Error(read.error);
      return read.brokerId;
    })());
  if (broker === "etrade") {
    return deps.createETradeService(chain.userLogin, chain.environment).client;
  }
  if (!isBrokerId(broker)) {
    throw new Error(
      `provider_unsupported: broker "${broker}" is not a registered broker; no other broker's data is used in its place.`
    );
  }
  const chainSource = deps.getChainSourceForBroker
    ? deps.getChainSourceForBroker(broker, {
        env: deps.env,
        userLogin: chain.userLogin,
        environment: chain.environment,
      })
    : platformChainSource(
        TradingPlatformRegistry.getPlatform(
          broker,
          deps.env as never,
          deps.orm,
          chain.userLogin,
          chain.environment
        )
      );
  if (chainSource) return chainSource;
  throw new Error(
    `provider_unsupported: broker "${broker}" does not provide an options chain source (no getOptionChains/getOptionExpireDates); no other broker's data is used in its place.`
  );
}

/** Latest completed sibling result for (stage, shardKey), or null. */
function siblingResult(
  deps: ShardExecutorDeps,
  chainId: string,
  stage: string,
  shardKey: string
): any | null {
  const rows = chainRows(deps, chainId).filter(
    (r) => r.stage === stage && r.shardKey === shardKey && r.status === "completed"
  );
  if (rows.length === 0) return null;
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return (rows[0].result ?? null) as any;
}

async function symbolsForUniverse(chain: ShardChainContext, listings: any[]): Promise<string[]> {
  const { UNIVERSES, resolveUniverse } = await import("../trading");
  const universeDef = (UNIVERSES as any)[chain.universe];
  const maxSymbols = chain.maxItems ?? universeDef?.defaultMaxSymbols ?? 0;
  const resolved = resolveUniverse(chain.universe as any, listings);
  const syms = resolved.map((s: any) => (typeof s === "string" ? s : s.symbol));
  return maxSymbols > 0 ? syms.slice(0, maxSymbols) : syms;
}

/**
 * Issue #1368: the nasdaq feed shard acquires through the platform
 * nasdaq adapter (the feedEtrade precedent: bootstrap this chain's
 * platform store, bind the adapter with capture deps, mint nothing —
 * the chain id IS the run id, so the listings capture is run-linked
 * to the chain). The return shape is unchanged ({ listings }), so
 * the etrade shard's sibling consumption is untouched; the retry
 * policy, bucket, and label are unchanged — only the fetch goes
 * through the adapter.
 * Issue #1378: the production path resolves through the route
 * table (nasdaqUniverseRouteBundle → reader → binder) instead of
 * hand-building the adapter around the listings module directly.
 * When deps.fetchListings is set, the pre-#1378 hand-built path
 * runs byte-identical — that is the #1368 feed-shard pin's
 * execution seam (stub fetcher + MockSqlStorage, seeded but not
 * enabled, which route resolution would reject), and existing-test
 * edits are out of scope for this slice.
 */
async function feedNasdaq(deps: ShardExecutorDeps, chain: ShardChainContext): Promise<{ listings: unknown }> {
  const policy = resolvePipelinePolicy(deps.env).retry[SHARD_RETRY_BUCKET.feed];
  if (deps.fetchListings) {
    const { bootstrapDataProviders, createNasdaqDataProvider } = await import("../trading");
    const ports = await shardPorts(deps);
    if (ports.config) await ports.config.bootstrapDataProviders();
    else bootstrapDataProviders(deps.sql as any);
    const adapter = createNasdaqDataProvider(deps.fetchListings as never, {
      capture: { sql: deps.sql as any, blobStorage: deps.storage as any, env: deps.env as any, ...(ports.captures ? { capturePort: ports.captures } : {}) },
    });
    const listings = await withRetry(
      () =>
        adapter
          .getScreenUniverse!({ runId: chain.chainId, userLogin: chain.userLogin })
          .then((r) => r.result),
      policy,
      retryWithHistory(deps, { label: "shard.feed.nasdaq" })
    );
    return { listings };
  }
  const {
    nasdaqUniverseRouteBundle,
    nasdaqUniverseProviderFromRoute,
    bindNasdaqUniverseDeps,
  } = await import("../trading");
  const bundlePorts = await shardPorts(deps);
  const bundle = await nasdaqUniverseRouteBundle({
    sql: deps.sql as any,
    storage: deps.storage as any,
    env: deps.env as any,
    userLogin: chain.userLogin,
    runId: chain.chainId,
    ...(bundlePorts.config ? { configPort: bundlePorts.config } : {}),
    ...(bundlePorts.captures ? { capturePort: bundlePorts.captures } : {}),
  });
  const provider = nasdaqUniverseProviderFromRoute(
    bundle.registry,
    bundle.configs,
    bundle.routes
  );
  const bound = bindNasdaqUniverseDeps(provider, bundle.runContext);
  const listings = await withRetry(() => bound.fetchListings(), policy, retryWithHistory(deps, { label: "shard.feed.nasdaq" }));
  return { listings };
}

async function feedEtrade(
  deps: ShardExecutorDeps,
  chain: ShardChainContext
): Promise<{ quotes: unknown }> {
  const nasdaq = siblingResult(deps, chain.chainId, "feed", "nasdaq");
  if (!nasdaq?.listings) {
    throw new Error("Feed shard etrade blocked: nasdaq shard has no completed listings result.");
  }
  const symbols = await symbolsForUniverse(chain, nasdaq.listings);
  // Issue #1356: the feed shard binds the platform quote seam
  // (replacing the E2 LiveScreenerDeps binding): bootstrap this
  // chain's platform store (seed + enable etrade), construct the
  // adapter over the chain's ETradeService, resolve the quotes
  // route's etrade primary, and bind the etrade-only deps over it.
  // The chain id is the run id, so every quote the shard acquires
  // is captured under the chain's run.
  const {
    bootstrapDataProviders,
    createETradeDataProvider,
    DataProviderRegistry,
    etradeQuoteProviderFromRoute,
    listProviderConfigs,
    listCapabilityRoutes,
    bindEtradeQuoteDeps,
  } = await import("../trading");
  const ports = await shardBootstrap(deps);
  if (!ports.config) bootstrapDataProviders(deps.sql as any);
  const service = deps.createETradeService(chain.userLogin, chain.environment);
  const adapter = createETradeDataProvider(service as any, {
    capture: { sql: deps.sql, blobStorage: deps.storage, env: deps.env, ...(ports.captures ? { capturePort: ports.captures } : {}) } as any,
  });
  const registry = new DataProviderRegistry();
  registry.register(adapter);
  const provider = etradeQuoteProviderFromRoute(
    registry,
    ports.config ? await ports.config.listProviderConfigs() : listProviderConfigs(deps.sql as any),
    ports.config ? await ports.config.listCapabilityRoutes() : listCapabilityRoutes(deps.sql as any)
  );
  const quoteDeps = bindEtradeQuoteDeps(provider, {
    runId: chain.chainId,
    userLogin: chain.userLogin,
  } as any);
  const policy = resolvePipelinePolicy(deps.env).retry[SHARD_RETRY_BUCKET.feed];
  if (!quoteDeps.fetchQuotes) {
    throw new Error("Feed shard etrade blocked: the bound E*TRADE deps expose no quote fetcher.");
  }
  const fetchQuotes = quoteDeps.fetchQuotes;
  const quotes = await withRetry(() => fetchQuotes(symbols), policy, retryWithHistory(deps, { label: "shard.feed.etrade" }));
  return { quotes };
}

async function feedYahoo(
  deps: ShardExecutorDeps,
  chain: ShardChainContext
): Promise<{ technicals: unknown }> {
  const nasdaq = siblingResult(deps, chain.chainId, "feed", "nasdaq");
  if (!nasdaq?.listings) {
    throw new Error("Feed shard yahoo blocked: nasdaq shard has no completed listings result.");
  }
  const symbols = await symbolsForUniverse(chain, nasdaq.listings);
  const { YahooFinanceProvider } = await import("./marketDataResearch");
  const {
    bootstrapDataProviders,
    createYahooDataProvider,
    bindYahooHistoryDeps,
    fetchPlatformTechnicalsBatch,
  } = await import("../trading");
  // Issue #2144 (owner ruling): the Yahoo shard fills COLUMNS only.
  // It no longer fetches quotes for E*TRADE-missed symbols and no
  // longer returns gapFillQuotes — E*TRADE-missed symbols go missing
  // honestly, and assembly uses E*TRADE quotes only. The shard still
  // runs (the feed gate requires it) and still returns technicals.
  // Issue #1331 (fix): binding failure degrades to a null-fetching
  // deps object, so the batch still runs and every symbol gets
  // honest null technicals — the shard never fails on history
  // binding alone, matching the old fetchTechnicalsBatch contract.
  let historyDeps;
  try {
    const ports = await shardBootstrap(deps);
    if (!ports.config) bootstrapDataProviders(deps.sql as any);
    const historyAdapter = createYahooDataProvider(new YahooFinanceProvider(deps.env as any), deps.env as any, {
      capture: { sql: deps.sql as any, blobStorage: deps.storage as any, env: deps.env as any, ...(ports.captures ? { capturePort: ports.captures } : {}) },
      // Issue #1745: shard Yahoo history runs behind the yahoo breaker.
      breaker: defaultBreakerRegistry().breakerFor("yahoo"),
    });
    historyDeps = bindYahooHistoryDeps(historyAdapter, {
      runId: chain.chainId,
      userLogin: chain.userLogin,
    });
  } catch (err) {
    structuredLog.warn("shard.feed_yahoo_history_binding_failed", {
      message: "[feedYahoo] History binding failed — technicals degrade to null",
      error: err instanceof Error ? err.message : String(err),
    });
    historyDeps = { fetchBars: async () => null };
  }
  // Issue #3931: persisted technicals are the PRIMARY source —
  // the technicals job's stored daily bars, read once up front.
  // A fresh copy serves every symbol it carries (labelled
  // persisted); a missing or stale copy degrades to the live deps
  // above, exactly as before. The read never fails the shard: any
  // failure here falls back to live.
  try {
    const { createFeedDatasetAdapter } = await import("../data/createFeedDatasetPorts");
    const feedJobs = await import("./feedJobs");
    const { withPersistedBarsFirst } = await import("../trading");
    const datasetStore = createFeedDatasetAdapter(
      deps.env as { AGENT_DB?: unknown },
    );
    if (datasetStore) {
      const envStrings: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(deps.env)) {
        if (typeof value === "string") envStrings[key] = value;
      }
      const technicalsDef = feedJobs
        .buildFeedJobRegistry(envStrings)
        .get(feedJobs.YAHOO_NASDAQ100_TECHNICALS_JOB_ID);
      const persisted = await feedJobs.readPersistedTechnicalsBars(datasetStore, {
        ...(technicalsDef
          ? { maxAgeSeconds: technicalsDef.staleAfterMinutes * 60 }
          : {}),
        nowMs: Date.now(),
      });
      if (persisted && !persisted.stale) {
        historyDeps = withPersistedBarsFirst(historyDeps, persisted);
      }
    }
  } catch {
    // Persisted read unavailable — the live fallback stands.
  }
  const technicalsMap = await fetchPlatformTechnicalsBatch(historyDeps, symbols);
  return {
    technicals: [...technicalsMap.entries()].map(([symbol, t]) => ({ ...t, symbol })),
  };
}

async function generateAssemble(
  deps: ShardExecutorDeps,
  chain: ShardChainContext
): Promise<Record<string, unknown>> {
  if (chain.screenType === "options") return generateAssembleOptions(deps, chain);
  // Completeness gate, enforced at execution too (not only at
  // planning): a manually retried assemble must still refuse a
  // partial feed, naming every blocker.
  const rows = chainRows(deps, chain.chainId);
  const gate = assessFeedGate(rows);
  if (!gate.ready) {
    const names = gate.blockedBy.map((b) => `${b.shardKey} (${b.reason})`).join(", ");
    throw new Error(`Assembly blocked by feed shard(s): ${names} — no partial report.`);
  }
  const etrade = siblingResult(deps, chain.chainId, "feed", "etrade");
  const yahoo = siblingResult(deps, chain.chainId, "feed", "yahoo");
  const etradeQuotes = ((etrade?.quotes ?? []) as any[]) || [];
  // Issue #2144 (owner ruling): assembly uses E*TRADE quotes only.
  // A Yahoo sibling row carrying legacy gapFillQuotes (stored by a
  // pre-fix chain) is ignored — Yahoo fills columns (technicals
  // below), never rows.
  const quotes = etradeQuotes;
  const technicalsMap = new Map(
    (((yahoo?.technicals ?? []) as any[]) || []).map((t: any) => [t.symbol, t])
  );
  const {
    DynamicMarketScreener,
    screenUniverse,
    buildAllStocks,
    attachFactorGrades,
    attachTechnicals,
    selectStandouts,
    toOpportunityStock,
  } = await import("../trading");
  const screener = new DynamicMarketScreener();
  const screenResult = screenUniverse(
    screener,
    { quotes, provider: "etrade" } as any,
    { sector: "ALL" } as any
  );
  const allStocks = attachTechnicals(
    attachFactorGrades(buildAllStocks(quotes, screenResult.stocks)),
    technicalsMap as any
  );
  const opportunities = selectStandouts(screenResult.stocks, chain.maxItems ?? 5).map((s) =>
    toOpportunityStock(s)
  );
  return {
    opportunities,
    allStocks,
    totalScanned: screenResult.totalScanned,
    matchedCount: screenResult.matchedCount,
    universe: chain.universe,
    timestamp: chain.timestamp,
    provider: "sharded",
  };
}

async function executeOptionsSymbol(
  deps: ShardExecutorDeps,
  chain: ShardChainContext,
  symbol: string,
  inputs: Record<string, unknown> = {}
): Promise<unknown> {
  const request = chain.options;
  if (!request) throw new Error("Options shard is missing its scan request.");
  // Issue #3655: the chain source is broker-aware — an Alpaca-broker
  // chain fetches Alpaca chains, never E*TRADE. The resolver is the
  // broker-aware seam; the E*TRADE-only factory below is the legacy
  // fallback for callers that did not bind a resolver.
  const engineClient = deps.resolveChainSource
    ? await deps.resolveChainSource(chain)
    : deps.createETradeService(chain.userLogin, chain.environment).client;
  const service = { client: engineClient };
  const eventCalendar = inputs.eventCalendar ?? await (await import("./eventCalendar")).getSymbolEventCalendar(symbol);
  const policy = resolvePipelinePolicy(deps.env).retry[SHARD_RETRY_BUCKET.feed];
  return withRetry(async () => {
    // Issue #3186 step 3e - the per-symbol shard scan goes through
    // the one scanner pipeline instead of the direct
    // scanOpportunitiesRetired4068 call (same engine, staged). The template,
    // scan options (incl. the chain-timestamp `now` override for
    // deterministic provenance) and the skipped-verdict retry
    // contract are unchanged; the shard result is read from the
    // shapeReport artifact. No requestRecord: the chain options ARE
    // the request - the assembled result's snapshot comes from the
    // scanner's own snapshot, exactly as the direct call produced
    // it. No scanRunStore: per-symbol shard results are stored as
    // chain rows and the ASSEMBLED result is recorded by
    // generateAssembleOptions - the direct path never saved
    // per-symbol rows to mas_opportunity_scans either.
    const shardRunId = `shard-scan:${chain.chainId}:${symbol}`;
    const shardStorage = memoryStageStorage();
    // Issue #4271: a shard is a strategy screen — it defines the
    // strategy job (strategy-screen:<runId>), not the options job.
    const shardOutcome = await runStrategyScreenViaEngine(
      {
        runId: shardRunId,
        userLogin: chain.userLogin,
        trigger: chain.trigger ?? "scheduled",
        request: {
          assetClass: "options",
          runIdentity: { runId: shardRunId },
          trigger: chain.trigger ?? "scheduled",
          classInput: {
            scan: {
              symbols: [symbol],
              template: {
                thesis: request.thesis as any,
                targetDate: request.targetDate,
                expectedIvDirection: "unchanged",
                maxPlannedLoss: request.maxPlannedLoss ?? 1000,
                minRewardRisk: request.minRewardRisk ?? 1.5,
                // Issue #2577: the scope's DTE band rides into the shard instead of
                // being dropped here (the per-symbol runner previously ignored it).
                ...(request.minDte !== undefined ? { minDte: request.minDte } : {}),
                ...(request.maxDte !== undefined ? { maxDte: request.maxDte } : {}),
                allowedStrategies: request.allowedStrategies?.length ? request.allowedStrategies as any : ["all"],
                // Issue #2091: the chain's scheduled scope rides into the
                // per-symbol template; manual chains omit it (thesis default).
                ...(request.evaluateAllStrategies === true ? { evaluateAllStrategies: true } : {}),
                // Issue #2600: the chain's canonical mode + far-dated toggle
                // ride the same template (the scanner resolves the mode once;
                // a conflicting alias pair throws there, never silently).
                ...(request.strategyMode !== undefined ? { strategyMode: request.strategyMode } : {}),
                ...(request.farDated !== undefined ? { farDated: request.farDated } : {}),
              },
              options: {
                riskProfile: request.riskProfile,
                maxSymbols: 1,
                eventCalendarBySymbol: eventCalendar
                  ? { [symbol]: eventCalendar as any }
                  : undefined,
                now: new Date(chain.timestamp),
              },
            },
          },
        } as ScannerPipelineRequest,
      },
      {
        stages: createScannerScreenPorts({
          agents: {
            data: new OptionsDataAgent(new DynamicOptionsScreener(service.client)),
            risk: new StrategyRiskAgent(),
            recommender: new RecommendationAgent(),
          },
          storage: shardStorage,
        }),
        claims: memoryStageClaims(),
        queue: (deps.env.SCREENER_EVENTS as unknown as StageQueueSend | null) ?? null,
        // Issue #4068: the engine run record is durable in the
        // shard executor's SQLite.
        engineStores: optionsEngineStoresFromSql(deps.sql),
      },
    );
    if (shardOutcome.outcome !== "completed") {
      throw new Error(`Options shard scan failed at ${shardOutcome.failedStage}: ${shardOutcome.reason}`);
    }
    const result = await shardStorage.get<OpportunityScanResult>(
      optionsArtifactKey(shardRunId, "shapeReport"),
    );
    if (!result) {
      throw new Error(`Options shard scan completed without a report artifact for ${symbol}; refusing to assemble from nothing.`);
    }
    // The scanner converts chain-fetch exceptions into skipped rows.
    // Re-throw those here so the shard's acquisition retry bucket can
    // retry this one underlying independently.
    if (result.matrix[0]?.verdict === "skipped") {
      throw new Error(result.matrix[0].skipReason || `Option chain unavailable for ${symbol}`);
    }
    return result;
  }, policy, retryWithHistory(deps, { label: `shard.feed.options.${symbol}` }));
}

async function generateAssembleOptions(
  deps: ShardExecutorDeps,
  chain: ShardChainContext
): Promise<Record<string, unknown>> {
  const symbols = [...new Set((chain.options?.symbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const rows = chainRows(deps, chain.chainId);
  const results: any[] = [];
  const failed: Array<{ symbol: string; reason: string }> = [];
  for (const symbol of symbols) {
    const attempts = rows.filter((row) => row.stage === "feed" && row.shardKey === symbol)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = attempts[attempts.length - 1];
    const completed = [...attempts].reverse().find((row) => row.status === "completed");
    if (completed?.result && (latest?.status === "completed" || latest?.status === "failed")) {
      results.push(completed.result);
    } else {
      failed.push({ symbol, reason: latest?.error || `Option chain shard ended with status ${latest?.status ?? "missing"}` });
    }
  }
  // The collation helper needs a successful shard as the source of the
  // request/config snapshot. If every acquisition failed, fail cleanly
  // before collation instead of dereferencing a missing first result.
  if (results.length === 0) {
    const topFailure = failed[0];
    throw new Error(
      `Options chain shards produced no evaluable symbols.${topFailure ? ` ${topFailure.symbol}: ${topFailure.reason}` : ""}`
    );
  }
  const { collateOpportunityScanShards } = await import("../trading");
  const assembled = collateOpportunityScanShards(symbols, results, failed, new Date(chain.timestamp), chain.options?.candidateLimit);
  if (assembled.coverage.evaluated === 0) {
    const top = assembled.partial?.topSkipReason;
    throw new Error(`Options chain shards produced no evaluable symbols.${top ? ` Top skip reason: ${top}` : ""}`);
  }
  const { recordOptionsRun } = await import("../agents/optionsRuns");
  await recordOptionsRun(deps.storage, {
    timestamp: chain.timestamp,
    success: true,
    trigger: chain.trigger ?? "scheduled",
    thesis: chain.options?.thesis ?? "bullish",
    symbols,
    withTrades: assembled.withTrades,
    summary: `Options screen — ${chain.options?.thesis ?? "bullish"}: ${assembled.withTrades} actionable setups; evaluated ${assembled.coverage.evaluated} of ${assembled.coverage.considered} underlyings.`,
    opportunities: assembled.opportunities,
  });
  return assembled as unknown as Record<string, unknown>;
}

async function generatePdf(
  deps: ShardExecutorDeps,
  chain: ShardChainContext
): Promise<{ format: string; key: string; fileName: string } | { format: string; status: "failed"; error: string }> {
  const dataset = siblingResult(deps, chain.chainId, "generate", "assemble");
  if (!dataset) throw new Error("Generate shard pdf blocked: assemble shard has no completed result.");
  const { runReportPipeline } = await import("./unifiedReportPipeline");
  const { screenerPdfFileName, optionsPdfFileName } = await import("../trading");
  // PDF generation is owned by ReportAssetAgent (#680/#914): this
  // shard delegates to runReportPipeline, it never calls the
  // generator directly.
  const out = await runReportPipeline(
    deps.env as { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
    deps.storage as any,
    {
      type: chain.screenType === "options" ? "options" : "screener",
      trigger: chain.trigger ?? "scheduled",
      result: dataset,
      userLogin: chain.userLogin,
      title: chain.screenType === "options"
        ? `Options scanner — ${chain.options?.thesis ?? "bullish"} (${chain.timestamp.slice(0, 10)})`
        : `Market screen — ${chain.universe}`,
      summary: chain.screenType === "options"
        ? `Evaluated ${(dataset.coverage as any)?.evaluated ?? dataset.scanned ?? 0} of ${(dataset.coverage as any)?.considered ?? dataset.scanned ?? 0} underlyings; ${dataset.withTrades ?? 0} actionable setups.`
        : `Scanned ${dataset.totalScanned} symbols, ${dataset.matchedCount} matched.`,
      timestamp: chain.timestamp,
    }
  );
  if (out.pdfStatus !== "generated" || !out.pdfKey) {
    // Issue #2621 P0 (options only): a renderer failure is a
    // per-format failed outcome, not a chain failure — the shard
    // job completes with this result, so the planner advances past
    // it and the run still ships the formats that generated. Stock
    // chains keep the existing throw (their stop semantics are
    // unchanged by this slice). A missing assemble dataset above
    // still throws for both: that is a blocker, not a renderer.
    const error = out.pdfError || "PDF generation failed in the report pipeline.";
    if (chain.screenType === "options") return { format: "pdf", status: "failed", error };
    throw new Error(error);
  }
  return {
    format: "pdf",
    key: out.pdfKey,
    fileName: chain.screenType === "options" ? optionsPdfFileName(dataset as any) : screenerPdfFileName(dataset),
  };
}

async function generateTabular(
  deps: ShardExecutorDeps,
  chain: ShardChainContext,
  format: "xlsx" | "csv"
): Promise<{ format: string; key: string; fileName: string } | { format: string; status: "failed"; error: string }> {
  const dataset = siblingResult(deps, chain.chainId, "generate", "assemble");
  if (!dataset) {
    throw new Error(`Generate shard ${format} blocked: assemble shard has no completed result.`);
  }
  const policy = resolvePipelinePolicy(deps.env).retry[SHARD_RETRY_BUCKET.generate];
  const prefix = chain.screenType === "options"
    ? (format === "xlsx" ? "options:xlsx:" : "options:csv:")
    : (format === "xlsx" ? "screener:xlsx:" : "screener:csv:");
  const { putReportPdf } = await import("./reportBlobStore");
  // Issue #2869 slice 3: the tabular leg runs through the
  // tabular-aware stage consumer (src/workflows/
  // stageTabularConsumer.ts) — persisted assemble dataset
  // only, injected generate + store. No claims store is
  // passed here, deliberately: the chain's own shard job
  // row is this leg's exactly-once guard (a completed
  // generate shard is never re-executed, and a crashed
  // in-flight shard must be allowed to regenerate — a
  // pre-generation SQL claim would suppress that recovery
  // with no key to hand the store shard). The consumer's
  // claim path is exercised by its own tests and remains
  // available to callers whose retry cannot recover a key.
  // The per-domain failure rule is UNCHANGED and stays at
  // this caller (issue #2621 P0, options only): generate
  // + store failures are a per-format failed outcome, not
  // a chain failure — same rule as generatePdf above.
  // Stock chains keep the existing throw. The blob store
  // is the generate leg's store: putReportPdf writes the
  // bytes (R2 when bound, DO storage otherwise) under the
  // per-run key. The mas_reports row is the store shard's
  // job. Content type follows the goal-screen pattern
  // (explicit per format), not persistRun's PDF default.
  const { consumeTabularGenerate } = await import("../workflows/stageTabularConsumer");
  let outcome: Awaited<ReturnType<typeof consumeTabularGenerate>>;
  try {
    outcome = await consumeTabularGenerate({
      runId: `${chain.screenType === "options" ? "options" : "screener"}:${chain.chainId}`,
      format,
      dataset,
      keyPrefix: prefix,
      generate: async ({ format: fmt, dataset: ds }) =>
        withRetry(
          async () => {
            // Issue #2911 (G4): the stock tabular leg routes through the one
            // generation module (src/services/stockReportArtifacts.ts) — the
            // same code persistRun uses. The options branches below keep
            // their own options generators: options is a separate domain
            // (#2621), not a second stock path.
            if (fmt === "xlsx") {
              if (chain.screenType === "options") {
                const { generateOptionsXlsx, optionsXlsxFileName, adaptOpportunityScanToOptionScreenResult } = await import("../trading");
                const adapted = adaptOpportunityScanToOptionScreenResult(ds as any);
                return { fileName: optionsXlsxFileName(adapted), bytes: generateOptionsXlsx(adapted) };
              }
              const { generateStockTabularBytes } = await import("./stockReportArtifacts");
              return generateStockTabularBytes("xlsx", ds as never);
            }
            if (chain.screenType === "options") {
              const { generateOptionsCsv, optionsCsvFileName, adaptOpportunityScanToOptionScreenResult } = await import("../trading");
              const adapted = adaptOpportunityScanToOptionScreenResult(ds as any);
              return { fileName: optionsCsvFileName(adapted), bytes: new TextEncoder().encode(generateOptionsCsv(adapted)) };
            }
            const { generateStockTabularBytes } = await import("./stockReportArtifacts");
            return generateStockTabularBytes("csv", ds as never);
          },
          policy,
          retryWithHistory(deps, { label: `shard.generate.${fmt}` }),
        ),
      store: async ({ key, fileName, bytes, contentType }) => {
        await putReportPdf(deps.env as any, deps.storage as any, key, fileName, bytes, contentType);
      },
      deadLetter: async ({ reason }) => {
        structuredLog.warn("shard.tabular_generate_dead_lettered", {
          message: `[shardExecutors] tabular generate dead-lettered: ${reason}`,
          reason,
        });
      },
    });
  } catch (err) {
    if (chain.screenType === "options") {
      return { format, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    throw err;
  }
  if (outcome.status !== "generated" || !outcome.key || !outcome.fileName) {
    // A dead-lettered (or, without claims, unreachable
    // duplicate-suppressed) tabular leg is a failed format,
    // never a silent skip: options records the per-format
    // failure; stock chains throw, as before.
    const reason = outcome.reason ?? "tabular generate produced no blob";
    if (chain.screenType === "options") {
      return { format, status: "failed", error: reason };
    }
    throw new Error(reason);
  }
  return { format, key: outcome.key, fileName: outcome.fileName };
}

async function storeFormat(
  deps: ShardExecutorDeps,
  chain: ShardChainContext,
  inputs: Record<string, unknown>
): Promise<{ format: string; key: string; reportId: string } | { format: string; key: string; status: "failed"; error: string }> {
  const format = String(inputs.format ?? "");
  const key = String(inputs.key ?? "");
  const fileName = String(inputs.fileName ?? "");
  if (!format || !key) throw new Error("Store shard requires format + key inputs.");
  // Serve-side honesty: the blob must read back, or the store
  // shard fails — a mas_reports row must never point at bytes
  // that are not there.
  const { getReportPdf } = await import("./reportBlobStore");
  const stored = await getReportPdf(deps.env as any, deps.storage as any, key);
  if (!stored) {
    // Issue #2621 P0 (options only): an unverifiable blob
    // downgrades its format instead of stopping the chain — the
    // serve planner reads this failed outcome and drops the format
    // from the run's links (see optionsArtifactsFromShardRows).
    // The row is still never written for this format, so no
    // mas_reports row points at missing bytes. Stock chains keep
    // the existing throw.
    if (chain.screenType === "options") {
      return { format, key, status: "failed", error: `Store shard ${format} blocked: blob ${key} is not readable.` };
    }
    throw new Error(`Store shard ${format} blocked: blob ${key} is not readable.`);
  }
  const provenance = shardProvenanceIds(chainRows(deps, chain.chainId));
  const row = deps.orm.storeCanonicalReport({
    runId: `${chain.screenType === "options" ? "options" : "screener"}:${chain.chainId}`,
    generationId: `${chain.screenType === "options" ? "options" : "screener"}:${chain.chainId}:${format}`,
    title: chain.screenType === "options"
      ? `Options scanner — ${chain.options?.thesis ?? "bullish"} (${format})`
      : `Market screen — ${chain.universe} (${format})`,
    source: chain.screenType === "options" ? "options_scanner" : "screener",
    summary: chain.screenType === "options"
      ? `Sharded options screen: ${chain.options?.thesis ?? "bullish"}, ${format} report, ${provenance.length} shards.`
      : `Sharded screen: ${chain.universe}, ${format} report, ${provenance.length} shards.`,
    body: { format, key, fileName, universe: chain.universe, thesis: chain.options?.thesis, chainId: chain.chainId, shardIds: provenance, trigger: chain.trigger ?? "scheduled" },
    createdAt: chain.timestamp,
    userLogin: chain.userLogin,
  },
  // Issue #1169 S4-1: thread deps.env so the seam indexes this
  // screener/options_scanner row at write time.
  deps.env);
  return { format, key, reportId: row?.reportId ?? `screener:${chain.chainId}:${format}` };
}

/**
 * Execute one shard.execute row's payload. Throws on failure —
 * the executor records the failure and the chain stops (a failed
 * feed shard additionally audits the assembly blocker by name).
 * Exception (issue #2621 P0, options chains only): a generate or
 * store format failure returns a completed { status: "failed" }
 * outcome instead of throwing, so one renderer or unverifiable
 * blob cannot kill the run — the planner advances past it and the
 * serve assembly drops that format from the run's links. Feed and
 * assemble failures still throw for every chain type.
 */
export async function executeShardJob(
  deps: ShardExecutorDeps,
  payload: ShardPayload
): Promise<unknown> {
  const { shard, chain } = payload;
  if (shard.stage === "feed" && chain.screenType === "options") {
    return executeOptionsSymbol(deps, chain, shard.key, payload.inputs);
  }
  if (shard.stage === "feed" && shard.key === "nasdaq") return feedNasdaq(deps, chain);
  if (shard.stage === "feed" && shard.key === "etrade") return feedEtrade(deps, chain);
  if (shard.stage === "feed" && shard.key === "yahoo") return feedYahoo(deps, chain);
  if (shard.stage === "generate" && shard.key === "assemble") return generateAssemble(deps, chain);
  if (shard.stage === "generate" && shard.key === "pdf") return generatePdf(deps, chain);
  if (shard.stage === "generate" && (shard.key === "xlsx" || shard.key === "csv")) {
    return generateTabular(deps, chain, shard.key);
  }
  if (shard.stage === "store") return storeFormat(deps, chain, payload.inputs ?? {});
  throw new Error(`Unsupported shard: ${shard.stage}/${shard.key}`);
}
