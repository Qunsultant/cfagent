/**
 * Issue #2781 (Monetization Phase 2.15) — commercial product
 * bundles port.
 *
 * A bundle is a named offer of two or more LISTED Phase 2 catalog
 * products at one operator-set, owner/CBO-approved bundle price,
 * sold through the SAME Selling UX as plans (2.1 Billing mint →
 * confirm-by-retrieve fulfill → status). This is commercial
 * product bundling — NOT the screening-engine bundle
 * (the recommendation-bundle build), which is a trade
 * construction, not an offer.
 *
 * Money rules (tech-standards §8, corrected 2026-11-06): money is
 * decimal USD, rounded to cents at defined points — never
 * accumulate unrounded float results. Prices are stored as
 * 2-decimal USD values (round2 at the assert boundary).
 *
 * Approval discipline (mirrors #3357 plan-price approval and the
 * #2547 catalogue discipline): a bundle is PROPOSED from the
 * moment it is created until an operator approves it through POST
 * /bundles/approve. Only an APPROVED bundle price may be charged:
 * every charging path refuses an unapproved bundle. No bundle is
 * ever seeded: bundles exist only when an operator creates one,
 * and no price, combination, or discount is ever defaulted —
 * which combinations become bundles, each price, and the discount
 * rule are owner/CBO decisions (#2781).
 *
 * Entitlement (no partial entitlement): a verified bundle payment
 * confers one entitlement row per member product, written in the
 * SAME atomic batch as the purchase row — a failed member
 * fulfillment fails the whole bundle closed, with nothing
 * activated. Entitlement rows are the durable access record:
 * unexpired rows are what the Selling derivation and the Billing
 * tab read. Gate consumption of bundle entitlements (per-run
 * coverage from bundle included runs) is a named follow-up, not
 * this slice — the same precedent as slice 3 deferring the
 * Subscribed included-run bypass.
 *
 * This module is the pure port: records, validation, and the
 * store interface. It imports no store client, references no env
 * binding, and writes no SQL. Only the adapters (Drizzle D1,
 * in-memory) touch a store, and only the composition root
 * (createProductBundlePorts.ts) maps a Worker binding to an
 * adapter.
 */
import { BusinessError } from "../outcomes/outcomeAspects";
import { PRICE_FAMILIES, type PriceFamily } from "./priceCataloguePorts";

/** Bundle price approval state — mirrors PlanPriceApprovalStatus (#3357). */
export type BundlePriceApprovalStatus = "proposed" | "approved";

export type BundlePurchaseStatus = "active" | "canceled";

