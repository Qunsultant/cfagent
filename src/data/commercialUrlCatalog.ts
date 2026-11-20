/**
 * Issue #2846 (Monetization Phase 2.16) — the commercial URL catalog, the
 * single source of truth for every commercial route path.
 *
 * Every commercial route is defined ONCE here: the full
 * `/payments/agentic/commercial/*` family (plus the cfpay channel family
 * under `/commercial/channel/*`), in both spellings while the #2839
 * dispatcher alias stands (canonical `/api/payments/agentic/commercial/*`
 * + bare `/payments/agentic/commercial/*`).
 *
 * Issue #5610 (G-8): the 10 parameterized routes (Group C) are catalogued
 * here too. Their `bare` is a `:param` template; the handler matches them
 * through `matchCatalogRoute` (suffix + `matchIncludes`, path only — the
 * method check stays explicit in the branch, exactly as before) and
 * extracts params through `extractCatalogParams` (the branches' old
 * split/indexOf/decode-with-keep-raw-fallback, in one place). Clients
 * build parameterized URLs with `commercialPathParams` /
 * `commercialBarePathParams` (values are encoded once, by the builder);
 * `commercialPath` / `commercialBarePath` throw on a parameterized entry
 * — fail loud, never emit a literal `:param` URL.
 *
 * Consumers derive paths from this module, never from a literal string:
 * - the dispatcher (`src/server/routes/platform.ts`) uses
 *   `COMMERCIAL_BARE_PREFIX` / `PAYMENTS_API_PREFIX`;
 * - the handlers (`src/agents/routes/agenticPayments.ts`) match
 *   `COMMERCIAL_ROUTE_SUFFIXES.<id>` (the exact `endsWith` string);
 * - the clients (`src/client/*Api.ts`, panels) build paths from
 *   `COMMERCIAL_API_BASE` or `commercialPath(id)`;
 * - the IAAA explorer (`src/client/iaaaEndpointCatalog.ts`) derives its
 *   `payments-agentic` prefixes + source from this module.
 *
 * Change a path here and every consumer follows. A hardcoded commercial
 * path literal anywhere else in `src/` fails
 * `tests/commercial_url_catalog_2846.test.ts`.
 *
 * This catalog owns PATHS. Prices live in the price catalogue (#2668,
 * `src/data/priceCataloguePorts.ts`) — the two are distinct by design
 * and must not be merged.
 */

export const COMMERCIAL_API_BASE = "/api/payments/agentic/commercial";
export const COMMERCIAL_BARE_BASE = "/payments/agentic/commercial";

/** Dispatcher prefix for the bare commercial spelling (trailing slash). */
export const COMMERCIAL_BARE_PREFIX = "/payments/agentic/commercial/";

/**
 * Dispatcher prefix for the whole `/api/payments/agentic/` family
 * (wallet + ledger + commercial under the canonical spelling). It is a
 * family prefix, not a commercial route literal — the commercial family
 * is the set of entries below.
 */
export const PAYMENTS_API_PREFIX = "/api/payments/agentic/";

export type CommercialRouteMethod = "GET" | "POST";

export interface CommercialRoute {
  /** Stable id used by `commercialPath(id)` / `COMMERCIAL_ROUTE_SUFFIXES`. */
  id: string;
  /** Methods served on this suffix. */
  methods: CommercialRouteMethod[];
  /** Full bare path (no `/api` prefix); a `:param` template for parameterized routes. */
  bare: string;
  /**
   * The exact string the handler matches with `path.endsWith(...)`.
   * Identical to `bare` except for the channel family, whose handlers
   * match the shorter `/commercial/channel/<x>` suffix. Empty for
   * includes-only routes (no endsWith tail — see `matchIncludes`).
   */
  matchSuffix: string;
  /**
   * `path.includes(...)` strings the handler also requires (parameterized
   * routes). Every string must be present. The first include is the
   * family stem (e.g. `/payments/agentic/commercial/products/`).
   */
  matchIncludes?: string[];
  /**
   * Path parameters, in order. Each is the segment after the literal
   * segment named by `after` (`parts[parts.indexOf(after) + 1]`, the
   * branches' old extraction, decodeURIComponent with keep-raw fallback).
   */
  params?: CatalogRouteParam[];
}

/** One path parameter: the segment after the literal segment `after`. */
export interface CatalogRouteParam {
  name: string;
  after: string;
}

