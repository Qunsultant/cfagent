/**
 * Issue #2120 (slice 1): thin REST routes for the Search hub.
 *
 * Two POST routes, no new envelope, no new store, no new binding:
 * - POST /search/agent -> ETradeAISearchService.searchFinancialDocs
 *   (service-native AISearchQueryResponse: query/results/totalMatches/
 *   provider/timestamp, plus `degraded` when the live index did not
 *   serve). Since #1169 S3 the service has no fallback corpus: an
 *   unserved query returns zero results with an in-band `degraded`
 *   reason, and the tab renders that degraded state as a visible
 *   notice — never as silent emptiness or substitute rows.
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
 */
import { ETradeAISearchService } from "../../services/aiSearch";
import { searchPlatformKnowledge } from "../../services/platformKnowledge";
import { unauthenticatedResponse } from "./routeIdentity";
import { createMAS, type MASOptions } from "../mas";
import type { Env } from "../../types";

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
    const service = new ETradeAISearchService(ctx.env);
    const result = await service.searchFinancialDocs(query, limit);
    return Response.json(result);
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

  return null;
}
