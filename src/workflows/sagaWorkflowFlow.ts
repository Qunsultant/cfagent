/**
 * SagaWorkflowFlow — the deterministic cross-domain saga flow for
 * issue #2041 (S1: skeleton + Leg 0/1 coordination).
 *
 * This is the flow module behind CrossDomainSagaWorkflow, mirroring
 * the repo pattern: the workflow class itself is a thin adapter;
 * every decision lives here, behind fakeable interfaces, so it is
 * unit-testable without a worker runtime.
 *
 * S3 scope: Leg 0 (start the payment child, poll it to a
 * terminal outcome) + Leg 1 (observe the paid screen to a terminal
 * status on the durable sleep + poll pattern) + Leg 2 (the journey
 * gate after a completed screen) + S3 compensation: a failed
 * screen (deadline / errored-terminated / unrecognized output)
 * compensates rail-aware under a NEW outcome code — stripe
 * checkout → policy-gated refund REQUEST (never execution;
 * operator approval still required), everything else → credit.
 * Leg 3 (S4, sagaTradeLeg.ts): an approved journey continues
 * to the trading leg — propose via the preview surfaces
 * (preview-only drafts; the saga never places an order) + a
 * TradingTradeWorkflow child through the leg port; trade outcomes
 * pass through as saga outcomes. Denied/expired end the saga
 * with no trades, no proposals, and NO credit (Q3 working
 * default: the screen was delivered). Entry route, job surface,
 * and outcome notices arrive with S4 (sagaEntry.ts,
 * sagaStatus.ts, sagaOutcomeNotice.ts).
 *
 * S1's FAILURE_SAGA_SCREEN_FAILED code stays valid in the catalog
 * (stored S1-era rows still resolve) but the S3 flow no longer
 * returns it: every failed screen compensates.
 *
 * Deterministic, NOT model-driven. No step prompts a model, no step
 * lets a model choose a leg, an amount, or a recipient. Leg order
 * is fixed (payment → screen); this is a linear leg sequence
 * with human gates (ADR 0017), never a DAG.
 *
 * Params carry ids + caller-supplied identity + the caller-built
 * screener command — never credentials, never secrets, never a
 * card, never a price. The saga never invents a screener command
 * or an account: both come from the caller, exactly like the
 * payment workflow's own screenerCommand discipline.
 *
 * Audit + the Q7 S2 blocking shape (gap G-AUDIT-WORKFLOW) — what
 * is and is not reachable from a workflow step, pinned here so
 * no later slice over-claims it:
 * - REACHABLE: endpoint-mediated blocking. The flow's recordAudit
 *   dep is a throwing dep: the production adapter posts to
 *   POST /api/audit/event (the same endpoint the payment
 *   workflow's recordEvent uses) and THROWS on any non-201, so a
 *   failed audit write fails the step (durably retried) instead
 *   of letting the saga complete with an unrecorded transition.
 *   The endpoint itself funnels through the single owner
 *   recordAudit() into the chained mas_events repo
 *   (DoSqliteEventLogAdapter extends ChainedAuditRepository),
 *   so a row that lands is hash-linked.
 * - NOT reachable: direct recordBlockingAudit(orm.events) from a
 *   workflow step. Workflows run in the Worker, not in the DO
 *   that owns the ORM; the workflow runtime has no ORM accessor.
 *   The flow therefore never imports the ORM, and no test here
 *   asserts a direct chained write — only that an audit failure
 *   propagates and produces no terminal outcome.
 *
 * Timeouts (open question Q2): the poll deadlines below are S1
 * working defaults, not rulings. The payment deadline covers the
 * payment leg's 24h verification window plus margin; the screen
 * deadline covers a long screen. Venus may change both.
 *
 * Journey gate (S2, Q1 ruled: all decision surfaces, first
 * answer wins). After a completed screen the flow audits
 * saga.journey_prompted, delivers prompts (Slack post; panel
 * and chat are state-driven off the prompted row), then waits
 * for a saga-journey-decision event (24h working default, Q2
 * open). The wait resolves on the FIRST decision; later answers
 * are refused at the delivery layer as superseded (the flow
 * consumes exactly one decision — see sagaJourneyGate.ts for
 * the concurrent-send race window). Approver rule working
 * default (G-APPROVER open): instance-owner-only; any other
 * decider's answer is audited as refused and the gate keeps
 * waiting. Prompt delivery is best-effort per surface; audit
 * stays blocking. Deadline residual, stated not hidden: the
 * provider wait timeout is the proven "24 hours" string, so a
 * refused answer arriving in the final stretch can extend the
 * provider wait by up to one period; the route-level owner
 * check makes that unreachable from user surfaces.
 */

