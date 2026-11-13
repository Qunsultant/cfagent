/**
 * Issue #3246 (sub-issue of #3241), slice 3 — runs-pack ports.
 *
 * This module is the ADR 0002 R1 boundary for runs packs: it
 * imports no store client, references no env binding, and writes
 * no SQL. Only the adapters (Drizzle D1, in-memory) touch a
 * store, and only the composition root (createRunsPackPorts.ts)
 * maps a Worker binding to an adapter.
 *
 * A runs pack is a prepaid bundle of runs with NO tier, NO
 * subscription row, and NO expiry in v1 (Mars NQ2): buying one
 * credits a dedicated per-login balance, and the gate spends
 * that balance AFTER subscription included runs and BEFORE
 * credits. Included runs spend only when Subscribed, so the
 * pack balance is never the included-runs counter. A pack is
 * family-agnostic (NQ6): the same balance covers any family's
 * run — the spend still requires that family's catalogue price
 * to be approved (NQ7), because price resolution precedes
 * coverage in the gate and fails closed.
 *
 * Three stores, one migration (0063):
 * - RunsPackVersionStore: the approval-gated (runs, price)
 *   terms for a runs_pack product. A version lands PROPOSED;
 *   only an operator approval makes its price buyable. The
 *   version NUMBER is server-assigned (max existing + 1 for
 *   the product+segment), mirroring plan versions (#3289).
 *   Per-run x N pricing is REJECTED (all per-run prices are
 *   PROPOSED): a pack version's (runs, price) terms are
 *   operator data, never derived from a per-run price.
 * - RunsPackBalancePort: the dedicated per-login balance.
 *   `consumePackRun` is the gate's decision-time spend: a
 *   single conditional decrement (balance > 0) with an
 *   applied-check, so a concurrent double-spend is refused.
 * - RunsPackDraftStore: the mint/confirm binding for one pack
 *   purchase, mirroring the top-up drafts (#3262). The draft
 *   id (`pack-<uuid>`) is the Stripe client_reference_id /
 *   x402 checkout id and the replay guard. Only a credited
 *   draft ever granted runs; the balance itself lives in the
 *   balance store.
 *
 * Single currency (USD) only, per #1069 §9: multi-currency is
 * requirement-driven expansion (later) — there is no currency
 * field and no conversion anywhere in this slice.
 */
import { assertSegment, DEFAULT_SEGMENT } from "./productPorts";
import type { PlanPriceApprovalStatus } from "./subscriptionPorts";
import { assertTopUpRail, type TopUpRail } from "./topUpPorts";

/** The pack rail, as the public API names it — the top-up rail, reused (one rail vocabulary). */
export type RunsPackRail = TopUpRail;
export { assertTopUpRail as assertRunsPackRail };

export type RunsPackDraftStatus = "minted" | "crediting" | "credited";

/** One runs-pack version: the approval-gated (runs, price) terms. */
export interface RunsPackVersion {
  id: string;
  productId: string;
  /** Server-assigned version number (max existing + 1 for the product+segment). */
  version: number;
  segment: string;
  /** Runs the pack grants when purchased. Positive integer, operator data. */
  runs: number;
  /** Price of the whole pack in USD. Operator data; never derived from a per-run price. */
  priceUSD: number;
  approvalStatus: PlanPriceApprovalStatus;
  /** Login of the approving operator; null while proposed. */
  approvedBy: string | null;
  /** Epoch ms of the approval; null while proposed. */
  approvedAtMs: number | null;
  active: boolean;
  effectiveFromMs: number;
  effectiveToMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Validate a pack version's runs: a positive integer. */
export function assertRunsPackRuns(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Pack runs must be a positive integer.");
  }
  return value;
}

/** Validate a pack version's price: finite, positive, at most two decimals (whole cents). */
export function assertRunsPackPriceUSD(value: unknown): number {
  const n = Number(value);
  if (typeof value === "string" || !Number.isFinite(n) || n <= 0) {
    throw new Error("Pack priceUSD must be a finite positive number.");
  }
  // Whole cents only. The comparison uses a tolerance: binary
  // floats cannot represent most decimals exactly (2.49 * 100 is
  // 249.00000000000003), so an exact `!==` rejects valid prices.
  // (The top-up amount assert carries the same exact-compare
  // shape; this one is written tolerant on purpose.)
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
    throw new Error("Pack priceUSD must be a value with at most two decimal places.");
  }
  return n;
}

/**
 * Validate a pack-version create input (operator data only — the
 * version number, approval state, and timestamps are server-assigned).
 * Segment defaults to "default"; effectiveFromMs defaults to now.
 */
export function assertRunsPackVersionInput(
  input: {
    productId?: unknown;
    segment?: unknown;
    runs?: unknown;
    priceUSD?: unknown;
    effectiveFromMs?: unknown;
    effectiveToMs?: unknown;
  },
  nowMs: number,
): {
  productId: string;
  segment: string;
  runs: number;
  priceUSD: number;
  effectiveFromMs: number;
  effectiveToMs: number | null;
} {
  const productId =
    typeof input.productId === "string" && input.productId.trim()
      ? input.productId.trim()
      : "";
  if (!productId) throw new Error("Pack productId is required.");
  const segment =
    input.segment === undefined || input.segment === null
      ? DEFAULT_SEGMENT
      : assertSegment(input.segment);
  const runs = assertRunsPackRuns(input.runs);
  const priceUSD = assertRunsPackPriceUSD(input.priceUSD);
  const effectiveFromMs =
    input.effectiveFromMs === undefined || input.effectiveFromMs === null
      ? nowMs
      : Number(input.effectiveFromMs);
  if (!Number.isFinite(effectiveFromMs) || effectiveFromMs < 0) {
    throw new Error("effectiveFromMs must be a non-negative epoch-ms number.");
  }
  let effectiveToMs: number | null = null;
  if (input.effectiveToMs !== undefined && input.effectiveToMs !== null) {
    effectiveToMs = Number(input.effectiveToMs);
    if (!Number.isFinite(effectiveToMs) || effectiveToMs <= effectiveFromMs) {
      throw new Error("effectiveToMs must be an epoch-ms number after effectiveFromMs when present.");
    }
  }
  return { productId, segment, runs, priceUSD, effectiveFromMs, effectiveToMs };
}

