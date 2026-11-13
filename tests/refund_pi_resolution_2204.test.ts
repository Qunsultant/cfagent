// @vitest-environment node
/**
 * Issue #2204 follow-up — pay-per-run payment-intent resolution via the
 * native ledger seam (related issue #2204, CBO refunds).
 *
 * Before this slice, executeRefund consulted deps.sourceResolver ONLY
 * for subscription records (kind guard), so an approved pay-per-run
 * refund whose PI id was not already stored on the record ALWAYS
 * failed closed — even when the native ledger charge row carried the
 * PI. This slice wires the native ledger's run->PI lookup into the
 * resolver seam: a charge row only, card rail only, PI extracted in
 * the order gatewayRef, proofSignature, note token — never guessed.
 *
 * TDD: written FIRST; fails until the slice lands.
 *
 * Out of scope (pinned, not changed here): refund policy
 * (window/approver/full-only), crypto non-refundability, and the
 * #2549 failure-credit XOR guard — whose logic is untouched; the
 * XOR tests below only pin that a PI-resolved run still passes
 * through it in both directions.
 */
import { describe, expect, it } from "vitest";
import { InMemoryNativeLedgerAdapter } from "../src/data/inMemoryNativeLedgerAdapter";
import type {
  NativeLedgerPort,
  NativeLedgerRow,
} from "../src/data/nativeLedgerPorts";
import {
  InMemoryRefundAdapter,
  InMemoryRefundPolicyAdapter,
} from "../src/data/inMemoryRefundAdapter";
import type { RefundPaymentSourceResolver } from "../src/data/refundPorts";
import {
  decideRefund,
  executeRefund,
  refundNotResolvableMessage,
  requestRefund,
  type FailureCreditLookup,
} from "../src/services/refundService";
import {
  createPayPerRunPaymentResolver,
  extractPaymentIntentFromNativeChargeRow,
} from "../src/services/refundPaymentIntent";

const PI = "pi_test_resolved1234567890";
const RUN = "run-pi-1";
const TENANT = "t1";

function chargeRow(overrides: Partial<NativeLedgerRow> = {}): NativeLedgerRow {
  return {
    id: "native_test_1",
    sessionId: `screener-payment-native:${RUN}`,
    action: "charge",
    amount: 0.1,
    currency: "USD",
    customer: "u1",
    gateway: "stripe",
    gatewayRef: PI,
    status: "completed",
    checkoutUrl: "",
    proposerDid: "orchestrator",
    proofSignature: PI,
    note: `stock run ${RUN} via native stripe checkout; payment intent ${PI}`,
    tenantId: TENANT,
    family: "stock",
    runRequestId: RUN,
    createdAtMs: Date.now() - 1000,
    updatedAtMs: Date.now() - 1000,
    ...overrides,
  };
}

/** Stub port returning canned rows, so the extraction matrix is exact. */
function stubPort(rows: NativeLedgerRow[]): NativeLedgerPort {
  return {
    recordRow: async () => {
      throw new Error("stub port does not record");
    },
    findRow: async (runRequestId: string, kind: "charge" | "credit") =>
      rows.find((r) => r.runRequestId === runRequestId && r.action === kind),
    listRowsForRun: async (runRequestId: string) =>
      rows.filter((r) => r.runRequestId === runRequestId),
    listRowsForTenant: async (tenantId: string) =>
      rows.filter((r) => r.tenantId === tenantId),
  };
}

function gatewayStub() {
  const calls: any[] = [];
  return {
    calls,
    gateway: {
      executeRefund: async (params: any) => {
        calls.push(params);
        return { success: true, refundId: "re_2204_1", amountRefunded: params.amount, message: "ok" };
      },
    },
  };
}

async function approvedPayPerRunRecord(opts: {
  tenantId?: string;
  originalPaymentRef?: string;
} = {}) {
  const policy = new InMemoryRefundPolicyAdapter();
  await policy.setKindApproval("pay_per_run", true, "op1");
  const store = new InMemoryRefundAdapter();
  // Issue #3180: the tenant comes from the resolved source, never
  // from request input — the stub source carries it here.
  const stubSource: RefundPaymentSourceResolver = {
    resolve: async () => ({
      paymentIntentId: null,
      rail: "card",
      originalAmountUSD: null,
      originalPaidAtMs: null,
      userId: "u1",
      tenantId: opts.tenantId ?? TENANT,
      subscriptionId: null,
    }),
  };
  const record = await requestRefund(
    { policyStore: policy, refundStore: store, sourceResolver: stubSource },
    {
      kind: "pay_per_run",
      originalPaymentRef: opts.originalPaymentRef ?? RUN,
      amountUSD: 0.1,
      originalAmountUSD: 0.1,
      originalPaidAtMs: Date.now() - 1000,
      rail: "card",
      reason: "run failed",
      requesterLogin: "u1",
      isOperator: false,
    },
  );
  await decideRefund({ refundStore: store }, { refundId: record.id, decision: "approve", approverLogin: "op1" });
  return { policy, store, record };
}

