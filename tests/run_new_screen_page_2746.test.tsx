/** @vitest-environment jsdom */
/**
 * Issue #2746: Move "Run a new screen" panel out of the stock screener panel
 * to its own dedicated page (?tab=screeners&view=new-screen) and add it as a
 * sub-menu under Stock Screener in left-nav.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { LeftNavBar } from "../src/client/components/LeftNavBar";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  SUB_MENU_CONFIGS,
  findNavItemConfig,
} from "../src/client/navConfig";
import { StockHub } from "../src/client/StockHub";

let container: HTMLDivElement;
let root: Root;

const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/screener/auto-runs")) {
      return Response.json({ runs: [] });
    }
    if (url.includes("/api/screener/runs/morning-digest")) {
      return Response.json({ digest: null });
    }
    if (url.includes("/api/screening/providers")) {
      return Response.json({
        providers: [
          {
            id: "etrade",
            label: "E*TRADE Brokerage",
            assetClasses: ["stocks", "options"],
            supportedFilters: { stocks: ["search", "exchange", "price-range", "trend", "limit"] },
          },
        ],
      });
    }
    return Response.json({});
  }) as typeof fetch;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  stubFetch();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("Run a new screen dedicated page and left-nav sub-menu (#2746)", () => {
  it("configures 'Run a new screen' as a sub-menu under Stock Hub in navConfig", () => {
    const stockSubItems = SUB_MENU_CONFIGS["stock-hub"];
    expect(stockSubItems).toBeDefined();
    const ids = stockSubItems.map((s) => s.id);
    expect(ids).toContain("new-screen");
    const newScreenItem = stockSubItems.find((s) => s.id === "new-screen");
    expect(newScreenItem?.label).toBe("Run a new screen");
    expect(newScreenItem?.shortLabel).toBe("Run");
  });

  it("renders 'Run a new screen' in the LeftNavBar sub-menu when Stock Hub is expanded", async () => {
    const onSelectTab = vi.fn();
    await act(async () => {
      root.render(
        <LeftNavBar
          config={DEFAULT_LEFT_NAV_CONFIG}
          activeTab="stock-hub"
          onSelectTab={onSelectTab}
          collapsed={false}
        />
      );
    });
    await flush();

    const subItemLabels = Array.from(
      container.querySelectorAll(".sidebar-submenu-item .submenu-item-label")
    ).map((el) => el.textContent?.trim());
    expect(subItemLabels).toContain("Run a new screen");
  });

  it("renders dedicated new-screen panel with form when initialTab is new-screen", async () => {
    await act(async () => {
      root.render(<StockHub activeEnv="PROD" userLogin="tester" initialTab="new-screen" />);
    });
    await flush();
    await flush();

    const newScreenPanel = container.querySelector("#screener-tabpanel-new-screen");
    expect(newScreenPanel).not.toBeNull();
    const form = newScreenPanel?.querySelector("form");
    expect(form).not.toBeNull();
    expect(newScreenPanel?.textContent).toContain("Run a new screen");
  });

  it("renders stocks panel with launch card pointing to new-screen when initialTab is stocks", async () => {
    await act(async () => {
      root.render(<StockHub activeEnv="PROD" userLogin="tester" initialTab="stocks" />);
    });
    await flush();
    await flush();

    const stocksPanel = container.querySelector("#screener-tabpanel-stocks");
    expect(stocksPanel).not.toBeNull();
    // Manual form is no longer inside the stocks panel
    const formInStocks = stocksPanel?.querySelector("form");
    expect(formInStocks).toBeNull();
    // Launch card is present in stocks panel
    expect(stocksPanel?.textContent).toContain("Run a new screen");
    expect(stocksPanel?.textContent).toContain("Execute a manual stock screen with custom filters");
  });
});

