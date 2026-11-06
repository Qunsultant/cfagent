/**
 * Issue #1745 ([AGENTIC] Automated market data circuit breakers).
 *
 * Port-first breaker layer (GoF Decorator over provider calls,
 * Protected Variations: providers stay behind stable interfaces).
 * Domain code depends on this port, never on breaker internals or
 * provider error shapes.
 *
 * State machine (deterministic, clock-injected):
 * closed → open (failureThreshold consecutive RETRYABLE failures;
 * one failure counted per execute(), never per retry attempt) →
 * half-open (after resetTimeoutMs, lazily on the next call) →
 * closed (probe success) or open again (probe failure). While open,
 * and while a half-open probe is in flight beyond halfOpenMaxProbes,
 * calls are rejected instantly: no provider call, no budget spend.
 * Permanent failures (shouldRetry false) are recorded but never
 * count toward the trip threshold — an auth/config failure is not
 * an outage signal.
 *
 * State is per-provider infrastructure state, held in memory per
 * isolate (documented loss semantics: an isolate recycle resets
 * breakers to closed — fail-open on cold start). A durable
 * cross-isolate breaker store is a follow-up, not this slice.
 * Breaker state is NEVER user-scoped: it records provider health,
 * not user data.
 *
 * Observability hooks for #1742 (later consumer, not built here):
 * snapshot() per breaker (state, trip counts, fallback counts) and
 * the onStateChange event stream, translated to #1739 CloudEvents
 * envelopes by toBreakerStateChangeEnvelope (same envelope,
 * id-as-idempotency-key; data carries counts only, never user
 * material). Emission failure is swallowed and logged, never
 * failing the breaker operation (the #1740 emitter pattern).
 */

import type { MessageEnvelope } from "../messaging/messagingPorts";
import type { RetryPolicy } from "../services/pipelinePolicy";
import { InMemoryCircuitBreaker } from "./inMemoryBreakerAdapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "breakers/breakerPorts",
});

/** Provider ids in the dataProviders registry. */
export const BREAKER_PROVIDER_IDS = [
  "etrade",
  "public",
  "yahoo",
  "alpaca",
  "nasdaq",
] as const;

export type BreakerProviderId = (typeof BREAKER_PROVIDER_IDS)[number];

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerPolicy {
  /** Consecutive retryable failures that trip closed → open (>= 1). */
  failureThreshold: number;
  /** Open → half-open delay in ms (>= 0). */
  resetTimeoutMs: number;
  /** Concurrent probes allowed while half-open (>= 1; default 1). */
  halfOpenMaxProbes: number;
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  halfOpenMaxProbes: 1,
};

/** A run budget gate (structural: SubrequestBudget satisfies it). */
export interface BudgetGate {
  tryConsume(): boolean;
  readonly exhausted: boolean;
}

export type BreakerOutcome<T> =
  | { status: "success"; value: T; state: BreakerState }
  | { status: "fallback"; value: T; reason: string; state: BreakerState };

export interface BreakerExecuteOptions<T> {
  /** Served when the live path cannot produce a value (open gate,
   *  budget exhaustion, or post-retry failure). The fallback value
   *  MUST be self-labeling (e.g. cached provenance) — the decorator
   *  never invents market data. Absent: business error thrown. */
  fallback?: () => Promise<T> | T;
  /** Run budget: one spend per execute(), never per retry attempt.
   *  Exhaustion serves the fallback (qualified partial), never a
   *  mid-scan throw — unless no fallback exists (business error). */
  budget?: BudgetGate;
  /** Retry policy for the inner call (withRetry reuse). Default:
   *  the pipeline acquisition policy (3 attempts). */
  retryPolicy?: RetryPolicy;
  /** Permanent failures are rethrown immediately and never count
   *  toward the trip threshold. Default: every failure counts. */
  shouldRetry?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  onRetry?: (event: import("../services/resilience").RetryEvent) => void;
}

