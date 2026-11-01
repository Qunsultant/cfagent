/**
 * Issue #2204 (sub-issue of #2012) — refund domain service
 * (implementation of the #2147 design).
 *
 * Port-first (ADR 0002 R1): this module depends only on port
 * interfaces (refund, subscription, commercial, journal-entry
 * types) and on the injected gateway executor. It imports no store
 * client, no gateway SDK, no env binding, and performs no fetch.
 * The route adapts PaymentGatewayService to RefundGatewayExecutor
 * and the subscription store to RefundPaymentSourceResolver; the
 * service never sees either concrete class. A structural test pins
 * the import rule.
 *
 * Lifecycle enforced here (the route only authenticates and
 * authorizes; it cannot widen these rules):
 * - request: policy-checked (crypto refused, amount/window rules)
 *   and recorded as "requested". A subscription request resolves
 *   its payment source authoritatively from the subscription row
 *   (#2200 Stripe ids); a legacy subscription row with no stored
 *   payment-intent id is refused at request time, not queued for
 *   an execution that can never resolve. A pay-per-run request
 *   carries requester-supplied original details that the
 *   approving operator verifies before approving, until the
 *   native ledger slice (#2194) wires its run→PI lookup into the
 *   resolver seam.
 * - decide: "requested" -> "approved" | "denied" only. The service
 *   records the approver; the route restricts approvers to the
 *   operator list (policy approver is operator_hitl only).
 * - execute: approved (or retry from execution_failed) + flag ON
 *   + current-policy re-validation + resolvable payment-intent id
 *   + card rail, then gateway execution, entitlement consequences,
 *   best-effort journal post, and the executed mark. A journal or
 *   entitlement failure never un-moves money that already moved:
 *   both are loud-logged and recorded, and execution still marks.
 * - compensation XOR (#2549, owner decision 2026-10-31 — both
 *   mechanisms stand, one per failure): the automatic failure
 *   compensation for a paid run is a one-time replacement-run
 *   credit; this service is the operator-initiated cash path and
 *   never fires automatically. A pay-per-run execution therefore
 *   consults the injected failure-credit lookup BEFORE the
 *   gateway call: a run that already received its failure credit
 *   is refused (credit XOR refund for the same failure), and a
 *   pay-per-run execution with no lookup wired is refused rather
 *   than unchecked. A lookup failure also refuses — no money
 *   moves on an unverifiable compensation state.
 */
import type { CommercialStore } from "../data/commercialPorts";
import type { JournalEntryInput } from "../data/journalPorts";
import {
  assertRefundKind,
  CRYPTO_NON_REFUNDABLE_MESSAGE,
  round2,
  validateRefundRequest,
  type RefundPaymentSource,
  type RefundPaymentSourceResolver,
  type RefundPolicy,
  type RefundPolicyStore,
  type RefundRecord,
  type RefundStore,
} from "../data/refundPorts";
import type { SubscriptionStore } from "../data/subscriptionPorts";

/**
 * Issue #2549: reads whether the automatic replacement-run
 * credit was already issued for a run (the payment ledgers'
 * credit rows are the record). Injected so the service stays
 * port-first; the route wires both ledgers, tests stub it.
 */
export interface FailureCreditLookup {
  hasFailureCredit(runRequestId: string): Promise<boolean>;
}

/** The gateway surface the service needs: Stripe refund by payment-intent id. */
export interface RefundGatewayExecutor {
  executeRefund(params: {
    transactionId: string;
    amount: number;
    gateway: "stripe";
    gatewayRef: string;
    userLogin: string;
    reason: string;
  }): Promise<{
    success: boolean;
    refundId: string;
    amountRefunded: number;
    message: string;
  }>;
}

