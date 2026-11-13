/**
 * Cloudflare Agentic Payments Service (x402 & Machine Payments Protocol - MPP)
 * Based on Cloudflare Agents SDK Payments Documentation:
 * https://developers.cloudflare.com/agents/tools/payments/
 *
 * Implements:
 * 1. HTTP 402 Payment Required negotiation for monetized AI agent resources
 * 2. x402 Protocol specification (Coinbase & Cloudflare Foundation):
 *    - PAYMENT-REQUIRED challenge header
 *    - PAYMENT-SIGNATURE client proof header
 *    - PAYMENT-RESPONSE server receipt header
 * 3. Machine Payments Protocol (MPP / mppx) specification:
 *    - WWW-Authenticate: Payment challenge header
 *    - Authorization: Payment credential header
 *    - Payment-Receipt confirmation header
 * 4. Dual role:
 *    - Provider: Monetizes Options Screener ($0.05), Equity Research ($0.10), and Quantitative Signals ($0.02)
 *    - Consumer: Outbound agent spending on external feeds with strict Human-in-the-Loop (HITL) safety limit
 * 5. Full financial ledger persistence in SQLite (mas_transactions & mas_events) with Agent DID cryptographic attestation
 */

import type {
  Env,
  X402PaymentChallenge,
  X402PaymentProof,
  MppChallenge,
  MppPaymentProof,
  AgenticPaymentReceipt,
  AgenticWalletStatus,
  PaidTradingServiceTier,
  PaymentRequiredCallback,
  TransactionRecord,
} from "../types";
// NOTE (issue #290): mppx/server is node-only (it imports node:util, which the
// browser bundle cannot externalize). It is loaded lazily inside createMppx()
// so that modules which (transitively) import this service — including the
// trading boundary index src/trading/index.ts, imported by client code — stay
// importable from browser bundles. Behavior is unchanged: the module loads on
// first MPP use, exactly as it did at startup before.
type MppxServer = typeof import("mppx/server");
let mppxServerPromise: Promise<MppxServer> | undefined;
function loadMppxServer(): Promise<MppxServer> {
  // mppx/server is node-only (it imports node:util) and is marked external in
  // vite.config.ts so the browser bundle never includes it. The worker build
  // (wrangler/esbuild) does not read the vite config and bundles it normally.
  // This executes only inside MPP payment flows, which are server-side.
  if (!mppxServerPromise) mppxServerPromise = import("mppx/server");
  return mppxServerPromise;
}
type MppxRoot = typeof import("mppx");
let mppxRootPromise: Promise<MppxRoot> | undefined;
function loadMppxRoot(): Promise<MppxRoot> {
  // Issue #700: the mppx ROOT module is loaded lazily for the same #290
  // reason — Credential.fromRequest lives only on the root (mppx/server
  // does not re-export it), and a static import would drag the root's
  // module graph into browser bundles through the same transitive path.
  // "mppx" is marked external in vite.config.ts alongside "mppx/server";
  // the worker build bundles it normally. This executes only inside MPP
  // payment flows, which are server-side.
  if (!mppxRootPromise) mppxRootPromise = import("mppx");
  return mppxRootPromise;
}
import { DatabaseORM } from "../orm";
import { AGENT_DIDS } from "../agents/did";
import { verifyOnChainClaim, type X402ClaimVerifier } from "./x402Verifier";
import { describeX402PaymentPath } from "./x402PaymentPath";
import {
  buildMeteredCallEvent,
  meteredGateRefusal,
  resolveMeteredTier,
  type MeteredGateOptions,
} from "./meteredPaymentGate";
import type { StoreTier } from "../data/commercialPorts";
import {
  createBucketPorts,
  isBucketPortsEnabled,
} from "../data/createBucketPorts";
import type { BucketFamilyPorts } from "../data/bucketPorts";
import { consumeStoreKey, createStoreKv, type DoNamespaceLike } from "../data/durableKv";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/agenticPayments",
});

// Fallback replay guard used only when no SessionStore namespace is bound.
const consumedTxHashes = new Set<string>();

/**
 * Issue #122: this service's wallet is a LOCAL LEDGER simulation. It never
 * reads an on-chain balance: the balance is a local starting credit plus or
 * minus locally recorded ledger entries. These constants name that honestly
 * and are surfaced on AgenticWalletStatus so every consumer renders the
 * balance as what it is.
 */
export const AGENTIC_WALLET_STARTING_CREDIT_USD = 50.0;
export const AGENTIC_WALLET_BALANCE_SOURCE = "local-ledger" as const;
export const AGENTIC_WALLET_SIMULATED_NOTE =
  "Simulated local-ledger balance: a $50.00 local starting credit plus/minus locally recorded agentic payment entries. This service does not read any on-chain wallet balance.";
/** Signature-field value used on simulated proofs: deliberately NOT shaped like a cryptographic signature. */
export const SIMULATED_PROOF_SIGNATURE = "SIMULATED_UNSIGNED_PROOF_NO_SIGNATURE";

/**
 * Issue #183: the persisted-state scope for a VERIFIED agentic payment.
 * Anonymous premium traffic is served by a shared gateway instance, so
 * its ledger rows and audit events must NOT be stamped with that shared
 * instance identity (every payer would pool into one wallet) and must
 * NEVER carry a caller-asserted login. The only identity a verified
 * payment actually proves is the payer, so payer-bound state is scoped
 * `x402:<payer>` — one scope per verified payer, derived from the
 * receipt the claim verifier produced, never from a header.
 */
export function payerScopeId(payer: string): string {
  return `x402:${payer}`;
}

/**
 * Catalogue of Paid Trading Services offered by E*TRADE Trading Agent
 */
