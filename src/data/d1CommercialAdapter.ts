/**
 * Issues #2015/#2020/#2022 — Drizzle D1 adapter for the commercial
 * store port. This module is the ONLY place commercial-store code
 * touches a store client: all SQL-adjacent code (the Drizzle query
 * builder) lives here, behind the port interface.
 *
 * Transactions: every operation is a single statement (one INSERT,
 * one SELECT, one UPDATE), which is atomic on any store. No
 * multi-statement transaction is used here, for the reason
 * recorded in migrationRunner.ts (drizzle-orm/d1's `db.transaction()`
 * is sequential BEGIN/COMMIT, not Postgres-equivalent atomicity on
 * D1). The redemption claim is a single PK insert: the loser of a
 * race gets a UNIQUE violation and re-checks, never a double spend.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  agentCommercialAccounts,
  agentCreditClaims,
  agentCreditRedemptions,
  agentPaidSubmissions,
  agentTenantSettings,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0010_PAID_SUBMISSIONS,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0026_TENANT_AUTO_REFRESH,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0028_TENANT_PROVIDERS,
  MIGRATION_0040_UNLIMITED_FREE_GRANT,
  MIGRATION_0058_PRODUCT_VERSIONS,
  MIGRATION_0062_OFFER_SUPPRESSIONS_RANK,
  type MigrationDb,
} from "./migrationRunner";
import { assertSegment, DEFAULT_SEGMENT } from "./productPorts";
import {
  assertIncludedRuns,
  assertNonNegativeCredits,
  assertStoreTier,
  resolveUnlimitedFreeGrantUpdate,
  DEFAULT_TENANT_AUTO_REFRESH,
  DEFAULT_TENANT_PROVIDERS,
  round2,
  type CommercialAccountRecord,
  type CommercialStore,
  type CreditClaimRecord,
  type CreditRedemptionRecord,
  type PaidSubmissionRecord,
  type TenantAutoRefresh,
  type TenantProviders,
  type TenantSettingsRecord,
} from "./commercialPorts";

/** Drizzle D1 database object carrying the commercial schema. */
export type CommercialDb = DrizzleD1Database<{
  agentCommercialAccounts: typeof agentCommercialAccounts;
  agentTenantSettings: typeof agentTenantSettings;
  agentCreditClaims: typeof agentCreditClaims;
  agentCreditRedemptions: typeof agentCreditRedemptions;
  agentPaidSubmissions: typeof agentPaidSubmissions;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1CommercialDb(d1: D1Database): CommercialDb {
  return drizzle(d1, {
    schema: {
      agentCommercialAccounts,
      agentTenantSettings,
      agentCreditClaims,
      agentCreditRedemptions,
      agentPaidSubmissions,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migrations 0007, 0010, and
 * 0026 if unapplied. 0010 rides with 0007 because the
 * submission-status ownership read needs the paid-submissions
 * table wherever the commercial store is ensured; 0026 (#2481)
 * adds the per-tenant auto-refresh columns to the tenant
 * settings row, so a commercial call site is also an ensure
 * site for the switch. 0040 (#3245) adds the unlimited-free
 * grant columns to the accounts row, same pattern. Issue #3289:
 * 0058 adds the account segment column and the claim
 * per-charge columns, so its prerequisites (0008 plans, 0009
 * journal, 0011 + 0027 catalogue, 0012 native ledger) ride along.
 */
export async function ensureCommercialSchema(db: CommercialDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0010_PAID_SUBMISSIONS,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0026_TENANT_AUTO_REFRESH,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    MIGRATION_0028_TENANT_PROVIDERS,
    MIGRATION_0040_UNLIMITED_FREE_GRANT,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0058_PRODUCT_VERSIONS,
    MIGRATION_0062_OFFER_SUPPRESSIONS_RANK,
  ]);
}

function toAccount(raw: typeof agentCommercialAccounts.$inferSelect): CommercialAccountRecord {
  // Pre-0040 rows have NULL grant columns: the row reads as "no
  // grant", never as an error. A half-written grant (grantedBy
  // without a reason) also reads as no grant — fail closed.
  const grantedBy = raw.unlimitedFreeGrantedBy ?? null;
  const reason = raw.unlimitedFreeReason ?? null;
  const expiresAtMs = raw.unlimitedFreeExpiresAtMs ?? null;
  return {
    id: raw.id,
    tenantId: raw.tenantId,
    tier: assertStoreTier(raw.tier),
    tierSource: raw.tierSource === "operator" || raw.tierSource === "subscription" ? raw.tierSource : null,
    creditsUSD: raw.creditsUSD,
    includedRuns: raw.includedRuns,
    unlimitedFreeGrant:
      grantedBy !== null && reason !== null
        ? { grantedBy, reason, expiresAtMs }
        : null,
    // Issue #3289: pre-0058 rows have no segment column — the
    // migration backfills "default", so a null here can only
    // mean a row written before the migration ran.
    segment: raw.segment ?? DEFAULT_SEGMENT,
    updatedAtMs: raw.updatedAtMs,
  };
}

/** Commercial store over D1 via Drizzle. */
export class D1CommercialAdapter implements CommercialStore {
  constructor(readonly db: CommercialDb) {}

  async getAccount(userId: string): Promise<CommercialAccountRecord | null> {
    const rows = await this.db
      .select()
      .from(agentCommercialAccounts)
      .where(eq(agentCommercialAccounts.id, userId))
      .limit(1);
    return rows.length === 0 ? null : toAccount(rows[0]);
  }

  async upsertAccount(input: {
    userId: string;
    tenantId: string;
    tier: unknown;
    tierSource?: unknown;
    creditsUSD?: unknown;
    includedRuns?: unknown;
    unlimitedFreeGrant?: unknown;
    /** Issue #3289: undefined preserves the stored segment, "default" for a new row. */
    segment?: unknown;
  }): Promise<CommercialAccountRecord> {
    if (!input.userId || !input.tenantId) {
      throw new Error("userId and tenantId are required.");
    }
    // tierSource omitted = preserve the existing grant, or
    // "operator" for a new row (every pre-subscription row was
    // operator-set). Callers that change the grant pass it
    // explicitly: the operator route passes "operator", purchase
    // activation passes "subscription".
    const existing = await this.getAccount(input.userId);
    const tierSource =
      input.tierSource === "operator" || input.tierSource === "subscription"
        ? input.tierSource
        : (existing?.tierSource ?? "operator");
    // Issue #3245: a grant update is preserve (undefined) /
    // revoke (null) / grant (object), resolved by the shared
    // port helper so this adapter and the in-memory one agree.
    const unlimitedFreeGrant = resolveUnlimitedFreeGrantUpdate(
      input.unlimitedFreeGrant,
      existing?.unlimitedFreeGrant,
    );
    // Issue #3289: same preserve semantics for the segment —
    // an upsert that says nothing about the segment changes
    // nothing; a new row starts in the default segment.
    const segment =
      input.segment === undefined
        ? (existing?.segment ?? DEFAULT_SEGMENT)
        : assertSegment(input.segment);
    const record: CommercialAccountRecord = {
      id: input.userId,
      tenantId: input.tenantId,
      tier: assertStoreTier(input.tier),
      tierSource,
      creditsUSD: input.creditsUSD === undefined ? 0 : assertNonNegativeCredits(input.creditsUSD),
      includedRuns: input.includedRuns === undefined ? 0 : assertIncludedRuns(input.includedRuns),
      unlimitedFreeGrant,
      segment,
      updatedAtMs: Date.now(),
    };
    await this.db
      .insert(agentCommercialAccounts)
      .values({
        id: record.id,
        tenantId: record.tenantId,
        tier: record.tier,
        tierSource: record.tierSource ?? null,
        creditsUSD: record.creditsUSD,
        includedRuns: record.includedRuns,
        unlimitedFreeGrantedBy: record.unlimitedFreeGrant?.grantedBy ?? null,
        unlimitedFreeReason: record.unlimitedFreeGrant?.reason ?? null,
        unlimitedFreeExpiresAtMs: record.unlimitedFreeGrant?.expiresAtMs ?? null,
        segment: record.segment,
        updatedAtMs: record.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentCommercialAccounts.id,
        set: {
          tenantId: record.tenantId,
          tier: record.tier,
          tierSource: record.tierSource ?? null,
          creditsUSD: record.creditsUSD,
          includedRuns: record.includedRuns,
          unlimitedFreeGrantedBy: record.unlimitedFreeGrant?.grantedBy ?? null,
          unlimitedFreeReason: record.unlimitedFreeGrant?.reason ?? null,
          unlimitedFreeExpiresAtMs: record.unlimitedFreeGrant?.expiresAtMs ?? null,
          segment: record.segment,
          updatedAtMs: record.updatedAtMs,
        },
      });
    return record;
  }

  async setAccountSegment(userId: string, segment: string): Promise<CommercialAccountRecord> {
    const account = await this.getAccount(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    const next = assertSegment(segment);
    await this.db
      .update(agentCommercialAccounts)
      .set({ segment: next, updatedAtMs: Date.now() })
      .where(eq(agentCommercialAccounts.id, userId));
    return { ...account, segment: next, updatedAtMs: Date.now() };
  }

  async adjustCredits(userId: string, deltaUSD: number): Promise<CommercialAccountRecord> {
    const account = await this.getAccount(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    const next = round2(account.creditsUSD + deltaUSD);
    if (next < 0) throw new Error("Credits cannot go below zero.");
    await this.db
      .update(agentCommercialAccounts)
      .set({ creditsUSD: next, updatedAtMs: Date.now() })
      .where(eq(agentCommercialAccounts.id, userId));
    return { ...account, creditsUSD: next, updatedAtMs: Date.now() };
  }

  async consumeIncludedRun(userId: string): Promise<CommercialAccountRecord> {
    const account = await this.getAccount(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    if (account.includedRuns <= 0) throw new Error("No included runs remaining.");
    await this.db
      .update(agentCommercialAccounts)
      .set({ includedRuns: account.includedRuns - 1, updatedAtMs: Date.now() })
      .where(eq(agentCommercialAccounts.id, userId));
    return { ...account, includedRuns: account.includedRuns - 1, updatedAtMs: Date.now() };
  }

  async consumeCredits(userId: string, amountUSD: number): Promise<CommercialAccountRecord> {
    const account = await this.getAccount(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    const amount = round2(amountUSD);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("amountUSD must be a positive finite number.");
    }
    if (account.creditsUSD < amount) throw new Error("Insufficient credits.");
    await this.db
      .update(agentCommercialAccounts)
      .set({ creditsUSD: round2(account.creditsUSD - amount), updatedAtMs: Date.now() })
      .where(eq(agentCommercialAccounts.id, userId));
    return { ...account, creditsUSD: round2(account.creditsUSD - amount), updatedAtMs: Date.now() };
  }

  async getTenantAdsEnabled(tenantId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(agentTenantSettings)
      .where(eq(agentTenantSettings.tenantId, tenantId))
      .limit(1);
    return rows.length === 0 ? true : rows[0].adsEnabled === 1;
  }

  async setTenantAdsEnabled(tenantId: string, adsEnabled: boolean): Promise<TenantSettingsRecord> {
    const existing = await this.getTenantAutoRefresh(tenantId);
    const providers = await this.getTenantProviders(tenantId);
    const record: TenantSettingsRecord = {
      tenantId,
      adsEnabled,
      updatedAtMs: Date.now(),
      autoRefreshEnabled: existing.enabled,
      autoRefreshIntervalS: existing.intervalS,
      dataProviderId: providers.dataProviderId,
      brokerId: providers.brokerId,
    };
    await this.db
      .insert(agentTenantSettings)
      .values({
        tenantId,
        adsEnabled: adsEnabled ? 1 : 0,
        updatedAtMs: record.updatedAtMs,
        autoRefreshEnabled: record.autoRefreshEnabled ? 1 : 0,
        autoRefreshIntervalS: record.autoRefreshIntervalS,
        dataProviderId: record.dataProviderId,
        brokerId: record.brokerId,
      })
      .onConflictDoUpdate({
        target: agentTenantSettings.tenantId,
        // Only the ads half changes here; the auto-refresh half
        // is preserved because it is not in the update set.
        set: { adsEnabled: adsEnabled ? 1 : 0, updatedAtMs: record.updatedAtMs },
      });
    return record;
  }

  // Issue #2481: per-tenant auto-refresh switch. Absent row = OFF.
  // Callers ensure the schema (migration 0026) before reading,
  // as the server route does; the defaults here cover an absent
  // row and a null/zero interval, not a pre-migration table.
  async getTenantAutoRefresh(tenantId: string): Promise<TenantAutoRefresh> {
    const rows = await this.db
      .select()
      .from(agentTenantSettings)
      .where(eq(agentTenantSettings.tenantId, tenantId))
      .limit(1);
    if (rows.length === 0) return { ...DEFAULT_TENANT_AUTO_REFRESH };
    const row = rows[0] as typeof rows[0] & {
      autoRefreshEnabled?: number | null;
      autoRefreshIntervalS?: number | null;
    };
    const intervalS =
      typeof row.autoRefreshIntervalS === "number" && row.autoRefreshIntervalS > 0
        ? row.autoRefreshIntervalS
        : DEFAULT_TENANT_AUTO_REFRESH.intervalS;
    return { enabled: row.autoRefreshEnabled === 1, intervalS };
  }

  async setTenantAutoRefresh(
    tenantId: string,
    autoRefresh: TenantAutoRefresh,
  ): Promise<TenantSettingsRecord> {
    const adsEnabled = await this.getTenantAdsEnabled(tenantId);
    const providers = await this.getTenantProviders(tenantId);
    const record: TenantSettingsRecord = {
      tenantId,
      adsEnabled,
      updatedAtMs: Date.now(),
      autoRefreshEnabled: autoRefresh.enabled,
      autoRefreshIntervalS: autoRefresh.intervalS,
      dataProviderId: providers.dataProviderId,
      brokerId: providers.brokerId,
    };
    await this.db
      .insert(agentTenantSettings)
      .values({
        tenantId,
        adsEnabled: adsEnabled ? 1 : 0,
        updatedAtMs: record.updatedAtMs,
        autoRefreshEnabled: record.autoRefreshEnabled ? 1 : 0,
        autoRefreshIntervalS: record.autoRefreshIntervalS,
        dataProviderId: record.dataProviderId,
        brokerId: record.brokerId,
      })
      .onConflictDoUpdate({
        target: agentTenantSettings.tenantId,
        // Only the auto-refresh half changes here; the ads half
        // is preserved because it is not in the update set.
        set: {
          autoRefreshEnabled: record.autoRefreshEnabled ? 1 : 0,
          autoRefreshIntervalS: record.autoRefreshIntervalS,
          updatedAtMs: record.updatedAtMs,
        },
      });
    return record;
  }

  async getTenantProviders(tenantId: string): Promise<TenantProviders> {
    const rows = await this.db
      .select()
      .from(agentTenantSettings)
      .where(eq(agentTenantSettings.tenantId, tenantId))
      .limit(1);
    if (rows.length === 0) return { ...DEFAULT_TENANT_PROVIDERS };
    const row = rows[0] as typeof rows[0] & {
      dataProviderId?: string | null;
      brokerId?: string | null;
    };
    return {
      dataProviderId:
        typeof row.dataProviderId === "string" && row.dataProviderId !== ""
          ? row.dataProviderId
          : DEFAULT_TENANT_PROVIDERS.dataProviderId,
      brokerId:
        typeof row.brokerId === "string" && row.brokerId !== ""
          ? row.brokerId
          : DEFAULT_TENANT_PROVIDERS.brokerId,
    };
  }

  async getTenantBrokerSelection(tenantId: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(agentTenantSettings)
      .where(eq(agentTenantSettings.tenantId, tenantId))
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0] as typeof rows[0] & { brokerId?: string | null };
    return typeof row.brokerId === "string" && row.brokerId !== "" ? row.brokerId : null;
  }

  async setTenantProviders(
    tenantId: string,
    providers: TenantProviders,
  ): Promise<TenantSettingsRecord> {
    const adsEnabled = await this.getTenantAdsEnabled(tenantId);
    const autoRefresh = await this.getTenantAutoRefresh(tenantId);
    const record: TenantSettingsRecord = {
      tenantId,
      adsEnabled,
      updatedAtMs: Date.now(),
      autoRefreshEnabled: autoRefresh.enabled,
      autoRefreshIntervalS: autoRefresh.intervalS,
      dataProviderId: providers.dataProviderId,
      brokerId: providers.brokerId,
    };
    await this.db
      .insert(agentTenantSettings)
      .values({
        tenantId,
        adsEnabled: adsEnabled ? 1 : 0,
        updatedAtMs: record.updatedAtMs,
        autoRefreshEnabled: record.autoRefreshEnabled ? 1 : 0,
        autoRefreshIntervalS: record.autoRefreshIntervalS,
        dataProviderId: record.dataProviderId,
        brokerId: record.brokerId,
      })
      .onConflictDoUpdate({
        target: agentTenantSettings.tenantId,
        set: {
          dataProviderId: record.dataProviderId,
          brokerId: record.brokerId,
          updatedAtMs: record.updatedAtMs,
        },
      });
    return record;
  }

  async recordCreditClaim(claim: {
    creditRunId: string;
    userId: string;
    family: string;
    amountUSD: number;
    productId?: string | null;
    versionId?: string | null;
    priceUSD?: number | null;
  }): Promise<CreditClaimRecord> {
    const record: CreditClaimRecord = {
      creditRunId: claim.creditRunId,
      userId: claim.userId,
      family: claim.family,
      amountUSD: round2(claim.amountUSD),
      // Issue #3289: which charge the credit replaces (§3.9).
      productId: claim.productId ?? null,
      versionId: claim.versionId ?? null,
      priceUSD: claim.priceUSD ?? null,
      createdAtMs: Date.now(),
    };
    // INSERT OR IGNORE: re-recording the same claim is a no-op.
    await this.db
      .insert(agentCreditClaims)
      .values({
        creditRunId: record.creditRunId,
        userId: record.userId,
        family: record.family,
        amountUSD: record.amountUSD,
        productId: record.productId,
        versionId: record.versionId,
        priceUSD: record.priceUSD,
        createdAtMs: record.createdAtMs,
      })
      .onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(agentCreditClaims)
      .where(eq(agentCreditClaims.creditRunId, record.creditRunId))
      .limit(1);
    return {
      creditRunId: rows[0].creditRunId,
      userId: rows[0].userId,
      family: rows[0].family,
      amountUSD: rows[0].amountUSD,
      productId: rows[0].productId ?? null,
      versionId: rows[0].versionId ?? null,
      priceUSD: rows[0].priceUSD ?? null,
      createdAtMs: rows[0].createdAtMs,
    };
  }

  async findUnredeemedCredit(
    userId: string,
    family: string,
  ): Promise<{
    creditRunId: string;
    amountUSD: number;
    productId?: string | null;
    versionId?: string | null;
    priceUSD?: number | null;
  } | null> {
    const rows = await this.db
      .select({
        creditRunId: agentCreditClaims.creditRunId,
        amountUSD: agentCreditClaims.amountUSD,
        productId: agentCreditClaims.productId,
        versionId: agentCreditClaims.versionId,
        priceUSD: agentCreditClaims.priceUSD,
      })
      .from(agentCreditClaims)
      .leftJoin(
        agentCreditRedemptions,
        eq(agentCreditRedemptions.creditRunId, agentCreditClaims.creditRunId),
      )
      .where(
        and(
          eq(agentCreditClaims.userId, userId),
          eq(agentCreditClaims.family, family),
          isNull(agentCreditRedemptions.creditRunId),
        ),
      )
      .orderBy(asc(agentCreditClaims.createdAtMs), asc(agentCreditClaims.creditRunId))
      .limit(1);
    return rows.length === 0
      ? null
      : {
          creditRunId: rows[0].creditRunId,
          amountUSD: rows[0].amountUSD,
          productId: rows[0].productId ?? null,
          versionId: rows[0].versionId ?? null,
          priceUSD: rows[0].priceUSD ?? null,
        };
  }

  async recordPaidSubmission(input: {
    workflowId: string;
    userId: string;
    runRequestId: string;
  }): Promise<PaidSubmissionRecord> {
    if (!input.workflowId || !input.userId || !input.runRequestId) {
      throw new Error("workflowId, userId, and runRequestId are required.");
    }
    const record: PaidSubmissionRecord = {
      workflowId: input.workflowId,
      userId: input.userId,
      runRequestId: input.runRequestId,
      createdAtMs: Date.now(),
    };
    // INSERT OR IGNORE: the first record wins, so a re-record
    // can never steal ownership from the original submitter.
    await this.db
      .insert(agentPaidSubmissions)
      .values({
        workflowId: record.workflowId,
        userId: record.userId,
        runRequestId: record.runRequestId,
        createdAtMs: record.createdAtMs,
      })
      .onConflictDoNothing();
    const rows = await this.db
      .select()
      .from(agentPaidSubmissions)
      .where(eq(agentPaidSubmissions.workflowId, record.workflowId))
      .limit(1);
    return {
      workflowId: rows[0].workflowId,
      userId: rows[0].userId,
      runRequestId: rows[0].runRequestId,
      createdAtMs: rows[0].createdAtMs,
    };
  }

  async getPaidSubmission(workflowId: string): Promise<PaidSubmissionRecord | null> {
    const rows = await this.db
      .select()
      .from(agentPaidSubmissions)
      .where(eq(agentPaidSubmissions.workflowId, workflowId))
      .limit(1);
    if (rows.length === 0) return null;
    return {
      workflowId: rows[0].workflowId,
      userId: rows[0].userId,
      runRequestId: rows[0].runRequestId,
      createdAtMs: rows[0].createdAtMs,
    };
  }

  async redeemCredit(creditRunId: string, redeemedByRunId: string): Promise<CreditRedemptionRecord> {
    const record: CreditRedemptionRecord = {
      creditRunId,
      redeemedByRunId,
      redeemedAtMs: Date.now(),
    };
    try {
      await this.db.insert(agentCreditRedemptions).values({
        creditRunId: record.creditRunId,
        redeemedByRunId: record.redeemedByRunId,
        redeemedAtMs: record.redeemedAtMs,
      });
    } catch {
      // A PK violation means the credit was already claimed — by a
      // concurrent submission or a replay. Re-check before reporting.
      const existing = await this.db
        .select()
        .from(agentCreditRedemptions)
        .where(eq(agentCreditRedemptions.creditRunId, creditRunId))
        .limit(1);
      if (existing.length > 0) throw new Error(`Credit ${creditRunId} already redeemed.`);
      throw new Error(`Failed to redeem credit ${creditRunId}.`);
    }
    return record;
  }
}
