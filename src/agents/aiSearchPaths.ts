/**
 * Issue #2223 (AiSearchAgent slice) — the agent's two-path search
 * runner. Kept OUT of the class module on purpose: the Think/Agents
 * module graph cannot load under Node vitest, so the behavior that
 * needs pins lives here, free of the class graph (the same split
 * slice 1 used: standalone dispatch module + thin class).
 *
 * The agent reaches the SAME Cloudflare AI Search instance the
 * SearchHub knowledge surface serves — since issue #3342 every
 * surface reaches it through the private ai_search_namespaces
 * binding (directly here, or through the agent's DO door in the
 * hub route / MCP commands); the instance configuration is NOT
 * re-vocabularied here (AI_SEARCH_INSTANCE names the instance;
 * AI_SEARCH_MCP_ENDPOINT is additive config for the second door).
 *
 * Access paths, in the priority order set by the user directive of
 * 2026-10-29 (tool first, MCP second):
 *
 * 1. namespace (PRIMARY) — the ai_search_namespaces binding:
 *    env.AI_SEARCH.get(AI_SEARCH_INSTANCE).search({ messages }).
 *    This is the agent-tool door: it powers BOTH the class's turn
 *    tool (getTools) and its direct search() method.
 * 2. mcp (SECOND) — the instance's public /mcp endpoint, tool
 *    "search", consumed through the repo's RemoteMcpClient exactly
 *    as any MCP client would. Gated on AI_SEARCH_MCP_ENDPOINT; the
 *    endpoint itself exists only when the owner enables the
 *    instance's Public Endpoint in the dashboard (deliberately
 *    unset in production — owner decision, #1169).
 *
 * The runner's former third path — REST through
 * AiSearchInstanceService over the public endpoint — was RETIRED
 * by issue #3342: the endpoint is unauthenticated by design, the
 * service class is a deprecated shim, and AI_SEARCH_ENDPOINT is
 * deleted from the worker configuration. An endpoint-only
 * environment now configures nothing and answers not_configured.
 *
 * Result items are hub-consistent: the S2 fields of
 * AISearchResultItem (title / snippet / source / score, plus
 * bucket-key provenance where the serving path provides it). Both
 * paths return the binding's chunk shape, so their chunks are
 * adapted (documented field renames only) and then mapped by the
 * SAME mapAiSearchChunks the retired REST leg's service used —
 * one mapping, one story, whichever door served the answer. The
 * serving path is always labelled via `path`.
 *
 * Honesty (hard rules):
 * - No path configured -> a typed not_configured degraded result.
 *   Zero results are fabricated, ever.
 * - A configured path that throws (or returns an unrecognized
 *   shape) falls through to the next configured path, and the
 *   failure is recorded in the result's `degraded` note.
 * - A genuinely empty OK answer (the instance served, nothing
 *   matched) stays ok with zero items — an empty index is never
 *   confused with an unavailable one.
 * - Report-type results (issue #2246: items this fleet uploads with
 *   document ids `report:<reportId>` and metadata kind "report")
 *   are served ONLY to their owner's login: the search must carry
 *   a callerLogin equal to the item's ownerLogin metadata, or the
 *   item is withheld and the withholding is recorded in the
 *   result's `degraded` note. No login context, a mismatched
 *   login, or an unproven owner (chunk metadata is the only owner
 *   proof; a report-type key without it proves nothing) all
 *   withhold — the safe default wins over recall.
 * - This module never throws.
 *
 * This module also hosts the shared binding helpers the #3342
 * migration put on the namespace path: searchAiSearchNamespaceChunks
 * (raw adapted chunks + the report discipline, for the MAS tool and
 * the legacy knowledge_search contract) and
 * aiSearchAgentResultToQueryResponse (the AISearchQueryResponse
 * shaping the Search Hub /search/agent route and the
 * ai_search_financial_docs MCP command share).
 *
 * Issue #2246 adds the module's ONE write: an indexing executor
 * (runAiSearchIndexUpload) that pushes a document to the instance
 * via the namespace binding's items API — the upload half of the
 * agents-sdk guide pattern. It exists so generated reports can be
 * indexed into the instance at store time (the pipeline hook lives
 * in src/services/reportAiSearchIndex.ts, flag-gated by
 * AI_SEARCH_REPORT_INDEXING_ENABLED, default OFF). The executor is
 * namespace-only (uploads have no MCP equivalent here),
 * config-gated exactly like the search paths, and returns typed
 * outcomes — never a fabricated success.
 *
 * OUT of scope (dashboard-gated): runtime provisioning (no
 * namespace create call). The knowledge-corpus items.upload bridge
 * is issue #3345: it lives in src/services/corpusAiSearchIndex.ts
 * and reuses this module's executor — it is not a second uploader.
 */
