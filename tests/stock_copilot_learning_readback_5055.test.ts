/**
 * Issue #5055 (AG-1) — Agentic-cycle learnings are read back into planning.
 *
 * The loop's header has always claimed step 1 reads "prior distilled
 * learnings from tenancy memory"; the code only ever wrote them. These
 * tests pin the read-back and the two stated rules by which a learning
 * changes a plan:
 *
 *  - `risk` learnings at/above the block threshold stop NEW entries
 *    (exits still execute — a risk lesson must never trap a position);
 *  - `session` learnings at/above the limit threshold force limit-only
 *    order shaping, including in the regular session where the default
 *    shape is a market order.
 *
 * Thresholds are externalized (env overrides + exported defaults, AOP);
 * the read is best-effort — a failing memory port is a recorded cycle
 * error, never a failed cycle.
 */
import { describe, it, expect } from "vitest";
import {
  createInMemoryStockCopilotActivityPort,
  createInMemoryStockCopilotMemoryPort,
  createInMemoryStockCopilotPositionPort,
} from "../src/data/createStockCopilotStorePorts";
import type {
  CopilotLearningRecord,
  StockCopilotMemoryPort,
} from "../src/data/stockCopilotStorePorts";
import { runStockCopilotAgenticCycle } from "../src/services/stockCopilotAgenticLoop";
import {
  COPILOT_LEARNING_POLICY_DEFAULTS,
  deriveCopilotLearningPolicy,
  resolveCopilotLearningPolicyThresholds,
} from "../src/services/stockCopilotLearningPolicy";

/** Closes that make `mean_reversion` fire an entry (mirrors #3519). */
function sawtoothCloses(): number[] {
  const closes: number[] = [];
  for (let k = 0; k < 8; k++) closes.push(100, 98, 101);
  closes.push(100, 98);
  return closes;
}

function createFakePlatform() {
  const placed: Array<Record<string, unknown>> = [];
  const platform = {
    platformId: "alpaca",
    name: "Alpaca (fake)",
    async getPositions() {
      return {
        account: {
          netAccountValue: 100_000,
          totalAccountValue: 100_000,
          buyingPower: 100_000,
        },
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
        executionPrice:
          params.orderType === "LIMIT" ? (params.limitPrice as number) : 100,
        totalSettled: 0,
        message: "submitted",
        timestamp: new Date().toISOString(),
      };
    },
    supportsSessionOrders() {
      return true;
    },
  };
  return { platform, placed };
}

function learning(
  overrides: Partial<CopilotLearningRecord> & {
    category: CopilotLearningRecord["category"];
  },
): CopilotLearningRecord {
  const base: CopilotLearningRecord = {
    id: `learn-${Math.random().toString(36).slice(2, 8)}`,
    userLogin: "trader1",
    cycleId: "2026-11-04T15:00:00Z",
    timestamp: "2026-11-04T15:00:00Z",
    category: overrides.category,
    insight: `Distilled ${overrides.category} insight`,
    sourceVerdict: "accept",
  };
  return { ...base, ...overrides };
}

function seedLearnings(
  memory: StockCopilotMemoryPort,
  learnings: CopilotLearningRecord[],
): void {
  memory.ensureSchema();
  for (const l of learnings) memory.recordLearning(l);
}

const baseDeps = () => ({
  env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
  selection: {
    resolved: true as const,
    selection: { brokerId: "alpaca", environment: "TEST", mode: "paper" },
  },
  userLogin: "trader1",
  universe: ["TEST"],
  strategies: ["mean_reversion"] as const,
  loadBars: async () => sawtoothCloses(),
  // Regular hours: the default order shape is MARKET.
  now: () => new Date("2026-11-04T15:00:00Z"),
});

