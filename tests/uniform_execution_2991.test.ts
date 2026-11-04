/**
 * Issue #2991 (#2770 Phase A) — uniform execution: the SAME
 * capability produces the SAME stages, records, messages, and
 * outcomes across execution modes. A mode changes only
 * timing/transport (wait vs poll, in-process vs queued), never
 * behavior. Where full unification needs another lane's work, the
 * dependency is NAMED here — not built as a parallel pipeline.
 *
 * The saga pair below is the proof at the flow level: immediate
 * leg completion vs delayed leg completion (several poll rounds)
 * must yield identical terminal outcomes, audit sequences, and
 * notices.
 */
import { describe, expect, it } from "vitest";
import {
  assertUniformRun,
  modeDifferenceReport,
  UNIFORMITY_DEPENDENCIES,
  type UniformRunTrace,
} from "../src/workflows/blocks/uniformExecution";
import {
  runSagaWorkflowFlow,
  type SagaAuditEvent,
  type SagaDeps,
  type SagaParams,
  type SagaStep,
} from "../src/workflows/sagaWorkflowFlow";
import type { SagaLeg, SagaLegInstanceStatus, SagaLegPort } from "../src/workflows/sagaLegPort";
import type {
  JourneyGatePrompt,
  JourneyPromptReceipts,
  JourneyWithdrawResult,
} from "../src/workflows/sagaJourneyGate";

class FakeLegPort implements SagaLegPort {
  statuses: Record<string, Array<SagaLegInstanceStatus | null>> = {};
  async startLeg(_leg: SagaLeg, _params: unknown) {
    return { workflowId: "pay-wf-1", existing: false };
  }
  async getLegStatus(leg: SagaLeg, workflowId: string) {
    const queue = this.statuses[`${leg}:${workflowId}`];
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }
}

function paymentStarted(): SagaLegInstanceStatus {
  return {
    status: "complete",
    output: {
      status: "started",
      runRequestId: "run-1",
      paidVia: "stripe_checkout",
      screenerWorkflowId: "scr-wf-1",
      priceUSD: 0.1,
    },
  };
}

function collation(lifecycle: string): SagaLegInstanceStatus {
  return { status: "complete", output: { lifecycle } };
}

async function runSaga(mode: "immediate" | "delayed"): Promise<{
  outcome: unknown;
  auditTypes: string[];
  notices: unknown[];
}> {
  const legPort = new FakeLegPort();
  if (mode === "immediate") {
    legPort.statuses["payment:pay-wf-1"] = [paymentStarted()];
    legPort.statuses["screener:scr-wf-1"] = [collation("Completed")];
    legPort.statuses["trade:pay-wf-1"] = [
      { status: "complete", output: { status: "settled", decision: "approved", orderId: "order-1" } },
    ];
  } else {
    legPort.statuses["payment:pay-wf-1"] = [
      { status: "running" },
      { status: "running" },
      paymentStarted(),
    ];
    legPort.statuses["screener:scr-wf-1"] = [
      { status: "running" },
      collation("Completed"),
    ];
    legPort.statuses["trade:pay-wf-1"] = [
      { status: "running" },
      { status: "complete", output: { status: "settled", decision: "approved", orderId: "order-1" } },
    ];
  }
  const auditEvents: SagaAuditEvent[] = [];
  const notices: unknown[] = [];
  const clock = { ms: 0 };
  const step: SagaStep = {
    async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_name: string, ms: number): Promise<void> {
      clock.ms += ms;
    },
    async waitForEvent(): Promise<{ payload: unknown }> {
      return {
        payload: {
          sagaId: "saga-1",
          decision: "approved",
          deciderLogin: "u1login",
          surface: "panel",
        },
      };
    },
  };
  const deps: SagaDeps = {
    legPort,
    recordAudit: async (event: SagaAuditEvent) => {
      auditEvents.push(event);
    },
    deliverPrompts: async (): Promise<JourneyPromptReceipts> => ({
      slackSkipped: "test: no Slack",
    }),
    withdrawPrompts: async (): Promise<JourneyWithdrawResult> => ({
      slack: "skipped",
      panel: "state-driven",
      chat: "state-driven",
    }),
    issueCredit: async () => {},
    getRefundPorts: async () => {
      throw new Error("unused");
    },
    monetizationEnabled: async () => true,
    proposeTrade: async () => ({ ok: true, orderId: "order-1" }),
    deliverNotice: async (notice: unknown) => {
      notices.push(notice);
      return { slack: "posted" };
    },
    nowMs: () => clock.ms,
  };
  const params: SagaParams = {
    sagaId: "saga-1",
    runRequestId: "run-1",
    userLogin: "u1login",
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    family: "goal",
    trigger: "manual",
    account: {
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
      tier: "PayPerUse",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    },
    screenerCommand: {
      jobId: "job-1",
      type: "run-screen",
      source: "manual",
      trigger: "manual",
      userLogin: "u1login",
      shards: [],
      role: "parent",
    },
    rail: "stripe",
    tradeIntent: {
      kind: "stock",
      symbol: "AAPL",
      action: "buy",
      quantity: 10,
      orderType: "market",
    },
    pollIntervalMs: 1000,
    paymentPollDeadlineMs: 60000,
    screenPollDeadlineMs: 60000,
    tradePollDeadlineMs: 60000,
  };
  const outcome = await runSagaWorkflowFlow(params, deps, step);
  return { outcome, auditTypes: auditEvents.map((e) => e.type), notices };
}

