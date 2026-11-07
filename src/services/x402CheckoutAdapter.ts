/**
 * Issue #2193 (slice 1, #2146) — the crypto adapter for the checkout
 * port. This is infrastructure, not domain: it mints 402 challenges
 * and verifies payment proofs against the x402 facilitator. It
 * holds no price, no coverage rule, and no confirm judgment — the
 * gate decides, from the verdict plus its own nonce/payer checks,
 * whether a run paid.
 *
 * RECIPIENT RULE (binding): the recipient address MUST be
 * explicitly configured (X402_RECIPIENT_ADDRESS). This adapter
 * NEVER constructs ETradeAgenticPaymentService and NEVER reads
 * its hardcoded recipient fallback: the challenge is built
 * directly from the constructor's recipient, and construction
 * throws when no valid recipient is supplied. An unconfigured
 * recipient means no x402 adapter exists at all (the composition
 * root returns null for the rail), and the gate fails closed.
 *
 * Facilitator verification mirrors the PaymentsAgent pattern
 * (src/agents/payments-agent.ts verifyWithFacilitator): simulated
 * proofs are rejected before any network call, malformed proofs
 * fail closed, and only an HTTP-OK response with isValid === true
 * verifies. The verify request additionally carries
 * paymentRequirements (exact scheme, this run's amount in atomic
 * USDC, payTo = the configured recipient), so a facilitator that
 * honors requirements binds the verdict to this run's amount and
 * recipient. Caveat, stated plainly: a facilitator that ignores
 * paymentRequirements would weaken the amount binding — the
 * on-chain claim check (src/services/x402Verifier.ts) is the
 * follow-up hardening for that case, not part of this slice.
 */
import type {
  CheckoutChallenge,
  CheckoutCreation,
  CheckoutPort,
  CheckoutRail,
  CreateCheckoutInput,
  CryptoVerification,
} from "./checkoutPorts";
import { resolveX402Network, usdToAtomic } from "./x402Networks";
import {
  CheckoutPortTimeoutError,
  CheckoutPortUsageError,
  CheckoutPortValidationError,
} from "./checkoutPortErrors";

export interface X402AdapterConfig {
  /** Explicitly configured USDC recipient. No fallback, ever. */
  recipientAddress: string;
  network?: string;
  facilitatorUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Facilitator verify timeout in ms (#3573: configuration, not a
   * hardcoded literal — the composition root threads the resolved
   * checkout-port timeout through; direct constructions keep the
   * prior 10 s default). The guard's race enforces the same bound
   * from outside; this signal frees the connection itself.
   */
  timeoutMs?: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class X402CheckoutAdapter implements CheckoutPort {
  readonly rail: CheckoutRail = "x402";
  private readonly recipient: string;
  private readonly network: string;
  private readonly facilitatorUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: X402AdapterConfig) {
    const recipient = (config.recipientAddress ?? "").trim();
    if (!ADDRESS_RE.test(recipient)) {
      throw new Error(
        "X402_RECIPIENT_ADDRESS must be explicitly configured as a valid address: refusing to build an x402 adapter without it (the hardcoded recipient fallback is forbidden on the screener path).",
      );
    }
    const network = (config.network ?? "base-sepolia").trim().toLowerCase();
    if (!resolveX402Network(network)) {
      throw new Error(`Refusing x402 on unknown network ${network}.`);
    }
    this.recipient = recipient;
    this.network = network;
    this.facilitatorUrl = (config.facilitatorUrl ?? "https://x402.org/facilitator").replace(/\/+$/, "");
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutCreation> {
    if (!Number.isFinite(input.priceUSD) || input.priceUSD <= 0) {
      throw new CheckoutPortValidationError(
        "Refusing to mint an x402 challenge without a positive per-run price.",
      );
    }
    const challenge: CheckoutChallenge = {
      version: "1.0",
      network: this.network,
      recipient: this.recipient,
      amountUSD: input.priceUSD,
      currency: "USDC",
      facilitator: this.facilitatorUrl,
      resource: `screener-run:${input.runRequestId}`,
      nonce: `n_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      expiresAtMs: Date.now() + 15 * 60 * 1000,
    };
    return { rail: "x402", checkoutId: input.runRequestId, challenge };
  }

  async retrieveCardSession(_input: { sessionId: string }): Promise<never> {
    throw new CheckoutPortUsageError("X402CheckoutAdapter cannot retrieve Stripe sessions: use the card adapter.");
  }

  async verifyCryptoPayment(input: { paymentProof: string; expectedAmountUSD: number }): Promise<CryptoVerification> {
    const denied: CryptoVerification = { verified: false, payer: null, nonce: null };
    try {
      const proof = input.paymentProof;
      if (!proof || typeof proof !== "string" || proof.length === 0 || proof.length > 100_000) return denied;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(Buffer.from(proof, "base64").toString("utf-8")) as Record<string, unknown>;
      } catch {
        try {
          parsed = JSON.parse(proof) as Record<string, unknown>;
        } catch {
          return denied;
        }
      }
      if (!parsed || typeof parsed !== "object") return denied;
      // Simulated proofs (issue #122) are never payments.
      if (parsed.simulated === true) return denied;
      if (typeof parsed.signature !== "string" || parsed.signature.length === 0) return denied;
      if (typeof parsed.payer !== "string" || parsed.payer.length === 0) return denied;
      if (!Number.isFinite(input.expectedAmountUSD) || input.expectedAmountUSD <= 0) return denied;
      const net = resolveX402Network(this.network);
      if (!net) return denied;
      const res = await this.fetchFn(`${this.facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 1,
          paymentPayload: parsed,
          paymentRequirements: {
            scheme: "exact",
            network: this.network,
            amount: usdToAtomic(input.expectedAmountUSD, net.usdcDecimals).toString(),
            payTo: this.recipient,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return denied;
      const data = (await res.json().catch(() => null)) as { isValid?: boolean } | null;
      if (data?.isValid !== true) return denied;
      return {
        verified: true,
        payer: parsed.payer,
        nonce: typeof parsed.nonce === "string" ? parsed.nonce : null,
      };
    } catch (err) {
      // A fetch abort is a timeout: unknown outcome, not proof of
      // non-payment — rethrow so the guard records it as such instead
      // of letting the caller read `denied` as "not paid". Every other
      // failure keeps returning denied (fail closed by value).
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new CheckoutPortTimeoutError("x402", "verifyCryptoPayment", this.timeoutMs);
      }
      return denied;
    }
  }
}
