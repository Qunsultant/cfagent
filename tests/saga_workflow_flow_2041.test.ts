/**
 * Issue #2041 S1+S2+S3 — CrossDomainSagaWorkflow flow core, leg port,
 * journey gate, and saga id derivation.
 *
 * The flow module is pure TypeScript (type-only imports), so these
 * tests run in plain vitest with a fake step surface (do executes
 * immediately, sleep advances a virtual clock), a fake leg port, and
 * fake audit/prompt deps — no worker runtime, no Think runtime, no
 * bindings, no network. The workflow class itself is a thin adapter
 * and is covered by typecheck, not by tests here.
 *
 * S1 scope: Leg 0 (payment child) + Leg 1 (observe the paid
 * screen to terminal). S2 adds Leg 2 (the journey gate after a
 * completed screen). S3 adds rail-aware mid-run failure
 * compensation (stripe checkout → refund REQUEST, never execution;
 * everything else → credit; one compensation per run, ever).
 * No trading leg (S4), no entry route (S4).
 *
 * Invariants pinned here:
 * - fail-closed identity (#1185) + goal-only family (Q5 default);
 * - payment outcomes map to saga outcomes; the saga never starts
 *   a second screener (Leg 1 observes the payment outcome's
 *   screenerWorkflowId);
 * - Leg 1 maps the screener collation lifecycle, not just the
 *   instance status (Failed collation is a failed screen even
 *   though the instance completed);
 * - an audit-write failure propagates: the saga never completes
 *   with an unrecorded transition (Q7 S2 blocking shape, as far
 *   as it is reachable from a workflow step — see the audit
 *   reachability note in sagaWorkflowFlow.ts);
 * - saga re-runs are idempotent: the same sagaId adopts the same
 *   leg instances instead of starting duplicates (G-REPLAY);
 * - leg instance ids are derived, never raw concatenations, and
 *   stay under the provider's 100-character ceiling (the #2129
 *   lesson, G-SAGA-ID);
 * - S2 journey gate (Q1 ruled: all decision surfaces, first
 *   answer wins): owner-only decisions (working default,
 *   G-APPROVER open); refused answers never decide; withdrawal
 *   runs on BOTH decide and expire paths; denied/expired end
 *   the saga with no trades and no proposals; approved ends at
 *   the gate (trading leg is S4).
 * - S3 compensation: every failed screen compensates through one
 *   call site (deadline / errored-terminated / unrecognized);
 *   stripe checkout → refund REQUEST (operator approval still
 *   required, execution stays operator-only), all else → credit;
 *   exactly one compensation per run (refund dedupe via the
 *   existing-record pre-check); denied/expired NEVER compensate
 *   (Q3 default: the screen was delivered); x402 never touches
 *   the refund path (Q9); a throwing compensate fails loud.
 */
import { describe, expect, it } from "vitest";
import {
  SAGA_JOURNEY_WAIT_MS_DEFAULT,
  SAGA_JOURNEY_WAIT_TIMEOUT,
  SAGA_PAYMENT_POLL_DEADLINE_MS_DEFAULT,
  SAGA_POLL_INTERVAL_MS_DEFAULT,
  SAGA_SCREEN_POLL_DEADLINE_MS_DEFAULT,
  runSagaWorkflowFlow,
  type SagaAuditEvent,
  type SagaDeps,
  type SagaParams,
  type SagaStep,
  type SagaWorkflowOutcome,
} from "../src/workflows/sagaWorkflowFlow";
import type {
  JourneyGatePrompt,
  JourneyPromptReceipts,
  JourneyWithdrawResult,
} from "../src/workflows/sagaJourneyGate";
import type { SagaRefundPorts } from "../src/workflows/sagaCompensation";
import {
  sagaLegInstanceId,
  sagaLegPort,
  type SagaLeg,
  type SagaLegInstanceStatus,
  type SagaLegPort,
} from "../src/workflows/sagaLegPort";
import type { WorkflowBindingLike } from "../src/workflows/cfWorkflowAdapter";
import type { NativeCommercialAccount } from "../src/services/nativeMonetization";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";

const baseAccount: NativeCommercialAccount = {
  userId: "u1",
  email: "u1@example.com",
  tenantId: "t1",
  tier: "PayPerUse",
  creditsUSD: 0,
  includedRunsRemaining: 0,
};

const baseCommand: WorkflowJobCommand = {
  jobId: "job-1",
  type: "run-screen",
  source: "manual",
  trigger: "manual",
  userLogin: "u1login",
  shards: [],
  role: "parent",
};

function baseParams(over: Partial<SagaParams> = {}): SagaParams {
  return {
    sagaId: "saga-1",
    runRequestId: "run-1",
    userLogin: "u1login",
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    family: "goal",
    trigger: "manual",
    account: baseAccount,
    screenerCommand: baseCommand,
    rail: "stripe",
    pollIntervalMs: 1000,
    paymentPollDeadlineMs: 5000,
    screenPollDeadlineMs: 5000,
    ...over,
  };
}

/** Fake step: do executes immediately; sleep advances a virtual clock. */
function fakeStep(clock: { ms: number }): SagaStep {
  return {
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_name: string, ms: number): Promise<void> {
      clock.ms += ms;
    },
    // Default: no journey event queued — the gate expires (the
    // flow catches the throw). Gate tests override via gateStep.
    async waitForEvent(): Promise<{ payload: unknown }> {
      throw new Error("no journey event queued");
    },
  };
}

