/**
 * PaymentWorkflowFlow — the deterministic payment flow behind
 * PaymentWorkflow (#2014; live — header corrected 2026-11-01, #2551).
 *
 * This is the flow module behind PaymentWorkflow, mirroring the repo pattern:
 * ScreenerScreenWorkflow dispatches through the one engine
 * (runScreenerScreenOnEngine) and TradingTradeWorkflow delegates
 * to runTradeApprovalFlow. The workflow class itself is a thin
 * adapter; every decision lives here, behind fakeable interfaces,
 * so it is unit-testable without a worker runtime.
 *
 * Deterministic, NOT model-driven. No step prompts a model, no step lets a
 * model choose an amount, a recipient, or whether to pay. Amounts come from
 * the price catalogue port (src/data/priceCataloguePorts.ts, #2185) as
 * resolved by the gate: only APPROVED catalogue prices resolve (#2547,
 * getApprovedPrice) — seeds are PROPOSED operator defaults, never code
 * constants, and an unapproved price refuses the charge fail-closed.
 * Payment is confirmed only by re-reading provider state via the
 * gate (native: Stripe session retrieve / x402 facilitator verify;
 * cfpay-era: checkout.status); a workflow event is a wake-up
 * signal, never proof of payment.
 *
 * CORRECTION (2026-10-27, user): there is NO new payment agent here.
 * PaymentsAgent already exists in cfagent (src/agents/payments-agent.ts,
 * fleet slice #1957, tracker #1951, shape (a)): it extends PortThink
 * (src/actors/thinkAdapter.ts; PortThink extends Think, Think extends
 * Agent), is a non-chat, RPC-only actor, and its RPC surface is
 * budgetCheck / processPaidRequest / todaySpent / listPayments /
 * migrateLegacyLedger. If a second payment-side agent were ever needed
 * it would extend PortThink too — never raw Think, never plain Agent.
 * What is new here is ONLY the workflow + orchestration wiring.
 * OrchestratorAgent is a CALLER, not a base class: like screener runs,
 * the orchestrator triggers/creates the workflow instance and owns
 * the store and deliver seams; the workflow class itself extends
 * ThinkWorkflow. Orchestration is a caller relationship, not inheritance.
 *
 * Steps, in order (all step.do() for money ops; never step.prompt()):
 *   1. gate-check — coverage first, then checkout (402), or
 *      coverage_required for recurring / unstated scheduled runs.
 *   2. await-payment-approval — human gate BEFORE capture, via
 *      waitForEvent (AgentWorkflow approval support), backed by the
 *      #1262 shared approval engine in production wiring. Timeout or
 *      rejection = no capture, no start. Exception: a one-off scheduled
 *      run already authorized at submission carries that approval in
 *      its params, so it does not wait for a second human gate; the
 *      submission approval is recorded instead.
 *   3. await-payment-verified — durable wait, 24h (cfpay checkout TTL).
 *      Timeout / termination = expired; nothing starts, nothing charges.
 *   4. confirm-paid — gate.confirmPaid(), replay-dedupe, fail closed.
 *      This is the capture step, and it runs only after approval.
 *   5. record-payment — audit event, same runRequestId, tenant-scoped.
 *   6. start-screener — injected starter (in production: the
 *      OrchestratorAgent creates ScreenerScreenWorkflow). If the
 *      screener starter throws after payment, issue one failure
 *      credit via the injected dep and return screener_failed_credit_issued.
 *      This flow never issues a cash refund: the credit is the
 *      automatic compensation (#2549). Cash refunds exist only as
 *      an operator-initiated, operator-approved action in the
 *      refund service (#2204), never from this flow.
 *
 * Params carry ids only — never credentials, never secrets, never a
 * payment card, never a cfpay key. Identity is the verified userLogin +
 * email + tenantId; missing identity fails closed (no fallback identity).
 */

import {
  type CommercialAccount,
  type GateDecision,
  type RunTrigger,
  type ScheduleKind,
  type ScreenerFamily,
} from "../services/cfpayMonetization";
import type { NativeLedgerPort } from "../data/nativeLedgerPorts";

/**
 * Issue #2193 (slice 1, #2146) — the structural gate surface the
 * flow consumes. The flow depends ONLY on check()/confirmPaid():
 * any gate satisfying this interface drives it — the cfpay gate
 * (in-flight drain) and the native gate (new runs) alike. This is
 * a type-level widening, not a step-logic change: no step order,
 * wait, timeout, or outcome changes in this slice. The native gate
 * (src/services/nativeMonetization.ts) satisfies this interface;
 * the cfpay gate does too (its narrower proof type is compatible
 * through method bivariance).
 */
