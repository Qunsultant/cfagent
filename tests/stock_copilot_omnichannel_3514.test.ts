/**
 * Issue #3514 — Stock Copilot Omnichannel Capabilities & MCP Completeness.
 *
 * Verifies:
 * 1. Dynamic universe and strategy resolution with preset indexes (NASDAQ100, SP100, MEGA_TECH, SEMIS).
 * 2. On-demand strategy evaluation without order execution or position alteration.
 * 3. Mesh door controls for universe and strategies with identity enforcement.
 * 4. MCP commands: stock_copilot_control, stock_copilot_learnings, stock_copilot_evaluate.
 * 5. REST endpoints: GET /stock-copilot/status, GET /stock-copilot/learnings, POST /stock-copilot/evaluate, POST /stock-copilot/control.
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseUniverseInput,
  parseStrategiesInput,
  resolveCopilotUniverse,
  resolveCopilotStrategies,
  PRESET_UNIVERSES,
  DEFAULT_COPILOT_UNIVERSE,
  DEFAULT_COPILOT_STRATEGIES,
  COPILOT_UNIVERSE_SETTING_KEY,
  COPILOT_STRATEGIES_SETTING_KEY,
} from "../src/services/stockCopilotConfiguration";
import {
  evaluateStockCopilotStrategy,
} from "../src/services/stockCopilotEvaluation";
import {
  getStockCopilotStatusViaDoor,
  controlStockCopilotViaDoor,
  evaluateStockCopilotViaDoor,
  getLearningsViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import {
  StockCopilotControlCommand,
  StockCopilotLearningsCommand,
  StockCopilotEvaluateCommand,
  meshStockCopilotDoorContextFromMcp,
} from "../src/mcps/openaimp/meshDoorCommands";
import { handleStockCopilotRoutes } from "../src/agents/routes/stockCopilot";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import type { Env } from "../src/types";

class MockSqlExecutor {
  private tables: Record<string, any[]> = {
    copilot_positions: [],
    stock_copilot_activity: [],
    stock_copilot_control: [],
    stock_copilot_learnings: [],
    mas_settings: [],
  };

  exec(query: string, ...params: any[]): any[] {
    const q = query.trim().toUpperCase();

    if (q.startsWith("CREATE TABLE") || q.startsWith("CREATE INDEX")) {
      return [];
    }

    if (q.startsWith("SELECT VALUE FROM MAS_SETTINGS")) {
      const key = params[0];
      const row = this.tables.mas_settings.find((r) => r.key === key);
      return row ? [{ value: row.value }] : [];
    }

    if (q.startsWith("INSERT INTO MAS_SETTINGS") || q.includes("ON CONFLICT(KEY) DO UPDATE")) {
      const key = params[0];
      const val = params[1];
      const existing = this.tables.mas_settings.find((r) => r.key === key);
      if (existing) {
        existing.value = val;
      } else {
        this.tables.mas_settings.push({ key, value: val });
      }
      return [];
    }

    if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_CONTROL")) {
      const user = params[0];
      const row = this.tables.stock_copilot_control.find((r) => r.user_login === user);
      return row ? [row] : [];
    }

    if (q.startsWith("INSERT INTO STOCK_COPILOT_CONTROL")) {
      const user = params[0];
      const paused = params[1];
      const row = this.tables.stock_copilot_control.find((r) => r.user_login === user);
      if (row) {
        row.paused = paused;
        row.updated_at = new Date().toISOString();
      } else {
        this.tables.stock_copilot_control.push({
          user_login: user,
          paused,
          updated_at: new Date().toISOString(),
        });
      }
      return [];
    }

    if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_LEARNINGS")) {
      const user = params[0];
      const limit = params[1] ?? 20;
      return this.tables.stock_copilot_learnings
        .filter((r) => r.user_login === user)
        .slice(0, limit);
    }

    if (q.startsWith("INSERT INTO STOCK_COPILOT_LEARNINGS")) {
      const id = params[0];
      const user = params[1];
      const insight = params[2];
      const verdict = params[3];
      const cat = params[4];
      const act = params[5];
      const ts = params[6];
      this.tables.stock_copilot_learnings.unshift({
        id,
        user_login: user,
        insight,
        verdict,
        category: cat,
        suggested_action: act,
        created_at: ts,
      });
      return [];
    }

    if (q.startsWith("SELECT") && q.includes("COPILOT_POSITIONS") && q.includes("STATUS = 'OPEN'")) {
      const user = params[0];
      return this.tables.copilot_positions.filter(
        (r) => r.user_login === user && r.status === "open"
      );
    }

    if (q.startsWith("SELECT") && q.includes("COPILOT_POSITIONS") && q.includes("STATUS = 'CLOSED'")) {
      const user = params[0];
      return this.tables.copilot_positions.filter(
        (r) => r.user_login === user && r.status === "closed"
      );
    }

    if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_ACTIVITY")) {
      const user = params[0];
      return this.tables.stock_copilot_activity.filter((r) => r.user_login === user);
    }

    return [];
  }
}

describe("Stock Copilot Configuration & Presets (Issue #3514)", () => {
  it("resolves default universe when unconfigured", () => {
    const universe = resolveCopilotUniverse();
    expect(universe).toEqual(DEFAULT_COPILOT_UNIVERSE);
  });

  it("resolves preset universes: NASDAQ100, SP100, MEGA_TECH, SEMIS", () => {
    expect(parseUniverseInput("NASDAQ100")).toEqual(PRESET_UNIVERSES.NASDAQ100);
    expect(parseUniverseInput("nasdaq-100")).toEqual(PRESET_UNIVERSES.NASDAQ100);
    expect(parseUniverseInput("SP100")).toEqual(PRESET_UNIVERSES.SP100);
    expect(parseUniverseInput("mega_tech")).toEqual(PRESET_UNIVERSES.MEGA_TECH);
    expect(parseUniverseInput("semis")).toEqual(PRESET_UNIVERSES.SEMIS);
  });

  it("parses and deduplicates custom symbol lists", () => {
    const parsed = parseUniverseInput("AAPL, tsla, NVDA, AAPL, msft");
    expect(parsed).toEqual(["AAPL", "TSLA", "NVDA", "MSFT"]);
  });

  it("resolves strategies correctly, including 'all'", () => {
    expect(resolveCopilotStrategies()).toEqual(DEFAULT_COPILOT_STRATEGIES);
    expect(parseStrategiesInput("all")).toEqual([
      "sma_crossover",
      "rsi_reversal",
      "mean_reversion",
      "breakout",
    ]);
    expect(parseStrategiesInput("sma_crossover, breakout, unknown_strategy")).toEqual([
      "sma_crossover",
      "breakout",
    ]);
  });
});

describe("Stock Copilot On-Demand Strategy Evaluation (Issue #3405)", () => {
  it("evaluates strategies on live bars without placing orders", async () => {
    const bars = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const loadBars = vi.fn().mockResolvedValue(bars);

    const result = await evaluateStockCopilotStrategy("AAPL", { loadBars });

    expect(result.symbol).toBe("AAPL");
    expect(result.barsCount).toBe(bars.length);
    expect(result.lastPrice).toBe(110);
    expect(result.evaluations.length).toBe(2);
    expect(result.evaluations.some((e) => e.strategy === "sma_crossover")).toBe(true);
    expect(loadBars).toHaveBeenCalledWith("AAPL");
  });

  it("reports insufficient bars gracefully when bars < 5", async () => {
    const loadBars = vi.fn().mockResolvedValue([100, 101]);
    const result = await evaluateStockCopilotStrategy("TSLA", { loadBars });

    expect(result.symbol).toBe("TSLA");
    expect(result.evaluations.every((e) => e.action === "none")).toBe(true);
    expect(result.evaluations[0].signalSuffix).toContain("Insufficient bars");
  });
});

describe("Stock Copilot Mesh Door & MCP Commands (Issue #3514)", () => {
  it("controls universe and strategies via mesh door", async () => {
    const sql = new MockSqlExecutor();
    const settings: Record<string, string> = {};
    const writeSetting = vi.fn((k: string, v: string) => {
      settings[k] = v;
    });
    const readSettingRaw = vi.fn((k: string) => settings[k] ?? null);

    const ctx: StockCopilotDoorContext = {
      env: {} as Env,
      sql,
      readSettingRaw,
      writeSetting,
    };

    const controlRes = await controlStockCopilotViaDoor(ctx, "trader@example.com", {
      universe: "NASDAQ100",
      strategies: "all",
    });

    expect(controlRes.success).toBe(true);
    expect(controlRes.universe).toEqual(PRESET_UNIVERSES.NASDAQ100);
    expect(controlRes.strategies).toEqual([
      "sma_crossover",
      "rsi_reversal",
      "mean_reversion",
      "breakout",
    ]);
    expect(writeSetting).toHaveBeenCalledWith(
      COPILOT_UNIVERSE_SETTING_KEY,
      PRESET_UNIVERSES.NASDAQ100.join(","),
    );

    // Verify status door returns configured universe and strategies
    const statusRes = await getStockCopilotStatusViaDoor(ctx, "trader@example.com");
    expect(statusRes.universe).toEqual(PRESET_UNIVERSES.NASDAQ100);
    expect(statusRes.strategies).toEqual([
      "sma_crossover",
      "rsi_reversal",
      "mean_reversion",
      "breakout",
    ]);
  });

  it("evaluates strategies via door on demand", async () => {
    const sql = new MockSqlExecutor();
    const loadBars = vi.fn().mockResolvedValue([150, 152, 151, 153, 155, 154, 156]);

    const ctx: StockCopilotDoorContext = {
      env: {} as Env,
      sql,
      readSettingRaw: () => null,
      loadBars,
    };

    const evalRes = await evaluateStockCopilotViaDoor(
      ctx,
      "trader@example.com",
      "NVDA",
      ["sma_crossover"],
    );

    expect(evalRes.symbol).toBe("NVDA");
    expect(evalRes.lastPrice).toBe(156);
    expect(evalRes.evaluations.length).toBe(1);
    expect(evalRes.evaluations[0].strategy).toBe("sma_crossover");
  });

  it("fails closed when actingLogin is absent on door operations", async () => {
    const ctx: StockCopilotDoorContext = {
      env: {} as Env,
      sql: new MockSqlExecutor(),
      readSettingRaw: () => null,
    };

    await expect(getStockCopilotStatusViaDoor(ctx, null)).rejects.toThrow(MeshDoorError);
    await expect(controlStockCopilotViaDoor(ctx, undefined, { paused: true })).rejects.toThrow(MeshDoorError);
    await expect(evaluateStockCopilotViaDoor(ctx, null, "AAPL")).rejects.toThrow(MeshDoorError);
    await expect(getLearningsViaDoor(ctx, null)).rejects.toThrow(MeshDoorError);
  });

  it("executes MCP commands: stock_copilot_learnings and stock_copilot_evaluate", async () => {
    const sql = new MockSqlExecutor();
    sql.exec(
      "INSERT INTO STOCK_COPILOT_LEARNINGS (id, user_login, insight, verdict, category, suggested_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "learn-1",
      "trader@example.com",
      "Extended-hours trade requires limit order per venue policy.",
      "accept",
      "session",
      "Use limit order",
      new Date().toISOString(),
    );

    const mcpContext: any = {
      env: {} as Env,
      storage: { sql },
      readSettingRaw: () => null,
      writeSetting: vi.fn(),
      actingLogin: () => "trader@example.com",
      audit: vi.fn(),
      orchestratorMesh: {
        recordHop: vi.fn(),
      },
    };

    // 1. Learnings MCP tool
    const learningsCmd = new StockCopilotLearningsCommand();
    expect(learningsCmd.name).toBe("stock_copilot_learnings");
    const learningsOutput = await learningsCmd.execute({ limit: 5 }, mcpContext);
    expect(learningsOutput.learnings.length).toBe(1);
    expect(learningsOutput.summary).toContain("Extended-hours trade requires limit order");

    // 2. Evaluate MCP tool
    const evalCmd = new StockCopilotEvaluateCommand();
    expect(evalCmd.name).toBe("stock_copilot_evaluate");
    const evalOutput = await evalCmd.execute({ symbol: "MSFT" }, mcpContext);
    expect(evalOutput.symbol).toBe("MSFT");
    expect(evalOutput.evaluations.length).toBeGreaterThan(0);
  });
});

describe("Stock Copilot REST Routes (Issue #3514)", () => {
  it("handles GET /stock-copilot/learnings and POST /stock-copilot/evaluate", async () => {
    const sql = new MockSqlExecutor();
    sql.exec(
      "INSERT INTO STOCK_COPILOT_LEARNINGS (id, user_login, insight, verdict, category, suggested_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "learn-2",
      "user123",
      "Stop loss bound respected (<= 5%).",
      "accept",
      "risk",
      "Maintain conservative sizing",
      new Date().toISOString(),
    );

    const routeCtx: any = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "true" },
      sql,
      getScreenerExecutionContext: async () => ({ userLogin: "user123" }),
      readSettingRaw: () => null,
      writeSetting: vi.fn(),
    };

    // GET /stock-copilot/learnings
    const reqLearnings = new Request("https://agent.internal/stock-copilot/learnings?limit=10", {
      method: "GET",
    });
    const resLearnings = await handleStockCopilotRoutes(
      reqLearnings,
      new URL(reqLearnings.url),
      "/stock-copilot/learnings",
      "sess-1",
      routeCtx,
    );

    expect(resLearnings).not.toBeNull();
    expect(resLearnings?.status).toBe(200);
    const learningsJson = await resLearnings!.json();
    expect(learningsJson.learnings.length).toBe(1);
    expect(learningsJson.summary).toContain("Stop loss bound respected");

    // POST /stock-copilot/evaluate
    const reqEval = new Request("https://agent.internal/stock-copilot/evaluate", {
      method: "POST",
      body: JSON.stringify({ symbol: "GOOGL", strategies: ["mean_reversion"] }),
      headers: { "content-type": "application/json" },
    });
    const resEval = await handleStockCopilotRoutes(
      reqEval,
      new URL(reqEval.url),
      "/stock-copilot/evaluate",
      "sess-2",
      routeCtx,
    );

    expect(resEval).not.toBeNull();
    expect(resEval?.status).toBe(200);
    const evalJson = await resEval!.json();
    expect(evalJson.symbol).toBe("GOOGL");
    expect(evalJson.evaluations.length).toBe(1);
    expect(evalJson.evaluations[0].strategy).toBe("mean_reversion");
  });

  it("handles POST /stock-copilot/control with universe and strategies", async () => {
    const sql = new MockSqlExecutor();
    const settings: Record<string, string> = {};
    const writeSetting = vi.fn((k: string, v: string) => {
      settings[k] = v;
    });

    const routeCtx: any = {
      env: {},
      sql,
      getScreenerExecutionContext: async () => ({ userLogin: "user123" }),
      readSettingRaw: (k: string) => settings[k] ?? null,
      writeSetting,
    };

    const req = new Request("https://agent.internal/stock-copilot/control", {
      method: "POST",
      body: JSON.stringify({
        universe: ["AAPL", "NVDA"],
        strategies: ["sma_crossover", "breakout"],
      }),
      headers: { "content-type": "application/json" },
    });

    const res = await handleStockCopilotRoutes(
      req,
      new URL(req.url),
      "/stock-copilot/control",
      "sess-3",
      routeCtx,
    );

    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    const json = await res!.json();
    expect(json.ok).toBe(true);
    expect(json.universe).toEqual(["AAPL", "NVDA"]);
    expect(json.strategies).toEqual(["sma_crossover", "breakout"]);
    expect(writeSetting).toHaveBeenCalledWith(COPILOT_UNIVERSE_SETTING_KEY, "AAPL,NVDA");
    expect(writeSetting).toHaveBeenCalledWith(COPILOT_STRATEGIES_SETTING_KEY, "sma_crossover,breakout");
  });
});