const route = (
  id: string,
  methods: CommercialRouteMethod[],
  stem: string,
  matchSuffix?: string,
  matchIncludes?: string[],
  params?: CatalogRouteParam[],
): CommercialRoute => ({
  id,
  methods,
  bare: `${COMMERCIAL_BARE_BASE}${stem}`,
  matchSuffix: matchSuffix ?? `${COMMERCIAL_BARE_BASE}${stem}`,
  ...(matchIncludes ? { matchIncludes } : {}),
  ...(params ? { params } : {}),
});

export const COMMERCIAL_ROUTES: CommercialRoute[] = [
  route("account", ["GET", "POST"], "/account"),
  route("identity", ["GET"], "/identity"),
  route("accountCredits", ["POST"], "/account/credits"),
  route("freeRunAllowance", ["GET", "POST"], "/free-run-allowance"),
  route("tenantSettings", ["GET", "POST"], "/tenant-settings"),
  route("submit", ["POST"], "/submit"),
  route("submissionStatus", ["GET"], "/submission-status"),
  route("plans", ["GET", "POST"], "/plans"),
  route("plansApprove", ["POST"], "/plans/approve"),
  route("plansDeactivate", ["POST"], "/plans/deactivate"),
  // Issue #2781 (Monetization Phase 2.15): product bundles mirror plans —
  // same catalog rule, no literal survives. The bundle routes were written
  // before this catalog landed; they are catalogued here so the handler
  // matches through COMMERCIAL_ROUTE_SUFFIXES, never a literal path.
  route("bundles", ["GET", "POST"], "/bundles"),
  route("bundlesApprove", ["POST"], "/bundles/approve"),
  route("bundlesDeactivate", ["POST"], "/bundles/deactivate"),
  route("bundleCheckout", ["POST"], "/subscription/bundle-checkout"),
  route("bundlePurchase", ["POST"], "/subscription/bundle-purchase"),
  route("subscriptionCheckout", ["POST"], "/subscription/checkout"),
  route("subscriptionPurchase", ["POST"], "/subscription/purchase"),
  route("topUpCheckout", ["POST"], "/top-up/checkout"),
  route("topUpConfirm", ["POST"], "/top-up/confirm"),
  route("subscriptionGrant", ["POST"], "/subscription/grant"),
  route("subscriptionTrial", ["POST"], "/subscription/trial"),
  route("subscriptionBillingCheckout", ["POST"], "/subscription/billing-checkout"),
  route("subscriptionBillingPurchase", ["POST"], "/subscription/billing-purchase"),
  route("billingWebhook", ["POST"], "/billing/webhook"),
  route("billingPolicy", ["GET", "POST"], "/billing-policy"),
  route("channelCheckout", ["POST"], "/channel/checkout", "/commercial/channel/checkout"),
  route("channelPurchase", ["POST"], "/channel/purchase", "/commercial/channel/purchase"),
  route("channelPurchases", ["GET"], "/channel/purchases", "/commercial/channel/purchases"),
  route("channelReconcile", ["POST"], "/channel/reconcile", "/commercial/channel/reconcile"),
  route("subscriptionCancel", ["POST"], "/subscription/cancel"),
  route("subscriptionBillingChangePlan", ["POST"], "/subscription/billing-change-plan"),
  route("subscription", ["GET"], "/subscription"),
  route("pricing", ["GET"], "/pricing"),
  route("prices", ["GET", "POST"], "/prices"),
  route("operators", ["GET"], "/operators"),
  route("operatorsAdd", ["POST"], "/operators/add"),
  route("operatorsRemove", ["POST"], "/operators/remove"),
  route("refunds", ["GET", "POST"], "/refunds"),
  route("refundsApprove", ["POST"], "/refunds/approve"),
  route("refundsExecute", ["POST"], "/refunds/execute"),
  route("refundPolicy", ["GET", "POST"], "/refund-policy"),
  route("refundPolicyApprove", ["POST"], "/refund-policy/approve"),
  route("submissionCheckPayment", ["POST"], "/submission/check-payment"),
  route("goalCommand", ["POST"], "/goal-command"),
  route("referralBalance", ["GET"], "/referral/balance"),
  route("referralRecordEarn", ["POST"], "/referral/record-earn"),
  route("referralRules", ["GET", "POST"], "/referral/rules"),
  route("referralAttribute", ["POST"], "/referral/attribute"),
  route("lifecyclePreferences", ["GET", "POST"], "/lifecycle/preferences"),
  route("lifecycleWelcome", ["POST"], "/lifecycle/welcome"),
  route("lifecycleDigestSend", ["POST"], "/lifecycle/digest/send"),
  route("lifecycleDigestRunDue", ["POST"], "/lifecycle/digest/run-due"),
  route("lifecycleUnsubscribe", ["POST"], "/lifecycle/unsubscribe"),
  // Rebase union (2026-11-14): routes that landed on main after the
  // slice's base — #2667 usage-billing, #3263 approved-free-quota +
  // free-access, #3246 runs-packs / products / offer / catalogue,
  // #3307 referral codes. Same catalog, same rule: no literal survives.
  route("usageBilling", ["GET"], "/usage-billing"),
  route("approvedFreeQuota", ["GET", "POST"], "/approved-free-quota"),
  route("runsPackCheckout", ["POST"], "/runs-packs/checkout"),
  route("runsPackConfirm", ["POST"], "/runs-packs/confirm"),
  route("referralCodeRules", ["GET", "POST"], "/referral-code-rules"),
  route("referralCodeIssue", ["POST"], "/referral-codes/issue"),
  route("referralCodes", ["GET"], "/referral-codes"),
  route("referralCodeRevoke", ["POST"], "/referral-codes/revoke"),
  route("referralCodeRedeem", ["POST"], "/referral-codes/redeem"),
  route("referralCodesMine", ["GET", "POST"], "/referral-codes/mine"),
  route("referralCodesMineRevoke", ["POST"], "/referral-codes/mine/revoke"),
  route("referralCodesBalance", ["GET"], "/referral-codes/balance"),
  route("products", ["GET", "POST"], "/products"),
  route("offer", ["POST"], "/offer"),
  route("offerCompare", ["GET"], "/offer/compare"),
  route("offerDismiss", ["POST"], "/offer/dismiss"),
  route("catalogueVersions", ["GET", "POST"], "/catalogue/versions"),
  route("freeAccessGrant", ["POST"], "/free-access/grant"),
  route("freeAccessRevoke", ["POST"], "/free-access/revoke"),
  route("freeAccess", ["GET"], "/free-access"),
  // Issue #5610 (G-8): the 10 parameterized routes (Group C). Their
  // `matchIncludes` + `matchSuffix` reproduce the branches' old match
  // conditions exactly — including the approve/deactivate branches,
  // which require only the products stem (no "/versions/" include),
  // and the bulk-move detail branch, which is includes-only (no
  // endsWith tail: the id is the last segment). `bare` is the `:param`
  // template clients fill through `commercialPathParams`.
  route(
    "subscriptionMove",
    ["POST"],
    "/subscriptions/:subscriptionId/move",
    "/move",
    [`${COMMERCIAL_BARE_BASE}/subscriptions/`],
    [{ name: "subscriptionId", after: "subscriptions" }],
  ),
  route(
    "accountSegment",
    ["POST"],
    "/accounts/:userId/segment",
    "/segment",
    [`${COMMERCIAL_BARE_BASE}/accounts/`],
    [{ name: "userId", after: "accounts" }],
  ),
  route(
    "productRank",
    ["POST"],
    "/products/:productId/rank",
    "/rank",
    [`${COMMERCIAL_BARE_BASE}/products/`],
    [{ name: "productId", after: "products" }],
  ),
  route(
    "productVersions",
    ["GET", "POST"],
    "/products/:productId/versions",
    "/versions",
    [`${COMMERCIAL_BARE_BASE}/products/`],
    [{ name: "productId", after: "products" }],
  ),
  route(
    "versionApprove",
    ["POST"],
    "/products/:productId/versions/:versionId/approve",
    "/approve",
    [`${COMMERCIAL_BARE_BASE}/products/`],
    [
      { name: "productId", after: "products" },
      { name: "versionId", after: "versions" },
    ],
  ),
  route(
    "versionDeactivate",
    ["POST"],
    "/products/:productId/versions/:versionId/deactivate",
    "/deactivate",
    [`${COMMERCIAL_BARE_BASE}/products/`],
    [
      { name: "productId", after: "products" },
      { name: "versionId", after: "versions" },
    ],
  ),
  route(
    "productBulkMove",
    ["POST"],
    "/products/:productId/bulk-move",
    "/bulk-move",
    [`${COMMERCIAL_BARE_BASE}/products/`],
    [{ name: "productId", after: "products" }],
  ),
  route(
    "productBulkMoves",
    ["GET"],
    "/products/:productId/bulk-moves",
    "/bulk-moves",
    [`${COMMERCIAL_BARE_BASE}/products/`],
    [{ name: "productId", after: "products" }],
  ),
  route(
    "productBulkMoveDetail",
    ["GET"],
    "/products/:productId/bulk-moves/:bulkMoveId",
    "",
    [`${COMMERCIAL_BARE_BASE}/products/`, "/bulk-moves/"],
    [
      { name: "productId", after: "products" },
      { name: "bulkMoveId", after: "bulk-moves" },
    ],
  ),
];

