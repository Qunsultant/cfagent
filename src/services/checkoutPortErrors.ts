/**
 * Issue #3573 — typed errors for the checkout-port guard.
 *
 * Pure error classes (no imports at runtime beyond types): the guard,
 * the adapters, and the routes all classify on these, never on error
 * message strings. Every error carries a fixed generic message — no
 * provider text ever reaches a client through one of these.
 *
 * - CheckoutPortTimeoutError: the provider call exceeded the configured
 *   timeout. The outcome is UNKNOWN (the external action may still have
 *   completed server-side) — never proof the payment failed. Carries the
 *   catalog code FAILURE_CHECKOUT_PORT_TIMEOUT.
 * - CheckoutPortBreakerOpenError: the per-rail circuit breaker is open
 *   (or a half-open probe slot is busy); the call was rejected WITHOUT
 *   a provider call (fail-fast). Carries FAILURE_CHECKOUT_PORT_BREAKER_OPEN.
 * - CheckoutPortValidationError / CheckoutPortUsageError: permanent
 *   caller errors (bad input, cross-rail method call). The guard's
 *   shouldRetry returns false for these, so they neither retry nor count
 *   toward the trip threshold — an auth/config/caller failure is not an
 *   outage signal (breakerPorts contract). They carry no catalog code:
 *   they name a caller bug, not a provider outcome.
 */
import type { CheckoutRail } from "./checkoutPorts";
import type { BreakerState } from "../breakers/breakerPorts";

export class CheckoutPortTimeoutError extends Error {
  readonly outcomeCode = "FAILURE_CHECKOUT_PORT_TIMEOUT";
  constructor(
    readonly rail: CheckoutRail,
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Checkout ${rail} ${operation} timed out after ${timeoutMs}ms (outcome unknown).`,
    );
    this.name = "CheckoutPortTimeoutError";
  }
}

export class CheckoutPortBreakerOpenError extends Error {
  readonly outcomeCode = "FAILURE_CHECKOUT_PORT_BREAKER_OPEN";
  constructor(
    readonly rail: CheckoutRail,
    readonly breakerState: BreakerState,
  ) {
    super(
      `Checkout ${rail} temporarily unavailable (circuit ${breakerState}); try again shortly.`,
    );
    this.name = "CheckoutPortBreakerOpenError";
  }
}

export class CheckoutPortValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutPortValidationError";
  }
}

export class CheckoutPortUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutPortUsageError";
  }
}

/** True for the two guard failures the routes map to coded 503s. */
export function isCheckoutPortGuardError(
  err: unknown,
): err is CheckoutPortTimeoutError | CheckoutPortBreakerOpenError {
  return err instanceof CheckoutPortTimeoutError || err instanceof CheckoutPortBreakerOpenError;
}

/** True for permanent caller errors: never retried, never counted toward a trip. */
export function isPermanentCheckoutError(err: unknown): boolean {
  return err instanceof CheckoutPortValidationError || err instanceof CheckoutPortUsageError;
}
