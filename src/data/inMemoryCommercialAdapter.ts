/**
 * Issues #2015/#2020/#2022 — in-memory commercial store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store at
 * all, and so route tests can run without a D1 binding. No
 * migration concept applies here (there is no SQL to migrate).
 */
import {
  assertIncludedRuns,
  assertNonNegativeCredits,
  assertStoreTier,
  DEFAULT_TENANT_AUTO_REFRESH,
  DEFAULT_TENANT_PROVIDERS,
  round2,
  type CommercialAccountRecord,
  type CommercialStore,
  type CreditClaimRecord,
  type CreditRedemptionRecord,
  type PaidSubmissionRecord,
  type TenantAutoRefresh,
  type TenantSettingsRecord,
  type TenantProviders,
} from "./commercialPorts";

export class InMemoryCommercialAdapter implements CommercialStore {
  private accounts = new Map<string, CommercialAccountRecord>();
  private tenantSettings = new Map<string, TenantSettingsRecord>();
  private claims = new Map<string, CreditClaimRecord>();
  private redemptions = new Map<string, CreditRedemptionRecord>();
  private submissions = new Map<string, PaidSubmissionRecord>();

  async getAccount(userId: string): Promise<CommercialAccountRecord | null> {
    return this.accounts.get(userId) ?? null;
  }

  async upsertAccount(input: {
    userId: string;
    tenantId: string;
    tier: unknown;
    tierSource?: unknown;
    creditsUSD?: unknown;
    includedRuns?: unknown;
  }): Promise<CommercialAccountRecord> {
    if (!input.userId || !input.tenantId) {
      throw new Error("userId and tenantId are required.");
    }
    const existing = this.accounts.get(input.userId);
    const tierSource =
      input.tierSource === "operator" || input.tierSource === "subscription"
        ? input.tierSource
        : (existing?.tierSource ?? "operator");
    const record: CommercialAccountRecord = {
      id: input.userId,
      tenantId: input.tenantId,
      tier: assertStoreTier(input.tier),
      tierSource,
      creditsUSD: input.creditsUSD === undefined ? 0 : assertNonNegativeCredits(input.creditsUSD),
      includedRuns: input.includedRuns === undefined ? 0 : assertIncludedRuns(input.includedRuns),
      updatedAtMs: Date.now(),
    };
    this.accounts.set(record.id, record);
    return record;
  }

  async adjustCredits(userId: string, deltaUSD: number): Promise<CommercialAccountRecord> {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    const next = round2(account.creditsUSD + deltaUSD);
    if (next < 0) throw new Error("Credits cannot go below zero.");
    const updated = { ...account, creditsUSD: next, updatedAtMs: Date.now() };
    this.accounts.set(userId, updated);
    return updated;
  }

  async consumeIncludedRun(userId: string): Promise<CommercialAccountRecord> {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    if (account.includedRuns <= 0) throw new Error("No included runs remaining.");
    const updated = { ...account, includedRuns: account.includedRuns - 1, updatedAtMs: Date.now() };
    this.accounts.set(userId, updated);
    return updated;
  }