import type { NativeCommercialAccount } from "../services/nativeMonetization";
import type { PaymentWorkflowParams } from "./paymentWorkflowFlow";
import type {
  JourneyGatePrompt,
  JourneyPromptReceipts,
  JourneySurface,
  JourneyWithdrawResult,
  SagaJourneyDecision,
} from "./sagaJourneyGate";
import { buildJourneyGatePrompt, parseJourneyDecision } from "./sagaJourneyGate";
import type { SagaLeg, SagaLegInstanceStatus, SagaLegPort } from "./sagaLegPort";
import {
  compensateFailedScreen,
  sagaCompensationDisclosure,
  type SagaCompensationDeps,
} from "./sagaCompensation";
import type { WorkflowJobCommand } from "./workflowPorts";
import {
  runTradeLeg,
  type ProposeTradeResult,
  type SagaTradeFinish,
  type SagaTradeIntent,
  type SagaTradeOutcome,
} from "./sagaTradeLeg";
import {
  buildSagaOutcomeNotice,
  type SagaOutcomeNotice,
  type SagaOutcomeNoticeReceipts,
} from "./sagaOutcomeNotice";

/** Minimal structural step surface the flow needs (fakeable in tests). */
export interface SagaWorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string },
  ): Promise<{ payload: unknown }>;
}

/** One saga audit event, carried to the recordAudit dep. */
export interface SagaAuditEvent {
  sagaId: string;
  runRequestId: string;
  tenantId: string;
  type:
    | "saga.started"
    | "saga.payment_started"
    | "saga.payment_not_completed"
    | "saga.screen_start_failed_credit_issued"
    | "saga.screen_completed"
    | "saga.screen_failed"
    | "saga.journey_prompted"
    | "saga.journey_decided"
    | "saga.journey_decision_refused"
    | "saga.journey_expired"
    | "saga.journey_prompts_withdrawn"
    | "saga.trade_proposed"
    | "saga.trade_settled"
    | "saga.trade_decided"
    | "saga.trade_leg_failed"
    | "saga.proposal_failed"
    | "saga.outcome_notice"
    | "saga.ended";
  userLogin: string;
  family: string;
  rail?: "stripe" | "x402";
  leg?: SagaLeg;
  outcomeCode?: string;
  screenerWorkflowId?: string;
  reason?: string;
  existing?: boolean;
  decidingSurface?: JourneySurface;
  decision?: "approved" | "denied";
  /** Why a journey answer was refused (S2 refused rows only; distinct from reason). */
  refusalReason?: string;
  withdraw?: JourneyWithdrawResult;
  /** S3 compensation form for a compensated screen failure. */
  compensationForm?: "refund-request" | "credit";
  /** Refund request id (refund-request form only). */
  refundId?: string;
  /** Credit run id (credit form only; equals the runRequestId). */
  creditRunId?: string;
  /** Why a refund-request attempt fell back to credit (credit form only). */
  fallbackReason?: string;
  /** How originalPaidAtMs was derived (S3: "leg0_completion" — see sagaCompensation.ts). */
  paidAtMsSource?: string;
  /** Draft order id (S4 trade leg rows only). */
  orderId?: string;
  /** Trade child workflow id (S4 trade leg rows only). */
  tradeWorkflowId?: string;
  /** Pre-payment disclosure text (S4: saga.started row only, from sagaCompensationDisclosure). */
  disclosure?: string;
  /** Outcome-notice delivery receipts (S4: saga.outcome_notice rows only). */
  notice?: SagaOutcomeNoticeReceipts;
}

/**
 * Saga params. Identity is verified, never defaulted (#1185).
 * family is "goal" in S1 (Q5 default: goal-only first family);
 * any other family throws. rail is carried and, since S3, acted
 * on for the compensation form (stripe + stripe_checkout →
 * refund request; everything else → credit).
 */
export interface SagaParams {
  sagaId: string;
  runRequestId: string;
  userLogin: string;
  userId: string;
  email: string;
  tenantId: string;
  family: "goal";
  trigger: PaymentWorkflowParams["trigger"];
  scheduleKind?: PaymentWorkflowParams["scheduleKind"];
  authorizedAtSubmission?: boolean;
  account: NativeCommercialAccount;
  screenerCommand: WorkflowJobCommand;
  rail?: "stripe" | "x402";
  pollIntervalMs?: number;
  paymentPollDeadlineMs?: number;
  screenPollDeadlineMs?: number;
  /** Journey wait window override (Q2 open; default 24h). */
  journeyWaitMs?: number;
  /**
   * Trade intent (S4, caller-supplied like screenerCommand).
   * The saga never invents what to trade; a missing intent at
   * the trading leg ends proposal_failed (defensive pin only —
   * the entry route requires it).
   */
  tradeIntent?: SagaTradeIntent;
  /** Trade-leg poll deadline override (Q2 open; default 25h). */
  tradePollDeadlineMs?: number;
}

