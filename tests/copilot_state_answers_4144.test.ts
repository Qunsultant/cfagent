// @vitest-environment node
/**
 * Issue #4164 — the copilot answers state questions from the tool payload.
 *
 * Observed failure: asked "how many strategies do you know?" and "which broker
 * in which mode are you using?", the copilot called `stock_copilot_status`,
 * then searched platform knowledge twice, got "No custom index documents
 * matched", and synthesized an answer anyway.
 *
 * The payload already carried the answers (`strategies`, `activeBroker`,
 * `activeMode`). What was missing was the instruction that these fields ARE
 * the answer, and the fields named in the tool description the model reads.
 *
 * These pins defend:
 *   1. the status tool's description names both question classes and the
 *      fields that answer them;
 *   2. both prompt blocks route those questions to the status payload;
 *   3. the grounding rule exists: read, never synthesize, never substitute an
 *      options-catalog total;
 *   4. the payload type still carries the three fields the prompt promises.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { STOCK_COPILOT_MCP_STEERING } from "../src/agents/prompts/stockCopilotPrompt";

const read = (p: string) => readFileSync(p, "utf8");

describe("#4164 — state questions are answered from stock_copilot_status", () => {
  it("the tool description names the strategy set and the broker/mode fields", () => {
    const src = read("src/mcps/openaimp/meshDoorCommands.ts");
    const block = src.slice(src.indexOf('readonly name = "stock_copilot_status"'));
    const description = block.slice(0, block.indexOf("readonly jsonSchema"));
    expect(description).toContain("`strategies`");
    expect(description).toContain("`activeBroker`");
    expect(description).toContain("`activeMode`");
    expect(description).toContain("how many / which strategies");
    expect(description).toContain("which broker in which mode");
  });

  it("the steering prompt routes both questions to the status payload", () => {
    expect(STOCK_COPILOT_MCP_STEERING).toContain("'strategies'");
    expect(STOCK_COPILOT_MCP_STEERING).toContain("'activeBroker'");
    expect(STOCK_COPILOT_MCP_STEERING).toContain("'activeMode'");
  });

  it("states the grounding rule: read it, never synthesize it", () => {
    expect(STOCK_COPILOT_MCP_STEERING).toContain("STATE QUESTIONS ARE READ, NOT SYNTHESIZED");
    expect(STOCK_COPILOT_MCP_STEERING).toContain("never a catalog total from platform knowledge");
    expect(STOCK_COPILOT_MCP_STEERING).toContain("never fill the gap from general knowledge");
  });

  it("the dynamic prompt block carries the same two fields", () => {
    const src = read("src/agents/prompts/stockCopilotPrompt.ts");
    expect(src).toContain("active broker/mode ('activeBroker'/'activeMode')");
    expect(src).toContain("the strategies the loop runs ('strategies')");
  });

  it("the payload type still carries the fields the prompt promises", () => {
    const src = read("src/agents/orchestrator/meshStockCopilotDoor.ts");
    const iface = src.slice(src.indexOf("export interface StockCopilotStatusResult"));
    const body = iface.slice(0, iface.indexOf("\n}"));
    expect(body).toContain("strategies: string[];");
    expect(body).toContain("activeBroker: string | null;");
    expect(body).toContain("activeMode: string | null;");
  });
});
