// @vitest-environment node
/**
 * Issue #6173 (slice 3) — the route-shell pin: POST /mcp resolves
 * the call's validated ExecutionContext ONCE at the entry and
 * carries it into the handler, with the role-derived gate port
 * bound to it. If the entry stopped establishing (or stopped
 * passing the port), no module-level test would fail — the gate
 * would silently fall back to its defaults — so this file pins
 * the wiring itself at the shell.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/agents/nlq", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/agents/nlq")>();
  return {
    ...mod,
    executeNaturalLanguageQuery: vi.fn(async () => ({
      plan: { operation: "table_data", domain: "test" },
      result: { domain: "test", count: 2, rows: [{ a: 1 }] },
    })),
  };
});

const establishMock = vi.hoisted(() => vi.fn());
vi.mock("../src/security/mcpToolContext", () => ({
  establishMcpToolContext: establishMock,
}));

const handleMock = vi.hoisted(() => vi.fn());
vi.mock("../src/mcps/openaimp/handler", () => ({
  handleOpenaimpMcpHttpRequest: handleMock,
}));

import {
  handleMcpChatNlqRoutes,
  type McpChatNlqRouteContext,
} from "../src/agents/routes/mcpChatNlq";
import type { ExecutionContext } from "../src/security/executionContext";

function fakeMcpContext(): ExecutionContext {
  return {
    tenantId: "tenant-mcp",
    principalId: "user-mcp",
    principalType: "user",
    initiatingPrincipalId: "user-mcp",
    taskId: "mcp:trace-1",
    serviceId: "mcp",
    environment: "sandbox",
    policyVersion: "iaaa-authorization-2",
    correlationId: "trace-1",
    sessionId: "sess",
    traceId: "trace-1",
    dispatchMode: "manual",
    execMode: "sync",
  };
}

const baseCtx = (): McpChatNlqRouteContext =>
  ({
    getOrm: () => ({}) as any,
    getStorageSql: () => ({}),
    env: {} as any,
    audit: vi.fn(),
    submitAsyncJob: vi.fn(async () => ({
      jobId: "j1",
      status: "queued" as const,
      statusUrl: "/jobs/j1",
    })),
    getAsyncJob: vi.fn(() => undefined),
    listAsyncJobs: vi.fn(() => []),
  }) as McpChatNlqRouteContext;

const mcpReq = (headers?: Record<string, string>) =>
  new Request("https://agent.internal/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_stock_screen", arguments: {} },
    }),
  });

describe("POST /mcp route shell carries the validated context (#6173)", () => {
  beforeEach(() => {
    establishMock.mockReset();
    handleMock.mockReset();
    handleMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it("passes the resolved context + the role-derived port into the handler", async () => {
    const context = fakeMcpContext();
    const resolveRoles = vi.fn(async () => ["member"] as const);
    establishMock.mockResolvedValue({
      outcome: { outcome: "resolved", context },
      refusal: null,
      resolveRoles,
    });
    const url = new URL("https://agent.internal/mcp");
    const res = await handleMcpChatNlqRoutes(
      mcpReq({ "x-user-login": "venus", "x-principal-kind": "session" }),
      url,
      "/mcp",
      "sess",
      baseCtx(),
    );
    expect(res!.status).toBe(200);
    expect(establishMock).toHaveBeenCalledTimes(1);
    const [input] = establishMock.mock.calls[0];
    expect(input.principal).toEqual({ login: "venus", kind: "session" });
    expect(input.sessionId).toBe("sess");
    expect(handleMock).toHaveBeenCalledTimes(1);
    const [, handlerContext] = handleMock.mock.calls[0];
    expect(handlerContext.executionContext).toBe(context);
    // The port is the role-derived one, not the default: a member
    // derives read+write, never trade.
    expect(handlerContext.permissionPort).toBeDefined();
    expect(
      await handlerContext.permissionPort.scopesFor({ login: "venus", kind: "session" }),
    ).toEqual(["mcp:read", "mcp:write"]);
    expect(resolveRoles).toHaveBeenCalled();
  });

  it("returns an enforce-mode refusal before the handler runs", async () => {
    const refusal = Response.json({ error: "denied", code: "NO_PRINCIPAL" }, { status: 403 });
    establishMock.mockResolvedValue({
      outcome: { outcome: "denied", code: "NO_PRINCIPAL", error: "denied" },
      refusal,
    });
    const url = new URL("https://agent.internal/mcp");
    const res = await handleMcpChatNlqRoutes(
      mcpReq({ "x-user-login": "venus", "x-principal-kind": "session" }),
      url,
      "/mcp",
      "sess",
      baseCtx(),
    );
    expect(res!.status).toBe(403);
    expect(handleMock).not.toHaveBeenCalled();
  });

  it("absent context (no login) reaches the handler with no context and no port — today's defaults", async () => {
    establishMock.mockResolvedValue({
      outcome: { outcome: "absent" },
      refusal: null,
    });
    const url = new URL("https://agent.internal/mcp");
    const res = await handleMcpChatNlqRoutes(mcpReq(), url, "/mcp", "sess", baseCtx());
    expect(res!.status).toBe(200);
    expect(handleMock).toHaveBeenCalledTimes(1);
    const [, handlerContext] = handleMock.mock.calls[0];
    expect(handlerContext.executionContext).toBeUndefined();
    expect(handlerContext.permissionPort).toBeUndefined();
  });
});
