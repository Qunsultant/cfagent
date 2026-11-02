/** @vitest-environment jsdom */
/**
 * Issue #2717 (Platform Phase 5, program #2468) — selling surfaces.
 *
 * TDD RED first: this suite imports src/data/productSelling.ts, which
 * does not exist yet, and extends src/client/ProductCatalogPanel.tsx
 * with a Selling section.
 *
 * The selling layer is pure derivation over caller-supplied data plus
 * a panel section that CALLS the existing 2.1 Billing API — it builds
 * no second checkout, no credits ledger, no ads code, no lifecycle
 * sends, no cancel/refund action, no new table/flag/cron/queue/route:
 * - per-product selling rail (2.1 Billing subscription vs x402
 *   pay-per-use vs none), purchasable only with an approved price or
 *   an active plan — never invented;
 * - subscription activation state from subscription rows + clock
 *   (none/active/past-due/canceled-at-period-end/expired);
 * - purchase receipts from Billing rows (plan price from the plan
 *   record only; unknown plan ⇒ null price, never invented);
 * - funnel purchase/activation events from VERIFIED Billing rows only
 *   (repurchase rows carry no provider subscription id and emit no
 *   events; no row ⇒ no events). Persistent funnel sink + dashboard
 *   stay deferred (Phase 4's model has no sink);
 * - credits redemption always unavailable with reason (slice 2.2,
 *   #2657, unlanded — no credits exist to redeem).
 * See PHASE5-INVENTORY.md for the scope lines vs 2.14 (checkout UI
 * surfaces), 2.2 (credits), 2.3 (ads), 2.4 (lifecycle), 2.7 (refunds),
 * Phase 6 (billing views + servicing).
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildProductSelling,
  type CatalogDisplayEntryLike,
  type SellingPlanInput,
  type SubscriptionRowInput,
} from "../src/data/productSelling";
import { ProductCatalogPanel } from "../src/client/ProductCatalogPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

function displayEntry(overrides: Partial<CatalogDisplayEntryLike>): CatalogDisplayEntryLike {
  return {
    id: "options:PayPerUse",
    canonicalName: "Options Screener",
    tier: "PayPerUse",
    availability: "purchasable",
    listed: true,
    unlistedReasons: [],
    priceUSD: 0.05,
    purchasePath: { label: "Pay per call", route: "/api/premium/options-scan", note: "" },
    purchasePathReason: null,
    ...overrides,
  };
}

const PRO_PLAN: SellingPlanInput = {
  id: "pro",
  name: "Pro",
  priceUSD: 10,
  periodDays: 30,
  includedRuns: 0,
  active: true,
};

function billingRow(overrides: Partial<SubscriptionRowInput>): SubscriptionRowInput {
  return {
    id: "sub_1",
    userId: "owner",
    planId: "pro",
    provider: "stripe",
    providerSubscriptionId: "sub_stripe_1",
    providerStatus: "active",
    status: "active",
    periodStartMs: NOW - 86_400_000,
    periodEndMs: NOW + 29 * 86_400_000,
    canceledAtMs: null,
    ...overrides,
  };
}

describe("selling derivation (#2717)", () => {
  it("unlisted products have no rail and are never purchasable", () => {
    const result = buildProductSelling({
      display: [
        displayEntry({
          id: "goal:PayPerUse",
          canonicalName: "goal × PayPerUse",
          listed: false,
          unlistedReasons: ["missing approved price"],
          priceUSD: null,
          purchasePath: null,
          purchasePathReason: "missing approved price",
        }),
      ],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(result.products).toHaveLength(1);
    expect(result.products[0].rail).toBe("none");
    expect(result.products[0].purchasable).toBe(false);
    expect(result.products[0].notPurchasableReason).toContain("missing approved price");
  });

  it("listed PayPerUse sells per call at the approved gate price", () => {
    const result = buildProductSelling({
      display: [displayEntry({})],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(result.products[0].rail).toBe("x402-pay-per-use");
    expect(result.products[0].purchasable).toBe(true);
    expect(result.products[0].priceUSD).toBe(0.05);
  });

  it("listed PayPerUse without an approved price is never purchasable", () => {
    const result = buildProductSelling({
      display: [displayEntry({ priceUSD: null, purchasePath: null })],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(result.products[0].purchasable).toBe(false);
    expect(result.products[0].notPurchasableReason).toMatch(/approved price/);
  });

  it("Subscribed products sell through Billing when an active plan exists", () => {
    const result = buildProductSelling({
      display: [
        displayEntry({
          id: "stock:Subscribed",
          canonicalName: "Stock Screener",
          tier: "Subscribed",
          availability: "entitlement-pending",
          priceUSD: null,
          purchasePath: { label: "View plans", route: "/payments/agentic/commercial/plans", note: "" },
        }),
      ],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(result.products[0].rail).toBe("billing-subscription");
    expect(result.products[0].purchasable).toBe(true);
  });

  it("Subscribed products are not purchasable without an active plan", () => {
    const result = buildProductSelling({
      display: [
        displayEntry({
          id: "stock:Subscribed",
          canonicalName: "Stock Screener",
          tier: "Subscribed",
          availability: "entitlement-pending",
          priceUSD: null,
          purchasePath: { label: "View plans", route: "/payments/agentic/commercial/plans", note: "" },
        }),
      ],
      plans: [{ ...PRO_PLAN, active: false }],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(result.products[0].purchasable).toBe(false);
    expect(result.products[0].notPurchasableReason).toMatch(/active subscription plan/);
  });

  it("free discovery products have no selling rail", () => {
    const result = buildProductSelling({
      display: [
        displayEntry({
          id: "stock:Free",
          canonicalName: "Stock Screener",
          tier: "Free",
          availability: "unlisted",
          priceUSD: null,
          purchasePath: null,
        }),
      ],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(result.products[0].rail).toBe("none");
    expect(result.products[0].purchasable).toBe(false);
  });

  it("activation follows the latest row and the clock", () => {
    const base = {
      display: [] as CatalogDisplayEntryLike[],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      nowMs: NOW,
    };
    expect(buildProductSelling({ ...base, subscriptions: [] }).subscription.activation).toBe("none");
    expect(buildProductSelling({ ...base, subscriptions: [billingRow({})] }).subscription.activation).toBe("active");
    expect(
      buildProductSelling({ ...base, subscriptions: [billingRow({ providerStatus: "past_due" })] }).subscription.activation,
    ).toBe("past-due");
    expect(
      buildProductSelling({ ...base, subscriptions: [billingRow({ status: "canceled", canceledAtMs: NOW })] }).subscription
        .activation,
    ).toBe("canceled-at-period-end");
    expect(
      buildProductSelling({ ...base, subscriptions: [billingRow({ periodEndMs: NOW - 1000 })] }).subscription.activation,
    ).toBe("expired");
    expect(
      buildProductSelling({ ...base, subscriptions: [billingRow({ providerStatus: "trialing" })] }).subscription.activation,
    ).toBe("active");
  });

  it("purchase receipts carry the plan price, never an invented one", () => {
    const result = buildProductSelling({
      display: [],
      plans: [PRO_PLAN],
      effectiveTier: "Subscribed",
      subscriptions: [
        billingRow({}),
        billingRow({ id: "sub_2", planId: "unknown-plan", providerSubscriptionId: "sub_stripe_2" }),
      ],
      nowMs: NOW,
    });
    expect(result.subscription.receipts).toHaveLength(2);
    const known = result.subscription.receipts.find((r) => r.subscriptionId === "sub_1");
    expect(known?.planName).toBe("Pro");
    expect(known?.priceUSD).toBe(10);
    const unknown = result.subscription.receipts.find((r) => r.subscriptionId === "sub_2");
    expect(unknown?.planName).toBeNull();
    expect(unknown?.priceUSD).toBeNull();
    expect(unknown?.planUnknown).toBe(true);
  });

  it("funnel purchase/activation events come from verified Billing rows only", () => {
    const result = buildProductSelling({
      display: [],
      plans: [PRO_PLAN],
      effectiveTier: "Subscribed",
      subscriptions: [
        billingRow({}),
        billingRow({ id: "sub_9", providerSubscriptionId: null, providerStatus: null }),
      ],
      nowMs: NOW,
    });
    // Only the Billing row emits; the repurchase row emits nothing.
    expect(result.subscription.funnelEvents).toHaveLength(2);
    expect(result.subscription.funnelEvents.map((e) => e.stage).sort()).toEqual(["activation", "purchase"]);
    expect(result.subscription.funnelEvents[0].occurredAtMs).toBe(NOW - 86_400_000);
    const empty = buildProductSelling({
      display: [],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(empty.subscription.funnelEvents).toHaveLength(0);
  });

  it("credits redemption is always unavailable with the 2.2 reason", () => {
    const result = buildProductSelling({
      display: [],
      plans: [PRO_PLAN],
      effectiveTier: "Free",
      subscriptions: [],
      nowMs: NOW,
    });
    expect(result.subscription.creditsRedemption.available).toBe(false);
    expect(result.subscription.creditsRedemption.reason).toMatch(/2657/);
  });

  it("effective tier is carried verbatim, never re-derived", () => {
    const result = buildProductSelling({
      display: [],
      plans: [PRO_PLAN],
      effectiveTier: "Subscribed",
      subscriptions: [billingRow({})],
      nowMs: NOW,
    });
    expect(result.subscription.effectiveTier).toBe("Subscribed");
  });
});

describe("selling panel section (#2717)", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function flush(ms = 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function buttonByText(text: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text));
    if (!found) throw new Error(`button not found: ${text}`);
    return found as HTMLButtonElement;
  }

  async function renderPanel(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ProductCatalogPanel />);
    });
    await flush();
  }

  const CATALOG_FIXTURE = [
    {
      id: "options:PayPerUse", family: "options", tier: "PayPerUse",
      canonicalName: "Options Screener", servingAgent: "trading",
      priceUSD: 0.05, priceSource: "gate", priceLabel: "$0.05 per call",
      availability: "purchasable", listed: true, unlistedReasons: [],
      parityVerdict: "parity", parityNotes: [],
      purchasePath: { label: "Pay per call", route: "/api/premium/options-scan", note: "" },
      purchasePathReason: null, realVsSimulated: "real (testnet)",
    },
    {
      id: "stock:Subscribed", family: "stock", tier: "Subscribed",
      canonicalName: "Stock Screener", servingAgent: "screener",
      priceUSD: null, priceSource: null, priceLabel: null,
      availability: "entitlement-pending", listed: true, unlistedReasons: [],
      parityVerdict: "divergent", parityNotes: [],
      purchasePath: { label: "View plans", route: "/payments/agentic/commercial/plans", note: "" },
      purchasePathReason: null, realVsSimulated: null,
    },
  ];

  function sellingFetch(overrides: {
    subscription?: unknown;
    plans?: unknown;
    mint?: unknown;
    mintStatus?: number;
    purchase?: unknown;
    purchaseStatus?: number;
  } = {}) {
    const seen: Array<{ url: string; method: string }> = [];
    const impl = async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET" });
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      const err = (status: number) => ({ ok: false, status, json: async () => ({ error: "typed" }) });
      if (url === "/api/products/catalog") return ok({ products: CATALOG_FIXTURE });
      if (url === "/api/payments/agentic/commercial/identity") {
        return ok({ userLogin: "owner", tenantId: null, hasAccount: true, tier: "Free", creditsUSD: 0, includedRunsRemaining: 0 });
      }
      if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
        return ok(
          overrides.subscription ?? { userId: "owner", effectiveTier: "Free", current: null, subscriptions: [] },
        );
      }
      if (url === "/api/payments/agentic/commercial/plans") {
        return ok(overrides.plans ?? { plans: [PRO_PLAN] });
      }
      if (url === "/api/payments/agentic/commercial/subscription/billing-checkout") {
        if (overrides.mintStatus) return err(overrides.mintStatus);
        return ok(
          overrides.mint ?? {
            checkoutRequestId: "bill-1",
            checkoutUrl: "https://checkout.stripe.test/s1",
            checkoutSessionId: "cs_1",
            plan: PRO_PLAN,
          },
        );
      }
      if (url === "/api/payments/agentic/commercial/subscription/billing-purchase") {
        if (overrides.purchaseStatus) return err(overrides.purchaseStatus);
        return ok(
          overrides.purchase ?? {
            subscription: billingRow({}),
            account: null,
            effectiveTier: "Subscribed",
          },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    return { impl, seen };
  }

  it("loads selling state on demand and shows tier, plans, and the credits reason", async () => {
    const { impl, seen } = sellingFetch();
    await renderPanel(impl);
    // Selling reads happen only when the user asks — Phase 4's catalog-only
    // fetch contract is untouched until then.
    expect(seen.map((s) => s.url)).toEqual(["/api/products/catalog"]);
    await act(async () => {
      buttonByText("Show selling options").click();
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Free");
    expect(text).toContain("Pro");
    expect(text).toContain("2657");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/identity");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/plans");
  });

  it("subscribe mints, opens checkout, confirms, and shows activation", async () => {
    const activeSub = {
      userId: "owner",
      effectiveTier: "Subscribed",
      current: billingRow({}),
      subscriptions: [billingRow({})],
    };
    let subscriptionCalls = 0;
    const { impl } = sellingFetch();
    const wrapped = async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
        subscriptionCalls += 1;
        if (subscriptionCalls > 1) return { ok: true, status: 200, json: async () => activeSub };
      }
      return impl(url, init);
    };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderPanel(wrapped);
    await act(async () => {
      buttonByText("Show selling options").click();
    });
    await flush();
    await act(async () => {
      buttonByText("Start checkout").click();
    });
    await flush();
    expect(openSpy).toHaveBeenCalledWith("https://checkout.stripe.test/s1", "_blank");
    await act(async () => {
      buttonByText("I have paid").click();
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Subscribed");
    expect(text).toContain("active");
  });

  it("mint 503 fails closed with a typed message and opens nothing", async () => {
    const { impl } = sellingFetch({ mintStatus: 503 });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderPanel(impl);
    await act(async () => {
      buttonByText("Show selling options").click();
    });
    await flush();
    await act(async () => {
      buttonByText("Start checkout").click();
    });
    await flush();
    expect(openSpy).not.toHaveBeenCalled();
    const text = container.textContent ?? "";
    expect(text).toMatch(/not configured/);
    // The catalog table itself renders a Subscribed tier row, so the
    // assertion must target activation state, not the tier string:
    // no activation, no success message.
    expect(text).toContain("Activation: none");
    expect(text).not.toContain("Subscription activated.");
  });

  it("confirm 402 fails closed: nothing activated", async () => {
    const { impl } = sellingFetch({ purchaseStatus: 402 });
    vi.spyOn(window, "open").mockImplementation(() => null);
    await renderPanel(impl);
    await act(async () => {
      buttonByText("Show selling options").click();
    });
    await flush();
    await act(async () => {
      buttonByText("Start checkout").click();
    });
    await flush();
    await act(async () => {
      buttonByText("I have paid").click();
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toMatch(/not verified/);
  });

  it("subscription rows offer Subscribe into the Selling flow, never the View-plans dead end", async () => {
    const { impl, seen } = sellingFetch();
    await renderPanel(impl);
    await flush();
    const before = container.textContent ?? "";
    expect(before).toContain("Stock Screener");
    expect(before).not.toContain("View plans");
    // The PayPerUse row keeps its gate link; the Subscribed row gets the action.
    const purchaseLink = container.querySelector('a[href="/api/premium/options-scan"]');
    expect(purchaseLink).not.toBeNull();
    await act(async () => {
      buttonByText("Subscribe").click();
    });
    await flush();
    const after = container.textContent ?? "";
    expect(after).toContain("Pro");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/identity");
  });
});
