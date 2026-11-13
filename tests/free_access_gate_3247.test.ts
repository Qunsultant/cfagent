// @vitest-environment node
/**
 * Issue #3247 (sub-issue of #3241), slice 1 — the gate pin:
 * a free-access grant NEVER makes a run free.
 *
 * The grant is access-only: it confers no tier, no included
 * runs, and no allowance. The gate (`NativeMonetizationGate
 * .check()`) reads only the account row — it takes no
 * FreeAccessGrantPort, has no grant step, and no grant-related
 * `paidVia` value. These tests drive `check()` through the
 * standard in-memory harness with a grant row present in the
 * store and assert the outcome is identical with and without
 * the grant: payment still required (402 `payment_required`
 * on manual, `coverage_required` skip on recurring) and
 * `paidVia` never grant-related. The tests fail if any future
 * change lets a grant make a run free; that is the point.
 */
import { describe, expect, it } from "vitest";
import { NativeMonetizationGate, type NativeCommercialAccount } from "../src/services/nativeMonetization";
import { StripeCheckoutAdapter, type StripeCheckoutClient } from "../src/services/stripeCheckoutAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryFreeAccessGrantAdapter } from "../src/data/inMemoryFreeAccessGrantAdapter";
import type { CheckoutPorts } from "../src/services/checkoutPorts";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

function account(overrides: Partial<NativeCommercialAccount> = {}): NativeCommercialAccount {
  return {
    userId: "u1",
    email: "u1@example.com",
    tenantId: "t1",
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 0,
    ...overrides,
  };
}

function makeGate() {
  const creates: Array<{ draftId: string; amount: number }> = [];
  const client: StripeCheckoutClient = {
    async createCheckout(params) {
      creates.push({ draftId: params.draftId, amount: params.amount });
      return {
        success: true,
        checkoutUrl: `https://checkout.example/session/${params.draftId}`,
        gatewayRef: `cs_test_${params.draftId}`,
      };
    },
    async retrieveSession(sessionId) {
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
  const ports: CheckoutPorts = { card: new StripeCheckoutAdapter(client), x402: null };
  // No free-run counter, no approved-free quota, no runs-pack
  // balance: the only coverage a Free account could have is
  // credits — so an uncovered run must reach the paid path.
  const gate = new NativeMonetizationGate({
    monetizationEnabled: true,
    priceCatalogue: new InMemoryPriceCatalogueAdapter(undefined, { approvedBy: "test-operator" }),
    checkout: ports,
  });
  return { gate, creates };
}

/** A grant row present in the store for u1 (the gate cannot see it — that is the pin). */
async function grantPresent(kind: "lifetime" | "limited") {
  const grants = new InMemoryFreeAccessGrantAdapter();
  const { granted } = await grants.grant({
    login: "u1",
    kind,
    expiresAtMs: kind === "limited" ? NOW + 86_400_000 : null,
    reason: "Owner-approved pilot account",
    grantedBy: "op1",
    nowMs: NOW,
  });
  expect(await grants.getActiveGrant("u1", NOW)).toEqual(granted);
  return grants;
}

describe("free-access grant: the gate pin (#3247)", () => {
  it("a manual run is 402 payment_required, identical with and without a lifetime or limited grant", async () => {
    const variants: Array<{ label: string; setup: () => Promise<void> }> = [
      { label: "no grant", setup: async () => {} },
      {
        label: "lifetime grant",
        setup: async () => {
          await grantPresent("lifetime");
        },
      },
      {
        label: "limited grant",
        setup: async () => {
          await grantPresent("limited");
        },
      },
    ];
    const decisions = [];
    for (const variant of variants) {
      await variant.setup();
      const { gate, creates } = makeGate();
      const decision = await gate.check({
        id: "run-1",
        family: "goal",
        trigger: "manual",
        nowMs: NOW,
        account: account(),
      });
      expect(decision, variant.label).toMatchObject({
        allowed: false,
        status: "payment_required",
        httpStatus: 402,
        priceUSD: 0.1,
        family: "goal",
      });
      expect("paidVia" in decision, variant.label).toBe(false);
      expect(creates, variant.label).toEqual([{ draftId: "run-1", amount: 0.1 }]);
      decisions.push(decision);
    }
    // Bit-for-bit identical: the grant row changes nothing.
    expect(decisions[1]).toEqual(decisions[0]);
    expect(decisions[2]).toEqual(decisions[0]);
  });

  it("a recurring scheduled run is coverage_required, identical with and without a grant, with no checkout", async () => {
    const decisions = [];
    for (const kind of [null, "lifetime", "limited"] as const) {
      if (kind) await grantPresent(kind);
      const { gate, creates } = makeGate();
      const decision = await gate.check({
        id: "run-1",
        family: "goal",
        trigger: "scheduled",
        nowMs: NOW,
        account: account(),
      });
      expect(decision).toMatchObject({
        allowed: false,
        status: "coverage_required",
        httpStatus: 402,
        priceUSD: 0.1,
        family: "goal",
      });
      expect("paidVia" in decision).toBe(false);
      expect(creates).toEqual([]);
      decisions.push(decision);
    }
    expect(decisions[1]).toEqual(decisions[0]);
    expect(decisions[2]).toEqual(decisions[0]);
  });

  it("a credits-covered run pays via credits, identical with and without a grant", async () => {
    const decisions = [];
    for (const kind of [null, "lifetime"] as const) {
      if (kind) await grantPresent(kind);
      const { gate, creates } = makeGate();
      const decision = await gate.check({
        id: "run-1",
        family: "goal",
        trigger: "manual",
        nowMs: NOW,
        account: account({ creditsUSD: 5 }),
      });
      expect(decision).toMatchObject({
        allowed: true,
        status: "paid",
        priceUSD: 0.1,
        paidVia: "credits",
      });
      expect(creates).toEqual([]);
      decisions.push(decision);
    }
    expect(decisions[1]).toEqual(decisions[0]);
  });

  it("no decision carries a grant-related paidVia value", async () => {
    await grantPresent("lifetime");
    const { gate } = makeGate();
    const decisions = [
      await gate.check({ id: "run-1", family: "goal", trigger: "manual", nowMs: NOW, account: account() }),
      await gate.check({ id: "run-2", family: "stock", trigger: "scheduled", nowMs: NOW, account: account() }),
      await gate.check({
        id: "run-3",
        family: "options",
        trigger: "manual",
        nowMs: NOW,
        account: account({ creditsUSD: 5 }),
      }),
    ];
    for (const decision of decisions) {
      const paidVia = (decision as { paidVia?: unknown }).paidVia;
      if (paidVia !== undefined) {
        expect(String(paidVia)).not.toMatch(/free.?access/i);
      }
    }
  });
});
