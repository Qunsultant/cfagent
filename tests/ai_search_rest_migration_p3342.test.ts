/**
 * Issue #3342 — AI Search REST migration (migrate-first, then the
 * owner disables the public endpoint).
 *
 * Before this slice, three production consumers rode the public
 * AI_SEARCH_ENDPOINT through the REST service class
 * (AiSearchInstanceService): Search Hub POST /search/agent, MAS
 * searchKnowledge (its searchRaw leg), and the MCP command
 * ai_search_financial_docs — plus the AiSearchAgent runner's third
 * (REST) path and the legacy knowledge_search "search" contract's
 * direct fetch. The endpoint is unauthenticated by design; the
 * migration moves every consumer onto the private
 * ai_search_namespaces binding (directly, or through the
 * AiSearchAgent's DO door), retires the runner's REST path, retires
 * the service class by deprecation, and deletes AI_SEARCH_ENDPOINT
 * from wrangler vars + the Env type.
 *
 * Pins below are the post-migration contract. On the pristine tree
 * the behavioural ones fail (the REST path still serves, the route
 * and the MCP command still call the service, the helper does not
 * exist); the two marked PRESERVED pass before and after — they are
 * the characterization half of the TDD pair.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import {
  runAiSearchPaths,
  searchAiSearchNamespaceChunks,
} from "../src/agents/aiSearchPaths";
import { handleSearchHubRoutes } from "../src/agents/routes/searchHub";
import { createMAS } from "../src/agents/mas";
import { __resetAiSearchCacheForTests } from "../src/services/aiSearchCache";
import { AiSearchInstanceService, mapAiSearchChunks } from "../src/services/aiSearch";
import { AISearchFinancialDocsCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";
import type { AiSearchAgentSearchResult } from "../src/agents/aiSearchPaths";

type EnvLike = Parameters<typeof runAiSearchPaths>[0];

/** Fake namespace binding instance in the workers-types shape. */
function fakeBindingInstance(chunks: unknown[]) {
  const calls: Array<{ messages: unknown }> = [];
  return {
    calls,
    search: async (params: { messages: unknown }) => {
      calls.push(params);
      return { search_query: "q", chunks };
    },
  };
}

const bindingEnv = (instance: unknown, name = "screener-search") =>
  ({
    AI_SEARCH: { get: (n: string) => (n === name ? instance : undefined) },
    AI_SEARCH_INSTANCE: name,
  }) as any;

const NS_CHUNK = {
  id: "chunk-1",
  type: "text",
  score: 0.87,
  text: "Pattern day traders must maintain minimum equity of $25,000.",
  item: {
    key: "knowledge/broker_rules/aaaa",
    metadata: { title: "FINRA Rule 4210", category: "broker_rules" },
  },
};

const REPORT_CHUNK = {
  id: "chunk-r",
  type: "text",
  score: 0.91,
  text: "Weekly screen results for the owner.",
  item: {
    key: "report:rpt-1",
    metadata: { title: "Weekly screen", kind: "report", ownerLogin: "alice" },
  },
};

