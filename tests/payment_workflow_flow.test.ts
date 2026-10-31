/**
 * Issue #2043 (follow-up to #2023) — repo port of the workspace payment
 * flow cases, plus caller-seam cases for paymentWorkflowSubmission.ts.
 *
 * The flow module is pure TypeScript (type-only imports), so these tests
 * run in plain vitest with a fake step surface, a fake cfpay client, and
 * fake deps — no worker runtime, no Think runtime, no cfpay key, no D1,
 * no screener binding, no network, no mainnet. The workflow class itself
 * is a thin adapter and is covered by typecheck, not by tests here.
 *
 * Money-path invariants pinned here:
 * - a workflow event is a wake-up only; only a re-read checkout.status
 *   of fulfilled/paid confirms payment (an event alone never starts);
 * - recurring (or unstated-kind) scheduled runs are coverage-only and
 *   never take a checkout;
 * - approval is a human gate BEFORE capture, never a model prompt;
 * - tenant mismatch fails closed before any start;
 * - a paid run whose screener fails gets a failure credit, never a
 *   cash-refund claim.
 */
import { describe, expect, it } from "vitest";
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
import {
  buildPaymentWorkflowParams,
  deliverPaymentApprovalViaHost,
  deliverPaymentVerifiedViaHost,
  startPaymentWorkflowViaBinding,
  startPaymentWorkflowViaHost,
  type PaymentWorkflowBinding,
  type PaymentWorkflowHost,
} from "../src/services/paymentWorkflowSubmission";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";

function stubCfpay(status = "fulfilled"): CfPayCheckoutClient {
  return {
    createCheckout: async () => ({ checkoutId: "chk-1" }),
    checkoutStatus: async () => ({ status }),
  };
}

