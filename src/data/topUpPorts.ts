/**
 * Issue #3262 — self-service top-up draft port. This module is the
 * ADR 0002 R1 boundary: it imports no store client, references no
 * env binding, and writes no SQL. Only the adapters (Drizzle D1,
 * in-memory) touch a store.
 *
 * A draft is the local binding for one top-up: the amount is bound
 * at mint (never re-read from a client at confirm), the draft id
 * (`topup-<uuid>`) is the replay guard and the Stripe
 * client_reference_id / x402 checkout id, and the draft carries the
 * provider evidence needed to verify the payment. A draft is never
 * an entitlement by itself: only a credited draft ever granted
 * credit, and the credit itself lives on the commercial account.
 *
 * Single currency (USD) only, per #1069 §9: multi-currency is
 * requirement-driven expansion (later) — there is no currency field
 * and no conversion anywhere in this slice.
 */

/**
 * The top-up rail as the public API names it: "card" for the Stripe
 * card checkout, "x402" for the crypto rail. The port layer calls
 * the card rail "stripe" (CheckoutRail) and keys CheckoutPorts by
 * "card" — the routes map TopUpRail to the port at the boundary,
 * never by renaming the public contract.
 */
export type TopUpRail = "card" | "x402";

export type TopUpDraftStatus = "minted" | "crediting" | "credited";

export interface TopUpDraft {
  /** Route-minted draft id: `topup-<uuid>`. Also the replay guard. */
  id: string;
  /** Verified session login that minted the top-up. Never client-supplied at confirm. */
  userLogin: string;
  /** Tenant resolved server-side at mint (#1069 §8). */
  tenantId: string;
  email: string;
  /** Amount bound at mint, in USD. Confirm credits exactly this. */
  amountUSD: number;
  rail: TopUpRail;
  status: TopUpDraftStatus;
  createdAtMs: number;
  creditedAtMs: number | null;
  /** Stripe payment intent from the verified session, when the rail is card. */
  paymentIntentId: string | null;
  /** Stripe session id from the mint, when the rail is card. */
  checkoutSessionId: string | null;
  /** x402 challenge nonce bound at mint, when the rail is x402. */
  challengeNonce: string | null;
}

export interface TopUpDraftStore {
  createDraft(draft: TopUpDraft): Promise<TopUpDraft>;
  getDraft(id: string): Promise<TopUpDraft | null>;
  /**
   * Atomically claim a minted draft for crediting (minted → crediting).
   * A single conditional transition: it refuses when the draft is
   * unknown or not minted, so exactly one confirmer can own the credit
   * — a retry or concurrent confirm sees a non-minted draft and refuses
   * instead of crediting again (#3572). Throws TopUpClaimRefusedError
   * on refusal.
   */
  claimForCredit(id: string): Promise<TopUpDraft>;
  /**
   * Release a claim (crediting → minted), restoring the draft so a retry
   * can proceed. Used when the credit fails after a successful claim.
   * Refuses when the draft is unknown or not crediting.
   */
  releaseClaim(id: string): Promise<TopUpDraft>;
  /**
   * Transition a crediting draft to credited. Refuses when the draft is
   * unknown, not crediting, or already credited — the replay guard.
   * Only ever called after a successful claimForCredit in the confirm
   * route; see the confirm route for the ordering (verify → claim →
   * credit → mark, #3572).
   */
  markCredited(
    id: string,
    update: { creditedAtMs: number; paymentIntentId: string | null; checkoutSessionId: string | null },
  ): Promise<TopUpDraft>;
  listByUser(userLogin: string): Promise<TopUpDraft[]>;
}

/**
 * A draft-state refusal for claim/release: the draft is not in the
 * state the transition requires. Callers map this to the replay
 * outcome (409 FAILURE_TOP_UP_REPLAY) — never to a store failure.
 */
export class TopUpClaimRefusedError extends Error {
  constructor(
    readonly draftId: string,
    readonly status: TopUpDraftStatus,
    readonly operation: "claim" | "release",
  ) {
    super(
      operation === "claim"
        ? `Top-up ${draftId} is not minted (status: ${status}).`
        : `Top-up ${draftId} is not crediting (status: ${status}).`,
    );
    this.name = "TopUpClaimRefusedError";
  }
}

export function assertTopUpDraftStatus(value: unknown): TopUpDraftStatus {
  if (value !== "minted" && value !== "crediting" && value !== "credited") {
    throw new Error(`Top-up draft status must be "minted", "crediting", or "credited".`);
  }
  return value;
}

export function assertTopUpRail(value: unknown): TopUpRail {
  if (value !== "card" && value !== "x402") {
    throw new Error(`Top-up rail must be "card" or "x402".`);
  }
  return value;
}

/** Validate a top-up amount: finite, positive, at most two decimals (whole cents). */
export function assertTopUpAmountUSD(value: unknown): number {
  const n = Number(value);
  if (typeof value === "string" || !Number.isFinite(n) || n <= 0) {
    throw new Error("top-up amountUSD must be a finite positive number.");
  }
  if (Math.round(n * 100) !== n * 100) {
    throw new Error("top-up amountUSD must have at most two decimal places.");
  }
  return n;
}
