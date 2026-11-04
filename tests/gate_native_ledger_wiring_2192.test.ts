/**
 * Issue #2192 follow-up (umbrella #2146) — gate → native-ledger wiring.
 *
 * The payment gate's successful native charge must record a native
 * ledger row (src/data/nativeLedgerPorts.ts) via the native ledger
 * port, best-effort: any ledger failure is loud-logged and NEVER
 * thrown into the payment path, so the payment outcome is identical
 * with the wiring on or off, except for the recorded row.
 *
 * These tests drive runPaymentWorkflowFlow (the flow the payment
 * workflow adapter delegates to) with a fake gate + fake step, and
 * the in-memory native ledger adapter — no worker runtime, no D1,
 * no Stripe key, no network, no live charge.
 *
 * Pinned here:
 * - a native stripe charge records one native charge row (tenant-
 *   scoped, truthful gateway, session id as gatewayRef);
 * - a native x402 charge records one native charge row (gateway
 *   x402, claim tx hash as gatewayRef);
 * - a ledger failure never fails the run (loud log + started);
 * - replay is idempotent (same run re-confirmed → one row);
 * - tenant mismatch throws before any row is recorded;
 * - covered runs and non-native (cfpay-era) confirmations record
 *   no native row; an absent port changes nothing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  runPaymentWorkflowFlow,
  type PaymentGate,
  type PaymentWorkflowDeps,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import type { CommercialAccount } from "../src/services/cfpayMonetization";
import { InMemoryNativeLedgerAdapter } from "../src/data/inMemoryNativeLedgerAdapter";
import type { NativeLedgerPort } from "../src/data/nativeLedgerPorts";

const baseAccount: CommercialAccount = {
  userId: "u1",
  email: "u1@example.com",
  tenantId: "t1",
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
};

const baseParams: PaymentWorkflowParams = {
  runRequestId: "run-1",
  family: "goal",
  trigger: "manual",
  tenantId: "t1",
  userId: "u1",
  email: "u1@example.com",
};

function fakeStep(verified: Record<string, string> = { sessionId: "cs_test_123", paymentIntentId: "pi_123" }): PaymentWorkflowStep {
  return {
    async waitForEvent(name: string) {
      if (name.includes("approval")) return { payload: { approved: true, approverId: "u1" } };
      return { payload: verified };
    },
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

/** Fake gate: check demands payment, confirmPaid confirms on the given rail. */
function fakeNativeGate(paidVia: string, priceUSD = 0.1): PaymentGate {
  return {
    check: async (run) => ({
      allowed: false,
      status: "payment_required",
      httpStatus: 402,
      runRequestId: run.id,
      priceUSD,
      family: run.family,
      checkout: { checkoutId: "cs_test_123" },
    }),
    confirmPaid: async (run) => ({
      allowed: true,
      status: "paid",
      runRequestId: run.id,
      priceUSD,
      paidVia,
    }),
  };
}

function depsFor(
  gate: PaymentGate,
  account: CommercialAccount,
  overrides: Partial<PaymentWorkflowDeps> = {},
): PaymentWorkflowDeps {
  return {
    gate,
    account,
    startScreener: async (p) => ({ workflowId: `wf-${p.runRequestId}` }),
    recordEvent: async () => {},
    issueFailureCredit: async () => {},
    ...overrides,
  };
}

