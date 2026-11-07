/** @vitest-environment jsdom */
/**
 * Issue #3089 (S3): broker indicator next to the Ctrl+K search
 * control. Orders placed from anywhere route through the selected
 * broker, so the trigger shows which broker that is — default
 * E*TRADE, live-updating when the tenant providers selection
 * changes.
 *
 * Harness: jsdom render with a stubbed global fetch (the quotes
 * hook's REST fallback must not hit the network). The selection
 * change is delivered the way the app delivers it: the
 * tenant-providers-changed event the hook subscribes to.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StockSearchBar } from "../src/client/components/StockSearchBar";
import { TENANT_PROVIDERS_CHANGED_EVENT } from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Search trigger UI cleanliness (#3089, updated #3728)", () => {
  it("renders a clean search trigger with shortcut hint without redundant broker badges", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<StockSearchBar onSelectTab={() => {}} onAskAgent={() => {}} />);
    });
    await flush();
    expect(container.textContent || "").toContain("Search stocks...");
    expect(container.querySelector(".stock-search-kbd")).not.toBeNull();
    // Issue #3728: redundant broker badge removed from search bar trigger for clean UI
    expect(container.querySelectorAll(".stock-search-trigger-container .badge").length).toBe(0);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TENANT_PROVIDERS_CHANGED_EVENT, {
          detail: { dataProviderId: "etrade", brokerId: "alpaca" },
        }),
      );
    });
    await flush();
    expect(container.querySelectorAll(".stock-search-trigger-container .badge").length).toBe(0);
  });
});
