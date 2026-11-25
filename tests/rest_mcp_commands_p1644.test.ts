/**
 * #1644 (parent #1638, doc §8): REST handlers call IMcpToolCommand
 * execution methods directly — one execution path per command.
 *
 * Pins, per reduced command:
 *  (a) DELEGATION: the route dispatches through McpToolFactory.executeTool
 *      (proven by spying on executeTool and returning canned command
 *      output — on pre-refactor code the spy is never called, so these
 *      tests are the TDD Red for this slice);
 *  (b) CONTRACT: with a real DatabaseORM over MockSqlStorage, the route
 *      response shapes are preserved exactly (shaping, clamps, filters,
 *      stats) before and after the refactor.
 *
 * Deliberately NOT reduced here (see issue map, comment 6412639447):
 * payments create/confirm (different money-flow operations), categories /
 * referrals / external ads (divergent defaults, id schemes, money
 * defaults, error semantics), execute_nlq (route auth gate + port wiring
 * the command lacks), and commands with no REST pair.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { runRestTool } from "../src/agents/routes/restToolBridge";
import { handleSchemaRoutes } from "../src/agents/routes/schema";
import { handleAdsRevenueReferralsRoutes } from "../src/agents/routes/adsRevenueReferrals";
import { handleAuditRoutes } from "../src/agents/routes/audit";
import { handleMemoryResetRoutes } from "../src/agents/routes/memoryReset";
import { handlePaymentsRoutes } from "../src/agents/routes/payments";
import type { Env } from "../src/types";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";
import type { AuditEvent } from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

const setup = () => {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  const audit = vi.fn();
  return { sql, orm, audit };
};

/** Spy executeTool: route the named tool to canned output, nothing else. */
const cannedTool = (canned: Record<string, unknown>) => {
  const spy = vi.spyOn(McpToolFactory, "executeTool");
  spy.mockImplementation(async (name: string) => {
    if (!(name in canned)) throw new Error(`unexpected tool in test: ${name}`);
    return canned[name];
  });
  return spy;
};

