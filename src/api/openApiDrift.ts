/**
 * #1768 (parent #1717, F-48): runtime OpenAPI validation.
 *
 * The generated spec (src/security/openapiSpec.ts, spike #1024) is
 * static knowledge derived from the IAAA endpoint catalog — nothing
 * validates it against the routes it describes. This module adds the
 * two runtime checks the slice pins:
 *
 * 1. validateOpenApiDocument: the generated document is structurally
 *    valid OpenAPI 3.x (version, info.title, paths object, every
 *    operation carrying a responses object).
 * 2. checkIngressRoutesInSpec: every route in the unified-ingress
 *    route table appears in the generated spec's paths. Drift is
 *    RETURNED, never hidden: a missing route is a problem string in
 *    the result, and the test pins the result empty — so a future
 *    route added to the table without a catalog entry fails loudly
 *    instead of silently drifting.
 *
 * The DOCS_PUBLIC_SURFACES final decision (open #1024) is EXCLUDED
 * from this slice per the issue body; the /openapi.json + /api/docs
 * provisional session gating is untouched.
 */

export interface IngressRoute {
  method: string;
  path: string;
  auth: "session" | "public" | "signature";
}

/** The ingress surfaces this slice unifies (WS + webhook + quote + gated search). */
export const API_INGRESS_ROUTES: readonly IngressRoute[] = [
  { method: "GET", path: "/voice/trade", auth: "session" },
  { method: "GET", path: "/api/trading/voice/ws", auth: "session" },
  { method: "GET", path: "/api/market-data/quotes/ws", auth: "public" },
  { method: "GET", path: "/api/market/quotes/ws", auth: "public" },
  { method: "GET", path: "/api/foss/quotes/ws", auth: "public" },
  { method: "GET", path: "/api/market-data/quotes", auth: "public" },
  { method: "GET", path: "/api/market/quotes", auth: "public" },
  { method: "GET", path: "/api/foss/quotes", auth: "public" },
  { method: "POST", path: "/nlq/webhook", auth: "signature" },
  { method: "POST", path: "/api/trading/nlq/webhook", auth: "signature" },
  { method: "POST", path: "/api/nlq/webhook", auth: "signature" },
  { method: "POST", path: "/api/payments/webhook", auth: "signature" },
  { method: "POST", path: "/payments/webhook", auth: "signature" },
  { method: "POST", path: "/api/memory/search", auth: "session" },
];

const OPERATION_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"];

/** Returns problem strings; empty means structurally valid. */
export function validateOpenApiDocument(spec: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof spec.openapi !== "string" || !spec.openapi.startsWith("3.")) {
    problems.push("openapi version is missing or not 3.x");
  }
  const info = spec.info as Record<string, unknown> | undefined;
  if (!info || typeof info.title !== "string" || !info.title) {
    problems.push("info.title is missing");
  }
  const paths = spec.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== "object") {
    problems.push("paths is missing or not an object");
    return problems;
  }
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") {
      problems.push(`${path}: path item is not an object`);
      continue;
    }
    for (const method of OPERATION_METHODS) {
      const operation = (item as Record<string, unknown>)[method];
      if (operation === undefined) continue;
      if (!operation || typeof operation !== "object") {
        problems.push(`${path}: ${method} operation is not an object`);
        continue;
      }
      const responses = (operation as Record<string, unknown>).responses;
      if (!responses || typeof responses !== "object") {
        problems.push(`${path}: ${method} operation has no responses object`);
      }
    }
  }
  return problems;
}

/** Returns the table paths absent from the spec's paths (drift). */
export function checkIngressRoutesInSpec(
  spec: Record<string, unknown>,
  routes: readonly IngressRoute[] = API_INGRESS_ROUTES,
): string[] {
  const paths = spec.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== "object") return routes.map((r) => r.path);
  return routes.filter((r) => !Object.prototype.hasOwnProperty.call(paths, r.path)).map((r) => r.path);
}
