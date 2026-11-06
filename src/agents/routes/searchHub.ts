/**
 * Issue #2120 (slice 1): thin REST routes for the Search hub.
 *
 * Two POST routes, no new envelope, no new store, no new binding:
 * - POST /search/agent -> the AiSearchAgent through its Durable
 *   Object door since #3342 (formerly AiSearchInstanceService over
 *   the public endpoint — the REST transport was retired and
 *   AI_SEARCH_ENDPOINT deleted). The response keeps the
 *   service-native AISearchQueryResponse shape (query/results/
 *   totalMatches/provider/timestamp, plus `degraded` when the live
 *   index did not serve), shaped by the one mapping the MCP command
 *   shares (aiSearchAgentResultToQueryResponse). Since #1169 S3
 *   there is no fallback corpus anywhere: an unserved query returns
 *   zero results with an in-band `degraded` reason, and the tab
 *   renders that degraded state as a visible notice — never as
 *   silent emptiness or substitute rows.
 * - POST /search/knowledge -> searchPlatformKnowledge, PLATFORM MODE
 *   ONLY: the catalog function is called directly, with no AI-endpoint
 *   attempt and no blend, so agent chunks and catalog entries never
 *   conflate. Returns the catalog-native shape (query/count/results/
 *   formattedAnswer); relevanceScore is the catalog's keyword
 *   relevance, not an index score — the tab discloses that.
 *
 * The hub does NOT depend on KNOWLEDGE_SERVING_ENABLED: the flag gates
 * mapping/serving, not queries, and neither route checks it.
 * Session gate: the shared 401 (routeIdentity.unauthenticatedResponse)
 * when no login is present, mirroring knowledgeCorpus.
 *
 * Issue #1169 (S4-2, revised scope): POST /search/mas invokes the MAS
 * searchKnowledge tool itself (createMAS, never a reimplementation)
 * and returns its NATIVE result shape — merged scheduled-report chunks
 * first, then AI Search index chunks, capped at 5 by the tool. The
 * route adds no envelope, no flag check (MAS handles
 * KNOWLEDGE_SERVING_ENABLED internally: flag off = chunks verbatim),
 * and no provenance of its own. When the report store (sql) is
 * absent the route fails honestly with a 500 instead of serving
 * instance-only results as the full MAS answer.
 *
 * Issue #3323: POST /search/ai-agent dispatches to the REAL
 * AiSearchAgent through the AI_SEARCH_AGENT Durable Object binding —
 * the hub surface the "Search Agent" tab's name always implied but
 * never was (that tab calls the service, above). The dispatch
 * mirrors AISearchAgentSearchCommand.execute (#2250) exactly: the
 * binding resolved off env (declared in wrangler.jsonc, not on the
 * Env type — the #2223 posture), the fixed service instance
 * "aisearch", the ROUTE's session login threaded as callerLogin (a
 * login in the request body is never read — identity comes from the
 * session only), and the agent's typed result shaped WITHOUT
 * laundering: rows pass through with their chunk fields and
 * provenance intact, the serving path is labelled, degraded notes
 * and failure tokens ride along verbatim. An absent/misshapen
 * binding answers the honest not_configured result in-band (200,
 * like the /search/agent degraded contract) — never a throw, never
 * fabricated rows. The shaping lives here rather than importing the
 * MCP command module: shapeAiSearchAgentAnswer is not exported, and
 * executing the command class would require fabricating an
 * McpToolContext (its `orm` handle) this route does not own; the
 * route shapes from the same typed runner result
 * (AiSearchAgentSearchResult) the command shapes from.
 */