describe("delegation: reduced routes execute through IMcpToolCommand", () => {
  it("GET /schema/tables returns command output, not a direct ORM read", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({ list_database_tables: { count: 3, tables: ["cmd_a"] } });
    const res = await handleSchemaRoutes(req("GET", "/api/schema/tables"), urlOf("/api/schema/tables"), "/api/schema/tables", "s1", {
      getOrm: () => orm,
    } as never);
    expect(res).not.toBeNull();
    expect(await res!.json()).toEqual({ count: 3, tables: ["cmd_a"] });
    expect(spy).toHaveBeenCalledWith("list_database_tables", {}, expect.anything());
    expect(audit).not.toHaveBeenCalled();
  });

  it("POST /schema/query defaults the table to mas_categories at the route", async () => {
    const { orm } = setup();
    const spy = cannedTool({ query_table_data: { tableName: "mas_categories", rows: [{ cmd: 1 }], total: 1 } });
    const res = await handleSchemaRoutes(req("POST", "/api/schema/query", {}), urlOf("/api/schema/query"), "/api/schema/query", "s1", {
      getOrm: () => orm,
    } as never);
    expect(await res!.json()).toEqual({ tableName: "mas_categories", rows: [{ cmd: 1 }], total: 1 });
    expect(spy).toHaveBeenCalledWith(
      "query_table_data",
      expect.objectContaining({ tableName: "mas_categories" }),
      expect.anything()
    );
  });

  it("GET /revenue returns the get_revenue_summary command output", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({ get_revenue_summary: { totalRevenue: 4242 } });
    const res = await handleAdsRevenueReferralsRoutes(req("GET", "/api/revenue"), urlOf("/api/revenue"), "/api/revenue", "s1", {
      getOrm: () => orm,
      ensureTables: () => sql,
      audit,
    } as never);
    expect(await res!.json()).toEqual({ totalRevenue: 4242 });
    expect(spy).toHaveBeenCalledWith("get_revenue_summary", {}, expect.anything());
  });

  it("GET /payments/gateways keeps its 3-field shape from the command", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({
      get_payment_gateways: {
        gateways: [{ gatewayId: "cmd-gw" }],
        agentDids: { X: "did:x" },
        userDid: "did:user",
        count: 1,
      },
    });
    const res = await handlePaymentsRoutes(req("GET", "/api/payments/gateways"), urlOf("/api/payments/gateways"), "/api/payments/gateways", "s1", {
      env: {} as Env,
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
    } as never);
    expect(await res!.json()).toEqual({
      gateways: [{ gatewayId: "cmd-gw" }],
      agentDids: { X: "did:x" },
      userDid: "did:user",
    });
    expect(spy).toHaveBeenCalledWith("get_payment_gateways", {}, expect.anything());
  });

  it("GET /payments/transactions maps command rows and keeps summary stats", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({
      get_transactions: {
        count: 1,
        transactions: [
          {
            id: "cmd-tx", sessionId: "s1", action: "charge", amount: 10, currency: "USD",
            customer: "C", gateway: "stripe", gatewayRef: "", status: "completed",
            checkoutUrl: "", proposerDid: "did:p", authorizerDid: "did:a",
            proofSignature: "sig", note: "n", createdAt: "t1", updatedAt: "t2",
          },
        ],
      },
    });
    const res = await handlePaymentsRoutes(req("GET", "/api/payments/transactions"), urlOf("/api/payments/transactions"), "/api/payments/transactions", "s1", {
      env: {} as Env,
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
    } as never);
    const body = await res!.json();
    expect(body.transactions[0].id).toBe("cmd-tx");
    expect(body.summary).toEqual({ totalVolume: 10, completedCount: 1, pendingCount: 0, verifiedDidCount: 1 });
    // #1728: the route carries its resolved mode as the command's run
    // value, so the delegation call now includes mode: "rest" (the
    // route legacy). The row-mapping + summary contract above is
    // unchanged; only the call shape gained the mode carrier.
    expect(spy).toHaveBeenCalledWith("get_transactions", { limit: 50, mode: "rest" }, expect.anything());
  });

  it("GET /audit filters by session, parses payloads, and clamps the limit", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({
      get_audit_events: {
        count: 2,
        events: [
          { id: "e1", sessionId: "s1", type: "t", agent: "a", payload: '{"k":1}', createdAt: "t1" },
          { id: "e2", sessionId: "other", type: "t", agent: "a", payload: '{"k":2}', createdAt: "t2" },
        ],
      },
    });
    const res = await handleAuditRoutes(req("GET", "/api/audit?limit=2"), urlOf("/api/audit?limit=2"), "/api/audit", "s1", {
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
      recordAudit: () => ({ id: "x", type: "t", agent: "a", payload: {}, created_at: "t" }),
    } as never);
    // Old REST shape preserved exactly, plus the #2371 additive field:
    // 5 stored fields, created_at snake_case, sessionId projected out,
    // payload JSON-parsed, and resolvedAspects (null here — payload
    // { k: 1 } carries no cataloged code). The pin update rides the
    // #2371 slice that added the field; the filter/parse/clamp
    // contract below is unchanged.
    expect(await res!.json()).toEqual({
      count: 1,
      events: [{ id: "e1", type: "t", agent: "a", payload: { k: 1 }, created_at: "t1", resolvedAspects: null }],
    });
    // #1968: the route passes its query params into the command (here
    // just the limit) instead of the old empty input — filtering happens
    // in the command, before the limit is applied.
    expect(spy).toHaveBeenCalledWith("get_audit_events", { limit: 2 }, expect.anything());
  });

  it("GET /memory returns command memories, sliced to 100", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({
      manage_session_memory: {
        count: 2,
        memories: [
          { key: "k1", value: "v1", updatedAt: "u1" },
          { key: "k2", value: "v2", updatedAt: "u2" },
        ],
      },
    });
    const res = await handleMemoryResetRoutes(req("GET", "/api/memory"), urlOf("/api/memory"), "/api/memory", "s1", {
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
      abortAllRequests: () => {},
      resetTurnState: () => {},
      clearConversationMessages: async () => {},
    } as never);
    expect(await res!.json()).toEqual({
      count: 2,
      memories: [
        { key: "k1", value: "v1", updatedAt: "u1" },
        { key: "k2", value: "v2", updatedAt: "u2" },
      ],
    });
    expect(spy).toHaveBeenCalledWith("manage_session_memory", { action: "list" }, expect.anything());
  });

  it("DELETE /memory?key= deletes through the command and keeps its audit", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({ manage_session_memory: { success: true, deleted: true, key: "k1" } });
    const res = await handleMemoryResetRoutes(req("DELETE", "/api/memory?key=k1"), urlOf("/api/memory?key=k1"), "/api/memory", "s1", {
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
      abortAllRequests: () => {},
      resetTurnState: () => {},
      clearConversationMessages: async () => {},
    } as never);
    expect(await res!.json()).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith("manage_session_memory", { action: "delete", key: "k1" }, expect.anything());
    expect(audit).toHaveBeenCalledWith("memory.deleted", "memory", { key: "k1" });
  });

  it("DELETE /memory clears through the command and keeps its audit", async () => {
    const { sql, orm, audit } = setup();
    const spy = cannedTool({ manage_session_memory: { success: true, cleared: true } });
    const res = await handleMemoryResetRoutes(req("DELETE", "/api/memory"), urlOf("/api/memory"), "/api/memory", "s1", {
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
      abortAllRequests: () => {},
      resetTurnState: () => {},
      clearConversationMessages: async () => {},
    } as never);
    expect(await res!.json()).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith("manage_session_memory", { action: "clear" }, expect.anything());
    expect(audit).toHaveBeenCalledWith("memory.cleared", "memory", {});
  });
});

