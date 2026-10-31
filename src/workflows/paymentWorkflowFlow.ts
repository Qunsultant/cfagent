/**
 * PaymentWorkflowFlow — the deterministic payment flow for Goal 1 Phase 2 (#2014).
 *
 * This is the flow module behind PaymentWorkflow, mirroring the repo pattern:
 * ScreenerScreenWorkflow delegates to screenerWorkflowFlow.ts and
 * TradingTradeWorkflow delegates to runTradeApprovalFlow. The workflow class
 * itself is a thin adapter; every decision lives here, behind fakeable
 * interfaces, so it is unit-testable without a worker runtime.
 *
 * Deterministic, NOT model-driven. No step prompts a model, no step lets a
 * model choose an amount, a recipient, or whether to pay. Amounts come from
 * the price catalogue in cfpayMonetization.ts (proposed, NOT approved).
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
 *      There is no cash refund in v1 (cfpay cannot refund, #2024 deferred).
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
    run: { id: string; userId: string; email: string; family?: ScreenerFamily },
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
   * How a covered run was covered (subscription_included | credits |
   * free_flag_off | already_paid). Set on payment.covered events for
   * the per-coverage-type revenue view (#2022).
   */
  paidVia?: string;
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
   * issuance only.
   */
  issueFailureCredit: (runRequestId: string, priceUSD: number) => Promise<void>;
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
}

export type PaymentWorkflowOutcome =
  | { status: "started"; runRequestId: string; paidVia: string; screenerWorkflowId: string; priceUSD: number }
  | { status: "payment_required"; runRequestId: string; priceUSD: number; checkout?: unknown }
  | { status: "coverage_required"; runRequestId: string; priceUSD: number }
  | { status: "approval_rejected"; runRequestId: string }
  | { status: "expired"; runRequestId: string }
  | { status: "screener_failed_credit_issued"; runRequestId: string; screenerError: string };

/** How long a checkout waits for verified payment before lapsing. */
export const PAYMENT_VERIFICATION_TIMEOUT = "24 hours";

