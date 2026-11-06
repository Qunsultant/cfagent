/**
 * Issue #2223 (AiSearchAgent slice) — AiSearchAgent: two-path
 * search runner + A2A dispatch.
 *
 * The agent reaches the SAME Cloudflare AI Search instance the
 * SearchHub knowledge surface serves, through two access paths in
 * user-set priority order (directive 2026-10-29):
 *
 * 1. namespace (PRIMARY) — the ai_search_namespaces binding
 *    (env.AI_SEARCH.get(instance).search), gated on the binding plus
 *    AI_SEARCH_INSTANCE. It powers BOTH the turn tool and search().
 * 2. mcp (SECOND) — the instance's public /mcp endpoint, tool
 *    "search", via the repo's RemoteMcpClient, gated on
 *    AI_SEARCH_MCP_ENDPOINT (dashboard Public Endpoint = owner gate).
 *
 * A third path existed until issue #3342: rest (LAST RESORT) —
 * AiSearchInstanceService over the public endpoint
 * (AI_SEARCH_ENDPOINT). #3342 retired it (the endpoint is
 * unauthenticated by design): the service is a deprecated shim,
 * the var is deleted, and an endpoint-only environment now
 * configures nothing. The REST-era tests below were adapted or
 * retired with the path; each change is marked inline, and the
 * retirement contract itself is pinned in
 * tests/ai_search_rest_migration_p3342.test.ts.
 *
 * Honesty: no path configured -> typed degraded result, zero
 * fabricated results; a path that throws falls through with the
 * failure recorded; since #1169 S3 removed the fabricated
 * FINANCIAL_KNOWLEDGE_BASE fallback, an unserved answer is zero
 * results plus a typed reason, never substitute content.
 *
 * Result items are hub-consistent: the S2 fields of
 * AISearchResultItem (title/snippet/source/score + bucket-key
 * provenance), produced by the SAME mapAiSearchChunks every
 * serving path uses.
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

describe("AiSearchAgent path priority (#2223)", () => {
  it("namespace wins when both paths are configured (PRIMARY)", async () => {
    const inst = fakeInstance([NS_CHUNK]);
    let mcpCalls = 0;
    const env = {
      AI_SEARCH: { get: (name: string) => (name === "kb" ? inst : undefined) },
      AI_SEARCH_INSTANCE: "kb",
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
      // KNOWLEDGE_SERVING_ENABLED on: the S2 mapping preserves true
      // scores/categories and stamps bucket-key provenance. (Flag
      // off reproduces the pre-S2 mapping — defaulted 0.9 score,
      // forced category, no provenance — that is the mapping's own
      // flag contract, pinned by the #1169 S2 suites, not re-pinned
      // here.)
      KNOWLEDGE_SERVING_ENABLED: "1",
    } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      mcpSearch: async () => {
        mcpCalls++;
        return [MCP_CHUNK];
      },
    };
    const result = await runAiSearchPaths(env, "pattern day trader", {}, deps);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("namespace");
    expect(mcpCalls).toBe(0);
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

  it("MCP serves when the namespace path is absent (SECOND)", async () => {
    const env = {
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
    } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      mcpSearch: async (_endpoint, _query) => [MCP_CHUNK],
    };
    const result = await runAiSearchPaths(env, "options risk", {}, deps);
    expect(result.ok).toBe(true);
    expect(result.path).toBe("mcp");
    expect(result.results![0]).toMatchObject({
      title: "ODD",
      snippet: "Options involve risk and are not suitable for all investors.",
      source: MCP_CHUNK.item.key,
      score: 0.66,
    });
  });

  it("an endpoint-only environment configures NOTHING (the REST path is retired, #3342)", async () => {
    // Replaces "REST serves when it is the only configured path":
    // the retired path must not silently come back — the legacy
    // var alone yields the typed not_configured outcome, with no
    // path label and zero fabricated results. (The full retirement
    // contract is pinned in
    // tests/ai_search_rest_migration_p3342.test.ts.)
    const env = { AI_SEARCH_ENDPOINT: "https://example.search.ai.cloudflare.com" } as unknown as EnvLike;
    const result = await runAiSearchPaths(env, "nvidia", {}, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_configured");
    expect(result.path).toBeUndefined();
    expect(result.results).toBeUndefined();
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
      AI_SEARCH: { get: (name: string) => (name === "kb" ? fakeInstance([]) : undefined) },
      AI_SEARCH_INSTANCE: "kb",
      AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp",
    } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      namespaceSearch: async () => {
        throw new Error("namespace down");
      },
      mcpSearch: async () => {
        throw new Error("mcp down");
      },
    };
    const result = await runAiSearchPaths(env, "q", {}, deps);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("all_paths_failed");
    expect(result.errorToken).toBe("ERR_TOOL_EXECUTION_FAILED");
    expect(result.error).toMatch(/namespace/);
    expect(result.error).toMatch(/mcp/);
    expect(result.results).toBeUndefined();
  });

  it("empty or missing query -> invalid_input, no path attempted", async () => {
    let mcpCalls = 0;
    const env = { AI_SEARCH_MCP_ENDPOINT: "https://example.search.ai.cloudflare.com/mcp" } as unknown as EnvLike;
    const deps: AiSearchAgentDeps = {
      mcpSearch: async () => {
        mcpCalls++;
        return [MCP_CHUNK];
      },
    };
    for (const q of ["", "   ", undefined as unknown as string]) {
      const result = await runAiSearchPaths(env, q, {}, deps);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("invalid_input");
      expect(result.errorToken).toBe("ERR_UNKNOWN_AGENT_ERROR");
    }
    expect(mcpCalls).toBe(0);
  });
});

describe("AiSearchAgent default executors (#2223)", () => {
  // Retired by #3342 with the REST path: the "REST honesty"
  // describe that lived here pinned (a) that a degraded REST answer
  // (in-band degraded reason) surfaces as DEGRADED
  // (code degraded_fallback), never as results, and (b) that the
  // DEFAULT rest executor constructs the real
  // AiSearchInstanceService. Both pins asserted the retired path's
  // contract; the surviving honesty contract — an unserved answer
  // is a typed failure with zero results, an empty served answer
  // stays ok — is pinned by the path-priority tests above, the
  // empty-answer test below, and
  // tests/ai_search_rest_migration_p3342.test.ts (endpoint-only
  // env -> not_configured; the shim never fetches).

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

  it("already-adapted (REST-layout) chunks pass through unchanged; unrecognizable payloads return null", () => {
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

  it("a failed search result stays failed through the dispatch — ok:false, honest text", async () => {
    // Adapted by #3342: the fake previously modelled the retired
    // REST path's degraded_fallback outcome (and the dispatch's
    // dedicated text branch for it, also removed). The surviving
    // failure shape is all_paths_failed; the dispatch must carry it
    // through unlaundered, with the runner's error in the text.
    const { search } = fakeSearch({
      ok: false,
      results: undefined,
      path: "mcp",
      code: "all_paths_failed",
      error: "All configured AI Search paths failed: mcp: mcp down",
    });
    const data = await dispatchAiSearchA2A(ENV, { operation: "aisearch.search", query: "x" }, { search });
    expect(data.ok).toBe(false);
    expect(data.code).toBe("all_paths_failed");
    expect(data.result).toBeUndefined();
    expect(aiSearchA2AOutcome(data).text).toContain("failed:");
    expect(aiSearchA2AOutcome(data).text).toContain("mcp down");
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
    // #3342: the card no longer advertises a REST door — the third
    // path was retired and the description is two-path now.
    expect(card!.description).not.toMatch(/REST/);
    const resolution = resolveA2AAgent("aisearch");
    expect(resolution).toBeDefined();
    expect(resolution!.binding).toBe("AI_SEARCH_AGENT");
    expect(resolution!.instanceName).toBeUndefined();
    expect(resolveA2AInstanceName(resolution!, "aisearch", ENV as never)).toBe("aisearch");
  });
});

describe("AiSearchAgent served-empty contract (#1169 S3)", () => {
  // Retargeted by #3342 from the REST leg to the namespace leg:
  // the contract under pin is path-independent — a served-but-empty
  // answer (the index genuinely has nothing) is an ok answer with
  // zero items, NOT a degraded outcome; an empty index must never
  // be confused with an unavailable one. The degraded half of the
  // S3 contract (unserved -> typed failure, zero results) is
  // pinned by the path-priority tests above.
  it("namespace-leg ok-but-empty answer (empty index) -> ok with zero items, NOT degraded", async () => {
    const env = {
      AI_SEARCH: { get: (name: string) => (name === "kb" ? fakeInstance([]) : undefined) },
      AI_SEARCH_INSTANCE: "kb",
    } as unknown as EnvLike;
    const result = await runAiSearchPaths(env, "unindexed topic", {}, {});
    expect(result.ok).toBe(true);
    expect(result.path).toBe("namespace");
    expect(result.results).toEqual([]);
    expect(result.code).toBeUndefined();
    expect(result.degraded).toBeUndefined();
  });
});

// The class itself is exercised by source-evidence pins in
// tests/agent-conformance.test.ts (the suite cannot instantiate a
// real Agent under Node); the runner + dispatch above are the
// behavior pins.
void (0 as unknown as AiSearchAgentResultItem);
