import { describe, it, expect } from "vitest";
import {
  synthesizeCapabilityProposals,
  introspectStockCopilot,
} from "../src/services/stockCopilotIntrospection";
import {
  resolveStockCopilotRsiMode,
  parseStockCopilotRsiMode,
  isStockCopilotRsiMode,
  COPILOT_RSI_MODE_SETTING_KEY,
} from "../src/services/stockCopilotRsiMode";
import { controlStockCopilotViaDoor } from "../src/agents/orchestrator/meshStockCopilotDoor";
import type { StockCopilotStoreSqlExecutor } from "../src/data/stockCopilotStorePorts";
import {
  createStockCopilotPositionPort,
  createStockCopilotActivityPort,
  createStockCopilotControlPort,
} from "../src/data/createStockCopilotStorePorts";

function createInMemorySql(): StockCopilotStoreSqlExecutor {
  const store = new Map<string, Array<Record<string, unknown>>>();

  const exec: StockCopilotStoreSqlExecutor = {
    exec: (query: string, ...params: unknown[]) => {
      const q = query.trim().toUpperCase();
      if (q.startsWith("CREATE TABLE")) return [];
      if (q.startsWith("INSERT INTO STOCK_COPILOT_CONTROL") || q.startsWith("UPDATE STOCK_COPILOT_CONTROL")) {
        const rows = store.get("control") || [];
        const login = String(params[0] ?? "");
        const existingIdx = rows.findIndex((r) => r.user_login === login);
        const record = {
          user_login: login,
          paused: params[1] ?? 0,
          pause_until: params[2] ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (existingIdx >= 0) {
          rows[existingIdx] = record;
        } else {
          rows.push(record);
        }
        store.set("control", rows);
        return [];
      }
      if (q.startsWith("SELECT")) {
        if (q.includes("FROM STOCK_COPILOT_POSITIONS")) {
          const all = store.get("positions") || [];
          const userLogin = String(params[0] ?? "");
          return all.filter((r) => r.user_login === userLogin);
        }
        if (q.includes("FROM STOCK_COPILOT_ACTIVITY")) {
          const all = store.get("activity") || [];
          const userLogin = String(params[0] ?? "");
          return all.filter((r) => r.user_login === userLogin);
        }
        if (q.includes("FROM STOCK_COPILOT_CONTROL")) {
          const all = store.get("control") || [];
          const userLogin = String(params[0] ?? "");
          return all.filter((r) => r.user_login === userLogin);
        }
        return [];
      }
      return [];
    },
  };
  return exec;
}

describe("Stock Copilot RSI: Capability Gap Diagnosis & Self-Improvement Proposals", () => {
  it("defaults RSI mode to 'governed' and handles validation correctly", () => {
    expect(resolveStockCopilotRsiMode()).toBe("governed");
    expect(resolveStockCopilotRsiMode({ readSettingRaw: () => null })).toBe("governed");
    expect(resolveStockCopilotRsiMode({ readSettingRaw: () => "invalid_mode" })).toBe("governed");
    expect(resolveStockCopilotRsiMode({ readSettingRaw: () => "self" })).toBe("self");
    expect(resolveStockCopilotRsiMode({ readSettingRaw: () => "governed" })).toBe("governed");
    expect(resolveStockCopilotRsiMode({ env: { STOCK_COPILOT_RSI_MODE: "self" } as any })).toBe("self");

    expect(parseStockCopilotRsiMode("self")).toBe("self");
    expect(parseStockCopilotRsiMode("autonomous")).toBe("self");
    expect(parseStockCopilotRsiMode("governed")).toBe("governed");
    expect(parseStockCopilotRsiMode("something_else")).toBe("governed");

    expect(isStockCopilotRsiMode("governed")).toBe(true);
    expect(isStockCopilotRsiMode("self")).toBe(true);
    expect(isStockCopilotRsiMode("autonomous")).toBe(false);
  });

  it("synthesizes capability proposals diagnosing universe bottlenecks and strategy gaps", () => {
    const proposals = synthesizeCapabilityProposals({
      universe: ["AAPL", "MSFT", "NVDA"],
      strategies: ["sma_crossover", "rsi_reversal"],
      enabledSessions: ["regular"],
      openPositionsCount: 0,
      refusalsCount: 2,
    });

    expect(proposals.length).toBeGreaterThanOrEqual(3);

    // 1. Dynamic Universe Expansion proposal
    const universeProposal = proposals.find((p) => p.gapId === "GAP_STATIC_UNIVERSE_BOTTLENECK");
    expect(universeProposal).toBeDefined();
    expect(universeProposal?.leveragedTools.domain).toContain("screenerAgent");
    expect(universeProposal?.leveragedTools.platform).toContain("browserAgent");
    expect(universeProposal?.governedPathway.targetIssueTitle).toContain("Dynamic Universe Ingestion from ScreenerAgent");
    expect(universeProposal?.selfRsiPathway.platformTool).toBe("thinkWorkflow");

    // 2. Downside risk options hedge proposal
    const hedgeProposal = proposals.find((p) => p.gapId === "GAP_UNHEDGED_CVAR_EXPOSURE");
    expect(hedgeProposal).toBeDefined();
    expect(hedgeProposal?.leveragedTools.domain).toContain("cvarRiskGate");
    expect(hedgeProposal?.governedPathway.targetIssueTitle).toContain("Cross-Asset Options Hedging Integration");
    expect(hedgeProposal?.selfRsiPathway.platformTool).toBe("a2aMeshDoor");

    // 3. Sandbox strategy backtesting proposal
    const sandboxProposal = proposals.find((p) => p.gapId === "GAP_STRATEGY_SYNTHESIS_SANDBOX");
    expect(sandboxProposal).toBeDefined();
    expect(sandboxProposal?.leveragedTools.platform).toContain("sandboxAgent");
    expect(sandboxProposal?.leveragedTools.platform).toContain("browserAgent");
    expect(sandboxProposal?.readiness).toBe("ready_to_synthesize");
    expect(sandboxProposal?.governedPathway.targetIssueTitle).toContain("Algorithmic Regime Adaptive Trading Patterns");
    expect(sandboxProposal?.selfRsiPathway.platformTool).toBe("sandboxAgent");
  });

  it("introspectStockCopilot surfaces RSI proposals in reflection and explanation markdown for governed mode", async () => {
    const sql = createInMemorySql();
    const positionPort = createStockCopilotPositionPort(sql);
    const activityPort = createStockCopilotActivityPort(sql);
    const controlPort = createStockCopilotControlPort(sql);

    const result = await introspectStockCopilot({
      env: {} as any,
      userLogin: "trader_rsi_test",
      readSettingRaw: () => null,
      positionPort,
      activityPort,
      controlPort,
    });

    expect(result.ok).toBe(true);
    expect(result.configuration.rsiMode).toBe("governed");
    expect(result.reflection.capabilityProposals).toBeDefined();
    expect(result.reflection.capabilityProposals.length).toBeGreaterThan(0);

    // Check that explanation markdown includes Section 4 and Governed indicator
    expect(result.explanationMarkdown).toContain("## 4. Recursive Self-Improvement (RSI) & Capability Gap Proposals");
    expect(result.explanationMarkdown).toContain("Current Mode: **GOVERNED**");
    expect(result.explanationMarkdown).toContain("Active Execution Pathway (🏛️ Governed Mode [GitHub Issue])");
    expect(result.explanationMarkdown).toContain("Dynamic Momentum Universe Expansion (via ScreenerAgent)");
    expect(result.explanationMarkdown).toContain("Autonomous Strategy Research & Sandboxed Backtesting");
  });

  it("introspectStockCopilot surfaces Self-RSI mode when configured", async () => {
    const sql = createInMemorySql();
    const positionPort = createStockCopilotPositionPort(sql);
    const activityPort = createStockCopilotActivityPort(sql);
    const controlPort = createStockCopilotControlPort(sql);

    const settings = new Map<string, string>([
      [COPILOT_RSI_MODE_SETTING_KEY, "self"],
    ]);

    const result = await introspectStockCopilot({
      env: {} as any,
      userLogin: "trader_rsi_test",
      readSettingRaw: (key) => settings.get(key) ?? null,
      positionPort,
      activityPort,
      controlPort,
    });

    expect(result.ok).toBe(true);
    expect(result.configuration.rsiMode).toBe("self");
    expect(result.explanationMarkdown).toContain("Current Mode: **SELF**");
    expect(result.explanationMarkdown).toContain("Active Execution Pathway (🤖 Self-RSI Mode [SandboxAgent])");
    expect(result.explanationMarkdown).toContain("Autonomous Sandbox Action");
  });

  it("switches RSI mode dynamically via controlStockCopilotViaDoor", async () => {
    const sql = createInMemorySql();
    const settings = new Map<string, string>();

    const ctx = {
      user: { login: "trader_rsi_door", email: "trader@example.com" },
      readSettingRaw: (key: string) => settings.get(key) ?? null,
      writeSetting: (key: string, val: string) => {
        settings.set(key, val);
      },
      audit: () => {},
      env: {} as any,
      sql,
    };

    // Default status
    const initialResult = await controlStockCopilotViaDoor(ctx, "trader_rsi_door", {});
    expect(initialResult.rsiMode).toBe("governed");

    // Switch to self mode
    const switchedResult = await controlStockCopilotViaDoor(ctx, "trader_rsi_door", { rsiMode: "self" });
    expect(switchedResult.success).toBe(true);
    expect(switchedResult.rsiMode).toBe("self");
    expect(settings.get(COPILOT_RSI_MODE_SETTING_KEY)).toBe("self");

    // Switch back to governed mode
    const backResult = await controlStockCopilotViaDoor(ctx, "trader_rsi_door", { rsiMode: "governed" });
    expect(backResult.success).toBe(true);
    expect(backResult.rsiMode).toBe("governed");
    expect(settings.get(COPILOT_RSI_MODE_SETTING_KEY)).toBe("governed");
  });
});
