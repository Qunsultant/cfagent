/**
 * Issue #3246 (sub-issue of #3241) — Drizzle D1 adapter for the
 * offer-suppression port. This module is the ONLY place
 * offer-suppression code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder) lives here, behind the port
 * interface. Every operation is a single statement, which is
 * atomic on any store (same rule as the other D1 adapters; see
 * migrationRunner.ts).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { agentOfferSuppressions } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0058_PRODUCT_VERSIONS,
  MIGRATION_0062_OFFER_SUPPRESSIONS_RANK,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertOfferSuppressionInput,
  type OfferSuppression,
  type OfferSuppressionPort,
  type OfferTrigger,
} from "./offerSuppressionPorts";

/** Drizzle D1 database object carrying the offer-suppression schema. */
export type OfferSuppressionDb = DrizzleD1Database<{
  agentOfferSuppressions: typeof agentOfferSuppressions;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1OfferSuppressionDb(d1: D1Database): OfferSuppressionDb {
  return drizzle(d1, {
    schema: {
      agentOfferSuppressions,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0062 (the
 * suppressions table + the product rank column) with 0058's
 * prerequisite chain, so a store ensured through this path
 * alone still has agent_products for the ALTER. applyMigrations
 * sorts by version, so list order does not matter.
 */
export async function ensureOfferSuppressionSchema(db: OfferSuppressionDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0058_PRODUCT_VERSIONS,
    MIGRATION_0062_OFFER_SUPPRESSIONS_RANK,
  ]);
}

/** Offer-suppression store over D1 via Drizzle. */
export class D1OfferSuppressionAdapter implements OfferSuppressionPort {
  constructor(readonly db: OfferSuppressionDb) {}

  async getSuppression(login: string, trigger: OfferTrigger): Promise<OfferSuppression | null> {
    const rows = await this.db
      .select()
      .from(agentOfferSuppressions)
      .where(
        and(eq(agentOfferSuppressions.login, login), eq(agentOfferSuppressions.trigger, trigger)),
      )
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      login: row.login,
      trigger: row.trigger as OfferTrigger,
      suppressedUntilMs: row.suppressedUntilMs,
      dismissedAtMs: row.dismissedAtMs,
    };
  }

  async setSuppression(input: {
    login: string;
    trigger: OfferTrigger;
    suppressedUntilMs: number;
    dismissedAtMs: number;
  }): Promise<OfferSuppression> {
    const validated = assertOfferSuppressionInput(input);
    await this.db
      .insert(agentOfferSuppressions)
      .values({
        login: validated.login,
        trigger: validated.trigger,
        suppressedUntilMs: validated.suppressedUntilMs,
        dismissedAtMs: validated.dismissedAtMs,
      })
      .onConflictDoUpdate({
        target: [agentOfferSuppressions.login, agentOfferSuppressions.trigger],
        set: {
          suppressedUntilMs: validated.suppressedUntilMs,
          dismissedAtMs: validated.dismissedAtMs,
        },
      });
    return validated;
  }
}