/** One queued waitForEvent answer: a payload, or a throw. */
type WaitScriptEntry = { payload: unknown } | { throws: Error };

/**
 * Fake step with a scripted journey-gate wait: each waitForEvent
 * consumes one entry (payload → resolved; throws → rejected).
 * waitCalls records every wait (name + options) for first-wins
 * pins. The queue never refills: exhaustion throws, so a test
 * that loops forever fails instead of hanging.
 */
function gateStep(
  clock: { ms: number },
  script: WaitScriptEntry[],
): SagaStep & { waitCalls: Array<{ name: string; options: { type: string; timeout?: string } }> } {
  const waitCalls: Array<{ name: string; options: { type: string; timeout?: string } }> = [];
  const queue = [...script];
  return {
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_name: string, ms: number): Promise<void> {
      clock.ms += ms;
    },
    async waitForEvent(
      name: string,
      options: { type: string; timeout?: string },
    ): Promise<{ payload: unknown }> {
      waitCalls.push({ name, options });
      const next = queue.shift();
      if (!next) throw new Error("waitForEvent script exhausted");
      if ("throws" in next) throw next.throws;
      return { payload: next.payload };
    },
    waitCalls,
  };
}

class FakeLegPort implements SagaLegPort {
  starts: Array<{ leg: SagaLeg; params: unknown }> = [];
  statusCalls: Array<{ leg: SagaLeg; workflowId: string }> = [];
  startResult: { workflowId: string; existing: boolean } = {
    workflowId: "pay-wf-1",
    existing: false,
  };
  startThrows?: Error;
  /** Queued statuses per leg:workflowId; exhausted queues stay "running". */
  statuses: Record<string, Array<SagaLegInstanceStatus | null>> = {};

  async startLeg(leg: SagaLeg, params: unknown): Promise<{ workflowId: string; existing: boolean }> {
    this.starts.push({ leg, params });
    if (this.startThrows) throw this.startThrows;
    return this.startResult;
  }

  async getLegStatus(leg: SagaLeg, workflowId: string): Promise<SagaLegInstanceStatus | null> {
    this.statusCalls.push({ leg, workflowId });
    const queue = this.statuses[`${leg}:${workflowId}`];
    if (!queue || queue.length === 0) return { status: "running" };
    return queue.shift()!;
  }
}

/** Minimal fake refund ports (working policy + store) for the S3 default path. */
function fakeRefundPorts() {
  const records: Array<Record<string, unknown>> = [];
  const store = {
    createRefund: async (input: Record<string, unknown>) => {
      const rec = { id: `refund-${records.length + 1}`, ...input };
      records.push(rec);
      return rec;
    },
    getRefund: async (id: string) => records.find((r) => r.id === id) ?? null,
    listRefunds: async (userId: string) => records.filter((r) => r.userId === userId),
    updateRefund: async (id: string, patch: Record<string, unknown>) => {
      const rec = records.find((r) => r.id === id);
      if (!rec) throw new Error(`No refund ${id}.`);
      Object.assign(rec, patch);
      return rec;
    },
  };
  const policy = {
    getPolicy: async () => ({
      windowDays: 30,
      approver: "operator_hitl",
      allowPartial: false,
      subscriptionFullEffect: "revoke_immediately",
      subscriptionPartialEffect: "keep_access",
      payPerRunEffect: "none",
      creditEffect: "none",
      updatedAtMs: 1,
    }),
    setPolicy: async () => {
      throw new Error("test: setPolicy unused");
    },
  };
  return { store, policy, records };
}

function depsFor(
  legPort: SagaLegPort,
  opts: {
    auditThrowsOnCall?: number;
    clock?: { ms: number };
    issueCredit?: SagaDeps["issueCredit"];
    getRefundPorts?: SagaDeps["getRefundPorts"];
    monetizationEnabled?: SagaDeps["monetizationEnabled"];
  } = {},
): {
  deps: SagaDeps;
  auditEvents: SagaAuditEvent[];
  clock: { ms: number };
  promptCalls: JourneyGatePrompt[];
  withdrawCalls: JourneyPromptReceipts[];
  issueCreditCalls: Array<{ runRequestId: string; priceUSD: number }>;
  depCalls: { refundPorts: number; monetization: number };
  refundPorts: ReturnType<typeof fakeRefundPorts>;
} {
  const auditEvents: SagaAuditEvent[] = [];
  const clock = opts.clock ?? { ms: 0 };
  const promptCalls: JourneyGatePrompt[] = [];
  const withdrawCalls: JourneyPromptReceipts[] = [];
  const issueCreditCalls: Array<{ runRequestId: string; priceUSD: number }> = [];
  const depCalls = { refundPorts: 0, monetization: 0 };
  const refundPorts = fakeRefundPorts();
  let call = 0;
  const deps: SagaDeps = {
    legPort,
    recordAudit: async (event: SagaAuditEvent) => {
      call += 1;
      if (opts.auditThrowsOnCall === call) {
        throw new Error("audit endpoint unavailable");
      }
      auditEvents.push(event);
    },
    deliverPrompts: async (prompt: JourneyGatePrompt): Promise<JourneyPromptReceipts> => {
      promptCalls.push(prompt);
      return { slackSkipped: "test: no Slack" };
    },
    withdrawPrompts: async (receipts: JourneyPromptReceipts): Promise<JourneyWithdrawResult> => {
      withdrawCalls.push(receipts);
      return { slack: "skipped", panel: "state-driven", chat: "state-driven" };
    },
    issueCredit:
      opts.issueCredit ??
      (async (runRequestId: string, priceUSD: number) => {
        issueCreditCalls.push({ runRequestId, priceUSD });
      }),
    getRefundPorts:
      opts.getRefundPorts ??
      (async () => {
        depCalls.refundPorts += 1;
        return refundPorts as unknown as SagaRefundPorts;
      }),
    monetizationEnabled:
      opts.monetizationEnabled ??
      (async () => {
        depCalls.monetization += 1;
        return true;
      }),
    nowMs: () => clock.ms,
  };
  return {
    deps,
    auditEvents,
    clock,
    promptCalls,
    withdrawCalls,
    issueCreditCalls,
    depCalls,
    refundPorts,
  };
}

