/**
 * Unified Options Intelligence Service
 *
 * Consolidates all option screening, strategy discovery, best-trade picking,
 * cross-symbol opportunity scanning, and LLM evaluations into a single,
 * omnichannel pipeline uniformly accessible via:
 * - UI (Discovery/Builder, Custom Thesis, NLQ, Chat)
 * - Slack (Interactive Block Kit cards with trade previews & approval buttons)
 * - Email (Responsive dark-mode HTML tables with greeks and payoffs)
 * - Voice (Pronunciation-tuned spoken speech and display markdown)
 * - Webhooks & MCP (Standardized JSON schemas)
 */

import type {
  Env,
  OptionScreenerFilter,
  OptionScreenResult,
  SlackBlockKitPayload,
  ETradeOptionChain,
} from "../../types";
import { DatabaseORM } from "../../orm";
import type { DataProviderPorts } from "../../data/buildDataProviderPorts";
import { TradingPlatformRegistry } from "../registry";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { platformChainSource } from "../optionChainSource";
import { ETradeService } from "../../services/etrade";
import type { ETradeRestClient } from "../etrade/client";
import {
  DataProviderRegistry,
  bootstrapDataProviders,
  createETradeDataProvider,
  listCapabilityRoutes,
  listProviderConfigs,
  type DataProvider,
  type DataRunContext,
  type ETradeCaptureDeps,
  type OptionsChainRequest,
  type Tier,
} from "../dataProviders";
import { DEFAULT_MAX_DTE, DynamicOptionsScreener } from "../optionsScreener";
import type { OptionChainSource } from "../optionChainSource";
import {
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  type PipelineOptions,
  type PipelineResult,
  recommendOptionStrategies,
  type EventCalendarInfo,
  type StrategyRequest,
  type StrategyRecommendationResult,
  type OptionThesis,
  type ExpectedIvDirection,
  type OptionStrategyType,
  type StrategyCandidate,
} from "./index";
import {
  memoryStageClaims,
  memoryStageStorage,
  runOptionsScreenWorkflow,
} from "../../workflows/optionsScreenWorkflow";
import {
  createStrategyScreenPorts,
  panelResultToPipelineResult,
} from "../../workflows/strategyScreenPorts";
import { optionsArtifactKey } from "../../workflows/optionsScreenPorts";
import type { PanelDiscoveryResult } from "../../services/recommendationKernel";
import { OpportunityScanner, type OpportunityScanResult, type ScanMode, type ScanRequestRecord, type ScanRequestTemplate, type ScanSymbolOverride } from "./opportunityScanner";
import type { ScanRunStore } from "./scanRunStore";
import { applyProfileFields, toProfileRef, type StrategyProfile } from "./strategyProfile";
import type { StrategyProfileStore } from "./strategyProfileStore";
import { buildTypeRollup } from "./strategies/ledger";
import { getEtapiConfig, type EtapiConfig } from "../../config/etapiConfig";
import { AGENT_DIDS } from "../../agents/did";
import { rankCandidatesWithLlm } from "./llmComparison";
import { defaultRegistry, REQUESTED_STRATEGY_NAMES } from "./strategies/catalog";
import { deriveFetchBands, filterDefinitionsByMode, resolveStrategyMode } from "./strategyChoice";
import { isDemoCalibratedChainsEnabled } from "../../config/demoMode";
import { SERVER_PALETTE } from "../../theme/serverPalette";

export type UnifiedOptionsAction =
  | "screen"
  | "strategies"
  | "best_trade"
  | "opportunities"
  | "recommend"
  | "compare"
  | "llm_ideas"
  | "llm_evaluate"
  | "config"
  | "catalog"
  | "discovery";

export type OmnichannelContext =
  | "ui"
  | "slack"
  | "email"
  | "voice"
  | "webhook"
  | "mcp"
  | "chat";

export interface UnifiedOptionsRequest {
  action: UnifiedOptionsAction;
  symbol?: string;
  symbols?: string[];
  /** Issue #738: max symbols for the scanner to process (overrides the 20-symbol default cap). */
  maxSymbols?: number;
  thesis?: OptionThesis;
  /**
   * Issue #3264: how this run was started, when the caller knows
   * it. Carried ONLY into the scan-run save (the history row's
   * trigger) — never into the cache key, the scan template, or the
   * request snapshot, so a manual and a scheduled run over the
   * same scan still share one cached result.
   */
  trigger?: "manual" | "scheduled";
  targetPrice?: number;
  targetDate?: string;
  expectedIvDirection?: ExpectedIvDirection;
  riskProfile?: "conservative" | "balanced" | "aggressive";
  allowedStrategies?: OptionStrategyType[];
  maxPlannedLoss?: number;
  minRewardRisk?: number;
  /**
   * Issue #2091: evaluate every wanted strategy against the chain
   * (thesis orients scoring, no longer excludes). Scheduled runs pass
   * true; manual runs omit it and keep the thesis default. Forwarded
   * into the scan template by the opportunities action, and segmented
   * in the cache key — a thesis-scope cached scan must never serve an
   * all-scope request.
   */
  evaluateAllStrategies?: boolean;
  /**
   * Issue #2600: canonical per-run strategy scope — "thesis"
   * (default), "all", or "no-view". Deprecated alias (superseded by strategyMode):
   * evaluateAllStrategies (true === "all"). A conflicting pair is
   * rejected at the unified route schema; the service resolves the
   * pair once via resolveStrategyMode before forwarding, so engine
   * and scanner never see two scopes. `limit` stays the unified
   * pagination/limit field and is NOT renamed to candidateLimit:
   * on the opportunities action it paginates fits / caps rows, and
   * omitting it means the scanner's own default — the ranked-cap
   * "all" on this surface is expressed through the scan's
   * candidateLimit option (see the opportunities forwarding below).
   */
  strategyMode?: "thesis" | "all" | "no-view";
  /** Issue #2600: far-dated fetch toggle, forwarded into the scan
   *  template (false suppresses horizon bands; absent = legacy bands). */
  farDated?: boolean;
  /**
   * Issue #2600: ranked-candidate cap, kept separate from `limit`
   * (pagination/row cap) and from best-trade `alternatives`. A number
   * caps ranked candidates; "all" means uncapped ("all ranked") and
   * is recorded as "all", never as a large number. On the
   * strategies/best_trade/compare/llm actions it caps the ranked
   * list (best-trade alternatives stay their own count, default 3);
   * on opportunities it caps the headline per_name_best list via
   * the scanner's candidateLimit option.
   */
  candidateLimit?: number | "all";
  /** Optimization bias (0 = max return, 100 = max chance); converted to
   *  score weights server-side (issue #29). */
  optimizationBias?: number;
  /** Opportunities only (issue #23): which strategy question the scan
   *  answers — "strategy_fit" (which names fit?) or "per_name_best"
   *  (best trade per name, the default). */
  mode?: ScanMode;
  /** Opportunities only (issue #23): per-name thesis/target overrides
   *  keyed by (uppercase) symbol. */
  perSymbol?: Record<string, ScanSymbolOverride>;
  /** Server-populated per-name event calendars (issue #16): routes
   *  strip any client-supplied value and fetch from the calendar
   *  service; internal callers (scheduled tasks) fetch their own.
   *  Forwarded into the scan (opportunities) and attached to the
   *  single-name request (strategies / best_trade). */
  eventCalendarBySymbol?: Record<string, EventCalendarInfo>;
  /** Opportunities only (issue #103): a target the caller stated for
   *  one symbol ({ price, symbol }) or the batch — forwarded into the
   *  scan template's statedTarget, where the scanner scopes it to its
   *  own symbol. Previously only the NLQ path could state one. */
  statedTarget?: { price: number; symbol?: string };
  /** Opportunities only (issue #103): DTE bounds, forwarded into the
   *  scan template. Also profile-suppliable fields (issue #28): when a
   *  profile is selected and the body omits them, the profile's
   *  bounds apply instead. */
  minDte?: number;
  maxDte?: number;
  /** Opportunities only (issue #103): strategy-fit pagination offset
   *  into the fit rows, forwarded like `limit` (which slice 1 of #84
   *  wired the same way). */
  offset?: number;
  /** Saved strategy profile to run under (issue #28): `profileId` is
   *  preferred; `profileName` resolves case-insensitively against the
   *  caller's profiles. Resolved before anything runs — an unknown
   *  profile is an error result, never a silent profile-less run.
   *  Applies to the opportunities and single-name actions. */
  profileId?: string;
  profileName?: string;
  filter?: OptionScreenerFilter;
  channel?: OmnichannelContext;
  question?: string;
  limit?: number;
  userLogin?: string;
  overrideEnv?: string;
}

export interface FormattedOmnichannelResponse {
  success: boolean;
  action: UnifiedOptionsAction;
  channel: OmnichannelContext;
  summary: string;
  data: any;
  meta: {
    symbol?: string;
    underlyingsCount?: number;
    contractsCount?: number;
    strategiesCount?: number;
    generatedAt: string;
    environment: string;
    cached: boolean;
  };
  toUi: () => any;
  toSlack: () => SlackBlockKitPayload;
  toEmailHtml: () => string;
  toEmailText: () => string;
  toVoice: () => { spokenText: string; displayMarkdown: string };
  toWebhook: () => Record<string, unknown>;
  toMcp: () => Record<string, unknown>;
}

// In-memory cache for recent chain/strategy evaluations across channels
interface CacheEntry {
  timestamp: number;
  data: any;
  summary: string;
}
const MEMORY_CACHE = new Map<string, CacheEntry>();
/**
 * Issue #3186 step 3e - the opportunities-case summary, extracted so
 * the scheduled pipeline call renders the identical summary (mode
 * label + fit-gate segment + #1290 partial segment) instead of
 * re-deriving it. Issue #23: the summary labels the mode;
 * strategy-fit reports the fit accounting instead of the best-trade
 * count. Issue #24: both modes append the fit-gate bucket counts; in
 * strategy-fit mode fitsTotal is already the GATED fit count.
 * Issue #1290 (#1173 R6): a partial scan says so in the summary
 * every surface renders (Slack/email/canonical).
 */
export function buildOpportunityScanSummary(scanResult: OpportunityScanResult): string {
  const gateSegment = ` Gate: ${scanResult.gate.fit} fit, ${scanResult.gate.borderline} borderline, ${scanResult.gate.noFit} no fit.`;
  const partialSegment = scanResult.partial
    ? ` Partial coverage — qualified partial results: evaluated ${scanResult.partial.evaluatedCount} of ${scanResult.partial.consideredCount} underlyings (${scanResult.partial.coverageErrors} failures, ${scanResult.partial.truncatedCount} truncated).`
    : "";
  return scanResult.mode === "strategy_fit"
    ? `Opportunity scan across ${scanResult.scanned} symbols (mode: strategy fit): ${scanResult.fitsTotal} of ${scanResult.scanned} names fit.${gateSegment}${partialSegment}`
    : `Opportunity scan across ${scanResult.scanned} symbols: found ${scanResult.withTrades} actionable trade setups. (mode: per-name best)${gateSegment}${partialSegment}`;
}


