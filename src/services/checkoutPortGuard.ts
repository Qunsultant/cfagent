/**
 * Issue #3573 — bounded timeout + circuit breaker for the checkout port.
 *
 * GoF Decorator over CheckoutPort (the same layering as
 * src/breakers/breakerDecorator.ts): every external call the port makes
 * (Stripe session retrieve/create, x402 facilitator verify) runs inside
 * a timeout race AND the shared breaker state machine. The composition
 * root (createCheckoutPorts) wraps each adapter it builds, so the 2.1
 * Billing routes, the top-up confirm, the cfpay channel, and the native
 * gate all inherit the guard with no consumer changes.
 *
 * REUSE, not a new mechanism: the breaker is the existing
 * src/breakers/ layer (InMemoryCircuitBreaker via createBreakerRegistry;
 * closed → open after failureThreshold consecutive retryable failures →
 * half-open after resetTimeoutMs → closed on a probe success). This
 * module adds only the checkout wiring: per-rail breaker ids, the
 * timeout race, the typed errors, and the structured aspect logging.
 *
 * - One breaker per rail ("checkout_stripe", "checkout_x402"): a Stripe
 *   outage must not trip the x402 breaker. Policy resolution is the
 *   shared resolveBreakerPolicyFor (code defaults < Worker env
 *   BREAKER_CHECKOUT_<RAIL>_* < settings map breaker.checkout_<rail>.*).
 * - Registry lifetime: a checkout-scoped module-level registry,
 *   per-isolate in-memory state with the documented loss semantics
 *   (an isolate recycle resets breakers to closed — fail-open on cold
 *   start). __resetCheckoutBreakerRegistry is the test seam. An
 *   injected registry (opts.registry) wins for tests.
 * - Retries: the breaker's default policy (3 attempts, exponential
 *   backoff with jitter, jitterRatio 0.25) is kept — each attempt is
 *   timeout-bounded, and the breaker counts ONE failure per execute,
 *   never per retry attempt. Mint retries are money-safe (an orphaned
 *   Stripe session expires uncompleted; nothing is credited without
 *   verified payment — the confirm re-reads provider state).
 * - Timeout: the race bounds the WAITER; the provider call may still
 *   complete server-side, so a timeout is recorded as unknown-outcome,
 *   never as proof the external action failed (tech-standards §13
 *   recovery truthfulness). The x402 adapter additionally aborts its
 *   fetch at the same configured timeout.
 * - Permanent failures (adapter input validation, cross-rail calls)
 *   neither retry nor count toward the trip threshold.
 *
 * Telemetry (15-factor): breaker state transitions and timeouts are
 * structured aspect events (logAspectEvent) — observable, countable,
 * carrying rail/operation/counts only, never user or tenant data.
 * Breaker state is provider-scoped infrastructure state, never
 * user-scoped.
 */
import {
  BreakerOpenError,
  createBreakerRegistry,
  type BreakerRegistry,
  type BreakerStateChangeEvent,
  type CircuitBreaker,
} from "../breakers/breakerPorts";
import { logAspectEvent } from "../aspects/loggingAspect";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import type {
  CardSessionEvidence,
  CheckoutCreation,
  CheckoutPort,
  CheckoutRail,
  CreateCheckoutInput,
  CryptoVerification,
} from "./checkoutPorts";
import {
  CheckoutPortBreakerOpenError,
  CheckoutPortTimeoutError,
  isPermanentCheckoutError,
} from "./checkoutPortErrors";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/checkoutPortGuard",
});

/** Per-rail breaker ids in the shared registry. */
export const CHECKOUT_BREAKER_IDS = {
  stripe: "checkout_stripe",
  x402: "checkout_x402",
} as const;

/** Code default for the per-call timeout (matches the x402 adapter's prior 10 s abort). */
export const DEFAULT_CHECKOUT_PORT_TIMEOUT_MS = 10_000;
const TIMEOUT_MIN_MS = 1_000;
const TIMEOUT_MAX_MS = 120_000;

export interface CheckoutPortGuardOptions {
  /** Operator-settings map (mas_settings values under checkout.* / breaker.checkout_*.*). */
  settings?: Record<string, string | undefined>;
  /** Injected registry (tests). Wins over the shared registry. */
  registry?: BreakerRegistry;
  /** Clock for the shared registry (tests). Only used at first creation. */
  nowMs?: () => number;
  /** Retry sleep (tests inject a no-op so retries don't wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source (tests inject a fixed value for determinism). */
  rng?: () => number;
  /** Explicit timeout override (tests). Wins over env/settings resolution. */
  timeoutMs?: number;
}

function envValue(env: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = env?.[key];
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * Resolve the per-call timeout. Precedence (the pipelinePolicy /
 * breakerPorts pattern): code default < Worker env
 * (CHECKOUT_PORT_TIMEOUT_MS) < settings map (checkout.timeoutMs).
 * Invalid values are ignored with a log line — resolution never throws.
 */
export function resolveCheckoutPortTimeoutMs(
  env?: Record<string, unknown>,
  settings?: Record<string, string | undefined>,
): number {
  const raw = settings?.["checkout.timeoutMs"] ?? envValue(env, "CHECKOUT_PORT_TIMEOUT_MS");
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_CHECKOUT_PORT_TIMEOUT_MS;
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    structuredLog.warn("checkout.timeout_non_numeric", {
      message: `[checkoutPortGuard] ignoring non-numeric CHECKOUT_PORT_TIMEOUT_MS: ${String(raw).slice(0, 40)}`,
      raw: String(raw).slice(0, 40),
    });
    return DEFAULT_CHECKOUT_PORT_TIMEOUT_MS;
  }
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.trunc(n)));
}