describe("uniform execution #2991", () => {
  it("immediate vs delayed leg completion yields identical outcomes, audits, and notices", async () => {
    const immediate = await runSaga("immediate");
    const delayed = await runSaga("delayed");
    expect(delayed.outcome).toEqual(immediate.outcome);
    expect(delayed.auditTypes).toEqual(immediate.auditTypes);
    expect(delayed.notices).toEqual(immediate.notices);
  });

  it("assertUniformRun passes a well-formed trace and modeDifferenceReport is empty for twins", () => {
    const a: UniformRunTrace = {
      mode: "immediate",
      stageIds: ["start", "poll", "decide", "settle"],
      recordKeys: ["runId", "outcome", "audit"],
      messageCodes: ["saga.started"],
      outcomeCode: "SUCCESS_SAGA_TRADE_SETTLED",
    };
    const b: UniformRunTrace = { ...a, mode: "delayed" };
    expect(() => assertUniformRun(a)).not.toThrow();
    expect(() => assertUniformRun(b)).not.toThrow();
    expect(modeDifferenceReport(a, b)).toEqual([]);
  });

  it("modeDifferenceReport names stage, record, and outcome divergences", () => {
    const a: UniformRunTrace = {
      mode: "sync",
      stageIds: ["start", "poll"],
      recordKeys: ["runId", "outcome"],
      messageCodes: [],
      outcomeCode: "SUCCESS_X",
    };
    const b: UniformRunTrace = {
      mode: "async",
      stageIds: ["start"],
      recordKeys: ["runId"],
      messageCodes: [],
      outcomeCode: "FAILURE_X",
    };
    const report = modeDifferenceReport(a, b);
    expect(report.some((r) => r.includes("poll"))).toBe(true);
    expect(report.some((r) => r.includes("outcome"))).toBe(true);
    expect(report.some((r) => r.includes("FAILURE_X"))).toBe(true);
  });

  it("assertUniformRun rejects traces missing stages, identity, or outcome", () => {
    const base: UniformRunTrace = {
      mode: "sync",
      stageIds: ["start"],
      recordKeys: ["runId", "outcome"],
      messageCodes: [],
      outcomeCode: "SUCCESS_X",
    };
    expect(() => assertUniformRun({ ...base, stageIds: [] })).toThrow(/stage/);
    expect(() => assertUniformRun({ ...base, recordKeys: ["outcome"] })).toThrow(/runId/);
    expect(() => assertUniformRun({ ...base, outcomeCode: "" })).toThrow(/outcome/);
  });

  it("uniformity dependencies are named with owner + blocking condition, not built", () => {
    for (const dep of UNIFORMITY_DEPENDENCIES) {
      expect(dep.id).toBeTruthy();
      expect(dep.owner).toBeTruthy();
      expect(dep.blocks).toBeTruthy();
      expect(dep.detail).toBeTruthy();
    }
    const ids = UNIFORMITY_DEPENDENCIES.map((d) => d.id);
    expect(ids).toContain("2869-runScreenInner-emission");
    expect(ids).toContain("goal-dispatch-migration");
    expect(ids).toContain("goal-work-onto-Q1");
  });
});
