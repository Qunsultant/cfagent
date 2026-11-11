/**
 * Issue #3289 (sub-issue of #3241) — product/version port.
 *
 * Products are identity; versions are immutable terms snapshots.
 * Plans ARE versions (subscription products) and catalogue rows
 * ARE versions (per-run products): no parallel purchaseable-unit
 * table exists alongside plans, and no second resolver exists
 * beside the one here. The subscription store and the price
 * catalogue store own their version rows; this module owns the
 * product identity rows (agent_products) and the move audit
 * rows (agent_version_moves / agent_bulk_moves), plus the one
 * pure effective-version resolver every reader uses — the gate,
 * activation, and checkout all resolve through it, so a version
 * means the same thing on every path.
 *
 * Port-first (ADR 0002 R1/R2): this module carries record types,
 * the port interface, and pure helpers ONLY. It imports no store
 * client, references no env binding, and writes no SQL. All
 * query-builder code lives in d1ProductAdapter.ts; the in-memory
 * adapter shares the validators below so the two implementations
 * cannot drift. A structural test pins the import rule.
 *
 * The resolver never defaults a segment: callers pass the
 * account's segment ("default" when unset). A missing/null
 * segment reads as "default" at the account mapping, never
 * inside the resolver.
 */

/** The segment every existing row is backfilled into (migration 0058), and the read for a missing/null segment. */
export const DEFAULT_SEGMENT = "default";

/** The Free product row (kind subscription, no versions — the read-only baseline, migration 0058). */
export const FREE_PRODUCT_ID = "prod-free";

export type ProductKind = "subscription" | "per_run";

export function assertProductKind(kind: unknown): ProductKind {
  if (kind !== "subscription" && kind !== "per_run") {
    throw new Error(`Invalid product kind: ${String(kind)} (must be subscription or per_run).`);
  }
  return kind;
}

/** A segment is an operator-managed label: a non-empty string, free-form, no registry, no fixed list. */
export function assertSegment(segment: unknown): string {
  if (typeof segment !== "string" || segment.trim().length === 0) {
    throw new Error("segment must be a non-empty string.");
  }
  return segment.trim();
}

/**
 * Deterministic per-run product id for a catalogue family.
 * Migration 0058 seeds exactly these ids; the catalogue
 * backfill and the adapters derive them from the same rule.
 */
export function perRunProductId(family: string): string {
  return `prod-per-run-${family}`;
}

/**
 * Deterministic subscription product id for a plan name.
 * Migration 0058 derives the same id in pure SQL
 * (`'prod-sub-' || lower(replace(trim(name), ' ', '-'))`),
 * so the two MUST agree: lowercase, spaces to hyphens, nothing
 * else. Names with other punctuation keep it in both places
 * (ASCII names only — SQLite lower() is ASCII-only, and plan
 * names are operator-entered ASCII in practice).
 */
export function subscriptionProductIdForName(name: string): string {
  return `prod-sub-${name.trim().toLowerCase().replace(/ /g, "-")}`;
}

/** Deterministic catalogue version id: `cat-<family>-<segment>-v<version>`. */
export function catalogueVersionId(family: string, segment: string, version: number): string {
  return `cat-${family}-${segment}-v${version}`;
}

/** A version, in the shape every version-carrying record shares. Plan rows and catalogue rows both satisfy it. */
export interface VersionLike {
  id: string;
  productId: string;
  segment: string;
  version: number;
  effectiveFromMs: number;
  effectiveToMs: number | null;
  /**
   * Whether the version is deactivated. OPTIONAL: plan rows
   * carry it (deactivatePlan), catalogue rows do not — a
   * catalogue version's activation is its approval + effective
   * window, so an absent flag reads as active. The resolver
   * treats only an explicit `false` as inactive.
   */
  active?: boolean;
}

export interface ProductRecord {
  id: string;
  name: string;
  kind: ProductKind;
  description: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The shared version shape (design §3.7): the fields a plan row and a catalogue row both carry as a version. */
export interface ProductVersionRecord extends VersionLike {
  /** Terms that differ per version kind live on the owning record (price/period on plans, price on catalogue rows). */
}

/**
 * The one effective-version rule (design §4.1): among the given
 * product's versions with segment = the customer's segment,
 * active, effectiveFromMs <= now, and (effectiveToMs null or
 * now < effectiveToMs), pick the greatest effectiveFromMs.
 * Ties (possible only in a list not protected by the
 * (product, segment, effectiveFrom) unique index) break by
 * greatest version, then greatest id — total and deterministic.
 * The input list is the versions OF ONE PRODUCT (the caller
 * loads them via listVersions); the resolver never filters by
 * productId itself. A new version becoming effective moves no
 * one: it only becomes available — holders keep their held
 * version until moved.
 */
export function resolveEffectiveVersion<T extends VersionLike>(
  versions: T[],
  segment: string,
  nowMs: number,
): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.segment !== segment) continue;
    if (v.active === false) continue;
    if (v.effectiveFromMs > nowMs) continue;
    if (v.effectiveToMs !== null && nowMs >= v.effectiveToMs) continue;
    if (!best) {
      best = v;
      continue;
    }
    if (v.effectiveFromMs > best.effectiveFromMs) {
      best = v;
      continue;
    }
    if (v.effectiveFromMs === best.effectiveFromMs) {
      if (v.version > best.version) {
        best = v;
        continue;
      }
      if (v.version === best.version && v.id > best.id) best = v;
    }
  }
  return best;
}

