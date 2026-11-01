/**
 * Issue #2719 (#2494 finding 1, tracker #2708 item A13) — prompt-bulk
 * removal: the OrchestratorAgent chat system prompt carries
 * capabilities and steering only. The platform documentation that
 * used to be embedded in the prompt (the 8-workflow UI navigation
 * map and the decisioning-engine descriptions) is served at turn
 * time by 'tool_openaimp_query_platform_knowledge'
 * (src/services/platformKnowledge.ts), which already carried the
 * canonical corpus — the prompt copy had drifted from it (it still
 * recited a curated-universe fallback the corpus records as removed
 * by #1554).
 *
 * Pins:
 *  (a) the assembled prompt contains NONE of the moved documentation
 *      bulk;
 *  (b) the knowledge service behind query_platform_knowledge returns
 *      the moved content for topical queries (the designed seam);
 *  (c) behavior steering STAYS: door semantics, never-deflect, HITL,
 *      flagged-off NLQ, and rules 1–8;
 *  (d) the assembled prompt size is pinned by measurement.
 */
import { describe, expect, it } from "vitest";

import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import { searchPlatformKnowledge } from "../src/services/platformKnowledge";

const prompt = buildOrchestratorSystemPrompt({
  route: { agent: "search", confidence: 0.92, reason: "test route" },
  memoryContext: "",
  vectorContext: "",
  optionsResearchContext: "",
  isAutoOptionsResearchRequest: false,
});

/** Pre-#2719 assembled prompt length (chars), measured on main @ 5caf8e05. */
const PRE_CHANGE_PROMPT_CHARS = 10_193;
/**
 * Post-#2719 size pin: assembled length measured at 5,880 chars on
 * the #2719 branch tree; pin keeps ~220 chars of headroom. History:
 * pre-#2719 the prompt measured 10,193 chars (see
 * PRE_CHANGE_PROMPT_CHARS) — the removed workflow map, engine
 * descriptions, and catalog bullets account for the 4,313-char drop.
 */
const PROMPT_SIZE_PIN_CHARS = 6_100;

describe("issue #2719 — moved documentation bulk is out of the prompt", () => {
  it("drops the Platform Workflows & UI Navigation Map section", () => {
    expect(prompt).not.toContain("Platform Workflows & UI Navigation Map:");
    expect(prompt).not.toContain("Workflow 1: Stock Screener & Equity Discovery");
    expect(prompt).not.toContain("Workflow 8: Natural Language Financial Intelligence (NLQ)");
    expect(prompt).not.toContain("Screens 8,000+ US equities with 14-period RSI & MACD");
    expect(prompt).not.toContain("Fallback hierarchy: Nasdaq API -> Yahoo Finance -> curatedStockUniverse.json");
  });

  it("drops the Algorithmic & Decisioning Engines section", () => {
    expect(prompt).not.toContain("Algorithmic & Decisioning Engines:");
    expect(prompt).not.toContain("PickBestTrades Engine: Evaluates trade setups across 5 dimensions");
    expect(prompt).not.toContain("Options Filter Engine: Enforces budget constraints");
    expect(prompt).not.toContain("Stock Screener Ingestion: Live multi-exchange discovery");
  });

  it("drops the pure catalog-description tool bullets (descriptions live in the discovered MCP catalog)", () => {
    expect(prompt).not.toContain("Query rows from any table (mas_categories");
    expect(prompt).not.toContain("Full CRUD for referral categories taxonomy");
    expect(prompt).not.toContain("Manage external ad placements (EthicalAds, Carbon, AdSense, Direct)");
    expect(prompt).not.toContain("Compute platform financial analytics across ad networks");
    expect(prompt).not.toContain("Inspect processor health status and registered agent DIDs");
    expect(prompt).not.toContain("Stream real-time routing decisions, judge evaluations, and security logs");
    expect(prompt).not.toContain("Retrieve broker account balances, equity holdings, and real-time unrealized P&L");
    expect(prompt).not.toContain("Inspect database tables, schema columns, and row counts via DatabaseORM");
  });

  it("points at the knowledge tool as the documentation source instead", () => {
    expect(prompt).toContain("tool_openaimp_query_platform_knowledge");
    expect(prompt).toContain("NOT carried in this prompt");
  });
});

describe("issue #2719 — behavior steering stays in the prompt", () => {
  it("keeps the door steering lines", () => {
    expect(prompt).toContain("'tool_openaimp_run_stock_screen'");
    expect(prompt).toContain("THE universe-screen tool");
    expect(prompt).toContain("'tool_openaimp_run_options_strategy_screen'");
    expect(prompt).toContain("NOT a universe screen");
    expect(prompt).toContain("listings");
  });

  it("keeps the safety / refusal semantics lines", () => {
    expect(prompt).toContain("NEVER execute unverified money movement");
    expect(prompt).toContain("NEVER execute without human confirmation");
    expect(prompt).toContain("ONLY after explicit human authorization");
    expect(prompt).toContain("Flagged OFF in chat turns by CHAT_NLQ_MODE, default off");
  });

  it("keeps Agentic Best Practices & Workflow Rules 1–8", () => {
    expect(prompt).toContain("Agentic Best Practices & Workflow Rules:");
    expect(prompt).toContain("invoke 'tool_openaimp_query_platform_knowledge'");
    expect(prompt).toContain("Human-in-the-Loop (HITL) Execution");
    expect(prompt).toContain("never deflect that request to a UI workflow");
    expect(prompt).toContain("Background execution: MCP capabilities return queued job IDs instead of final results");
  });
});

describe("issue #2719 — the knowledge tool serves the moved content", () => {
  const combined = (query: string): string => {
    const r = searchPlatformKnowledge(query, { maxResults: 5 });
    return [
      r.formattedAnswer,
      ...r.results.flatMap((x) => [x.title, x.summary, x.details, ...x.howToUse]),
    ].join("\n");
  };

  it("serves the full 8-workflow map (empty query overview)", () => {
    const text = combined("");
    expect(text).toContain("Stock Screener & Multi-Exchange Equity Discovery");
    expect(text).toContain("Options Strategy Discovery & Greeks Engine");
    expect(text).toContain("Options Flow Estimates");
    expect(text).toContain("Visual Multi-Leg Strategy Builder");
    expect(text).toContain("Portfolio Positions & Account Sync");
    expect(text).toContain("Brokerage Order Execution with HITL Guardrails");
    expect(text).toContain("Natural Language Financial Intelligence (NLQ)");
    expect(text).toContain("Fallback hierarchy");
    expect(text).toContain("curatedStockUniverse.json");
  });

  it("serves the stock-screener fallback / ingestion documentation", () => {
    const text = combined("how does the stock screener fallback hierarchy work with nasdaq and the curated universe");
    expect(text).toContain("DynamicMarketScreener");
  });

  it("serves the PickBestTrades decisioning-engine documentation", () => {
    const text = combined("pickbesttrades");
    expect(text).toContain("Pick Best Trade");
  });

  it("serves the options filter constraints documentation (max loss / max profit)", () => {
    const text = combined("find me options that have maxprofit > 0 and maxloss <= 30");
    expect(text.toLowerCase()).toContain("max loss");
  });

  it("serves the background cron / token-renewal documentation", () => {
    const text = combined("autonomous background cron token renewal schedule");
    expect(text).toContain("23:00");
  });
});

describe("issue #2719 — prompt size pin (by measurement)", () => {
  it("the assembled prompt shrank materially and stays under the pin", () => {
    expect(prompt.length).toBeLessThan(PRE_CHANGE_PROMPT_CHARS - 1_500);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_SIZE_PIN_CHARS);
  });
});
