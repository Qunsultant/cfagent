/**
 * Saga mid-run failure compensation — issue #2041 S3.
 *
 * One compensation per paid run, ever, whatever the form. Leg 1
 * failed/deadline routes through compensateFailedScreen (the single
 * call site); the three failure branches are mutually exclusive by
 * control flow, so a run compensates exactly once.
 *
 * Form selection (grounded in src/services/nativeMonetization.ts
 * paidVia values): refund-request ONLY when the run's rail is
 * "stripe" AND the payment leg's paidVia is "stripe_checkout" —
 * i.e. a card checkout actually charged cash. Everything else
 * (x402, covered runs, unknown rail/paidVia) takes the credit
 * form: a covered run must never get a refund request, because
 * no cash was charged and the request would consume the
 * one-compensation slot with a record that should never execute.
 *
 * Stripe is REQUEST-first, never execute (Q10 working default).
 * requestRefund for pay-per-run does not require operator status
 * — the operator verifies the requester-supplied details at
 * approval — but decideRefund and executeRefund stay operator-only
 * and the operator route's authorization is untouched. The saga
 * never calls decide/execute and never claims operator status.
 * Full automated execution would need the saga to approve its own
 * record, contradicting the refund policy ("No automatic refunds
 * exist in this slice", approver operator_hitl only) — that needs
 * a Q10 ruling change, not an implementation assumption.
 *
 * Credit fallback: when a refund is unavailable — ports unbound,
 * monetization flag OFF (checked here because requestRefund does
 * not check the flag; the operator route does), no policy row, or
 * request validation failure — the saga issues the credit instead.
 * The fallback reason is recorded on the audit event, never hidden.
 *
 * Dedupe: the credit form dedupes at the ledger (DO credit row
 * deduped per run, D1 claim re-record is a no-op); the refund
 * form pre-checks listRefunds for an existing record with the same
 * originalPaymentRef and returns it without creating. Retries
 * re-run the pre-check, so a create that landed before a crash is
 * never duplicated. createRefund is the last statement of
 * requestRefund, so a throw after a successful create is not a
 * live path.
 *
 * Compensation failure is fail-loud: a throwing dep fails the step
 * (durably retried), never a terminal uncompensated outcome — the
 * payment leg's issueFailureCredit precedent.
 *
 * Price provenance: priceUSD comes from the payment "started"
 * outcome (S3 extends it with the existing gateDecision.priceUSD
 * — plumbing, not new pricing). paidAtMs is the saga's Leg-0
 * completion time: the payment flow knows no trustworthy paid
 * timestamp, and the 30-day window makes the minutes-wide
 * approximation immaterial; it is recorded as
 * paidAtMsSource "leg0_completion" on the audit event so the
 * operator sees exactly what it is.
 *
 * Disclosure: sagaCompensationDisclosure is the single source for
 * the per-rail compensation lines; the journey-gate copy imports
 * it (no drift). Pre-payment saga copy cannot be wired until the
 * S4 entry route exists — the constant is written here, its S4
 * wiring recorded as S4 work. The shared NATIVE_PAYMENT_DISCLOSURE
 * string is untouched (non-saga paid runs must not change meaning).
 */

import { requestRefund } from "../services/refundService";
import type { RefundPolicyStore, RefundStore } from "../data/refundPorts";

/** Compensation forms. "refund-request" is a request, never an execution. */
export type SagaCompensationForm = "refund-request" | "credit";

/** Refund ports as the compensation step consumes them (port interfaces). */
export interface SagaRefundPorts {
  store: RefundStore;
  policy: RefundPolicyStore;
}

export interface SagaCompensationInput {
  sagaId: string;
  runRequestId: string;
  userLogin: string;
  tenantId: string;
  family: string;
  rail?: "stripe" | "x402";
  paidVia?: string;
  /** Gate price from the payment "started" outcome; must be positive. */
  priceUSD: number | undefined;
  /** Leg-0 completion time (window-validation approximation — see header). */
  paidAtMs: number;
  /** The screen failure reason (deadline / errored-terminated / unrecognized). */
  reason: string;
}

export interface SagaCompensationDeps {
  /** Fail-loud credit issuance, payment-leg shape (DO ledger + D1 claim). */
  issueCredit: (runRequestId: string, priceUSD: number) => Promise<void>;
  /** Lazy refund ports; null when AGENT_DB is unbound (fail-closed to credit). */
  getRefundPorts: () => Promise<SagaRefundPorts | null>;
  /** Monetization flag, mirroring the operator route's requireRefundFlag. */
  monetizationEnabled: () => Promise<boolean>;
  nowMs: () => number;
}

