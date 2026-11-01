/**
 * Issue #2015 — the payment workflow consumes coverage in the
 * account store on the covered path (one included run, or credits),
 * and consumes nothing on any other path. The adapter's
 * consumeCoverage implementation is best-effort (see the flow dep
 * doc); these tests pin the flow side: when and with what it calls
 * the dep.
 *
 * Harness mirrors tests/payment_workflow_flow.test.ts (#2087): fake
 * step surface, fake cfpay client, fake deps — no worker runtime.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CfPayMonetizationGate,
  type CfPayCheckoutClient,
  type CommercialAccount,
} from "../src/services/cfpayMonetization";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";

function stubCfpay(status = "fulfilled"): CfPayCheckoutClient {
  return {
    createCheckout: async () => ({ checkoutId: "chk-1" }),
    checkoutStatus: async () => ({ status }),
  };
}

function fakeStep(): PaymentWorkflowStep {
  return {
    async waitForEvent(name: string) {
      if (name.includes("approval")) return { payload: { approved: true } };
      return { payload: { claimTxHash: "0xabc" } };
    },
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

const screenerCommand: WorkflowJobCommand = {
  jobId: "job-1",
  type: "run-screen",
  source: "test",
  trigger: "manual",
  userLogin: "u1",
  shards: [],
  role: "parent",
};

function depsFor(
  account: CommercialAccount,
  consumeCoverage: PaymentWorkflowDeps["consumeCoverage"],
): PaymentWorkflowDeps {
  const gate = new CfPayMonetizationGate(stubCfpay(), {
    monetizationEnabled: true,
    network: "base-sepolia",
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
  });
  return {
    gate,
    account,
    startScreener: vi.fn(async () => ({ workflowId: "wf-1" })),
    recordEvent: vi.fn(async () => {}),
    issueFailureCredit: vi.fn(async () => {}),
    consumeCoverage,
  };
}

const baseParams: PaymentWorkflowParams = {
  runRequestId: "run-1",
  family: "goal",
  trigger: "manual",
  tenantId: "t1",
  userId: "u1",
  email: "u1@example.com",
};

describe("coverage consumption (#2015)", () => {
  it("consumes one included run on the subscription-covered path", async () => {
    const consumeCoverage = vi.fn(async () => {});
    const out = await runPaymentWorkflowFlow(
      baseParams,
      depsFor(
        { userId: "u1", email: "u1@example.com", tenantId: "t1", tier: "Subscribed", creditsUSD: 0, includedRunsRemaining: 1 },
        consumeCoverage,
      ),
      fakeStep(),
    );
    expect(out.status).toBe("started");
    expect(consumeCoverage).toHaveBeenCalledOnce();
    expect(consumeCoverage).toHaveBeenCalledWith({
      userId: "u1",
      paidVia: "subscription_included",
      priceUSD: 0.1,
    });
  });

  it("consumes credits on the credits-covered path", async () => {
    const consumeCoverage = vi.fn(async () => {});
    const out = await runPaymentWorkflowFlow(
      baseParams,
      depsFor(
        { userId: "u1", email: "u1@example.com", tenantId: "t1", tier: "PayPerUse", creditsUSD: 5, includedRunsRemaining: 0 },
        consumeCoverage,
      ),
      fakeStep(),
    );
    expect(out.status).toBe("started");
    expect(consumeCoverage).toHaveBeenCalledWith({
      userId: "u1",
      paidVia: "credits",
      priceUSD: 0.1,
    });
  });

  it("consumes nothing on the checkout path", async () => {
    const consumeCoverage = vi.fn(async () => {});
    const out = await runPaymentWorkflowFlow(
      { ...baseParams, scheduleKind: "one_off", authorizedAtSubmission: true },
      depsFor(
        { userId: "u1", email: "u1@example.com", tenantId: "t1", tier: "PayPerUse", creditsUSD: 0, includedRunsRemaining: 0 },
        consumeCoverage,
      ),
      fakeStep(),
    );
    expect(out.status).toBe("started");
    expect(consumeCoverage).not.toHaveBeenCalled();
  });

  it("covered runs still start when no consume dep is provided (backward compatible)", async () => {
    const deps = depsFor(
      { userId: "u1", email: "u1@example.com", tenantId: "t1", tier: "Subscribed", creditsUSD: 0, includedRunsRemaining: 1 },
      undefined,
    );
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("started");
  });

  it("a failed screener issues the failure credit at the run price", async () => {
    const issueFailureCredit = vi.fn(async () => {});
    const deps = depsFor(
      { userId: "u1", email: "u1@example.com", tenantId: "t1", tier: "Subscribed", creditsUSD: 0, includedRunsRemaining: 1 },
      vi.fn(async () => {}),
    );
    deps.issueFailureCredit = issueFailureCredit;
    deps.startScreener = vi.fn(async () => {
      throw new Error("screener boom");
    });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("screener_failed_credit_issued");
    expect(issueFailureCredit).toHaveBeenCalledWith("run-1", 0.1);
  });
});
