/**
 * Issue #2204 (sub-issue of #2012) — Drizzle D1 adapter for the
 * refund port (records + externalized policy). This module is the
 * ONLY place refund code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder) lives here, behind the port
 * interfaces.
 *
 * Transactions: every operation is a single statement (one INSERT,
 * one SELECT, one UPDATE), which is atomic on any store. No
 * multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { agentRefundPolicy, agentRefunds } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0018_REFUNDS,
  MIGRATION_0036_REFUND_POLICY_APPROVAL,
  type MigrationDb,
} from "./migrationRunner";
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

/** Drizzle D1 database object carrying the refund schema. */
export type RefundDb = DrizzleD1Database<{
  agentRefundPolicy: typeof agentRefundPolicy;
  agentRefunds: typeof agentRefunds;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1RefundDb(d1: D1Database): RefundDb {
  return drizzle(d1, {
    schema: {
      agentRefundPolicy,
      agentRefunds,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migrations 0018 + 0036 if unapplied,
 * then seeds the proposed policy (INSERT OR IGNORE — re-seeding is
 * a no-op, so an operator-edited policy is never overwritten by a
 * later ensure). The seeds are PROPOSED defaults pending owner
 * approval, not an activation. Issue #2662: the seed row is
 * unapproved (approved_kinds '[]'); refunds refuse fail-closed
 * until an operator approves the kind.
 */
export async function ensureRefundSchema(db: RefundDb): Promise<number[]> {
  const applied = await applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0018_REFUNDS,
    MIGRATION_0036_REFUND_POLICY_APPROVAL,
  ]);
  const now = Date.now();
  await db
    .insert(agentRefundPolicy)
    .values(policyRow({ ...PROPOSED_SEED_POLICY, updatedAtMs: now }))
    .onConflictDoNothing();
  return applied;
}

function parseApprovedKinds(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => k === "subscription" || k === "pay_per_run") : [];
  } catch {
    return [];
  }
}

function toPolicy(raw: typeof agentRefundPolicy.$inferSelect): RefundPolicy {
  return {
    ...assertRefundPolicy({
      windowDays: raw.windowDays,
      approver: raw.approver,
      allowPartial: raw.allowPartial === 1,
      subscriptionFullEffect: raw.subscriptionFullEffect,
      subscriptionPartialEffect: raw.subscriptionPartialEffect,
      payPerRunEffect: raw.payPerRunEffect,
      creditEffect: raw.creditEffect,
      approvedKinds: parseApprovedKinds(raw.approvedKinds),
      approvedBy: raw.approvedBy,
      approvedAtMs: raw.approvedAtMs,
    }),
    updatedAtMs: raw.updatedAtMs,
  };
}

function policyRow(policy: RefundPolicy): typeof agentRefundPolicy.$inferInsert {
  return {
    id: "default",
    windowDays: policy.windowDays,
    approver: policy.approver,
    allowPartial: policy.allowPartial ? 1 : 0,
    subscriptionFullEffect: policy.subscriptionFullEffect,
    subscriptionPartialEffect: policy.subscriptionPartialEffect,
    payPerRunEffect: policy.payPerRunEffect,
    creditEffect: policy.creditEffect,
    approvedKinds: JSON.stringify(policy.approvedKinds),
    approvedBy: policy.approvedBy,
    approvedAtMs: policy.approvedAtMs,
    updatedAtMs: policy.updatedAtMs,
  };
}

/** Refund policy over D1 via Drizzle. */
export class D1RefundPolicyAdapter implements RefundPolicyStore {
  constructor(readonly db: RefundDb) {}

  async getPolicy(): Promise<RefundPolicy | null> {
    const rows = await this.db
      .select()
      .from(agentRefundPolicy)
      .where(eq(agentRefundPolicy.id, "default"))
      .limit(1);
    if (rows.length === 0) return null;
    const policy = toPolicy(rows[0]);
    return { ...policy, updatedAtMs: rows[0].updatedAtMs };
  }

  async setPolicy(patch: Record<string, unknown>): Promise<RefundPolicy> {
    const current = await this.getPolicy();
    if (!current) throw new Error("Refund policy is not configured: run the refund schema ensure first.");
    const validated = assertRefundPolicyPatch(patch, current);
    // Issue #2662 (#2547 rule): a value edit resets approval — approval
    // attaches to exact values, never survives an edit silently.
    const updated: RefundPolicy = {
      ...validated,
      approvedKinds: [],
      approvedBy: null,
      approvedAtMs: null,
      updatedAtMs: Date.now(),
    };
    await this.db
      .update(agentRefundPolicy)
      .set(policyRow(updated))
      .where(eq(agentRefundPolicy.id, "default"));
    return updated;
  }

  async setKindApproval(kind: RefundPolicy["approvedKinds"][number], approved: boolean, byLogin: string): Promise<RefundPolicy> {
    const current = await this.getPolicy();
    if (!current) throw new Error("Refund policy is not configured: run the refund schema ensure first.");
    if (kind !== "subscription" && kind !== "pay_per_run") {
      throw new Error(`Invalid refund kind: ${String(kind)} (must be subscription or pay_per_run).`);
    }
    if (typeof byLogin !== "string" || !byLogin.trim()) {
      throw new Error("byLogin is required.");
    }
    const kinds = new Set(current.approvedKinds);
    if (approved) kinds.add(kind);
    else kinds.delete(kind);
    const approvedKinds = [...kinds];
    const updated: RefundPolicy = {
      ...current,
      approvedKinds,
      approvedBy: approvedKinds.length > 0 ? byLogin.trim() : null,
      approvedAtMs: approvedKinds.length > 0 ? Date.now() : null,
      updatedAtMs: Date.now(),
    };
    await this.db
      .update(agentRefundPolicy)
      .set(policyRow(updated))
      .where(eq(agentRefundPolicy.id, "default"));
    return updated;
  }
}

function toRecord(raw: typeof agentRefunds.$inferSelect): RefundRecord {
  return {
    id: raw.id,
    kind: raw.kind as RefundRecord["kind"],
    rail: raw.rail as RefundRecord["rail"],
    tenantId: raw.tenantId,
    userId: raw.userId,
    originalPaymentRef: raw.originalPaymentRef,
    subscriptionId: raw.subscriptionId,
    paymentIntentId: raw.paymentIntentId,
    family: raw.family,
    originalAmountUSD: raw.originalAmountUSD,
    amountUSD: raw.amountUSD,
    originalPaidAtMs: raw.originalPaidAtMs,
    reason: raw.reason,
    status: raw.status as RefundRecord["status"],
    approverLogin: raw.approverLogin,
    decisionNote: raw.decisionNote,
    gatewayRefundId: raw.gatewayRefundId,
    executedAtMs: raw.executedAtMs,
    entitlementConsequence: raw.entitlementConsequence,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function recordRow(record: RefundRecord): typeof agentRefunds.$inferInsert {
  return {
    id: record.id,
    kind: record.kind,
    rail: record.rail,
    tenantId: record.tenantId,
    userId: record.userId,
    originalPaymentRef: record.originalPaymentRef,
    subscriptionId: record.subscriptionId,
    paymentIntentId: record.paymentIntentId,
    family: record.family,
    originalAmountUSD: record.originalAmountUSD,
    amountUSD: record.amountUSD,
    originalPaidAtMs: record.originalPaidAtMs,
    reason: record.reason,
    status: record.status,
    approverLogin: record.approverLogin,
    decisionNote: record.decisionNote,
    gatewayRefundId: record.gatewayRefundId,
    executedAtMs: record.executedAtMs,
    entitlementConsequence: record.entitlementConsequence,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

/** Refund records over D1 via Drizzle. */
export class D1RefundAdapter implements RefundStore {
  constructor(readonly db: RefundDb) {}

  async createRefund(
    input: Parameters<RefundStore["createRefund"]>[0],
  ): Promise<RefundRecord> {
    const validated = assertRefundRecord(input);
    const record: RefundRecord = { ...validated, createdAtMs: input.createdAtMs, updatedAtMs: input.updatedAtMs };
    await this.db.insert(agentRefunds).values(recordRow(record));
    return record;
  }

  async getRefund(refundId: string): Promise<RefundRecord | null> {
    const rows = await this.db
      .select()
      .from(agentRefunds)
      .where(eq(agentRefunds.id, refundId))
      .limit(1);
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async listRefunds(userId: string): Promise<RefundRecord[]> {
    const rows = await this.db
      .select()
      .from(agentRefunds)
      .where(eq(agentRefunds.userId, userId))
      .orderBy(asc(agentRefunds.createdAtMs), asc(agentRefunds.id));
    return rows.map(toRecord);
  }

  async updateRefund(
    refundId: string,
    patch: Partial<RefundRecord> & { updatedAtMs: number },
  ): Promise<RefundRecord> {
    const current = await this.getRefund(refundId);
    if (!current) throw new Error(`No refund ${refundId}.`);
    const merged = { ...current, ...patch, id: current.id };
    const validated = assertRefundRecord(merged);
    const updated: RefundRecord = { ...validated, createdAtMs: current.createdAtMs, updatedAtMs: patch.updatedAtMs };
    const { id: _id, createdAtMs: _created, ...set } = recordRow(updated);
    await this.db.update(agentRefunds).set(set).where(eq(agentRefunds.id, refundId));
    return updated;
  }
}
