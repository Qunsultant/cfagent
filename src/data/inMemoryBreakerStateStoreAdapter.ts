/**
 * Phase 5 Slice 2 (issue #2000) — in-memory breaker state store.
 *
 * Test double and local fallback: same contract as the D1
 * adapter, Map-backed. A behavior difference between them is a
 * defect in one adapter, not a test difference.
 */
import type {
  BreakerPersistedState,
  BreakerStateStore,
} from "../breakers/breakerStateStorePorts";

interface TripClaim {
  alertedAtMs: number;
  claimToken: string;
}

export class InMemoryBreakerStateStoreAdapter implements BreakerStateStore {
  private readonly rows = new Map<string, BreakerPersistedState>();
  private readonly claims = new Map<string, TripClaim>();

  async load(providerId: string): Promise<BreakerPersistedState | null> {
    const row = this.rows.get(providerId);
    return row ? { ...row } : null;
  }

  async save(state: BreakerPersistedState): Promise<void> {
    this.rows.set(state.providerId, { ...state });
  }

  async claimTripAlert(transitionId: string, atMs: number, token: string): Promise<boolean> {
    // Slice-1 token semantics: first token wins; a different token
    // loses; the same token re-claiming is idempotent-true. (The
    // subscriber claims with a fresh token per call, so a
    // re-delivery always loses — see breaker_trip_alert tests.)
    const existing = this.claims.get(transitionId);
    if (existing === undefined) {
      this.claims.set(transitionId, { alertedAtMs: atMs, claimToken: token });
      return true;
    }
    return existing.claimToken === token;
  }
}
