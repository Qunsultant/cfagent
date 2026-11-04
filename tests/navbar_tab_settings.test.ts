import { describe, it, expect } from "vitest";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  NAV_TAB_PRESETS,
} from "../src/client/components/NavigationMenu";

describe("Navbar Visible Tabs Settings", () => {
  it("defines an entry in DEFAULT_VISIBLE_NAV_TABS for every item in NAVIGATION_ITEMS", () => {
    for (const item of NAVIGATION_ITEMS) {
      expect(DEFAULT_VISIBLE_NAV_TABS[item.id]).toBe(true);
    }
  });

  it("provides valid presets: all, traderFocus, and minimal", () => {
    expect(NAV_TAB_PRESETS.all).toBeDefined();
    expect(NAV_TAB_PRESETS.traderFocus).toBeDefined();
    expect(NAV_TAB_PRESETS.minimal).toBeDefined();

    // In all tabs preset, all items are enabled
    for (const item of NAVIGATION_ITEMS) {
      expect(NAV_TAB_PRESETS.all[item.id]).toBe(true);
    }

    // In traderFocus, core execution & intelligence tabs are enabled
    expect(NAV_TAB_PRESETS.traderFocus.autopilot).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.order).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.portfolio).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.ledger).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus["options-flows"]).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.screeners).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.research).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.chat).toBe(true);

    // Non-core administrative tabs are disabled in traderFocus
    expect(NAV_TAB_PRESETS.traderFocus.ads).toBe(false);
    expect(NAV_TAB_PRESETS.traderFocus.referrals).toBe(false);
    expect(NAV_TAB_PRESETS.traderFocus.revenue).toBe(false);

    // In minimal preset, only essential desk tools are active
    expect(NAV_TAB_PRESETS.minimal.autopilot).toBe(true);
    expect(NAV_TAB_PRESETS.minimal.order).toBe(true);
    expect(NAV_TAB_PRESETS.minimal.portfolio).toBe(true);
    expect(NAV_TAB_PRESETS.minimal.research).toBe(true);
    expect(NAV_TAB_PRESETS.minimal.chat).toBe(true);
    expect(NAV_TAB_PRESETS.minimal.scanner).toBe(false);
    expect(NAV_TAB_PRESETS.minimal.audit).toBe(false);
  });

  it("filters navigation items dynamically based on visibleTabs map", () => {
    const customVisibility: Record<string, boolean> = {
      ...DEFAULT_VISIBLE_NAV_TABS,
      ads: false,
      referrals: false,
      revenue: false,
      payments: false,
    };

    const filtered = NAVIGATION_ITEMS.filter((item) => customVisibility[item.id] !== false);
    const visibleIds = filtered.map((i) => i.id);

    expect(visibleIds).toContain("autopilot");
    expect(visibleIds).toContain("order");
    // Issue #2974 removed the Research & Dual Feed nav entry, so the
    // research route no longer renders as a nav item; chat stands in
    // as the always-visible Intelligence item here.
    expect(visibleIds).toContain("chat");
    expect(visibleIds).not.toContain("ads");
    expect(visibleIds).not.toContain("referrals");
    expect(visibleIds).not.toContain("revenue");
    expect(visibleIds).not.toContain("payments");
    expect(filtered.length).toBe(NAVIGATION_ITEMS.length - 4);
  });

  it("toggles single tab visibility state correctly", () => {
    const state: Record<string, boolean> = { ...DEFAULT_VISIBLE_NAV_TABS };
    expect(state.endpoints).toBe(true);

    // Toggle off
    state.endpoints = state.endpoints === false ? true : false;
    expect(state.endpoints).toBe(false);

    // Toggle back on
    state.endpoints = state.endpoints === false ? true : false;
    expect(state.endpoints).toBe(true);
  });
});