export interface PaymentGate {
  check(run: {
    id: string;
    family: ScreenerFamily;
    trigger: RunTrigger;
    scheduleKind?: ScheduleKind;
    authorizedAtSubmission?: boolean;
    tenantId?: string;
    account: CommercialAccount;
    rail?: "stripe" | "x402";
  }): Promise<GateDecision>;
  confirmPaid(
    run: { id: string; userId: string; email: string; family?: ScreenerFamily; segment?: string },
    proof?: {
      claimTxHash?: string;
      paymentIntentId?: string;
      sessionId?: string;
      paymentProof?: string;
      payer?: string;
      stripeReturnPage?: boolean;
    },
  ): Promise<GateDecision>;
}

export interface PaymentWorkflowParams {
  runRequestId: string;
  family: ScreenerFamily;
  trigger: RunTrigger;
  scheduleKind?: ScheduleKind;
  authorizedAtSubmission?: boolean;
  tenantId: string;
  userId: string;
  email: string;
  /**
   * Operational wiring (2026-10-27): the screener command the caller
   * already built (WorkflowJobCommand, ids + references only, no bulk
   * data, no credentials). The payment workflow does NOT invent a
   * screener command — inventing shards/scenario would be a wiring
   * lie. The caller (route / schedule service, via
   * paymentWorkflowSubmission.ts) supplies it; the start-screener
   * step hands it, unchanged, to the screener workflow port.
   */
  screenerCommand?: unknown;
  /**
   * #2041 G-METERING: saga-only metering context. When present,
   * the paid path records one usage_event after confirm-paid
   * succeeds (never earlier, never on covered runs). Absent =
   * today's behavior exactly (no rows). The saga Leg 0 sets this;
   * no other caller does, so non-saga runs are never labeled
   * saga. The category is literal "saga" because the meter route
   * rejects any other category.
   */
  meterContext?: { category: "saga"; userLogin: string };
  /**
   * Issue #2762 — W3C traceparent for the run (#1743's field, the
   * WorkflowJobCommand contract): buildPaymentWorkflowParams stamps
   * it from the caller-built screener command's traceparent —
   * server-side only, never a tool argument or a caller input. The
   * flow's step hops record under it (the S17 mechanism, #2428);
   * absent → the run's steps record nothing, never minted
   * mid-flight.
   */
  traceparent?: string;
}

/** Minimal structural step surface the flow needs (fakeable in tests). */
export interface PaymentWorkflowStep {
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string },
  ): Promise<{ payload: PaymentApprovalEvent | PaymentVerifiedEvent }>;
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Human approval decision, delivered as a workflow event (never a prompt). */
export interface PaymentApprovalEvent {
  approved?: boolean;
  approverId?: string;
}

/** Wake-up signal only. confirm-paid re-reads provider state regardless. Carries the provider join keys the native gate's stateless confirm needs: the Stripe session id for card, the x402 payment proof (+ claimed payer) for crypto. */
export interface PaymentVerifiedEvent {
  claimTxHash?: string;
  paymentIntentId?: string;
  sessionId?: string;
  paymentProof?: string;
  payer?: string;
}

/**
 * Audit event the flow emits. Optional detail fields are carried so the
 * adapter can write a complete ledger row and a complete mas_events
 * payload from the same event — the flow, not the adapter, holds the
 * price, the checkout, and the verified proof at each step.
 */
export interface PaymentWorkflowEvent {
  runRequestId: string;
  tenantId: string;
  type: string;
  priceUSD?: number;
  checkoutId?: string;
  claimTxHash?: string;
  paymentIntentId?: string;
  /**
   * Who approved the payment (#2550): the approverId carried by
   * the approval event, or the submission's authorizing
   * principal on the approved-at-submission path. Set on
   * payment.approved and payment.approved_at_submission — the
   * approval is the decision that lets capture proceed, and the
   * audit trail must name who made it.
   */
  approverId?: string;
  /** When the flow recorded the event (epoch ms), for events whose decision time is the audit fact (#2550). */
  occurredAtMs?: number;
  /**
   * How a covered run was covered (subscription_included | credits |
   * free_flag_off | already_paid). Set on payment.covered events for
   * the per-coverage-type revenue view (#2022).
   */
  paidVia?: string;
  /**
   * Issue #3263 (AOP, #1969 acceptance): the outcome-catalog code
   * for the event's decision, so the audit record alone answers
   * "which code, what happened, for which login". Set on the
   * quota-exhausted refusal and on a quota-covered run.
   */
  outcomeCode?: string;
  /** The login the event's decision was made for (server-resolved). */
  login?: string;
  /** Structured detail for the audit record (never a client message). */
  detail?: string;
  /**
   * Issue #3289 — per-charge recording (§3.9): the product and
   * version charged, resolved by the gate at check time. Set on
   * payment.confirmed (and payment.covered, for the failure-credit
   * path that may follow). The adapter's journal mapping refuses
   * a per-run event without them.
   */
  productId?: string;
  versionId?: string;
}