describe("#3342 runner: the REST path is retired", () => {
  it("an endpoint-only env configures NOTHING (not_configured, zero fabricated results)", async () => {
    const env = {
      AI_SEARCH_ENDPOINT: "https://unreachable.invalid/ai-search",
    } as unknown as EnvLike;
    const result = await runAiSearchPaths(env, "pattern day trader", {}, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_configured");
    expect(result.path).toBeUndefined();
    expect(result.results).toBeUndefined();
  });

  it("the not_configured note names only the two surviving paths", async () => {
    const result = await runAiSearchPaths({} as EnvLike, "anything", {}, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_configured");
    expect(result.degraded).toMatch(/namespace/);
    expect(result.degraded).toMatch(/MCP/);
    expect(result.degraded).not.toMatch(/AI_SEARCH_ENDPOINT/);
    expect(result.degraded).not.toMatch(/REST path/);
  });

  it("namespace remains PRIMARY and MCP the fallthrough (PRESERVED)", async () => {
    const inst = fakeBindingInstance([NS_CHUNK]);
    const env = {
      ...bindingEnv(inst),
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
    } as unknown as EnvLike;
    const result = await runAiSearchPaths(env, "pattern day trader", {}, {});
    expect(result.ok).toBe(true);
    expect(result.path).toBe("namespace");
    expect(result.results).toHaveLength(1);
    expect(result.results![0].title).toBe("FINRA Rule 4210");
  });
});

describe("#3342 namespace chunks helper (MAS / legacy search contract leg)", () => {
  it("returns adapted chunks from the binding (text -> snippet, item.key -> key)", async () => {
    const inst = fakeBindingInstance([NS_CHUNK]);
    const outcome = await searchAiSearchNamespaceChunks(bindingEnv(inst), "margin");
    expect(outcome.ok).toBe(true);
    expect(outcome.chunks).toHaveLength(1);
    const chunk = outcome.chunks![0] as any;
    expect(chunk.snippet).toBe(NS_CHUNK.text);
    expect(chunk.key).toBe(NS_CHUNK.item.key);
    expect(chunk.item).toBe(NS_CHUNK.item);
    expect(inst.calls).toEqual([
      { messages: [{ role: "user", content: "margin" }] },
    ]);
  });

  it("report discipline: report chunks are withheld without a proven owner login", async () => {
    const inst = fakeBindingInstance([NS_CHUNK, REPORT_CHUNK]);
    const anon = await searchAiSearchNamespaceChunks(bindingEnv(inst), "screens");
    expect(anon.ok).toBe(true);
    expect(anon.chunks).toHaveLength(1);
    expect((anon.chunks![0] as any).key).toBe(NS_CHUNK.item.key);
    expect(anon.withheld).toBe(1);

    const other = await searchAiSearchNamespaceChunks(bindingEnv(inst), "screens", {
      callerLogin: "bob",
    });
    expect(other.chunks).toHaveLength(1);
    expect(other.withheld).toBe(1);

    const owner = await searchAiSearchNamespaceChunks(bindingEnv(inst), "screens", {
      callerLogin: "alice",
    });
    expect(owner.chunks).toHaveLength(2);
    expect(owner.withheld).toBe(0);
  });

  it("unconfigured binding -> typed not_configured outcome, never a throw", async () => {
    const outcome = await searchAiSearchNamespaceChunks({} as any, "margin");
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("not_configured");
    expect(outcome.chunks).toBeUndefined();
  });

  it("a throwing binding -> typed search_failed outcome carrying the failure", async () => {
    const inst = {
      search: async () => {
        throw new Error("binding boom");
      },
    };
    const outcome = await searchAiSearchNamespaceChunks(bindingEnv(inst), "margin");
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("search_failed");
    expect(outcome.error).toMatch(/binding boom/);
  });
});

/** Fake AI_SEARCH_AGENT DO namespace, mirroring the #3323 suite. */
function fakeAgentNamespace(
  searchImpl: (query: string, opts?: { callerLogin?: string; limit?: number }) => Promise<AiSearchAgentSearchResult>,
) {
  const calls: { idFromName: string[]; search: Array<{ query: string; opts?: { callerLogin?: string; limit?: number } }> } = {
    idFromName: [],
    search: [],
  };
  const stub = {
    search: async (query: string, opts?: { callerLogin?: string; limit?: number }) => {
      calls.search.push({ query, opts });
      return searchImpl(query, opts);
    },
  };
  const namespace = {
    idFromName: (name: string) => {
      calls.idFromName.push(name);
      return `id:${name}`;
    },
    get: () => stub,
  };
  return { namespace, calls };
}

const AGENT_ITEM = {
  title: "FINRA Rule 4210",
  snippet: "Pattern day traders must maintain minimum equity of $25,000.",
  source: "knowledge/broker_rules/aaaa",
  score: 0.87,
  category: "broker_rules" as const,
  bucketKey: "knowledge/broker_rules/aaaa",
};

const postAgent = (body: unknown, env: unknown, login = "alice") =>
  handleSearchHubRoutes(
    new Request("https://agent.internal/api/search/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(login ? { "x-user-login": login } : {}),
      },
      body: JSON.stringify(body),
    }),
    new URL("https://agent.internal/api/search/agent"),
    "/api/search/agent",
    "sess",
    { env: env as any, userLogin: login, audit: () => {} } as any,
  );

