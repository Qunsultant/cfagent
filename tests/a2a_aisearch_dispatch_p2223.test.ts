/**
 * Issue #2223 (AiSearchAgent slice) — AiSearchAgent: three-path
 * search runner + A2A dispatch.
 *
 * The agent reaches the SAME Cloudflare AI Search instance the
 * SearchHub knowledge surface serves (POST /search/agent ->
 * AiSearchInstanceService over AI_SEARCH_ENDPOINT), through three
 * access paths in user-set priority order (directive 2026-10-29):
 *
 * 1. namespace (PRIMARY) — the ai_search_namespaces binding
 *    (env.AI_SEARCH.get(instance).search), gated on the binding plus
 *    AI_SEARCH_INSTANCE. It powers BOTH the turn tool and search().
 * 2. mcp (SECOND) — the instance's public /mcp endpoint, tool
 *    "search", via the repo's RemoteMcpClient, gated on
 *    AI_SEARCH_MCP_ENDPOINT (dashboard Public Endpoint = owner gate).
 * 3. rest (LAST RESORT) — AiSearchInstanceService reused exactly
 *    as-is, gated on AI_SEARCH_ENDPOINT (the hub's own var).
 *
 * Honesty: no path configured -> typed degraded result, zero
 * fabricated results; a path that throws falls through with the
 * failure recorded; a REST answer carrying the service's in-band
 * `degraded` reason is surfaced as DEGRADED (code degraded_fallback),
 * never as results and never as an ok empty answer — since #1169 S3
 * removed the service's fabricated FINANCIAL_KNOWLEDGE_BASE fallback,
 * an unserved REST answer is zero results plus that reason.
 *
 * Result items are hub-consistent: the S2 fields of
 * AISearchResultItem (title/snippet/source/score + bucket-key
 * provenance), produced for the namespace/MCP paths by the SAME
 * mapAiSearchChunks the REST leg's service uses.
 */
import { describe, it, expect } from "vitest";

import {
  runAiSearchPaths,
  adaptAiSearchChunks,
  type AiSearchAgentDeps,
  type AiSearchAgentResultItem,
  type AiSearchAgentSearchResult,
} from "../src/agents/aiSearchPaths";
import {
  AISEARCH_A2A_OPERATIONS,
  dispatchAiSearchA2A,
  aiSearchA2AOutcome,
} from "../src/agents/aiSearchDispatch";
import type { AISearchQueryResponse } from "../src/services/aiSearch";
import { getAgentCard } from "../src/a2a/agent-cards";
import { resolveA2AAgent, resolveA2AInstanceName } from "../src/a2a/resolution";
import { RemoteMcpClient } from "../src/mcps/client/mcpClient";

type EnvLike = Parameters<typeof runAiSearchPaths>[0];

/** Fake namespace instance in the workers-types binding shape. */
function fakeInstance(chunks: unknown[]) {
  const calls: Array<{ messages: unknown }> = [];
  return {
    calls,
    search: async (params: { messages: unknown }) => {
      calls.push(params);
      return { search_query: "q", chunks };
    },
  };
}

const NS_CHUNK = {
  id: "chunk-1",
  type: "text",
  score: 0.87,
  text: "Pattern day traders must maintain minimum equity of $25,000.",
  item: {
    key: "knowledge/broker_rules/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    metadata: { title: "FINRA Rule 4210", category: "broker_rules" },
  },
};

const MCP_CHUNK = {
  id: "chunk-9",
  type: "text",
  score: 0.66,
  text: "Options involve risk and are not suitable for all investors.",
  item: {
    key: "knowledge/options_disclosure/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    metadata: { title: "ODD", category: "options_disclosure" },
  },
};

const LIVE_REST = {
  query: "q",
  results: [
    {
      id: "doc-1",
      title: "NVIDIA 10-K",
      url: "https://www.sec.gov/example",
      snippet: "Data Center revenue grew.",
      score: 0.93,
      category: "sec_filing" as const,
    },
  ],
  totalMatches: 1,
  provider: "cloudflare_ai_search" as const,
  timestamp: "2026-10-29T00:00:00Z",
};

