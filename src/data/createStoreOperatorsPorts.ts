/**
 * Issue #2680 — composition root for the store operator list
 * port. This is the ONLY module that maps a Worker binding to
 * a port implementation: domain code imports this helper and
 * the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state: the
 * helper returns null and callers fall back to env-only
 * operator checks — exactly today's behavior, no lockout.
 * A present-but-unreadable store fails at the call site,
 * where the caller decides the direction.
 */
import {
  createD1StoreOperatorsDb,
  D1StoreOperatorsAdapter,
  ensureStoreOperatorsSchema,
  type StoreOperatorsDb,
} from "./d1StoreOperatorsAdapter";
import type { StoreOperators } from "./storeOperatorsPorts";

/** Build the store operator list adapter from Worker env, or null if unbound. */
export function createStoreOperatorsAdapter(env: { AGENT_DB?: unknown }): D1StoreOperatorsAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1StoreOperatorsAdapter(createD1StoreOperatorsDb(env.AGENT_DB as D1Database));
}

/**
 * Parse the env operator list. The env var is a comma-separated
 * login list; blank entries are skipped. Kept here (the composition
 * root) so the four former per-site copies have one home.
 */
export function parseEnvOperators(env: { COMMERCIAL_STORE_OPERATORS?: unknown }): Set<string> {
  const raw = typeof env.COMMERCIAL_STORE_OPERATORS === "string" ? env.COMMERCIAL_STORE_OPERATORS : "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * #6180 — the effective legacy operator logins: env UNION store.
 * THE deprecated read: every gate site that still consults the
 * login-keyed lists goes through this one function, so the fallback
 * is named in one place and its removal (follow-up issue under
 * #6180) deletes one function, not four copies. A present-but-
 * unreadable store degrades to env-only — exactly today's behavior,
 * no lockout — and the caller reports the degradation.
 */
export async function listEffectiveOperatorLogins(
  env: { COMMERCIAL_STORE_OPERATORS?: unknown; AGENT_DB?: unknown },
  // Narrow on purpose: the only operator operation this reader needs
  // is listOperators. Route contexts carry exactly that Pick, and the
  // full StoreOperators remains assignable to it.
  operators?: Pick<StoreOperators, "listOperators"> | null,
): Promise<{ logins: Set<string>; storeDegraded: boolean }> {
  const logins = parseEnvOperators(env);
  const adapter = operators === undefined ? createStoreOperatorsAdapter(env) : operators;
  if (!adapter) return { logins, storeDegraded: false };
  try {
    for (const entry of await adapter.listOperators()) logins.add(entry.login);
  } catch {
    return { logins, storeDegraded: true };
  }
  return { logins, storeDegraded: false };
}

export { ensureStoreOperatorsSchema };
export type { StoreOperators, StoreOperatorsDb };