export interface SagaDeps {
  legPort: SagaLegPort;
  /**
   * Throwing audit dep (see the G-AUDIT-WORKFLOW note above):
   * a failed audit write must propagate, never be swallowed.
   * The flow never catches recordAudit failures.
   */
  recordAudit: (event: SagaAuditEvent) => Promise<void>;
  /**
   * Journey prompt delivery (S2). Best-effort per surface (see
   * sagaJourneyGate.ts): a failed surface is recorded in the
   * receipts, never thrown — the prompted audit row is the
   * durable prompt record for the state-driven surfaces.
   */
  deliverPrompts: (prompt: JourneyGatePrompt) => Promise<JourneyPromptReceipts>;
  /**
   * Journey prompt withdrawal (S2), called on BOTH decide and
   * expire paths. Never throws (failures are recorded in the
   * result): withdrawal must not fail a saga whose decision is
   * already recorded.
   */
  withdrawPrompts: (receipts: JourneyPromptReceipts) => Promise<JourneyWithdrawResult>;
  /**
   * S3 compensation deps (see sagaCompensation.ts): fail-loud
   * credit issuance (payment-leg shape), lazy refund ports
   * (null when unbound → credit fallback), and the monetization
   * flag (mirroring the operator route's requireRefundFlag).
   * Journey denied/expired paths never consult these (Q3 default).
   */
  issueCredit: SagaCompensationDeps["issueCredit"];
  getRefundPorts: SagaCompensationDeps["getRefundPorts"];
  monetizationEnabled: SagaCompensationDeps["monetizationEnabled"];
  /**
   * S4 trading-leg deps. proposeTrade proposes via the preview
   * surfaces (ok/err for service refusals; throws only for
   * config failure — see sagaTradeLeg.ts). deliverNotice posts
   * the terminal-outcome notice through existing channels; the
   * flow treats a throwing dep as a failed receipt (best-effort
   * at the flow level too), so a notice failure never fails a
   * saga whose outcome is already recorded.
   */
  proposeTrade: (intent: SagaTradeIntent) => Promise<ProposeTradeResult>;
  deliverNotice: (
    notice: SagaOutcomeNotice,
  ) => Promise<SagaOutcomeNoticeReceipts>;
  nowMs: () => number;
}

export type SagaWorkflowOutcome =
  | {
      status: "payment_not_completed";
      code: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED";
      sagaId: string;
      runRequestId: string;
      reason: string;
      rail?: "stripe" | "x402";
    }
  | {
      status: "screen_start_failed_credit_issued";
      code: "FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED";
      sagaId: string;
      runRequestId: string;
      screenerError: string;
      rail?: "stripe" | "x402";
    }
  | {
      status: "screen_completed";
      code: "SUCCESS_SAGA_SCREEN_COMPLETED";
      sagaId: string;
      runRequestId: string;
      screenerWorkflowId: string;
      rail?: "stripe" | "x402";
    }
  | {
      status: "screen_failed_credit_issued";
      code: "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED";
      sagaId: string;
      runRequestId: string;
      screenerWorkflowId: string;
      reason: string;
      compensationForm: "credit";
      creditRunId: string;
      fallbackReason?: string;
      rail?: "stripe" | "x402";
    }
  | {
      status: "screen_failed_refund_requested";
      code: "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED";
      sagaId: string;
      runRequestId: string;
      screenerWorkflowId: string;
      reason: string;
      compensationForm: "refund-request";
      refundId: string;
      existing?: boolean;
      rail?: "stripe" | "x402";
    }
  | {
      status: "journey_approved";
      code: "SUCCESS_SAGA_JOURNEY_APPROVED";
      sagaId: string;
      runRequestId: string;
      screenerWorkflowId: string;
      decidingSurface: JourneySurface;
      rail?: "stripe" | "x402";
    }
  | {
      status: "journey_denied";
      code: "FAILURE_SAGA_JOURNEY_DENIED";
      sagaId: string;
      runRequestId: string;
      screenerWorkflowId: string;
      decidingSurface: JourneySurface;
      rail?: "stripe" | "x402";
    }
  | {
      status: "journey_expired";
      code: "FAILURE_SAGA_JOURNEY_EXPIRED";
      sagaId: string;
      runRequestId: string;
      screenerWorkflowId: string;
      rail?: "stripe" | "x402";
    }
  | SagaTradeOutcome;

