/**
 * Issues #3896 & #3897 —
 * 1. Synchronous Browser / Web Fetch / Sandbox MCP Execution (#3896)
 * 2. Authenticated Workspace File Listing, Viewing & Download Routes (/api/workspace/files, /api/workspace/file) (#3896)
 * 3. Real-Time Slack & Email Notifications on On-Demand and Copilot Order Placements (#3897)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { isSynchronousMcpTool } from "../src/config/asyncJobModes";
import { handleOpenaimpMcpHttpRequest, type OpenaimpMcpHandlerContext } from "../src/mcps/openaimp/handler";
import { handleWorkspaceRoutes, resolveCanonicalWorkspacePath } from "../src/agents/routes/workspace";
import { PortThink, createThinkActorPort } from "../src/actors/thinkAdapter";
import { createActorPorts } from "../src/actors/createActorPorts";
import { thinkWorkspaceEndpointFromPath } from "../src/actors/thinkPortMapping";
import {
  formatOrderNotificationPayload,
  notifyOrderExecution,
} from "../src/services/orderExecutionNotifier";
import { STOCK_COPILOT_MCP_STEERING, buildStockCopilotSystemPrompt } from "../src/agents/prompts/stockCopilotPrompt";
import { MockSqlStorage } from "./mock-sql";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Issue #3896 — Synchronous Browser, Web Fetch/Search, and Sandbox MCP Tools", () => {
  it("marks browser, web_fetch, web_search, sandbox, think, and Slack/webhook tools as synchronous", () => {
    const syncTools = [
      "browser_inspect_page",
      "browser_screenshot",
      "browser_scrape_tables",
      "browser_capture_page",
      "browser_snap_transaction",
      "web_fetch",
      "web_search",
      "run_sandbox_command",
      "run_quant_backtest",
      "think_trade_validation",
      "dispatch_trading_webhook",
      "slack_dispatch_transaction_snap",
      "slack_send_pre_trade_approval",
    ];
    for (const toolName of syncTools) {
      expect(isSynchronousMcpTool(toolName), `Expected ${toolName} to be synchronous`).toBe(true);
    }
  });

  it("executes browser_screenshot inline via /mcp without queueing into submitJob", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("<html><head><title>Example</title></head><body>Hello</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );

    const submitJob = vi.fn().mockResolvedValue({
      jobId: "should-not-queue",
      status: "queued",
      statusUrl: "/api/jobs/should-not-queue",
    });

    const ctx: OpenaimpMcpHandlerContext = {
      env: { HTTP_DELIVERY_MODE: "queued" } as any,
      orm: {} as any,
      sessionId: "sess-3896",
      actingLogin: () => "mubasher",
      submitJob,
      audit: vi.fn(),
      principal: { kind: "session", login: "mubasher" },
    };

    const req = new Request("https://agent.internal/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browser_screenshot",
          arguments: { url: "https://example.com" },
        },
      }),
    });

    const res = await handleOpenaimpMcpHttpRequest(req, ctx);
    expect(res.status).toBe(200);
    expect(submitJob).not.toHaveBeenCalled();
    const payload = (await res.json()) as any;
    const text = payload?.result?.content?.[0]?.text ?? "";
    expect(text).toContain("screenshotKind");
    expect(text).not.toContain('"status":"queued"');
  });
});

describe("Issue #3896 — Authenticated Workspace File Routes (/api/workspace/files & /api/workspace/file)", () => {
  it("normalizes relative and /workspace-prefixed paths and rejects directory traversal", () => {
    const rel = resolveCanonicalWorkspacePath("stock-copilot-enhancement-issues.md");
    expect(rel.ok).toBe(true);
    if (rel.ok) {
      expect(rel.path).toBe("/workspace/stock-copilot-enhancement-issues.md");
    }

    const abs = resolveCanonicalWorkspacePath("/workspace/strategies/momentum.ts");
    expect(abs.ok).toBe(true);
    if (abs.ok) {
      expect(abs.path).toBe("/workspace/strategies/momentum.ts");
    }

    const traversal = resolveCanonicalWorkspacePath("/workspace/../etc/passwd");
    expect(traversal.ok).toBe(false);
  });

  it("lists, views raw, and downloads files from the OrchestratorAgent hostWorkspace and SQLite store", async () => {
    const sql = new MockSqlStorage();
    const hostFiles = new Map<string, string>([
      ["/workspace/stock-copilot-enhancement-issues.md", "# Stock Copilot Enhancement Issues\n\n1. Enable browser tools\n2. Order notifications\n"],
    ]);

    const ctx = {
      sql: sql as any,
      getScreenerExecutionContext: async () => ({ userLogin: "mubasher" }),
      hostWorkspace: {
        listFiles: async (dir: string) => {
          if (dir === "/workspace") {
            return [
              {
                name: "stock-copilot-enhancement-issues.md",
                path: "/workspace/stock-copilot-enhancement-issues.md",
                type: "file",
                size: hostFiles.get("/workspace/stock-copilot-enhancement-issues.md")!.length,
              },
            ];
          }
          return [];
        },
        readFile: async (p: string) => hostFiles.get(p) ?? null,
        writeFile: async (p: string, c: string) => {
          hostFiles.set(p, c);
        },
        deleteFile: async (p: string) => hostFiles.delete(p),
      },
      audit: vi.fn(),
    };

    // 1. List files
    const listUrl = new URL("https://agent.internal/api/workspace/files");
    const listRes = await handleWorkspaceRoutes(
      new Request(listUrl.toString(), { method: "GET" }),
      listUrl,
      listUrl.pathname,
      "sess-1",
      ctx,
    );
    expect(listRes?.status).toBe(200);
    const listJson = (await listRes!.json()) as any;
    expect(listJson.ok).toBe(true);
    expect(listJson.files).toHaveLength(1);
    expect(listJson.files[0]).toMatchObject({
      name: "stock-copilot-enhancement-issues.md",
      path: "/workspace/stock-copilot-enhancement-issues.md",
      downloadUrl: "/api/workspace/file?path=%2Fworkspace%2Fstock-copilot-enhancement-issues.md&download=1",
      viewUrl: "/api/workspace/file?path=%2Fworkspace%2Fstock-copilot-enhancement-issues.md&raw=1",
    });

    // 2. Download file (?download=1)
    const dlUrl = new URL(
      "https://agent.internal/api/workspace/file?path=/workspace/stock-copilot-enhancement-issues.md&download=1",
    );
    const dlRes = await handleWorkspaceRoutes(
      new Request(dlUrl.toString(), { method: "GET" }),
      dlUrl,
      dlUrl.pathname,
      "sess-1",
      ctx,
    );
    expect(dlRes?.status).toBe(200);
    expect(dlRes?.headers.get("Content-Disposition")).toContain(
      'attachment; filename="stock-copilot-enhancement-issues.md"',
    );
    expect(dlRes?.headers.get("Content-Type")).toContain("text/markdown");
    expect(await dlRes!.text()).toContain("# Stock Copilot Enhancement Issues");

    // 3. View raw (?raw=1)
    const rawUrl = new URL(
      "https://agent.internal/api/workspace/file?path=stock-copilot-enhancement-issues.md&raw=1",
    );
    const rawRes = await handleWorkspaceRoutes(
      new Request(rawUrl.toString(), { method: "GET" }),
      rawUrl,
      rawUrl.pathname,
      "sess-1",
      ctx,
    );
    expect(rawRes?.status).toBe(200);
    expect(rawRes?.headers.get("Content-Type")).toContain("text/plain");
    expect(await rawRes!.text()).toContain("1. Enable browser tools");

    // 4. Write new file via POST /api/workspace/file
    const postUrl = new URL("https://agent.internal/api/workspace/file");
    const postRes = await handleWorkspaceRoutes(
      new Request(postUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/workspace/strategies/alpha.ts",
          content: "export const alpha = 1;",
        }),
      }),
      postUrl,
      postUrl.pathname,
      "sess-1",
      ctx,
    );
    expect(postRes?.status).toBe(200);
    const postJson = (await postRes!.json()) as any;
    expect(postJson.ok).toBe(true);
    expect(postJson.path).toBe("/workspace/strategies/alpha.ts");
    expect(hostFiles.get("/workspace/strategies/alpha.ts")).toBe("export const alpha = 1;");
  });

  it("steers Stock Copilot to provide clickable /api/workspace/file download links instead of local cat commands", () => {
    expect(STOCK_COPILOT_MCP_STEERING).toContain("/api/workspace/file?path=/workspace/<filename>&download=1");
    expect(STOCK_COPILOT_MCP_STEERING).toContain("/api/workspace/files");
    const prompt = buildStockCopilotSystemPrompt({
      route: { agent: "search", confidence: 0.95, reason: "test" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    });
    expect(prompt).toContain("/api/workspace/file?path=/workspace/<filename>&download=1");
  });
});

describe("Issue #3897 — Slack & Email Notifications on Order Placement", () => {
  it("formats order notification payload with bracket exits, broker/mode, and order metadata", () => {
    const formatted = formatOrderNotificationPayload({
      orderId: "ord-123",
      broker: "paper-broker",
      mode: "paper",
      symbol: "AAPL",
      action: "BUY",
      quantity: 10,
      orderType: "LIMIT",
      orderClass: "bracket",
      price: 328.06,
      takeProfitPrice: 341.18,
      stopLossPrice: 321.5,
      status: "accepted",
      origin: "on_demand_order",
      timestamp: "2026-11-09T16:00:00.000Z",
    });

    expect(formatted.subject).toBe("[Stock Copilot Order] BUY 10 AAPL (LIMIT) — ACCEPTED");
    expect(formatted.slackText).toContain("*BUY 10 AAPL*");
    expect(formatted.slackText).toContain("TP $341.18 / SL $321.50");
    expect(formatted.emailText).toContain("Order ID: ord-123");
    expect(formatted.emailHtml).toContain("341.18");
  });

  it("dispatches both Slack and Email notifications when transports are configured", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const emailSent: any[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const bodyText = typeof init?.body === "string" ? init.body : "";
      calls.push({ url: urlStr, body: bodyText ? JSON.parse(bodyText) : null });
      return new Response(JSON.stringify({ ok: true, id: "msg-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const receipt = await notifyOrderExecution(
      {
        SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T00/B00/X00",
        EMAIL: {
          send: async (msg: unknown) => {
            emailSent.push(msg);
          },
        },
        SCREENER_EMAIL_TO: "trader@example.com",
      },
      {
        orderId: "ord-999",
        broker: "paper-broker",
        mode: "paper",
        symbol: "NVDA",
        action: "BUY",
        quantity: 5,
        orderType: "MARKET",
        status: "placed",
        origin: "on_demand_order",
      },
    );

    expect(receipt.slack.sent).toBe(true);
    expect(receipt.slack.status).toBe("delivered");
    expect(receipt.email.sent).toBe(true);
    expect(receipt.email.status).toBe("delivered");
    expect(receipt.email.to).toBe("trader@example.com");
    expect(calls.some((c) => new URL(c.url).hostname === "hooks.slack.com")).toBe(true);
    expect(emailSent).toHaveLength(1);
  });

  it("returns not_configured without throwing when Slack and Email are not configured", async () => {
    const receipt = await notifyOrderExecution(
      {},
      {
        orderId: "ord-000",
        broker: "paper-broker",
        mode: "paper",
        symbol: "MSFT",
        action: "SELL",
        quantity: 2,
        orderType: "MARKET",
        status: "placed",
        origin: "on_demand_order",
      },
    );

    expect(receipt.slack).toMatchObject({ sent: false, status: "not_configured" });
    expect(receipt.email).toMatchObject({ sent: false, status: "not_configured" });
  });
});

describe("PortThink Workspace Port & Channel Inheritance (#3491 / #3896)", () => {
  class AnySubclassedAgent extends PortThink {
    async onRequest(_request: Request): Promise<Response> {
      return new Response("custom-agent-router", { status: 200 });
    }
  }

  it("matches reserved /workspace/files and /workspace/file tails under any agent prefix", () => {
    expect(thinkWorkspaceEndpointFromPath("/agents/research-agent/inst-1/workspace/files")).toBe("files");
    expect(thinkWorkspaceEndpointFromPath("/agents/trading-agent/inst-1/workspace/file")).toBe("file");
    expect(thinkWorkspaceEndpointFromPath("/api/workspace/files")).toBe("files");
    expect(thinkWorkspaceEndpointFromPath("/api/stock-copilot/workspace/file")).toBe("file");
    expect(thinkWorkspaceEndpointFromPath("/agents/x/y/other")).toBeNull();
  });

  it("gives every PortThink subclass built-in /workspace/file and /workspace/files HTTP routes via PortThink.fetch and workspacePort", async () => {
    const ctx = {
      storage: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        sql: { exec: () => [] },
      },
    };
    const agent = new AnySubclassedAgent(ctx as never, {} as never);

    // 1. Write via PortThink.fetch (POST /agents/.../workspace/file)
    const writeRes = await agent.fetch(
      new Request("https://agent.openaimp.com/agents/any-subclassed-agent/inst-1/workspace/file", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-login": "mubasher",
        },
        body: JSON.stringify({
          path: "/workspace/stock-copilot-enhancement-issues.md",
          content: "# Shared PortThink Workspace\n",
        }),
      }),
    );
    expect(writeRes.status).toBe(200);
    const writeJson = (await writeRes.json()) as any;
    expect(writeJson.ok).toBe(true);
    expect(writeJson.path).toBe("/workspace/stock-copilot-enhancement-issues.md");
    expect(writeJson.downloadUrl).toContain("download=1");

    // 2. List via PortThink.fetch (GET /agents/.../workspace/files)
    const listRes = await agent.fetch(
      new Request("https://agent.openaimp.com/agents/any-subclassed-agent/inst-1/workspace/files", {
        method: "GET",
        headers: { "x-user-login": "mubasher" },
      }),
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.count).toBe(1);
    expect(listJson.files[0].path).toBe("/workspace/stock-copilot-enhancement-issues.md");

    // 3. Download via PortThink.fetch (GET /agents/.../workspace/file?path=...&download=1)
    const dlRes = await agent.fetch(
      new Request(
        "https://agent.openaimp.com/agents/any-subclassed-agent/inst-1/workspace/file?path=/workspace/stock-copilot-enhancement-issues.md&download=1",
        {
          method: "GET",
          headers: { "x-user-login": "mubasher" },
        },
      ),
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-disposition")).toContain("attachment;");
    expect(await dlRes.text()).toBe("# Shared PortThink Workspace\n");

    // 4. Non-workspace routes still fall through to the subclass's onRequest
    const otherRes = await agent.fetch(
      new Request("https://agent.openaimp.com/agents/any-subclassed-agent/inst-1/health"),
    );
    expect(await otherRes.text()).toBe("custom-agent-router");
  });

  it("exposes getPortWorkspaceTools() on PortThink and honors AGENT_CAPABILITIES_DISABLED", async () => {
    const enabledAgent = new AnySubclassedAgent({} as never, {} as never);
    const tools = enabledAgent.getPortWorkspaceTools("mubasher");
    expect(Object.keys(tools)).toEqual([
      "workspace_list_files",
      "workspace_read_file",
      "workspace_write_file",
      "workspace_delete_file",
    ]);

    const disabledAgent = new AnySubclassedAgent(
      {} as never,
      { AGENT_CAPABILITIES_DISABLED: "*:workspace" } as never,
    );
    expect(disabledAgent.isPortCapabilityEnabled("workspace")).toBe(false);
    expect(Object.keys(disabledAgent.getPortWorkspaceTools("mubasher"))).toEqual([]);
    const refused = await disabledAgent.fetch(
      new Request("https://agent.openaimp.com/agents/any-subclassed-agent/inst-1/workspace/files"),
    );
    expect(refused.status).toBe(403);
  });

  it("wires port.workspace on createActorPorts and createThinkActorPort", async () => {
    const hooks = {
      getModel: () => null,
      getSystemPrompt: () => "",
      getTools: () => ({}),
      beforeTurn: async () => undefined,
      onChatResponse: async () => {},
    };
    const inMemPort = createActorPorts("in-memory", { hooks });
    expect(inMemPort.workspace).toBeDefined();
    await inMemPort.workspace!.writeFile("/workspace/test.txt", "hello");
    const read = await inMemPort.workspace!.readFile("/workspace/test.txt");
    expect(read?.content).toBe("hello");

    const thinkAgent = new AnySubclassedAgent({} as never, {} as never);
    const thinkPort = createThinkActorPort({
      think: thinkAgent,
      hooks,
      storage: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        sql: { exec: () => [] },
      },
      scheduler: {
        schedule: async () => ({}),
        scheduleEvery: async () => ({}),
        listSchedules: async () => [],
        cancelSchedule: async () => true,
      },
    });
    expect(thinkPort.workspace).toBe(thinkAgent.workspacePort);
  });
});