export const TRADING_PAID_SERVICES: Record<string, PaidTradingServiceTier> = {
  OPTIONS_SCREENER: {
    id: "options_screener",
    resource: "/api/premium/options-scan",
    name: "E*TRADE Institutional Options & Greeks Screener",
    description: "Deep options screening with Delta, Gamma, Theta, IV percentile, and volume/OI flow analysis.",
    priceUSD: 0.05,
    rateLimitPerMin: 60,
  },
  MARKET_RESEARCH: {
    id: "market_research",
    resource: "/api/premium/market-research",
    name: "E*TRADE Autonomous Equity Research Report",
    description: "Multi-ticker valuation metrics, fundamentals, and algorithmic trade signals with DID proof.",
    priceUSD: 0.10,
    rateLimitPerMin: 30,
  },
  STOCK_SIGNALS: {
    id: "stock_signals",
    resource: "/api/premium/stock-signals",
    name: "Real-Time Quant Anomaly Signals",
    description: "Live capital flow anomaly detection, unusual volume, and momentum breakouts.",
    priceUSD: 0.02,
    rateLimitPerMin: 120,
  },
};

export class ETradeAgenticPaymentService {
  private network: string;
  private recipient: string;
  private facilitatorUrl: string;
  private autoApproveLimitUSD: number;
  private agentWalletAddress: string;
  private mppSecretKey?: string;

  constructor(
    private orm: DatabaseORM | undefined,
    private env: Env | undefined,
    // Issue #1185: the instance/session identity is explicit at every
    // construction site — no synthetic shared default.
    private sessionId: string,
    private claimVerifier: X402ClaimVerifier = verifyOnChainClaim,
    /**
     * Issue #183: payer-bound mode is used for anonymous premium traffic
     * (the worker's premium-gateway instance). In this mode, persisted
     * payment state is scoped by the VERIFIED payer (see payerScopeId)
     * instead of this.sessionId, so anonymous payers never pool into one
     * shared ledger identity. Session (per-user instance) traffic leaves
     * this off: its instance identity already IS the user's.
     */
    private identityOptions: { payerBound?: boolean } = {}
  ) {
    // Issue #1185: fail closed — no session identity, no service.
    if (!this.sessionId) {
      throw new Error("AgenticPaymentsService requires an explicit sessionId (the verified caller identity; issue #1185: no default identity).");
    }
    this.network = this.env?.X402_NETWORK || "base-sepolia";
    this.recipient =
      this.env?.X402_RECIPIENT_ADDRESS || "0x71C8363837918a211797E3c76A8B3C4258759550";
    this.facilitatorUrl = this.env?.X402_FACILITATOR_URL || "https://x402.org/facilitator";
    this.autoApproveLimitUSD = Number(this.env?.X402_AUTO_APPROVE_LIMIT || 0.05);
    // Issue #183: a limit previously set for this identity overrides the
    // env default — setAutoApproveLimit persists per identity (below),
    // and services are constructed per request, so the constructor is
    // where a fresh instance picks the persisted value back up.
    const persistedLimit = this.loadPersistedAutoApproveLimit();
    if (persistedLimit !== undefined) this.autoApproveLimitUSD = persistedLimit;
    // Gitleaks gate (#691): no hardcoded wallet fallback. The value below is
    // an address, not a signing key (this service holds no key — see
    // signPaymentProof's simulated note), but a synthetic default address
    // would let the service act under an identity nobody configured, and it
    // trips secret scans. Unconfigured → "" and the action paths fail
    // closed (see signPaymentProof).
    this.agentWalletAddress = this.env?.X402_AGENT_WALLET_KEY || "";
    this.mppSecretKey = this.env?.MPP_SECRET_KEY;
  }

  /** Issue #183: true when this service serves anonymous (gateway) premium traffic. */
  get payerBound(): boolean {
    return this.identityOptions.payerBound === true;
  }

  /**
   * Issue #183: the sessionId stamp for persisted payment state. In
   * payer-bound mode with a receipt, that is the verified payer's scope;
   * otherwise the service's own instance identity.
   */
  private stampForReceipt(receipt?: AgenticPaymentReceipt): string {
    if (this.payerBound && receipt) return payerScopeId(receipt.payer);
    return this.sessionId;
  }

  // =========================================================================
  // 1. Server-Side Provider: HTTP 402 Challenge Generation & Verification
  // =========================================================================