/** The runs-pack version store surface. */
export interface RunsPackVersionStore {
  listVersions(productId: string, segment?: string): Promise<RunsPackVersion[]>;
  getVersion(id: string): Promise<RunsPackVersion | null>;
  createVersion(input: {
    productId: unknown;
    segment?: unknown;
    runs: unknown;
    priceUSD: unknown;
    effectiveFromMs?: unknown;
    effectiveToMs?: unknown;
  }): Promise<RunsPackVersion>;
  approveVersion(id: string, approverId: string): Promise<RunsPackVersion>;
  deactivateVersion(id: string): Promise<RunsPackVersion>;
}

/** Validate a pack-balance login: a non-empty string. */
export function assertRunsPackLogin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Runs-pack login must be a non-empty string.");
  }
  return value.trim();
}

/** The result of a decision-time pack spend. */
export interface RunsPackConsumption {
  /** True exactly when one pack run was spent by this call. */
  allowed: boolean;
  /** The balance after this call. */
  remaining: number;
}

/**
 * The runs-pack balance surface. `getBalance` returns 0 for a
 * login with no row (no pack ever bought). `addPackRuns` credits
 * runs (purchase activation); `consumePackRun` spends one run
 * at gate-decision time.
 */
export interface RunsPackBalancePort {
  getBalance(login: string): Promise<number>;
  addPackRuns(login: string, runs: number): Promise<number>;
  consumePackRun(input: { login: string }): Promise<RunsPackConsumption>;
}

/** One runs-pack draft: the mint/confirm binding for one purchase. */
export interface RunsPackDraft {
  /** Route-minted draft id: `pack-<uuid>`. Also the replay guard. */
  id: string;
  /** Verified session login that minted the pack. Never client-supplied at confirm. */
  userLogin: string;
  /** Tenant resolved server-side at mint (#1069 §8). */
  tenantId: string;
  email: string;
  /** The pack version bought (terms bound at mint, never re-read from a client at confirm). */
  versionId: string;
  productId: string;
  /** Runs bound at mint. Confirm credits exactly this. */
  runs: number;
  /** Price bound at mint, in USD. Confirm verifies exactly this. */
  priceUSD: number;
  rail: RunsPackRail;
  status: RunsPackDraftStatus;
  createdAtMs: number;
  creditedAtMs: number | null;
  /** Stripe payment intent from the verified session, when the rail is card. */
  paymentIntentId: string | null;
  /** Stripe session id from the mint, when the rail is card. */
  checkoutSessionId: string | null;
  /** x402 challenge nonce bound at mint, when the rail is x402. */
  challengeNonce: string | null;
}

export interface RunsPackDraftStore {
  createDraft(draft: RunsPackDraft): Promise<RunsPackDraft>;
  getDraft(id: string): Promise<RunsPackDraft | null>;
  /**
   * Atomically claim a minted draft for crediting (minted → crediting).
   * A single conditional transition: it refuses when the draft is
   * unknown or not minted, so exactly one confirmer can own the credit
   * — a retry or concurrent confirm sees a non-minted draft and refuses
   * instead of crediting again (the top-up #3572 precedent). Throws
   * RunsPackClaimRefusedError on refusal.
   */
  claimForCredit(id: string): Promise<RunsPackDraft>;
  /**
   * Release a claim (crediting → minted), restoring the draft so a retry
   * can proceed. Used when the credit fails after a successful claim.
   * Refuses when the draft is unknown or not crediting.
   */
  releaseClaim(id: string): Promise<RunsPackDraft>;
  /**
   * Transition a crediting draft to credited. Refuses when the draft is
   * unknown, not crediting, or already credited — the replay guard.
   * Only ever called after a successful claimForCredit in the confirm
   * route; see the confirm route for the ordering (verify → claim →
   * credit → mark, the top-up #3572 precedent).
   */
  markCredited(
    id: string,
    update: { creditedAtMs: number; paymentIntentId: string | null; checkoutSessionId: string | null },
  ): Promise<RunsPackDraft>;
  listByUser(userLogin: string): Promise<RunsPackDraft[]>;
}

/**
 * A draft-state refusal for claim/release: the draft is not in the
 * state the transition requires. Callers map this to the replay
 * outcome (409 FAILURE_RUNS_PACK_REPLAY) — never to a store failure.
 */
export class RunsPackClaimRefusedError extends Error {
  constructor(
    readonly draftId: string,
    readonly status: RunsPackDraftStatus,
    readonly operation: "claim" | "release",
  ) {
    super(
      operation === "claim"
        ? `Runs pack ${draftId} is not minted (status: ${status}).`
        : `Runs pack ${draftId} is not crediting (status: ${status}).`,
    );
    this.name = "RunsPackClaimRefusedError";
  }
}

export function assertRunsPackDraftStatus(value: unknown): RunsPackDraftStatus {
  if (value !== "minted" && value !== "crediting" && value !== "credited") {
    throw new Error(`Runs-pack draft status must be "minted", "crediting", or "credited".`);
  }
  return value;
}
