import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AGENT_DIDS, createDidAttestation, getUserDid, resolveAgentDidDocument } from "../src/agents/did";
import { PaymentGatewayService } from "../src/services/payments";
import type { Env } from "../src/types";

describe("Agent Decentralized Identifiers (DIDs) & Payments", () => {
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock_key",
  };

  it("exports known registered agent DIDs", () => {
    expect(AGENT_DIDS.ORCHESTRATOR).toBe("did:agent:openaimp:orchestrator");
    expect(AGENT_DIDS.JUDGE).toBe("did:agent:openaimp:judge");
    expect(AGENT_DIDS.PAYMENTS).toBe("did:agent:openaimp:payments");
    expect(AGENT_DIDS.NLQ).toBe("did:agent:openaimp:nlq");
  });

  it("formats user DID correctly", () => {
    const userDid = getUserDid("developer123");
    expect(userDid).toBe("did:user:github:developer123");
  });

  it("generates an honestly labelled unkeyed content-label attestation when no key is threaded", async () => {
    const attestation = await createDidAttestation({
      proposerDid: AGENT_DIDS.PAYMENTS,
      action: "charge",
      draftId: "pay_unit_999",
      amount: 45.0,
      currency: "USD",
      customer: "Acme Corp",
      gateway: "stripe",
    });

    expect(attestation.proposerDid).toBe(AGENT_DIDS.PAYMENTS);
    // Issue #2426: without an HMAC key the value is an unkeyed
    // SHA-256 content label, and proofType says so — the keyed
    // "HmacSha256Verification2026" type is reserved for proofs
    // created with a key (verified in tests/mesh_identity_s16_2426).
    expect(attestation.proofType).toBe("UnkeyedContentLabel2026");
    expect(attestation.signature).toBeDefined();
    expect(attestation.signature.length).toBe(64);
  });

  it("resolves valid W3C DID document for agent DIDs", () => {
    const didDoc = resolveAgentDidDocument(AGENT_DIDS.PAYMENTS);

    expect(didDoc.id).toBe(AGENT_DIDS.PAYMENTS);
    expect(didDoc.verificationMethod.length).toBeGreaterThan(0);
    expect(didDoc.authentication).toContain(`${AGENT_DIDS.PAYMENTS}#key-1`);
  });

  describe("PaymentGatewayService", () => {
    // Issue #401: the Stripe strategy performs a LIVE fetch to
    // api.stripe.com when an API key resolves — with the mock key the
    // unit test made a real network call (~5.3s, past the 25s timeout
    // under suite load) and silently passed on the 401 error path.
    // Stub fetch hermetically and assert the real success contract.
    beforeEach(() => {
      vi.stubGlobal("fetch", async (input: any) => {
        const url = String(input?.url ?? input);
        if (url.includes("api.stripe.com/v1/checkout/sessions")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              id: "cs_test_401",
              url: "https://checkout.stripe.com/c/pay/cs_test_401",
            }),
          } as Response;
        }
        throw new Error(`network disabled in tests (unexpected fetch: ${url})`);
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("reports configured status for Stripe when API key is set", () => {
      const service = new PaymentGatewayService(mockEnv);
      const statuses = service.getGatewayStatuses();

      const stripe = statuses.find((s) => s.id === "stripe");
      expect(stripe).toBeDefined();
      expect(stripe?.configured).toBe(true);

      const paypal = statuses.find((s) => s.id === "paypal");
      expect(paypal).toBeDefined();
    });

    it("creates checkout session with cryptographic DID proof", async () => {
      const service = new PaymentGatewayService(mockEnv);
      const result = await service.createCheckout({
        draftId: "pay_test_service",
        amount: 25.0,
        currency: "USD",
        customer: "Acme Corp",
        gateway: "stripe",
        userLogin: "mubasher",
      });

      expect(result.draftId).toBe("pay_test_service");
      expect(result.success).toBe(true);
      expect(result.checkoutUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_401");
      expect(result.gatewayRef).toBe("cs_test_401");
      expect(result.didAttestation).toBeDefined();
      expect(result.didAttestation?.proposerDid).toBe(AGENT_DIDS.PAYMENTS);
      expect(result.didAttestation?.signature).toBeDefined();
    });
  });
});