  /**
   * Extract nonce from x402 PAYMENT-SIGNATURE proof
   */
  extractNonce(sigOrHeaders?: string | null | Headers | Record<string, string>): string | undefined {
    if (!sigOrHeaders) return undefined;
    let rawStr = "";
    if (typeof sigOrHeaders === "string") {
      rawStr = sigOrHeaders;
    } else if (sigOrHeaders instanceof Headers) {
      rawStr = sigOrHeaders.get("PAYMENT-SIGNATURE") || sigOrHeaders.get("payment-signature") || "";
    } else if (typeof sigOrHeaders === "object") {
      rawStr = (sigOrHeaders as any)["PAYMENT-SIGNATURE"] || (sigOrHeaders as any)["payment-signature"] || "";
    }

    if (!rawStr) return undefined;

    try {
      let parsed: any;
      try {
        parsed = JSON.parse(Buffer.from(rawStr, "base64").toString("utf-8"));
      } catch {
        parsed = JSON.parse(rawStr);
      }
      return parsed.nonce ? String(parsed.nonce) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Create an x402-compliant payment challenge
   */
  createX402Challenge(
    resource: string,
    priceUSD: number = 0.05,
    description: string = "E*TRADE Trading Intelligence Access",
    nonce?: string
  ): X402PaymentChallenge {
    const finalNonce = nonce || `n_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes TTL

    return {
      version: "1.0",
      network: this.network,
      recipient: this.recipient,
      amount: priceUSD,
      currency: "USDC",
      facilitator: this.facilitatorUrl,
      description,
      resource,
      nonce: finalNonce,
      expiresAt,
    };
  }

  /**
   * Create an MPP-compliant payment challenge
   */
  createMppChallenge(
    resource: string,
    priceUSD: number = 0.05,
    description: string = "E*TRADE Trading Intelligence Access"
  ): MppChallenge {
    return {
      protocol: "mpp",
      method: "tempo",
      amount: priceUSD.toFixed(2),
      currency: "0x20c0000000000000000000000000000000000000", // Standard USDC Contract Identifier
      recipient: this.recipient,
      description,
      realm: resource,
      testnet: this.network.includes("sepolia") || this.network.includes("test"),
    };
  }

  /**
   * Encode x402 challenge into standard PAYMENT-REQUIRED HTTP header
   */
  formatX402ChallengeHeader(challenge: X402PaymentChallenge): string {
    return Buffer.from(JSON.stringify(challenge)).toString("base64");
  }

  /**
   * Encode MPP challenge into standard WWW-Authenticate HTTP header
   */
  formatMppChallengeHeader(challenge: MppChallenge): string {
    return `Payment method="${challenge.method}", amount="${challenge.amount}", currency="${challenge.currency}", recipient="${challenge.recipient}", description="${encodeURIComponent(challenge.description)}"`;
  }

  /**
   * Generate an HTTP 402 Payment Required response carrying x402 and MPP challenges
   */
  createPaymentRequiredResponse(
    challenge: X402PaymentChallenge,
    mppChallenge?: MppChallenge,
    reason?: string
  ): Response {
    const mpp = mppChallenge || this.createMppChallenge(challenge.resource, challenge.amount, challenge.description);
    const x402HeaderVal = this.formatX402ChallengeHeader(challenge);
    const mppHeaderVal = this.formatMppChallengeHeader(mpp);

    // Record challenge audit event
    if (this.orm?.events) {
      this.orm.events.create({
        id: `evt_402_${Date.now()}`,
        // Issue #183: a challenge is issued BEFORE any payment exists, so
        // in payer-bound (anonymous gateway) mode there is no verified
        // payer to scope it to yet. Key the event by the challenge's own
        // nonce — unique per challenge, traceable to the verified
        // payment that later presents a proof carrying the same nonce —
        // never by an asserted login or the shared gateway identity.
        // The verified payment itself is payer-scoped (recordPaymentTransaction).
        sessionId: this.payerBound ? `x402:challenge:${challenge.nonce}` : this.sessionId,
        type: "AGENTIC_PAYMENT_CHALLENGE",
        agent: "trading",
        payload: {
          resource: challenge.resource,
          amount: challenge.amount,
          currency: challenge.currency,
          recipient: challenge.recipient,
          network: challenge.network,
          nonce: challenge.nonce,
        },
        createdAt: new Date().toISOString(),
      });
    }

    const body = {
      error: "Payment Required",
      statusCode: 402,
      message: `Access to ${challenge.resource} requires an agentic payment of $${challenge.amount.toFixed(2)} ${challenge.currency}.`,
      // #2406 (Phase 1.1): per-path real-vs-simulated labeling — the
      // inbound x402 path is an on-chain transfer path, testnet when the
      // network is a testnet (base-sepolia default: testnet funds, no
      // real money). This is a path label, not a verification claim:
      // the payment itself is verified per request by verifyPayment.
      // The simulated local-ledger path is never labeled this way —
      // see describeX402PaymentPath and the #122 simulated rejection.
      paymentPath: describeX402PaymentPath(challenge.network),
      protocols: {
        x402: {
          header: "PAYMENT-SIGNATURE",
          challenge,
        },
        mpp: {
          header: "Authorization: Payment",
          challenge: mpp,
        },
      },
      ...(reason ? { reason } : {}),
      facilitator: challenge.facilitator,
      timestamp: new Date().toISOString(),
    };

    return new Response(JSON.stringify(body, null, 2), {
      status: 402,
      statusText: "Payment Required",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": x402HeaderVal,
        ...(reason ? { "X-Payment-Error": reason.replace(/[^\x20-\x7e]/g, " ").slice(0, 200) } : {}),
        "WWW-Authenticate": mppHeaderVal,
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt, X-Payment-Error",
      },
    });
  }

  /**
   * Issue #2436 (#1976 step 5e): the residual bucket family
   * composition for this service's claims, when
   * BUCKET_PORTS_ENABLED is on; null when off (the direct
   * funnel composition below serves, unchanged).
   */
  private bucketPorts(): BucketFamilyPorts | null {
    return this.env && isBucketPortsEnabled(this.env)
      ? createBucketPorts(this.env)
      : null;
  }

  private async consumeTxHash(txHash: string): Promise<boolean> {
    const key = `x402tx:${txHash.toLowerCase()}`;
    // Issue #329 P3: this used to be a KV `get`-then-`put`, which two colos
    // could both win. The DO serialises the check and the claim.
    // Issue #2436: the claim is the named ClaimPort's consume
    // contract (Q-6) — flag-on composes through
    // src/data/createBucketPorts.ts; the three outcomes stay
    // distinct below: "duplicate" is a replay, "unavailable"
    // is NOT fresh (the isolate-local fallback decides).
    const ports = this.bucketPorts();
    const outcome = ports
      ? await ports.claims.consume(
          "payments",
          key,
          new Date().toISOString(),
          60 * 60 * 24 * 365
        )
      : await consumeStoreKey({
          namespace: this.env?.SESSION_STORE as unknown as DoNamespaceLike | undefined,
          namespaceName: "payments",
          key,
          value: new Date().toISOString(),
          ttlSeconds: 60 * 60 * 24 * 365,
        });

    if (outcome === "consumed") return true;
    if (outcome === "duplicate") return false;

    // Store unreachable: refuse rather than treat the payment as fresh. The
    // isolate-local set still catches repeats within this worker's lifetime.
    if (consumedTxHashes.has(key)) return false;
    consumedTxHashes.add(key);
    return true;
  }

  private async releaseTxHash(txHash: string): Promise<void> {
    const key = `x402tx:${txHash.toLowerCase()}`;
    // Issue #2436: flag-on releases through the ClaimPort's
    // release (the claim's named inverse); flag-off is the
    // direct funnel delete below, unchanged.
    const ports = this.bucketPorts();
    if (ports) {
      await ports.claims.release("payments", key);
    } else {
      await createStoreKv({
        namespace: this.env?.SESSION_STORE as unknown as DoNamespaceLike | undefined,
        namespaceName: "payments",
      }).delete(key);
    }
    consumedTxHashes.delete(key);
  }

  /**
   * Verify an incoming x402 or MPP payment signature
   */
  async verifyPayment(
    headers: Headers | Record<string, string>,
    challenge: X402PaymentChallenge | MppChallenge
  ): Promise<{ valid: boolean; receipt?: AgenticPaymentReceipt; reason?: string }> {
    const getHeader = (name: string): string | null => {
      if (headers instanceof Headers) return headers.get(name);
      return headers[name] || headers[name.toLowerCase()] || null;
    };

    const x402Sig = getHeader("PAYMENT-SIGNATURE") || getHeader("payment-signature");
    const mppAuth = getHeader("Authorization") || getHeader("authorization");

    // 1. Process x402 Payment Signature
    if (x402Sig) {
      try {
        let proof: X402PaymentProof;
        try {
          proof = JSON.parse(Buffer.from(x402Sig, "base64").toString("utf-8"));
        } catch {
          proof = JSON.parse(x402Sig);
        }

        if (!proof.signature || !proof.payer) {
          return { valid: false, reason: "Malformed PAYMENT-SIGNATURE: missing signature or payer address." };
        }

        // Issue #122: a locally produced simulated proof is not a payment and
        // must never be redeemable — reject it before any claim verification,
        // regardless of how the configured claim verifier would treat it.
        if (proof.simulated === true || proof.signature === SIMULATED_PROOF_SIGNATURE) {
          return { valid: false, reason: "Simulated payment proofs are not accepted as payment: no real payment was made. A verifiable on-chain payment is required." };
        }

        if (!("resource" in challenge) || !("nonce" in challenge)) {
          return { valid: false, reason: "x402 payments require an x402 challenge." };
        }
        if (proof.nonce !== challenge.nonce) {
          return { valid: false, reason: "Invalid nonce in PAYMENT-SIGNATURE: challenge mismatch." };
        }

        const claim = await this.claimVerifier({
          proof,
          resource: challenge.resource,
          amountUSD: challenge.amount,
          recipient: challenge.recipient,
          network: challenge.network,
        });
        if (!claim.ok) return { valid: false, reason: claim.reason };

        const txHash = claim.txHash;
        if (!(await this.consumeTxHash(txHash))) {
          return { valid: false, reason: "This payment transaction has already been used." };
        }        const receiptId = `rcpt_x402_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
        const amount = challenge.amount;

        const receipt: AgenticPaymentReceipt = {
          receiptId,
          protocol: "x402",
          resource: challenge.resource,
          amount,
          currency: challenge.currency,
          network: challenge.network,
          payer: proof.payer,
          recipient: this.recipient,
          status: "verified",
          txHash,
          signature: proof.signature,
          timestamp: new Date().toISOString(),
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid: `did:pkh:eip155:${proof.payer}`,
          note: `Verified on-chain: USDC transfer to recipient confirmed on ${challenge.network}.`,
        };

        // Persist transaction in SQLite
        try {
          await this.recordPaymentTransaction(receipt, "inbound");
        } catch (error) {
          await this.releaseTxHash(txHash);
          throw error;
        }

        return { valid: true, receipt };
      } catch (err: any) {
        return { valid: false, reason: `Failed to decode PAYMENT-SIGNATURE: ${err.message}` };
      }
    }

    // 2. MPP credentials are cryptographically verified by mppx in handleGatedEndpoint; never accept them from headers alone.
    if (mppAuth && mppAuth.toLowerCase().startsWith("payment ")) {
      return { valid: false, reason: "MPP credentials must be verified through the mppx gateway (handleGatedEndpoint)." };
    }
    return { valid: false, reason: "No payment credentials provided. Expected PAYMENT-SIGNATURE or Authorization: Payment." };
  }

