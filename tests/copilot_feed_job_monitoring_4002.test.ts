// @vitest-environment node
/**
 * Issue #4002 — Yahoo feed-runs failing with FAILURE_ASYNC_JOB_FAILED.
 *
 * The copilot told the owner the platform "doesn't expose a direct
 * REST URL for monitoring the sentiment feed job". That claim is
 * wrong: the monitoring paths exist today — MCP
 * `tool_openaimp_get_feed_job_status`, REST
 * `GET /data-providers/:id/feed` (and `/feed-jobs`), the Schedules
 * → Runs ledger, and Workflow Runs. No new endpoint is needed;
 * the copilot's steering needs the correction, not a new surface.
 *
 * This file pins the fix: the Stock Copilot prompt carries the
 * feed-job monitoring rule naming those paths, on every steering
 * surface, so a feed job's status is checked through them and
 * never declared unmonitorable.
 */
import { describe, expect, it } from "vitest";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import {
  buildStockCopilotMcpSteering,
  buildStockCopilotSystemPrompt,
  STOCK_COPILOT_FEED_JOB_MONITORING_RULE,
  STOCK_COPILOT_MCP_STEERING,
  type StockCopilotPromptCapability,
} from "../src/agents/prompts/stockCopilotPrompt";

const PROMPT_BASE = {
  route: { agent: "search" as const, confidence: 0.92, reason: "test route" },
  memoryContext: "",
  vectorContext: "",
  optionsResearchContext: "",
  isAutoOptionsResearchRequest: false,
};

/** An E*TRADE/paper capability: exercises the broker-aware steering branch. */
const ETRADE_CAPABILITY: StockCopilotPromptCapability = {
  brokerId: "etrade",
  brokerLabel: "E*TRADE",
  mode: "paper",
  environment: "TEST",
  tools: {
    quote: "etrade_get_quote",
    preview: "etrade_preview_order",
    place: "etrade_execute_order",
    orders: null,
    cancel: null,
  },
  bracketOrders: "preview",
  percentBrackets: false,
};

function expectMonitoringRule(prompt: string): void {
  expect(prompt).toContain("tool_openaimp_get_feed_job_status");
  expect(prompt).toContain("GET /data-providers/:id/feed");
  expect(prompt).toMatch(/runs ledger/i);
  expect(prompt).toMatch(/never (say|claim|declare).*unmonitorable/i);
}

describe("feed-job monitoring steering (#4002)", () => {
  it("the monitoring rule names the existing paths: MCP status tool, REST feed routes, runs ledger", () => {
    expectMonitoringRule(STOCK_COPILOT_FEED_JOB_MONITORING_RULE);
    expect(STOCK_COPILOT_FEED_JOB_MONITORING_RULE).toContain("yahoo-nasdaq100-sentiment");
  });

  it("the default Stock Copilot steering carries the monitoring rule", () => {
    expectMonitoringRule(STOCK_COPILOT_MCP_STEERING);
  });

  it("the broker-aware steering carries the monitoring rule for a non-Alpaca broker", () => {
    expectMonitoringRule(buildStockCopilotMcpSteering(ETRADE_CAPABILITY));
  });

  it("an activated Stock Copilot turn carries the monitoring rule", () => {
    expectMonitoringRule(buildStockCopilotSystemPrompt(PROMPT_BASE));
    expectMonitoringRule(
      buildOrchestratorSystemPrompt({ ...PROMPT_BASE, stockCopilotMcpActive: true }),
    );
  });
});