export interface BreakerSnapshot {
  providerId: string;
  state: BreakerState;
  consecutiveFailures: number;
  /** execute() invocations gated (including open/budget rejections). */
  totalCalls: number;
  totalSuccesses: number;
  /** execute() invocations ending in provider failure. */
  totalFailures: number;
  totalTrips: number;
  /** Fallback values served (open gate, budget, or failure). */
  totalFallbacks: number;
  /** Open/budget rejections with no fallback (business error thrown). */
  totalRejected: number;
  openedAtMs: number | null;
  lastFailureAtMs: number | null;
}

export interface CircuitBreaker {
  readonly providerId: string;
  execute<T>(
    fn: () => Promise<T>,
    opts?: BreakerExecuteOptions<T>
  ): Promise<BreakerOutcome<T>>;
  getState(): BreakerState;
  snapshot(): BreakerSnapshot;
  /** Back to closed; lifetime totals are kept (history, not state). */
  reset(): void;
}

export interface BreakerRegistry {
  breakerFor(providerId: string): CircuitBreaker;
  snapshots(): BreakerSnapshot[];
  resetAll(): void;
}

export interface BreakerStateChangeEvent {
  providerId: string;
  from: BreakerState;
  to: BreakerState;
  atMs: number;
  /** Per-breaker monotonic transition counter (envelope id anchor). */
  transitionSeq: number;
  trips: number;
  fallbacks: number;
}

export interface BreakerRegistryOptions {
  env?: Record<string, unknown>;
  settings?: Record<string, string | undefined>;
  nowMs?: () => number;
  onStateChange?: (event: BreakerStateChangeEvent) => void;
  /** Best-effort state-change emission; failures swallowed + logged. */
  emit?: (envelope: MessageEnvelope) => void | Promise<void>;
}

/**
 * Business error: breaker open (or probe busy) and no fallback.
 * Carries a business message, never a raw provider error.
 */
export class BreakerOpenError extends Error {
  constructor(
    readonly providerId: string,
    readonly breakerState: BreakerState
  ) {
    super(
      `${providerId} market data temporarily unavailable (circuit ${breakerState}); try again shortly`
    );
    this.name = "BreakerOpenError";
  }
}

/** Business error: run budget exhausted and no fallback exists. */
export class BreakerBudgetExhaustedError extends Error {
  constructor(readonly providerId: string) {
    super(
      `${providerId} run budget exhausted; only partial results are available`
    );
    this.name = "BreakerBudgetExhaustedError";
  }
}

/** Business error: a fallback author reports no usable fallback value. */
export class BreakerFallbackError extends Error {
  constructor(
    readonly providerId: string,
    detail: string
  ) {
    super(`${providerId} fallback unavailable: ${detail}`);
    this.name = "BreakerFallbackError";
  }
}

function parseIntClamped(
  raw: string | undefined,
  min: number,
  max: number,
  label: string
): number | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    structuredLog.warn("breaker.policy_non_numeric", {
      message: `[breakerPolicy] ignoring non-numeric ${label}: ${String(raw).slice(0, 40)}`,
      label,
      raw: String(raw).slice(0, 40),
    });
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Resolve the effective breaker policy for one provider.
 * Precedence (the pipelinePolicy pattern): code defaults < Worker
 * env (BREAKER_<ID>_*) < settings map (breaker.<id>.*). Invalid
 * values are ignored with a log line — resolution never throws.
 */