let sharedRegistry: BreakerRegistry | undefined;

function getSharedCheckoutBreakerRegistry(
  opts: Pick<CheckoutPortGuardOptions, "settings" | "nowMs"> & { env?: Record<string, unknown> },
): BreakerRegistry {
  if (!sharedRegistry) {
    sharedRegistry = createBreakerRegistry({
      env: opts.env,
      settings: opts.settings,
      nowMs: opts.nowMs,
      onStateChange: (event: BreakerStateChangeEvent) => {
        logAspectEvent({
          aspect: "checkout-port-breaker",
          operationName: `breaker.${event.providerId}.state`,
          code: event.to === "open" ? "FAILURE_CHECKOUT_PORT_BREAKER_OPEN" : undefined,
          level: event.to === "open" ? "warn" : "info",
          message: `Checkout breaker ${event.providerId} ${event.from} → ${event.to} (trips ${event.trips}).`,
          metadata: {
            providerId: event.providerId,
            from: event.from,
            to: event.to,
            trips: event.trips,
            fallbacks: event.fallbacks,
          },
        });
      },
    });
  }
  return sharedRegistry;
}

/** Test seam: drop the shared registry (mirrors __resetDefaultBreakerRegistry). */
export function __resetCheckoutBreakerRegistry(): void {
  sharedRegistry = undefined;
}

type CheckoutOperation = "createCheckout" | "retrieveCardSession" | "verifyCryptoPayment";

/** Decorator: one CheckoutPort, timeout + breaker on every method. */
class GuardedCheckoutPort implements CheckoutPort {
  readonly rail: CheckoutRail;

  constructor(
    private readonly inner: CheckoutPort,
    private readonly breaker: CircuitBreaker,
    private readonly timeoutMs: number,
    private readonly sleep?: (ms: number) => Promise<void>,
    private readonly rng?: () => number,
  ) {
    this.rail = inner.rail;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutCreation> {
    return this.guard("createCheckout", () => this.inner.createCheckout(input));
  }

  async retrieveCardSession(input: { sessionId: string }): Promise<CardSessionEvidence> {
    return this.guard("retrieveCardSession", () => this.inner.retrieveCardSession(input));
  }

  async verifyCryptoPayment(input: {
    paymentProof: string;
    expectedAmountUSD: number;
  }): Promise<CryptoVerification> {
    return this.guard("verifyCryptoPayment", () => this.inner.verifyCryptoPayment(input));
  }

  private async guard<T>(operation: CheckoutOperation, fn: () => Promise<T>): Promise<T> {
    try {
      const outcome = await this.breaker.execute(() => this.callWithTimeout(operation, fn), {
        shouldRetry: (err) => !isPermanentCheckoutError(err),
        onRetry: (event) => {
          logAspectEvent({
            aspect: "checkout-port-breaker",
            operationName: `checkout.${this.rail}.${operation}`,
            level: "warn",
            message: `Retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms after: ${event.error}`,
            metadata: {
              rail: this.rail,
              operation,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
            },
          });
        },
        sleep: this.sleep,
        rng: this.rng,
      });
      return outcome.value;
    } catch (err) {
      if (err instanceof BreakerOpenError) {
        // Fast-fail while open is expected behavior, not an alarm: the
        // open transition itself is the warn-level event (onStateChange).
        logAspectEvent({
          aspect: "checkout-port-breaker",
          operationName: `breaker.${this.rail}.open`,
          code: "FAILURE_CHECKOUT_PORT_BREAKER_OPEN",
          level: "info",
          message: `Checkout ${this.rail} ${operation} rejected: circuit ${err.breakerState} (fail-fast, no provider call).`,
          metadata: { rail: this.rail, operation, breakerState: err.breakerState },
        });
        throw new CheckoutPortBreakerOpenError(this.rail, err.breakerState);
      }
      if (err instanceof CheckoutPortTimeoutError) {
        logAspectEvent({
          aspect: "checkout-port-breaker",
          operationName: `checkout.${this.rail}.${operation}`,
          code: "FAILURE_CHECKOUT_PORT_TIMEOUT",
          level: "warn",
          message: `Checkout ${this.rail} ${operation} timed out after ${this.timeoutMs}ms (outcome unknown).`,
          metadata: {
            rail: this.rail,
            operation,
            timeoutMs: this.timeoutMs,
            outcome: "unknown",
          },
        });
      }
      throw err;
    }
  }

  /**
   * Bound the waiter, not the provider call: the race rejects after
   * timeoutMs while the underlying call may still complete server-side
   * (hence the unknown-outcome recording above). The timer is cleared
   * on settle so a fast call leaves no dangling timer.
   */
  private async callWithTimeout<T>(operation: CheckoutOperation, fn: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CheckoutPortTimeoutError(this.rail, operation, this.timeoutMs)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * Wrap a checkout port with the timeout + breaker guard. The registry
 * is shared per isolate unless one is injected; the timeout resolves
 * from env/settings unless overridden.
 */
export function guardCheckoutPort(
  inner: CheckoutPort,
  opts: CheckoutPortGuardOptions & { env?: Record<string, unknown> } = {},
): CheckoutPort {
  const registry = opts.registry ?? getSharedCheckoutBreakerRegistry(opts);
  const breakerId =
    inner.rail === "stripe" ? CHECKOUT_BREAKER_IDS.stripe : CHECKOUT_BREAKER_IDS.x402;
  const breaker = registry.breakerFor(breakerId);
  const timeoutMs = opts.timeoutMs ?? resolveCheckoutPortTimeoutMs(opts.env, opts.settings);
  return new GuardedCheckoutPort(inner, breaker, timeoutMs, opts.sleep, opts.rng);
}
