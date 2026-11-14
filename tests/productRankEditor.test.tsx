/** @vitest-environment jsdom */
/**
 * Issue #3246 (sub-issue of #3241), slice 2 — the per-product
 * ladder-position editor in the Products section.
 *
 * Pins (design §9.2/§5.3): the editor saves through the set-rank
 * route with client-side validation (a positive whole number, or
 * empty to clear); an invalid value renders the catalog message
 * and posts nothing; the Free baseline product shows its fixed
 * rank with NO edit control; the new-product form carries an
 * optional rank input that is included in the create body only
 * when provided.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProductsSection } from "../src/client/ProductsSection";
import { codedMessage } from "../src/outcomes/outcomeAspects";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface ProductRow {
  id: string;
  name: string;
  kind: "subscription" | "per_run";
  description: string | null;
  rank: number | null;
}

interface MockState {
  products: ProductRow[];
  calls: Array<{ url: string; method: string | undefined; body: unknown }>;
  rankStatus: number | null;
}

function productsFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    state.calls.push({ url, method: init?.method, body });
    if (url === "/api/payments/agentic/commercial/products" && (!init?.method || init.method === "GET")) {
      return ok({ products: state.products.map((product) => ({ product, versions: [] })) });
    }
    const rankMatch = url.match(/^\/api\/payments\/agentic\/commercial\/products\/([^/]+)\/rank$/);
    if (rankMatch && init?.method === "POST") {
      if (state.rankStatus) return err(state.rankStatus);
      const product = state.products.find((p) => p.id === decodeURIComponent(rankMatch[1]));
      if (!product) return err(404);
      product.rank = (body as { rank: number | null }).rank;
      return ok({ product });
    }
    if (url === "/api/payments/agentic/commercial/products" && init?.method === "POST") {
      const b = body as { name: string; kind: "subscription" | "per_run"; description: string | null; rank?: number };
      state.products.push({
        id: `prod-${state.products.length + 1}`,
        name: b.name,
        kind: b.kind,
        description: b.description,
        rank: b.rank ?? null,
      });
      return ok({});
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
      { id: "prod-free", name: "Free", kind: "subscription", description: null, rank: 1 },
      { id: "prod-basic", name: "Basic", kind: "subscription", description: null, rank: 2 },
      { id: "prod-premium", name: "Premium", kind: "subscription", description: null, rank: null },
    ],
    calls: [],
    rankStatus: null,
  };
}

function rowEl(productId: string): HTMLElement {
  const row = container!.querySelector(`[data-testid="product-row-${productId}"]`) as HTMLElement | null;
  if (!row) throw new Error(`No row for ${productId}`);
  return row;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function rankInputFor(productId: string): HTMLInputElement {
  const row = rowEl(productId);
  const label = Array.from(row.querySelectorAll("label")).find((l) =>
    (l.textContent || "").includes("Ladder position"),
  );
  if (!label) throw new Error(`No rank label in row ${productId}`);
  const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
  const input = (id ? document.getElementById(id) : label.querySelector("input")) as HTMLInputElement | null;
  if (!input) throw new Error(`No rank input in row ${productId}`);
  return input;
}

async function clickSaveFor(productId: string) {
  const row = rowEl(productId);
  const button = Array.from(row.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === "Save ladder position",
  );
  if (!button) throw new Error(`No save button in row ${productId}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {});
  await act(async () => {});
}

function rankCalls(state: MockState) {
  return state.calls.filter((c) => c.url.endsWith("/rank"));
}

describe("ladder position editor", () => {
  it("shows the current rank per row and saves through the set-rank route", async () => {
    const state = baseState();
    await renderSection(state);
    expect(rowEl("prod-basic").textContent || "").toContain("Ladder position: 2");
    expect(rowEl("prod-premium").textContent || "").toContain("Ladder position: Unranked");
    expect(rankInputFor("prod-premium").value).toBe("");
    await act(async () => {
      setInputValue(rankInputFor("prod-premium"), "3");
    });
    await clickSaveFor("prod-premium");
    expect(rankCalls(state)).toHaveLength(1);
    expect(rankCalls(state)[0].url).toBe(
      "/api/payments/agentic/commercial/products/prod-premium/rank",
    );
    expect(rankCalls(state)[0].body).toEqual({ rank: 3 });
    // The reload reflects the saved rank.
    expect(rowEl("prod-premium").textContent || "").toContain("Ladder position: 3");
  });

  it("an empty input clears the rank to null", async () => {
    const state = baseState();
    await renderSection(state);
    expect(rankInputFor("prod-basic").value).toBe("2");
    await act(async () => {
      setInputValue(rankInputFor("prod-basic"), "");
    });
    await clickSaveFor("prod-basic");
    expect(rankCalls(state)).toHaveLength(1);
    expect(rankCalls(state)[0].body).toEqual({ rank: null });
    expect(rowEl("prod-basic").textContent || "").toContain("Ladder position: Unranked");
  });

  it("an invalid rank renders the catalog message and posts nothing", async () => {
    const state = baseState();
    await renderSection(state);
    await act(async () => {
      setInputValue(rankInputFor("prod-basic"), "0");
    });
    await clickSaveFor("prod-basic");
    expect(rankCalls(state)).toHaveLength(0);
    expect(rowEl("prod-basic").textContent || "").toContain(
      codedMessage("FAILURE_PRODUCT_RANK_INVALID"),
    );
    await act(async () => {
      setInputValue(rankInputFor("prod-basic"), "1.5");
    });
    await clickSaveFor("prod-basic");
    expect(rankCalls(state)).toHaveLength(0);
  });

  it("the Free baseline shows its fixed rank with no edit control", async () => {
    const state = baseState();
    await renderSection(state);
    const row = rowEl("prod-free");
    expect(row.textContent || "").toContain("Ladder position: 1");
    expect(row.textContent || "").toContain("fixed");
    expect(row.querySelectorAll("input")).toHaveLength(0);
    const buttons = Array.from(row.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.join(" ")).not.toContain("Save ladder position");
  });

  it("a failed save renders the failure without changing the displayed rank", async () => {
    const state = baseState();
    state.rankStatus = 503;
    await renderSection(state);
    await act(async () => {
      setInputValue(rankInputFor("prod-basic"), "5");
    });
    await clickSaveFor("prod-basic");
    expect(rankCalls(state)).toHaveLength(1);
    expect(rowEl("prod-basic").textContent || "").toContain("Ladder position: 2");
  });
});

describe("new-product rank input", () => {
  async function openForm() {
    // Issue #4511 — the create form lives in the "Create product"
    // sub-tab directly (the tab is the entry; there is no "New
    // product" toggle any more).
    const tab = Array.from(container!.querySelectorAll('button[role="tab"]')).find((b) =>
      (b.textContent || "").includes("Create product"),
    );
    if (!tab) throw new Error("No Create product tab");
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
  }

  function inputForFormLabel(labelText: string): HTMLInputElement {
    const label = Array.from(container!.querySelectorAll("label")).find((l) =>
      (l.textContent || "").includes(labelText),
    );
    if (!label) throw new Error(`No label found for: ${labelText}`);
    const id = label.getAttribute("for") || (label as HTMLLabelElement).htmlFor;
    const input = (id ? document.getElementById(id) : label.querySelector("input")) as HTMLInputElement | null;
    if (!input) throw new Error(`No input found for label: ${labelText}`);
    return input;
  }

  it("includes the rank in the create body when provided", async () => {
    const state = baseState();
    await renderSection(state);
    await openForm();
    await act(async () => {
      setInputValue(inputForFormLabel("Product name"), "Enterprise");
      setInputValue(inputForFormLabel("Ladder position (optional)"), "4");
    });
    await act(async () => {
      const create = Array.from(container!.querySelectorAll("button")).find(
        (b) => b.getAttribute("role") !== "tab" && (b.textContent || "").trim() === "Create product",
      );
      create!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    await act(async () => {});
    const creates = state.calls.filter(
      (c) => c.url === "/api/payments/agentic/commercial/products" && c.method === "POST",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0].body).toMatchObject({ name: "Enterprise", rank: 4 });
  });

  it("omits the rank from the create body when left empty", async () => {
    const state = baseState();
    await renderSection(state);
    await openForm();
    await act(async () => {
      setInputValue(inputForFormLabel("Product name"), "Enterprise");
    });
    await act(async () => {
      const create = Array.from(container!.querySelectorAll("button")).find(
        (b) => b.getAttribute("role") !== "tab" && (b.textContent || "").trim() === "Create product",
      );
      create!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    await act(async () => {});
    const creates = state.calls.filter(
      (c) => c.url === "/api/payments/agentic/commercial/products" && c.method === "POST",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0].body).not.toHaveProperty("rank");
  });

  it("an invalid rank blocks creation with the catalog message", async () => {
    const state = baseState();
    await renderSection(state);
    await openForm();
    await act(async () => {
      setInputValue(inputForFormLabel("Product name"), "Enterprise");
      setInputValue(inputForFormLabel("Ladder position (optional)"), "-1");
    });
    await act(async () => {
      const create = Array.from(container!.querySelectorAll("button")).find(
        (b) => b.getAttribute("role") !== "tab" && (b.textContent || "").trim() === "Create product",
      );
      create!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    const creates = state.calls.filter(
      (c) => c.url === "/api/payments/agentic/commercial/products" && c.method === "POST",
    );
    expect(creates).toHaveLength(0);
    expect(container!.textContent || "").toContain(codedMessage("FAILURE_PRODUCT_RANK_INVALID"));
  });
});
