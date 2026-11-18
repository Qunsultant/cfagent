/** @vitest-environment jsdom */
/**
 * Issue #5230 — operator UI to manage the per-run price catalogue in
 * the Product Hub admin-products tab.
 *
 * TDD RED first: this suite imports src/client/priceCatalogueApi.ts
 * (getPriceEntries / setPrice / approvePrice) and
 * src/client/PriceCatalogueSection.tsx.
 *
 * Scope: a price editor over the EXISTING prices route only — GET
 * prices (operator-only) for the effective entries with approval
 * state, POST prices (operator-only) for price edits (land PROPOSED)
 * and for the separate explicit approval action (records the
 * approving operator login), GET operators (operator-only, proves
 * the viewer is an operator). Edits are reflected from a FRESH
 * entries read (never an optimistic assertion). Failures render as
 * fixed strings; server error bodies are never rendered. Only an
 * APPROVED price may be charged (#2547). ui primitives only.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getPriceEntries,
  setPrice,
  approvePrice,
  PriceCatalogueApiError,
  type PriceEntryView,
} from "../src/client/priceCatalogueApi";
import { PriceCatalogueSection } from "../src/client/PriceCatalogueSection";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number) {
  return { ok: false, status, json: async () => ({ error: "typed server detail" }) };
}

interface MockState {
  entries: PriceEntryView[];
  operatorsStatus: number;
  pricesStatus: number | null;
  postStatus: number | null;
  posts: Array<Record<string, unknown>>;
}

function entry(
  family: PriceEntryView["family"],
  priceUSD: number,
  approvalStatus: PriceEntryView["approvalStatus"],
): PriceEntryView {
  return {
    id: `cat-${family}-default-v1`,
    family,
    priceUSD,
    updatedAtMs: 1700000000000,
    approvalStatus,
    approvedBy: approvalStatus === "approved" ? "op1" : null,
    approvedAtMs: approvalStatus === "approved" ? 1700000000000 : null,
    productId: `prod-${family}`,
    segment: "default",
    version: 1,
    effectiveFromMs: 1700000000000,
  };
}

/** Stateful mock: POST updates server state but answers STALE, so a UI
 *  that shows the new state proves it re-read (never optimistic). */
function pricesFetch(state: MockState) {
  return async (url: string, init?: RequestInit) => {
    if (
      url === "/api/payments/agentic/commercial/prices" &&
      (!init || init.method === undefined || init.method === "GET")
    ) {
      if (state.pricesStatus) return err(state.pricesStatus);
      return ok({ code: "SUCCESS_PRICES_LISTED", entries: [...state.entries] });
    }
    if (url === "/api/payments/agentic/commercial/prices" && init?.method === "POST") {
      if (state.postStatus) return err(state.postStatus);
      const body = JSON.parse(String(init.body)) as {
        family: PriceEntryView["family"];
        priceUSD?: number;
        approvalStatus?: string;
      };
      state.posts.push({ ...body });
      const idx = state.entries.findIndex((e) => e.family === body.family);
      const stale = { ...state.entries[idx] };
      if (body.priceUSD !== undefined) {
        state.entries[idx] = {
          ...state.entries[idx],
          priceUSD: body.priceUSD,
          approvalStatus: "proposed",
          approvedBy: null,
          approvedAtMs: null,
        };
      }
      if (body.approvalStatus === "approved") {
        state.entries[idx] = {
          ...state.entries[idx],
          approvalStatus: "approved",
          approvedBy: "op1",
          approvedAtMs: 1700000001000,
        };
      }
      return ok({ code: "SUCCESS_PRICE_ENTRY_SAVED", entry: stale });
    }
    if (url === "/api/payments/agentic/commercial/operators") {
      if (state.operatorsStatus !== 200) return err(state.operatorsStatus);
      return ok({ operators: [{ login: "op1", source: "env", addedBy: null, addedAtMs: null }] });
    }
    return err(404);
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderSection(state: MockState) {
  vi.stubGlobal("fetch", pricesFetch(state));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(PriceCatalogueSection));
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
  const input = id
    ? (container!.querySelector(`#${id}`) as HTMLInputElement | null)
    : (label.querySelector("input") as HTMLInputElement | null);
  if (!input) throw new Error(`No input found for label: ${labelText}`);
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes(text),
  );
  if (!button) throw new Error(`No button found with text: ${text}`);
  return button as HTMLButtonElement;
}

function text(): string {
  return container!.textContent || "";
}

function baseState(overrides: Partial<MockState> = {}): MockState {
  return {
    entries: [
      entry("stock", 0.02, "approved"),
      entry("goal", 0.1, "approved"),
      entry("options", 0.05, "proposed"),
      entry("strategy", 0.1, "approved"),
    ],
    operatorsStatus: 200,
    pricesStatus: null,
    postStatus: null,
    posts: [],
    ...overrides,
  };
}

