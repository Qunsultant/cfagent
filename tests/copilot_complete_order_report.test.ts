import { describe, expect, it } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { buildOrchestratorSystemPrompt, FINAL_REPLY_CONTRACT, withFinalReplyContract } from "../src/agents/chatPrompt";
import { assessReplyCompleteness, synthesizeToolTurnSummary } from "../src/agents/orchestrator/replyCompleteness";
import { extractMessageText } from "../src/agents/orchestrator/chatTurnHelpers";
import { extractText } from "../src/client/chat/types";
import { ToolResultView } from "../src/client/chat/ToolResultView";

describe("final-reply contract applies to every agent (pin 5899-P01)", () => {
  const cases = [
    { name: "stock copilot", extra: { stockCopilotMcpActive: true } },
    { name: "generic orchestrator", extra: {} },
  ];
  for (const c of cases) {
    it(`${c.name}: contract appended once; builder output untouched`, () => {
      const base = buildOrchestratorSystemPrompt({
        route: { agent: "stock", confidence: 1, reason: "test" },
        activeBroker: "alpaca",
        activeMode: "paper",
        ...c.extra,
      } as never);
      expect(base).not.toContain(FINAL_REPLY_CONTRACT);
      const full = withFinalReplyContract(base);
      expect(full.split(FINAL_REPLY_CONTRACT).length - 1).toBe(1);
      expect(withFinalReplyContract(full)).toBe(full);
      expect(full.startsWith(base)).toBe(true);
      expect(FINAL_REPLY_CONTRACT).toContain("MUST equal the number of calls");
      expect(FINAL_REPLY_CONTRACT).toContain("Never end a turn on an announcement");
    });
  }
});

describe("assessReplyCompleteness & synthesizeToolTurnSummary (pin 5899-P02)", () => {
  const tool1 = {
    type: "tool-tool_openaimp_alpaca_place_order",
    output: { success: true, orderId: "ord-1", symbol: "NVDA", side: "sell", qty: 10, type: "limit", limit_price: 182, status: "accepted" },
  };
  const tool2 = {
    type: "tool-tool_openaimp_alpaca_place_order",
    output: { success: true, orderId: "ord-2", symbol: "AAPL", side: "sell", qty: 5, type: "limit", limit_price: 299, status: "accepted" },
  };
  const tool3 = {
    type: "tool-tool_openaimp_alpaca_place_order",
    output: { success: false, orderId: "ord-3", symbol: "MSFT", side: "sell", qty: 3, type: "limit", limit_price: 520, status: "rejected", message: "insufficient shares" },
  };

  it("flags the reported failure (announcement then 3 tool calls, no closing text) and synthesizes a complete 3-call receipt", () => {
    const msg = {
      role: "assistant",
      parts: [{ type: "text", text: "Submitting the two limit sell orders now at 30% above current prices:" }, tool1, tool2, tool3],
    };
    const r = assessReplyCompleteness(msg);
    expect(r).toEqual({ complete: false, reason: "announcement_only", toolCalls: 3 });

    const summary = synthesizeToolTurnSummary(msg);
    expect(summary).toContain("Completed 3 tool calls:");
    expect(summary).toContain("1. `alpaca_place_order`: SELL 10 NVDA · LIMIT · @ $182.00 · ID `ord-1` · status: **accepted**");
    expect(summary).toContain("2. `alpaca_place_order`: SELL 5 AAPL · LIMIT · @ $299.00 · ID `ord-2` · status: **accepted**");
    expect(summary).toContain("3. `alpaca_place_order`: SELL 3 MSFT · LIMIT · @ $520.00 · ID `ord-3` · status: **rejected** · — insufficient shares");

    expect(extractMessageText(msg)).toContain("Completed 3 tool calls:");
    expect(extractText(msg)).toContain("Completed 3 tool calls:");
  });

  it("flags tool calls with no text at all and synthesizes the receipt", () => {
    const msg = { role: "assistant", parts: [tool1] };
    expect(assessReplyCompleteness(msg).reason).toBe("no_text");
    expect(extractMessageText(msg)).toContain("Completed 1 tool call:");
  });

  it("flags a non-announcement text that still ends on tools", () => {
    expect(assessReplyCompleteness({ parts: [{ type: "text", text: "Placing orders" }, tool1] }).reason).toBe("ended_on_tool");
  });

  it("accepts a closing text after the tools without synthesizing duplicate summary", () => {
    const msg = { role: "assistant", parts: [tool1, tool2, { type: "text", text: "Placed 2 orders: NVDA and AAPL." }] };
    expect(assessReplyCompleteness(msg).complete).toBe(true);
    expect(synthesizeToolTurnSummary(msg)).toBeNull();
    expect(extractMessageText(msg)).toBe("Placed 2 orders: NVDA and AAPL.");
  });

  it("accepts a plain no-tool reply", () => {
    expect(assessReplyCompleteness({ parts: [{ type: "text", text: "Hi" }] }).complete).toBe(true);
    expect(assessReplyCompleteness(null).complete).toBe(true);
  });

  it("ToolResultView renders a structured execution card for tool_openaimp_alpaca_place_order instead of raw 🔧 Tool Call fallback", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(ToolResultView, {
        toolType: "tool-tool_openaimp_alpaca_place_order",
        data: tool1.output,
      }),
    );
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(text).not.toContain("🔧 Tool Call:");
    expect(text).toContain("Alpaca Execution:");
    expect(text).toContain("NVDA");
  });
});
