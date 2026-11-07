// @vitest-environment node
/**
 * Issue #3573 — checkout-port bounded timeout + circuit breaker.
 *
 * TDD: these tests define the guard contract before the implementation
 * exists. The guard decorates a CheckoutPort (both rails) with:
 * - a bounded timeout per call (config, never a hardcoded literal) —
 *   a slow provider call rejects with CheckoutPortTimeoutError
 *   (outcome unknown, never proof the external action failed);
 * - a circuit breaker (the shared src/breakers/ state machine) —
 *   repeated failures trip it and later calls fail fast with
 *   CheckoutPortBreakerOpenError, without a provider call;
 * - half-open probing after the reset timeout.
 *
 * Permanent failures (adapter input validation, cross-rail calls)
 * neither retry nor count toward the trip threshold — an auth/config
 * failure is not an outage signal (breakerPorts contract).
 *
 * No network: Stripe fakes never resolve / always reject; the x402
 * facilitator fetch is stubbed. The breaker clock is injected; the
 * retry sleep is a no-op and the jitter rng is fixed, so timing
 * assertions are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StripeCheckoutAdapter, type StripeCheckoutClient } from "../src/services/stripeCheckoutAdapter";
import { X402CheckoutAdapter } from "../src/services/x402CheckoutAdapter";
import { createCheckoutPorts } from "../src/services/createCheckoutPorts";
import {
  guardCheckoutPort,
  resolveCheckoutPortTimeoutMs,
  __resetCheckoutBreakerRegistry,
  DEFAULT_CHECKOUT_PORT_TIMEOUT_MS,
} from "../src/services/checkoutPortGuard";
import {
  CheckoutPortBreakerOpenError,
  CheckoutPortTimeoutError,
  CheckoutPortUsageError,
  CheckoutPortValidationError,
  isCheckoutPortGuardError,
} from "../src/services/checkoutPortErrors";
import { createBreakerRegistry, type BreakerRegistry } from "../src/breakers/breakerPorts";
import { codedMessage, resolveOutcome } from "../src/outcomes/outcomeAspects";
import type { CheckoutPort } from "../src/services/checkoutPorts";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NOOP_SLEEP = async () => {};
const FIXED_RNG = () => 0.5;

function hangingStripeClient(): StripeCheckoutClient & { calls: number } {
  const state = { calls: 0 };
  const hang = () => {
    state.calls += 1;
    return new Promise<never>(() => {});
  };
  return {
    get calls() {
      return state.calls;
    },
    createCheckout: () => hang().then((v) => v as unknown as { success: boolean; checkoutUrl: string; gatewayRef: string }),
    retrieveSession: () => hang(),
  };
}

function failingStripeClient(): StripeCheckoutClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    createCheckout: async () => {
      calls += 1;
      throw new Error("stripe boom");
    },
    retrieveSession: async () => {
      calls += 1;
      throw new Error("stripe boom");
    },
  };
}

function flakyStripeClient(failuresBeforeSuccess: number): StripeCheckoutClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    createCheckout: async (params: { draftId: string; amount: number }) => {
      calls += 1;
      if (calls <= failuresBeforeSuccess) throw new Error("stripe boom");
      return { success: true, checkoutUrl: `https://checkout.example/session/${params.draftId}`, gatewayRef: `cs_test_${params.draftId}` };
    },
    retrieveSession: async (sessionId: string) => {
      calls += 1;
      if (calls <= failuresBeforeSuccess) throw new Error("stripe boom");
      return {
        id: sessionId,
        status: "complete",
        payment_status: "paid",
        amount_total: 10,
        client_reference_id: "run-1",
        payment_intent: "pi_test_run-1",
      };
    },
  };
}

function goodStripeClient(): StripeCheckoutClient {
  return {
    createCheckout: async (params) => ({
      success: true,
      checkoutUrl: `https://checkout.example/session/${params.draftId}`,
      gatewayRef: `cs_test_${params.draftId}`,
    }),
    retrieveSession: async (sessionId) => ({
      id: sessionId,
      status: "complete",
      payment_status: "paid",
      amount_total: 10,
      client_reference_id: "run-1",
      payment_intent: "pi_test_run-1",
    }),
  };
}

/** Isolated registry with an injected clock and a short trip policy for tests. */
function testRegistry(nowMs: () => number, env: Record<string, unknown> = {}): BreakerRegistry {
  return createBreakerRegistry({
    nowMs,
    env: {
      BREAKER_CHECKOUT_STRIPE_FAILURE_THRESHOLD: "2",
      BREAKER_CHECKOUT_STRIPE_RESET_TIMEOUT_MS: "100",
      BREAKER_CHECKOUT_STRIPE_HALF_OPEN_PROBES: "1",
      BREAKER_CHECKOUT_X402_FAILURE_THRESHOLD: "2",
      BREAKER_CHECKOUT_X402_RESET_TIMEOUT_MS: "100",
      BREAKER_CHECKOUT_X402_HALF_OPEN_PROBES: "1",
      ...env,
    },
  });
}

