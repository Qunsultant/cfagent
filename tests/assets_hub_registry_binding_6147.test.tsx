/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ScreenersHub,
  SCREENER_HUB_TABS,
  isValidScreenerTab,
} from "../src/client/ScreenersHub";
import { isNavItemOrSubItemActive } from "../src/client/navConfig";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("#6147 S2 — Assets Hub registry + binding tabs", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/screeners");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ bindings: [], registry: undefined }),
      })) as unknown as typeof fetch,
    );
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

  it("SCREENER_HUB_TABS carries registry + binding, and isValidScreenerTab accepts them", () => {
    expect(SCREENER_HUB_TABS).toContain("registry");
    expect(SCREENER_HUB_TABS).toContain("binding");
    expect(isValidScreenerTab("registry")).toBe(true);
    expect(isValidScreenerTab("binding")).toBe(true);
    expect(isValidScreenerTab("nope")).toBe(false);
    expect(isValidScreenerTab(undefined)).toBe(false);
  });

  it("deep-links ?view=registry to the Registry tab with the registry section open", async () => {
    window.history.replaceState(null, "", "/screeners?view=registry");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Registry");

    const panel = container?.querySelector("#screener-tabpanel-registry");
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute("hidden")).toBe(false);
    // The registry view lands with the Registry Manager expanded.
    expect(panel?.textContent).toContain("Broker, Asset-Type & Account-Type Registry");
  });

  it("deep-links ?view=binding to the Binding tab with the registry section closed", async () => {
    window.history.replaceState(null, "", "/screeners?view=binding");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Binding");

    const panel = container?.querySelector("#screener-tabpanel-binding");
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute("hidden")).toBe(false);
    expect(panel?.textContent).toContain("Account & Asset-Class Binding");
    // The binding view shows the bindings form, registry collapsed.
    expect(panel?.textContent).not.toContain("Broker, Asset-Type & Account-Type Registry");
  });

  it("clicking the Registry tab round-trips the URL to view=registry (and back to binding)", async () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const buttons = Array.from(container?.querySelectorAll(".capability-tab-btn") || []);
    const registryBtn = buttons.find((b) => b.textContent?.includes("Registry")) as HTMLButtonElement;
    expect(registryBtn).toBeDefined();
    await act(async () => {
      registryBtn.click();
    });
    expect(String(pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1][2])).toContain(
      "view=registry",
    );
    expect(container?.querySelector("#screener-tabpanel-registry")?.hasAttribute("hidden")).toBe(false);

    const bindingBtn = buttons.find((b) => b.textContent?.includes("Binding")) as HTMLButtonElement;
    await act(async () => {
      bindingBtn.click();
    });
    expect(String(pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1][2])).toContain(
      "view=binding",
    );
    expect(container?.querySelector("#screener-tabpanel-binding")?.hasAttribute("hidden")).toBe(false);
  });

  it("composition: one tablist, six tabs, exactly one visible tabpanel", async () => {
    window.history.replaceState(null, "", "/screeners?view=binding");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    expect(container?.querySelectorAll('[role="tablist"]').length).toBe(1);
    expect(container?.querySelectorAll(".capability-tab-btn").length).toBe(6);
    const panels = Array.from(container?.querySelectorAll('[role="tabpanel"]') || []);
    expect(panels.filter((p) => !p.hasAttribute("hidden")).length).toBe(1);
    expect(panels.find((p) => !p.hasAttribute("hidden"))?.id).toBe("screener-tabpanel-binding");
  });

  it("#4681: the assets-hub item is active on ?tab=assets-hub&view=registry (and binding)", () => {
    const item = {
      id: "assets-hub",
      subItems: [{ id: "registry" }, { id: "binding" }],
    } as never;
    window.history.replaceState(null, "", "/?tab=assets-hub&view=registry");
    expect(isNavItemOrSubItemActive(item, "assets-hub")).toBe(true);
    window.history.replaceState(null, "", "/?tab=assets-hub&view=binding");
    expect(isNavItemOrSubItemActive(item, "assets-hub")).toBe(true);
    // The default forex view still activates the hub the same way.
    window.history.replaceState(null, "", "/?tab=assets-hub&view=forex");
    expect(isNavItemOrSubItemActive(item, "assets-hub")).toBe(true);
  });

  it("#4681: the view-match list activates the hub for the legacy ?tab=screeners&view=registry address", () => {
    // "screeners" has no route entry (retired; getNavGroup falls back
    // to "autopilot"), so the only path that activates the hub item
    // for a legacy screeners bookmark is the view-match list — the
    // exact gap the #4681 fix closes. Without "assets-hub" in that
    // list this returns false.
    const item = {
      id: "assets-hub",
      subItems: [
        { id: "forex" },
        { id: "futures" },
        { id: "commodities" },
        { id: "bonds" },
        { id: "registry" },
        { id: "binding" },
      ],
    } as never;
    window.history.replaceState(null, "", "/?tab=screeners&view=registry");
    expect(isNavItemOrSubItemActive(item, "screeners")).toBe(true);
    window.history.replaceState(null, "", "/?tab=screeners&view=binding");
    expect(isNavItemOrSubItemActive(item, "screeners")).toBe(true);
    window.history.replaceState(null, "", "/?tab=screeners&view=forex");
    expect(isNavItemOrSubItemActive(item, "screeners")).toBe(true);
  });
});
