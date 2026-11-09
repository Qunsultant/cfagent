/**
 * Issue #291 — trading extraction ledger (slice T0, characterization only).
 *
 * The per-competency extraction cuts along two seams, and this test pins
 * both so every later slice moves against a measured baseline:
 *
 * 1. THE BOUNDARY SURFACE — the exact re-export list of src/trading/index.ts
 *    (the sole public import surface per #290). Adding or removing a
 *    re-export is a deliberate boundary change: update the pin in the same
 *    PR that makes it.
 *
 * 2. THE CONSTRUCTION LEDGER — every `new ETradeService(` call site outside
 *    src/trading/, counted per file. The extraction migrates these sites
 *    behind the future TradingAgent facade family by family (plan on #291);
 *    a slice that migrates a site shrinks its file's count in the same PR.
 *    A NEW site — or a count that grows — fails here until the ledger is
 *    updated deliberately. Counting is raw-text (comments included): the
 *    ledger is a tripwire, and strictness is the point.
 *
 * This test changes no behavior; it is the extraction's safety net.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const TRADING_DIR = path.join(SRC, "trading");
const INDEX_FILE = path.join(TRADING_DIR, "index.ts");

function* tsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* tsFiles(full);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

/** The pinned boundary surface of src/trading/index.ts, in file order. */
const PINNED_STAR_REEXPORTS = [
  "./interfaces",
  "./registry",
  // Issue #3812: percent bracket exits join the public trading surface.
  "./bracketPercent",
  // Issue #3888: the externalized trading limits every engine and tool reads.
  "./limits",
  // Issue #3232: the broker catalog joins the public trading surface.
  "./brokerCatalog",
  // Issue #2853: the broker panel contract joins the public trading surface.
  "./brokerPanels",
  // Issue #3417: what a broker is CALLED, beside what it can do.
  "./brokerPresentation",
  // Issue #3272: the option chain source port joins the public trading surface.
  "./optionChainSource",
  // Issue #3272 S2: the stock quote source port joins the public trading surface.
  "./stockQuoteSource",
  // Issue #3272 S3: the neutral screener joins the public trading surface.
  "./neutralMarketScreener",
  "./portfolioRiskSource",
  "./screeningProvider",
  "./dataProviders",
  "./screener",
  "./agent",
  "./etrade/client",
  "./etrade/platform",
  "./alpaca/platform",
  "./alpaca/fillLots",
  "./alpaca/occSymbol",
  // Issue #3351: the Alpaca sign-in surface, exported through the boundary so
  // route handlers never import a trading-internal path (issue #290).
  "./alpaca/credentials",
  "./alpaca/credentialStore",
  "./alpaca/credentialResolution",
  "./alpaca/signIn",
  "./optionsScreener",
  "./technicals",
  "./platformHistory",
  "./universes",
  "./screenerConfig",
  "./screenerPipeline",
  // Issue #1980: the #1852 index-membership port joins the trading
  // surface so stored-list code imports it through the barrel (#290).
  "./indexMembership",
  "./screeningSchemas",
  "./screenerReportPdf",
  // Issue #2088: the PDF template module joins the trading surface.
  "./screenerReportTemplate",
  "./screenerReportXlsx",
  "./screenerReportCsv",
  "./optionsReportPdf",
  // Issue #2162: the strategy report generator joins the trading surface.
  "./strategyReport",
  "./optionsReportXlsx",
  // Issue #2583: the options report scope resolver joins the trading surface.
  "./optionsReportScope",
  "./setupCatalog",
  "./researchReportPdf",
  // Issue #2167: the research workbook/CSV renderers join the trading surface.
  "./researchReportData",
  "./researchReportXlsx",
  "./researchReportCsv",
  // Issue #2180: the discovery run-report renderers join the trading surface.
  "./discoveryReportData",
  "./discoveryReportPdf",
  "./discoveryReportXlsx",
  "./discoveryReportCsv",
  "./options",
  "./options/flows",
  "./options/flows/types",
  "./options/strategyEngine",
  "./options/strategyProfile",
  "./options/strategyProfileStore",
  "./options/scanRunStore",
  "./options/discoveryRunStore",
  "./options/discoveryDerivation",
  "./options/ivHistoryStore",
  "./options/discoverySignals",
  "./options/discoveryInference",
  "./options/discoveryExpression",
  "./options/discoverySetupStore",
  "./options/discoveryAlertStore",
  "./options/discoveryDelta",
  "./options/ivCollector",
  "./options/optionsDataAgent",
  "./options/panelFetchDteBands",
  "./options/opportunityScanner",
  "./options/unifiedOptionsService",
  "./options/calibratedOptionChains",
  "./options/syntheticChains",
  "./options/llmComparison",
  "./options/recommendationAgent",
  "./options/strategyRiskAgent",
  "./options/strategies/catalog",
  "./options/strategies/ledger",
  "./email/agent",
  "./slack/agent",
  "./voice/agent",
  "./voice/stockCopilotVoiceActivation",
  "./channels/intake",
  "./channels/approval",
  "./channels/signedLinks",
  "./etrade/quoteTrace",
  "./quotePolicies",
];