/**
 * Pull a checkout id out of the gate's checkout value (the cfpay
 * createCheckout response, whose shape is the raw A2A result, or
 * the native CheckoutCreation). Falls back to undefined — the run
 * id itself is the checkout join key for cfpay (checkout.create
 * used requestId == runRequestId), so the ledger writer falls back
 * to it. For native checkouts the id is the provider join key:
 * the Stripe session id (or payment-intent id) for card — NEVER
 * the checkout URL, which is a redirect, not an id, and is
 * skipped explicitly even if it appears under an id-like key.
 */
export function extractCheckoutId(checkout: unknown): string | undefined {
  if (!checkout || typeof checkout !== "object") return undefined;
  const record = checkout as Record<string, unknown>;
  for (const key of ["checkoutId", "id", "gatewayRef", "sessionId", "paymentIntentId", "requestId"]) {
    const value = record[key];
    if (typeof value === "string" && value && !value.startsWith("http://") && !value.startsWith("https://")) {
      return value;
    }
  }
  const data = record["data"];
  if (data && typeof data === "object") {
    const inner = data as Record<string, unknown>;
    for (const key of ["checkoutId", "id", "gatewayRef", "sessionId", "paymentIntentId", "requestId"]) {
      const value = inner[key];
      if (typeof value === "string" && value && !value.startsWith("http://") && !value.startsWith("https://")) {
        return value;
      }
    }
  }
  return undefined;
}

export interface PaymentWorkflowDeps {
  gate: PaymentGate;
  account: CommercialAccount;
  startScreener: (params: PaymentWorkflowParams) => Promise<{ workflowId: string }>;
  recordEvent: (event: PaymentWorkflowEvent) => Promise<void>;
  /**
   * Issue the one-time replacement-run credit for a failed run, at the
   * run's list price. Called for paid and covered runs alike: a failed
   * covered run consumed one included run, so a replacement is owed
   * there too. Redemption is the account store's job (#2015); this is
   * issuance only. Issue #3289: the third param carries the
   * product/version the failed run was charged for (gate-check
   * resolution), so the claim and the failure-credit journal entry
   * record which charge the credit replaces.
   */
  issueFailureCredit: (
    runRequestId: string,
    priceUSD: number,
    product?: { productId?: string; versionId?: string },
  ) => Promise<void>;
  /**
   * Issue #2015: consume the coverage a covered run used, in the
   * account store (one included run, or priceUSD of credits).
   * Optional so existing flow tests without a store keep passing.
   * The adapter's implementation is best-effort with loud logging:
   * a store blip must not deny a run the user already covered, so
   * a failed consumption logs loudly and the run still starts (the
   * leak is one run's balance, correctable by an operator
   * adjustment). paidVia values that consume nothing
   * (free_flag_off, already_paid) are no-ops.
   */
  consumeCoverage?: (use: { userId: string; paidVia: string; priceUSD: number }) => Promise<void>;
  /**
   * #2041 G-METERING: record one usage event for a saga paid run.
   * Called only when params.meterContext is present and only
   * after confirm-paid succeeds. MUST throw on failure
   * (fail-closed): a throwing dep fails the step (durably
   * retried) so a run never completes unmetered. Optional only
   * so existing flow tests without metering keep passing; when
   * meterContext is present and this dep is absent, the flow
   * throws (a wiring bug, fail loud).
   */
  recordUsage?: (usage: {
    receiptId: string;
    protocol: "stripe" | "x402";
    userLogin: string;
    priceUSD: number;
  }) => Promise<void>;
  /**
   * Issue #2192 follow-up (umbrella #2146): gate → native-ledger
   * wiring. The native ledger port the flow records a charge row
   * through after a successful native charge confirmation (see
   * recordNativeLedgerBestEffort below). Optional and purely
   * best-effort: absent → today's behavior exactly (no rows);
   * a recording failure is loud-logged and never thrown into
   * the payment path, so the payment outcome is identical with
   * the wiring on or off, except for the recorded row. The port
   * dedupes per run+kind, so a retried step never double-records.
   * The production adapter wires it in paymentWorkflow.ts from
   * AGENT_DB (createNativeLedgerAdapter); flow test doubles pass
   * the in-memory adapter. Only the flow's confirmed-native-charge
   * path calls it — covered runs, cfpay-era confirmations, and
   * unconfirmed payments record no native row here.
   */
  nativeLedger?: NativeLedgerPort | null;
  /**
   * Issue #2762 (tracker #2708 A6, S17 #2428): trace hop recorder
   * for this run's steps — the screener flow's traceHop pattern.
   * Optional and purely observational: called AFTER a step's
   * journaled result returns (never inside a step callback, so
   * durable replay cannot re-run it as a side effect — and the
   * recorder's deterministic spans make a re-record converge in
   * the store regardless). Absent → the flow records no step
   * hops (flow test doubles and the saga's direct wiring keep
   * today's behavior). The production adapter wires it in
   * paymentWorkflow.ts from the params' traceparent; a throwing
   * recorder must never fail a step — call sites go through
   * traceStep(), which swallows.
   */
  traceHop?: (event: { operation: string; note?: string }) => Promise<void>;
  /**
   * Issue #3073 - one stage-boundary message per completed step, on the
   * shared #2869 seam. Injected by PaymentWorkflow.run (the flow itself has
   * no queue binding). Best-effort by the same #1743 rule as traceHop: a
   * boundary that cannot be published never fails a payment.
   */
  stageBoundary?: (input: { stageId: PaymentStepId }) => Promise<unknown>;
}