function fakeStep(
  opts: {
    waitThrows?: boolean;
    approved?: boolean;
    verified?: { claimTxHash?: string; paymentIntentId?: string };
  } = {},
): PaymentWorkflowStep {
  const { waitThrows = false, approved = true, verified = { claimTxHash: "0xabc" } } = opts;
  return {
    async waitForEvent(name: string) {
      if (waitThrows) throw new Error("timeout");
      if (name.includes("approval")) return { payload: { approved } };
      return { payload: verified };
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
): { deps: PaymentWorkflowDeps; events: Array<{ type: string }> } {
  const events: Array<{ type: string }> = [];
  return {
    deps: {
      gate,
      account,
      startScreener: async (p) => ({ workflowId: `wf-${p.runRequestId}` }),
      recordEvent: async (e) => {
        events.push({ type: e.type });
      },
      issueFailureCredit: async () => {},
      ...overrides,
    },
    events,
  };
}

function gateFor(status = "fulfilled"): CfPayMonetizationGate {
  return new CfPayMonetizationGate(stubCfpay(status), {
    monetizationEnabled: true,
    network: "base-sepolia",
    // #2185: the gate prices from the catalogue port, never from
    // code — the test double seeds the proposed defaults.
    priceCatalogue: new InMemoryPriceCatalogueAdapter(),
  });
}

describe("payment workflow flow (#2043, ported from the workspace cases)", () => {
  it("coverage run starts the screener with no wait and no checkout", async () => {
    const account = { ...baseAccount, tier: "Subscribed" as const, includedRunsRemaining: 1 };
    const { deps } = depsFor(gateFor(), account);
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("started");
    if (out.status === "started") {
      expect(out.paidVia).toBe("subscription_included");
      expect(out.screenerWorkflowId).toBe("wf-run-1");
      // S3 (#2041): the started outcome carries the gate price so
      // the saga can value compensation (credit or refund request).
      // Pinned as positive, not as a catalogue value: the proposed
      // defaults the test double seeds are unapproved.
      expect(out.priceUSD).toBeGreaterThan(0);
    }
  });

  it("credits run starts the screener with no wait and no checkout", async () => {
    const account = { ...baseAccount, creditsUSD: 1 };
    const { deps } = depsFor(gateFor(), account);
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("started");
    if (out.status === "started") expect(out.paidVia).toBe("credits");
  });

  it("flag-OFF run starts the screener with no wait and no checkout", async () => {
    const gate = new CfPayMonetizationGate(stubCfpay(), {
      monetizationEnabled: false,
      network: "base-sepolia",
      priceCatalogue: new InMemoryPriceCatalogueAdapter(),
    });
    const { deps } = depsFor(gate, { ...baseAccount });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("started");
    if (out.status === "started") expect(out.paidVia).toBe("free_flag_off");
  });

  it("checkout run waits, confirms, then starts the screener", async () => {
    const { deps, events } = depsFor(gateFor(), { ...baseAccount });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("started");
    if (out.status === "started") expect(out.paidVia).toBe("cfpay_checkout");
    expect(events.some((e) => e.type === "payment.confirmed")).toBe(true);
  });

  it("checkout wait timeout expires and starts nothing", async () => {
    let started = false;
    const { deps } = depsFor(gateFor(), { ...baseAccount }, {
      startScreener: async () => {
        started = true;
        return { workflowId: "x" };
      },
    });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep({ waitThrows: true }));
    expect(out.status).toBe("expired");
    expect(started).toBe(false);
  });

  it("event alone is not proof: unfulfilled status does not start the screener", async () => {
    const { deps } = depsFor(gateFor("pending"), { ...baseAccount });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("payment_required");
  });

  it("recurring scheduled run is coverage_required, never a checkout", async () => {
    const { deps } = depsFor(gateFor(), { ...baseAccount });
    const out = await runPaymentWorkflowFlow(
      { ...baseParams, trigger: "scheduled", scheduleKind: "recurring" },
      deps,
      fakeStep(),
    );
    expect(out.status).toBe("coverage_required");
  });

  it("unstated-kind scheduled run is coverage_required, never a checkout", async () => {
    const { deps } = depsFor(gateFor(), { ...baseAccount });
    const out = await runPaymentWorkflowFlow(
      { ...baseParams, trigger: "scheduled" },
      deps,
      fakeStep(),
    );
    expect(out.status).toBe("coverage_required");
  });

  it("tenant mismatch fails closed before any start", async () => {
    const { deps } = depsFor(gateFor(), { ...baseAccount, tenantId: "t2" });
    await expect(
      runPaymentWorkflowFlow(baseParams, deps, fakeStep()),
    ).rejects.toThrow(/Tenant mismatch/);
  });

  it("screener failure after payment issues a failure credit, no cash refund claim", async () => {
    let credited = false;
    const { deps, events } = depsFor(gateFor(), { ...baseAccount }, {
      startScreener: async () => {
        throw new Error("screener boom");
      },
      issueFailureCredit: async () => {
        credited = true;
      },
    });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep());
    expect(out.status).toBe("screener_failed_credit_issued");
    expect(credited).toBe(true);
    expect(events.some((e) => e.type === "payment.failure_credit_issued")).toBe(true);
  });

  it("approval rejected: no capture, no screener start", async () => {
    let started = false;
    const { deps } = depsFor(gateFor(), { ...baseAccount }, {
      startScreener: async () => {
        started = true;
        return { workflowId: "x" };
      },
    });
    const out = await runPaymentWorkflowFlow(baseParams, deps, fakeStep({ approved: false }));
    expect(out.status).toBe("approval_rejected");
    expect(started).toBe(false);
  });

  it("one-off scheduled run authorized at submission skips the second approval wait", async () => {
    const { deps } = depsFor(gateFor(), { ...baseAccount });
    const out = await runPaymentWorkflowFlow(
      {
        ...baseParams,
        trigger: "scheduled",
        scheduleKind: "one_off",
        authorizedAtSubmission: true,
      },
      deps,
      // approved:false is never consulted on this path; payment still
      // confirms via checkout.status.
      fakeStep({ approved: false }),
    );
    expect(out.status).toBe("started");
  });
});

