/**
 * Pluggable Trading Capability Microservice
 *
 * Implements:
 * - Strategy + Abstract Factory + Registry patterns for broker platforms.
 * - Dynamic Market Screener.
 * - Trading Micro-Agent with HITL safety and W3C DID stamping.
 *
 * BOUNDARY (issue #290): this module is the SOLE public import surface of
 * src/trading/. Every module outside src/trading/ must import trading
 * capabilities only through this index. Importing a deeper trading path
 * (e.g. "../trading/options/scanRunStore") from outside src/trading/ is a
 * defect — enforced by tests/trading-boundary.test.ts.
 */

import { TradingPlatformRegistry } from "./registry";
import { ETradeTradingPlatform } from "./etrade/platform";
import { AlpacaTradingPlatform } from "./alpaca/platform";
import { PublicTradingPlatform } from "./public/platform";
import { assertBrokerCatalogComplete } from "./brokerCatalog";

// Register default pluggable platforms (unchanged)
TradingPlatformRegistry.register("etrade", (env, orm, userLogin, overrideEnv, storage) => new ETradeTradingPlatform(env, orm, userLogin, overrideEnv, undefined, storage));
// Issue #3272: the selection must reach the adapter, or `paper` can never be
// chosen for Alpaca and the hub switch stays E*TRADE-only.
TradingPlatformRegistry.register(
  "alpaca",
  (env, orm, userLogin, overrideEnv) => new AlpacaTradingPlatform(env, orm, userLogin, overrideEnv),
);
// Issue #3990: Public as a live broker — the platform is constructed
// from the same factory signature; its environment resolves TEST
// (preview-only, no paper mode) or PROD (live) from overrideEnv.
TradingPlatformRegistry.register(
  "public",
  (env, orm, userLogin, overrideEnv) => new PublicTradingPlatform(env, orm, userLogin, overrideEnv),
);
TradingPlatformRegistry.register("sandbox", (env, orm, userLogin, overrideEnv, storage) => new ETradeTradingPlatform(env, orm, userLogin, overrideEnv, undefined, storage));

// Issue #3232 (program #3216): every registered platform id must be a broker
// in the catalog, or a declared legacy alias ("sandbox" → etrade/TEST).
// Registering a broker without a catalog entry fails HERE, at import time,
// instead of surfacing later as an unlabeled or mis-vocabulated platform.
assertBrokerCatalogComplete(TradingPlatformRegistry.getRegisteredPlatforms() as string[]);

// --- boundary surface (pre-existing) ---
export * from "./interfaces";
export * from "./registry";
// Issue #3812: percent bracket exits — the one deterministic conversion
// from "+4% / -2%" to absolute leg prices (public trading surface).
export * from "./bracketPercent";
// Issue #3888: the externalized trading limits every engine, the limits
// route, the trading_limits tool and the copilot's answers resolve.
export * from "./limits";
// Issue #3883/#3886: the neutral cancel vocabulary — order classes, status
// classification and the mapping from a broker row onto a cancel target.
export * from "./cancelFilters";
// Issue #3887: the base-breakout continuation ladder — detection, plan and
// the state machine that places rung N+1 only after a continuation step.
export * from "./baseBreakout";
// Issue #3892: the declarative advanced/complex order-type registry, the named
// option-strategy builders and the collateral/protective-exit validators.
export * from "./advancedOrders";
// Issue #3232: the broker catalog is part of the public trading surface.
export * from "./brokerCatalog";
export * from "./brokerPanels";
// Issue #3417: what a broker is CALLED, beside what it can do. The worker and
// the client both read it, so no surface has to invent a name.
export * from "./brokerPresentation";
export * from "./optionChainSource";
export * from "./stockQuoteSource";
export * from "./neutralMarketScreener";
export * from "./portfolioRiskSource";
export * from "./screeningProvider";
export * from "./dataProviders";
export * from "./screener";
export * from "./agent";
export * from "./etrade/client";
export * from "./etrade/platform";
export * from "./alpaca/platform";
export * from "./public/platform";
export * from "./alpaca/fillLots";
export * from "./alpaca/occSymbol";
// Issue #3351: the sign-in surface. Exported through the boundary so route
// handlers never import a trading-internal path (issue #290).
export * from "./alpaca/credentials";
export * from "./alpaca/credentialStore";
export * from "./alpaca/credentialResolution";
export * from "./alpaca/signIn";
export * from "./optionsScreener";

