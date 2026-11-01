/**
 * Issue #2656 (Phase 2.1, #2405) — Drizzle D1 adapter for the
 * Billing customer mapping port. This module is the ONLY place
 * billing-customer code touches a store client. Every operation
 * is a single statement, which is atomic on any store (same
 * rule as the other D1 adapters; see migrationRunner.ts).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { agentBillingCustomers } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0030_BILLING_CUSTOMERS,
  type MigrationDb,
} from "./migrationRunner";
import type {
  BillingCustomerRecord,
  BillingCustomerStore,
} from "./billingCustomerPorts";

/** Drizzle D1 database object carrying the billing-customer schema. */
export type BillingCustomerDb = DrizzleD1Database<{
  agentBillingCustomers: typeof agentBillingCustomers;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1BillingCustomerDb(d1: D1Database): BillingCustomerDb {
  return drizzle(d1, {
    schema: {
      agentBillingCustomers,
    },
  });
}

/** Idempotent schema-ensure: applies migration 0030 if unapplied. */
export async function ensureBillingCustomerSchema(db: BillingCustomerDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0030_BILLING_CUSTOMERS]);
}

function toRecord(raw: typeof agentBillingCustomers.$inferSelect): BillingCustomerRecord {
  return {
    userId: raw.userId,
    tenantId: raw.tenantId,
    stripeCustomerId: raw.stripeCustomerId,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Billing customer mapping over D1 via Drizzle. */
export class D1BillingCustomerAdapter implements BillingCustomerStore {
  constructor(readonly db: BillingCustomerDb) {}

  async getCustomer(userId: string): Promise<BillingCustomerRecord | null> {
    const rows = await this.db
      .select()
      .from(agentBillingCustomers)
      .where(eq(agentBillingCustomers.userId, userId))
      .limit(1);
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async recordCustomer(input: {
    userId: string;
    tenantId: string;
    stripeCustomerId: string;
  }): Promise<BillingCustomerRecord> {
    if (!input.userId || !input.tenantId || !input.stripeCustomerId) {
      throw new Error("userId, tenantId, and stripeCustomerId are required to record a Billing customer.");
    }
    const existing = await this.getCustomer(input.userId);
    if (existing) {
      if (existing.stripeCustomerId !== input.stripeCustomerId) {
        throw new Error(
          `Billing customer mismatch for user ${input.userId}: mapped to ${existing.stripeCustomerId}, refusing ${input.stripeCustomerId} (operator resolves; never a silent overwrite).`,
        );
      }
      return existing;
    }
    const now = Date.now();
    const record: BillingCustomerRecord = { ...input, createdAtMs: now, updatedAtMs: now };
    await this.db.insert(agentBillingCustomers).values({
      userId: record.userId,
      tenantId: record.tenantId,
      stripeCustomerId: record.stripeCustomerId,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    return record;
  }
}
