/**
 * Issue #2185 (sub-issue of #2012) — Drizzle D1 adapter for the
 * price catalogue port. This module is the ONLY place
 * price-catalogue code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder) lives here, behind the port
 * interface.
 *
 * Issue #3289 — a catalogue row IS a version (migration 0058):
 * the primary key is the version id (not the family), a family
 * has one version chain per segment, and `setPrice` creates a
 * new version instead of updating a row in place.
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT, one UPDATE), which is atomic on any store.
 * No multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { agentPriceCatalogue } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0058_PRODUCT_VERSIONS,
  MIGRATION_0062_OFFER_SUPPRESSIONS_RANK,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertApproverId,
  assertPriceFamily,
  assertPriceUSD,
  PRICE_FAMILIES,
  PROPOSED_SEED_PRICES,
  type PriceCatalogue,
  type PriceEntry,
  type PriceFamily,
} from "./priceCataloguePorts";
import {
  assertSegment,
  catalogueVersionId,
  DEFAULT_SEGMENT,
  perRunProductId,
  resolveEffectiveVersion,
} from "./productPorts";

/** Drizzle D1 database object carrying the price catalogue schema. */
export type PriceCatalogueDb = DrizzleD1Database<{
  agentPriceCatalogue: typeof agentPriceCatalogue;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1PriceCatalogueDb(d1: D1Database): PriceCatalogueDb {
  return drizzle(d1, {
    schema: {
      agentPriceCatalogue,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migrations 0011 + 0027 +
 * 0058 if unapplied (0058's prerequisites 0007 + 0008 + 0009
 * + 0012 ride along), then seeds the proposed prices as v1 rows (INSERT OR
 * IGNORE — re-seeding is a no-op, so an operator-edited price
 * is never overwritten by a later ensure). The seeds are
 * PROPOSED defaults pending owner approval, not an activation:
 * migration 0027 (#2547) gives every seeded and pre-existing
 * row approval status 'proposed', and only an operator approval
 * through approvePrice makes a price chargeable.
 */
export async function ensurePriceCatalogueSchema(db: PriceCatalogueDb): Promise<number[]> {
  const applied = await applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0058_PRODUCT_VERSIONS,
    MIGRATION_0062_OFFER_SUPPRESSIONS_RANK,
  ]);
  const now = Date.now();
  for (const [family, priceUSD] of Object.entries(PROPOSED_SEED_PRICES)) {
    const familyKey = assertPriceFamily(family);
    await db
      .insert(agentPriceCatalogue)
      .values({
        id: catalogueVersionId(familyKey, DEFAULT_SEGMENT, 1),
        family: familyKey,
        priceUSD,
        updatedAtMs: now,
        approvalStatus: "proposed",
        approvedBy: null,
        approvedAtMs: null,
        productId: perRunProductId(familyKey),
        segment: DEFAULT_SEGMENT,
        version: 1,
        effectiveFromMs: now,
        effectiveToMs: null,
      })
      .onConflictDoNothing();
  }
  return applied;
}

function toEntry(raw: typeof agentPriceCatalogue.$inferSelect): PriceEntry {
  // Approval state is read fail-closed (#2547): anything that is
  // not exactly 'approved' — including a pre-0027 row backfilled
  // by the column default or a corrupt value — reads as proposed,
  // and the approval record is only honored on an approved row.
  const approved = raw.approvalStatus === "approved";
  // Issue #3289: pre-0058 rows carry no version columns — the
  // migration backfills them, so a null/empty here can only mean
  // a row written before the migration ran; read it as the
  // backfill would have written it (v1, default segment,
  // effective at update time, product from the family).
  const family = assertPriceFamily(raw.family);
  return {
    id:
      typeof raw.id === "string" && raw.id.length > 0
        ? raw.id
        : catalogueVersionId(family, DEFAULT_SEGMENT, 1),
    family,
    priceUSD: raw.priceUSD,
    updatedAtMs: raw.updatedAtMs,
    approvalStatus: approved ? "approved" : "proposed",
    approvedBy: approved ? (raw.approvedBy ?? null) : null,
    approvedAtMs: approved ? (raw.approvedAtMs ?? null) : null,
    productId:
      typeof raw.productId === "string" && raw.productId.length > 0
        ? raw.productId
        : perRunProductId(family),
    segment:
      typeof raw.segment === "string" && raw.segment.length > 0 ? raw.segment : DEFAULT_SEGMENT,
    version: typeof raw.version === "number" && raw.version >= 1 ? raw.version : 1,
    effectiveFromMs:
      typeof raw.effectiveFromMs === "number" && raw.effectiveFromMs > 0
        ? raw.effectiveFromMs
        : raw.updatedAtMs,
    effectiveToMs: raw.effectiveToMs ?? null,
  };
}

/** Price catalogue over D1 via Drizzle. */
export class D1PriceCatalogueAdapter implements PriceCatalogue {
  constructor(readonly db: PriceCatalogueDb) {}

  async getPrice(family: string, segment?: string): Promise<number | null> {
    const entry = await this.getEntry(family, segment);
    return entry ? entry.priceUSD : null;
  }

  async getEntry(family: string, segment?: string): Promise<PriceEntry | null> {
    const entry = await this.getEffectiveEntry(
      family,
      segment === undefined ? DEFAULT_SEGMENT : assertSegment(segment),
    );
    if (!entry) return null;
    // Same fail-closed read as getPrice: an invalid stored value
    // reads as missing, approval state included.
    if (!Number.isFinite(entry.priceUSD) || entry.priceUSD <= 0) return null;
    return entry;
  }

  async getApprovedPrice(family: string, segment?: string): Promise<number | null> {
    const entry = await this.getEntry(family, segment);
    if (!entry || entry.approvalStatus !== "approved") return null;
    return entry.priceUSD;
  }

  async getEffectiveEntry(family: string, segment: string, nowMs?: number): Promise<PriceEntry | null> {
    // Read path, fail-closed: an invalid family reads as no
    // effective entry (null), never a throw — the old getPrice
    // contract ("nope" → null) is preserved. The write path
    // (createVersion/setPrice) still validates the family.
    if (!(PRICE_FAMILIES as readonly string[]).includes(family)) return null;
    const familyKey = family as PriceFamily;
    const seg = assertSegment(segment);
    const versions = await this.listVersions(familyKey, seg);
    return resolveEffectiveVersion(versions, seg, nowMs ?? Date.now());
  }

  async getAllPrices(): Promise<PriceEntry[]> {
    // Issue #3289: the operator price list is the effective
    // version per family for the default segment — one row per
    // family, never a stale or future version.
    const rows = await this.db.select().from(agentPriceCatalogue);
    const byFamily = new Map<PriceFamily, PriceEntry[]>();
    for (const raw of rows) {
      const entry = toEntry(raw);
      const list = byFamily.get(entry.family) ?? [];
      list.push(entry);
      byFamily.set(entry.family, list);
    }
    const effective: PriceEntry[] = [];
    for (const [family, versions] of byFamily) {
      const resolved = resolveEffectiveVersion(versions, DEFAULT_SEGMENT, Date.now());
      if (resolved) effective.push(resolved);
    }
    effective.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
    return effective;
  }

  async listVersions(family: string, segment?: string): Promise<PriceEntry[]> {
    const familyKey = assertPriceFamily(family);
    const productId = perRunProductId(familyKey);
    const rows =
      segment === undefined
        ? await this.db
            .select()
            .from(agentPriceCatalogue)
            .where(eq(agentPriceCatalogue.productId, productId))
            .orderBy(
              asc(agentPriceCatalogue.effectiveFromMs),
              asc(agentPriceCatalogue.version),
              asc(agentPriceCatalogue.id),
            )
        : await this.db
            .select()
            .from(agentPriceCatalogue)
            .where(
              and(
                eq(agentPriceCatalogue.productId, productId),
                eq(agentPriceCatalogue.segment, assertSegment(segment)),
              ),
            )
            .orderBy(
              asc(agentPriceCatalogue.effectiveFromMs),
              asc(agentPriceCatalogue.version),
              asc(agentPriceCatalogue.id),
            );
    return rows.map(toEntry);
  }

  async createVersion(input: {
    family: PriceFamily;
    priceUSD: number;
    segment?: string;
    effectiveFromMs?: number;
    effectiveToMs?: number | null;
  }): Promise<PriceEntry> {
    const family = assertPriceFamily(input.family);
    const priceUSD = assertPriceUSD(input.priceUSD);
    const segment = input.segment === undefined ? DEFAULT_SEGMENT : assertSegment(input.segment);
    const effectiveFromMs = input.effectiveFromMs ?? Date.now();
    if (!Number.isFinite(effectiveFromMs) || effectiveFromMs < 0) {
      throw new Error("effectiveFromMs must be a non-negative epoch-ms number.");
    }
    const effectiveToMs = input.effectiveToMs ?? null;
    if (effectiveToMs !== null && (!Number.isFinite(effectiveToMs) || effectiveToMs <= effectiveFromMs)) {
      throw new Error("effectiveToMs must be an epoch-ms number after effectiveFromMs when present.");
    }
    const productId = perRunProductId(family);
    // Two versions may share an effectiveFromMs (same-ms
    // creation is a race, not a caller error — see the 0058
    // header note): the resolver tiebreaks ties by greatest
    // version, so the newest version wins. No bump: a version
    // created "effective now" must be effective now.
    const siblings = await this.listVersions(family, segment);
    const version = siblings.reduce((max, s) => Math.max(max, s.version), 0) + 1;
    const now = Date.now();
    const record: PriceEntry = {
      id: catalogueVersionId(family, segment, version),
      family,
      priceUSD,
      updatedAtMs: now,
      // #2547: a price write is a proposal. The new version
      // carries no approval; a changed price can never ride on
      // the previous version's approval.
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
      productId,
      segment,
      version,
      effectiveFromMs,
      effectiveToMs,
    };
    await this.db.insert(agentPriceCatalogue).values({
      id: record.id,
      family: record.family,
      priceUSD: record.priceUSD,
      updatedAtMs: record.updatedAtMs,
      approvalStatus: record.approvalStatus,
      approvedBy: record.approvedBy,
      approvedAtMs: record.approvedAtMs,
      productId: record.productId,
      segment: record.segment,
      version: record.version,
      effectiveFromMs: record.effectiveFromMs,
      effectiveToMs: record.effectiveToMs,
    });
    return record;
  }

  async setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry> {
    // Issue #3289: set a price = create a new version (default
    // segment, effective now). The operator price route keeps
    // its shape; the old row is never edited in place.
    return this.createVersion({
      family: assertPriceFamily(input.family),
      priceUSD: assertPriceUSD(input.priceUSD),
    });
  }

  async approvePrice(input: {
    family: unknown;
    approverId: unknown;
    segment?: unknown;
  }): Promise<PriceEntry> {
    const family = assertPriceFamily(input.family);
    const approverId = assertApproverId(input.approverId);
    const segment = input.segment === undefined || input.segment === null ? DEFAULT_SEGMENT : assertSegment(input.segment);
    // Issue #3289: approval targets the EFFECTIVE version for
    // the segment — the one the gate would charge — not "the
    // family row" (there is no longer one row per family).
    const existing = await this.getEffectiveEntry(family, segment);
    if (!existing) {
      throw new Error(
        `No stored price for family ${family}: cannot approve a price that does not exist.`,
      );
    }
    const now = Date.now();
    await this.db
      .update(agentPriceCatalogue)
      .set({ approvalStatus: "approved", approvedBy: approverId, approvedAtMs: now, updatedAtMs: now })
      .where(eq(agentPriceCatalogue.id, existing.id));
    return { ...existing, approvalStatus: "approved", approvedBy: approverId, approvedAtMs: now, updatedAtMs: now };
  }
}
