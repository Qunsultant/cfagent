/**
 * Discovery service (issue #14, slice 5) — runs the Phase 1 pipeline
 * over a universe and persists the run.
 *
 * Per name, in order: load the chain snapshot (no contracts -> the
 * name is pre-screened out of the run entirely), fetch daily bars,
 * read the IV history, characterize, run the optionability
 * pre-screen, detect signals, infer a thesis (abstentions recorded
 * with their stage and reason), derive the expected move from the
 * name's own chain, build the request (the #16 event calendar
 * attached, projected so engine requests stay stable), run the
 * options pipeline, and judge the pick with the discovery fit gate.
 *
 * A name that throws anywhere in its flow counts as an error — the
 * run still completes and its counts reconcile (acceptance (e)).
 * Deltas are classified against the previous run of the same scope
 * (the store's latestForScope) before the new run is saved.
 *
 * All market access is injected (DiscoveryServiceDeps) so the
 * orchestration is unit-testable end to end; createDiscoveryService
 * wires the production dependencies. Note the pipeline loads its own
 * chain snapshot per expressed name (the panel pipeline's
 * contract) — characterization deliberately reads a separate,
 * earlier snapshot so inference never sees the expression's screen.
 *
 * #1639 (D3, retained with stated reason): this service is a
 * universe-scan / characterization / inference / persistence
 * pre-stage, not a parallel recommendation engine — every name it
 * expresses goes through runOptionsPanelViaEngine (the engine-routed
 * panel; the direct runPanelPipelineRetired4068 call was retired by #4068), i.e.
 * the kernel's discoverPanel. It is therefore retained alongside the
 * kernel,
 * not removed as a duplicate path.
 */

import {
  getDiscoveryConfig,
  getEtapiConfig,
  getOpportunityScannerConfig,
  type EtapiDiscoveryConfig,
} from "../config/etapiConfig";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import { platformChainSource, type ITradingPlatform } from "../trading";
import { getSymbolEventCalendar, toEventCalendarInfo, type SymbolEventCalendar } from "./eventCalendar";
import {
  bindYahooHistoryDeps,
  resolveYahooHistoryProvider,
  type DataProvider,
} from "../trading";
import type { CaptureBlobStorage } from "../trading";
import type { ProviderConfigStore } from "../data/providerConfigPorts";
import type { ProviderCaptureStore } from "../data/providerCapturePorts";
import type { YahooDailyBar } from "../trading";
import {
  chainAggregatesFromContracts,
  characterizeName,
  detectSignals,
  flowAggregatesFromItems,
  prescreenOptionability,
  type DiscoveryNameInputs,
  type FlowItemLike,
} from "../trading";
import { fetchRealMarketFlowsForSymbol } from "../trading";
import type { DiscoveryAlertStore } from "../data/discoveryAlertPorts";
import {
  dispatchDiscoveryAlerts,
  signedWebhookAlertSender,
  slackWebhookAlertSender,
  type DiscoveryAlertChannelSender,
  type DiscoveryAlertDispatchResult,
} from "./discoveryAlerts";
import { inferThesis } from "../trading";
import {
  buildDiscoveryRequest,
  expressDiscoverySetup,
  resolveDiscoveryFitGate,
  type DiscoveryRiskCaps,
} from "../trading";
import { estimateExpectedMove } from "../trading";
import {
  runOptionsPanelViaEngine,
  type OptionsEngineStores,
} from "../workflows/optionsScreenEngine";
import { OptionsDataAgent, type OptionsDataSnapshot } from "../trading";
import { DynamicOptionsScreener } from "../trading";
import {
  computeIvStats,
  type IvStats,
} from "../trading";
import {
  type DiscoverySetupItem,
  type DiscoverySetupStore,
  type StoredDiscoverySetupRun,
} from "../trading";
import {
  buildOptionsDiscoveryPorts,
  createOptionsDiscoveryPorts,
} from "../data/createOptionsDiscoveryPorts";
import type { IvHistoryStore } from "../data/ivHistoryPorts";
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import {
  classifyDiscoveryDeltas,
  type DiscoveryDelta,
} from "../trading";
import type { PipelineResult } from "../trading";
import type { StrategyRequest } from "../trading";

