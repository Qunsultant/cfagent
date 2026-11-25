import { describe, it, expect } from "vitest";
import {
  buildOrchestratorSystemPrompt,
  resolvePromptBrokerTools,
} from "../src/agents/chatPrompt";

describe("Gap 9 — Public chat wiring (#4662)", () => {
  it("returns Public MCP tools when activeBroker is 'public' or 'public.com'", () => {
    for (const broker of ["public", "Public", "public.com"]) {
      const resolved = resolvePromptBrokerTools({
        activeBroker: broker,
        activeMode: "live",
        copilotExecutionMode: "hitl",
      });
      expect(resolved).toEqual({
        brokerId: "public",
        brokerLabel: "Public.com",
        modeId: "live",
        modeLabel: "Live",
        quoteTool: "tool_openaimp_market_data_get_quote",
        previewTool: "tool_openaimp_broker_order_preview",
        executeTool: "tool_openaimp_public_place_order",
        ordersTool: "tool_openaimp_broker_orders_list",
        cancelBracketTool: "tool_openaimp_broker_order_cancel",
        executionPolicy: "hitl",
      });
    }
  });

  it("wires Public tools into buildOrchestratorSystemPrompt when activeBroker='public'", () => {
    const prompt = buildOrchestratorSystemPrompt({
      route: { agent: "trading", confidence: 0.98, reason: "stock order" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
      activeBroker: "public",
      activeMode: "live",
    });
    expect(prompt).toContain("Broker-Neutral Trading & Market Screening (Public.com Live)");
    expect(prompt).toContain("tool_openaimp_broker_order_preview");
    expect(prompt).toContain("tool_openaimp_public_place_order");
    expect(prompt).not.toContain("tool_openaimp_alpaca_place_order");
    expect(prompt).not.toContain("tool_openaimp_etrade_execute_order");
  });
});
