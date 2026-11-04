/**
 * Issue #2991 (#2770 Phase A) — journey gate as a standalone
 * capability: the flow's embedded runJourneyGate, extracted verbatim
 * in behavior. The capability performs prompted audit, prompt
 * delivery, the wait loop with refused audits, and the approved
 * milestone audit — then returns, leaving terminal sequencing
 * (endSaga) and prompt withdrawal to the caller. Step names and
 * audit order are preserved exactly.
 */
import { describe, expect, it } from "vitest";
import {
  runJourneyGateCapability,
  type JourneyGateCapabilityDeps,
  type JourneyGateStep,
} from "../src/workflows/journeyGateCapability";
import type { SagaAuditEvent } from "../src/workflows/sagaWorkflowFlow";
import type {
  JourneyGatePrompt,
  JourneyPromptReceipts,
  JourneyWithdrawResult,
} from "../src/workflows/sagaJourneyGate";

function fakeStep(opts: {
  script: Array<{ payload: unknown } | { throws: Error }>;
  clock: { ms: number };
}): JourneyGateStep & { stepNames: string[]; waitCalls: number } {
  const stepNames: string[] = [];
  const queue = [...opts.script];
  let waitCalls = 0;
  return {
    stepNames,
    get waitCalls() {
      return waitCalls;
    },
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      stepNames.push(name);
      return fn();
    },
    async waitForEvent(
      name: string,
      _options: { type: string; timeout?: string },
    ): Promise<{ payload: unknown }> {
      stepNames.push(name);
      waitCalls += 1;
      const next = queue.shift();
      if (!next) throw new Error("waitForEvent script exhausted");
      if ("throws" in next) throw next.throws;
      return { payload: next.payload };
    },
  };
}

function depsFor(opts: {
  auditEvents: SagaAuditEvent[];
  clock: { ms: number };
  journeyWaitMs?: number;
}): {
  deps: JourneyGateCapabilityDeps;
  promptCalls: JourneyGatePrompt[];
  withdrawCalls: JourneyPromptReceipts[];
} {
  const promptCalls: JourneyGatePrompt[] = [];
  const withdrawCalls: JourneyPromptReceipts[] = [];
  const deps: JourneyGateCapabilityDeps = {
    sagaId: "saga-1",
    runRequestId: "run-1",
    family: "goal",
    rail: "stripe",
    userLogin: "u1login",
    screenerWorkflowId: "scr-wf-1",
    baseAudit: {
      sagaId: "saga-1",
      runRequestId: "run-1",
      tenantId: "t1",
      userLogin: "u1login",
      family: "goal",
      rail: "stripe",
    },
    recordAudit: async (event: SagaAuditEvent) => {
      opts.auditEvents.push(event);
    },
    deliverPrompts: async (
      prompt: JourneyGatePrompt,
    ): Promise<JourneyPromptReceipts> => {
      promptCalls.push(prompt);
      return { slackSkipped: "test: no Slack" };
    },
    withdrawPrompts: async (
      receipts: JourneyPromptReceipts,
    ): Promise<JourneyWithdrawResult> => {
      withdrawCalls.push(receipts);
      return { slack: "skipped", panel: "state-driven", chat: "state-driven" };
    },
    nowMs: () => opts.clock.ms,
    journeyWaitMs: opts.journeyWaitMs ?? 86_400_000,
    journeyWaitTimeout: "24 hours",
  };
  return { deps, promptCalls, withdrawCalls };
}

function auditTypes(events: SagaAuditEvent[]): string[] {
  return events.map((e) => e.type);
}

