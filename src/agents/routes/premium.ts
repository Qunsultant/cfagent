/**
 * Issue #359-08: premium paid-trading routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move - no behavior change.
 *
 * Owns the Paid Trading Service blocks:
 * /premium/options-scan (Institutional Options & Greeks Screener, $0.05 USDC),
 * /premium/market-research (Autonomous Equity Research Report, $0.10 USDC),
 * /premium/stock-signals (Real-Time Quantitative Anomaly Signals, $0.02 USDC).
 * Each is a payment-gated endpoint (ETradeAgenticPaymentService.handleGatedEndpoint)
 * matching `path.includes("/premium/...")` for GET and POST.
 * The three blocks were contiguous in routeRequest (between the Cloudflare
 * Agentic Payments block and the Environment & E*TRADE Trading APIs block),
 * so this module exports ONE handler invoked from routeRequest at the EXACT
 * position the original blocks occupied in the sequential matching sequence.
 * It returns a Response when one of its paths matches, or null when none
 * does - matching order relative to all other handlers is preserved by the
 * call site.
 *
 * Canonical-copy reporting (#307/#308) is preserved exactly: the options
 * scan stores source "options_scanner", the market research report stores
 * source "research_report" (generation id = sha256 of the report JSON),
 * both inside try/catch so persistence failure cannot break the endpoint.
 *
 * Payment-path labeling (#2406, Phase 1.1): these three endpoints are
 * the INBOUND x402 path — an on-chain USDC transfer verified per
 * payment by the gate (base-sepolia default: testnet funds, no real
 * money). They are NOT the simulated local-ledger path: the agent
 * wallet's simulated proofs are rejected by verifyPayment (#122) and
 * are labeled simulated wherever a price is shown (see
 * src/services/x402PaymentPath.ts). The 402 body carries the path
 * label in `paymentPath`; prices are pinned ($0.05 / $0.10 / $0.02)
 * and stand unless the owner changes them.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * PremiumRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import {
  ETradeAgenticPaymentService,
  TRADING_PAID_SERVICES,
  payerScopeId,
} from "../../services/agenticPayments";
import { MarketDataResearchService } from "../../services/marketDataResearch";
import { UnifiedOptionsService } from "../../trading";
import { buildDataProviderPorts } from "../../data/buildDataProviderPorts";
import { parseOptionsScreenRequest } from "../../trading";
import type { CaptureBlobStorage } from "../../trading";
import { getCuratedStockBySymbol } from "../../config/curatedStockUniverse";
import type { NasdaqStockListing } from "../../services/nasdaqListings";
import { sha256Hex } from "../../services/scheduledReports";
import {
  manualWorkflowJobId,
  tryStartScreenerWorkflow,
  workflowTenantId,
} from "../../workflows/screenerWorkflowRoutes";
import { runStockScreenViaEngine } from "../../workflows/runStockScreenViaEngine";
import type { Env } from "../../types";
import type { DatabaseORM, SqlStorage } from "../../orm";
import type { ScreenerAgent } from "../screener-agent";
import {
  resolvePaymentsSwitchByKey,
  type PaymentsModeValues,
  type PaymentsScopedModes,
  type PaymentsSurfaceMode,
} from "../../config/agenticPaymentsModes";
import { createCanonicalReportStorePorts } from "../../data/createCanonicalReportStorePorts";
import { createCommercialAdapter } from "../../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../../data/createSubscriptionPorts";
import type { StoreTier } from "../../data/commercialPorts";
import { resolveEffectiveTier } from "../../data/subscriptionPorts";
import type { MeteredGateOptions } from "../../services/meteredPaymentGate";
import { screenAlreadyRunningDetails } from "../../services/screenInFlight";
import { quotaExceededDetails } from "../../security/userRequestQuota";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/premium",
});

/** The subset of OrchestratorAgent surface the premium handlers need. */
export interface PremiumRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Screener agent (owner: OrchestratorAgent.getScreenerAgent) — issue #1007: premium stock-signals execute through the one stock pipeline via this agent, with the Yahoo data-source adapter as provider. */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /**
   * Issue #4278: the one engine seam (runStockScreenViaEngine)
   * this route's sync stock-signals screen runs through.
   * Optional: absent in production construction, the route
   * calls the real seam; tests inject a fake. The field exists
   * only so a test can substitute the seam — it never selects
   * a different engine.
   */
  runStockScreenViaEngine?: import("../../workflows/runStockScreenViaEngine").RunStockScreenViaEngine;
  /** Canonical-copy screener persistence (owner: OrchestratorAgent.persistScreenerReportCanonical) — the REST idiom. */
  persistScreenerReportCanonical(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    provider?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    pdfKey?: string;
    error?: string;
    trigger?: unknown;
    userLogin?: string;
  }): Promise<void>;
  /** Durable Object SQL storage (owner: OrchestratorAgent — was
   *  `this.ctx.storage.sql`). Issue #1206 (E5b): together with
   *  blobStorage, supplies the data-provider platform deps for the
   *  options scan. Optional: a host that owns no storage (unit
   *  contexts) omits both handles and the scan constructs its
   *  service exactly as before — no deps, nothing captured. */
  sql?: SqlStorage;
  /** Durable Object storage (owner: OrchestratorAgent — was
   *  `this.ctx.storage`): the capture blob seam's storage half. */
  blobStorage?: CaptureBlobStorage;
  /**
   * #1728: optional session/user carriers for the premium switches
   * (run comes from the per-request `?mode=` query param — the POST
   * body is NOT read before the payment gate, so there is no body
   * mode on these routes — global env from `env`). Populated by the
   * execution-context owner; unset carriers fall through to env. See
   * src/config/agenticPaymentsModes.ts.
   */
  scopedPaymentsModes?: PaymentsScopedModes;
}

