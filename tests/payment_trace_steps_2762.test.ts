// @vitest-environment node
/**
 * Issue #2762 (tracker #2708 item A6) — close the S17 trace break
 * `payment-workflow-steps`: PaymentWorkflowParams carry the
 * traceparent the caller-built screener command already carries
 * (#1743's field, stamped at the buildPaymentWorkflowParams seam),
 * and the payment flow records its step hops under that trace with
 * the landed S17 mechanism (deterministic spans from
 * (runRequestId, step name), recorded after each step's journaled
 * result, best-effort — tracing observes, never decides).
 *
 * Pins:
 *  - carriage: the submission seam stamps params.traceparent from
 *    the screener command's traceparent (and omits the field when
 *    the command carries none); the paid-screen builder carries it
 *    through;
 *  - a traced run's hops join the carried trace id (operations =
 *    the flow's step names), parented on the carried span, agent
 *    PaymentWorkflow, jobId = the run's runRequestId;
 *  - replay convergence: re-running the flow re-records the
 *    identical deterministic spans — one hop per step;
 *  - absence degrades honestly: no traceparent (or a malformed
 *    one) records NOTHING and never mints mid-flight — the landed
 *    recordWorkflowTraceHop contract — and the flow's outcomes
 *    (including the #2550 payment.approved audit) are unchanged;
 *  - a throwing trace recorder never fails a payment step;
 *  - the registry spine cell reads carried.
 */
