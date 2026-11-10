/**
 * Issue #3934 — web tools compose on each class's own execution
 * surface, not only on the chat-turn hook.
 *
 * PR #3927 (#3494/#3495) put `web_fetch` / `web_search` behind
 * `PortThink.beforeTurn`, which fires only for a class that hosts a
 * chat turn (portHooks set). BrowserAgent and SandboxAgent are
 * headless — their port hooks are deliberately unset — so the same
 * capability that the manifest reports `enabled` for them never
 * materialized. This suite pins the correction: capability
 * availability is a manifest + resolver decision, so the same
 * builder composes on the class's execution surface, behind the same
 * gate, additively, with the turn path untouched.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BrowserAgent } from "../src/agents/browserAgent";
import { SandboxAgent } from "../src/agents/sandbox-agent";
import { resolveAgentCapabilityManifest } from "../src/actors/capabilityManifest";
import type { Env } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = () =>
  ({ id: { toString: () => "web-tools-3934" }, storage: {}, waitUntil: vi.fn() }) as any;

const browser = (env: Record<string, unknown> = {}) =>
  new BrowserAgent(ctx(), env as unknown as Env);

const sandbox = (env: Record<string, unknown> = {}) =>
  new SandboxAgent(ctx(), env as unknown as Env);

const stubPage = (body = "plain body") =>
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/plain" } })
  );

describe("headless classes compose the web tools (#3934)", () => {
  it("BrowserAgent hosts no chat turn, yet carries both tools on its execution surface", () => {
    const agent = browser();
    expect((agent as any).portHooks).toBeUndefined();
    expect(Object.keys(agent.getExecutionTools()).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("SandboxAgent hosts no chat turn, yet carries both tools on its execution surface", () => {
    const agent = sandbox();
    expect((agent as any).portHooks).toBeUndefined();
    expect(Object.keys(agent.getExecutionTools()).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("web_fetch executes real content through BrowserAgent's composition path", async () => {
    stubPage("browser path body");
    const tools = browser().getExecutionTools() as Record<string, any>;
    const out = await tools.web_fetch.execute({ url: "https://example.com/b" });
    expect(out.status).toBe(200);
    expect(JSON.stringify(out)).toContain("browser path body");
  });

  it("web_fetch executes real content through SandboxAgent's composition path", async () => {
    stubPage("sandbox path body");
    const tools = sandbox().getExecutionTools() as Record<string, any>;
    const out = await tools.web_fetch.execute({ url: "https://example.com/s" });
    expect(out.status).toBe(200);
    expect(JSON.stringify(out)).toContain("sandbox path body");
  });

  it("web_search keeps its named failure on both composition paths", async () => {
    // #3935: the default chain is keyless-first, so the unconfigured
    // case is an explicitly empty chain.
    for (const agent of [
      browser({ WEB_SEARCH_PROVIDERS: "" }),
      sandbox({ WEB_SEARCH_PROVIDERS: "" }),
    ]) {
      const tools = agent.getExecutionTools() as Record<string, any>;
      const out = await tools.web_search.execute({ query: "aapl" });
      expect(out).toMatchObject({ ok: false, error: "web_search_provider_not_configured" });
    }
  });

  it("the capability gate withdraws each tool per class", () => {
    expect(Object.keys(browser({ AGENT_CAPABILITIES_DISABLED: "*:webSearch" }).getExecutionTools()))
      .toEqual(["web_fetch"]);
    expect(Object.keys(sandbox({ AGENT_CAPABILITIES_DISABLED: "*:webFetch" }).getExecutionTools()))
      .toEqual(["web_search"]);
    expect(
      Object.keys(
        browser({ AGENT_CAPABILITIES_DISABLED: "*:webFetch,*:webSearch" }).getExecutionTools()
      )
    ).toEqual([]);
    expect(
      Object.keys(
        sandbox({ AGENT_CAPABILITIES_DISABLED: "*:webFetch,*:webSearch" }).getExecutionTools()
      )
    ).toEqual([]);
  });

  it("composition is additive only — a class's own tool is never replaced or duplicated", () => {
    const own = { own_tool: { description: "class tool" } };
    const tools = browser().getExecutionTools(own) as Record<string, any>;
    expect(Object.keys(tools).sort()).toEqual(["own_tool", "web_fetch", "web_search"]);
    expect(tools.own_tool.description).toBe("class tool");

    // An MCP-discovered web_fetch (tool_openaimp_web_fetch) already on the
    // surface means the port must not add a second, competing web_fetch.
    const discovered = { tool_openaimp_web_fetch: { description: "mcp" } };
    const composed = sandbox().getExecutionTools(discovered) as Record<string, any>;
    expect(Object.keys(composed).sort()).toEqual(["tool_openaimp_web_fetch", "web_search"]);
  });

  it("the manifest describes the composed reality for both headless classes", () => {
    for (const className of ["BrowserAgent", "SandboxAgent"]) {
      const manifest = resolveAgentCapabilityManifest(className, { env: {} });
      expect(manifest.tools.webFetch.state).toBe("enabled");
      expect(manifest.tools.webFetch.note).toContain("execution surface");
      expect(manifest.tools.webSearch.note).toContain("execution surface");
    }
  });
});
