/**
 * Issue #2185 (sub-issue of #2012) — externalized per-run price
 * catalogue port (slice 0 of the native-payments program).
 *
 * Prices are OPERATOR DATA, never code constants: the monetization
 * gate reads them through this port, and an operator changes a
 * price via the operator-gated upsert route with no code deploy.
 * The port module is the ADR 0002 R1 boundary: it imports no
 * store client, references no env binding, and writes no SQL.
 * Only the adapters (Drizzle D1, in-memory) touch a store, and
 * only the composition root (createPriceCataloguePorts.ts) maps
 * a Worker binding to an adapter.
 *
 * Fail-closed contract: a family with no stored price reads as
 * null, and the gate treats null (or an invalid stored value) as
 * "refuse to charge" — never as a reason to fall back to a
 * hardcoded price. There is no runtime fallback anywhere in this
 * module: the seed values below are WRITE-time data only. They
 * are written into the store once, at schema-ensure time (D1) or
 * at adapter construction (in-memory test double), and from then
 * on the store is the only source of truth. An operator edit
 * survives re-ensure (INSERT OR IGNORE seeding).
 */

/** Screener families with a per-run price. Mirrors the gate's family union. */
export type PriceFamily = "stock" | "goal" | "options" | "strategy";

/**
 * #5609 (G-7): premium families with a per-call price. These are NOT
 * per-run families: they name the three paid premium services
 * (options-scan, market-research, stock-signals), whose prices live in
 * this same catalogue under the seed decision's own keys — but they
 * must never leak into per-run-only surfaces (free-run allowances,
 * cfpay channels, upgrade offers, approved-free quotas), all of which
 * validate through assertPriceFamily / PRICE_FAMILIES. The catalogue
 * (7 families) is the union; the per-run namespace (4) stays closed.
 */
export type PremiumPriceFamily = "options-scan" | "market-research" | "stock-signals";

export const PREMIUM_PRICE_FAMILIES: readonly PremiumPriceFamily[] = [
  "options-scan",
  "market-research",
  "stock-signals",
];

/** Every family the price catalogue can hold a row for. */
export type CataloguePriceFamily = PriceFamily | PremiumPriceFamily;

export function isPremiumPriceFamily(family: unknown): family is PremiumPriceFamily {
  return family === "options-scan" || family === "market-research" || family === "stock-signals";
}

import { BusinessError } from "../outcomes/outcomeAspects";

export const PRICE_FAMILIES: readonly PriceFamily[] = ["stock", "goal", "options", "strategy"];

/** Every family the price catalogue can hold a row for (per-run + premium). */
export const CATALOGUE_PRICE_FAMILIES: readonly CataloguePriceFamily[] = [
  ...PRICE_FAMILIES,
  ...PREMIUM_PRICE_FAMILIES,
];

export function assertPriceFamily(family: unknown): PriceFamily {
  if (family !== "stock" && family !== "goal" && family !== "options" && family !== "strategy") {
    // Issue #5606 (G-3): typed refusal — the family value never reaches a client in a raw message.
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID");
  }
  return family;
}

/**
 * #5609 (G-7): validate a catalogue family (per-run or premium).
 * This is the ONLY validator that accepts premium families; the
 * per-run validator above stays closed so premium families can
 * never leak into free-run allowances, cfpay channels, upgrade
 * offers, or approved-free quotas.
 */
export function assertCataloguePriceFamily(family: unknown): CataloguePriceFamily {
  if (
    family !== "stock" &&
    family !== "goal" &&
    family !== "options" &&
    family !== "strategy" &&
    family !== "options-scan" &&
    family !== "market-research" &&
    family !== "stock-signals"
  ) {
    // Issue #5606 (G-3): typed refusal — the family value never reaches a client in a raw message.
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID");
  }
  return family;
}

/**
 * #5609 (G-7): the catalogue product id for a family. Premium
 * families are premium products, not per-run products — their id
 * must not lie about what the product is.
 */
export function catalogueProductId(family: CataloguePriceFamily): string {
  return isPremiumPriceFamily(family) ? `prod-premium-${family}` : perRunProductId(family);
}

/** Money is stored to the cent; anything finer is a caller bug, not a rounding policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function assertPriceUSD(priceUSD: unknown): number {
  const value = Number(priceUSD);
  if (!Number.isFinite(value) || value <= 0) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  return round2(value);
}

/**
 * PROPOSED seed prices, NOT owner-approved and NOT an activation.
 * Seeded into the store at ensure time (migration 0011) so a
 * fresh store has prices to read; the gate never reads this
 * constant. An owner-approved price replaces these rows in
 * operator data, not in code. Per-run values: stock $0.02, goal
 * $0.10, options $0.05, strategy $0.10. Premium values (#5609,
 * owner seed decision 2026-11-20, comment 7055099801 on #5609):
 * options-scan $5, market-research $10, stock-signals $2.
 */
export const PROPOSED_SEED_PRICES: Record<CataloguePriceFamily, number> = {
  stock: 0.02,
  goal: 0.1,
  options: 0.05,
  strategy: 0.1,
  "options-scan": 5,
  "market-research": 10,
  "stock-signals": 2,
};

