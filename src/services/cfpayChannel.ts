/**
 * Issue #2945 (Monetization Phase 2.17, program #2405) — cfpay as a
 * separate channel: minimal wiring within the card's actual operations.
 *
 * The card (ADR 0026, fetched live 2026-11-02) publishes NO response
 * schemas, so every retrieve judgment here is allowlist-based and
 * fail-closed:
 * - Paid statuses are an explicit allowlist: paid | completed |
 *   fulfilled | succeeded (case-insensitive). Any other vocabulary —
 *   including a missing status — refuses with FAILURE_CHANNEL_NOT_PAID.
 * - If the retrieved record carries a requestId it MUST equal the draft
 *   id; if it carries an email it MUST equal the draft email. Else refuse.
 * - NO amount is ever read from a cfpay field: the card publishes no
 *   amount semantics, so reading one would be false security. Price
 *   protection is the approved catalogue price plus the operator-attested
 *   channel fixed price at mint, plus totals-level reconciliation.
 *
 * Failures are BusinessError with outcome-catalog codes (#2381): the
 * route layer maps code → catalog httpStatus + coded message. Nothing
 * here invents a code, a price, or a payment intent.
 */
import { BusinessError } from "../outcomes/outcomeAspects";
import { assertPriceFamily, round2 } from "../data/priceCataloguePorts";
import type { ChannelDraft, ChannelDraftStore } from "../data/cfpayChannelPorts";

export type { ChannelDraft, ChannelDraftStore } from "../data/cfpayChannelPorts";

/** Paid-status vocabulary the confirm step accepts (card publishes no schema). */
export const CHANNEL_PAID_STATUSES: ReadonlySet<string> = new Set([
  "paid",
  "completed",
  "fulfilled",
  "succeeded",
]);

export interface CfpayOperationResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Minimal cfpay payments-agent surface (ADR 0026 operations only). */
export interface CfpayChannelClient {
  createCheckout(input: { requestId: string; email: string; request: string }): Promise<CfpayOperationResult>;
  getStatus(requestId: string): Promise<CfpayOperationResult>;
  fulfil(requestId: string, paymentIntentId: string): Promise<CfpayOperationResult>;
  listPayments(limit: number): Promise<CfpayOperationResult>;
  paymentsTotals(): Promise<CfpayOperationResult>;
}

export interface ChannelCatalogue {
  getApprovedPrice(family: string): Promise<number | null>;
}

export interface ChannelAccountStore {
  adjustCredits(userId: string, deltaUSD: number): Promise<{ userId: string; creditsUSD: number }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First string found across the data part's plausible status locations. */
export function extractStatusString(data: unknown): string | null {
  const root = asRecord(data);
  if (!root) return null;
  for (const key of ["status", "state"]) {
    if (typeof root[key] === "string") return root[key] as string;
  }
  for (const nest of ["result", "checkout", "data"]) {
    const inner = asRecord(root[nest]);
    if (inner && typeof inner.status === "string") return inner.status as string;
  }
  return null;
}

/** First string found across the data part's plausible id/email locations. */
export function extractField(data: unknown, field: string): string | null {
  const root = asRecord(data);
  if (!root) return null;
  if (typeof root[field] === "string") return root[field] as string;
  for (const nest of ["result", "checkout", "data"]) {
    const inner = asRecord(root[nest]);
    if (inner && typeof inner[field] === "string") return inner[field] as string;
  }
  return null;
}

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.trim().length > 0 && email.includes("@");
}

/**
 * Mint a channel purchase. The draft is persisted ONLY after
 * checkout.create succeeds, so a failed cfpay call leaves no orphan
 * draft behind. Mint creates NO entitlement — only the confirm step,
 * on verified retrieve, grants credit.
 */