describe("#3342 POST /search/agent serves through the AiSearchAgent door", () => {
  it("served answer keeps the service-native shape (query/results/totalMatches/provider/timestamp)", async () => {
    const { namespace, calls } = fakeAgentNamespace(async () => ({
      ok: true,
      path: "namespace",
      correlationId: "corr-1",
      results: [AGENT_ITEM],
    }));
    const res = await postAgent({ query: "margin rules" }, { AI_SEARCH_AGENT: namespace });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.query).toBe("margin rules");
    expect(body.provider).toBe("cloudflare_ai_search");
    expect(body.totalMatches).toBe(1);
    expect(body.degraded).toBeUndefined();
    expect(typeof body.timestamp).toBe("string");
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      title: "FINRA Rule 4210",
      snippet: AGENT_ITEM.snippet,
      url: "knowledge/broker_rules/aaaa",
      score: 0.87,
      category: "broker_rules",
      bucketKey: "knowledge/broker_rules/aaaa",
    });
    // The route's session login is threaded as callerLogin; the
    // fixed service instance is the one resolved.
    expect(calls.idFromName).toEqual(["aisearch"]);
    expect(calls.search[0].opts?.callerLogin).toBe("alice");
  });

  it("binding absent -> the PRESERVED degraded shape (endpoint_not_configured, zero results)", async () => {
    const res = await postAgent({ query: "options risk" }, {});
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
    expect(body.degraded).toBe("endpoint_not_configured");
    expect(body.provider).toBe("cloudflare_ai_search");
  });

  it("agent all_paths_failed -> degraded upstream_unreachable, zero results", async () => {
    const { namespace } = fakeAgentNamespace(async () => ({
      ok: false,
      path: "mcp",
      code: "all_paths_failed",
      correlationId: "corr-2",
      error: "Every configured AI Search path failed: namespace: boom.",
    }));
    const res = await postAgent({ query: "margin rules" }, { AI_SEARCH_AGENT: namespace });
    const body = await res!.json();
    expect(body.results).toEqual([]);
    expect(body.totalMatches).toBe(0);
    expect(body.degraded).toBe("upstream_unreachable");
  });
});

describe("#3342 MAS searchKnowledge rides the binding", () => {
  beforeEach(() => __resetAiSearchCacheForTests());
  afterEach(() => __resetAiSearchCacheForTests());

  const masOpts = (env: any, sessionId: string) => ({
    env,
    sessionId,
    requestId: "req-3342",
    sql: { exec: () => [] as unknown as Iterable<unknown> },
    audit: () => {},
  });

  it("index chunks come from the binding; report-type chunks are withheld (no MAS login)", async () => {
    const inst = fakeBindingInstance([
      { title: "Index doc", snippet: "Served from the index." },
      REPORT_CHUNK,
    ]);
    const mas: any = createMAS(masOpts(bindingEnv(inst), "sess-3342-a"));
    const res = await mas.searchKnowledge.execute({ query: "margin rules" });
    expect(res.resultsFound).toBe(true);
    expect(res.count).toBe(1);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].title).toBe("Index doc");
  });

  it("unconfigured binding with no local reports -> the upstream-failure shape ({ error, query } only)", async () => {
    const mas: any = createMAS(masOpts({} as any, "sess-3342-b"));
    const res = await mas.searchKnowledge.execute({ query: "margin rules" });
    expect(res.error).toMatch(/Knowledge search upstream unavailable/);
    expect(res.query).toBe("margin rules");
    expect(res).not.toHaveProperty("resultsFound");
  });
});

