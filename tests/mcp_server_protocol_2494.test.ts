/**
 * Issue #2494 (MCP server slice) — protocol-level acceptance battery for
 * the /mcp server, written BEFORE the SDK handler swap (gitops §7:
 * characterization first, then keep green across the change).
 *
 * The battery drives the server's JSON-RPC surface through ONE seam:
 * `send()`. In the first (red/green-characterization) step the seam
 * calls the hand-rolled `handleMCPRequest`; after the swap the same
 * seam drives the SDK HTTP handler (`handleOpenaimpMcpHttpRequest`)
 * with real Request objects and parses the JSON response back. The
 * assertions below never change — they ARE the parity contract:
 *
 * - identical catalog (names, schemas) on tools/list;
 * - identical initialize/ping/resources/prompts shapes;
 * - identical execution carriage (sync execution vs queued
 *   `mcp.tool` job receipts);
 * - identical error contract: permission denial and execution
 *   failures as JSON-RPC errors at -32000 carrying the business
 *   message (denials carry [FAILURE_MCP_PERMISSION_DENIED], #1744 /
 *   #1763), invalid params at -32602, unknown method/prompt at
 *   -32601;
 * - the mesh door's identity refusal (run_stock_screen with no
 *   acting identity) surfaces as -32000 with the refusal text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_INFO,
  MCP_TOOLS,
} from "../src/mcps/openaimp";
import { handleOpenaimpMcpHttpRequest } from "../src/mcps/openaimp/handler";
import {
  createInMemoryMcpPermissionPort,
  createProductionMcpPermissionPort,
  type McpPrincipal,
} from "../src/mcps/openaimp/mcpPermissionPorts";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const SESSION: McpPrincipal = { kind: "session", login: "alice" };
const ANONYMOUS: McpPrincipal = { kind: "unknown", login: null };
const READ_ONLY_PORT = createInMemoryMcpPermissionPort({
  overrides: new Map<string, readonly string[]>([["session:reader", ["mcp:read"]]]),
} as any);
const READER: McpPrincipal = { kind: "session", login: "reader" };

interface SendOverrides {
  principal?: McpPrincipal;
  permissionPort?: unknown;
  submitJob?: (job: any) => Promise<any>;
  getJob?: (jobId: string) => unknown;
  listJobs?: () => unknown[];
}

describe("MCP server protocol acceptance (#2494)", () => {
  let orm: DatabaseORM;
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  };
  const auditMock = vi.fn();

  beforeEach(() => {
    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    auditMock.mockClear();
  });

  /**
   * THE SEAM — written against the hand-rolled handleMCPRequest for
   * the characterization step (14/14 green), then repointed here at
   * the SDK HTTP handler for the swap step. The assertions below did
   * not change between the two runs: that is the parity evidence.
   */
  async function send(msg: Record<string, unknown>, overrides: SendOverrides = {}): Promise<any> {
    const context = {
      env: mockEnv,
      orm,
      sessionId: "session_1",
      audit: auditMock as any,
      principal: overrides.principal ?? SESSION,
      permissionPort: (overrides.permissionPort as any) ?? createProductionMcpPermissionPort(),
      ...(overrides.submitJob ? { submitJob: overrides.submitJob } : {}),
      ...(overrides.getJob ? { getJob: overrides.getJob } : {}),
      ...(overrides.listJobs ? { listJobs: overrides.listJobs } : {}),
    } as any;
    const request = new Request("https://agent.internal/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(msg),
    });
    const response = await handleOpenaimpMcpHttpRequest(request, context);
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : { __emptyHttpResponse: response.status };
  }

  it("initialize returns the negotiated 2024-11-05 protocol version, server info and capabilities", async () => {
    const resp = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "acceptance-probe", version: "0" },
      },
    });
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.error).toBeUndefined();
    expect(resp.result.protocolVersion).toBe("2024-11-05");
    expect(resp.result.serverInfo.name).toBe(MCP_SERVER_INFO.name);
    expect(resp.result.serverInfo.version).toBe(MCP_SERVER_INFO.version);
    expect(resp.result.capabilities.tools).toBeDefined();
    expect(resp.result.capabilities.resources).toBeDefined();
    expect(resp.result.capabilities.prompts).toBeDefined();
  });

  it("ping returns an empty result", async () => {
    const resp = await send({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({});
  });

  it("tools/list returns the identical catalog (names + schemas)", async () => {
    const resp = await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect(resp.error).toBeUndefined();
    expect(resp.result.tools.length).toBe(MCP_TOOLS.length);
    const byName = (list: any[]) =>
      [...list].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(resp.result.tools)).toEqual(byName(MCP_TOOLS as any[]));
    expect(resp.result.tools.map((t: any) => t.name)).toContain("run_stock_screen");
    expect(resp.result.tools.map((t: any) => t.name)).toContain("execute_nlq");
  });

  it("tools/call executes synchronously without a job submitter", async () => {
    const resp = await send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_database_tables", arguments: {} },
    });
    expect(resp.error).toBeUndefined();
    expect(resp.result.isError).toBe(false);
    expect(resp.result.content[0].type).toBe("text");
    const parsed = JSON.parse(resp.result.content[0].text);
    expect(parsed.tables.some((t: any) => t.name === "mas_categories")).toBe(true);
  });

  it("tools/call queues a durable mcp.tool job when a submitter is present (execution carriage)", async () => {
    const receipt = {
      jobId: "d9643325-6195-4c4a-bc5a-9d9348070e5d",
      status: "queued",
      statusUrl: "/api/jobs/d9643325-6195-4c4a-bc5a-9d9348070e5d",
    };
    const submitJob = vi.fn().mockResolvedValue(receipt);
    const resp = await send(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "list_database_tables", arguments: {} },
      },
      { submitJob }
    );
    expect(resp.error).toBeUndefined();
    expect(submitJob).toHaveBeenCalledWith({
      capability: "mcp.tool",
      payload: { toolName: "list_database_tables", arguments: {} },
    });
    expect(JSON.parse(resp.result.content[0].text)).toEqual(receipt);
  });

  it("refuses an anonymous caller at the gate before any job is queued", async () => {
    const submitJob = vi.fn().mockResolvedValue({ jobId: "x", status: "queued", statusUrl: "/x" });
    const resp = await send(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "list_database_tables", arguments: {} },
      },
      { principal: ANONYMOUS, submitJob }
    );
    expect(submitJob).not.toHaveBeenCalled();
    expect(resp.result).toBeUndefined();
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toContain("[FAILURE_MCP_PERMISSION_DENIED]");
  });

  it("refuses a read-only principal calling a write-scoped tool (sync path)", async () => {
    const resp = await send(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "draft_payment", arguments: {} },
      },
      { principal: READER, permissionPort: READ_ONLY_PORT }
    );
    expect(resp.result).toBeUndefined();
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toContain("[FAILURE_MCP_PERMISSION_DENIED]");
  });

  it("surfaces the mesh door identity refusal for run_stock_screen with no acting identity", async () => {
    const resp = await send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "run_stock_screen", arguments: {} },
    });
    expect(resp.result).toBeUndefined();
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toContain("acting identity");
  });

  it("tools/call without a name is an invalid-params error at -32602", async () => {
    const resp = await send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { arguments: {} },
    });
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toBe("Invalid params: 'name' is required");
  });

  it("resources/list and resources/read match the catalog and the read contract", async () => {
    const list = await send({ jsonrpc: "2.0", id: 10, method: "resources/list", params: {} });
    expect(list.error).toBeUndefined();
    expect(list.result.resources.length).toBe(MCP_RESOURCES.length);

    const read = await send({
      jsonrpc: "2.0",
      id: 11,
      method: "resources/read",
      params: { uri: "sqlite://schema/tables" },
    });
    expect(read.error).toBeUndefined();
    expect(read.result.contents[0].uri).toBe("sqlite://schema/tables");
    expect(read.result.contents[0].mimeType).toBe("application/json");
    expect(() => JSON.parse(read.result.contents[0].text)).not.toThrow();
  });

  it("resources/read without a uri is an invalid-params error at -32602", async () => {
    const resp = await send({ jsonrpc: "2.0", id: 12, method: "resources/read", params: {} });
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toBe("Invalid params: 'uri' is required");
  });

  it("resources/read of an unknown uri fails at -32000 with the not-found message", async () => {
    const resp = await send({
      jsonrpc: "2.0",
      id: 13,
      method: "resources/read",
      params: { uri: "sqlite://nope/nothing" },
    });
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toBe("MCP Resource not found: sqlite://nope/nothing");
  });

  it("prompts/list matches the catalog and prompts/get resolves and refuses by name", async () => {
    const list = await send({ jsonrpc: "2.0", id: 14, method: "prompts/list", params: {} });
    expect(list.error).toBeUndefined();
    expect(list.result.prompts.length).toBe(MCP_PROMPTS.length);

    const got = await send({
      jsonrpc: "2.0",
      id: 15,
      method: "prompts/get",
      params: { name: "audit_security_review", arguments: { draftId: "d1" } },
    });
    expect(got.error).toBeUndefined();
    expect(got.result.description).toBe(MCP_PROMPTS[0].description);
    expect(got.result.messages[0].content.text).toContain("audit_security_review");

    const missing = await send({
      jsonrpc: "2.0",
      id: 16,
      method: "prompts/get",
      params: { name: "nope_prompt" },
    });
    expect(missing.error?.code).toBe(-32601);
    expect(missing.error?.message).toBe("Prompt not found: nope_prompt");
  });

  it("an unknown method is refused at -32601", async () => {
    const resp = await send({ jsonrpc: "2.0", id: 17, method: "foo/bar", params: {} });
    expect(resp.error?.code).toBe(-32601);
    expect(resp.error?.message).toContain("Method not found");
  });
});
