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
  /** Full bare path (no `/api` prefix). */
  bare: string;
  /**
   * The exact string the handler matches with `path.endsWith(...)`.
   * Identical to `bare` except for the channel family, whose handlers
   * match the shorter `/commercial/channel/<x>` suffix.
   */
  matchSuffix: string;
}

const route = (
  id: string,
  methods: CommercialRouteMethod[],
  stem: string,
  matchSuffix?: string,
): CommercialRoute => ({
  id,
  methods,
  bare: `${COMMERCIAL_BARE_BASE}${stem}`,
  matchSuffix: matchSuffix ?? `${COMMERCIAL_BARE_BASE}${stem}`,
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
];

const BY_ID = new Map(COMMERCIAL_ROUTES.map((r) => [r.id, r]));

/** Canonical (`/api`) path for a route id. Throws on an unknown id — fail loud, never guess a path. */
export function commercialPath(id: string): string {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`Unknown commercial route id: ${id}`);
  return `/api${entry.bare}`;
}

/** Bare path (no `/api` prefix) for a route id. */
export function commercialBarePath(id: string): string {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`Unknown commercial route id: ${id}`);
  return entry.bare;
}

/** Handler match suffixes by route id (the exact `endsWith` strings). */
export const COMMERCIAL_ROUTE_SUFFIXES: Record<string, string> = Object.fromEntries(
  COMMERCIAL_ROUTES.map((r) => [r.id, r.matchSuffix]),
);
