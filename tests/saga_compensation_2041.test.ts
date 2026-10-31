/**
 * Saga mid-run failure compensation — issue #2041 S3.
 *
 * Pins (working defaults, NOT rulings — 2026-10-31 autonomous direction):
 * - Rail-aware form: refund-request ONLY for stripe + stripe_checkout;
 *   x402, covered runs, and unknown rail/paidVia all take the credit form.
 * - Stripe is REQUEST-first: the saga records a policy-gated "requested"
 *   refund and never approves or executes it (operator route unchanged).
 * - Credit fallback when a refund is unavailable: ports unbound, flag OFF,
 *   no policy, or request validation failure — each pinned separately.
 * - One compensation per paid run: refund dedupe via the existing-record
 *   pre-check; retries never create a second record.
 * - x402 never refunds: the refund deps are never even consulted.
 * - Q3 default: journey denied/expired paths never compensate (pinned in
 *   the flow test; the helper itself never runs on those paths).
 * - Missing/non-positive price fails loud (no uncompensated completion).
 * - Disclosure copy per rail, from one source (sagaCompensationDisclosure).
 * - Redemption (G-REDEEM): the saga's issued claim redeems through the
 *   REAL D1 claim store — FIFO oldest-first, atomic redeem, replay refused,
 *   re-record a no-op. The route-level behavior (redeemed run starts
 *   without payment; no burn on failed start) is pinned by the pre-existing
 *   tests/commercial_routes.test.ts; this pins the store contract the saga
 *   relies on. NOTE the corrected default: claims are a separate FIFO
 *   store consumed at paid-submission BEFORE the payment workflow — they do
 *   NOT ride the native gate's creditsUSD coverage balance.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import type {
  RefundPolicy,
  RefundPolicyStore,
  RefundRecord,
  RefundStore,
} from "../src/data/refundPorts";
import {
  compensateFailedScreen,
  sagaCompensationDisclosure,
  selectCompensationForm,
  type SagaCompensationDeps,
  type SagaCompensationInput,
  type SagaRefundPorts,
} from "../src/workflows/sagaCompensation";

const NOW = 1_800_000_000_000;

const POLICY: RefundPolicy = {
  windowDays: 30,
  approver: "operator_hitl",
  allowPartial: false,
  subscriptionFullEffect: "revoke_immediately",
  subscriptionPartialEffect: "keep_access",
  payPerRunEffect: "none",
  creditEffect: "none",
  updatedAtMs: 1,
};

function fakeRefundStore() {
  const records: RefundRecord[] = [];
  const store = {
    records,
    createRefund: vi.fn(async (input: Record<string, unknown>) => {
      const rec = { ...input } as unknown as RefundRecord;
      records.push(rec);
      return rec;
    }),
    getRefund: async (id: string) => records.find((r) => r.id === id) ?? null,
    listRefunds: async (userId: string) => records.filter((r) => r.userId === userId),
    updateRefund: async (id: string, patch: Record<string, unknown>) => {
      const rec = records.find((r) => r.id === id);
      if (!rec) throw new Error(`No refund ${id}.`);
      Object.assign(rec, patch);
      return rec;
    },
  };
  return store;
}

function fakePolicyStore(policy: RefundPolicy | null) {
  return {
    getPolicy: vi.fn(async () => policy),
    setPolicy: vi.fn(async () => {
      throw new Error("test: setPolicy unused");
    }),
  };
}

function baseInput(over: Partial<SagaCompensationInput> = {}): SagaCompensationInput {
  return {
    sagaId: "saga-1",
    runRequestId: "run-1",
    userLogin: "u1",
    tenantId: "t1",
    family: "goal",
    rail: "stripe",
    paidVia: "stripe_checkout",
    priceUSD: 0.1,
    paidAtMs: NOW - 60_000,
    reason: "screen_deadline_exceeded",
    ...over,
  };
}

function baseDeps(over: Partial<SagaCompensationDeps> = {}): {
  deps: SagaCompensationDeps;
  issueCredit: ReturnType<typeof vi.fn>;
  getRefundPorts: ReturnType<typeof vi.fn>;
  monetizationEnabled: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof fakeRefundStore>;
  policyStore: ReturnType<typeof fakePolicyStore>;
} {
  const store = fakeRefundStore();
  const policyStore = fakePolicyStore(POLICY);
  const issueCredit = vi.fn(async () => undefined);
  const ports: SagaRefundPorts = {
    store: store as unknown as RefundStore,
    policy: policyStore as unknown as RefundPolicyStore,
  };
  const getRefundPorts = vi.fn(async () => ports);
  const monetizationEnabled = vi.fn(async () => true);
  const deps: SagaCompensationDeps = {
    issueCredit,
    getRefundPorts,
    monetizationEnabled,
    nowMs: () => NOW,
    ...over,
  };
  return { deps, issueCredit, getRefundPorts, monetizationEnabled, store, policyStore };
}

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors billing_ports). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as never[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as never[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as never[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as never[]))
              .map((row: Record<string, unknown>) => Object.values(row));
          },
        };
      },
    };
  }
}

describe("compensation form selection (S3, #2041)", () => {
  it("stripe + stripe_checkout selects the refund-request form", () => {
    expect(selectCompensationForm({ rail: "stripe", paidVia: "stripe_checkout" })).toBe(
      "refund-request",
    );
  });
  it("x402 selects credit (Q9: x402 credit-only, never an outbound refund)", () => {
    expect(selectCompensationForm({ rail: "x402", paidVia: "x402" })).toBe("credit");
  });
  it("covered runs select credit even on the stripe rail (no cash was charged)", () => {
    expect(selectCompensationForm({ rail: "stripe", paidVia: "credits" })).toBe("credit");
    expect(selectCompensationForm({ rail: "stripe", paidVia: "subscription_included" })).toBe(
      "credit",
    );
    expect(selectCompensationForm({ rail: "stripe", paidVia: "already_paid" })).toBe("credit");
  });
  it("unknown rail or paidVia selects credit, never a refund promise", () => {
    expect(selectCompensationForm({ rail: undefined, paidVia: "stripe_checkout" })).toBe("credit");
    expect(selectCompensationForm({ rail: "stripe", paidVia: undefined })).toBe("credit");
    expect(selectCompensationForm({ rail: undefined, paidVia: undefined })).toBe("credit");
  });
});

describe("compensateFailedScreen (S3, #2041)", () => {
  it("stripe checkout records a policy-gated refund request and issues no credit", async () => {
    const { deps, issueCredit, store } = baseDeps();
    const out = await compensateFailedScreen(deps, baseInput());
    expect(out.form).toBe("refund-request");
    expect(out.refundId).toMatch(/^refund-/);
    expect(out.existing).toBe(false);
    expect(issueCredit).not.toHaveBeenCalled();
    expect(store.createRefund).toHaveBeenCalledTimes(1);
    const rec = store.records[0];
    expect(rec.status).toBe("requested");
    expect(rec.originalPaymentRef).toBe("run-1");
    expect(rec.amountUSD).toBe(0.1);
    expect(rec.originalAmountUSD).toBe(0.1);
    expect(rec.rail).toBe("card");
    expect(rec.approverLogin).toBeNull();
  });

  it("unbound refund ports fall back to credit (fail-closed to credit)", async () => {
    const { deps, issueCredit, store } = baseDeps({ getRefundPorts: async () => null });
    const out = await compensateFailedScreen(deps, baseInput());
    expect(out.form).toBe("credit");
    expect(out.fallbackReason).toMatch(/ports/i);
    expect(issueCredit).toHaveBeenCalledTimes(1);
    expect(issueCredit).toHaveBeenCalledWith("run-1", 0.1);
    expect(store.createRefund).not.toHaveBeenCalled();
  });

  it("monetization flag OFF falls back to credit", async () => {
    const { deps, issueCredit, store } = baseDeps({ monetizationEnabled: async () => false });
    const out = await compensateFailedScreen(deps, baseInput());
    expect(out.form).toBe("credit");
    expect(out.fallbackReason).toMatch(/flag/i);
    expect(issueCredit).toHaveBeenCalledTimes(1);
    expect(store.createRefund).not.toHaveBeenCalled();
  });

  it("missing refund policy falls back to credit", async () => {
    const store = fakeRefundStore();
    const policyStore = fakePolicyStore(null);
    const issueCredit = vi.fn(async () => undefined);
    const deps: SagaCompensationDeps = {
      issueCredit,
      getRefundPorts: async () => ({
        store: store as unknown as RefundStore,
        policy: policyStore as unknown as RefundPolicyStore,
      }),
      monetizationEnabled: async () => true,
      nowMs: () => NOW,
    };
    const out = await compensateFailedScreen(deps, baseInput());
    expect(out.form).toBe("credit");
    expect(out.fallbackReason).toMatch(/policy/i);
    expect(issueCredit).toHaveBeenCalledTimes(1);
    expect(store.createRefund).not.toHaveBeenCalled();
  });

  it("request validation failure (paidAtMs in the future) falls back to credit", async () => {
    const { deps, issueCredit, store } = baseDeps();
    const out = await compensateFailedScreen(deps, baseInput({ paidAtMs: NOW + 86_400_000 }));
    expect(out.form).toBe("credit");
    expect(out.fallbackReason).toMatch(/future/i);
    expect(issueCredit).toHaveBeenCalledTimes(1);
    expect(store.createRefund).not.toHaveBeenCalled();
  });

  it("x402 issues credit without consulting the refund deps (Q9)", async () => {
    const { deps, issueCredit, getRefundPorts, monetizationEnabled, store } = baseDeps();
    const out = await compensateFailedScreen(
      deps,
      baseInput({ rail: "x402", paidVia: "x402" }),
    );
    expect(out.form).toBe("credit");
    expect(out.creditRunId).toBe("run-1");
    expect(issueCredit).toHaveBeenCalledTimes(1);
    expect(getRefundPorts).not.toHaveBeenCalled();
    expect(monetizationEnabled).not.toHaveBeenCalled();
    expect(store.createRefund).not.toHaveBeenCalled();
  });

  it("an existing refund for the run is returned, never duplicated", async () => {
    const { deps, issueCredit, store } = baseDeps();
    store.records.push({
      id: "refund-prior",
      kind: "pay_per_run",
      rail: "card",
      tenantId: "t1",
      userId: "u1",
      originalPaymentRef: "run-1",
      subscriptionId: null,
      paymentIntentId: null,
      family: "goal",
      originalAmountUSD: 0.1,
      amountUSD: 0.1,
      originalPaidAtMs: NOW - 60_000,
      reason: "screen_deadline_exceeded",
      status: "requested",
      approverLogin: null,
      decisionNote: null,
      gatewayRefundId: null,
      executedAtMs: null,
      entitlementConsequence: null,
      createdAtMs: NOW - 60_000,
      updatedAtMs: NOW - 60_000,
    } as unknown as RefundRecord);
    const out = await compensateFailedScreen(deps, baseInput());
    expect(out.form).toBe("refund-request");
    expect(out.refundId).toBe("refund-prior");
    expect(out.existing).toBe(true);
    expect(store.createRefund).not.toHaveBeenCalled();
    expect(issueCredit).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(1);
  });

  it("retrying compensation creates exactly one refund record", async () => {
    const { deps, store } = baseDeps();
    const first = await compensateFailedScreen(deps, baseInput());
    const second = await compensateFailedScreen(deps, baseInput());
    expect(first.refundId).toBe(second.refundId);
    expect(store.createRefund).toHaveBeenCalledTimes(1);
    expect(store.records).toHaveLength(1);
  });

  it("missing price fails loud: no credit, no refund, no silent completion", async () => {
    const { deps, issueCredit, store } = baseDeps();
    await expect(compensateFailedScreen(deps, baseInput({ priceUSD: 0 }))).rejects.toThrow(
      /positive price/i,
    );
    expect(issueCredit).not.toHaveBeenCalled();
    expect(store.createRefund).not.toHaveBeenCalled();
  });
});

describe("compensation disclosure copy (G-DISCLOSURE, S3)", () => {
  it("stripe copy states refund requested first, operator approval required, credit fallback", () => {
    const copy = sagaCompensationDisclosure("stripe");
    expect(copy).toMatch(/refund/i);
    expect(copy).toMatch(/operator approval/i);
    expect(copy).toMatch(/credit/i);
    expect(copy).not.toMatch(/you would have received a provider refund first/);
  });
  it("x402 copy states credit with no refund on this rail", () => {
    const copy = sagaCompensationDisclosure("x402");
    expect(copy).toMatch(/credit/i);
    expect(copy).toMatch(/no refund on this rail/i);
  });
  it("unknown rail copy promises credit only, never a refund", () => {
    const copy = sagaCompensationDisclosure(undefined);
    expect(copy).toMatch(/credit/i);
    expect(copy).not.toMatch(/refund/i);
  });
});

describe("saga credit redemption (G-REDEEM, S3)", () => {
  it("an issued claim redeems FIFO, atomically, with replay refused and re-record a no-op", async () => {
    const mock = new MockD1Database();
    const db = createD1CommercialDb(mock as unknown as D1Database);
    await ensureCommercialSchema(db);
    const store = new D1CommercialAdapter(db);
    // The saga's issueCredit dep records exactly this claim shape.
    await store.recordCreditClaim({ creditRunId: "run-9", userId: "u1", family: "goal", amountUSD: 0.1 });
    await store.recordCreditClaim({ creditRunId: "run-10", userId: "u1", family: "goal", amountUSD: 0.1 });
    expect(await store.findUnredeemedCredit("u1", "goal")).toEqual({
      creditRunId: "run-9",
      amountUSD: 0.1,
    });
    await store.redeemCredit("run-9", "run-new");
    expect(await store.findUnredeemedCredit("u1", "goal")).toEqual({
      creditRunId: "run-10",
      amountUSD: 0.1,
    });
    await expect(store.redeemCredit("run-9", "run-other")).rejects.toThrow(/already redeemed/i);
    await store.recordCreditClaim({ creditRunId: "run-10", userId: "u1", family: "goal", amountUSD: 0.1 });
    expect(await store.findUnredeemedCredit("u1", "goal")).toEqual({
      creditRunId: "run-10",
      amountUSD: 0.1,
    });
    expect(await store.findUnredeemedCredit("u1", "stock")).toBeNull();
  });
});