import {
  mapAiSearchChunks,
  type AiSearchDegradedReason,
  type AISearchQueryResponse,
  type AISearchResultItem,
} from "../services/aiSearch";
import { isKnowledgeServingEnabled } from "../services/knowledgeCorpus";
import { RemoteMcpClient } from "../mcps/client/mcpClient";
import { AGENT_ERROR_CATALOG, AgentErrorCode } from "../aspects/errorCodes";
import type { Env } from "../types";

/** The access path that served (or last attempted) a search. */
export type AiSearchPath = "namespace" | "mcp";

/**
 * One search result, hub-consistent with the SearchHub knowledge
 * surface: the S2 AISearchResultItem fields, with the item's URL (or
 * its R2 key, per the service mapping) carried as `source`.
 * bucketKey / servedFileLink / indexingState provenance is present
 * exactly when the serving path provides it (KNOWLEDGE_SERVING_ENABLED
 * on, per the S2 mapping) — never invented.
 */
export interface AiSearchAgentResultItem {
  title?: string;
  snippet?: string;
  source?: string;
  score?: number;
  category?: AISearchResultItem["category"];
  bucketKey?: string;
  servedFileLink?: string;
  indexingState?: AISearchResultItem["indexingState"];
}

/** Stable local outcome tokens for the search runner. */
export type AiSearchAgentErrorToken =
  | "invalid_input"
  | "not_configured"
  | "all_paths_failed";

/**
 * Map the local outcome tokens onto AGENT_ERROR_CATALOG keys (the
 * slice-1 pattern): invalid input and not-configured are "the
 * request/environment names something the agent cannot serve"
 * (ERR_UNKNOWN_AGENT_ERROR — the catalog has no validation or
 * configuration class); an all-paths failure is an execution
 * failure (ERR_TOOL_EXECUTION_FAILED). No catalog keys are
 * invented here. (The pre-#3342 degraded_fallback token existed
 * only for the retired REST path's in-band degraded answers; with
 * that path gone, nothing produces it, so it is removed rather
 * than kept as a dead outcome.)
 */