export function resolveBreakerPolicyFor(
  providerId: string,
  env?: Record<string, unknown>,
  settings?: Record<string, string | undefined>
): BreakerPolicy {
  const id = providerId.toLowerCase();
  const e = (key: string): string | undefined => {
    const v = env?.[key];
    return v === undefined || v === null ? undefined : String(v);
  };
  const s = (key: string): string | undefined => settings?.[key];
  const d = DEFAULT_BREAKER_POLICY;
  return {
    failureThreshold:
      parseIntClamped(
        s(`breaker.${id}.failureThreshold`) ?? e(`BREAKER_${id.toUpperCase()}_FAILURE_THRESHOLD`),
        1, 100, `BREAKER_${id.toUpperCase()}_FAILURE_THRESHOLD`
      ) ?? d.failureThreshold,
    resetTimeoutMs:
      parseIntClamped(
        s(`breaker.${id}.resetTimeoutMs`) ?? e(`BREAKER_${id.toUpperCase()}_RESET_TIMEOUT_MS`),
        0, 3_600_000, `BREAKER_${id.toUpperCase()}_RESET_TIMEOUT_MS`
      ) ?? d.resetTimeoutMs,
    halfOpenMaxProbes:
      parseIntClamped(
        s(`breaker.${id}.halfOpenMaxProbes`) ?? e(`BREAKER_${id.toUpperCase()}_HALF_OPEN_PROBES`),
        1, 10, `BREAKER_${id.toUpperCase()}_HALF_OPEN_PROBES`
      ) ?? d.halfOpenMaxProbes,
  };
}

/**
 * Translate a breaker state change to a #1739 CloudEvents v1.0
 * envelope. The id is deterministic per transition (provider +
 * to-state + per-breaker sequence) so it IS the idempotency key.
 * Data carries counts only — never user material, never payloads.
 */
export function toBreakerStateChangeEnvelope(
  event: BreakerStateChangeEvent,
  source = "breaker-registry"
): MessageEnvelope {
  return {
    specversion: "1.0",
    id: `breaker-state:${event.providerId}:${event.to}:${event.transitionSeq}`,
    source,
    type: "breaker.state_changed",
    time: new Date(event.atMs).toISOString(),
    subject: event.providerId,
    correlationid: `breaker:${event.providerId}:${event.transitionSeq}`,
    data: {
      providerId: event.providerId,
      from: event.from,
      to: event.to,
      trips: event.trips,
      fallbacks: event.fallbacks,
    },
  };
}

/**
 * Build a per-provider breaker registry. The five registry ids are
 * pre-created; any other id is created on demand with defaults.
 * onStateChange fires per transition; when emit is supplied, each
 * transition is also translated to a CloudEvents envelope and
 * emitted best-effort (failures swallowed + logged).
 */
export function createBreakerRegistry(
  opts: BreakerRegistryOptions = {}
): BreakerRegistry {
  const breakers = new Map<string, CircuitBreaker>();
  const emitStateChange = (event: BreakerStateChangeEvent) => {
    try {
      opts.onStateChange?.(event);
    } catch (err) {
      structuredLog.warn("breaker.on_state_change_failed", {
        message: `[breaker] onStateChange failed for ${event.providerId}: ${err instanceof Error ? err.message : String(err)}`,
        providerId: event.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (opts.emit) {
      try {
        const result = opts.emit(toBreakerStateChangeEnvelope(event));
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            structuredLog.warn("breaker.state_change_emission_failed", {
              message: `[breaker] state-change emission failed for ${event.providerId}: ${err instanceof Error ? err.message : String(err)}`,
              providerId: event.providerId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        structuredLog.warn("breaker.state_change_emission_failed", {
          message: `[breaker] state-change emission failed for ${event.providerId}: ${err instanceof Error ? err.message : String(err)}`,
          providerId: event.providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const create = (providerId: string): CircuitBreaker =>
    new InMemoryCircuitBreaker(
      providerId,
      resolveBreakerPolicyFor(providerId, opts.env, opts.settings),
      { nowMs: opts.nowMs, onStateChange: emitStateChange }
    );
  for (const id of BREAKER_PROVIDER_IDS) breakers.set(id, create(id));
  return {
    breakerFor(providerId: string): CircuitBreaker {
      let b = breakers.get(providerId);
      if (!b) {
        b = create(providerId);
        breakers.set(providerId, b);
      }
      return b;
    },
    snapshots(): BreakerSnapshot[] {
      return [...breakers.values()].map((b) => b.snapshot());
    },
    resetAll(): void {
      for (const b of breakers.values()) b.reset();
    },
  };
}
