import { describe, it, expect, vi } from "vitest";
import {
  buildPipelineStageCatalog,
  introspectStockCopilot,
} from "../src/services/stockCopilotIntrospection";
import {
  introspectStockCopilotViaDoor,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import {
  StockCopilotIntrospectCommand,
} from "../src/mcps/openaimp/meshDoorCommands";
import {
  handleStockCopilotRoutes,
  type StockCopilotRouteContext,
} from "../src/agents/routes/stockCopilot";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
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
      if (q.startsWith("CREATE TABLE")) {
        return [];
      }
      if (q.startsWith("SELECT")) {
        if (q.includes("FROM STOCK_COPILOT_POSITIONS")) {
          const all = store.get("positions") || [];
          const userLogin = String(params[0] ?? "");
          const filtered = all.filter((r) => r.user_login === userLogin);
          if (q.includes("CLOSED_AT IS NULL")) {
            return filtered.filter((r) => r.closed_at === null);
          }
          if (q.includes("CLOSED_AT IS NOT NULL")) {
            return filtered.filter((r) => r.closed_at !== null);
          }
          return filtered;
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
      if (q.startsWith("INSERT INTO STOCK_COPILOT_CONTROL")) {
        const list = store.get("control") || [];
        list.push({
          user_login: params[0],
          paused: params[1],
          updated_at: params[2],
        });
        store.set("control", list);
        return [];
      }
      if (q.startsWith("INSERT INTO STOCK_COPILOT_ACTIVITY")) {
        const list = store.get("activity") || [];
        list.unshift({
          user_login: params[0],
          cycle_timestamp: params[1],
          type: params[2],
          summary: params[3],
          details: params[4],
          created_at: params[5],
        });
        store.set("activity", list);
        return [];
      }
      if (q.startsWith("INSERT INTO STOCK_COPILOT_POSITIONS")) {
        const list = store.get("positions") || [];
        list.push({
          id: params[0],
          user_login: params[1],
          symbol: params[2],
          strategy: params[3],
          quantity: params[4],
          entry_price: params[5],
          stop_price: params[6],
          target_price: params[7],
          broker_order_ref: params[8],
          entry_session: params[9],
          entry_order_type: params[10],
          opened_at: params[11],
          closed_at: null,
          exit_price: null,
          exit_reason: null,
        });
        store.set("positions", list);
        return [];
      }
      return [];
    },
  };
  return exec;
}

describe("Issue #3588 — Stock Copilot Introspection Service", () => {
  it("builds the 5-stage pipeline catalog", () => {
    const catalog = buildPipelineStageCatalog();
    expect(catalog).toHaveLength(5);
    const stageNames = catalog.map((s) => s.name);
    expect(stageNames).toEqual(["FEED", "ENRICH", "ANALYZE", "GENERATE", "DELIVER"]);

    for (const stage of catalog) {
      expect(stage.tools.length).toBeGreaterThan(0);
      for (const tool of stage.tools) {
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.role.length).toBeGreaterThan(0);
      }
    }
  });

  it("reflects live configuration, telemetry, and distilled learnings", async () => {
    const sql = createInMemorySql();
    const positionPort = createStockCopilotPositionPort(sql);
    const activityPort = createStockCopilotActivityPort(sql);
    const controlPort = createStockCopilotControlPort(sql);
    positionPort.ensureSchema();
    activityPort.ensureSchema();
    controlPort.ensureSchema();

    // Record an open position
    positionPort.insertPosition({
      id: "pos-1",
      userLogin: "trader_alice",
      symbol: "NVDA",
      strategy: "sma_crossover",
      quantity: 15,
      entryPrice: 120.5,
      stopPrice: 114.47,
      targetPrice: 132.55,
      brokerOrderRef: "alpaca-ord-1",
      entrySession: "regular",
      entryOrderType: "limit",
      openedAt: "2026-11-06T10:00:00Z",
      status: "open",
      closedAt: null,
      exitBrokerOrderRef: null,
      exitPrice: null,
      exitReason: null,
    });

    const settings = new Map<string, string>();
    settings.set("stock_copilot:cadence", "every 1 hour");
    settings.set("stock_copilot:sessions", "pre_market,regular,after_hours,exto");

    const result = await introspectStockCopilot({
      env: { AGENT_DB: undefined, STOCK_COPILOT_PAPER_ENABLED: "true" } as any,
      userLogin: "trader_alice",
      readSettingRaw: (k: string) => settings.get(k) ?? null,
      positionPort,
      activityPort,
      controlPort,
    });

    expect(result.ok).toBe(true);
    expect(result.userLogin).toBe("trader_alice");
    expect(result.configuration.broker).toBe("alpaca");
    expect(result.configuration.mode).toBe("paper");
    expect(result.configuration.cadence.effective).toBe("every 1 hour");
    expect(result.configuration.enabledSessions).toEqual([
      "pre_market",
      "regular",
      "after_hours",
      "exto",
    ]);
    expect(result.telemetry.openPositionsCount).toBe(1);
    expect(result.pipeline).toHaveLength(5);
    expect(result.reflection.learnings.length).toBeGreaterThan(0);
    expect(result.explanationMarkdown).toContain("Stock Copilot Self-Explanation");
    expect(result.explanationMarkdown).toContain("Stage 1: Feed");
    expect(result.explanationMarkdown).toContain("Stage 5: Deliver");
  });
});