/** Request-body fields a caller expressed (issue #28): a field counts
 *  as expressed when it is present (not undefined) in the body. These
 *  are the StrategyRequest-level fields a saved profile can supply;
 *  posture fields (riskProfile / mode) are added for the opportunities
 *  action, whose scanner options they steer. */
// Issue #103: minDte/maxDte join the list — they became body fields
// the same change that grew the request to carry them; a body that
// states DTE bounds must win over the profile's, like every other
// expressed field.
/** Issue #986: the screener filter's fields, in a fixed order, for
 *  deterministic cache-key serialization — defined fields only, so two
 *  semantically identical filters produce the same segment (a hit) and
 *  any differing field produces a different one (a miss). */
const FILTER_CACHE_FIELDS = [
  "underlyingSymbols", "maxUnderlyings", "sector", "contractType",
  "minVolume", "minOpenInterest", "maxSpreadPct", "maxQuoteAgeSeconds",
  "minDelta", "maxDelta", "minGamma", "maxGamma", "minTheta", "maxTheta",
  "minVega", "maxVega", "minRho", "maxRho", "minPrice", "maxPrice",
  "minImpliedVolatility", "maxImpliedVolatility", "minDte", "maxDte",
  "expirationDteBands", "moneyness", "maxStrikeDistancePct", "limit", "sortBy",
] as const;

function filterCacheSegment(filter: OptionScreenerFilter): string {
  return FILTER_CACHE_FIELDS.map((field) => {
    const v = filter[field];
    if (v === undefined) return "";
    if (field === "underlyingSymbols") {
      // The screener normalizes underlyings (uppercase/dedupe) before
      // screening — set semantics, so the segment is order/case-free.
      return [...new Set((v as string[]).map((s) => s.toUpperCase()))].sort().join("+");
    }
    if (field === "expirationDteBands") {
      return (v as NonNullable<OptionScreenerFilter["expirationDteBands"]>)
        .map((b) => `${b.minDte}-${b.maxDte}-${b.maxExpirations ?? ""}`)
        .join("+");
    }
    return String(v);
  }).join("|");
}

/** Issue #986: stable stringify for plain-data request fragments (the
 *  per-symbol event calendars) — object keys sorted recursively, so
 *  key order in the caller's object never changes the segment. */
function stableCacheStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableCacheStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableCacheStringify(v)}`).join(",")}}`;
}

const PROFILE_BODY_FIELDS = ["thesis", "expectedIvDirection", "maxPlannedLoss", "minRewardRisk", "allowedStrategies", "optimizationBias", "minDte", "maxDte"] as const;
export function bodyPresentFields(req: UnifiedOptionsRequest, includePosture: boolean): string[] {
  const present: string[] = PROFILE_BODY_FIELDS.filter((field) => req[field] !== undefined);
  if (includePosture) {
    if (req.riskProfile !== undefined) present.push("riskProfile");
    if (req.mode !== undefined) present.push("mode");
  }
  return present;
}

/**
 * Issue #2600: the ONE viewed-request assembly for the unified
 * strategies / best_trade / compare / llm actions (previously three
 * copies that each dropped a different control). Resolves the mode
 * once (alias folded in); no-view is refused here — these actions
 * are viewed by construction and must never fabricate a thesis for
 * a constraint-only request. candidateLimit "all" is uncapped
 * (omitted on the request; the kernel slices rankedAll.length when
 * absent); a number caps it. farDated true attaches the same
 * mode-resolved fetch bands the panel route uses; absent/false
 * leaves the loader's default window (far templates are then
 * ledger-skipped, never silently ranked on partial chains).
 */
function buildUnifiedViewedRequest(
  req: UnifiedOptionsRequest,
  symbol: string,
  targetPrice: number,
  targetDate: string,
): StrategyRequest {
  const mode = resolveStrategyMode(req);
  if (mode === "no-view") {
    throw new Error("strategyMode \"no-view\" cannot run a viewed unified action; use the no-view path (constraint-only, no thesis/target/date/IV)");
  }
  const allowedStrategies = req.allowedStrategies && req.allowedStrategies.length > 0 ? req.allowedStrategies : ["all"];
  const request: StrategyRequest = {
    symbol,
    thesis: req.thesis || "bullish",
    targetPrice,
    targetDate,
    expectedIvDirection: req.expectedIvDirection || "unchanged",
    maxPlannedLoss: req.maxPlannedLoss || 1000,
    minRewardRisk: req.minRewardRisk || 1.5,
    allowedStrategies,
    optimizationBias: req.optimizationBias,
    strategyMode: mode,
    ...(mode === "all" ? { evaluateAllStrategies: true } : {}),
    ...(req.minDte !== undefined ? { minDte: req.minDte } : {}),
    ...(req.maxDte !== undefined ? { maxDte: req.maxDte } : {}),
    ...(typeof req.candidateLimit === "number" ? { candidateLimit: req.candidateLimit } : {}),
    ...(req.farDated !== undefined ? { farDated: req.farDated } : {}),
    eventCalendar: req.eventCalendarBySymbol?.[symbol],
  };
  if (req.farDated === true) {
    const wanted = new Set(defaultRegistry.resolveMany(allowedStrategies).ids);
    const selected = filterDefinitionsByMode(defaultRegistry.list(), wanted, mode, request.thesis);
    const { bands } = deriveFetchBands({
      selected,
      nearMinDte: request.minDte ?? 0,
      nearMaxDte: request.maxDte ?? DEFAULT_MAX_DTE,
      farDated: true,
    });
    request.expirationDteBands = bands;
  }
  return request;
}

/**
 * Issue #1157 (E2): the client FACADE the engines receive when the
 * service runs platform-wired. The engines (DynamicOptionsScreener
 * and everything built on it) consume an ETradeRestClient; the
 * facade keeps that exact shape while routing the two data calls
 * the engines make — getOptionChains and getOptionExpireDates —
 * through the data-provider adapter (which captures them under the
 * run context), and delegating EVERY other member (lastError, env,
 * and any other method) straight to the real client, bound to it.
 * Return shapes are the adapter results unwrapped from their
 * provenance envelopes — byte-for-byte what the raw client returns.
 */