  /**
   * Wrap an existing handler with automatic 402 gatekeeping and payment receipt injection.
   *
   * Issue #2408 (Phase 1.2): metering enforcement. When `metered`
   * is supplied, a verified payment is served only through the
   * meter: the tier is resolved (fail-closed default Free), the
   * fulfillment runs, and exactly one usage_event is inserted
   * BEFORE the result is served. A missing meter, a tier-store
   * failure, an invalid tier, or a meter failure refuses with a
   * typed error and serves nothing (the x402 tx hash is released,
   * as on fulfill failure, so the payer can retry). When `metered`
   * is absent the gate refuses served calls the same way — an
   * unmetered paid serve through this gate is impossible after
   * #2408; unpaid/failed payments keep their typed 402 either way.
   * The meter identity is attribution only, never entitlement:
   * entitlement is the verified payment itself.
   */
  async handleGatedEndpoint(
    req: Request,
    resource: string,
    priceUSD: number,
    description: string,
    fulfill: (receipt: AgenticPaymentReceipt) => Promise<any>,
    metered?: MeteredGateOptions
  ): Promise<Response> {
    const extractedNonce = this.extractNonce(req.headers);
    const challenge = this.createX402Challenge(resource, priceUSD, description, extractedNonce);

    const hasX402 = Boolean(req.headers.get("PAYMENT-SIGNATURE"));
    const hasMpp = /^payment\s/i.test(req.headers.get("Authorization") || "");
    if (hasMpp && !hasX402) {
      return this.handleMppRequest(req, resource, priceUSD, description, fulfill, metered);
    }

    // Verify if payment headers are attached
    const verification = await this.verifyPayment(req.headers, challenge);

    if (!verification.valid || !verification.receipt) {
      const required = this.createPaymentRequiredResponse(challenge, undefined, hasX402 ? verification.reason : undefined);
      const mppChallenge = await this.issueMppChallenge(req, priceUSD, description);
      if (mppChallenge) required.headers.set("WWW-Authenticate", mppChallenge);
      return required;
    }

    // Issue #2408: the meter is a gate condition. No meter, no serve.
    if (!metered?.meter) {
      structuredLog.error("agenticPayments.metered_gate_no_meter", {
        message: `[payments] metered gate refused ${resource}: no usage meter configured — nothing served.`,
        resource,
      });
      if (verification.receipt.txHash) await this.releaseTxHash(verification.receipt.txHash);
      return meteredGateRefusal(503, "MeteringUnavailable", "The usage meter is not configured for this paid endpoint; the paid result was not served.");
    }
    const meter = metered.meter;
    // Issue #2408: tier check at the gate. The identity is the
    // verified session login when the worker set it, else the
    // verified payer scope (#183) — the same rule the premium
    // routes use for fulfillment identity.
    const userLogin = req.headers.get("x-user-login") || payerScopeId(verification.receipt.payer);
    let tier: StoreTier;
    try {
      tier = await resolveMeteredTier(metered.resolveTier, userLogin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      structuredLog.error("agenticPayments.metered_gate_tier_resolution_failed", {
        message: `[payments] metered gate refused ${resource}: tier resolution failed: ${message}`,
        resource,
        error: message,
      });
      if (verification.receipt.txHash) await this.releaseTxHash(verification.receipt.txHash);
      // assertStoreTier's message is the only invalid-tier source
      // here; anything else is a tier-store failure.
      if (message.startsWith("Invalid tier:")) {
        return meteredGateRefusal(500, "TierInvalid", `The stored tier for this caller is invalid; the paid result was not served. (${message})`);
      }
      return meteredGateRefusal(503, "TierUnavailable", "The tier store could not be read; the paid result was not served.");
    }

    // Payment is valid: Fulfill the premium data
    let result: any;
    try {
      result = await fulfill(verification.receipt);
    } catch (error) {
      if (verification.receipt.txHash) await this.releaseTxHash(verification.receipt.txHash);
      throw error;
    }

    // Issue #2408: meter the SERVED call only, before serving it.
    // A meter failure refuses with a typed error — the computed
    // result is discarded, never served unmetered — and releases
    // the tx hash so the payer can retry.
    try {
      meter.ensureSchema();
      meter.insertEvent(buildMeteredCallEvent({
        receipt: verification.receipt,
        userLogin,
        category: metered.category,
        priceUSD,
        tier,
      }));
    } catch (err) {
      structuredLog.error("agenticPayments.metered_gate_usage_meter_failed", {
        message: `[payments] metered gate refused ${resource}: usage meter failed: ${err instanceof Error ? err.message : String(err)}`,
        resource,
        error: err instanceof Error ? err.message : String(err),
      });
      if (verification.receipt.txHash) await this.releaseTxHash(verification.receipt.txHash);
      return meteredGateRefusal(503, "MeteringUnavailable", "The usage meter failed; the paid result was not served. Retry the payment.");
    }

    // Issue #2522: tier-decision audit. Best-effort, NEVER a gate
    // condition: the meter row above is the authoritative per-call
    // tier record, so an audit write failure warns and the call
    // still serves — refusing a verified, metered payment over an
    // audit row would be worse than a missing audit row.
    try {
      if (this.orm?.events) {
        this.orm.events.create({
          id: crypto.randomUUID(),
          sessionId: userLogin,
          type: "commercial.tier.decision",
          agent: "payments",
          payload: {
            userLogin,
            tier,
            receiptId: verification.receipt.receiptId,
            category: metered.category,
            priceUSD,
            protocol: verification.receipt.protocol,
          },
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      structuredLog.warn("agenticPayments.tier_decision_audit_failed", {
        message: `[payments] tier-decision audit failed for ${resource}: ${err instanceof Error ? err.message : String(err)}`,
        resource,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Attach x402 and MPP receipt headers
    const receiptHeader = Buffer.from(JSON.stringify(verification.receipt)).toString("base64");
    const headers = new Headers({
      "Content-Type": "application/json",
      "PAYMENT-RESPONSE": receiptHeader,
      "Payment-Receipt": `id=${verification.receipt.receiptId}, amount=${verification.receipt.amount}, tx=${verification.receipt.txHash}`,
    });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers,
    });
  }

  private async createMppx() {
    if (!this.mppSecretKey) return null;
    const { Mppx, tempo } = await loadMppxServer();
    return Mppx.create({
      methods: [
        tempo.charge({
          recipient: this.recipient as `0x${string}`,
          testnet: this.network.includes("sepolia") || this.network.includes("test"),
        }),
      ],
      secretKey: this.mppSecretKey,
    });
  }

  /** Returns the mppx-signed WWW-Authenticate challenge, or null when MPP is not configured. */
  private async issueMppChallenge(req: Request, priceUSD: number, description: string): Promise<string | null> {
    const mppx = await this.createMppx();
    if (!mppx) return null;
    const result = await mppx.charge({ amount: priceUSD.toFixed(2), description })(req.clone() as unknown as Request);
    return result.status === 402 ? result.challenge.headers.get("WWW-Authenticate") : null;
  }

  /**
   * Issue #700 (point 3): the payer identity of a VERIFIED MPP payment.
   *
   * The typed mppx.charge result does not expose the credential, but the
   * credential charge just verified is recoverable from the request via
   * Credential.fromRequest (mppx root). Its `source` is the payer DID
   * (did:pkh:eip155:<chain>:<address>), and it is safe to trust HERE:
   * this runs only after charge succeeded, and the tempo verifier binds
   * source to the payment cryptographically — proof credentials must
   * carry a source and their signature is checked against it, and
   * transaction credentials have their source cross-checked against the
   * on-chain sender. A forged source cannot reach this code.
   *
   * The receipt's payer is the parsed bare address, so MPP rows use the
   * same vocabulary as x402 rows (whose payer is a bare address) and the
   * #183 payer-bound machinery scopes them per payer; authorizerDid is
   * the source DID itself.
   *
   * FALLBACK — the pooled identity ("mpp-credential") now applies ONLY
   * where no payer is exposed: credentials that carry no parseable
   * source (transaction credentials may omit it; for those the payer is
   * genuinely not visible to the app). It also covers a credential that
   * fails to deserialize, because an already-verified payment must
   * never fail on identity extraction.
   */
  private async verifiedMppPayer(
    req: Request
  ): Promise<{ payer: string; authorizerDid: string }> {
    const pooled = { payer: "mpp-credential", authorizerDid: "did:mpp:credential" };
    try {
      const { Credential } = await loadMppxRoot();
      const source = Credential.fromRequest(req)?.source;
      if (!source) return pooled;
      const match = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(source);
      if (!match) return pooled;
      return { payer: match[1], authorizerDid: source };
    } catch {
      return pooled;
    }
  }

  /** Verify an MPP credential with mppx, fulfill the request and attach the MPP receipt. */
  private async handleMppRequest(
    req: Request,
    resource: string,
    priceUSD: number,
    description: string,
    fulfill: (receipt: AgenticPaymentReceipt) => Promise<any>,
    metered?: MeteredGateOptions
  ): Promise<Response> {
    const mppx = await this.createMppx();
    if (!mppx) {
      return new Response(JSON.stringify({ error: "MPP payments are not configured (MPP_SECRET_KEY missing)." }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await mppx.charge({ amount: priceUSD.toFixed(2), description })(req.clone() as unknown as Request);
    if (result.status === 402) return result.challenge;

    // Issue #700: bind the receipt to the VERIFIED payer (see
    // verifiedMppPayer) instead of pooling every MPP payer into one
    // scope. txHash stays "" — the mppx receipt is not exposed on the
    // typed charge result either; that gap is tracked separately.
    const { payer, authorizerDid } = await this.verifiedMppPayer(req);

    const receipt: AgenticPaymentReceipt = {
      receiptId: `rcpt_mpp_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`,
      protocol: "mpp",
      resource,
      amount: priceUSD,
      currency: "USDC",
      network: this.network,
      payer,
      recipient: this.recipient,
      status: "verified",
      txHash: "",
      timestamp: new Date().toISOString(),
      proposerDid: AGENT_DIDS.TRADING,
      authorizerDid,
      note: "Verified by the mppx SDK (Machine Payments Protocol).",
    };
    await this.recordPaymentTransaction(receipt, "inbound");

    // Issue #2408: same metered-gate enforcement as the x402
    // branch — no meter, no serve; tier checked before fulfill;
    // the served call metered before the receipt is attached.
    // (MPP has no tx hash to release: the mppx receipt exposes
    // none, a pre-existing gap noted on the receipt itself. A
    // meter refusal here still serves nothing and stays typed.)
    if (!metered?.meter) {
      structuredLog.error("agenticPayments.mpp_metered_gate_no_meter", {
        message: `[payments] metered gate refused ${resource}: no usage meter configured — nothing served.`,
        resource,
      });
      return meteredGateRefusal(503, "MeteringUnavailable", "The usage meter is not configured for this paid endpoint; the paid result was not served.");
    }
    const meter = metered.meter;
    const userLogin = req.headers.get("x-user-login") || payerScopeId(receipt.payer);
    let tier: StoreTier;
    try {
      tier = await resolveMeteredTier(metered.resolveTier, userLogin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      structuredLog.error("agenticPayments.mpp_metered_gate_tier_resolution_failed", {
        message: `[payments] metered gate refused ${resource}: tier resolution failed: ${message}`,
        resource,
        error: message,
      });
      if (message.startsWith("Invalid tier:")) {
        return meteredGateRefusal(500, "TierInvalid", `The stored tier for this caller is invalid; the paid result was not served. (${message})`);
      }
      return meteredGateRefusal(503, "TierUnavailable", "The tier store could not be read; the paid result was not served.");
    }

    const data = await fulfill(receipt);
    try {
      meter.ensureSchema();
      meter.insertEvent(buildMeteredCallEvent({
        receipt,
        userLogin,
        category: metered.category,
        priceUSD,
        tier,
      }));
    } catch (err) {
      structuredLog.error("agenticPayments.mpp_metered_gate_usage_meter_failed", {
        message: `[payments] metered gate refused ${resource}: usage meter failed: ${err instanceof Error ? err.message : String(err)}`,
        resource,
        error: err instanceof Error ? err.message : String(err),
      });
      return meteredGateRefusal(503, "MeteringUnavailable", "The usage meter failed; the paid result was not served. Retry the payment.");
    }

    // Issue #2522: tier-decision audit, same rule as the x402
    // branch — best-effort, never a gate condition.
    try {
      if (this.orm?.events) {
        this.orm.events.create({
          id: crypto.randomUUID(),
          sessionId: userLogin,
          type: "commercial.tier.decision",
          agent: "payments",
          payload: {
            userLogin,
            tier,
            receiptId: receipt.receiptId,
            category: metered.category,
            priceUSD,
            protocol: receipt.protocol,
          },
          createdAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      structuredLog.warn("agenticPayments.mpp_tier_decision_audit_failed", {
        message: `[payments] tier-decision audit failed for ${resource}: ${err instanceof Error ? err.message : String(err)}`,
        resource,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result.withReceipt(
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as Response;
  }
  // =========================================================================
  // 2. Client-Side Buyer: Autonomous Outbound Micropayments with HITL
  // =========================================================================

  /**
   * Build an x402 payment proof for an outbound payment challenge.
   *
   * Issue #122: this service holds NO signing key and settles nothing
   * on-chain, so it cannot produce a real cryptographic proof. The returned
   * proof is explicitly simulated: it is marked `simulated: true`, its
   * signature field carries a plain-text non-signature marker (never a
   * signature-shaped fabrication), and it carries no txHash and no
   * facilitator token (no facilitator issued anything). Real verifiers —
   * including this service's own verifyPayment — reject it; only demo/mock
   * servers that skip verification would accept it, and receipts from such
   * flows are recorded as simulated (see synthesizeReceipt).
   */
  async signPaymentProof(
    challenge: X402PaymentChallenge | MppChallenge,
    payerAddress?: string
  ): Promise<{ x402Proof?: X402PaymentProof; mppProof?: MppPaymentProof; headers: Record<string, string> }> {
    // Fail closed: signing as the agent's wallet needs a configured wallet
    // identity. Never mint a proof under a default address.
    const payer = payerAddress ?? this.agentWalletAddress;
    if (!payer) {
      throw new Error(
        "Agent wallet not configured: set X402_AGENT_WALLET_KEY before signing payment proofs."
      );
    }
    const timestamp = Date.now();
    const nonce = "nonce" in challenge ? challenge.nonce : `n_${timestamp}`;

    const x402Proof: X402PaymentProof = {
      signature: SIMULATED_PROOF_SIGNATURE,
      payer,
      nonce,
      timestamp,
      simulated: true,
    };

    const x402Header = Buffer.from(JSON.stringify(x402Proof)).toString("base64");

    return {
      x402Proof,
      headers: {
        "PAYMENT-SIGNATURE": x402Header,
      },
    };
  }

  /**
   * Perform an HTTP fetch with automatic 402 detection, payment signing, and HITL gate
   */
  async requestWithAgenticPayment<T = any>(
    url: string,
    init: RequestInit = {},
    onConfirmationRequired?: PaymentRequiredCallback
  ): Promise<{ success: boolean; data?: T; receipt?: AgenticPaymentReceipt; error?: string; status: number }> {
    // 1. Initial request
    let res = await fetch(url, init);

    // If resource is not 402-gated, return direct response
    if (res.status !== 402) {
      if (!res.ok) {
        return { success: false, status: res.status, error: `Upstream HTTP ${res.status}: ${res.statusText}` };
      }
      const data = (await res.json().catch(() => ({}))) as T;
      return { success: true, status: res.status, data };
    }

    // 2. Parse 402 Payment Challenge
    const paymentReqHeader = res.headers.get("PAYMENT-REQUIRED") || res.headers.get("payment-required");
    const wwwAuthHeader = res.headers.get("WWW-Authenticate") || res.headers.get("www-authenticate");

    let challenge: X402PaymentChallenge;
    if (paymentReqHeader) {
      try {
        challenge = JSON.parse(Buffer.from(paymentReqHeader, "base64").toString("utf-8"));
      } catch {
        challenge = JSON.parse(paymentReqHeader);
      }
    } else {
      challenge = this.createX402Challenge(new URL(url).pathname, 0.05, "Agentic Resource");
    }

    // 3. Human-in-the-Loop (HITL) Gate: Check if amount exceeds auto-approval limit
    const cost = Number(challenge.amount);
    if (cost > this.autoApproveLimitUSD) {
      if (onConfirmationRequired) {
        const approved = await onConfirmationRequired(challenge);
        if (!approved) {
          return {
            success: false,
            status: 402,
            error: `Agentic payment of $${cost.toFixed(2)} ${challenge.currency} for "${challenge.description}" was rejected by Human Authorization (HITL safety rule).`,
          };
        }
      } else {
        return {
          success: false,
          status: 402,
          error: `Payment of $${cost.toFixed(2)} exceeds auto-approval threshold of $${this.autoApproveLimitUSD.toFixed(2)}. Human confirmation required.`,
        };
      }
    }

    // 4. Sign payment proof & retry request with credentials
    const { headers: paymentHeaders, x402Proof } = await this.signPaymentProof(challenge);

    const mergedHeaders = new Headers(init.headers || {});
    for (const [k, v] of Object.entries(paymentHeaders)) {
      mergedHeaders.set(k, v);
    }

    const paidRes = await fetch(url, {
      ...init,
      headers: mergedHeaders,
    });

    if (!paidRes.ok) {
      const errText = await paidRes.text().catch(() => "");
      return {
        success: false,
        status: paidRes.status,
        error: `Paid request retry failed [HTTP ${paidRes.status}]: ${errText.slice(0, 150)}`,
      };
    }

    const data = (await paidRes.json().catch(() => ({}))) as T;

    // Parse receipt from response header. A server-issued receipt is used
    // only when it is complete (receiptId + status + amount); anything less
    // is not evidence of a verified payment, so fall back to an honestly
    // labelled local simulated record (issue #122).
    let receipt: AgenticPaymentReceipt;
    let serverReceipt: AgenticPaymentReceipt | undefined;
    const respHeader = paidRes.headers.get("PAYMENT-RESPONSE");
    if (respHeader) {
      try {
        const parsed = JSON.parse(Buffer.from(respHeader, "base64").toString("utf-8"));
        if (parsed && parsed.receiptId && parsed.status && typeof parsed.amount === "number") {
          serverReceipt = parsed as AgenticPaymentReceipt;
        }
      } catch {
        serverReceipt = undefined;
      }
    }
    receipt = serverReceipt ?? this.synthesizeReceipt(challenge);

    // Record outbound transaction
    await this.recordPaymentTransaction(receipt, "outbound");

    return {
      success: true,
      status: paidRes.status,
      data,
      receipt,
    };
  }

  /**
   * Issue #122: the local fallback receipt. The outbound proof this service
   * produces is simulated and unsigned, and this service performed no
   * settlement or verification — so the record says exactly that: status
   * "simulated", no txHash (nothing exists on-chain to hash), and a note
   * stating no real payment was made or verified.
   */
  private synthesizeReceipt(challenge: X402PaymentChallenge): AgenticPaymentReceipt {
    return {
      receiptId: `rcpt_out_${Date.now()}`,
      protocol: "x402",
      resource: challenge.resource,
      amount: challenge.amount,
      currency: challenge.currency,
      network: challenge.network,
      payer: this.agentWalletAddress,
      recipient: challenge.recipient,
      status: "simulated",
      simulated: true,
      timestamp: new Date().toISOString(),
      proposerDid: AGENT_DIDS.TRADING,
      note: `Local record of a SIMULATED outbound payment for ${challenge.description}: the proof was unsigned (this service holds no signing key) and no on-chain settlement was made or verified. Not proof of payment.`,
    };
  }

  // =========================================================================
  // 3. Ledger, Wallet Status & Persistence
  // =========================================================================

  /**
   * Persist transaction in SQLite ORM and emit audit event
   */
  async recordPaymentTransaction(
    receipt: AgenticPaymentReceipt,
    direction: "inbound" | "outbound"
  ): Promise<TransactionRecord> {
    const now = new Date().toISOString();
    const action = direction === "inbound" ? ("agentic_payment" as const) : ("micropayment" as const);
    // Issue #183: in payer-bound mode the row (and its audit event) is
    // stamped with the VERIFIED payer's scope, not the serving
    // instance's identity — anonymous premium payments must not pool
    // into the shared gateway instance's ledger.
    const stamp = this.stampForReceipt(receipt);
    // Issue #122: a simulated receipt records as a simulated ledger entry —
    // never "completed", never with a fabricated `sig_…` proof signature.
    const isSimulated = receipt.simulated === true || receipt.status === "simulated";
    const baseNote =
      receipt.note || `Cloudflare Agentic Payment (${(receipt.protocol || "x402").toUpperCase()}) on ${receipt.network || this.network}`;
    const txRecord: TransactionRecord = {
      id: `tx_${receipt.receiptId}`,
      sessionId: stamp,
      action,
      amount: receipt.amount,
      currency: receipt.currency,
      customer: direction === "inbound" ? receipt.payer : receipt.recipient,
      gateway: receipt.protocol === "mpp" ? "mpp" : "x402",
      gatewayRef: receipt.txHash || receipt.receiptId,
      status: isSimulated ? "simulated" : "completed",
      checkoutUrl: receipt.resource,
      proposerDid: receipt.proposerDid,
      authorizerDid: receipt.authorizerDid || `did:key:${receipt.payer}`,
      proofSignature: receipt.signature || (isSimulated ? "none (simulated local record — no signature)" : "none (no signature recorded)"),
      note: isSimulated ? `${baseNote} [Simulated local payment record — no real payment was made or verified.]` : baseNote,
      createdAt: now,
      updatedAt: now,
      // Issue #3182: wallet receipts carry payer/recipient addresses,
      // not a resolved tenant — explicit null, never invented.
      tenantId: null,
    };

    if (this.orm?.transactions) {
      this.orm.transactions.create(txRecord);
    }

    if (this.orm?.events) {
      this.orm.events.create({
        id: `evt_pay_${Date.now()}`,
        sessionId: stamp,
        type: direction === "inbound" ? "AGENTIC_PAYMENT_COLLECTED" : "AGENTIC_PAYMENT_SUBMITTED",
        agent: "trading",
        payload: {
          receiptId: receipt.receiptId,
          protocol: receipt.protocol,
          resource: receipt.resource,
          amount: receipt.amount,
          currency: receipt.currency,
          payer: receipt.payer,
          recipient: receipt.recipient,
          txHash: receipt.txHash,
          simulated: isSimulated,
          direction,
        },
        createdAt: now,
      });
    }

    return txRecord;
  }

  /**
   * Get the status of the Agent Wallet's LOCAL LEDGER simulation and
   * micropayment metrics. The balance is simulated (see
   * AGENTIC_WALLET_SIMULATED_NOTE) — never a live on-chain balance.
   */
  async getWalletStatus(): Promise<AgenticWalletStatus> {
    return this.getWalletStatusSync();
  }

  /**
   * Synchronous core of getWalletStatus — the ledger read is synchronous, and
   * synchronous consumers (the NLQ sync executor) must render the SAME status
   * object rather than re-implementing the balance (issue #122).
   */
  getWalletStatusSync(): AgenticWalletStatus {
    let totalSpent = 0;
    let totalEarned = 0;
    let count = 0;

    if (this.orm?.transactions) {
      const allTx = this.orm.transactions.findMany();
      for (const tx of allTx) {
        // Issue #183: wallet status is PER-IDENTITY. Only rows stamped
        // with this service's own identity count — even if the backing
        // store is shared, one identity's agentic payments can never
        // surface in another identity's wallet status.
        if (tx.sessionId !== this.sessionId) continue;
        if (tx.gateway === "x402" || tx.gateway === "mpp") {
          // Issue #2396 (Agent Mesh S11 / G3): a row recorded with
          // status "simulated" is a record that a simulation happened
          // (the retired NLQ paid leg booked such rows into this
          // ledger) — it is not earnings or spend, and it must not move
          // the wallet's totals, count, or derived balance. The rows
          // themselves stay in the ledger, labelled simulated, and
          // remain visible via micropayments_list with that status.
          if (tx.status === "simulated") continue;
          count++;
          if (tx.action === "agentic_payment" || tx.action === "charge") {
            totalEarned += tx.amount;
          } else if (tx.action === "micropayment" || tx.action === "payout") {
            totalSpent += tx.amount;
          }
        }
      }
    }

    // Issue #122: the balance is a simulated local-ledger figure — a local
    // starting credit plus/minus locally recorded entries. It is labelled as
    // such on the returned object itself so no surface can render it as an
    // on-chain balance.
    const startingBalance = AGENTIC_WALLET_STARTING_CREDIT_USD;
    const currentBalance = Math.max(0, startingBalance + totalEarned - totalSpent);

    return {
      walletAddress: this.agentWalletAddress,
      network: this.network,
      balanceUSD: currentBalance,
      autoApproveLimitUSD: this.autoApproveLimitUSD,
      facilitatorUrl: this.facilitatorUrl,
      protocol: "hybrid",
      totalSpentUSD: totalSpent,
      totalEarnedUSD: totalEarned,
      transactionCount: count,
      simulated: true,
      source: AGENTIC_WALLET_BALANCE_SOURCE,
      startingCreditUSD: startingBalance,
      note: AGENTIC_WALLET_SIMULATED_NOTE,
    };
  }

  /**
   * Issue #183: the durable per-identity storage key for the
   * auto-approve limit (the instance ORM's mas_memory key-value store —
   * the same store the MCP commands use for persisted facts).
   */
  private autoApproveLimitKey(): string {
    return `agentic:autoApproveLimitUSD:${this.sessionId}`;
  }

  /**
   * Issue #183: read this identity's persisted auto-approve limit, or
   * undefined when none was ever set (the caller then keeps the env
   * default). A storage read failure must not break service
   * construction — services are built per request in contexts that may
   * not have the schema ready — so failures fall back to undefined.
   */
  private loadPersistedAutoApproveLimit(): number | undefined {
    try {
      if (!this.orm?.memory) return undefined;
      const row = this.orm.memory.findById(this.autoApproveLimitKey());
      if (!row) return undefined;
      const value = Number(row.value);
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Set auto-approval threshold for Human-in-the-Loop protection.
   *
   * Issue #183: the limit is PERSISTED per identity in the instance's
   * durable key-value store. Previously this only mutated a field on a
   * per-request service object, so the POSTed limit evaporated with the
   * request and every read re-derived the env default — the setting
   * never actually took effect. A persistence failure propagates: the
   * caller must learn the limit did not take, not be told it did.
   */
  setAutoApproveLimit(limitUSD: number): void {
    if (limitUSD < 0) throw new Error("Auto-approval limit cannot be negative.");
    this.autoApproveLimitUSD = limitUSD;
    if (this.orm?.memory) {
      const key = this.autoApproveLimitKey();
      const now = new Date().toISOString();
      if (this.orm.memory.findById(key)) {
        this.orm.memory.update(key, { value: String(limitUSD), updatedAt: now });
      } else {
        this.orm.memory.create({ key, value: String(limitUSD), updatedAt: now });
      }
    }
  }

  getAutoApproveLimit(): number {
    return this.autoApproveLimitUSD;
  }
}