export async function runPaymentWorkflowFlow(
  params: PaymentWorkflowParams,
  deps: PaymentWorkflowDeps,
  step: PaymentWorkflowStep,
): Promise<PaymentWorkflowOutcome> {
  if (!params.userId || !params.email || !params.tenantId) {
    throw new Error(
      "Payment workflow payload is missing verified userId, email, or tenantId: no default identity, fail closed.",
    );
  }
  if (deps.account.tenantId && params.tenantId !== deps.account.tenantId) {
    throw new Error("Tenant mismatch: run tenant must equal the verified account tenant.");
  }

  const gateDecision = await step.do("gate-check", () =>
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

  if (!gateDecision.allowed) {
    if (gateDecision.status === "coverage_required") {
      // #2019: a skip is audited, not silent — the gate's in-memory
      // skip note would otherwise be lost with the workflow instance.
      await step.do("record-coverage-required", () =>
        deps.recordEvent({
          runRequestId: params.runRequestId,
          tenantId: params.tenantId,
          type: "payment.coverage_required",
          priceUSD: gateDecision.priceUSD,
        }),
      );
      return { status: "coverage_required", runRequestId: params.runRequestId, priceUSD: gateDecision.priceUSD };
    }
    // payment_required: a checkout was created (or already exists).
    // #2019: a newly created checkout is audited with its id; a
    // pre-existing checkout (gateDecision.checkout undefined) is not
    // re-announced as created.
    if (gateDecision.checkout !== undefined) {
      await step.do("record-checkout", () =>
        deps.recordEvent({
          runRequestId: params.runRequestId,
          tenantId: params.tenantId,
          type: "payment.checkout_created",
          priceUSD: gateDecision.priceUSD,
          checkoutId: extractCheckoutId(gateDecision.checkout),
        }),
      );
    }
    // Human gate BEFORE capture: wait for an approval event, never a
    // model prompt. A one-off scheduled run already authorized at
    // submission skips this wait — its approval is in the params.
    const alreadyApproved =
      params.scheduleKind === "one_off" && params.authorizedAtSubmission === true;
    if (alreadyApproved) {
      await step.do("record-approval", () =>
        deps.recordEvent({ runRequestId: params.runRequestId, tenantId: params.tenantId, type: "payment.approved_at_submission" }),
      );
    } else {
      let approval: PaymentApprovalEvent;
      try {
        const event = await step.waitForEvent("await-payment-approval", {
          type: "approval",
          timeout: PAYMENT_VERIFICATION_TIMEOUT,
        });
        approval = (event.payload ?? {}) as PaymentApprovalEvent;
      } catch {
        await step.do("record-expiry", () =>
          deps.recordEvent({ runRequestId: params.runRequestId, tenantId: params.tenantId, type: "payment.approval_expired" }),
        );
        return { status: "expired", runRequestId: params.runRequestId };
      }
      if (approval.approved !== true) {
        await step.do("record-rejection", () =>
          deps.recordEvent({ runRequestId: params.runRequestId, tenantId: params.tenantId, type: "payment.approval_rejected" }),
        );
        return { status: "approval_rejected", runRequestId: params.runRequestId };
      }
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
      await step.do("record-expiry", () =>
        deps.recordEvent({ runRequestId: params.runRequestId, tenantId: params.tenantId, type: "payment.expired" }),
      );
      return { status: "expired", runRequestId: params.runRequestId };
    }
    const confirmed = await step.do("confirm-paid", () =>
      deps.gate.confirmPaid(
        { id: params.runRequestId, userId: params.userId, email: params.email, family: params.family },
        {
          claimTxHash: verified.claimTxHash,
          paymentIntentId: verified.paymentIntentId,
          sessionId: verified.sessionId,
          paymentProof: verified.paymentProof,
          payer: verified.payer,
        },
      ),
    );
    if (!confirmed.allowed) {
      return {
        status: "payment_required",
        runRequestId: params.runRequestId,
        priceUSD: confirmed.priceUSD,
        checkout: gateDecision.checkout,
      };
    }
    await step.do("record-payment", () =>
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
      }),
    );
    return startScreenerOrCredit(
      params,
      deps,
      step,
      confirmed.paidVia ?? "cfpay_checkout",
      gateDecision.priceUSD,
    );
  }

  // Covered, already paid, or free (flag OFF): no wait, no new charge.
  await step.do("record-payment", () =>
    deps.recordEvent({
      runRequestId: params.runRequestId,
      tenantId: params.tenantId,
      type: "payment.covered",
      priceUSD: gateDecision.priceUSD,
      paidVia: gateDecision.paidVia ?? gateDecision.status,
    }),
  );
  // Issue #2015: consume the coverage in the store, so an included
  // run or a credit balance cannot be spent twice. Best-effort in
  // the adapter (see the dep doc): a failed consumption never
  // blocks this covered run.
  if (deps.consumeCoverage) {
    await step.do("consume-coverage", () =>
      deps.consumeCoverage!({
        userId: params.userId,
        paidVia: gateDecision.paidVia ?? gateDecision.status,
        priceUSD: gateDecision.priceUSD,
      }),
    );
  }
  return startScreenerOrCredit(
    params,
    deps,
    step,
    gateDecision.paidVia ?? gateDecision.status,
    gateDecision.priceUSD,
  );
}

async function startScreenerOrCredit(
  params: PaymentWorkflowParams,
  deps: PaymentWorkflowDeps,
  step: PaymentWorkflowStep,
  paidVia: string,
  priceUSD: number,
): Promise<PaymentWorkflowOutcome> {
  try {
    const started = await step.do("start-screener", () => deps.startScreener(params));
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await step.do("issue-failure-credit", async () => {
      await deps.issueFailureCredit(params.runRequestId, priceUSD);
      await deps.recordEvent({
        runRequestId: params.runRequestId,
        tenantId: params.tenantId,
        type: "payment.failure_credit_issued",
        priceUSD,
      });
    });
    return { status: "screener_failed_credit_issued", runRequestId: params.runRequestId, screenerError: message };
  }
}