function paymentStarted(screenerWorkflowId = "scr-wf-1"): SagaLegInstanceStatus {
  return {
    status: "complete",
    output: {
      status: "started",
      runRequestId: "run-1",
      paidVia: "stripe_checkout",
      screenerWorkflowId,
      // S3: the payment "started" outcome carries the gate price.
      priceUSD: 0.1,
    },
  };
}

function paymentOutcome(status: string): SagaLegInstanceStatus {
  return { status: "complete", output: { status, runRequestId: "run-1" } };
}

function collation(lifecycle: string): SagaLegInstanceStatus {
  return { status: "complete", output: { lifecycle } };
}

function auditTypes(events: SagaAuditEvent[]): string[] {
  return events.map((e) => e.type);
}

describe("saga flow fail-closed (S1, #2041)", () => {
  it("throws without userLogin (issue #1185: no default identity)", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock } = depsFor(legPort);
    await expect(
      runSagaWorkflowFlow(baseParams({ userLogin: "" }), deps, fakeStep(clock)),
    ).rejects.toThrow(/userLogin/);
    expect(legPort.starts).toHaveLength(0);
  });

  it("throws without userId, email, or tenantId", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock } = depsFor(legPort);
    await expect(
      runSagaWorkflowFlow(baseParams({ userId: "" }), deps, fakeStep(clock)),
    ).rejects.toThrow();
    await expect(
      runSagaWorkflowFlow(baseParams({ tenantId: "" }), deps, fakeStep(clock)),
    ).rejects.toThrow();
    expect(legPort.starts).toHaveLength(0);
  });

  it("throws on tenant mismatch between params and account", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock } = depsFor(legPort);
    await expect(
      runSagaWorkflowFlow(
        baseParams({ account: { ...baseAccount, tenantId: "other" } }),
        deps,
        fakeStep(clock),
      ),
    ).rejects.toThrow(/Tenant mismatch/);
  });

  it("throws for a non-goal family (goal-only, Q5 default)", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock } = depsFor(legPort);
    await expect(
      runSagaWorkflowFlow(
        baseParams({ family: "stock" as SagaParams["family"] }),
        deps,
        fakeStep(clock),
      ),
    ).rejects.toThrow(/goal-only/);
  });

  it("throws without a trigger or a valid screenerCommand jobId", async () => {
    const legPort = new FakeLegPort();
    const { deps, clock } = depsFor(legPort);
    await expect(
      runSagaWorkflowFlow(
        baseParams({ trigger: undefined as unknown as SagaParams["trigger"] }),
        deps,
        fakeStep(clock),
      ),
    ).rejects.toThrow();
    await expect(
      runSagaWorkflowFlow(
        baseParams({ screenerCommand: { ...baseCommand, jobId: "" } }),
        deps,
        fakeStep(clock),
      ),
    ).rejects.toThrow();
  });
});

