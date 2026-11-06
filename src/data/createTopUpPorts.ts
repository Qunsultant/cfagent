/**
 * Issue #3262 — composition root for the top-up draft port. This is
 * the ONLY module that maps a Worker binding to a draft
 * implementation: domain code imports this helper and the port types,
 * never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createTopUpDraftAdapter` returns null and callers keep their fail
 * direction — fail-closed on money paths. A present-but-unreadable
 * store fails at the call site, where the caller decides the direction.
 */
import {
  createD1TopUpDb,
  D1TopUpAdapter,
  ensureTopUpSchema,
  type TopUpDraftDb,
} from "./d1TopUpAdapter";
import type { TopUpDraftStore } from "./topUpPorts";

/** Build the top-up draft adapter from Worker env, or null if unbound. */
export function createTopUpDraftAdapter(env: { AGENT_DB?: unknown }): D1TopUpAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1TopUpAdapter(createD1TopUpDb(env.AGENT_DB as D1Database));
}

export { ensureTopUpSchema };
export type { TopUpDraftDb, TopUpDraftStore };
