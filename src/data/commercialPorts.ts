/**
 * Issues #2015/#2020/#2022 — commercial store port.
 *
 * The store is the D1 half of the money path: accounts, tenant
 * settings, credit claims, and redemptions. The DO ledger
 * (mas_transactions) stays the financial audit record; this store
 * holds the operational state the payment path reads and writes
 * (coverage balances, the ads flag, redeemable claims).
 *
 * Tenancy is enforced here, not by callers: accounts carry the
 * tenant, and every read is scoped by userId, so credits,
 * subscriptions, and claims never cross tenants. Since #2219 the
 * paid routes derive the run tenant from the stored record for
 * the verified login (platform identity) and ignore any
 * client-supplied tenantId, even on mismatch — resolved identity
 * wins, so there is no mismatch refusal anymore; the port returns
 * the record and the caller uses its tenant.
 *
 * Money rules shared by both adapters (Drizzle + in-memory) live
 * in the pure helpers below so the two implementations cannot
 * drift: tier validation, credit rounding and floors, and the
 * failure messages the endpoints map to status codes.
 */
import type { CommercialAccount } from "../services/cfpayMonetization";

export type StoreTier = "Free" | "PayPerUse" | "Subscribed";

export const VALID_TIERS: readonly StoreTier[] = ["Free", "PayPerUse", "Subscribed"];

/**
 * Who granted a stored Subscribed tier. "operator" = a store
 * operator set it (survives a lapsed subscription); "subscription"
 * = a purchase set it (confers nothing once every subscription
 * row has expired — see resolveEffectiveTier). NULL on
 * pre-0008 rows reads as "operator".
 */
export type TierSource = "operator" | "subscription";

/**
 * Issue #3245 (slice 1 of #3241) — unlimited-free grant for an
 * approved account. An operator-granted, account-level entitlement:
 * a granted account runs any screener family, manual or scheduled
 * (including recurring), free and unlimited, at price 0, with no
 * checkout and no credit/included-run deduction. The grant is
 * stored on the commercial account row (migration 0040) so the
 * gate reads it from the same record as tier/credits. `expiresAtMs`
 * null = no expiry; a grant whose expiry has passed lapses to the
 * normal gate. `grantedBy` is the session-verified operator login
 * that wrote it (the route sets it, never the client).
 */
export interface UnlimitedFreeGrant {
  grantedBy: string;
  reason: string;
  expiresAtMs: number | null;
}

/** A grant is live only while it exists and its expiry (if any) is in the future. */
export function isUnlimitedFreeGrantActive(
  grant: UnlimitedFreeGrant | null | undefined,
  nowMs: number,
): boolean {
  if (!grant) return false;
  return grant.expiresAtMs === null || grant.expiresAtMs > nowMs;
}

/**
 * Validate a grant object. The route passes the session-verified
 * operator login as grantedBy; a missing/blank grantedBy or reason,
 * or a non-null expiry that is not a finite positive epoch-ms,
 * throws (the route maps it to 400). Null is never valid here —
 * null means "revoke", handled by the upsert, not by this helper.
 */
export function assertUnlimitedFreeGrant(value: unknown): UnlimitedFreeGrant {
  if (typeof value !== "object" || value === null) {
    throw new Error("Unlimited-free grant must be an object with grantedBy, reason, and expiresAtMs.");
  }
  const grant = value as Record<string, unknown>;
  const grantedBy = typeof grant.grantedBy === "string" ? grant.grantedBy.trim() : "";
  if (!grantedBy) {
    throw new Error("Unlimited-free grant grantedBy must be a non-empty string.");
  }
  const reason = typeof grant.reason === "string" ? grant.reason.trim() : "";
  if (!reason) {
    throw new Error("Unlimited-free grant reason must be a non-empty string.");
  }
  const expiresAtMs = grant.expiresAtMs;
  if (
    expiresAtMs !== null &&
    (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0)
  ) {
    throw new Error("Unlimited-free grant expiresAtMs must be null or a finite positive epoch-ms.");
  }
  return { grantedBy, reason, expiresAtMs: expiresAtMs as number | null };
}

