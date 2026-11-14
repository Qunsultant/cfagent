/** @vitest-environment jsdom */
/**
 * Issue #2781 (Monetization Phase 2.15) — bundle Selling UI.
 *
 * The ProductCatalogPanel's Selling section lists bundle offers through
 * the same mint → confirm-by-retrieve shape as plans, and renders owned
 * bundles with their live entitlements. Harness mirrors the selling
 * panel section in tests/product_selling_2717.test.tsx (fetch stubbed,
 * real React render). The bundles read is best-effort: a bundles fetch
 * failure shows no bundles rather than blocking the plan flow.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProductCatalogPanel } from "../src/client/ProductCatalogPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

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
    id: "stock:PayPerUse", family: "stock", tier: "PayPerUse",
    canonicalName: "Stock Screener", servingAgent: "screener",
    priceUSD: 0.05, priceSource: "gate", priceLabel: "$0.05 per call",
    availability: "purchasable", listed: true, unlistedReasons: [],
    parityVerdict: "parity", parityNotes: [],
    purchasePath: { label: "Pay per call", route: "/api/premium/stock-scan", note: "" },
    purchasePathReason: null, realVsSimulated: "real (testnet)",
  },
];

const BUNDLE_FIXTURE = {
  id: "bnd-test-1",
  name: "Stock + Options",
  memberProductIds: ["stock:PayPerUse", "options:PayPerUse"],
  priceUSD: 0.06,
  periodDays: 30,
  includedRunsPerMember: 10,
  approvalStatus: "approved",
  active: true,
};

describe("bundle selling panel (#2781)", () => {
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
    // Issue #4511 — the sub-tabs are URL-synced; reset the URL so a
    // tab change in one test never leaks into the next test's mount.
    window.history.pushState(null, "", "/");
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

  function bundleFetch(overrides: {
    bundles?: unknown;
    bundlesStatus?: number;
    subscription?: unknown;
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
          overrides.subscription ?? { userId: "owner", effectiveTier: "Free", current: null, subscriptions: [], bundlePurchases: [], bundleEntitlements: [] },
        );
      }
      if (url === "/api/payments/agentic/commercial/plans") {
        return ok({ plans: [] });
      }
      if (url === "/api/payments/agentic/commercial/bundles") {
        if (overrides.bundlesStatus) return err(overrides.bundlesStatus);
        return ok(overrides.bundles ?? { bundles: [BUNDLE_FIXTURE] });
      }
      if (url === "/api/payments/agentic/commercial/subscription/bundle-checkout") {
        if (overrides.mintStatus) return err(overrides.mintStatus);
        return ok(
          overrides.mint ?? {
            checkoutRequestId: "bbnd-1",
            checkoutUrl: "https://checkout.stripe.test/b1",
            checkoutSessionId: "cs_bundle_1",
            bundle: BUNDLE_FIXTURE,
          },
        );
      }
      if (url === "/api/payments/agentic/commercial/subscription/bundle-purchase") {
        if (overrides.purchaseStatus) return err(overrides.purchaseStatus);
        return ok(
          overrides.purchase ?? {
            purchase: { id: "bp-1", bundleId: "bnd-test-1", status: "active" },
            entitlements: [],
            bundle: BUNDLE_FIXTURE,
            code: "SUCCESS_BUNDLE_PURCHASED",
            message: "Bundle purchased.",
            retryable: false,
          },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    return { impl, seen };
  }

  /** Issue #4511 — the SellingSection lives in the "Selling options"
   *  sub-tab; open that tab before reaching the section. */
  async function openSelling(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
    await renderPanel(impl);
    await act(async () => {
      const tab = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) =>
        (b.textContent ?? "").includes("Selling options"),
      );
      if (!tab) throw new Error("tab not found: Selling options");
      (tab as HTMLButtonElement).click();
    });
    await flush();
    await act(async () => {
      buttonByText("Show selling options").click();
    });
    await flush();
  }

  it("lists the bundle with price, savings, and members", async () => {
    const { impl } = bundleFetch();
    await openSelling(impl);
    const text = container.textContent ?? "";
    expect(text).toContain("Product bundles");
    expect(text).toContain("Stock + Options");
    expect(text).toContain("$0.06");
    expect(text).toContain("saves $0.04");
    expect(text).toContain("stock:PayPerUse");
    expect(text).toContain("options:PayPerUse");
    expect(text).toContain("10 runs per member product");
  });

  it("no bundles renders the empty state, never an invented offer", async () => {
    const { impl } = bundleFetch({ bundles: { bundles: [] } });
    await openSelling(impl);
    expect(container.textContent ?? "").toContain("No bundles offered");
  });

  it("a bundles read failure shows no bundles and leaves the plan flow intact", async () => {
    const { impl, seen } = bundleFetch({ bundlesStatus: 500 });
    await openSelling(impl);
    const text = container.textContent ?? "";
    expect(text).toContain("No bundles offered");
    expect(text).toContain("Free");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/bundles");
  });

  it("a proposed bundle shows the approval reason and no checkout button", async () => {
    const { impl } = bundleFetch({
      bundles: { bundles: [{ ...BUNDLE_FIXTURE, approvalStatus: "proposed" }] },
    });
    await openSelling(impl);
    const text = container.textContent ?? "";
    expect(text).toContain("proposed, not owner-approved");
    expect(Array.from(container.querySelectorAll("button")).some((b) => (b.textContent ?? "").includes("Start bundle checkout"))).toBe(false);
  });

  it("bundle mint opens checkout, confirm shows activation", async () => {
    const ownedSub = {
      userId: "owner",
      effectiveTier: "Free",
      current: null,
      subscriptions: [],
      bundlePurchases: [
        { id: "bp-1", bundleId: "bnd-test-1", status: "active", periodStartMs: NOW - 1000, periodEndMs: NOW + 1000 },
      ],
      bundleEntitlements: [
        { id: "bent-1", bundlePurchaseId: "bp-1", productId: "stock:PayPerUse", status: "active", periodEndMs: NOW + 1000 },
        { id: "bent-2", bundlePurchaseId: "bp-1", productId: "options:PayPerUse", status: "active", periodEndMs: NOW + 1000 },
      ],
    };
    let subscriptionCalls = 0;
    const { impl } = bundleFetch();
    const wrapped = async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/payments/agentic/commercial/subscription?")) {
        subscriptionCalls += 1;
        if (subscriptionCalls > 1) return { ok: true, status: 200, json: async () => ownedSub };
      }
      return impl(url, init);
    };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    await openSelling(wrapped);
    await act(async () => {
      buttonByText("Start bundle checkout").click();
    });
    await flush();
    expect(openSpy).toHaveBeenCalledWith("https://checkout.stripe.test/b1", "_blank");
    await act(async () => {
      buttonByText("I have paid").click();
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Bundle Activated");
    expect(text).toContain("(owned)");
    expect(text).toContain("Live entitlements: stock:PayPerUse, options:PayPerUse");
  });
});
