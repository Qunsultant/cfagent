/**
 * Issue #2204 (sub-issue of #2012) — refund port: refund records +
 * externalized refund policy (implementation of the #2147 design).
 *
 * Refunds are OPERATOR DATA + operator HITL, never code constants:
 * the refund window, the approver, partial-vs-full rules, and the
 * entitlement/credit consequences live in the policy store, seeded
 * at migration time with PROPOSED defaults (pending owner
 * approval) and changeable by an operator with no code deploy.
 *
 * Port-first (ADR 0002 R1): this module carries record types,
 * the port interfaces, and pure validation ONLY. It imports no
 * store client, references no env binding, and writes no SQL.
 * All query-builder code lives in d1RefundAdapter.ts; the
 * in-memory adapter shares the validators below so the two
 * implementations cannot drift. A structural test pins the
 * import rule.
 *
 * Fail-closed contract, stated once:
 * - Crypto (x402) payments are NON-REFUNDABLE in this slice: a
 *   settled on-chain transfer has no refund operation, and a
 *   compensating operator payout (new custody + signing surface)
 *   is a separate owner decision that is NOT built here. A crypto
 *   refund request is refused with CRYPTO_NON_REFUNDABLE_MESSAGE.
 * - A refund executes only from status "approved" (or a retry from
 *   "execution_failed"), only with the monetization flag ON, and
 *   only when a Stripe payment-intent id resolves for the original
 *   payment. A legacy row with no stored payment-intent id fails
 *   closed with a clear error — an id is never guessed.
 * - Amount and window rules are re-validated at execution time
 *   against the CURRENT policy, so a policy change between
 *   approval and execution cannot widen an approved refund.
 * - No automatic refunds exist in this slice: the only approver
 *   value is "operator_hitl".
 */

/** What was paid for: a subscription period, or one pay-per-run charge. */
export type RefundKind = "subscription" | "pay_per_run";

/** Payment rail of the original payment. */
export type RefundRail = "card" | "crypto";

/**
 * Refund lifecycle. "requested" -> "approved" | "denied"; an approved
 * refund -> "executed", or -> "execution_failed" on a gateway
 * failure (a retry from "execution_failed" is allowed). No other
 * transition exists: an unapproved refund can never execute.
 */
export type RefundStatus =
  | "requested"
  | "approved"
  | "denied"
  | "executed"
  | "execution_failed";

export function assertRefundKind(kind: unknown): RefundKind {
  if (kind !== "subscription" && kind !== "pay_per_run") {
    throw new Error(`Invalid refund kind: ${String(kind)} (must be subscription or pay_per_run).`);
  }
  return kind;
}

export function assertRefundRail(rail: unknown): RefundRail {
  if (rail !== "card" && rail !== "crypto") {
    throw new Error(`Invalid refund rail: ${String(rail)} (must be card or crypto).`);
  }
  return rail;
}

export function assertRefundStatus(status: unknown): RefundStatus {
  if (
    status !== "requested" &&
    status !== "approved" &&
    status !== "denied" &&
    status !== "executed" &&
    status !== "execution_failed"
  ) {
    throw new Error(`Invalid refund status: ${String(status)}.`);
  }
  return status;
}

/** Money is stored to the cent; anything finer is a caller bug, not a rounding policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertMoney(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${field} must be a finite positive number.`);
  }
  return round2(n);
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

/**
 * Crypto is non-refundable in this slice (see module header). This
 * message is the refusal everywhere — request, approval, and
 * execution — so no path can silently reinterpret it.
 */
export const CRYPTO_NON_REFUNDABLE_MESSAGE =
  "Crypto (x402) payments are non-refundable: a settled on-chain transfer has no refund operation, " +
  "and a compensating operator payout is a separate owner decision (new custody + signing surface) " +
  "that is not built in this slice. If a crypto-paid run failed to start, a replacement-run credit applies instead.";

/** One day in epoch-ms; the refund window is whole days. */
export const MS_PER_DAY = 86_400_000;