function createPlatformOptionsClient(
  client: ETradeRestClient,
  provider: DataProvider,
  runContext: DataRunContext
): ETradeRestClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "getOptionChains") {
        return async (params: OptionsChainRequest, requestBudget?: import("../interfaces").OptionRequestBudget) =>
          (await (requestBudget
            ? provider.getOptionsChain!(params, runContext, requestBudget)
            : provider.getOptionsChain!(params, runContext))).result;
      }
      if (prop === "getOptionExpireDates") {
        return async (symbol: string, expiryType?: string, requestBudget?: import("../interfaces").OptionRequestBudget) =>
          (await (requestBudget
            ? provider.getOptionExpiryDates!(symbol, runContext, requestBudget)
            : provider.getOptionExpiryDates!(symbol, runContext))).result;
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class UnifiedOptionsService {
  private config: EtapiConfig;
  private orm?: DatabaseORM;
  /** Issue #27: optional scan-run persistence seam. When supplied,
   *  opportunities scans are stored and the response data carries
   *  scanRunId/persisted; when absent, behavior is exactly as before. */
  private scanRunStore?: ScanRunStore;
  /** Issue #28: optional saved-profile store. When supplied, requests
   *  may select a profile by id/name; when absent, a request that names
   *  a profile fails with an availability error. */
  private profileStore?: StrategyProfileStore;
  /** Issue #14: optional SQL seam for the discovery action. When
   *  supplied, the action runs the Phase 1 discovery pipeline and
   *  persists its runs; when absent, the action fails with an
   *  availability error (same discipline as the profile store). */
  private discoverySql?: { exec(query: string, ...params: unknown[]): Iterable<unknown> };
  /** Issue #1157 (E2): optional data-provider platform deps. When
   *  supplied, execute() bootstraps the platform in this storage,
   *  resolves the optionsChains route, and runs the engines through
   *  the E*TRADE adapter (capturing every chain/expiry fetch under a
   *  run id minted before the fetch — the same id the scan run is
   *  persisted under). When absent, every code path is exactly as
   *  before: the engines receive the raw client and nothing is
   *  captured. */
  private platformDeps?: ETradeCaptureDeps;

  /**
   * #2303 (#1976 step 1): the data-provider platform ports,
   * supplied by the host (constructor) — this module is
   * reachable from the client bundle through the trading
   * barrel, so it must not statically import the port BUILDER
   * (which pulls the D1 adapters and the transaction aspect's
   * node:async_hooks into the graph). Hosts build the ports
   * from env via src/data/buildDataProviderPorts and pass them
   * in; when bound, execute()'s bootstrap + route resolution
   * run on D1 through the config port and the adapter's
   * captures land through the capture port; unbound, the
   * platformDeps sql path runs exactly as before.
   */
  private injectedDataProviderPorts?: DataProviderPorts | null;

  private async dataProviderPorts(): Promise<DataProviderPorts> {
    return this.injectedDataProviderPorts ?? { config: null, captures: null };
  }

  /** The entitlement tier this service instance presents to route
   *  resolution (E5, issue #1202). Defaults to "freemium": every
   *  in-app host (REST screen, scheduled scans, NLQ, MCP) is a
   *  freemium surface, so an operator-tiered premium route refuses
   *  them with DataProviderTierError instead of serving. A host
   *  serving a premium surface passes "premium" explicitly. */
  private callerTier: Tier;

  constructor(
    private env: Env,
    private userLogin: string,
    private overrideEnv?: string,
    orm?: DatabaseORM,
    scanRunStore?: ScanRunStore,
    profileStore?: StrategyProfileStore,
    discoverySql?: { exec(query: string, ...params: unknown[]): Iterable<unknown> },
    platformDeps?: ETradeCaptureDeps,
    callerTier: Tier = "freemium",
    dataProviderPorts?: DataProviderPorts | null
  ) {
    // Issue #1185: the service resolves the owner's stored token and
    // scopes its runs/profiles by login — an explicit login is required.
    if (!userLogin) {
      throw new Error("UnifiedOptionsService requires an explicit userLogin (issue #1185: no default identity).");
    }
    this.config = getEtapiConfig(env, overrideEnv);
    this.orm = orm;
    this.scanRunStore = scanRunStore;
    this.profileStore = profileStore;
    this.discoverySql = discoverySql;
    this.platformDeps = platformDeps;
    this.callerTier = callerTier;
    this.injectedDataProviderPorts = dataProviderPorts;
  }

  /**
   * Issue #982 (screening consolidation S2): the service layer's engine
   * execution primitives. The three options engines are constructed
   * ONLY here (execute() runs through these same methods) — entry
   * points that cannot express their request as a UnifiedOptionsRequest
   * without losing semantics (the NLQ strategy actions carry a full
   * StrategyRequest, a strategyFilter, and caller-resolved profiles the
   * unified request type has no fields for) call these with the client
   * they already hold, so engine construction and execution live in
   * exactly one layer while their result assembly stays their own.
   * `client` is the E*TRADE REST data plane (ETradeService's `.client`).
   */
  static async screenContracts(
    client: OptionChainSource | undefined,
    filter: OptionScreenerFilter
  ): Promise<OptionScreenResult> {
    return new DynamicOptionsScreener(client).screenOptions(filter);
  }

  static async runStrategyPipeline(
    source: OptionChainSource | undefined,
    request: StrategyRequest,
    options: PipelineOptions = {},
    userLogin?: string,
  ): Promise<PipelineResult> {
    // Issue #3186 step 3e: the service's panel runs go through the one
    // panel pipeline instead of runPanelPipeline directly - this static
    // is the seam all three execute() panel cases (strategies /
    // best_trade, compare, llm_ideas) ride, so one change migrates
    // them all for every caller (unified handler, NLQ screen path).
    // The agents are constructed exactly as runPanelPipeline built
    // them (data agent over the given screener - no universeDeps -
    // fresh risk + recommender). All four PipelineOptions fields ride
    // the classInput (the feed seam's snapshotOverride included), so
    // the static's contract is preserved for callers that pass a
    // stored snapshot. The service holds no DO storage/queue handle,
    // so stage storage/claims are the shared in-memory helpers and
    // publishing is skipped (queue null); the durable record for
    // these runs is the caller's downstream record, unchanged.
    const runId = `options-panel:service:${request.symbol}:${new Date().toISOString()}`;
    const storage = memoryStageStorage();
    const outcome = await runOptionsScreenWorkflow(
      {
        runId,
        userLogin,
        request: {
          assetClass: "options",
          runIdentity: { runId },
          trigger: "manual",
          classInput: {
            strategyRequest: request,
            strategyFilter: options.strategyFilter,
            riskProfile: options.riskProfile,
            alternatives: options.alternatives,
            snapshotOverride: options.snapshotOverride,
          },
        },
      },
      {
        stages: createStrategyScreenPorts({
          agents: {
            data: new OptionsDataAgent(new DynamicOptionsScreener(source)),
            risk: new StrategyRiskAgent(),
            recommender: new RecommendationAgent(),
          },
          storage,
        }),
        claims: memoryStageClaims(),
        queue: null,
      },
    );
    if (outcome.outcome !== "completed") {
      throw new Error(
        `Options strategy screen failed at ${outcome.failedStage}: ${outcome.reason}`,
      );
    }
    const panelResult = await storage.get<PanelDiscoveryResult>(
      optionsArtifactKey(runId, "shapeReport"),
    );
    if (!panelResult) {
      throw new Error(
        "Options strategy screen completed without a report artifact; refusing to answer from nothing.",
      );
    }
    return panelResultToPipelineResult(panelResult);
  }

  static async scanOpportunities(
    source: OptionChainSource | undefined,
    symbols: string[],
    template: ScanRequestTemplate,
    options: Parameters<OpportunityScanner["scan"]>[2] = {}
  ): Promise<OpportunityScanResult> {
    return new OpportunityScanner(new DynamicOptionsScreener(source)).scan(symbols, template, options);
  }

  private getCacheKey(req: UnifiedOptionsRequest, profile?: StrategyProfile): string {
    const sym = (req.symbol || (req.symbols ? req.symbols.join(",") : "")).toUpperCase();
    // Scan mode and per-symbol overrides change the opportunities result
    // (issue #23), so they belong in the key: without them a caller could be
    // served another mode's cached scan.
    const perSymbol = req.perSymbol
      ? Object.keys(req.perSymbol)
          .sort()
          .map((s) => {
            const o = req.perSymbol![s];
            const t = o.target
              ? o.target.kind === "absolute"
                ? `$${o.target.price}`
                : o.target.kind === "percent"
                  ? `${o.target.pct}%`
                  : `${o.target.multiple}EM`
              : "";
            return `${s}=${o.thesis || ""}|${t}`;
          })
          .join(";")
      : "";
    // Issue #28: profile application happens INSIDE the scan / request
    // assembly, so two calls differing only by profile would otherwise
    // collide on this key and be served each other's cached results.
    // The RESOLVED profile segments the key by id + version — a profile
    // edit (version bump) busts the cache, and a profile call never
    // shares an entry with a profile-less one.
    const profileSegment = profile ? `profile=${profile.id}@v${profile.version}` : "";
    // Issue #84 slice 1: `limit` changes the opportunities result (fit
    // pagination / row cap) once forwarded to the scanner, so it belongs
    // in the key for the same reason mode and profile do — two calls
    // differing only by limit must not share a cached scan.
    // Issue #103: statedTarget / minDte / maxDte / offset joined the
    // forwarded set, so they segment the key the same way — a scan
    // under a stated target must never be served to a caller who
    // stated a different one (or none).
    const statedTargetSegment = req.statedTarget
      ? `${req.statedTarget.symbol ?? ""}@${req.statedTarget.price}`
      : "";
    // Issue #986: MEMORY_CACHE is module-level — shared across ALL
    // service instances — so the key must also segment by everything
    // instance- or request-scoped that changes the result:
    //  - this.userLogin: a second user's identical request must never
    //    be served the first user's entry. Since #982 routed the paid
    //    premium scan and NLQ screens through execute(), the first
    //    payer's result was servable to a second payer with E*TRADE
    //    never constructed under their identity.
    //  - the effective environment (the instance's overrideEnv over
    //    the env's ETRADE_ENVIRONMENT): a different data source
    //    entirely (PROD vs TEST chains).
    //  - req.filter: the screen action's whole criteria object was
    //    unsegmented, so two differing filters collided.
    //  - the remaining forwarded fields the original key missed —
    //    maxSymbols, the effective targetDate (the +30d default the
    //    actions resolve to), expectedIvDirection, allowedStrategies
    //    (an allowlist — set semantics, serialized sorted), the risk
    //    caps, optimizationBias, the per-symbol event calendars, and
    //    question (echoed into the llm actions' payload). Each steers
    //    the scan/pipeline or appears in the result.
    //  - scanRunStore presence: an opportunities result gains
    //    scanRunId/persisted only when a store is injected — a
    //    store-less instance served a stored instance's entry would
    //    report a persistence that never happened for it, and the
    //    reverse would silently skip a run the caller expected saved.
    // Segmentation is conservative throughout: an extra miss is always
    // safe; a wrong hit never is. (Deliberately NOT segmented: channel
    // — formatting is applied per call from the cached data, which is
    // channel-independent; and the request's own userLogin/overrideEnv
    // fields, which execute() never reads — the instance's are the
    // effective identity.)
    const filterSegment = req.filter ? filterCacheSegment(req.filter) : "";
    const envSegment = `${this.overrideEnv ?? ""}|${this.env.ETRADE_ENVIRONMENT ?? ""}`;
    const effectiveTargetDate =
      req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
    const allowedSegment = req.allowedStrategies ? [...req.allowedStrategies].sort().join("+") : "";
    const calendarSegment = req.eventCalendarBySymbol ? stableCacheStringify(req.eventCalendarBySymbol) : "";
    // Issue #14: a discovery result is a persisted run — its key must
    // segment on the universe (the action reads `symbols`, not the
    // single `sym` the key leads with) and on the discovery wiring,
    // for the same honesty reason as the scanRunStore segment above:
    // an unwired instance must never serve a wired instance's run.
    const discoverySegment =
      req.action === "discovery"
        ? `${[...(req.symbols ?? (req.symbol ? [req.symbol] : []))].map((s) => s.toUpperCase().trim()).sort().join("+")}:${this.discoverySql ? "disc-wired" : "disc-unwired"}`
        : "";
    return `${req.action}:${sym}:${req.thesis || ""}:${req.riskProfile || ""}:${req.targetPrice || ""}:${req.mode || ""}:${perSymbol}:${profileSegment}:${req.limit ?? ""}:${statedTargetSegment}:${req.minDte ?? ""}:${req.maxDte ?? ""}:${req.offset ?? ""}:${this.userLogin}:${envSegment}:${filterSegment}:${req.maxSymbols ?? ""}:${effectiveTargetDate}:${req.expectedIvDirection || ""}:${allowedSegment}:${req.maxPlannedLoss ?? ""}:${req.minRewardRisk ?? ""}:${req.optimizationBias ?? ""}:${calendarSegment}:${req.question ?? ""}:${this.scanRunStore ? "store" : "nostore"}:${discoverySegment}:${req.evaluateAllStrategies === true ? "allstrat" : ""}:${req.strategyMode ?? ""}:${req.farDated === true ? "fardated" : req.farDated === false ? "neardated" : ""}:${req.candidateLimit ?? ""}`;
  }

  /**
   * Issue #3186 step 3e - the engine client execute() runs on,
   * extracted so the scheduled pipeline call can run the SAME
   * client instead of silently bypassing the data-provider
   * platform path with the raw client. When platform deps are
   * wired the client is the platform-routed facade (captures
   * land through the capture port) and a platform run id is
   * minted BEFORE any fetch, so fetch-time captures share one
   * identity with the persisted scan row (#1157 E2). Without
   * deps the client is the raw E*TRADE client and the run id
   * stays undefined, exactly as execute() behaved before.
   * A resolution failure throws and surfaces as an error;
   * there is NO silent fallback to the direct client.
   */
  async resolveEngineClient(): Promise<{ engineClient: ETradeRestClient | OptionChainSource; platformRunId?: string }> {
    const broker = await resolveTenantBroker(this.env);
    if (broker !== "etrade") {
      const platform = TradingPlatformRegistry.getPlatform(
        broker,
        this.env,
        this.orm,
        this.userLogin,
        this.overrideEnv,
      );
      const chainSource = platformChainSource(platform);
      if (chainSource) {
        return { engineClient: chainSource };
      }
    }
    // Issue #781: forward the injected ORM as-is. This service only
    // uses ETradeService's REST client; the ORM reaches only its
    // trading platform, whose contract is explicitly optional with
    // every access guarded — so without an ORM, platform persistence
    // is honestly absent. The former stub fallback made the platform
    // believe persistence existed while discarding every write. When
    // no ORM is present, construct env-first: ETradeService's
    // orm-first overload would otherwise drop the env argument.
    const etrade = this.orm
      ? new ETradeService(this.orm, this.env, this.userLogin, this.overrideEnv)
      : new ETradeService(this.env, undefined, this.userLogin, this.overrideEnv);
    // Issue #1157 (E2): when platform deps are wired, the engines
    // run through the data-provider platform: bootstrap this
    // storage (seed + enable etrade), resolve the optionsChains
    // route — a resolution failure throws and surfaces as an
    // error; there is NO silent fallback to the direct client —
    // mint the run id BEFORE any fetch, and hand the engines a
    // facade over the adapter built on THIS execute() call's
    // ETradeService instance. Without deps, engineClient is the
    // raw client and platformRunId stays undefined: every path
    // below is exactly as before.
    let engineClient: ETradeRestClient = etrade.client;
    let platformRunId: string | undefined;
    if (this.platformDeps) {
      // #2303: ports win when bound (production) — the config
      // reads/writes run on D1 and captures land through the
      // capture port; the deps' own capturePort, when a host
      // threaded one explicitly, is respected first.
      const ports = await this.dataProviderPorts();
      const configPort = ports.config;
      if (configPort) await configPort.bootstrapDataProviders();
      else bootstrapDataProviders(this.platformDeps.sql);
      platformRunId = crypto.randomUUID();
      const captureDeps: ETradeCaptureDeps =
        ports.captures && !this.platformDeps.capturePort
          ? { ...this.platformDeps, capturePort: ports.captures }
          : this.platformDeps;
      const provider = createETradeDataProvider(etrade, {
        capture: captureDeps,
      });
      const registry = new DataProviderRegistry();
      registry.register(provider);
      const assignment = registry.resolveRoute(
        "optionsChains",
        configPort
          ? await configPort.listProviderConfigs()
          : listProviderConfigs(this.platformDeps.sql),
        configPort
          ? await configPort.listCapabilityRoutes()
          : listCapabilityRoutes(this.platformDeps.sql),
        this.callerTier
      );
      engineClient = createPlatformOptionsClient(etrade.client, assignment.primary, {
        runId: platformRunId,
        userLogin: this.userLogin,
      });
    }
    return { engineClient, platformRunId };
  }


  /**
   * Issue #3186 step 3e - the saved-profile resolution execute()
   * runs first, extracted so the unified handler's opportunities
   * path can resolve the caller's profile exactly as execute()
   * does. An unknown id/name, or no store wired, is an error in
   * the service's existing style - the action does NOT silently
   * run without the profile.
   */
  async resolveStrategyProfile(
    req: UnifiedOptionsRequest,
  ): Promise<{ profile?: StrategyProfile; error?: string }> {
    if (!req.profileId && !req.profileName) return {};
    if (!this.profileStore) {
      return { error: "Saved profiles aren't available in this context." };
    }
    const found = req.profileId
      ? await this.profileStore.get(this.userLogin, req.profileId)
      : await this.profileStore.getByName(this.userLogin, req.profileName!);
    if (found) return { profile: found };
    return {
      error: req.profileId
        ? `No saved profile with id "${req.profileId}".`
        : `No saved profile named "${req.profileName}".`,
    };
  }

  async execute(req: UnifiedOptionsRequest): Promise<FormattedOmnichannelResponse> {
    const channel = req.channel || "ui";
    const cacheTtlMs = this.config.cache.chainTtlSeconds * 1000;
    const now = Date.now();

    // Issue #28: resolve the saved profile FIRST, before the cache is
    // consulted — the resolved profile (id + version) segments the
    // cache key, and a failed resolution must never be served a cached
    // profile-less result (nor cached itself). An unknown id/name, or
    // no store wired, is an error result in the service's existing
    // style; the action does NOT silently run without the profile.
    const { profile: strategyProfile, error: profileError } = await this.resolveStrategyProfile(req);
    const cacheKey = this.getCacheKey(req, strategyProfile);

    const cached = MEMORY_CACHE.get(cacheKey);
    let executionData: any;
    let summary = "";
    let isFromCache = false;

    if (!profileError && cached && now - cached.timestamp < cacheTtlMs) {
      executionData = cached.data;
      summary = cached.summary;
      isFromCache = true;
    } else if (profileError) {
      executionData = { error: profileError };
      summary = profileError;
    } else {
      const { engineClient, platformRunId } = await this.resolveEngineClient();
      switch (req.action) {
        case "screen": {
          const filter: OptionScreenerFilter = {
            ...req.filter,
            underlyingSymbols: req.symbols || (req.symbol ? [req.symbol.toUpperCase()] : undefined),
            limit: req.limit || this.config.screener.maxReturnedContracts,
          };
          const screenResult = await UnifiedOptionsService.screenContracts(engineClient, filter);
          executionData = screenResult;
          summary = `Screened ${screenResult.matchedCount} options contracts across ${screenResult.totalUnderlyingsScanned} symbols.`;
          break;
        }

        case "discovery": {
          // Issue #14: the Phase 1 signal-driven discovery pipeline.
          // View-less by construction — the service characterizes
          // each name, infers (or abstains), expresses, persists the
          // run, and classifies deltas against the previous run of
          // the same scope (here: this caller's universe).
          // #1639 (D3, retained with stated reason): this is NOT a
          // parallel recommendation path bypassing the kernel — the
          // service's per-name expression runs runPanelPipeline, i.e.
          // RecommendationService.discoverPanel. What stays outside
          // the kernel is only the universe-scan / inference / run
          // persistence pre-stage, which no kernel stage owns.
          if (!this.discoverySql) {
            executionData = { error: "Discovery isn't wired in this context." };
            summary = "Discovery isn't wired in this context.";
            break;
          }
          const discoverySymbols = [
            ...new Set(
              (req.symbols && req.symbols.length > 0
                ? req.symbols
                : req.symbol
                  ? [req.symbol]
                  : []
              )
                .map((s) => s.toUpperCase().trim())
                .filter(Boolean),
            ),
          ];
          if (discoverySymbols.length === 0) {
            executionData = { error: "Discovery needs at least one symbol (symbols or symbol)." };
            summary = "Discovery needs at least one symbol.";
            break;
          }
          const { createDiscoveryService, formatDiscoveryRunSummary } = await import(
            "../../services/discoveryService"
          );
          const discoveryPorts = this.platformDeps
            ? await this.dataProviderPorts()
            : null;
          const discoveryService = createDiscoveryService({
            env: this.env,
            userLogin: this.userLogin,
            // Issue #3388: the run executes on the selected broker's chains.
            platform: TradingPlatformRegistry.getPlatform(
              await resolveTenantBroker(this.env),
              this.env,
              this.orm,
              this.userLogin,
              this.overrideEnv,
            ),
            overrideEnv: this.overrideEnv,
            orm: this.orm,
            sql: this.discoverySql,
            // Issue #1661: full history capture when the service
            // carries platformDeps; absent → today's outcome-only.
            ...(this.platformDeps?.blobStorage
              ? { blobStorage: this.platformDeps.blobStorage as never }
              : {}),
            // #2303: the platform ports thread into the history
            // resolution when bound (see discoveryService).
            ...(discoveryPorts?.config
              ? { configPort: discoveryPorts.config }
              : {}),
            ...(discoveryPorts?.captures
              ? { capturePort: discoveryPorts.captures }
              : {}),
          });
          const outcome = await discoveryService.run({
            symbols: discoverySymbols,
            scopeKey: `unified:${this.userLogin}:${discoverySymbols.join(",")}`,
            source: "unified",
            caps: {
              maxPlannedLoss: req.maxPlannedLoss ?? 1000,
              minRewardRisk: req.minRewardRisk ?? 1.5,
            },
            userLogin: this.userLogin,
            // Issue #18: a resolved profile biases pick selection
            // by its allowed strategy types (ranking only — the
            // "all" sentinel prefers nothing in particular).
            ...(strategyProfile?.allowedStrategies &&
            strategyProfile.allowedStrategies.some((t) => t !== "all")
              ? {
                  profileBias: {
                    preferredTypes: strategyProfile.allowedStrategies.filter((t) => t !== "all"),
                  },
                }
              : {}),
          });
          executionData = { run: outcome.run, deltas: outcome.deltas, errors: outcome.errors };
          summary = formatDiscoveryRunSummary(outcome);
          break;
        }

        case "strategies":
        case "best_trade": {
          const symbol = (req.symbol || "SPY").toUpperCase().trim();
          const targetPrice = req.targetPrice || (req.thesis === "bearish" ? 100 : 150);
          const targetDate = req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
          // Issue #2600: one builder for all viewed actions (mode,
          // far-dated bands, DTE window, candidateLimit) — previously
          // this copy dropped evaluateAllStrategies, minDte/maxDte,
          // and any candidate cap entirely.
          // Issue #16: this name's event calendar, server-fetched by
          // the caller — the engine annotates / excludes on it.
          const strategyRequest = buildUnifiedViewedRequest(req, symbol, targetPrice, targetDate);
          // Issue #28: a selected profile layers under the body's own
          // fields — fields present in the body stay explicit.
          const effectiveRequest = strategyProfile
            ? applyProfileFields(strategyRequest, strategyProfile, new Set(bodyPresentFields(req, false))).merged
            : strategyRequest;

          const pipelineResult = await UnifiedOptionsService.runStrategyPipeline(
            engineClient,
            effectiveRequest,
            {
              riskProfile: req.riskProfile || "balanced",
            },
            this.userLogin,
          );

          // Issue #26: every single-name pipeline result carries the
          // per-strategy-type roll-up (best-per-type + ledger counts),
          // built by the same pure builder the NLQ actions use.
          const typeRollup = buildTypeRollup(pipelineResult.strategies.evaluations, pipelineResult.ranked);
          if (req.action === "best_trade") {
            const bestCandidate = pipelineResult.bestTrade?.best?.candidate;
            const bestScore = pipelineResult.bestTrade?.best?.compositeScore ?? bestCandidate?.score;
            executionData = {
              bestTrade: pipelineResult.bestTrade,
              evaluations: pipelineResult.strategies.evaluations,
              snapshot: pipelineResult.snapshot,
              typeRollup,
              ...(strategyProfile ? { profileRef: toProfileRef(strategyProfile) } : {}),
            };
            summary = bestCandidate
              ? `Best trade for ${symbol} (${effectiveRequest.thesis}): ${bestCandidate.label} (Score: ${bestScore})`
              : `No suitable option trade found for ${symbol} matching ${effectiveRequest.thesis} criteria.`;
          } else {
            executionData = { ...pipelineResult, typeRollup, ...(strategyProfile ? { profileRef: toProfileRef(strategyProfile) } : {}) };
            summary = `Generated ${pipelineResult.ranked.length} evaluated strategy candidates for ${symbol}.`;
          }
          break;
        }

        case "opportunities": {
          const symbols = req.symbols && req.symbols.length > 0 ? req.symbols : (req.symbol ? [req.symbol.toUpperCase()] : []);
          if (symbols.length === 0) {
            throw new Error("Provide explicit symbols or a live universe for options screening; no static symbols are substituted.");
          }
          const targetDate = req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
          const scanResult = await UnifiedOptionsService.scanOpportunities(engineClient, symbols, {
            thesis: req.thesis || "bullish",
            targetDate,
            expectedIvDirection: req.expectedIvDirection || "unchanged",
            maxPlannedLoss: req.maxPlannedLoss || 1000,
            minRewardRisk: req.minRewardRisk || 1.5,
            allowedStrategies: req.allowedStrategies && req.allowedStrategies.length > 0 ? req.allowedStrategies : ["all"],
            optimizationBias: req.optimizationBias,
            ...(req.perSymbol ? { perSymbol: req.perSymbol } : {}),
            // Issue #103: the template fields the request grew to
            // carry — a stated target (the scanner scopes it to its
            // own symbol) and DTE bounds. They ride the template like
            // perSymbol does, so the profile merge treats them as
            // ordinary template fields (body-present ones are declared
            // explicit below and win over the profile's).
            ...(req.statedTarget ? { statedTarget: req.statedTarget } : {}),
            ...(req.minDte !== undefined ? { minDte: req.minDte } : {}),
            ...(req.maxDte !== undefined ? { maxDte: req.maxDte } : {}),
            // Issue #2600: canonical mode resolved once (alias folded
            // in; the route schema already rejected a conflicting
            // pair). The scanner resolves the same way, so template
            // and snapshot agree. farDated rides the template so
            // the scanner's band derivation sees it.
            strategyMode: resolveStrategyMode(req),
            ...(resolveStrategyMode(req) === "all" ? { evaluateAllStrategies: true } : {}),
            ...(req.farDated !== undefined ? { farDated: req.farDated } : {}),
          }, {
            riskProfile: req.riskProfile || "balanced",
            ...(req.mode ? { mode: req.mode } : {}),
            // Issue #84 slice 1: the request declares `limit` (the
            // scanner panel's fit-mode page size) — forward it into the
            // scan, where it paginates fits in strategy_fit mode and
            // caps rows in per-name mode. It was previously dropped,
            // which made a caller's limit a no-op.
            ...(req.limit !== undefined ? { limit: req.limit } : {}),
            // Issue #2600: ranked-candidate cap, distinct from limit
            // (see the UnifiedOptionsRequest field comment): it caps
            // the headline per_name_best list; "all" returns every
            // opportunity. strategy_fit pagination stays limit-driven.
            ...(req.candidateLimit !== undefined ? { candidateLimit: req.candidateLimit } : {}),
            // Issue #738: forward maxSymbols so the scanner respects the
            // caller's universe size instead of the hardcoded 20-symbol cap.
            ...(req.maxSymbols !== undefined ? { maxSymbols: req.maxSymbols } : {}),
            // Issue #16: per-name event calendars, server-fetched by
            // the caller — the scan judges event risk per name and
            // reports coverage in its result.
            ...(req.eventCalendarBySymbol ? { eventCalendarBySymbol: req.eventCalendarBySymbol } : {}),
            // Issue #103: `offset` paginates strategy-fit fits
            // alongside `limit`; forwarded (and cached) the same way.
            ...(req.offset !== undefined ? { offset: req.offset } : {}),
            // Issue #28: the profile layers under the body's own
            // fields — every field actually present in the body
            // (thesis, caps, types, bias, and the posture fields
            // riskProfile / mode) is declared explicit, so the profile
            // supplies only what the caller left unsaid. The scan
            // result itself carries profileRef + the profile snapshot.
            ...(strategyProfile
              ? { profile: strategyProfile, explicitFields: bodyPresentFields(req, true) }
              : {}),
          });
          // Issue #103: record the caller's original request on the
          // result BEFORE it is returned or persisted, so a stored run
          // can be replayed verbatim (the snapshot's template alone is
          // the EFFECTIVE, post-profile view — it cannot reconstruct
          // the symbol list as asked, the pagination, or which fields
          // the caller actually expressed). Only fields the caller
          // sent are recorded; symbols/targetDate are the resolved
          // values the scan actually ran under.
          const requestRecord: ScanRequestRecord = {
            symbols,
            targetDate,
            ...(req.thesis !== undefined ? { thesis: req.thesis } : {}),
            ...(req.riskProfile !== undefined ? { riskProfile: req.riskProfile } : {}),
            ...(req.mode !== undefined ? { mode: req.mode } : {}),
            ...(req.profileId !== undefined ? { profileId: req.profileId } : {}),
            ...(req.profileName !== undefined ? { profileName: req.profileName } : {}),
            ...(req.limit !== undefined ? { limit: req.limit } : {}),
            ...(req.offset !== undefined ? { offset: req.offset } : {}),
            ...(req.expectedIvDirection !== undefined ? { expectedIvDirection: req.expectedIvDirection } : {}),
            ...(req.optimizationBias !== undefined ? { optimizationBias: req.optimizationBias } : {}),
            ...(req.maxPlannedLoss !== undefined ? { maxPlannedLoss: req.maxPlannedLoss } : {}),
            ...(req.minRewardRisk !== undefined ? { minRewardRisk: req.minRewardRisk } : {}),
            ...(req.allowedStrategies !== undefined ? { allowedStrategies: req.allowedStrategies } : {}),
            ...(req.perSymbol !== undefined ? { perSymbol: req.perSymbol } : {}),
            ...(req.statedTarget !== undefined ? { statedTarget: req.statedTarget } : {}),
            ...(req.minDte !== undefined ? { minDte: req.minDte } : {}),
            ...(req.maxDte !== undefined ? { maxDte: req.maxDte } : {}),
            // Issue #2600: the four controls as submitted (mode as
            // resolved, so a stored run replays the scope it ran).
            ...(req.strategyMode !== undefined || req.evaluateAllStrategies !== undefined
              ? { strategyMode: resolveStrategyMode(req) } : {}),
            ...(req.farDated !== undefined ? { farDated: req.farDated } : {}),
            ...(req.candidateLimit !== undefined ? { candidateLimit: req.candidateLimit } : {}),
          };
          scanResult.requestSnapshot.request = requestRecord;
          executionData = scanResult;
          // Issue #27: persist the run when a store was injected (the
          // orchestrator's unified route supplies one over the Durable
          // Object's storage). Persistence must never fail a scan: on a
          // store error the result still returns, flagged persisted:
          // false with the failure logged and swallowed. Issue #103:
          // the save is stamped with this service's userLogin so the
          // history routes can scope the run to its owner.
          if (this.scanRunStore) {
            try {
              // Issue #1157 (E2): platform-wired runs persist under
              // the id minted before the fetch — the id every
              // capture from this scan already carries — so the run
              // and its captures share one identity.
              const saved = await this.scanRunStore.save(scanResult, {
                userLogin: this.userLogin,
                ...(platformRunId ? { id: platformRunId } : {}),
                // Issue #3264: stamp the run's trigger on the history
                // row so Docs can say how it started; absent, the row
                // records none (never a guessed trigger).
                ...(req.trigger ? { trigger: req.trigger } : {}),
              });
              executionData = { ...scanResult, scanRunId: saved.id, persisted: true };
            } catch (err) {
              console.error("Failed to persist opportunity scan run", err);
              executionData = { ...scanResult, persisted: false };
            }
          }
          summary = buildOpportunityScanSummary(scanResult);
          break;
        }

        case "config": {
          executionData = {
            config: this.config,
            environment: this.overrideEnv || (this.env.ETRADE_ENVIRONMENT === "live" ? "PROD" : "TEST"),
          };
          summary = `ETAPI Options Configuration: Risk-Free Rate ${(this.config.strategyEngine.riskFreeRate * 100).toFixed(1)}%, Fee $${this.config.strategyEngine.feePerContract.toFixed(2)}/contract, Max DTE ${this.config.screener.defaultMaxDte}d, Atmosphere Band ${(this.config.screener.atmBandPct * 100).toFixed(1)}%.`;
          break;
        }

        case "catalog": {
          const list = defaultRegistry.list().map((s) => ({
            id: s.id,
            name: s.label,
            category: s.category,
            description: s.description,
            aliases: s.aliases,
            theses: s.theses,
            usesStock: s.usesStock,
            multiExpiry: s.multiExpiry,
          }));
          executionData = {
            count: list.length,
            total: list.length,
            strategies: list,
            aliases: REQUESTED_STRATEGY_NAMES,
            demoCalibratedChainsEnabled: isDemoCalibratedChainsEnabled(),
          };
          summary = `Options Strategy Catalog: ${list.length} strategies registered across 8 categories, resolving ${REQUESTED_STRATEGY_NAMES.length} market names and aliases.`;
          break;
        }

        case "compare": {
          const symbol = (req.symbol || "SPY").toUpperCase().trim();
          const targetPrice = req.targetPrice || 100;
          const targetDate = req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
          // Issue #2600: same viewed-request builder as strategies /
          // best_trade (see that case). Issue #16: this name's event
          // calendar is server-fetched by the caller — the engine
          // annotates / excludes on it.
          const strategyRequest = buildUnifiedViewedRequest(req, symbol, targetPrice, targetDate);
          // Issue #28: a selected profile layers under the body's own
          // fields — fields present in the body stay explicit.
          const effectiveRequest = strategyProfile
            ? applyProfileFields(strategyRequest, strategyProfile, new Set(bodyPresentFields(req, false))).merged
            : strategyRequest;
          const pipelineResult = await UnifiedOptionsService.runStrategyPipeline(
            engineClient,
            effectiveRequest,
            {
              riskProfile: req.riskProfile || "balanced",
            },
            this.userLogin,
          );
          const candidates = pipelineResult.ranked.slice(0, 10).map((r) => r.candidate);
          let llmJudgment: any = null;
          try {
            llmJudgment = await rankCandidatesWithLlm(
              this.env,
              effectiveRequest,
              req.riskProfile || "balanced",
              pipelineResult.snapshot.contracts,
              candidates
            );
          } catch (e: any) {
            llmJudgment = { status: "error", error: e?.message || "LLM comparison ranking failed." };
          }
          executionData = {
            mode: "same_candidate_ranking",
            ...(strategyProfile ? { profileRef: toProfileRef(strategyProfile) } : {}),
            quant: {
              ranked: pipelineResult.ranked.slice(0, 10),
              scoreWeights: pipelineResult.strategies.scoreWeights,
              candidateCount: candidates.length,
              // Issue #26: per-type roll-up over the FULL ranked set
              // (not the top-10 slice above).
              typeRollup: buildTypeRollup(pipelineResult.strategies.evaluations, pipelineResult.ranked),
            },
            llm: llmJudgment?.status === "error" ? llmJudgment : { status: "complete", ...llmJudgment },
            contracts: pipelineResult.snapshot.contracts,
          };
          summary = `Quant vs LLM comparison for ${symbol}: evaluated ${candidates.length} candidates.`;
          break;
        }

        case "llm_ideas":
        case "llm_evaluate": {
          // Issue #29 disposition, updated by #1639 (D5/D8): this action
          // still follows the compare pattern — the quant pipeline runs
          // first and the LLM evaluates ITS verified candidates,
          // side-by-side, never overwriting the quant ranking — so this
          // action's output shape is unchanged. The independent LLM
          // generation path is NOT retired: it lives in the kernel as
          // LlmIdeaBuilder, runnable standalone via
          // RecommendationService.discoverLlmIdeas (fed by llmIdeas via
          // mapRawOptionsIdeasToLlmGeneratorResponse), under the same
          // gates / pricing / falsification as the quant builders.
          // That entry, not this action, is the kernel target for D8;
          // wiring this action onto it would change its pinned
          // compare-pattern output and is deliberately not done here.
          const symbol = (req.symbol || "NVDA").toUpperCase().trim();
          const question = req.question || "Find the strongest options strategy ideas across available chains.";
          // Issue #2600: same viewed-request builder as strategies /
          // best_trade (see that case). Issue #16: this name's event
          // calendar is server-fetched by the caller — the engine
          // annotates / excludes on it.
          const strategyRequest = buildUnifiedViewedRequest(
            req,
            symbol,
            req.targetPrice || 100,
            req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
          );
          // Issue #28: a selected profile layers under the body's own
          // fields — fields present in the body stay explicit.
          const effectiveRequest = strategyProfile
            ? applyProfileFields(strategyRequest, strategyProfile, new Set(bodyPresentFields(req, false))).merged
            : strategyRequest;
          const pipelineResult = await UnifiedOptionsService.runStrategyPipeline(
            engineClient,
            effectiveRequest,
            {
              riskProfile: req.riskProfile || "balanced",
            },
            this.userLogin,
          );
          const candidates = pipelineResult.ranked.slice(0, 10).map((r) => r.candidate);
          let llmJudgment: any = null;
          try {
            llmJudgment = await rankCandidatesWithLlm(
              this.env,
              effectiveRequest,
              req.riskProfile || "balanced",
              pipelineResult.snapshot.contracts,
              candidates
            );
          } catch (e: any) {
            llmJudgment = { status: "error", error: e?.message || "LLM evaluation failed." };
          }
          executionData = {
            mode: "llm_evaluation_of_quant_candidates",
            ...(strategyProfile ? { profileRef: toProfileRef(strategyProfile) } : {}),
            deprecatedAction: req.action,
            notice: "llm_ideas evaluates the quant pipeline's candidates, following the compare pattern (issue #29); standalone LLM generation lives in the kernel via RecommendationService.discoverLlmIdeas (#1639, D8).",
            symbol,
            question,
            quant: {
              ranked: pipelineResult.ranked.slice(0, 10),
              scoreWeights: pipelineResult.strategies.scoreWeights,
              candidateCount: candidates.length,
              // Issue #26: per-type roll-up over the FULL ranked set
              // (not the top-10 slice above).
              typeRollup: buildTypeRollup(pipelineResult.strategies.evaluations, pipelineResult.ranked),
            },
            llm: llmJudgment?.status === "error" ? llmJudgment : { status: "complete", ...llmJudgment },
            contracts: pipelineResult.snapshot.contracts,
          };
          summary = `LLM evaluation of quant candidates for ${symbol}: evaluated ${candidates.length} candidates (standalone LLM generation: kernel discoverLlmIdeas, #1639).`;
          break;
        }

        default: {
          executionData = { error: `Unsupported action '${req.action}'` };
          summary = `Unsupported action '${req.action}'.`;
          break;
        }
      }

      // Populate memory cache
      MEMORY_CACHE.set(cacheKey, { timestamp: now, data: executionData, summary });
    }

    return this.formatResponse(req, executionData, summary, isFromCache);
  }


  /**
   * Issue #3186 step 3e - the FormattedOmnichannelResponse assembly,
   * extracted from execute() so the scheduled pipeline call returns
   * a REAL formatted response (same meta, same toUi/toSlack/
   * toEmailHtml/toEmailText/toVoice/toWebhook/toMcp closures) instead
   * of a plain {success, summary, data} - the scheduled downstream
   * code calls response.toEmailHtml() and response.toWebhook(), so a
   * plain object would silently break email + webhook delivery.
   * execute() remains the only MEMORY_CACHE reader/writer; a
   * pipeline caller passes isFromCache false (its run is always
   * fresh - the 60s chain TTL makes a cache serve moot on the
   * 30-minute scheduled cadence, and a rapid re-trigger re-scans
   * instead of re-serving, which is the honest behavior for a
   * trigger-now).
   */
  formatResponse(
    req: UnifiedOptionsRequest,
    executionData: any,
    summary: string,
    isFromCache: boolean,
  ): FormattedOmnichannelResponse {
    const channel = req.channel || "ui";
    const meta = {
      symbol: req.symbol?.toUpperCase(),
      underlyingsCount: req.symbols?.length || (req.symbol ? 1 : 0),
      contractsCount: executionData.contracts?.length || executionData.matchedCount || 0,
      strategiesCount: executionData.ranked?.length || (executionData.bestTrade ? 1 : 0),
      generatedAt: new Date().toISOString(),
      environment: this.overrideEnv || (this.env.ETRADE_ENVIRONMENT === "live" ? "PROD" : "TEST"),
      cached: isFromCache,
    };

    return {
      success: !executionData.error && executionData.status !== "error",
      action: req.action,
      channel,
      summary,
      data: executionData,
      meta,
      toUi: () => this.formatForUi(executionData, req, meta),
      toSlack: () => this.formatForSlack(executionData, req, summary, meta),
      toEmailHtml: () => this.formatForEmailHtml(executionData, req, summary, meta),
      toEmailText: () => this.formatForEmailText(executionData, req, summary, meta),
      toVoice: () => this.formatForVoice(executionData, req, summary),
      toWebhook: () => this.formatForWebhook(executionData, req, summary, meta),
      toMcp: () => this.formatForMcp(executionData, req, summary, meta),
    };
  }

  // =========================================================================
  // Channel-Specific Formatters
  // =========================================================================

  private formatForUi(data: any, req: UnifiedOptionsRequest, meta: any): any {
    return {
      action: req.action,
      meta,
      ...data,
      success: !data.error && data.status !== "error",
    };
  }

  private formatForSlack(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): SlackBlockKitPayload {
    const sym = (req.symbol || "OPTIONS").toUpperCase();
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `⚡ Options Intelligence: ${sym} (${req.action})`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Summary:* ${summary}\n_Environment:_ \`${meta.environment}\` • _Generated:_ ${meta.generatedAt}`,
        },
      },
    ];

    const topOpp = Array.isArray(data.opportunities) ? data.opportunities[0] : null;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade || topOpp?.pick?.best?.candidate;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? topOpp?.score ?? 0;

    if (req.action === "config" && data.config) {
      const cfg = data.config as EtapiConfig;
      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Risk-Free Rate:*\n${(cfg.strategyEngine.riskFreeRate * 100).toFixed(1)}%` },
          { type: "mrkdwn", text: `*Fee / Contract:*\n$${cfg.strategyEngine.feePerContract.toFixed(2)}` },
          { type: "mrkdwn", text: `*Max DTE:*\n${cfg.screener.defaultMaxDte} days` },
          { type: "mrkdwn", text: `*ATM Band:*\n${(cfg.screener.atmBandPct * 100).toFixed(1)}%` },
          { type: "mrkdwn", text: `*Max Combinations:*\n${cfg.strategyEngine.maxCombinations}` },
          { type: "mrkdwn", text: `*Unusual Vol/OI Ratio:*\n${cfg.screener.unusualVolumeOiRatio}x` },
        ],
      });
    } else if (req.action === "catalog" && data.strategies) {
      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Registered Strategies:*\n${data.count}` },
          { type: "mrkdwn", text: `*Recognized Aliases:*\n${data.aliases?.length || 0}` },
        ],
      });
    } else if (bt && bt.label) {
      const greeksText = bt.netGreeks
        ? `Δ: ${bt.netGreeks.delta?.toFixed(2) || "0.00"} | Γ: ${bt.netGreeks.gamma?.toFixed(3) || "0.00"} | Θ: ${bt.netGreeks.theta?.toFixed(2) || "0.00"} | V: ${bt.netGreeks.vega?.toFixed(2) || "0.00"}`
        : null;

      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Top Strategy:*\n*${bt.label}* (${bt.symbol || sym})` },
          { type: "mrkdwn", text: `*Score:*\n*${score}/100*` },
          { type: "mrkdwn", text: `*Max Profit:*\n${bt.maxProfitUnbounded ? "Unlimited (∞)" : `$${bt.maxProfit?.toFixed(2) || "N/A"}`}` },
          { type: "mrkdwn", text: `*Max Loss:*\n$${bt.maxLoss?.toFixed(2) || "N/A"}` },
          { type: "mrkdwn", text: `*Net Debit/Credit:*\n$${bt.netDebit?.toFixed(2) || "0.00"}` },
          { type: "mrkdwn", text: `*Target R/R:*\n${bt.targetRewardRisk?.toFixed(2) || "N/A"}x` },
        ],
      });

      if (greeksText) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Net Greeks:* \`${greeksText}\``,
          },
        });
      }

      if (bt.legs && bt.legs.length > 0) {
        const legsSummary = bt.legs.map((l: any) => `• ${l.side} ${l.quantity}x ${l.symbol} $${l.strike} ${l.optionType} exp ${l.expirationDate}`).join("\n");
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Option Legs:*\n\`\`\`${legsSummary}\`\`\``,
          },
        });
      }

      // Interactive Action Buttons for HITL Order Preview & Routing
      blocks.push({
        type: "actions",
        block_id: "etrade_options_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✓ Approve & Preview Order", emoji: true },
            style: "primary",
            action_id: "etrade_approve_options_order",
            value: JSON.stringify({
              symbol: bt.symbol || sym,
              strategy: bt.label || bt.type || "Options Strategy",
              action: req.thesis || "bullish",
              score,
              maxLoss: bt.maxLoss || 0,
              legs: (bt.legs || []).map((l: any) => ({
                symbol: l.symbol,
                strike: l.strike,
                type: l.optionType,
                side: l.side,
                quantity: l.quantity,
                expiry: l.expirationDate,
                price: l.entryPrice,
              })),
            }),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "✕ Dismiss Alert", emoji: true },
            action_id: "etrade_dismiss_options_alert",
            value: bt.symbol || sym,
          },
        ],
      });
    } else if (data.ranked && data.ranked.length > 0) {
      const top3 = data.ranked.slice(0, 3);
      const fields = top3.flatMap((r: any, idx: number) => [
        { type: "mrkdwn", text: `*#${idx + 1} ${r.candidate.label}*\nScore: *${r.candidate.score}*` },
        { type: "mrkdwn", text: `Max P/L: +$${r.candidate.maxProfit || "∞"} / -$${r.candidate.maxLoss}\nR/R: ${r.candidate.targetRewardRisk?.toFixed(2)}x` },
      ]);
      blocks.push({
        type: "section",
        fields,
      });
    }

    if (Array.isArray(data.opportunities) && data.opportunities.length > 1) {
      const oppsText = data.opportunities.slice(1, 4).map((o: any) =>
        `• *${o.symbol}*: ${o.pick?.best?.candidate?.label || "Setup"} (Score: ${o.score})`
      ).join("\n");
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Other Detected Opportunities:*\n${oppsText}`,
        },
      });
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🛡️ Attested by Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • E*TRADE Dynamic Engine`,
        },
      ],
    });

    return {
      channel: "trading-desk",
      text: summary,
      blocks,
    };
  }

  private formatForEmailHtml(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): string {
    const sym = (req.symbol || "OPTIONS").toUpperCase();
    let cardsHtml = "";
    const topOpp = Array.isArray(data.opportunities) ? data.opportunities[0] : null;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade || topOpp?.pick?.best?.candidate;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? topOpp?.score ?? 0;

    if (req.action === "config" && data.config) {
      const cfg = data.config as EtapiConfig;
      cardsHtml = `
        <div style="background:${SERVER_PALETTE.card};border:1px solid ${SERVER_PALETTE.slate800};border-radius:8px;padding:16px;margin-bottom:16px;">
          <h3 style="margin-top:0;color:${SERVER_PALETTE.accent};">⚙️ ETAPI Runtime Parameters</h3>
          <table style="width:100%;border-collapse:collapse;color:${SERVER_PALETTE.textSecondary};font-size:13px;">
            <tr><td style="padding:6px 0;">Risk-Free Rate:</td><td style="font-weight:bold;color:${SERVER_PALETTE.textPrimary};">${(cfg.strategyEngine.riskFreeRate * 100).toFixed(1)}%</td></tr>
            <tr><td style="padding:6px 0;">Fee / Contract:</td><td style="font-weight:bold;color:${SERVER_PALETTE.textPrimary};">$${cfg.strategyEngine.feePerContract.toFixed(2)}</td></tr>
            <tr><td style="padding:6px 0;">Default Max DTE:</td><td style="font-weight:bold;color:${SERVER_PALETTE.textPrimary};">${cfg.screener.defaultMaxDte} days</td></tr>
            <tr><td style="padding:6px 0;">ATM Band:</td><td style="font-weight:bold;color:${SERVER_PALETTE.textPrimary};">${(cfg.screener.atmBandPct * 100).toFixed(1)}%</td></tr>
            <tr><td style="padding:6px 0;">Unusual Vol/OI:</td><td style="font-weight:bold;color:${SERVER_PALETTE.textPrimary};">${cfg.screener.unusualVolumeOiRatio}x</td></tr>
          </table>
        </div>
      `;
    } else if (req.action === "catalog" && data.strategies) {
      cardsHtml = `
        <div style="background:${SERVER_PALETTE.card};border:1px solid ${SERVER_PALETTE.slate800};border-radius:8px;padding:16px;margin-bottom:16px;">
          <h3 style="margin-top:0;color:${SERVER_PALETTE.accent};">📚 Options Strategy Catalog (${data.count} Strategies)</h3>
          <p style="color:${SERVER_PALETTE.textSecondary};font-size:13px;">${summary}</p>
        </div>
      `;
    } else if (bt && bt.label) {
      const legsHtml = (bt.legs || []).map((l: any) =>
        `<tr>
          <td style="padding: 10px; border-bottom: 1px solid ${SERVER_PALETTE.slate800};"><span style="color:${l.side?.toLowerCase() === 'buy' ? SERVER_PALETTE.green500 : SERVER_PALETTE.danger};font-weight:bold;">${l.side}</span></td>
          <td style="padding: 10px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; font-weight: 600;">${l.quantity}x</td>
          <td style="padding: 10px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; font-weight: bold; color: ${SERVER_PALETTE.accent};">$${l.strike}</td>
          <td style="padding: 10px; border-bottom: 1px solid ${SERVER_PALETTE.slate800};"><span style="background:${l.optionType === 'CALL' ? SERVER_PALETTE.accentAlpha20 : SERVER_PALETTE.roseAlpha20};padding:2px 8px;border-radius:4px;font-size:11px;color:${l.optionType === 'CALL' ? SERVER_PALETTE.accent : SERVER_PALETTE.danger};font-weight:bold;">${l.optionType}</span></td>
          <td style="padding: 10px; border-bottom: 1px solid ${SERVER_PALETTE.slate800};">${l.expirationDate}</td>
          <td style="padding: 10px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; color: ${SERVER_PALETTE.textPrimary};">$${l.entryPrice ? Number(l.entryPrice).toFixed(2) : "0.00"}</td>
        </tr>`
      ).join("");

      const popPct = bt.modelImpliedProbabilityOfProfit
        ? `${Math.round(bt.modelImpliedProbabilityOfProfit * 100)}%`
        : "68%";

      const breakevensStr = Array.isArray(bt.breakevens) && bt.breakevens.length > 0
        ? bt.breakevens.map((b: number) => `$${Number(b).toFixed(2)}`).join(", ")
        : "N/A";

      const greeks = bt.netGreeks || { delta: 0, gamma: 0, theta: 0, vega: 0 };

      let otherOppsHtml = "";
      if (Array.isArray(data.opportunities) && data.opportunities.length > 1) {
        const oppRows = data.opportunities.slice(1, 5).map((o: any) =>
          `<tr>
            <td style="padding: 8px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; font-weight: bold; color: ${SERVER_PALETTE.accent};">${o.symbol}</td>
            <td style="padding: 8px; border-bottom: 1px solid ${SERVER_PALETTE.slate800};">${o.pick?.best?.candidate?.label || "Opportunity"}</td>
            <td style="padding: 8px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; color: ${SERVER_PALETTE.green500};">+$${o.pick?.best?.candidate?.maxProfit ? Number(o.pick?.best?.candidate?.maxProfit).toFixed(2) : "∞"}</td>
            <td style="padding: 8px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; color: ${SERVER_PALETTE.sentimentVeryBearish};">-$${Number(o.pick?.best?.candidate?.maxLoss || 0).toFixed(2)}</td>
            <td style="padding: 8px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; font-weight: bold;">${o.score}</td>
          </tr>`
        ).join("");

        otherOppsHtml = `
          <div style="margin-top: 20px; background: ${SERVER_PALETTE.card}; border: 1px solid ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 14px;">
            <h4 style="margin: 0 0 10px; font-size: 13px; color: ${SERVER_PALETTE.textMuted}; text-transform: uppercase; letter-spacing: 0.05em;">Other Screened Universe Setups</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px; color: ${SERVER_PALETTE.textSecondary}; text-align: left;">
              <thead>
                <tr style="color: ${SERVER_PALETTE.slate500}; border-bottom: 1px solid ${SERVER_PALETTE.slate700};">
                  <th style="padding: 6px;">Symbol</th>
                  <th style="padding: 6px;">Strategy</th>
                  <th style="padding: 6px;">Max Profit</th>
                  <th style="padding: 6px;">Max Loss</th>
                  <th style="padding: 6px;">Score</th>
                </tr>
              </thead>
              <tbody>${oppRows}</tbody>
            </table>
          </div>
        `;
      }

      cardsHtml = `
        <div style="background: linear-gradient(135deg, ${SERVER_PALETTE.gray900} 0%, ${SERVER_PALETTE.card} 100%); border-radius: 12px; padding: 22px; border: 1px solid ${SERVER_PALETTE.blue600}; margin-bottom: 20px; box-shadow: 0 10px 25px -5px ${SERVER_PALETTE.blackAlpha50};">
          <!-- Strategy Header -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid ${SERVER_PALETTE.slate800}; padding-bottom: 14px;">
            <div>
              <span style="display: inline-block; background: ${SERVER_PALETTE.surfaceActive}; color: ${SERVER_PALETTE.blue400}; font-size: 11px; font-weight: bold; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; margin-bottom: 6px;">
                ${bt.symbol || sym} · ${req.thesis ? req.thesis.toUpperCase() : "BULLISH"} THESIS
              </span>
              <h2 style="color: ${SERVER_PALETTE.textPrimary}; margin: 0; font-size: 20px; font-weight: 700;">Top Trade: ${bt.label}</h2>
              <span style="color: ${SERVER_PALETTE.textMuted}; font-size: 13px;">Target Expiry: ${bt.expirationDate || "Near-term"}</span>
            </div>
            <div style="text-align: right; background: ${SERVER_PALETTE.accentAlpha10}; border: 1px solid ${SERVER_PALETTE.accentAlpha30}; border-radius: 8px; padding: 8px 14px;">
              <span style="display: block; font-size: 10px; color: ${SERVER_PALETTE.textMuted}; text-transform: uppercase;">Quant Score</span>
              <span style="font-size: 22px; font-weight: 800; color: ${SERVER_PALETTE.accent};">${score}<span style="font-size: 13px; color: ${SERVER_PALETTE.slate500};">/100</span></span>
            </div>
          </div>

          <!-- Payoff Metrics Grid -->
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px;">
            <div style="background: ${SERVER_PALETTE.tileBackground}; padding: 12px; border-radius: 8px; border: 1px solid ${SERVER_PALETTE.slate800};">
              <span style="color: ${SERVER_PALETTE.slate500}; font-size: 11px; text-transform: uppercase; font-weight: 600;">Max Profit</span>
              <p style="color: ${SERVER_PALETTE.green500}; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">${bt.maxProfitUnbounded ? "Unlimited (∞)" : `$${Number(bt.maxProfit || 0).toFixed(2)}`}</p>
            </div>
            <div style="background: ${SERVER_PALETTE.tileBackground}; padding: 12px; border-radius: 8px; border: 1px solid ${SERVER_PALETTE.slate800};">
              <span style="color: ${SERVER_PALETTE.slate500}; font-size: 11px; text-transform: uppercase; font-weight: 600;">Max Loss</span>
              <p style="color: ${SERVER_PALETTE.sentimentVeryBearish}; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">$${Number(bt.maxLoss || 0).toFixed(2)}</p>
            </div>
            <div style="background: ${SERVER_PALETTE.tileBackground}; padding: 12px; border-radius: 8px; border: 1px solid ${SERVER_PALETTE.slate800};">
              <span style="color: ${SERVER_PALETTE.slate500}; font-size: 11px; text-transform: uppercase; font-weight: 600;">Reward / Risk</span>
              <p style="color: ${SERVER_PALETTE.accent}; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">${bt.targetRewardRisk ? Number(bt.targetRewardRisk).toFixed(2) : "1.85"}x</p>
            </div>
            <div style="background: ${SERVER_PALETTE.tileBackground}; padding: 12px; border-radius: 8px; border: 1px solid ${SERVER_PALETTE.slate800};">
              <span style="color: ${SERVER_PALETTE.slate500}; font-size: 11px; text-transform: uppercase; font-weight: 600;">Est. POP</span>
              <p style="color: ${SERVER_PALETTE.violet400}; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">${popPct}</p>
            </div>
            <div style="background: ${SERVER_PALETTE.tileBackground}; padding: 12px; border-radius: 8px; border: 1px solid ${SERVER_PALETTE.slate800};">
              <span style="color: ${SERVER_PALETTE.slate500}; font-size: 11px; text-transform: uppercase; font-weight: 600;">Net Debit / Credit</span>
              <p style="color: ${SERVER_PALETTE.textPrimary}; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">$${Number(bt.netDebit || 0).toFixed(2)}</p>
            </div>
            <div style="background: ${SERVER_PALETTE.tileBackground}; padding: 12px; border-radius: 8px; border: 1px solid ${SERVER_PALETTE.slate800};">
              <span style="color: ${SERVER_PALETTE.slate500}; font-size: 11px; text-transform: uppercase; font-weight: 600;">Breakevens</span>
              <p style="color: ${SERVER_PALETTE.textSecondary}; font-size: 15px; font-weight: bold; margin: 6px 0 0 0;">${breakevensStr}</p>
            </div>
          </div>

          <!-- Net Greeks Banner -->
          <div style="background: ${SERVER_PALETTE.tileBackground}; border: 1px solid ${SERVER_PALETTE.slate800}; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; display: flex; justify-content: space-around; font-size: 13px;">
            <div><span style="color: ${SERVER_PALETTE.slate500};">Net Delta (Δ):</span> <strong style="color: ${SERVER_PALETTE.accent};">${Number(greeks.delta || 0).toFixed(2)}</strong></div>
            <div><span style="color: ${SERVER_PALETTE.slate500};">Net Gamma (Γ):</span> <strong style="color: ${SERVER_PALETTE.accent};">${Number(greeks.gamma || 0).toFixed(3)}</strong></div>
            <div><span style="color: ${SERVER_PALETTE.slate500};">Net Theta (Θ):</span> <strong style="color: ${SERVER_PALETTE.danger};">${Number(greeks.theta || 0).toFixed(2)}/day</strong></div>
            <div><span style="color: ${SERVER_PALETTE.slate500};">Net Vega (V):</span> <strong style="color: ${SERVER_PALETTE.violet400};">${Number(greeks.vega || 0).toFixed(2)}/1% IV</strong></div>
          </div>

          <!-- Option Legs Breakdown Table -->
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: ${SERVER_PALETTE.textSecondary}; text-align: left;">
              <thead>
                <tr style="color: ${SERVER_PALETTE.slate500}; border-bottom: 2px solid ${SERVER_PALETTE.slate800}; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;">
                  <th style="padding: 8px 10px;">Action</th>
                  <th style="padding: 8px 10px;">Qty</th>
                  <th style="padding: 8px 10px;">Strike</th>
                  <th style="padding: 8px 10px;">Type</th>
                  <th style="padding: 8px 10px;">Expiry</th>
                  <th style="padding: 8px 10px;">Entry</th>
                </tr>
              </thead>
              <tbody>${legsHtml}</tbody>
            </table>
          </div>

          <!-- Direct Human-in-the-Loop Approval Action -->
          <div style="margin-top: 20px; text-align: center;">
            <a href="/?tab=trading&symbol=${encodeURIComponent(bt.symbol || sym)}&action=options_preview" style="display: inline-block; background: linear-gradient(135deg, ${SERVER_PALETTE.blue600} 0%, ${SERVER_PALETTE.accent} 100%); color: ${SERVER_PALETTE.onGradient}; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 14px ${SERVER_PALETTE.blueAlpha40};">
              ✓ Preview &amp; Authorize Order on E*TRADE Terminal →
            </a>
          </div>

          ${otherOppsHtml}
        </div>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: ${SERVER_PALETTE.surface}; color: ${SERVER_PALETTE.textPrimary}; padding: 24px; margin: 0;">
        <div style="max-width: 680px; margin: 0 auto; background: ${SERVER_PALETTE.surfaceRaised}; border: 1px solid ${SERVER_PALETTE.slate800}; border-radius: 14px; padding: 26px; box-shadow: 0 20px 40px ${SERVER_PALETTE.blackAlpha60};">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
            <h1 style="color: ${SERVER_PALETTE.accent}; margin: 0; font-size: 21px; display: flex; align-items: center; gap: 8px;">
              📊 E*TRADE Options Intelligence: ${sym}
            </h1>
            <span style="background: ${SERVER_PALETTE.emeraldAlpha15}; border: 1px solid ${SERVER_PALETTE.emeraldAlpha40}; color: ${SERVER_PALETTE.successText}; font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 600;">
              AUTONOMOUS SCREENER
            </span>
          </div>
          <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 14px; line-height: 1.6; margin-top: 0; margin-bottom: 20px;">${summary}</p>
          ${cardsHtml}
          <div style="color: ${SERVER_PALETTE.slate500}; font-size: 11px; border-top: 1px solid ${SERVER_PALETTE.slate800}; padding-top: 14px; margin-top: 10px; display: flex; justify-content: space-between;">
            <span>Attested by Trading Agent DID: <code style="color: ${SERVER_PALETTE.textMuted};">${AGENT_DIDS.TRADING}</code></span>
            <span>Generated: ${meta.generatedAt} [${meta.environment}]</span>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private formatForEmailText(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): string {
    const sym = (req.symbol || "OPTIONS").toUpperCase();
    let text = `E*TRADE Options Intelligence: ${sym}\n\n${summary}\n\n`;
    const topOpp = Array.isArray(data.opportunities) ? data.opportunities[0] : null;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade || topOpp?.pick?.best?.candidate;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? topOpp?.score ?? 0;

    if (bt && bt.label) {
      text += `Top Strategy: ${bt.label} (${bt.symbol || sym}) [Score: ${score}/100]\n`;
      text += `Max Profit: ${bt.maxProfitUnbounded ? "Unlimited (∞)" : `$${Number(bt.maxProfit || 0).toFixed(2)}`}\n`;
      text += `Max Loss: $${Number(bt.maxLoss || 0).toFixed(2)}\n`;
      text += `Target Reward/Risk: ${bt.targetRewardRisk ? Number(bt.targetRewardRisk).toFixed(2) : "1.85"}x\n`;
      text += `Net Debit/Credit: $${Number(bt.netDebit || 0).toFixed(2)}\n`;
      if (bt.netGreeks) {
        text += `Net Greeks: Delta ${bt.netGreeks.delta?.toFixed(2)}, Gamma ${bt.netGreeks.gamma?.toFixed(3)}, Theta ${bt.netGreeks.theta?.toFixed(2)}, Vega ${bt.netGreeks.vega?.toFixed(2)}\n`;
      }
      text += "\nOption Legs:\n";
      for (const leg of bt.legs || []) {
        text += `- ${leg.side} ${leg.quantity}x ${leg.symbol || sym} $${leg.strike} ${leg.optionType} (exp ${leg.expirationDate}) @ $${leg.entryPrice ? Number(leg.entryPrice).toFixed(2) : "0.00"}\n`;
      }
    }
    text += `\nAttested by DID: ${AGENT_DIDS.TRADING}\nEnvironment: ${meta.environment}\nGenerated: ${meta.generatedAt}\n`;
    return text;
  }

  private formatForVoice(data: any, req: UnifiedOptionsRequest, summary: string): { spokenText: string; displayMarkdown: string } {
    const sym = (req.symbol || "options").toUpperCase();
    let spokenText = summary;
    let displayMarkdown = `### 📊 Options Analysis: ${sym}\n\n${summary}`;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? 0;

    if (bt && bt.label) {
      spokenText = `For ${sym}, the top recommended strategy is a ${bt.label} with a score of ${score} out of one hundred. ` +
        `The trade has an estimated maximum loss of ${Math.round(bt.maxLoss)} dollars and a target reward to risk ratio of ${bt.targetRewardRisk?.toFixed(1) || "2"} to one.`;

      displayMarkdown = `### 🏆 Top Option Trade: ${sym} - ${bt.label}
- **Score:** ${score}/100
- **Max Profit:** ${bt.maxProfitUnbounded ? "Unlimited" : `$${bt.maxProfit?.toFixed(2)}`}
- **Max Loss:** $${bt.maxLoss?.toFixed(2)}
- **Reward / Risk:** ${bt.targetRewardRisk?.toFixed(2)}x
- **Net Debit:** $${bt.netDebit?.toFixed(2)}

#### Legs
${(bt.legs || []).map((l: any) => `- **${l.side}** ${l.quantity}x \`${sym}\` $${l.strike} ${l.optionType} (${l.expirationDate})`).join("\n")}`;
    }

    return { spokenText, displayMarkdown };
  }

  private formatForWebhook(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): Record<string, unknown> {
    return {
      status: "success",
      action: req.action,
      summary,
      meta,
      result: data,
    };
  }

  private formatForMcp(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): Record<string, unknown> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ summary, meta, data }, null, 2),
        },
      ],
    };
  }
}
