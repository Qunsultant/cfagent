/**
 * Issue #3525 S4 — broker/provider neutrality, platform services & agent
 * descriptions.
 *
 * Characterization pins: the platform's self-description (the knowledge
 * service served to agents and users) names capabilities and neutral
 * mechanisms — provider ports, per-element routing, the connected
 * broker — not a brand, wherever the text frames the PLATFORM. Each
 * change pin asserts the neutral string is present and the branded
 * framing it replaced is absent.
 *
 * Deferred rows (documented in the PR body) are pinned as UNCHANGED so a
 * later slice cannot silently absorb them: strings that name the actual
 * serving source or route (provenance — data sources, API hosts, route
 * paths, per-provider execution entries, the E*TRADE-only positions and
 * token-renewal route families, code identifiers, and the legacy
 * `sandbox` broker-alias explanation in the contract prose).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  PLATFORM_WORKFLOWS_KNOWLEDGE,
  getPlatformCapabilitiesDeskSummary,
  searchPlatformKnowledge,
} from "../src/services/platformKnowledge";

const read = (p: string) => readFileSync(p, "utf8");
const wf = (id: string) => {
  const found = PLATFORM_WORKFLOWS_KNOWLEDGE.find((w) => w.id === id);
  if (!found) throw new Error(`workflow ${id} missing`);
  return found;
};

describe("neutrality S4 — platformKnowledge generic workflow framing", () => {
  it("stock screener badge names the capability, not the providers", () => {
    expect(wf("stock-screener").badge).toBe("Dual-Engine (Listings & Quotes)");
    expect(wf("stock-screener").badge).not.toContain("Nasdaq & Yahoo");
  });

  it("stock screener provider-flexibility feature is framed neutrally", () => {
    const features = wf("stock-screener").keyFeatures.join("\n");
    expect(features).toContain(
      "Dual provider flexibility: connected-broker mode or 100% zero-credential market-data mode."
    );
    expect(features).not.toContain("E*TRADE broker mode");
    expect(features).not.toContain("Yahoo Finance mode");
  });

  it("strategy builder transitions to the broker order preview, unnamed", () => {
    const features = wf("strategy-builder").keyFeatures.join("\n");
    expect(features).toContain(
      "One-click transition from visual builder to broker order preview."
    );
    expect(features).not.toContain("E*TRADE order preview");
  });

  it("strategy builder chain-pricing source is framed neutrally", () => {
    const sources = wf("strategy-builder").dataSources.join("\n");
    expect(sources).toContain(
      "Live Option Chain Pricing (connected broker & market-data providers)"
    );
    expect(sources).not.toContain("(E*TRADE & Yahoo Finance)");
  });

  it("NLQ dogfooding line names broker trading generically", () => {
    const features = wf("nlq-conversational-agent").keyFeatures.join("\n");
    expect(features).toContain("database ORM, broker trading, market-data research");
    expect(features).not.toContain("E*TRADE trading");
  });
});

describe("neutrality S4 — capabilities desk summary (voice/NLQ surface)", () => {
  const caps = getPlatformCapabilitiesDeskSummary();

  it("order-drafts workflow title names no broker", () => {
    const drafts = caps.workflows.find((w) => w.id === "order-execution");
    expect(drafts?.title).toBe("Brokerage Order Drafts (Strict HITL)");
  });

  it("spoken summary opens with the neutral desk name", () => {
    expect(caps.spokenSummary).toContain(
      "The Voice Trading Desk provides 14 integrated market capabilities"
    );
    expect(caps.spokenSummary).not.toContain("E*TRADE Voice Trading Desk");
  });

  it("markdown overview titles the neutral desk", () => {
    expect(caps.markdownOverview).toContain(
      "### 🎙️ Voice Trading Desk: Platform Capabilities"
    );
    expect(caps.markdownOverview).not.toContain("E*TRADE Voice Trading Desk");
  });
});

describe("neutrality S4 — agent description and contract prose examples", () => {
  it("trading-agent header states neutrality without brand examples", () => {
    const src = read("src/agents/trading-agent.ts");
    expect(src).toContain(
      "It is provider-NEUTRAL: each provider sits behind the TradingPlatformRegistry seam; new providers onboard by registering a platform, with no agent changes."
    );
    expect(src).not.toContain("E*TRADE is one provider behind the TradingPlatformRegistry seam");
    expect(src).not.toContain("Public.com) onboard by registering a platform");
  });

  it("interfaces plug-in example names no platform brands", () => {
    const src = read("src/trading/interfaces.ts");
    expect(src).toContain(
      "New platforms (a brokerage or exchange integration) plug in without modifying existing code."
    );
    expect(src).not.toContain("(E*TRADE, Alpaca, Interactive Brokers)");
  });
});

describe("neutrality S4 — deferred provenance pinned unchanged", () => {
  it("data-bearing route paths in apiEndpoint fields are untouched", () => {
    expect(wf("stock-screener").apiEndpoint).toContain("POST /api/etrade/screen");
    expect(wf("options-strategy-discovery").apiEndpoint).toContain(
      "POST /api/etrade/options/strategy"
    );
    expect(wf("portfolio-positions-sync").apiEndpoint).toContain(
      "GET /api/etrade/positions"
    );
    expect(wf("automated-execution-hitl").apiEndpoint).toContain(
      "POST /api/etrade/order/preview"
    );
  });

  it("data sources naming the actual serving source stay (provenance)", () => {
    const screenerSources = wf("stock-screener").dataSources.join("\n");
    expect(screenerSources).toContain("Nasdaq Official Screener API (api.nasdaq.com/api/screener/stocks)");
    expect(screenerSources).toContain("E*TRADE Market Quote & Orders API (api.etrade.com/v1/market/quote)");
    const flowSources = wf("options-flows").dataSources.join("\n");
    expect(flowSources).toContain(
      "Option-Chain Snapshots (E*TRADE / Yahoo Finance) — modelled flow estimates; no trade-tape feed exists"
    );
  });

  it("the E*TRADE positions route entry keeps its provenance naming", () => {
    expect(wf("portfolio-positions-sync").subtitle).toContain(
      "Sync live E*TRADE positions, account balances, and unrealized PnL."
    );
    expect(wf("portfolio-positions-sync").sampleQueryOrAction).toBe(
      "Show my E*TRADE positions and unrealized PnL"
    );
  });

  it("the token-renewal job description keeps its provenance naming", () => {
    expect(wf("background-cron-scheduling").overview).toContain(
      "Automatically renews E*TRADE OAuth access tokens daily"
    );
  });

  it("per-provider execution entries in the 14-workflow directory stay", () => {
    const result = searchPlatformKnowledge("how many workflows analysis and execution");
    expect(result.formattedAnswer).toContain(
      "E1: Brokerage Order Preview & HITL Execution (E*TRADE)"
    );
    expect(result.formattedAnswer).toContain(
      "E2: Direct Equities & Crypto Order Placement (Alpaca Broker API)"
    );
  });

  it("interfaces legacy sandbox-alias explanation stays (data-bearing truth)", () => {
    const src = read("src/trading/interfaces.ts");
    expect(src).toContain("resolves to\n * (etrade, TEST) via `resolveBrokerSelection`");
  });
});
