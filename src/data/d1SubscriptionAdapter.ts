/**
 * Issues #2020/#2127 — Drizzle D1 adapter for the subscription
 * store port. This module is the ONLY place subscription-store
 * code touches a store client: all SQL-adjacent code (the Drizzle
 * query builder) lives here, behind the port interface.
 *
 * Transactions: every operation is a single statement, which is
 * atomic on any store. No multi-statement transaction is used
 * here, for the reason recorded in migrationRunner.ts
 * (drizzle-orm/d1's `db.transaction()` is sequential
 * BEGIN/COMMIT, not Postgres-equivalent atomicity on D1). The
 * payment-reference uniqueness is a single UNIQUE index: the
 * loser of a race gets a UNIQUE violation and re-checks, never a
 * double activation.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq, gt } from "drizzle-orm";
import { agentSubscriptionPlans, agentSubscriptions } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS,
  MIGRATION_0014_BILLING,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertPlan,
  assertSubscriptionStatus,
  type ProviderBillingPatch,
  type SubscriptionPlanRecord,
  type SubscriptionRecord,
  type SubscriptionStore,
} from "./subscriptionPorts";

/** Drizzle D1 database object carrying the subscription schema. */
export type SubscriptionDb = DrizzleD1Database<{
  agentSubscriptions: typeof agentSubscriptions;
  agentSubscriptionPlans: typeof agentSubscriptionPlans;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1SubscriptionDb(d1: D1Database): SubscriptionDb {
  return drizzle(d1, {
    schema: {
      agentSubscriptions,
      agentSubscriptionPlans,
    },
  });
}

/** Idempotent schema-ensure: applies migrations 0008 + 0013 + 0014 if unapplied (0013 adds the native Stripe id columns; 0014 adds the Billing provider columns + policy table). */
export async function ensureSubscriptionSchema(db: SubscriptionDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0008_SUBSCRIPTIONS, MIGRATION_0013_SUBSCRIPTION_STRIPE_IDS, MIGRATION_0014_BILLING]);
}