const BY_ID = new Map(COMMERCIAL_ROUTES.map((r) => [r.id, r]));

/** A catalog route by id. Throws on an unknown id — fail loud, never guess a route. */
export function commercialRouteById(id: string): CommercialRoute {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`Unknown commercial route id: ${id}`);
  return entry;
}

/**
 * Canonical (`/api`) path for a route id. Throws on an unknown id — fail
 * loud, never guess a path. Throws on a parameterized entry: a `:param`
 * template is not a URL — use `commercialPathParams`.
 */
export function commercialPath(id: string): string {
  const entry = commercialRouteById(id);
  if (entry.params?.length) {
    throw new Error(`Commercial route ${id} is parameterized; use commercialPathParams`);
  }
  return `/api${entry.bare}`;
}

/** Bare path (no `/api` prefix) for a route id. Same throw rules as `commercialPath`. */
export function commercialBarePath(id: string): string {
  const entry = commercialRouteById(id);
  if (entry.params?.length) {
    throw new Error(`Commercial route ${id} is parameterized; use commercialBarePathParams`);
  }
  return entry.bare;
}

/**
 * Canonical (`/api`) path for a parameterized route id, with `:param`
 * segments filled from `params` (each value encoded once, here — callers
 * pass raw values). Throws on an unknown id or a missing param.
 */
