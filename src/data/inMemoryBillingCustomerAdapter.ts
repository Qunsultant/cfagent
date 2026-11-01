/**
 * Issue #2656 (Phase 2.1, #2405) — in-memory Billing customer
 * mapping store (test double with the same port semantics as
 * the D1 adapter). It is NOT a production store: it exists so
 * the mapping contract is testable without any store at all.
 * First-wins, exactly like the D1 adapter: a different
 * customer id for a user that already has one throws.
 */
import type {
  BillingCustomerRecord,
  BillingCustomerStore,
} from "./billingCustomerPorts";

export class InMemoryBillingCustomerAdapter implements BillingCustomerStore {
  private readonly byUser = new Map<string, BillingCustomerRecord>();

  async getCustomer(userId: string): Promise<BillingCustomerRecord | null> {
    return this.byUser.get(userId) ?? null;
  }

  async recordCustomer(input: {
    userId: string;
    tenantId: string;
    stripeCustomerId: string;
  }): Promise<BillingCustomerRecord> {
    if (!input.userId || !input.tenantId || !input.stripeCustomerId) {
      throw new Error("userId, tenantId, and stripeCustomerId are required to record a Billing customer.");
    }
    const existing = this.byUser.get(input.userId);
    if (existing) {
      if (existing.stripeCustomerId !== input.stripeCustomerId) {
        throw new Error(
          `Billing customer mismatch for user ${input.userId}: mapped to ${existing.stripeCustomerId}, refusing ${input.stripeCustomerId} (operator resolves; never a silent overwrite).`,
        );
      }
      return { ...existing };
    }
    const now = Date.now();
    const record: BillingCustomerRecord = { ...input, createdAtMs: now, updatedAtMs: now };
    this.byUser.set(input.userId, record);
    return { ...record };
  }
}
