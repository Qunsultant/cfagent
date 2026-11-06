/**
 * Issue #359-11: E*TRADE options routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous options block (between the E*TRADE broker
 * account-activity delegation and the E*TRADE watchlists block). Its
 * route list and order are pinned by tests/thin_router_inventory.test.ts
 * and tests/etrade_routes_resplit_995.test.ts; the list is not repeated
 * here, so the pins stay the one place a route change is recorded.
 *
 * The blocks were contiguous in routeRequest, so this module exports ONE
 * handler invoked from routeRequest at the EXACT position the original
 * blocks occupied in the sequential matching sequence. It returns a Response
 * when one of its paths matches, or null when none does (the orchestrator
 * then continues its sequential matching).
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * BOUNDARY DISCIPLINE (#290): all trading access goes through the
 * src/trading/index.ts boundary ("../../trading"), exactly as the inline
 * code did. No direct imports of trading internals.
 *
 * The #314 single-owner handleOptionsStrategyRecommend moved here with its
 * block (slice #359-09 did the same for handleEnvironmentSwitch): it is
 * called only by the two strategy routes owned by this module.
 *
 * Handlers receive OrchestratorAgent state via EtradeOptionsRouteContext
 * (no new globals; requestedEnv passes through the context).
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { executeOptionsRegenerate } from "./optionsRegenerate";
import type { AgentContext } from "agents";
import { ETradeService } from "../../services/etrade";
import {
  DynamicOptionsScreener,
  buildStrategyReportInput,
  strategyReportArtifactLinks,
  createOptionsScreeningProvider,
  OPTIONS_SCREENING_PROVIDER_ID,
  recommendOptionStrategies,
  validateStrategyRequest,
  validateStrategyProfile,
  describeLlmInput,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  TradingPlatformRegistry,
  platformChainSource,
  type RiskProfile,
  type StrategyScreenFilter,
  defaultRegistry,
  REQUESTED_STRATEGY_NAMES,
  type StrategyRequest,
} from "../../trading";
import {
  parseOptionsDiscoveryRequest,
  parseOptionsScreenRequest,
  parseUnifiedOptionsRequest,
  resolvePanelFetchBands,
  normalizeViewedRecommendationBody,
  noViewComparisonError,
  strategyRecordControlFields,
} from "../../trading";
import { getEtapiConfig, setRuntimeEtapiConfigOverrides } from "../../config/etapiConfig";
import { isDemoCalibratedChainsEnabled } from "../../config/demoMode";
import { DEFAULT_AI_MODEL } from "../model";
import type { Env, ETradeOptionChain, ETradeOptionExpireDate } from "../../types";
import type { DatabaseORM, SqlStorage } from "../../orm";
import type { ScreenerAgent } from "../screener-agent";
import { deliverGatedSlack } from "../../services/gatedSlackDelivery";
import { screenerOutcomeFromRunResult } from "../../services/screenerFollowups";
import { type KernelSnapshot, type PanelDiscoveryResult } from "../../services/recommendationKernel";
import {
  runComparePanelViaPipeline,
  runManualPanelViaPipeline,
} from "../../workflows/manualPanelScreen";
import type { OptionsStageStorage } from "../../workflows/optionsScreenPorts";
import { listComparisonOutcomes, runProductionComparison } from "../../services/comparisonRunner";
import { getSymbolEventCalendar, toEventCalendarInfo } from "../../services/eventCalendar";
import {
  handleOptionsLatestRuns,
  handleOptionsScansList,
  handleOptionsScansDiff,
  handleOptionsScanRunById,
  handleOptionsDiscoveryRunsList,
  handleOptionsDiscoveryRunById,
  handleOptionsIvHistory,
} from "./etradeOptionsRuns";
import {
  handleOptionsProfilesList,
  handleOptionsProfilesCreate,
  handleOptionsProfileGet,
  handleOptionsProfileUpdate,
  handleOptionsProfileDelete,
  handleOptionsStrategyReviewsList,
  handleOptionsStrategyReviewsDecide,
} from "./etradeOptionsProfiles";
import {
  executeLlmIdeasEvaluation,
  rankOptionsCompareCandidates,
} from "./etradeOptionsEvaluate";
import {
  executeOptionsScreen,
  executeUnifiedOptions,
} from "./etradeOptionsScreen";
import { runNoViewStrategies } from "./etradeOptionsNoView";
import { serveDiscoveryReport } from "./etradeOptionsDiscoveryReport";
import { recordStrategyScreenRun } from "../../services/optionsServeRecord";
import { resolveTenantBroker } from "../../services/tenantProviders";
import { panelAuthResponse } from "../../services/optionsAuthFreshness";
import { resolveTenantProviders } from "../../services/tenantProviders";

/** The subset of OrchestratorAgent surface the E*TRADE options handlers need. */
export interface EtradeOptionsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** Issue #1123: set when this request is executed as an async job —
   *  inline deliveries defer to the tracked follow-up pipeline. */
  asyncJobId?: string;
  /** Issue #1123 S5a: bridge a synchronously-completed screen into
   *  the tracked follow-up pipeline. Preferred over inline delivery
   *  whenever the host provides it. */
  scheduleScreenerFollowups?: (
    outcome: import("../../services/screenerFollowups").ScreenerRunOutcome,
    userLogin: string,
  ) => Promise<void>;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Durable Object agent context (owner: OrchestratorAgent - was `this.ctx`),
   * used for the SqlStorage-backed stores. */
  agentCtx: AgentContext;
  /** Table initializer (owner: OrchestratorAgent - was `this.ensureTables()`). */
  ensureTables(): SqlStorage;
  /** Requested E*TRADE environment (owner: routeRequest local - stays inline,
   * shared with the watchlists module (#359-12); passed through here). */
  requestedEnv: "TEST" | "PROD" | undefined;
  /** Screener agent (owner: OrchestratorAgent - was `this.getScreenerAgent()`). */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
}