/** Poll cadence for leg observation (S1 working default, Q2 open). */
export const SAGA_POLL_INTERVAL_MS_DEFAULT = 30_000;
/** Payment-leg poll deadline: the 24h verification window + margin (Q2 open). */
export const SAGA_PAYMENT_POLL_DEADLINE_MS_DEFAULT = 25 * 60 * 60 * 1000;
/** Screen-leg poll deadline (Q2 open). */
export const SAGA_SCREEN_POLL_DEADLINE_MS_DEFAULT = 60 * 60 * 1000;
/** Journey-gate provider wait timeout (proven "24 hours" string, Q2 open). */
export const SAGA_JOURNEY_WAIT_TIMEOUT = "24 hours";
/** Journey-gate wait window (Q2 open; per-order wait is also 24h). */
export const SAGA_JOURNEY_WAIT_MS_DEFAULT = 24 * 60 * 60 * 1000;

export type LegTerminal =
  | { terminal: "complete"; output?: unknown }
  | { terminal: "errored" }
  | { terminal: "terminated" }
  | { terminal: "deadline" };

/**
 * Poll one leg to a terminal state on the durable sleep + poll
 * pattern (mirroring screenerWorkflowFlow's pollBatch): deadline
 * check first, then sleep, then one status read per round.
 * Unknown/missing statuses keep polling — only a terminal status
 * or the deadline ends the loop. A missing binding throws
 * immediately (the port fails loud, never burns a deadline).
 * The deps are structural (legPort + nowMs only) so the trading
 * leg (S4, sagaTradeLeg.ts) reuses this same poll instead of a
 * second copy of the loop.
 */