describe("journey gate capability #2991", () => {
  it("approved: prompted, decided milestone, then withdrawal on the caller's withdraw", async () => {
    const auditEvents: SagaAuditEvent[] = [];
    const clock = { ms: 0 };
    const { deps } = depsFor({ auditEvents, clock });
    const step = fakeStep({
      clock,
      script: [
        {
          payload: {
            sagaId: "saga-1",
            decision: "approved",
            deciderLogin: "u1login",
            surface: "panel",
          },
        },
      ],
    });
    const result = await runJourneyGateCapability(deps, step);
    expect(result.kind).toBe("approved");
    if (result.kind !== "approved") throw new Error("expected approved");
    expect(result.decision.surface).toBe("panel");
    // Milestone recorded; withdrawal NOT yet run — the caller owns it.
    expect(auditTypes(auditEvents)).toEqual([
      "saga.journey_prompted",
      "saga.journey_decided",
    ]);
    expect(
      auditEvents[1].outcomeCode,
    ).toBe("SUCCESS_SAGA_JOURNEY_APPROVED");
    await result.withdraw();
    expect(auditTypes(auditEvents)).toEqual([
      "saga.journey_prompted",
      "saga.journey_decided",
      "saga.journey_prompts_withdrawn",
    ]);
    expect(step.stepNames).toContain("await-journey-decision");
    expect(step.stepNames).toContain("record-audit-journey-prompted");
    expect(step.stepNames).toContain("record-audit-journey-decided-approved");
  });

  it("denied: prompted only from the capability; the caller ends the saga, then withdraws", async () => {
    const auditEvents: SagaAuditEvent[] = [];
    const clock = { ms: 0 };
    const { deps } = depsFor({ auditEvents, clock });
    const step = fakeStep({
      clock,
      script: [
        {
          payload: {
            sagaId: "saga-1",
            decision: "denied",
            deciderLogin: "u1login",
            surface: "slack",
          },
        },
      ],
    });
    const result = await runJourneyGateCapability(deps, step);
    expect(result.kind).toBe("denied");
    if (result.kind !== "denied") throw new Error("expected denied");
    expect(result.decision.surface).toBe("slack");
    // No terminal journey_decided row from the capability itself —
    // the caller's endSaga records it.
    expect(auditTypes(auditEvents)).toEqual(["saga.journey_prompted"]);
    await result.withdraw();
    expect(auditTypes(auditEvents)).toEqual([
      "saga.journey_prompted",
      "saga.journey_prompts_withdrawn",
    ]);
  });

  it("expired: a wait throw ends the wait with no decision", async () => {
    const auditEvents: SagaAuditEvent[] = [];
    const clock = { ms: 0 };
    const { deps } = depsFor({ auditEvents, clock });
    const step = fakeStep({
      clock,
      script: [{ throws: new Error("provider timeout") }],
    });
    const result = await runJourneyGateCapability(deps, step);
    expect(result.kind).toBe("expired");
    if (result.kind !== "expired") throw new Error("expected expired");
    expect(auditTypes(auditEvents)).toEqual(["saga.journey_prompted"]);
    await result.withdraw();
    expect(auditTypes(auditEvents)).toEqual([
      "saga.journey_prompted",
      "saga.journey_prompts_withdrawn",
    ]);
  });

  it("refused answers never decide: wrong saga, wrong decider, malformed — then approved", async () => {
    const auditEvents: SagaAuditEvent[] = [];
    const clock = { ms: 0 };
    const { deps } = depsFor({ auditEvents, clock });
    const step = fakeStep({
      clock,
      script: [
        {
          payload: {
            sagaId: "saga-other",
            decision: "approved",
            deciderLogin: "u1login",
            surface: "panel",
          },
        },
        {
          payload: {
            sagaId: "saga-1",
            decision: "approved",
            deciderLogin: "someone-else",
            surface: "panel",
          },
        },
        { payload: { nope: true } },
        {
          payload: {
            sagaId: "saga-1",
            decision: "approved",
            deciderLogin: "u1login",
            surface: "chat",
          },
        },
      ],
    });
    const result = await runJourneyGateCapability(deps, step);
    expect(result.kind).toBe("approved");
    const refusals = auditEvents.filter(
      (e) => e.type === "saga.journey_decision_refused",
    );
    expect(refusals.map((e) => e.refusalReason)).toEqual([
      "saga_id_mismatch",
      "non_owner_decider",
      // { nope: true } carries no sagaId: the parser's first
      // failure is malformed_saga_id, not the generic payload
      // reason (which fires only for non-object payloads).
      "malformed_saga_id",
    ]);
    expect(step.waitCalls).toBe(4);
  });
});