/** Effect of a FULL subscription refund on the refunded period. */
export type SubscriptionFullRefundEffect = "revoke_immediately" | "cancel_at_period_end";
/** Effect of a PARTIAL subscription refund on the refunded period. */
export type SubscriptionPartialRefundEffect = "keep_access" | "revoke_immediately";
/** Effect of a pay-per-run refund. Only "none" exists in this slice. */
export type PayPerRunRefundEffect = "none";
/** Effect of any refund on credit claims. Only "none" exists in this slice. */
export type CreditRefundEffect = "none";
/** Approver of a refund. Only operator HITL exists in this slice. */
export type RefundApprover = "operator_hitl";

/**
 * The externalized refund policy: one row, operator data. Every
 * field is validated by assertRefundPolicy, shared by both
 * adapters, so a bad policy row can never be written through
 * either implementation.
 */
export interface RefundPolicy {
  /** Whole days from the original payment inside which a refund may be requested and executed. */
  windowDays: number;
  /** Who approves a refund. Only "operator_hitl" in this slice. */
  approver: RefundApprover;
  /** When false, only a refund equal to the original amount is allowed (full-only). */
  allowPartial: boolean;
  /** What a FULL subscription refund does to the refunded period. */
  subscriptionFullEffect: SubscriptionFullRefundEffect;
  /** What a PARTIAL subscription refund does to the refunded period. */
  subscriptionPartialEffect: SubscriptionPartialRefundEffect;
  /** What a pay-per-run refund does. Only "none" in this slice. */
  payPerRunEffect: PayPerRunRefundEffect;
  /** What a refund does to credit claims. Only "none" in this slice. */
  creditEffect: CreditRefundEffect;
  updatedAtMs: number;
}

/**
 * PROPOSED seed policy, NOT owner-approved and NOT an activation.
 * Seeded into the store at schema-ensure time (migration 0018) so
 * a fresh store has a policy to read; the service never reads this
 * constant at runtime. An owner-approved policy replaces these
 * rows in operator data, not in code.
 *
 * - 30-day window; operator-HITL approval only; full-only refunds.
 * - Full subscription refund revokes the period immediately and
 *   removes the plan's included runs from the account.
 * - Partial subscription refund keeps access (a partial refund is
 *   a goodwill adjustment, not a cancellation).
 * - Pay-per-run refunds and credit claims: no consequence — the
 *   run was already delivered, and claims are replacement-run
 *   entitlements, not cash. The approving operator verifies no
 *   failure credit was issued for the refunded payment before
 *   approving (double-recovery check).
 */
export const PROPOSED_SEED_POLICY: Omit<RefundPolicy, "updatedAtMs"> = {
  windowDays: 30,
  approver: "operator_hitl",
  allowPartial: false,
  subscriptionFullEffect: "revoke_immediately",
  subscriptionPartialEffect: "keep_access",
  payPerRunEffect: "none",
  creditEffect: "none",
};

/**
 * PROPOSED refund disclosure copy (issue #2204), NOT owner-approved.
 * This copy is the disclosure the UI slice will later surface
 * before payment; it is not wired into the UI in this slice.
 */
export const REFUND_POLICY_COPY =
  "Refunds are available within 30 days of payment and require operator approval. " +
  "Refunds are never automatic: the automatic compensation for a failed paid run is a replacement-run credit, and a run that already received that credit is not also cash-refunded. " +
  "Card payments may be refunded in full (partial refunds only if the operator policy allows them). " +
  "Crypto (x402) payments are non-refundable; if a crypto-paid run fails to start, a replacement-run credit applies instead. " +
  "A refunded subscription period ends immediately and its included runs are removed, unless the operator policy keeps access to the end of the period. " +
  "Refund decisions are recorded and audited.";

const POLICY_FIELDS = [
  "windowDays",
  "approver",
  "allowPartial",
  "subscriptionFullEffect",
  "subscriptionPartialEffect",
  "payPerRunEffect",
  "creditEffect",
] as const;

type PolicyField = (typeof POLICY_FIELDS)[number];