export async function pollLegToTerminal(
  deps: { legPort: SagaLegPort; nowMs: () => number },
  step: SagaWorkflowStep,
  leg: SagaLeg,
  workflowId: string,
  deadlineMs: number,
  pollIntervalMs: number,
): Promise<LegTerminal> {
  const startedAt = deps.nowMs();
  const deadlineAt = startedAt + deadlineMs;
  let round = 0;
  for (;;) {
    if (deps.nowMs() >= deadlineAt) return { terminal: "deadline" };
    await step.sleep(`poll-wait-${leg}-${round}`, pollIntervalMs);
    const snapshot = await step.do(`poll-${leg}-${round}`, () =>
      deps.legPort.getLegStatus(leg, workflowId),
    );
    round += 1;
    const status = snapshot?.status ?? "unknown";
    if (status === "complete") {
      return { terminal: "complete", output: snapshot?.output };
    }
    if (status === "errored" || status === "terminated") {
      return { terminal: status };
    }
    // queued / running / paused / waiting / waitingForPause /
    // unknown / missing: keep polling until the deadline.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Screener collation lifecycle, when the output carries one. */
function collationLifecycle(output: unknown): string | null {
  if (!isRecord(output)) return null;
  const lifecycle = output["lifecycle"];
  return typeof lifecycle === "string" ? lifecycle : null;
}

export async function runSagaWorkflowFlow(
  params: SagaParams,
  deps: SagaDeps,
  step: SagaWorkflowStep,
): Promise<SagaWorkflowOutcome> {
  if (!params.sagaId || !params.runRequestId) {
    throw new Error("Saga payload is missing sagaId or runRequestId.");
  }
  // Issue #1185 discipline: no default identity, fail closed.
  if (!params.userLogin || !params.userId || !params.email || !params.tenantId) {
    throw new Error(
      "Saga payload is missing verified userLogin, userId, email, or tenantId (no default identity).",
    );
  }
  if (params.account.tenantId && params.tenantId !== params.account.tenantId) {
    throw new Error("Tenant mismatch: saga tenant must equal the verified account tenant.");
  }
  if (params.family !== "goal") {
    throw new Error(
      `Saga is goal-only (Q5 default); family "${String(params.family)}" is not accepted yet.`,
    );
  }
  if (!params.trigger) {
    throw new Error("Saga payload is missing the trigger for the payment leg.");
  }
  if (!params.screenerCommand || typeof params.screenerCommand.jobId !== "string" || !params.screenerCommand.jobId) {
    throw new Error("Saga payload is missing a valid screenerCommand (jobId required).");
  }

  const pollIntervalMs = params.pollIntervalMs ?? SAGA_POLL_INTERVAL_MS_DEFAULT;
  const paymentDeadlineMs = params.paymentPollDeadlineMs ?? SAGA_PAYMENT_POLL_DEADLINE_MS_DEFAULT;
  const screenDeadlineMs = params.screenPollDeadlineMs ?? SAGA_SCREEN_POLL_DEADLINE_MS_DEFAULT;

  const baseAudit = {
    sagaId: params.sagaId,
    runRequestId: params.runRequestId,
    tenantId: params.tenantId,
    userLogin: params.userLogin,
    family: params.family,
    ...(params.rail ? { rail: params.rail } : {}),
  };

  // Every audit write is a durable step whose failure propagates:
  // the saga never completes with an unrecorded transition.
  // The started row carries the pre-payment disclosure (S4: the
  // same single source the entry route returns — one function,
  // two surfaces, no copy drift).
  await step.do("record-audit-saga-started", () =>
    deps.recordAudit({
      ...baseAudit,
      type: "saga.started",
      disclosure: sagaCompensationDisclosure(params.rail),
    }),
  );

  const endSaga = async (
    outcome: SagaWorkflowOutcome,
    terminalEvent: Omit<
      SagaAuditEvent,
      "sagaId" | "runRequestId" | "tenantId" | "userLogin" | "family" | "rail"
    >,
  ): Promise<SagaWorkflowOutcome> => {
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
      sagaId: params.sagaId,
      runRequestId: params.runRequestId,
      outcomeCode: outcome.code,
      statusUrl: `/api/saga/${params.sagaId}/status`,
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

  // Leg 0 — start the payment child, poll it to terminal.
  const payment = await step.do("start-payment-leg", () =>
    deps.legPort.startLeg("payment", {
      runRequestId: params.runRequestId,
      family: params.family,
      trigger: params.trigger,
      scheduleKind: params.scheduleKind,
      authorizedAtSubmission: params.authorizedAtSubmission,
      tenantId: params.tenantId,
      userId: params.userId,
      email: params.email,
      account: params.account,
      screenerCommand: params.screenerCommand,
      // #2041 G-METERING: saga-only metering context. The payment
      // workflow records one usage_event after confirm-paid
      // succeeds, only when this context is present — so non-saga
      // payment runs are never labeled saga, and the saga entry
      // route (which never observes the payment outcome) stays
      // out of metering entirely.
      meterContext: { category: "saga", userLogin: params.userLogin },
    }),
  );
  const payTerminal = await pollLegToTerminal(
    deps,
    step,
    "payment",
    payment.workflowId,
    paymentDeadlineMs,
    pollIntervalMs,
  );

  if (payTerminal.terminal === "deadline") {
    return endSaga(
      {
        status: "payment_not_completed",
        code: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
        sagaId: params.sagaId,
        runRequestId: params.runRequestId,
        reason: "payment_deadline_exceeded",
        ...(params.rail ? { rail: params.rail } : {}),
      },
      { type: "saga.payment_not_completed", leg: "payment", outcomeCode: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED", reason: "payment_deadline_exceeded" },
    );
  }
  if (payTerminal.terminal === "errored" || payTerminal.terminal === "terminated") {
    const reason = `payment_leg_${payTerminal.terminal}`;
    return endSaga(
      {
        status: "payment_not_completed",
        code: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
        sagaId: params.sagaId,
        runRequestId: params.runRequestId,
        reason,
        ...(params.rail ? { rail: params.rail } : {}),
      },
      { type: "saga.payment_not_completed", leg: "payment", outcomeCode: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED", reason },
    );
  }

  // Complete payment instance: the outcome rides in its output.
  const paymentOutput = payTerminal.output;
  const paymentStatus = isRecord(paymentOutput) ? paymentOutput["status"] : undefined;
  if (paymentStatus === "started") {
    const screenerWorkflowId = isRecord(paymentOutput) ? paymentOutput["screenerWorkflowId"] : undefined;
    if (typeof screenerWorkflowId !== "string" || !screenerWorkflowId) {
      return endSaga(
        {
          status: "payment_not_completed",
          code: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
          sagaId: params.sagaId,
          runRequestId: params.runRequestId,
          reason: "payment_output_unrecognized",
          ...(params.rail ? { rail: params.rail } : {}),
        },
        { type: "saga.payment_not_completed", leg: "payment", outcomeCode: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED", reason: "payment_output_unrecognized" },
      );
    }
    await step.do("record-audit-payment-started", () =>
      deps.recordAudit({
        ...baseAudit,
        type: "saga.payment_started",
        leg: "payment",
        screenerWorkflowId,
        existing: payment.existing,
      }),
    );

    // S3 compensation provenance, captured at Leg-0 completion:
    // the payment leg's paidVia selects the form, its priceUSD
    // values the compensation, and the completion time anchors
    // the refund window (the payment flow knows no trustworthy
    // paid timestamp — see sagaCompensation.ts). A missing price
    // fails loud ONLY if a screen failure actually needs
    // compensation; a completed screen never consults it.
    const paidVia =
      isRecord(paymentOutput) && typeof paymentOutput["paidVia"] === "string"
        ? (paymentOutput["paidVia"] as string)
        : undefined;
    const priceUSD =
      isRecord(paymentOutput) && typeof paymentOutput["priceUSD"] === "number"
        ? (paymentOutput["priceUSD"] as number)
        : undefined;
    const paymentCompletedAtMs = deps.nowMs();

    // S3: every failed screen compensates through this single
    // call site (deadline / errored-terminated / unrecognized
    // output are mutually exclusive by control flow), so a run
    // compensates exactly once. A throwing compensate fails the
    // step (durably retried), never a terminal uncompensated
    // outcome. Journey denied/expired never reach this helper
    // (Q3 default: the screen was delivered).
    const compensateAndEnd = async (reason: string): Promise<SagaWorkflowOutcome> => {
      const compensation = await step.do("compensate-failed-screen", () =>
        compensateFailedScreen(
          {
            issueCredit: deps.issueCredit,
            getRefundPorts: deps.getRefundPorts,
            monetizationEnabled: deps.monetizationEnabled,
            nowMs: deps.nowMs,
          },
          {
            sagaId: params.sagaId,
            runRequestId: params.runRequestId,
            userLogin: params.userLogin,
            tenantId: params.tenantId,
            family: params.family,
            rail: params.rail,
            paidVia,
            priceUSD,
            paidAtMs: paymentCompletedAtMs,
            reason,
          },
        ),
      );
      if (compensation.form === "refund-request") {
        const refundId = compensation.refundId;
        if (!refundId) throw new Error("Compensation returned refund-request without a refund id.");
        const outcome: SagaWorkflowOutcome = {
          status: "screen_failed_refund_requested",
          code: "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED",
          sagaId: params.sagaId,
          runRequestId: params.runRequestId,
          screenerWorkflowId,
          reason,
          compensationForm: "refund-request",
          refundId,
          ...(compensation.existing !== undefined ? { existing: compensation.existing } : {}),
          ...(params.rail ? { rail: params.rail } : {}),
        };
        return endSaga(outcome, {
          type: "saga.screen_failed",
          leg: "screener",
          outcomeCode: "FAILURE_SAGA_SCREEN_FAILED_REFUND_REQUESTED",
          screenerWorkflowId,
          reason,
          compensationForm: "refund-request",
          refundId,
          ...(compensation.existing !== undefined ? { existing: compensation.existing } : {}),
          paidAtMsSource: "leg0_completion",
        });
      }
      const creditRunId = compensation.creditRunId;
      if (!creditRunId) throw new Error("Compensation returned credit without a credit run id.");
      const outcome: SagaWorkflowOutcome = {
        status: "screen_failed_credit_issued",
        code: "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED",
        sagaId: params.sagaId,
        runRequestId: params.runRequestId,
        screenerWorkflowId,
        reason,
        compensationForm: "credit",
        creditRunId,
        ...(compensation.fallbackReason ? { fallbackReason: compensation.fallbackReason } : {}),
        ...(params.rail ? { rail: params.rail } : {}),
      };
      return endSaga(outcome, {
        type: "saga.screen_failed",
        leg: "screener",
        outcomeCode: "FAILURE_SAGA_SCREEN_FAILED_CREDIT_ISSUED",
        screenerWorkflowId,
        reason,
        compensationForm: "credit",
        creditRunId,
        ...(compensation.fallbackReason ? { fallbackReason: compensation.fallbackReason } : {}),
      });
    };

    // Leg 1 — observe the paid screen (never start a second one).
    const screenTerminal = await pollLegToTerminal(
      deps,
      step,
      "screener",
      screenerWorkflowId,
      screenDeadlineMs,
      pollIntervalMs,
    );
    if (screenTerminal.terminal === "deadline") {
      return compensateAndEnd("screen_deadline_exceeded");
    }
    if (screenTerminal.terminal === "errored" || screenTerminal.terminal === "terminated") {
      return compensateAndEnd(`screen_leg_${screenTerminal.terminal}`);
    }
    const lifecycle = collationLifecycle(screenTerminal.output);
    if (lifecycle === "Completed" || lifecycle === "ReportGenerated") {
      // Leg 1 completion is a milestone row, not a terminal
      // outcome: S2 continues to the journey gate (Leg 2).
      await step.do("record-audit-screen-completed", () =>
        deps.recordAudit({
          ...baseAudit,
          type: "saga.screen_completed",
          leg: "screener",
          outcomeCode: "SUCCESS_SAGA_SCREEN_COMPLETED",
          screenerWorkflowId,
        }),
      );
      return runJourneyGate(params, deps, step, baseAudit, screenerWorkflowId, endSaga);
    }
    // Failed collation, or an output that is not a collation at all:
    // a completed instance is not a delivered screen. S3 routes
    // this through the same compensation helper as every other
    // failed screen (one compensation per run, ever).
    return compensateAndEnd(
      lifecycle === "Failed" ? "screen_failed" : "screen_output_unrecognized",
    );
  }

  if (paymentStatus === "screener_failed_credit_issued") {
    const screenerError =
      isRecord(paymentOutput) && typeof paymentOutput["screenerError"] === "string"
        ? (paymentOutput["screenerError"] as string)
        : "screener failed to start";
    // The payment leg already issued the credit; the saga records
    // it and does NOT re-issue (S1 has no credit dep at all).
    return endSaga(
      {
        status: "screen_start_failed_credit_issued",
        code: "FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED",
        sagaId: params.sagaId,
        runRequestId: params.runRequestId,
        screenerError,
        ...(params.rail ? { rail: params.rail } : {}),
      },
      { type: "saga.screen_start_failed_credit_issued", leg: "payment", outcomeCode: "FAILURE_SAGA_SCREEN_START_FAILED_CREDIT_ISSUED" },
    );
  }

  // payment_required / coverage_required / approval_rejected /
  // expired / unrecognized output: the payment did not complete.
  const reason =
    typeof paymentStatus === "string" &&
    ["payment_required", "coverage_required", "approval_rejected", "expired"].includes(paymentStatus)
      ? paymentStatus
      : "payment_output_unrecognized";
  return endSaga(
    {
      status: "payment_not_completed",
      code: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED",
      sagaId: params.sagaId,
      runRequestId: params.runRequestId,
      reason,
      ...(params.rail ? { rail: params.rail } : {}),
    },
    { type: "saga.payment_not_completed", leg: "payment", outcomeCode: "FAILURE_SAGA_PAYMENT_NOT_COMPLETED", reason },
  );
}

/**
 * Leg 2 — the journey gate (S2, Q1 ruled: all decision surfaces,
 * first answer wins).
 *
 * Sequence: audit the prompted row, deliver prompts, then wait
 * for the first saga-journey-decision event. Owner-only (working
 * default, G-APPROVER open): a non-owner or malformed answer is
 * audited as refused and the gate keeps waiting. No valid owner
 * decision within the window (wait throw, or the flow clock
 * passing the deadline) → expired. Approved → Leg 3 (S4: the
 * decided row is recorded, prompts withdrawn, and the trading
 * leg runs — journey_approved is a milestone, not a terminal).
 * Denied → journey_denied (no trades, no proposals).
 * Withdrawal runs on BOTH decide and
 * expire paths, AFTER the decision/expiry is recorded: a prompt
 * that outlives its decision is superseded-safe, while a
 * decision without its record would not be.
 */
async function runJourneyGate(
  params: SagaParams,
  deps: SagaDeps,
  step: SagaWorkflowStep,
  baseAudit: Omit<SagaAuditEvent, "type">,
  screenerWorkflowId: string,
  endSaga: (
    outcome: SagaWorkflowOutcome,
    terminalEvent: Omit<
      SagaAuditEvent,
      "sagaId" | "runRequestId" | "tenantId" | "userLogin" | "family" | "rail"
    >,
  ) => Promise<SagaWorkflowOutcome>,
): Promise<SagaWorkflowOutcome> {
  const journeyWaitMs = params.journeyWaitMs ?? SAGA_JOURNEY_WAIT_MS_DEFAULT;
  const deadlineAt = deps.nowMs() + journeyWaitMs;
  const prompt = buildJourneyGatePrompt(
    params.sagaId,
    params.runRequestId,
    params.family,
    params.rail,
  );
  await step.do("record-audit-journey-prompted", () =>
    deps.recordAudit({
      ...baseAudit,
      type: "saga.journey_prompted",
      leg: "screener",
      screenerWorkflowId,
    }),
  );
  const receipts = await step.do("deliver-journey-prompts", () => deps.deliverPrompts(prompt));

  const withdrawAndAudit = async (): Promise<void> => {
    const result = await step.do("withdraw-journey-prompts", () => deps.withdrawPrompts(receipts));
    await step.do("record-audit-journey-prompts-withdrawn", () =>
      deps.recordAudit({
        ...baseAudit,
        type: "saga.journey_prompts_withdrawn",
        screenerWorkflowId,
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
        timeout: SAGA_JOURNEY_WAIT_TIMEOUT,
      });
    } catch {
      // Provider timeout or termination: no decision obtained.
      break;
    }
    const parsed = parseJourneyDecision(event.payload);
    if (!parsed.ok) {
      await step.do("record-audit-journey-decision-refused", () =>
        deps.recordAudit({
          ...baseAudit,
          type: "saga.journey_decision_refused",
          screenerWorkflowId,
          refusalReason: parsed.reason,
        }),
      );
      continue;
    }
    if (parsed.decision.sagaId !== params.sagaId) {
      // A decision for another saga must never decide this one.
      await step.do("record-audit-journey-decision-refused", () =>
        deps.recordAudit({
          ...baseAudit,
          type: "saga.journey_decision_refused",
          screenerWorkflowId,
          refusalReason: "saga_id_mismatch",
        }),
      );
      continue;
    }
    if (parsed.decision.deciderLogin !== params.userLogin) {
      await step.do("record-audit-journey-decision-refused", () =>
        deps.recordAudit({
          ...baseAudit,
          type: "saga.journey_decision_refused",
          screenerWorkflowId,
          refusalReason: "non_owner_decider",
        }),
      );
      continue;
    }
    decision = parsed.decision;
    break;
  }

  if (decision === null) {
    const outcome: SagaWorkflowOutcome = {
      status: "journey_expired",
      code: "FAILURE_SAGA_JOURNEY_EXPIRED",
      sagaId: params.sagaId,
      runRequestId: params.runRequestId,
      screenerWorkflowId,
      ...(params.rail ? { rail: params.rail } : {}),
    };
    const result = await endSaga(outcome, {
      type: "saga.journey_expired",
      screenerWorkflowId,
      outcomeCode: "FAILURE_SAGA_JOURNEY_EXPIRED",
    });
    await withdrawAndAudit();
    return result;
  }

  if (decision.decision === "denied") {
    const outcome: SagaWorkflowOutcome = {
      status: "journey_denied",
      code: "FAILURE_SAGA_JOURNEY_DENIED",
      sagaId: params.sagaId,
      runRequestId: params.runRequestId,
      screenerWorkflowId,
      decidingSurface: decision.surface,
      ...(params.rail ? { rail: params.rail } : {}),
    };
    const result = await endSaga(outcome, {
      type: "saga.journey_decided",
      decidingSurface: decision.surface,
      decision: "denied",
      screenerWorkflowId,
      outcomeCode: "FAILURE_SAGA_JOURNEY_DENIED",
    });
    await withdrawAndAudit();
    return result;
  }

  // S4: approval is a MILESTONE, not a terminal. The decided row
  // is recorded (not via endSaga — the saga does not end here),
  // prompts are withdrawn, and the flow continues to Leg 3. The
  // saga ends at the TRADE outcome; its saga.ended row carries
  // the trade code plus decidingSurface (see endSaga).
  // SUCCESS_SAGA_JOURNEY_APPROVED stays valid in the catalog
  // (stored S2-era rows still resolve) but the S4 flow no longer
  // returns it as a terminal outcome.
  await step.do("record-audit-journey-decided-approved", () =>
    deps.recordAudit({
      ...baseAudit,
      type: "saga.journey_decided",
      decidingSurface: decision.surface,
      decision: "approved",
      screenerWorkflowId,
      outcomeCode: "SUCCESS_SAGA_JOURNEY_APPROVED",
    }),
  );
  await withdrawAndAudit();
  // endSaga returns its input verbatim, so the wrapper cast is
  // sound: the leg's finish contract is the trade outcome it was
  // handed, and endSaga hands exactly that back.
  const finishTrade: SagaTradeFinish = async (outcome, terminalEvent) =>
    (await endSaga(outcome, terminalEvent)) as SagaTradeOutcome;
  return runTradeLeg(
    {
      sagaId: params.sagaId,
      runRequestId: params.runRequestId,
      userLogin: params.userLogin,
      tenantId: params.tenantId,
      family: params.family,
      ...(params.rail ? { rail: params.rail } : {}),
      tradeIntent: params.tradeIntent,
      screenerWorkflowId,
      decidingSurface: decision.surface,
      tradePollDeadlineMs: params.tradePollDeadlineMs,
      pollIntervalMs: params.pollIntervalMs ?? SAGA_POLL_INTERVAL_MS_DEFAULT,
    },
    {
      legPort: deps.legPort,
      recordAudit: deps.recordAudit,
      proposeTrade: deps.proposeTrade,
      nowMs: deps.nowMs,
    },
    step,
    baseAudit,
    finishTrade,
  );
}
