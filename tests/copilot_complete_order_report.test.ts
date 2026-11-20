import { describe, expect, it } from "vitest";
import { buildStockCopilotSystemPrompt } from "../src/agents/prompts/stockCopilotPrompt";

describe("copilot complete order report (pin COPILOT-COMPLETE-P01)", () => {
  for (const activeBroker of ["alpaca", "tastytrade"] as const) {
    it(`requires a complete, count-consistent order receipt on ${activeBroker}`, () => {
      const prompt = buildStockCopilotSystemPrompt({
        route: { agent: "stock", confidence: 1, reason: "test" },
        activeBroker,
        activeMode: "paper",
      });
      expect(prompt).toContain("Complete, consistent order reports");
      expect(prompt).toContain("EVERY order attempted");
      expect(prompt).toContain("MUST equal the number of order tool calls");
      expect(prompt).toContain("never end a turn on");
    });
  }
});
