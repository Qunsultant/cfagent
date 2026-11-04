/**
 * Issue #3169 — composition root for the tenant channel port.
 * This is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * type, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createTenantChannelAdapter` returns null and callers keep
 * their fail direction — the channel admin routes fail closed
 * with 503, never a default list that looks like "all enabled
 * everywhere".
 */
import {
  createD1TenantChannelDb,
  D1TenantChannelAdapter,
  type TenantChannelDb,
} from "./d1TenantChannelAdapter";
import type { TenantChannelStore } from "./tenantChannelPorts";

/** Build the tenant channel adapter from Worker env, or null if unbound. */
export function createTenantChannelAdapter(env: { AGENT_DB?: unknown }): D1TenantChannelAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1TenantChannelAdapter(createD1TenantChannelDb(env.AGENT_DB as D1Database));
}

export type { TenantChannelStore, TenantChannelDb };