describe("saga flow Leg 0/1 (S1, #2041) and gate entry (S2)", () => {
  it("started payment + completed screen reaches the gate; an owner approval ends journey_approved, and never starts a second screener", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [{ status: "running" }, paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [{ status: "running" }, collation("Completed")];
    const { deps, auditEvents, clock, promptCalls, withdrawCalls } = depsFor(legPort);
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" } },
    ]);
    const outcome: SagaWorkflowOutcome = await runSagaWorkflowFlow(
      baseParams(),
      deps,
      step,
    );
    expect(outcome.status).toBe("journey_approved");
    expect(outcome.code).toBe("SUCCESS_SAGA_JOURNEY_APPROVED");
    expect(outcome.screenerWorkflowId).toBe("scr-wf-1");
    expect(outcome.rail).toBe("stripe");
    // screen_completed is a milestone row now, NOT the terminal outcome.
    expect(auditTypes(auditEvents)).toEqual([
      "saga.started",
      "saga.payment_started",
      "saga.screen_completed",
      "saga.journey_prompted",
      "saga.journey_decided",
      "saga.ended",
      "saga.journey_prompts_withdrawn",
    ]);
    const decided = auditEvents.find((e) => e.type === "saga.journey_decided");
    expect(decided?.decidingSurface).toBe("slack");
    expect(decided?.decision).toBe("approved");
    // The gate ran exactly once, with the ruled 24h provider timeout.
    expect(step.waitCalls).toHaveLength(1);
    expect(step.waitCalls[0].name).toBe("await-journey-decision");
    expect(step.waitCalls[0].options.type).toBe("saga-journey-decision");
    expect(step.waitCalls[0].options.timeout).toBe("24 hours");
    // Prompts delivered, then withdrawn after the decision.
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0].sagaId).toBe("saga-1");
    expect(withdrawCalls).toHaveLength(1);
    // Exactly one leg start (payment); the screener is observed, never started.
    expect(legPort.starts).toHaveLength(1);
    expect(legPort.starts[0].leg).toBe("payment");
    const paymentParams = legPort.starts[0].params as Record<string, unknown>;
    expect(paymentParams["runRequestId"]).toBe("run-1");
    expect(paymentParams["family"]).toBe("goal");
    expect(paymentParams["account"]).toBe(baseAccount);
    expect(paymentParams["screenerCommand"]).toBe(baseCommand);
    // The screen was observed through the payment outcome's id, not a new start.
    expect(legPort.statusCalls.some((c) => c.leg === "screener" && c.workflowId === "scr-wf-1")).toBe(true);
  });

  it("ReportGenerated collation also reaches the gate; a denial ends journey_denied with no trades", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("ReportGenerated")];
    const { deps, auditEvents, clock, withdrawCalls } = depsFor(legPort);
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "denied", deciderLogin: "u1login", surface: "panel" } },
    ]);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, step);
    expect(outcome.status).toBe("journey_denied");
    expect(outcome.code).toBe("FAILURE_SAGA_JOURNEY_DENIED");
    expect(auditTypes(auditEvents)).toEqual([
      "saga.started",
      "saga.payment_started",
      "saga.screen_completed",
      "saga.journey_prompted",
      "saga.journey_decided",
      "saga.ended",
      "saga.journey_prompts_withdrawn",
    ]);
    // Denied ends the saga: no trading leg start, no second screener, prompts withdrawn.
    expect(legPort.starts).toHaveLength(1);
    expect(withdrawCalls).toHaveLength(1);
  });

  it.each(["payment_required", "coverage_required", "approval_rejected", "expired"])(
    "payment outcome %s ends payment_not_completed without touching the screen",
    async (paymentStatus) => {
      const legPort = new FakeLegPort();
      legPort.statuses["payment:pay-wf-1"] = [paymentOutcome(paymentStatus)];
      const { deps, auditEvents, clock } = depsFor(legPort);
      const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
      expect(outcome.status).toBe("payment_not_completed");
      expect(outcome.code).toBe("FAILURE_SAGA_PAYMENT_NOT_COMPLETED");
      expect(auditTypes(auditEvents)).toEqual([
        "saga.started",
        "saga.payment_not_completed",
        "saga.ended",
      ]);
      expect(legPort.statusCalls.some((c) => c.leg === "screener")).toBe(false);
    },
  );

  it("payment start-failure credit passes through without re-issue by the saga", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [
      { status: "complete", output: { status: "screener_failed_credit_issued", runRequestId: "run-1", screenerError: "port unavailable" } },
    ];
    const { deps, auditEvents, clock, issueCreditCalls, depCalls } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("screen_start_failed_credit_issued");
    expect(outcome.code).toBe("FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED");
    if (outcome.status === "screen_start_failed_credit_issued") {
      expect(outcome.screenerError).toBe("port unavailable");
    }
    expect(auditTypes(auditEvents)).toEqual([
      "saga.started",
      "saga.screen_start_failed_credit_issued",
      "saga.ended",
    ]);
    // The payment leg already issued the credit; the saga records
    // it and does NOT re-issue — S3's issueCredit dep stays unused
    // on this path, and the refund path is never consulted.
    expect(issueCreditCalls).toHaveLength(0);
    expect(depCalls.refundPorts).toBe(0);
    expect("issueFailureCredit" in deps).toBe(false);
  });

  it("errored/terminated payment leg ends payment_not_completed", async () => {
    for (const raw of ["errored", "terminated"] as const) {
      const legPort = new FakeLegPort();
      legPort.statuses["payment:pay-wf-1"] = [{ status: raw }];
      const { deps, clock } = depsFor(legPort);
      const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
      expect(outcome.status).toBe("payment_not_completed");
      if (outcome.status === "payment_not_completed") {
        expect(outcome.reason).toBe(`payment_leg_${raw}`);
      }
    }
  });

  it("payment deadline exceeded ends payment_not_completed (never hangs)", async () => {
    const legPort = new FakeLegPort();
    // Statuses never leave "running": the virtual clock runs past the deadline.
    const { deps, clock } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("payment_not_completed");
    if (outcome.status === "payment_not_completed") {
      expect(outcome.reason).toBe("payment_deadline_exceeded");
    }
  });

  it("unrecognized payment output ends payment_not_completed, never a fake started", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [{ status: "complete", output: {} }];
    const { deps, clock } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("payment_not_completed");
    if (outcome.status === "payment_not_completed") {
      expect(outcome.reason).toBe("payment_output_unrecognized");
    }
    const legPort2 = new FakeLegPort();
    legPort2.statuses["payment:pay-wf-1"] = [
      { status: "complete", output: { status: "started", runRequestId: "run-1" } },
    ];
    const second = depsFor(legPort2);
    const outcome2 = await runSagaWorkflowFlow(baseParams(), second.deps, fakeStep(second.clock));
    expect(outcome2.status).toBe("payment_not_completed");
  });

  it("Failed collation lifecycle ends screen_failed_refund_requested (instance complete is not screen success)", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Failed")];
    const { deps, auditEvents, clock, refundPorts } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("screen_failed_refund_requested");
    expect(outcome.code).toBe("FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED");
    if (outcome.status === "screen_failed_refund_requested") {
      expect(outcome.reason).toBe("screen_failed");
      expect(outcome.compensationForm).toBe("refund-request");
      expect(outcome.refundId).toMatch(/^refund-/);
      expect(outcome.refundId).toBe((refundPorts.records[0] as { id: string }).id);
    }
    expect(auditTypes(auditEvents)).toEqual([
      "saga.started",
      "saga.payment_started",
      "saga.screen_failed",
      "saga.ended",
    ]);
    const failed = auditEvents.find((e) => e.type === "saga.screen_failed");
    expect(failed?.compensationForm).toBe("refund-request");
    expect(failed?.paidAtMsSource).toBe("leg0_completion");
    const ended = auditEvents.find((e) => e.type === "saga.ended");
    expect(ended?.outcomeCode).toBe("FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED");
    // Exactly one compensation for the run (one refund record).
    expect(refundPorts.records).toHaveLength(1);
  });

  it("screen errored/terminated/deadline/unrecognized-output all compensate under S3 (no uncompensated screen_failed)", async () => {
    const cases: Array<{ statuses: SagaLegInstanceStatus[]; reason: string }> = [
      { statuses: [{ status: "errored" }], reason: "screen_leg_errored" },
      { statuses: [{ status: "terminated" }], reason: "screen_leg_terminated" },
      { statuses: [], reason: "screen_deadline_exceeded" },
      { statuses: [{ status: "complete", output: {} }], reason: "screen_output_unrecognized" },
    ];
    for (const c of cases) {
      const legPort = new FakeLegPort();
      legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
      legPort.statuses["screener:scr-wf-1"] = c.statuses;
      const { deps, clock, refundPorts } = depsFor(legPort);
      const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
      expect(outcome.status).toBe("screen_failed_refund_requested");
      expect(outcome.code).toBe("FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED");
      if (outcome.status === "screen_failed_refund_requested") {
        expect(outcome.reason).toBe(c.reason);
        expect(outcome.compensationForm).toBe("refund-request");
      }
      expect(refundPorts.records).toHaveLength(1);
    }
  });

  it("x402 screen failure issues credit without consulting the refund path (Q9)", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [
      {
        status: "complete",
        output: {
          status: "started",
          runRequestId: "run-1",
          paidVia: "x402",
          screenerWorkflowId: "scr-wf-1",
          priceUSD: 0.1,
        },
      },
    ];
    legPort.statuses["screener:scr-wf-1"] = [{ status: "errored" }];
    const { deps, clock, issueCreditCalls, depCalls } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(
      baseParams({ rail: "x402" }),
      deps,
      fakeStep(clock),
    );
    expect(outcome.status).toBe("screen_failed_credit_issued");
    expect(outcome.code).toBe("FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED");
    if (outcome.status === "screen_failed_credit_issued") {
      expect(outcome.compensationForm).toBe("credit");
      expect(outcome.creditRunId).toBe("run-1");
      expect(outcome.fallbackReason).toBeUndefined();
    }
    expect(issueCreditCalls).toEqual([{ runRequestId: "run-1", priceUSD: 0.1 }]);
    expect(depCalls.refundPorts).toBe(0);
    expect(depCalls.monetization).toBe(0);
  });

  it("unbound refund ports fall back to credit with the reason recorded (S3)", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [{ status: "errored" }];
    const { deps, clock, issueCreditCalls } = depsFor(legPort, {
      getRefundPorts: async () => null,
    });
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("screen_failed_credit_issued");
    expect(outcome.code).toBe("FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED");
    if (outcome.status === "screen_failed_credit_issued") {
      expect(outcome.fallbackReason).toMatch(/ports/i);
    }
    expect(issueCreditCalls).toHaveLength(1);
  });

  it("journey denied and expired never compensate (Q3 default: the screen was delivered)", async () => {
    // Denied path: owner denies at the gate after a completed screen.
    const deniedPort = new FakeLegPort();
    deniedPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    deniedPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const denied = depsFor(deniedPort);
    const deniedOutcome = await runSagaWorkflowFlow(
      baseParams(),
      denied.deps,
      gateStep(denied.clock, [
        {
          payload: {
            sagaId: "saga-1",
            decision: "denied",
            deciderLogin: "u1login",
            surface: "panel",
          },
        },
      ]),
    );
    expect(deniedOutcome.status).toBe("journey_denied");
    expect(denied.issueCreditCalls).toHaveLength(0);
    expect(denied.depCalls.refundPorts).toBe(0);
    // Expired path: no decision arrives before the wait ends.
    const expiredPort = new FakeLegPort();
    expiredPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    expiredPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const expired = depsFor(expiredPort);
    const expiredOutcome = await runSagaWorkflowFlow(
      baseParams(),
      expired.deps,
      fakeStep(expired.clock),
    );
    expect(expiredOutcome.status).toBe("journey_expired");
    expect(expired.issueCreditCalls).toHaveLength(0);
    expect(expired.depCalls.refundPorts).toBe(0);
  });

  it("a throwing compensate fails loud: no terminal outcome, no saga.ended", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [
      {
        status: "complete",
        output: {
          status: "started",
          runRequestId: "run-1",
          paidVia: "x402",
          screenerWorkflowId: "scr-wf-1",
          priceUSD: 0.1,
        },
      },
    ];
    legPort.statuses["screener:scr-wf-1"] = [{ status: "errored" }];
    const { deps, auditEvents, clock } = depsFor(legPort, {
      issueCredit: async () => {
        throw new Error("ledger unavailable");
      },
    });
    await expect(runSagaWorkflowFlow(baseParams({ rail: "x402" }), deps, fakeStep(clock))).rejects.toThrow(
      /ledger unavailable/,
    );
    expect(auditTypes(auditEvents)).not.toContain("saga.ended");
  });

  it("an audit-write failure propagates: the saga never completes unrecorded", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const { deps, auditEvents, clock } = depsFor(legPort, { auditThrowsOnCall: 2 });
    await expect(runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock))).rejects.toThrow(
      /audit endpoint unavailable/,
    );
    // Only the saga.started row landed; no terminal outcome was produced.
    expect(auditTypes(auditEvents)).toEqual(["saga.started"]);
  });

  it("a re-run with the same sagaId adopts the existing payment instance (G-REPLAY)", async () => {
    const legPort = new FakeLegPort();
    legPort.startResult = { workflowId: "pay-wf-1", existing: true };
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const { deps, auditEvents, clock } = depsFor(legPort);
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "chat" } },
    ]);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, step);
    expect(outcome.status).toBe("journey_approved");
    expect(legPort.starts).toHaveLength(1);
    const startedEvent = auditEvents.find((e) => e.type === "saga.payment_started");
    expect(startedEvent?.existing).toBe(true);
  });

  it("polls across sleeps until terminal (no busy loop, no single-shot read)", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [
      { status: "running" },
      { status: "running" },
      paymentStarted(),
    ];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const { deps, clock } = depsFor(legPort);
    let sleeps = 0;
    const countingStep: SagaStep = {
      async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
        return fn();
      },
      async sleep(_name: string, ms: number): Promise<void> {
        sleeps += 1;
        clock.ms += ms;
      },
      // Gate reached with no queued answer: expires (assertions
      // here cover only the poll loop, not the gate outcome).
      async waitForEvent(): Promise<{ payload: unknown }> {
        throw new Error("no journey event queued");
      },
    };
    await runSagaWorkflowFlow(baseParams(), deps, countingStep);
    expect(legPort.statusCalls.filter((c) => c.leg === "payment")).toHaveLength(3);
    expect(sleeps).toBeGreaterThanOrEqual(3);
    expect(clock.ms).toBeGreaterThanOrEqual(3000);
  });

  it("carries the rail in the outcome and the audit rows (no S1 compensation behavior)", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const { deps, auditEvents, clock } = depsFor(legPort);
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "panel" } },
    ]);
    const outcome = await runSagaWorkflowFlow(baseParams({ rail: "x402" }), deps, step);
    expect(outcome.rail).toBe("x402");
    expect(auditEvents.every((e) => e.rail === "x402")).toBe(true);
  });

  it("exposes the S1/S2 working defaults (Q2 stays open: Venus may change them)", () => {
    expect(SAGA_POLL_INTERVAL_MS_DEFAULT).toBe(30_000);
    expect(SAGA_PAYMENT_POLL_DEADLINE_MS_DEFAULT).toBe(25 * 60 * 60 * 1000);
    expect(SAGA_SCREEN_POLL_DEADLINE_MS_DEFAULT).toBe(60 * 60 * 1000);
    // S2: the journey wait is a working default, NOT a ruling (Q2 open).
    expect(SAGA_JOURNEY_WAIT_MS_DEFAULT).toBe(24 * 60 * 60 * 1000);
    expect(SAGA_JOURNEY_WAIT_TIMEOUT).toBe("24 hours");
  });
});

