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
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, asc, eq, gte } from "drizzle-orm";
import {
  agentDigestPassDays,
  agentDigestSends,
  agentDigestSubscriberEmails,
  agentNotificationPreferences,
  agentReferralAttributions,
  agentReferralEarnings,
  agentReferralRules,
  agentReferralTrialExtensions,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0015_LIFECYCLE_REFERRAL,
  MIGRATION_0031_REFERRAL_ATTRIBUTION,
  MIGRATION_0035_DIGEST_PASS,
  MIGRATION_0069_REFERRAL_EXPIRY,
  MIGRATION_0082_REFERRAL_TRIAL_EXTENSION,
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
  expiredBalanceFor,
  redeemableBalanceFor,
  referralEarningId,
  round2,
  validateReferralRules,
  type DigestSubscriber,
  type LifecycleStore,
  type NotificationPreferences,
  type ReferralAllocation,
  type ReferralAttribution,
  type ReferralEarning,
  type ReferralRules,
  type ReferralTrialExtension,
} from "./lifecyclePorts";
import { BusinessError } from "../outcomes/outcomeAspects";

/** Drizzle D1 database object carrying the lifecycle schema. */
export type LifecycleDb = DrizzleD1Database<{
  agentReferralRules: typeof agentReferralRules;
  agentReferralEarnings: typeof agentReferralEarnings;
  agentReferralAttributions: typeof agentReferralAttributions;
  agentReferralTrialExtensions: typeof agentReferralTrialExtensions;
  agentNotificationPreferences: typeof agentNotificationPreferences;
  agentDigestSends: typeof agentDigestSends;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1LifecycleDb(d1: D1Database): LifecycleDb {
  return createDrizzleD1Db(d1, {
    schema: {
      agentReferralRules,
      agentReferralEarnings,
      agentReferralAttributions,
      agentReferralTrialExtensions,
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
    MIGRATION_0035_DIGEST_PASS,
    MIGRATION_0069_REFERRAL_EXPIRY,
    MIGRATION_0082_REFERRAL_TRIAL_EXTENSION,
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

function toExtension(raw: typeof agentReferralTrialExtensions.$inferSelect): ReferralTrialExtension {
  return {
    id: raw.id,
    referrerUserId: raw.referrerUserId,
    referredUserId: raw.referredUserId,
    tenantId: raw.tenantId,
    daysGranted: raw.daysGranted,
    status: raw.status as ReferralTrialExtension["status"],
    subscriptionId: raw.subscriptionId,
    grantedAtMs: raw.grantedAtMs,
    expiresAtMs: raw.expiresAtMs,
    appliedAtMs: raw.appliedAtMs,
    consumedAtMs: raw.consumedAtMs,
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
    if (rows.length === 0) throw new BusinessError("FAILURE_UNEXPECTED_ERROR"); // #5606 (G-3)
    if (rows[0].redemptionScope !== "pay-per-run") {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    return {
      id: rows[0].id,
      earnAmountUSD: rows[0].earnAmountUSD,
      vestingDelayMs: rows[0].vestingDelayMs,
      redemptionScope: "pay-per-run",
      expiryPeriodMs: rows[0].expiryPeriodMs,
      extensionDays: rows[0].extensionDays,
      referredTrialDays: rows[0].referredTrialDays,
      maxExtensionsPerDay: rows[0].maxExtensionsPerDay,
      maxExtensionsPerMonth: rows[0].maxExtensionsPerMonth,
      referralTrialPlanId: rows[0].referralTrialPlanId,
      shareMessageTemplate: rows[0].shareMessageTemplate,
      updatedAtMs: rows[0].updatedAtMs,
    };
  }

  async setRules(input: {
    earnAmountUSD: unknown;
    vestingDelayMs: unknown;
    redemptionScope: unknown;
    expiryPeriodMs?: unknown;
    extensionDays?: unknown;
    referredTrialDays?: unknown;
    maxExtensionsPerDay?: unknown;
    maxExtensionsPerMonth?: unknown;
    referralTrialPlanId?: unknown;
    shareMessageTemplate?: unknown;
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
        expiryPeriodMs: record.expiryPeriodMs,
        extensionDays: record.extensionDays,
        referredTrialDays: record.referredTrialDays,
        maxExtensionsPerDay: record.maxExtensionsPerDay,
        maxExtensionsPerMonth: record.maxExtensionsPerMonth,
        referralTrialPlanId: record.referralTrialPlanId,
        shareMessageTemplate: record.shareMessageTemplate,
        updatedAtMs: record.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentReferralRules.id,
        set: {
          earnAmountUSD: record.earnAmountUSD,
          vestingDelayMs: record.vestingDelayMs,
          redemptionScope: record.redemptionScope,
          expiryPeriodMs: record.expiryPeriodMs,
          extensionDays: record.extensionDays,
          referredTrialDays: record.referredTrialDays,
          maxExtensionsPerDay: record.maxExtensionsPerDay,
          maxExtensionsPerMonth: record.maxExtensionsPerMonth,
          referralTrialPlanId: record.referralTrialPlanId,
          shareMessageTemplate: record.shareMessageTemplate,
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
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
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
    source?: ReferralAttribution["source"];
  }): Promise<ReferralAttribution> {
    if (!input.referrerUserId || !input.referredUserId || !input.tenantId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    const existing = await this.getAttribution(input.referredUserId);
    if (existing) {
      if (existing.referrerUserId !== input.referrerUserId) {
        throw new BusinessError("FAILURE_COMMERCIAL_CONFLICT"); // #5606 (G-3)
      }
      return existing;
    }
    const record: ReferralAttribution = {
      referredUserId: input.referredUserId,
      referrerUserId: input.referrerUserId,
      tenantId: input.tenantId,
      // Additive (#3307): a caller that passes nothing keeps
      // stamping "operator"; a referral-kind code redemption
      // passes "code".
      source: input.source ?? "operator",
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
      if (!raced) throw new BusinessError("FAILURE_UNEXPECTED_ERROR"); // #5606 (G-3)
      if (raced.referrerUserId !== input.referrerUserId) {
        throw new BusinessError("FAILURE_COMMERCIAL_CONFLICT"); // #5606 (G-3)
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
    const rules = await this.getRules();
    // #5229: the single balance-read path — vested AND unexpired.
    // Both adapters share redeemableBalanceFor, so the two
    // implementations cannot drift.
    return redeemableBalanceFor(earnings, Date.now(), rules.expiryPeriodMs);
  }

  async recordExtension(input: ReferralTrialExtension): Promise<ReferralTrialExtension> {
    if (!input.id || !input.referrerUserId || !input.referredUserId || !input.tenantId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    if (input.referrerUserId === input.referredUserId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    // INSERT OR IGNORE: one extension per referred user, ever.
    await this.db
      .insert(agentReferralTrialExtensions)
      .values({
        id: input.id,
        referrerUserId: input.referrerUserId,
        referredUserId: input.referredUserId,
        tenantId: input.tenantId,
        daysGranted: input.daysGranted,
        status: input.status,
        subscriptionId: input.subscriptionId,
        grantedAtMs: input.grantedAtMs,
        expiresAtMs: input.expiresAtMs,
        appliedAtMs: input.appliedAtMs,
        consumedAtMs: input.consumedAtMs,
      })
      .onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(agentReferralTrialExtensions)
      .where(eq(agentReferralTrialExtensions.id, input.id))
      .limit(1);
    return toExtension(rows[0]);
  }

  async listExtensions(referrerUserId: string): Promise<ReferralTrialExtension[]> {
    const rows = await this.db
      .select()
      .from(agentReferralTrialExtensions)
      .where(eq(agentReferralTrialExtensions.referrerUserId, referrerUserId))
      .orderBy(asc(agentReferralTrialExtensions.grantedAtMs), asc(agentReferralTrialExtensions.id));
    return rows.map(toExtension);
  }

  async countExtensionsSince(referrerUserId: string, sinceMs: number): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentReferralTrialExtensions)
      .where(
        and(
          eq(agentReferralTrialExtensions.referrerUserId, referrerUserId),
          gte(agentReferralTrialExtensions.grantedAtMs, sinceMs),
        ),
      );
    return rows.length;
  }

  async markExtensionApplied(
    id: string,
    subscriptionId: string,
    nowMs: number,
  ): Promise<ReferralTrialExtension | null> {
    await this.db
      .update(agentReferralTrialExtensions)
      .set({ status: "applied", subscriptionId, appliedAtMs: nowMs })
      .where(eq(agentReferralTrialExtensions.id, id));
    const rows = await this.db
      .select()
      .from(agentReferralTrialExtensions)
      .where(eq(agentReferralTrialExtensions.id, id))
      .limit(1);
    return rows.length === 0 ? null : toExtension(rows[0]);
  }

  async markExtensionConsumed(
    id: string,
    subscriptionId: string,
    nowMs: number,
  ): Promise<ReferralTrialExtension | null> {
    await this.db
      .update(agentReferralTrialExtensions)
      .set({ status: "consumed", subscriptionId, consumedAtMs: nowMs })
      .where(eq(agentReferralTrialExtensions.id, id));
    const rows = await this.db
      .select()
      .from(agentReferralTrialExtensions)
      .where(eq(agentReferralTrialExtensions.id, id))
      .limit(1);
    return rows.length === 0 ? null : toExtension(rows[0]);
  }

  async redeem(input: {
    userId: string;
    tenantId: string;
    amountUSD: number;
    runRequestId: string;
  }): Promise<{ allocations: ReferralAllocation[]; redeemedUSD: number; expiredUSD: number }> {
    if (!input.userId || !input.tenantId || !input.runRequestId) {
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
    }
    const earnings = await this.listEarnings(input.userId);
    // Tenant isolation, checked before any write: every earning
    // redeemed here must belong to the caller's tenant.
    for (const e of earnings) {
      if (e.tenantId !== input.tenantId) {
        throw new BusinessError("FAILURE_COMMERCIAL_FORBIDDEN"); // #5606 (G-3)
      }
    }
    const rules = await this.getRules();
    const now = Date.now();
    const allocations = allocateRedemption(earnings, input.amountUSD, now, rules.expiryPeriodMs);
    const expiredUSD = expiredBalanceFor(earnings, now, rules.expiryPeriodMs);
    for (const a of allocations) {
      const earning = earnings.find((e) => e.id === a.earningId);
      if (!earning) throw new BusinessError("FAILURE_UNEXPECTED_ERROR"); // #5606 (G-3)
      const next = round2(earning.redeemedAmountUSD + a.amountUSD);
      if (next > earning.amountUSD) {
        throw new BusinessError("FAILURE_UNEXPECTED_ERROR"); // #5606 (G-3)
      }
      await this.db
        .update(agentReferralEarnings)
        .set({ redeemedAmountUSD: next, redeemedByRunId: input.runRequestId, redeemedAtMs: now })
        .where(eq(agentReferralEarnings.id, a.earningId));
    }
    return { allocations, redeemedUSD: round2(allocations.reduce((s, a) => s + a.amountUSD, 0)), expiredUSD };
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
      throw new BusinessError("FAILURE_COMMERCIAL_REQUEST_INVALID"); // #5606 (G-3)
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

  async suppressMailForUser(userId: string): Promise<NotificationPreferences | null> {
    // Issue #2660: one UPDATE keyed by user_id alone (the table's
    // primary key), so no tenant scope is consulted and no
    // tenant-mismatch failure is possible. No row → null: defaults
    // are already digest-OFF, so there is nothing to suppress.
    if (!userId) throw new Error("userId is required.");
    const rows = await this.db
      .select()
      .from(agentNotificationPreferences)
      .where(eq(agentNotificationPreferences.userId, userId))
      .limit(1);
    if (rows.length === 0) return null;
    const updatedAtMs = Date.now();
    await this.db
      .update(agentNotificationPreferences)
      .set({ digestEnabled: 0, welcomeEnabled: 0, updatedAtMs })
      .where(eq(agentNotificationPreferences.userId, userId));
    return {
      userId: rows[0].userId,
      tenantId: rows[0].tenantId,
      digestEnabled: false,
      welcomeEnabled: false,
      updatedAtMs,
    };
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

  async listDigestSubscribers(): Promise<DigestSubscriber[]> {
    // Digest-enabled rows only, ordered by user_id for a
    // deterministic pass order. The email JOIN is tenant-aware:
    // an address recorded under another tenant never leaks.
    const rows = await this.db
      .select({
        userId: agentNotificationPreferences.userId,
        tenantId: agentNotificationPreferences.tenantId,
        email: agentDigestSubscriberEmails.email,
      })
      .from(agentNotificationPreferences)
      .leftJoin(
        agentDigestSubscriberEmails,
        and(
          eq(agentDigestSubscriberEmails.userId, agentNotificationPreferences.userId),
          eq(agentDigestSubscriberEmails.tenantId, agentNotificationPreferences.tenantId),
        ),
      )
      .where(eq(agentNotificationPreferences.digestEnabled, 1))
      .orderBy(asc(agentNotificationPreferences.userId));
    return rows.map((r) => ({ userId: r.userId, tenantId: r.tenantId, email: r.email ?? null }));
  }

  async setSubscriberEmail(userId: string, tenantId: string, email: string): Promise<void> {
    if (!userId || !tenantId || !email) {
      throw new Error("userId, tenantId, and email are required.");
    }
    // #1761: the address table's primary key is user_id alone,
    // so an upsert would otherwise overwrite another tenant's
    // row. Fail closed: a stored row for another tenant throws
    // before any write. Callers (send routes) catch: persistence
    // never changes a send result.
    const scope = bindTenantScope(tenantId);
    const raw = await this.db
      .select()
      .from(agentDigestSubscriberEmails)
      .where(eq(agentDigestSubscriberEmails.userId, userId))
      .limit(1);
    if (raw.length > 0) assertTenantScopeMatch(raw[0].tenantId, scope);
    await this.db
      .insert(agentDigestSubscriberEmails)
      .values({ userId, tenantId, email, updatedAtMs: Date.now() })
      .onConflictDoUpdate({
        target: agentDigestSubscriberEmails.userId,
        set: { tenantId, email, updatedAtMs: Date.now() },
      });
  }

  async hasDigestPassRun(day: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(agentDigestPassDays)
      .where(eq(agentDigestPassDays.day, day))
      .limit(1);
    return rows.length > 0;
  }

  async markDigestPassRun(day: string): Promise<void> {
    await this.db
      .insert(agentDigestPassDays)
      .values({ day, ranAtMs: Date.now() })
      .onConflictDoNothing();
  }
}
