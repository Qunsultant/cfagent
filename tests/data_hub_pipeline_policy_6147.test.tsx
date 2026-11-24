/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DataHubHome } from "../src/client/DataHubHome";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  DATA_HUB_VIEWS,
  DATA_HUB_VIEW_LABELS,
  isDataHubView,
  normalizeDataHubView,
} from "../src/client/dataHubView";
import { isNavItemOrSubItemActive } from "../src/client/navConfig";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("#6147 S3 — Data Hub pipeline-policy view", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ settings: {}, defaults: {} }),
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

  it("DATA_HUB_VIEWS carries pipeline-policy, and isDataHubView accepts it", () => {
    expect(DATA_HUB_VIEWS).toContain("pipeline-policy");
    expect(DATA_HUB_VIEW_LABELS["pipeline-policy"]).toBe("Pipeline Policy");
    expect(isDataHubView("pipeline-policy")).toBe(true);
    expect(isDataHubView("nope")).toBe(false);
    expect(normalizeDataHubView("nope")).toBe("data-providers");
    expect(normalizeDataHubView(undefined)).toBe("data-providers");
  });

  it("deep-links ?view=pipeline-policy to the Pipeline Policy tab with the panel mounted", async () => {
    window.history.replaceState(null, "", "/?tab=data-hub&view=pipeline-policy");

    await act(async () => {
      root?.render(<ToastProvider><DataHubHome /></ToastProvider>);
    });

    const activeTab = container?.querySelector('[role="tab"][aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Pipeline Policy");

    const panel = container?.querySelector("#data-hub-panel-pipeline-policy");
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute("hidden")).toBe(false);
    // The panel itself renders once its settings load.
    expect(panel?.textContent).toContain("Retry budgets and notifications");
  });

  it("clicking the Pipeline Policy tab round-trips the URL to view=pipeline-policy (and back to data-providers)", async () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    await act(async () => {
      root?.render(<ToastProvider><DataHubHome /></ToastProvider>);
    });

    const buttons = Array.from(container?.querySelectorAll('[role="tab"]') || []);
    const policyBtn = buttons.find((b) =>
      b.textContent?.includes("Pipeline Policy"),
    ) as HTMLButtonElement;
    expect(policyBtn).toBeDefined();
    await act(async () => {
      policyBtn.click();
    });
    expect(String(pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1][2])).toContain(
      "view=pipeline-policy",
    );
    expect(container?.querySelector("#data-hub-panel-pipeline-policy")).not.toBeNull();

    const providersBtn = buttons.find((b) =>
      b.textContent?.includes("Data Providers"),
    ) as HTMLButtonElement;
    await act(async () => {
      providersBtn.click();
    });
    expect(String(pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1][2])).toContain(
      "view=data-providers",
    );
    expect(container?.querySelector("#data-hub-panel-data-providers")).not.toBeNull();
  });

  it("composition: one tablist, five tabs, exactly one tabpanel", async () => {
    window.history.replaceState(null, "", "/?tab=data-hub&view=pipeline-policy");

    await act(async () => {
      root?.render(<ToastProvider><DataHubHome /></ToastProvider>);
    });

    expect(container?.querySelectorAll('[role="tablist"]').length).toBe(1);
    expect(container?.querySelectorAll('[role="tab"]').length).toBe(5);
    const panels = Array.from(container?.querySelectorAll('[role="tabpanel"]') || []);
    expect(panels.length).toBe(1);
    expect(panels[0]?.id).toBe("data-hub-panel-pipeline-policy");
  });

  it("the data-hub item is active on ?tab=data-hub&view=pipeline-policy (and data-providers)", () => {
    const item = {
      id: "data-hub",
      subItems: [{ id: "data-providers" }, { id: "pipeline-policy" }],
    } as never;
    window.history.replaceState(null, "", "/?tab=data-hub&view=pipeline-policy");
    expect(isNavItemOrSubItemActive(item, "data-hub")).toBe(true);
    window.history.replaceState(null, "", "/?tab=data-hub&view=data-providers");
    expect(isNavItemOrSubItemActive(item, "data-hub")).toBe(true);
  });
});
