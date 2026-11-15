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
 * Final scope (owner, 2026-11-14): FIVE hub tabs — Products (catalog),
 * Selling options, Marketing draft preview, Admin Products, Free Runs.
 * Billing, Checkout, Payments, Orders, Ledger, and Revenue stay
 * standalone and are NOT hub tabs. The hub REPLACES the standalone
 * product pages: the product-domain URLs redirect to their hub tabs
 * (see product_hub_redirect_4530.test.ts).
 *
 * Issue #4582 — just one of everything: the Products tab shows the
 * catalog directly with NO sub-tab row (the catalog sub-tabs duplicated
 * the hub tabs), and Marketing draft preview is a hub tab of its own
 * instead of a nested sub-tab. The panels are reused, not rebuilt:
 * ProductCatalogPanel (Products tab), the exported SellingSection
 * (Selling options tab), MarketingDraftPreviewSection (Marketing draft
 * preview tab), ProductsSection (Admin Products tab),
 * FreeRunAllowanceSection (Free Runs tab). The hub tab IS the demand
 * for the selling load: visiting the Selling options hub tab opens
 * the selling flow (the Products page keeps its own on-demand button
 * contract — see product_catalog_subtabs_4511.test.tsx).
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

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

function text(): string {
  return container.textContent ?? "";
}

describe("Product Hub (#4530)", () => {
  it("has exactly five tabs in order: Products, Selling options, Marketing draft preview, Admin Products, Free Runs", async () => {
    expect(PRODUCT_HUB_TABS).toEqual([
      "products",
      "selling-options",
      "marketing-draft-preview",
      "admin-products",
      "free-runs",
    ]);
    const { impl } = hubFetch();
    await renderHub(impl);
    expect(hubTabLabels()).toEqual([
      "Products",
      "Selling options",
      "Marketing draft preview",
      "Admin Products",
      "Free Runs",
    ]);
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
    expect(container.querySelector('select[aria-label="Marketing channel"]')).toBeNull();
    expect(seen.map((s) => s.url)).toEqual(["/api/products/catalog"]);
  });

  it("the Products tab shows the catalog with NO sub-tab row", async () => {
    // #4582 — just one of everything: the catalog sub-tabs duplicated
    // the hub tabs, so the Products tab has no sub-tabs of its own.
    const { impl } = hubFetch();
    await renderHub(impl);
    expect(container.querySelector('[id^="products-tab-"]')).toBeNull();
    expect(text()).toContain("Options Screener");
    expect(text()).toContain("Teaser Rule B1");
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

  it("switching to Marketing draft preview mounts the preview panel", async () => {
    const { impl } = hubFetch();
    await renderHub(impl);
    await act(async () => {
      hubTabButton("marketing-draft-preview").click();
    });
    await flush();
    expect(hubTabButton("marketing-draft-preview").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=marketing-draft-preview");
    expect(text()).toContain("Compose channel-formatted");
    expect(container.querySelector('select[aria-label="Marketing channel"]')).not.toBeNull();
  });

  it("Preview draft in the catalog composes and switches the HUB to the preview tab", async () => {
    const { impl } = hubFetch();
    await renderHub(impl);
    await act(async () => {
      buttonByText("Preview draft").click();
    });
    await flush();
    expect(hubTabButton("marketing-draft-preview").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=marketing-draft-preview");
    expect(window.location.search).not.toContain("productTab=");
    expect(text()).toContain("Draft Preview");
    expect(container.querySelector('select[aria-label="Marketing channel"]')).not.toBeNull();
  });

  it("Subscribe in the catalog switches the HUB to the selling-options tab and opens the selling flow", async () => {
    const { impl, seen } = hubFetch();
    await renderHub(impl);
    await act(async () => {
      buttonByText("Subscribe").click();
    });
    await flush();
    expect(hubTabButton("selling-options").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toContain("view=selling-options");
    expect(text()).toContain("Pro");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/identity");
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
    ["marketing-draft-preview", "Compose channel-formatted"],
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

  it("a stale nested productTab param is ignored by the hub; the catalog shows", async () => {
    // #4582 — the nested `productTab` mechanism is gone, so the hub
    // ignores the param (the redirect in Chat routes a bookmarked
    // nested address to the preview tab; this pins the hub itself
    // never reading it).
    const { impl } = hubFetch();
    await renderHub(impl, "/?tab=product-hub&view=products&productTab=marketing-draft-preview");
    expect(hubTabButton("products").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Options Screener");
    expect(container.querySelector('[id^="products-tab-"]')).toBeNull();
  });
});

describe("Admin Products sub-tabs are URL-synced on adminTab (#4689)", () => {
  function adminTabButton(id: string): HTMLButtonElement {
    const found = container.querySelector(`#platform-admin-products-tab-${id}`);
    if (!found) throw new Error(`admin sub-tab not found: ${id}`);
    return found as HTMLButtonElement;
  }

  async function clickAdminTab(id: string) {
    await act(async () => {
      adminTabButton(id).click();
    });
    await flush();
  }

  it.each([
    ["create-product", "Product name"],
    ["create-version", "No products yet. Create a product first."],
  ])(
    "a ?tab=product-hub&view=admin-products&adminTab=%s URL opens that sub-tab on mount",
    async (subTab, marker) => {
      const { impl } = hubFetch();
      await renderHub(impl, `/?tab=product-hub&view=admin-products&adminTab=${subTab}`);
      expect(hubTabButton("admin-products").getAttribute("aria-selected")).toBe("true");
      expect(adminTabButton(subTab).getAttribute("aria-selected")).toBe("true");
      expect(adminTabButton("products").getAttribute("aria-selected")).toBe("false");
      expect(text()).toContain(marker);
    },
  );

  it("admin-products with no adminTab opens the Products sub-tab", async () => {
    const { impl } = hubFetch();
    await renderHub(impl, "/?tab=product-hub&view=admin-products");
    expect(hubTabButton("admin-products").getAttribute("aria-selected")).toBe("true");
    expect(adminTabButton("products").getAttribute("aria-selected")).toBe("true");
    expect(adminTabButton("create-product").getAttribute("aria-selected")).toBe("false");
  });

  it("clicking an admin sub-tab writes adminTab to the URL", async () => {
    const { impl } = hubFetch();
    await renderHub(impl, "/?tab=product-hub&view=admin-products");
    await clickAdminTab("create-product");
    expect(new URLSearchParams(window.location.search).get("adminTab")).toBe("create-product");
    await clickAdminTab("create-version");
    expect(new URLSearchParams(window.location.search).get("adminTab")).toBe("create-version");
  });

  it("the nested adminTab param does not leak across hub tabs (#4582 lesson)", async () => {
    // Leave Admin Products with a sub-tab open: the URL must drop
    // adminTab, and coming back must show the Products sub-tab — not
    // the stale in-memory one.
    const { impl } = hubFetch();
    await renderHub(impl, "/?tab=product-hub&view=admin-products&adminTab=create-version");
    expect(adminTabButton("create-version").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      hubTabButton("products").click();
    });
    await flush();
    expect(hubTabButton("products").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).not.toContain("adminTab=");
    await act(async () => {
      hubTabButton("admin-products").click();
    });
    await flush();
    expect(hubTabButton("admin-products").getAttribute("aria-selected")).toBe("true");
    expect(adminTabButton("products").getAttribute("aria-selected")).toBe("true");
    expect(adminTabButton("create-version").getAttribute("aria-selected")).toBe("false");
  });
});