/**
 * Approval state of a catalogue entry (#2547, from the #2013
 * review). A price is PROPOSED from the moment it is written —
 * by seeding or by an operator price change — until an operator
 * approves it through the operator route. Only an APPROVED price
 * may be charged: the monetization gates resolve prices through
 * `getApprovedPrice`, never through the raw stored value, so a
 * proposed price fails closed exactly like a missing one. The
 * approver and the approval time are recorded on the entry: an
 * approval with no name and no time is not an audit record.
 */
export type PriceApprovalStatus = "proposed" | "approved";
export function assertPriceApprovalStatus(status: unknown): PriceApprovalStatus {
  if (status !== "proposed" && status !== "approved") {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  return status;
}

/** The approver is an audit identity: a blank approver approves nothing. */
export function assertApproverId(approverId: unknown): string {
  if (typeof approverId !== "string" || approverId.trim().length === 0) {
    throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
  }
  return approverId.trim();
}

// Issue #3289: a catalogue row IS a version. The resolver and
// the segment rules are the single definitions in productPorts.
import {
  assertSegment,
  catalogueVersionId,
  DEFAULT_SEGMENT,
  perRunProductId,
  resolveEffectiveVersion,
} from "./productPorts";

export interface PriceEntry {
  /** Version id, e.g. `cat-stock-default-v1` (migration 0058). */
  id: string;
  family: CataloguePriceFamily;
  priceUSD: number;
  updatedAtMs: number;
  /**
   * #2547: proposed until an operator approves the entry. Only
   * an APPROVED price may be charged: the monetization gates
   * resolve prices through getApprovedPrice, so a PROPOSED
   * price fails closed exactly like a missing one. Approval
   * is per version automatically, since the status lives on
   * the version row. approvedBy is the approving operator's
   * login; approvedAtMs the approval instant. Both are null
   * on a proposed entry. A pre-#2547 row has approvalStatus
   * "approved" with approvedBy/approvedAtMs null (grandfathered
   * by the migration, not by an approval record).
   */
  approvalStatus: PriceApprovalStatus;
  approvedBy: string | null;
  approvedAtMs: number | null;
  /** Issue #3289 — the product this price belongs to (per-run or premium, #5609). */
  productId: string;
  /** Issue #3289 — the segment this price is sellable to. */
  segment: string;
  /** Issue #3289 — the per-product per-segment version number, from 1. */
  version: number;
  /** Issue #3289 — the instant this version became chargeable (epoch ms). */
  effectiveFromMs: number;
  /** Issue #3289 — the instant this version stops being chargeable (epoch ms); null = open-ended. */
  effectiveToMs: number | null;
}

/**
 * The price catalogue store surface. `getPrice`/`getEntry`
 * return the EFFECTIVE version for the segment (default
 * "default"), whether or not it is approved — null when no
 * version is effective. Charging reads go through
 * `getApprovedPrice`, which returns null unless the effective
 * entry exists, is valid, and is APPROVED — that null is the
 * gates' fail-closed signal, not an invitation to guess a
 * price (#2547). `getAllPrices` returns the effective version
 * per family for the default segment, one row per family.
 */
export interface PriceCatalogue {
  getPrice(family: string, segment?: string): Promise<number | null>;
  getEntry(family: string, segment?: string): Promise<PriceEntry | null>;
  getApprovedPrice(family: string, segment?: string): Promise<number | null>;
  getAllPrices(): Promise<PriceEntry[]>;
  /**
   * Issue #3289 — the effective entry for a family+segment at
   * an explicit instant (default now). The resolution
   * primitive behind getEntry/getPrice/getApprovedPrice.
   */
  getEffectiveEntry(family: string, segment: string, nowMs?: number): Promise<PriceEntry | null>;
  /**
   * Issue #3289 — all versions of one family's per-run
   * product (optionally one segment), oldest effective first.
   * A catalogue row IS a version, so this is the version-chain
   * read for per-run products.
   */
  listVersions(family: string, segment?: string): Promise<PriceEntry[]>;
  /**
   * Issue #3289 — create a new version for a family+segment:
   * the version number is server-assigned (max existing + 1),
   * the version is PROPOSED (a price change is never approved
   * by being written), effectiveFromMs defaults to now,
   * segment to "default". A duplicate effectiveFromMs for the
   * product+segment throws.
   */
  createVersion(input: {
    family: CataloguePriceFamily;
    priceUSD: number;
    segment?: string;
    effectiveFromMs?: number;
    effectiveToMs?: number | null;
  }): Promise<PriceEntry>;
  /**
   * Issue #3289 — set a price = create a new version (see
   * createVersion). A price change is always a new version,
   * never an edit in place: the old version stays on record
   * (and stays chargeable to grandfathered holders until its
   * effectiveToMs). The operator price route keeps its shape.
   * Writing ALWAYS lands as PROPOSED with the approval record
   * cleared: a changed price is a new proposal, never a
   * silently-still-approved one (#2547).
   */
  setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry>;
  /**
   * Approve the EFFECTIVE version of a family in a segment
   * (default "default"), recording the approver and the
   * approval time. Approving a family with no effective version
   * throws — there is nothing to approve.
   */
  approvePrice(input: { family: unknown; approverId: unknown; segment?: unknown }): Promise<PriceEntry>;
}
