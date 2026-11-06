/**
 * Phase 5 Slice 2 (issue #2000) — durable CircuitBreaker adapter.
 *
 * The state machine stays in InMemoryCircuitBreaker (one
 * machine, not two); this adapter adds cross-isolate durability
 * around it: transitions and operator resets persist to the
 * breaker state store, and a fresh isolate hydrates from the
 * store on first execute, so a trip in one isolate protects
 * siblings and survives recycle.
 *
 * Hot-path contract (the latency analysis in
 * breakerStateStorePorts.ts): the in-memory machine is the
 * authority. Steady state costs ZERO store operations per
 * execute after hydration: one single-row read on first
 * execute per isolate per provider, one single-row write per
 * transition, fire-and-forget off the return path.
 *
 * Cold-start semantics, stated plainly:
 * - getState()/snapshot() before first execute return fresh
 *   in-memory state (closed); the gate that matters,
 *   execute(), always hydrates first, so cold-start
 *   protection engages on the first provider call, not on
 *   reads. A snapshots route in a fresh isolate may briefly
 *   show closed until the first execute hydrates.
 * - Hydration applies the persisted row exactly once. A
 *   persisted open state with an unexpired resetTimeout
 *   gates instantly (fail-closed on cold start); an expired
 *   one lazily half-opens on the next call, per the machine.
 * - Sub-threshold consecutive-failure counts are NOT durable
 *   (see the port): a recycle resets the count toward the
 *   next trip, never un-trips an open breaker.
 * - A store error never fails a provider call: a failed load
 *   degrades to fresh state (logged); a failed save is
 *   swallowed and logged.
 */
import type {
  BreakerExecuteOptions,
  BreakerOutcome,
  BreakerPolicy,
  BreakerSnapshot,
  BreakerStateChangeEvent,
  CircuitBreaker,
} from "./breakerPorts";
import { InMemoryCircuitBreaker } from "./inMemoryBreakerAdapter";
import type {
  BreakerPersistedState,
  BreakerStateStore,
} from "./breakerStateStorePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "breakers/durableBreakerAdapter",
});

export interface DurableBreakerDeps {
  nowMs?: () => number;
  onStateChange?: (event: BreakerStateChangeEvent) => void;
}

export class DurableCircuitBreaker implements CircuitBreaker {
  private readonly inner: InMemoryCircuitBreaker;
  private readonly store: BreakerStateStore;
  private readonly nowMs: () => number;
  private readonly onStateChange?: (event: BreakerStateChangeEvent) => void;
  /** Per-breaker monotonic transition counter, tracked from
   *  events (snapshot() does not carry it — the port is
   *  unchanged by this slice). Seeded from the hydrated row. */
  private lastSeq = 0;
  /** Set by reset() before hydration completes: the reset is
   *  honored immediately in memory, but its persist waits for
   *  hydration so the hydrated sequence/totals are preserved
   *  (persisting a fresh seq 0 over a tripped row would regress
   *  the sequence and collide with a previous trip's envelope
   *  id, suppressing its alert). */
  private resetPending = false;
  /** Hydration promise (started in the constructor; never
   *  rejects — hydrateOnce catches everything — so awaiting
   *  it cannot poison later executes). */
  private readonly hydration: Promise<void>;
  /** True once hydration has applied or been skipped. */
  private hydrationSettled = false;
  /** Serialized persist chain: saves execute in call order,
   *  so the row always reflects the latest transition even
   *  when a lazy half-open transition nests inside a persist's
   *  snapshot read. Failures are swallowed + logged (a store
   *  error never fails a provider call). */
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly providerId: string,
    private readonly policy: BreakerPolicy,
    store: BreakerStateStore,
    deps: DurableBreakerDeps = {}
  ) {
    this.store = store;
    this.nowMs = deps.nowMs ?? Date.now;
    this.onStateChange = deps.onStateChange;
    this.inner = new InMemoryCircuitBreaker(providerId, policy, {
      nowMs: this.nowMs,
      onStateChange: (event) => {
        this.lastSeq = event.transitionSeq;
        this.persist();
        this.onStateChange?.(event);
      },
    });
    // Start the load immediately so it overlaps construction;
    // execute() awaits it before gating (see ensureHydrated).
    this.hydration = this.hydrateOnce();
  }

  /** Load once and apply. Sequence is always seeded from the
   *  row (never regressed). If an operator reset landed first,
   *  the reset wins for state (closed, count cleared) but the
   *  row's history (totals + sequence) is preserved and the
   *  reset row is persisted — a reset never resurrects a trip,
   *  and never rewinds the sequence. */
  private async hydrateOnce(): Promise<void> {
    try {
      const row = await this.store.load(this.providerId);
      if (row) {
        this.lastSeq = row.transitionSeq;
        if (this.resetPending) {
          this.inner.hydrate({
            ...row,
            state: "closed",
            consecutiveFailures: 0,
            openedAtMs: null,
          });
          this.persist();
        } else {
          this.inner.hydrate(row);
        }
      }
    } catch (err) {
      structuredLog.warn("breaker.durable_load_failed", {
        message: `[breaker] durable load failed for ${this.providerId}, degrading to in-memory: ${err instanceof Error ? err.message : String(err)}`,
        providerId: this.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.hydrationSettled = true;
      this.resetPending = false;
    }
  }

  /** Await hydration (first execute only; later calls await an already-resolved promise). */
  private async ensureHydrated(): Promise<void> {
    await this.hydration;
  }

  /** Capture the current machine state as a persistable row. */
  private captureRow(): BreakerPersistedState {
    const snap = this.inner.snapshot();
    return {
      providerId: this.providerId,
      state: snap.state,
      consecutiveFailures: snap.consecutiveFailures,
      openedAtMs: snap.openedAtMs,
      lastFailureAtMs: snap.lastFailureAtMs,
      totalCalls: snap.totalCalls,
      totalSuccesses: snap.totalSuccesses,
      totalFailures: snap.totalFailures,
      totalTrips: snap.totalTrips,
      totalFallbacks: snap.totalFallbacks,
      totalRejected: snap.totalRejected,
      transitionSeq: this.lastSeq,
      updatedAtMs: this.nowMs(),
    };
  }

  /** Enqueue a serialized, swallowed persist of the current row. */
  private persist(): void {
    const row = this.captureRow();
    this.persistQueue = this.persistQueue.then(() => this.store.save(row)).then(
      () => undefined,
      (err: unknown) => {
        structuredLog.warn("breaker.durable_save_failed", {
          message: `[breaker] durable save failed for ${this.providerId}: ${err instanceof Error ? err.message : String(err)}`,
          providerId: this.providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    );
  }

  getState() {
    return this.inner.getState();
  }

  snapshot(): BreakerSnapshot {
    return this.inner.snapshot();
  }

  reset(): void {
    this.inner.reset();
    if (!this.hydrationSettled) {
      // Defer the persist: hydrateOnce will persist the reset
      // state with the hydrated sequence/totals once the load
      // lands (see hydrateOnce). Persisting now would write a
      // fresh seq 0 over the tripped row.
      this.resetPending = true;
    } else {
      this.persist();
    }
  }

  async execute<T>(
    fn: () => Promise<T>,
    opts: BreakerExecuteOptions<T> = {}
  ): Promise<BreakerOutcome<T>> {
    await this.ensureHydrated();
    return this.inner.execute(fn, opts);
  }

  /** Test seam: await all persistence writes enqueued so far. */
  async drain(): Promise<void> {
    await this.persistQueue;
  }
}