describe("saga flow Leg 2 journey gate (S2, #2041)", () => {
  /** A completed paid screen, ready to enter the gate. */
  function completedScreen(over: Partial<SagaParams> = {}) {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    const bundle = depsFor(legPort);
    return { legPort, params: baseParams(over), ...bundle };
  }

  it("a wait throw ends journey_expired, and prompts are still withdrawn", async () => {
    const { legPort, params, deps, auditEvents, clock, withdrawCalls } = completedScreen();
    const outcome = await runSagaWorkflowFlow(params, deps, fakeStep(clock));
    expect(outcome.status).toBe("journey_expired");
    expect(outcome.code).toBe("FAILURE_SAGA_JOURNEY_EXPIRED");
    expect(auditTypes(auditEvents)).toEqual([
      "saga.started",
      "saga.payment_started",
      "saga.screen_completed",
      "saga.journey_prompted",
      "saga.journey_expired",
      "saga.ended",
      "saga.journey_prompts_withdrawn",
    ]);
    // Expired ends the saga: no trading leg start, prompts withdrawn.
    expect(legPort.starts).toHaveLength(1);
    expect(withdrawCalls).toHaveLength(1);
  });

  it("a zero wait window expires without waiting (deadline is honored, not looped)", async () => {
    const { params, deps, auditEvents, clock, promptCalls, withdrawCalls } = completedScreen({
      journeyWaitMs: 0,
    });
    const step = gateStep(clock, []);
    const outcome = await runSagaWorkflowFlow(params, deps, step);
    expect(outcome.status).toBe("journey_expired");
    expect(step.waitCalls).toHaveLength(0);
    expect(promptCalls).toHaveLength(1);
    expect(withdrawCalls).toHaveLength(1);
    expect(auditTypes(auditEvents)).toContain("saga.journey_expired");
  });

  it("a non-owner answer is refused and never decides; the owner answer then decides", async () => {
    const { deps, auditEvents, clock } = completedScreen();
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "denied", deciderLogin: "someone-else", surface: "slack" } },
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "panel" } },
    ]);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, step);
    expect(outcome.status).toBe("journey_approved");
    const refused = auditEvents.filter((e) => e.type === "saga.journey_decision_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].refusalReason).toBe("non_owner_decider");
    const decided = auditEvents.filter((e) => e.type === "saga.journey_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0].decidingSurface).toBe("panel");
    expect(step.waitCalls).toHaveLength(2);
  });

  it("a malformed answer is refused and never decides; the owner answer then decides", async () => {
    const { deps, auditEvents, clock } = completedScreen();
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "maybe", deciderLogin: "u1login", surface: "chat" } },
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "chat" } },
    ]);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, step);
    expect(outcome.status).toBe("journey_approved");
    const refused = auditEvents.filter((e) => e.type === "saga.journey_decision_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].refusalReason).toBe("malformed_decision_value");
  });

  it("an answer for another saga is refused and never decides", async () => {
    const { deps, auditEvents, clock } = completedScreen();
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-other", decision: "denied", deciderLogin: "u1login", surface: "slack" } },
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" } },
    ]);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, step);
    expect(outcome.status).toBe("journey_approved");
    const refused = auditEvents.filter((e) => e.type === "saga.journey_decision_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].refusalReason).toBe("saga_id_mismatch");
  });

  it("first answer wins: a second queued decision is never consumed", async () => {
    const { deps, auditEvents, clock } = completedScreen();
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" } },
      { payload: { sagaId: "saga-1", decision: "denied", deciderLogin: "u1login", surface: "panel" } },
    ]);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, step);
    expect(outcome.status).toBe("journey_approved");
    expect(step.waitCalls).toHaveLength(1);
    expect(auditEvents.filter((e) => e.type === "saga.journey_decided")).toHaveLength(1);
  });

  it("pre-gate outcomes never deliver or withdraw prompts", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentOutcome("payment_required")];
    const { deps, clock, promptCalls, withdrawCalls } = depsFor(legPort);
    const outcome = await runSagaWorkflowFlow(baseParams(), deps, fakeStep(clock));
    expect(outcome.status).toBe("payment_not_completed");
    expect(promptCalls).toHaveLength(0);
    expect(withdrawCalls).toHaveLength(0);
  });

  it("an audit-write failure at the prompted row propagates before any prompt is delivered", async () => {
    const legPort = new FakeLegPort();
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    // Calls: 1 started, 2 payment_started, 3 screen_completed, 4 prompted.
    const { deps, auditEvents, clock, promptCalls } = depsFor(legPort, { auditThrowsOnCall: 4 });
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" } },
    ]);
    await expect(runSagaWorkflowFlow(baseParams(), deps, step)).rejects.toThrow(
      /audit endpoint unavailable/,
    );
    expect(auditTypes(auditEvents)).toEqual([
      "saga.started",
      "saga.payment_started",
      "saga.screen_completed",
    ]);
    expect(promptCalls).toHaveLength(0);
  });

  it("the delivered gate copy states leg entry, not trade approval, plus the rail policy", async () => {
    const { deps, clock, promptCalls } = completedScreen();
    const step = gateStep(clock, [
      { payload: { sagaId: "saga-1", decision: "approved", deciderLogin: "u1login", surface: "slack" } },
    ]);
    await runSagaWorkflowFlow(baseParams(), deps, step);
    expect(promptCalls).toHaveLength(1);
    const copy = promptCalls[0].copy;
    expect(copy.title).toBe("Enter the trading leg?");
    expect(copy.body).toContain("ENTERING the trading leg");
    expect(copy.body).toContain("NOT approval of any trade");
    expect(copy.compensationLine).toContain("refund");
    expect(promptCalls[0].sagaId).toBe("saga-1");
    expect(promptCalls[0].runRequestId).toBe("run-1");
    expect(promptCalls[0].rail).toBe("stripe");
  });
});

