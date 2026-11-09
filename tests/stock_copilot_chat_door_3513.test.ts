/**
 * Issue #3513 — Stock Copilot chat door & dynamic quick-chips.
 *
 * Verifies:
 * 1. getStockCopilotStatusViaDoor retrieves live loop telemetry, open positions,
 *    closed trades, and trading mode via the underlying data layer ports.
 * 2. controlStockCopilotViaDoor modifies pause state and enabled sessions.
 * 3. Identity discipline: both methods fail closed with MeshDoorError when actingLogin is absent.
 * 4. MCP commands StockCopilotStatusCommand and StockCopilotControlCommand execute cleanly.
 * 5. Registry uniform quickChips and hero definitions for core copilots (general, options, stock).
 */

import { describe, it, expect, vi } from "vitest";
import {
  getStockCopilotStatusViaDoor,
  controlStockCopilotViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import {
  StockCopilotStatusCommand,
  StockCopilotControlCommand,
  meshStockCopilotDoorContextFromMcp,
} from "../src/mcps/openaimp/meshDoorCommands";
import {
  DEFAULT_COPILOTS,
  findCopilot,
  registerCopilot,
} from "../src/client/chat/copilotRegistry";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";

class MockSqlExecutor {
  private tables: Record<string, any[]> = {
    copilot_positions: [],
    stock_copilot_activity: [],
    stock_copilot_control: [],
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

  insertMockPosition(pos: any) {
    this.tables.copilot_positions.push(pos);
  }

  insertMockActivity(act: any) {
    this.tables.stock_copilot_activity.push(act);
  }
}

function createTestDoorContext(sql: MockSqlExecutor, overrides?: Partial<StockCopilotDoorContext>): StockCopilotDoorContext {
  const settingsStore = new Map<string, string>();
  return {
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "true",
      STOCK_COPILOT_MODE: "paper",
    } as any,
    sql: sql as any,
    readSettingRaw: (k: string) => settingsStore.get(k) ?? null,
    writeSetting: (k: string, v: string) => settingsStore.set(k, v),
    // Issue #3899: the door reads the REAL stored broker selection —
    // the empty in-memory store resolves to the copilot default
    // (alpaca, paper) through the resolver, never a hardcoded fake.
    commercial: new InMemoryCommercialAdapter(),
    audit: vi.fn(),
    ...overrides,
  };
}

describe("Issue #3513 Stock Copilot Chat Door", () => {
  it("fails closed when actingLogin is missing or empty", async () => {
    const sql = new MockSqlExecutor();
    const ctx = createTestDoorContext(sql);

    await expect(getStockCopilotStatusViaDoor(ctx, null)).rejects.toThrow(MeshDoorError);
    await expect(getStockCopilotStatusViaDoor(ctx, "")).rejects.toThrow(MeshDoorError);
    await expect(controlStockCopilotViaDoor(ctx, undefined, { paused: true })).rejects.toThrow(MeshDoorError);
  });

  it("reads loop status, positions, and cycle activity via getStockCopilotStatusViaDoor", async () => {
    const sql = new MockSqlExecutor();
    sql.insertMockPosition({
      id: "pos-1",
      user_login: "trader_alice",
      symbol: "NVDA",
      strategy: "momentum_breakout",
      quantity: 10,
      entry_price: 130.5,
      stop_price: 125.0,
      target_price: 145.0,
      broker_order_ref: "alpaca-ord-123",
      entry_session: "regular",
      entry_order_type: "bracket",
      status: "open",
      opened_at: new Date().toISOString(),
      closed_at: null,
      exit_price: null,
      exit_reason: null,
    });
    sql.insertMockActivity({
      id: "act-1",
      user_login: "trader_alice",
      cycle_id: "cycle-999",
      action: "scan_complete",
      details: JSON.stringify({ symbolsScanned: 50, signalsFound: 1 }),
      created_at: new Date().toISOString(),
    });

    const ctx = createTestDoorContext(sql);
    const status = await getStockCopilotStatusViaDoor(ctx, "trader_alice");

    expect(status.userLogin).toBe("trader_alice");
    expect(status.flagEnabled).toBe(true);
    expect(status.paused).toBe(false);
    expect(status.activeBroker).toBe("alpaca");
    expect(status.activeMode).toBe("paper");
    expect(status.openPositions).toHaveLength(1);
    expect(status.openPositions[0].symbol).toBe("NVDA");
    expect(status.openPositions[0].entryPrice).toBe(130.5);
    expect(status.openPositions[0].stopPrice).toBe(125.0);
    expect(status.openPositions[0].targetPrice).toBe(145.0);
    expect(status.activity).toHaveLength(1);
    expect(status.lastCycle).not.toBeNull();
  });

  it("controls pause/resume and sessions via controlStockCopilotViaDoor", async () => {
    const sql = new MockSqlExecutor();
    const ctx = createTestDoorContext(sql);

    // 1. Pause loop
    const pauseRes = await controlStockCopilotViaDoor(ctx, "trader_bob", { paused: true });
    expect(pauseRes.success).toBe(true);
    expect(pauseRes.paused).toBe(true);
    expect(ctx.audit).toHaveBeenCalledWith(
      "stock_copilot.control_paused_via_door",
      "orchestrator",
      expect.objectContaining({ userLogin: "trader_bob", paused: true }),
    );

    // Verify status reflects paused
    const statusAfterPause = await getStockCopilotStatusViaDoor(ctx, "trader_bob");
    expect(statusAfterPause.paused).toBe(true);
    expect(statusAfterPause.status).toBe("paused");

    // 2. Resume loop
    const resumeRes = await controlStockCopilotViaDoor(ctx, "trader_bob", { paused: false });
    expect(resumeRes.success).toBe(true);
    expect(resumeRes.paused).toBe(false);

    // 3. Update sessions
    const sessionRes = await controlStockCopilotViaDoor(ctx, "trader_bob", {
      sessions: ["regular", "after_hours"],
    });
    expect(sessionRes.success).toBe(true);
    expect(sessionRes.enabledSessions).toEqual(["regular", "after_hours"]);
  });

  it("throws door_unavailable when updating sessions without writeSetting", async () => {
    const sql = new MockSqlExecutor();
    const ctx = createTestDoorContext(sql, { writeSetting: undefined });

    await expect(
      controlStockCopilotViaDoor(ctx, "trader_carol", { sessions: ["regular"] }),
    ).rejects.toThrow(/writeSetting is not configured/);
  });
});

describe("Issue #3513 MCP Tool Commands", () => {
  it("executes StockCopilotStatusCommand and StockCopilotControlCommand via McpToolContext", async () => {
    const sql = new MockSqlExecutor();
    const mcpContext: any = {
      env: {
        STOCK_COPILOT_PAPER_ENABLED: "true",
        STOCK_COPILOT_MODE: "paper",
      },
      storage: { sql },
      actingLogin: () => "agent_dev",
      audit: vi.fn(),
      recordCallMetric: vi.fn(),
    };

    const statusCmd = new StockCopilotStatusCommand();
    expect(statusCmd.name).toBe("stock_copilot_status");
    const statusResult = await statusCmd.execute({}, mcpContext);
    expect(statusResult.userLogin).toBe("agent_dev");
    // Issue #3899: the MCP door context carries no commercial store
    // and this harness binds no AGENT_DB, so the selection is
    // unresolved (never a hardcoded alpaca) — in production the
    // resolver composes the real D1 store from env.
    expect(statusResult.selectionResolved).toBe(false);
    expect(statusResult.activeBroker).toBeNull();
    expect(statusResult.activeMode).toBeNull();
    expect(statusResult.status).toBe("mode_unresolved");

    const controlCmd = new StockCopilotControlCommand();
    expect(controlCmd.name).toBe("stock_copilot_control");
    const controlResult = await controlCmd.execute({ paused: true }, mcpContext);
    expect(controlResult.success).toBe(true);
    expect(controlResult.paused).toBe(true);
  });

  it("meshStockCopilotDoorContextFromMcp throws when SQL is missing", () => {
    const badContext: any = {
      env: {},
      storage: {},
      actingLogin: () => "user",
    };
    expect(() => meshStockCopilotDoorContextFromMcp(badContext)).toThrow(
      /cannot access SQLite/,
    );
  });
});

describe("Issue #3513 Copilot Registry Quick Chips & Hero", () => {
  it("defines uniform quickChips and hero for general, options, and stock copilots", () => {
    const stock = findCopilot("stock");
    expect(stock).toBeDefined();
    expect(stock?.hero?.title).toBe("Stock Copilot & Autonomous Loop");
    expect(stock?.quickChips).toBeDefined();
    expect(stock?.quickChips?.length).toBeGreaterThanOrEqual(6);
    const stockLabels = stock?.quickChips?.map((c) => c.label) || [];
    expect(stockLabels.some((l) => l.includes("Open Positions"))).toBe(true);
    expect(stockLabels.some((l) => l.includes("Pause Loop"))).toBe(true);

    const options = findCopilot("options");
    expect(options).toBeDefined();
    expect(options?.hero?.title).toBe("Options Strategy & Intelligence Copilot");
    expect(options?.quickChips?.length).toBeGreaterThanOrEqual(6);

    const general = findCopilot("general");
    expect(general).toBeDefined();
    expect(general?.hero?.title).toBe("Enterprise Multi-Agent Studio");
    expect(general?.quickChips?.length).toBeGreaterThanOrEqual(6);
  });

  it("supports dynamic registration with custom quickChips and hero", () => {
    const unregister = registerCopilot({
      id: "crypto_test",
      label: "Crypto Test",
      mode: "chat",
      tooltip: {
        eyebrow: "Crypto",
        title: "Crypto Intelligence",
        description: "Crypto trading bot",
      },
      hero: {
        icon: "🪙",
        title: "Crypto Trading Studio",
        description: "DeFi & CeFi automated arbitrage",
      },
      quickChips: [
        {
          label: "🪙 BTC Arbitrage",
          prompt: "Scan for cross-exchange BTC price spreads",
        },
      ],
    });

    const registered = findCopilot("crypto_test");
    expect(registered?.hero?.title).toBe("Crypto Trading Studio");
    expect(registered?.quickChips?.[0].label).toBe("🪙 BTC Arbitrage");

    unregister();
  });
});
