/**
 * Issue #1745 — in-memory CircuitBreaker adapter.
 *
 * Pure state machine over the breaker port; the only adapter in
 * this slice (a durable cross-isolate store is a follow-up).
 * Clock injected for tests; production uses Date.now. One failure
 * counted per execute(), never per retry attempt: withRetry may
 * call fn up to maxAttempts times inside one execute, but the
 * breaker judges the execute's final outcome — otherwise a single
 * execute with 3 attempts would trip a threshold-3 breaker alone.
 */

import type {
  BreakerExecuteOptions,
  BreakerOutcome,
  BreakerPolicy,
  BreakerSnapshot,
  BreakerState,
  BreakerStateChangeEvent,
  CircuitBreaker,
} from "./breakerPorts";
import type { BreakerPersistedState } from "./breakerStateStorePorts";
import {
  BreakerBudgetExhaustedError,
  BreakerOpenError,
} from "./breakerPorts";
import { withRetry } from "../services/resilience";
import { DEFAULT_PIPELINE_POLICY } from "../services/pipelinePolicy";

export interface InMemoryBreakerDeps {
  nowMs?: () => number;
  onStateChange?: (event: BreakerStateChangeEvent) => void;
}

export class InMemoryCircuitBreaker implements CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private probeCount = 0;
  private openedAtMs: number | null = null;
  private lastFailureAtMs: number | null = null;
  private totalCalls = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private totalTrips = 0;
  private totalFallbacks = 0;
  private totalRejected = 0;
  private transitionSeq = 0;
  private readonly nowMs: () => number;
  private readonly onStateChange?: (event: BreakerStateChangeEvent) => void;

  constructor(
    readonly providerId: string,
    private readonly policy: BreakerPolicy,
    deps: InMemoryBreakerDeps = {}
  ) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.onStateChange = deps.onStateChange;
  }

  getState(): BreakerState {
    this.maybeHalfOpen();
    return this.state;
  }

  snapshot(): BreakerSnapshot {
    return {
      providerId: this.providerId,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      totalCalls: this.totalCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalTrips: this.totalTrips,
      totalFallbacks: this.totalFallbacks,
      totalRejected: this.totalRejected,
      openedAtMs: this.openedAtMs,
      lastFailureAtMs: this.lastFailureAtMs,
    };
  }

  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeCount = 0;
    this.openedAtMs = null;
    // Lifetime totals are history, not state — reset keeps them so
    // an operator reset never erases the trip/fallback record.
  }

  /**
   * Restore persisted state (Phase 5 Slice 2 durable hydration).
   * NOT a transition: emits nothing, and resets the in-flight
   * probe count (a probe cannot survive an isolate recycle).
   * The caller (durable adapter) guarantees this runs before
   * any execute on the hydrated instance, and never after a
   * reset — applying a stale row over a fresh reset would
   * resurrect a trip the operator just cleared.
   */
  hydrate(state: BreakerPersistedState): void {
    this.state = state.state;
    this.consecutiveFailures = state.consecutiveFailures;
    this.probeCount = 0;
    this.openedAtMs = state.openedAtMs;
    this.lastFailureAtMs = state.lastFailureAtMs;
    this.totalCalls = state.totalCalls;
    this.totalSuccesses = state.totalSuccesses;
    this.totalFailures = state.totalFailures;
    this.totalTrips = state.totalTrips;
    this.totalFallbacks = state.totalFallbacks;
    this.totalRejected = state.totalRejected;
    this.transitionSeq = state.transitionSeq;
  }

  async execute<T>(
    fn: () => Promise<T>,
    opts: BreakerExecuteOptions<T> = {}
  ): Promise<BreakerOutcome<T>> {
    const now = this.nowMs();
    const budget = opts.budget;

    // Budget gate FIRST: an exhausted budget serves the fallback
    // (qualified partial) without spending or calling anything.
    if (budget && budget.exhausted) {
      return this.rejectOrFallback("budget-exhausted", opts);
    }

    this.maybeHalfOpen();
    if (this.state === "open") {
      return this.rejectOrFallback("open", opts);
    }
    let isProbe = false;
    if (this.state === "half-open") {
      if (this.probeCount >= this.policy.halfOpenMaxProbes) {
        return this.rejectOrFallback("half-open-probe", opts);
      }
      this.probeCount += 1;
      isProbe = true;
    }

    // One budget spend per execute(), never per retry attempt.
    if (budget && !budget.tryConsume()) {
      if (isProbe) this.probeCount -= 1;
      return this.rejectOrFallback("budget-exhausted", opts);
    }

    this.totalCalls += 1;
    try {
      const value = await withRetry(fn, opts.retryPolicy ?? DEFAULT_PIPELINE_POLICY.retry.acquisition, {
        shouldRetry: opts.shouldRetry,
        sleep: opts.sleep,
        rng: opts.rng,
        onRetry: opts.onRetry,
      });
      this.totalSuccesses += 1;
      if (isProbe) {
        this.probeCount = 0;
        this.transitionTo("closed", now);
      } else {
        this.consecutiveFailures = 0;
      }
      return { status: "success", value, state: this.state };
    } catch (err) {
      this.totalFailures += 1;
      this.lastFailureAtMs = now;
      const permanent = opts.shouldRetry !== undefined && !opts.shouldRetry(err);
      if (!permanent) {
        this.consecutiveFailures += 1;
        if (isProbe) {
          this.probeCount = 0;
          this.totalTrips += 1;
          this.transitionTo("open", now);
        } else if (this.consecutiveFailures >= this.policy.failureThreshold) {
          this.totalTrips += 1;
          this.transitionTo("open", now);
        }
      } else if (isProbe) {
        // Permanent failure during a probe: release the probe, keep
        // half-open (the next call probes again). An auth/config
        // failure is not an outage signal, so it never trips.
        this.probeCount -= 1;
      }
      if (opts.fallback) {
        const value = await opts.fallback();
        this.totalFallbacks += 1;
        return { status: "fallback", value, reason: "provider-failed", state: this.state };
      }
      throw err;
    }
  }

  /** Lazy open → half-open transition; emits exactly once per trip. */
  private maybeHalfOpen(): void {
    if (
      this.state === "open" &&
      this.openedAtMs !== null &&
      this.nowMs() - this.openedAtMs >= this.policy.resetTimeoutMs
    ) {
      this.transitionTo("half-open", this.nowMs());
    }
  }

  private transitionTo(to: BreakerState, atMs: number): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === "open") this.openedAtMs = atMs;
    if (to === "closed") {
      this.consecutiveFailures = 0;
      this.openedAtMs = null;
    }
    this.transitionSeq += 1;
    this.onStateChange?.({
      providerId: this.providerId,
      from,
      to,
      atMs,
      transitionSeq: this.transitionSeq,
      trips: this.totalTrips,
      fallbacks: this.totalFallbacks,
    });
  }

  private async rejectOrFallback<T>(
    reason: "open" | "half-open-probe" | "budget-exhausted",
    opts: BreakerExecuteOptions<T>
  ): Promise<BreakerOutcome<T>> {
    if (opts.fallback) {
      const value = await opts.fallback();
      this.totalFallbacks += 1;
      return { status: "fallback", value, reason, state: this.state };
    }
    this.totalRejected += 1;
    if (reason === "budget-exhausted") {
      throw new BreakerBudgetExhaustedError(this.providerId);
    }
    throw new BreakerOpenError(this.providerId, this.state);
  }
}
