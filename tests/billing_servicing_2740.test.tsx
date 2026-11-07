/** @vitest-environment jsdom */
/**
 * Issue #2740 (Platform Phase 6, program #2468) — servicing.
 *
 * TDD RED first: this suite imports src/data/billingServicing.ts and
 * src/client/BillingServicingPanel.tsx, which do not exist yet.
 *
 * Scope (see PHASE6-INVENTORY.md): a READ-ONLY billing servicing view
 * over landed rails only — 2.1 subscription read + plans list, slice-4
 * receipts, 2.2 referral balance (this panel is its FIRST client
 * caller) — plus a support snapshot card and the credits-copy
 * correction. No purchase action (Selling owns it), no cancel action
 * (rescoped 2.14 owns it), no deactivation (2.5), no refund action
 * (2.7), no new route/table/flag/cron/queue, no price invented, no
 * owner decision defaulted (referral rule values render as
 * operator-set PROPOSED, pending owner approval, per #2657 §15).
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildBillingView,
  type BillingReferralInput,
  type BillingSubscriptionInput,
} from "../src/data/billingServicing";
import { CREDITS_UNAVAILABLE_REASON } from "../src/data/productSelling";
import { BillingServicingPanel } from "../src/client/BillingServicingPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

const SUBSCRIPTION: BillingSubscriptionInput = {
  userId: "owner",
  effectiveTier: "Subscribed",
  current: { periodEndMs: NOW + 30 * 24 * 3600 * 1000 },
  subscriptions: [{ periodEndMs: NOW + 30 * 24 * 3600 * 1000 }],
};

const REFERRAL: BillingReferralInput = {
  redeemableUSD: 1.5,
  totalEarnedUSD: 2.0,
  attribution: { referrerUserId: "referrer-1" },
  rules: { earnAmountUSD: 0.5, vestingDelayMs: 7 * 24 * 3600 * 1000, redemptionScope: "pay-per-run" },
};

function viewInput(overrides: Record<string, unknown> = {}) {
  return {
    identity: { userLogin: "owner", tier: "Subscribed" },
    subscription: SUBSCRIPTION,
    receipts: [
      { id: "r1", kind: "meter", createdAt: "2026-11-01T00:00:00Z", provenance: "real", amountUSD: 0.05 },
    ],
    plans: [{ id: "pro", name: "Pro", priceUSD: 10, periodDays: 30 }],
    referral: REFERRAL,
    nowMs: NOW,
    ...overrides,
  };
}

describe("billing servicing derivation", () => {
  it("carries tier, period end, and counts verbatim from server truth", () => {
    const view = buildBillingView(viewInput());
    expect(view.tier).toBe("Subscribed");
    expect(view.periodEndISO).toBe(new Date(NOW + 30 * 24 * 3600 * 1000).toISOString());
    expect(view.subscriptionCount).toBe(1);
    expect(view.receipts).toHaveLength(1);
    expect(view.plans).toHaveLength(1);
  });

  it("reports no subscription as none with a null period end", () => {
    const view = buildBillingView(
      viewInput({
        subscription: { userId: "owner", effectiveTier: "Free", current: null, subscriptions: [] },
      }),
    );
    expect(view.subscriptionStatus).toBe("none");
    expect(view.periodEndISO).toBeNull();
  });

  it("reports an expired current row as expired, never active", () => {
    const view = buildBillingView(
      viewInput({
        subscription: {
          userId: "owner",
          effectiveTier: "Free",
          current: { periodEndMs: NOW - 1000 },
          subscriptions: [{ periodEndMs: NOW - 1000 }],
        },
      }),
    );
    expect(view.subscriptionStatus).toBe("expired");
  });

  it("surfaces referral balance, attribution, and the proposed-rules note", () => {
    const view = buildBillingView(viewInput());
    expect(view.referral.redeemableUSD).toBe(1.5);
    expect(view.referral.totalEarnedUSD).toBe(2.0);
    expect(view.referral.attributedReferrer).toBe("referrer-1");
    expect(view.referral.rulesNote).toMatch(/proposed/i);
    expect(view.referral.rulesNote).toMatch(/owner approval/i);
  });

  it("builds the support snapshot from the same server truth", () => {
    const view = buildBillingView(viewInput());
    expect(view.supportSnapshot.login).toBe("owner");
    expect(view.supportSnapshot.tier).toBe("Subscribed");
    expect(view.supportSnapshot.subscriptionStatus).toBe("active");
    expect(view.supportSnapshot.receiptsCount).toBe(1);
  });
});

describe("credits-copy correction", () => {
  it("states the ledger exists and names the missing panel flow, never unlanded", () => {
    expect(CREDITS_UNAVAILABLE_REASON).toMatch(/ledger exists/i);
    expect(CREDITS_UNAVAILABLE_REASON).toMatch(/2657/);
    expect(CREDITS_UNAVAILABLE_REASON).toMatch(/no redemption flow/i);
    expect(CREDITS_UNAVAILABLE_REASON).not.toMatch(/unlanded/);
    expect(CREDITS_UNAVAILABLE_REASON).not.toMatch(/no credits exist/);
  });
});

describe("billing servicing panel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function billingFetch(overrides: Record<string, unknown> = {}) {
    const impl = async (url: string) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      const err = (status: number) => ({ ok: false, status, json: async () => ({ error: "typed" }) });
      if (url === "/api/payments/agentic/commercial/identity") {
        return ok({ userLogin: "owner", tenantId: null, hasAccount: true, tier: "Subscribed", creditsUSD: 0, includedRunsRemaining: 0 });
      }
      if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
        return ok(overrides.subscription ?? { userId: "owner", effectiveTier: "Subscribed", current: { periodEndMs: NOW + 30 * 24 * 3600 * 1000 }, subscriptions: [{}] });
      }
      if (url === "/api/payments/receipts") {
        if (overrides.receiptsStatus) return err(overrides.receiptsStatus as number);
        return ok({ receipts: [{ id: "r1", kind: "meter", createdAt: "2026-11-01T00:00:00Z", provenance: "real", amountUSD: 0.05 }] });
      }
      if (url === "/api/payments/agentic/commercial/plans") {
        return ok({ plans: [{ id: "pro", name: "Pro", priceUSD: 10, periodDays: 30 }] });
      }
      if (url.startsWith("/api/payments/agentic/commercial/referral/balance?")) {
        return ok(overrides.referral ?? { userId: "owner", redeemableUSD: 1.5, totalEarnedUSD: 2.0, attribution: { referrerUserId: "referrer-1" }, rules: { earnAmountUSD: 0.5, vestingDelayMs: 604800000, redemptionScope: "pay-per-run" } });
      }
      if (url === "/api/payments/agentic/commercial/usage-billing") {
        return ok({
          outcome: "SUCCESS_USAGE_BILLING_READ",
          userLogin: "owner",
          tier: "Subscribed",
          limit: 50,
          identity: { creditsUSD: 0, includedRunsRemaining: 0, hasAccount: true },
          usage: { receipts: [], counts: { meter: 0, tier: 0, transaction: 0, real: 0, simulated: 0, audit: 0 } },
          billing: {
            effectiveTier: "Subscribed",
            current: null,
            subscriptions: [],
            renewals: [],
            refunds: [],
            referral: { redeemableUSD: 0, totalEarnedUSD: 0 },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    return impl;
  }

  async function renderPanel(impl: (url: string) => Promise<unknown>) {
    const prev = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn(impl);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(BillingServicingPanel));
    });
    await act(async () => {});
    return () => {
      (globalThis as any).fetch = prev;
    };
  }

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it("renders subscription, receipts, plans, referral balance, and support snapshot", async () => {
    const restore = await renderPanel(billingFetch());
    try {
      const text = container!.textContent ?? "";
      expect(text).toMatch(/Subscribed/);
      expect(text).toMatch(/Pro/);
      expect(text).toMatch(/referrer-1/);
      expect(text).toMatch(/Support snapshot/);
    } finally {
      restore();
    }
  });

  it("renders a receipts failure as a fixed error, never invented rows", async () => {
    const restore = await renderPanel(billingFetch({ receiptsStatus: 503 }));
    try {
      const text = container!.textContent ?? "";
      expect(text).toMatch(/could not be loaded/);
    } finally {
      restore();
    }
  });

  it("offers no purchase and no cancel action", async () => {
    const restore = await renderPanel(billingFetch());
    try {
      const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
      expect(buttons.join(" ")).not.toMatch(/Start checkout|Cancel subscription|Cancel/i);
    } finally {
      restore();
    }
  });

  it("points at Checkout for cancellation, with no cancel button (#2669)", async () => {
    const restore = await renderPanel(billingFetch());
    try {
      const link = container!.querySelector('a[href="?tab=checkout&checkoutTab=subscriptions"]');
      expect(link).not.toBeNull();
      expect(link?.textContent).toContain("Checkout");
      const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent ?? "");
      expect(buttons.join(" ")).not.toMatch(/Cancel subscription/i);
    } finally {
      restore();
    }
  });
});
