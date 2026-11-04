/**
 * Cloudflare AI Search & Vectorize Service for Financial Documentation
 * Repurposed from Cloudflare Agents AI Search standard:
 * https://developers.cloudflare.com/agents/tools/ai-search/
 *
 * Implements:
 * - Semantic vector search over SEC filings, 10-K/10-Q disclosures, and broker rules
 * - Cloudflare AI Search endpoint and Vectorize binding integration
 * - Built-in semantic retrieval with ranking and snippet extraction
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
 * past the fallback — a malformed chunk must fail VISIBLY, never
 * silently substitute stub results. `details` names the chunk index
 * and field so the probe can pinpoint the shape mismatch. Flag-OFF
 * never throws: it reproduces today's lenient mapping verbatim.
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
   * category), never a defaulted 0.9 or a forced "sec_filing". The
   * fallback branch below still always sets both: its constant's
   * annotation narrows to Required for score/category (see the
   * NOTE below), so no fallback logic line needed to change.
   */
  score?: number;
  category?: "sec_filing" | "broker_rules" | "options_disclosure" | "market_education";
  /**
   * NOTE on the optionality above: the fallback branch below still
   * always sets both (its constant entries all carry scores and
   * categories — the constant's annotation below narrows to
   * Required for exactly those two fields, so the fallback's
   * arithmetic still typechecks). No fallback LOGIC line is touched
   * by S2; the narrowing fails CLOSED at compile time if a future
   * entry ever omits a score/category, instead of silently
   * defaulting one.
   */
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
      // visibly (AiSearchMappingError, rethrown past the fallback
      // by the service) instead of being silently defaulted or
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

export interface AISearchQueryResponse {
  query: string;
  results: AISearchResultItem[];
  totalMatches: number;
  provider: "cloudflare_ai_search" | "vectorize" | "semantic_cache";
  timestamp: string;
}

// Built-in institutional knowledge base for financial trading docs
// Issue #1169 (S2, TYPE-ONLY): the constant's entries always carry a
// score and a category (all five do), so the annotation narrows those
// two fields to Required. This keeps the fallback branch's arithmetic
// typechecking after AISearchResultItem.score/category became optional
// for the flag-ON mapping. NO fallback logic line is touched, and the
// narrowing fails CLOSED (compile error) if a future entry omits one.
const FINANCIAL_KNOWLEDGE_BASE: (AISearchResultItem &
  Required<Pick<AISearchResultItem, "score" | "category">>)[] = [
  {
    id: "sec_nvda_10k_2025",
    title: "NVIDIA Corp - Annual 10-K Filing (Risk Factors & Data Center Revenue)",
    snippet: "Data Center revenue grew 140% driven by accelerated computing and Blackwell GPU architecture. Key risks include export controls and supply chain concentration.",
    score: 0.95,
    category: "sec_filing",
    url: "https://www.sec.gov/edgar/data/1045810/nvda-10k.htm",
  },
  {
    id: "etrade_order_types_guide",
    title: "E*TRADE Advanced Order Types & Routing Guide",
    snippet: "E*TRADE supports Market, Limit, Stop, Stop-Limit, Trailing Stop ($ and %), and Conditional Orders. Extended hours trading available 07:00-09:30 ET and 16:00-20:00 ET.",
    score: 0.92,
    category: "broker_rules",
    url: "https://us.etrade.com/knowledge/order-types",
  },
  {
    id: "finra_rule_4210_pdt",
    title: "FINRA Rule 4210: Pattern Day Trader (PDT) Margin Requirements",
    snippet: "Pattern day traders must maintain minimum equity of $25,000 on any day on which day trading occurs. A pattern day trader executes 4 or more day trades within 5 business days.",
    score: 0.89,
    category: "broker_rules",
    url: "https://www.finra.org/rules-guidance/rulebooks/finra-rules/4210",
  },
  {
    id: "options_clearing_corp_odg",
    title: "Characteristics and Risks of Standardized Options (ODD)",
    snippet: "Options involve risk and are not suitable for all investors. Option buyers risk the loss of entire premium; uncovered option writers face potentially unlimited losses.",
    score: 0.88,
    category: "options_disclosure",
    url: "https://www.theocc.com/company-information/documents-and-archives/options-disclosure-document",
  },
  {
    id: "sec_aapl_10q_services",
    title: "Apple Inc - 10-Q Quarterly Report (Services & Gross Margin)",
    snippet: "Services gross margin reached 74.2%, with installed active device base exceeding 2.2 billion active devices globally.",
    score: 0.85,
    category: "sec_filing",
    url: "https://www.sec.gov/edgar/data/320193/aapl-10q.htm",
  },
];