describe("contract: real ORM, seeded rows, shapes preserved", () => {
  it("GET /payments/transactions keeps mapping + summary stats", async () => {
    const { sql, orm, audit } = setup();
    orm.transactions.create({
      id: "tx1", sessionId: "s1", action: "charge", amount: 100, currency: "USD",
      customer: "C", gateway: "stripe", gatewayRef: "", status: "completed",
      checkoutUrl: "", proposerDid: "did:p", authorizerDid: "did:a",
      proofSignature: "sig", note: "", createdAt: "t1", updatedAt: "t1",
    });
    orm.transactions.create({
      id: "tx2", sessionId: "s1", action: "refund", amount: 30, currency: "USD",
      customer: "C", gateway: "stripe", gatewayRef: "", status: "completed",
      checkoutUrl: "", proposerDid: "did:p", authorizerDid: "did:a",
      proofSignature: "sig", note: "", createdAt: "t2", updatedAt: "t2",
    });
    orm.transactions.create({
      id: "tx3", sessionId: "s1", action: "charge", amount: 50, currency: "USD",
      customer: "C", gateway: "stripe", gatewayRef: "", status: "awaiting_confirmation",
      checkoutUrl: "", proposerDid: "did:p", authorizerDid: "did:a",
      proofSignature: "sig", note: "", createdAt: "t3", updatedAt: "t3",
    });
    const res = await handlePaymentsRoutes(req("GET", "/api/payments/transactions"), urlOf("/api/payments/transactions"), "/api/payments/transactions", "s1", {
      env: {} as Env,
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
    } as never);
    const body = await res!.json();
    expect(body.count).toBe(3);
    expect(body.summary).toEqual({ totalVolume: 70, completedCount: 2, pendingCount: 1, verifiedDidCount: 3 });
    expect(body.transactions[0].id).toBe("tx3");
  });

  it("GET /audit keeps session filter, payload parse, and limit clamp", async () => {
    const { sql, orm, audit } = setup();
    // #6102: the event log lives in D1 now — seeded through the real
    // chained store; the route passes its env to the command.
    const mock = new MockD1Database();
    const store = new D1AuditEventStore(createD1AuditEventDb(mock as never));
    const mk = (id: string, sessionId: string, createdAt: string) =>
      store.create({
        id,
        sessionId,
        type: "t",
        agent: "a",
        payload: JSON.stringify({ k: id }),
        createdAt,
      } as unknown as AuditEvent);
    await mk("e1", "s1", "t1");
    await mk("e2", "s1", "t2");
    await mk("e3", "s1", "t3");
    await mk("eX", "other", "t4");
    const ctx = {
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
      recordAudit: () => ({ id: "x", type: "t", agent: "a", payload: {}, created_at: "t" }),
      env: { AGENT_DB: mock },
    } as never;
    const limited = await handleAuditRoutes(req("GET", "/api/audit?limit=2"), urlOf("/api/audit?limit=2"), "/api/audit", "s1", ctx);
    const limitedBody = await limited!.json();
    expect(limitedBody.count).toBe(2);
    expect(limitedBody.events.map((e: any) => e.id)).toEqual(["e3", "e2"]);
    expect(limitedBody.events[0].payload).toEqual({ k: "e3" });
    const all = await handleAuditRoutes(req("GET", "/api/audit?limit=5000"), urlOf("/api/audit?limit=5000"), "/api/audit", "s1", ctx);
    expect((await all!.json()).count).toBe(3);
  });

  it("GET /memory caps at 100, newest first", async () => {
    const { sql, orm, audit } = setup();
    for (let i = 0; i < 105; i++) {
      orm.memory.create({ key: `k${i}`, value: `v${i}`, updatedAt: `u${String(i).padStart(3, "0")}` });
    }
    const res = await handleMemoryResetRoutes(req("GET", "/api/memory"), urlOf("/api/memory"), "/api/memory", "s1", {
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
      abortAllRequests: () => {},
      resetTurnState: () => {},
      clearConversationMessages: async () => {},
    } as never);
    const body = await res!.json();
    expect(body.count).toBe(100);
    expect(body.memories[0].key).toBe("k104");
  });

  it("DELETE /memory?key= and DELETE /memory remove rows and audit", async () => {
    const { sql, orm, audit } = setup();
    orm.memory.create({ key: "k1", value: "v1", updatedAt: "u1" });
    orm.memory.create({ key: "k2", value: "v2", updatedAt: "u2" });
    const ctx = {
      ensureTables: () => sql,
      getOrm: () => orm,
      audit,
      abortAllRequests: () => {},
      resetTurnState: () => {},
      clearConversationMessages: async () => {},
    } as never;
    const del = await handleMemoryResetRoutes(req("DELETE", "/api/memory?key=k1"), urlOf("/api/memory?key=k1"), "/api/memory", "s1", ctx);
    expect(await del!.json()).toEqual({ success: true });
    expect(orm.memory.findById("k1")).toBeNull();
    expect(orm.memory.findById("k2")).not.toBeNull();
    expect(audit).toHaveBeenCalledWith("memory.deleted", "memory", { key: "k1" });
    const clear = await handleMemoryResetRoutes(req("DELETE", "/api/memory"), urlOf("/api/memory"), "/api/memory", "s1", ctx);
    expect(await clear!.json()).toEqual({ success: true });
    expect(orm.memory.findMany()).toEqual([]);
    expect(audit).toHaveBeenCalledWith("memory.cleared", "memory", {});
  });

  it("POST /schema/query with no table queries mas_categories", async () => {
    const { orm } = setup();
    orm.categories.create({
      id: "c1", name: "Cat", slug: "cat", description: "d", icon: "🏷️",
      isActive: true, sortOrder: 1, createdAt: "t", updatedAt: "t",
    });
    const res = await handleSchemaRoutes(req("POST", "/api/schema/query", {}), urlOf("/api/schema/query"), "/api/schema/query", "s1", {
      getOrm: () => orm,
    } as never);
    const body = await res!.json();
    expect(body.tableName).toBe("mas_categories");
    expect(body.rows.some((r: any) => r.id === "c1")).toBe(true);
  });

  it("GET /revenue passes the ORM summary through", async () => {
    const { sql, orm, audit } = setup();
    const expected = orm.getRevenueSummary();
    const res = await handleAdsRevenueReferralsRoutes(req("GET", "/api/revenue"), urlOf("/api/revenue"), "/api/revenue", "s1", {
      getOrm: () => orm,
      ensureTables: () => sql,
      audit,
    } as never);
    expect(await res!.json()).toEqual(expected);
  });
});