/** Validate a full policy row (shared by both adapters). */
export function assertRefundPolicy(input: {
  windowDays?: unknown;
  approver?: unknown;
  allowPartial?: unknown;
  subscriptionFullEffect?: unknown;
  subscriptionPartialEffect?: unknown;
  payPerRunEffect?: unknown;
  creditEffect?: unknown;
}): Omit<RefundPolicy, "updatedAtMs"> {
  const windowDays = Number(input.windowDays);
  if (!Number.isFinite(windowDays) || Math.floor(windowDays) !== windowDays || windowDays < 1 || windowDays > 365) {
    throw new Error("windowDays must be an integer between 1 and 365.");
  }
  if (input.approver !== "operator_hitl") {
    throw new Error('approver must be "operator_hitl" (automatic refunds are not built in this slice).');
  }
  if (typeof input.allowPartial !== "boolean") {
    throw new Error("allowPartial must be a boolean.");
  }
  if (input.subscriptionFullEffect !== "revoke_immediately" && input.subscriptionFullEffect !== "cancel_at_period_end") {
    throw new Error('subscriptionFullEffect must be "revoke_immediately" or "cancel_at_period_end".');
  }
  if (input.subscriptionPartialEffect !== "keep_access" && input.subscriptionPartialEffect !== "revoke_immediately") {
    throw new Error('subscriptionPartialEffect must be "keep_access" or "revoke_immediately".');
  }
  if (input.payPerRunEffect !== "none") {
    throw new Error('payPerRunEffect must be "none" in this slice.');
  }
  if (input.creditEffect !== "none") {
    throw new Error('creditEffect must be "none" in this slice.');
  }
  return {
    windowDays,
    approver: "operator_hitl",
    allowPartial: input.allowPartial,
    subscriptionFullEffect: input.subscriptionFullEffect,
    subscriptionPartialEffect: input.subscriptionPartialEffect,
    payPerRunEffect: "none",
    creditEffect: "none",
  };
}

