/** @vitest-environment jsdom */
/**
 * Issue #4582 — the Products panel is catalog-only (no sub-tabs).
 *
 * The catalog sub-tabs are gone: "Catalog" duplicated the Products hub
 * tab (the Products tab IS the catalog) and "Selling options" duplicated
 * the Selling options hub tab, and Marketing draft preview moved up to
 * a hub tab. ProductCatalogPanel renders the catalog table + Teaser
 * rules directly, with no sub-tab row. Subscribe and Preview draft are
 * callbacks the hub owns: Subscribe switches the hub to its Selling
 * options tab, Preview draft composes the draft and switches the hub
 * to its Marketing draft preview tab.
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

function catalogFetch() {
  const seen: Array<{ url: string; method: string }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? "GET" });
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    const err = (status: number) => ({ ok: false, status, json: async () => ({ error: "typed" }) });
    if (url === "/api/products/catalog") return ok({ products: CATALOG_FIXTURE });
    return err(404);
  };
  return { impl, seen };
}

async function renderPanel(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onSubscribe = vi.fn();
  const onPreviewDraft = vi.fn();
  await act(async () => {
    root!.render(<ProductCatalogPanel onSubscribe={onSubscribe} onPreviewDraft={onPreviewDraft} />);
  });
  await flush();
  return { onSubscribe, onPreviewDraft };
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

describe("Products panel (#4582) — catalog only, no sub-tabs", () => {
  it("renders the catalog directly with no sub-tab row; catalog fetches only", async () => {
    const { impl, seen } = catalogFetch();
    await renderPanel(impl);
    expect(container.querySelectorAll('button[role="tab"]')).toHaveLength(0);
    expect(text()).toContain("Options Screener");
    expect(text()).toContain("Stock Screener");
    expect(text()).toContain("Teaser Rule B1");
    // The Subscribed row's purchase path is the "View plans" dead end —
    // the panel never renders it; it offers a Subscribe button instead
    // (moved from tests/product_selling_2717.test.tsx, #4582).
    expect(text()).not.toContain("View plans");
    // No selling section and no preview panel live in the catalog panel.
    expect(text()).not.toContain("Show selling options");
    expect(container.querySelector('select[aria-label="Marketing channel"]')).toBeNull();
    expect(seen.map((s) => s.url)).toEqual(["/api/products/catalog"]);
  });

  it("Subscribe calls onSubscribe and mounts no selling section here", async () => {
    const { impl } = catalogFetch();
    const { onSubscribe } = await renderPanel(impl);
    await act(async () => {
      buttonByText("Subscribe").click();
    });
    await flush();
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("Show selling options");
    expect(container.querySelector("#selling-plan")).toBeNull();
  });

  it("Preview draft calls onPreviewDraft with the row and renders no preview panel here", async () => {
    const { impl } = catalogFetch();
    const { onPreviewDraft } = await renderPanel(impl);
    await act(async () => {
      buttonByText("Preview draft").click();
    });
    await flush();
    expect(onPreviewDraft).toHaveBeenCalledTimes(1);
    expect(onPreviewDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "options:PayPerUse" }),
    );
    expect(container.querySelector('select[aria-label="Marketing channel"]')).toBeNull();
    expect(text()).not.toContain("Draft Preview");
  });
});
