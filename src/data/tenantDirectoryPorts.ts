/**
 * Issue #2221 (program #2218, slice 3) — tenant directory port.
 *
 * The commercial store (commercialPorts.ts) keys accounts by userId
 * and settings by tenantId, but offers no enumeration: an operator
 * surface cannot list tenants from it. This port closes exactly
 * that gap — enumeration only. It writes nothing, mutates no
 * membership, and never invents a tenant: the ids it returns are
 * the distinct tenantIds already present in the commercial tables
 * (account rows UNION settings rows, so a created-but-empty
 * tenant still lists).
 *
 * ADR 0002 port-first: domain code depends only on this
 * interface. Only the adapters (Drizzle D1, in-memory) touch a
 * store, and only the composition root (createTenantDirectoryPorts.ts)
 * maps a Worker binding to an adapter. Members here are
 * account-row members (users with a commercial account in the
 * tenant) — the same account-row authority slice 1 (#2219)
 * resolves identity from. Full membership (including IAAA-only
 * members) is the IAAA read path, consumed client-side by the
 * tenant panel; it is not duplicated through this port.
 */
export interface TenantDirectory {
  /** Distinct tenant ids across account + settings rows, sorted. */
  listTenantIds(): Promise<string[]>;
  /** UserIds with a commercial account row in this tenant, sorted. Empty for unknown tenants. */
  listTenantMembers(tenantId: string): Promise<string[]>;
}
