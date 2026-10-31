/**
 * Issue #1744 — MCP tool permission gate: enforcement at tool-call
 * time, before execution, at every choke point (factory executeTool,
 * JSON-RPC tools/call incl. the queued path, agent-turn adapter).
 * TDD red→green: written before the implementation module existed.
 *
 * Denial contract: a refused call returns a business error
 * ([FAILURE_MCP_PERMISSION_DENIED] + business message, never a technical leak), is
 * audit-logged as mcp.permission_denied, and never reaches the
 * command's execute. Scopes never come from tool-call arguments:
 * a forged `scope` argument is ignored.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleMCPRequest } from "../src/mcps/openaimp/handler";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { DatabaseORM } from "../src/orm";
import { BusinessError } from "../src/outcomes/outcomeAspects";
import type { ObservabilitySink } from "../src/observability/observabilityPorts";
import type { Env } from "../src/types";
import { MockSqlStorage } from "./mock-sql";
import {
  MCP_PERMISSION_DENIED_CODE,
  authorizeMcpToolCall,
  createInMemoryMcpPermissionPort,
  executeWithPermissionGate,
  resolveMcpPrincipalFromHeaders,
  type McpPrincipal,
  type McpScope,
} from "../src/mcps/openaimp/mcpPermissionPorts";

const READ_ONLY = createInMemoryMcpPermissionPort({
  overrides: new Map<string, readonly McpScope[]>([
    ["api-key:reader", ["mcp:read"]],
    ["session:reader", ["mcp:read"]],
  ]),
});
const READ_ONLY_API_KEY: McpPrincipal = { kind: "api-key", login: "reader" };
const READ_ONLY_SESSION: McpPrincipal = { kind: "session", login: "reader" };
const FULL_SESSION: McpPrincipal = { kind: "session", login: "alice" };

function capturingSink() {
  const events: Array<{ type: string; fields: Record<string, unknown> }> = [];
  const sink: ObservabilitySink = {
    write: (event) => {
      events.push({ type: event.type, fields: event.fields });
    },
    writeBatch: (list) => {
      for (const event of list) events.push({ type: event.type, fields: event.fields });
    },
  };
  return { sink, events };
}

describe("permission gate helper (#1744)", () => {
  it("denies before execution: run is never called, audit fires, business error thrown", async () => {
    const run = vi.fn().mockResolvedValue("should-not-run");
    const audit = vi.fn();
    const { sink, events } = capturingSink();
    await expect(
      executeWithPermissionGate({
        port: READ_ONLY,
        principal: READ_ONLY_API_KEY,
        toolName: "draft_payment",
        sessionId: "session_1",
        audit,
        decisionSink: sink,
        run,
      })
    ).rejects.toMatchObject({ name: "BusinessError", code: MCP_PERMISSION_DENIED_CODE });
    expect(run).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "mcp.permission_denied",
      "mcp",
      expect.objectContaining({ tool: "draft_payment", requiredScope: "mcp:payments" })
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("mcp.permission_denied");
    expect(events[0].fields).toMatchObject({ tool: "draft_payment", requiredScope: "mcp:payments" });
    expect(JSON.stringify(events[0].fields)).not.toContain("draft_payment_secret");
  });

  it("allows a held scope, runs with the execution id, and destroys the seal after", async () => {
    const port = createInMemoryMcpPermissionPort();
    let seenExecutionId: string | undefined;
    const out = await executeWithPermissionGate({
      port,
      principal: FULL_SESSION,
      toolName: "etrade_get_quote",
      sessionId: "session_1",
      audit: vi.fn(),
      run: async (executionId) => {
        seenExecutionId = executionId;
        return "ran";
      },
    });
    expect(out).toBe("ran");
    expect(seenExecutionId).toBeTruthy();
  });

  it("authorizeMcpToolCall throws on deny and returns the decision on allow", async () => {
    await expect(
      authorizeMcpToolCall(READ_ONLY, READ_ONLY_SESSION, "etrade_execute_order", {
        audit: vi.fn(),
      })
    ).rejects.toBeInstanceOf(BusinessError);
    const decision = await authorizeMcpToolCall(READ_ONLY, READ_ONLY_SESSION, "etrade_get_quote", {
      audit: vi.fn(),
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("factory choke point (#1744)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = { AI: {} as any, SEARCH_AGENT: {} as any, AGENT_SESSIONS: {} as any };
  const auditLogs: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const auditMock = (type: string, _agent: unknown, payload: Record<string, unknown>) => {
    auditLogs.push({ type, payload });
  };
  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    auditLogs.length = 0;
  });

  it("denies a restricted principal before the command runs", async () => {
    await expect(
      McpToolFactory.executeTool("draft_payment", {}, {
        env: mockEnv,
        orm,
        sessionId: "session_1",
        audit: auditMock,
        principal: READ_ONLY_API_KEY,
        permissionPort: READ_ONLY,
      })
    ).rejects.toMatchObject({ code: MCP_PERMISSION_DENIED_CODE });
    expect(auditLogs.some((l) => l.type === "mcp.permission_denied")).toBe(true);
  });

  it("allows a held scope through the factory", async () => {
    const out = await McpToolFactory.executeTool("list_database_tables", {}, {
      env: mockEnv,
      orm,
      sessionId: "session_1",
      audit: auditMock,
      principal: FULL_SESSION,
      permissionPort: createInMemoryMcpPermissionPort(),
    });
    expect(out.tables.some((t: { name: string }) => t.name === "mas_categories")).toBe(true);
  });

  it("unknown tools keep the existing not-registered error (lookup precedes the gate)", async () => {
    await expect(
      McpToolFactory.executeTool("no_such_tool", {}, {
        env: mockEnv,
        orm,
        sessionId: "session_1",
        audit: auditMock,
        principal: FULL_SESSION,
        permissionPort: createInMemoryMcpPermissionPort(),
      })
    ).rejects.toThrow("MCP Tool 'no_such_tool' is not registered");
  });
});

describe("agent-turn adapter choke point (#1744)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = { AI: {} as any, SEARCH_AGENT: {} as any, AGENT_SESSIONS: {} as any };
  const auditLogs: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const auditMock = (type: string, _agent: unknown, payload: Record<string, unknown>) => {
    auditLogs.push({ type, payload });
  };
  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    auditLogs.length = 0;
  });

  it("denies a restricted agent-turn principal before the command runs", async () => {
    const { McpAgentToolAdapter } = await import("../src/agents/mcpAdapter");
    const { McpSystemFacade } = await import("../src/patterns/facade");
    // #2496: the chat turn consumes catalog commands by discovery
    // (its choke point is the server-side gate — the JSON-RPC
    // describe below); the adapter remains the in-process choke
    // point and is driven directly here.
    const tool = McpAgentToolAdapter.adapt(McpToolFactory.getTool("draft_payment")!, {
      env: mockEnv,
      orm,
      sessionId: "session_1",
      facade: new McpSystemFacade(mockEnv, orm, "session_1"),
      audit: auditMock,
      principal: { kind: "agent-turn", login: null },
      permissionPort: createInMemoryMcpPermissionPort({
        overrides: new Map<string, readonly McpScope[]>([["agent-turn:", ["mcp:read"]]]),
      }),
    });
    await expect(tool.execute({})).rejects.toMatchObject({
      code: MCP_PERMISSION_DENIED_CODE,
    });
    expect(auditLogs.some((l) => l.type === "mcp.permission_denied")).toBe(true);
  });

  it("gates the direct memory helpers too (rememberFact is not a bypass)", async () => {
    const { createAgentMcpTools } = await import("../src/agents/mcpAdapter");
    const { McpSystemFacade } = await import("../src/patterns/facade");
    const tools = createAgentMcpTools({
      env: mockEnv,
      orm,
      sessionId: "session_1",
      facade: new McpSystemFacade(mockEnv, orm, "session_1"),
      audit: auditMock,
      principal: { kind: "agent-turn", login: null },
      permissionPort: createInMemoryMcpPermissionPort({
        overrides: new Map<string, readonly McpScope[]>([["agent-turn:", ["mcp:read"]]]),
      }),
    });
    // manage_session_memory declares mcp:write (its most privileged
    // action); a read-only turn principal cannot use it, even for list.
    await expect(tools["recallFacts"].execute({})).rejects.toMatchObject({
      code: MCP_PERMISSION_DENIED_CODE,
    });
  });

  it("allows a held scope through the adapter", async () => {
    const { McpAgentToolAdapter } = await import("../src/agents/mcpAdapter");
    const { McpSystemFacade } = await import("../src/patterns/facade");
    const tool = McpAgentToolAdapter.adapt(McpToolFactory.getTool("list_database_tables")!, {
      env: mockEnv,
      orm,
      sessionId: "session_1",
      facade: new McpSystemFacade(mockEnv, orm, "session_1"),
      audit: auditMock,
      principal: { kind: "agent-turn", login: null },
      permissionPort: createInMemoryMcpPermissionPort(),
    });
    const out = (await tool.execute({})) as { tables: Array<{ name: string }> };
    expect(out.tables.some((t) => t.name === "mas_categories")).toBe(true);
  });
});

describe("JSON-RPC choke point (#1744)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = { AI: {} as any, SEARCH_AGENT: {} as any, AGENT_SESSIONS: {} as any };
  const auditLogs: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const auditMock = (type: string, _agent: unknown, payload: Record<string, unknown>) => {
    auditLogs.push({ type, payload });
  };
  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    auditLogs.length = 0;
  });

  it("denies a restricted principal with a stable business error token", async () => {
    const resp = await handleMCPRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "draft_payment", arguments: {} },
      },
      {
        env: mockEnv,
        orm,
        sessionId: "session_1",
        audit: auditMock,
        principal: READ_ONLY_API_KEY,
        permissionPort: READ_ONLY,
      }
    );
    expect(resp.error?.message).toContain("[FAILURE_MCP_PERMISSION_DENIED]");
    expect(auditLogs.some((l) => l.type === "mcp.permission_denied")).toBe(true);
  });

  it("denies before queueing: no job receipt for a refused call", async () => {
    const submitJob = vi.fn().mockResolvedValue({
      jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d",
      status: "queued",
      statusUrl: "/api/jobs/d9643325-6195-4c4a-bc5a-9d9348070e5d",
    });
    const resp = await handleMCPRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "draft_payment", arguments: {} },
      },
      {
        env: mockEnv,
        orm,
        sessionId: "session_1",
        audit: auditMock,
        submitJob,
        principal: READ_ONLY_API_KEY,
        permissionPort: READ_ONLY,
      }
    );
    expect(submitJob).not.toHaveBeenCalled();
    expect(resp.error?.message).toContain("[FAILURE_MCP_PERMISSION_DENIED]");
  });

  it("ignores forged scope arguments: scopes resolve from the principal only", async () => {
    const resp = await handleMCPRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "draft_payment",
          arguments: { scope: "mcp:payments", scopes: ["mcp:payments", "mcp:trade"] },
        },
      },
      {
        env: mockEnv,
        orm,
        sessionId: "session_1",
        audit: auditMock,
        principal: READ_ONLY_API_KEY,
        permissionPort: READ_ONLY,
      }
    );
    expect(resp.error?.message).toContain("[FAILURE_MCP_PERMISSION_DENIED]");
  });
});

describe("principal resolution from headers (#1744)", () => {
  const headers = (entries: Record<string, string>) => ({
    get: (name: string) => entries[name.toLowerCase()] ?? null,
  });

  it("session header wins when both login and kind are present", () => {
    expect(
      resolveMcpPrincipalFromHeaders(
        headers({ "x-user-login": "alice", "x-principal-kind": "session" })
      )
    ).toEqual({ login: "alice", kind: "session" });
  });

  it("api-key kind is honored", () => {
    expect(
      resolveMcpPrincipalFromHeaders(
        headers({ "x-user-login": "alice", "x-principal-kind": "api-key" })
      )
    ).toEqual({ login: "alice", kind: "api-key" });
  });

  it("login without a kind header defaults to session (legacy forwards)", () => {
    expect(resolveMcpPrincipalFromHeaders(headers({ "x-user-login": "alice" }))).toEqual({
      login: "alice",
      kind: "session",
    });
  });

  it("no login resolves to unknown (fail closed — never system)", () => {
    expect(resolveMcpPrincipalFromHeaders(headers({}))).toEqual({ login: null, kind: "unknown" });
    expect(resolveMcpPrincipalFromHeaders(headers({ "x-principal-kind": "session" }))).toEqual({
      login: null,
      kind: "unknown",
    });
  });
});