/**
 * #1728: resolves one premium switch for a route in run > session >
 * user > env > builtin order. An invalid winning value fails closed
 * to the route legacy and is LOGGED ONLY: PremiumRouteContext has no
 * audit writer (the quoteModes precedent for unaudited surfaces) —
 * the misconfiguration is visible in Workers Logs, not the audit
 * ledger. The gate, price, identity, channel, and capture behavior
 * are identical in both modes regardless.
 */
function resolvePremiumRouteMode(
  ctx: PremiumRouteContext,
  key: keyof PaymentsModeValues,
  run: unknown,
  legacy: PaymentsSurfaceMode
): PaymentsSurfaceMode {
  const envRecord = ctx.env as unknown as Record<string, unknown> | undefined;
  const { resolved, switchName } = resolvePaymentsSwitchByKey(
    ctx.scopedPaymentsModes,
    key,
    run,
    envRecord?.[PREMIUM_ROUTE_SWITCH_NAMES[key]],
    legacy
  );
  if (resolved.invalid) {
    structuredLog.error("premium.payments_mode_config_invalid", {
      message: `[payments] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`,
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/** Env var name per switch key (for the env level lookup above). */
const PREMIUM_ROUTE_SWITCH_NAMES: Record<keyof PaymentsModeValues, string> = {
  create: "PAYMENTS_CREATE_MODE",
  confirm: "PAYMENTS_CONFIRM_MODE",
  transactions: "PAYMENTS_TRANSACTIONS_MODE",
  wallet: "AGENTIC_WALLET_MODE",
  screener: "PREMIUM_SCREENER_MODE",
  research: "PREMIUM_RESEARCH_MODE",
};

/**
 * Issue #1206 (E5b): the OrchestratorAgent surface the factory below
 * binds. env / getOrm / getScreenerAgent /
 * persistScreenerReportCanonical are picked from PremiumRouteContext
 * itself (the shapes are identical by construction); the only extra
 * member is the agent context whose storage supplies the platform
 * handles.
 */
type PremiumRouteHost = Pick<
  PremiumRouteContext,
  "env" | "getOrm" | "getScreenerAgent" | "persistScreenerReportCanonical"
> & {
  ctx: { storage: DurableObjectStorage };
};

/**
 * Issue #1206 (E5b): build the premium route context from the
 * orchestrator host. The context used to be an inline literal in
 * routeRequest; it lives here now (the #992 extraction pattern, cf.
 * makeRunScheduleCallback in routes/schedules.ts) so the storage
 * handles the platform wiring needs could be added without growing
 * orchestrator.ts past its size budget. The host arrives as unknown
 * for the same reason makeRunScheduleCallback's does: the agent's
 * ctx/env are protected DurableObject members, so no public
 * structural type can name them; the cast below is the binding
 * contract. Method calls go through the host object, so `this`
 * stays bound to the agent.
 */
export function makePremiumRouteContext(host: unknown): PremiumRouteContext {
  const h = host as PremiumRouteHost;
  return {
    env: h.env,
    sql: h.ctx.storage.sql,
    blobStorage: h.ctx.storage,
    getOrm: () => h.getOrm(),
    getScreenerAgent: (userLogin?: string) => h.getScreenerAgent(userLogin),
    persistScreenerReportCanonical: (result) => h.persistScreenerReportCanonical(result),
  };
}

/**
 * Issue #183: build the payment service for a premium request. The
 * worker (src/server.ts) sets the x-user-login header ONLY from the
 * caller's verified session and strips it for anonymous traffic, which
 * is served by the shared premium-gateway instance. So: header present
 * → session traffic, per-user behaviour unchanged; header absent →
 * anonymous traffic, and the service runs payer-bound so every
 * persisted payment row/event is scoped by the VERIFIED payer
 * (services/agenticPayments.ts payerScopeId), never by an asserted
 * login and never pooled under the gateway instance's identity.
 */
function premiumPaymentService(
  ctx: PremiumRouteContext,
  sessionId: string,
  request: Request
): ETradeAgenticPaymentService {
  const payerBound = !request.headers.get("x-user-login");
  return new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId, undefined, { payerBound });
}

/**
 * Issue #2408 (Phase 1.2): build the metered-gate options for one
 * premium request. The meter is the usage port over the premium
 * host's already-bound agent DO sql (the same seam
 * researchPublish meters through) — no new store, no SessionStore
 * involvement. Without ctx.sql there is no meter, and the gate
 * refuses served calls (fail-closed); the production host always
 * supplies sql via makePremiumRouteContext. The tier resolver is
 * wired ONLY for session traffic (x-user-login present, set by
 * the worker from the verified session): it reads the stored
 * commercial tier + subscription overlay through the existing
 * adapters (two indexed D1 point reads; unbound AGENT_DB →
 * null → Free default, no reads). Anonymous payer-bound traffic
 * wires no resolver: no login exists to resolve, so the tier
 * defaults to Free with zero store reads, and the verified
 * payment remains the entitlement evidence.
 */
export function premiumMeteredGateOptions(
  ctx: PremiumRouteContext,
  request: Request,
  category: string
): MeteredGateOptions {
  // The scheduledReports.storePorts precedent: the composition
  // root takes the host's sql handle; the cast matches that seam.
  const meter = ctx.sql ? createCanonicalReportStorePorts(ctx.sql as never).usage : undefined;
  const login = request.headers.get("x-user-login");
  return {
    meter,
    category,
    ...(login ? { resolveTier: (userLogin: string) => resolvePremiumTier(ctx.env, userLogin) } : {}),
  };
}

/**
 * Issue #2408: the premium gate's tier resolution, reusing the
 * ONE existing rule (resolveEffectiveTier) and the existing
 * commercial/subscription adapters. Unbound store → null (the
 * gate defaults to Free); a present-but-failing store throws
 * and the gate refuses (money-path fail direction).
 */
async function resolvePremiumTier(env: Env, userLogin: string): Promise<StoreTier | null> {
  const store = createCommercialAdapter(env as { AGENT_DB?: unknown });
  const subs = createSubscriptionAdapter(env as { AGENT_DB?: unknown });
  if (!store || !subs) return null;
  const record = await store.getAccount(userLogin);
  const subscriptions = await subs.listSubscriptions(userLogin);
  return resolveEffectiveTier(record, subscriptions, Date.now());
}

/**
 * Handles the premium paid-trading routes. Returns a Response on match,
 * null when no premium path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handlePremiumRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PremiumRouteContext
): Promise<Response | null> {
  // Paid Trading Service: Institutional Options & Greeks Screener ($0.05 USDC)
  if (path.includes("/premium/options-scan") && (request.method === "GET" || request.method === "POST")) {
    const paymentService = premiumPaymentService(ctx, sessionId, request);
    const tier = TRADING_PAID_SERVICES.OPTIONS_SCREENER;
    // #1728: the screener switch governs the RESPONSE ENVELOPE only
    // (mode "mcp" → the MCP flat envelope; mode "rest" (legacy) →
    // the REST envelope below). The gate, price, engine, channel,
    // identity, and canonical capture are identical in both modes.
    // Run level is the `?mode=` query param: the POST body is owned
    // by the fulfillment below and is never read before the gate.
    const screenerMode = resolvePremiumRouteMode(ctx, "screener", url.searchParams.get("mode"), "rest");

    return paymentService.handleGatedEndpoint(
      request,
      tier.resource,
      tier.priceUSD,
      tier.description,
      async (receipt) => {
        let filter: any = {};
        if (request.method === "POST") {
          filter = (await request.json().catch(() => ({}))) as any;
        } else {
          filter = {
            underlyingSymbols: url.searchParams.get("symbol") ? [url.searchParams.get("symbol")!.toUpperCase().trim()] : undefined,
            maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
            contractType: url.searchParams.get("contractType") || "BOTH",
            minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
            maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
            minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
            minOpenInterest: url.searchParams.get("minOpenInterest") ? Number(url.searchParams.get("minOpenInterest")) : undefined,
            maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
            maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
            minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
            maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }
        // Issue #959: the paid scan takes the same OptionScreenerFilter
        // shape as every other options screen — validate through the
        // ONE shared schema; a mis-shaped filter fails explicitly with
        // the field named (in the endpoint's usual failure shape).
        const parsedPremiumFilter = parseOptionsScreenRequest(filter);
        if (!parsedPremiumFilter.ok) {
          return { success: false, service: tier.name, receipt, error: parsedPremiumFilter.error };
        }
        filter = parsedPremiumFilter.value.filter;
        // Issue #183: the fulfillment identity is the session login
        // (x-user-login, set by the worker from the verified session)
        // for signed-in traffic. For anonymous gateway traffic there is
        // deliberately NO x-user-login — the identity is the VERIFIED
        // payer scope from the payment receipt. That scope is not an app
        // login and holds no stored E*TRADE tokens, so broker access
        // fails honestly ("OAuth Token Missing") instead of running
        // under a caller-asserted login. The previous fallbacks
        // (sessionId, then a shared "premium_subscriber") are gone.
        const userLogin = request.headers.get("x-user-login") || payerScopeId(receipt.payer);
        const rawEnvHdr = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
        const reqEnvLocal = (rawEnvHdr === "TEST" || rawEnvHdr === "PROD") ? rawEnvHdr : undefined;
        // Issue #982 (screening consolidation S2): the paid scan
        // executes through UnifiedOptionsService — the same service
        // the REST routes call — instead of a route-local engine. The
        // service's screen data IS the screen result this body has
        // always carried; the caller's filter rides through with its
        // symbols/limit lifted onto the request so the effective
        // filter is unchanged. Payment gating above and the canonical
        // persistence below are untouched.
        // Issue #1206 (E5b): with the host's storage handles on the
        // context, the paid scan executes ON the data-provider
        // platform — platform deps in the same shape the REST host
        // passes (etradeOptionsScreen.ts) — and presents callerTier
        // "premium": this endpoint's x402 verification (above) IS
        // the entitlement evidence, so an operator-tiered premium
        // optionsChains route serves this path while refusing
        // freemium surfaces, and premium scans are captured and
        // run-linked like every other routed scan. The service
        // bootstraps the platform itself when deps are supplied, as
        // on the REST path. Without handles the service is
        // constructed exactly as before (no deps, nothing captured).
        const platformDeps = ctx.sql && ctx.blobStorage
          ? { sql: ctx.sql, blobStorage: ctx.blobStorage, env: ctx.env }
          : undefined;
        // #2303: the platform ports for the service's platform
        // block (built from env; nulls when AGENT_DB is unbound).
        const dpPorts = platformDeps
          ? await buildDataProviderPorts(ctx.env)
          : undefined;
        const service = new UnifiedOptionsService(ctx.env, userLogin, reqEnvLocal, ctx.getOrm(), undefined, undefined, undefined, platformDeps, "premium", dpPorts);
        const serviceResponse = await service.execute({
          action: "screen",
          channel: "webhook",
          filter,
          symbols: filter.underlyingSymbols,
          limit: filter.limit,
        });
        const result = serviceResponse.data;
        const failed = result.status === "error";
        // Issue #307/#308: store the canonical options-scan report copy
        // (one row per generation) so scans are searchable via AI Search.
        try {
          const timestamp = new Date().toISOString();
          const symbols = Array.isArray(filter?.underlyingSymbols)
            ? filter.underlyingSymbols.join(",")
            : "";
          ctx.getOrm().storeCanonicalReport({
            runId: `options_scanner:${timestamp}`,
            generationId: `options_scanner:${timestamp}`,
            title: `Options scan — ${symbols || "universe"} (${filter?.contractType || "BOTH"})`,
            source: "options_scanner",
            summary: failed
              ? `Options scan failed: ${result.validationError || result.fetchErrors?.[0]?.reason || "upstream error"}.`
              : `Options scan completed for ${symbols || "the default universe"} (thesis: ${filter?.contractType || "BOTH"}).`,
            body: { filter, result, failed },
            createdAt: timestamp,
            userLogin,
          },
          // Issue #1169 S4-1: thread ctx.env so the seam indexes this
          // options_scanner row at write time.
          ctx.env);
        } catch {
          // Non-critical: persistence failure must not break the scan.
        }
        // #1728: mode "mcp" returns the MCP paid_options_screener
        // envelope verbatim (same fields, same error fallback) over
        // the same screen result; canonical persistence above still
        // ran — it is a route duty (#307/#308), not part of the
        // response contract, and is unchanged in both modes.
        if (screenerMode === "mcp") {
          return {
            status: 200,
            paid: true,
            receipt,
            matchesCount: result.matchedCount,
            totalMatches: result.totalMatches,
            screenStatus: result.status,
            rejectionCount: result.rejectionCount,
            ...(failed
              ? {
                  error:
                    result.validationError ||
                    result.fetchErrors?.[0]?.reason ||
                    "Options screen failed upstream; no data could be fetched.",
                }
              : {}),
            ...(result.fetchErrors && result.fetchErrors.length > 0 ? { fetchErrors: result.fetchErrors } : {}),
            ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
            quoteQuality: result.quoteQuality,
            contracts: result.contracts,
            timestamp: new Date().toISOString(),
          };
        }
        return {
          success: !failed,
          service: tier.name,
          receipt,
          screenResult: result,
          ...(failed
            ? {
                error:
                  result.validationError ||
                  result.fetchErrors?.[0]?.reason ||
                  "Options screen failed upstream; no data could be fetched.",
              }
            : {}),
        };
      },
      premiumMeteredGateOptions(ctx, request, tier.id)
    );
  }

  // Paid Trading Service: Autonomous Equity Research Report ($0.10 USDC)
  if (path.includes("/premium/market-research") && (request.method === "GET" || request.method === "POST")) {
    const paymentService = premiumPaymentService(ctx, sessionId, request);
    const tier = TRADING_PAID_SERVICES.MARKET_RESEARCH;
    // #1728: the research switch governs the RESPONSE ENVELOPE only
    // (same boundaries and `?mode=` run level as the screener
    // switch above).
    const researchMode = resolvePremiumRouteMode(ctx, "research", url.searchParams.get("mode"), "rest");

    return paymentService.handleGatedEndpoint(
      request,
      tier.resource,
      tier.priceUSD,
      tier.description,
      async (receipt) => {
        // Multi-tenant owner for the canonical research row (#183 identity
        // rule, same as the paid options scan above).
        const userLogin = request.headers.get("x-user-login") || payerScopeId(receipt.payer);
        let symbol = "NVDA";
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (body.symbol) symbol = String(body.symbol).toUpperCase().trim();
        } else {
          const sym = url.searchParams.get("symbol");
          if (sym) symbol = sym.toUpperCase().trim();
        }

        const marketDataResearch = new MarketDataResearchService(ctx.env);
        const report = await marketDataResearch.generateResearchReport(symbol);
        // Issue #308: store the canonical copy at generation time (one
        // row per content hash) so the report is searchable via AI Search.
        try {
          const timestamp = new Date().toISOString();
          const reportJson = JSON.stringify(report ?? {});
          const generationId = await sha256Hex(reportJson);
          ctx.getOrm().storeCanonicalReport({
            runId: generationId,
            generationId,
            title: `Market research — ${symbol}`,
            source: "research_report",
            summary: `Equity research report for ${symbol}.`,
            body: report ?? {},
            createdAt: timestamp,
            userLogin,
          },
          // Issue #1169 S4-1: thread ctx.env so the seam indexes this
          // research_report row at write time.
          ctx.env);
        } catch {
          // Non-critical: persistence failure must not break the report.
        }
        // #1728: mode "mcp" returns the MCP paid_market_research
        // envelope verbatim; canonical persistence above still ran
        // (route duty, unchanged in both modes).
        if (researchMode === "mcp") {
          return {
            status: 200,
            paid: true,
            receipt,
            report,
          };
        }
        return {
          success: true,
          service: tier.name,
          receipt,
          report,
        };
      },
      premiumMeteredGateOptions(ctx, request, tier.id)
    );
  }

  // Paid Trading Service: Real-Time Quantitative Anomaly Signals ($0.02 USDC)
  // #2373 Slice B (verification): paid via the x402/MPP gate below in ALL
  // flag states — the gate reads no flag. Seam-unification onto
  // paidScreenSubmission is an open owner decision: the seam needs a verified
  // login + account row, but anonymous traffic here has only a verified payer
  // scope (see premiumPaymentService, #183).
  if (path.includes("/premium/stock-signals") && (request.method === "GET" || request.method === "POST")) {
    const paymentService = premiumPaymentService(ctx, sessionId, request);
    const tier = TRADING_PAID_SERVICES.STOCK_SIGNALS;

    return paymentService.handleGatedEndpoint(
      request,
      tier.resource,
      tier.priceUSD,
      tier.description,
      async (receipt) => {
        let symbols = ["NVDA", "AAPL", "MSFT", "TSLA"];
        // Issue #1737: the async flag rides the POST body or the GET query.
        let asyncRequested = false;
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (Array.isArray(body.symbols) && body.symbols.length > 0) symbols = body.symbols;
          asyncRequested = body.async === true;
        } else {
          const sym = url.searchParams.get("symbols") || url.searchParams.get("symbol");
          if (sym) symbols = sym.split(",").map(s => s.trim().toUpperCase());
          asyncRequested = url.searchParams.get("async") === "1";
        }
        symbols = symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);

        // Issue #1007 (consolidation S3): the paid signals execute
        // through the ONE stock pipeline — ScreenerAgent with the
        // Yahoo data-source adapter as provider — instead of the
        // retired second Market-data engine. The requested symbols
        // are the run's explicit universe (membership only; prices come
        // from live Yahoo quotes via the adapter). The run stores a
        // canonical report in the REST idiom, like every other stock
        // screen. Identity follows the #183 rule used by the options
        // scan above: session login when present, else the verified
        // payer scope.
        const userLogin = request.headers.get("x-user-login") || payerScopeId(receipt.payer);
        const listings: NasdaqStockListing[] = symbols.map((symbol) => {
          const curated = getCuratedStockBySymbol(symbol);
          return {
            symbol,
            companyName: curated?.companyName || symbol,
            exchange: curated?.exchange || "nasdaq",
            change: 0,
            changePercent: 0,
            sector: curated?.sector,
          };
        });
        const agent = ctx.getScreenerAgent(userLogin);
        // Issue #1737: async path. The fulfillment IS the handle:
        // the payer polls job/report paths (jobs/history +
        // canonical reports) for the result. Store only, no
        // deliver step (this route has none). Unbound → fall
        // through to the synchronous fulfillment below.
        if (asyncRequested) {
          const jobId = manualWorkflowJobId("symbols");
          const handle = await tryStartScreenerWorkflow(ctx.env, {
            jobId,
            type: "run-screen",
            source: "manual",
            trigger: "manual",
            userLogin,
            role: "parent",
            tenantId: workflowTenantId(ctx.env),
            shards: [{ shardId: "symbols", symbols: listings }],
            provider: "yahoo",
            deliver: false,
            maxItems: listings.length,
            maxSymbols: listings.length,
          });
          if (handle) {
            return {
              success: true,
              service: tier.name,
              receipt,
              async: true,
              jobId: handle.jobId,
              workflowId: handle.workflowId,
              statusUrl: handle.statusUrl,
            };
          }
        }
        // Issue #4278: the sync fulfillment runs through the one
        // engine seam (was agent.runScreen). The spec is the paid
        // fulfillment's own provider, store-only (deliver
        // false, as the async path's literal), explicit-symbols
        // universe. The command overrides carry the async path's
        // literal shape verbatim — symbols shard, caps, job id —
        // so the sync and async fulfillments run the same command.
        const spec = {
          source: "premium" as const,
          trigger: "manual" as const,
          deliver: false,
          provider: "yahoo" as const,
          filters: {},
          universe: "symbols",
          jobId: manualWorkflowJobId("symbols"),
          asyncRequested: false,
          delivery: {},
          userLogin,
        };
        let result;
        try {
          const outcome = await (ctx.runStockScreenViaEngine ?? runStockScreenViaEngine)({
            env: ctx.env,
            spec,
            userLogin,
            agent,
            commandOverrides: {
              jobId: manualWorkflowJobId("symbols"),
              shards: [{ shardId: "symbols", symbols: listings }],
              maxItems: listings.length,
              maxSymbols: listings.length,
            },
          });
          result = outcome.results[0];
        } catch (screenErr) {
          const error = screenErr instanceof Error ? screenErr.message : String(screenErr);
          if (error.includes("already running")) {
            // #2840: name the in-flight run (id + status) for the
            // second submitter; the retryable shape is unchanged.
            const details = screenAlreadyRunningDetails(screenErr);
            return { success: false, service: tier.name, receipt, error: "Screen already running; retry shortly.", retryable: true, runId: details?.runId ?? null, status: details?.status ?? "running" };
          }
          // Issue #2842: quota refusal carries limit/usage/reset;
          // a counter failure fails closed (never an uncounted run).
          if (error.includes("quota exceeded")) {
            const details = quotaExceededDetails(screenErr);
            return { success: false, service: tier.name, receipt, error: "Request quota exceeded.", retryable: true, limit: details?.limit ?? null, usage: details?.usage ?? null, window: details?.window ?? null, resetAt: details?.resetAtIso ?? null, resetAtMs: details?.resetAtMs ?? null };
          }
          if (error.includes("quota unavailable")) {
            return { success: false, service: tier.name, receipt, error: "Request quota unavailable.", retryable: true };
          }
          throw screenErr;
        }
        // Issue #4278: a SUCCESS result was already stored by the
        // workflow's own store step — persisting it here would twin
        // the row. A FAILED result never reached that step, so it
        // keeps the canonical-copy persist, then answers the honest
        // failure below.
        if (!result.success) {
          await ctx.persistScreenerReportCanonical({ ...result, userLogin });
        }
        if (!result.success) {
          // Honest failure (the options-scan idiom above): Yahoo
          // unavailable fails the fulfillment visibly — no signals are
          // fabricated from another provider or from static data.
          return {
            success: false,
            service: tier.name,
            receipt,
            error: result.error || "Yahoo Finance unavailable; no stock signals could be produced.",
          };
        }
        // Signals are the pipeline's screened rows for the requested
        // symbols (allStocks rows that survived screening; with the
        // empty filter here that is every quoted symbol).
        // `confidence` is pipeline-derived — the screening indicator
        // composite (indicators.screenScore, 0–100) normalized to
        // 0–1. The hard-coded constant this replaces is gone.
        // NOTE (response-shape change, disclosed): the old engine's
        // per-signal `volume` field is not carried on the pipeline's
        // scanned-stock shape, so it is dropped rather than fabricated.
        const signals = result.allStocks
          .filter((stock) => stock.signal !== "unknown")
          .map((stock) => ({
            symbol: stock.symbol,
            price: stock.lastPrice,
            changePercent: stock.changePercent,
            rsi: stock.rsi14 ?? undefined,
            signalType: (stock.rsi14 != null && stock.rsi14 < 35) ? "OVERSOLD_BOUNCE" : (stock.rsi14 != null && stock.rsi14 > 70) ? "OVERBOUGHT_MOMENTUM" : "TREND_CONTINUATION",
            confidence: Number((stock.indicators.screenScore / 100).toFixed(2)),
            timestamp: result.timestamp,
          }));

        return {
          success: true,
          service: tier.name,
          receipt,
          count: signals.length,
          signals,
        };
      },
      premiumMeteredGateOptions(ctx, request, tier.id)
    );
  }

  return null;
}