/**
 * Resolve a grant update for an upsert. `undefined` preserves the
 * stored grant (an upsert that says nothing about the grant changes
 * nothing); explicit `null` revokes it; an object grants it.
 * Anything else throws. The adapters share this so the two
 * implementations cannot drift on preserve-vs-revoke semantics.
 */
export function resolveUnlimitedFreeGrantUpdate(
  input: unknown,
  existing: UnlimitedFreeGrant | null | undefined,
): UnlimitedFreeGrant | null {
  if (input === undefined) return existing ?? null;
  if (input === null) return null;
  return assertUnlimitedFreeGrant(input);
}

export interface CommercialAccountRecord {
  id: string;
  tenantId: string;
  tier: StoreTier;
  tierSource?: TierSource | null;
  creditsUSD: number;
  includedRuns: number;
  /** Issue #3245: operator-granted unlimited-free entitlement (null = none). */
  unlimitedFreeGrant?: UnlimitedFreeGrant | null;
  updatedAtMs: number;
}

export interface TenantSettingsRecord {
  tenantId: string;
  adsEnabled: boolean;
  updatedAtMs: number;
  /**
   * Issue #2481: per-tenant auto-refresh switch. Absent row = OFF.
   * Defaults are applied by the adapters, not by callers.
   */
  autoRefreshEnabled: boolean;
  /** Issue #2481: auto-refresh cadence in seconds. Absent row = 15. */
  autoRefreshIntervalS: number;
  /** Per-tenant data-provider selection. Absent row = etrade. */
  dataProviderId: string;
  /** Per-tenant broker selection. Absent row = etrade. */
  brokerId: string;
}

/** Issue #2481: the auto-refresh half of a tenant settings row. */
export interface TenantAutoRefresh {
  enabled: boolean;
  intervalS: number;
}

/** Issue #2481: defaults for a tenant with no settings row. */
export const DEFAULT_TENANT_AUTO_REFRESH: TenantAutoRefresh = {
  enabled: false,
  intervalS: 15,
};

/** Per-tenant data-provider / broker selections. */
export interface TenantProviders {
  dataProviderId: string;
  brokerId: string;
}

/**
 * Defaults for a tenant with no settings row. Issue #3812 (owner rule on
 * #3451): the platform's default BROKER is Alpaca, in paper mode. The
 * data provider stays etrade, preserving the pre-existing behaviour for
 * every data read; the trading default is now the copilot's broker, so
 * the settings menu, the manual routes, and the copilot resolver agree.
 * Paper is not stored here: it is the mode default (TEST) applied by the
 * trade-environment resolver, so live remains an explicit act.
 */
export const DEFAULT_TENANT_PROVIDERS: TenantProviders = {
  dataProviderId: "etrade",
  brokerId: "alpaca",
};

export interface CreditClaimRecord {
  creditRunId: string;
  userId: string;
  family: string;
  amountUSD: number;
  createdAtMs: number;
}

export interface CreditRedemptionRecord {
  creditRunId: string;
  redeemedByRunId: string;
  redeemedAtMs: number;
}

/**
 * Issue #2137 (checkout follow-ups): who submitted a paid run.
 * Recorded by the submit route at submission time, from the
 * verified session login — never from a caller claim — so the
 * submission-status read can enforce ownership instead of
 * trusting that a workflowId is unguessable. One row per
 * submission; workflowId is the primary key because the status
 * read is keyed by it. For the payment path the workflowId is
 * the runRequestId (the binding creates the instance with
 * id = runRequestId); for a credit-redeemed run it is the
 * screener workflow id the submit route returns.
 */
export interface PaidSubmissionRecord {
  workflowId: string;
  userId: string;
  runRequestId: string;
  createdAtMs: number;
}

export function assertStoreTier(tier: unknown): StoreTier {
  if (tier !== "Free" && tier !== "PayPerUse" && tier !== "Subscribed") {
    throw new Error(`Invalid tier: ${String(tier)} (must be Free, PayPerUse, or Subscribed).`);
  }
  return tier;
}

/** Money is stored to the cent; anything finer is a caller bug, not a rounding policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function assertNonNegativeCredits(creditsUSD: unknown): number {
  const value = Number(creditsUSD);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("creditsUSD must be a finite non-negative number.");
  }
  return round2(value);
}

export function assertIncludedRuns(includedRuns: unknown): number {
  const value = Number(includedRuns);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("includedRuns must be a finite non-negative integer.");
  }
  return Math.floor(value);
}

/**
 * Map a store record to the payment gate's account shape. A missing
 * record is a Free account with no balance — Free is implicit
 * (#1076), never a stored row the caller must create first.
 */
