// @vitest-environment node
/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — payment
 * workflow outcome for the approved-free per-service quota.
 *
 * At the cap nothing runs over allowance (#3241 decision 4): the
 * workflow returns `quota_exhausted` with the outcome-coded
 * at-limit decision — no approval wait, no screener start, no
 * checkout. The refusal is audited as
 * `payment.approved_free_quota_exhausted`.
 *
 * The #1069 §10-shaped test below is the batch alignment test in
 * miniature: an authorized user in Tenant A runs a premium
 * screening workflow in sandbox mode, within budget — and cannot
 * access Tenant B, switch to live execution, or bypass approval.
 * (The live-switch leg is covered by environment being
 * server-resolved: no client-supplied environment reaches quota
 * evaluation.)
 */
import { describe, expect, it } from "vitest";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { StripeCheckoutAdapter, type StripeCheckoutClient } from "../src/services/stripeCheckoutAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryFreeRunCounterAdapter } from "../src/data/inMemoryFreeRunCounterAdapter";
import { InMemoryApprovedFreeQuotaAdapter } from "../src/data/inMemoryApprovedFreeQuotaAdapter";
import { approvedFreeQuotaPeriodKey } from "../src/data/approvedFreeQuotaPorts";
import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowEvent,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import type { CheckoutPorts } from "../src/services/checkoutPorts";

const NOV = Date.UTC(2026, 10, 15, 12, 0, 0);
// The flow drives the gate without nowMs, so its period key is the
// real current month — computed here, never hardcoded.
const CURRENT_PERIOD = approvedFreeQuotaPeriodKey(Date.now(), "month");

function grantedAccount(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
  return {
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 0,
    unlimitedFreeGrant: { grantedBy: "op1", reason: "Owner-approved pilot account", expiresAtMs: null },
    ...overrides,
  };
}

/** A step surface that FAILS if the flow ever waits — the quota path must not wait for anything. */
function noWaitStep(): PaymentWorkflowStep {
  return {
    async waitForEvent() {
      throw new Error("payment workflow waited for an event on the quota path (must not wait)");
    },
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

function quotaGate() {
  const client: StripeCheckoutClient = {
    async createCheckout(params) {
      return {
        success: true,
        checkoutUrl: `https://checkout.example/session/${params.draftId}`,
        gatewayRef: `cs_test_${params.draftId}`,
      };
    },
    async retrieveSession(sessionId) {
      return {
        id: sessionId,
        status: "complete",
        payment_status: "paid",
        amount_total: 10,
        client_reference_id: "run-1",
        payment_intent: "pi_test_run-1",
      };
    },
  };
  const ports: CheckoutPorts = { card: new StripeCheckoutAdapter(client), x402: null };
  const quota = new InMemoryApprovedFreeQuotaAdapter({
    caps: { stock: 10, goal: 10, options: 10, strategy: 10 },
    settings: { windowKind: "month", atLimitAction: "upgrade_or_buy_credits" },
  });
  const counter = new InMemoryFreeRunCounterAdapter({ stock: 10, goal: 10, options: 10, strategy: 10 });
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
    checkout: ports,
    freeRunCounter: counter,
    approvedFreeQuota: quota,
  });
  return { gate, quota };
}

function flowFor(
  gate: NativeMonetizationGate,
  account: NativeCommercialAccount,
): { deps: PaymentWorkflowDeps; events: string[]; eventObjects: PaymentWorkflowEvent[]; screenerStarts: string[] } {
  const events: string[] = [];
  const eventObjects: PaymentWorkflowEvent[] = [];
  const screenerStarts: string[] = [];
  const deps: PaymentWorkflowDeps = {
    gate,
    account,
    startScreener: async (p) => {
      screenerStarts.push(p.runRequestId);
      return { workflowId: `wf-${p.runRequestId}` };
    },
    recordEvent: async (e) => {
      events.push(e.type);
      eventObjects.push(e);
    },
    issueFailureCredit: async () => {},
  };
  return { deps, events, eventObjects, screenerStarts };
}

function paramsFor(runRequestId: string, tenantId = "t1"): PaymentWorkflowParams {
  return {
    runRequestId,
    family: "goal",
    trigger: "manual",
    tenantId,
    userId: "u1",
    email: "u1@example.com",
  };
}

describe("payment workflow: approved-free quota (#3263)", () => {
  it("a grant run within the quota starts the screener with no wait and no checkout", async () => {
    const { gate } = quotaGate();
    const { deps, events, eventObjects, screenerStarts } = flowFor(gate, grantedAccount());
    const outcome = await runPaymentWorkflowFlow(paramsFor("run-1"), deps, noWaitStep());
    expect(outcome).toMatchObject({ status: "started", runRequestId: "run-1", paidVia: "approved_free_quota", priceUSD: 0, outcomeCode: "SUCCESS_APPROVED_FREE_QUOTA_COVERED" });
    expect(screenerStarts).toEqual(["run-1"]);
    expect(events).toContain("payment.covered");
    expect(events).not.toContain("payment.approved_free_quota_exhausted");
    // AOP (#1969): the covered audit event carries its success code
    // and login, so the record alone answers which code, what
    // happened, for which login.
    const covered = eventObjects.find((e) => e.type === "payment.covered");
    expect(covered).toMatchObject({
      outcomeCode: "SUCCESS_APPROVED_FREE_QUOTA_COVERED",
      login: "u1",
      tenantId: "t1",
    });
  });

  it("at the cap the workflow returns quota_exhausted, audits it, and never starts the screener", async () => {
    const { gate, quota } = quotaGate();
    const account = grantedAccount();
    // Exhaust the quota through the gate first (10 runs in November).
    for (let i = 1; i <= 10; i++) {
      await gate.check({ id: `pre-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account });
    }
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: "2026-11" })).toBe(10);
    const { deps, events, eventObjects, screenerStarts } = flowFor(gate, account);
    const outcome = await runPaymentWorkflowFlow(paramsFor("run-11"), deps, noWaitStep());
    expect(outcome).toMatchObject({
      status: "quota_exhausted",
      runRequestId: "run-11",
      priceUSD: 0,
      family: "goal",
      outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED",
      nextStep: "upgrade_or_buy_credits",
    });
    expect(events).toContain("payment.approved_free_quota_exhausted");
    expect(screenerStarts).toEqual([]);
    // AOP (#1969): the refusal audit event carries its code, the
    // login, and the server-side detail (counts + decision ref).
    const exhausted = eventObjects.find((e) => e.type === "payment.approved_free_quota_exhausted");
    expect(exhausted).toMatchObject({
      outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED",
      login: "u1",
      tenantId: "t1",
    });
    expect(exhausted?.detail).toContain("Approved-free quota for goal exhausted");
  });

  it("#1069 §10 shape: Tenant A within budget starts; Tenant B has its own count; cross-tenant throws; no bypass at the cap", async () => {
    const { gate, quota } = quotaGate();
    const inA = grantedAccount();
    const inB = grantedAccount({ tenantId: "t2" });
    // Tenant A, within budget: starts.
    const flowA = flowFor(gate, inA);
    const started = await runPaymentWorkflowFlow(paramsFor("a-1", "t1"), flowA.deps, noWaitStep());
    expect(started).toMatchObject({ status: "started", paidVia: "approved_free_quota" });
    // Tenant B, same login: its own count, starts at 0.
    const flowB = flowFor(gate, inB);
    const startedB = await runPaymentWorkflowFlow(paramsFor("b-1", "t2"), flowB.deps, noWaitStep());
    expect(startedB).toMatchObject({ status: "started", paidVia: "approved_free_quota" });
    expect(await quota.getUsed({ tenantId: "t2", login: "u1", family: "goal", period: CURRENT_PERIOD })).toBe(1);
    expect(await quota.getUsed({ tenantId: "t1", login: "u1", family: "goal", period: CURRENT_PERIOD })).toBe(1);
    // Cross-tenant: params tenant B with account tenant A throws before any quota read.
    const flowX = flowFor(gate, inA);
    await expect(runPaymentWorkflowFlow(paramsFor("x-1", "t2"), flowX.deps, noWaitStep())).rejects.toThrow(
      /Tenant mismatch/,
    );
    // At the cap in Tenant A: refused with the at-limit outcome — no approval bypass, no screener.
    for (let i = 2; i <= 10; i++) {
      await gate.check({ id: `a-${i}`, family: "goal", trigger: "manual", nowMs: NOV, account: inA });
    }
    const flowCap = flowFor(gate, inA);
    const capped = await runPaymentWorkflowFlow(paramsFor("a-11", "t1"), flowCap.deps, noWaitStep());
    expect(capped).toMatchObject({ status: "quota_exhausted", outcomeCode: "FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED" });
    expect(flowCap.screenerStarts).toEqual([]);
  });
});
