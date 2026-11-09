import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildOrchestratorSystemPrompt,
  resolvePromptBrokerTools,
} from "../src/agents/chatPrompt";
import {
  deriveTurn,
  isStockCopilotIntent,
  type ChatTurnHelpersContext,
} from "../src/agents/orchestrator/chatTurnHelpers";
import {
  controlStockCopilotViaDoor,
  getStockCopilotStatusViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const PROMPT_BASE = {
  route: { agent: "trading" as const, confidence: 0.98, reason: "stock order" },
  memoryContext: "",
  vectorContext: "",
  optionsResearchContext: "",
  isAutoOptionsResearchRequest: false,
};

function makeDoorCtx(): {
  ctx: StockCopilotDoorContext;
  settings: Map<string, string>;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const sql = new MockSqlStorage();
  const settings = new Map<string, string>();
  const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ctx: StockCopilotDoorContext = {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as unknown as Env,
    sql: sql as never,
    readSettingRaw: (key: string) => settings.get(key) ?? null,
    writeSetting: (key: string, value: string) => {
      settings.set(key, value);
    },
    audit: (type, _agent, payload) => {
      audits.push({ type, payload });
    },
  };
  return { ctx, settings, audits };
}

describe("Issue #3846 — Copilot-Autopilot Bridge, Autonomous Mode & Broker-Neutral Prompts", () => {
  describe("1. Broker-Neutral & Selected Broker/Mode Driven Prompts", () => {
    it("defaults general chat prompt to Alpaca (Paper) and never asks the user which broker to use", () => {
      const prompt = buildOrchestratorSystemPrompt(PROMPT_BASE);
      expect(prompt).toContain("Broker-Neutral Trading & Market Screening (Alpaca Paper)");
      expect(prompt).toContain("Active broker is Alpaca (Paper) — never ask which broker to use.");
      expect(prompt).toContain("tool_openaimp_alpaca_get_quote");
      expect(prompt).toContain("tool_openaimp_alpaca_preview_order");
      expect(prompt).toContain("tool_openaimp_alpaca_place_order");
      expect(prompt).not.toContain("6. E*TRADE Trading & Market Screening");
      expect(prompt).not.toContain("Only execute via 'tool_openaimp_etrade_execute_order'");
    });

    it("dynamically binds E*TRADE (Live) tools when activeBroker='etrade' and activeMode='live'", () => {
      const resolved = resolvePromptBrokerTools({
        activeBroker: "etrade",
        activeMode: "live",
        copilotExecutionMode: "hitl",
      });
      expect(resolved).toMatchObject({
        brokerId: "etrade",
        brokerLabel: "E*TRADE",
        modeId: "live",
        modeLabel: "Live",
        quoteTool: "tool_openaimp_etrade_get_quote",
        previewTool: "tool_openaimp_etrade_preview_order",
        executeTool: "tool_openaimp_etrade_execute_order",
        executionPolicy: "hitl",
      });

      const prompt = buildOrchestratorSystemPrompt({
        ...PROMPT_BASE,
        activeBroker: "etrade",
        activeMode: "live",
      });
      expect(prompt).toContain("Broker-Neutral Trading & Market Screening (E*TRADE Live)");
      expect(prompt).toContain("Active broker is E*TRADE (Live) — never ask which broker to use.");
      expect(prompt).toContain("tool_openaimp_etrade_get_quote");
      expect(prompt).toContain("tool_openaimp_etrade_preview_order");
      expect(prompt).toContain("tool_openaimp_etrade_execute_order");
    });

    it("dynamically binds selected broker and mode on activated Stock Copilot turns", () => {
      const alpacaLivePrompt = buildOrchestratorSystemPrompt({
        ...PROMPT_BASE,
        stockCopilotMcpActive: true,
        activeBroker: "alpaca",
        activeMode: "live",
      });
      expect(alpacaLivePrompt).toContain("Stock Copilot Trading & Execution (Alpaca Live — Mode: HITL)");
      expect(alpacaLivePrompt).toContain("Selected broker is Alpaca (Live mode).");

      const etradePaperPrompt = buildOrchestratorSystemPrompt({
        ...PROMPT_BASE,
        stockCopilotMcpActive: true,
        activeBroker: "etrade",
        activeMode: "paper",
      });
      expect(etradePaperPrompt).toContain("Stock Copilot Trading & Execution (E*TRADE Paper — Mode: HITL)");
      expect(etradePaperPrompt).toContain("tool_openaimp_etrade_preview_order");
    });
  });

  describe("2. Interactive Chat Copilot Autonomous Execution Mode ('autonomous' vs 'hitl')", () => {
    it("steers Stock Copilot and general prompts to execute orders directly when copilotExecutionMode='autonomous'", () => {
      const autoCopilotPrompt = buildOrchestratorSystemPrompt({
        ...PROMPT_BASE,
        stockCopilotMcpActive: true,
        copilotExecutionMode: "autonomous",
      });
      expect(autoCopilotPrompt).toContain("Mode: AUTONOMOUS");
      expect(autoCopilotPrompt).toContain("Autonomous Execution Mode Active (copilotExecutionMode: 'autonomous')");
      expect(autoCopilotPrompt).toContain(
        "execute it immediately in ONE call via 'tool_openaimp_alpaca_place_order'",
      );

      const autoGeneralPrompt = buildOrchestratorSystemPrompt({
        ...PROMPT_BASE,
        copilotExecutionMode: "autonomous",
      });
      expect(autoGeneralPrompt).toContain(
        "Autonomous mode is active: for trade orders (buy/sell/bracket), invoke 'tool_openaimp_alpaca_place_order' directly.",
      );
    });
  });

  describe("3. Managing & Enabling 24/7 Autopilot via Copilot Chat Door", () => {
    it("exposes autopilot state and copilotExecutionMode in stock_copilot_status and updates them via stock_copilot_control", async () => {
      const { ctx } = makeDoorCtx();

      // Initial status: autopilot off, hitl mode
      const initial = await getStockCopilotStatusViaDoor(ctx, "trader1");
      expect(initial.copilotExecutionMode).toBe("hitl");
      expect(initial.autopilot.running).toBe(false);
      expect(initial.autopilot.killSwitch).toBe(false);
      expect(initial.autopilot.mode).toBe("hitl");

      // Enable 24/7 autopilot, set custom risk limits, and switch chat to autonomous execution mode
      const updated = await controlStockCopilotViaDoor(ctx, "trader1", {
        autopilotRunning: true,
        copilotExecutionMode: "autonomous",
        sessions: ["pre_market", "regular", "after_hours", "exto"],
        autopilotLimits: {
          maxOrdersPerDay: 25,
          maxPositionPct: 15,
          minCashReservePct: 30,
        },
      });

      expect(updated.success).toBe(true);
      expect(updated.paused).toBe(false);
      expect(updated.copilotExecutionMode).toBe("autonomous");
      expect(updated.autopilot.running).toBe(true);
      expect(updated.autopilot.mode).toBe("autonomous");
      expect(updated.autopilot.limits.maxOrdersPerDay).toBe(25);
      expect(updated.autopilot.limits.maxPositionPct).toBe(15);
      expect(updated.autopilot.limits.minCashReservePct).toBe(30);
      expect(updated.enabledSessions).toEqual(["pre_market", "regular", "after_hours", "exto"]);

      // Engage emergency kill-switch via chat control
      const killed = await controlStockCopilotViaDoor(ctx, "trader1", {
        killSwitch: true,
        killSwitchReason: "Volatility spike halt requested in chat",
      });
      expect(killed.paused).toBe(true);
      expect(killed.autopilot.killSwitch).toBe(true);
      expect(killed.autopilot.killSwitchReason).toBe("Volatility spike halt requested in chat");
      expect(killed.autopilot.mode).toBe("hitl");

      // Verify MCP command schema accepts the new autopilot fields
      const cmd = McpToolFactory.getTool("stock_copilot_control");
      expect(cmd).toBeDefined();
      const parsed = cmd!.zodSchema.safeParse({
        autopilotRunning: true,
        copilotExecutionMode: "autonomous",
        killSwitch: false,
        autopilotLimits: { maxOrdersPerDay: 20 },
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("4. Automatic Stock Copilot Intent Elevation in deriveTurn", () => {
    it("elevates stock bracket, buy/sell, and autopilot prompts from General Chat to 'Stock Copilot'", async () => {
      const bracketPrompt =
        "Draft a limit buy order for 10 AAPL with +4% take-profit and -2% stop-loss bracket exits";
      expect(isStockCopilotIntent(bracketPrompt)).toBe(true);
      expect(isStockCopilotIntent("buy appl at market")).toBe(true);
      expect(isStockCopilotIntent("Preview Buy 10 AAPL")).toBe(true);
      expect(isStockCopilotIntent("enable autopilot")).toBe(true);
      expect(isStockCopilotIntent("Screen the NASDAQ100 for bull put credit spreads")).toBe(false);

      const helperCtx: ChatTurnHelpersContext = {
        env: {} as Env,
        ensureTables: () => ({}) as never,
        getOrm: () => ({}) as never,
        sessionKey: () => "sess-3846",
        audit: () => {},
        submitAsyncJob: async () => ({ jobId: "j1", status: "queued", statusUrl: "/jobs/j1" }),
        getAsyncJob: () => undefined,
        listAsyncJobs: () => [],
        getMessages: async () => [
          {
            id: "m1",
            role: "user",
            content: bracketPrompt,
            metadata: { sourceTab: "Chat & Agents", userLogin: "trader1" },
          },
        ],
        activeTurnMetadata: undefined,
      };

      const derived = await deriveTurn(helperCtx, { messages: [] });
      expect(derived.sourceTab).toBe("Stock Copilot");
      expect(derived.userLogin).toBe("trader1");
    });
  });

  describe("5. Architecture Documentation (docs/architecture/agentic/copilot-autopilot.md)", () => {
    it("documents the 24/7 autonomous loop, RiskPolicyEngine guardrails, chat control, and autonomous mode", () => {
      const docPath = path.resolve(__dirname, "../docs/architecture/agentic/copilot-autopilot.md");
      expect(fs.existsSync(docPath)).toBe(true);
      const content = fs.readFileSync(docPath, "utf8");
      expect(content).toContain("RiskPolicyEngine");
      expect(content).toContain("copilotExecutionMode");
      expect(content).toContain("tool_openaimp_stock_copilot_control");
      expect(content).toContain("resolvePromptBrokerTools");
    });
  });
});