// --- boundary surface (#290): every capability external code used via deep paths ---
// Issue #1317: the deleted Yahoo data-source module's helpers moved
// into screenerPipeline.ts. Issue #1331: the yahooHistory runtime
// is deleted — its pure technicals moved into technicals.ts and its
// consumers fetch through the platform historicalBars route via
// platformHistory.ts.
export * from "./technicals";
export * from "./platformHistory";
// Issue #3536: the pipeline enrich stage computes the snapshot
// screening indicators over persisted feed datasets — the
// capability joins the boundary surface by name (a star export
// would collide on this module's generic type names).
export {
  computeScreeningIndicators,
  type QuoteSnapshot,
  type ScreeningIndicators,
} from "./screeningIndicators";
export * from "./universes";
export * from "./screenerConfig";
export * from "./screenerPipeline";
export * from "./indexMembership";
export * from "./screeningSchemas";
export * from "./screenerReportPdf";
export * from "./screenerReportTemplate";
export * from "./screenerReportXlsx";
export * from "./screenerReportCsv";
export * from "./optionsReportPdf";
export * from "./strategyReport";
export * from "./optionsReportXlsx";
// Issue #2583: the options report scope resolver joins the trading surface.
export * from "./optionsReportScope";
export * from "./setupCatalog";
export * from "./researchReportPdf";
export * from "./researchReportData";
export * from "./researchReportXlsx";
export * from "./researchReportCsv";
export * from "./discoveryReportData";
export * from "./discoveryReportPdf";
export * from "./discoveryReportXlsx";
export * from "./discoveryReportCsv";
export * from "./options";
export * from "./options/flows";
export * from "./options/flows/types";
export * from "./options/strategyEngine";
export * from "./options/strategyProfile";
export * from "./options/strategyProfileStore";
export * from "./options/scanRunStore";
export * from "./options/discoveryRunStore";
export * from "./options/discoveryDerivation";
export * from "./options/ivHistoryStore";
export * from "./options/discoverySignals";
export * from "./options/discoveryInference";
export * from "./options/discoveryExpression";
export * from "./options/discoverySetupStore";
export * from "./options/discoveryAlertStore";
export * from "./options/discoveryDelta";
export * from "./options/ivCollector";
export * from "./options/optionsDataAgent";
export * from "./options/panelFetchDteBands";
export * from "./options/opportunityScanner";
export * from "./options/unifiedOptionsService";
export * from "./options/calibratedOptionChains";
export * from "./options/syntheticChains";
export * from "./options/llmComparison";
export * from "./options/recommendationAgent";
export * from "./options/strategyRiskAgent";
export * from "./options/strategies/catalog";
export * from "./options/strategies/ledger";
export * from "./email/agent";
export * from "./slack/agent";
export * from "./voice/agent";
export * from "./voice/stockCopilotVoiceActivation";
export * from "./channels/intake";
export * from "./channels/approval";
export * from "./channels/signedLinks";

// Disambiguation (#290): MAX_SCAN_SYMBOLS exists in both ./optionsScreener
// (screener config) and ./options/opportunityScanner (options config) with
// different values. External code used the options value, so an explicit
// named export — which always wins over `export *` — pins that binding.
export { MAX_SCAN_SYMBOLS } from "./options/opportunityScanner";
// Disambiguation (#4270): toLeg lives in ./options/strategies/legs, which
// the barrel does NOT star-export — a star export would make `contractKey`
// ambiguous, because ./options/strategyEngine already re-exports the same
// `contractKey` from legs. A named export joins the surface without that
// collision, the same pattern as MAX_SCAN_SYMBOLS above.
export { toLeg } from "./options/strategies/legs";
export * from "./etrade/quoteTrace";
export * from "./quotePolicies";

