/**
 * Issue #5175 slice 5 — id-resolve read route (GET /api/ids/resolve).
 *
 * Read-only: resolves any run, alias, or derived id against the
 * mas_runs registry (slice 2) and returns the shared resolution shape
 * (src/services/idResolution.ts). It never mints — the registry is the
 * resolution half of the one id authority, and this route only reads
 * through its resolve port.
 *
 * The route is instance-level, like GET /api/audit/chain-verification:
 * mas_runs carries no session column (family / job_kind / trigger /
 * created_at only), so no session filter applies and the sessionId
 * carrier is unused. A missing or empty `id` query parameter is a
 * 400; any non-empty id that does not resolve answers 200 with
 * found:false (see idResolution.ts — "unknown" is a legitimate
 * answer, never a 404, and the registry is the single authority on
 * what is known).
 *
 * Exported as ONE handler invoked from routeRequest at the exact
 * position after the audit handler, matching the audit module's
 * shape: it returns a Response when its path matches, or null when
 * it does not.
 */
import type { SqlStorage } from "../../orm";
import { createRunRegistryPorts } from "../../data/createRunRegistryPorts";
import { toIdResolution } from "../../services/idResolution";

/** The subset of OrchestratorAgent surface the id-resolve handler needs. */
export interface IdResolveRouteContext {
  ensureTables(): SqlStorage;
}

/**
 * Handles the id-resolve route. Returns a Response on match, null when
 * the path does not match (the orchestrator then continues its
 * sequential matching).
 */
export async function handleIdResolveRoutes(
  request: Request,
  url: URL,
  path: string,
  _sessionId: string,
  ctx: IdResolveRouteContext,
): Promise<Response | null> {
  if (!(path.endsWith("/ids/resolve") && request.method === "GET")) return null;
  try {
    const id = url.searchParams.get("id");
    if (id === null || id.trim() === "") {
      return Response.json({ error: "Missing required query parameter: id" }, { status: 400 });
    }
    const resolve = createRunRegistryPorts(ctx.ensureTables()).resolve;
    return Response.json(toIdResolution(id, resolve.resolveId(id)));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to resolve id" }, { status: 500 });
  }
}