export async function mintChannelPurchase(
  deps: {
    drafts: ChannelDraftStore;
    catalogue: ChannelCatalogue;
    channelFixedPriceUSD: number | null;
    cfpay: CfpayChannelClient;
    nowMs?: number;
  },
  input: { userLogin: string; tenantId: string; email: unknown; family: unknown },
): Promise<{ draft: ChannelDraft; cfpay: unknown }> {
  const nowMs = deps.nowMs ?? Date.now();
  const family = assertPriceFamily(input.family);
  if (!isValidEmail(input.email)) {
    throw new Error("email is required for a cfpay channel purchase.");
  }
  const email = (input.email as string).trim();
  const approved = await deps.catalogue.getApprovedPrice(family);
  if (approved === null) {
    throw new BusinessError("FAILURE_CHANNEL_NOT_CONFIGURED", {
      family,
      reason: "no approved catalogue price",
    });
  }
  const attested = deps.channelFixedPriceUSD;
  if (attested === null || attested === undefined) {
    throw new BusinessError("FAILURE_CHANNEL_NOT_CONFIGURED", {
      family,
      reason: "operator has not set the channel fixed price",
    });
  }
  if (round2(approved) !== round2(attested)) {
    throw new BusinessError("FAILURE_CHANNEL_PRICE_MISMATCH", {
      family,
      approvedPriceUSD: approved,
      channelFixedPriceUSD: attested,
    });
  }
  const id = `cfpay-${crypto.randomUUID()}`;
  const created = await deps.cfpay.createCheckout({ requestId: id, email, request: id });
  if (!created.ok) {
    throw new BusinessError("FAILURE_CHANNEL_UNAVAILABLE", {
      reason: created.error ?? "checkout.create failed",
    });
  }
  const draft = await deps.drafts.createDraft({
    id,
    userLogin: input.userLogin,
    tenantId: input.tenantId,
    email,
    family,
    expectedPriceUSD: round2(approved),
    status: "minted",
    createdAtMs: nowMs,
    fulfilledAtMs: null,
    paymentIntentId: null,
    fulfilSkippedReason: null,
  });
  return { draft, cfpay: created.data ?? null };
}

/**
 * Confirm a channel purchase (the HITL step, mirroring 2.1 Billing's
 * "I have paid"): the caller's confirm action plus server-side retrieve.
 * On verified paid status only: optionally fulfil with cfpay, then top up
 * commercial credits by exactly the bound price, record the ledger row,
 * and mark the draft fulfilled. Every refusal grants nothing.
 */
export async function confirmChannelPurchase(
  deps: {
    drafts: ChannelDraftStore;
    cfpay: CfpayChannelClient;
    adjustCredits: ChannelAccountStore["adjustCredits"];
    recordTransaction: (draft: ChannelDraft) => Promise<unknown>;
    audit: (type: string, payload: Record<string, unknown>) => void;
    nowMs?: number;
  },
  input: { userLogin: string; channelRequestId: string },
): Promise<{ draft: ChannelDraft; account: { userId: string; creditsUSD: number }; transaction: unknown }> {
  const nowMs = deps.nowMs ?? Date.now();
  const draft = await deps.drafts.getDraft(input.channelRequestId);
  if (!draft) {
    throw new BusinessError("FAILURE_CHANNEL_UNKNOWN_PURCHASE", { channelRequestId: input.channelRequestId });
  }
  if (draft.userLogin !== input.userLogin) {
    throw new BusinessError("FAILURE_CHANNEL_FORBIDDEN", { channelRequestId: draft.id });
  }
  if (draft.status === "fulfilled") {
    throw new BusinessError("FAILURE_CHANNEL_REPLAY", { channelRequestId: draft.id });
  }
  const status = await deps.cfpay.getStatus(draft.id);
  if (!status.ok) {
    throw new BusinessError("FAILURE_CHANNEL_UNAVAILABLE", { reason: status.error ?? "checkout.status failed" });
  }
  const statusString = extractStatusString(status.data);
  if (!statusString || !CHANNEL_PAID_STATUSES.has(statusString.toLowerCase())) {
    throw new BusinessError("FAILURE_CHANNEL_NOT_PAID", {
      channelRequestId: draft.id,
      retrievedStatus: statusString,
    });
  }
  const retrievedRequestId = extractField(status.data, "requestId");
  if (retrievedRequestId !== null && retrievedRequestId !== draft.id) {
    throw new BusinessError("FAILURE_CHANNEL_NOT_PAID", {
      channelRequestId: draft.id,
      reason: "retrieved requestId does not match the draft",
    });
  }
  const retrievedEmail = extractField(status.data, "email");
  if (retrievedEmail !== null && retrievedEmail !== draft.email) {
    throw new BusinessError("FAILURE_CHANNEL_NOT_PAID", {
      channelRequestId: draft.id,
      reason: "retrieved email does not match the draft",
    });
  }
  const paymentIntentId = extractField(status.data, "paymentIntentId");
  let fulfilSkippedReason: string | null = null;
  if (paymentIntentId !== null) {
    const fulfilled = await deps.cfpay.fulfil(draft.id, paymentIntentId);
    if (!fulfilled.ok) {
      throw new BusinessError("FAILURE_CHANNEL_FULFIL_FAILED", {
        channelRequestId: draft.id,
        reason: fulfilled.error ?? "checkout.fulfil failed",
      });
    }
  } else {
    // checkout.fulfil takes a caller-supplied payment intent; inventing
    // one is forbidden, so fulfil is skipped for a stated reason and
    // the verified paid status alone carries the fulfilment.
    fulfilSkippedReason = "no_payment_intent";
  }
  const account = await deps.adjustCredits(draft.userLogin, draft.expectedPriceUSD);
  const transaction = await deps.recordTransaction(draft);
  const fulfilledDraft = await deps.drafts.markFulfilled(draft.id, {
    fulfilledAtMs: nowMs,
    paymentIntentId,
    fulfilSkippedReason,
  });
  deps.audit("commercial.channel.fulfilled", {
    channelRequestId: draft.id,
    userId: draft.userLogin,
    tenantId: draft.tenantId,
    family: draft.family,
    amountUSD: draft.expectedPriceUSD,
    paymentIntentId,
    fulfilSkippedReason,
  });
  return { draft: fulfilledDraft, account, transaction };
}

