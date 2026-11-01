/**
 * Phase 6 (#2016) — the cfpay gate's network allowlist: mainnet
 * admission is explicit and fail-closed. Base mainnet forms are
 * admitted alongside the Sepolia testnets; anything else (including
 * Ethereum mainnet, which is not in cfpay's chain map) is refused
 * when monetization is enabled. The guard does not apply when the
 * flag is OFF, and the default network (base-sepolia, in the
 * workflow adapter) is unchanged — mainnet requires an explicit
 * MONETIZATION_NETWORK value.
 */
import { describe, expect, it } from "vitest";
import { CfPayMonetizationGate } from "../src/services/cfpayMonetization";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";

const stubCfpay = {
  createCheckout: async () => ({}),
  checkoutStatus: async () => ({ state: "unpaid" }),
};

const freeAccount = {
  userId: "u1",
  email: "u1@example.com",
  tier: "Free" as const,
  creditsUSD: 0,
  includedRunsRemaining: 0,
};

describe("cfpay gate network allowlist (#2016)", () => {
  it.each(["base-sepolia", "ethereum-sepolia", "base", "eip155:8453"])(
    "accepts %s when monetization is enabled",
    (network) => {
      expect(
        () => new CfPayMonetizationGate(stubCfpay, { monetizationEnabled: true, network }),
      ).not.toThrow();
    },
  );

  it.each(["foo", "ethereum", "eip155:1", ""])(
    "refuses unknown network %s when monetization is enabled",
    (network) => {
      expect(
        () => new CfPayMonetizationGate(stubCfpay, { monetizationEnabled: true, network }),
      ).toThrow(/unknown network/);
    },
  );

  it("does not apply the guard when monetization is disabled", () => {
    expect(
      () => new CfPayMonetizationGate(stubCfpay, { monetizationEnabled: false, network: "foo" }),
    ).not.toThrow();
  });

  it("discloses mainnet acceptance and no longer claims testnet-only", async () => {
    const gate = new CfPayMonetizationGate(stubCfpay, {
      monetizationEnabled: true,
      network: "base-sepolia",
      priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
    });
    const decision = await gate.check({ id: "run-1", family: "stock", trigger: "manual", account: freeAccount });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected payment_required");
    expect(decision.status).toBe("payment_required");
    expect(decision.disclosure).toContain("Mainnet payments are accepted");
    expect(decision.disclosure).not.toContain("no mainnet payment is accepted");
  });
});
