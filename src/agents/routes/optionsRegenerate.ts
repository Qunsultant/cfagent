/**
 * Issue #2603 (options programme slice 6) — regenerate a stored options
 * run from its record.
 *
 * A sibling endpoint of /trading/options/unified, dispatched by the thin
 * router (orchestrator.routeRequest) BEFORE handleEtradeOptionsRoutes so
 * the etrade options module keeps its #359 size and condition budget.
 *
 * The request is rebuilt server-side from the stored canonical row —
 * never from the request body, which carries only the row id — and is
 * executed through the same `executeUnifiedOptions` path the manual run
 * uses, so the new run is recorded under its own generation id and the
 * original row is never written. An incomplete record is refused with
 * the missing fields named (422), never guessed.
 */
import { unauthenticatedResponse } from "./routeIdentity";
import { executeUnifiedOptions } from "./etradeOptionsScreen";
import type { EtradeOptionsRouteContext } from "./etradeOptions";
import { rebuildOptionsRegenerateRequest } from "../../services/optionsRegenerate";
import {
  listScheduledReports,
  resolveCanonicalReportBodyWithBackfill,
} from "../../services/scheduledReports";

/**
 * Match and handle `POST /trading/options/regenerate`.
 * Returns null when the request is not this route (the router continues).
 */
export async function executeOptionsRegenerate(args: {
  request: Request;
  sessionId: string;
  ctx: EtradeOptionsRouteContext;
}): Promise<Response> {
  const { request, sessionId, ctx } = args;
  try {
    const userLogin = request.headers.get("x-user-login");
    if (!userLogin) return unauthenticatedResponse();
    const payload = (await request.json().catch(() => ({}))) as { reportId?: unknown };
    const wanted = typeof payload.reportId === "string" ? payload.reportId : "";
    const sql = ctx.ensureTables();
    // Owner-scoped by construction: only the caller's own rows are candidates.
    const optionsHits = listScheduledReports(sql, { userLogin, limit: 200 }).filter((hit) =>
      hit.source.startsWith("options"),
    );
    const hit = wanted ? optionsHits.find((candidate) => candidate.id === wanted) : optionsHits[0];
    if (!hit) {
      return Response.json({ error: "No stored options run to regenerate." }, { status: 404 });
    }
    const storedBody =
      (await resolveCanonicalReportBodyWithBackfill(
        sql,
        (ctx as { env?: unknown }).env ?? {},
        hit,
      )) ?? "";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(storedBody);
    } catch {
      parsed = null;
    }
    const plan = rebuildOptionsRegenerateRequest({
      reportId: hit.id,
      body: parsed,
      userLogin,
      nowIso: new Date().toISOString(),
    });
    if (!plan.ok) {
      return Response.json({ error: plan.reason, missing: plan.missing }, { status: 422 });
    }
    // The same executor the manual unified path uses: it screens, generates,
    // records its own run row, and delivers per the request's channels.
    return await executeUnifiedOptions({ request, sessionId, ctx, reqData: plan.request });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Options regenerate failed" },
      { status: 500 },
    );
  }
}