const AISEARCH_CATALOG_CODES: Record<AiSearchAgentErrorToken, AgentErrorCode> = {
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_configured: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  all_paths_failed: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

/** Resolve a local token to its AGENT_ERROR_CATALOG token. */
function aiSearchCatalogCode(token: AiSearchAgentErrorToken): AgentErrorCode {
  const code = AISEARCH_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  // Defensive: the catalog is the authority; never emit a token it
  // does not define.
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

/** The typed result of one agent search. Never a fabricated success. */
export interface AiSearchAgentSearchResult {
  ok: boolean;
  /** Present only on a real (non-degraded) success. */
  results?: AiSearchAgentResultItem[];
  /** The path that served the answer; on failure, the last attempted path. */
  path?: AiSearchPath;
  /**
   * Set whenever the answer is degraded: earlier configured paths
   * failed before this one served, the serving path's own output
   * was degraded and withheld, or report-type results were withheld
   * under the login discipline.
   */
  degraded?: string;
  /** Stable local outcome token when ok is false. */
  code?: AiSearchAgentErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  /** Human-readable failure detail when ok is false. */
  error?: string;
  correlationId: string;
}

export interface AiSearchAgentSearchOptions {
  /** Max results to return (default 5, mirroring the service default). */
  limit?: number;
  /**
   * Issue #2246: the login the search is performed for, when the
   * caller has one. Report-type results are served only when this
   * equals the item's ownerLogin metadata; absent (the A2A door and
   * the turn tool carry no login today) report-type results are
   * withheld. Threading a session login into those callers is the
   * recorded follow-up — until then the safe default applies.
   */
  callerLogin?: string;
}

/**
 * Injectable path executors. The defaults are the real doors; tests
 * substitute fakes per path. namespaceSearch receives the resolved
 * binding instance; mcpSearch the endpoint URL.
 */
export interface AiSearchAgentDeps {
  namespaceSearch?: (
    instance: AiSearchNamespaceInstanceLike,
    query: string,
  ) => Promise<unknown>;
  mcpSearch?: (endpoint: string, query: string) => Promise<unknown>;
}

/** Structural minimum of the binding's instance handle this runner uses. */
export interface AiSearchNamespaceInstanceLike {
  search(params: {
    messages: Array<{ role: "user"; content: string }>;
  }): Promise<unknown>;
}

const defaultNamespaceSearch: NonNullable<AiSearchAgentDeps["namespaceSearch"]> = (
  instance,
  query,
) => instance.search({ messages: [{ role: "user", content: query }] });

const defaultMcpSearch: NonNullable<AiSearchAgentDeps["mcpSearch"]> = (endpoint, query) =>
  RemoteMcpClient.callTool({
    serverUrl: endpoint,
    toolName: "search",
    arguments: { query },
  });

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Adapt AI Search chunks from either native shape into the REST
 * chunk layout mapAiSearchChunks consumes:
 * - binding chunks (AiSearchSearchResponse) carry the chunk text in
 *   `text` and the item key at `item.key`;
 * - REST chunks already carry `snippet` and a top-level `key`.
 * The renames are the documented field correspondences (chunk text
 * IS the snippet; the item's key IS the chunk's R2 key) — values are
 * never invented, only relocated, and only when the target field is
 * absent. Accepts a bare chunk array or any envelope carrying a
 * `chunks` array (the binding response, the REST `{ result }`
 * envelope, an MCP tool payload). Returns null when no chunk array
 * exists — the caller treats that as a path failure, never as an
 * empty success.
 */
export function adaptAiSearchChunks(payload: unknown): unknown[] | null {
  let chunks: unknown = payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.chunks)) {
      chunks = p.chunks;
    } else if (
      p.result !== null &&
      typeof p.result === "object" &&
      Array.isArray((p.result as Record<string, unknown>).chunks)
    ) {
      chunks = (p.result as Record<string, unknown>).chunks;
    } else if (Array.isArray(p.results)) {
      chunks = p.results;
    }
  }
  if (!Array.isArray(chunks)) return null;
  return chunks.map((chunk) => {
    if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) return chunk;
    const c = chunk as Record<string, unknown>;
    const item =
      c.item !== null && typeof c.item === "object" && !Array.isArray(c.item)
        ? (c.item as Record<string, unknown>)
        : undefined;
    const snippet =
      typeof c.snippet === "string"
        ? c.snippet
        : typeof c.text === "string"
          ? c.text
          : undefined;
    const key =
      typeof c.key === "string" ? c.key : typeof item?.key === "string" ? item.key : undefined;
    if (snippet === c.snippet && key === c.key) return chunk;
    return {
      ...c,
      ...(snippet !== undefined ? { snippet } : {}),
      ...(key !== undefined ? { key } : {}),
    };
  });
}

/** Map S2 service items into the agent's hub-consistent item shape. */
function toAgentItems(items: readonly AISearchResultItem[]): AiSearchAgentResultItem[] {
  return items.map((item) => ({
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.snippet !== undefined ? { snippet: item.snippet } : {}),
    ...(item.url !== undefined ? { source: item.url } : {}),
    ...(item.score !== undefined ? { score: item.score } : {}),
    ...(item.category !== undefined ? { category: item.category } : {}),
    ...(item.bucketKey !== undefined ? { bucketKey: item.bucketKey } : {}),
    ...(item.servedFileLink !== undefined ? { servedFileLink: item.servedFileLink } : {}),
    ...(item.indexingState !== undefined ? { indexingState: item.indexingState } : {}),
  }));
}

