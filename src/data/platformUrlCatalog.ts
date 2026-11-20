/**
 * Issue #5610 (G-8) — the platform URL catalog, the single source of truth
 * for the platform families' route paths, on the commercial catalog pattern
 * (#2846, `src/data/commercialUrlCatalog.ts`).
 *
 * Every platform route is defined ONCE here: the accounts/onboarding/profile
 * family (`/platform/accounts/*`, `/platform/onboarding/*`), the tenants
 * family (`/platform-tenants*`), the channels family
 * (`/platform-channels/*`), and the users family
 * (`/admin/platform-users/*`). `bare` is the path without the `/api`
 * prefix; `platformPath(id)` is the canonical `/api` spelling.
 *
 * Consumers derive paths from this module, never from a literal string:
 * - the handlers (`src/agents/routes/platform*.ts`) match
 *   `PLATFORM_ROUTE_SUFFIXES.<id>` / `PLATFORM_ROUTE_INCLUDES.<id>` /
 *   `PLATFORM_ROUTE_TAILS.<id>`;
 * - the clients (`src/client/*Api.ts`, panels, bizCopilot services) build
 *   paths from `platformPath(id)` / `platformPathParams(id, params)`;
 * - the shared schemas registry (`src/api/commercialSchemas.ts`) and the
 *   ONE OpenAPI spec (`src/security/openapiSpec.ts`) enumerate the routes
 *   from this module.
 *
 * Shape notes (the handlers keep their dispatch structure; only the
 * literals move here):
 * - Methods merge per shared suffix, as in the commercial catalog:
 *   14 entries cover 19 (method, path) operations (onboardingState
 *   GET+POST, accountProfile GET+POST, tenants GET+POST, channelSlackChannel
 *   GET+PUT+PATCH, channelWebhookUrl GET+PUT+PATCH).
 * - `matchSuffix` is the exact `endsWith` string, or "" for includes-only
 *   routes (tenants detail/settings, all four channel entries), which the
 *   handlers match by `includes` + segment dispatch.
 * - `segmentTail` is the final segment the handler requires after the
 *   `:tenantId` (channels family + tenant settings); absent = no tail
 *   (the read/detail shape: exactly one segment after the marker).
 * - Matching + extraction reuse the commercial catalog's helpers
 *   (`matchCatalogRoute`, `extractCatalogParams`, `segmentsAfterMarker`) —
 *   one implementation of the matcher/extractor. The tenants/channels
 *   handlers keep their own segment dispatch with strict
 *   `decodeURIComponent` (a malformed segment throws, exactly as before);
 *   `extractCatalogParams` (lenient, keep-raw) is the commercial
 *   branches' extraction and is not used there.
 *
 * A hardcoded platform path literal anywhere else in `src/` fails
 * `tests/platform_url_catalog_5610.test.ts`.
 */

import {
  type CatalogRouteParam,
  extractCatalogParams,
  matchCatalogRoute,
  segmentsAfterMarker,
} from "./commercialUrlCatalog";

export type { CatalogRouteParam };
export { extractCatalogParams, matchCatalogRoute, segmentsAfterMarker };

export type PlatformRouteMethod = "GET" | "POST" | "PATCH" | "PUT";

export interface PlatformRoute {
  /** Stable id used by `platformPath(id)` / `PLATFORM_ROUTE_SUFFIXES`. */
  id: string;
  /** Methods served on this route. */
  methods: PlatformRouteMethod[];
  /** Full bare path (no `/api` prefix); a `:param` template for parameterized routes. */
  bare: string;
  /**
   * The exact string the handler matches with `path.endsWith(...)`.
   * Empty for includes-only routes (no endsWith tail — see `matchIncludes`).
   */
  matchSuffix: string;
  /**
   * `path.includes(...)` strings the handler also requires
   * (includes-only routes). Every string must be present.
   */
  matchIncludes?: string[];
  /** Path parameters, in order (segment after the literal `after`). */
  params?: CatalogRouteParam[];
  /**
   * The final segment the handler requires after the `:tenantId`
   * (channels family + tenant settings). Absent = no tail.
   */
  segmentTail?: string;
}

const route = (
  id: string,
  methods: PlatformRouteMethod[],
  bare: string,
  matchSuffix?: string,
  extra?: {
    matchIncludes?: string[];
    params?: CatalogRouteParam[];
    segmentTail?: string;
  },
): PlatformRoute => ({
  id,
  methods,
  bare,
  matchSuffix: matchSuffix ?? bare,
  ...(extra?.matchIncludes ? { matchIncludes: extra.matchIncludes } : {}),
  ...(extra?.params ? { params: extra.params } : {}),
  ...(extra?.segmentTail ? { segmentTail: extra.segmentTail } : {}),
});

