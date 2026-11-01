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

// Register default pluggable platforms (unchanged)
TradingPlatformRegistry.register("etrade", (env, orm, userLogin, overrideEnv, storage) => new ETradeTradingPlatform(env, orm, userLogin, overrideEnv, undefined, storage));
TradingPlatformRegistry.register("alpaca", (env, orm, userLogin) => new AlpacaTradingPlatform(env, orm, userLogin));
TradingPlatformRegistry.register("sandbox", (env, orm, userLogin, overrideEnv, storage) => new ETradeTradingPlatform(env, orm, userLogin, overrideEnv, undefined, storage));

// --- boundary surface (pre-existing) ---
export * from "./interfaces";
export * from "./registry";
export * from "./screeningProvider";
export * from "./dataProviders";
export * from "./screener";
export * from "./agent";
export * from "./etrade/client";
export * from "./etrade/platform";
export * from "./alpaca/platform";
export * from "./optionsScreener";

// --- boundary surface (#290): every capability external code used via deep paths ---
// Issue #1317: the deleted Yahoo data-source module's helpers moved
// into screenerPipeline.ts. Issue #1331: the yahooHistory runtime
// is deleted — its pure technicals moved into technicals.ts and its
// consumers fetch through the platform historicalBars route via
// platformHistory.ts.
export * from "./technicals";
export * from "./platformHistory";
export * from "./universes";
export * from "./screenerConfig";
export * from "./screenerPipeline";
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
export * from "./channels/intake";
export * from "./channels/approval";
export * from "./channels/signedLinks";

// Disambiguation (#290): MAX_SCAN_SYMBOLS exists in both ./optionsScreener
// (screener config) and ./options/opportunityScanner (options config) with
// different values. External code used the options value, so an explicit
// named export — which always wins over `export *` — pins that binding.
export { MAX_SCAN_SYMBOLS } from "./options/opportunityScanner";
export * from "./etrade/quoteTrace";
export * from "./quotePolicies";

