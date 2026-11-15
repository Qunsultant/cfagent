/** @vitest-environment jsdom */
/**
 * Issue 4627 (S2 of 4625): stock-hub / screeners / assets-hub fresh-load
 * routing bug — the Trading Hub hardcoded initialTab="stocks" /
 * initialTab="forex" when it mounted StockHub / ScreenersHub, and the
 * shared useUrlSyncedTabs hook adopts a valid initialTab at mount BEFORE
 * ever reading the URL. A fresh load / reload / bookmark / pasted link of
 * `?tab=stock-hub&view=research` therefore landed on stocks (live), and
 * `?tab=assets-hub&view=futures` landed on forex.
 *
 * These pins mount the COMPOSED page — ETradeTradingHub with the URL
 * preset, the way a fresh load arrives — and assert the tab the URL
 * names is the tab that is active. Per-hub unit tests (which mount
 * StockHub / ScreenersHub directly, with no initialTab) cannot catch
 * this: the bug lives in the host handoff, not in either hub.
 *
 * Post-S1 (#4626) the retired `?tab=screeners` address redirects onto
 * `?tab=assets-hub` carrying the view, so the assets-hub cases below
 * also cover the screeners address class.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("fresh-load routing through the Trading Hub (#4627)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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
    window.history.replaceState(null, "", "/");
  });

  async function mountHub(
    activeSubTab: "stock-hub" | "assets-hub",
    search: string,
  ) {
    window.history.replaceState(null, "", `/${search}`);
    await act(async () => {
      root?.render(
        <ToastProvider>
          <ETradeTradingHub
            activeSubTab={activeSubTab}
            user={{ login: "tester" }}
          />
        </ToastProvider>,
      );
    });
  }

  function visiblePanel(id: string): Element | null {
    const panel = container?.querySelector(`#${id}`) ?? null;
    if (panel && panel.hasAttribute("hidden")) return null;
    return panel;
  }

  it("fresh load of ?tab=stock-hub&view=research lands on Market Research, not stocks", async () => {
    await mountHub("stock-hub", "?tab=stock-hub&view=research");
    expect(visiblePanel("screener-tabpanel-research")).not.toBeNull();
    expect(container?.querySelector("#screener-tabpanel-stocks")).toBeNull();
    const activeTab = container?.querySelector(
      '.capability-tab-btn[aria-selected="true"]',
    );
    expect(activeTab?.textContent).toContain("Market Research");
  });

  it("fresh load of ?tab=stock-hub&view=patterns lands on Patterns, not stocks", async () => {
    await mountHub("stock-hub", "?tab=stock-hub&view=patterns");
    expect(visiblePanel("screener-tabpanel-patterns")).not.toBeNull();
    expect(container?.querySelector("#screener-tabpanel-stocks")).toBeNull();
    const activeTab = container?.querySelector(
      '.capability-tab-btn[aria-selected="true"]',
    );
    expect(activeTab?.textContent).toContain("Patterns");
  });

  it("bare ?tab=stock-hub still lands on stocks (the default)", async () => {
    await mountHub("stock-hub", "?tab=stock-hub");
    expect(visiblePanel("screener-tabpanel-stocks")).not.toBeNull();
    expect(container?.querySelector("#screener-tabpanel-research")).toBeNull();
  });

  it("fresh load of ?tab=assets-hub&view=futures lands on Futures, not forex", async () => {
    await mountHub("assets-hub", "?tab=assets-hub&view=futures");
    expect(visiblePanel("screener-tabpanel-futures")).not.toBeNull();
    expect(container?.querySelector("#screener-tabpanel-forex")).toBeNull();
    const activeTab = container?.querySelector(
      '.capability-tab-btn[aria-selected="true"]',
    );
    expect(activeTab?.textContent).toContain("Futures");
  });

  it("fresh load of ?tab=assets-hub&view=bonds lands on Bonds, not forex", async () => {
    await mountHub("assets-hub", "?tab=assets-hub&view=bonds");
    expect(visiblePanel("screener-tabpanel-bonds")).not.toBeNull();
    expect(container?.querySelector("#screener-tabpanel-forex")).toBeNull();
    const activeTab = container?.querySelector(
      '.capability-tab-btn[aria-selected="true"]',
    );
    expect(activeTab?.textContent).toContain("Bonds");
  });

  it("bare ?tab=assets-hub still lands on forex (the default)", async () => {
    await mountHub("assets-hub", "?tab=assets-hub");
    expect(visiblePanel("screener-tabpanel-forex")).not.toBeNull();
    expect(container?.querySelector("#screener-tabpanel-futures")).toBeNull();
  });
});

describe("host passes no hardcoded initialTab to either hub (#4627)", () => {
  it("the Trading Hub mounts StockHub / ScreenersHub without initialTab, so the URL selects the tab", () => {
    const hub = read("src/client/ETradeTradingHub.tsx");
    expect(hub).not.toContain('renderStockHub("stocks")');
    expect(hub).not.toContain('renderScreenersHub("forex")');
    expect(hub).toContain("renderStockHub()");
    expect(hub).toContain("renderScreenersHub()");
  });
});
