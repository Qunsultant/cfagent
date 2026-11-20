import { describe, expect, it } from "vitest";
import { buildOrchestratorSystemPrompt, FINAL_REPLY_CONTRACT } from "../src/agents/chatPrompt";
import { assessReplyCompleteness } from "../src/agents/orchestrator/replyCompleteness";

describe("final-reply contract applies to every agent (pin 5899-P01)", () => {
  const cases = [
    { name: "stock copilot", extra: { stockCopilotMcpActive: true } },
    { name: "generic orchestrator", extra: {} },
  ];
  for (const c of cases) {
    it(`${c.name} prompt carries the contract exactly once`, () => {
      const prompt = buildOrchestratorSystemPrompt({
        route: { agent: "stock", confidence: 1, reason: "test" },
        activeBroker: "alpaca",
        activeMode: "paper",
        ...c.extra,
      } as never);
      expect(prompt.split(FINAL_REPLY_CONTRACT).length - 1).toBe(1);
      expect(prompt).toContain("MUST equal the number of calls");
      expect(prompt).toContain("Never end a turn on an announcement");
    });
  }
});

describe("assessReplyCompleteness (pin 5899-P02)", () => {
  const tool = { type: "tool-tool_openaimp_alpaca_place_order" };
  it("flags the reported failure: announcement then 3 tool calls, no closing text", () => {
    const r = assessReplyCompleteness({
      parts: [{ type: "text", text: "Submitting the two limit sell orders now:" }, tool, tool, tool],
    });
    expect(r).toEqual({ complete: false, reason: "announcement_only", toolCalls: 3 });
  });
  it("flags tool calls with no text at all", () => {
    expect(assessReplyCompleteness({ parts: [tool] }).reason).toBe("no_text");
  });
  it("flags a non-announcement text that still ends on tools", () => {
    expect(assessReplyCompleteness({ parts: [{ type: "text", text: "Placing orders" }, tool] }).reason).toBe("ended_on_tool");
  });
  it("accepts a closing text after the tools", () => {
    expect(assessReplyCompleteness({ parts: [tool, tool, { type: "text", text: "Placed 2 orders: ..." }] }).complete).toBe(true);
  });
  it("accepts a plain no-tool reply", () => {
    expect(assessReplyCompleteness({ parts: [{ type: "text", text: "Hi" }] }).complete).toBe(true);
    expect(assessReplyCompleteness(null).complete).toBe(true);
  });
});
