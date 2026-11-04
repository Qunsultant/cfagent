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

describe("Broker indicator at search (#3089)", () => {
  it("shows E*TRADE by default and follows the selection to Alpaca", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<StockSearchBar onSelectTab={() => {}} onAskAgent={() => {}} />);
    });
    await flush();
    expect(container.textContent || "").toContain("E*TRADE");
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(TENANT_PROVIDERS_CHANGED_EVENT, {
          detail: { dataProviderId: "etrade", brokerId: "alpaca" },
        }),
      );
    });
    await flush();
    expect(container.textContent || "").toContain("Alpaca");
  });
});
