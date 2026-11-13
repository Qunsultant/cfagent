// @vitest-environment node
/**
 * Issue #2662 (monetization Phase 2.7, #2405) — cancellation/refunds per
 * owner-decided policies. TDD: this file is written FIRST and fails until
 * the slice lands.
 *
 * The missing layer (verified against main before scoping):
 * - Refund routes + policy store exist (#2204), but request AND execute
 *   succeed under the PROPOSED seed policy with zero owner approval —
 *   which #2662 scope item 2 forbids ("a seeded PROPOSED value is never
 *   an approval"). This slice adds per-kind owner approval, fail-closed.
 * - cancelBillingImmediately exists in the Billing service but NO route
 *   calls it; the cancel route never reads downgradeTiming. This slice
 *   wires immediate cancel to the operator downgrade-timing policy.
 * - No provider subscription UPDATE path exists, so prorationBehavior is
 *   decorative policy nothing reads. This slice adds the operator-only
 *   plan-change route that sends the policy prorationBehavior to Stripe.
 * - Deactivation interaction (2.5 gate): canceled rows do not block;
 *   active unexpired rows do. Pinned here, no gate code change.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createD1RefundDb,
  D1RefundAdapter,
  D1RefundPolicyAdapter,
  ensureRefundSchema,
} from "../src/data/d1RefundAdapter";
import {
  InMemoryRefundAdapter,
  InMemoryRefundPolicyAdapter,
} from "../src/data/inMemoryRefundAdapter";
import {
  PROPOSED_SEED_POLICY,
  type RefundPaymentSourceResolver,
  type RefundPolicyStore,
  type RefundStore,
} from "../src/data/refundPorts";
import {
  decideRefund,
  executeRefund,
  requestRefund,
} from "../src/services/refundService";
import { hasUnexpiredSubscription } from "../src/data/subscriptionPorts";

/** Minimal D1Database stand-in over node:sqlite (mirrors slice 2.1). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function seededPolicies(): Promise<
  Array<{ name: string; policy: RefundPolicyStore; store: RefundStore }>
> {
  const mock = new MockD1Database();
  const db = createD1RefundDb(mock as unknown as D1Database);
  await ensureRefundSchema(db);
  return [
    {
      name: "in-memory",
      policy: new InMemoryRefundPolicyAdapter(),
      store: new InMemoryRefundAdapter(),
    },
    {
      name: "drizzle",
      policy: new D1RefundPolicyAdapter(db),
      store: new D1RefundAdapter(db),
    },
  ];
}

function gatewayStub() {
  const calls: any[] = [];
  return {
    calls,
    gateway: {
      executeRefund: async (params: any) => {
        calls.push(params);
        return { success: true, refundId: "re_2662_1", amountRefunded: params.amount, message: "ok" };
      },
    },
  };
}

describe("refund policy approval (2.7, per kind, fail-closed)", () => {
  it("seeds unapproved: no kind is approved on a fresh policy", async () => {
    for (const { policy } of await seededPolicies()) {
      const got = await policy.getPolicy();
      expect(got).toMatchObject({ ...PROPOSED_SEED_POLICY });
      expect(got?.approvedKinds).toEqual([]);
      expect(got?.approvedBy).toBeNull();
      expect(got?.approvedAtMs).toBeNull();
    }
  });

  it("approve route semantics at the store: setKindApproval toggles one kind only", async () => {
    for (const { policy } of await seededPolicies()) {
      const approved = await policy.setKindApproval("subscription", true, "op1");
      expect(approved.approvedKinds).toEqual(["subscription"]);
      expect(approved.approvedBy).toBe("op1");
      expect(approved.approvedAtMs).toBeGreaterThan(0);
      const afterPayPerRun = await policy.setKindApproval("pay_per_run", true, "op1");
      expect([...afterPayPerRun.approvedKinds].sort()).toEqual(["pay_per_run", "subscription"]);
      const withdrawn = await policy.setKindApproval("subscription", false, "op1");
      expect(withdrawn.approvedKinds).toEqual(["pay_per_run"]);
      await expect(policy.setKindApproval("bogus" as any, true, "op1")).rejects.toThrow();
    }
  });

  it("an operator value edit RESETS approval (never silently-still-approved, #2547 rule)", async () => {
    for (const { policy } of await seededPolicies()) {
      await policy.setKindApproval("subscription", true, "op1");
      const edited = await policy.setPolicy({ windowDays: 14 });
      expect(edited.windowDays).toBe(14);
      expect(edited.approvedKinds).toEqual([]);
      expect(edited.approvedBy).toBeNull();
      expect(edited.approvedAtMs).toBeNull();
    }
  });

  it("approval can never be smuggled through setPolicy (unknown-field rule)", async () => {
    for (const { policy } of await seededPolicies()) {
      await expect(policy.setPolicy({ approvedKinds: ["subscription"] })).rejects.toThrow(/Unknown refund policy field/);
      await expect(policy.setPolicy({ approvedBy: "op1" })).rejects.toThrow(/Unknown refund policy field/);
    }
  });
});

describe("refund service approval gate (2.7)", () => {
  // Issue #3180: a stub resolved payment source — the tenant comes
  // from the source, never from request input.
  const stubSource: RefundPaymentSourceResolver = {
    resolve: async () => ({
      paymentIntentId: null,
      rail: "card",
      originalAmountUSD: null,
      originalPaidAtMs: null,
      userId: "u1",
      tenantId: "t1",
      subscriptionId: null,
    }),
  };

  it("request refuses an unapproved kind before any record is created", async () => {
    for (const { policy, store } of await seededPolicies()) {
      await expect(
        requestRefund(
          { policyStore: policy, refundStore: store },
          {
            kind: "pay_per_run",
            originalPaymentRef: "run-1",
            amountUSD: 0.1,
            originalAmountUSD: 0.1,
            originalPaidAtMs: Date.now() - 1000,
            rail: "card",
            reason: "run failed",
            requesterLogin: "u1",
            isOperator: false,
          },
        ),
      ).rejects.toThrow(/not owner-approved/);
      expect((await store.listRefunds("u1")).length).toBe(0);
    }
  });

  it("request succeeds once the kind is approved, and execute re-checks approval", async () => {
    for (const { policy, store } of await seededPolicies()) {
      await policy.setKindApproval("pay_per_run", true, "op1");
      const gateway = gatewayStub();
      const record = await requestRefund(
        { policyStore: policy, refundStore: store, sourceResolver: stubSource },
        {
          kind: "pay_per_run",
          originalPaymentRef: "run-1",
          amountUSD: 0.1,
          originalAmountUSD: 0.1,
          originalPaidAtMs: Date.now() - 1000,
          rail: "card",
          reason: "run failed",
          requesterLogin: "u1",
          isOperator: false,
        },
      );
      expect(record.status).toBe("requested");
      await decideRefund(
        { refundStore: store },
        { refundId: record.id, decision: "approve", approverLogin: "op1" },
      );
      // Approval withdrawn between approve and execute: execution refuses,
      // and the gateway is never called (policy change cannot widen a refund).
      await policy.setKindApproval("pay_per_run", false, "op1");
      await expect(
        executeRefund(
          {
            policyStore: policy,
            refundStore: store,
            gateway: gateway.gateway,
            monetizationEnabled: true,
          },
          { refundId: record.id },
        ),
      ).rejects.toThrow(/not owner-approved/);
      expect(gateway.calls.length).toBe(0);
    }
  });
});

describe("deactivation interaction (2.5 gate, pinned, no code change)", () => {
  it("a canceled row does not block deactivation; an active unexpired row does", () => {
    const now = Date.now();
    expect(hasUnexpiredSubscription([{ status: "canceled", periodEndMs: now + 1000 }], now)).toBe(false);
    expect(hasUnexpiredSubscription([{ status: "active", periodEndMs: now + 1000 }], now)).toBe(true);
    expect(hasUnexpiredSubscription([{ status: "active", periodEndMs: now - 1000 }], now)).toBe(false);
  });
});