export interface DiscoveryServiceDeps {
  loadSnapshot(symbol: string): Promise<OptionsDataSnapshot>;
  fetchBars(symbol: string): Promise<YahooDailyBar[] | null>;
  ivStatsFor(symbol: string): Promise<IvStats | null>;
  calendarFor(symbol: string): Promise<SymbolEventCalendar>;
  /** Phase 2 (#18): the name's flow items (any provenance — the
   *  aggregator filters). A failure here must not fail the name:
   *  flow is a confidence modifier, so the service treats a flow
   *  outage as no flow data. */
  flowFor(symbol: string): Promise<readonly FlowItemLike[]>;
  /** Issue #4276: the pipeline runner receives the run's engine
   *  stores (when the caller threaded them) so each expression's
   *  panel run records durably over the caller's stores. */
  runPipeline(
    request: StrategyRequest,
    options?: { engineStores?: OptionsEngineStores | null },
  ): Promise<PipelineResult>;
  store: DiscoverySetupStore;
  /** Issue #18: alert dispatch wiring (Decision 2). Absent, runs
   *  never alert — dispatch is opt-in per caller. */
  alerts?: {
    store: DiscoveryAlertStore;
    senders: readonly DiscoveryAlertChannelSender[];
  };
  now(): Date;
}

export interface DiscoveryRunRequest {
  symbols: string[];
  /** Comparability key — successive runs of one scope delta against
   *  each other (a schedule id, a watchlist universe, an ad-hoc set). */
  scopeKey: string;
  source: string;
  caps: DiscoveryRiskCaps;
  userLogin?: string;
  /** Issue #4276: the engine stores the run's panel expressions
   *  record over (the #4066 pattern — threaded by the NLQ leg from
   *  engineSql). Absent, each expression runs over in-memory stores
   *  (the #4069 accepted-absent discipline) and leaves no durable
   *  pipeline record. */
  engineStores?: OptionsEngineStores | null;
  /** Issue #18: Strategy Profile biasing — the resolved profile's
   *  allowed strategy types. Ranking only: the service adds the
   *  configured boost for pick selection; signals, inference, and
   *  recorded scores are unaffected. */
  profileBias?: { preferredTypes: readonly string[] };
}

export interface DiscoveryRunOutcome {
  run: StoredDiscoverySetupRun;
  deltas: DiscoveryDelta[];
  errors: Array<{ symbol: string; message: string }>;
  /** Issue #18 Decision 2: present only when the caller wired
   *  alert dispatch — interactive surfaces leave it off; scheduled
   *  runs opt in. */
  alerts?: DiscoveryAlertDispatchResult;
}

/** Stable fingerprint of the config a run executed under: the
 *  discovery section plus the scanner fit gate it composes with.
 *  Provenance, not security — a short djb2 hex is enough to tell two
 *  runs' calibrations apart. */