/**
 * Issue #314 — single-owner handler for options strategy discovery
 * (Workflow A2). Both spellings (`/trading/options/recommend` and the
 * advertised `POST /api/etrade/options/strategy`) delegate here, so the
 * strategy request is validated once and evaluated once by the real
 * engine (E*TRADE chain snapshot -> screened contracts ->
 * recommendOptionStrategies), with byte-identical responses.
 *
 * Honest subset vs the docs: the engine computes Black-Scholes Greeks,
 * model-implied probability of profit (N(d2)), expected value, payoff
 * curves, and a volatility-ALIGNMENT score per candidate. It does not
 * compute a standalone "IV rank" field; IV enters through the per-leg
 * impliedVolatility and the volatility-alignment score weight.
 */
export async function handleOptionsStrategyRecommend(
  request: Request,
  deps: { orm: any; env: Env; sessionKey: string; requestedEnv: "TEST" | "PROD" | undefined; storage?: any }
): Promise<Response> {
  const body = await request.json().catch(() => null) as Partial<StrategyRequest> | null;
  // Issue #2600: normalize BEFORE the legacy validator.
  const normalized = normalizeViewedRecommendationBody(body);
  if (normalized.noViewError) {
    return Response.json({ error: normalized.noViewError }, { status: 400 });
  }
  const validationBody = normalized.validationBody as Partial<StrategyRequest>;
  const validationError = validateStrategyRequest(validationBody);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }

  try {
    const strategyRequest = validationBody as StrategyRequest;
    const banded = resolvePanelFetchBands(strategyRequest, normalized.farDated);
    // Issue #16: the event calendar is a server-side fact — a
    // client-supplied one is never trusted. Fetch it for this name and
    // overwrite whatever the body carried. The service never throws;
    // an uncovered result simply keeps event risk unverified.
    strategyRequest.eventCalendar = toEventCalendarInfo(await getSymbolEventCalendar(strategyRequest.symbol));
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const etrade = new ETradeService(deps.orm, deps.env, userLogin, deps.requestedEnv);
    // Issue #1378: the optional call tolerates ETradeService-shaped
    // mocks without getUniverseDeps (single_pdf_path_s4) — undefined
    // degrades to the missing-seam throw at discovery time.
    const screener = new DynamicOptionsScreener(etrade.client, undefined, await etrade.getUniverseDeps?.(deps.storage));
    // Consolidation C1 (issue #1201, epic #1151 R1): the contract
    // screen behind strategy recommendation executes through the
    // Phase 0 ScreeningProvider (same engine, same result) — see
    // executeOptionsScreen in etradeOptionsScreen.ts.
    const provider = createOptionsScreeningProvider(OPTIONS_SCREENING_PROVIDER_ID, screener);
    const provided = await provider.screen({
      assetClass: "options",
      filter: {
        underlyingSymbols: [strategyRequest.symbol.toUpperCase().trim()],
        contractType: "BOTH",
        minDte: strategyRequest.minDte,
        maxDte: strategyRequest.maxDte,
        ...(banded.request.expirationDteBands ? { expirationDteBands: banded.request.expirationDteBands } : {}),
        minVolume: strategyRequest.minVolume,
        minOpenInterest: strategyRequest.minOpenInterest,
        maxSpreadPct: strategyRequest.maxSpreadPct,
        maxQuoteAgeSeconds: strategyRequest.maxQuoteAgeSeconds,
        limit: strategyRequest.contractLimit,
      },
    });
    if (provided.assetClass !== "options") {
      throw new Error("Options screening provider returned a non-options result.");
    }
    const screened = provided.result;
    const recommendations = recommendOptionStrategies(screened.contracts, banded.request, normalized.candidateLimitAll ? undefined : strategyRequest.candidateLimit);
    return Response.json({
      ...recommendations,
      contracts: screened.contracts,
      screen: {
        scannedAt: screened.scannedAt,
        underlyingsScanned: screened.totalUnderlyingsScanned,
        contractsEvaluated: screened.totalContractsEvaluated,
        contractsMatched: screened.matchedCount,
        quoteQuality: screened.quoteQuality,
        fetchErrors: screened.fetchErrors,
        warnings: screened.warnings,
        validationError: screened.validationError,
        status: screened.status,
      },
      contractRejections: (screened.rejections || []).slice(0, 50),
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Options recommendation failed" }, { status: 400 });
  }
}

/**
 * Handles the E*TRADE options routes (chains / expire-dates / scans /
 * iv-history / profiles / strategy) and the trading/options routes
 * (llm-ideas / compare / recommend / catalog / strategies / screen /
 * unified / config). Returns a Response on match, null when no options path
 * matches (the orchestrator then continues its sequential matching).
 */
/**
 * Issue #2180: serve a discovery run report by its stored key.
 * Owner-scoped exactly like every other discovery read (a key without the
 * owner resolves to nothing), and 404 — never a guess — when the key is
 * absent or unknown.
 */
export async function handleEtradeOptionsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: EtradeOptionsRouteContext
): Promise<Response | null> {
  const sql = ctx.ensureTables();

    // Issue #223: latest autonomous options-analysis runs. Results were only
    // ever visible in the live broadcast; the scheduler now keeps the last 20
    // runs in DO storage so the panel can render what actually ran.
    // server.ts strips the /api prefix, so the DO sees /options/latest.
    if (path.endsWith("/options/latest") && request.method === "GET") {
      return handleOptionsLatestRuns(ctx);
    }

    // Real E*TRADE REST API: Option Chains
    if (path.endsWith("/etrade/options/chains") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryYear = url.searchParams.get("expiryYear") ? Number(url.searchParams.get("expiryYear")) : undefined;
        const expiryMonth = url.searchParams.get("expiryMonth") ? Number(url.searchParams.get("expiryMonth")) : undefined;
        const expiryDay = url.searchParams.get("expiryDay") ? Number(url.searchParams.get("expiryDay")) : undefined;
        const strikePrice = url.searchParams.get("strikePrice") ? Number(url.searchParams.get("strikePrice")) : undefined;
        const noOfStrikes = url.searchParams.get("noOfStrikes") ? Number(url.searchParams.get("noOfStrikes")) : undefined;
        const chainType = (url.searchParams.get("chainType") as "CALL" | "PUT" | "CALLPUT") || undefined;
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        // #291 T5c: resolved through the platform registry (the chains
        // read is a verbatim client passthrough on the platform contract);
        // one instance serves the call and its #155 error read.
        const broker = await resolveTenantBroker(ctx.env);
        const etrade = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, ctx.requestedEnv);
        const chain = await etrade.getOptionChains?.({
          symbol,
          expiryYear,
          expiryMonth,
          expiryDay,
          strikePrice,
          noOfStrikes,
          chainType,
        });
        if (!chain) {
          // Issue #155: a null chain with a recorded client error is an
          // upstream failure (expired OAuth, missing credentials,
          // network), not an empty chain — surface it as a 502 naming
          // the cause instead of a fabricated 200 empty payload.
          const upstreamError = etrade.getLastError?.();
          if (upstreamError) {
            return Response.json({ error: upstreamError, symbol }, { status: 502 });
          }
        }
        return Response.json(chain || { symbol, underlyingPrice: 0, pairs: [] });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option chains" }, { status: 500 });
      }
    }

    // Issue #314: the advertised POST /api/etrade/options/strategy spelling
    // (docs/ANALYSIS_AND_EXECUTION_WORKFLOWS.md, Workflow A2) delegates to
    // the same single-owner strategy-discovery handler as
    // /trading/options/recommend — one logic owner, byte-identical contract.
    if (path.endsWith("/etrade/options/strategy") && request.method === "POST") {
      return handleOptionsStrategyRecommend(request, {
        orm: ctx.getOrm(),
        env: ctx.env,
        sessionKey: sessionId,
        requestedEnv: ctx.requestedEnv,
        // Issue #1661: DO blob handle for full capture on this leg.
        storage: ctx.agentCtx?.storage,
      });
    }

    // Real E*TRADE REST API: Option Expire Dates
    if (path.endsWith("/etrade/options/expire-dates") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryType = url.searchParams.get("expiryType") || undefined;
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        // #291 T5c: registry-resolved platform (verbatim passthrough
        // reads); the #155 error read stays on this same instance.
        const broker = await resolveTenantBroker(ctx.env);
        const etrade = TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, ctx.requestedEnv);
        const dates = (await etrade.getOptionExpireDates?.(symbol, expiryType)) ?? [];
        if (dates.length === 0) {
          // Issue #155: distinguish an upstream failure (client error
          // recorded) from a symbol that genuinely has no expirations —
          // only the genuine empty keeps the 200 empty payload.
          const upstreamError = etrade.getLastError?.();
          if (upstreamError) {
            return Response.json({ error: upstreamError, symbol }, { status: 502 });
          }
        }
        return Response.json({ count: dates.length, dates });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option expire dates" }, { status: 500 });
      }
    }

    // Persisted opportunity scan runs (issue #27): list -> diff -> by-id
    if (path.endsWith("/etrade/options/scans") && request.method === "GET") {
      return handleOptionsScansList(request, url, sessionId, sql, ctx);
    }

    if (path.endsWith("/etrade/options/scans/diff") && request.method === "GET") {
      return handleOptionsScansDiff(request, url, sessionId, sql);
    }

    const scanRunIdMatch = path.match(/\/etrade\/options\/scans\/([^/]+)$/);
    if (scanRunIdMatch && request.method === "GET") {
      return handleOptionsScanRunById(request, sessionId, sql, scanRunIdMatch);
    }

    // Issue #2180: discovery run report downloads (keys recorded on the
    // canonical row by the publish seam).
    if (path.endsWith("/discovery/report.pdf") && request.method === "GET") {
      return serveDiscoveryReport(request, ctx, "pdf");
    }
    if (path.endsWith("/discovery/report.xlsx") && request.method === "GET") {
      return serveDiscoveryReport(request, ctx, "xlsx");
    }
    if (path.endsWith("/discovery/report.csv") && request.method === "GET") {
      return serveDiscoveryReport(request, ctx, "csv");
    }

    // Persisted scheduled-discovery runs (issue #126, PR-E)
    if (path.endsWith("/etrade/options/discovery-runs") && request.method === "GET") {
      return handleOptionsDiscoveryRunsList(request, url, sessionId, sql, ctx);
    }

    const discoveryRunIdMatch = path.match(/\/etrade\/options\/discovery-runs\/([^/]+)$/);
    if (discoveryRunIdMatch && request.method === "GET") {
      return handleOptionsDiscoveryRunById(request, sessionId, sql, discoveryRunIdMatch, ctx);
    }

    // IV history (issue #15)
    if (path.endsWith("/etrade/options/iv-history") && request.method === "GET") {
      return handleOptionsIvHistory(url, ctx, sql);
    }

    // Saved strategy profiles (issue #28)
    if (path.endsWith("/etrade/options/profiles") && request.method === "GET") {
      return handleOptionsProfilesList(request, sessionId, sql);
    }

    if (path.endsWith("/etrade/options/profiles") && request.method === "POST") {
      return handleOptionsProfilesCreate(request, sessionId, sql);
    }

    const profileIdMatch = path.match(/\/etrade\/options\/profiles\/([^/]+)$/);
    if (profileIdMatch && request.method === "GET") {
      return handleOptionsProfileGet(request, sessionId, sql, profileIdMatch);
    }
    if (profileIdMatch && request.method === "PUT") {
      return handleOptionsProfileUpdate(request, sessionId, sql, profileIdMatch);
    }
    if (profileIdMatch && request.method === "DELETE") {
      return handleOptionsProfileDelete(request, sessionId, sql, profileIdMatch);
    }

    // ==========================================
    // Dynamic Options Screener Engine Endpoint
    // ==========================================
    if (path.endsWith("/trading/options/llm-ideas") && request.method === "POST") {
      const body = await request.json().catch(() => null) as { symbol?: unknown; question?: unknown; refresh?: unknown } | null;
      const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
      const question = typeof body?.question === "string" ? body.question.trim() : "";
      const forceRefresh = body?.refresh === true;
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
        return Response.json({ error: "Provide a valid stock ticker symbol." }, { status: 400 });
      }
      if (!question || question.length > 4000) {
        return Response.json({ error: "Provide a natural-language question up to 4,000 characters." }, { status: 400 });
      }

      const retrievedChains: ETradeOptionChain[] = [];
      const state: { retrievedExpirations: ETradeOptionExpireDate[]; usedSyntheticChains: boolean } = {
        retrievedExpirations: [],
        usedSyntheticChains: false,
      };
      const orm = ctx.getOrm();
      const cached = !forceRefresh ? orm.getOptionsChain(symbol) : null;

      try {
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(orm, ctx.env, userLogin, ctx.requestedEnv);
        return await executeLlmIdeasEvaluation({
          ctx, orm, etrade, userLogin, symbol, question, cached, retrievedChains, state,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : "Failed to retrieve complete E*TRADE option data.";
        const failedContractCount = retrievedChains.reduce(
          (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
          0,
        );
        const fallbackLlmInput = retrievedChains.length > 0 ? {
          id: "all",
          label: "All Expirations",
          symbol,
          question,
          expirations: state.retrievedExpirations,
          optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          systemPrompt: "Normalized options contract dataset",
          userPrompt: question,
          selection: {
            contractsAvailable: failedContractCount,
            contractsIncluded: failedContractCount,
            truncated: false,
          },
        } : undefined;
        return Response.json({
          error,
          mode: "llm_evaluation_of_quant_candidates",
          llm: { status: "error", model: ctx.env.AI_MODEL || DEFAULT_AI_MODEL, error },
          llmInput: fallbackLlmInput,
          retrievedData: {
            symbol,
            question,
            dataSource: state.usedSyntheticChains ? "synthetic option chains (TEST environment)" : "E*TRADE option chains",
            expirations: state.retrievedExpirations,
            optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          },
          dataCoverage: {
            expirationCount: state.retrievedExpirations.length,
            chainCount: retrievedChains.length,
            contractCount: failedContractCount,
            sentContractCount: 0,
            estimatedInputTokens: 0,
            inputTruncated: false,
          },
        }, { status: 502 });
      }
    }

    if (path.endsWith("/trading/options/compare") && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const validationError = validateStrategyRequest(body);
      if (validationError || !body) {
        return Response.json({ error: validationError || "Invalid strategy request." }, { status: 400 });
      }
      if (body.riskProfile !== undefined && !["conservative", "balanced", "aggressive"].includes(body.riskProfile)) {
        return Response.json({ error: "riskProfile must be conservative, balanced, or aggressive." }, { status: 400 });
      }

      try {
        const strategyRequest = body as StrategyRequest;
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        // Issue #3186 step 3e: the compare route runs through the one panel pipeline.
        const result = await runComparePanelViaPipeline({
          userLogin,
          strategyRequest,
          riskProfile: body.riskProfile,
          alternatives: body.alternatives,
          dataAgent: new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await etrade.getUniverseDeps?.(ctx.agentCtx?.storage))),
          storage: ctx.agentCtx?.storage as unknown as OptionsStageStorage | undefined,
          getSql: ctx.agentCtx?.storage?.sql ? () => ctx.agentCtx.storage.sql : undefined,
          queue: ctx.env.SCREENER_EVENTS ?? null,
        });
        const poolByType = new Map<string, { type: string; label: string; generated: number; bestScore: number }>();
        for (const c of result.strategies.candidates) {
          const e = poolByType.get(c.type) || { type: c.type, label: c.label, generated: 0, bestScore: 0 };
          e.generated += 1;
          e.bestScore = Math.max(e.bestScore, c.score);
          poolByType.set(c.type, e);
        }
        const common = {
          llmInput: describeLlmInput(strategyRequest, body.riskProfile || "balanced", result.snapshot.contracts, result.ranked.slice(0, 20).map((ranked) => ranked.candidate)),
          quantStrategyPool: [...poolByType.values()],
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
        };

        if (path.endsWith("/trading/options/compare")) {
          return rankOptionsCompareCandidates(ctx, strategyRequest, body, result, common);
        }

      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options candidate generation failed." }, { status: 500 });
      }
    }

    // Consolidation C5 (#1361): 3-way comparison outcomes
    if (path.endsWith("/trading/options/comparison/outcomes") && request.method === "GET") {
      const runId = url.searchParams.get("runId");
      if (!runId) {
        return Response.json({ error: "runId query parameter is required." }, { status: 400 });
      }
      try {
        const outcomes = listComparisonOutcomes(ctx.getOrm(), runId);
        return Response.json({ runId, outcomes });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to read comparison outcomes." }, { status: 500 });
      }
    }

    if (path.endsWith("/trading/options/comparison") && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        strategyFilter?: StrategyScreenFilter;
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const parsedDiscovery = parseOptionsDiscoveryRequest(body);
      if (!parsedDiscovery.ok) {
        return Response.json({ error: parsedDiscovery.error }, { status: 400 });
      }
      // Issue #2600: comparison is viewed-only (no-view refused).
      const noViewComparison = noViewComparisonError(parsedDiscovery.value.strategyMode);
      if (noViewComparison) {
        return Response.json({ error: noViewComparison }, { status: 400 });
      }
      try {
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await etrade.getUniverseDeps?.(ctx.agentCtx?.storage)));
        const banded = resolvePanelFetchBands(parsedDiscovery.value.request, parsedDiscovery.value.farDated);
        const s = await dataAgent.loadSnapshot(banded.request);
        // KernelSnapshot mapping replicated without calling discoverPanel
        const snapshot: KernelSnapshot = {
          symbol: s.symbol,
          contracts: s.contracts,
          dataSource: s.dataSource,
          chainProvenance: s.dataSource === "calibrated-demo" ? "calibrated" : "live",
          underlyingPrice: s.contracts[0]?.underlyingPrice,
          screen: s.screen,
          rejections: s.rejections,
          validationError: s.validationError,
          quotes: Object.fromEntries(
            s.contracts.map((c) => [c.symbol, {
              bid: c.bid, ask: c.ask,
              iv: c.impliedVolatility ?? null,
              volume: c.volume ?? null,
              openInterest: c.openInterest ?? null,
            }]),
          ),
        };
        if ((snapshot.contracts ?? []).length === 0) {
          return Response.json({
            status: "no_candidates",
            reason: "snapshot has no screened contracts",
            symbol: s.symbol,
            dataSource: s.dataSource,
            screen: s.screen,
            contractRejections: s.rejections,
            snapshotError: s.validationError,
          });
        }
        const riskAgent = new StrategyRiskAgent();
        const recommender = new RecommendationAgent();
        const req = parsedDiscovery.value.request;
        const question = `What ${req.thesis ?? "directional"} option strategies on ${req.symbol} look best for a ${req.targetDate ?? "near-term"} horizon with max planned loss ${req.maxPlannedLoss ?? "the stated limit"}?`;
        const { artifact, generationNotes } = await runProductionComparison({
          snapshot,
          request: req,
          question,
          riskProfile: parsedDiscovery.value.riskProfile ?? "balanced",
          strategyFilter: parsedDiscovery.value.strategyFilter,
          buildFn: (contracts, request) => riskAgent.buildStrategies(contracts, request as StrategyRequest),
          rankFn: (candidates, request, profile) => recommender.rank(candidates, request as unknown as StrategyRequest, profile),
          screenFn: (candidates, filter) => riskAgent.screenStrategies(candidates, filter),
          env: ctx.env,
          ledgerSql: ctx.getOrm(),
        });
        return Response.json({
          status: "compared",
          artifact,
          generationNotes,
          symbol: s.symbol,
          dataSource: s.dataSource,
          screen: s.screen,
          contractRejections: s.rejections,
          snapshotError: s.validationError,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options comparison failed." }, { status: 502 });
      }
    }

    if (path.endsWith("/trading/options/recommend") && request.method === "POST") {
      return handleOptionsStrategyRecommend(request, {
        orm: ctx.getOrm(),
        env: ctx.env,
        sessionKey: sessionId,
        requestedEnv: ctx.requestedEnv,
        // Issue #1661: DO blob handle for full capture on this leg.
        storage: ctx.agentCtx?.storage,
      });
    }

    // Unified Options Strategy Catalog (Single source of truth: 74 registered strategies & 114 aliases)
    // Issue #1334: emit BOTH name and label — the Scanner browser list
    // and StrategyLibraryModal render `label`, and the previous shape
    // carried only `name`, so every strategy name rendered blank.
    if (path.endsWith("/trading/options/catalog") && request.method === "GET") {
      const list = defaultRegistry.list().map((s) => ({
        id: s.id,
        name: s.label,
        label: s.label,
        category: s.category,
        description: s.description,
        aliases: s.aliases,
        theses: s.theses,
        usesStock: s.usesStock,
        multiExpiry: s.multiExpiry,
      }));
      return Response.json({
        success: true,
        count: list.length,
        total: list.length,
        strategies: list,
        aliases: REQUESTED_STRATEGY_NAMES,
        demoCalibratedChainsEnabled: isDemoCalibratedChainsEnabled(),
      });
    }

    // Strategy screener (capability 2) and best-trade picker (capability 3) over the options data agent (capability 1)
    // Issue #1334: the second /trading/options/catalog handler below
    // (ex-#275, label shape) was dead — the first matching if above
    // always returned first — and its existence masked the missing
    // `label` on the live shape. Removed; the live handler above now
    // emits both name and label.
    if ((path.endsWith("/trading/options/strategies") || path.endsWith("/trading/options/best-trade")) && request.method === "POST") {
      const isBestTrade = path.endsWith("/best-trade");
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        strategyFilter?: StrategyScreenFilter;
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      // Issue #2600: no-view bodies run in the sibling module (null = viewed).
      const noViewResponse = await runNoViewStrategies(ctx, request, body as Record<string, unknown> | null, path, isBestTrade);
      if (noViewResponse) return noViewResponse;
      // Issue #959: the discovery request validates through the ONE
      // shared schema (src/trading/screeningSchemas.ts) — the request
      // fields and the route envelope (strategyFilter / riskProfile /
      // alternatives) are checked together, and a mis-shape is a 400
      // naming the offending field.
      const parsedDiscovery = parseOptionsDiscoveryRequest(body);
      if (!parsedDiscovery.ok) {
        return Response.json({ error: parsedDiscovery.error }, { status: 400 });
      }
      try {
        const userLogin = request.headers.get("x-user-login");
        if (!userLogin) return unauthenticatedResponse();
        const blocked = await panelAuthResponse(ctx.env, userLogin, ctx.requestedEnv);
        if (blocked) return blocked;
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        // Consolidation C4 (#1329): Recommendation Kernel facade
        const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client, undefined, await etrade.getUniverseDeps?.(ctx.agentCtx?.storage)));
        const banded = resolvePanelFetchBands(parsedDiscovery.value.request, parsedDiscovery.value.farDated);
        const t0 = Date.now();
        // Issue #3186 step 3e: the manual panel route runs through the
        // one panel pipeline (manualPanelScreen.ts); the shaped artifact
        // is the discoverPanel result, so downstream reads it unchanged.
        const result = await runManualPanelViaPipeline({
          userLogin,
          strategyRequest: banded.request,
          strategyFilter: parsedDiscovery.value.strategyFilter,
          riskProfile: parsedDiscovery.value.riskProfile,
          alternatives: parsedDiscovery.value.alternatives,
          dataAgent,
          storage: ctx.agentCtx?.storage as unknown as OptionsStageStorage | undefined,
          getSql: ctx.agentCtx?.storage?.sql ? () => ctx.agentCtx.storage.sql : undefined,
          queue: ctx.env.SCREENER_EVENTS ?? null,
        });
        const discoverPanelDurationMs = Date.now() - t0;
        const common = {
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
          dataSource: result.snapshot.dataSource,
          snapshotError: result.snapshot.validationError,
        };
        const strategyReportInput = buildStrategyReportInput({
          action: isBestTrade ? "best-trade" : "strategies",
          request: banded.request as unknown as Record<string, any>,
          data: {
            ranked: result.ranked,
            bestTrade: result.bestTrade,
            screenedOut: result.screenedOut,
            symbol: result.snapshot.contracts?.[0]?.symbol,
          },
          symbol: result.snapshot.contracts?.[0]?.symbol,
          summary: `${result.ranked.length} ranked strateg${result.ranked.length === 1 ? "y" : "ies"} for ${parsedDiscovery.value.request.symbol}.`,
          generatedAt: new Date().toISOString(),
        });
        const t1 = Date.now();
        const strategyArtifacts = await ctx.getScreenerAgent(userLogin).generateAndStoreStrategyReport(strategyReportInput);
        const artifactLinks = strategyReportArtifactLinks(strategyArtifacts);
        // Slice 1: stamp tenant provider/broker into provenance (fail-open etrade/etrade).
        recordStrategyScreenRun(ctx.getOrm(), {
          ...strategyArtifacts,
          ...(await resolveTenantProviders(ctx.env)),
          userLogin,
          symbol: parsedDiscovery.value.request.symbol,
          trigger: "manual",
          mode: isBestTrade ? "best-trade" : "strategies",
          ranked: result.ranked,
          bestTrade: result.bestTrade,
          riskReports: result.riskReports,
          screenedOut: result.screenedOut,
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          dataSource: result.snapshot.dataSource,
          asyncJobId: ctx.asyncJobId,
          // Issue #2600: run record carries all four controls.
          ...strategyRecordControlFields({
            strategyMode: parsedDiscovery.value.strategyMode,
            riskProfile: parsedDiscovery.value.riskProfile,
            candidateLimit: parsedDiscovery.value.candidateLimit,
            farDated: parsedDiscovery.value.farDated,
            alternatives: parsedDiscovery.value.alternatives,
            request: parsedDiscovery.value.request as Record<string, any>,
            bands: banded.bands,
            horizonLimited: banded.horizonLimited,
          }),
          submittedVia: `ui — POST ${path} (options-strategy-panel)`,
          generationDurationMs: Date.now() - t1,
          discoverPanelDurationMs,
        });
        if (isBestTrade) {
          return Response.json({ bestTrade: result.bestTrade, evaluations: result.legacy?.evaluations, nameLedger: result.legacy?.nameLedger, ...common, ...artifactLinks });
        }
        return Response.json({
          status: result.ranked.length > 0 ? "ranked_candidates" : "no_candidates",
          ranked: result.ranked,
          riskReports: result.riskReports,
          screenedOut: result.screenedOut.slice(0, 50),
          excluded: result.legacy?.excluded,
          ...common,
          ...artifactLinks,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options strategy pipeline failed" }, { status: 400 });
      }
    }

    if (path.endsWith("/trading/options/screen") && (request.method === "POST" || request.method === "GET")) {
      let filter: any = {};
      const userLogin = request.headers.get("x-user-login");
      if (!userLogin) return unauthenticatedResponse();
      try {
        if (request.method === "POST") {
          filter = (await request.json().catch(() => ({}))) as any;
        } else {
          // Parse GET query params
          filter = {
            sector: url.searchParams.get("sector") || undefined,
            contractType: url.searchParams.get("contractType") || undefined,
            minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
            maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
            minGamma: url.searchParams.get("minGamma") ? Number(url.searchParams.get("minGamma")) : undefined,
            maxGamma: url.searchParams.get("maxGamma") ? Number(url.searchParams.get("maxGamma")) : undefined,
            minTheta: url.searchParams.get("minTheta") ? Number(url.searchParams.get("minTheta")) : undefined,
            maxTheta: url.searchParams.get("maxTheta") ? Number(url.searchParams.get("maxTheta")) : undefined,
            minImpliedVolatility: url.searchParams.get("minIv") ? Number(url.searchParams.get("minIv")) : undefined,
            maxImpliedVolatility: url.searchParams.get("maxIv") ? Number(url.searchParams.get("maxIv")) : undefined,
            minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
            minOpenInterest: url.searchParams.get("minOi") ? Number(url.searchParams.get("minOi")) : undefined,
            maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
            maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
            minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
            maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
            moneyness: url.searchParams.get("moneyness") || undefined,
            underlyingSymbols: url.searchParams.get("symbols") ? url.searchParams.get("symbols")!.split(",").map((s) => s.trim()) : undefined,
            maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }

        // Issue #959: the assembled filter (POST body or GET params)
        // validates through the ONE shared options-screen schema — a
        // mis-shaped filter is a 400 naming the field, and the engine
        // receives exactly the validated filter (its internal sanitizer
        // no longer silently drops unknown keys or enum values).
        const parsedScreen = parseOptionsScreenRequest(filter);
        if (!parsedScreen.ok) {
          return Response.json({ error: parsedScreen.error }, { status: 400 });
        }
        const screenFilter = parsedScreen.value.filter;
        const screenPushToSlack = parsedScreen.value.pushToSlack;
        const screenSlackChannel = parsedScreen.value.slackChannel;
        const screenUniverseLabel = parsedScreen.value.universe;
        const screenEmailTo = parsedScreen.value.emailTo;

        const broker = await resolveTenantBroker(ctx.env);
        const brokerPlatform = broker !== "etrade"
          ? TradingPlatformRegistry.getPlatform(broker, ctx.env, ctx.getOrm(), userLogin, ctx.requestedEnv)
          : null;
        const chainSource = brokerPlatform ? platformChainSource(brokerPlatform) : null;
        const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, ctx.requestedEnv);
        const universeDeps = await etrade.getUniverseDeps?.(ctx.agentCtx?.storage);
        const screener = new DynamicOptionsScreener(chainSource ?? etrade.client, undefined, universeDeps);
        return await executeOptionsScreen({ ctx, userLogin, screener, screenFilter, screenPushToSlack, screenSlackChannel, screenUniverseLabel, screenEmailTo, deferDelivery: Boolean(ctx.asyncJobId) });
      } catch (err) {
        const error = err instanceof Error ? err.message : "Options screening failed";
        if (!ctx.asyncJobId && (filter.pushToSlack === true || filter.pushToSlack === "true" || filter.pushToSlack === "1")) {
          if (ctx.scheduleScreenerFollowups) {
            // Issue #1123 S5a: the failure joins the tracked pipeline
            // (failed main-job record + failed notifications).
            await ctx.scheduleScreenerFollowups(
              screenerOutcomeFromRunResult("options", { success: false, error, thesis: filter.universe }, ctx.env.APP_BASE_URL),
              request.headers.get("x-user-login") as string,
            );
          } else {
            const sent = await deliverGatedSlack(ctx.env, {
              userLogin,
              channel: filter.slackChannel,
              text: `⚠️ Options Contract Screen FAILED — ${(filter.underlyingSymbols || []).join(", ") || filter.universe || "selected underlyings"}\nError: ${error}`,
            });
            if (!sent.ok) console.warn("[Orchestrator] Slack options contract failure notification failed:", sent.error);
          }
        }
        return Response.json({ error }, { status: 500 });
      }
    }

    // Issue #2603: regenerate a stored options run. Sibling of the unified
    // route: the request is rebuilt server-side from the stored record.
    if (path.endsWith("/trading/options/regenerate") && request.method === "POST") {
      return executeOptionsRegenerate({ request, sessionId, ctx });
    }

    // Omnichannel Unified Options Intelligence Endpoint
    if (path.endsWith("/trading/options/unified") && (request.method === "POST" || request.method === "GET")) {
      try {
        let reqData: any = {};
        if (request.method === "POST") {
          reqData = (await request.json().catch(() => ({}))) as any;
        } else {
          reqData = {
            action: url.searchParams.get("action") || "screen",
            symbol: url.searchParams.get("symbol") || undefined,
            symbols: url.searchParams.get("symbols") ? url.searchParams.get("symbols")!.split(",").map((s) => s.trim()) : undefined,
            thesis: url.searchParams.get("thesis") || undefined,
            targetPrice: url.searchParams.get("targetPrice") ? Number(url.searchParams.get("targetPrice")) : undefined,
            riskProfile: url.searchParams.get("riskProfile") || undefined,
            channel: url.searchParams.get("channel") || "ui",
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }

        // Issue #959: unified request validation
        const parsedUnified = parseUnifiedOptionsRequest(reqData);
        if (!parsedUnified.ok) {
          return Response.json({ error: parsedUnified.error }, { status: 400 });
        }
        reqData = {
          ...parsedUnified.value.request,
          ...(parsedUnified.value.pushToSlack !== undefined ? { pushToSlack: parsedUnified.value.pushToSlack } : {}),
          ...(parsedUnified.value.slackChannel !== undefined ? { slackChannel: parsedUnified.value.slackChannel } : {}),
        };

        return await executeUnifiedOptions({ request, sessionId, ctx, reqData });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Unified options query failed" }, { status: 500 });
      }
    }

    // Dynamic ETAPI Options Configuration & Tuning Endpoint
    if (path.endsWith("/trading/options/config") && (request.method === "POST" || request.method === "GET")) {
      try {
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (body.reset) {
            setRuntimeEtapiConfigOverrides(null);
          } else if (body.overrides) {
            setRuntimeEtapiConfigOverrides(body.overrides);
          }
          return Response.json({
            success: true,
            environment: ctx.requestedEnv,
            config: getEtapiConfig(ctx.env, ctx.requestedEnv),
            message: body.reset ? "Reset configuration to environment defaults" : "Runtime configuration overrides applied",
          });
        }
        return Response.json({
          success: true,
          environment: ctx.requestedEnv,
          config: getEtapiConfig(ctx.env, ctx.requestedEnv),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to access options configuration" }, { status: 500 });
      }
    }

    // Issue #653: strategy candidate review endpoints.
    if (path.endsWith("/options/strategy-reviews") && request.method === "GET") {
      return handleOptionsStrategyReviewsList(url, ctx);
    }
    if (path.endsWith("/options/strategy-reviews/decide") && request.method === "POST") {
      return handleOptionsStrategyReviewsDecide(request, ctx);
    }

  return null;
}
