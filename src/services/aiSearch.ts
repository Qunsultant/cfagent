/**
 * Cloudflare AI Search shared mapping + response contract for
 * financial documentation, plus the RETIRED REST service class.
 *
 * This module's live surface is the mapping layer:
 * mapAiSearchChunks (the one chunk -> result mapping every serving
 * path uses), the AISearchResultItem / AISearchQueryResponse
 * contract types, and the AiSearchDegradedReason vocabulary.
 * Retrieval itself lives behind the private ai_search_namespaces
 * binding: the AiSearchAgent runner (src/agents/aiSearchPaths.ts)
 * and its consumers.
 *
 * Issue #3342 retired the public-endpoint REST transport this
 * module used to own: the endpoint was unauthenticated by design,
 * so every production consumer migrated onto the binding (or the
 * AiSearchAgent door), AI_SEARCH_ENDPOINT was deleted from the
 * worker configuration, and AiSearchInstanceService below remains
 * only as a deprecated shim answering the degraded contract. The
 * S3 honesty contract is unchanged: an unserved answer is zero
 * results plus a stable degraded reason — there is no built-in
 * fallback corpus (removed by issue #1169 S3; the constant is
 * superseded by this degraded contract).
 */

import type { Env } from "../types";
import {
  KNOWLEDGE_CATEGORIES,
  corpusBucketKeyFromIndexKey,
  servedFileLinkFor,
} from "./knowledgeCorpus";
// Issue #1169 (S2, cross-cutting: typed errors + externalized
// messages): the mapping error extends the aspects catalog's
// KnowledgeError — its code/message/remediation live in
// src/aspects/errorCodes.ts, never inline here.
import { KnowledgeError, KnowledgeErrorCode } from "../aspects/errorCodes";

/**
 * Issue #1169 (S2): a flag-ON mapping failure, typed and explicit.
 * Thrown by mapAiSearchChunks when an upstream chunk is malformed
 * (wrong-typed field, non-object chunk). The service rethrows it
 * instead of returning a degraded response — a malformed chunk must
 * fail VISIBLY, never silently degrade or substitute results.
 * `details` names the chunk index and field so the probe can
 * pinpoint the shape mismatch. Flag-OFF never throws: it reproduces
 * today's lenient mapping verbatim.
 */
export class AiSearchMappingError extends KnowledgeError {
  public readonly chunkIndex: number;
  public readonly field: string;

  constructor(chunkIndex: number, field: string) {
    super(
      KnowledgeErrorCode.MAPPING_INVALID_CHUNK,
      `Upstream AI Search chunk ${chunkIndex} has a malformed field '${field}'; the chunk was not mapped.`,
      { chunkIndex, field }
    );
    this.name = "AiSearchMappingError";
    this.chunkIndex = chunkIndex;
    this.field = field;
  }
}

export interface AISearchResultItem {
  id: string;
  title: string;
  url?: string;
  snippet: string;
  /**
   * Issue #1169 (S2, flag-gated): optional since the flag-ON mapping
   * preserves the TRUE index score/category — an upstream chunk that
   * carries no score (or no category) yields no score (or no
   * category), never a defaulted 0.9 or a forced "sec_filing".
   */
  score?: number;
  category?: "sec_filing" | "broker_rules" | "options_disclosure" | "market_education";
  /**
   * Issue #1169 (S2, flag-gated) provenance. Present only when
   * KNOWLEDGE_SERVING_ENABLED is on: bucketKey is the chunk's R2 key
   * when present; servedFileLink exists ONLY for servable corpus
   * keys (a link to anything else would 404); indexingState
   * "indexed" marks index-returned rows — a row the live index
   * returned is, by definition, indexed.
   */
  bucketKey?: string;
  servedFileLink?: string;
  indexingState?: "indexed" | "indexing" | "unknown";
}

/**
 * Issue #1169 (S2, flag-gated): upstream chunk -> result mapping.
 *
 * PROBE-DEPENDENT: the assumed chunk shape is documented in
 * tests/r2_knowledge_serving_p1169.test.ts. If the Step 0 live probe
 * shows a different chunk shape, this mapping + its pins MUST be
 * adjusted before S2 closes. Do not present probe-unverified mapping
 * as proven.
 *
 * flagOn=false reproduces the pre-S2 mapping VERBATIM (defaulted
 * score 0.9, forced category "sec_filing", no provenance) — that is
 * the flag-OFF = today's behavior guarantee, pinned golden.
 * flagOn=true preserves the true score (finite number or absent,
 * never 0.9 — including a legitimate 0, which `||` used to erase)
 * and the true category (one of the four corpus categories or
 * absent, never forced), and stamps provenance.
 */
