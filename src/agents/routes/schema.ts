/**
 * Issue #359-17: schema introspection routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change. FINAL slice of the #359 orchestrator breakup:
 * routeRequest is now a thin ordered dispatcher over src/agents/routes/.
 *
 * Owns the two schema blocks (invoked at the EXACT original position in
 * routeRequest's sequential matching sequence, between the MCP/chat/NLQ
 * delegation and the ads/revenue/referrals delegation):
 *   GET  /schema/tables   (ORM table inventory)
 *   POST /schema/query    (ORM table data: table/search/limit/offset)
 *
 * The handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * SchemaRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import type { DatabaseORM } from "../../orm";
import type { AgentName } from "../../types";
import { runRestTool } from "./restToolBridge";

/** The subset of OrchestratorAgent surface the schema handlers need. */
export interface SchemaRouteContext {
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /**
   * #1644: audit sink for command execution. Optional — the reduced schema
   * commands never audit, so routes without it run with a no-op.
   */
  audit?: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
}

/**
 * Handles the schema introspection routes. Returns a Response on match,
 * null when neither schema path matches (the orchestrator then continues
 * its sequential matching).
 */
export async function handleSchemaRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SchemaRouteContext
): Promise<Response | null> {
  // Schema Introspection & Database Tables via ORM
  // #1644: executed through the list_database_tables command — the route
  // keeps only its response shape and error mapping.
  if (path.endsWith("/schema/tables") && request.method === "GET") {
    try {
      const out = await runRestTool("list_database_tables", {}, {
        orm: ctx.getOrm(),
        sessionId,
        audit: ctx.audit ?? (() => {}),
      });
      return Response.json(out);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to inspect database tables" }, { status: 500 });
    }
  }

  // Direct Table Query Execution via ORM
  // #1644: executed through the query_table_data command. The route keeps
  // its mas_categories default and error mapping; limit/offset clamps live
  // in the ORM call the command owns.
  if (path.endsWith("/schema/query") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        table?: string;
        search?: string;
        limit?: number;
        offset?: number;
      };
      const table = body.table || "mas_categories";
      const data = await runRestTool("query_table_data", {
        tableName: table,
        search: body.search,
        limit: body.limit,
        offset: body.offset,
      }, {
        orm: ctx.getOrm(),
        sessionId,
        audit: ctx.audit ?? (() => {}),
        allowUnlistedTables: true,
      } as never);
      return Response.json(data);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to query table data" }, { status: 500 });
    }
  }

  return null;
}
