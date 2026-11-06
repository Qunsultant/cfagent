/**
 * Issue #1745 — breaker factory conveniences.
 *
 * defaultBreakerRegistry() is the per-isolate shared registry used
 * by production wiring that has no registry to inject (E*TRADE,
 * Nasdaq, public fetch paths). Its semantics are the documented
 * in-memory ones: state resets on isolate recycle (fail-open on
 * cold start), state is provider-scoped infrastructure state, never
 * user-scoped. Tests and call sites that need isolation use
 * createBreakerRegistry() directly with an injected clock.
 *
 * Phase 5 Slice 2 (issue #2000) — durable production path.
 * createDurableBreakerRegistry() builds a registry whose
 * breakers persist transitions to a breaker state store, so a
 * trip in one isolate protects siblings and survives recycle.
 * defaultBreakerRegistry() uses the durable path once
 * configureDefaultBreakerDurability() has run in the isolate
 * (server entry points call it before any breaker use); if the
 * shared registry already exists when configuration lands, it
 * stays in-memory and a warning is logged — configuration must
 * precede first use, which the entry-point ordering guarantees.
 * Tests and call sites that need isolation use
 * createDurableBreakerRegistry() directly with an injected store.
 */

import {
  BREAKER_PROVIDER_IDS,
  createBreakerRegistry,
  resolveBreakerPolicyFor,
  toBreakerStateChangeEnvelope,
  type BreakerRegistry,
  type BreakerRegistryOptions,
  type BreakerSnapshot,
  type BreakerStateChangeEvent,
  type CircuitBreaker,
} from "./breakerPorts";
import type { MessageEnvelope } from "../messaging/messagingPorts";
import type { BreakerStateStore } from "./breakerStateStorePorts";
import { DurableCircuitBreaker } from "./durableBreakerAdapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "breakers/createBreakerPorts",
});

let shared: BreakerRegistry | undefined;

export interface DurableBreakerRegistryOptions extends BreakerRegistryOptions {
  /** Durable state store (AGENT_DB-backed in production). */
  store: BreakerStateStore;
  /** Trip subscriber: called with each state-change envelope
   *  (failures swallowed + logged, never failing breaker ops). */
  tripAlert?: (envelope: MessageEnvelope) => void | Promise<void>;
}

/**
 * Build a registry whose breakers are durable: transitions and
 * resets persist to the store, fresh isolates hydrate on first
 * execute. The port contract is unchanged — the registry still
 * satisfies BreakerRegistry, and the in-memory adapter remains
 * the conformance-suite counterpart.
 */
export function createDurableBreakerRegistry(
  store: BreakerStateStore,
  opts: Omit<DurableBreakerRegistryOptions, "store">
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
    const envelope = toBreakerStateChangeEnvelope(event);
    if (opts.emit) {
      try {
        const result = opts.emit(envelope);
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
    if (opts.tripAlert) {
      try {
        const result = opts.tripAlert(envelope);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            structuredLog.warn("breaker.trip_alert_failed", {
              message: `[breaker] trip alert failed for ${event.providerId}: ${err instanceof Error ? err.message : String(err)}`,
              providerId: event.providerId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        structuredLog.warn("breaker.trip_alert_failed", {
          message: `[breaker] trip alert failed for ${event.providerId}: ${err instanceof Error ? err.message : String(err)}`,
          providerId: event.providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const create = (providerId: string): CircuitBreaker =>
    new DurableCircuitBreaker(
      providerId,
      resolveBreakerPolicyFor(providerId, opts.env, opts.settings),
      store,
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

interface ConfiguredDurability {
  store: BreakerStateStore;
  tripAlert?: (envelope: MessageEnvelope) => void | Promise<void>;
}

let configured: ConfiguredDurability | undefined;

/**
 * Configure the durable production path for this isolate.
 * Idempotent: the first configuration wins; later calls are
 * ignored (the shared registry, once created, is never swapped
 * — swapping would discard live in-memory state).
 */
export function configureDefaultBreakerDurability(deps: ConfiguredDurability): void {
  if (configured) return;
  configured = deps;
  if (shared) {
    structuredLog.warn("breaker.durability_configured_late", {
      message:
        "[breaker] durability configured after the shared registry already exists; keeping the in-memory registry (configure before first use)",
    });
  }
}

/** Test seam: drop the durability configuration (mirrors __resetDefaultBreakerRegistry). */
export function __resetDefaultBreakerDurability(): void {
  configured = undefined;
}

/** Lazily-created shared per-isolate registry (see header). */
export function defaultBreakerRegistry(
  opts: BreakerRegistryOptions = {}
): BreakerRegistry {
  if (!shared) {
    shared = configured
      ? createDurableBreakerRegistry(configured.store, { ...opts, tripAlert: configured.tripAlert })
      : createBreakerRegistry(opts);
  }
  return shared;
}

/** Test seam: drop the shared registry (mirrors __resetSessionCache). */
export function __resetDefaultBreakerRegistry(): void {
  shared = undefined;
}
