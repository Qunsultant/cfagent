/**
 * Issue #2208 — Drizzle D1 adapter for the lifecycle port. This
 * module is the ONLY place lifecycle-store code touches a store
 * client: all SQL-adjacent code (the Drizzle query builder)
 * lives here, behind the port interfaces.
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT, one UPDATE), which is atomic on any
 * store — the same rule as the commercial adapter. Redemption
 * reads then allocates pure-first (allocateRedemption throws
 * before any write on shortfall or unvested-only balance), then
 * applies one UPDATE per allocated earning; a concurrent redeem
 * of the same earning can over-allocate in the same read-then-
 * write way the commercial adapter's adjustCredits can, and is
 * reconciled from the earning rows (redeemedAmountUSD never
 * exceeds amountUSD — an over-allocating UPDATE is refused by
 * the adapter's own guard and the whole redeem throws).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import {
  agentDigestSends,
  agentNotificationPreferences,
  agentReferralAttributions,
  agentReferralEarnings,
  agentReferralRules,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0015_LIFECYCLE_REFERRAL,
  MIGRATION_0031_REFERRAL_ATTRIBUTION,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertTenantScopeMatch,
  bindTenantScope,
  tenantEq,
} from "./tenantScope";
import {
  allocateRedemption,
  defaultPreferences,
  referralEarningId,
  round2,
  validateReferralRules,
  type LifecycleStore,
  type NotificationPreferences,
  type ReferralAllocation,
  type ReferralAttribution,
  type ReferralEarning,
  type ReferralRules,
} from "./lifecyclePorts";

/** Drizzle D1 database object carrying the lifecycle schema. */
export type LifecycleDb = DrizzleD1Database<{
  agentReferralRules: typeof agentReferralRules;
  agentReferralEarnings: typeof agentReferralEarnings;
  agentReferralAttributions: typeof agentReferralAttributions;
  agentNotificationPreferences: typeof agentNotificationPreferences;
  agentDigestSends: typeof agentDigestSends;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1LifecycleDb(d1: D1Database): LifecycleDb {
  return drizzle(d1, {
    schema: {
      agentReferralRules,
      agentReferralEarnings,
      agentReferralAttributions,
      agentNotificationPreferences,
      agentDigestSends,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0015 (ledger + rules) and
 * migration 0031 (attribution store, #2657) if unapplied. The rule seed
 * lives IN the migration SQL (data, not a code constant); nothing here
 * re-seeds or overwrites an operator-changed rule row. The attribution
 * migration seeds nothing: no attribution, no grant.
 */
export async function ensureLifecycleSchema(db: LifecycleDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0015_LIFECYCLE_REFERRAL,
    MIGRATION_0031_REFERRAL_ATTRIBUTION,
  ]);
}

function toAttribution(raw: typeof agentReferralAttributions.$inferSelect): ReferralAttribution {
  return {
    referredUserId: raw.referredUserId,
    referrerUserId: raw.referrerUserId,
    tenantId: raw.tenantId,
    source: raw.source as ReferralAttribution["source"],
    createdAtMs: raw.createdAtMs,
  };
}

function toEarning(raw: typeof agentReferralEarnings.$inferSelect): ReferralEarning {
  return {
    id: raw.id,
    referrerUserId: raw.referrerUserId,
    referredUserId: raw.referredUserId,
    tenantId: raw.tenantId,
    amountUSD: raw.amountUSD,
    redeemedAmountUSD: raw.redeemedAmountUSD,
    earnedAtMs: raw.earnedAtMs,
    vestedAtMs: raw.vestedAtMs,
    redeemedByRunId: raw.redeemedByRunId,
    redeemedAtMs: raw.redeemedAtMs,
  };
}

/** Lifecycle store over D1 via Drizzle. */
export class D1LifecycleAdapter implements LifecycleStore {
  constructor(readonly db: LifecycleDb) {}

  async getRules(): Promise<ReferralRules> {
    const rows = await this.db
      .select()
      .from(agentReferralRules)
      .where(eq(agentReferralRules.id, "default"))
      .limit(1);
    if (rows.length === 0) throw new Error("Referral rules not seeded: migration 0015 has not run.");
    if (rows[0].redemptionScope !== "pay-per-run") {
      throw new Error(`Unknown referral redemptionScope: ${rows[0].redemptionScope}.`);
    }
    return {
      id: rows[0].id,
      earnAmountUSD: rows[0].earnAmountUSD,
      vestingDelayMs: rows[0].vestingDelayMs,
      redemptionScope: "pay-per-run",
      updatedAtMs: rows[0].updatedAtMs,
    };
  }

  async setRules(input: {
    earnAmountUSD: unknown;
    vestingDelayMs: unknown;
    redemptionScope: unknown;
  }): Promise<ReferralRules> {
    const validated = validateReferralRules(input);
    const record: ReferralRules = { id: "default", ...validated, updatedAtMs: Date.now() };
    await this.db
      .insert(agentReferralRules)
      .values({
        id: record.id,
        earnAmountUSD: record.earnAmountUSD,
        vestingDelayMs: record.vestingDelayMs,
        redemptionScope: record.redemptionScope,
        updatedAtMs: record.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentReferralRules.id,
        set: {
          earnAmountUSD: record.earnAmountUSD,
          vestingDelayMs: record.vestingDelayMs,
          redemptionScope: record.redemptionScope,
          updatedAtMs: record.updatedAtMs,
        },
      });
    return record;
  }

  async recordEarning(input: {
    referrerUserId: string;
    referredUserId: string;
    tenantId: string;
  }): Promise<ReferralEarning> {
    if (!input.referrerUserId || !input.referredUserId || !input.tenantId) {
      throw new Error("referrerUserId, referredUserId, and tenantId are required.");
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new Error("A user cannot refer themselves.");
    }
    const rules = await this.getRules();
    const now = Date.now();
    const record: ReferralEarning = {
      id: referralEarningId(input.referredUserId),
      referrerUserId: input.referrerUserId,
      referredUserId: input.referredUserId,
      tenantId: input.tenantId,
      amountUSD: rules.earnAmountUSD,
      redeemedAmountUSD: 0,
      earnedAtMs: now,
      vestedAtMs: now + rules.vestingDelayMs,
      redeemedByRunId: null,
      redeemedAtMs: null,
    };
    // INSERT OR IGNORE: one earning per referred user, ever.
    await this.db
      .insert(agentReferralEarnings)
      .values({
        id: record.id,
        referrerUserId: record.referrerUserId,
        referredUserId: record.referredUserId,
        tenantId: record.tenantId,
        amountUSD: record.amountUSD,
        redeemedAmountUSD: record.redeemedAmountUSD,
        earnedAtMs: record.earnedAtMs,
        vestedAtMs: record.vestedAtMs,
        redeemedByRunId: record.redeemedByRunId,
        redeemedAtMs: record.redeemedAtMs,
      })
      .onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(agentReferralEarnings)
      .where(eq(agentReferralEarnings.id, record.id))
      .limit(1);
    return toEarning(rows[0]);
  }

  async recordAttribution(input: {
    referrerUserId: string;
    referredUserId: string;
    tenantId: string;
  }): Promise<ReferralAttribution> {
    if (!input.referrerUserId || !input.referredUserId || !input.tenantId) {
      throw new Error("referrerUserId, referredUserId, and tenantId are required.");
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new Error("A user cannot refer themselves.");
    }
    const existing = await this.getAttribution(input.referredUserId);
    if (existing) {
      if (existing.referrerUserId !== input.referrerUserId) {
        throw new Error(
          `User ${input.referredUserId} is already attributed to a different referrer; attribution is set-once and is never silently overwritten.`,
        );
      }
      return existing;
    }
    const record: ReferralAttribution = {
      referredUserId: input.referredUserId,
      referrerUserId: input.referrerUserId,
      tenantId: input.tenantId,
      source: "operator",
      createdAtMs: Date.now(),
    };
    try {
      await this.db.insert(agentReferralAttributions).values({
        referredUserId: record.referredUserId,
        referrerUserId: record.referrerUserId,
        tenantId: record.tenantId,
        source: record.source,
        createdAtMs: record.createdAtMs,
      });
    } catch {
      // Racing second attribution for the same user hit the PRIMARY KEY:
      // reconcile from the row, never a duplicate.
      const raced = await this.getAttribution(input.referredUserId);
      if (!raced) throw new Error("Referral attribution insert failed.");
      if (raced.referrerUserId !== input.referrerUserId) {
        throw new Error(
          `User ${input.referredUserId} is already attributed to a different referrer; attribution is set-once and is never silently overwritten.`,
        );
      }
      return raced;
    }
    return record;
  }

  async getAttribution(referredUserId: string): Promise<ReferralAttribution | null> {
    if (!referredUserId) return null;
    const rows = await this.db
      .select()
      .from(agentReferralAttributions)
      .where(eq(agentReferralAttributions.referredUserId, referredUserId))
      .limit(1);
    return rows.length === 0 ? null : toAttribution(rows[0]);
  }

  async listEarnings(userId: string): Promise<ReferralEarning[]> {
    const rows = await this.db
      .select()
      .from(agentReferralEarnings)
      .where(eq(agentReferralEarnings.referrerUserId, userId))
      .orderBy(asc(agentReferralEarnings.earnedAtMs), asc(agentReferralEarnings.id));
    return rows.map(toEarning);
  }

  async redeemableBalance(userId: string): Promise<number> {
    const earnings = await this.listEarnings(userId);
    const now = Date.now();
    let total = 0;
    for (const e of earnings) {
      if (now < e.vestedAtMs) continue;
      total = round2(total + round2(e.amountUSD - e.redeemedAmountUSD));
    }
    return total;
  }

  async redeem(input: {
    userId: string;
    tenantId: string;
    amountUSD: number;
    runRequestId: string;
  }): Promise<{ allocations: ReferralAllocation[]; redeemedUSD: number }> {
    if (!input.userId || !input.tenantId || !input.runRequestId) {
      throw new Error("userId, tenantId, and runRequestId are required.");
    }
    const earnings = await this.listEarnings(input.userId);
    // Tenant isolation, checked before any write: every earning
    // redeemed here must belong to the caller's tenant.
    for (const e of earnings) {
      if (e.tenantId !== input.tenantId) {
        throw new Error("Referral credits never cross tenants: earning tenant differs from run tenant.");
      }
    }
    const allocations = allocateRedemption(earnings, input.amountUSD, Date.now());
    const now = Date.now();
    for (const a of allocations) {
      const earning = earnings.find((e) => e.id === a.earningId);
      if (!earning) throw new Error(`Referral earning ${a.earningId} vanished mid-redeem.`);
      const next = round2(earning.redeemedAmountUSD + a.amountUSD);
      if (next > earning.amountUSD) {
        throw new Error(`Referral earning ${a.earningId} would over-redeem; redeem refused.`);
      }
      await this.db
        .update(agentReferralEarnings)
        .set({ redeemedAmountUSD: next, redeemedByRunId: input.runRequestId, redeemedAtMs: now })
        .where(eq(agentReferralEarnings.id, a.earningId));
    }
    return { allocations, redeemedUSD: round2(allocations.reduce((s, a) => s + a.amountUSD, 0)) };
  }

  async getPreferences(userId: string, tenantId: string): Promise<NotificationPreferences> {
    // #1761: the pre-fix read predicated on user_id alone and
    // returned another tenant's row for the same user. The tenant
    // filter is now built by the bound scope: a blank tenant
    // throws, a mismatched tenant reads defaults (never the
    // other tenant's row).
    const scope = bindTenantScope(tenantId);
    const rows = await this.db
      .select()
      .from(agentNotificationPreferences)
      .where(
        and(
          eq(agentNotificationPreferences.userId, userId),
          tenantEq(agentNotificationPreferences, scope),
        ),
      )
      .limit(1);
    if (rows.length === 0) return defaultPreferences(userId, tenantId);
    return {
      userId: rows[0].userId,
      tenantId: rows[0].tenantId,
      digestEnabled: rows[0].digestEnabled === 1,
      welcomeEnabled: rows[0].welcomeEnabled === 1,
      updatedAtMs: rows[0].updatedAtMs,
    };
  }

  async setPreferences(input: {
    userId: string;
    tenantId: string;
    digestEnabled?: unknown;
    welcomeEnabled?: unknown;
  }): Promise<NotificationPreferences> {
    if (!input.userId || !input.tenantId) {
      throw new Error("userId and tenantId are required.");
    }
    // #1761: the table's primary key is user_id alone, so the
    // upsert below would otherwise overwrite another tenant's
    // row. Fail closed: a stored row for another tenant throws
    // before any write, instead of being silently clobbered.
    const scope = bindTenantScope(input.tenantId);
    const raw = await this.db
      .select()
      .from(agentNotificationPreferences)
      .where(eq(agentNotificationPreferences.userId, input.userId))
      .limit(1);
    if (raw.length > 0) assertTenantScopeMatch(raw[0].tenantId, scope);
    const existing = await this.getPreferences(input.userId, input.tenantId);
    const record: NotificationPreferences = {
      userId: input.userId,
      tenantId: input.tenantId,
      digestEnabled:
        input.digestEnabled === undefined ? existing.digestEnabled : input.digestEnabled === true,
      welcomeEnabled:
        input.welcomeEnabled === undefined ? existing.welcomeEnabled : input.welcomeEnabled === true,
      updatedAtMs: Date.now(),
    };
    await this.db
      .insert(agentNotificationPreferences)
      .values({
        userId: record.userId,
        tenantId: record.tenantId,
        digestEnabled: record.digestEnabled ? 1 : 0,
        welcomeEnabled: record.welcomeEnabled ? 1 : 0,
        updatedAtMs: record.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentNotificationPreferences.userId,
        set: {
          tenantId: record.tenantId,
          digestEnabled: record.digestEnabled ? 1 : 0,
          welcomeEnabled: record.welcomeEnabled ? 1 : 0,
          updatedAtMs: record.updatedAtMs,
        },
      });
    return record;
  }

  async hasSentDigest(userId: string, day: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(agentDigestSends)
      .where(and(eq(agentDigestSends.userId, userId), eq(agentDigestSends.day, day)))
      .limit(1);
    return rows.length > 0;
  }

  async markDigestSent(userId: string, day: string): Promise<void> {
    await this.db
      .insert(agentDigestSends)
      .values({ userId, day, sentAtMs: Date.now() })
      .onConflictDoNothing();
  }
}