/**
 * Issue #2246: the document-id prefix for report documents in the
 * instance (`report:<reportId>` — the same document-id convention
 * the Vectorize leg uses in reportSemanticIndex.ts). The item key
 * is the one identification signal that survives EVERY serving
 * path's chunk mapping (as bucketKey, or as the item url when the
 * chunk carries no url), so the login discipline keys off it, with
 * chunk metadata as the owner-carrying refinement where it
 * survives (both surviving paths carry chunk metadata).
 */
export const AI_SEARCH_REPORT_DOCUMENT_PREFIX = "report:";

/** Mapped items after the report login discipline, plus the withheld count. */
interface MappedWithDiscipline {
  items: AiSearchAgentResultItem[];
  withheld: number;
}

/**
 * Issue #2246: is this (adapted) chunk a report-type item, and what
 * owner does its metadata prove? Report-type = chunk metadata
 * kind "report" (what the indexing executor writes) OR the item
 * key carrying the report document prefix. Anything else is not a
 * report and is never disciplined.
 */
function reportChunkVerdict(chunk: unknown): { report: boolean; ownerLogin?: string } {
  if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) {
    return { report: false };
  }
  const c = chunk as Record<string, unknown>;
  const item =
    c.item !== null && typeof c.item === "object" && !Array.isArray(c.item)
      ? (c.item as Record<string, unknown>)
      : undefined;
  const rawMeta = item ? item.metadata : undefined;
  const meta =
    rawMeta !== null && typeof rawMeta === "object" && !Array.isArray(rawMeta)
      ? (rawMeta as Record<string, unknown>)
      : undefined;
  const key =
    typeof c.key === "string"
      ? c.key
      : typeof item?.key === "string"
        ? item.key
        : undefined;
  const byKind = meta?.kind === "report";
  const byKey = key !== undefined && key.startsWith(AI_SEARCH_REPORT_DOCUMENT_PREFIX);
  if (!byKind && !byKey) return { report: false };
  return {
    report: true,
    ownerLogin: typeof meta?.ownerLogin === "string" ? meta.ownerLogin : undefined,
  };
}

/**
 * The discipline's keep/withhold decision for ONE verdict: a
 * non-report item always passes; a report-type item is served ONLY
 * when a callerLogin is present AND equals its proven ownerLogin.
 * Shared by the mapped-item discipline below and the raw-chunk
 * discipline in searchAiSearchNamespaceChunks (#3342) so every
 * binding consumer enforces the identical rule.
 */
function reportChunkServed(
  verdict: { report: boolean; ownerLogin?: string } | undefined,
  callerLogin: string | undefined,
): boolean {
  if (!verdict?.report) return true;
  return Boolean(callerLogin && verdict.ownerLogin && verdict.ownerLogin === callerLogin);
}

/**
 * Issue #2246: apply the report login discipline to mapped items.
 * `verdicts` is parallel to `items` (one per source chunk/item).
 * Every withheld report-type item is counted (the caller surfaces
 * the count in the result's degraded note).
 */
function applyReportDiscipline(
  items: AiSearchAgentResultItem[],
  verdicts: Array<{ report: boolean; ownerLogin?: string }>,
  callerLogin: string | undefined,
): MappedWithDiscipline {
  let withheld = 0;
  const kept = items.filter((_, idx) => {
    if (reportChunkServed(verdicts[idx], callerLogin)) return true;
    withheld += 1;
    return false;
  });
  return { items: kept, withheld };
}

/**
 * Map a chunk payload from the namespace or MCP path through the
 * shared S2 mapping, then apply the #2246 report login discipline
 * (the mapper is 1:1, so chunk verdicts stay parallel to items).
 * Throws when the payload carries no chunk array (an unrecognized
 * shape is a path failure, not an empty success) and propagates
 * the mapper's AiSearchMappingError on malformed chunks — the
 * visible-failure behaviour the service itself has.
 */
function mapChunkPayload(
  env: Env,
  payload: unknown,
  callerLogin: string | undefined,
): MappedWithDiscipline {
  const chunks = adaptAiSearchChunks(payload);
  if (chunks === null) {
    throw new Error("AI Search response carried no recognizable chunks array.");
  }
  const items = toAgentItems(mapAiSearchChunks(chunks, isKnowledgeServingEnabled(env)));
  const verdicts = chunks.map((chunk) => reportChunkVerdict(chunk));
  return applyReportDiscipline(items, verdicts, callerLogin);
}