describe("saga leg port (S1, #2041, gap G-OBS)", () => {
  class FakeBinding implements WorkflowBindingLike {
    creates: Array<{ id: string; params: unknown }> = [];
    gets: string[] = [];
    createBehavior: (id: string) => Promise<{ id: string }> = async (id) => ({ id });
    getBehavior: (id: string) => Promise<{ status: () => Promise<{ status: string; output?: unknown; error?: { message: string } }> }> = async (id) => ({
      status: async () => ({ status: "running" }),
    });

    async create(options: { id: string; params: unknown }): Promise<{ id: string }> {
      this.creates.push(options);
      return this.createBehavior(options.id);
    }

    async get(id: string): Promise<{ id: string; status: () => Promise<{ status: string; output?: unknown; error?: { message: string } }> }> {
      this.gets.push(id);
      const inner = await this.getBehavior(id);
      return { id, status: inner.status };
    }
  }

  it("starts a leg under its derived id", async () => {
    const binding = new FakeBinding();
    const port = sagaLegPort({ PAYMENT_WORKFLOW: binding }, "saga-1");
    const res = await port.startLeg("payment", { runRequestId: "run-1" });
    expect(res).toEqual({ workflowId: "saga-payment-saga-1", existing: false });
    expect(binding.creates).toHaveLength(1);
    expect(binding.creates[0].id).toBe("saga-payment-saga-1");
  });

  it("adopts the existing instance when create reports the id taken", async () => {
    const binding = new FakeBinding();
    binding.createBehavior = async () => {
      throw new Error("id taken");
    };
    const port = sagaLegPort({ PAYMENT_WORKFLOW: binding }, "saga-1");
    const res = await port.startLeg("payment", {});
    expect(res).toEqual({ workflowId: "saga-payment-saga-1", existing: true });
    expect(binding.gets).toEqual(["saga-payment-saga-1"]);
    expect(binding.creates).toHaveLength(1);
  });

  it("falls back to a hashed id when neither create nor adopt works, else throws the original error", async () => {
    const binding = new FakeBinding();
    binding.createBehavior = async (id) => {
      if (id.startsWith("saga-h-")) return { id };
      throw new Error("provider outage");
    };
    binding.getBehavior = async () => {
      throw new Error("no such instance");
    };
    const port = sagaLegPort({ PAYMENT_WORKFLOW: binding }, "saga-1");
    const res = await port.startLeg("payment", {});
    expect(res.existing).toBe(false);
    expect(res.workflowId.startsWith("saga-h-")).toBe(true);
    expect(res.workflowId.length).toBeLessThanOrEqual(100);
    expect(binding.creates).toHaveLength(2);

    const failing = new FakeBinding();
    failing.createBehavior = async () => {
      throw new Error("provider outage");
    };
    failing.getBehavior = async () => {
      throw new Error("no such instance");
    };
    const failingPort = sagaLegPort({ PAYMENT_WORKFLOW: failing }, "saga-1");
    await expect(failingPort.startLeg("payment", {})).rejects.toThrow(/provider outage/);
  });

  it("fails loud on an absent binding (never burns a poll deadline on misconfiguration)", async () => {
    const port = sagaLegPort({}, "saga-1");
    await expect(port.startLeg("payment", {})).rejects.toThrow(/PAYMENT_WORKFLOW.*not configured/);
    await expect(port.getLegStatus("screener", "scr-wf-1")).rejects.toThrow(
      /SCREENER_WORKFLOW.*not configured/,
    );
  });

  it("maps instance statuses and returns null for a missing instance", async () => {
    const binding = new FakeBinding();
    binding.getBehavior = async (id) => {
      if (id === "gone") throw new Error("not found");
      if (id === "weird") return { status: async () => ({ status: "bogus" }) };
      return { status: async () => ({ status: "complete", output: { lifecycle: "Completed" } }) };
    };
    const port = sagaLegPort({ SCREENER_WORKFLOW: binding }, "saga-1");
    expect(await port.getLegStatus("screener", "scr-wf-1")).toEqual({
      status: "complete",
      output: { lifecycle: "Completed" },
    });
    expect(await port.getLegStatus("screener", "weird")).toEqual({ status: "unknown" });
    expect(await port.getLegStatus("screener", "gone")).toBeNull();
  });
});