// Post-#1169 S3 the REST service has no fallback corpus to answer
// from: an unserved answer is zero results + an in-band degraded
// reason (provider stays "cloudflare_ai_search"; no served result
// can carry "semantic_cache" anymore).
const DEGRADED_REST_FIXTURE = {
  query: "q",
  results: [],
  totalMatches: 0,
  provider: "cloudflare_ai_search" as const,
  timestamp: "2026-11-04T00:00:00Z",
  degraded: "upstream_http_error" as const,
};

describe("AiSearchAgent path priority (#2223)", () => {
  it("namespace wins when all three paths are configured (PRIMARY)", async () => {
    const inst = fakeInstance([NS_CHUNK]);
    let mcpCalls = 0;
    let restCalls = 0;
    const env = {
      AI_SEARCH: { get: (name: string) => (name === "kb" ? inst : undefined) },
      AI_SEARCH_INSTANCE: "kb",
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
      AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com",
      // KNOWLEDGE_SERVING_ENABLED on: the S2 mapping preserves true
      // scores/categories and stamps bucket-key provenance. (Flag
      // off reproduces the pre-S2 mapping — defaulted 0.9 score,
      // forced category, no provenance — that is the service's own
      // flag contract, pinned by the #1169 S2 suites, not re-pinned
      // here.)
      KNOWLEDGE_SERVING_ENABLED: "1",
    } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      mcpSearch: async () => {
        mcpCalls++;
        return [MCP_CHUNK];
      },
      restSearch: async () => {
        restCalls++;
        return LIVE_REST;
      },
    };
    const result = await runAiSearchPaths(env, "pattern day trader", {}, deps);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("namespace");
    expect(mcpCalls).toBe(0);
    expect(restCalls).toBe(0);
    // The doc-pattern call: messages array with one user message.
    expect(inst.calls).toEqual([{ messages: [{ role: "user", content: "pattern day trader" }] }]);
    // Hub-consistent mapped item: S2 fields + bucket-key provenance,
    // chunk text carried as the snippet.
    expect(result.results).toHaveLength(1);
    expect(result.results![0]).toMatchObject({
      title: "FINRA Rule 4210",
      snippet: "Pattern day traders must maintain minimum equity of $25,000.",
      source: NS_CHUNK.item.key,
      score: 0.87,
      bucketKey: NS_CHUNK.item.key,
      category: "broker_rules",
    });
  });

  it("MCP wins over REST when the namespace path is absent (SECOND beats LAST RESORT)", async () => {
    let restCalls = 0;
    const env = {
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
      AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com",
    } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      mcpSearch: async (_endpoint, _query) => [MCP_CHUNK],
      restSearch: async () => {
        restCalls++;
        return LIVE_REST;
      },
    };
    const result = await runAiSearchPaths(env, "options risk", {}, deps);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("mcp");
    expect(restCalls).toBe(0);
    expect(result.results![0]).toMatchObject({
      title: "ODD",
      snippet: "Options involve risk and are not suitable for all investors.",
      source: MCP_CHUNK.item.key,
      score: 0.66,
    });
  });

  it("REST serves when it is the only configured path, mapping service items hub-consistently", async () => {
    const env = { AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com" } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = { restSearch: async () => LIVE_REST };
    const result = await runAiSearchPaths(env, "nvidia", {}, deps);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("rest");
    expect(result.results).toEqual([
      {
        title: "NVIDIA 10-K",
        snippet: "Data Center revenue grew.",
        source: "https://www.sec.gov/example",
        score: 0.93,
        category: "sec_filing",
      },
    ]);
  });

  it("no path configured -> typed degraded result, zero fabricated results", async () => {
    const result = await runAiSearchPaths({} as EnvLike, "anything", {}, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_configured");
    expect(result.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
    expect(result.results).toBeUndefined();
    expect(result.degraded).toMatch(/no AI Search access path is configured/i);
    expect(result.correlationId).toBeTruthy();
  });

  it("a throwing path falls through to the next configured path and the failure is recorded", async () => {
    const env = {
      AI_SEARCH: {
        get: () => ({
          search: async () => {
            throw new Error("namespace boom");
          },
        }),
      },
      AI_SEARCH_INSTANCE: "kb",
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
    } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = { mcpSearch: async () => [MCP_CHUNK] };
    const result = await runAiSearchPaths(env, "options risk", {}, deps);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("mcp");
    expect(result.degraded).toMatch(/namespace/);
    expect(result.degraded).toMatch(/namespace boom/);
  });

  it("all configured paths failing -> honest all_paths_failed error, never a fabricated success", async () => {
    const env = {
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
      AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com",
    } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      mcpSearch: async () => {
        throw new Error("mcp down");
      },
      restSearch: async () => {
        throw new Error("rest down");
      },
    };
    const result = await runAiSearchPaths(env, "q", {}, deps);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("all_paths_failed");
    expect(result.errorToken).toBe("ERR_TOOL_EXECUTION_FAILED");
    expect(result.error).toMatch(/mcp/);
    expect(result.error).toMatch(/rest/);
    expect(result.results).toBeUndefined();
  });

  it("empty or missing query -> invalid_input, no path attempted", async () => {
    let restCalls = 0;
    const env = { AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com" } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      restSearch: async () => {
        restCalls++;
        return LIVE_REST;
      },
    };
    for (const q of ["", "   ", undefined as unknown as string]) {
      const result = await runAiSearchPaths(env, q, {}, deps);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("invalid_input");
      expect(result.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
    }
    expect(restCalls).toBe(0);
  });
});