/** Validate a partial policy update: unknown fields throw (a typo must not silently no-op). */
export function assertRefundPolicyPatch(
  patch: Record<string, unknown>,
  current: RefundPolicy,
): Omit<RefundPolicy, "updatedAtMs"> {
  for (const key of Object.keys(patch)) {
    if (!(POLICY_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Unknown refund policy field: ${key}.`);
    }
  }
  const merged: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch)) {
    merged[key] = patch[key];
  }
  return assertRefundPolicy(merged as Parameters<typeof assertRefundPolicy>[0]);
}

/** The refund policy store surface. Null policy = unconfigured store (fail closed). */
export interface RefundPolicyStore {
  getPolicy(): Promise<RefundPolicy | null>;
  /** Partial update, validated; returns the new policy row. Throws when no policy row exists yet. */
  setPolicy(patch: Record<string, unknown>): Promise<RefundPolicy>;
}

/** One refund request, from request through decision to execution. */
export interface RefundRecord {
  id: string;
  kind: RefundKind;
  rail: RefundRail;
  tenantId: string;
  /** The payer's verified login (the refund requester, or the subscription owner). */
  userId: string;
  /** The original payment reference: subscription id or provider payment ref, or a pay-per-run runRequestId. */
  originalPaymentRef: string;
  /** The refunded subscription's row id, when kind is subscription; null otherwise. */
  subscriptionId: string | null;
  /** Stripe payment-intent id the gateway refund needs. Null until resolved (pay-per-run without a ledger source). */
  paymentIntentId: string | null;
  /** Screener family, when known (pay-per-run journal attribution); null for subscriptions. */
  family: string | null;
  /** Original charge amount, USD. */
  originalAmountUSD: number;
  /** Requested refund amount, USD. */
  amountUSD: number;
  /** When the original payment landed, epoch-ms (window anchor). */
  originalPaidAtMs: number;
  reason: string;
  status: RefundStatus;
  /** Operator login that approved or denied, once decided. */
  approverLogin: string | null;
  /** Operator note recorded with the decision. */
  decisionNote: string | null;
  /** Gateway refund id (e.g. Stripe `re_*`), once executed. */
  gatewayRefundId: string | null;
  executedAtMs: number | null;
  /** Human-readable summary of the entitlement consequences applied at execution, once executed. */
  entitlementConsequence: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type RefundCreateInput = Omit<RefundRecord, "createdAtMs" | "updatedAtMs">;

/**
 * Shared record validation for both adapters: kinds, rails, money,
 * and the amount/window rules that do not depend on a store. The
 * policy-dependent rules (partial allowed, window length) live in
 * validateRefundRequest below, applied by the service at request
 * AND execution time.
 */
export function assertRefundRecord(input: RefundCreateInput): RefundCreateInput {
  const kind = assertRefundKind(input.kind);
  const rail = assertRefundRail(input.rail);
  const status = assertRefundStatus(input.status);
  const originalAmountUSD = assertMoney(input.originalAmountUSD, "originalAmountUSD");
  const amountUSD = assertMoney(input.amountUSD, "amountUSD");
  if (amountUSD > originalAmountUSD) {
    throw new Error(`Refund amount $${amountUSD} exceeds the original amount $${originalAmountUSD}.`);
  }
  return {
    ...input,
    id: assertNonEmptyString(input.id, "id"),
    kind,
    rail,
    tenantId: assertNonEmptyString(input.tenantId, "tenantId"),
    userId: assertNonEmptyString(input.userId, "userId"),
    originalPaymentRef: assertNonEmptyString(input.originalPaymentRef, "originalPaymentRef"),
    originalAmountUSD,
    amountUSD,
    originalPaidAtMs:
      Number.isFinite(input.originalPaidAtMs) && input.originalPaidAtMs > 0
        ? Math.floor(input.originalPaidAtMs)
        : (() => {
            throw new Error("originalPaidAtMs must be a positive epoch-ms timestamp.");
          })(),
    reason: assertNonEmptyString(input.reason, "reason"),
    status,
  };
}

/**
 * Policy-dependent request rules, applied by the service at request
 * time AND re-applied at execution time against the current policy.
 * Crypto is refused first: a crypto refund is never a window or
 * amount question.
 */
export function validateRefundRequest(
  policy: RefundPolicy,
  input: {
    rail: RefundRail;
    amountUSD: number;
    originalAmountUSD: number;
    originalPaidAtMs: number;
  },
  nowMs: number,
): void {
  if (input.rail === "crypto") {
    throw new Error(CRYPTO_NON_REFUNDABLE_MESSAGE);
  }
  const amountUSD = round2(input.amountUSD);
  const originalAmountUSD = round2(input.originalAmountUSD);
  if (amountUSD > originalAmountUSD) {
    throw new Error(`Refund amount $${amountUSD} exceeds the original amount $${originalAmountUSD}.`);
  }
  if (!policy.allowPartial && amountUSD !== originalAmountUSD) {
    throw new Error(
      `Partial refunds are not allowed by the current refund policy (requested $${amountUSD} of $${originalAmountUSD}); request the full amount.`,
    );
  }
  if (!Number.isFinite(input.originalPaidAtMs) || input.originalPaidAtMs > nowMs) {
    throw new Error("originalPaidAtMs must not be in the future.");
  }
  if (nowMs - input.originalPaidAtMs > policy.windowDays * MS_PER_DAY) {
    throw new Error(
      `Refund window expired: the original payment is older than the ${policy.windowDays}-day refund window.`,
    );
  }
}

/** The refund record store surface. */
export interface RefundStore {
  createRefund(input: RefundCreateInput & { createdAtMs: number; updatedAtMs: number }): Promise<RefundRecord>;
  getRefund(refundId: string): Promise<RefundRecord | null>;
  /** All refunds for one user, oldest first. No unscoped read. */
  listRefunds(userId: string): Promise<RefundRecord[]>;
  /** Field patch; the caller sets updatedAtMs. Returns the updated record; throws when missing. */
  updateRefund(
    refundId: string,
    patch: Partial<RefundRecord> & { updatedAtMs: number },
  ): Promise<RefundRecord>;
}

/**
 * The payment-intent resolution seam for refunds. The subscription
 * implementation (in refundService.ts) reads the #2200 Stripe ids
 * off the subscription row. Pay-per-run resolution belongs to the
 * native ledger slice (#2194): until that slice wires its run→PI
 * lookup in here, a pay-per-run refund has no source and fails
 * closed at execution — never a guessed id.
 */
export interface RefundPaymentSource {
  /** Stripe payment-intent id, or null when the source row carries none (legacy). */
  paymentIntentId: string | null;
  /** Rail of the original payment, or null when the source cannot say (legacy cfpay rows). */
  rail: RefundRail | null;
  originalAmountUSD: number | null;
  originalPaidAtMs: number | null;
  userId: string | null;
  tenantId: string | null;
  /** The subscription row id, when the source is a subscription. */
  subscriptionId: string | null;
}

export interface RefundPaymentSourceResolver {
  resolve(originalPaymentRef: string): Promise<RefundPaymentSource | null>;
}
