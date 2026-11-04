/**
 * Issue #2991 (#2770 Phase A) — saga terminal finisher: the flow's
 * endSaga, extracted verbatim. Terminal audit row, outcome notice
 * AFTER the terminal row and BEFORE saga.ended, notice delivery
 * degrading to a failed receipt (never failing a recorded saga),
 * and the ending guard the flow's catch-all reads.
 */
import { describe, expect, it } from "vitest";
import { createSagaFinisher } from "../src/workflows/sagaTerminal";
import type {
  SagaAuditEvent,
  SagaWorkflowOutcome,
  SagaWorkflowStep,
} from "../src/workflows/sagaWorkflowFlow";

function fakeStep(): SagaWorkflowStep & { stepNames: string[] } {
  const stepNames: string[] = [];
  return {
    stepNames,
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      stepNames.push(name);
      return fn();
    },
    async sleep(): Promise<void> {},
    async waitForEvent(): Promise<{ payload: unknown }> {
      throw new Error("unused");
    },
  };
}

describe("saga terminal finisher #2991", () => {
  it("records terminal row, notice, ended — in that order — and returns the outcome verbatim", async () => {
    const auditEvents: SagaAuditEvent[] = [];
    const notices: unknown[] = [];
    const step = fakeStep();
    const finisher = createSagaFinisher(
      { sagaId: "saga-1", runRequestId: "run-1" },
      {
        recordAudit: async (event: SagaAuditEvent) => {
          auditEvents.push(event);
        },
        deliverNotice: async (notice: unknown) => {
          notices.push(notice);
          return { slack: "posted" };
        },
      },
      step,
      {
        sagaId: "saga-1",
        runRequestId: "run-1",
        tenantId: "t1",
        userLogin: "u1login",
        family: "goal",
        rail: "stripe",
      },
    );
    expect(finisher.isEnding()).toBe(false);
    const outcome: SagaWorkflowOutcome = {
      status: "journey_denied",
      code: "FAILURE_SAGA_JOURNEY_DENIED",
      sagaId: "saga-1",
      runRequestId: "run-1",
      screenerWorkflowId: "scr-wf-1",
      decidingSurface: "panel",
      rail: "stripe",
    };
    const returned = await finisher.endSaga(outcome, {
      type: "saga.journey_decided",
      decidingSurface: "panel",
      decision: "denied",
      screenerWorkflowId: "scr-wf-1",
      outcomeCode: "FAILURE_SAGA_JOURNEY_DENIED",
    });
    expect(returned).toBe(outcome);
    expect(finisher.isEnding()).toBe(true);
    expect(auditEvents.map((e) => e.type)).toEqual([
      "saga.journey_decided",
      "saga.outcome_notice",
      "saga.ended",
    ]);
    const ended = auditEvents[2];
    expect(ended.outcomeCode).toBe("FAILURE_SAGA_JOURNEY_DENIED");
    expect(ended.decidingSurface).toBe("panel");
    expect(notices).toHaveLength(1);
    const notice = notices[0] as Record<string, unknown>;
    // buildSagaOutcomeNotice names the code `code`, not
    // `outcomeCode` — the finisher passes the outcome code
    // through unchanged.
    expect(notice.code).toBe("FAILURE_SAGA_JOURNEY_DENIED");
    expect(notice.statusUrl).toBe("/api/saga/saga-1/status");
    expect(step.stepNames).toEqual([
      "record-audit-journey_denied",
      "deliver-outcome-notice",
      "record-audit-outcome-notice",
      "record-audit-saga-ended",
    ]);
  });

  it("a throwing notice delivery degrades to a failed receipt and the saga still ends", async () => {
    const auditEvents: SagaAuditEvent[] = [];
    const step = fakeStep();
    const finisher = createSagaFinisher(
      { sagaId: "saga-1", runRequestId: "run-1" },
      {
        recordAudit: async (event: SagaAuditEvent) => {
          auditEvents.push(event);
        },
        deliverNotice: async () => {
          throw new Error("Slack down");
        },
      },
      step,
      {
        sagaId: "saga-1",
        runRequestId: "run-1",
        tenantId: "t1",
        userLogin: "u1login",
        family: "goal",
        rail: "stripe",
      },
    );
    const outcome: SagaWorkflowOutcome = {
      status: "journey_expired",
      code: "FAILURE_SAGA_JOURNEY_EXPIRED",
      sagaId: "saga-1",
      runRequestId: "run-1",
      screenerWorkflowId: "scr-wf-1",
      rail: "stripe",
    };
    const returned = await finisher.endSaga(outcome, {
      type: "saga.journey_expired",
      screenerWorkflowId: "scr-wf-1",
      outcomeCode: "FAILURE_SAGA_JOURNEY_EXPIRED",
    });
    expect(returned).toBe(outcome);
    expect(auditEvents.map((e) => e.type)).toEqual([
      "saga.journey_expired",
      "saga.outcome_notice",
      "saga.ended",
    ]);
    const noticeRow = auditEvents[1].notice as Record<string, unknown>;
    expect(noticeRow.slack).toBe("failed");
    expect(String(noticeRow.slackDetail)).toContain("Slack down");
  });
});
