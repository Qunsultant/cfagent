/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScreenersHub, SCREENER_HUB_TABS } from "../src/client/ScreenersHub";
import { StockHub, STOCK_HUB_TABS } from "../src/client/StockHub";
import { CapabilityNavBar } from "../src/client/components/CapabilityNavBar";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ScreenersHub Tabbed Browsing Reference Implementation", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/screeners");
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it("exports SCREENER_HUB_TABS without the moved stocks tabs, and STOCK_HUB_TABS carries them (#2896; #2954 moves options/scanner/iv-history to OptionsHub; #2971 moves the own pages out)", () => {
    expect(SCREENER_HUB_TABS).toBeDefined();
    expect(SCREENER_HUB_TABS).not.toContain("stocks");
    expect(SCREENER_HUB_TABS).not.toContain("new-screen");
    expect(SCREENER_HUB_TABS).not.toContain("run-screen");
    expect(SCREENER_HUB_TABS).not.toContain("options");
    expect(SCREENER_HUB_TABS).not.toContain("scanner");
    expect(SCREENER_HUB_TABS).not.toContain("iv-history");
    expect(SCREENER_HUB_TABS).not.toContain("goal-screen");
    expect(SCREENER_HUB_TABS).not.toContain("reports");
    expect(SCREENER_HUB_TABS).not.toContain("schedules");
    expect(SCREENER_HUB_TABS).not.toContain("review");
    expect(SCREENER_HUB_TABS).not.toContain("track-record");
    expect(STOCK_HUB_TABS).toContain("stocks");
    expect(STOCK_HUB_TABS).toContain("new-screen");
    expect(STOCK_HUB_TABS).toContain("research");
  });

  it("deep-links directly into the tab specified by the canonical ?view param", async () => {
    window.history.replaceState(null, "", "/screeners?view=bonds");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Bonds");

    const bondsPanel = container?.querySelector('#screener-tabpanel-bonds');
    expect(bondsPanel).not.toBeNull();
    expect(bondsPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("still deep-links via a hash tab", async () => {
    window.history.replaceState(null, "", "/screeners#bonds");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Bonds");
  });

  it("deep-links directly into the tab specified by URL query param ?screenerTab", async () => {
    window.history.replaceState(null, "", "/screeners?screenerTab=bonds");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Bonds");

    // Bonds panel tabpanel is rendered and active (not hidden)
    const bondsPanel = container?.querySelector('#screener-tabpanel-bonds');
    expect(bondsPanel).not.toBeNull();
    expect(bondsPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("updates URL and history state when switching tabs (StockHub, #2896)", async () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    await act(async () => {
      root?.render(<StockHub activeEnv="TEST" initialTab="stocks" />);
    });

    // Find the new-screen tab and click it
    const buttons = Array.from(container?.querySelectorAll(".capability-tab-btn") || []);
    const newScreenBtn = buttons.find((b) => b.textContent?.includes("Run a New Screen")) as HTMLButtonElement;
    expect(newScreenBtn).toBeDefined();

    await act(async () => {
      newScreenBtn.click();
    });

    expect(pushStateSpy).toHaveBeenCalled();
    const lastCallUrl = String(pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1][2]);
    expect(lastCallUrl).toContain("view=new-screen");

    const newScreenPanel = container?.querySelector('#screener-tabpanel-new-screen');
    expect(newScreenPanel).not.toBeNull();
    expect(newScreenPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("responds to browser back/forward (popstate) events (StockHub, #2896)", async () => {
    await act(async () => {
      root?.render(<StockHub activeEnv="TEST" initialTab="stocks" />);
    });

    expect(container?.querySelector('.capability-tab-btn[aria-selected="true"]')?.textContent).toContain("Stocks");

    // Simulate browser back/forward navigation to ?screenerTab=new-screen
    window.history.replaceState(null, "", "/screeners?screenerTab=new-screen");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab?.textContent).toContain("Run a New Screen");

    const newScreenPanel = container?.querySelector('#screener-tabpanel-new-screen');
    expect(newScreenPanel).not.toBeNull();
    expect(newScreenPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("preserves mounted tab state across tab switches (retained DOM panels, StockHub, #2896)", async () => {
    await act(async () => {
      root?.render(<StockHub activeEnv="TEST" initialTab="stocks" />);
    });

    // Verify stocks panel is visible
    const stocksPanel = container?.querySelector('#screener-tabpanel-stocks');
    expect(stocksPanel).not.toBeNull();
    expect(stocksPanel?.hasAttribute("hidden")).toBe(false);

    // Switch to the new-screen tab
    const buttons = Array.from(container?.querySelectorAll(".capability-tab-btn") || []);
    const newScreenBtn = buttons.find((b) => b.textContent?.includes("Run a New Screen")) as HTMLButtonElement;
    await act(async () => {
      newScreenBtn.click();
    });

    // Stocks panel is hidden, not unmounted
    expect(stocksPanel?.hasAttribute("hidden")).toBe(true);
    const newScreenPanel = container?.querySelector('#screener-tabpanel-new-screen');
    expect(newScreenPanel).not.toBeNull();
    expect(newScreenPanel?.hasAttribute("hidden")).toBe(false);

    // Switch back to Stocks tab
    const stocksBtn = buttons.find((b) => b.textContent?.includes("Stocks")) as HTMLButtonElement;
    await act(async () => {
      stocksBtn.click();
    });

    expect(stocksPanel?.hasAttribute("hidden")).toBe(false);
    expect(newScreenPanel?.hasAttribute("hidden")).toBe(true);
  });

  it("CapabilityNavBar supports WCAG 2.2 / WAI-ARIA roving tabindex keyboard navigation", async () => {
    const handleTabChange = vi.fn();
    const tabs = [
      { id: "tab-1", label: "First Tab" },
      { id: "tab-2", label: "Second Tab" },
      { id: "tab-3", label: "Third Tab" },
    ];

    function StatefulNav() {
      const [active, setActive] = React.useState("tab-1");
      return (
        <CapabilityNavBar
          tabs={tabs}
          activeTabId={active}
          onTabChange={(id) => {
            handleTabChange(id);
            setActive(id);
          }}
          ariaLabel="Test Capabilities"
        />
      );
    }

    await act(async () => {
      root?.render(<StatefulNav />);
    });

    const tablist = container?.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist).not.toBeNull();

    // ArrowRight navigates to next tab
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(handleTabChange).toHaveBeenCalledWith("tab-2");

    // End key navigates to last tab
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(handleTabChange).toHaveBeenCalledWith("tab-3");

    // Home key navigates to first tab
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(handleTabChange).toHaveBeenCalledWith("tab-1");
  });
});