/**
 * Subscription payment source, from the #2200 Stripe ids on the
 * subscription row. A row is found by subscription id OR by its
 * provider payment ref (the `sub-` draft id), since a requester may
 * hold either. Rail mapping: "stripe" -> card; "x402" -> crypto;
 * anything else (legacy "cfpay" rows) -> null rail, which the
 * service refuses as unresolvable rather than guessing.
 */
export function createSubscriptionPaymentResolver(subs: SubscriptionStore): RefundPaymentSourceResolver {
  return {
    async resolve(originalPaymentRef: string): Promise<RefundPaymentSource | null> {
      const sub =
        (await subs.getSubscription(originalPaymentRef)) ??
        (await subs.findByPaymentRef(originalPaymentRef));
      if (!sub) return null;
      const plan = await subs.getPlan(sub.planId).catch(() => null);
      return {
        paymentIntentId: sub.stripePaymentIntentId,
        rail: sub.provider === "stripe" ? "card" : sub.provider === "x402" ? "crypto" : null,
        originalAmountUSD: plan ? plan.priceUSD : null,
        originalPaidAtMs: sub.createdAtMs,
        userId: sub.userId,
        tenantId: sub.tenantId,
        subscriptionId: sub.id,
      };
    },
  };
}

export function refundNotResolvableMessage(originalPaymentRef: string): string {
  return (
    `Payment-intent id is not resolvable for ${originalPaymentRef} ` +
    `(legacy row without a stored payment-intent id, or no ledger source yet); ` +
    `refund refused — no id is guessed.`
  );
}

export interface RequestRefundInput {
  kind: unknown;
  originalPaymentRef: unknown;
  amountUSD: unknown;
  reason: unknown;
  requesterLogin: string;
  isOperator: boolean;
  tenantId?: unknown;
  originalAmountUSD?: unknown;
  originalPaidAtMs?: unknown;
  rail?: unknown;
  family?: unknown;
}

