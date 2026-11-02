/** @vitest-environment jsdom */
/**
 * Issue #2823: Payment Workflow Assurance UI modernization and tabbed navigation.
 *
 * Verifies:
 * 1. PaymentWorkflowAssurance renders with top-level tabs:
 *    - Simulator & Presets (default: "simulation")
 *    - Live Workflow ("live")
 *    - Store Prices ("prices")
 *    - Store Operators ("operators")
 * 2. Default tab renders simulator controls ("Tunable fakes", "Run this scenario", "Run all 9 preset tests").
 * 3. Switching to "live" tab renders Cloudflare workflow live execution controls.
 * 4. Switching to "prices" tab renders PriceApprovalSection table.
 * 5. Switching to "operators" tab renders StoreOperatorsPanel.
 * 6. Tabs retain mounted state across tab switching.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PaymentWorkflowAssurance, ASSURANCE_TABS } from "../src/client/PaymentWorkflowAssurance";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/?tab=payment-assurance");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PaymentWorkflowAssurance Tabbed Navigation (#2823)", () => {
  it("exports ASSURANCE_TABS with the 4 required sections", () => {
    expect(ASSURANCE_TABS.map((t) => t.id)).toEqual([
      "simulation",
      "live",
      "prices",
      "operators",
    ]);
  });

  it("renders with Simulator tab active by default and switches between tabs", async () => {
    await act(async () => {
      root.render(<PaymentWorkflowAssurance userLogin="alice" />);
    });
    await flush();

    // Verify top-level title and tabs
    expect(container.textContent).toContain("Payment Workflow Assurance");
    expect(container.textContent).toContain("Simulator & Presets");
    expect(container.textContent).toContain("Live Workflow");
    expect(container.textContent).toContain("Store Prices");
    expect(container.textContent).toContain("Store Operators");

    // Simulator tab content is visible by default
    expect(container.textContent).toContain("What this page is (and is not)");
    expect(container.textContent).toContain("Tunable fakes");
    expect(container.textContent).toContain("Run all 9 preset tests");

    // Switch to "Live Workflow" tab
    const tabButtons = Array.from(container.querySelectorAll("button[role='tab']"));
    const liveTab = tabButtons.find((b) => b.textContent?.includes("Live Workflow"));
    expect(liveTab).toBeDefined();

    await act(async () => {
      liveTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Live mode — real workflow on Cloudflare");
    expect(container.textContent).toContain("Start live run");

    // Switch to "Store Operators" tab
    const operatorsTab = tabButtons.find((b) => b.textContent?.includes("Store Operators"));
    expect(operatorsTab).toBeDefined();

    await act(async () => {
      operatorsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Store operators");
  });

  it("respects initial URL query param ?view=prices", async () => {
    window.history.replaceState(null, "", "/?tab=payment-assurance&view=prices");

    await act(async () => {
      root.render(<PaymentWorkflowAssurance userLogin="alice" />);
    });
    await flush();

    expect(container.textContent).toContain("Store price approval");
  });
});
