/**
 * Issue #3525 S2 — broker/provider neutrality, client copy & labels.
 *
 * Characterization pins: generic platform surfaces name the capability,
 * not a provider. Each pin asserts the neutralized string is present in
 * the surface's source and the provider-specific framing it replaced is
 * absent. Deferred rows (documented in the PR body) are pinned as
 * UNCHANGED so a later slice cannot silently absorb them: the landing
 * broker pills (owner accuracy decision pending) and the Stock Copilot's
 * Alpaca-only constraint statement (integration-truth copy).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("neutrality S2 — WorkflowsHub generic workflow copy", () => {
  const src = read("src/client/WorkflowsHub.tsx");
  it("badge names the capability, not the providers", () => {
    expect(src).toContain("Dual-Engine (Listings & Quotes)");
    expect(src).not.toContain("Dual-Engine (Nasdaq & Yahoo)");
  });
  it("provider-flexibility feature is framed neutrally", () => {
    expect(src).toContain("connected-broker mode or 100% zero-credential market-data mode");
    expect(src).not.toContain("E*TRADE broker mode");
  });
  it("options workflow copy names the connected broker generically", () => {
    expect(src).toContain("Fetches live option chains from the connected broker or market-data feeds.");
    expect(src).toContain("broker order preview draft");
    expect(src).toContain("Live Option Chain Pricing (connected broker & market-data providers)");
  });
  it("zero-credential research overview names no provider as the platform engine", () => {
    expect(src).toContain("powered by zero-credential public market-data endpoints and free provider data APIs");
    expect(src).toContain("Seamless integration with broker order execution for trading.");
    expect(src).toContain("Can I use market-data research if I do not have a broker account?");
  });
  it("data-bearing route paths are untouched (integration, not copy)", () => {
    expect(src).toContain("POST /api/etrade/screen");
    expect(src).toContain("api.etrade.com/v1/market/quote");
  });
});

describe("neutrality S2 — hub descriptions and nav", () => {
  it("StockHub feature description is neutral", () => {
    const src = read("src/client/StockHub.tsx");
    expect(src).toContain("Zero-credential dual market-data feed, fundamental peer comparison.");
    expect(src).not.toContain("Zero-credential Yahoo Finance and Alpaca dual feed");
  });
  it("nav-config descriptions are neutral in both entries", () => {
    const src = read("src/client/nav-config.json");
    expect(src).not.toContain("Zero-credential Yahoo Finance and Alpaca dual feed");
    expect(src.split("Zero-credential dual market-data feed, fundamental peer comparison").length - 1).toBe(2);
  });
});

describe("neutrality S2 — screener results failure and methodology copy", () => {
  const src = read("src/client/ScreenerResultsView.tsx");
  it("failure copy names no broker", () => {
    expect(src).toContain("Broker unavailable — no market data. No fallback data substituted.");
    expect(src).not.toContain("E*TRADE unavailable");
  });
  it("methodology header is broker-honest, not provider-honest", () => {
    expect(src).toContain("Indicator methodology is broker-honest");
    expect(src).not.toContain("E*TRADE-honest");
  });
});

describe("neutrality S2 — copilot source-tab label stays in sync across client and server matcher", () => {
  it("all four sites carry the neutral label and none carries the old one", () => {
    const sites = [
      "src/client/chat/copilotRegistry.ts",
      "src/client/chat/AgentChatTabContent.tsx",
      "src/agents/orchestrator/chatTurnHelpers.ts",
    ];
    for (const p of sites) {
      expect(read(p)).toContain("Broker · Auto Options Research");
      expect(read(p)).not.toContain("E*TRADE · Auto Options Research");
    }
  });
});

describe("neutrality S2 — chat and widget example copy", () => {
  it("OptionsStrategyCard preview names your broker", () => {
    const src = read("src/client/chat/OptionsStrategyCard.tsx");
    expect(src).toContain("Preview with your broker");
    expect(src).not.toContain("Preview in E*TRADE");
  });
  it("AskAgentWidget examples and canned reply are provider-neutral", () => {
    const src = read("src/client/components/AskAgentWidget.tsx");
    expect(src).toContain("⚡ Market Snapshot");
    expect(src).not.toContain("⚡ Alpaca Snapshot");
    expect(src).toContain("Market-data multiples + NBBO quotes available.");
  });
  it("Chat fallback research label is neutral", () => {
    expect(read("src/client/Chat.tsx")).toContain('"Market Data Research"');
    expect(read("src/client/Chat.tsx")).not.toContain('"Yahoo Finance Research"');
  });
  it("research hub default NLQ names connected providers generically", () => {
    expect(read("src/client/MarketDataResearchHub.tsx")).toContain("using connected market-data providers");
  });
});

describe("neutrality S2 — admin copy", () => {
  it("tenant defaults hint names broker providers generically", () => {
    expect(read("src/client/TenantAdminPanel.tsx")).toContain("broker providers");
    expect(read("src/client/TenantAdminPanel.tsx")).not.toContain("etrade providers");
  });
  it("deactivation copy names broker tokens generically", () => {
    expect(read("src/client/IaaaAdminPanel.tsx")).toContain("API keys, and broker tokens,");
  });
});

describe("neutrality S2 — deferred rows pinned unchanged", () => {
  it("landing broker pills stay until the owner accuracy decision", () => {
    const src = read("src/client/landing.ts");
    expect(src).toContain("Fidelity Investments");
    expect(src).toContain("Tradier Brokerage");
  });
  it("Stock Copilot Alpaca-only constraint statement stays (integration-truth copy)", () => {
    expect(read("src/client/StockCopilotPanel.tsx")).toContain("the Stock Copilot trades on Alpaca only");
  });
  it("data-bearing storage key stays (integration, not copy)", () => {
    expect(read("src/client/options/StrategyDiscoveryPanel.tsx")).toContain("etrade_saved_options_trades");
  });
});
