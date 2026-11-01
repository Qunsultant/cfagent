/**
 * Issues #2020/#2127 — in-memory subscription store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any store
 * at all, and so route tests can run without a D1 binding. No
 * migration concept applies here (there is no SQL to migrate).
 */
import {
  assertPlan,
  type ProviderBillingPatch,
  type SubscriptionPlanRecord,
  type SubscriptionRecord,
  type SubscriptionStore,
} from "./subscriptionPorts";

export class InMemorySubscriptionAdapter implements SubscriptionStore {
  private plans = new Map<string, SubscriptionPlanRecord>();
  private subscriptions = new Map<string, SubscriptionRecord>();

  async createPlan(input: {
    id?: unknown;
    name?: unknown;
    priceUSD?: unknown;
    periodDays?: unknown;
    includedRuns?: unknown;
  }): Promise<SubscriptionPlanRecord> {
    const plan = assertPlan(input);
    const id = plan.id || `plan-${crypto.randomUUID().slice(0, 8)}`;
    if (this.plans.has(id)) throw new Error(`Plan ${id} already exists.`);
    const now = Date.now();
    const record: SubscriptionPlanRecord = { ...plan, id, active: true, createdAtMs: now, updatedAtMs: now };
    this.plans.set(id, record);
    return record;
  }

  async getPlan(planId: string): Promise<SubscriptionPlanRecord | null> {
    return this.plans.get(planId) ?? null;
  }

  async listPlans(activeOnly: boolean): Promise<SubscriptionPlanRecord[]> {
    const rows = [...this.plans.values()]
      .filter((p) => !activeOnly || p.active)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  async deactivatePlan(planId: string): Promise<SubscriptionPlanRecord> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`No plan ${planId}.`);
    const updated = { ...plan, active: false, updatedAtMs: Date.now() };
    this.plans.set(planId, updated);
    return updated;
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
    const existing = await this.findByPaymentRef(input.providerPaymentRef);
    if (existing) throw new Error(`Payment reference ${input.providerPaymentRef} already activated subscription ${existing.id}.`);
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
    this.subscriptions.set(record.id, record);
    return record;
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionRecord | null> {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  async listSubscriptions(userId: string): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()]
      .filter((s) => s.userId === userId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async findByProviderSubscriptionId(providerSubscriptionId: string): Promise<SubscriptionRecord | null> {
    if (!providerSubscriptionId) return null;
    for (const s of this.subscriptions.values()) {
      if (s.providerSubscriptionId === providerSubscriptionId) return s;
    }
    return null;
  }

  async updateProviderBilling(subscriptionId: string, patch: ProviderBillingPatch): Promise<SubscriptionRecord> {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) throw new Error(`No subscription ${subscriptionId}.`);
    const updated: SubscriptionRecord = { ...existing, ...patch, updatedAtMs: Date.now() };
    this.subscriptions.set(subscriptionId, updated);
    return updated;
  }

  async findByPaymentRef(providerPaymentRef: string): Promise<SubscriptionRecord | null> {
    for (const s of this.subscriptions.values()) {
      if (s.providerPaymentRef === providerPaymentRef) return s;
    }
    return null;
  }

  async revokeSubscription(subscriptionId: string, nowMs: number): Promise<SubscriptionRecord | null> {
    const record = this.subscriptions.get(subscriptionId);
    if (!record) return null;
    const updated = { ...record, status: "canceled" as const, canceledAtMs: nowMs, periodEndMs: nowMs, updatedAtMs: nowMs };
    this.subscriptions.set(subscriptionId, updated);
    return { ...updated };
  }

  async cancelUnexpiredSubscriptions(userId: string, nowMs: number): Promise<SubscriptionRecord[]> {
    const canceled: SubscriptionRecord[] = [];
    for (const s of this.subscriptions.values()) {
      if (s.userId === userId && s.status === "active" && s.periodEndMs > nowMs) {
        const updated = { ...s, status: "canceled" as const, canceledAtMs: nowMs, updatedAtMs: nowMs };
        this.subscriptions.set(s.id, updated);
        canceled.push(updated);
      }
    }
    canceled.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return canceled;
  }

  async cancelSubscription(subscriptionId: string, nowMs: number): Promise<SubscriptionRecord | null> {
    const s = this.subscriptions.get(subscriptionId);
    if (!s) return null;
    const updated = { ...s, status: "canceled" as const, canceledAtMs: nowMs, updatedAtMs: nowMs };
    this.subscriptions.set(subscriptionId, updated);
    return { ...updated };
  }
}
