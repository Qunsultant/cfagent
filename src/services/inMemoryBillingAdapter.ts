/**
 * Issue #2202 — in-memory Billing adapter (test double /
 * portability proof, never a production fallback).
 *
 * Same port semantics as the Stripe adapter, with no
 * provider: created subscriptions start "active" with a
 * 30-day period, cancel-at-period-end flips the flag
 * without ending the period, and immediate cancel ends
 * it at the call instant. Tests drive state transitions
 * through this adapter without any network.
 */
import type {
  BillingPort,
  CreateProviderSubscriptionInput,
  ProviderSubscription,
} from "./billingPorts";

const MS_PER_DAY = 86_400_000;

export class InMemoryBillingAdapter implements BillingPort {
  private subs = new Map<string, ProviderSubscription>();
  private counter = 0;
  private nowMs: () => number;

  constructor(nowMs?: () => number) {
    this.nowMs = nowMs ?? (() => Date.now());
  }

  async createProviderSubscription(input: CreateProviderSubscriptionInput): Promise<ProviderSubscription> {
    if (!input.customerId?.trim()) throw new Error("customerId is required.");
    if (!input.priceId?.trim()) throw new Error("priceId is required.");
    const now = this.nowMs();
    const record: ProviderSubscription = {
      providerSubscriptionId: `sub_test_${++this.counter}`,
      status: "active",
      currentPeriodStartMs: now,
      currentPeriodEndMs: now + 30 * MS_PER_DAY,
      cancelAtPeriodEnd: false,
      canceledAtMs: null,
      customerId: input.customerId,
      priceId: input.priceId,
    };
    this.subs.set(record.providerSubscriptionId, record);
    return { ...record };
  }

  async retrieveProviderSubscription(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const found = this.subs.get(providerSubscriptionId);
    if (!found) throw new Error(`No provider subscription ${providerSubscriptionId}.`);
    return { ...found };
  }

  async cancelProviderAtPeriodEnd(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const found = await this.retrieveProviderSubscription(providerSubscriptionId);
    const updated: ProviderSubscription = { ...found, cancelAtPeriodEnd: true };
    this.subs.set(providerSubscriptionId, updated);
    return { ...updated };
  }

  async cancelProviderImmediately(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const found = await this.retrieveProviderSubscription(providerSubscriptionId);
    const now = this.nowMs();
    const updated: ProviderSubscription = {
      ...found,
      status: "canceled",
      cancelAtPeriodEnd: false,
      canceledAtMs: now,
      currentPeriodEndMs: now,
    };
    this.subs.set(providerSubscriptionId, updated);
    return { ...updated };
  }

  async updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    priceId: string,
    _prorationBehavior: import("../data/billingPolicyPorts").ProrationBehavior,
  ): Promise<ProviderSubscription> {
    const found = await this.retrieveProviderSubscription(providerSubscriptionId);
    if (found.status === "canceled") {
      throw new Error(`Provider subscription ${providerSubscriptionId} is canceled and cannot change price.`);
    }
    if (!priceId?.trim()) throw new Error("priceId is required.");
    const updated: ProviderSubscription = { ...found, priceId };
    this.subs.set(providerSubscriptionId, updated);
    return { ...updated };
  }

  /** Test-only: force a provider state (e.g. past_due) to drive webhook/transition tests. */
  setProviderState(providerSubscriptionId: string, patch: Partial<ProviderSubscription>): ProviderSubscription {
    const found = this.subs.get(providerSubscriptionId);
    if (!found) throw new Error(`No provider subscription ${providerSubscriptionId}.`);
    const updated = { ...found, ...patch };
    this.subs.set(providerSubscriptionId, updated);
    return { ...updated };
  }
}