export function mapAiSearchChunks(chunks: readonly unknown[], flagOn: boolean): AISearchResultItem[] {
  return (chunks as any[]).map((c: any, idx: number) => {
    if (flagOn) {
      // Strict validation, flag-ON only: a malformed chunk fails
      // visibly (AiSearchMappingError, rethrown by the service)
      // instead of being silently defaulted or
      // coerced. ABSENT fields are fine (they yield absent
      // score/category); PRESENT-but-wrong-typed fields are not.
      // Flag-OFF skips this block entirely — today's lenient
      // mapping below is reproduced verbatim.
      const malformed = (field: string): AiSearchMappingError =>
        new AiSearchMappingError(idx, field);
      if (typeof c !== "object" || c === null || Array.isArray(c)) throw malformed("chunk");
      if (c.item !== undefined && (typeof c.item !== "object" || c.item === null || Array.isArray(c.item))) throw malformed("item");
      if (c.item?.metadata !== undefined && (typeof c.item.metadata !== "object" || c.item.metadata === null || Array.isArray(c.item.metadata))) throw malformed("item.metadata");
      if (c.item?.id !== undefined && typeof c.item.id !== "string") throw malformed("item.id");
      if (c.item?.metadata?.title !== undefined && typeof c.item.metadata.title !== "string") throw malformed("item.metadata.title");
      if (c.snippet !== undefined && typeof c.snippet !== "string") throw malformed("snippet");
      if (c.item?.metadata?.description !== undefined && typeof c.item.metadata.description !== "string") throw malformed("item.metadata.description");
      if (c.url !== undefined && typeof c.url !== "string") throw malformed("url");
      if (c.key !== undefined && typeof c.key !== "string") throw malformed("key");
      if (c.score !== undefined && (typeof c.score !== "number" || !Number.isFinite(c.score))) throw malformed("score");
      if (c.item?.metadata?.category !== undefined && typeof c.item.metadata.category !== "string") throw malformed("category");
    }
    const id = c.item?.id || `doc_${idx}`;
    const title = c.item?.metadata?.title || "Financial Document";
    const snippet = c.snippet || c.item?.metadata?.description || "";
    const url = c.url || c.key;
    if (!flagOn) {
      return {
        id,
        title,
        snippet,
        url,
        score: c.score || 0.9,
        category: "sec_filing",
      } as AISearchResultItem;
    }
    const score =
      typeof c.score === "number" && Number.isFinite(c.score) ? c.score : undefined;
    const rawCategory = c.item?.metadata?.category;
    const category =
      typeof rawCategory === "string" &&
      (KNOWLEDGE_CATEGORIES as readonly string[]).includes(rawCategory)
        ? (rawCategory as AISearchResultItem["category"])
        : undefined;
    const rawKey = typeof c.key === "string" ? c.key : undefined;
    // Issue #3345: an items-API corpus chunk carries the corpus
    // document id (`corpus:<bucketKey>`) as its key; resolve it to
    // the servable bucket key so bucketKey / servedFileLink render
    // exactly as they do for an R2-source corpus chunk. Any other
    // key passes through verbatim.
    const bucketKey = rawKey
      ? (corpusBucketKeyFromIndexKey(rawKey) ?? rawKey)
      : undefined;
    const servedFileLink = bucketKey ? servedFileLinkFor(bucketKey) : undefined;
    return {
      id,
      title,
      snippet,
      url,
      score,
      category,
      ...(bucketKey ? { bucketKey } : {}),
      ...(servedFileLink ? { servedFileLink } : {}),
      indexingState: "indexed",
    } as AISearchResultItem;
  });
}

/**
 * Issue #1169 (S3): the stable, machine-readable reasons a
 * searchFinancialDocs answer is DEGRADED — the live AI Search
 * instance did not serve it. These tokens are part of the served
 * contract: consumers (SearchHub tab, MCP command, AiSearchAgent
 * runner) key their degraded presentation/outcome off them, so the
 * values must stay stable; add new reasons, never repurpose one.
 */
