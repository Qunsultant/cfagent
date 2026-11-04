/**
 * Issue #2991 (#2770 Phase A) — saga terminal finisher: the flow's
 * endSaga, extracted verbatim. Every terminal outcome is finished
 * the same way: terminal audit row, outcome notice AFTER the
 * terminal row and BEFORE saga.ended, and the ended row carrying
 * the outcome's fields. A throwing notice delivery degrades to a
 * failed receipt — the notice row is the visible record, and a
 * notice failure never fails a saga whose outcome is already
 * recorded.
 *
 * The `ending` guard lives here: the flow's catch-all reads
 * isEnding() to avoid double-recording when endSaga itself throws.
 */

import {
  buildSagaOutcomeNotice,
  type SagaOutcomeNotice,
  type SagaOutcomeNoticeReceipts,
} from "./sagaOutcomeNotice";
import type {
  SagaAuditEvent,
  SagaWorkflowOutcome,
  SagaWorkflowStep,
} from "./sagaWorkflowFlow";

export interface SagaFinisherDeps {
  recordAudit: (event: SagaAuditEvent) => Promise<void>;
  deliverNotice: (notice: SagaOutcomeNotice) => Promise<SagaOutcomeNoticeReceipts>;
}

export interface SagaFinisher {
  endSaga: (
    outcome: SagaWorkflowOutcome,
    terminalEvent: Omit<
      SagaAuditEvent,
      "sagaId" | "runRequestId" | "tenantId" | "userLogin" | "family" | "rail"
    >,
  ) => Promise<SagaWorkflowOutcome>;
  isEnding: () => boolean;
}

export function createSagaFinisher(
  identity: { sagaId: string; runRequestId: string },
  deps: SagaFinisherDeps,
  step: SagaWorkflowStep,
  baseAudit: Omit<SagaAuditEvent, "type">,
): SagaFinisher {
  let ending = false;

  const endSaga: SagaFinisher["endSaga"] = async (outcome, terminalEvent) => {
    ending = true;
    await step.do(`record-audit-${outcome.status}`, () =>
      deps.recordAudit({ ...baseAudit, ...terminalEvent }),
    );
    // S4 outcome notice: every terminal outcome is noticed
    // through existing channels AFTER its terminal audit row and
    // BEFORE saga.ended. A throwing dep degrades to a failed
    // receipt here (flow-level best-effort): the notice row is
    // the visible record, and a notice failure never fails a
    // saga whose outcome is already recorded.
    const notice = buildSagaOutcomeNotice({
      sagaId: identity.sagaId,
      runRequestId: identity.runRequestId,
      outcomeCode: outcome.code,
      statusUrl: `/api/saga/${identity.sagaId}/status`,
    });
    let noticeReceipts: SagaOutcomeNoticeReceipts;
    try {
      noticeReceipts = await step.do("deliver-outcome-notice", () =>
        deps.deliverNotice(notice),
      );
    } catch (err) {
      noticeReceipts = {
        slack: "failed",
        slackDetail: `Outcome notice delivery threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    await step.do("record-audit-outcome-notice", () =>
      deps.recordAudit({
        ...baseAudit,
        type: "saga.outcome_notice",
        outcomeCode: outcome.code,
        notice: noticeReceipts,
      }),
    );
    await step.do("record-audit-saga-ended", () =>
      deps.recordAudit({
        ...baseAudit,
        type: "saga.ended",
        outcomeCode: outcome.code,
        ...("screenerWorkflowId" in outcome
          ? { screenerWorkflowId: outcome.screenerWorkflowId }
          : {}),
        ...("decidingSurface" in outcome
          ? { decidingSurface: outcome.decidingSurface }
          : {}),
        ...("orderId" in outcome && outcome.orderId
          ? { orderId: outcome.orderId }
          : {}),
        ...("tradeWorkflowId" in outcome && outcome.tradeWorkflowId
          ? { tradeWorkflowId: outcome.tradeWorkflowId }
          : {}),
        ...("reason" in outcome ? { reason: outcome.reason } : {}),
        ...("compensationForm" in outcome
          ? {
              compensationForm: outcome.compensationForm,
              // Only the refund-request form consumes a paidAtMs
              // (the Leg-0 completion approximation); the credit
              // form uses no timestamp, so it records none.
              ...(outcome.compensationForm === "refund-request"
                ? { paidAtMsSource: "leg0_completion" }
                : {}),
              ...("refundId" in outcome ? { refundId: outcome.refundId } : {}),
              ...("existing" in outcome ? { existing: outcome.existing } : {}),
              ...("creditRunId" in outcome ? { creditRunId: outcome.creditRunId } : {}),
              ...("fallbackReason" in outcome && outcome.fallbackReason
                ? { fallbackReason: outcome.fallbackReason }
                : {}),
            }
          : {}),
      }),
    );
    return outcome;
  };

  return { endSaga, isEnding: () => ending };
}