import type { AISearchQueryResponse } from "../../services/aiSearch";
import { aiSearchAgentResultToQueryResponse } from "../aiSearchPaths";
import { searchPlatformKnowledge } from "../../services/platformKnowledge";
import { unauthenticatedResponse } from "./routeIdentity";
import { createMAS, type MASOptions } from "../mas";
import { AgentErrorCode } from "../../aspects/errorCodes";
import type {
  AiSearchAgentResultItem,
  AiSearchAgentSearchOptions,
  AiSearchAgentSearchResult,
  AiSearchPath,
} from "../aiSearchPaths";
import type { Env } from "../../types";

/** The AiSearchAgent service instance (mirrors the #2250 command). */
const AI_SEARCH_AGENT_SERVICE_INSTANCE = "aisearch";

/** Structural minimum of the AiSearchAgent stub this route calls. */
interface AiSearchAgentStubLike {
  search(
    query: string,
    opts?: AiSearchAgentSearchOptions,
  ): Promise<AiSearchAgentSearchResult>;
}

/**
 * The route's answer shape — field-for-field the `data` half of the
 * #2250 command's shaped answer (AiSearchAgentToolData): the agent's
 * result with its rows unaltered, its serving path labelled, and its
 * degraded/failure state carried, never laundered.
 */
export interface SearchHubAiAgentResponse {
  ok: boolean;
  path?: AiSearchPath;
  degraded?: string;
  results: AiSearchAgentResultItem[];
  code?: AiSearchAgentSearchResult["code"];
  errorToken?: AgentErrorCode;
  error?: string;
  correlationId: string;
}

/** Shape one typed agent search result into the route's answer. */
function shapeAiAgentResponse(
  result: AiSearchAgentSearchResult,
): SearchHubAiAgentResponse {
  return {
    ok: result.ok,
    ...(result.path ? { path: result.path } : {}),
    ...(result.degraded ? { degraded: result.degraded } : {}),
    results: result.results ?? [],
    ...(result.code ? { code: result.code } : {}),
    ...(result.errorToken ? { errorToken: result.errorToken } : {}),
    ...(result.error ? { error: result.error } : {}),
    correlationId: result.correlationId,
  };
}

export interface SearchHubRouteContext {
  env?: Env;
  userLogin?: string;
  sql?: MASOptions["sql"];
  audit?: MASOptions["audit"];
}