export type AiSearchDegradedReason =
  | "endpoint_not_configured"
  | "upstream_unreachable"
  | "upstream_http_error"
  | "upstream_invalid_response"
  // Issue #3342: added when the consumers moved behind the
  // AiSearchAgent runner — the runner rejected the query itself
  // (blank) before any access path was attempted, so no upstream
  // reason honestly applies.
  | "invalid_query";

export interface AISearchQueryResponse {
  query: string;
  results: AISearchResultItem[];
  totalMatches: number;
  provider: "cloudflare_ai_search" | "vectorize";
  timestamp: string;
  /**
   * Issue #1169 (S3): present EXACTLY when the live index did not
   * serve this answer. A degraded response always carries zero
   * results — since S3 removed the built-in fallback corpus, there
   * is nothing else an unserved answer could honestly contain.
   * `provider` names the serving system the answer was requested
   * from; this field is what says it did not serve. Absent on a
   * served answer — including a served EMPTY answer (upstream
   * chunks: []), which is an honest empty index, not a failure;
   * the two stay distinguishable by this field alone.
   */
  degraded?: AiSearchDegradedReason;
}

/**
 * @deprecated superseded by the AI Search namespace binding path —
 * the AiSearchAgent runner (runAiSearchPaths and
 * searchAiSearchNamespaceChunks in src/agents/aiSearchPaths.ts) and
 * the AiSearchAgent door (ai_search_agent_search, #2250) — since
 * issue #3342 retired this class's public-endpoint REST transport.
 *
 * Retirement shape (issue #3342, gitops §22 — deprecated in place,
 * never silently deleted): the class name stays importable so no
 * straggler breaks at load, but the transport is GONE:
 * AI_SEARCH_ENDPOINT is deleted from wrangler.jsonc and from the
 * Env type, so nothing can configure the REST leg anymore, and no
 * method here performs a fetch. searchFinancialDocs answers the
 * module's degraded contract (zero results +
 * endpoint_not_configured) — honest, because for this retired path
 * nothing IS configured — and searchRaw throws, since its raw
 * Response contract has no honest post-retirement answer. Every
 * former caller (Search Hub /search/agent, MAS searchKnowledge,
 * the ai_search_financial_docs MCP command, the agent runner's
 * third path) migrated onto the binding in #3342; do not add new
 * callers.
 */
export class AiSearchInstanceService {
  constructor(private env?: Env) {
    void this.env;
  }

  /**
   * @deprecated superseded by searchAiSearchNamespaceChunks in
   * src/agents/aiSearchPaths.ts (issue #3342). The raw-Response
   * contract this method served (MAS searchKnowledge's leg, owned
   * here since #1775) has no post-retirement equivalent: the method
   * throws rather than fabricate an HTTP response.
   */
  async searchRaw(
    query: string,
    opts?: { signal?: AbortSignal }
  ): Promise<Response> {
    void query;
    void opts;
    throw new Error(
      "AiSearchInstanceService.searchRaw is retired (#3342): the public-endpoint REST transport was removed and AI_SEARCH_ENDPOINT no longer exists in the worker configuration. Use searchAiSearchNamespaceChunks (src/agents/aiSearchPaths.ts) for binding-backed chunks."
    );
  }

  /**
   * @deprecated superseded by the AiSearchAgent runner
   * (runAiSearchPaths in src/agents/aiSearchPaths.ts) and the
   * AiSearchAgent door (issue #3342). The REST transport is
   * retired, so this method can only answer the module's degraded
   * contract: zero results plus the endpoint_not_configured
   * reason — the honest answer for a path whose configuration was
   * deleted. It never fetches and never fabricates results.
   */
  async searchFinancialDocs(query: string, limit: number = 5): Promise<AISearchQueryResponse> {
    void limit;
    console.warn(`[knowledgeSearch] aiSearch degraded reason=endpoint_not_configured`);
    return {
      query,
      results: [],
      totalMatches: 0,
      provider: "cloudflare_ai_search",
      timestamp: new Date().toISOString(),
      degraded: "endpoint_not_configured",
    };
  }
}
