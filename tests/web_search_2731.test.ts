/**
 * Issue #2731 (tracker #2708 item A2) — the `web_search` MCP tool.
 *
 * The registry's web-search family was recorded `absent` by S14
 * (#2417) because no web_search tool existed. This slice builds the
 * tool behind a named-provider seam (src/services/webSearch.ts).
 * Since #3935 that seam carries a provider CHAIN, free/keyless first
 * (SearXNG → DuckDuckGo → Brave); this suite still pins the #2731
 * honesty contract, in both directions, with the unconfigured case
 * now expressed as an EMPTY chain:
 *
 *   - An empty provider chain → the call FAILS with the named error
 *     `web_search_provider_not_configured`. Never fabricated
 *     results, never a silent empty success.
 *   - Provider configured → results are the provider's, shaped
 *     {title, url, snippet}, with the provider named in-band.
 *   - Provider failure (HTTP error, network throw, contract-breaking
 *     payload) → `web_search_provider_error`, never an empty success.
 *   - A provider's honestly-empty result set is a real count: 0.
 *
 * Provider HTTP is fixture-driven through an injected fetch (the
 * service seam) or a stubbed global fetch (the command seam) — the
 * suite never reaches the network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { WebSearchCommand } from "../src/mcps/openaimp/webSearchCommands";
import {
  WebSearchError,
  executeWebSearch,
  resolveWebSearchProvider,
} from "../src/services/webSearch";
import { getToolFamily } from "../src/agents/registry";
import type { McpToolContext } from "../src/patterns/interfaces";

function makeContext(env: Record<string, unknown>): McpToolContext {
  return {
    env,
    orm: {} as any,
    sessionId: "session-web-search-2731",
    audit: vi.fn(),
  } as unknown as McpToolContext;
}

interface FetchCall {
  url: string;
  init: any;
}

function braveFetch(payload: unknown, status = 200) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const BRAVE_FIXTURE = {
  web: {
    results: [
      { title: "Alpha", url: "https://alpha.example/a", description: "first snippet" },
      { title: "Beta", url: "https://beta.example/b", description: "second snippet" },
      { title: "Gamma", url: "https://gamma.example/c", description: "third snippet" },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Catalog + scope + schema
// ---------------------------------------------------------------------------

describe("web_search catalog registration (#2731)", () => {
  it("is registered in the factory with the mcp:read scope", () => {
    expect(McpToolFactory.getTool("web_search")).toBeDefined();
    expect(MCP_TOOL_SCOPES.web_search).toBe("mcp:read");
  });

  it("carries no identity input — login rides the context, never a tool argument", () => {
    const cmd = new WebSearchCommand();
    expect(Object.keys(cmd.jsonSchema.properties).sort()).toEqual(["count", "query"]);
    expect(cmd.jsonSchema.required).toEqual(["query"]);
    const parsed = cmd.zodSchema.parse({ query: "x", login: "mallory", actingLogin: "mallory" }) as Record<string, unknown>;
    expect("login" in parsed).toBe(false);
    expect("actingLogin" in parsed).toBe(false);
  });

  it("rejects an empty query", async () => {
    const ctx = makeContext({ BRAVE_SEARCH_API_KEY: "k" });
    await expect(new WebSearchCommand().execute({ query: "   " }, ctx)).rejects.toThrow(/query is required/);
  });
});

// ---------------------------------------------------------------------------
// The fail-loud contract (no provider configured in this deployment)
// ---------------------------------------------------------------------------

describe("web_search provider resolution (#2731)", () => {
  it("an empty provider chain: fails loud with the named error, and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called when unconfigured");
    });
    vi.stubGlobal("fetch", fetchSpy);
    // #3935: the default chain is keyless-first, so "no provider
    // configured" is now expressed as an explicitly empty chain.
    const ctx = makeContext({ WEB_SEARCH_PROVIDERS: "" });
    const err = await new WebSearchCommand().execute({ query: "cloudflare workers" }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_provider_not_configured");
    expect(err.message).toContain("BRAVE_SEARCH_API_KEY");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctx.audit).toHaveBeenCalledWith(
      "web_search.config_error",
      "orchestrator",
      expect.objectContaining({ code: "web_search_provider_not_configured" }),
    );
  });

  it("an unknown WEB_SEARCH_PROVIDER value fails loud, naming the value", async () => {
    const err = await executeWebSearch({ WEB_SEARCH_PROVIDER: "altavista" }, "q", 5).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_provider_unknown");
    expect(err.message).toContain("altavista");
  });

  it("a named-but-unconfigured provider fails as not_configured, naming the missing secret", async () => {
    const err = await executeWebSearch({ WEB_SEARCH_PROVIDER: "brave" }, "q", 5).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_provider_not_configured");
    expect(err.message).toContain("brave");
    expect(err.message).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("resolveWebSearchProvider returns the chain's head — free/keyless first", () => {
    // #3935: a keyed Brave no longer outranks the keyless provider;
    // the chain order decides, and the default order is free first.
    expect(resolveWebSearchProvider({ BRAVE_SEARCH_API_KEY: "k" }).id).toBe("duckduckgo");
    expect(
      resolveWebSearchProvider({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }).id,
    ).toBe("brave");
  });
});

// ---------------------------------------------------------------------------
// Configured provider behavior (fixture-driven)
// ---------------------------------------------------------------------------

describe("web_search with a configured Brave provider (#2731)", () => {
  it("returns shaped results with the provider named in-band, and audits the call", async () => {
    const { fn, calls } = braveFetch(BRAVE_FIXTURE);
    vi.stubGlobal("fetch", fn);
    const ctx = makeContext({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "test-key" });
    const result = await new WebSearchCommand().execute({ query: "cloudflare workers" }, ctx);
    expect(result.provider).toBe("brave");
    expect(result.query).toBe("cloudflare workers");
    expect(result.count).toBe(3);
    expect(result.results[0]).toEqual({
      title: "Alpha",
      url: "https://alpha.example/a",
      snippet: "first snippet",
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("cloudflare workers");
    expect(calls[0].init.headers["X-Subscription-Token"]).toBe("test-key");
    expect(ctx.audit).toHaveBeenCalledWith(
      "mcp.tool_called",
      "orchestrator",
      expect.objectContaining({ tool: "web_search", provider: "brave", count: 3 }),
    );
  });

  it("clamps count into 1..10 before the provider sees it", async () => {
    const many = {
      web: {
        results: Array.from({ length: 12 }, (_, i) => ({
          title: `T${i}`,
          url: `https://e.example/${i}`,
          description: `s${i}`,
        })),
      },
    };
    const { fn, calls } = braveFetch(many);
    const outcome = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }, "q", 50, fn);
    expect(outcome.count).toBe(10);
    expect(new URL(calls[0].url).searchParams.get("count")).toBe("10");
    const { fn: fn2 } = braveFetch(many);
    const outcome2 = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }, "q", 0, fn2);
    expect(outcome2.count).toBe(1);
  });

  it("an honestly-empty provider response is a real count: 0, not an error", async () => {
    const { fn } = braveFetch({ web: { results: [] } });
    const outcome = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }, "obscure query", 5, fn);
    expect(outcome.provider).toBe("brave");
    expect(outcome.count).toBe(0);
    expect(outcome.results).toEqual([]);
  });

  it("an HTTP failure is a named provider error — never an empty success", async () => {
    const { fn } = braveFetch({ error: "rate limited" }, 429);
    const err = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }, "q", 5, fn).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    // #3935: an exhausted chain surfaces ONE aggregate error that
    // carries the provider's own named code and reason.
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts).toHaveLength(1);
    expect(err.attempts[0]).toMatchObject({ provider: "brave", code: "web_search_provider_error" });
    expect(err.message).toContain("brave");
    expect(err.message).toContain("429");
  });

  it("a network throw is a named provider error", async () => {
    const fn = vi.fn(async () => {
      throw new Error("socket boom");
    }) as unknown as typeof fetch;
    const err = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }, "q", 5, fn).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts[0].reason).toContain("socket boom");
  });

  it("a contract-breaking payload is a named provider error, not empty results", async () => {
    const { fn } = braveFetch({ unexpected: true });
    const err = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }, "q", 5, fn).catch((e) => e);
    expect(err).toBeInstanceOf(WebSearchError);
    expect(err.code).toBe("web_search_all_providers_failed");
    expect(err.attempts[0]).toMatchObject({ provider: "brave", code: "web_search_provider_error" });
  });

  it("results missing url or title are dropped, never fabricated", async () => {
    const { fn } = braveFetch({
      web: {
        results: [
          { title: "Kept", url: "https://kept.example/", description: "ok" },
          { title: "No URL", description: "dropped" },
          { url: "https://no-title.example/", description: "dropped" },
        ],
      },
    });
    const outcome = await executeWebSearch({ WEB_SEARCH_PROVIDERS: "brave", BRAVE_SEARCH_API_KEY: "k" }, "q", 5, fn);
    expect(outcome.count).toBe(1);
    expect(outcome.results[0].url).toBe("https://kept.example/");
  });
});

// ---------------------------------------------------------------------------
// Registry truth-sync
// ---------------------------------------------------------------------------

describe("web-search registry family (#2731)", () => {
  it("records live: the command surface is served and a keyless provider answers with no config", () => {
    const family = getToolFamily("web-search");
    expect(family).toBeDefined();
    // #3935: the keyless provider in the chain means the family has a
    // working backend with zero configuration — no longer degraded.
    expect(family!.status).toBe("live");
    expect(family!.commands).toEqual(["web_search"]);
    expect(family!.source).toContain("src/mcps/openaimp/webSearchCommands.ts");
    expect(family!.notes ?? "").toContain("BRAVE_SEARCH_API_KEY");
    expect(family!.notes ?? "").toContain("web_search_provider_not_configured");
  });
});
