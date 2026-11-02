/**
 * Phase 5 Slice 2 (issue #2000) — composition root for the
 * breaker state store port. This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state: the
 * helper returns null and callers degrade to in-memory breaker
 * state — exactly today's behavior, no lockout. A
 * present-but-unreadable store fails at the call site, where
 * the caller decides the direction (the durable adapter logs
 * and degrades; it never fails a provider call).
 */
import {
  createD1BreakerStateStoreDb,
  D1BreakerStateStoreAdapter,
  ensureBreakerStateSchema,
  type BreakerStateStoreDb,
} from "./d1BreakerStateStoreAdapter";
import type { BreakerStateStore } from "../breakers/breakerStateStorePorts";

/** Build the breaker state store adapter from Worker env, or null if unbound. */
export function createBreakerStateStoreAdapter(env: { AGENT_DB?: unknown }): D1BreakerStateStoreAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1BreakerStateStoreAdapter(createD1BreakerStateStoreDb(env.AGENT_DB as D1Database));
}

export { ensureBreakerStateSchema };
export type { BreakerStateStore, BreakerStateStoreDb };
