/**
 * Issue #359-02: characterization for the MCP + chat + NLQ route extraction.
 *
 * Pins (a) the route inventory and relative order of the extracted handlers in
 * src/agents/routes/mcpChatNlq.ts — the matching order in routeRequest is
 * load-bearing, so the module must handle the same 3 (path, method) pairs in
 * the same sequence as the original inline blocks; and (b) the extracted
 * entry point's behavior with a mock context: each moved path responds as
 * before, non-matching paths return null (the orchestrator keeps routing).
 *
 * The NLQ safety invariants (table allowlist, zod-validated plan, bound
 * parameters) live inside executeNaturalLanguageQuery (src/agents/nlq.ts) —
 * untouched by this move. The test stubs that single owner at the module
 * boundary to pin the route shell's argument contract (orm, sessionId,
 * query, env, userLogin, userDid, options with schedulingPort), not the
 * pipeline itself.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

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

import {
  handleMcpChatNlqRoutes,
  type McpChatNlqRouteContext,
} from "../src/agents/routes/mcpChatNlq";
import { executeNaturalLanguageQuery } from "../src/agents/nlq";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (overrides: Partial<McpChatNlqRouteContext> = {}): McpChatNlqRouteContext =>
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
    extractMessageText: (m: unknown) =>
      typeof m === "object" && m !== null && "content" in (m as any)
        ? String((m as any).content)
        : "",
    // Issue #686: the Think session's async read; the adapter no
    // longer writes conversation messages (the turn driver owns
    // session appends, beforeTurn owns the user mas_messages record).
    getMessages: async () => [],
    recordMessage: vi.fn(),
    runAgenticChatTurn: vi.fn(async () => ({
      result: { text: Promise.resolve("assistant reply") },
      route: { agent: "trading", confidence: 0.9, reason: "r", needsConfirmation: false },
    })),
    buildChatErrorFallback: vi.fn(async () => "fallback text"),
    nlqSchedulingPort: () => ({}),
    ...overrides,
  }) as McpChatNlqRouteContext;

const req = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("mcp/chat/nlq route inventory (extraction #364)", () => {
  it("the 3 route conditions appear in the extracted module in the original relative order", () => {
    const moduleSrc = src("agents/routes/mcpChatNlq.ts");
    const markers = [
      'path.endsWith("/mcp")',
      '(path === "/chat" || path === "/api/chat") && request.method === "POST"',
      'path.endsWith("/nlq") && request.method === "POST"',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = moduleSrc.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; the delegation stands in their place", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(dispatchSrc).toContain("handleMcpChatNlqRoutes(request, url, path, sessionId,");
    // Distinctive comments that headed the inline blocks before extraction.
    expect(orchSrc).not.toContain("// Model Context Protocol (MCP) Server Endpoint (JSON-RPC 2.0 & Discovery)");
    expect(orchSrc).not.toContain('if (path.endsWith("/mcp")) {');
    expect(orchSrc).not.toContain('if (path.endsWith("/nlq") && request.method === "POST") {');
    // The extracted module is the sole owner of these conditions now.
    const moduleSrc = src("agents/routes/mcpChatNlq.ts");
    expect(moduleSrc).toContain("// Model Context Protocol (MCP) Server Endpoint (JSON-RPC 2.0 & Discovery)");
    expect(moduleSrc).toContain("// Issue #312: the advertised POST /api/chat.");
  });

  it("the NLQ webhook spellings were never in routeRequest (single owner is the server entry, issue #313)", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    expect(orchSrc).not.toContain("/nlq/webhook");
    // Slice 6 of Qunsultant/cfagent#2902 (2026-11-05): the NLQ webhook
    // handler moved from src/server.ts to src/server/routes/messaging.ts;
    // the entry surface is server.ts + routes/*.ts, so the pin reads
    // both files.
    const serverSrc = src("server.ts") + src("server/routes/messaging.ts");
    expect(serverSrc).toContain("handleNlqWebhookRequest");
  });
});

describe("handleMcpChatNlqRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const ctx = baseCtx();
    const cases: Array<[string, string]> = [
      ["POST", "/trading/options/scan"],
      ["GET", "/chat"], // chat is POST-only
      ["GET", "/api/chat"],
      ["GET", "/nlq"], // nlq is POST-only
      ["POST", "/mcp2"],
      ["POST", "/schema/query"], // owned by routes/schema.ts since slice #359-17
    ];
    for (const [method, path] of cases) {
      const url = new URL(`https://agent.internal${path}`);
      expect(await handleMcpChatNlqRoutes(req(method, path), url, path, "sess", ctx)).toBeNull();
    }
  });

  it("GET /mcp serves the discovery document", async () => {
    const ctx = baseCtx();
    const url = new URL("https://agent.internal/mcp");
    const res = await handleMcpChatNlqRoutes(req("GET", "/mcp"), url, "/mcp", "sess", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.server).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.resources).toBeDefined();
    expect(body.prompts).toBeDefined();
    expect(body.endpoints.jsonrpc).toBe("/api/mcp");
  });

  it("POST /mcp delegates JSON-RPC to the MCP handler (method-not-found stays JSON-RPC)", async () => {
    const ctx = baseCtx();
    const url = new URL("https://agent.internal/mcp");
    const res = await handleMcpChatNlqRoutes(req("POST", "/mcp", {}), url, "/mcp", "sess", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32601);
  });

  it("POST /mcp stock_copilot_status refuses door_unavailable when the route context carries no storage (#3635)", async () => {
    const ctx = baseCtx({
      env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    });
    const url = new URL("https://agent.internal/mcp");
    const res = await handleMcpChatNlqRoutes(
      req(
        "POST",
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "stock_copilot_status", arguments: {} },
        },
        { "x-user-login": "alice" },
      ),
      url,
      "/mcp",
      "sess",
      ctx,
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(String(body.error?.message ?? "")).toMatch(/cannot access SQLite/);
  });

  it("POST /mcp stock_copilot_status returns live status when the route context supplies storage (#3635)", async () => {
    const mockSql = {
      exec: vi.fn().mockImplementation((query: string) => {
        const q = query.trim().toUpperCase();
        if (q.startsWith("SELECT") && q.includes("COPILOT_POSITIONS")) return [];
        if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_ACTIVITY")) return [];
        if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_CONTROL")) return [];
        return [];
      }),
    };
    const submitAsyncJob = vi.fn(async () => ({
      jobId: "j1",
      status: "queued" as const,
      statusUrl: "/jobs/j1",
    }));
    const ctx = baseCtx({
      env: { STOCK_COPILOT_PAPER_ENABLED: "1", HTTP_DELIVERY_MODE: "queued" } as any,
      getStorage: () => ({ sql: mockSql }),
      submitAsyncJob,
    });
    const url = new URL("https://agent.internal/mcp");
    const res = await handleMcpChatNlqRoutes(
      req(
        "POST",
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "stock_copilot_status", arguments: {} },
        },
        { "x-user-login": "alice" },
      ),
      url,
      "/mcp",
      "sess",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    // Synchronous despite HTTP_DELIVERY_MODE=queued: stock_copilot_*
    // are in SYNCHRONOUS_MCP_TOOLS and must never be queued.
    expect(submitAsyncJob).not.toHaveBeenCalled();
    const body = (await res!.json()) as any;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    expect(body.result.content).toBeDefined();
  });

  it("POST /api/chat 400s without a final user message", async () => {
    const ctx = baseCtx();
    const url = new URL("https://agent.internal/api/chat");
    const res = await handleMcpChatNlqRoutes(req("POST", "/api/chat", {}), url, "/api/chat", "sess", ctx);
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toContain("non-empty array");
  });

  it("POST /api/chat runs the single-owner chat turn with history context", async () => {
    const getMessages = vi.fn(async () => []);
    const recordMessage = vi.fn();
    const runTurn = vi.fn(async () => ({
      result: { text: Promise.resolve("assistant reply") },
      route: { agent: "trading", confidence: 0.9, reason: "r", needsConfirmation: false },
    }));
    const audit = vi.fn();
    const ctx = baseCtx({ getMessages, recordMessage, runAgenticChatTurn: runTurn, audit });
    const url = new URL("https://agent.internal/api/chat");
    const path = "/api/chat";
    const res = await handleMcpChatNlqRoutes(
      req("POST", path, { messages: [{ role: "user", content: "hi there" }] }, { "x-user-login": "alice" }),
      url,
      path,
      "sess",
      ctx
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.reply).toBe("assistant reply");
    expect(body.route.agent).toBe("trading");
    expect(body.route.needsConfirmation).toBe(false);
    expect(body.streaming).toBe(false);
    // Contract with the single-owner pipeline: same args shape as before.
    expect(runTurn).toHaveBeenCalledTimes(1);
    const args = runTurn.mock.calls[0][0];
    expect(args.userText).toBe("hi there");
    // Issue #1185: chatUserLogin is the verified x-user-login header —
    // the session id is never promoted to a login.
    expect(args.userLogin).toBe("alice");
    expect(args.isAutoOptionsResearchRequest).toBe(false);
    // Issue #686: history was read for the judge's recent-turns
    // context (existing history + the current message, as the
    // pre-cutover merge produced), and the adapter wrote NO
    // conversation state and NO user record — session appends are
    // the turn driver's, the user record is beforeTurn's.
    expect(getMessages).toHaveBeenCalled();
    expect(args.recentTurns).toEqual([{ role: "user", content: "hi there" }]);
    expect(recordMessage).not.toHaveBeenCalledWith("user", expect.anything(), expect.anything());
    expect(audit).toHaveBeenCalledWith("chat.http_turn", "orchestrator", expect.anything());
  });

  it("POST /api/chat honors the x-user-login caller", async () => {
    const runTurn = vi.fn(async () => ({
      result: { text: Promise.resolve("ok") },
      route: { agent: "trading", confidence: 1, reason: "r", needsConfirmation: false },
    }));
    const ctx = baseCtx({ runAgenticChatTurn: runTurn });
    const url = new URL("https://agent.internal/api/chat");
    await handleMcpChatNlqRoutes(
      req("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }, { "x-user-login": "alice" }),
      url,
      "/api/chat",
      "sess",
      ctx
    );
    expect(runTurn.mock.calls[0][0].userLogin).toBe("alice");
  });

  it("POST /api/chat returns the degraded fallback on pipeline failure", async () => {
    const ctx = baseCtx({
      runAgenticChatTurn: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const url = new URL("https://agent.internal/api/chat");
    const res = await handleMcpChatNlqRoutes(
      req("POST", "/api/chat", { messages: [{ role: "user", content: "hi" }] }, { "x-user-login": "alice" }),
      url,
      "/api/chat",
      "sess",
      ctx
    );
    const body = (await res!.json()) as any;
    expect(body).toEqual({ reply: "fallback text", fallback: true, streaming: false });
  });

  it("POST /nlq 400s without a query", async () => {
    const ctx = baseCtx();
    const url = new URL("https://agent.internal/nlq");
    const res = await handleMcpChatNlqRoutes(req("POST", "/nlq", {}), url, "/nlq", "sess", ctx);
    expect(res!.status).toBe(400);
    expect(((await res!.json()) as any).error).toBe("Query parameter is required");
  });

  it("POST /nlq calls the single-owner NLQ pipeline with the right contract", async () => {
    const nlqMock = executeNaturalLanguageQuery as unknown as ReturnType<typeof vi.fn>;
    nlqMock.mockClear();
    const audit = vi.fn();
    const schedulingPort = { id: "port" };
    const ctx = baseCtx({ audit, nlqSchedulingPort: () => schedulingPort as any });
    const url = new URL("https://agent.internal/nlq");
    const res = await handleMcpChatNlqRoutes(
      req("POST", "/nlq", { query: "  show me trades  " }, { "x-user-login": "bob" }),
      url,
      "/nlq",
      "sess",
      ctx
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.domain).toBe("test");
    expect(body.count).toBe(2);
    // Argument contract: (orm, sessionId, query, env, userLogin, userDid, options).
    expect(nlqMock).toHaveBeenCalledTimes(1);
    const args = nlqMock.mock.calls[0];
    expect(args[1]).toBe("sess");
    expect(args[2]).toBe("show me trades");
    expect(args[4]).toBe("bob");
    expect(args[6].schedulingPort).toBe(schedulingPort);
    expect(args[6].scanRunStore).toBeDefined();
    expect(args[6].profileStore).toBeDefined();
    expect(audit).toHaveBeenCalledWith(
      "nlq.executed",
      "nlq",
      expect.objectContaining({ query: "show me trades", domain: "test", operation: "table_data", count: 2 })
    );
  });
});
