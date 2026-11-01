/**
 * Issue #2019 — the payment flow emits the auditable lifecycle the
 * durable ledger needs: a skip event for coverage-required runs, a
 * checkout-created event when a checkout is made, full details on the
 * confirmed event (price from the durable gate-check step, checkout
 * id, verified proof), and the run price on the failure-credit call.
 * The adapter turns these events into mas_transactions rows and
 * mas_events rows; this file pins the flow side of that contract.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import {
  CfPayMonetizationGate,
  type CfPayCheckoutClient,
  type CommercialAccount,
} from "../src/services/cfpayMonetization";
import {
  extractCheckoutId,
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowEvent,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";

function stubCfpay(status = "fulfilled"): CfPayCheckoutClient {
  return {
    createCheckout: async () => ({ checkoutId: "chk-1" }),
    checkoutStatus: async () => ({ status }),
  };
}

function fakeStep(
  opts: { waitThrows?: boolean; approved?: boolean } = {},
): PaymentWorkflowStep {
  const { waitThrows = false, approved = true } = opts;
  return {
    async waitForEvent(name: string) {
      if (waitThrows) throw new Error("timeout");
      if (name.includes("approval")) return { payload: { approved } };
      return { payload: { claimTxHash: "0xabc", paymentIntentId: "pi-1" } };
    },
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

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

function depsFor(
  gate: CfPayMonetizationGate,
  account: CommercialAccount,
  overrides: Partial<PaymentWorkflowDeps> = {},
): { deps: PaymentWorkflowDeps; events: PaymentWorkflowEvent[]; credits: Array<{ run: string; price: number }> } {
  const events: PaymentWorkflowEvent[] = [];
  const credits: Array<{ run: string; price: number }> = [];
  return {
    deps: {
      gate,
      account,
      startScreener: async (p) => ({ workflowId: `wf-${p.runRequestId}` }),
      recordEvent: async (e) => {
        events.push(e);
      },
      issueFailureCredit: async (run, price) => {
        credits.push({ run, price });
      },
      ...overrides,
    },
    events,
    credits,
  };
}

function gateFor(status = "fulfilled"): CfPayMonetizationGate {
  return new CfPayMonetizationGate(stubCfpay(status), {
    monetizationEnabled: true,
    network: "base-sepolia",
    // #2185: the gate prices from the catalogue port, never from code.
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
  });
}

describe("payment workflow ledger audit events (#2019)", () => {
  it("coverage-required skip is audited with the run price, not silent", async () => {
    const { deps, events } = depsFor(gateFor(), { ...baseAccount });
    const out = await runPaymentWorkflowFlow(
      { ...baseParams, trigger: "scheduled", scheduleKind: "recurring" },
      deps,
      fakeStep(),
    );
    expect(out.status).toBe("coverage_required");
    const skip = events.find((e) => e.type === "payment.coverage_required");
    expect(skip).toBeDefined();
    expect(skip?.runRequestId).toBe("run-1");
    expect(skip?.priceUSD).toBe(0.1);
  });

  it("checkout creation is audited with the checkout id", async () => {
    const { deps, events } = depsFor(gateFor(), { ...baseAccount });
    await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    const created = events.find((e) => e.type === "payment.checkout_created");
    expect(created).toBeDefined();
    expect(created?.checkoutId).toBe("chk-1");
    expect(created?.priceUSD).toBe(0.1);
  });

  it("confirmed event carries price, checkout id, and verified proof", async () => {
    const { deps, events } = depsFor(gateFor(), { ...baseAccount });
    await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    const confirmed = events.find((e) => e.type === "payment.confirmed");
    expect(confirmed).toBeDefined();
    expect(confirmed?.priceUSD).toBe(0.1);
    expect(confirmed?.checkoutId).toBe("chk-1");
    expect(confirmed?.claimTxHash).toBe("0xabc");
    expect(confirmed?.paymentIntentId).toBe("pi-1");
  });

  it("failure credit receives the run price, and its event carries it", async () => {
    const { deps, events, credits } = depsFor(gateFor(), { ...baseAccount }, {
      startScreener: async () => {
        throw new Error("screener boom");
      },
    });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("screener_failed_credit_issued");
    expect(credits).toEqual([{ run: "run-1", price: 0.1 }]);
    const issued = events.find((e) => e.type === "payment.failure_credit_issued");
    expect(issued?.priceUSD).toBe(0.1);
  });

  it("covered event carries how the run was covered (#2022)", async () => {
    const { deps, events } = depsFor(gateFor(), {
      ...baseAccount,
      tier: "Subscribed",
      includedRunsRemaining: 1,
    });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("started");
    const covered = events.find((e) => e.type === "payment.covered");
    expect(covered?.paidVia).toBe("subscription_included");
    expect(covered?.priceUSD).toBe(0.1);
  });
});

describe("extractCheckoutId (#2019)", () => {
  it("reads id, checkoutId, requestId, and nested data shapes", () => {
    expect(extractCheckoutId({ id: "a" })).toBe("a");
    expect(extractCheckoutId({ checkoutId: "b" })).toBe("b");
    expect(extractCheckoutId({ requestId: "c" })).toBe("c");
    expect(extractCheckoutId({ data: { id: "d" } })).toBe("d");
    expect(extractCheckoutId({ ok: true })).toBeUndefined();
    expect(extractCheckoutId(undefined)).toBeUndefined();
    expect(extractCheckoutId("chk-1")).toBeUndefined();
  });
});
