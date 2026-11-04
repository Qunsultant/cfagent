/**
 * Issue #2991 (#2770 Phase A) — journey gate as a standalone
 * capability, extracted from the saga flow's embedded runJourneyGate
 * with behavior verbatim: decision surfaces, first-answer-wins,
 * deciding-surface attribution, stale-prompt cleanup, waitForEvent
 * waits, email notification-only (the prompt itself never decides
 * by email — email is a notice channel, not a decision surface).
 *
 * The capability performs prompted audit, prompt delivery, the
 * wait loop with refused audits, and the approved milestone audit
 * — then RETURNS, leaving terminal sequencing to the caller:
 *
 *   - approved: the caller withdraws prompts, then continues
 *     (the saga's trade leg). The decided row is a MILESTONE,
 *     not a terminal.
 *   - denied / expired: the caller ends the saga (endSaga records
 *     the terminal row + notice + ended), then withdraws.
 *
 * Step names and audit order are preserved exactly, so the saga's
 * existing tests pin this capability through the flow unchanged.
 */

import {
  buildJourneyGatePrompt,
  parseJourneyDecision,
  type JourneyGatePrompt,
  type JourneyPromptReceipts,
  type JourneyWithdrawResult,
  type SagaJourneyDecision,
} from "./sagaJourneyGate";
import type { SagaAuditEvent } from "./sagaWorkflowFlow";

/** The step surface the gate needs: do + waitForEvent only. */
export interface JourneyGateStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string },
  ): Promise<{ payload: unknown }>;
}

export interface JourneyGateCapabilityDeps {
  sagaId: string;
  runRequestId: string;
  family: string;
  rail?: "stripe" | "x402";
  userLogin: string;
  screenerWorkflowId: string;
  baseAudit: Omit<SagaAuditEvent, "type">;
  recordAudit: (event: SagaAuditEvent) => Promise<void>;
  deliverPrompts: (prompt: JourneyGatePrompt) => Promise<JourneyPromptReceipts>;
  withdrawPrompts: (
    receipts: JourneyPromptReceipts,
  ) => Promise<JourneyWithdrawResult>;
  nowMs: () => number;
  journeyWaitMs: number;
  journeyWaitTimeout: string;
}

export type JourneyGateCapabilityResult =
  | {
      kind: "approved";
      decision: SagaJourneyDecision;
      withdraw: () => Promise<void>;
    }
  | {
      kind: "denied";
      decision: SagaJourneyDecision;
      withdraw: () => Promise<void>;
    }
  | { kind: "expired"; withdraw: () => Promise<void> };

export async function runJourneyGateCapability(
  deps: JourneyGateCapabilityDeps,
  step: JourneyGateStep,
): Promise<JourneyGateCapabilityResult> {
  const deadlineAt = deps.nowMs() + deps.journeyWaitMs;
  const prompt = buildJourneyGatePrompt(
    deps.sagaId,
    deps.runRequestId,
    deps.family,
    deps.rail,
  );
  await step.do("record-audit-journey-prompted", () =>
    deps.recordAudit({
      ...deps.baseAudit,
      type: "saga.journey_prompted",
      leg: "screener",
      screenerWorkflowId: deps.screenerWorkflowId,
    }),
  );
  const receipts = await step.do("deliver-journey-prompts", () =>
    deps.deliverPrompts(prompt),
  );

  const withdraw = async (): Promise<void> => {
    const result = await step.do("withdraw-journey-prompts", () =>
      deps.withdrawPrompts(receipts),
    );
    await step.do("record-audit-journey-prompts-withdrawn", () =>
      deps.recordAudit({
        ...deps.baseAudit,
        type: "saga.journey_prompts_withdrawn",
        screenerWorkflowId: deps.screenerWorkflowId,
        withdraw: result,
      }),
    );
  };

  let decision: SagaJourneyDecision | null = null;
  while (deps.nowMs() < deadlineAt) {
    let event: { payload: unknown };
    try {
      event = await step.waitForEvent("await-journey-decision", {
        type: "saga-journey-decision",
        timeout: deps.journeyWaitTimeout,
      });
    } catch {
      // Provider timeout or termination: no decision obtained.
      break;
    }
    const parsed = parseJourneyDecision(event.payload);
    if (!parsed.ok) {
      await step.do("record-audit-journey-decision-refused", () =>
        deps.recordAudit({
          ...deps.baseAudit,
          type: "saga.journey_decision_refused",
          screenerWorkflowId: deps.screenerWorkflowId,
          refusalReason: parsed.reason,
        }),
      );
      continue;
    }
    if (parsed.decision.sagaId !== deps.sagaId) {
      // A decision for another saga must never decide this one.
      await step.do("record-audit-journey-decision-refused", () =>
        deps.recordAudit({
          ...deps.baseAudit,
          type: "saga.journey_decision_refused",
          screenerWorkflowId: deps.screenerWorkflowId,
          refusalReason: "saga_id_mismatch",
        }),
      );
      continue;
    }
    if (parsed.decision.deciderLogin !== deps.userLogin) {
      await step.do("record-audit-journey-decision-refused", () =>
        deps.recordAudit({
          ...deps.baseAudit,
          type: "saga.journey_decision_refused",
          screenerWorkflowId: deps.screenerWorkflowId,
          refusalReason: "non_owner_decider",
        }),
      );
      continue;
    }
    decision = parsed.decision;
    break;
  }

  if (decision === null) {
    return { kind: "expired", withdraw };
  }

  if (decision.decision === "denied") {
    return { kind: "denied", decision, withdraw };
  }

  // Approval is a MILESTONE, not a terminal. The decided row is
  // recorded (not via endSaga — the saga does not end here);
  // prompts are withdrawn by the caller, and the flow continues
  // to the trade leg. The saga ends at the TRADE outcome.
  await step.do("record-audit-journey-decided-approved", () =>
    deps.recordAudit({
      ...deps.baseAudit,
      type: "saga.journey_decided",
      decidingSurface: decision.surface,
      decision: "approved",
      screenerWorkflowId: deps.screenerWorkflowId,
      outcomeCode: "SUCCESS_SAGA_JOURNEY_APPROVED",
    }),
  );
  return { kind: "approved", decision, withdraw };
}
