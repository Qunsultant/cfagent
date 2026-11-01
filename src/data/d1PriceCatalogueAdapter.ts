/**
 * Issue #2185 (sub-issue of #2012) — Drizzle D1 adapter for the
 * price catalogue port. This module is the ONLY place
 * price-catalogue code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder) lives here, behind the port
 * interface.
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT, one UPDATE), which is atomic on any store.
 * No multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's
 * `db.transaction()` is sequential BEGIN/COMMIT, not
 * Postgres-equivalent atomicity on D1).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { agentPriceCatalogue } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertApproverId,
  assertPriceFamily,
  assertPriceUSD,
  PROPOSED_SEED_PRICES,
  type PriceCatalogue,
  type PriceEntry,
} from "./priceCataloguePorts";

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
 * Idempotent schema-ensure: applies migrations 0011 + 0027 if
 * unapplied, then seeds the proposed prices (INSERT OR IGNORE —
 * re-seeding is a no-op, so an operator-edited price is never
 * overwritten by a later ensure). The seeds are PROPOSED defaults
 * pending owner approval, not an activation: migration 0027
 * (#2547) gives every seeded and pre-existing row approval
 * status 'proposed', and only an operator approval through
 * approvePrice makes a price chargeable.
 */
export async function ensurePriceCatalogueSchema(db: PriceCatalogueDb): Promise<number[]> {
  const applied = await applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  ]);
  const now = Date.now();
  for (const [family, priceUSD] of Object.entries(PROPOSED_SEED_PRICES)) {
    await db
      .insert(agentPriceCatalogue)
      .values({ family, priceUSD, updatedAtMs: now, approvalStatus: "proposed", approvedBy: null, approvedAtMs: null })
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
  return {
    family: assertPriceFamily(raw.family),
    priceUSD: raw.priceUSD,
    updatedAtMs: raw.updatedAtMs,
    approvalStatus: approved ? "approved" : "proposed",
    approvedBy: approved ? (raw.approvedBy ?? null) : null,
    approvedAtMs: approved ? (raw.approvedAtMs ?? null) : null,
  };
}

/** Price catalogue over D1 via Drizzle. */
export class D1PriceCatalogueAdapter implements PriceCatalogue {
  constructor(readonly db: PriceCatalogueDb) {}

  async getPrice(family: string): Promise<number | null> {
    const rows = await this.db
      .select()
      .from(agentPriceCatalogue)
      .where(eq(agentPriceCatalogue.family, family))
      .limit(1);
    if (rows.length === 0) return null;
    const price = rows[0].priceUSD;
    // A stored row that fails validation reads as missing: the
    // gate fails closed on it rather than charging a bad price.
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  }

  async getEntry(family: string): Promise<PriceEntry | null> {
    const rows = await this.db
      .select()
      .from(agentPriceCatalogue)
      .where(eq(agentPriceCatalogue.family, family))
      .limit(1);
    if (rows.length === 0) return null;
    const entry = toEntry(rows[0]);
    // Same fail-closed read as getPrice: an invalid stored value
    // reads as missing, approval state included.
    if (!Number.isFinite(entry.priceUSD) || entry.priceUSD <= 0) return null;
    return entry;
  }

  async getApprovedPrice(family: string): Promise<number | null> {
    const entry = await this.getEntry(family);
    if (!entry || entry.approvalStatus !== "approved") return null;
    return entry.priceUSD;
  }

  async getAllPrices(): Promise<PriceEntry[]> {
    const rows = await this.db
      .select()
      .from(agentPriceCatalogue)
      .orderBy(asc(agentPriceCatalogue.family));
    return rows.map(toEntry);
  }

  async setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry> {
    const family = assertPriceFamily(input.family);
    const priceUSD = assertPriceUSD(input.priceUSD);
    // #2547: a price write is a proposal. Any prior approval is
    // cleared in the same statement, so a changed price can never
    // ride on the previous price's approval.
    const record: PriceEntry = {
      family,
      priceUSD,
      updatedAtMs: Date.now(),
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
    };
    await this.db
      .insert(agentPriceCatalogue)
      .values({
        family: record.family,
        priceUSD: record.priceUSD,
        updatedAtMs: record.updatedAtMs,
        approvalStatus: record.approvalStatus,
        approvedBy: record.approvedBy,
        approvedAtMs: record.approvedAtMs,
      })
      .onConflictDoUpdate({
        target: agentPriceCatalogue.family,
        set: {
          priceUSD: record.priceUSD,
          updatedAtMs: record.updatedAtMs,
          approvalStatus: record.approvalStatus,
          approvedBy: record.approvedBy,
          approvedAtMs: record.approvedAtMs,
        },
      });
    return record;
  }

  async approvePrice(input: { family: unknown; approverId: unknown }): Promise<PriceEntry> {
    const family = assertPriceFamily(input.family);
    const approverId = assertApproverId(input.approverId);
    const existing = await this.getEntry(family);
    if (!existing) {
      throw new Error(`No stored price for family ${family}: cannot approve a price that does not exist.`);
    }
    const now = Date.now();
    await this.db
      .update(agentPriceCatalogue)
      .set({ approvalStatus: "approved", approvedBy: approverId, approvedAtMs: now, updatedAtMs: now })
      .where(eq(agentPriceCatalogue.family, family));
    return { ...existing, approvalStatus: "approved", approvedBy: approverId, approvedAtMs: now, updatedAtMs: now };
  }
}