function guardStripe(
  client: StripeCheckoutClient,
  registry: BreakerRegistry,
  timeoutMs = 50,
): CheckoutPort {
  return guardCheckoutPort(new StripeCheckoutAdapter(client), {
    registry,
    timeoutMs,
    sleep: NOOP_SLEEP,
    rng: FIXED_RNG,
  });
}

describe("checkout port guard (#3573)", () => {
  beforeEach(() => {
    __resetCheckoutBreakerRegistry();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetCheckoutBreakerRegistry();
  });

  it("catalog: the timeout and breaker-open codes resolve as retryable 503s", () => {
    for (const code of ["FAILURE_CHECKOUT_PORT_TIMEOUT", "FAILURE_CHECKOUT_PORT_BREAKER_OPEN"]) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved).toBe(true);
      expect(resolved.entry?.outcome).toBe("failure");
      expect(resolved.entry?.httpStatus).toBe(503);
      expect(resolved.entry?.retryable).toBe(true);
      expect(resolved.entry?.category).toBe("commercial");
      expect(codedMessage(code)).toBe(`[${code}] ${resolved.entry?.businessMessage}`);
    }
  });

  it("config: timeout defaults to 10s, env overrides, invalid values fall back to the default", () => {
    expect(DEFAULT_CHECKOUT_PORT_TIMEOUT_MS).toBe(10_000);
    expect(resolveCheckoutPortTimeoutMs()).toBe(10_000);
    expect(resolveCheckoutPortTimeoutMs({ CHECKOUT_PORT_TIMEOUT_MS: "2500" })).toBe(2500);
    expect(resolveCheckoutPortTimeoutMs({}, { "checkout.timeoutMs": "3000" })).toBe(3000);
    expect(resolveCheckoutPortTimeoutMs({ CHECKOUT_PORT_TIMEOUT_MS: "not-a-number" })).toBe(10_000);
    expect(resolveCheckoutPortTimeoutMs({ CHECKOUT_PORT_TIMEOUT_MS: "5" })).toBe(1000);
    expect(resolveCheckoutPortTimeoutMs({ CHECKOUT_PORT_TIMEOUT_MS: "999999" })).toBe(120_000);
  });

  it("timeout: a hanging retrieve rejects with the typed timeout error, bounded (no hang)", async () => {
    const registry = testRegistry(() => Date.now());
    const port = guardStripe(hangingStripeClient(), registry, 50);
    const start = Date.now();
    const err = await port.retrieveCardSession({ sessionId: "cs_test_run-1" }).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(err).toBeInstanceOf(CheckoutPortTimeoutError);
    expect((err as CheckoutPortTimeoutError).outcomeCode).toBe("FAILURE_CHECKOUT_PORT_TIMEOUT");
    expect((err as CheckoutPortTimeoutError).rail).toBe("stripe");
    expect(isCheckoutPortGuardError(err)).toBe(true);
  });

  it("timeout: a hanging createCheckout rejects with the typed timeout error", async () => {
    const registry = testRegistry(() => Date.now());
    const port = guardStripe(hangingStripeClient(), registry, 50);
    await expect(
      port.createCheckout({ runRequestId: "run-1", priceUSD: 0.1, email: "u@example.com", userId: "u1" }),
    ).rejects.toBeInstanceOf(CheckoutPortTimeoutError);
  });

  it("timeout: a hanging x402 facilitator verify rejects with the timeout error, not a denied verdict", async () => {
    const neverFetch = (() => new Promise<never>(() => {})) as unknown as typeof fetch;
    const adapter = new X402CheckoutAdapter({
      recipientAddress: RECIPIENT,
      fetchFn: neverFetch,
      timeoutMs: 50,
    });
    const registry = testRegistry(() => Date.now());
    const port = guardCheckoutPort(adapter, { registry, timeoutMs: 50, sleep: NOOP_SLEEP, rng: FIXED_RNG });
    const proof = Buffer.from(JSON.stringify({ signature: "0xsig", payer: "0x2222222222222222222222222222222222222222" })).toString("base64");
    await expect(
      port.verifyCryptoPayment({ paymentProof: proof, expectedAmountUSD: 0.1 }),
    ).rejects.toBeInstanceOf(CheckoutPortTimeoutError);
  });

  it("breaker: repeated provider failures trip the breaker and later calls fail fast without a provider call", async () => {
    const registry = testRegistry(() => Date.now());
    const client = failingStripeClient();
    const port = guardStripe(client, registry, 1000);
    // Two consecutive failed executes trip the threshold-2 breaker.
    await expect(port.retrieveCardSession({ sessionId: "cs_test_a" })).rejects.toThrow("stripe boom");
    await expect(port.retrieveCardSession({ sessionId: "cs_test_b" })).rejects.toThrow("stripe boom");
    const callsAfterTrip = client.calls;
    expect(callsAfterTrip).toBeGreaterThan(0);
    const err = await port.retrieveCardSession({ sessionId: "cs_test_c" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CheckoutPortBreakerOpenError);
    expect((err as CheckoutPortBreakerOpenError).outcomeCode).toBe("FAILURE_CHECKOUT_PORT_BREAKER_OPEN");
    expect(isCheckoutPortGuardError(err)).toBe(true);
    // Fail-fast: no further provider call was made.
    expect(client.calls).toBe(callsAfterTrip);
  });

  it("breaker: after the reset timeout the half-open probe succeeds and the breaker closes", async () => {
    let now = 1_000_000;
    const registry = testRegistry(() => now);
    const client = flakyStripeClient(2 * 3); // 2 failed executes x 3 retry attempts each
    const port = guardStripe(client, registry, 1000);
    await expect(port.retrieveCardSession({ sessionId: "cs_test_a" })).rejects.toThrow("stripe boom");
    await expect(port.retrieveCardSession({ sessionId: "cs_test_b" })).rejects.toThrow("stripe boom");
    // Tripped: fast-fail without a provider call.
    const callsAfterTrip = client.calls;
    await expect(port.retrieveCardSession({ sessionId: "cs_test_c" })).rejects.toBeInstanceOf(
      CheckoutPortBreakerOpenError,
    );
    expect(client.calls).toBe(callsAfterTrip);
    // Advance past the 100ms reset timeout: the next call probes and succeeds.
    now += 150;
    const evidence = await port.retrieveCardSession({ sessionId: "cs_test_d" });
    expect(evidence.status).toBe("complete");
    // Closed again: the following call goes through to the provider.
    const afterProbe = client.calls;
    await port.retrieveCardSession({ sessionId: "cs_test_e" });
    expect(client.calls).toBeGreaterThan(afterProbe);
  });

  it("breaker: a failed half-open probe re-opens the breaker", async () => {
    let now = 1_000_000;
    const registry = testRegistry(() => now);
    const client = failingStripeClient();
    const port = guardStripe(client, registry, 1000);
    await expect(port.retrieveCardSession({ sessionId: "cs_test_a" })).rejects.toThrow("stripe boom");
    await expect(port.retrieveCardSession({ sessionId: "cs_test_b" })).rejects.toThrow("stripe boom");
    now += 150;
    // Probe fails: breaker re-opens, next call fast-fails.
    await expect(port.retrieveCardSession({ sessionId: "cs_test_c" })).rejects.toThrow("stripe boom");
    const callsAfterReopen = client.calls;
    await expect(port.retrieveCardSession({ sessionId: "cs_test_d" })).rejects.toBeInstanceOf(
      CheckoutPortBreakerOpenError,
    );
    expect(client.calls).toBe(callsAfterReopen);
  });

  it("breaker: validation errors never trip the breaker", async () => {
    const registry = testRegistry(() => Date.now());
    const port = guardStripe(goodStripeClient(), registry, 1000);
    for (let i = 0; i < 5; i++) {
      await expect(port.retrieveCardSession({ sessionId: "" })).rejects.toBeInstanceOf(
        CheckoutPortValidationError,
      );
    }
    // Still closed: a good call goes through.
    const evidence = await port.retrieveCardSession({ sessionId: "cs_test_run-1" });
    expect(evidence.status).toBe("complete");
  });

  it("breaker: cross-rail calls never trip the breaker", async () => {
    const registry = testRegistry(() => Date.now());
    const port = guardStripe(goodStripeClient(), registry, 1000);
    for (let i = 0; i < 5; i++) {
      await expect(
        port.verifyCryptoPayment({ paymentProof: "x", expectedAmountUSD: 0.1 }),
      ).rejects.toBeInstanceOf(CheckoutPortUsageError);
    }
    const evidence = await port.retrieveCardSession({ sessionId: "cs_test_run-1" });
    expect(evidence.status).toBe("complete");
  });

  it("guard: a successful call still returns the provider evidence unchanged", async () => {
    const registry = testRegistry(() => Date.now());
    const port = guardStripe(goodStripeClient(), registry, 1000);
    const evidence = await port.retrieveCardSession({ sessionId: "cs_test_run-1" });
    expect(evidence).toEqual({
      sessionId: "cs_test_run-1",
      status: "complete",
      paymentStatus: "paid",
      amountTotalCents: 10,
      clientReferenceId: "run-1",
      paymentIntentId: "pi_test_run-1",
      checkoutUrl: undefined,
    });
    const created = await port.createCheckout({
      runRequestId: "run-1",
      priceUSD: 0.1,
      email: "u@example.com",
      userId: "u1",
    });
    expect(created.rail).toBe("stripe");
    expect(created.checkoutId).toBe("cs_test_run-1");
  });

  it("composition: createCheckoutPorts returns a guarded x402 port (timeout via env)", async () => {
    const neverFetch = (() => new Promise<never>(() => {})) as unknown as typeof fetch;
    vi.stubGlobal("fetch", neverFetch);
    const ports = createCheckoutPorts(
      {
        X402_RECIPIENT_ADDRESS: RECIPIENT,
        X402_NETWORK: "base-sepolia",
        // Env resolution clamps to a 1 s floor, so 1000 ms is the
        // smallest env timeout: 3 attempts x 1000 ms, retries instant
        // (no-op sleep), hence the < 4000 ms bound.
        CHECKOUT_PORT_TIMEOUT_MS: "1000",
      },
      { sleep: NOOP_SLEEP, rng: FIXED_RNG },
    );
    expect(ports?.x402).not.toBeNull();
    const proof = Buffer.from(JSON.stringify({ signature: "0xsig", payer: "0x2222222222222222222222222222222222222222" })).toString("base64");
    const start = Date.now();
    await expect(
      ports!.x402!.verifyCryptoPayment({ paymentProof: proof, expectedAmountUSD: 0.1 }),
    ).rejects.toBeInstanceOf(CheckoutPortTimeoutError);
    expect(Date.now() - start).toBeLessThan(4000);
  });
});
