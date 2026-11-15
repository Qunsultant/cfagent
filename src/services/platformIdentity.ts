/**
 * Issue #2219 (program #2218, slice 1) — platform identity resolution
 * for the payment workflow screen.
 *
 * The payment screen's tenant / user / account are AUTOMATIC and
 * READ-ONLY: the server resolves them from the verified session
 * login, and the UI only displays what this module returns. A
 * client-supplied tenantId is untrusted input, never identity, so
 * no caller in this slice reads one — the paid-submission and
 * subscription checkout/purchase routes derive the tenant from
 * the resolved identity below and ignore any client-supplied
 * value, even on mismatch (resolved identity wins).
 *
 * Port-first (ADR 0002): this module depends only on port
 * interfaces (CommercialStore, SubscriptionStore) and on the
 * pure helpers in the data layer. It never imports a store
 * client, references env.AGENT_DB, or writes SQL. Callers build
 * the ports from the composition roots (createCommercialAdapter,
 * createSubscriptionAdapter — null when unbound) and pass them
 * in. No parallel account store exists: the commercial and
 * subscription ports ARE the platform identity source in this
 * slice; later platform slices may add a dedicated identity port
 * behind this same shape.
 *
 * No-account behavior (PROPOSED, owner may correct — see the PR
 * body): a missing store row is not an error for the DISPLAY
 * read (hasAccount false, tenantId null, tier Free, zero
 * balances — Free is implicit, #1076). On a PAID path the caller
 * must fail closed with NO_ACCOUNT_PAID_MESSAGE, directing the
 * user to account setup (a platform surface to come) — never
 * invent an account or tenant, never fall back to a text field.
 * On the FREE path (monetization flag OFF) the caller proceeds
 * exactly as today; the flag-OFF fallback scope is the caller's
 * decision, not this module's (see the submit route).
 */
import {
  type CommercialAccountRecord,
  type CommercialStore,
  type StoreTier,
} from "../data/commercialPorts";
import {
  resolveEffectiveTier,
  type SubscriptionStore,
} from "../data/subscriptionPorts";

/** Paid-path failure message for a user with no resolved account. */
export const NO_ACCOUNT_PAID_MESSAGE =
  "No commercial account is set up for your signed-in account yet. " +
  "Set up an account through platform management (coming) or ask an operator " +
  "to create one, then try again. No charge was made.";

/**
 * Issue #4602 — reserved prefix distinguishing personal login-as-tenant ids
 * (when a verified login has no commercial account row) from real tenant ids.
 * Real tenant creation rejects this prefix so a login string can never collide
 * with a real tenant id.
 */
export const LOGIN_TENANT_PREFIX = "login:" as const;

/** Format a verified login as a namespaced personal login-as-tenant id (#4602). */
export function toLoginTenantId(login: string): string {
  const trimmed = login.trim();
  return trimmed.startsWith(LOGIN_TENANT_PREFIX)
    ? trimmed
    : `${LOGIN_TENANT_PREFIX}${trimmed}`;
}

/** True when a tenant id uses the reserved personal login-as-tenant prefix (#4602). */
export function isLoginTenantId(tenantId: string | null | undefined): boolean {
  return typeof tenantId === "string" && tenantId.startsWith(LOGIN_TENANT_PREFIX);
}

/**
 * Resolve the effective tenant id when a route falls back to personal login scope
 * (`identity.tenantId` when an account exists, else `toLoginTenantId(login)`).
 */
export function resolveEffectiveTenantId(
  identityTenantId: string | null | undefined,
  login: string,
): string {
  if (typeof identityTenantId === "string" && identityTenantId.trim().length > 0) {
    return identityTenantId.trim();
  }
  return toLoginTenantId(login);
}

/** Port inputs for identity resolution (adapters satisfy these structurally). */
export interface PlatformIdentityPorts {
  commercial: CommercialStore | null;
  subscriptions: SubscriptionStore | null;
}

/**
 * Issue #4600 — canonical authority source for a login's resolved "current tenant"
 * across the three tenant authorities (commercial account row, IAAA memberships,
 * and env default). The env default is NEVER a silent fallback here: when neither
 * an account row nor an active tenant membership exists, the source is `"unresolved"`.
 */
export type CurrentTenantAuthoritySource = "account" | "membership" | "unresolved";

/** Minimal membership shape required by `resolveCurrentTenant` (#4600). */
export interface CurrentTenantMembershipInput {
  membershipId: string;
  tenantId: string;
  createdAtMs: number;
  revokedAtMs?: number;
}

/** Recorded result of resolving a login's current tenant (#4600). */
export interface CurrentTenantResolution {
  /** Resolved current tenant id, or null when unresolved (never env default). */
  currentTenantId: string | null;
  /** Which authority won (`"account"` > `"membership"` > `"unresolved"`). */
  currentTenantSource: CurrentTenantAuthoritySource;
  /** Distinct active (unrevoked) tenant-scoped membership tenantIds in deterministic order. */
  candidateMembershipTenants: string[];
}

/**
 * Issue #4600 — resolve a login's single "current tenant" across the platform's
 * tenant authorities and record which authority won:
 *
 * 1. **Commercial account tenant (`"account"`)**: if the login has a stored
 *    commercial account row (`accountTenantId` non-empty), that single billing
 *    tenant wins unconditionally, even when the login holds multiple IAAA
 *    memberships.
 * 2. **Active IAAA tenant membership (`"membership"`)**: if no commercial
 *    account row exists, active (unrevoked: `revokedAtMs === undefined`)
 *    tenant-scoped memberships (`tenantId` non-empty and `!== "platform"`) are
 *    ordered deterministically by `(createdAtMs ASC, tenantId ASC, membershipId ASC)`
 *    and the first membership's `tenantId` is selected.
 * 3. **Unresolved (`"unresolved"`, `currentTenantId: null`)**: when neither an
 *    account row nor an active tenant membership exists. No path silently falls
 *    back to the deployment env default (`IAAA_TENANT_ID` / `"primary"`).
 */
