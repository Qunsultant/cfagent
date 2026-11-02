/**
 * Issue #2204 (sub-issue of #2012) — in-memory refund adapters.
 *
 * Test doubles with the same port semantics as the D1 adapters.
 * They are NOT production stores and NOT a second source of truth
 * — they exist so the port contract is testable without any store
 * at all, and so service tests can run without a D1 binding. No
 * migration concept applies here (there is no SQL to migrate).
 */
import {
  assertRefundPolicy,
  assertRefundPolicyPatch,
  assertRefundRecord,
  PROPOSED_SEED_POLICY,
  type RefundPolicy,
  type RefundPolicyStore,
  type RefundRecord,
  type RefundStore,
} from "./refundPorts";

/**
 * Policy store over a single in-memory row. By default the row is
 * seeded with the proposed defaults (mirroring ensure on D1);
 * pass null for an empty store (fail-closed read test).
 */
export class InMemoryRefundPolicyAdapter implements RefundPolicyStore {
  private policy: RefundPolicy | null;

  constructor(seed: Omit<RefundPolicy, "updatedAtMs"> | null | undefined = PROPOSED_SEED_POLICY) {
    this.policy = seed === null ? null : { ...assertRefundPolicy(seed), updatedAtMs: Date.now() };
  }

  async getPolicy(): Promise<RefundPolicy | null> {
    return this.policy === null ? null : { ...this.policy };
  }

  async setPolicy(patch: Record<string, unknown>): Promise<RefundPolicy> {
    if (!this.policy) throw new Error("Refund policy is not configured: run the refund schema ensure first.");
    const validated = assertRefundPolicyPatch(patch, this.policy);
    // Issue #2662 (#2547 rule): a value edit resets approval.
    this.policy = {
      ...validated,
      approvedKinds: [],
      approvedBy: null,
      approvedAtMs: null,
      updatedAtMs: Date.now(),
    };
    return { ...this.policy };
  }

  async setKindApproval(kind: RefundPolicy["approvedKinds"][number], approved: boolean, byLogin: string): Promise<RefundPolicy> {
    if (!this.policy) throw new Error("Refund policy is not configured: run the refund schema ensure first.");
    if (kind !== "subscription" && kind !== "pay_per_run") {
      throw new Error(`Invalid refund kind: ${String(kind)} (must be subscription or pay_per_run).`);
    }
    if (typeof byLogin !== "string" || !byLogin.trim()) {
      throw new Error("byLogin is required.");
    }
    const kinds = new Set(this.policy.approvedKinds);
    if (approved) kinds.add(kind);
    else kinds.delete(kind);
    const approvedKinds = [...kinds];
    this.policy = {
      ...this.policy,
      approvedKinds,
      approvedBy: approvedKinds.length > 0 ? byLogin.trim() : null,
      approvedAtMs: approvedKinds.length > 0 ? Date.now() : null,
      updatedAtMs: Date.now(),
    };
    return { ...this.policy };
  }
}

/** Refund records over an in-memory map, oldest-first list order. */
export class InMemoryRefundAdapter implements RefundStore {
  private refunds = new Map<string, RefundRecord>();

  async createRefund(
    input: Parameters<RefundStore["createRefund"]>[0],
  ): Promise<RefundRecord> {
    const validated = assertRefundRecord(input);
    if (this.refunds.has(validated.id)) throw new Error(`Refund ${validated.id} already exists.`);
    const record: RefundRecord = { ...validated, createdAtMs: input.createdAtMs, updatedAtMs: input.updatedAtMs };
    this.refunds.set(record.id, record);
    return { ...record };
  }

  async getRefund(refundId: string): Promise<RefundRecord | null> {
    const record = this.refunds.get(refundId);
    return record ? { ...record } : null;
  }

  async listRefunds(userId: string): Promise<RefundRecord[]> {
    return [...this.refunds.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({ ...r }));
  }

  async updateRefund(
    refundId: string,
    patch: Partial<RefundRecord> & { updatedAtMs: number },
  ): Promise<RefundRecord> {
    const current = this.refunds.get(refundId);
    if (!current) throw new Error(`No refund ${refundId}.`);
    const merged = { ...current, ...patch, id: current.id };
    const validated = assertRefundRecord(merged);
    const updated: RefundRecord = { ...validated, createdAtMs: current.createdAtMs, updatedAtMs: patch.updatedAtMs };
    this.refunds.set(refundId, updated);
    return { ...updated };
  }
}