export function commercialPathParams(id: string, params: Record<string, string>): string {
  return `/api${commercialBarePathParams(id, params)}`;
}

/** Bare path for a parameterized route id, with `:param` segments filled. */
export function commercialBarePathParams(id: string, params: Record<string, string>): string {
  const entry = commercialRouteById(id);
  return entry.bare
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const name = segment.slice(1);
      const value = params[name];
      if (value === undefined) {
        throw new Error(`Missing path param ${name} for commercial route ${id}`);
      }
      return encodeURIComponent(value);
    })
    .join("/");
}

/** Handler match suffixes by route id (the exact `endsWith` strings; "" = includes-only). */
export const COMMERCIAL_ROUTE_SUFFIXES: Record<string, string> = Object.fromEntries(
  COMMERCIAL_ROUTES.map((r) => [r.id, r.matchSuffix]),
);

/** Handler `path.includes(...)` strings by route id (parameterized routes only). */
export const COMMERCIAL_ROUTE_INCLUDES: Record<string, readonly string[]> = Object.fromEntries(
  COMMERCIAL_ROUTES.filter((r) => r.matchIncludes?.length).map((r) => [
    r.id,
    r.matchIncludes as readonly string[],
  ]),
);

/**
 * The segments after a route's includes marker (the first
 * `matchIncludes` string) in the path. The tenants/channels handlers
 * dispatch on these segments; the commercial extractor above is built
 * on the same split. An entry with no marker yields no segments.
 */
export function segmentsAfterMarker(
  path: string,
  route: Pick<CommercialRoute, "matchIncludes">,
): string[] {
  const marker = route.matchIncludes?.[0] ?? "";
  if (!marker) return [];
  const rest = path.split(marker)[1] ?? "";
  return rest.split("/");
}

/**
 * Path-only catalog match: the handler's old `endsWith(matchSuffix)` plus
 * every `matchIncludes` string, in one place. Method is deliberately NOT
 * checked here — it stays explicit and literal in the branch (merged
 * entries serve two methods from two branches, and the users + tenants
 * collection branches match on suffix alone and answer 405 inside).
 */
export function matchCatalogRoute(
  route: Pick<CommercialRoute, "matchSuffix" | "matchIncludes">,
  path: string,
): boolean {
  if (route.matchSuffix.length > 0 && !path.endsWith(route.matchSuffix)) return false;
  for (const needle of route.matchIncludes ?? []) {
    if (!path.includes(needle)) return false;
  }
  return true;
}

/**
 * Path parameters for a catalog route, by the branches' old extraction:
 * `parts[parts.indexOf(after) + 1]`, `decodeURIComponent` with keep-raw
 * fallback on a malformed segment. A missing marker yields "" (the old
 * `parts[0]` for an absolute path), never a throw — the lookup below
 * 404s on it, exactly as before.
 */
export function extractCatalogParams(
  route: Pick<CommercialRoute, "params">,
  path: string,
): Record<string, string> {
  const parts = path.split("/");
  const out: Record<string, string> = {};
  for (const param of route.params ?? []) {
    const raw = parts[parts.indexOf(param.after) + 1] ?? "";
    try {
      out[param.name] = decodeURIComponent(raw);
    } catch {
      out[param.name] = raw;
    }
  }
  return out;
}
