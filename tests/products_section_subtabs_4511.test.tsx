/** @vitest-environment jsdom */
/**
 * Issue #4511 — product creation and new-version creation as sub-tabs
 * of the Platform Admin Products page.
 *
 * TDD RED first: ProductsSection gains local-state sub-tabs
 * ("products" | "create-product" | "create-version") via the
 * Tabs/TabPanel primitives. Local state, not URL-synced, so the tabs
 * never fight the parent PlatformAdminPage "view" param. The
 * "create-product" tab holds the New product form directly (the tab
 * is the entry — no "New product" toggle). The "create-version" tab
 * holds a product Select plus the NewVersionForm for the selected
 * product, opened directly via its new startOpen prop (default
 * false, so the in-row "New version" button is unchanged). Creating
 * a product returns to the Products tab with a note; creating a
 * version posts to the same versions route the in-row form uses.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProductsSection } from "../src/client/ProductsSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface MockState {
  products: Array<{ id: string; name: string; kind: string; description: string | null }>;
  versions: Record<string, Array<{ id: string; version: number; priceUSD: number; periodDays: number; segment: string; status: string }>>;
  calls: Array<{ url: string; method: string | undefined; body: unknown }>;
}

function productsFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ url, method: init?.method, body });
    if (url === "/api/payments/agentic/commercial/products" && (!init?.method || init.method === "GET")) {
      return ok({
        products: state.products.map((product) => ({
          product,
          versions: state.versions[product.id] ?? [],
        })),
      });
    }
    if (url === "/api/payments/agentic/commercial/products" && init?.method === "POST") {
      const b = body as { name: string; kind: string; description: string | null };
      state.products.push({ id: `prod-${state.products.length + 1}`, name: b.name, kind: b.kind, description: b.description });
      return ok({});
    }
    const versionMatch = url.match(/^\/api\/payments\/agentic\/commercial\/products\/([^/]+)\/versions$/);
    if (versionMatch && init?.method === "POST") {
      const productId = decodeURIComponent(versionMatch[1]);
      const list = state.versions[productId] ?? [];
      const next = { id: `ver-${list.length + 1}`, version: list.length + 1, priceUSD: (body as any).priceUSD, periodDays: (body as any).periodDays, segment: (body as any).segment, status: "proposed" };
      list.push(next);
      state.versions[productId] = list;
      return ok({ plan: next });
    }
    if (url === "/api/payments/agentic/commercial/billing-policy") {
      return ok({ policy: { annualDiscountPct: 15 } });
    }
    return err(404);
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderSection(state: MockState) {
  vi.stubGlobal("fetch", productsFetch(state));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ProductsSection));
  });
  await act(async () => {});
  await act(async () => {});
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function baseState(): MockState {
  return {
    products: [
      { id: "prod-test-subs", name: "Test-Subs", kind: "subscription", description: null },
      { id: "prod-basic", name: "Basic", kind: "subscription", description: null },
    ],
    versions: {
      "prod-test-subs": [{ id: "ver-1", version: 1, priceUSD: 1, periodDays: 30, segment: "default", status: "approved" }],
      "prod-basic": [],
    },
    calls: [],
  };
}

function tabButton(label: string): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll('button[role="tab"]')).find((b) =>
    (b.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`tab not found: ${label}`);
  return found as HTMLButtonElement;
}

function buttonByText(text: string): HTMLButtonElement {
  // Exclude the tab buttons (role="tab") — a tab label can share the
  // submit button's text ("Create product" / "Create version").
  const found = Array.from(container!.querySelectorAll("button")).find((b) =>
    b.getAttribute("role") !== "tab" && (b.textContent ?? "").trim() === text,
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function inputForLabel(labelText: string): HTMLInputElement {
  const label = Array.from(container!.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`No label found for: ${labelText}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const input = (id ? document.getElementById(id) : label.querySelector("input")) as HTMLInputElement | null;
  if (!input) throw new Error(`No input found for label: ${labelText}`);
  return input;
}

function text(): string {
  return container!.textContent || "";
}

async function clickTab(label: string) {
  await act(async () => {
    tabButton(label).click();
  });
  await act(async () => {});
  await act(async () => {});
}

describe("ProductsSection sub-tabs (#4511)", () => {
  it("defaults to the Products tab; the create forms are not shown", async () => {
    const state = baseState();
    await renderSection(state);
    expect(tabButton("Products").getAttribute("aria-selected")).toBe("true");
    expect(tabButton("Create product").getAttribute("aria-selected")).toBe("false");
    expect(tabButton("Create version").getAttribute("aria-selected")).toBe("false");
    expect(text()).toContain("Test-Subs");
    expect(text()).toContain("Basic");
    // The create forms live in their own tabs, not on the list. (The
    // tab labels themselves read "Create product" / "Create version",
    // so the form is pinned by its fields, not by the tab text.)
    expect(text()).not.toContain("Product name");
    expect(text()).not.toContain("New version of");
  });

  it("the Create product tab holds the form directly and creating returns to the list with a note", async () => {
    const state = baseState();
    await renderSection(state);
    await clickTab("Create product");
    expect(text()).toContain("Create product");
    await act(async () => {
      setInputValue(inputForLabel("Product name"), "Enterprise");
    });
    await act(async () => {
      buttonByText("Create product").click();
    });
    await act(async () => {});
    await act(async () => {});
    const creates = state.calls.filter(
      (c) => c.url === "/api/payments/agentic/commercial/products" && c.method === "POST",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({ name: "Enterprise", kind: "subscription" });
    // Back on the Products tab, with the new product listed and a note.
    expect(tabButton("Products").getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Enterprise");
    expect(text()).toContain("created");
  });

  it("the Create version tab opens the version form directly for the selected product", async () => {
    const state = baseState();
    await renderSection(state);
    await clickTab("Create version");
    expect(text()).toContain("New version of Test-Subs");
    expect(text()).toContain("Price (USD)");
    await act(async () => {
      setInputValue(inputForLabel("Price (USD)"), "2");
      setInputValue(inputForLabel("Period (days)"), "30");
      setInputValue(inputForLabel("Included runs"), "0");
    });
    await act(async () => {
      buttonByText("Create version").click();
    });
    await act(async () => {});
    await act(async () => {});
    const creates = state.calls.filter(
      (c) => c.url === "/api/payments/agentic/commercial/products/prod-test-subs/versions" && c.method === "POST",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({ priceUSD: 2, periodDays: 30 });
    expect(text()).toContain("Version v2 created");
  });
});