/** A bundle offer: operator data, never code. */
export interface ProductBundleRecord {
  id: string;
  name: string;
  /** Catalog product ids (`family:PayPerUse`), ≥2, unique. */
  memberProductIds: string[];
  priceUSD: number;
  periodDays: number;
  /** Included runs conferred per member product, per period. */
  includedRunsPerMember: number;
  approvalStatus: BundlePriceApprovalStatus;
  /** Login of the approving operator; null while proposed. */
  approvedBy: string | null;
  /** Epoch ms of the approval; null while proposed. */
  approvedAtMs: number | null;
  active: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One verified bundle purchase: the Billing-managed row. */
export interface BundlePurchaseRecord {
  id: string;
  userId: string;
  tenantId: string;
  bundleId: string;
  provider: string;
  /** Route-minted draft id (`bbnd-…`) — the replay-guard key. */
  providerPaymentRef: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  providerSubscriptionId: string | null;
  /** Provider status string (Stripe: active, past_due, canceled, …); null on non-Billing rows. Recorded verbatim, never judged here. */
  providerStatus: string | null;
  status: BundlePurchaseStatus;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** One member product's access under a bundle purchase. */
export interface BundleEntitlementRecord {
  id: string;
  bundlePurchaseId: string;
  userId: string;
  tenantId: string;
  /** Catalog product id (`family:PayPerUse`). */
  productId: string;
  includedRuns: number;
  periodStartMs: number;
  periodEndMs: number;
  status: BundlePurchaseStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Round money to the cent; anything finer is a caller bug. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A member product id is `family:PayPerUse` with a known family. */
export function isBundleMemberProductId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [family, tier] = value.split(":");
  return (
    (PRICE_FAMILIES as readonly string[]).includes(family) &&
    tier === "PayPerUse" &&
    value === `${family}:${tier}`
  );
}

/** The family a member product id names, or null when malformed. */
export function bundleMemberFamily(productId: string): PriceFamily | null {
  const [family] = productId.split(":");
  return (PRICE_FAMILIES as readonly string[]).includes(family)
    ? (family as PriceFamily)
    : null;
}

/**
 * Validate bundle creation input; throws a catalog-coded
 * BusinessError on the first failure (never a raw Error — the
 * route maps BusinessError to its catalog-coded response).
 * Members are validated for shape here; "listed" is a route-time
 * catalog check, not a port concern.
 */
export function assertBundle(input: {
  id?: unknown;
  name?: unknown;
  memberProductIds?: unknown;
  priceUSD?: unknown;
  periodDays?: unknown;
  includedRunsPerMember?: unknown;
}): {
  id: string;
  name: string;
  memberProductIds: string[];
  priceUSD: number;
  periodDays: number;
  includedRunsPerMember: number;
} {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new BusinessError("FAILURE_BUNDLE_INVALID");
  const members = input.memberProductIds;
  if (!Array.isArray(members) || members.length < 2) {
    throw new BusinessError("FAILURE_BUNDLE_MEMBERS_INVALID");
  }
  const seen = new Set<string>();
  for (const m of members) {
    if (!isBundleMemberProductId(m) || seen.has(m)) {
      throw new BusinessError("FAILURE_BUNDLE_MEMBERS_INVALID");
    }
    seen.add(m);
  }
  const priceUSD = Number(input.priceUSD);
  if (!Number.isFinite(priceUSD) || priceUSD <= 0) {
    throw new BusinessError("FAILURE_BUNDLE_INVALID");
  }
  const periodDays = Number(input.periodDays);
  if (!Number.isFinite(periodDays) || periodDays < 1 || Math.floor(periodDays) !== periodDays) {
    throw new BusinessError("FAILURE_BUNDLE_INVALID");
  }
  const includedRunsPerMember = Number(input.includedRunsPerMember);
  if (
    !Number.isFinite(includedRunsPerMember) ||
    includedRunsPerMember < 0 ||
    Math.floor(includedRunsPerMember) !== includedRunsPerMember
  ) {
    throw new BusinessError("FAILURE_BUNDLE_INVALID");
  }
  return {
    id,
    name,
    memberProductIds: [...members] as string[],
    priceUSD: round2(priceUSD),
    periodDays,
    includedRunsPerMember,
  };
}

/** The approver is an audit identity: a blank approver approves nothing. */
export function assertBundleApproverId(approverId: unknown): string {
  if (typeof approverId !== "string" || approverId.trim().length === 0) {
    throw new BusinessError("FAILURE_BUNDLE_APPROVAL_INVALID");
  }
  return approverId.trim();
}

/** Only an APPROVED bundle price may be charged. */
export function isBundlePriceApproved(bundle: {
  approvalStatus: BundlePriceApprovalStatus;
}): boolean {
  return bundle.approvalStatus === "approved";
}

/** An entitlement row is live when active and its period covers now. */
export function isBundleEntitlementLive(
  entitlement: { status: BundlePurchaseStatus; periodEndMs: number },
  nowMs: number,
): boolean {
  return entitlement.status === "active" && entitlement.periodEndMs > nowMs;
}

/** A purchase row is live when active and its period covers now. */
export function isBundlePurchaseLive(
  purchase: { status: BundlePurchaseStatus; periodEndMs: number },
  nowMs: number,
): boolean {
  return purchase.status === "active" && purchase.periodEndMs > nowMs;
}

export interface BundlePurchaseInput {
  id?: string;
  userId: string;
  tenantId: string;
  bundleId: string;
  providerPaymentRef: string;
  stripeSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  providerSubscriptionId?: string | null;
  providerStatus?: string | null;
  periodStartMs: number;
  periodEndMs: number;
}

export interface BundleEntitlementInput {
  productId: string;
  includedRuns: number;
  periodStartMs: number;
  periodEndMs: number;
}

export interface ProductBundleStore {
  createBundle(input: {
    id?: unknown;
    name?: unknown;
    memberProductIds?: unknown;
    priceUSD?: unknown;
    periodDays?: unknown;
    includedRunsPerMember?: unknown;
  }): Promise<ProductBundleRecord>;
  getBundle(bundleId: string): Promise<ProductBundleRecord | null>;
  listBundles(activeOnly: boolean): Promise<ProductBundleRecord[]>;
  deactivateBundle(bundleId: string): Promise<ProductBundleRecord>;
  /**
   * Approve a bundle's price, recording the approver and the
   * approval time. Approving a missing bundle throws; a blank
   * approver approves nothing. Re-approval updates the record
   * (the operator re-affirms). Deactivation does not un-approve:
   * approval is about the price, not about whether the bundle
   * is sold.
   */
  approveBundle(bundleId: string, approverId: string): Promise<ProductBundleRecord>;
  /**
   * Atomically record a verified bundle purchase plus one
   * entitlement row per member product. All-or-nothing: a
   * validation failure (or a store failure mid-write) writes
   * NOTHING — no partial entitlement, ever. The caller has
   * already verified the payment and the member list; this
   * method re-validates the entitlement inputs structurally
   * before writing. A replay (an existing purchase row for the
   * same provider subscription id) returns the existing
   * purchase; the route maps that to 409.
   */
  createBundlePurchaseAtomic(input: {
    purchase: BundlePurchaseInput;
    entitlements: BundleEntitlementInput[];
    nowMs?: number;
  }): Promise<{
    purchase: BundlePurchaseRecord;
    entitlements: BundleEntitlementRecord[];
  }>;
  getBundlePurchase(purchaseId: string): Promise<BundlePurchaseRecord | null>;
  /** The Billing-managed purchase for this provider subscription id, if any — the replay guard. */
  findBundlePurchaseByProviderSubscriptionId(
    providerSubscriptionId: string,
  ): Promise<BundlePurchaseRecord | null>;
  /** The purchase for this payment reference (draft id or payment-intent id), if any — the refund-refusal lookup. */
  findBundlePurchaseByPaymentRef(paymentRef: string): Promise<BundlePurchaseRecord | null>;
  /** All purchases for the user, oldest first. */
  listBundlePurchases(userId: string): Promise<BundlePurchaseRecord[]>;
  /** All entitlement rows for the user, oldest first. */
  listBundleEntitlements(userId: string): Promise<BundleEntitlementRecord[]>;
  /**
   * Cancel ONE purchase at period end: status canceled,
   * periodEndMs KEPT (access continues to periodEnd),
   * canceledAtMs set — and the same for its entitlement rows.
   * Null when the purchase does not exist.
   */
  cancelBundlePurchase(
    purchaseId: string,
    nowMs: number,
  ): Promise<BundlePurchaseRecord | null>;
  /**
   * Revoke ONE purchase immediately: status canceled AND
   * periodEndMs moved to nowMs (and the same for its
   * entitlement rows), so access stops at the next read.
   * Returns the updated row, or null when the id is unknown.
   */
  revokeBundlePurchase(
    purchaseId: string,
    nowMs: number,
  ): Promise<BundlePurchaseRecord | null>;
}
