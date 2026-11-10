/**
 * Issues #3494 / #3495 (Capability S10/S11) — web_fetch and web_search
 * as PortThink capabilities: enabled once on the base class, inherited
 * by every subclass, gated by AGENT_CAPABILITIES_DISABLED, additive only.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PortThink } from "../src/actors/thinkAdapter";
import { resolveAgentCapabilityManifest } from "../src/actors/capabilityManifest";

afterEach(() => {
  vi.unstubAllGlobals();
});

class AnyAgent extends PortThink {
  constructor(env: unknown = {}) {
    super({} as never, env as never);
  }
}

class HookedAgent extends PortThink {
  constructor(env: unknown = {}) {
    super({} as never, env as never);
    this.portHooks = {
      getModel: () => null,
      getSystemPrompt: () => "",
      getTools: () => ({}),
      beforeTurn: async () => ({ instructions: "own" }),
      onChatResponse: async () => {},
    };
  }
}

const thinkCtx = (toolNames: string[] = []) => ({
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  tools: Object.fromEntries(toolNames.map((n) => [n, {}])),
  model: {},
  continuation: false,
  body: {},
});

describe("PortThink web tools (#3494/#3495)", () => {
  it("every subclass exposes web_fetch and web_search by default", () => {
    expect(Object.keys(new AnyAgent().getPortWebTools()).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("AGENT_CAPABILITIES_DISABLED withdraws each tool independently", () => {
    const noSearch = new AnyAgent({ AGENT_CAPABILITIES_DISABLED: "*:webSearch" });
    expect(Object.keys(noSearch.getPortWebTools())).toEqual(["web_fetch"]);
    const none = new AnyAgent({ AGENT_CAPABILITIES_DISABLED: "*:webFetch,*:webSearch" });
    expect(Object.keys(none.getPortWebTools())).toEqual([]);
  });

  it("web_search fails loud with the named code when the provider chain is empty", async () => {
    // #3935: the default chain is keyless-first, so the unconfigured
    // case is an explicitly empty chain.
    const tools = new AnyAgent({ WEB_SEARCH_PROVIDERS: "" }).getPortWebTools() as Record<string, any>;
    const out = await tools.web_search.execute({ query: "aapl" });
    expect(out).toMatchObject({ ok: false, error: "web_search_provider_not_configured" });
  });

  it("web_fetch returns a named error code for an invalid URL, never fabricated content", async () => {
    const tools = new AnyAgent().getPortWebTools() as Record<string, any>;
    const out = await tools.web_fetch.execute({ url: "ftp://example.com/x" });
    expect(out).toMatchObject({ ok: false, error: "web_fetch_unsupported_protocol" });
  });

  it("web_fetch fetches real content through the service", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("plain body", { status: 200, headers: { "content-type": "text/plain" } })
    );
    const tools = new AnyAgent().getPortWebTools() as Record<string, any>;
    const out = await tools.web_fetch.execute({ url: "https://example.com/a" });
    expect(out.status).toBe(200);
    expect(JSON.stringify(out)).toContain("plain body");
  });

  it("beforeTurn adds the web tools additively on top of the class's own config", async () => {
    const config: any = await new HookedAgent().beforeTurn(thinkCtx() as never);
    expect(config.instructions).toBe("own");
    expect(Object.keys(config.tools).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("beforeTurn never duplicates a tool the turn already carries (own or MCP-discovered)", async () => {
    const config: any = await new HookedAgent().beforeTurn(
      thinkCtx(["tool_openaimp_web_fetch", "web_search"]) as never
    );
    expect(config.tools).toBeUndefined();
  });

  it("beforeTurn adds nothing when both capabilities are disabled by config", async () => {
    const config: any = await new HookedAgent({
      AGENT_CAPABILITIES_DISABLED: "*:webFetch,*:webSearch",
    }).beforeTurn(thinkCtx() as never);
    expect(config).toEqual({ instructions: "own" });
  });

  it("the manifest reports both web tools enabled for a plain fleet class — no key is required", () => {
    const m = resolveAgentCapabilityManifest("ResearchAgent", { env: {} });
    expect(m.tools.webFetch.state).toBe("enabled");
    // #3935: the chain's keyless provider means web_search needs no
    // provider secret, so the entry carries no prerequisite and
    // resolves enabled against an empty env.
    expect(m.tools.webSearch.state).toBe("enabled");
    expect(m.tools.webSearch.prerequisite).toBeUndefined();
  });
});
