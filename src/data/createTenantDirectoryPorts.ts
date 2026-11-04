/**
 * Issue #2221 — composition root for the tenant directory port.
 * This is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * type, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createTenantDirectoryAdapter` returns null and callers keep
 * their fail direction — the tenant admin routes fail closed
 * with 503, never an empty list that looks like "no tenants".
 */
import {
  createD1TenantDirectoryDb,
  D1TenantDirectoryAdapter,
  type TenantDirectoryDb,
} from "./d1TenantDirectoryAdapter";
import type { TenantDirectory } from "./tenantDirectoryPorts";

/** Build the tenant directory adapter from Worker env, or null if unbound. */
export function createTenantDirectoryAdapter(env: { AGENT_DB?: unknown }): D1TenantDirectoryAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1TenantDirectoryAdapter(createD1TenantDirectoryDb(env.AGENT_DB as D1Database));
}

export type { TenantDirectory, TenantDirectoryDb };