describe("priceCatalogueApi (#5230)", () => {
  it("getPriceEntries returns the entries", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", pricesFetch(state));
    const result = await getPriceEntries();
    expect(result.entries.map((e) => e.family)).toEqual(["stock", "goal", "options", "strategy"]);
    expect(result.entries[0].priceUSD).toBe(0.02);
    expect(result.entries[2].approvalStatus).toBe("proposed");
    vi.unstubAllGlobals();
  });

  it("setPrice posts family + priceUSD and returns the POST answer (stale by design)", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", pricesFetch(state));
    const result = await setPrice("stock", 0.03);
    expect(state.posts).toEqual([{ family: "stock", priceUSD: 0.03 }]);
    // The API returns the POST answer as-is (here the mock answers
    // STALE by design); callers must re-read and render only the
    // fresh read, never this return.
    expect(result.priceUSD).toBe(0.02);
    expect(state.entries[0].priceUSD).toBe(0.03);
    expect(state.entries[0].approvalStatus).toBe("proposed");
    vi.unstubAllGlobals();
  });

  it("approvePrice posts approvalStatus approved", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", pricesFetch(state));
    await approvePrice("options");
    expect(state.posts).toEqual([{ family: "options", approvalStatus: "approved" }]);
    expect(state.entries[2].approvalStatus).toBe("approved");
    expect(state.entries[2].approvedBy).toBe("op1");
    vi.unstubAllGlobals();
  });

  it("getPriceEntries rejects a half-shaped entry", async () => {
    const state = baseState();
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/payments/agentic/commercial/prices") {
        return ok({ entries: [{ family: "stock", priceUSD: "cheap" }] });
      }
      return err(404);
    });
    await expect(getPriceEntries()).rejects.toBeInstanceOf(PriceCatalogueApiError);
    vi.unstubAllGlobals();
  });
});

describe("PriceCatalogueSection (#5230)", () => {
  it("operator: renders each family with its price and approval state", async () => {
    const state = baseState();
    await renderSection(state);
    expect(text()).toContain("Per-run prices");
    expect(text()).toContain("stock");
    expect(text()).toContain("$0.02");
    expect(text()).toContain("$0.05");
    expect(text()).toContain("Approved by op1");
    expect(text()).toContain("Proposed — not chargeable until approved");
    expect(text()).toContain("Save price");
    expect(text()).toContain("Approve price");
  });

  it("operator: editing a price posts it and re-reads (stale POST answer)", async () => {
    const state = baseState();
    await renderSection(state);
    setInputValue(inputForLabel("Price for stock (USD)"), "0.03");
    await act(async () => {
      buttonByText("Save price").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(state.posts).toEqual([{ family: "stock", priceUSD: 0.03 }]);
    // The POST answer was the stale $0.02 entry; the re-read shows $0.03.
    expect(text()).toContain("$0.03");
    expect(inputForLabel("Price for stock (USD)").value).toBe("0.03");
  });

  it("operator: approving a proposed price posts approval and re-reads", async () => {
    const state = baseState();
    await renderSection(state);
    await act(async () => {
      buttonByText("Approve price").click();
    });
    await act(async () => {});
    await act(async () => {});
    expect(state.posts).toEqual([{ family: "options", approvalStatus: "approved" }]);
    expect(text()).toContain("Approved by op1");
    expect(text()).not.toContain("Approve price");
  });

  it("operator: an invalid price shows a fixed string and posts nothing", async () => {
    const state = baseState();
    await renderSection(state);
    setInputValue(inputForLabel("Price for stock (USD)"), "0");
    await act(async () => {
      buttonByText("Save price").click();
    });
    await act(async () => {});
    expect(state.posts).toEqual([]);
    expect(text()).toContain("The price is invalid: enter a positive amount in USD.");
  });

  it("operator: a 403 on save shows a fixed string", async () => {
    const state = baseState({ postStatus: 403 });
    await renderSection(state);
    setInputValue(inputForLabel("Price for stock (USD)"), "0.03");
    await act(async () => {
      buttonByText("Save price").click();
    });
    await act(async () => {});
    expect(text()).toContain("Only a store operator can change per-run prices.");
  });

  it("non-operator: fixed note, no values, no edit controls", async () => {
    const state = baseState({ operatorsStatus: 403 });
    await renderSection(state);
    expect(text()).toContain("Only a store operator can view or change per-run prices.");
    expect(text()).not.toContain("$0.02");
    expect(text()).not.toContain("Save price");
  });
});