export async function handleSearchHubRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SearchHubRouteContext
): Promise<Response | null> {
  if (path.endsWith("/search/agent") && request.method === "POST") {
    const login = ctx.userLogin || request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as {
      query?: string;
      limit?: number;
    };
    const query = (body.query || "").trim();
    if (!query) {
      return Response.json({ error: "Query parameter is required" }, { status: 400 });
    }
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 5;
    // Issue #3342: this route served the public endpoint through
    // AiSearchInstanceService; with the REST transport retired it
    // dispatches through the AiSearchAgent's Durable Object door
    // (the same door /search/ai-agent uses: fixed service instance,
    // the ROUTE's session login threaded as callerLogin — a body
    // login is never read) and shapes the typed result into the
    // service-native AISearchQueryResponse contract the
    // SearchAgentTab renders, via the one mapping the MCP command
    // shares. An absent binding answers the degraded contract
    // in-band (endpoint_not_configured, zero results), exactly the
    // answer the unconfigured service used to give.
    const namespace = (ctx.env as any)?.AI_SEARCH_AGENT as
      | DurableObjectNamespace
      | undefined;
    if (
      !namespace ||
      typeof namespace.get !== "function" ||
      typeof namespace.idFromName !== "function"
    ) {
      const answer: AISearchQueryResponse = {
        query,
        results: [],
        totalMatches: 0,
        provider: "cloudflare_ai_search",
        timestamp: new Date().toISOString(),
        degraded: "endpoint_not_configured",
      };
      return Response.json(answer);
    }
    const stub = namespace.get(
      namespace.idFromName(AI_SEARCH_AGENT_SERVICE_INSTANCE),
    ) as unknown as AiSearchAgentStubLike;
    const result = await stub.search(query, { callerLogin: login, limit });
    return Response.json(aiSearchAgentResultToQueryResponse(query, result));
  }

  if (path.endsWith("/search/knowledge") && request.method === "POST") {
    const login = ctx.userLogin || request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as {
      query?: string;
      category?: string;
      maxResults?: number;
    };
    const query = (body.query || "").trim();
    if (!query) {
      return Response.json({ error: "Query parameter is required" }, { status: 400 });
    }
    const result = searchPlatformKnowledge(query, {
      maxResults: typeof body.maxResults === "number" && body.maxResults > 0 ? body.maxResults : 8,
      category: typeof body.category === "string" && body.category ? body.category : undefined,
    });
    return Response.json(result);
  }

  if (path.endsWith("/search/mas") && request.method === "POST") {
    const login = ctx.userLogin || request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as {
      query?: string;
    };
    const query = (body.query || "").trim();
    if (!query) {
      return Response.json({ error: "Query parameter is required" }, { status: 400 });
    }
    if (!ctx.sql) {
      return Response.json(
        { error: "MAS search requires its report store (mas_reports); instance-only results cannot stand in for the full MAS answer." },
        { status: 500 }
      );
    }
    // The tool's cache key is query + sessionId; the handler's
    // sessionId is the scope, so one session never reads another's
    // cached result. The orchestrator mount passes its audit (its
    // type accepts the MAS "search" agent value); without a mount
    // audit the tool's audit calls become a no-op rather than
    // failing the search.
    const mas = createMAS({
      env: ctx.env as Env,
      sessionId,
      requestId: crypto.randomUUID(),
      sql: ctx.sql,
      audit: ctx.audit ?? (() => {}),
    });
    // Adapted call (not the tool): the installed `ai` Tool type
    // requires the ToolExecutionOptions second argument. The tool's
    // execute ignores it — it destructures only { query } — so this
    // carries no behavior, only the call shape the SDK demands.
    const result = await mas.searchKnowledge.execute(
      { query },
      { toolCallId: crypto.randomUUID(), messages: [{ role: "user", content: query }], context: {} }
    );
    return Response.json(result);
  }

  if (path.endsWith("/search/ai-agent") && request.method === "POST") {
    const login = ctx.userLogin || request.headers.get("x-user-login") || "";
    if (!login) return unauthenticatedResponse();
    const body = (await request.json().catch(() => ({}))) as {
      query?: string;
      limit?: number;
    };
    const query = (body.query || "").trim();
    if (!query) {
      return Response.json({ error: "Query parameter is required" }, { status: 400 });
    }
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 5;
    const audit = ctx.audit ?? (() => {});
    const namespace = (ctx.env as any)?.AI_SEARCH_AGENT as
      | DurableObjectNamespace
      | undefined;
    if (
      !namespace ||
      typeof namespace.get !== "function" ||
      typeof namespace.idFromName !== "function"
    ) {
      const detail =
        "the AI_SEARCH_AGENT Durable Object binding is not configured in this environment, so the AiSearchAgent cannot be reached";
      audit("ai_search_agent.query", "search", {
        query,
        ok: false,
        code: "not_configured",
      });
      const answer: SearchHubAiAgentResponse = {
        ok: false,
        code: "not_configured",
        errorToken: AgentErrorCode.UNKNOWN_AGENT_ERROR,
        error: detail,
        results: [],
        correlationId: crypto.randomUUID(),
      };
      return Response.json(answer);
    }
    const stub = namespace.get(
      namespace.idFromName(AI_SEARCH_AGENT_SERVICE_INSTANCE),
    ) as unknown as AiSearchAgentStubLike;
    const result = await stub.search(query, { callerLogin: login, limit });
    audit("ai_search_agent.query", "search", {
      query,
      ok: result.ok,
      path: result.path,
      matches: (result.results ?? []).length,
      degraded: Boolean(result.degraded),
    });
    return Response.json(shapeAiAgentResponse(result));
  }

  return null;
}
