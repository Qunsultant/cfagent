/**
 * Stock Hub split (issue #2896).
 *
 * The screener page held everything. The stock-specific tabs move to
 * their own page, Stock Hub, with exactly three tabs — and the stock
 * screener menu keeps its three sub-menus, repointed at the Hub, each
 * linked to its own tab. The old hub loses both stocks tabs; its
 * default becomes options. One home per tab: nothing is duplicated.
 *
 * Issue #2954: the options tab leaves the old hub for its own copy
 * hub, so the old hub's default becomes forex, not options.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTES, hasNavEntry, getRoute } from "../src/client/routes";
import { SUB_MENU_CONFIGS } from "../src/client/navConfig";
import { NAV_ICON_MAP } from "../src/client/components/NavigationMenu";
import {
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";
import { mapTabToTradingSubTab } from "../src/client/chat/types";
import {
  STOCK_HUB_TABS,
  isValidStockHubTab,
} from "../src/client/StockHub";
import {
  SCREENER_HUB_TABS,
  isValidScreenerTab,
} from "../src/client/ScreenersHub";

const oldHubSrc = readFileSync(join(__dirname, "../src/client/ScreenersHub.tsx"), "utf8");
const stockHubSrc = readFileSync(join(__dirname, "../src/client/StockHub.tsx"), "utf8");
const tradingHubSrc = readFileSync(join(__dirname, "../src/client/ETradeTradingHub.tsx"), "utf8");

describe("Stock Hub split (#2896)", () => {
  it("adds a stock-hub route with a nav entry and drops the screeners nav entry", () => {
    const hub = getRoute("stock-hub");
    expect(hub).toBeDefined();
    expect(hasNavEntry(hub!)).toBe(true);
    expect(hub!.navEntry!.label).toBe("Stock Hub");
    expect(hub!.navEntry!.badge).toBe("Stocks");
    expect(NAV_ICON_MAP[hub!.icon]).toBeDefined();
    const old = getRoute("screeners");
    expect(old).toBeDefined();
    expect(hasNavEntry(old!)).toBe(false);
    // Issue #2954 adds the Assets Hub nav entry: 30 → 31.
    expect(ROUTES.filter(hasNavEntry)).toHaveLength(31);
  });

  it("defines the Hub tab set: stocks, new-screen (+run-screen alias), research (+ patterns, presets #2954)", () => {
    expect([...STOCK_HUB_TABS]).toEqual(["stocks", "new-screen", "run-screen", "research", "patterns", "presets"]);
    expect(isValidStockHubTab("stocks")).toBe(true);
    expect(isValidStockHubTab("research")).toBe(true);
    expect(isValidStockHubTab("options")).toBe(false);
  });

  it("keeps the stock screener menu's sub-menus, repointed at Hub tabs (+ patterns, presets #2954)", () => {
    const subs = SUB_MENU_CONFIGS["stock-hub"];
    expect(subs).toBeDefined();
    expect(subs.map((s) => s.id)).toEqual(["screeners", "new-screen", "research", "patterns", "presets"]);
    for (const sub of subs) {
      expect(sub.description.length).toBeGreaterThan(0);
      expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
    }
    expect(deepLinkForNavNode("stock-hub", "screeners")).toEqual({
      tab: "stock-hub",
      view: "stocks",
    });
    expect(deepLinkHrefForNavNode("stock-hub", "screeners")).toBe(
      "?tab=stock-hub&view=stocks",
    );
    expect(deepLinkForNavNode("stock-hub", "new-screen")).toEqual({
      tab: "stock-hub",
      view: "new-screen",
    });
    expect(deepLinkForNavNode("stock-hub", "research")).toEqual({
      tab: "stock-hub",
      view: "research",
    });
    expect(SUB_MENU_CONFIGS["screeners"]).toBeUndefined();
  });

  it("removes both stocks tabs from the old hub and defaults it to forex (#2954)", () => {
    expect((SCREENER_HUB_TABS as readonly string[])).not.toContain("stocks");
    expect((SCREENER_HUB_TABS as readonly string[])).not.toContain("new-screen");
    expect((SCREENER_HUB_TABS as readonly string[])).not.toContain("run-screen");
    expect(isValidScreenerTab("stocks")).toBe(false);
    expect(oldHubSrc).not.toContain('id="screener-tabpanel-stocks"');
    expect(oldHubSrc).not.toContain('id="screener-tabpanel-new-screen"');
    expect(oldHubSrc).toContain('defaultTab: "forex"');
  });

  it("renders all three Hub tabs in the StockHub copy", () => {
    expect(stockHubSrc).toContain('id="screener-tabpanel-stocks"');
    expect(stockHubSrc).toContain('id="screener-tabpanel-new-screen"');
    expect(stockHubSrc).toContain("<MarketDataResearchHub");
  });

  it("routes ?tab=stock-hub through the trading hub's stock-hub subtab", () => {
    expect(mapTabToTradingSubTab("stock-hub")).toBe("stock-hub");
    expect(tradingHubSrc).toContain('effectiveSubTab === "stock-hub"');
  });
});
