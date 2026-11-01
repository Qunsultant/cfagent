import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Issue #1322 & #1353: Pin test suite ensuring all user-facing UX strings in NextGenTP
 * are independent of cloud provider and infrastructure product names (Cloudflare Worker,
 * Workers AI, Durable Objects, DO Alarms, Vectorize RAG, R2 archival), as well as
 * low-level database and technology jargon (SQLite, SQLite ORM, LLM, WAL).
 * All capabilities must be presented as institutional business capabilities.
 */
describe("UX Vendor Independence & Capability Representation (Issues #1322 & #1353)", () => {
  const root = resolve(__dirname, "..");
  const read = (file: string) => readFileSync(resolve(root, file), "utf8");

  it("WorkflowsHub.tsx contains 0 vendor product or raw database jargon and presents institutional capabilities", () => {
    const content = read("src/client/WorkflowsHub.tsx");
    expect(content).not.toContain("Cloudflare Workers AI");
    expect(content).not.toContain("Cloudflare DO Alarms");
    expect(content).not.toContain("Cloudflare Durable Object");
    expect(content).not.toContain("Vectorize RAG");
    expect(content).not.toContain("R2 archival");
    expect(content).not.toContain("Cloudflare EMAIL Worker Binding");
    expect(content).not.toContain("Cloudflare Workers Telemetry");
    expect(content).not.toContain("Cloudflare Worker API Metrics");
    expect(content).not.toContain("SQLite WAL");
    expect(content).not.toContain("SQLite storage");
    expect(content).not.toContain("SQLite database");

    expect(content).toContain("Autonomous State Alarms");
    expect(content).toContain("Neural Strategy AI Engine");
    expect(content).toContain("Enterprise Semantic Knowledge Index");
    expect(content).toContain("Inbound Corporate Email Gateway");
    expect(content).toContain("cold-storage vault archival");
    expect(content).toContain("Cryptographic Audit Ledger");
    expect(content).toContain("Upstream Subrequests &amp; Edge Execution Metrics");
  });

  it("ETradeTradingHub.tsx presents omnichannel trading desks and institutional execution ledger", () => {
    const content = read("src/client/ETradeTradingHub.tsx");
    expect(content).not.toContain("Cloudflare Agents SDK");
    expect(content).not.toContain("Cloudflare Email Trading Agent");
    expect(content).not.toContain("Cloudflare Slack Trading Agent");
    expect(content).not.toContain("Cloudflare Agents Voice SDK");
    expect(content).not.toContain("Cloudflare Durable Objects + SQLite");
    expect(content).not.toContain("Configured in Cloudflare");
    expect(content).not.toContain("Persistent Distributed SQLite");
    expect(content).not.toContain("SQLite mas_trades");

    expect(content).toContain("Autonomous Multi-Agent Architecture");
    expect(content).toContain("Autonomous Email Trading Desk");
    expect(content).toContain("Autonomous Slack Trading Desk");
    expect(content).toContain("Real-Time Voice Architecture");
    expect(content).toContain("Institutional Execution Ledger");
    expect(content).toContain("Securely Configured");
  });

  it("ScheduledOptionsManager and ScheduleFormModal express persistent background timers", () => {
    const manager = read("src/client/ScheduledOptionsManager.tsx");
    expect(manager).not.toContain("Cloudflare Agents Durable Timers");
    expect(manager).not.toContain("Cloudflare Durable Object storage");
    expect(manager).toContain("Persistent Background Timers");
    expect(manager).toContain("server-side distributed state");

    const modal = read("src/client/scheduledOptionsManager/ScheduleFormModal.tsx");
    expect(modal).not.toContain("durable Cloudflare Agents SDK timer");
    expect(modal).toContain("autonomous persistent timer");
  });

  it("ETradeDynamicMenu.tsx and MarketDataResearchHub.tsx express institutional ledgers", () => {
    const menu = read("src/client/ETradeDynamicMenu.tsx");
    expect(menu).not.toContain("Durable Objects + SQLite");
    expect(menu).not.toContain("Persistent Distributed SQLite");
    // Issue #2624: the provenance prose moved with the admin sections into
    // the Platform Admin drawer. Same assertions, new host.
    const platformAdmin = read("src/client/PlatformAdminPanel.tsx");
    expect(platformAdmin).toContain("Institutional Execution Ledger &amp; Audit Trail");
    expect(platformAdmin).not.toContain("Durable Objects + SQLite");
    expect(platformAdmin).not.toContain("Persistent Distributed SQLite");

    const marketDataResearch = read("src/client/MarketDataResearchHub.tsx");
    expect(marketDataResearch).not.toContain("SQLite Durable Objects");
    expect(marketDataResearch).toContain("persistent event ledger");
  });

  it("AgentChatTabContent.tsx, RevenueTab.tsx, and AdsTab.tsx present platform capabilities", () => {
    const chat = read("src/client/chat/AgentChatTabContent.tsx");
    expect(chat).not.toContain("Stateful Durable Object SQLite Session");
    expect(chat).not.toContain("Cloudflare Workers AI");
    expect(chat).not.toContain('>Workers AI<');
    expect(chat).toContain("Stateful Distributed Ledger Session");
    expect(chat).toContain("neural strategy intelligence");
    expect(chat).toContain('>Neural Strategy<');

    const rev = read("src/client/chat/tabs/RevenueTab.tsx");
    expect(rev).not.toContain("Durable Object ORM");
    expect(rev).not.toContain("powered by SQLite ORM");
    expect(rev).not.toContain("SQLite ORM `mas_categories`");
    expect(rev).toContain("Referral Categories &amp; Taxonomy Manager");
    expect(rev).toContain("Institutional Data Schemas &amp; Record Counts");

    const ads = read("src/client/chat/tabs/AdsTab.tsx");
    expect(ads).not.toContain("Workers AI Vectorize Bundle");
    expect(ads).not.toContain("Cloudflare Platform");
  });

  it("PartnerDealsModal.tsx presents enterprise developer capabilities without vendor hosting names", () => {
    const deals = read("src/client/components/PartnerDealsModal.tsx");
    expect(deals).not.toContain('"Cloudflare Workers AI"');
    expect(deals).not.toContain('"Cloudflare AI Search"');
    expect(deals).not.toContain('"Durable Objects SQLite"');
    expect(deals).not.toContain("institutional RAG pipelines");
    expect(deals).toContain("Neural Strategy Accelerators");
    expect(deals).toContain("Enterprise Vector Knowledge Engine");
    expect(deals).toContain("Distributed Transactional Ledger");
  });

  it("Options research modals and panels reference neural strategy and AI rather than low-level acronyms", () => {
    const panel = read("src/client/options/OptionsResearchPanel.tsx");
    expect(panel).not.toContain("Workers AI LLM");
    expect(panel).not.toContain("Configured Workers AI model");
    expect(panel).not.toContain("powered by Cloudflare Durable Timers");
    expect(panel).not.toContain("🧠 Evaluate with LLM");
    expect(panel).toContain("🧠 Evaluate with AI");
    expect(panel).toContain("Quant vs. AI ranking");

    const evalModal = read("src/client/options/LlmStrategyEvalModal.tsx");
    expect(evalModal).not.toContain("Workers AI LLM Evaluation");
    expect(evalModal).not.toContain("Workers AI Llama 3.3");
    expect(evalModal).not.toContain("⚡ Stored SQLite Cache");
    expect(evalModal).toContain("⚡ Stored Market Cache");

    const ideas = read("src/client/options/LlmOptionsIdeasPanel.tsx");
    expect(ideas).not.toContain("Analyzing chains with Workers AI…");
    expect(ideas).not.toContain("⚡ Stored SQLite Cache");
    expect(ideas).toContain("⚡ Stored Market Cache");

    const etapi = read("src/client/options/EtapiConfigModal.tsx");
    expect(etapi).not.toContain("Cloudflare Workers AI model is assigned");
  });
});
