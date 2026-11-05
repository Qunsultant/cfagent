/**
 * Issue #3305 (sub-issue of #3241) — composition root for the
 * free-run counter port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createFreeRunCounterAdapter` returns null and the gate keeps
 * today's behavior (no free runs — a Free account falls through
 * to the paid path, exactly as before this slice). A
 * present-but-unreadable store fails at the call site, where the
 * caller decides the direction.
 */
import {
  createD1FreeRunCounterDb,
  D1FreeRunCounterAdapter,
  ensureFreeRunCounterSchema,
  type FreeRunCounterDb,
} from "./d1FreeRunCounterAdapter";
import type { FreeRunCounter } from "./freeRunCounterPorts";

/** Build the free-run counter adapter from Worker env, or null if unbound. */
export function createFreeRunCounterAdapter(env: { AGENT_DB?: unknown }): D1FreeRunCounterAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1FreeRunCounterAdapter(createD1FreeRunCounterDb(env.AGENT_DB as D1Database));
}

export { ensureFreeRunCounterSchema };
export type { FreeRunCounter, FreeRunCounterDb };