export interface SagaCompensationResult {
  form: SagaCompensationForm;
  refundId?: string;
  creditRunId?: string;
  /** True when an existing refund record was returned (dedupe hit). */
  existing?: boolean;
  /** Set on the credit form when a refund was attempted first and unavailable. */
  fallbackReason?: string;
}

/**
 * Refund-request form ONLY for a stripe card checkout; every other
 * rail/paidVia combination takes the credit form. Unknown rail or
 * paidVia falls back to credit — never to a refund promise.
 */
export function selectCompensationForm(input: {
  rail?: "stripe" | "x402";
  paidVia?: string;
}): SagaCompensationForm {
  return input.rail === "stripe" && input.paidVia === "stripe_checkout"
    ? "refund-request"
    : "credit";
}

/**
 * Compensate one failed paid screen. Exactly one compensation per
 * run: the credit form dedupes at the ledger/claim, the refund
 * form dedupes via the existing-record pre-check, and the caller
 * (the flow) invokes this exactly once per failed-screen run.
 * Throws only when no compensation can be recorded at all
 * (missing price, or the credit fallback itself failing) — the
 * step then retries durably instead of completing uncompensated.
 */
export async function compensateFailedScreen(
  deps: SagaCompensationDeps,
  input: SagaCompensationInput,
): Promise<SagaCompensationResult> {
  if (
    typeof input.priceUSD !== "number" ||
    !Number.isFinite(input.priceUSD) ||
    input.priceUSD <= 0
  ) {
    throw new Error(
      `Refusing to compensate failed screen for run ${input.runRequestId} without a positive price.`,
    );
  }
  const priceUSD = input.priceUSD;
  const creditFallback = async (fallbackReason: string): Promise<SagaCompensationResult> => {
    await deps.issueCredit(input.runRequestId, priceUSD);
    return { form: "credit", creditRunId: input.runRequestId, fallbackReason };
  };
  if (selectCompensationForm(input) === "credit") {
    await deps.issueCredit(input.runRequestId, priceUSD);
    return { form: "credit", creditRunId: input.runRequestId };
  }
  const ports = await deps.getRefundPorts();
  if (!ports) {
    return creditFallback("refund ports unbound; credit fallback");
  }
  if (!(await deps.monetizationEnabled())) {
    return creditFallback("monetization flag OFF; credit fallback");
  }
  const existing = (await ports.store.listRefunds(input.userLogin)).find(
    (r) => r.originalPaymentRef === input.runRequestId,
  );
  if (existing) {
    return { form: "refund-request", refundId: existing.id, existing: true };
  }
  try {
    const record = await requestRefund(
      { policyStore: ports.policy, refundStore: ports.store, nowMs: deps.nowMs() },
      {
        kind: "pay_per_run",
        originalPaymentRef: input.runRequestId,
        amountUSD: priceUSD,
        reason: input.reason,
        requesterLogin: input.userLogin,
        isOperator: false,
        tenantId: input.tenantId,
        originalAmountUSD: priceUSD,
        originalPaidAtMs: input.paidAtMs,
        rail: "card",
        family: input.family,
      },
    );
    return { form: "refund-request", refundId: record.id, existing: false };
  } catch (err) {
    return creditFallback(
      `refund request unavailable (${err instanceof Error ? err.message : String(err)}); credit fallback`,
    );
  }
}

/**
 * Per-rail compensation disclosure (G-DISCLOSURE, compensation copy).
 * Stripe states the request-first reality plainly: a refund is
 * REQUESTED, operator approval is still required before money
 * moves, and credit is the fallback if a refund cannot be
 * requested. x402 states credit with no refund on this rail.
 * Unknown rail promises credit only, never a refund.
 */
export function sagaCompensationDisclosure(rail?: "stripe" | "x402"): string {
  if (rail === "stripe") {
    return (
      "If this screen had failed, a provider refund would be requested first — " +
      "operator approval is still required before money moves — with a " +
      "replacement-run credit as fallback if a refund cannot be requested."
    );
  }
  if (rail === "x402") {
    return (
      "If this screen had failed, you would have received a one-time " +
      "replacement-run credit: an on-chain payment cannot be reversed, so " +
      "there is no refund on this rail."
    );
  }
  return (
    "If this screen had failed, you would have received a one-time " +
    "replacement-run credit."
  );
}