export function resolveCurrentTenant(input: {
  accountTenantId?: string | null;
  memberships?: ReadonlyArray<CurrentTenantMembershipInput> | null;
}): CurrentTenantResolution {
  const activeMemberships = (input.memberships ?? [])
    .filter(
      (m) =>
        m.revokedAtMs === undefined &&
        typeof m.tenantId === "string" &&
        m.tenantId.trim().length > 0 &&
        m.tenantId.trim() !== "platform",
    )
    .slice()
    .sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      const tCmp = a.tenantId.trim().localeCompare(b.tenantId.trim());
      if (tCmp !== 0) return tCmp;
      return a.membershipId.localeCompare(b.membershipId);
    });

  const candidateMembershipTenants: string[] = [];
  for (const m of activeMemberships) {
    const tid = m.tenantId.trim();
    if (!candidateMembershipTenants.includes(tid)) {
      candidateMembershipTenants.push(tid);
    }
  }

  const trimmedAccountTenant =
    typeof input.accountTenantId === "string" && input.accountTenantId.trim().length > 0
      ? input.accountTenantId.trim()
      : null;

  if (trimmedAccountTenant !== null) {
    return {
      currentTenantId: trimmedAccountTenant,
      currentTenantSource: "account",
      candidateMembershipTenants,
    };
  }

  if (candidateMembershipTenants.length > 0) {
    return {
      currentTenantId: candidateMembershipTenants[0],
      currentTenantSource: "membership",
      candidateMembershipTenants,
    };
  }

  return {
    currentTenantId: null,
    currentTenantSource: "unresolved",
    candidateMembershipTenants: [],
  };
}

/** The resolved platform identity for one verified login. */
export interface PlatformIdentity {
  userLogin: string;
  /** Null when no store row exists — never a guessed value. */
  tenantId: string | null;
  /** Issue #4600: single resolved current tenant across account + active memberships (never env default). */
  currentTenantId: string | null;
  /** Issue #4600: recorded authority that supplied `currentTenantId`. */
  currentTenantSource: CurrentTenantAuthoritySource;
  /** Issue #4600: deterministic list of active membership tenantIds for multi-membership logins. */
  candidateMembershipTenants: string[];
  hasAccount: boolean;
  /** Effective tier at read time (a lapsed subscription stops conferring Subscribed). */
  tier: StoreTier;
  creditsUSD: number;
  includedRunsRemaining: number;
  /** The stored row, when one exists, for callers that build an account view from it. */
  stored: CommercialAccountRecord | null;
}

/**
 * Resolve the platform identity for a verified login.
 *
 * Fail-closed throughout: an unbound store throws (no identity
 * can be verified), and a subscription-read failure throws (no
 * tier can be verified). A missing store row is NOT a failure —
 * it resolves to hasAccount false with a null tenant; whether a
 * caller may proceed without an account is the caller's path
 * decision (paid fails closed, free proceeds), never this
 * module's.
 */
export async function resolvePlatformIdentity(
  ports: PlatformIdentityPorts,
  input: {
    userId: string;
    nowMs: number;
    memberships?: ReadonlyArray<CurrentTenantMembershipInput> | null;
  },
): Promise<PlatformIdentity> {
  if (!ports.commercial || !ports.subscriptions) {
    throw new Error(
      "Commercial account store is unavailable; refusing to resolve platform identity without verified account data.",
    );
  }
  const stored = await ports.commercial.getAccount(input.userId);
  let subscriptions: Array<{ periodEndMs: number }>;
  try {
    subscriptions = await ports.subscriptions.listSubscriptions(input.userId);
  } catch (err) {
    throw new Error(
      `Subscription state unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const tier = resolveEffectiveTier(stored, subscriptions, input.nowMs);
  const accountTenantId = stored ? stored.tenantId : null;
  const currentTenant = resolveCurrentTenant({
    accountTenantId,
    memberships: input.memberships,
  });
  return {
    userLogin: input.userId,
    tenantId: accountTenantId,
    currentTenantId: currentTenant.currentTenantId,
    currentTenantSource: currentTenant.currentTenantSource,
    candidateMembershipTenants: currentTenant.candidateMembershipTenants,
    hasAccount: stored !== null,
    tier,
    creditsUSD: stored ? stored.creditsUSD : 0,
    includedRunsRemaining: stored ? stored.includedRuns : 0,
    stored,
  };
}

/** The identity shape the self-only read endpoint returns (no stored row leaks). */
export function toPlatformIdentityView(identity: PlatformIdentity): {
  userLogin: string;
  tenantId: string | null;
  currentTenantId: string | null;
  currentTenantSource: CurrentTenantAuthoritySource;
  hasAccount: boolean;
  tier: StoreTier;
  creditsUSD: number;
  includedRunsRemaining: number;
} {
  return {
    userLogin: identity.userLogin,
    tenantId: identity.tenantId,
    currentTenantId: identity.currentTenantId,
    currentTenantSource: identity.currentTenantSource,
    hasAccount: identity.hasAccount,
    tier: identity.tier,
    creditsUSD: identity.creditsUSD,
    includedRunsRemaining: identity.includedRunsRemaining,
  };
}