/** Pinned named re-exports (the #290 MAX_SCAN_SYMBOLS disambiguation). */
const PINNED_NAMED_REEXPORTS = ["MAX_SCAN_SYMBOLS from ./options/opportunityScanner"];

/**
 * The construction ledger: `new ETradeService(` counts per file outside
 * src/trading/ (paths relative to src/). Baseline 2026-10-22 on main
 * 3b8ac74: 51 sites in 13 files. Shrink a count only in the PR that
 * migrates those sites behind the TradingAgent facade (#291 slices T1+).
 * Shrinks: T5c (2026-10-23) — etradeOptions chains + expire-dates routes
 * resolved through the platform registry: 51 -> 49. Q2 (2026-10-23) —
 * researchProviders resolved through the registry with the LIVE_STRICT
 * quote policy named at the call site: 49 -> 48. Q3 (2026-10-23) —
 * the broker quote route onto the registry + LIVE_STRICT: 48 -> 47.
 * Q4 (2026-10-23) — the MCP quote command likewise: 47 -> 46.
 * Growths: C5 (#1361) — the comparison route constructs its own
 * service like every sibling options route: etradeOptions 5 -> 6.
 * #2581 — the mesh options-strategy door composes the service
 * for the acting login exactly as the NLQ execution layer does:
 * +1 in a new file.
 */
const CONSTRUCTION_LEDGER: Record<string, number> = {
  "agents/nlq/execution.ts": 2,
  "agents/orchestrator/asyncJobs.ts": 2,
  "agents/orchestrator/meshOptionsStrategyDoor.ts": 1,
  "agents/routes/etradeBroker.ts": 21,
  "agents/routes/etradeOptions.ts": 6,
  "agents/routes/etradeOptionsNoView.ts": 1,
  "agents/routes/watchlists.ts": 5,
  "agents/screener-agent.ts": 2,
  "mcps/openaimp/cloudflareAgentCommands.ts": 1,
  "mcps/openaimp/etradeCommands.ts": 6,
  "mcps/openaimp/index.ts": 1,
  "services/scheduledTasks.ts": 2,
  "services/thinkHarness.ts": 1,
  "services/tradingWebhooks.ts": 1,
};

describe("trading extraction ledger (issue #291 T0)", () => {
  it("pins the boundary surface of src/trading/index.ts", () => {
    const text = fs.readFileSync(INDEX_FILE, "utf8");
    const stars = [...text.matchAll(/export \* from "([^"]+)";/g)].map((m) => m[1]);
    expect(stars).toEqual(PINNED_STAR_REEXPORTS);
    const named = [...text.matchAll(/export \{ ([^}]+) \} from "([^"]+)";/g)].map(
      (m) => `${m[1]} from ${m[2]}`,
    );
    expect(named).toEqual(PINNED_NAMED_REEXPORTS);
  });

  it("pins every ETradeService construction site outside src/trading", () => {
    const actual: Record<string, number> = {};
    for (const file of tsFiles(SRC)) {
      if (file.startsWith(TRADING_DIR + path.sep)) continue;
      const text = fs.readFileSync(file, "utf8");
      const count = text.split("new ETradeService(").length - 1;
      if (count > 0) actual[path.relative(SRC, file).replace(/\\/g, "/")] = count;
    }
    expect(actual).toEqual(CONSTRUCTION_LEDGER);
    const total = Object.values(actual).reduce((a, b) => a + b, 0);
    // 46 → 47 in #1135: the recommendation-bundle route constructs its
    // own ETradeService like every sibling portfolio-risk route.
    // 47 → 48 in #1201: ScreenerAgent.runGoalScreen constructs its
    // ETradeService for the options leg, like its sibling screen path.
    // 48 → 49 in #1355: the shard executor dispatch constructs its
    // ETradeService for the feed.etrade shard, like the scheduled
    // screen path it shards.
    // 49 → 50 in #1361: the comparison route constructs its own
    // ETradeService like every sibling options route.
    // 50 → 51 in #1236: the feed.snapshot executor dispatch
    // constructs its ETradeService for the feed job, like the shard
    // executor dispatch it mirrors.
    // 51 → 52 in #1726: the /etrade/screen listings branch constructs
    // its ETradeService like every sibling broker route.
    // 52 → 53 in #2581: the mesh options-strategy door constructs
    // its ETradeService for the acting login, like the NLQ
    // execution layer whose engine seam it calls.
    // 53 → 54 in #2600: the no-view strategies route constructs
    // its own ETradeService like every sibling options route
    // (C5 precedent); the construction lives in the sibling
    // module etradeOptionsNoView.ts, not in etradeOptions.ts,
    // which keeps its count at 6 and stays under the #359 ratchet.
    // 54 ? 52 in #3388: discovery composes on the platform port, so\r\n    // services/discoveryService.ts no longer constructs ETradeService.\r\n    expect(total).toBe(52);
  });
});