describe("pay-per-run PI extraction from a native charge row", () => {
  it("gatewayRef pi_ id wins", () => {
    expect(
      extractPaymentIntentFromNativeChargeRow(
        chargeRow({ gatewayRef: PI, proofSignature: "pi_test_other0000000001", note: "no token" }),
      ),
    ).toBe(PI);
  });

  it("proofSignature pi_ id is used when gatewayRef is a session id", () => {
    expect(
      extractPaymentIntentFromNativeChargeRow(
        chargeRow({ gatewayRef: "cs_test_session1", proofSignature: PI, note: "no token" }),
      ),
    ).toBe(PI);
  });

  it("note token is used when neither gatewayRef nor proofSignature carries a pi_ id", () => {
    expect(
      extractPaymentIntentFromNativeChargeRow(
        chargeRow({
          gatewayRef: "cs_test_session1",
          proofSignature: "none (no on-chain claim recorded)",
          note: `stock run ${RUN} via native stripe checkout; payment intent ${PI}`,
        }),
      ),
    ).toBe(PI);
  });

  it("session-only row (no PI anywhere) extracts null — never a guessed id", () => {
    expect(
      extractPaymentIntentFromNativeChargeRow(
        chargeRow({
          gatewayRef: "cs_test_session1",
          proofSignature: "none (no on-chain claim recorded)",
          note: `stock run ${RUN} via native stripe checkout`,
        }),
      ),
    ).toBeNull();
  });

  it("non-pi_ gatewayRef / proofSignature values are ignored", () => {
    expect(
      extractPaymentIntentFromNativeChargeRow(
        chargeRow({ gatewayRef: RUN, proofSignature: "0xdeadbeef", note: "no token" }),
      ),
    ).toBeNull();
  });
});

describe("pay-per-run payment resolver over the native ledger port", () => {
  it("resolves a PI from a recorded native charge row (adapter-backed)", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    await ledger.recordRow({
      kind: "charge",
      runRequestId: RUN,
      tenantId: TENANT,
      userId: "u1",
      family: "stock",
      priceUSD: 0.1,
      rail: "stripe",
      sessionId: "cs_test_session1",
      paymentIntentId: PI,
    });
    const source = await createPayPerRunPaymentResolver(ledger).resolve(RUN);
    expect(source?.paymentIntentId).toBe(PI);
    expect(source?.rail).toBe("card");
    expect(source?.tenantId).toBe(TENANT);
    expect(source?.userId).toBe("u1");
    expect(source?.subscriptionId).toBeNull();
  });

  it("returns null for a missing row, an x402 row, and a credit-only row", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    await ledger.recordRow({
      kind: "charge",
      runRequestId: "run-x402",
      tenantId: TENANT,
      userId: "u1",
      family: "stock",
      priceUSD: 0.1,
      rail: "x402",
      claimTxHash: "0xclaimhash",
    });
    await ledger.recordRow({
      kind: "credit",
      runRequestId: "run-credit-only",
      tenantId: TENANT,
      userId: "u1",
      family: "stock",
      priceUSD: 0.1,
      rail: "stripe",
    });
    const resolver = createPayPerRunPaymentResolver(ledger);
    expect(await resolver.resolve("run-missing")).toBeNull();
    expect(await resolver.resolve("run-x402")).toBeNull();
    expect(await resolver.resolve("run-credit-only")).toBeNull();
  });

  it("returns null for a session-only charge row (no paymentIntentId recorded)", async () => {
    const resolver = createPayPerRunPaymentResolver(
      stubPort([
        chargeRow({
          gatewayRef: "cs_test_session1",
          proofSignature: "none (no on-chain claim recorded)",
          note: `stock run ${RUN} via native stripe checkout`,
        }),
      ]),
    );
    expect(await resolver.resolve(RUN)).toBeNull();
  });
});