function toPlan(raw: typeof agentSubscriptionPlans.$inferSelect): SubscriptionPlanRecord {
  return {
    id: raw.id,
    name: raw.name,
    priceUSD: raw.priceUSD,
    periodDays: raw.periodDays,
    includedRuns: raw.includedRuns,
    active: raw.active === 1,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toSubscription(raw: typeof agentSubscriptions.$inferSelect): SubscriptionRecord {
  return {
    id: raw.id,
    userId: raw.userId,
    tenantId: raw.tenantId,
    planId: raw.planId,
    provider: raw.provider,
    providerPaymentRef: raw.providerPaymentRef,
    stripeSessionId: raw.stripeSessionId ?? null,
    stripePaymentIntentId: raw.stripePaymentIntentId ?? null,
    providerSubscriptionId: raw.providerSubscriptionId ?? null,
    providerStatus: raw.providerStatus ?? null,
    status: assertSubscriptionStatus(raw.status),
    periodStartMs: raw.periodStartMs,
    periodEndMs: raw.periodEndMs,
    canceledAtMs: raw.canceledAtMs,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Subscription store over D1 via Drizzle. */
export class D1SubscriptionAdapter implements SubscriptionStore {
  constructor(readonly db: SubscriptionDb) {}

  async createPlan(input: {
    id?: unknown;
    name?: unknown;
    priceUSD?: unknown;
    periodDays?: unknown;
    includedRuns?: unknown;
  }): Promise<SubscriptionPlanRecord> {
    const plan = assertPlan(input);
    const id = plan.id || `plan-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const record: SubscriptionPlanRecord = { ...plan, id, active: true, createdAtMs: now, updatedAtMs: now };
    try {
      await this.db.insert(agentSubscriptionPlans).values({
        id: record.id,
        name: record.name,
        priceUSD: record.priceUSD,
        periodDays: record.periodDays,
        includedRuns: record.includedRuns,
        active: 1,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
      });
    } catch {
      const existing = await this.getPlan(id);
      if (existing) throw new Error(`Plan ${id} already exists.`);
      throw new Error(`Failed to create plan ${id}.`);
    }
    return record;
  }

  async getPlan(planId: string): Promise<SubscriptionPlanRecord | null> {
    const rows = await this.db
      .select()
      .from(agentSubscriptionPlans)
      .where(eq(agentSubscriptionPlans.id, planId))
      .limit(1);
    return rows.length === 0 ? null : toPlan(rows[0]);
  }

  async listPlans(activeOnly: boolean): Promise<SubscriptionPlanRecord[]> {
    const rows = activeOnly
      ? await this.db
          .select()
          .from(agentSubscriptionPlans)
          .where(eq(agentSubscriptionPlans.active, 1))
          .orderBy(asc(agentSubscriptionPlans.createdAtMs), asc(agentSubscriptionPlans.id))
      : await this.db
          .select()
          .from(agentSubscriptionPlans)
          .orderBy(asc(agentSubscriptionPlans.createdAtMs), asc(agentSubscriptionPlans.id));
    return rows.map(toPlan);
  }

  async deactivatePlan(planId: string): Promise<SubscriptionPlanRecord> {
    const plan = await this.getPlan(planId);
    if (!plan) throw new Error(`No plan ${planId}.`);
    await this.db
      .update(agentSubscriptionPlans)
      .set({ active: 0, updatedAtMs: Date.now() })
      .where(eq(agentSubscriptionPlans.id, planId));
    return { ...plan, active: false, updatedAtMs: Date.now() };
  }

  async createSubscription(input: {
    id: string;
    userId: string;
    tenantId: string;
    planId: string;
    provider: string;
    providerPaymentRef: string;
    stripeSessionId?: string | null;
    stripePaymentIntentId?: string | null;
    providerSubscriptionId?: string | null;
    providerStatus?: string | null;
    periodStartMs: number;
    periodEndMs: number;
  }): Promise<SubscriptionRecord> {
    if (!input.id || !input.userId || !input.tenantId || !input.planId || !input.provider || !input.providerPaymentRef) {
      throw new Error("id, userId, tenantId, planId, provider, and providerPaymentRef are required.");
    }
    if (!(input.periodEndMs > input.periodStartMs)) {
      throw new Error("periodEndMs must be after periodStartMs.");
    }
    const now = Date.now();
    const record: SubscriptionRecord = {
      ...input,
      stripeSessionId: input.stripeSessionId ?? null,
      stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      providerSubscriptionId: input.providerSubscriptionId ?? null,
      providerStatus: input.providerStatus ?? null,
      status: "active",
      canceledAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    try {
      await this.db.insert(agentSubscriptions).values({
        id: record.id,
        userId: record.userId,
        tenantId: record.tenantId,
        planId: record.planId,
        provider: record.provider,
        providerPaymentRef: record.providerPaymentRef,
        stripeSessionId: record.stripeSessionId,
        stripePaymentIntentId: record.stripePaymentIntentId,
        providerSubscriptionId: record.providerSubscriptionId,
        providerStatus: record.providerStatus,
        status: record.status,
        periodStartMs: record.periodStartMs,
        periodEndMs: record.periodEndMs,
        canceledAtMs: record.canceledAtMs,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
      });
    } catch {
      const existing = await this.findByPaymentRef(input.providerPaymentRef);
      if (existing) throw new Error(`Payment reference ${input.providerPaymentRef} already activated subscription ${existing.id}.`);
      throw new Error(`Failed to create subscription ${input.id}.`);
    }
    return record;
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionRecord | null> {
    const rows = await this.db
      .select()
      .from(agentSubscriptions)
      .where(eq(agentSubscriptions.id, subscriptionId))
      .limit(1);
    return rows.length === 0 ? null : toSubscription(rows[0]);
  }

  async listSubscriptions(userId: string): Promise<SubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(agentSubscriptions)
      .where(eq(agentSubscriptions.userId, userId))
      .orderBy(asc(agentSubscriptions.createdAtMs), asc(agentSubscriptions.id));
    return rows.map(toSubscription);
  }

  async findByProviderSubscriptionId(providerSubscriptionId: string): Promise<SubscriptionRecord | null> {
    if (!providerSubscriptionId) return null;
    const rows = await this.db
      .select()
      .from(agentSubscriptions)
      .where(eq(agentSubscriptions.providerSubscriptionId, providerSubscriptionId))
      .limit(1);
    return rows.length === 0 ? null : toSubscription(rows[0]);
  }

  async updateProviderBilling(subscriptionId: string, patch: ProviderBillingPatch): Promise<SubscriptionRecord> {
    const existing = await this.getSubscription(subscriptionId);
    if (!existing) throw new Error(`No subscription ${subscriptionId}.`);
    const now = Date.now();
    const set: Record<string, unknown> = { updatedAtMs: now };
    if (patch.providerSubscriptionId !== undefined) set.providerSubscriptionId = patch.providerSubscriptionId;
    if (patch.providerStatus !== undefined) set.providerStatus = patch.providerStatus;
    if (patch.periodStartMs !== undefined) set.periodStartMs = patch.periodStartMs;
    if (patch.periodEndMs !== undefined) set.periodEndMs = patch.periodEndMs;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.canceledAtMs !== undefined) set.canceledAtMs = patch.canceledAtMs;
    await this.db
      .update(agentSubscriptions)
      .set(set as never)
      .where(eq(agentSubscriptions.id, subscriptionId));
    const updated = await this.getSubscription(subscriptionId);
    if (!updated) throw new Error(`No subscription ${subscriptionId}.`);
    return updated;
  }

  async findByPaymentRef(providerPaymentRef: string): Promise<SubscriptionRecord | null> {
    const rows = await this.db
      .select()
      .from(agentSubscriptions)
      .where(eq(agentSubscriptions.providerPaymentRef, providerPaymentRef))
      .limit(1);
    return rows.length === 0 ? null : toSubscription(rows[0]);
  }

  async revokeSubscription(subscriptionId: string, nowMs: number): Promise<SubscriptionRecord | null> {
    const rows = await this.db
      .select()
      .from(agentSubscriptions)
      .where(eq(agentSubscriptions.id, subscriptionId))
      .limit(1);
    if (rows.length === 0) return null;
    await this.db
      .update(agentSubscriptions)
      .set({ status: "canceled", canceledAtMs: nowMs, periodEndMs: nowMs, updatedAtMs: nowMs })
      .where(eq(agentSubscriptions.id, subscriptionId));
    return { ...toSubscription(rows[0]), status: "canceled", canceledAtMs: nowMs, periodEndMs: nowMs, updatedAtMs: nowMs };
  }

  async cancelUnexpiredSubscriptions(userId: string, nowMs: number): Promise<SubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(agentSubscriptions)
      .where(
        and(
          eq(agentSubscriptions.userId, userId),
          eq(agentSubscriptions.status, "active"),
          gt(agentSubscriptions.periodEndMs, nowMs),
        ),
      )
      .orderBy(asc(agentSubscriptions.createdAtMs), asc(agentSubscriptions.id));
    if (rows.length === 0) return [];
    await this.db
      .update(agentSubscriptions)
      .set({ status: "canceled", canceledAtMs: nowMs, updatedAtMs: nowMs })
      .where(
        and(
          eq(agentSubscriptions.userId, userId),
          eq(agentSubscriptions.status, "active"),
          gt(agentSubscriptions.periodEndMs, nowMs),
        ),
      );
    return rows.map((r) => ({ ...toSubscription(r), status: "canceled" as const, canceledAtMs: nowMs, updatedAtMs: nowMs }));
  }

  async cancelSubscription(subscriptionId: string, nowMs: number): Promise<SubscriptionRecord | null> {
    const rows = await this.db
      .select()
      .from(agentSubscriptions)
      .where(eq(agentSubscriptions.id, subscriptionId))
      .limit(1);
    if (rows.length === 0) return null;
    await this.db
      .update(agentSubscriptions)
      .set({ status: "canceled", canceledAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(agentSubscriptions.id, subscriptionId));
    return { ...toSubscription(rows[0]), status: "canceled" as const, canceledAtMs: nowMs, updatedAtMs: nowMs };
  }
}
