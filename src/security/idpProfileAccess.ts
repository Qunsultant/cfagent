/**
 * Issue #5160 — tenant scoping for the identity lookup.
 *
 * Stored IDP attributes are PII and access-controlled: a
 * platform-admin sees all tenants, a tenant-admin sees their own
 * tenant only (the logged-in-users viewer-scope rule). A
 * tenant-admin's tenantId parameter is ignored outright (the
 * platformUsers.ts #2231 precedent) — the caller's own tenant is
 * the only scope they can ever search. A non-admin caller is
 * denied with no data. Pure: no store access, no throws.
 */

/** The caller's admin identity as the lookup route resolves it. */
export interface LookupCaller {
  role: string;
  tenantId: string;
}

export type LookupScope =
  | { ok: true; tenantId: string | null }
  | { ok: false; code: "FAILURE_IDP_PROFILE_FORBIDDEN" };

/**
 * Scope one lookup request. requestedTenantId null = a
 * cross-tenant search (platform-admin only). Returns the tenant
 * to search, or the denial — never the caller's data.
 */
export function scopeLookupRequest(
  caller: LookupCaller | null,
  requestedTenantId: string | null,
): LookupScope {
  if (!caller) return { ok: false, code: "FAILURE_IDP_PROFILE_FORBIDDEN" };
  if (caller.role === "platform-admin") {
    return { ok: true, tenantId: requestedTenantId };
  }
  if (caller.role === "tenant-admin") {
    return { ok: true, tenantId: caller.tenantId };
  }
  return { ok: false, code: "FAILURE_IDP_PROFILE_FORBIDDEN" };
}
