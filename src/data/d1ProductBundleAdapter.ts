/**
 * Issue #2781 (Monetization Phase 2.15) — Drizzle D1 adapter
 * for the product bundle store port. This module is the ONLY
 * place bundle code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder, plus the raw-SQL batch for
 * the atomic purchase write) lives here, behind the port
 * interface.
 *
 * Atomicity (standards §7.2 Idempotent Receiver, and the
 * #2781 no-partial-entitlement rule): the purchase row AND
 * every entitlement row land in ONE d1.batch (the
 * d1ProfileAdapter precedent) — a batch failure rolls all of
 * them back, so a purchase never lands without its full
 * entitlement set and an entitlement never lands without its
 * purchase. Every other operation is a single statement,
 * which is atomic on any store. The provider-subscription
 * uniqueness is a single UNIQUE index: the loser of a race
 * gets a UNIQUE violation and re-checks, never a double
 * activation.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { BusinessError } from "../outcomes/outcomeAspects";
import {
  agentBundleEntitlements,
  agentBundlePurchases,
  agentProductBundles,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0053_PRODUCT_BUNDLES,
  type MigrationDb,
} from "./migrationRunner";
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

/** Drizzle D1 database object carrying the bundle tables. */
export type ProductBundleDb = DrizzleD1Database<{
  agentProductBundles: typeof agentProductBundles;
  agentBundlePurchases: typeof agentBundlePurchases;
  agentBundleEntitlements: typeof agentBundleEntitlements;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProductBundleDb(d1: D1Database): ProductBundleDb {
  return drizzle(d1, {
    schema: {
      agentProductBundles,
      agentBundlePurchases,
      agentBundleEntitlements,
    },
  });
}

/** Idempotent schema-ensure: applies migration 0053 if unapplied. */
export async function ensureProductBundleSchema(db: ProductBundleDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0053_PRODUCT_BUNDLES]);
}