export function hashDiscoveryConfig(
  discovery: EtapiDiscoveryConfig = getDiscoveryConfig(),
): string {
  const payload = JSON.stringify({ discovery, fitGate: getOpportunityScannerConfig().fitGate });
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash + payload.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export async function runDiscovery(
  deps: DiscoveryServiceDeps,
  request: DiscoveryRunRequest,
): Promise<DiscoveryRunOutcome> {
  const discoveryConfig = getDiscoveryConfig();
  const scannerConfig = getOpportunityScannerConfig();
  const gate = resolveDiscoveryFitGate(scannerConfig, discoveryConfig);
  const now = deps.now();

  const items: DiscoverySetupItem[] = [];
  const errors: Array<{ symbol: string; message: string }> = [];
  let prescreenedOut = 0;

  const symbols = [...new Set(request.symbols.map((s) => s.toUpperCase().trim()).filter(Boolean))];

  for (const symbol of symbols) {
    try {
      const snapshot = await deps.loadSnapshot(symbol);
      if (snapshot.validationError || snapshot.contracts.length === 0) {
        prescreenedOut++;
        continue;
      }
      const bars = (await deps.fetchBars(symbol)) ?? [];
      const spot = bars.length > 0 ? bars[bars.length - 1].close : snapshot.contracts[0].underlyingPrice;
      const chain = chainAggregatesFromContracts(snapshot.contracts, spot);
      // Issue #18: the calendar is fetched once, up front — the
      // characterization's event signals read the same projection
      // the request later carries (issue #16 pattern).
      const eventCalendar = toEventCalendarInfo(await deps.calendarFor(symbol));
      // Issue #18: flow failures abstain the FLOW signals, never
      // the name (flow only ever modifies confidence).
      const flowItems = await deps.flowFor(symbol).catch(() => [] as FlowItemLike[]);
      const inputs: DiscoveryNameInputs = {
        symbol,
        bars,
        ivStats: await deps.ivStatsFor(symbol),
        chain,
        eventCalendar,
        flow: flowAggregatesFromItems(flowItems),
      };

      const prescreen = prescreenOptionability(inputs, discoveryConfig);
      if (!prescreen.optionable) {
        items.push({
          kind: "abstention",
          symbol,
          stage: "prescreen",
          reason: prescreen.reason,
          nearMissSignals: [],
        });
        continue;
      }

      const characterization = characterizeName(inputs, discoveryConfig);
      const signals = detectSignals(characterization, discoveryConfig);
      const inference = inferThesis(
        characterization,
        signals,
        discoveryConfig,
        scannerConfig.targetEmMultiples,
      );
      if (!inference.inferred) {
        items.push({
          kind: "abstention",
          symbol,
          stage: "inference",
          reason: inference.reason,
          nearMissSignals: inference.nearMissSignals,
        });
        continue;
      }

      const expectedMove = estimateExpectedMove(snapshot.contracts, spot, now);
      const built = buildDiscoveryRequest({
        characterization,
        inference,
        expectedMove,
        caps: request.caps,
      });
      if (!built.built) {
        items.push({
          kind: "abstention",
          symbol,
          stage: "expression",
          reason: built.reason,
          nearMissSignals: [],
        });
        continue;
      }

      // Issue #16 pattern: the calendar is server-fetched and
      // projected before it touches the request — the projection
      // computed above for characterization is reused verbatim.
      built.request.eventCalendar = eventCalendar;

      const expression = await expressDiscoverySetup(
        // Issue #4276: the run's engine stores ride into the
        // pipeline runner so each expression records durably.
        { run: (req) => deps.runPipeline(req, { engineStores: request.engineStores }) },
        built.request,
        gate,
        request.profileBias && request.profileBias.preferredTypes.length > 0
          ? { preferredTypes: request.profileBias.preferredTypes, points: discoveryConfig.profileBiasPoints }
          : undefined,
      );
      const best = expression.pick.best;
      if (!best || expression.gate.bucket === "no_fit") {
        items.push({
          kind: "abstention",
          symbol,
          stage: "expression",
          reason:
            expression.gate.reasons.join("; ") ||
            expression.pick.rationale.join("; ") ||
            "no expressible setup",
          nearMissSignals: [],
        });
        continue;
      }
      items.push({
        kind: "setup",
        symbol,
        thesis: inference.thesis,
        ruleId: inference.ruleId,
        confidence: inference.confidence,
        discoveryScore: best.compositeScore,
        gateBucket: expression.gate.bucket,
        targetPrice: built.request.targetPrice,
        targetDate: built.request.targetDate,
        firedSignals: inference.firedSignals,
        evidence: inference.rationale,
        rollup: expression.rollup.map((r) => ({
          type: r.type,
          label: r.label,
          compositeScore: r.compositeScore,
        })),
      });
    } catch (error) {
      errors.push({ symbol, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const counts = {
    considered: symbols.length,
    setups: items.filter((i) => i.kind === "setup").length,
    abstentions: items.filter((i) => i.kind === "abstention").length,
    prescreenedOut,
    errors: errors.length,
  };

  const previous = await deps.store.latestForScope(request.scopeKey, {
    userLogin: request.userLogin,
  });
  const deltas = classifyDiscoveryDeltas(previous?.items ?? [], items, discoveryConfig.deltaScoreThreshold);

  const run = await deps.store.save({
    createdAt: now.toISOString(),
    scopeKey: request.scopeKey,
    source: request.source,
    configHash: hashDiscoveryConfig(discoveryConfig),
    counts,
    items,
    ...(request.userLogin !== undefined ? { userLogin: request.userLogin } : {}),
  });

  // Issue #18 Decision 2: alerts dispatch after the run is saved
  // and its deltas classified — the alert records link this run.
  const alerts = deps.alerts
    ? await dispatchDiscoveryAlerts(deps.alerts, run, deltas, discoveryConfig)
    : undefined;

  return { run, deltas, errors, ...(alerts ? { alerts } : {}) };
}

/** Production wiring: ETrade chains (the unified service's own
 *  construction discipline), Yahoo bars, the env-aware IV history
 *  store (D1 when AGENT_DB is bound, #2337) and the SQL run
 *  stores, and the live calendar service. */
export function createDiscoveryService(args: {
  env: Env;
  userLogin: string;
  overrideEnv?: string;
  orm?: DatabaseORM;
  sql: { exec(query: string, ...params: unknown[]): Iterable<unknown> };
  /**
   * Issue #1331: blob handle for history capture. When supplied,
   * discovery bars are captured (raw + normalized, run-linked);
   * without it the binding still outcome-tracks every fetch via
   * the sql-derived recorder, but writes no capture rows.
   * Issue #1661: threaded at asyncJobs, the NLQ route, the
   * trading-integrations route, and UnifiedOptionsService.
   */
  blobStorage?: CaptureBlobStorage;
  /**
   * #2303 (#1976 step 1): the data-layer ports. When a host
   * supplies them, the history provider resolution runs its
   * bootstrap/transitions/route reads on D1 through the config
   * port and captures land through the capture port; otherwise
   * the sql path runs unchanged.
   */
  configPort?: ProviderConfigStore | null;
  capturePort?: ProviderCaptureStore | null;
  /** Issue #18: opt into Decision 2 alert dispatch for runs from
   *  this service instance. Channels are built from the
   *  environment: SLACK_WEBHOOK_URL (Slack), and
   *  DISCOVERY_ALERT_WEBHOOK_URL + DISCOVERY_ALERT_WEBHOOK_SECRET
   *  (signed webhook); the alert-log record is the in-app channel
   *  and always lands. */
  alerts?: boolean;
  /**
   * Issue #3388: the platform whose chains this run executes on. REQUIRED on
   * purpose — omitting it fails the type check, so a new call site cannot
   * silently borrow E*TRADE's client. A platform with no options chain source
   * refuses at composition, naming itself, rather than running on another
   * broker's data.
   */
  platform: ITradingPlatform;
}): { run(request: DiscoveryRunRequest): Promise<DiscoveryRunOutcome> } {
  const chainSource = platformChainSource(args.platform);
  if (!chainSource) {
    throw new Error(
      `${args.platform.platformId} has no options chain source, so no discovery run can execute on it. No other broker's chains were used.`,
    );
  }
  const screener = new DynamicOptionsScreener(chainSource);
  const dataAgent = new OptionsDataAgent(screener);
  // #2337 (#1976 step 2): the family stores come from the data
  // layer's composition root. The transaction-capable storage
  // is the blobStorage handle when it carries one — every
  // production caller passes the Durable Object storage object
  // there (ctx.storage); a blob handle without transactionSync
  // composes sequentially, exactly the legacy behaviour.
  const txStorage =
    args.blobStorage &&
    typeof (args.blobStorage as { transactionSync?: unknown }).transactionSync === "function"
      ? (args.blobStorage as unknown as DoTransactionStorage)
      : undefined;
  const ports = createOptionsDiscoveryPorts({
    sql: args.sql,
    ...(txStorage ? { storage: txStorage } : {}),
  });
  // #2337 cutover (R-2): IV stats read through the env-aware
  // build's IV store — D1 when AGENT_DB is bound — not the
  // sync root's DO store. createDiscoveryService is sync (its
  // callers construct it inline), so the store resolves
  // lazily on first use and is cached for the service
  // instance — the ensureHistoryProvider shape below. A
  // rejected resolution clears the cache so a later call
  // retries, and the failure surfaces to the caller: there
  // is no silent fallback to the abandoned DO series.
  let ivHistoryPromise: Promise<IvHistoryStore> | null = null;
  function ensureIvHistory(): Promise<IvHistoryStore> {
    if (!ivHistoryPromise) {
      ivHistoryPromise = buildOptionsDiscoveryPorts(args.env, {
        sql: args.sql,
        ...(txStorage ? { storage: txStorage } : {}),
      }).then((built) => built.ivHistory);
    }
    return ivHistoryPromise;
  }
  // Referenced so the config load (and its env validation) happens
  // at construction, like the unified service's constructor.
  void getEtapiConfig(args.env, args.overrideEnv);
  // Issue #1331: history through the platform — the provider
  // resolves lazily (createDiscoveryService is sync, the
  // lifecycle is async) on first fetchBars, then caches for the
  // service instance; the run id is minted per run() call below,
  // before any fetch, so every discovery fetch is attributable
  // to exactly one discovery run.
  let discoveryRunId = crypto.randomUUID();
  let historyProviderPromise: Promise<DataProvider> | null = null;
  function ensureHistoryProvider(): Promise<DataProvider> {
    if (!historyProviderPromise) {
      historyProviderPromise = resolveYahooHistoryProvider({
        sql: args.sql,
        env: args.env,
        userLogin: args.userLogin,
        ...(args.blobStorage ? { blobStorage: args.blobStorage } : {}),
        ...(args.configPort ? { configPort: args.configPort } : {}),
        ...(args.capturePort ? { capturePort: args.capturePort } : {}),
      });
    }
    return historyProviderPromise;
  }
  const deps: DiscoveryServiceDeps = {
    loadSnapshot: (symbol) => dataAgent.loadSnapshot({ symbol }),
    fetchBars: async (symbol) => {
      // Issue #1331 (fix): resolution failure degrades to null —
      // the old fetchYahooDailyHistory contract (missing history
      // means "indicator unavailable", never a thrown run). A
      // rejected cached promise is cleared so a later call retries
      // instead of inheriting a transient failure.
      let provider;
      try {
        provider = await ensureHistoryProvider();
      } catch {
        historyProviderPromise = null;
        return null;
      }
      return bindYahooHistoryDeps(provider, {
        runId: discoveryRunId,
        userLogin: args.userLogin,
      }).fetchBars(symbol);
    },
    ivStatsFor: async (symbol) => {
      let ivStore: IvHistoryStore;
      try {
        ivStore = await ensureIvHistory();
      } catch (err) {
        // Mirror fetchBars: a rejected cached resolution is
        // cleared so a later call retries instead of
        // inheriting a transient failure. The failure itself
        // surfaces — it never degrades to the DO store.
        ivHistoryPromise = null;
        throw err;
      }
      return computeIvStats(await ivStore.listSeries(symbol));
    },
    calendarFor: (symbol) => getSymbolEventCalendar(symbol),
    flowFor: (symbol) => fetchRealMarketFlowsForSymbol(symbol),
    // Issue #4068: the discovery panel runs through the one engine-routed
    // panel (runOptionsPanelViaEngine) over the same chainSource the
    // screener above was built from — no direct runPanelPipelineRetired4068 call.
    // Issue #4276: the run's engine stores ride as the panel's 6th
    // argument, so the expression records durably over the caller's
    // stores; absent, the panel builds in-memory stores explicitly.
    runPipeline: (request, options) =>
      runOptionsPanelViaEngine(chainSource, request, {}, args.userLogin, undefined, options?.engineStores),
    store: ports.discoverySetupRuns,
    ...(args.alerts
      ? {
          alerts: {
            store: ports.discoveryAlerts,
            senders: buildAlertSenders(args.env),
          },
        }
      : {}),
    now: () => new Date(),
  };
  return {
    run: (request) => {
      discoveryRunId = crypto.randomUUID();
      return runDiscovery(deps, request);
    },
  };
}

/** Channel senders from the environment — a channel exists only
 *  when its configuration does. */
function buildAlertSenders(env: Env): DiscoveryAlertChannelSender[] {
  const senders: DiscoveryAlertChannelSender[] = [];
  const record = env as unknown as Record<string, string | undefined>;
  if (record.SLACK_WEBHOOK_URL) senders.push(slackWebhookAlertSender(record.SLACK_WEBHOOK_URL));
  if (record.DISCOVERY_ALERT_WEBHOOK_URL && record.DISCOVERY_ALERT_WEBHOOK_SECRET) {
    senders.push(
      signedWebhookAlertSender(record.DISCOVERY_ALERT_WEBHOOK_URL, record.DISCOVERY_ALERT_WEBHOOK_SECRET),
    );
  }
  return senders;
}

/** The omnichannel text rendering of a discovery run: one card line
 *  per setup (with its mandatory evidence) and per abstention (with
 *  its stage and reason), preceded by the reconciled coverage line.
 *  Shared by the unified action and the NLQ surface so every channel
 *  shows the same cards. */
export function formatDiscoveryRunSummary(outcome: DiscoveryRunOutcome): string {
  const { run, deltas, errors } = outcome;
  const c = run.counts;
  const lines: string[] = [
    `Discovery run over ${c.considered} name${c.considered === 1 ? "" : "s"}: ` +
      `${c.setups} setup${c.setups === 1 ? "" : "s"}, ${c.abstentions} abstention${c.abstentions === 1 ? "" : "s"}, ` +
      `${c.prescreenedOut} pre-screened out, ${c.errors} error${c.errors === 1 ? "" : "s"}.`,
  ];
  for (const item of run.items) {
    if (item.kind === "setup") {
      lines.push(
        `▸ ${item.symbol} ${item.thesis} — rule ${item.ruleId}, score ${item.discoveryScore} (${item.gateBucket}), ` +
          `target $${item.targetPrice} by ${item.targetDate}. Evidence: ${item.evidence}`,
      );
      // Issue #18: the per-type roll-up, when the run recorded one
      // (pre-roll-up stored runs render exactly as before).
      if (item.rollup && item.rollup.length > 0) {
        lines.push(
          `    Roll-up: ${item.rollup.map((r) => `${r.label} ${Math.round(r.compositeScore)}`).join(" · ")}`,
        );
      }
    } else {
      lines.push(`▸ ${item.symbol} — abstained (${item.stage}): ${item.reason}`);
    }
  }
  for (const e of errors) {
    lines.push(`▸ ${e.symbol} — error: ${e.message}`);
  }
  const notable = deltas.filter((d) => d.kind === "NEW" || d.kind === "STRENGTHENED" || d.kind === "GONE");
  if (notable.length > 0) {
    lines.push(
      `Changes vs the previous comparable run: ${notable.map((d) => `${d.symbol} ${d.thesis} ${d.kind}`).join("; ")}.`,
    );
  }
  return lines.join("\n");
}

