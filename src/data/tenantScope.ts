/**
 * Issue #1761 ([1717] Tenancy isolation: app-level WHERE-clause
 * leak class, SEC-006 / DATA-003) — the tenant-scope binding
 * mechanism.
 *
 * The assessed leak class is a query that reads a tenant-carrying
 * table without predicating on tenant_id: the omission silently
 * returns cross-tenant rows. The fix is not "remember the filter"
 * — it is a binding a query cannot run without:
 *
 *  - A `TenantScope` is an opaque token that exists only via
 *    `bindTenantScope(tenantId)`, which throws on a missing,
 *    blank, or non-string tenant id. There is no unscoped
 *    construction path: a caller that has no tenant bound cannot
 *    build the token, and a query site that takes a scope cannot
 *    run filter-omitted.
 *  - `tenantEq(table, scope)` is the single predicate constructor
 *    for Drizzle tenant-carrying tables: every tenant-scoped read
 *    in an adopting adapter predicates on it, so the tenant
 *    filter is built by the mechanism, not re-typed per query.
 *  - `assertTenantScopeMatch(rowTenantId, scope)` is the
 *    fail-closed guard for id-keyed paths whose lookup key is not
 *    itself the tenant (e.g. a user-id primary key): a stored row
 *    belonging to another tenant throws instead of being
 *    returned — or, on write, instead of being overwritten.
 *
 * Deliberately NOT configurable: this is enforcement, not a
 * behavior variant. A runtime switch that let a caller disable
 * its own tenant scoping would be exactly the defect the
 * program's security guard forbids (IAAA gate switches are
 * admin/platform-controlled and fail closed; tenant scoping is
 * not opt-out at any scope). No endpoint, route, or code path
 * is removed by this module; it adds the binding that the
 * omitting adapters now use.
 *
 * #CISO-bhdm
 */
import { eq, type AnyColumn, type SQL } from "drizzle-orm";

/** Thrown when tenant scope is missing, blank, or mismatched. */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

/**
 * An opaque bound-tenant token. Constructible only through
 * `bindTenantScope` — the brand field exists so a bare string
 * (or a forgotten argument) is never accepted where a scope is
 * required.
 */
export type TenantScope = {
  readonly tenantId: string;
  readonly __brand: "TenantScope";
};

/**
 * Bind a tenant scope. Fails closed: a missing, non-string, or
 * blank tenant id throws instead of producing a scope that
 * would read (or write) across tenants.
 */
export function bindTenantScope(tenantId: unknown): TenantScope {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new TenantScopeError(
      "Tenant scope requires a non-empty tenant id; refusing to run unscoped (issue #1761).",
    );
  }
  return { tenantId, __brand: "TenantScope" };
}

/** The tenant id carried by a bound scope. */
export function tenantScopeId(scope: TenantScope): string {
  return scope.tenantId;
}

/**
 * The tenant predicate for a Drizzle table carrying a `tenantId`
 * column. Adopting adapters build every tenant-table read on
 * this predicate (alone or inside `and(...)`) so the filter
 * cannot be silently dropped from a query.
 */
export function tenantEq(
  table: { tenantId: AnyColumn },
  scope: TenantScope,
): SQL {
  return eq(table.tenantId, scope.tenantId);
}

/**
 * Fail-closed row-ownership check: a stored row whose tenant
 * differs from the bound scope throws instead of being
 * returned or overwritten. A null/undefined stored tenant never
 * matches a bound scope.
 */
export function assertTenantScopeMatch(
  rowTenantId: unknown,
  scope: TenantScope,
): void {
  if (rowTenantId !== scope.tenantId) {
    throw new TenantScopeError(
      `Tenant scope mismatch: stored row belongs to another tenant, not ${scope.tenantId}; refusing cross-tenant access (issue #1761).`,
    );
  }
}
