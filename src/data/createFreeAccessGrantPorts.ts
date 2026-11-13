/**
 * Issue #3247 (sub-issue of #3241), slice 1 — composition root
 * for the free-access grant port. This is the ONLY module that
 * maps a Worker binding to a port implementation: domain code
 * imports this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createFreeAccessGrantAdapter` returns null and callers keep
 * their fail direction — fail-closed on the operator routes
 * (503), null mention on the offer surface (slice 2). A
 * present-but-unreadable store fails at the call site, where
 * the caller decides the direction.
 */
import {
  createD1FreeAccessGrantDb,
  D1FreeAccessGrantAdapter,
  ensureFreeAccessGrantSchema,
  type FreeAccessGrantDb,
} from "./d1FreeAccessGrantAdapter";
import type { FreeAccessGrantPort } from "./freeAccessGrantPorts";

/** Build the free-access grant adapter from Worker env, or null if unbound. */
export function createFreeAccessGrantAdapter(env: { AGENT_DB?: unknown }): D1FreeAccessGrantAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1FreeAccessGrantAdapter(createD1FreeAccessGrantDb(env.AGENT_DB as D1Database));
}

export { ensureFreeAccessGrantSchema };
export type { FreeAccessGrantPort, FreeAccessGrantDb };
