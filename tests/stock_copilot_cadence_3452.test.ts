/**
 * Issue #3452 — Stock Copilot cycle cadence externalization & conversational controls.
 *
 * Tests:
 * 1. resolveCopilotCadence: defaults, env override, settings override, platform floor (30m).
 * 2. declareStockCopilotTasks: task schedule reflects effective cadence.
 * 3. controlStockCopilotViaDoor: sets cadence & pauseUntil via door, rejects invalid input.
 * 4. GET /stock-copilot/status & POST /stock-copilot/control: cadence lifecycle.
 * 5. copilotRegistry: chips for cadence, sessions, pause until, and self-explanation.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOCK_COPILOT_SCHEDULE,
  formatCadenceString,
  parseCadenceMinutes,
  resolveCopilotCadence,
  COPILOT_CADENCE_SETTING_KEY,
} from "../src/services/stockCopilotCadence";
import {
  declareStockCopilotTasks,
  STOCK_COPILOT_TASK_ID,
} from "../src/agents/orchestrator/scheduledTasksCopilot";
import {
  controlStockCopilotViaDoor,
  getStockCopilotStatusViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import { handleStockCopilotRoutes } from "../src/agents/routes/stockCopilot";
import { findCopilot } from "../src/client/chat/copilotRegistry";
import type { Env } from "../src/types";

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
}

describe("Issue #3452 Stock Copilot Cadence Resolution", () => {
  it("parses human cadence strings correctly", () => {
    expect(parseCadenceMinutes("every 30 minutes")).toBe(30);
    expect(parseCadenceMinutes("30m")).toBe(30);
    expect(parseCadenceMinutes("every 1 hour")).toBe(60);
    expect(parseCadenceMinutes("1h")).toBe(60);
    expect(parseCadenceMinutes("every 2 hours")).toBe(120);
    expect(parseCadenceMinutes("2h")).toBe(120);
    expect(parseCadenceMinutes("every 15 minutes")).toBe(15);
    expect(parseCadenceMinutes("invalid")).toBeNull();
  });

  it("formats cadence minutes into canonical strings", () => {
    expect(formatCadenceString(30)).toBe("every 30 minutes");
    expect(formatCadenceString(60)).toBe("every 1 hour");
    expect(formatCadenceString(120)).toBe("every 2 hours");
    expect(formatCadenceString(15)).toBe("every 15 minutes");
  });

  it("resolves default cadence when unset", () => {
    const res = resolveCopilotCadence({});
    expect(res.configured).toBe("every 30 minutes");
    expect(res.effective).toBe(DEFAULT_STOCK_COPILOT_SCHEDULE);
    expect(res.minutes).toBe(30);
  });

  it("resolves cadence from env and enforces platform floor", () => {
    // 1 hour: coarser than 30m, effective is 1 hour
    const hr = resolveCopilotCadence({
      env: { STOCK_COPILOT_CADENCE: "every 1 hour" },
    });
    expect(hr.configured).toBe("every 1 hour");
    expect(hr.effective).toBe("every 1 hour");
    expect(hr.minutes).toBe(60);

    // 15m: finer than platform floor (30m), effective coarsened to 30m
    const fine = resolveCopilotCadence({
      env: { STOCK_COPILOT_CADENCE: "every 15 minutes" },
    });
    expect(fine.configured).toBe("every 15 minutes");
    expect(fine.effective).toBe("every 30 minutes");
    expect(fine.minutes).toBe(30);
  });

  it("stored user setting wins over env var", () => {
    const settings = new Map<string, string>([
      [COPILOT_CADENCE_SETTING_KEY, "every 2 hours"],
    ]);
    const res = resolveCopilotCadence({
      env: { STOCK_COPILOT_CADENCE: "every 1 hour" },
      readSettingRaw: (k) => settings.get(k) ?? null,
    });
    expect(res.configured).toBe("every 2 hours");
    expect(res.effective).toBe("every 2 hours");
    expect(res.minutes).toBe(120);
  });
});

describe("Issue #3452 Think Task Declaration with Cadence", () => {
  it("declares task using effective cadence from env", async () => {
    const sql = new MockSqlExecutor();
    const ctx: any = {
      env: {
        STOCK_COPILOT_PAPER_ENABLED: "1",
        STOCK_COPILOT_CADENCE: "every 1 hour",
      },
      agentCtx: { storage: { sql } },
      getScreenerExecutionContext: async () => ({ userLogin: "testuser" }),
      getOrm: () => undefined,
      readSettingRaw: () => null,
      audit: () => {},
    };

    const tasks = await declareStockCopilotTasks(ctx);
    expect(tasks[STOCK_COPILOT_TASK_ID]).toBeDefined();
    expect(tasks[STOCK_COPILOT_TASK_ID].schedule).toBe("every 1 hour");
  });

  it("declares task using default 30m when cadence is unset", async () => {
    const sql = new MockSqlExecutor();
    const ctx: any = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" },
      agentCtx: { storage: { sql } },
      getScreenerExecutionContext: async () => ({ userLogin: "testuser" }),
      getOrm: () => undefined,
      readSettingRaw: () => null,
      audit: () => {},
    };

    const tasks = await declareStockCopilotTasks(ctx);
    expect(tasks[STOCK_COPILOT_TASK_ID]).toBeDefined();
    expect(tasks[STOCK_COPILOT_TASK_ID].schedule).toBe("every 30 minutes");
  });
});

describe("Issue #3452 Door Control & Status with Cadence", () => {
  it("updates cadence via door and reports in status", async () => {
    const sql = new MockSqlExecutor();
    const settings = new Map<string, string>();
    const audits: Array<{ type: string; payload: any }> = [];

    const ctx: StockCopilotDoorContext = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as Env,
      sql: sql as any,
      readSettingRaw: (k) => settings.get(k) ?? null,
      writeSetting: (k, v) => settings.set(k, v),
      audit: (type, agent, payload) => audits.push({ type, payload }),
    };

    // Update cadence to 1 hour
    const ctrlRes = await controlStockCopilotViaDoor(ctx, "trader_alice", {
      cadence: "every 1 hour",
    });

    expect(ctrlRes.success).toBe(true);
    expect(ctrlRes.cadence.configured).toBe("every 1 hour");
    expect(ctrlRes.cadence.effective).toBe("every 1 hour");
    expect(settings.get(COPILOT_CADENCE_SETTING_KEY)).toBe("every 1 hour");
    expect(audits.some((a) => a.type === "stock_copilot.control_cadence_via_door")).toBe(true);

    // Query status via door
    const status = await getStockCopilotStatusViaDoor(ctx, "trader_alice");
    expect(status.cadence.configured).toBe("every 1 hour");
    expect(status.cadence.effective).toBe("every 1 hour");
  });

  it("handles pauseUntil via door", async () => {
    const sql = new MockSqlExecutor();
    const settings = new Map<string, string>();

    const ctx: StockCopilotDoorContext = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as Env,
      sql: sql as any,
      readSettingRaw: (k) => settings.get(k) ?? null,
      writeSetting: (k, v) => settings.set(k, v),
    };

    const res = await controlStockCopilotViaDoor(ctx, "trader_alice", {
      pauseUntil: "9:30 AM",
    });
    expect(res.paused).toBe(true);
    expect(res.pauseUntil).toBe("9:30 AM");
    expect(settings.get("stock_copilot:pause_until")).toBe("9:30 AM");
  });

  it("refuses invalid cadence input", async () => {
    const sql = new MockSqlExecutor();
    const ctx: StockCopilotDoorContext = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as Env,
      sql: sql as any,
      readSettingRaw: () => null,
      writeSetting: () => {},
    };

    await expect(
      controlStockCopilotViaDoor(ctx, "trader_alice", { cadence: "every invalid day" }),
    ).rejects.toThrow(/Invalid cadence/);
  });
});

describe("Issue #3452 REST Routes with Cadence", () => {
  it("GET /stock-copilot/status returns cadence", async () => {
    const sql = new MockSqlExecutor();
    const settings = new Map<string, string>([[COPILOT_CADENCE_SETTING_KEY, "every 1 hour"]]);
    const ctx: any = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" },
      sql,
      getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
      readSettingRaw: (k: string) => settings.get(k) ?? null,
      writeSetting: (k: string, v: string) => settings.set(k, v),
    };

    const req = new Request("http://localhost/stock-copilot/status", { method: "GET" });
    const url = new URL(req.url);
    const res = await handleStockCopilotRoutes(req, url, url.pathname, "session-1", ctx);
    expect(res).toBeDefined();
    const data = await res!.json();
    expect(data.cadence).toEqual({
      configured: "every 1 hour",
      effective: "every 1 hour",
    });
  });

  it("POST /stock-copilot/control updates cadence", async () => {
    const sql = new MockSqlExecutor();
    const settings = new Map<string, string>();
    const ctx: any = {
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" },
      sql,
      getScreenerExecutionContext: async () => ({ userLogin: "alice" }),
      readSettingRaw: (k: string) => settings.get(k) ?? null,
      writeSetting: (k: string, v: string) => settings.set(k, v),
    };

    const req = new Request("http://localhost/stock-copilot/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cadence: "every 1 hour" }),
    });
    const url = new URL(req.url);
    const res = await handleStockCopilotRoutes(req, url, url.pathname, "session-1", ctx);
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(data.ok).toBe(true);
    expect(data.cadence.configured).toBe("every 1 hour");
    expect(settings.get(COPILOT_CADENCE_SETTING_KEY)).toBe("every 1 hour");
  });
});

describe("Issue #3452 Stock Copilot Chat Quick Chips", () => {
  it("includes all requested chips in the copilot registry", () => {
    const copilot = findCopilot("stock");
    expect(copilot).toBeDefined();
    const chips = copilot?.quickChips || [];
    const prompts = chips.map((c) => c.prompt);
    const labels = chips.map((c) => c.label);

    // Required chips from owner request
    expect(prompts).toContain("Set loop interval to 1 hour");
    expect(prompts).toContain("Enable pre-market and overnight sessions");
    expect(prompts).toContain("Pause trading until 9:30 AM");
    expect(prompts).toContain(
      "What is the Stock Copilot doing right now and what happened in the latest cycle?",
    );
    expect(prompts).toContain(
      "Explain your autonomous trading workflow, 5-stage pipeline, and active tools",
    );

    // Label verification
    expect(labels.some((l) => l.includes("Set loop interval to 1 hour"))).toBe(true);
    expect(labels.some((l) => l.includes("Enable pre-market and overnight sessions"))).toBe(true);
    expect(labels.some((l) => l.includes("Pause trading until 9:30 AM"))).toBe(true);
    expect(labels.some((l) => l.includes("Open Positions"))).toBe(true);
    expect(labels.some((l) => l.includes("Pause Loop"))).toBe(true);
    expect(labels.some((l) => l.includes("Resume Loop"))).toBe(true);
  });
});