export function toCommercialAccount(
  userId: string,
  record: CommercialAccountRecord | null,
  email: string,
  fallbackTenantId: string,
): CommercialAccount {
  if (!record) {
    return {
      userId,
      email,
      tenantId: fallbackTenantId,
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    };
  }
  return {
    userId,
    email,
    tenantId: record.tenantId,
    tier: record.tier,
    creditsUSD: record.creditsUSD,
    includedRunsRemaining: record.includedRuns,
    // Issue #3245: the grant rides on the resolved account so the
    // gate sees it without a second store read. The gate, not this
    // mapping, decides whether it is live at run time (expiry).
    unlimitedFreeGrant: record.unlimitedFreeGrant ?? null,
  };
}

export interface CommercialStore {
  getAccount(userId: string): Promise<CommercialAccountRecord | null>;
  upsertAccount(input: {
    userId: string;
    tenantId: string;
    tier: unknown;
    tierSource?: unknown;
    creditsUSD?: unknown;
    includedRuns?: unknown;
    /**
     * Issue #3245: undefined preserves the stored grant, null
     * revokes it, an object grants it (see
     * resolveUnlimitedFreeGrantUpdate).
     */
    unlimitedFreeGrant?: unknown;
  }): Promise<CommercialAccountRecord>;
  adjustCredits(userId: string, deltaUSD: number): Promise<CommercialAccountRecord>;
  consumeIncludedRun(userId: string): Promise<CommercialAccountRecord>;
  consumeCredits(userId: string, amountUSD: number): Promise<CommercialAccountRecord>;
  getTenantAdsEnabled(tenantId: string): Promise<boolean>;
  setTenantAdsEnabled(tenantId: string, adsEnabled: boolean): Promise<TenantSettingsRecord>;
  /** Issue #2481: per-tenant auto-refresh switch (absent row = OFF). */
  getTenantAutoRefresh(tenantId: string): Promise<TenantAutoRefresh>;
  setTenantAutoRefresh(
    tenantId: string,
    autoRefresh: TenantAutoRefresh,
  ): Promise<TenantSettingsRecord>;
  getTenantProviders(tenantId: string): Promise<TenantProviders>;
  /**
   * The tenant's STORED broker selection, or null when no broker
   * selection is stored (no settings row, or a row whose brokerId
   * is empty). Unlike getTenantProviders this applies NO default:
   * the absent-row default is a getTenantProviders behavior
   * for its existing consumers, and callers whose absent-selection
   * default differs (the Stock Copilot, #3451: no selection ⇒
   * alpaca) must be able to tell "no selection stored" apart from
   * an explicitly stored etrade selection.
   */
  getTenantBrokerSelection(tenantId: string): Promise<string | null>;
  setTenantProviders(
    tenantId: string,
    providers: TenantProviders,
  ): Promise<TenantSettingsRecord>;
  /** Idempotent: re-recording the same claim is a no-op (the DO ledger row is the audit). */
  recordCreditClaim(claim: {
    creditRunId: string;
    userId: string;
    family: string;
    amountUSD: number;
  }): Promise<CreditClaimRecord>;
  /** Oldest unredeemed claim for the family, FIFO by creation. */
  findUnredeemedCredit(userId: string, family: string): Promise<{ creditRunId: string; amountUSD: number } | null>;
  /** The atomic claim: throws /already redeemed/ on replay. */
  redeemCredit(creditRunId: string, redeemedByRunId: string): Promise<CreditRedemptionRecord>;
  /**
   * Record who submitted a paid run. Idempotent on workflowId:
   * the FIRST record wins, so a re-record (retry, replay) can
   * never steal ownership from the original submitter.
   */
  recordPaidSubmission(input: {
    workflowId: string;
    userId: string;
    runRequestId: string;
  }): Promise<PaidSubmissionRecord>;
  /** The submission that owns this workflowId, or null when unknown. */
  getPaidSubmission(workflowId: string): Promise<PaidSubmissionRecord | null>;
}
