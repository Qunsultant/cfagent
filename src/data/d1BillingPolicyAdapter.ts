/**
 * Issue #2202 — Drizzle D1 adapter for the billing-policy
 * port. This module is the ONLY place billing-policy code
 * touches a store client: all SQL-adjacent code (the
 * Drizzle query builder) lives here, behind the port
 * interface. Every operation is a single statement, which
 * is atomic on any store (same rule as the other D1
 * adapters; see migrationRunner.ts).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { agentBillingPolicy } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0014_BILLING,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertBillingPolicy,
  BILLING_POLICY_KEYS,
  PROPOSED_SEED_BILLING_POLICY,
  type BillingPolicy,
  type BillingPolicyStore,
} from "./billingPolicyPorts";

/** Drizzle D1 database object carrying the billing-policy schema. */
export type BillingPolicyDb = DrizzleD1Database<{
  agentBillingPolicy: typeof agentBillingPolicy;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1BillingPolicyDb(d1: D1Database): BillingPolicyDb {
  return drizzle(d1, {
    schema: {
      agentBillingPolicy,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0014 if
 * unapplied, then seeds the proposed policy rows (INSERT
 * OR IGNORE — re-seeding is a no-op, so an operator-edited
 * value is never overwritten by a later ensure). PREREQUISITE:
 * the subscription schema (migrations 0008 + 0013) must be
 * applied first, because 0014 alters agent_subscriptions
 * (same precedent as 0008 altering the 0007 accounts
 * table). The seeds are PROPOSED defaults pending owner
 * approval, not an activation.
 */
export async function ensureBillingPolicySchema(db: BillingPolicyDb): Promise<number[]> {
  const applied = await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0014_BILLING]);
  const now = Date.now();
  const seedRows: Array<[string, unknown]> = [
    [BILLING_POLICY_KEYS.billingPeriodDefault, PROPOSED_SEED_BILLING_POLICY.billingPeriodDefault],
    [BILLING_POLICY_KEYS.billingPeriodsAllowed, PROPOSED_SEED_BILLING_POLICY.billingPeriodsAllowed],
    [BILLING_POLICY_KEYS.dunningRetryDelayDays, PROPOSED_SEED_BILLING_POLICY.dunningRetryDelayDays],
    [BILLING_POLICY_KEYS.gracePeriodDays, PROPOSED_SEED_BILLING_POLICY.gracePeriodDays],
    [BILLING_POLICY_KEYS.downgradeTiming, PROPOSED_SEED_BILLING_POLICY.downgradeTiming],
    [BILLING_POLICY_KEYS.prorationBehavior, PROPOSED_SEED_BILLING_POLICY.prorationBehavior],
    [BILLING_POLICY_KEYS.repurchaseMigration, PROPOSED_SEED_BILLING_POLICY.repurchaseMigration],
    [BILLING_POLICY_KEYS.stripePriceByPlan, PROPOSED_SEED_BILLING_POLICY.stripePriceByPlan],
    [BILLING_POLICY_KEYS.cfpayChannelFixedPriceUSD, PROPOSED_SEED_BILLING_POLICY.cfpayChannelFixedPriceUSD],
    [BILLING_POLICY_KEYS.topUpMinUSD, PROPOSED_SEED_BILLING_POLICY.topUpMinUSD],
    [BILLING_POLICY_KEYS.topUpMaxUSD, PROPOSED_SEED_BILLING_POLICY.topUpMaxUSD],
    [BILLING_POLICY_KEYS.annualDiscountPct, PROPOSED_SEED_BILLING_POLICY.annualDiscountPct],
  ];
  for (const [key, value] of seedRows) {
    await db
      .insert(agentBillingPolicy)
      .values({ key, valueJson: JSON.stringify(value), updatedAtMs: now })
      .onConflictDoNothing();
  }
  return applied;
}

function keyFor(field: keyof BillingPolicy): string {
  return BILLING_POLICY_KEYS[field];
}

/** Billing policy over D1 via Drizzle. */
export class D1BillingPolicyAdapter implements BillingPolicyStore {
  constructor(readonly db: BillingPolicyDb) {}

  async getPolicy(): Promise<BillingPolicy> {
    const rows = await this.db.select().from(agentBillingPolicy);
    const stored: Record<string, unknown> = { ...PROPOSED_SEED_BILLING_POLICY };
    const byKey: Record<string, string> = {};
    for (const row of rows) byKey[row.key] = row.valueJson;
    const fieldByKey: Record<string, keyof BillingPolicy> = {
      [BILLING_POLICY_KEYS.billingPeriodDefault]: "billingPeriodDefault",
      [BILLING_POLICY_KEYS.billingPeriodsAllowed]: "billingPeriodsAllowed",
      [BILLING_POLICY_KEYS.dunningRetryDelayDays]: "dunningRetryDelayDays",
      [BILLING_POLICY_KEYS.gracePeriodDays]: "gracePeriodDays",
      [BILLING_POLICY_KEYS.downgradeTiming]: "downgradeTiming",
      [BILLING_POLICY_KEYS.prorationBehavior]: "prorationBehavior",
      [BILLING_POLICY_KEYS.repurchaseMigration]: "repurchaseMigration",
      [BILLING_POLICY_KEYS.stripePriceByPlan]: "stripePriceByPlan",
      [BILLING_POLICY_KEYS.cfpayChannelFixedPriceUSD]: "cfpayChannelFixedPriceUSD",
      [BILLING_POLICY_KEYS.topUpMinUSD]: "topUpMinUSD",
      [BILLING_POLICY_KEYS.topUpMaxUSD]: "topUpMaxUSD",
      [BILLING_POLICY_KEYS.annualDiscountPct]: "annualDiscountPct",
    };
    for (const [key, field] of Object.entries(fieldByKey)) {
      const raw = byKey[key];
      if (raw === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Billing policy row ${key} is not valid JSON: refusing to guess a policy (fail closed).`);
      }
      stored[field] = parsed;
    }
    return assertBillingPolicy(stored);
  }

  async updatePolicy(partial: Partial<BillingPolicy>): Promise<BillingPolicy> {
    const current = await this.getPolicy();
    const merged: BillingPolicy = { ...current, ...partial };
    // Validate the merged result (partial itself is validated by the caller-facing service; re-validating here keeps the store fail-closed even for direct callers).
    const validated = assertBillingPolicy(merged);
    const now = Date.now();
    for (const field of Object.keys(partial) as Array<keyof BillingPolicy>) {
      const key = keyFor(field);
      const valueJson = JSON.stringify(validated[field]);
      try {
        await this.db.insert(agentBillingPolicy).values({ key, valueJson, updatedAtMs: now });
      } catch {
        await this.db
          .update(agentBillingPolicy)
          .set({ valueJson, updatedAtMs: now })
          .where(eq(agentBillingPolicy.key, key));
      }
    }
    return validated;
  }
}
