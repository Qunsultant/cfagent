// @vitest-environment node
/**
 * Issue #6509 — generic capabilities are steered at neutral MCP tools.
 *
 * Pins:
 * - 6509-P01 every neutral tool exists in the MCP factory and has a scope;
 * - 6509-P02 every broker (E*TRADE, Alpaca, Public, Tastytrade) resolves
 *   quote/preview/orders/cancel to the neutral tools; only direct execution
 *   stays the broker's own tool;
 * - 6509-P03 every broker-named generic tool maps to a neutral capability;
 * - 6509-P04 the chat prompt has no isEtrade/isPublic branch and no
 *   broker-named generic tool literals;
 * - 6509-P05 the Stock Copilot steering names the neutral tools and keeps the
 *   broker's own execution tool.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import {
  BROKER_TOOL_TO_GENERIC_CAPABILITY,
  NEUTRAL_BROKER_TOOL_NAMES,
  neutralBrokerToolName,
} from "../src/shared/brokerToolNames";
import { resolvePromptBrokerTools } from "../src/agents/chatPrompt";
import { buildStockCopilotMcpSteering } from "../src/agents/prompts/stockCopilotPrompt";
import type { StockCopilotPromptCapability } from "../src/agents/prompts/stockCopilotPrompt";

describe("neutral broker tools (issue 6509)", () => {
  it("P01: every neutral tool exists and is permissioned", () => {
    for (const name of Object.values(NEUTRAL_BROKER_TOOL_NAMES)) {
      expect(McpToolFactory.getTool(name), name).toBeDefined();
      expect(MCP_TOOL_SCOPES[name], name).toBeTruthy();
    }
  });

  it("P02: every broker resolves generic capabilities to neutral tools", () => {
    const cases = [
      ["etrade", "tool_openaimp_etrade_execute_order"],
      ["alpaca", "tool_openaimp_alpaca_place_order"],
      ["public", "tool_openaimp_public_place_order"],
      ["tastytrade", "tool_openaimp_broker_order_create"],
    ] as const;
    for (const [broker, executeTool] of cases) {
      const resolved = resolvePromptBrokerTools({ activeBroker: broker });
      expect(resolved.quoteTool, broker).toBe("tool_openaimp_market_data_get_quote");
      expect(resolved.previewTool, broker).toBe("tool_openaimp_broker_order_preview");
      expect(resolved.ordersTool, broker).toBe("tool_openaimp_broker_orders_list");
      expect(resolved.cancelBracketTool, broker).toBe("tool_openaimp_broker_order_cancel");
      expect(resolved.executeTool, broker).toBe(executeTool);
    }
  });

  it("P03: every broker-named generic tool maps to a neutral capability", () => {
    for (const [tool, capability] of Object.entries(BROKER_TOOL_TO_GENERIC_CAPABILITY)) {
      expect(neutralBrokerToolName(tool)).toBe(NEUTRAL_BROKER_TOOL_NAMES[capability]);
    }
    expect(neutralBrokerToolName("etrade_execute_order")).toBe("etrade_execute_order");
    expect(neutralBrokerToolName(null)).toBeNull();
  });

  it("P04: the chat prompt has no broker branch for generic tools", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../src/agents/chatPrompt.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/isEtrade|isPublic/);
    expect(source).not.toMatch(/tool_openaimp_etrade_(get_quote|preview_order|orders|cancel_order)/);
    expect(source).not.toMatch(/tool_openaimp_alpaca_(get_quote|preview_order|orders|cancel_bracket_ladder)/);
  });

  it("P05: steering names neutral tools and the broker's own execution tool", () => {
    const etrade: StockCopilotPromptCapability = {
      brokerId: "etrade",
      brokerLabel: "E*TRADE",
      mode: "paper",
      environment: "TEST",
      tools: {
        quote: "etrade_get_quote",
        preview: "etrade_preview_order",
        place: "etrade_execute_order",
        orders: "etrade_orders",
        cancel: "etrade_cancel_order",
      },
      bracketOrders: "preview",
      percentBrackets: false,
    };
    const steering = buildStockCopilotMcpSteering(etrade);
    expect(steering).toContain("tool_openaimp_market_data_get_quote");
    expect(steering).toContain("tool_openaimp_broker_order_preview");
    expect(steering).toContain("tool_openaimp_broker_orders_list");
    expect(steering).toContain("tool_openaimp_broker_order_cancel");
    expect(steering).toContain("tool_openaimp_etrade_execute_order");
    expect(steering).not.toContain("tool_openaimp_etrade_preview_order");
  });

  it("P06: a new broker-named generic tool cannot appear unclassified", () => {
    const dir = path.resolve(__dirname, "../src/mcps/openaimp");
    const names = new Set<string>();
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const text = fs.readFileSync(path.join(dir, entry), "utf8");
      for (const match of text.matchAll(/readonly name = "([^"]+)"/g)) names.add(match[1]);
    }
    const generic = [...names].filter((name) =>
      /^(etrade|alpaca|public)_(get_quote|get_positions|positions|account|preview_order|orders|cancel.*)$/.test(name),
    );
    const unclassified = generic.filter((name) => !(name in BROKER_TOOL_TO_GENERIC_CAPABILITY));
    expect(unclassified).toEqual([]);
  });
});