describe("#3342 MCP ai_search_financial_docs dispatches through the agent door", () => {
  const mcpContext = (env: unknown, sessionId = "alice") =>
    ({
      env,
      sessionId,
      orm: {},
      audit: vi.fn(),
    }) as any;

  it("answer shape preserved (AISearchQueryResponse), callerLogin threaded from the session carrier", async () => {
    const { namespace, calls } = fakeAgentNamespace(async () => ({
      ok: true,
      path: "namespace",
      correlationId: "corr-1",
      results: [AGENT_ITEM],
    }));
    const cmd = new AISearchFinancialDocsCommand();
    const answer: any = await cmd.execute(
      { query: "margin rules" },
      mcpContext({ AI_SEARCH_AGENT: namespace }),
    );
    expect(answer.query).toBe("margin rules");
    expect(answer.provider).toBe("cloudflare_ai_search");
    expect(answer.totalMatches).toBe(1);
    expect(answer.degraded).toBeUndefined();
    expect(answer.results).toHaveLength(1);
    expect(answer.results[0]).toMatchObject({
      title: "FINRA Rule 4210",
      url: "knowledge/broker_rules/aaaa",
      score: 0.87,
    });
    expect(calls.idFromName).toEqual(["aisearch"]);
    expect(calls.search[0].opts?.callerLogin).toBe("alice");
  });

  it("binding absent -> degraded endpoint_not_configured in the preserved shape", async () => {
    const cmd = new AISearchFinancialDocsCommand();
    const answer: any = await cmd.execute(
      { query: "margin rules" },
      mcpContext({}),
    );
    expect(answer.results).toEqual([]);
    expect(answer.totalMatches).toBe(0);
    expect(answer.degraded).toBe("endpoint_not_configured");
    expect(answer.provider).toBe("cloudflare_ai_search");
  });

  it("agent all_paths_failed -> degraded upstream_unreachable", async () => {
    const { namespace } = fakeAgentNamespace(async () => ({
      ok: false,
      path: "namespace",
      code: "all_paths_failed",
      correlationId: "corr-2",
      error: "Every configured AI Search path failed: namespace: boom.",
    }));
    const cmd = new AISearchFinancialDocsCommand();
    const answer: any = await cmd.execute(
      { query: "margin rules" },
      mcpContext({ AI_SEARCH_AGENT: namespace }),
    );
    expect(answer.results).toEqual([]);
    expect(answer.degraded).toBe("upstream_unreachable");
  });
});

describe("#3342 the REST service class is a retired deprecation shim", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("searchFinancialDocs never fetches: the degraded contract answers endpoint_not_configured", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { chunks: [] } }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const svc = new AiSearchInstanceService({
      AI_SEARCH_ENDPOINT: "https://search.example.test",
    } as any);
    const res = await svc.searchFinancialDocs("margin rules", 5);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.degraded).toBe("endpoint_not_configured");
    expect(res.results).toEqual([]);
    expect(res.totalMatches).toBe(0);
    expect(res.provider).toBe("cloudflare_ai_search");
  });

  it("searchRaw throws the retirement error instead of fetching", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const svc = new AiSearchInstanceService({
      AI_SEARCH_ENDPOINT: "https://search.example.test",
    } as any);
    await expect(svc.searchRaw("margin rules")).rejects.toThrow(/retired/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the shared chunk mapping survives the retirement (the runner still uses it)", () => {
    const items = mapAiSearchChunks(
      [{ key: "k1", snippet: "s", score: 0.5, item: { id: "d1", metadata: { title: "T" } } }],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("T");
  });

  it("source pins: deprecation names the successor; the #3322 alias and the endpoint var are gone", () => {
    const service = readFileSync("src/services/aiSearch.ts", "utf8");
    expect(service).toContain("@deprecated");
    expect(service).toContain("superseded by");
    expect(service).not.toContain("ETradeAISearchService");
    const types = readFileSync("src/types.ts", "utf8");
    expect(types).not.toMatch(/AI_SEARCH_ENDPOINT\s*:/);
    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    expect(wrangler).not.toContain("\"AI_SEARCH_ENDPOINT\"");
  });
});
