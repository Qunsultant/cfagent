import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleMCPRequest } from "../src/mcps/openaimp/handler";
import { MCP_SERVER_INFO, MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS } from "../src/mcps/openaimp";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

describe("Model Context Protocol (MCP) Server", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  };
  const auditLogs: any[] = [];
  const auditMock = (type: string, agent: any, payload: Record<string, unknown>) => {
    auditLogs.push({ type, agent, payload });
  };

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
  });

  describe("MCP Initialization & Discovery", () => {
    it("handles initialize method and returns protocol version and capabilities", async () => {
      const resp = await handleMCPRequest(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe(1);
      expect(resp.result?.protocolVersion).toBe(MCP_SERVER_INFO.protocolVersion);
      expect(resp.result?.serverInfo?.name).toBe(MCP_SERVER_INFO.name);
      expect(resp.result?.capabilities?.tools).toBeDefined();
      expect(resp.result?.capabilities?.resources).toBeDefined();
      expect(resp.result?.capabilities?.prompts).toBeDefined();
    });

    it("handles ping method", async () => {
      const resp = await handleMCPRequest(
        { jsonrpc: "2.0", id: 2, method: "ping" },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe(2);
      expect(resp.result).toEqual({});
    });
  });

  describe("MCP Tools (tools/list & tools/call)", () => {
    it("lists all available platform tools", async () => {
      const resp = await handleMCPRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      expect(resp.result?.tools?.length).toBe(MCP_TOOLS.length);
      const names = resp.result.tools.map((t: any) => t.name);
      expect(names).toContain("knowledge_search");
      expect(names).toContain("draft_payment");
      expect(names).toContain("confirm_payment_draft");
      expect(names).toContain("execute_nlq");
      expect(names).toContain("get_async_job");
      expect(names).toContain("list_async_jobs");
      expect(names).toContain("list_database_tables");
      expect(names).toContain("manage_categories");
      expect(names).toContain("manage_external_ads");
      expect(names).toContain("get_revenue_summary");
      expect(names).toContain("manage_session_memory");
    });

    it("executes tool: list_database_tables", async () => {
      const resp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "list_database_tables", arguments: {} },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      expect(resp.result?.isError).toBe(false);
      const parsed = JSON.parse(resp.result.content[0].text);
      expect(parsed.count).toBe(11); // 11 after mas_reports (#278)
      expect(parsed.tables.some((t: any) => t.name === "mas_categories")).toBe(true);
      expect(parsed.tables.some((t: any) => t.name === "mas_trades")).toBe(true);
    });

    it("returns a job ticket immediately for production MCP tool execution", async () => {
      const submitJob = vi.fn().mockResolvedValue({
        jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d",
        status: "queued",
        statusUrl: "/api/jobs/d9643325-6195-4c4a-bc5a-9d9348070e5d",
      });
      const response = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: { name: "list_database_tables", arguments: {} },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock, submitJob }
      );

      expect(submitJob).toHaveBeenCalledWith({
        capability: "mcp.tool",
        payload: {
          toolName: "list_database_tables",
          arguments: {},
        },
        // #3810: MCP submissions stamp trigger "agent" at the queue point.
        trigger: "agent",
      });
      expect(JSON.parse(response.result?.content[0].text)).toMatchObject({
        jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d",
        status: "queued",
      });
    });

    it("keeps async job status tools immediate", async () => {
      const submitJob = vi.fn();
      const getJob = vi.fn().mockReturnValue({
        jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d",
        status: "completed",
        result: { answer: 42 },
      });
      const response = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 31,
          method: "tools/call",
          params: {
            name: "get_async_job",
            arguments: { jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d" },
          },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock, submitJob, getJob }
      );

      expect(submitJob).not.toHaveBeenCalled();
      expect(getJob).toHaveBeenCalledWith("d9643325-6195-4c4a-bc5a-9d9348070e5d");
      expect(JSON.parse(response.result?.content[0].text)).toMatchObject({
        status: "completed",
        result: { answer: 42 },
      });
    });

    it("executes tool: manage_categories (create, list, delete)", async () => {
      // 1. Create
      const createResp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "manage_categories",
            arguments: {
              action: "create",
              name: "Machine Learning Ops",
              icon: "🧪",
              description: "ML pipeline and model serving tools",
            },
          },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const createdData = JSON.parse(createResp.result.content[0].text);
      expect(createdData.success).toBe(true);
      expect(createdData.category.name).toBe("Machine Learning Ops");

      // 2. List
      const listResp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "manage_categories", arguments: { action: "list" } },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const listData = JSON.parse(listResp.result.content[0].text);
      expect(listData.categories.some((c: any) => c.name === "Machine Learning Ops")).toBe(true);

      // 3. Delete
      const deleteResp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "manage_categories", arguments: { action: "delete", id: createdData.category.id } },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const deleteData = JSON.parse(deleteResp.result.content[0].text);
      expect(deleteData.success).toBe(true);
    });

    it("executes tool: manage_external_ads (impression, click, monetization)", async () => {
      const clickResp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "manage_external_ads",
            arguments: { action: "click", id: "ext_ethicalads_dev" },
          },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const clickData = JSON.parse(clickResp.result.content[0].text);
      expect(clickData.success).toBe(true);
      expect(clickData.clicks).toBeGreaterThanOrEqual(1);
    });

    it("executes tool: get_revenue_summary", async () => {
      const resp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "get_revenue_summary", arguments: {} },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const summary = JSON.parse(resp.result.content[0].text);
      expect(summary.grossRevenue).toBeGreaterThan(0);
      expect(summary.adNetworkRevenue).toBeGreaterThan(0);
    });

    it("executes tool: manage_session_memory (remember & list)", async () => {
      const rememberResp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "manage_session_memory",
            arguments: { action: "remember", key: "preferred_currency", value: "EUR" },
          },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const remData = JSON.parse(rememberResp.result.content[0].text);
      expect(remData.success).toBe(true);
      expect(remData.key).toBe("preferred_currency");
    });
  });

  describe("MCP Resources (resources/list & resources/read)", () => {
    it("lists available resources", async () => {
      const resp = await handleMCPRequest(
        { jsonrpc: "2.0", id: 11, method: "resources/list" },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      expect(resp.result?.resources?.length).toBe(MCP_RESOURCES.length);
      const uris = resp.result.resources.map((r: any) => r.uri);
      expect(uris).toContain("sqlite://schema/tables");
      expect(uris).toContain("sqlite://revenue/summary");
      expect(uris).toContain("sqlite://categories/list");
    });

    it("reads resource: sqlite://schema/tables", async () => {
      const resp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "resources/read",
          params: { uri: "sqlite://schema/tables" },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const content = resp.result?.contents?.[0];
      expect(content?.uri).toBe("sqlite://schema/tables");
      const tables = JSON.parse(content?.text);
      expect(tables.length).toBe(11); // 11 after mas_reports (#278)
    });

    it("reads resource: sqlite://revenue/summary", async () => {
      const resp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 13,
          method: "resources/read",
          params: { uri: "sqlite://revenue/summary" },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      const content = resp.result?.contents?.[0];
      const summary = JSON.parse(content?.text);
      expect(summary.grossRevenue).toBeGreaterThan(0);
    });
  });

  describe("MCP Prompts (prompts/list & prompts/get)", () => {
    it("lists available prompts", async () => {
      const resp = await handleMCPRequest(
        { jsonrpc: "2.0", id: 14, method: "prompts/list" },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      expect(resp.result?.prompts?.length).toBe(MCP_PROMPTS.length);
      const names = resp.result.prompts.map((p: any) => p.name);
      expect(names).toContain("audit_security_review");
      expect(names).toContain("revenue_performance_analysis");
    });

    it("retrieves a prompt template by name", async () => {
      const resp = await handleMCPRequest(
        {
          jsonrpc: "2.0",
          id: 15,
          method: "prompts/get",
          params: { name: "audit_security_review" },
        },
        { env: mockEnv, orm, sessionId: "session_1", audit: auditMock }
      );

      expect(resp.result?.messages?.length).toBeGreaterThan(0);
    });
  });
});
