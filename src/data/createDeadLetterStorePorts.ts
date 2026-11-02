/**
 * Phase 5 Slice 1 (issue #2000) — composition root for the
 * dead-letter store port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state: the
 * helper returns null and callers degrade to console-only
 * dead-letter records — exactly today's behavior, no lockout.
 * A present-but-unreadable store fails at the call site,
 * where the caller decides the direction.
 */
import {
  createD1DeadLetterStoreDb,
  D1DeadLetterStoreAdapter,
  ensureDeadLetterStoreSchema,
  type DeadLetterStoreDb,
} from "./d1DeadLetterStoreAdapter";
import type { DeadLetterStore } from "../messaging/deadLetterStorePorts";

/** Build the dead-letter store adapter from Worker env, or null if unbound. */
export function createDeadLetterStoreAdapter(env: { AGENT_DB?: unknown }): D1DeadLetterStoreAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1DeadLetterStoreAdapter(createD1DeadLetterStoreDb(env.AGENT_DB as D1Database));
}

export { ensureDeadLetterStoreSchema };
export type { DeadLetterStore, DeadLetterStoreDb };
