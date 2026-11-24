/**
 * #6151 S4 — composition root for the admin-config store port.
 * This is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createNavAdminConfigAdapter` returns null and callers keep
 * their fail direction — the nav-availability read degrades to
 * no narrowing (the shipped persona defaults, no allowance, no
 * allow-list), while admin mutations fail closed with a 503.
 */
import {
  createD1NavAdminConfigDb,
  D1NavAdminConfigAdapter,
  ensureNavAdminConfigSchema,
  type NavAdminConfigDb,
} from "./d1NavAdminConfigAdapter";
import type { NavAdminConfigStore } from "./navAdminConfigPorts";

/** Build the admin-config store adapter from Worker env, or null if unbound. */
export function createNavAdminConfigAdapter(env: { AGENT_DB?: unknown }): D1NavAdminConfigAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1NavAdminConfigAdapter(createD1NavAdminConfigDb(env.AGENT_DB as D1Database));
}

export { ensureNavAdminConfigSchema };
export type { NavAdminConfigDb, NavAdminConfigStore };
