/**
 * Cloudflare AI Search & Vectorize Service for Financial Documentation
 * Repurposed from Cloudflare Agents AI Search standard:
 * https://developers.cloudflare.com/agents/tools/ai-search/
 *
 * Implements:
 * - Semantic vector search over SEC filings, 10-K/10-Q disclosures, and broker rules
 * - Cloudflare AI Search endpoint and Vectorize binding integration
 * - Retrieval from the live AI Search instance only: when the
 *   instance does not serve, searchFinancialDocs returns an explicit
 *   degraded response (zero results + a degraded reason) — there is
 *   no built-in fallback corpus (removed by issue #1169 S3; the
 *   constant is superseded by this degraded contract).
 */

import type { Env } from "../types";
import {
  KNOWLEDGE_CATEGORIES,
  isKnowledgeServingEnabled,
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
    const bucketKey = typeof c.key === "string" ? c.key : undefined;
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
  | "upstream_invalid_response";

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

export class ETradeAISearchService {
  constructor(private env?: Env) {}

  /**
   * Qunsultant/cfagent#1775 (Adapter S1): the MAS searchKnowledge
   * tool's raw `/search` call, owned here so this module is the
   * single home for AI Search HTTP calls. It returns the upstream
   * Response untouched — status handling, chunk extraction, the
   * abort timeout, the TTL cache, and the audit calls all stay
   * with the MAS caller, verbatim. This is deliberately NOT
   * searchFinancialDocs: that path posts to the instance's /search
   * path with ai_search_options, maps chunks, and — since #1169 S3
   * removed its built-in fallback corpus — returns an explicit
   * degraded response (zero results + a degraded reason) when the
   * instance does not serve, never stub docs. A different contract
   * the MAS tool must not inherit (it surfaces upstream failure,
   * never stub docs).
   */
  async searchRaw(
    query: string,
    opts?: { signal?: AbortSignal }
  ): Promise<Response> {
    return fetch(`${this.env?.AI_SEARCH_ENDPOINT}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: query }] }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Search financial documentation and SEC filings using AI Search.
   *
   * Issue #1169 (S3): answers come from the live AI Search instance
   * or not at all. The built-in fallback corpus this method used to
   * serve on any failure is REMOVED — it is
   * superseded by the degraded contract on AISearchQueryResponse:
   * when the instance does not serve (endpoint unconfigured, fetch
   * failure, non-OK status, or an unusable response body), the
   * answer is zero results plus a stable `degraded` reason, logged
   * via the repo's console-stream idiom (bracket prefix; reason and
   * status only — never query text, chunk content, or logins). A
   * served answer — including an empty one (chunks: []) — carries
   * no `degraded` field. AiSearchMappingError still propagates:
   * a malformed chunk fails visibly, it does not degrade.
   */
  async searchFinancialDocs(query: string, limit: number = 5): Promise<AISearchQueryResponse> {
    const timestamp = new Date().toISOString();
    const cleanQuery = query.trim().toLowerCase();

    const degradedResponse = (reason: AiSearchDegradedReason): AISearchQueryResponse => ({
      query,
      results: [],
      totalMatches: 0,
      provider: "cloudflare_ai_search",
      timestamp,
      degraded: reason,
    });

    if (!this.env?.AI_SEARCH_ENDPOINT) {
      console.warn(`[knowledgeSearch] aiSearch degraded reason=endpoint_not_configured`);
      return degradedResponse("endpoint_not_configured");
    }

    let json: any;
    try {
      const searchUrl = `${this.env.AI_SEARCH_ENDPOINT.replace(/\/+$/, "")}/search`;
      const resp = await fetch(searchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: cleanQuery }],
          ai_search_options: {
            retrieval: {
              max_num_results: Math.min(limit, 10),
            },
          },
        }),
      });

      if (!resp.ok) {
        console.warn(
          `[knowledgeSearch] aiSearch degraded reason=upstream_http_error status=${resp.status}`
        );
        return degradedResponse("upstream_http_error");
      }

      try {
        json = await resp.json();
      } catch {
        // A non-JSON body — e.g. the HTML web UI a redirect to the
        // bare endpoint lands on (the 2026-11-04 probe finding) —
        // is an invalid response, not search data.
        console.warn(
          `[knowledgeSearch] aiSearch degraded reason=upstream_invalid_response detail=non_json_body`
        );
        return degradedResponse("upstream_invalid_response");
      }
    } catch (err) {
      console.warn(
        `[knowledgeSearch] aiSearch degraded reason=upstream_unreachable error=${err instanceof Error ? err.name : "unknown"}`
      );
      return degradedResponse("upstream_unreachable");
    }

    if (!json?.success || !Array.isArray(json?.result?.chunks)) {
      console.warn(
        `[knowledgeSearch] aiSearch degraded reason=upstream_invalid_response detail=missing_success_or_chunks`
      );
      return degradedResponse("upstream_invalid_response");
    }

    // Issue #1169 (S2, flag-gated): the primary-path mapping lives
    // in mapAiSearchChunks above. Flag-OFF reproduces the pre-S2
    // mapping verbatim; flag-ON preserves true scores/categories +
    // provenance. Cross-cutting (S2): mapping application is logged
    // via the repo's console-stream idiom (see loggingAspect.ts:
    // standard console streams, bracket prefix, no sensitive fields
    // — counts and flag state only, never chunk content, keys, or
    // logins). A mapping failure is VISIBLE, never a silent
    // degradation — it is rethrown, as before.
    const flagOn = isKnowledgeServingEnabled(this.env);
    let results: AISearchResultItem[];
    try {
      results = mapAiSearchChunks(json.result.chunks, flagOn);
    } catch (err) {
      if (err instanceof AiSearchMappingError) {
        console.warn(
          `[knowledgeMapping] aiSearch mapping failed chunkIndex=${err.chunkIndex} field=${err.field} code=${err.code}`
        );
      }
      throw err;
    }
    console.info(
      `[knowledgeMapping] aiSearch mapped chunks=${json.result.chunks.length} results=${results.length} flag=${flagOn ? "on" : "off"}`
    );

    return {
      query,
      results,
      totalMatches: results.length,
      provider: "cloudflare_ai_search",
      timestamp,
    };
  }
}
