/**
 * Issue #2781 (Monetization Phase 2.15) — in-memory product
 * bundle store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any store
 * at all, and so route tests can run without a D1 binding. No
 * migration concept applies here (there is no SQL to migrate).
 *
 * Atomicity: createBundlePurchaseAtomic validates the entire
 * input first (bundle exists, entitlement set is exactly the
 * member set, every period usable) and only then writes — a
 * failure writes nothing, mirroring the D1 batch.
 */
import { BusinessError } from "../outcomes/outcomeAspects";
import {
  assertBundle,
  assertBundleApproverId,
  type BundleEntitlementInput,
  type BundleEntitlementRecord,
  type BundlePurchaseInput,
  type BundlePurchaseRecord,
  type ProductBundleRecord,
  type ProductBundleStore,
} from "./productBundles";

export class InMemoryProductBundleAdapter implements ProductBundleStore {
  private bundles = new Map<string, ProductBundleRecord>();
  private purchases = new Map<string, BundlePurchaseRecord>();
  private entitlements = new Map<string, BundleEntitlementRecord>();

  async createBundle(input: {
    id?: unknown;
    name?: unknown;
    memberProductIds?: unknown;
    priceUSD?: unknown;
    periodDays?: unknown;
    includedRunsPerMember?: unknown;
  }): Promise<ProductBundleRecord> {
    const bundle = assertBundle(input);
    const id = bundle.id || `bnd-${crypto.randomUUID().slice(0, 8)}`;
    if (this.bundles.has(id)) throw new Error(`Bundle ${id} already exists.`);
    const now = Date.now();
    // A bundle is created PROPOSED — only an operator approval
    // through approveBundle makes its price chargeable.
    const record: ProductBundleRecord = {
      ...bundle,
      id,
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
      active: true,
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.bundles.set(id, record);
    return record;
  }

  async approveBundle(bundleId: string, approverId: string): Promise<ProductBundleRecord> {
    const approver = assertBundleApproverId(approverId);
    const bundle = this.bundles.get(bundleId);
    if (!bundle) throw new BusinessError("FAILURE_BUNDLE_NOT_FOUND", { bundleId });
    const now = Date.now();
    const updated: ProductBundleRecord = {
      ...bundle,
      approvalStatus: "approved",
      approvedBy: approver,
      approvedAtMs: now,
      updatedAtMs: now,
    };
    this.bundles.set(bundleId, updated);
    return updated;
  }

  async getBundle(bundleId: string): Promise<ProductBundleRecord | null> {
    return this.bundles.get(bundleId) ?? null;
  }

  async listBundles(activeOnly: boolean): Promise<ProductBundleRecord[]> {
    return [...this.bundles.values()]
      .filter((b) => !activeOnly || b.active)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async deactivateBundle(bundleId: string): Promise<ProductBundleRecord> {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) throw new BusinessError("FAILURE_BUNDLE_NOT_FOUND", { bundleId });
    const updated = { ...bundle, active: false, updatedAtMs: Date.now() };
    this.bundles.set(bundleId, updated);
    return updated;
  }

  async createBundlePurchaseAtomic(input: {
    purchase: BundlePurchaseInput;
    entitlements: BundleEntitlementInput[];
    nowMs?: number;
  }): Promise<{ purchase: BundlePurchaseRecord; entitlements: BundleEntitlementRecord[] }> {
    const { purchase, entitlements } = input;
    const nowMs = input.nowMs ?? Date.now();
    if (purchase.providerSubscriptionId) {
      const existing = await this.findBundlePurchaseByProviderSubscriptionId(
        purchase.providerSubscriptionId,
      );
      if (existing) {
        return {
          purchase: existing,
          entitlements: [...this.entitlements.values()].filter(
            (e) => e.bundlePurchaseId === existing.id,
          ),
        };
      }
    }
    // Validate EVERYTHING before writing anything.
    if (
      !purchase.id ||
      !purchase.userId ||
      !purchase.tenantId ||
      !purchase.bundleId ||
      !purchase.providerPaymentRef
    ) {
      throw new Error("id, userId, tenantId, bundleId, and providerPaymentRef are required.");
    }
    if (!(purchase.periodEndMs > purchase.periodStartMs)) {
      throw new Error("periodEndMs must be after periodStartMs.");
    }
    const bundle = await this.getBundle(purchase.bundleId);
    if (!bundle) throw new BusinessError("FAILURE_BUNDLE_NOT_FOUND", { bundleId: purchase.bundleId });
    const memberSet = new Set(bundle.memberProductIds);
    const givenSet = new Set(entitlements.map((e) => e.productId));
    if (
      entitlements.length !== bundle.memberProductIds.length ||
      entitlements.length === 0 ||
      ![...memberSet].every((m) => givenSet.has(m)) ||
      ![...givenSet].every((m) => memberSet.has(m))
    ) {
      throw new Error("Entitlements must cover exactly the bundle member products — refusing a partial entitlement set.");
    }
    for (const e of entitlements) {
      if (!e.productId || !Number.isInteger(e.includedRuns) || e.includedRuns < 0) {
        throw new Error("Each entitlement needs a productId and a non-negative integer includedRuns.");
      }
      if (!(e.periodEndMs > e.periodStartMs)) {
        throw new Error("Each entitlement periodEndMs must be after periodStartMs.");
      }
    }
    if (this.purchases.has(purchase.id)) {
      throw new Error(`Bundle purchase ${purchase.id} already exists.`);
    }
    const purchaseRecord: BundlePurchaseRecord = {
      id: purchase.id,
      userId: purchase.userId,
      tenantId: purchase.tenantId,
      bundleId: purchase.bundleId,
      provider: "stripe",
      providerPaymentRef: purchase.providerPaymentRef,
      stripeSessionId: purchase.stripeSessionId ?? null,
      stripePaymentIntentId: purchase.stripePaymentIntentId ?? null,
      providerSubscriptionId: purchase.providerSubscriptionId ?? null,
      providerStatus: purchase.providerStatus ?? null,
      status: "active",
      periodStartMs: purchase.periodStartMs,
      periodEndMs: purchase.periodEndMs,
      canceledAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const entitlementRecords: BundleEntitlementRecord[] = entitlements.map((e) => ({
      id: `bent-${crypto.randomUUID().slice(0, 8)}`,
      bundlePurchaseId: purchaseRecord.id,
      userId: purchaseRecord.userId,
      tenantId: purchaseRecord.tenantId,
      productId: e.productId,
      includedRuns: e.includedRuns,
      periodStartMs: e.periodStartMs,
      periodEndMs: e.periodEndMs,
      status: "active",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    }));
    this.purchases.set(purchaseRecord.id, purchaseRecord);
    for (const e of entitlementRecords) this.entitlements.set(e.id, e);
    return { purchase: purchaseRecord, entitlements: entitlementRecords };
  }

  async getBundlePurchase(purchaseId: string): Promise<BundlePurchaseRecord | null> {
    return this.purchases.get(purchaseId) ?? null;
  }

  async findBundlePurchaseByProviderSubscriptionId(
    providerSubscriptionId: string,
  ): Promise<BundlePurchaseRecord | null> {
    for (const p of this.purchases.values()) {
      if (p.providerSubscriptionId === providerSubscriptionId) return p;
    }
    return null;
  }

  async findBundlePurchaseByPaymentRef(paymentRef: string): Promise<BundlePurchaseRecord | null> {
    for (const p of this.purchases.values()) {
      if (p.providerPaymentRef === paymentRef || p.stripePaymentIntentId === paymentRef) return p;
    }
    return null;
  }

  async listBundlePurchases(userId: string): Promise<BundlePurchaseRecord[]> {
    return [...this.purchases.values()]
      .filter((p) => p.userId === userId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async listBundleEntitlements(userId: string): Promise<BundleEntitlementRecord[]> {
    return [...this.entitlements.values()]
      .filter((e) => e.userId === userId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async cancelBundlePurchase(purchaseId: string, nowMs: number): Promise<BundlePurchaseRecord | null> {
    const purchase = this.purchases.get(purchaseId);
    if (!purchase) return null;
    const updated = { ...purchase, status: "canceled" as const, canceledAtMs: nowMs, updatedAtMs: nowMs };
    this.purchases.set(purchaseId, updated);
    for (const e of this.entitlements.values()) {
      if (e.bundlePurchaseId === purchaseId) {
        this.entitlements.set(e.id, { ...e, status: "canceled", updatedAtMs: nowMs });
      }
    }
    return updated;
  }

  async revokeBundlePurchase(purchaseId: string, nowMs: number): Promise<BundlePurchaseRecord | null> {
    const purchase = this.purchases.get(purchaseId);
    if (!purchase) return null;
    const updated = {
      ...purchase,
      status: "canceled" as const,
      periodEndMs: nowMs,
      canceledAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.purchases.set(purchaseId, updated);
    for (const e of this.entitlements.values()) {
      if (e.bundlePurchaseId === purchaseId) {
        this.entitlements.set(e.id, { ...e, status: "canceled", periodEndMs: nowMs, updatedAtMs: nowMs });
      }
    }
    return updated;
  }
}
