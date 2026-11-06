/**
 * Issue #3519 — Stock Copilot Dual-Mode Operation:
 * Deterministic trajectory + Non-deterministic agentic loop
 * (perceive / plan / execute / reflect / learn, critic, memory).
 *
 * Requirements:
 * 1. Mode is user-selected: stored in `mas_settings` as `stock_copilot:execution_mode`,
 *    defaulting to "deterministic". Settable per channel / per turn.
 * 2. Activity record schema: `CopilotCycleActivityRecord` carries optional
 *    `mode: "deterministic" | "agentic"` and `criticVerdict`.
 * 3. Copilot Learning Memory: tenancy-scoped `StockCopilotMemoryPort` persisting
 *    distilled learnings from Critic verdicts and execution deltas into SQLite.
 * 4. Critic & Reflection: `evaluateCriticRules` verifies all planned trade intents
 *    against risk bounds (CVaR sizing, 5% stop loss, 10% target, session limit-only)
 *    and produces structured verdicts (accept / revise / reject).
 * 5. Deterministic Safety: Raw LLM output never touches orders; trades cross into
 *    the execution seam only as validated structured data intents approved by the critic.
 * 6. Queryable Retrospective: "What did you learn from recent cycles?" is answerable
 *    through doors and chat surfaces.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotPositionPort,
  createInMemoryStockCopilotControlPort,
} from "../src/data/createStockCopilotStorePorts";
import {
  createInMemoryStockCopilotMemoryPort,
  createStockCopilotMemoryPort,
} from "../src/data/createStockCopilotStorePorts";
import type {
  CopilotCycleActivityRecord,
  CopilotLearningRecord,
  StockCopilotMemoryPort,
} from "../src/data/stockCopilotStorePorts";
import {
  DoSqliteStockCopilotActivityStore,
} from "../src/data/doSqliteStockCopilotSurfaceAdapter";
import {
  DoSqliteStockCopilotMemoryStore,
} from "../src/data/doSqliteStockCopilotSurfaceAdapter";
import {
  runStockCopilotCycle,
  type StockCopilotDeps,
} from "../src/services/stockCopilot";
import {
  evaluateCriticRules,
  type CriticEvaluationInput,
} from "../src/services/stockCopilotCritic";
import {
  runStockCopilotAgenticCycle,
  summarizeLearnings,
} from "../src/services/stockCopilotAgenticLoop";
import {
  resolveCopilotExecutionMode,
  COPILOT_EXECUTION_MODE_SETTING_KEY,
} from "../src/services/stockCopilotExecutionMode";
import {
  getStockCopilotStatusViaDoor,
  controlStockCopilotViaDoor,
  getLearningsViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";

function sawtoothCloses(): number[] {
  const closes: number[] = [];
  for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
  closes.push(100, 98);
  return closes;
}

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

function createFakePlatform(opts?: { sessionOrders?: boolean }) {
  const placed: Array<Record<string, unknown>> = [];
  const platform = {
    platformId: "alpaca",
    name: "Alpaca (fake)",
    async getPositions() {
      return {
        account: { netAccountValue: 100_000, totalAccountValue: 100_000, buyingPower: 100_000 },
        positions: [],
      };
    },
    async getQuote(symbol: string) {
      return { symbol, lastPrice: 100 };
    },
    async placeOrderRemote(params: Record<string, unknown>) {
      placed.push(params);
      return {
        success: true,
        orderId: String(params.orderId),
        brokerOrderRef: `alpaca-${placed.length}`,
        executionId: `alpaca-${placed.length}`,
        status: "submitted",
        symbol: params.symbol,
        action: params.action,
        quantity: params.quantity,
        executionPrice: params.orderType === "LIMIT" ? (params.limitPrice as number) : 100,
        totalSettled: 0,
        message: "submitted",
        timestamp: new Date().toISOString(),
      };
    },
    supportsSessionOrders(session: string) {
      return opts?.sessionOrders !== false;
    },
  };
  return { platform, placed };
}

describe("Issue #3519 — Stock Copilot Dual-Mode Operation & Learning Loop", () => {
  describe("1. Execution Mode Resolution & Settings", () => {
    it("defaults to deterministic mode when setting is unset", () => {
      const mode = resolveCopilotExecutionMode({
        readSettingRaw: () => null,
      });
      expect(mode).toBe("deterministic");
    });

    it("resolves agentic mode when setting is 'agentic' or 'non_deterministic'", () => {
      expect(
        resolveCopilotExecutionMode({
          readSettingRaw: (k) => (k === COPILOT_EXECUTION_MODE_SETTING_KEY ? "agentic" : null),
        }),
      ).toBe("agentic");

      expect(
        resolveCopilotExecutionMode({
          readSettingRaw: (k) => (k === COPILOT_EXECUTION_MODE_SETTING_KEY ? "non_deterministic" : null),
        }),
      ).toBe("agentic");
    });

    it("reads mode from deployment env if setting store is not configured", () => {
      expect(
        resolveCopilotExecutionMode({
          env: { STOCK_COPILOT_EXECUTION_MODE: "agentic" } as any,
        }),
      ).toBe("agentic");
    });
  });

  describe("2. Activity Store Mode & Critic Verdict Persistence", () => {
    it("persists mode and critic verdict in InMemoryStockCopilotActivityStore", () => {
      const store = createInMemoryStockCopilotActivityPort();
      store.ensureSchema();

      store.appendActivity({
        id: "act-1",
        userLogin: "trader1",
        cycleAt: "2026-11-06T12:00:00Z",
        outcome: "traded",
        entries: ["AAPL"],
        exits: [],
        detail: null,
        mode: "agentic",
        criticVerdict: {
          verdict: "accept",
          reason: "Risk parameters within bounds",
        },
      });

      const list = store.listActivity("trader1", 10);
      expect(list).toHaveLength(1);
      expect(list[0].mode).toBe("agentic");
      expect(list[0].criticVerdict?.verdict).toBe("accept");
    });

    it("persists mode and critic verdict in DoSqliteStockCopilotActivityStore", () => {
      const db = new SqliteTestStorage();
      const store = new DoSqliteStockCopilotActivityStore(db as any);
      store.ensureSchema();

      store.appendActivity({
        id: "act-sqlite-1",
        userLogin: "trader1",
        cycleAt: "2026-11-06T12:00:00Z",
        outcome: "traded",
        entries: ["NVDA"],
        exits: [],
        detail: null,
        mode: "agentic",
        criticVerdict: {
          verdict: "accept",
          reason: "All 5 guards passed",
          recommendations: ["Maintain 5% stop"],
        },
      });

      const list = store.listActivity("trader1", 10);
      expect(list).toHaveLength(1);
      expect(list[0].mode).toBe("agentic");
      expect(list[0].criticVerdict?.verdict).toBe("accept");
      expect(list[0].criticVerdict?.recommendations).toEqual(["Maintain 5% stop"]);
    });
  });

  describe("3. Copilot Learning Memory Store", () => {
    it("records and lists learnings in InMemory memory port", () => {
      const memory = createInMemoryStockCopilotMemoryPort();
      memory.ensureSchema();

      memory.recordLearning({
        id: "learn-1",
        userLogin: "trader1",
        timestamp: "2026-11-06T12:00:00Z",
        category: "session",
        insight: "Extended hours orders must be LIMIT orders; venue rejects market orders.",
        sourceVerdict: "revise",
        suggestedAction: "Enforce LIMIT order type in pre-market.",
      });

      const learnings = memory.listLearnings("trader1");
      expect(learnings).toHaveLength(1);
      expect(learnings[0].category).toBe("session");
      expect(learnings[0].insight).toContain("Extended hours orders must be LIMIT");
    });

    it("records and prunes learnings in SQLite memory store", () => {
      const db = new SqliteTestStorage();
      const memory = new DoSqliteStockCopilotMemoryStore(db as any);
      memory.ensureSchema();

      for (let i = 0; i < 60; i++) {
        memory.recordLearning({
          id: `learn-sql-${i}`,
          userLogin: "trader1",
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          category: "risk",
          insight: `Insight ${i}`,
        });
      }

      const list = memory.listLearnings("trader1", 100);
      // Retention bound keeps newest 50
      expect(list.length).toBeLessThanOrEqual(50);
      expect(list[0].insight).toBe("Insight 59");
    });
  });

  describe("4. Critic Rules & Reflection Engine", () => {
    it("accepts valid plan with compliant bracket exits and sizing", () => {
      const { platform } = createFakePlatform();
      const result = evaluateCriticRules({
        userLogin: "trader1",
        session: "regular",
        platform,
        proposedIntents: [
          {
            symbol: "AAPL",
            action: "BUY",
            quantity: 10,
            orderType: "MARKET",
            limitPrice: 150,
            stopPrice: 142.5, // 5% stop
            targetPrice: 165, // 10% target
          },
        ],
        openPositions: [],
      });

      expect(result.verdict).toBe("accept");
      expect(result.violations).toHaveLength(0);
      expect(result.distilledLearnings.length).toBeGreaterThan(0);
    });

    it("rejects intent violating the 5% stop loss safety constraint", () => {
      const { platform } = createFakePlatform();
      const result = evaluateCriticRules({
        userLogin: "trader1",
        session: "regular",
        platform,
        proposedIntents: [
          {
            symbol: "AAPL",
            action: "BUY",
            quantity: 10,
            orderType: "MARKET",
            limitPrice: 100,
            stopPrice: 80, // 20% loss violates max 5% constraint
            targetPrice: 120,
          },
        ],
        openPositions: [],
      });

      expect(result.verdict).toBe("reject");
      expect(result.violations.some((v) => v.includes("Stop-loss"))).toBe(true);
    });

    it("revises intent if market order is attempted in extended-hours session", () => {
      const { platform } = createFakePlatform();
      const result = evaluateCriticRules({
        userLogin: "trader1",
        session: "pre_market",
        platform,
        proposedIntents: [
          {
            symbol: "NVDA",
            action: "BUY",
            quantity: 10,
            orderType: "MARKET", // Invalid in pre-market
            limitPrice: 120,
            stopPrice: 114,
            targetPrice: 132,
          },
        ],
        openPositions: [],
      });

      expect(result.verdict).toBe("revise");
      expect(result.recommendations.some((r) => r.includes("LIMIT"))).toBe(true);
    });
  });

  describe("5. End-to-End Agentic Cycle (Perceive -> Plan -> Critic -> Execute -> Learn)", () => {
    it("executes agentic cycle, records critic verdict, and persists distilled learnings", async () => {
      const { platform, placed } = createFakePlatform();
      const positions = createInMemoryStockCopilotPositionPort();
      const activity = createInMemoryStockCopilotActivityPort();
      const memory = createInMemoryStockCopilotMemoryPort();

      const result = await runStockCopilotAgenticCycle({
        env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
        selection: {
          resolved: true,
          selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
        },
        userLogin: "trader1",
        platform,
        positions,
        activity,
        memory,
        universe: ["TEST"],
        strategies: ["mean_reversion"],
        loadBars: async () => sawtoothCloses(),
        now: () => new Date("2026-11-04T15:00:00Z"), // Regular hours
      });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("agentic");
      expect(result.criticVerdict.verdict).toBe("accept");
      expect(result.entriesPlaced).toBe(1);
      expect(placed).toHaveLength(1);

      // Verify activity record carries mode and critic verdict
      const activities = activity.listActivity("trader1", 1);
      expect(activities[0].mode).toBe("agentic");
      expect(activities[0].criticVerdict?.verdict).toBe("accept");

      // Verify learning was distilled and stored
      const learnings = memory.listLearnings("trader1");
      expect(learnings.length).toBeGreaterThan(0);
      expect(learnings[0].category).toBeDefined();

      // Test retrospective summarizer
      const summary = summarizeLearnings(learnings);
      expect(summary).toContain("Stock Copilot Learnings");
    });

    it("unified runStockCopilotCycle dispatches agentic cycle when executionMode is agentic", async () => {
      const { platform, placed } = createFakePlatform();
      const positions = createInMemoryStockCopilotPositionPort();
      const activity = createInMemoryStockCopilotActivityPort();
      const memory = createInMemoryStockCopilotMemoryPort();

      const result = await runStockCopilotCycle({
        env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
        selection: {
          resolved: true,
          selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
        },
        userLogin: "trader1",
        platform,
        positions,
        activity,
        memory,
        executionMode: "agentic",
        universe: ["TEST"],
        strategies: ["mean_reversion"],
        loadBars: async () => sawtoothCloses(),
        now: () => new Date("2026-11-04T15:00:00Z"),
      });

      expect(result.status).toBe("ok");
      expect(result.mode).toBe("agentic");
      expect(result.entriesPlaced).toBe(1);
      expect(placed).toHaveLength(1);
    });
  });

  describe("6. Mesh Door Queries & Mode Control", () => {
    it("queries learnings via getLearningsViaDoor", async () => {
      const db = new SqliteTestStorage();
      const memory = new DoSqliteStockCopilotMemoryStore(db as any);
      memory.ensureSchema();
      memory.recordLearning({
        id: "l-1",
        userLogin: "trader1",
        timestamp: new Date().toISOString(),
        category: "execution",
        insight: "Mean reversion entries performed best on 2% pullbacks.",
      });

      const ctx: StockCopilotDoorContext = {
        env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
        sql: db as any,
        readSettingRaw: () => null,
      };

      const res = await getLearningsViaDoor(ctx, "trader1");
      expect(res.learnings).toHaveLength(1);
      expect(res.summary).toContain("Mean reversion entries");
    });

    it("controls executionMode via controlStockCopilotViaDoor", async () => {
      const db = new SqliteTestStorage();
      const settings = new Map<string, string>();

      const ctx: StockCopilotDoorContext = {
        env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
        sql: db as any,
        readSettingRaw: (k) => settings.get(k) ?? null,
        writeSetting: (k, v) => settings.set(k, v),
      };

      const res = await controlStockCopilotViaDoor(ctx, "trader1", {
        executionMode: "agentic",
      });

      expect(res.success).toBe(true);
      expect(res.executionMode).toBe("agentic");
      expect(settings.get(COPILOT_EXECUTION_MODE_SETTING_KEY)).toBe("agentic");

      const status = await getStockCopilotStatusViaDoor(ctx, "trader1");
      expect(status.executionMode).toBe("agentic");
    });
  });
});