describe("Issue #3588 — Mesh Door Introspection", () => {
  it("fails closed without acting login", async () => {
    const sql = createInMemorySql();
    await expect(
      introspectStockCopilotViaDoor(
        {
          env: {} as any,
          sql,
          readSettingRaw: () => null,
        },
        null,
      ),
    ).rejects.toThrow(MeshDoorError);
  });

  it("succeeds with acting login and emits audit event", async () => {
    const sql = createInMemorySql();
    const audits: Array<{ type: string; payload: any }> = [];
    const auditFn = (type: string, _agent: string, payload: any) => {
      audits.push({ type, payload });
    };

    const result = await introspectStockCopilotViaDoor(
      {
        env: { AGENT_DB: undefined, STOCK_COPILOT_PAPER_ENABLED: "true" } as any,
        sql,
        readSettingRaw: () => null,
        audit: auditFn as any,
      },
      "trader_bob",
    );

    expect(result.ok).toBe(true);
    expect(result.userLogin).toBe("trader_bob");
    expect(audits).toHaveLength(1);
    expect(audits[0].type).toBe("stock_copilot.introspect_via_door");
    expect(audits[0].payload.userLogin).toBe("trader_bob");
  });
});

describe("Issue #3588 — MCP Introspect Command", () => {
  it("executes through McpToolCommand interface", async () => {
    const cmd = new StockCopilotIntrospectCommand();
    expect(cmd.name).toBe("stock_copilot_introspect");
    expect(cmd.description).toContain("5-stage execution pipeline");

    const sql = createInMemorySql();
    const audited: any[] = [];
    const context: any = {
      actingLogin: () => "trader_carol",
      env: { AGENT_DB: undefined, STOCK_COPILOT_PAPER_ENABLED: "true" },
      storage: { sql },
      readSettingRaw: () => null,
      audit: (event: string, cat: string, p: any) => audited.push({ event, cat, p }),
    };

    const res = await cmd.execute({}, context);
    expect(res.ok).toBe(true);
    expect(res.userLogin).toBe("trader_carol");
    expect(audited.some((a) => a.event === "stock_copilot_introspect")).toBe(true);
  });
});

describe("Issue #3588 — REST Route GET /stock-copilot/introspect", () => {
  it("returns 401 when unauthenticated", async () => {
    const sql = createInMemorySql();
    const ctx: StockCopilotRouteContext = {
      env: { AGENT_DB: undefined } as any,
      sql,
      getScreenerExecutionContext: async () => undefined,
      readSettingRaw: () => null,
    };

    const req = new Request("http://localhost/stock-copilot/introspect", { method: "GET" });
    const url = new URL(req.url);
    const res = await handleStockCopilotRoutes(req, url, url.pathname, "session-1", ctx);
    expect(res).toBeDefined();
    expect(res!.status).toBe(401);
  });

  it("returns 200 with introspection JSON when authenticated", async () => {
    const sql = createInMemorySql();
    const ctx: StockCopilotRouteContext = {
      env: { AGENT_DB: undefined, STOCK_COPILOT_PAPER_ENABLED: "true" } as any,
      sql,
      getScreenerExecutionContext: async () => ({ userLogin: "trader_dan" }),
      readSettingRaw: () => null,
    };

    const req = new Request("http://localhost/stock-copilot/introspect", { method: "GET" });
    const url = new URL(req.url);
    const res = await handleStockCopilotRoutes(req, url, url.pathname, "session-1", ctx);
    expect(res).toBeDefined();
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(data.ok).toBe(true);
    expect(data.userLogin).toBe("trader_dan");
    expect(data.pipeline).toHaveLength(5);
  });
});