/** Billing period for a version (from billingPolicyPorts — the single definition, never redeclared here). */
export type { BillingPeriod } from "./billingPolicyPorts";
import { assertBillingPeriod as assertBillingPeriodValue } from "./billingPolicyPorts";

/** Validate a version's billing period (monthly | annual). */
export function assertVersionBillingPeriod(value: unknown): import("./billingPolicyPorts").BillingPeriod {
  return assertBillingPeriodValue(value, "billingPeriod");
}

/**
 * Derive a version's billing period from its length, the same
 * rule migration 0058 backfills with: 365 days is annual,
 * anything else monthly. The POST /plans annual derivation
 * (monthly x 12 x (1 - discount)) is a price suggestion, not
 * this — this is only the period label.
 */
export function deriveBillingPeriod(periodDays: number): import("./billingPolicyPorts").BillingPeriod {
  return periodDays === 365 ? "annual" : "monthly";
}

/** One row of the per-customer move audit (agent_version_moves, design §3.8). */
export interface VersionMoveRecord {
  id: string;
  /** The bulk move this row belongs to; null for a per-customer move. */
  bulkMoveId: string | null;
  userId: string;
  /** The product moved on; null for a segment-only move by a customer holding no version. */
  productId: string | null;
  /** The held version before the move; null for a segment-only move (no held version). */
  fromVersionId: string | null;
  /**
   * The version moved to — null only for a segment-only move by
   * a customer holding no version (the segment changed; no
   * version was assigned or changed).
   */
  toVersionId: string | null;
  segment: string;
  movedBy: string;
  reason: string | null;
  movedAtMs: number;
}

/** One row of the bulk-move summary (agent_bulk_moves, design §3.8). Written by the slice-2 bulk job. */
export interface BulkMoveRecord {
  id: string;
  productId: string;
  /** The segment the bulk move was scoped to; null = all segments ("all customers on this product"). */
  segmentScope: string | null;
  /** The per-segment target version ids resolved at job start (one per segment in scope), as JSON. */
  targetVersionIdsJson: string;
  movedBy: string;
  reason: string | null;
  status: "running" | "complete" | "complete_with_failures";
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  startedAtMs: number;
  finishedAtMs: number | null;
}

export function assertBulkMoveStatus(status: unknown): BulkMoveRecord["status"] {
  if (status !== "running" && status !== "complete" && status !== "complete_with_failures") {
    throw new Error(
      `Invalid bulk move status: ${String(status)} (must be running, complete, or complete_with_failures).`,
    );
  }
  return status;
}

/** Validate a create-product input (server-side; never trust the client). */
export function assertProduct(input: {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  description?: unknown;
}): { id: string; name: string; kind: ProductKind; description: string | null } {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("Product name is required.");
  const kind = assertProductKind(input.kind);
  const description =
    input.description === undefined || input.description === null
      ? null
      : typeof input.description === "string"
        ? input.description
        : (() => {
            throw new Error("Product description must be a string when present.");
          })();
  return { id, name, kind, description };
}

/**
 * The product store surface. Versions are NOT created here:
 * a subscription version is a plan row (SubscriptionStore) and
 * a per-run version is a catalogue row (PriceCatalogue) — one
 * implementation per table, never a cross-table union in this
 * store. This store owns product identity and the move audit.
 */
export interface ProductStore {
  createProduct(input: { id?: unknown; name?: unknown; kind?: unknown; description?: unknown }): Promise<ProductRecord>;
  getProduct(productId: string): Promise<ProductRecord | null>;
  /** Find a product by name + kind (the POST /plans route resolves the name-derived product before creating a version). */
  findProductByName(name: string, kind: ProductKind): Promise<ProductRecord | null>;
  /** Find by name + kind, else create it — the product row for a name-derived version always exists after this. */
  getOrCreateProduct(input: { name?: unknown; kind?: unknown; description?: unknown }): Promise<ProductRecord>;
  listProducts(): Promise<ProductRecord[]>;
  /** Write one per-customer move audit row. The (bulkMoveId, userId) unique index is the bulk-job idempotency backstop. */
  recordMove(move: {
    id?: string;
    bulkMoveId?: string | null;
    userId: string;
    productId?: string | null;
    fromVersionId?: string | null;
    toVersionId?: string | null;
    segment: string;
    movedBy: string;
    reason?: string | null;
    movedAtMs?: number;
  }): Promise<VersionMoveRecord>;
  /** Move rows for one product, oldest first. */
  listMovesForProduct(productId: string): Promise<VersionMoveRecord[]>;
  /** Move rows for one customer, oldest first — the audit that answers "what happened to customer X". */
  listMovesForUser(userId: string): Promise<VersionMoveRecord[]>;
}