describe("saga leg instance ids (S1, #2041, gap G-SAGA-ID)", () => {
  it("derives deterministic, readable ids for short saga ids", () => {
    expect(sagaLegInstanceId("saga-1", "payment")).toBe("saga-payment-saga-1");
    expect(sagaLegInstanceId("saga-1", "payment")).toBe(sagaLegInstanceId("saga-1", "payment"));
    expect(sagaLegInstanceId("saga-1", "screener")).toBe("saga-screener-saga-1");
    expect(sagaLegInstanceId("saga-1", "payment")).not.toBe(sagaLegInstanceId("saga-1", "screener"));
  });

  it("sanitizes to provider-safe characters (no raw concatenation)", () => {
    const id = sagaLegInstanceId("saga:1/abc def@example", "payment");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id).toContain("saga-payment-");
    expect(id).not.toContain(":");
    expect(id).not.toContain("/");
  });

  it("pins the exact hashed form for a fixed long saga id (computed from the implementation, never guessed)", () => {
    const long = "saga-".repeat(40);
    expect(sagaLegInstanceId(long, "payment")).toBe("saga-h-692f3cdd48705c11306ae43a23fddf84");
    expect(sagaLegInstanceId(long, "screener")).toBe("saga-h-a8ae2af36a6bb6aa9da2516ba48253ed");
    expect(sagaLegInstanceId(long, "trade")).toBe("saga-h-092dc11356f8e0b9645b1d165af9a254");
  });

  it("hashes long saga ids down under the 100-character ceiling", () => {
    const long = "saga-".repeat(40);
    const id = sagaLegInstanceId(long, "payment");
    expect(id.startsWith("saga-h-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id).toBe(sagaLegInstanceId(long, "payment"));
    expect(id).not.toBe(sagaLegInstanceId(long, "screener"));
  });
});