/**
 * Issue #2192 follow-up (umbrella #2146): record one native
 * ledger charge row for a confirmed native payment, best-effort
 * (never throws into the flow — the DO/cfpay ledger row the
 * record-payment step just wrote stays authoritative, and this
 * D1 row is its native projection; a failure here is a loud log
 * + a reconcile flag, not a failed payment).
 *
 * Rail is truthful per paidVia: "stripe_checkout" → stripe,
 * "x402" → x402. Any other paidVia (covered, already_paid,
 * cfpay-era) is not a native charge and records nothing — the
 * cfpay-era path already records its own row. Tenant comes from
 * the verified flow params (the flow throws on tenant mismatch
 * before any step runs, so no client-supplied tenant can scope
 * this row); the price is the gate-check price, for the same
 * resume reason as the record-payment comment above. A missing
 * or non-positive price, or an unbound port, logs loudly and
 * skips — never a guessed row, never an invented tenant.
 * Replay is safe: the port returns the existing row as a
 * duplicate instead of writing a second row.
 */
async function recordNativeLedgerBestEffort(
  port: NativeLedgerPort | null | undefined,
  row: {
    runRequestId: string;
    tenantId: string;
    userId: string;
    family: ScreenerFamily;
    priceUSD: number;
    paidVia?: string;
    sessionId?: string;
    paymentIntentId?: string;
    claimTxHash?: string;
    /** Issue #3289: the product/version charged (gate-check resolution). */
    productId?: string;
    versionId?: string;
  },
): Promise<void> {
  try {
    if (!port) {
      console.error(
        `[payment-workflow] native ledger row skipped for run=${row.runRequestId} (native ledger port unbound); payment unaffected.`,
      );
      return;
    }
    const rail =
      row.paidVia === "stripe_checkout"
        ? "stripe"
        : row.paidVia === "x402"
          ? "x402"
          : null;
    if (!rail) return;
    if (!Number.isFinite(row.priceUSD) || row.priceUSD <= 0) {
      console.error(
        `[payment-workflow] native ledger row refused for run=${row.runRequestId} without a positive price; payment unaffected.`,
      );
      return;
    }
    const { duplicate } = await port.recordRow({
      kind: "charge",
      runRequestId: row.runRequestId,
      tenantId: row.tenantId,
      userId: row.userId,
      family: row.family,
      priceUSD: row.priceUSD,
      rail,
      sessionId: row.sessionId,
      paymentIntentId: row.paymentIntentId,
      claimTxHash: row.claimTxHash,
      // Issue #3289: per-charge recording (§3.9).
      productId: row.productId,
      versionId: row.versionId,
    });
    if (duplicate) {
      console.log(
        `[payment-workflow] native ledger charge row already exists for run=${row.runRequestId} (retried step, deduped)`,
      );
    }
  } catch (err) {
    console.error(
      `[payment-workflow] native ledger record failed for run=${row.runRequestId} — payment unaffected:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Issue #2762: record one trace hop for a completed step,
 * best-effort (never throws into the flow — tracing degrades,
 * the run does not, per the #1743 rule).
 */
async function traceStep(
  deps: PaymentWorkflowDeps,
  operation: string,
  note?: string,
): Promise<void> {
  try {
    await deps.traceHop?.({ operation, ...(note ? { note } : {}) });
  } catch {
    // Best-effort by design (the #1743 degradation rule).
  }
}

export type PaymentWorkflowOutcome =
  | { status: "started"; runRequestId: string; paidVia: string; screenerWorkflowId: string; priceUSD: number; outcomeCode?: string }
  | { status: "payment_required"; runRequestId: string; priceUSD: number; checkout?: unknown }
  | { status: "quota_exhausted"; runRequestId: string; priceUSD: number; family: string; outcomeCode?: string; nextStep?: string }
  | { status: "coverage_required"; runRequestId: string; priceUSD: number }
  | { status: "approval_rejected"; runRequestId: string }
  | { status: "expired"; runRequestId: string }
  | { status: "screener_failed_credit_issued"; runRequestId: string; screenerError: string };

/** How long a checkout waits for verified payment before lapsing. */
export const PAYMENT_VERIFICATION_TIMEOUT = "24 hours";

/**
 * Issue #3191 - the payment workflow's real step ids live in the shared,
 * dependency-free `stageRuntimeIds` module (the workflow catalog renders in
 * the browser and must not import this file). Re-exported here so the flow
 * and the catalog read one declaration; tests/payment_saga_stage_ids_3191.test.ts
 * scans this file and fails if the two drift.
 */
export { PAYMENT_STEP_IDS } from "./stageRuntimeIds";
export type { PaymentStepId } from "./stageRuntimeIds";
import type { PaymentStepId as PaymentStepIdValue } from "./stageRuntimeIds";
type PaymentStepId = PaymentStepIdValue;

export async function runPaymentWorkflowFlow(
  params: PaymentWorkflowParams,
  deps: PaymentWorkflowDeps,
  step: PaymentWorkflowStep,
): Promise<PaymentWorkflowOutcome> {
  /**
   * Issue #3073: the one place a payment step runs. Durable step first,
   * then the boundary message - so the artifact the message references
   * (the step's own persisted record) exists before anything is published.
   * The emit is awaited behind a swallow, so a seam failure cannot alter
   * the flow's outcome.
   */
  const doStep = async <T,>(stageId: PaymentStepId, fn: () => Promise<T>): Promise<T> => {
    const result = await step.do(stageId, fn);
    try {
      await deps.stageBoundary?.({ stageId });
    } catch {
      // Best-effort by design (the #1743 degradation rule).
    }
    return result;
  };
  if (!params.userId || !params.email || !params.tenantId) {
    throw new Error(
      "Payment workflow payload is missing verified userId, email, or tenantId: no default identity, fail closed.",
    );
  }
  if (deps.account.tenantId && params.tenantId !== deps.account.tenantId) {
    throw new Error("Tenant mismatch: run tenant must equal the verified account tenant.");
  }

  const gateDecision = await doStep("gate-check", () =>
    deps.gate.check({
      id: params.runRequestId,
      family: params.family,
      trigger: params.trigger,
      scheduleKind: params.scheduleKind,
      authorizedAtSubmission: params.authorizedAtSubmission,
      tenantId: params.tenantId,
      account: deps.account,
    }),
  );
  await traceStep(deps, "gate-check");

  if (!gateDecision.allowed) {
    if (gateDecision.status === "approved_free_quota_exhausted") {
      // Issue #3263: at the approved-free quota cap nothing runs
      // over allowance (#3241 decision 4). No approval wait, no
      // screener start, no checkout — the refusal is audited and
      // returned with the outcome-coded at-limit decision.
      await doStep("record-quota-exhausted", () =>
        deps.recordEvent({
          runRequestId: params.runRequestId,
          tenantId: params.tenantId,
          type: "payment.approved_free_quota_exhausted",
          priceUSD: gateDecision.priceUSD,
          // AOP (#1969): the audit record alone answers which code,
          // what happened, for which login. `detail` carries the
          // gate's server-side reason (counts + decision reference)
          // for the audit trail — it is never a client message.
          ...(gateDecision.outcomeCode ? { outcomeCode: gateDecision.outcomeCode } : {}),
          login: params.userId,
          ...(gateDecision.reason ? { detail: gateDecision.reason } : {}),
        }),
      );
      await traceStep(deps, "record-quota-exhausted");
      return {
        status: "quota_exhausted",
        runRequestId: params.runRequestId,
        priceUSD: gateDecision.priceUSD,
        family: gateDecision.family,
        ...(gateDecision.outcomeCode ? { outcomeCode: gateDecision.outcomeCode } : {}),
        ...(gateDecision.nextStep ? { nextStep: gateDecision.nextStep } : {}),
      };
    }
    if (gateDecision.status === "coverage_required") {
      // #2019: a skip is audited, not silent — the gate's in-memory
      // skip note would otherwise be lost with the workflow instance.
      await doStep("record-coverage-required", () =>
        deps.recordEvent({
          runRequestId: params.runRequestId,
          tenantId: params.tenantId,
          type: "payment.coverage_required",
          priceUSD: gateDecision.priceUSD,
        }),
      );
      await traceStep(deps, "record-coverage-required");
      return { status: "coverage_required", runRequestId: params.runRequestId, priceUSD: gateDecision.priceUSD };
    }
    // payment_required: a checkout was created (or already exists).
    // #2019: a newly created checkout is audited with its id; a
    // pre-existing checkout (gateDecision.checkout undefined) is not
    // re-announced as created.
    if (gateDecision.checkout !== undefined) {
      await doStep("record-checkout", () =>
        deps.recordEvent({
          runRequestId: params.runRequestId,
          tenantId: params.tenantId,
          type: "payment.checkout_created",
          priceUSD: gateDecision.priceUSD,
          checkoutId: extractCheckoutId(gateDecision.checkout),
        }),
      );
      await traceStep(deps, "record-checkout");
    }
    // Human gate BEFORE capture: wait for an approval event, never a
    // model prompt. A one-off scheduled run already authorized at
    // submission skips this wait — its approval is in the params.
    const alreadyApproved =
      params.scheduleKind === "one_off" && params.authorizedAtSubmission === true;
    if (alreadyApproved) {
      // #2550: the at-submission record names its authorizing
      // principal — the verified submitter whose authorization
      // the params carry — symmetric with the waited path below.
      await doStep("record-approval", () =>
        deps.recordEvent({
          runRequestId: params.runRequestId,
          tenantId: params.tenantId,
          type: "payment.approved_at_submission",
          approverId: params.userId,
          priceUSD: gateDecision.priceUSD,
          occurredAtMs: Date.now(),
        }),
      );
      await traceStep(deps, "record-approval");
    } else {
      let approval: PaymentApprovalEvent;
      try {
        const event = await step.waitForEvent("await-payment-approval", {
          type: "approval",
          timeout: PAYMENT_VERIFICATION_TIMEOUT,
        });
        approval = (event.payload ?? {}) as PaymentApprovalEvent;
      } catch {
        // The wait completed with no decision: the hop records the
        // elapsed wait under the carried trace, noted as expired.
        await traceStep(deps, "await-payment-approval", "expired");
        await doStep("record-expiry", () =>
          deps.recordEvent({ runRequestId: params.runRequestId, tenantId: params.tenantId, type: "payment.approval_expired" }),
        );
        await traceStep(deps, "record-expiry");
        return { status: "expired", runRequestId: params.runRequestId };
      }
      await traceStep(deps, "await-payment-approval");
      if (approval.approved !== true) {
        await doStep("record-rejection", () =>
          deps.recordEvent({ runRequestId: params.runRequestId, tenantId: params.tenantId, type: "payment.approval_rejected" }),
        );
        await traceStep(deps, "record-rejection");
        return { status: "approval_rejected", runRequestId: params.runRequestId };
      }
      // #2550: a successful approval is audited like its
      // neighbors (rejection/expiry above) — exactly one
      // payment.approved event naming the approver, the run, the
      // amount, and the time, recorded before the verified-
      // payment wait so the trail exists even if payment never
      // completes.
      await doStep("record-approval", () =>
        deps.recordEvent({
          runRequestId: params.runRequestId,
          tenantId: params.tenantId,
          type: "payment.approved",
          approverId: approval.approverId,
          priceUSD: gateDecision.priceUSD,
          occurredAtMs: Date.now(),
        }),
      );
      await traceStep(deps, "record-approval");
    }
    // Then wait for a verified-payment event, then confirm by re-reading status.
    let verified: PaymentVerifiedEvent;
    try {
      const event = await step.waitForEvent("await-payment-verified", {
        type: "payment_verified",
        timeout: PAYMENT_VERIFICATION_TIMEOUT,
      });
      verified = (event.payload ?? {}) as PaymentVerifiedEvent;
    } catch {
      await traceStep(deps, "await-payment-verified", "expired");
      await doStep("record-expiry", () =>
        deps.recordEvent({ runRequestId: params.runRequestId, tenantId: params.tenantId, type: "payment.expired" }),
      );
      await traceStep(deps, "record-expiry");
      return { status: "expired", runRequestId: params.runRequestId };
    }
    await traceStep(deps, "await-payment-verified");
    const confirmed = await doStep("confirm-paid", () =>
      deps.gate.confirmPaid(
        {
          id: params.runRequestId,
          userId: params.userId,
          email: params.email,
          family: params.family,
          // Issue #3289: the stateless confirm resolves the
          // effective version for the account's segment.
          segment: deps.account.segment,
        },
        {
          claimTxHash: verified.claimTxHash,
          paymentIntentId: verified.paymentIntentId,
          sessionId: verified.sessionId,
          paymentProof: verified.paymentProof,
          payer: verified.payer,
        },
      ),
    );
    await traceStep(deps, "confirm-paid");
    if (!confirmed.allowed) {
      return {
        status: "payment_required",
        runRequestId: params.runRequestId,
        priceUSD: confirmed.priceUSD,
        checkout: gateDecision.checkout,
      };
    }
    await doStep("record-payment", () =>
      deps.recordEvent({
        runRequestId: params.runRequestId,
        tenantId: params.tenantId,
        type: "payment.confirmed",
        // The gate-check price, not the confirm price: gate-check ran
        // in a durable step before any suspend, while confirm-paid
        // re-executes against a fresh in-memory gate after resume and
        // would report 0 for a run it never saw checked.
        priceUSD: gateDecision.priceUSD,
        checkoutId: extractCheckoutId(gateDecision.checkout),
        claimTxHash: verified.claimTxHash,
        paymentIntentId: verified.paymentIntentId,
        // Issue #3289: the gate-check product/version — the
        // version that was quoted, which the charge journal entry
        // is recorded against (per-charge recording, §3.9).
        ...(gateDecision.productId ? { productId: gateDecision.productId } : {}),
        ...(gateDecision.versionId ? { versionId: gateDecision.versionId } : {}),
      }),
    );
    await traceStep(deps, "record-payment");
    // Issue #2192 follow-up: project the confirmed native charge
    // into the native D1 ledger (best-effort, never thrown — see
    // recordNativeLedgerBestEffort). This is a separate step from
    // record-payment so a durable replay replays it independently
    // and the port dedupe absorbs the retry. The charge journal
    // projection needs no second wiring: the adapter's
    // record-payment handler already posts it (rail-agnostic,
    // same runRequestId ref, best-effort, replay-safe), so a
    // second post here would be a duplicate no-op.
    await doStep("record-native-ledger", () =>
      recordNativeLedgerBestEffort(deps.nativeLedger, {
        runRequestId: params.runRequestId,
        tenantId: params.tenantId,
        userId: params.userId,
        family: params.family,
        priceUSD: gateDecision.priceUSD,
        paidVia: confirmed.paidVia,
        sessionId: verified.sessionId,
        paymentIntentId: verified.paymentIntentId,
        claimTxHash: verified.claimTxHash,
        // Issue #3289: per-charge recording (§3.9).
        productId: gateDecision.productId,
        versionId: gateDecision.versionId,
      }),
    );
    await traceStep(deps, "record-native-ledger");
    // #2041 G-METERING: one usage row for a saga paid run, after
    // confirm-paid succeeds and before the screen starts. Earlier
    // would over-meter (unpaid runs); the covered path never
    // reaches this (no confirm-paid, no payment). The receipt id
    // is the provider id the native gate's confirm just used:
    // the Stripe session id for card, the x402 payment proof for
    // crypto — stable across step retries and workflow replays
    // because `verified` comes from the completed waitForEvent
    // step. Neither present is fail-closed: a confirmed payment
    // without a provider id cannot be metered, and must not
    // start unmetered. The price is the gate-check price, for the
    // same resume reason as the record-payment comment above.
    if (params.meterContext) {
      if (!deps.recordUsage) {
        throw new Error(
          "Payment workflow metering miswired: meterContext present but recordUsage dep is absent.",
        );
      }
      const receipt = verified.sessionId
        ? { receiptId: verified.sessionId, protocol: "stripe" as const }
        : verified.paymentProof
          ? { receiptId: verified.paymentProof, protocol: "x402" as const }
          : null;
      if (!receipt) {
        throw new Error(
          `Payment workflow cannot meter run ${params.runRequestId}: confirmed payment carries no provider receipt id.`,
        );
      }
      await doStep("record-usage", () =>
        deps.recordUsage!({
          ...receipt,
          userLogin: params.meterContext!.userLogin,
          priceUSD: gateDecision.priceUSD,
        }),
      );
      await traceStep(deps, "record-usage");
    }
    return startScreenerOrCredit(
      params,
      deps,
      step,
      confirmed.paidVia ?? "cfpay_checkout",
      gateDecision.priceUSD,
      gateDecision.outcomeCode,
      // Issue #3289: the gate-check product/version, so a failed
      // run's replacement credit records which charge it replaces.
      gateDecision.productId,
      gateDecision.versionId,
    );
  }

  // Covered, already paid, or free (flag OFF): no wait, no new charge.
  await doStep("record-payment", () =>
    deps.recordEvent({
      runRequestId: params.runRequestId,
      tenantId: params.tenantId,
      type: "payment.covered",
      priceUSD: gateDecision.priceUSD,
      paidVia: gateDecision.paidVia ?? gateDecision.status,
      // AOP (#1969): a quota-covered run carries its success code
      // and login on the audit event. Other covered paths carry no
      // outcome code — the gate sets one only on the quota branch.
      ...(gateDecision.outcomeCode ? { outcomeCode: gateDecision.outcomeCode, login: params.userId } : {}),
      // Issue #3289: the gate-check product/version, so a failed
      // covered run's replacement credit records which charge it
      // replaces.
      ...(gateDecision.productId ? { productId: gateDecision.productId } : {}),
      ...(gateDecision.versionId ? { versionId: gateDecision.versionId } : {}),
    }),
  );
  await traceStep(deps, "record-payment");
  // Issue #2015: consume the coverage in the store, so an included
  // run or a credit balance cannot be spent twice. Best-effort in
  // the adapter (see the dep doc): a failed consumption never
  // blocks this covered run.
  if (deps.consumeCoverage) {
    await doStep("consume-coverage", () =>
      deps.consumeCoverage!({
        userId: params.userId,
        paidVia: gateDecision.paidVia ?? gateDecision.status,
        priceUSD: gateDecision.priceUSD,
      }),
    );
    await traceStep(deps, "consume-coverage");
  }
  return startScreenerOrCredit(
    params,
    deps,
    step,
    gateDecision.paidVia ?? gateDecision.status,
    gateDecision.priceUSD,
    gateDecision.outcomeCode,
    // Issue #3289: the gate-check product/version, so a failed
    // covered run's replacement credit records which charge it
    // replaces.
    gateDecision.productId,
    gateDecision.versionId,
  );
}

async function startScreenerOrCredit(
  params: PaymentWorkflowParams,
  deps: PaymentWorkflowDeps,
  step: PaymentWorkflowStep,
  paidVia: string,
  priceUSD: number,
  outcomeCode?: string,
  /** Issue #3289: the product/version the run was charged for (gate-check resolution). */
  productId?: string,
  versionId?: string,
): Promise<PaymentWorkflowOutcome> {
  // Issue #3073: same durable step, same boundary - declared here because this
  // helper owns its own `step` handle (the flow's wrapper is out of scope).
  const doStep = async <T,>(stageId: PaymentStepId, fn: () => Promise<T>): Promise<T> => {
    const result = await step.do(stageId, fn);
    try {
      await deps.stageBoundary?.({ stageId });
    } catch {
      // Best-effort by design (the #1743 degradation rule).
    }
    return result;
  };
  try {
    const started = await doStep("start-screener", () => deps.startScreener(params));
    await traceStep(deps, "start-screener");
    return {
      status: "started",
      runRequestId: params.runRequestId,
      paidVia,
      screenerWorkflowId: started.workflowId,
      // S3 (#2041): the saga's compensation needs the gate price
      // (credit issuance and refund requests both refuse a missing
      // price). Plumbing the existing gateDecision.priceUSD — not
      // new pricing, never the unapproved catalogue defaults.
      priceUSD,
      // Issue #3263 (AOP): a quota-covered start carries its
      // success code so the submission-status poll can render the
      // catalog message. Other starts carry no outcome code.
      ...(outcomeCode ? { outcomeCode } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await doStep("issue-failure-credit", async () => {
      await deps.issueFailureCredit(params.runRequestId, priceUSD, {
        ...(productId ? { productId } : {}),
        ...(versionId ? { versionId } : {}),
      });
      await deps.recordEvent({
        runRequestId: params.runRequestId,
        tenantId: params.tenantId,
        type: "payment.failure_credit_issued",
        priceUSD,
      });
    });
    await traceStep(deps, "issue-failure-credit");
    return { status: "screener_failed_credit_issued", runRequestId: params.runRequestId, screenerError: message };
  }
}