describe("Issue #5055 — agentic learnings read back into planning", () => {
  describe("1. Externalized thresholds (no hardcoded policy)", () => {
    it("exports defaults and lets env override each threshold", () => {
      expect(COPILOT_LEARNING_POLICY_DEFAULTS.riskBlockAt).toBeGreaterThan(0);
      expect(COPILOT_LEARNING_POLICY_DEFAULTS.sessionLimitAt).toBeGreaterThan(0);

      const resolved = resolveCopilotLearningPolicyThresholds({
        COPILOT_LEARNING_POLICY_WINDOW: "7",
        COPILOT_LEARNING_RISK_BLOCK_AT: "5",
        COPILOT_LEARNING_SESSION_LIMIT_AT: "4",
      } as any);
      expect(resolved.window).toBe(7);
      expect(resolved.riskBlockAt).toBe(5);
      expect(resolved.sessionLimitAt).toBe(4);
      expect(resolved.enabled).toBe(true);
    });

    it("falls back to defaults on absent or invalid env values", () => {
      const resolved = resolveCopilotLearningPolicyThresholds({
        COPILOT_LEARNING_RISK_BLOCK_AT: "not-a-number",
        COPILOT_LEARNING_SESSION_LIMIT_AT: "0",
        COPILOT_LEARNING_READBACK_ENABLED: "false",
      } as any);
      expect(resolved.riskBlockAt).toBe(
        COPILOT_LEARNING_POLICY_DEFAULTS.riskBlockAt,
      );
      expect(resolved.sessionLimitAt).toBe(
        COPILOT_LEARNING_POLICY_DEFAULTS.sessionLimitAt,
      );
      expect(resolved.enabled).toBe(false);
    });
  });

  describe("2. The stated rules", () => {
    it("blocks new entries when risk learnings reach the threshold", () => {
      const policy = deriveCopilotLearningPolicy(
        [learning({ category: "risk" }), learning({ category: "risk" })],
        { ...COPILOT_LEARNING_POLICY_DEFAULTS, riskBlockAt: 2, sessionLimitAt: 2 },
      );
      expect(policy.riskCount).toBe(2);
      expect(policy.blockEntries).toBe(true);
      expect(policy.requireLimitOrders).toBe(false);
      expect(policy.reason).toContain("risk");
    });

    it("requires limit orders when session learnings reach the threshold", () => {
      const policy = deriveCopilotLearningPolicy(
        [learning({ category: "session" }), learning({ category: "session" })],
        { ...COPILOT_LEARNING_POLICY_DEFAULTS, riskBlockAt: 2, sessionLimitAt: 2 },
      );
      expect(policy.sessionCount).toBe(2);
      expect(policy.requireLimitOrders).toBe(true);
      expect(policy.blockEntries).toBe(false);
    });

    it("leaves the plan unchanged below every threshold", () => {
      const policy = deriveCopilotLearningPolicy(
        [learning({ category: "risk" }), learning({ category: "pattern" })],
        { ...COPILOT_LEARNING_POLICY_DEFAULTS, riskBlockAt: 2, sessionLimitAt: 2 },
      );
      expect(policy.blockEntries).toBe(false);
      expect(policy.requireLimitOrders).toBe(false);
      expect(policy.considered).toBe(2);
    });
  });

  describe("3. Cycle wiring", () => {
    it("stops new entries when recent risk learnings cross the threshold", async () => {
      const { platform, placed } = createFakePlatform();
      const memory = createInMemoryStockCopilotMemoryPort();
      seedLearnings(memory, [
        learning({ category: "risk" }),
        learning({ category: "risk" }),
      ]);

      const result = await runStockCopilotAgenticCycle({
        ...baseDeps(),
        platform,
        positions: createInMemoryStockCopilotPositionPort(),
        activity: createInMemoryStockCopilotActivityPort(),
        memory,
      });

      expect(result.status).toBe("ok");
      expect(result.plan.learningsPolicy.blockEntries).toBe(true);
      expect(result.plan.learningsPolicy.riskCount).toBe(2);
      expect(result.plan.learningsPolicy.considered).toBe(2);
      expect(result.entriesPlaced).toBe(0);
      expect(placed).toHaveLength(0);
      expect(result.plan.reasoning).toContain("risk learning");
    });

    it("still places entries when risk learnings stay below the threshold", async () => {
      const { platform, placed } = createFakePlatform();
      const memory = createInMemoryStockCopilotMemoryPort();
      seedLearnings(memory, [learning({ category: "risk" })]);

      const result = await runStockCopilotAgenticCycle({
        ...baseDeps(),
        platform,
        positions: createInMemoryStockCopilotPositionPort(),
        activity: createInMemoryStockCopilotActivityPort(),
        memory,
      });

      expect(result.plan.learningsPolicy.blockEntries).toBe(false);
      expect(result.entriesPlaced).toBe(1);
      expect(placed).toHaveLength(1);
    });

    it("forces limit-only shaping when session learnings cross the threshold", async () => {
      const { platform, placed } = createFakePlatform();
      const memory = createInMemoryStockCopilotMemoryPort();
      seedLearnings(memory, [
        learning({ category: "session" }),
        learning({ category: "session" }),
      ]);

      const result = await runStockCopilotAgenticCycle({
        ...baseDeps(),
        platform,
        positions: createInMemoryStockCopilotPositionPort(),
        activity: createInMemoryStockCopilotActivityPort(),
        memory,
      });

      expect(result.plan.learningsPolicy.requireLimitOrders).toBe(true);
      expect(result.entriesPlaced).toBe(1);
      expect(placed).toHaveLength(1);
      expect(placed[0].orderType).toBe("LIMIT");
      expect(placed[0].limitPrice).toBeGreaterThan(0);
    });

    it("keeps exits executing while new entries are blocked", async () => {
      const { platform, placed } = createFakePlatform();
      const memory = createInMemoryStockCopilotMemoryPort();
      seedLearnings(memory, [
        learning({ category: "risk" }),
        learning({ category: "risk" }),
      ]);
      const positions = createInMemoryStockCopilotPositionPort();
      positions.insertPosition({
        id: "pos-1",
        userLogin: "trader1",
        symbol: "TEST",
        strategy: "mean_reversion",
        quantity: 10,
        entryPrice: 100,
        stopPrice: 99,
        targetPrice: 120,
        brokerOrderRef: "alpaca-open",
        entrySession: "regular",
        entryOrderType: "MARKET",
        status: "open",
        openedAt: "2026-11-01T15:00:00Z",
        closedAt: null,
        exitBrokerOrderRef: null,
        exitPrice: null,
        exitReason: null,
      });

      const result = await runStockCopilotAgenticCycle({
        ...baseDeps(),
        platform,
        positions,
        activity: createInMemoryStockCopilotActivityPort(),
        memory,
      });

      expect(result.plan.learningsPolicy.blockEntries).toBe(true);
      expect(result.exitsPlaced).toBe(1);
      expect(result.entriesPlaced).toBe(0);
      expect(placed).toHaveLength(1);
      expect(placed[0].action).toBe("SELL");
    });

    it("records a read failure as a cycle error without failing the cycle", async () => {
      const { platform } = createFakePlatform();
      const inner = createInMemoryStockCopilotMemoryPort();
      const memory: StockCopilotMemoryPort = {
        ensureSchema: () => inner.ensureSchema(),
        recordLearning: (l) => inner.recordLearning(l),
        listLearnings: () => {
          throw new Error("memory unavailable");
        },
      };

      const result = await runStockCopilotAgenticCycle({
        ...baseDeps(),
        platform,
        positions: createInMemoryStockCopilotPositionPort(),
        activity: createInMemoryStockCopilotActivityPort(),
        memory,
      });

      expect(result.status).toBe("ok");
      expect(
        result.errors.some(
          (e) =>
            e.stage === "learning_readback" &&
            e.message.includes("memory unavailable"),
        ),
      ).toBe(true);
      expect(result.plan.learningsPolicy.blockEntries).toBe(false);
      // A failed read never invents a policy; the cycle still runs.
      expect(result.entriesPlaced).toBe(1);
    });

    it("honours the read-back kill switch", async () => {
      const { platform, placed } = createFakePlatform();
      const memory = createInMemoryStockCopilotMemoryPort();
      seedLearnings(memory, [
        learning({ category: "risk" }),
        learning({ category: "risk" }),
        learning({ category: "risk" }),
      ]);

      const result = await runStockCopilotAgenticCycle({
        ...baseDeps(),
        env: {
          STOCK_COPILOT_PAPER_ENABLED: "1",
          COPILOT_LEARNING_READBACK_ENABLED: "false",
        } as any,
        platform,
        positions: createInMemoryStockCopilotPositionPort(),
        activity: createInMemoryStockCopilotActivityPort(),
        memory,
      });

      expect(result.plan.learningsPolicy.enabled).toBe(false);
      expect(result.plan.learningsPolicy.blockEntries).toBe(false);
      expect(result.entriesPlaced).toBe(1);
      expect(placed).toHaveLength(1);
    });
  });
});
