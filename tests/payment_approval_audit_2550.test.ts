// @vitest-environment node
/**
 * Issue #2550 — payment approval audit record, TDD.
 *
 * Rejection and expiry already emit mas_events audit rows
 * (payment.approval_rejected / payment.approval_expired), but a
 * successful approval — the decision that lets capture proceed —
 * recorded nothing, and the approverId carried by the approval
 * event was dropped. The flow now emits exactly one
 * payment.approved event on the approval branch, carrying the
 * approver id, the run id, the tenant, the amount, and the
 * approval time; the at-submission path records its authorizing
 * principal on payment.approved_at_submission the same way.
 */
import { describe, expect, it } from "vitest";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowEvent,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import {
  CfPayMonetizationGate,
  type CfPayCheckoutClient,
  type CommercialAccount,
} from "../src/services/cfpayMonetization";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";

function stubCfpay(status = "fulfilled"): CfPayCheckoutClient {
  return {
    createCheckout: async () => ({ checkoutId: "chk-1" }),
    checkoutStatus: async () => ({ status }),
  };
}

async function gateFor(): Promise<CfPayMonetizationGate> {
  const catalogue = new InMemoryPriceCatalogueAdapter();
  // #2547: catalogue seeds land as proposals and the gate refuses an
  // unapproved price fail-closed, so approve the seed through the
  // operator API in setup — the production rule at full strength
  // (same pattern as the #2548 suite).
  await catalogue.approvePrice({ family: "goal", approverId: "test-operator" });
  return new CfPayMonetizationGate(stubCfpay(), {
    monetizationEnabled: true,
    network: "base-sepolia",
    priceCatalogue: catalogue,
  });
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

async function harness(approvalPayload: Record<string, unknown>) {
  const events: PaymentWorkflowEvent[] = [];
  const deps: PaymentWorkflowDeps = {
    gate: await gateFor(),
    account: { ...baseAccount },
    startScreener: async (p) => ({ workflowId: `wf-${p.runRequestId}` }),
    recordEvent: async (e) => {
      events.push(e);
    },
    issueFailureCredit: async () => {},
  };
  const step: PaymentWorkflowStep = {
    async waitForEvent(name: string) {
      if (name.includes("approval")) return { payload: approvalPayload };
      return { payload: { claimTxHash: "0xabc" } };
    },
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
  return { deps, step, events };
}

describe("payment approval audit (#2550)", () => {
  it("an approval emits exactly one payment.approved event naming the approver, run, amount, and time", async () => {
    const before = Date.now();
    const { deps, step, events } = await harness({ approved: true, approverId: "ops-lead" });
    const out = await runPaymentWorkflowFlow(baseParams, deps, step);
    expect(out.status).toBe("started");
    const approved = events.filter((e) => e.type === "payment.approved");
    expect(approved).toHaveLength(1);
    const event = approved[0];
    expect(event.approverId).toBe("ops-lead");
    expect(event.runRequestId).toBe("run-1");
    expect(event.tenantId).toBe("t1");
    expect(event.priceUSD).toBe(0.1);
    expect(event.occurredAtMs).toBeGreaterThanOrEqual(before);
    expect(event.occurredAtMs).toBeLessThanOrEqual(Date.now());
    // Symmetric neighbors still fire exactly as before.
    expect(events.filter((e) => e.type === "payment.checkout_created")).toHaveLength(1);
    expect(events.filter((e) => e.type === "payment.confirmed")).toHaveLength(1);
  });

  it("a rejection emits no payment.approved event (rejection record unchanged)", async () => {
    const { deps, step, events } = await harness({ approved: false, approverId: "ops-lead" });
    const out = await runPaymentWorkflowFlow(baseParams, deps, step);
    expect(out.status).toBe("approval_rejected");
    expect(events.filter((e) => e.type === "payment.approved")).toHaveLength(0);
    expect(events.filter((e) => e.type === "payment.approval_rejected")).toHaveLength(1);
  });

  it("the at-submission path records the authorizing principal on payment.approved_at_submission", async () => {
    const { deps, step, events } = await harness({ approved: true, approverId: "ignored-on-this-path" });
    const out = await runPaymentWorkflowFlow(
      { ...baseParams, trigger: "scheduled", scheduleKind: "one_off", authorizedAtSubmission: true },
      deps,
      step,
    );
    expect(out.status).toBe("started");
    const atSubmission = events.filter((e) => e.type === "payment.approved_at_submission");
    expect(atSubmission).toHaveLength(1);
    expect(atSubmission[0].approverId).toBe("u1");
    expect(atSubmission[0].priceUSD).toBe(0.1);
    expect(atSubmission[0].occurredAtMs).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "payment.approved")).toHaveLength(0);
  });
});
