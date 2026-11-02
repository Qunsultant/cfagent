import type { Env } from "../types";

/**
 * Paths served verbatim from the ASSETS binding (wrangler.jsonc,
 * `assets.directory` = ./dist). They carry no session semantics, so issue #329
 * requires them to be answered without a session-store read.
 *
 * Anything not listed here — `/`, `/index.html`, the API and agent routes —
 * keeps going through `requireAuth`.
 */
const STATIC_ASSET_PREFIXES = ["/assets/", "/strategies/"] as const;
const STATIC_ASSET_PATHS = new Set([
  "/favicon.ico",
  "/robots.txt",
  "/site.webmanifest",
  "/manifest.webmanifest",
]);

export function isStaticAssetRequest(request: Request, path: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return (
    STATIC_ASSET_PATHS.has(path) ||
    STATIC_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/**
 * Issue #329: static assets never need a session, but `run_worker_first` routes
 * them through the Worker anyway. Before this, every bundle/CSS/favicon request
 * reached `requireAuth` and spent a SESSIONS KV `get()` first — the reads that
 * exhausted the free tier's daily budget and 401'd authenticated routes.
 *
 * Returns the asset response for an asset request, or `null` when the request
 * must continue through the normal (authenticated) handler. The response is
 * exactly what the ASSETS fallback at the end of the handler would return,
 * minus the session-store read; this module never touches the session store,
 * which is what makes the "no session read" property hold by construction
 * rather than by convention.
 */
export async function serveStaticAsset(
  request: Request,
  path: string,
  env: Env
): Promise<Response | null> {
  if (!isStaticAssetRequest(request, path)) return null;
  return fetchStaticAsset(request, env);
}

/**
 * Qunsultant/cfagent#1775 (Adapter S1): the asset port — the single
 * home for ASSETS.fetch in this module. Unlike serveStaticAsset,
 * this does NOT gate on asset paths: it is for call sites that
 * already authenticated/authorized the request (the landing-page
 * injection for `/` / `/index.html` and the fallthrough serve in
 * server.ts). Widening isStaticAssetRequest to cover `/` would
 * have been wrong — those paths must keep their session handling
 * in handleFetch; only the binding fetch itself moves behind the
 * port, with the response passed through verbatim.
 */
export async function fetchStaticAsset(
  request: Request,
  env: Env
): Promise<Response> {
  return env.ASSETS.fetch(request);
}