export async function requestRefund(
  deps: {
    policyStore: RefundPolicyStore;
    refundStore: RefundStore;
    sourceResolver?: RefundPaymentSourceResolver;
    nowMs?: number;
  },
  input: RequestRefundInput,
): Promise<RefundRecord> {
  const nowMs = deps.nowMs ?? Date.now();
  const policy = await deps.policyStore.getPolicy();
  if (!policy) throw new Error("Refund policy is not configured: run the refund schema ensure first.");
  const kind = assertRefundKind(input.kind);
  const originalPaymentRef =
    typeof input.originalPaymentRef === "string" && input.originalPaymentRef.trim()
      ? input.originalPaymentRef.trim()
      : (() => {
          throw new Error("originalPaymentRef is required.");
        })();
  const reason =
    typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim()
      : (() => {
          throw new Error("reason is required.");
        })();
  const amountUSD = Number(input.amountUSD);

  let source: RefundPaymentSource | null = null;
  if (kind === "subscription") {
    if (!deps.sourceResolver) {
      throw new Error("Subscription refunds require a payment-source resolver.");
    }
    source = await deps.sourceResolver.resolve(originalPaymentRef);
    if (!source) throw new Error(`No subscription found for payment reference ${originalPaymentRef}.`);
    if (source.userId !== input.requesterLogin && !input.isOperator) {
      throw new Error("Only the subscription owner or a store operator may request this refund.");
    }
    if (source.rail === "crypto") throw new Error(CRYPTO_NON_REFUNDABLE_MESSAGE);
    if (!source.paymentIntentId) {
      throw new Error(
        `Subscription ${source.subscriptionId ?? originalPaymentRef} has no stored Stripe payment-intent id ` +
          `(legacy payment); the refund cannot be executed and is refused rather than guessed.`,
      );
    }
    if (!source.rail) {
      throw new Error(
        `Subscription ${source.subscriptionId ?? originalPaymentRef} has no determinable payment rail; the refund is refused rather than guessed.`,
      );
    }
  }

  const rail =
    kind === "subscription"
      ? (source?.rail ?? "card")
      : input.rail === "card" || input.rail === "crypto"
        ? input.rail
        : (() => {
            throw new Error("rail is required for pay-per-run refunds (card or crypto).");
          })();
  const tenantId =
    source?.tenantId ??
    (typeof input.tenantId === "string" && input.tenantId.trim() ? input.tenantId.trim() : null);
  if (!tenantId) throw new Error("tenantId is required.");
  const originalAmountUSD = source?.originalAmountUSD ?? Number(input.originalAmountUSD);
  const originalPaidAtMs = source?.originalPaidAtMs ?? Number(input.originalPaidAtMs);
  if (!Number.isFinite(originalAmountUSD) || originalAmountUSD <= 0) {
    throw new Error("originalAmountUSD is required and must be a finite positive number.");
  }
  if (!Number.isFinite(originalPaidAtMs) || originalPaidAtMs <= 0) {
    throw new Error("originalPaidAtMs is required and must be a positive epoch-ms timestamp.");
  }
  validateRefundRequest(policy, { rail, amountUSD, originalAmountUSD, originalPaidAtMs }, nowMs);

  const record = await deps.refundStore.createRefund({
    id: `refund-${crypto.randomUUID().slice(0, 8)}`,
    kind,
    rail,
    tenantId,
    userId: kind === "subscription" && source?.userId ? source.userId : input.requesterLogin,
    originalPaymentRef,
    subscriptionId: source?.subscriptionId ?? null,
    paymentIntentId: source?.paymentIntentId ?? null,
    family:
      typeof input.family === "string" && input.family.trim()
        ? input.family.trim()
        : null,
    originalAmountUSD: round2(originalAmountUSD),
    amountUSD: round2(amountUSD),
    originalPaidAtMs: Math.floor(originalPaidAtMs),
    reason,
    status: "requested",
    approverLogin: null,
    decisionNote: null,
    gatewayRefundId: null,
    executedAtMs: null,
    entitlementConsequence: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  return record;
}

export async function decideRefund(
  deps: { refundStore: RefundStore; nowMs?: number },
  input: { refundId: string; decision: "approve" | "deny"; approverLogin: string; note?: string },
): Promise<RefundRecord> {
  const nowMs = deps.nowMs ?? Date.now();
  const record = await deps.refundStore.getRefund(input.refundId);
  if (!record) throw new Error(`No refund ${input.refundId}.`);
  if (record.status !== "requested") {
    throw new Error(`Refund ${input.refundId} cannot be decided from status ${record.status}.`);
  }
  return deps.refundStore.updateRefund(input.refundId, {
    status: input.decision === "approve" ? "approved" : "denied",
    approverLogin: input.approverLogin,
    decisionNote: input.note?.trim() ? input.note.trim() : null,
    updatedAtMs: nowMs,
  });
}

/**
 * Entitlement consequences of an executed refund, per the CURRENT
 * policy. Best-effort by design: the caller (executeRefund) logs
 * and records a failure here but never un-moves money over it.
 * Returns the consequence summary stored on the refund record.
 */
export async function applyRefundEntitlements(
  deps: {
    subscriptionStore?: SubscriptionStore;
    commercialStore?: CommercialStore;
    sourceResolver?: RefundPaymentSourceResolver;
    /**
     * Issue #2549: for a pay-per-run refund, whether the run's
     * automatic failure credit was issued — executeRefund always
     * resolves this through the XOR guard before calling here
     * (an issued credit refuses execution, so an executed refund
     * records "no"); a direct caller that did not check records
     * "unchecked" rather than claiming a fact it never read.
     */
    failureCreditIssued?: boolean;
  },
  record: RefundRecord,
  policy: RefundPolicy,
  nowMs: number,
): Promise<string> {
  let base: string;
  if (record.kind === "pay_per_run") {
    const creditFact =
      deps.failureCreditIssued === undefined
        ? "unchecked"
        : deps.failureCreditIssued
          ? "yes"
          : "no";
    base = `none:run_already_delivered;failure_credit_issued:${creditFact}`;
  } else {
    let subId = record.subscriptionId;
    if (!subId && deps.sourceResolver) {
      const source = await deps.sourceResolver.resolve(record.originalPaymentRef);
      subId = source?.subscriptionId ?? null;
    }
    const sub =
      subId && deps.subscriptionStore ? await deps.subscriptionStore.getSubscription(subId) : null;
    if (!sub) {
      base = "subscription_not_found:entitlement_unchanged";
    } else {
      const isFull = round2(record.amountUSD) === round2(record.originalAmountUSD);
      const effect = isFull ? policy.subscriptionFullEffect : policy.subscriptionPartialEffect;
      if (effect === "keep_access") {
        base = "access_kept:partial_refund";
      } else if (effect === "cancel_at_period_end") {
        if (deps.subscriptionStore) {
          await deps.subscriptionStore.cancelUnexpiredSubscriptions(sub.userId, nowMs);
        }
        base = "subscription_canceled_at_period_end:access_continues_to_period_end";
      } else {
        if (deps.subscriptionStore) {
          await deps.subscriptionStore.revokeSubscription(sub.id, nowMs);
        }
        let removedNote = "included_runs_unchanged:account_or_plan_missing";
        if (deps.subscriptionStore && deps.commercialStore) {
          const plan = await deps.subscriptionStore.getPlan(sub.planId).catch(() => null);
          const account = await deps.commercialStore.getAccount(sub.userId);
          if (plan && account) {
            const remaining = Math.max(0, account.includedRuns - plan.includedRuns);
            await deps.commercialStore.upsertAccount({
              userId: account.id,
              tenantId: account.tenantId,
              tier: account.tier,
              tierSource: account.tierSource,
              creditsUSD: account.creditsUSD,
              includedRuns: remaining,
            });
            removedNote = `included_runs_removed:${account.includedRuns - remaining}`;
          }
        }
        base = `subscription_revoked:period_ended_at_${nowMs};${removedNote}`;
      }
    }
  }
  return `${base};credits_unchanged`;
}

/** Balanced double-entry journal effect of a refund: Dr 5000 (refunds contra-revenue) / Cr 1000 (funds). */
export function buildRefundJournalEntries(record: RefundRecord): JournalEntryInput[] {
  const transactionRef = `${record.id}:refund`;
  const family = record.family ?? (record.kind === "subscription" ? "subscription" : "pay_per_run");
  return [
    {
      transactionRef,
      accountCode: "5000",
      debitUSD: record.amountUSD,
      creditUSD: 0,
      currency: "USD",
      tenantId: record.tenantId,
      runRequestId: record.originalPaymentRef,
      family,
    },
    {
      transactionRef,
      accountCode: "1000",
      debitUSD: 0,
      creditUSD: record.amountUSD,
      currency: "USD",
      tenantId: record.tenantId,
      runRequestId: record.originalPaymentRef,
      family,
    },
  ];
}

export async function executeRefund(
  deps: {
    policyStore: RefundPolicyStore;
    refundStore: RefundStore;
    sourceResolver?: RefundPaymentSourceResolver;
    subscriptionStore?: SubscriptionStore;
    commercialStore?: CommercialStore;
    gateway: RefundGatewayExecutor;
    postJournal?: (entries: JournalEntryInput[]) => Promise<void>;
    /** Issue #2549: required for pay-per-run execution (XOR guard). */
    failureCreditLookup?: FailureCreditLookup;
    monetizationEnabled: boolean;
    nowMs?: number;
  },
  input: { refundId: string },
): Promise<RefundRecord> {
  const nowMs = deps.nowMs ?? Date.now();
  if (!deps.monetizationEnabled) {
    throw new Error("monetization flag is OFF; refund execution is disabled.");
  }
  const record = await deps.refundStore.getRefund(input.refundId);
  if (!record) throw new Error(`No refund ${input.refundId}.`);
  if (record.status !== "approved" && record.status !== "execution_failed") {
    throw new Error(`Only an approved refund may execute (refund ${input.refundId} is ${record.status}).`);
  }
  const policy = await deps.policyStore.getPolicy();
  if (!policy) throw new Error("Refund policy is not configured: run the refund schema ensure first.");
  if (policy.approver !== "operator_hitl") {
    throw new Error('Refund approver policy must be "operator_hitl" in this slice.');
  }
  // Re-validate against the CURRENT policy: a policy change between
  // approval and execution cannot widen an approved refund.
  validateRefundRequest(
    policy,
    {
      rail: record.rail,
      amountUSD: record.amountUSD,
      originalAmountUSD: record.originalAmountUSD,
      originalPaidAtMs: record.originalPaidAtMs,
    },
    nowMs,
  );
  let paymentIntentId = record.paymentIntentId;
  if (!paymentIntentId && record.kind === "subscription" && deps.sourceResolver) {
    const source = await deps.sourceResolver.resolve(record.originalPaymentRef);
    paymentIntentId = source?.paymentIntentId ?? null;
  }
  if (!paymentIntentId) {
    throw new Error(refundNotResolvableMessage(record.originalPaymentRef));
  }
  // Issue #2549 — compensation XOR at the money gate: a
  // pay-per-run run that already received its automatic
  // replacement-run credit must not also be cash-refunded for
  // the same failure. Checked after payment-intent resolution
  // and before the gateway call, so a refusal never moves money;
  // an unwired or failing lookup also refuses (fail closed).
  let failureCreditIssued = false;
  if (record.kind === "pay_per_run") {
    if (!deps.failureCreditLookup) {
      throw new Error(
        "Pay-per-run refund execution requires a failure-credit lookup (issue #2549): " +
          "execution is refused rather than risk double compensation.",
      );
    }
    failureCreditIssued = await deps.failureCreditLookup.hasFailureCredit(record.originalPaymentRef);
    if (failureCreditIssued) {
      throw new Error(
        `Run ${record.originalPaymentRef} already received its automatic replacement-run credit ` +
          `for this failure; a cash refund on top would double-compensate the same failure ` +
          `(credit XOR refund per failure, issue #2549). Refund refused.`,
      );
    }
  }
  const result = await deps.gateway.executeRefund({
    transactionId: record.id,
    amount: record.amountUSD,
    gateway: "stripe",
    gatewayRef: paymentIntentId,
    userLogin: record.userId,
    reason: record.reason,
  });
  if (!result.success) {
    await deps.refundStore.updateRefund(record.id, { status: "execution_failed", updatedAtMs: nowMs });
    throw new Error(`Gateway refund failed: ${result.message || "unknown gateway error"}`);
  }
  let consequence: string;
  try {
    consequence = await applyRefundEntitlements(
      {
        subscriptionStore: deps.subscriptionStore,
        commercialStore: deps.commercialStore,
        sourceResolver: deps.sourceResolver,
        failureCreditIssued,
      },
      record,
      policy,
      nowMs,
    );
  } catch (err) {
    console.error(
      "[refund] entitlement application failed — refund already executed, consequence recorded:",
      err instanceof Error ? err.message : String(err),
    );
    consequence = "entitlement_application_failed:see_operator_log;credits_unchanged";
  }
  if (deps.postJournal) {
    try {
      await deps.postJournal(buildRefundJournalEntries(record));
    } catch (err) {
      // The journal is a projection, never the financial record:
      // a journal failure never fails an executed refund.
      console.error(
        "[refund] journal post failed — refund execution unaffected:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return deps.refundStore.updateRefund(record.id, {
    status: "executed",
    gatewayRefundId: result.refundId,
    executedAtMs: nowMs,
    entitlementConsequence: consequence,
    updatedAtMs: nowMs,
  });
}
