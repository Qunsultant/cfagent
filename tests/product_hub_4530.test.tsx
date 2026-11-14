/** @vitest-environment jsdom */
/**
 * Issue #4530 — Product Hub page as per StockHub/OptionsHub.
 *
 * TDD RED first: ProductHub.tsx is a dedicated hub page at
 * ?tab=product-hub with URL-synced tabs (param "view") via the shared
 * useUrlSyncedTabs hook + the Tabs/TabPanel primitives, following the
 * StockHub/OptionsHub pattern (visitedTabs gating: a tab's panel mounts
 * only after it is visited).
 *
 * Final scope (owner, 2026-11-14): FOUR hub tabs — Products (catalog),
 * Selling options, Admin Products, Free Runs. Billing, Checkout,
 * Payments, Orders, Ledger, and Revenue stay standalone and are NOT
 * hub tabs. The hub REPLACES the standalone product pages: the
 * product-domain URLs redirect to their hub tabs (see
 * product_hub_redirect_4530.test.ts).
 *
 * The panels are reused, not rebuilt: ProductCatalogPanel (Products
 * tab), the exported SellingSection (Selling options tab),
 * ProductsSection (Admin Products tab), FreeRunAllowanceSection
 * (Free Runs tab). The hub tab IS the demand for the selling load:
 * visiting the Selling options hub tab opens the selling flow (the
 * Products page keeps its own on-demand button contract — see
 * product_catalog_subtabs_4511.test.tsx).
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProductHub, PRODUCT_HUB_TABS } from "../src/client/ProductHub";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

const PRO_PLAN = {
  id: "pro", name: "Pro", priceUSD: 10, periodDays: 30,
  includedRuns: 0, trialDays: null, active: true,
};

let container: HTMLDivElement;
let root: Root | null = null;

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

function hubFetch() {
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
      return ok({ userId: "owner", effectiveTier: "Free", current: null, subscriptions: [] });
    }
    if (url === "/api/payments/agentic/commercial/plans") {
      return ok({ plans: [PRO_PLAN] });
    }
    if (url === "/api/payments/agentic/commercial/bundles") {
      return ok({ bundles: [] });
    }
    if (url === "/api/payments/agentic/commercial/products") {
      return ok({ products: [] });
    }
    if (url === "/api/payments/agentic/commercial/free-run-allowance") {
      return ok({ allowances: [] });
    }
    return err(404);
  };
  return { impl, seen };
}

async function renderHub(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>, search = "/?tab=product-hub") {
  window.history.pushState(null, "", search);
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ProductHub />);
  });
  await flush();
}

function hubTabButton(id: string): HTMLButtonElement {
  const found = container.querySelector(`#product-hub-tab-${id}`);
  if (!found) throw new Error(`hub tab not found: ${id}`);
  return found as HTMLButtonElement;
}

function hubTabLabels(): string[] {
  return Array.from(
    container.querySelectorAll('button[role="tab"][id^="product-hub-tab-"]'),
  ).map((b) => (b.textContent ?? "").trim());
}

function text(): string {
  return container.textContent ?? "";
}

describe("Product Hub (#4530)", () => {
  it("has exactly four tabs in order: Products, Selling options, Admin Products, Free Runs", async () => {
    expect(PRODUCT_HUB_TABS).toEqual(["products", "selling-options", "admin-products", "free-runs"]);
    const { impl } = hubFetch();
    await renderHub(impl);
    expect(hubTabLabels()).toEqual(["Products", "Selling options", "Admin Products", "Free Runs"]);
  });

  it("defaults to the Products tab and mounts the catalog; other panels are not mounted", async () => {
    const { impl, seen } = hubFetch();
    await renderHub(impl);
    expect(hubTabButton("products").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Options Screener");
    expect(text()).toContain("Stock Screener");
    // No other hub panel is mounted yet (visitedTabs gating).
    expect(text()).not.toContain("Show selling options");
    expect(text()).not.toContain("Free-run allowance (operator)");
    expect(text()).not.toContain("Create product");
    expect(seen.map((s) => s.url)).toEqual(["/api/products/catalog"]);
  });

  it("switching to Selling options mounts the selling section and opens the selling flow; switching back restores the catalog", async () => {
    const { impl, seen } = hubFetch();
    await renderHub(impl);
    await act(async () => {
      hubTabButton("selling-options").click();
    });
    await flush();
    expect(hubTabButton("selling-options").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=selling-options");
    // The hub tab IS the demand: the selling load runs on tab visit.
    expect(text()).toContain("Pro");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/identity");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/plans");
    // The hub fetches the catalog once more for the Selling tab's
    // products prop (the Products tab's panel keeps its own copy) —
    // accepted duplicate, noted in the PR body.
    expect(seen.filter((s) => s.url === "/api/products/catalog").length).toBe(2);
    await act(async () => {
      hubTabButton("products").click();
    });
    await flush();
    expect(hubTabButton("products").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Options Screener");
    // Re-visiting Selling options does not re-fetch the catalog.
    await act(async () => {
      hubTabButton("selling-options").click();
    });
    await flush();
    expect(seen.filter((s) => s.url === "/api/products/catalog").length).toBe(2);
  });

  it("switching to Admin Products mounts ProductsSection with its sub-tabs", async () => {
    const { impl, seen } = hubFetch();
    await renderHub(impl);
    await act(async () => {
      hubTabButton("admin-products").click();
    });
    await flush();
    expect(hubTabButton("admin-products").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=admin-products");
    expect(text()).toContain("Create product");
    expect(text()).toContain("Create version");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/products");
  });

  it("switching to Free Runs mounts the free-run allowance section", async () => {
    const { impl, seen } = hubFetch();
    await renderHub(impl);
    await act(async () => {
      hubTabButton("free-runs").click();
    });
    await flush();
    expect(hubTabButton("free-runs").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=free-runs");
    expect(text()).toContain("Free-run allowance (operator)");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/free-run-allowance");
  });

  it.each([
    ["selling-options", "Pro"],
    ["admin-products", "Create product"],
    ["free-runs", "Free-run allowance (operator)"],
  ])("a ?tab=product-hub&view=%s URL opens that tab on mount", async (view, marker) => {
    const { impl } = hubFetch();
    await renderHub(impl, `/?tab=product-hub&view=${view}`);
    expect(hubTabButton(view).getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain(marker);
  });

  it("an unknown view falls back to the Products tab", async () => {
    const { impl } = hubFetch();
    await renderHub(impl, "/?tab=product-hub&view=billing");
    expect(hubTabButton("products").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Options Screener");
  });
});