describe("bridge: restToolBridge dispatches by command name", () => {
  it("runs a real command against the route orm", async () => {
    const { sql, orm, audit } = setup();
    const out = await runRestTool("get_revenue_summary", {}, { orm, sessionId: "s1", audit });
    expect(out).toEqual(orm.getRevenueSummary());
  });

  it("rejects an unregistered tool name like the factory", async () => {
    const { sql, orm, audit } = setup();
    await expect(runRestTool("no_such_tool", {}, { orm, sessionId: "s1", audit })).rejects.toThrow(
      "MCP Tool 'no_such_tool' is not registered"
    );
  });

  it("source pin: reduced routes dispatch through the bridge, not inline queries", async () => {
    const { readFileSync } = await import("node:fs");
    const schemaSrc = readFileSync("src/agents/routes/schema.ts", "utf8");
    expect(schemaSrc).toContain("runRestTool");
    expect(schemaSrc).not.toContain("orm.listTables()");
    expect(schemaSrc).not.toContain("orm.getTableData(");
    const auditSrc = readFileSync("src/agents/routes/audit.ts", "utf8");
    expect(auditSrc).toContain("runRestTool");
    expect(auditSrc).not.toContain("FROM mas_events WHERE session_id");
    const memorySrc = readFileSync("src/agents/routes/memoryReset.ts", "utf8");
    expect(memorySrc).toContain("runRestTool");
    expect(memorySrc).not.toContain("FROM mas_memory ORDER BY");
    const paymentsSrc = readFileSync("src/agents/routes/payments.ts", "utf8");
    expect(paymentsSrc).toContain("executeMCPTool");
    expect(paymentsSrc).not.toContain("FROM mas_transactions ORDER BY created_at DESC LIMIT 50");
  });
});
