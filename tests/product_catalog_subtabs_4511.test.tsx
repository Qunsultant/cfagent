/** @vitest-environment jsdom */
/**
 * Issue #4511 — "Selling options" as a sub-tab of the Products page.
 *
 * TDD RED first: ProductCatalogPanel gains URL-synced sub-tabs
 * (param "view": "catalog" | "selling-options", default "catalog")
 * via the shared useUrlSyncedTabs hook + the Tabs/TabPanel primitives.
 * The Catalog tab holds the catalog table + Teaser rules + Marketing
 * draft preview; the Selling options tab holds the SellingSection.
 * The catalog table's Subscribe button switches to the selling-options
 * sub-tab as well as opening the selling flow. The on-demand selling
 * load contract is unchanged: no selling read happens until the user
 * asks (tab switch to selling-options, or Subscribe).
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProductCatalogPanel } from "../src/client/ProductCatalogPanel";

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

function sellingFetch() {
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
    return err(404);
  };
  return { impl, seen };
}

async function renderPanel(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ProductCatalogPanel />);
  });
  await flush();
}

function tabButton(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`tab not found: ${label}`);
  return found as HTMLButtonElement;
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

describe("Products sub-tabs (#4511)", () => {
  it("defaults to the Catalog tab; selling reads happen only on demand", async () => {
    const { impl, seen } = sellingFetch();
    await renderPanel(impl);
    expect(tabButton("Catalog").getAttribute("aria-selected")).toBe("true");
    expect(tabButton("Selling options").getAttribute("aria-selected")).toBe("false");
    expect(text()).toContain("Options Screener");
    expect(text()).toContain("Stock Screener");
    // The SellingSection is not mounted on the Catalog tab.
    expect(text()).not.toContain("Show selling options");
    expect(seen.map((s) => s.url)).toEqual(["/api/products/catalog"]);
  });

  it("switching to Selling options shows the selling section; switching back restores the catalog", async () => {
    const { impl, seen } = sellingFetch();
    await renderPanel(impl);
    await act(async () => {
      tabButton("Selling options").click();
    });
    await flush();
    expect(tabButton("Selling options").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Show selling options");
    // Still no selling read: the section loads on demand.
    expect(seen.map((s) => s.url)).toEqual(["/api/products/catalog"]);
    await act(async () => {
      buttonByText("Show selling options").click();
    });
    await flush();
    expect(text()).toContain("Pro");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/identity");
    await act(async () => {
      tabButton("Catalog").click();
    });
    await flush();
    expect(tabButton("Catalog").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Options Screener");
  });

  it("Subscribe in the catalog switches to the selling-options sub-tab and opens the selling flow", async () => {
    const { impl, seen } = sellingFetch();
    await renderPanel(impl);
    await act(async () => {
      buttonByText("Subscribe").click();
    });
    await flush();
    expect(tabButton("Selling options").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Pro");
    expect(seen.map((s) => s.url)).toContain("/api/payments/agentic/commercial/identity");
  });

  it("a ?view=selling-options URL opens the selling-options tab on mount", async () => {
    window.history.pushState(null, "", "/?tab=products&view=selling-options");
    const { impl } = sellingFetch();
    await renderPanel(impl);
    expect(tabButton("Selling options").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Show selling options");
  });
});