describe("payment workflow caller seam (#2043)", () => {
  const command: WorkflowJobCommand = {
    jobId: "job-1",
    type: "run-screen",
    source: "test",
    trigger: "manual",
    userLogin: "u1",
    shards: [],
    role: "parent",
  };
  const input = {
    runRequestId: "run-1",
    family: "goal" as const,
    trigger: "manual" as const,
    tenantId: "t1",
    userId: "u1",
    email: "u1@example.com",
    account: { ...baseAccount },
    screenerCommand: command,
  };

  it("builds params carrying ids only, with the caller screener command", () => {
    const params = buildPaymentWorkflowParams(input);
    expect(params.runRequestId).toBe("run-1");
    expect(params.screenerCommand).toBe(command);
    expect(params.account).toBe(input.account);
  });

  it("rejects missing identity, missing jobId, and tenant mismatch", () => {
    expect(() => buildPaymentWorkflowParams({ ...input, userId: "" })).toThrow(/verified userId/);
    expect(() =>
      buildPaymentWorkflowParams({ ...input, screenerCommand: { jobId: 7 } as unknown as WorkflowJobCommand }),
    ).toThrow(/jobId/);
    expect(() =>
      buildPaymentWorkflowParams({ ...input, account: { ...baseAccount, tenantId: "t2" } }),
    ).toThrow(/Tenant mismatch/);
  });

  it("starts via binding with instance id equal to the run request id", async () => {
    const created: Array<{ id: string; params: unknown }> = [];
    const binding: PaymentWorkflowBinding = {
      create: async (options) => {
        created.push(options);
        return { id: options.id };
      },
      get: async () => ({}),
    };
    const params = buildPaymentWorkflowParams(input);
    const out = await startPaymentWorkflowViaBinding(binding, params);
    expect(out.workflowId).toBe("run-1");
    expect(created).toHaveLength(1);
    expect(created[0].params).toBe(params);
    await expect(startPaymentWorkflowViaBinding(undefined, params)).rejects.toThrow(
      /not configured/,
    );
  });

  it("starts via host with the PAYMENT_WORKFLOW binding name", async () => {
    const calls: Array<{ binding: string; params: unknown }> = [];
    const host: PaymentWorkflowHost = {
      runWorkflow: async (binding, params) => {
        calls.push({ binding, params });
        return { id: "run-1" };
      },
      sendWorkflowEvent: async () => {},
    };
    const params = buildPaymentWorkflowParams(input);
    const out = await startPaymentWorkflowViaHost(host, params);
    expect(out.workflowId).toBe("run-1");
    expect(calls[0].binding).toBe("PAYMENT_WORKFLOW");
    await expect(startPaymentWorkflowViaHost(undefined, params)).rejects.toThrow(
      /runWorkflow/,
    );
  });

  it("delivers approval and verified events with the right types", async () => {
    const sent: Array<{ binding: string; workflowId: string; event: { type: string; payload: unknown } }> = [];
    const host: PaymentWorkflowHost = {
      runWorkflow: async () => ({ id: "run-1" }),
      sendWorkflowEvent: async (binding, workflowId, event) => {
        sent.push({ binding, workflowId, event });
      },
    };
    await deliverPaymentApprovalViaHost(host, "run-1", { approved: true, approverId: "op-1" });
    await deliverPaymentVerifiedViaHost(host, "run-1", { claimTxHash: "0xabc" });
    expect(sent[0]).toEqual({
      binding: "PAYMENT_WORKFLOW",
      workflowId: "run-1",
      event: { type: "approval", payload: { approved: true, approverId: "op-1" } },
    });
    expect(sent[1].event.type).toBe("payment_verified");
    await expect(
      deliverPaymentApprovalViaHost(undefined, "run-1", { approved: true }),
    ).rejects.toThrow(/sendWorkflowEvent/);
  });
});