interface PathAttempt {
  path: AiSearchPath;
  run: () => Promise<MappedWithDiscipline>;
}

/**
 * Run one search across the configured paths in priority order
 * (namespace -> mcp). Never throws; every outcome is a typed
 * result.
 */
export async function runAiSearchPaths(
  env: Env,
  query: string,
  opts: AiSearchAgentSearchOptions = {},
  deps: AiSearchAgentDeps = {},
): Promise<AiSearchAgentSearchResult> {
  const correlationId = crypto.randomUUID();
  const cleanQuery = typeof query === "string" ? query.trim() : "";
  if (!cleanQuery) {
    return {
      ok: false,
      code: "invalid_input",
      errorToken: aiSearchCatalogCode("invalid_input"),
      correlationId,
      error: "AiSearchAgent.search requires a non-empty query string.",
    };
  }
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : 5;
  const callerLogin = nonEmptyString(opts.callerLogin) ?? undefined;

  const attempts: PathAttempt[] = [];

  // 1. namespace (PRIMARY): binding + instance name.
  const instanceName = nonEmptyString(env.AI_SEARCH_INSTANCE);
  if (env.AI_SEARCH && instanceName) {
    const binding = env.AI_SEARCH;
    const namespaceSearch = deps.namespaceSearch ?? defaultNamespaceSearch;
    attempts.push({
      path: "namespace",
      run: async () => {
        const instance = binding.get(instanceName);
        if (!instance || typeof instance.search !== "function") {
          throw new Error(
            `AI Search namespace binding resolved no searchable instance for "${instanceName}".`,
          );
        }
        return mapChunkPayload(env, await namespaceSearch(instance, cleanQuery), callerLogin);
      },
    });
  }

  // 2. mcp (SECOND): the instance's public /mcp endpoint.
  const mcpEndpoint = nonEmptyString(env.AI_SEARCH_MCP_ENDPOINT);
  if (mcpEndpoint) {
    const mcpSearch = deps.mcpSearch ?? defaultMcpSearch;
    attempts.push({
      path: "mcp",
      run: async () => mapChunkPayload(env, await mcpSearch(mcpEndpoint, cleanQuery), callerLogin),
    });
  }

  if (attempts.length === 0) {
    const degraded =
      "No AI Search access path is configured: the namespace path needs the ai_search_namespaces binding (env.AI_SEARCH) plus AI_SEARCH_INSTANCE, and the MCP path needs AI_SEARCH_MCP_ENDPOINT (the instance's dashboard-enabled public endpoint).";
    return {
      ok: false,
      code: "not_configured",
      errorToken: aiSearchCatalogCode("not_configured"),
      correlationId,
      degraded,
      error: degraded,
    };
  }

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const { items, withheld } = await attempt.run();
      const sliced = items.slice(0, limit);
      const notes: string[] = [];
      if (failures.length > 0) {
        notes.push(
          `Served by the ${attempt.path} path after earlier configured path(s) failed: ${failures.join("; ")}.`,
        );
      }
      if (withheld > 0) {
        notes.push(
          `${withheld} report-type result(s) withheld under the report login discipline: report results are served only to the report owner's login (#2246).`,
        );
      }
      return {
        ok: true,
        path: attempt.path,
        correlationId,
        results: sliced,
        ...(notes.length > 0 ? { degraded: notes.join(" ") } : {}),
      };
    } catch (err) {
      failures.push(
        `${attempt.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ok: false,
    path: attempts[attempts.length - 1].path,
    code: "all_paths_failed",
    errorToken: aiSearchCatalogCode("all_paths_failed"),
    correlationId,
    error: `Every configured AI Search path failed: ${failures.join("; ")}.`,
  };
}

// =====================================================================
// Issue #3342 — shared binding helpers for the migrated consumers.
// =====================================================================

/** The typed outcome of one namespace-chunks search. Never throws. */
export interface AiSearchNamespaceChunksOutcome {
  ok: boolean;
  /** Adapted chunks (REST layout) after the report discipline. */
  chunks?: unknown[];
  /** Report-type chunks withheld under the #2246 discipline. */
  withheld?: number;
  /** Stable local outcome token when ok is false. */
  code?: "not_configured" | "search_failed";
  /** Human-readable failure detail when ok is false. */
  error?: string;
}

/**
 * Issue #3342: the binding-backed raw-chunks leg for the consumers
 * whose contracts are chunk-shaped rather than agent-shaped — the
 * MAS searchKnowledge tool and the legacy knowledge_search
 * "search" contract (src/mcps/openaimp/commands.ts). Both used to
 * read the public endpoint directly (the service's searchRaw, and
 * a bare fetch); both now read the SAME namespace binding the
 * runner's primary path uses, through this one helper.
 *
 * The returned chunks are adapted into the REST layout
 * (adaptAiSearchChunks: chunk text as `snippet`, item key as
 * top-level `key`, the native chunk object otherwise untouched) so
 * the consumers' downstream handling — MAS's corpus-provenance
 * attach, the legacy contract's slicing — sees the shape it always
 * saw. The #2246 report discipline applies with the identical rule
 * the runner enforces (reportChunkServed): a caller with no proven
 * owner login (MAS carries none) has report-type chunks withheld;
 * a caller carrying the session login (the MCP contract) is served
 * only its own reports.
 *
 * Never throws: an unconfigured binding is a typed not_configured
 * outcome and a failed search a typed search_failed outcome, so
 * each caller keeps its own honest failure shape.
 */
export async function searchAiSearchNamespaceChunks(
  env: Env,
  query: string,
  opts: AiSearchAgentSearchOptions = {},
): Promise<AiSearchNamespaceChunksOutcome> {
  const instanceName = nonEmptyString(env?.AI_SEARCH_INSTANCE);
  if (!env?.AI_SEARCH || !instanceName) {
    return {
      ok: false,
      code: "not_configured",
      error:
        "AI Search is not configured: the namespace path needs the ai_search_namespaces binding (env.AI_SEARCH) plus AI_SEARCH_INSTANCE.",
    };
  }
  const callerLogin = nonEmptyString(opts.callerLogin) ?? undefined;
  try {
    const instance = env.AI_SEARCH.get(instanceName);
    if (!instance || typeof instance.search !== "function") {
      throw new Error(
        `AI Search namespace binding resolved no searchable instance for "${instanceName}".`,
      );
    }
    const payload = await instance.search({
      messages: [{ role: "user", content: query }],
    });
    const chunks = adaptAiSearchChunks(payload);
    if (chunks === null) {
      return {
        ok: false,
        code: "search_failed",
        error: "AI Search response carried no recognizable chunks array.",
      };
    }
    let withheld = 0;
    const kept = chunks.filter((chunk) => {
      if (reportChunkServed(reportChunkVerdict(chunk), callerLogin)) return true;
      withheld += 1;
      return false;
    });
    return { ok: true, chunks: kept, withheld };
  } catch (err) {
    return {
      ok: false,
      code: "search_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Issue #3342: shape one AiSearchAgent typed result into the
 * AISearchQueryResponse contract the pre-migration REST consumers
 * served — shared by the Search Hub POST /search/agent route and
 * the ai_search_financial_docs MCP command so the two surfaces can
 * never drift apart. Served answers map item-for-item (the agent
 * item's `source` becomes the result `url`; the item id the agent
 * shape does not carry is re-derived from the bucket key / source,
 * falling back to the mapping's own doc_<n> convention). Failed
 * answers become the degraded contract: zero results plus the
 * stable reason the runner's outcome honestly maps to
 * (not_configured -> endpoint_not_configured, invalid_input ->
 * invalid_query, all_paths_failed -> upstream_unreachable). An
 * ok-but-degraded agent answer (paths fell through, report rows
 * withheld) DID serve, so it carries no `degraded` reason here —
 * the note itself stays visible on the agent-native surfaces
 * (AiSearchAgent tab, ai_search_agent_search).
 */
export function aiSearchAgentResultToQueryResponse(
  query: string,
  result: AiSearchAgentSearchResult,
): AISearchQueryResponse {
  const timestamp = new Date().toISOString();
  if (!result.ok) {
    const degraded: AiSearchDegradedReason =
      result.code === "not_configured"
        ? "endpoint_not_configured"
        : result.code === "invalid_input"
          ? "invalid_query"
          : "upstream_unreachable";
    return {
      query,
      results: [],
      totalMatches: 0,
      provider: "cloudflare_ai_search",
      timestamp,
      degraded,
    };
  }
  const results: AISearchResultItem[] = (result.results ?? []).map((item, idx) => ({
    id: item.bucketKey ?? item.source ?? `doc_${idx}`,
    title: item.title ?? "Financial Document",
    snippet: item.snippet ?? "",
    ...(item.source ? { url: item.source } : {}),
    ...(item.score !== undefined ? { score: item.score } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.bucketKey ? { bucketKey: item.bucketKey } : {}),
    ...(item.servedFileLink ? { servedFileLink: item.servedFileLink } : {}),
    ...(item.indexingState ? { indexingState: item.indexingState } : {}),
  }));
  return {
    query,
    results,
    totalMatches: results.length,
    provider: "cloudflare_ai_search",
    timestamp,
  };
}

// =====================================================================
// Issue #2246 — report indexing: the flag + the upload executor.
// =====================================================================

/**
 * Issue #2246: is report indexing into the AI Search instance
 * enabled? Follows the S2 precedent (isKnowledgeServingEnabled):
 * the env var is a plain string, "1"/"true"/"on" (case-insensitive,
 * trimmed) means ON, and ABSENCE means OFF. The var is deliberately
 * NOT in wrangler.jsonc — the capability ships default-off, and
 * enablement is a config change after the #1169 probe, never a
 * code change. When OFF, the pipeline hook in
 * src/services/reportAiSearchIndex.ts is a silent no-op and report
 * storage behaves exactly as before #2246 (Vectorize leg only).
 */
export function isAiSearchReportIndexingEnabled(
  env?: { AI_SEARCH_REPORT_INDEXING_ENABLED?: string } | null,
): boolean {
  const v = env?.AI_SEARCH_REPORT_INDEXING_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

/**
 * Issue #3345: is corpus indexing into the AI Search instance
 * enabled? The corpus bridge's flag, read with the exact idiom of
 * isAiSearchReportIndexingEnabled above (and S2's
 * isKnowledgeServingEnabled): "1"/"true"/"on" (case-insensitive,
 * trimmed) means ON, ABSENCE means OFF. The var is deliberately
 * NOT in wrangler.jsonc — the bridge ships default-off, and
 * enablement is a config change after the #1169 probe, never a
 * code change. When OFF, the hooks in
 * src/services/corpusAiSearchIndex.ts record the honest
 * not-configured state and corpus writes/syncs behave exactly as
 * before #3345.
 */
export function isAiSearchCorpusIndexingEnabled(
  env?: { AI_SEARCH_CORPUS_INDEXING_ENABLED?: string } | null,
): boolean {
  const v = env?.AI_SEARCH_CORPUS_INDEXING_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

/** A document to index into the instance: id, text content, metadata. */
export interface AiSearchIndexDocument {
  /** The item key the upload is stored under (the document id). */
  id: string;
  /** The document's text content (the instance chunks/embeds it). */
  content: string;
  /** Item metadata, carried verbatim (provenance lives here). */
  metadata: Record<string, unknown>;
}

/** Stable local outcome tokens for the indexing executor. */
export type AiSearchIndexErrorToken =
  | "invalid_input"
  | "not_configured"
  | "upload_failed";

const AISEARCH_INDEX_CATALOG_CODES: Record<AiSearchIndexErrorToken, AgentErrorCode> = {
  invalid_input: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  not_configured: AgentErrorCode.UNKNOWN_AGENT_ERROR,
  upload_failed: AgentErrorCode.TOOL_EXECUTION_FAILED,
};

function aiSearchIndexCatalogCode(token: AiSearchIndexErrorToken): AgentErrorCode {
  const code = AISEARCH_INDEX_CATALOG_CODES[token] ?? AgentErrorCode.UNKNOWN_AGENT_ERROR;
  return AGENT_ERROR_CATALOG[code] ? code : AgentErrorCode.UNKNOWN_AGENT_ERROR;
}

/** The typed outcome of one indexing attempt. Never a fabricated success. */
export interface AiSearchIndexOutcome {
  ok: boolean;
  /** The path that performed the upload (only "namespace" exists). */
  path?: "namespace";
  /** Stable local outcome token when ok is false. */
  code?: AiSearchIndexErrorToken;
  /** Stable AGENT_ERROR_CATALOG token when ok is false. */
  errorToken?: AgentErrorCode;
  /** Human-readable failure detail when ok is false. */
  error?: string;
  correlationId: string;
}

/** The env subset the indexing executor reads (the namespace door's config). */
export interface AiSearchIndexEnv {
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
}

/**
 * Structural minimum of the binding instance's items API this
 * executor uses (the ambient AiSearchInstance satisfies it: items
 * .upload(name, content, { metadata }) is an upsert by item key).
 */
export interface AiSearchNamespaceInstanceUploadLike {
  items: {
    upload(
      name: string,
      content: string,
      options?: { metadata?: Record<string, unknown> },
    ): Promise<unknown>;
  };
}

/** Injectable upload executor. The default is the real binding call. */
export interface AiSearchIndexDeps {
  namespaceUpload?: (
    instance: AiSearchNamespaceInstanceUploadLike,
    doc: AiSearchIndexDocument,
  ) => Promise<unknown>;
}

const defaultNamespaceUpload: NonNullable<AiSearchIndexDeps["namespaceUpload"]> = (
  instance,
  doc,
) => instance.items.upload(doc.id, doc.content, { metadata: doc.metadata });

/**
 * Upload one document into the AI Search instance via the
 * namespace binding's items API (the agents-sdk guide pattern:
 * env.AI_SEARCH.get(AI_SEARCH_INSTANCE).items.upload(...)).
 * Namespace-only: uploads have no MCP/REST equivalent in this
 * layer. Config-gated exactly like the search paths — the binding
 * plus AI_SEARCH_INSTANCE must both be present, else a typed
 * not_configured outcome. Never throws; a failed or impossible
 * upload is an honest upload_failed outcome, never a fabricated
 * success.
 */
export async function runAiSearchIndexUpload(
  env: AiSearchIndexEnv,
  doc: AiSearchIndexDocument,
  deps: AiSearchIndexDeps = {},
): Promise<AiSearchIndexOutcome> {
  const correlationId = crypto.randomUUID();
  const id = typeof doc?.id === "string" ? doc.id.trim() : "";
  const content = typeof doc?.content === "string" ? doc.content : "";
  if (!id || !content) {
    return {
      ok: false,
      code: "invalid_input",
      errorToken: aiSearchIndexCatalogCode("invalid_input"),
      correlationId,
      error: "AiSearch index upload requires a non-empty document id and content.",
    };
  }
  const instanceName = nonEmptyString(env?.AI_SEARCH_INSTANCE);
  if (!env?.AI_SEARCH || !instanceName) {
    const error =
      "AI Search indexing is not configured: the namespace path needs the ai_search_namespaces binding (env.AI_SEARCH) plus AI_SEARCH_INSTANCE.";
    return {
      ok: false,
      code: "not_configured",
      errorToken: aiSearchIndexCatalogCode("not_configured"),
      correlationId,
      error,
    };
  }
  try {
    const instance = env.AI_SEARCH.get(instanceName);
    const uploadFn = (instance as AiSearchNamespaceInstanceUploadLike | null)?.items
      ?.upload;
    if (!instance || typeof uploadFn !== "function") {
      throw new Error(
        `AI Search namespace binding resolved no item-uploadable instance for "${instanceName}".`,
      );
    }
    const upload = deps.namespaceUpload ?? defaultNamespaceUpload;
    await upload(instance as AiSearchNamespaceInstanceUploadLike, { ...doc, id });
    return { ok: true, path: "namespace", correlationId };
  } catch (err) {
    return {
      ok: false,
      code: "upload_failed",
      errorToken: aiSearchIndexCatalogCode("upload_failed"),
      correlationId,
      error: `AI Search index upload failed for document "${id}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
