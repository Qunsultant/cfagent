/**
 * Issue #3261 — composition root for the user profile port.
 * This is the ONLY module that maps a Worker binding to a port
 * implementation: domain code imports this helper and the port
 * type, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createProfileAdapter` returns null and callers keep their
 * fail direction — the profile routes fail closed with 503,
 * never a default profile that looks like "no name everywhere".
 */
import {
  createD1ProfileDb,
  D1ProfileAdapter,
  type ProfileDb,
} from "./d1ProfileAdapter";
import type { UserProfileStore } from "./profilePorts";

/** Build the user profile adapter from Worker env, or null if unbound. */
export function createProfileAdapter(env: { AGENT_DB?: unknown }): D1ProfileAdapter | null {
  if (!env.AGENT_DB) return null;
  const d1 = env.AGENT_DB as D1Database;
  return new D1ProfileAdapter(createD1ProfileDb(d1), d1);
}

export type { UserProfileStore, ProfileDb };