describe("AiSearchAgent REST honesty (#2223)", () => {
  it("degraded REST output (in-band degraded reason) is surfaced as DEGRADED, never as results", async () => {
    // Adapted by #1169 S3 (user directive 2026-11-04): was
    // "fallback-labelled REST output (semantic_cache)…". The service
    // no longer has a fallback to label; the runner now keys off the
    // response's `degraded` reason. Assertions kept at equal or
    // greater strength (reason surfaced, withholding stated, no rows).
    const env = { AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com" } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = { restSearch: async () => DEGRADED_REST_FIXTURE };
    const result = await runAiSearchPaths(env, "pattern day trader", {}, deps);
    expect(result.ok).toBe(false);
    expect(result.path).toBe("rest");
    expect(result.code).toBe("degraded_fallback");
    expect(result.degraded).toMatch(/upstream_http_error/);
    expect(result.degraded).toMatch(/did not serve the query/i);
    expect(result.degraded).toMatch(/withheld/);
    // The degraded answer is withheld, not laundered into results.
    expect(result.results).toBeUndefined();
  });

  it("DEFAULT rest executor constructs the real AiSearchInstanceService (reuse, not reimplementation)", async () => {
    // No deps override: the runner builds the service over env.
    // With the endpoint configured but unreachable (test netblock /
    // hermetic fetch), the service returns its degraded contract
    // (#1169 S3) — and the agent must surface exactly that as
    // degraded, never as an ok empty answer.
    const env = { AI_SEARCH_ENDPOINT: "https://unreachable.invalid/ai-search" } as unknown as EnvLike;
    const result = await runAiSearchPaths(env, "pattern day trader", {}, {});
    expect(result.ok).toBe(false);
    expect(result.path).toBe("rest");
    expect(result.code).toBe("degraded_fallback");
    expect(result.results).toBeUndefined();
  });

  it("DEFAULT mcp executor goes through RemoteMcpClient.callTool with tool 'search'", async () => {
    const original = RemoteMcpClient.callTool;
    const seen: Array<{ serverUrl: string; toolName: string; args: Record<string, unknown> }> = [];
    RemoteMcpClient.callTool = async (params: {
      serverUrl: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }) => {
      seen.push({ serverUrl: params.serverUrl, toolName: params.toolName, args: params.arguments });
      return { search_query: "options risk", chunks: [MCP_CHUNK] };
    };
    try {
      const env = {
        AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
      } as unknown as EnvLike;
      const result = await runAiSearchPaths(env, "options risk", {}, {});
      expect(result.ok).toBe(true);
      expect(result.path).toBe("mcp");
      expect(seen).toEqual([
        {
          serverUrl: "https://example.search.ai.cloudflare.com/mcp",
          toolName: "search",
          args: { query: "options risk" },
        },
      ]);
      expect(result.results![0].title).toBe("ODD");
    } finally {
      RemoteMcpClient.callTool = original;
    }
  });
});

describe("AiSearchAgent chunk adaptation (#2223)", () => {
  it("binding-shaped chunks adapt losslessly (text -> snippet, item.key -> key)", () => {
    const adapted = adaptAiSearchChunks([NS_CHUNK]);
    expect(adapted).toHaveLength(1);
    expect(adapted![0]).toMatchObject({
      snippet: NS_CHUNK.text,
      key: NS_CHUNK.item.key,
      score: 0.87,
    });
    // Native fields are preserved, not replaced.
    expect((adapted![0] as { item: unknown }).item).toBe(NS_CHUNK.item);
  });

  it("REST-shaped chunks pass through unchanged; unrecognizable payloads return null", () => {
    const restChunk = { snippet: "s", key: "knowledge/sec_filing/x", score: 0.5, item: { id: "d1" } };
    const adapted = adaptAiSearchChunks({ result: { chunks: [restChunk] } });
    expect(adapted![0]).toBe(restChunk);
    expect(adaptAiSearchChunks({ raw: "plain text" })).toBeNull();
    expect(adaptAiSearchChunks(42)).toBeNull();
    expect(adaptAiSearchChunks(null)).toBeNull();
  });
});

describe("AiSearchAgent A2A dispatch (#2223)", () => {
  const ENV = {} as EnvLike;

  function fakeSearch(result: Partial<AiSearchAgentSearchResult>) {
    const calls: Array<{ query: string }> = [];
    const search = async (
      _env: EnvLike,
      query: string,
    ): Promise<AiSearchAgentSearchResult> => {
      calls.push({ query });
      return {
        ok: true,
        correlationId: "corr-test",
        results: [{ title: "FINRA Rule 4210", snippet: "…", source: "knowledge/broker_rules/x" }],
        path: "namespace",
        ...result,
      };
    };
    return { search, calls };
  }

  it("aisearch.search routes to the search executor and reports the serving path", async () => {
    const { search, calls } = fakeSearch({});
    const data = await dispatchAiSearchA2A(ENV, { operation: "aisearch.search", query: "margin rules" }, { search });
    expect(data.ok).toBe(true);
    expect(data.operation).toBe("aisearch.search");
    expect(data.correlationId).toBeTruthy();
    expect(calls).toEqual([{ query: "margin rules" }]);
    const outcome = aiSearchA2AOutcome(data);
    expect(outcome.text).toContain("aisearch.search");
    expect(outcome.text).toContain("namespace");
    expect((data.result as AiSearchAgentSearchResult).results).toHaveLength(1);
  });

  it("accepts the JSON-RPC message/send data-part envelope", async () => {
    const { search, calls } = fakeSearch({});
    const body = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: {
        message: {
          parts: [{ kind: "data", data: { operation: "aisearch.search", query: "margin" } }],
        },
      },
    };
    const data = await dispatchAiSearchA2A(ENV, body, { search });
    expect(data.ok).toBe(true);
    expect(calls).toEqual([{ query: "margin" }]);
  });

  it("a degraded search result stays degraded through the dispatch — ok:false, honest text", async () => {
    const { search } = fakeSearch({
      ok: false,
      results: undefined,
      path: "rest",
      code: "degraded_fallback",
      degraded: "REST path degraded (upstream_unreachable); answer withheld",
    });
    const data = await dispatchAiSearchA2A(ENV, { operation: "aisearch.search", query: "x" }, { search });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("degraded_fallback");
    expect(data.result).toBeUndefined();
    expect(aiSearchA2AOutcome(data).text).toMatch(/degraded/i);
  });

  it("unknown operation -> classified unknown_operation with a catalog errorToken", async () => {
    const { search, calls } = fakeSearch({});
    const data = await dispatchAiSearchA2A(ENV, { operation: "aisearch.bogus" }, { search });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("unknown_operation");
    expect(data.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
    expect(calls).toHaveLength(0);
    expect(aiSearchA2AOutcome(data).text).toContain("failed:");
  });

  it("missing operation -> missing_operation (empty body, null body, non-object body)", async () => {
    const { search } = fakeSearch({});
    for (const body of [{}, null, "a string", 42]) {
      const data = await dispatchAiSearchA2A(ENV, body, { search });
      expect(data.ok).toBe(false);
      expect(data.code).toBe("missing_operation");
      expect(data.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
      expect(data.correlationId).toBeTruthy();
    }
  });

  it("aisearch.search without a query is invalid_input, not a search call", async () => {
    const { search, calls } = fakeSearch({});
    const data = await dispatchAiSearchA2A(ENV, { operation: "aisearch.search" }, { search });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("never throws when the search executor throws — classified internal_error", async () => {
    const search = async (): Promise<AiSearchAgentSearchResult> => {
      throw new Error("kaboom");
    };
    const data = await dispatchAiSearchA2A(ENV, { operation: "aisearch.search", query: "x" }, { search });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("internal_error");
    expect(data.errorToken).toBe("ERR_TOOL_EXECUTION_FAILED");
    expect(data.error).toContain("kaboom");
  });

  it("DEFAULT dispatch executor runs the real path runner (no config -> not_configured)", async () => {
    const data = await dispatchAiSearchA2A(ENV, { operation: "aisearch.search", query: "x" });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("not_configured");
  });

  it("anti-drift: aisearch card ops == dispatch served ops; resolution -> AI_SEARCH_AGENT, URL-name instance", () => {
    const card = getAgentCard("aisearch");
    expect(card).toBeDefined();
    expect([...card!.operations].sort()).toEqual([...AISEARCH_A2A_OPERATIONS].sort());
    expect(card!.operations).toEqual(["aisearch.search"]);
    expect(card!.endpoint).toBe("/a2a/aisearch");
    expect(card!.description).toMatch(/namespace/i);
    expect(card!.description).toMatch(/MCP/);
    expect(card!.description).toMatch(/REST/);
    const resolution = resolveA2AAgent("aisearch");
    expect(resolution).toBeDefined();
    expect(resolution!.binding).toBe("AI_SEARCH_AGENT");
    expect(resolution!.instanceName).toBeUndefined();
    expect(resolveA2AInstanceName(resolution!, "aisearch", ENV as never)).toBe("aisearch");
  });
});

describe("AiSearchAgent REST degraded contract (#1169 S3)", () => {
  const ENV = { AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com" } as unknown as EnvLike;

  // The degraded-answer half of this contract is pinned by the
  // adapted "REST honesty" test above (degraded reason ->
  // degraded_fallback). This pin covers the other half: the rewire
  // must not over-block a served answer.
  const EMPTY_OK_REST: AISearchQueryResponse = {
    query: "unindexed topic",
    results: [],
    totalMatches: 0,
    provider: "cloudflare_ai_search",
    timestamp: "2026-11-04T00:00:00.000Z",
  };

  it("REST-leg ok-but-empty answer (empty index) -> ok with zero items, NOT degraded", async () => {
    const deps: AiSearchAgentDeps = { restSearch: async () => EMPTY_OK_REST };
    const result = await runAiSearchPaths(ENV, "unindexed topic", {}, deps);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("rest");
    expect(result.results).toEqual([]);
    expect(result.code).toBeUndefined();
  });
});

// The class itself is exercised by source-evidence pins in
// tests/agent-conformance.test.ts (the suite cannot instantiate a
// real Agent under Node); the runner + dispatch above are the
// behavior pins.
void (0 as unknown as AiSearchAgentResultItem);