export type ChannelReconcileVerdict = "match" | "mismatch" | "unverifiable";

/**
 * Totals-level reconciliation against cfpay's ledger (scope item 3).
 * Record-level matching is NOT claimed: payments.list record schemas are
 * unpublished, so matching on guessed fields would be false precision.
 * The cfpay totals payload is returned verbatim for operator judgment.
 */
export async function reconcileChannel(deps: {
  drafts: ChannelDraftStore;
  cfpay: CfpayChannelClient;
}): Promise<{
  local: { count: number; totalUSD: number };
  cfpay: { totals: unknown; list: unknown };
  verdict: ChannelReconcileVerdict;
  reason: string;
}> {
  const fulfilled = await deps.drafts.listFulfilled();
  const local = {
    count: fulfilled.length,
    totalUSD: round2(fulfilled.reduce((sum, d) => sum + d.expectedPriceUSD, 0)),
  };
  const totals = await deps.cfpay.paymentsTotals();
  if (!totals.ok) {
    return {
      local,
      cfpay: { totals: null, list: null },
      verdict: "unverifiable",
      reason: `cfpay totals unavailable: ${totals.error ?? "payments.totals failed"}`,
    };
  }
  const list = await deps.cfpay.listPayments(100);
  const cfpayTotals = totals.data ?? null;
  const extracted = extractComparableTotal(cfpayTotals);
  if (extracted === null) {
    return {
      local,
      cfpay: { totals: cfpayTotals, list: list.ok ? (list.data ?? null) : null },
      verdict: "unverifiable",
      reason: "cfpay totals expose no comparable number; operator judges from both figures",
    };
  }
  if (round2(extracted) === local.totalUSD) {
    return {
      local,
      cfpay: { totals: cfpayTotals, list: list.ok ? (list.data ?? null) : null },
      verdict: "match",
      reason: "cfpay totals agree with local fulfilled channel totals",
    };
  }
  return {
    local,
    cfpay: { totals: cfpayTotals, list: list.ok ? (list.data ?? null) : null },
    verdict: "mismatch",
    reason: `cfpay totals (${extracted}) disagree with local fulfilled channel totals (${local.totalUSD}); operator investigates`,
  };
}

/** A totals payload is comparable only when it carries an explicit total field. */
export function extractComparableTotal(payload: unknown): number | null {
  if (typeof payload === "number" && Number.isFinite(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return null;
  for (const key of ["total", "totalUSD", "sum", "amount"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