export class ETradeAISearchService {
  constructor(private env?: Env) {}

  /**
   * Qunsultant/cfagent#1775 (Adapter S1): the MAS searchKnowledge
   * tool's raw `/search` call, owned here so this module is the
   * single home for AI Search HTTP calls. It returns the upstream
   * Response untouched — status handling, chunk extraction, the
   * abort timeout, the TTL cache, and the audit calls all stay
   * with the MAS caller, verbatim. This is deliberately NOT
   * searchFinancialDocs: that path posts to the bare endpoint
   * with ai_search_options, maps chunks, and falls back to the
   * local corpus — a different contract the MAS tool must not
   * inherit (it surfaces upstream failure, never stub docs).
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
   * Search financial documentation and SEC filings using AI Search
   */
  async searchFinancialDocs(query: string, limit: number = 5): Promise<AISearchQueryResponse> {
    const timestamp = new Date().toISOString();
    const cleanQuery = query.trim().toLowerCase();

    // 1. If Cloudflare AI Search endpoint is configured, query upstream
    if (this.env?.AI_SEARCH_ENDPOINT) {
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

        if (resp.ok) {
          const json = (await resp.json()) as any;
          if (json.success && json.result?.chunks) {
            // Issue #1169 (S2, flag-gated): the primary-path mapping
            // lives in mapAiSearchChunks above. Flag-OFF reproduces
            // the pre-S2 mapping verbatim; flag-ON preserves true
            // scores/categories + provenance. The fallback branch
            // below is untouched by S2 (S3 owns it).
            // Cross-cutting (S2): mapping application is logged via
            // the repo's console-stream idiom (see loggingAspect.ts:
            // standard console streams, bracket prefix, no sensitive
            // fields — counts and flag state only, never chunk
            // content, keys, or logins).
            const flagOn = isKnowledgeServingEnabled(this.env);
            const results = mapAiSearchChunks(json.result.chunks, flagOn);
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
      } catch (err) {
        // Cross-cutting (S2): a mapping failure is VISIBLE, never a
        // silent substitution — it is rethrown past the fallback
        // below (S3 owns the fallback; S2 must not let a malformed
        // chunk silently become stub results). Every other primary-
        // path failure keeps today's fall-through behavior exactly.
        if (err instanceof AiSearchMappingError) {
          console.warn(
            `[knowledgeMapping] aiSearch mapping failed chunkIndex=${err.chunkIndex} field=${err.field} code=${err.code}`
          );
          throw err;
        }
        // Fall through to semantic cache
      }
    }

    // 2. Local semantic matcher over preloaded financial knowledge base
    const terms = cleanQuery.split(/\s+/).filter(Boolean);
    const scored = FINANCIAL_KNOWLEDGE_BASE.map((doc) => {
      let matchCount = 0;
      const docText = `${doc.title} ${doc.snippet} ${doc.category}`.toLowerCase();
      for (const t of terms) {
        if (docText.includes(t)) matchCount++;
      }
      const score = terms.length > 0 ? parseFloat((matchCount / terms.length).toFixed(2)) : 0.5;
      return { ...doc, score: Math.max(score, doc.score * (matchCount > 0 ? 1 : 0.4)) };
    });

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, limit);

    return {
      query,
      results: topResults,
      totalMatches: topResults.length,
      provider: "semantic_cache",
      timestamp,
    };
  }
}