  async consumeCredits(userId: string, amountUSD: number): Promise<CommercialAccountRecord> {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`No commercial account for user ${userId}.`);
    const amount = round2(amountUSD);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("amountUSD must be a positive finite number.");
    }
    if (account.creditsUSD < amount) throw new Error("Insufficient credits.");
    const updated = { ...account, creditsUSD: round2(account.creditsUSD - amount), updatedAtMs: Date.now() };
    this.accounts.set(userId, updated);
    return updated;
  }

  async getTenantAdsEnabled(tenantId: string): Promise<boolean> {
    return this.tenantSettings.get(tenantId)?.adsEnabled ?? true;
  }

  async setTenantAdsEnabled(tenantId: string, adsEnabled: boolean): Promise<TenantSettingsRecord> {
    const existing = this.tenantSettings.get(tenantId);
    const record: TenantSettingsRecord = {
      tenantId,
      adsEnabled,
      updatedAtMs: Date.now(),
      autoRefreshEnabled: existing?.autoRefreshEnabled ?? DEFAULT_TENANT_AUTO_REFRESH.enabled,
      autoRefreshIntervalS: existing?.autoRefreshIntervalS ?? DEFAULT_TENANT_AUTO_REFRESH.intervalS,
      dataProviderId: existing?.dataProviderId ?? DEFAULT_TENANT_PROVIDERS.dataProviderId,
      brokerId: existing?.brokerId ?? DEFAULT_TENANT_PROVIDERS.brokerId,
    };
    this.tenantSettings.set(tenantId, record);
    return record;
  }

  // Issue #2481: per-tenant auto-refresh switch; the ads flag on
  // the shared row is preserved, mirroring setTenantAdsEnabled.
  async getTenantAutoRefresh(tenantId: string): Promise<TenantAutoRefresh> {
    const existing = this.tenantSettings.get(tenantId);
    return {
      enabled: existing?.autoRefreshEnabled ?? DEFAULT_TENANT_AUTO_REFRESH.enabled,
      intervalS: existing?.autoRefreshIntervalS ?? DEFAULT_TENANT_AUTO_REFRESH.intervalS,
    };
  }

  async setTenantAutoRefresh(
    tenantId: string,
    autoRefresh: TenantAutoRefresh,
  ): Promise<TenantSettingsRecord> {
    const existing = this.tenantSettings.get(tenantId);
    const record: TenantSettingsRecord = {
      tenantId,
      adsEnabled: existing?.adsEnabled ?? true,
      updatedAtMs: Date.now(),
      autoRefreshEnabled: autoRefresh.enabled,
      autoRefreshIntervalS: autoRefresh.intervalS,
      dataProviderId: existing?.dataProviderId ?? DEFAULT_TENANT_PROVIDERS.dataProviderId,
      brokerId: existing?.brokerId ?? DEFAULT_TENANT_PROVIDERS.brokerId,
    };
    this.tenantSettings.set(tenantId, record);
    return record;
  }

  async getTenantProviders(tenantId: string): Promise<TenantProviders> {
    const existing = this.tenantSettings.get(tenantId);
    return {
      dataProviderId: existing?.dataProviderId ?? DEFAULT_TENANT_PROVIDERS.dataProviderId,
      brokerId: existing?.brokerId ?? DEFAULT_TENANT_PROVIDERS.brokerId,
    };
  }

  async setTenantProviders(
    tenantId: string,
    providers: TenantProviders,
  ): Promise<TenantSettingsRecord> {
    const existing = this.tenantSettings.get(tenantId);
    const record: TenantSettingsRecord = {
      tenantId,
      adsEnabled: existing?.adsEnabled ?? true,
      updatedAtMs: Date.now(),
      autoRefreshEnabled: existing?.autoRefreshEnabled ?? DEFAULT_TENANT_AUTO_REFRESH.enabled,
      autoRefreshIntervalS: existing?.autoRefreshIntervalS ?? DEFAULT_TENANT_AUTO_REFRESH.intervalS,
      dataProviderId: providers.dataProviderId,
      brokerId: providers.brokerId,
    };
    this.tenantSettings.set(tenantId, record);
    return record;
  }

  async recordCreditClaim(claim: {
    creditRunId: string;
    userId: string;
    family: string;
    amountUSD: number;
  }): Promise<CreditClaimRecord> {
    const existing = this.claims.get(claim.creditRunId);
    if (existing) return existing;
    const record: CreditClaimRecord = {
      creditRunId: claim.creditRunId,
      userId: claim.userId,
      family: claim.family,
      amountUSD: round2(claim.amountUSD),
      createdAtMs: Date.now(),
    };
    this.claims.set(record.creditRunId, record);
    return record;
  }

  async findUnredeemedCredit(
    userId: string,
    family: string,
  ): Promise<{ creditRunId: string; amountUSD: number } | null> {
    const matches = [...this.claims.values()]
      .filter((c) => c.userId === userId && c.family === family && !this.redemptions.has(c.creditRunId))
      .sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
        return a.creditRunId < b.creditRunId ? -1 : a.creditRunId > b.creditRunId ? 1 : 0;
      });
    return matches.length === 0
      ? null
      : { creditRunId: matches[0].creditRunId, amountUSD: matches[0].amountUSD };
  }

  async recordPaidSubmission(input: {
    workflowId: string;
    userId: string;
    runRequestId: string;
  }): Promise<PaidSubmissionRecord> {
    if (!input.workflowId || !input.userId || !input.runRequestId) {
      throw new Error("workflowId, userId, and runRequestId are required.");
    }
    const existing = this.submissions.get(input.workflowId);
    if (existing) return existing;
    const record: PaidSubmissionRecord = {
      workflowId: input.workflowId,
      userId: input.userId,
      runRequestId: input.runRequestId,
      createdAtMs: Date.now(),
    };
    this.submissions.set(record.workflowId, record);
    return record;
  }

  async getPaidSubmission(workflowId: string): Promise<PaidSubmissionRecord | null> {
    return this.submissions.get(workflowId) ?? null;
  }

  async redeemCredit(creditRunId: string, redeemedByRunId: string): Promise<CreditRedemptionRecord> {
    if (this.redemptions.has(creditRunId)) {
      throw new Error(`Credit ${creditRunId} already redeemed.`);
    }
    const record: CreditRedemptionRecord = {
      creditRunId,
      redeemedByRunId,
      redeemedAtMs: Date.now(),
    };
    this.redemptions.set(creditRunId, record);
    return record;
  }
}