describe("gate → native-ledger wiring (#2192)", () => {
  it("records one native charge row on a successful stripe charge", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    const out = await runPaymentWorkflowFlow(
      baseParams,
      depsFor(fakeNativeGate("stripe_checkout"), baseAccount, { nativeLedger: ledger }),
      fakeStep(),
    );
    expect(out.status).toBe("started");
    const row = await ledger.findRow("run-1", "charge");
    expect(row).toBeDefined();
    expect(row!.tenantId).toBe("t1");
    expect(row!.family).toBe("goal");
    expect(row!.amount).toBe(0.1);
    expect(row!.gateway).toBe("stripe");
    expect(row!.gatewayRef).toBe("cs_test_123");
    expect(row!.customer).toBe("u1");
    expect(row!.action).toBe("charge");
  });

  it("records one native charge row on a successful x402 charge", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    const out = await runPaymentWorkflowFlow(
      baseParams,
      depsFor(fakeNativeGate("x402"), baseAccount, { nativeLedger: ledger }),
      fakeStep({ paymentProof: "proof-1", payer: "0xabc", claimTxHash: "0xclaim" }),
    );
    expect(out.status).toBe("started");
    const row = await ledger.findRow("run-1", "charge");
    expect(row).toBeDefined();
    expect(row!.gateway).toBe("x402");
    expect(row!.gatewayRef).toBe("0xclaim");
  });

  it("never fails the run when the ledger throws (loud log, outcome unchanged)", async () => {
    const throwing: NativeLedgerPort = {
      recordRow: async () => {
        throw new Error("D1 down");
      },
      findRow: async () => undefined,
      listRowsForRun: async () => [],
      listRowsForTenant: async () => [],
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runPaymentWorkflowFlow(
        baseParams,
        depsFor(fakeNativeGate("stripe_checkout"), baseAccount, { nativeLedger: throwing }),
        fakeStep(),
      );
      expect(out.status).toBe("started");
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).toMatch(/native ledger/i);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("is idempotent on replay: a re-confirmed run records exactly one charge row", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    const deps = depsFor(fakeNativeGate("stripe_checkout"), baseAccount, { nativeLedger: ledger });
    const out1 = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    const out2 = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out1.status).toBe("started");
    expect(out2.status).toBe("started");
    const rows = (await ledger.listRowsForRun("run-1")).filter((r) => r.action === "charge");
    expect(rows).toHaveLength(1);
  });

  it("tenant mismatch throws before any native row is recorded", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    await expect(
      runPaymentWorkflowFlow(
        { ...baseParams, tenantId: "t-other" },
        depsFor(fakeNativeGate("stripe_checkout"), baseAccount, { nativeLedger: ledger }),
        fakeStep(),
      ),
    ).rejects.toThrow(/Tenant mismatch/);
    expect(await ledger.findRow("run-1", "charge")).toBeUndefined();
    expect(await ledger.listRowsForTenant("t-other")).toHaveLength(0);
  });

  it("records no native row for a covered run", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    const coveredGate: PaymentGate = {
      check: async (run) => ({
        allowed: true,
        status: "paid",
        runRequestId: run.id,
        priceUSD: 0.1,
        paidVia: "subscription_included",
      }),
      confirmPaid: async (run) => ({
        allowed: true,
        status: "already_paid",
        runRequestId: run.id,
        priceUSD: 0.1,
        paidVia: "subscription_included",
      }),
    };
    const out = await runPaymentWorkflowFlow(
      baseParams,
      depsFor(coveredGate, baseAccount, { nativeLedger: ledger }),
      fakeStep(),
    );
    expect(out.status).toBe("started");
    expect(await ledger.findRow("run-1", "charge")).toBeUndefined();
  });

  it("records no native row for a non-native (cfpay-era) confirmation", async () => {
    const ledger = new InMemoryNativeLedgerAdapter();
    const out = await runPaymentWorkflowFlow(
      baseParams,
      depsFor(fakeNativeGate("cfpay_checkout"), baseAccount, { nativeLedger: ledger }),
      fakeStep({ claimTxHash: "0xabc" }),
    );
    expect(out.status).toBe("started");
    expect(await ledger.findRow("run-1", "charge")).toBeUndefined();
  });

  it("an absent native ledger port changes nothing", async () => {
    const out = await runPaymentWorkflowFlow(
      baseParams,
      depsFor(fakeNativeGate("stripe_checkout"), baseAccount),
      fakeStep(),
    );
    expect(out.status).toBe("started");
  });
});