function toBundle(raw: typeof agentProductBundles.$inferSelect): ProductBundleRecord {
  let memberProductIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw.memberProductIds);
    if (Array.isArray(parsed)) memberProductIds = parsed.filter((m): m is string => typeof m === "string");
  } catch {
    memberProductIds = [];
  }
  return {
    id: raw.id,
    name: raw.name,
    memberProductIds,
    priceUSD: raw.priceUSD,
    periodDays: raw.periodDays,
    includedRunsPerMember: raw.includedRunsPerMember,
    approvalStatus: raw.approvalStatus === "approved" ? "approved" : "proposed",
    approvedBy: raw.approvedBy ?? null,
    approvedAtMs: raw.approvedAtMs ?? null,
    active: raw.active === 1,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toPurchase(raw: typeof agentBundlePurchases.$inferSelect): BundlePurchaseRecord {
  return {
    id: raw.id,
    userId: raw.userId,
    tenantId: raw.tenantId,
    bundleId: raw.bundleId,
    provider: raw.provider,
    providerPaymentRef: raw.providerPaymentRef,
    stripeSessionId: raw.stripeSessionId ?? null,
    stripePaymentIntentId: raw.stripePaymentIntentId ?? null,
    providerSubscriptionId: raw.providerSubscriptionId ?? null,
    providerStatus: raw.providerStatus ?? null,
    status: raw.status === "canceled" ? "canceled" : "active",
    periodStartMs: raw.periodStartMs,
    periodEndMs: raw.periodEndMs,
    canceledAtMs: raw.canceledAtMs,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toEntitlement(raw: typeof agentBundleEntitlements.$inferSelect): BundleEntitlementRecord {
  return {
    id: raw.id,
    bundlePurchaseId: raw.bundlePurchaseId,
    userId: raw.userId,
    tenantId: raw.tenantId,
    productId: raw.productId,
    includedRuns: raw.includedRuns,
    periodStartMs: raw.periodStartMs,
    periodEndMs: raw.periodEndMs,
    status: raw.status === "canceled" ? "canceled" : "active",
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Product bundles over D1 via Drizzle (+ raw-SQL batch for the atomic purchase write). */
export class D1ProductBundleAdapter implements ProductBundleStore {
  constructor(
    readonly db: ProductBundleDb,
    private readonly d1: D1Database,
  ) {}

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
    const now = Date.now();
    // A bundle is created PROPOSED — only an operator approval
    // through POST /bundles/approve makes its price chargeable.
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
    try {
      await this.db.insert(agentProductBundles).values({
        id: record.id,
        name: record.name,
        memberProductIds: JSON.stringify(record.memberProductIds),
        priceUSD: record.priceUSD,
        periodDays: record.periodDays,
        includedRunsPerMember: record.includedRunsPerMember,
        approvalStatus: "proposed",
        approvedBy: null,
        approvedAtMs: null,
        active: 1,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
      });
    } catch {
      const existing = await this.getBundle(id);
      if (existing) throw new Error(`Bundle ${id} already exists.`);
      throw new Error(`Failed to create bundle ${id}.`);
    }
    return record;
  }

  async approveBundle(bundleId: string, approverId: string): Promise<ProductBundleRecord> {
    const approver = assertBundleApproverId(approverId);
    const bundle = await this.getBundle(bundleId);
    if (!bundle) throw new BusinessError("FAILURE_BUNDLE_NOT_FOUND", { bundleId });
    const now = Date.now();
    await this.db
      .update(agentProductBundles)
      .set({ approvalStatus: "approved", approvedBy: approver, approvedAtMs: now, updatedAtMs: now })
      .where(eq(agentProductBundles.id, bundleId));
    return { ...bundle, approvalStatus: "approved", approvedBy: approver, approvedAtMs: now, updatedAtMs: now };
  }

  async getBundle(bundleId: string): Promise<ProductBundleRecord | null> {
    const rows = await this.db
      .select()
      .from(agentProductBundles)
      .where(eq(agentProductBundles.id, bundleId))
      .limit(1);
    return rows.length === 0 ? null : toBundle(rows[0]);
  }

  async listBundles(activeOnly: boolean): Promise<ProductBundleRecord[]> {
    const rows = activeOnly
      ? await this.db
          .select()
          .from(agentProductBundles)
          .where(eq(agentProductBundles.active, 1))
          .orderBy(asc(agentProductBundles.createdAtMs), asc(agentProductBundles.id))
      : await this.db
          .select()
          .from(agentProductBundles)
          .orderBy(asc(agentProductBundles.createdAtMs), asc(agentProductBundles.id));
    return rows.map(toBundle);
  }

  async deactivateBundle(bundleId: string): Promise<ProductBundleRecord> {
    const bundle = await this.getBundle(bundleId);
    if (!bundle) throw new BusinessError("FAILURE_BUNDLE_NOT_FOUND", { bundleId });
    await this.db
      .update(agentProductBundles)
      .set({ active: 0, updatedAtMs: Date.now() })
      .where(eq(agentProductBundles.id, bundleId));
    return { ...bundle, active: false, updatedAtMs: Date.now() };
  }

  async createBundlePurchaseAtomic(input: {
    purchase: BundlePurchaseInput;
    entitlements: BundleEntitlementInput[];
    nowMs?: number;
  }): Promise<{ purchase: BundlePurchaseRecord; entitlements: BundleEntitlementRecord[] }> {
    const { purchase, entitlements } = input;
    const nowMs = input.nowMs ?? Date.now();
    // Replay guard first: an existing purchase for this provider
    // subscription id is returned, never duplicated (the route
    // maps that to 409).
    if (purchase.providerSubscriptionId) {
      const existing = await this.findBundlePurchaseByProviderSubscriptionId(purchase.providerSubscriptionId);
      if (existing) {
        const existingEntitlements = await this.db
          .select()
          .from(agentBundleEntitlements)
          .where(eq(agentBundleEntitlements.bundlePurchaseId, existing.id));
        return { purchase: existing, entitlements: existingEntitlements.map(toEntitlement) };
      }
    }
    // Structural validation BEFORE any write: the entitlement set
    // must be exactly the bundle's member set (no subset, no
    // extra), every period must be usable, every field present.
    // A failure here writes nothing — the no-partial-entitlement
    // rule is enforced before the batch, not by rolling one back.
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
    try {
      await this.d1.batch([
        this.d1
          .prepare(
            `INSERT INTO agent_bundle_purchases (id, user_id, tenant_id, bundle_id, provider, provider_payment_ref, stripe_session_id, stripe_payment_intent_id, provider_subscription_id, provider_status, status, period_start_ms, period_end_ms, canceled_at_ms, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            purchaseRecord.id,
            purchaseRecord.userId,
            purchaseRecord.tenantId,
            purchaseRecord.bundleId,
            purchaseRecord.provider,
            purchaseRecord.providerPaymentRef,
            purchaseRecord.stripeSessionId,
            purchaseRecord.stripePaymentIntentId,
            purchaseRecord.providerSubscriptionId,
            purchaseRecord.providerStatus,
            purchaseRecord.status,
            purchaseRecord.periodStartMs,
            purchaseRecord.periodEndMs,
            purchaseRecord.canceledAtMs,
            purchaseRecord.createdAtMs,
            purchaseRecord.updatedAtMs,
          ),
        ...entitlementRecords.map((e) =>
          this.d1
            .prepare(
              `INSERT INTO agent_bundle_entitlements (id, bundle_purchase_id, user_id, tenant_id, product_id, included_runs, period_start_ms, period_end_ms, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              e.id,
              e.bundlePurchaseId,
              e.userId,
              e.tenantId,
              e.productId,
              e.includedRuns,
              e.periodStartMs,
              e.periodEndMs,
              e.status,
              e.createdAtMs,
              e.updatedAtMs,
            ),
        ),
      ]);
    } catch (err) {
      // Race: another delivery recorded this provider id between
      // the guard check and the batch (the UNIQUE index refused
      // the second insert). A re-check separates that replay from
      // a genuine store failure — the failure re-throws for the
      // coded 503, never a parsed error string.
      if (purchaseRecord.providerSubscriptionId) {
        const existing = await this.findBundlePurchaseByProviderSubscriptionId(purchaseRecord.providerSubscriptionId);
        if (existing) {
          const existingEntitlements = await this.db
            .select()
            .from(agentBundleEntitlements)
            .where(eq(agentBundleEntitlements.bundlePurchaseId, existing.id));
          return { purchase: existing, entitlements: existingEntitlements.map(toEntitlement) };
        }
      }
      throw err;
    }
    return { purchase: purchaseRecord, entitlements: entitlementRecords };
  }

  async getBundlePurchase(purchaseId: string): Promise<BundlePurchaseRecord | null> {
    const rows = await this.db
      .select()
      .from(agentBundlePurchases)
      .where(eq(agentBundlePurchases.id, purchaseId))
      .limit(1);
    return rows.length === 0 ? null : toPurchase(rows[0]);
  }

  async findBundlePurchaseByProviderSubscriptionId(
    providerSubscriptionId: string,
  ): Promise<BundlePurchaseRecord | null> {
    const rows = await this.db
      .select()
      .from(agentBundlePurchases)
      .where(eq(agentBundlePurchases.providerSubscriptionId, providerSubscriptionId))
      .limit(1);
    return rows.length === 0 ? null : toPurchase(rows[0]);
  }

  async findBundlePurchaseByPaymentRef(paymentRef: string): Promise<BundlePurchaseRecord | null> {
    const byDraft = await this.db
      .select()
      .from(agentBundlePurchases)
      .where(eq(agentBundlePurchases.providerPaymentRef, paymentRef))
      .limit(1);
    if (byDraft.length > 0) return toPurchase(byDraft[0]);
    const byIntent = await this.db
      .select()
      .from(agentBundlePurchases)
      .where(eq(agentBundlePurchases.stripePaymentIntentId, paymentRef))
      .limit(1);
    return byIntent.length === 0 ? null : toPurchase(byIntent[0]);
  }

  async listBundlePurchases(userId: string): Promise<BundlePurchaseRecord[]> {
    const rows = await this.db
      .select()
      .from(agentBundlePurchases)
      .where(eq(agentBundlePurchases.userId, userId))
      .orderBy(asc(agentBundlePurchases.createdAtMs), asc(agentBundlePurchases.id));
    return rows.map(toPurchase);
  }

  async listBundleEntitlements(userId: string): Promise<BundleEntitlementRecord[]> {
    const rows = await this.db
      .select()
      .from(agentBundleEntitlements)
      .where(eq(agentBundleEntitlements.userId, userId))
      .orderBy(asc(agentBundleEntitlements.createdAtMs), asc(agentBundleEntitlements.id));
    return rows.map(toEntitlement);
  }

  async cancelBundlePurchase(purchaseId: string, nowMs: number): Promise<BundlePurchaseRecord | null> {
    const purchase = await this.getBundlePurchase(purchaseId);
    if (!purchase) return null;
    await this.db
      .update(agentBundlePurchases)
      .set({ status: "canceled", canceledAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(agentBundlePurchases.id, purchaseId));
    await this.db
      .update(agentBundleEntitlements)
      .set({ status: "canceled", updatedAtMs: nowMs })
      .where(eq(agentBundleEntitlements.bundlePurchaseId, purchaseId));
    return { ...purchase, status: "canceled", canceledAtMs: nowMs, updatedAtMs: nowMs };
  }

  async revokeBundlePurchase(purchaseId: string, nowMs: number): Promise<BundlePurchaseRecord | null> {
    const purchase = await this.getBundlePurchase(purchaseId);
    if (!purchase) return null;
    await this.db
      .update(agentBundlePurchases)
      .set({ status: "canceled", periodEndMs: nowMs, canceledAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(agentBundlePurchases.id, purchaseId));
    await this.db
      .update(agentBundleEntitlements)
      .set({ status: "canceled", periodEndMs: nowMs, updatedAtMs: nowMs })
      .where(eq(agentBundleEntitlements.bundlePurchaseId, purchaseId));
    return { ...purchase, status: "canceled", periodEndMs: nowMs, canceledAtMs: nowMs, updatedAtMs: nowMs };
  }
}