describe("executeRefund with a PI-resolved pay-per-run run", () => {
  it("executes with the resolved PI and calls the gateway with it", async () => {
    const { policy, store, record } = await approvedPayPerRunRecord();
    const ledger = new InMemoryNativeLedgerAdapter();
    await ledger.recordRow({
      kind: "charge",
      runRequestId: RUN,
      tenantId: TENANT,
      userId: "u1",
      family: "stock",
      priceUSD: 0.1,
      rail: "stripe",
      sessionId: "cs_test_session1",
      paymentIntentId: PI,
    });
    const { calls, gateway } = gatewayStub();
    const noCredit: FailureCreditLookup = { hasFailureCredit: async () => false };
    const executed = await executeRefund(
      {
        policyStore: policy,
        refundStore: store,
        sourceResolver: createPayPerRunPaymentResolver(ledger),
        gateway,
        monetizationEnabled: true,
        failureCreditLookup: noCredit,
      },
      { refundId: record.id },
    );
    expect(executed.status).toBe("executed");
    expect(executed.gatewayRefundId).toBe("re_2204_1");
    expect(calls).toHaveLength(1);
    expect(calls[0].gatewayRef).toBe(PI);
  });

  it("still fails closed with the current message when the PI is unresolvable", async () => {
    const { policy, store, record } = await approvedPayPerRunRecord();
    const { calls, gateway } = gatewayStub();
    const noCredit: FailureCreditLookup = { hasFailureCredit: async () => false };
    await expect(
      executeRefund(
        {
          policyStore: policy,
          refundStore: store,
          sourceResolver: createPayPerRunPaymentResolver(new InMemoryNativeLedgerAdapter()),
          gateway,
          monetizationEnabled: true,
          failureCreditLookup: noCredit,
        },
        { refundId: record.id },
      ),
    ).rejects.toThrow(refundNotResolvableMessage(RUN));
    expect(calls).toEqual([]);
    expect((await store.getRefund(record.id))?.status).toBe("approved");
  });

  it("refuses when the resolved source belongs to a different tenant", async () => {
    const { policy, store, record } = await approvedPayPerRunRecord();
    const { calls, gateway } = gatewayStub();
    const noCredit: FailureCreditLookup = { hasFailureCredit: async () => false };
    const otherTenant = createPayPerRunPaymentResolver(
      stubPort([chargeRow({ tenantId: "t-other" })]),
    );
    await expect(
      executeRefund(
        {
          policyStore: policy,
          refundStore: store,
          sourceResolver: otherTenant,
          gateway,
          monetizationEnabled: true,
          failureCreditLookup: noCredit,
        },
        { refundId: record.id },
      ),
    ).rejects.toThrow(/cross-tenant/i);
    expect(calls).toEqual([]);
  });

  it("XOR guard still refuses a PI-resolved run that already received a failure credit", async () => {
    const { policy, store, record } = await approvedPayPerRunRecord();
    const ledger = new InMemoryNativeLedgerAdapter();
    await ledger.recordRow({
      kind: "charge",
      runRequestId: RUN,
      tenantId: TENANT,
      userId: "u1",
      family: "stock",
      priceUSD: 0.1,
      rail: "stripe",
      paymentIntentId: PI,
    });
    const { calls, gateway } = gatewayStub();
    const credited: FailureCreditLookup = { hasFailureCredit: async () => true };
    await expect(
      executeRefund(
        {
          policyStore: policy,
          refundStore: store,
          sourceResolver: createPayPerRunPaymentResolver(ledger),
          gateway,
          monetizationEnabled: true,
          failureCreditLookup: credited,
        },
        { refundId: record.id },
      ),
    ).rejects.toThrow(/already received its automatic replacement-run credit/);
    expect(calls).toEqual([]);
  });

  it("XOR guard still refuses a PI-resolved run when the lookup is unwired", async () => {
    const { policy, store, record } = await approvedPayPerRunRecord();
    const ledger = new InMemoryNativeLedgerAdapter();
    await ledger.recordRow({
      kind: "charge",
      runRequestId: RUN,
      tenantId: TENANT,
      userId: "u1",
      family: "stock",
      priceUSD: 0.1,
      rail: "stripe",
      paymentIntentId: PI,
    });
    const { calls, gateway } = gatewayStub();
    await expect(
      executeRefund(
        {
          policyStore: policy,
          refundStore: store,
          sourceResolver: createPayPerRunPaymentResolver(ledger),
          gateway,
          monetizationEnabled: true,
        },
        { refundId: record.id },
      ),
    ).rejects.toThrow(/failure-credit lookup/);
    expect(calls).toEqual([]);
  });
});