export const PLATFORM_ROUTES: PlatformRoute[] = [
  // Accounts / onboarding / profile (Group E) — suffix-matched, one entry
  // per shared suffix; the handler's method booleans stay explicit.
  route("accountSelf", ["GET"], "/platform/accounts/self"),
  route("accountSetup", ["POST"], "/platform/accounts/setup"),
  route("accountLookup", ["GET"], "/platform/accounts/lookup"),
  route("onboardingState", ["GET", "POST"], "/platform/onboarding/state"),
  route("accountProfile", ["GET", "POST"], "/platform/accounts/profile"),
  // Tenants (Group F) — the collection suffix serves list (GET) + create
  // (POST); any other method on it still matches and answers 405 from the
  // list branch, exactly as before. Detail/settings are includes-only.
  route("tenants", ["GET", "POST"], "/platform-tenants"),
  route("tenantDetail", ["GET"], "/platform-tenants/:tenantId", "", {
    matchIncludes: ["/platform-tenants/"],
    params: [{ name: "tenantId", after: "platform-tenants" }],
  }),
  route("tenantSettings", ["PATCH"], "/platform-tenants/:tenantId/settings", "", {
    matchIncludes: ["/platform-tenants/"],
    params: [{ name: "tenantId", after: "platform-tenants" }],
    segmentTail: "settings",
  }),
  // Channels (Group G) — all includes-only; the handler dispatches on the
  // segment after the tenant id. Read is the one-segment shape (no tail).
  route("channelRead", ["GET"], "/platform-channels/:tenantId", "", {
    matchIncludes: ["/platform-channels/"],
    params: [{ name: "tenantId", after: "platform-channels" }],
  }),
  route("channelPatch", ["PATCH"], "/platform-channels/:tenantId/channels", "", {
    matchIncludes: ["/platform-channels/"],
    params: [{ name: "tenantId", after: "platform-channels" }],
    segmentTail: "channels",
  }),
  route(
    "channelSlackChannel",
    ["GET", "PUT", "PATCH"],
    "/platform-channels/:tenantId/slack-channel",
    "",
    {
      matchIncludes: ["/platform-channels/"],
      params: [{ name: "tenantId", after: "platform-channels" }],
      segmentTail: "slack-channel",
    },
  ),
  route(
    "channelWebhookUrl",
    ["GET", "PUT", "PATCH"],
    "/platform-channels/:tenantId/webhook-url",
    "",
    {
      matchIncludes: ["/platform-channels/"],
      params: [{ name: "tenantId", after: "platform-channels" }],
      segmentTail: "webhook-url",
    },
  ),
  // Users (Group H) — suffix-matched; the handler answers 405 for non-GET
  // after dispatch, exactly as before.
  route("userMe", ["GET"], "/admin/platform-users/me"),
  route("userLookup", ["GET"], "/admin/platform-users/lookup"),
];

const BY_ID = new Map(PLATFORM_ROUTES.map((r) => [r.id, r]));

/** A platform route by id. Throws on an unknown id — fail loud, never guess a route. */
export function platformRouteById(id: string): PlatformRoute {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`Unknown platform route id: ${id}`);
  return entry;
}

/**
 * Canonical (`/api`) path for a route id. Throws on an unknown id — fail
 * loud, never guess a path. Throws on a parameterized entry: a `:param`
 * template is not a URL — use `platformPathParams`.
 */
export function platformPath(id: string): string {
  const entry = platformRouteById(id);
  if (entry.params?.length) {
    throw new Error(`Platform route ${id} is parameterized; use platformPathParams`);
  }
  return `/api${entry.bare}`;
}

/** Bare path (no `/api` prefix) for a route id. Same throw rules as `platformPath`. */
export function platformBarePath(id: string): string {
  const entry = platformRouteById(id);
  if (entry.params?.length) {
    throw new Error(`Platform route ${id} is parameterized; use platformBarePathParams`);
  }
  return entry.bare;
}

/**
 * Canonical (`/api`) path for a parameterized route id, with `:param`
 * segments filled from `params` (each value encoded once, here — callers
 * pass raw values). Throws on an unknown id or a missing param.
 */
export function platformPathParams(id: string, params: Record<string, string>): string {
  return `/api${platformBarePathParams(id, params)}`;
}

/** Bare path for a parameterized route id, with `:param` segments filled. */
export function platformBarePathParams(id: string, params: Record<string, string>): string {
  const entry = platformRouteById(id);
  return entry.bare
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      const value = params[name];
      if (value === undefined) {
        throw new Error(`Missing path param ${name} for platform route ${id}`);
      }
      return encodeURIComponent(value);
    })
    .join("/");
}

/** Handler match suffixes by route id (the exact `endsWith` strings; "" = includes-only). */
export const PLATFORM_ROUTE_SUFFIXES: Record<string, string> = Object.fromEntries(
  PLATFORM_ROUTES.map((r) => [r.id, r.matchSuffix]),
);

/** Handler `path.includes(...)` strings by route id (includes-only routes). */
export const PLATFORM_ROUTE_INCLUDES: Record<string, readonly string[]> = Object.fromEntries(
  PLATFORM_ROUTES.filter((r) => r.matchIncludes?.length).map((r) => [
    r.id,
    r.matchIncludes as readonly string[],
  ]),
);

/** The final segment after the `:tenantId`, by route id (segment-dispatched routes only). */
export const PLATFORM_ROUTE_TAILS: Record<string, string> = Object.fromEntries(
  PLATFORM_ROUTES.filter((r) => r.segmentTail).map((r) => [r.id, r.segmentTail as string]),
);