import { describe, expect, it, vi } from "vitest";
import {
  runPaymentWorkflowFlow,
  type PaymentGate,
  type PaymentWorkflowDeps,
  type PaymentWorkflowEvent,
  type PaymentWorkflowParams,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import { paymentTraceHop } from "../src/workflows/paymentWorkflow";
import { buildPaymentWorkflowParams } from "../src/services/paymentWorkflowSubmission";
import { buildPaidScreenSubmission } from "../src/services/paidScreenSubmission";
import {
  meshTraceStoreForEnv,
  readTraceHops,
} from "../src/data/createMeshTracePorts";
import { deterministicSpanId } from "../src/observability/meshTrace";
import { MESH_TRACE_SPINE } from "../src/agents/registry";
import type { CommercialAccount } from "../src/services/cfpayMonetization";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type { Env } from "../src/types";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CARRIED_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${CARRIED_SPAN_ID}-01`;
const RUN_ID = "pay-run-2762";

const account: CommercialAccount = {
  userId: "alice",
  email: "alice@example.com",
  tenantId: "tenant-1",
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
};

function tracedParams(extra: Partial<PaymentWorkflowParams> = {}): PaymentWorkflowParams {
  return {
    runRequestId: RUN_ID,
    family: "goal",
    trigger: "manual",
    tenantId: "tenant-1",
    userId: "alice",
    email: "alice@example.com",
    traceparent: TRACEPARENT,
    ...extra,
  };
}

const coveredGate: PaymentGate = {
  check: async () => ({
    allowed: true,
    status: "covered",
    runRequestId: RUN_ID,
    priceUSD: 10,
    paidVia: "subscription_included",
  }),
  confirmPaid: async () => {
    throw new Error("confirmPaid must not run on the covered path");
  },
};

function checkoutGate(confirm: PaymentGate["confirmPaid"]): PaymentGate {
  return {
    check: async () => ({
      allowed: false,
      status: "payment_required",
      httpStatus: 402,
      runRequestId: RUN_ID,
      priceUSD: 10,
      family: "goal",
      checkout: { checkoutId: "chk-2762" },
    }),
    confirmPaid: confirm,
  };
}

const paidConfirm: PaymentGate["confirmPaid"] = async () => ({
  allowed: true,
  status: "paid",
  runRequestId: RUN_ID,
  priceUSD: 10,
  paidVia: "stripe_card",
});

const coverageRequiredGate: PaymentGate = {
  check: async () => ({
    allowed: false,
    status: "coverage_required",
    httpStatus: 402,
    runRequestId: RUN_ID,
    priceUSD: 10,
    family: "goal",
  }),
  confirmPaid: async () => {
    throw new Error("confirmPaid must not run when coverage is required");
  },
};

interface StepScript {
  approval?: Record<string, unknown>;
  approvalTimeout?: boolean;
  verified?: Record<string, unknown>;
  verifiedTimeout?: boolean;
}

function fakeStep(script: StepScript = {}): PaymentWorkflowStep {
  return {
    waitForEvent: async (name: string) => {
      if (name === "await-payment-approval") {
        if (script.approvalTimeout) throw new Error("waitForEvent timed out");
        return { payload: script.approval ?? { approved: true, approverId: "ops-lead" } };
      }
      if (script.verifiedTimeout) throw new Error("waitForEvent timed out");
      return { payload: script.verified ?? { claimTxHash: "0xabc" } };
    },
    do: async (_name: string, fn: () => Promise<unknown>) => fn(),
  } as PaymentWorkflowStep;
}

/** Deps wired exactly as the production adapter wires them (paymentTraceHop over the env store). */
function wiredDeps(
  env: Record<string, unknown>,
  params: PaymentWorkflowParams,
  gate: PaymentGate,
  extra: Partial<PaymentWorkflowDeps> = {},
): { deps: PaymentWorkflowDeps; events: PaymentWorkflowEvent[] } {
  const events: PaymentWorkflowEvent[] = [];
  const deps: PaymentWorkflowDeps = {
    gate,
    account: { ...account },
    startScreener: async (p) => ({ workflowId: `wf-${p.runRequestId}` }),
    recordEvent: async (e) => {
      events.push(e);
    },
    issueFailureCredit: async () => {},
    consumeCoverage: async () => {},
    traceHop: paymentTraceHop(env as unknown as Env, params),
    ...extra,
  };
  return { deps, events };
}

/* ------------------------------------------------------------------ */
/* Carriage: seam -> params                                            */
/* ------------------------------------------------------------------ */

describe("issue #2762 — traceparent carriage into the payment workflow params", () => {
  const baseInput = {
    runRequestId: RUN_ID,
    family: "goal" as const,
    trigger: "manual" as const,
    tenantId: "tenant-1",
    userId: "alice",
    email: "alice@example.com",
    account,
  };

  it("buildPaymentWorkflowParams stamps the screener command's traceparent", () => {
    const params = buildPaymentWorkflowParams({
      ...baseInput,
      screenerCommand: { jobId: "job-2762", traceparent: TRACEPARENT } as unknown as WorkflowJobCommand,
    });
    expect(params.traceparent).toBe(TRACEPARENT);
  });

  it("a command with no traceparent produces params with no traceparent field", () => {
    const params = buildPaymentWorkflowParams({
      ...baseInput,
      screenerCommand: { jobId: "job-2762" } as unknown as WorkflowJobCommand,
    });
    expect(params).not.toHaveProperty("traceparent");
  });

  it("buildPaidScreenSubmission carries the command's traceparent through the same seam", () => {
    const params = buildPaidScreenSubmission({
      ...baseInput,
      screenerCommand: { jobId: "job-2762", traceparent: TRACEPARENT } as unknown as WorkflowJobCommand,
    });
    expect(params.traceparent).toBe(TRACEPARENT);
  });
});

/* ------------------------------------------------------------------ */
/* Step hops: the flow records under the carried trace                 */
/* ------------------------------------------------------------------ */

describe("issue #2762 — PaymentWorkflow step hops join the carried trace", () => {
  it("a covered run records gate-check / record-payment / consume-coverage / start-screener hops", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    const { deps } = wiredDeps(env, params, coveredGate);
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(outcome.status).toBe("started");

    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual([
      "gate-check",
      "record-payment",
      "consume-coverage",
      "start-screener",
    ]);
    for (const hop of hops) {
      expect(hop.kind).toBe("workflow-step");
      expect(hop.traceId).toBe(TRACE_ID);
      expect(hop.spanId).toBe(deterministicSpanId(`${RUN_ID}:${hop.operation}`));
      expect(hop.parentSpanId).toBe(CARRIED_SPAN_ID);
      expect(hop.agent).toBe("PaymentWorkflow");
      expect(hop.jobId).toBe(RUN_ID);
      expect(hop.caller).toBe("alice");
      expect(hop.tenantId).toBe("tenant-1");
    }
  });

  it("a paid run records the full step sequence and the #2550 approval audit is unchanged", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    const { deps, events } = wiredDeps(env, params, checkoutGate(paidConfirm));
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(outcome.status).toBe("started");

    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual([
      "gate-check",
      "record-checkout",
      "await-payment-approval",
      "record-approval",
      "await-payment-verified",
      "confirm-paid",
      "record-payment",
      // #2192 follow-up: the best-effort native-ledger step traces
      // between record-payment and start-screener on paid runs.
      "record-native-ledger",
      "start-screener",
    ]);
    // The approval audit contract (#2550) is untouched by tracing:
    // exactly one payment.approved naming the approver.
    const approved = events.filter((e) => e.type === "payment.approved");
    expect(approved).toHaveLength(1);
    expect(approved[0].approverId).toBe("ops-lead");
    expect(events.filter((e) => e.type === "payment.confirmed")).toHaveLength(1);
  });

  it("a metered (saga) paid run records the record-usage hop after record-native-ledger", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams({ meterContext: { category: "saga", userLogin: "alice" } });
    const { deps } = wiredDeps(env, params, checkoutGate(paidConfirm), {
      recordUsage: async () => {},
    });
    const outcome = await runPaymentWorkflowFlow(
      params,
      deps,
      fakeStep({ verified: { sessionId: "sess-2762" } }),
    );
    expect(outcome.status).toBe("started");
    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual([
      "gate-check",
      "record-checkout",
      "await-payment-approval",
      "record-approval",
      "await-payment-verified",
      "confirm-paid",
      "record-payment",
      "record-native-ledger",
      "record-usage",
      "start-screener",
    ]);
  });

  it("replay re-records converge: running the flow twice leaves one hop per step", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    const { deps } = wiredDeps(env, params, coveredGate);
    await runPaymentWorkflowFlow(params, deps, fakeStep());
    await runPaymentWorkflowFlow(params, deps, fakeStep());
    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops).toHaveLength(4);
    expect(new Set(hops.map((h) => h.spanId)).size).toBe(4);
  });

  it("an approval-wait timeout records the await hop noted expired, then record-expiry, and confirms nothing", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    const { deps } = wiredDeps(env, params, checkoutGate(paidConfirm));
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep({ approvalTimeout: true }));
    expect(outcome.status).toBe("expired");
    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual([
      "gate-check",
      "record-checkout",
      "await-payment-approval",
      "record-expiry",
    ]);
    expect(hops.find((h) => h.operation === "await-payment-approval")!.note).toBe("expired");
  });

  it("a rejection records await-payment-approval + record-rejection and stops there", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    const { deps } = wiredDeps(env, params, checkoutGate(paidConfirm));
    const outcome = await runPaymentWorkflowFlow(
      params,
      deps,
      fakeStep({ approval: { approved: false, approverId: "ops-lead" } }),
    );
    expect(outcome.status).toBe("approval_rejected");
    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual([
      "gate-check",
      "record-checkout",
      "await-payment-approval",
      "record-rejection",
    ]);
  });

  it("a coverage_required run records gate-check + record-coverage-required only", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams({ trigger: "scheduled", scheduleKind: "recurring" });
    const { deps } = wiredDeps(env, params, coverageRequiredGate);
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(outcome.status).toBe("coverage_required");
    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual(["gate-check", "record-coverage-required"]);
  });

  it("a failed screener start records issue-failure-credit (the failed step itself records no hop)", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    const { deps } = wiredDeps(env, params, coveredGate, {
      startScreener: async () => {
        throw new Error("screener port unavailable");
      },
    });
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(outcome.status).toBe("screener_failed_credit_issued");
    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual([
      "gate-check",
      "record-payment",
      "consume-coverage",
      "issue-failure-credit",
    ]);
  });

  it("an unconfirmed payment ends the run at the confirm-paid hop", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    const gate = checkoutGate(async () => ({
      allowed: false,
      status: "payment_required",
      httpStatus: 402,
      runRequestId: RUN_ID,
      priceUSD: 10,
      family: "goal",
    }));
    const { deps } = wiredDeps(env, params, gate);
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(outcome.status).toBe("payment_required");
    const hops = await readTraceHops(env as unknown as Env, TRACE_ID);
    expect(hops.map((h) => h.operation)).toEqual([
      "gate-check",
      "record-checkout",
      "await-payment-approval",
      "record-approval",
      "await-payment-verified",
      "confirm-paid",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Absence / failure degrade honestly                                  */
/* ------------------------------------------------------------------ */

describe("issue #2762 — absence and recorder failure degrade honestly", () => {
  it("no traceparent → no hops recorded, nothing minted, outcome unchanged", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams();
    delete params.traceparent;
    const store = meshTraceStoreForEnv(env as unknown as Env);
    const recordSpy = vi.spyOn(store, "record");
    const { deps } = wiredDeps(env, params, coveredGate);
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(outcome.status).toBe("started");
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("a malformed traceparent → no hops, no throw, outcome unchanged", async () => {
    const env: Record<string, unknown> = {};
    const params = tracedParams({ traceparent: "not-a-traceparent" });
    const store = meshTraceStoreForEnv(env as unknown as Env);
    const recordSpy = vi.spyOn(store, "record");
    const { deps } = wiredDeps(env, params, coveredGate);
    const outcome = await runPaymentWorkflowFlow(params, deps, fakeStep());
    expect(outcome.status).toBe("started");
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("a flow wired without the traceHop dep behaves exactly as today", async () => {
    const events: PaymentWorkflowEvent[] = [];
    const deps: PaymentWorkflowDeps = {
      gate: coveredGate,
      account: { ...account },
      startScreener: async (p) => ({ workflowId: `wf-${p.runRequestId}` }),
      recordEvent: async (e) => {
        events.push(e);
      },
      issueFailureCredit: async () => {},
      consumeCoverage: async () => {},
    };
    const outcome = await runPaymentWorkflowFlow(tracedParams(), deps, fakeStep());
    expect(outcome.status).toBe("started");
    expect(events.filter((e) => e.type === "payment.covered")).toHaveLength(1);
  });

  it("a throwing traceHop recorder never fails a payment step", async () => {
    const { deps } = wiredDeps({}, tracedParams(), coveredGate, {
      traceHop: async () => {
        throw new Error("trace store unavailable");
      },
    });
    const outcome = await runPaymentWorkflowFlow(tracedParams(), deps, fakeStep());
    expect(outcome.status).toBe("started");
  });
});

/* ------------------------------------------------------------------ */
/* Registry truth-sync                                                 */
/* ------------------------------------------------------------------ */

describe("issue #2762 — registry spine truth-sync", () => {
  it("MESH_TRACE_SPINE records payment-workflow-steps as carried", () => {
    const entry = MESH_TRACE_SPINE.find((e) => e.hop === "payment-workflow-steps");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("carried");
    expect(entry!.carrier).toContain("PaymentWorkflowParams.traceparent");
    expect(entry!.evidence).toContain("workflow-step");
    const breaks = MESH_TRACE_SPINE.filter((e) => e.status === "break");
    expect(breaks.map((b) => b.hop).sort()).toEqual([
      "channel-ingress-turns",
      "http-route-workflow-starts",
    ]);
  });
});
