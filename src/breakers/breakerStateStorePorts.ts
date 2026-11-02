/**
 * Phase 5 Slice 2 (issue #2000) — breaker state store port.
 *
 * No SQL, no env binding, no store client: adapters live in
 * src/data/*, the composition root in createBreakerStateStorePorts.ts.
 *
 * Working defaults (not rulings), recorded here so a later
 * different ruling is a follow-up change, not a rediscovery:
 *
 * - Store binding: the existing AGENT_DB (D1) binding. D1 is
 *   already bound, strongly consistent for single-row PK reads
 *   (a trip must be visible to the next isolate immediately —
 *   KV's eventual consistency would defeat the point), and the
 *   established pattern (dead-letter store, async jobs, stage
 *   rows all ride D1). No new binding, so no COO gate is hit.
 *   KV (eventual) and DO (new binding, single-instance
 *   semantics nobody needs) were considered and set aside.
 *
 * - Latency placement (measured as operation counts, not
 *   asserted milliseconds — no live D1 latency is observable
 *   from here): the in-memory machine stays the hot-path
 *   authority, so steady state costs ZERO D1 operations per
 *   execute after hydration. D1 sees one single-row read on
 *   first execute per isolate per provider, and one single-row
 *   write per transition (trips are outage-rare, never
 *   steady-state). Transition writes are fire-and-forget, off
 *   the provider call's return path. Steady-state provider-call
 *   latency is therefore unchanged by construction.
 *
 * - Persistence points: transitions (open/half-open/closed)
 *   and operator resets. Sub-threshold consecutive-failure
 *   counts are NOT durable by design: an isolate recycle
 *   resets the count toward the next trip, but never un-trips
 *   an open breaker. Persisting every failed execute would put
 *   a D1 write on the failure path during an outage (every
 *   execute fails until the trip) for no gating benefit.
 *
 * - Degradation: a store error never fails a provider call.
 *   A failed load degrades to fresh in-memory state (logged);
 *   a failed save is swallowed and logged. Durability degrades
 *   to per-isolate on store errors, exactly today's behavior.
 *   Breaker state is provider-scoped infrastructure state,
 *   never user-scoped.
 */
import type { BreakerState } from "./breakerPorts";

/** One provider's durable breaker row. Totals are history (the
 *  last transition's values); the gating fields are state,
 *  openedAtMs, consecutiveFailures, and transitionSeq. */
export interface BreakerPersistedState {
  providerId: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAtMs: number | null;
  lastFailureAtMs: number | null;
  totalCalls: number;
  totalSuccesses: number;
  totalFailures: number;
  totalTrips: number;
  totalFallbacks: number;
  totalRejected: number;
  /** Per-provider monotonic transition counter. Durable, because
   *  envelope ids embed it (provider:to:seq is the idempotency
   *  key) — a restart that reset it to 0 would collide with a
   *  previous isolate's trip id and suppress its alert. */
  transitionSeq: number;
  updatedAtMs: number;
}

/** Durable breaker state + trip-alert claims. */
export interface BreakerStateStore {
  load(providerId: string): Promise<BreakerPersistedState | null>;
  save(state: BreakerPersistedState): Promise<void>;
  /**
   * Guarded trip-alert claim (the slice-1 token pattern, never
   * an affected-row count): first caller for a transition id
   * wins; later callers for the same id lose. The token is the
   * caller's unique claim token; the claim won iff the stored
   * token is the caller's after re-read.
   */
  claimTripAlert(transitionId: string, atMs: number, token: string): Promise<boolean>;
}
