import { describe, expect, it } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import { EXPECTED_PROMPTS } from "./orchestrator-prompt-fixtures";
import { ToolResultView } from "../src/client/chat/ToolResultView";

const PROMPT_BASE = {
  route: { agent: "search" as const, confidence: 0.92, reason: "test route" },
  memoryContext: "",
  vectorContext: "",
  optionsResearchContext: "",
  isAutoOptionsResearchRequest: false,
};

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("Issue #3838 — Stock Copilot Prompt Externalization & Alpaca HITL Invariants", () => {
  it("base prompt without stockCopilotMcpActive remains 100% byte-identical to EXPECTED_PROMPTS.plain", () => {
    const prompt = buildOrchestratorSystemPrompt(PROMPT_BASE);
    expect(prompt).toBe(EXPECTED_PROMPTS.plain);
  });

  it("activated Stock Copilot prompt uses externalized Alpaca trading capabilities and rules", async () => {
    const { buildStockCopilotSystemPrompt, STOCK_COPILOT_TRADING_RULE } = await import(
      "../src/agents/prompts/stockCopilotPrompt"
    );
    expect(typeof buildStockCopilotSystemPrompt).toBe("function");
    expect(STOCK_COPILOT_TRADING_RULE).toContain("tool_openaimp_alpaca_place_order");

    const prompt = buildOrchestratorSystemPrompt({
      ...PROMPT_BASE,
      stockCopilotMcpActive: true,
    });

    // Advertises Alpaca tools in capabilities
    expect(prompt).toContain("tool_openaimp_alpaca_preview_order");
    expect(prompt).toContain("tool_openaimp_alpaca_place_order");
    expect(prompt).toContain("tool_openaimp_alpaca_get_quote");

    // Must NOT mandate etrade_execute_order on Stock Copilot turns
    expect(prompt).not.toContain("Only execute via 'tool_openaimp_etrade_execute_order'");

    // Instructs approval execution via Alpaca place order
    expect(prompt).toMatch(/approve.*alpaca_place_order|tool_openaimp_alpaca_place_order.*approv/i);

    // Invariant: trading tools are synchronous and do not poll get_async_job
    expect(prompt).toMatch(/synchronous.*do NOT.*get_async_job|no get_async_job polling/i);

    // Ticker normalization
    expect(prompt).toMatch(/appl.*AAPL|normalize.*symbol/i);
  });

  it("ToolResultView renders Alpaca Trade Intent and dispatches Alpaca approval for drafts without explicit broker", () => {
    let capturedAction: string | null = null;
    const draftData = {
      orderId: "alp_ord_test123",
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "MARKET",
      status: "previewed",
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ToolResultView, {
        toolType: "trade_proposal",
        data: draftData,
        onAction: (action: string) => {
          capturedAction = action;
        },
      }),
    );

    const text = textOf(html);
    expect(text).toContain("Alpaca Trade Intent");
    expect(text).toContain("Alpaca Order ID");
    expect(text).not.toContain("E*TRADE Trade Intent");
    expect(text).not.toContain("E*TRADE Order ID");
  });

  it("ToolResultView defaults to Alpaca (Paper) rather than E*TRADE for generic copilot order proposals", () => {
    const copilotProposal = {
      orderId: "ord_copilot_456",
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      copilot: true,
      orderType: "MARKET",
      status: "previewed",
    };

    const html = ReactDOMServer.renderToString(
      React.createElement(ToolResultView, {
        toolType: "copilot_order_draft",
        data: copilotProposal,
      }),
    );

    const text = textOf(html);
    expect(text).toContain("Alpaca Trade Intent");
    expect(text).not.toContain("E*TRADE Trade Intent");
  });
});
