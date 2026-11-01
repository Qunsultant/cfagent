import { describe, it, expect } from "vitest";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  NAV_TAB_PRESETS,
} from "../src/client/components/NavigationMenu";

describe("Settings Consolidation & Unified Preferences", () => {
  it("maintains complete configuration presets for navigation visible tabs", () => {
    expect(NAV_TAB_PRESETS.all).toBeDefined();
    expect(NAV_TAB_PRESETS.traderFocus).toBeDefined();
    expect(NAV_TAB_PRESETS.minimal).toBeDefined();

    // In traderFocus, essential execution & analysis tools are active
    expect(NAV_TAB_PRESETS.traderFocus.autopilot).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.order).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.portfolio).toBe(true);
    expect(NAV_TAB_PRESETS.traderFocus.research).toBe(true);

    // Non-core tabs are disabled in traderFocus
    expect(NAV_TAB_PRESETS.traderFocus.ads).toBe(false);
    expect(NAV_TAB_PRESETS.traderFocus.referrals).toBe(false);
  });

  it("provides all default items in NAVIGATION_ITEMS with proper metadata", () => {
    for (const item of NAVIGATION_ITEMS) {
      expect(item.id).toBeTruthy();
      expect(item.label).toBeTruthy();
      expect(item.category).toBeTruthy();
      expect(["Execution", "Intelligence", "Playbooks", "Platform", "Billing"]).toContain(item.category);
      expect(DEFAULT_VISIBLE_NAV_TABS[item.id]).toBe(true);
    }
  });

  it("supports granular tab toggling without losing other tab states", () => {
    const userTabs = { ...DEFAULT_VISIBLE_NAV_TABS };
    expect(userTabs.screeners).toBe(true);

    // Toggle screeners off
    userTabs.screeners = false;
    expect(userTabs.screeners).toBe(false);
    expect(userTabs.autopilot).toBe(true);
    expect(userTabs.order).toBe(true);

    // Apply minimal preset
    const minimalTabs = { ...NAV_TAB_PRESETS.minimal };
    expect(minimalTabs.autopilot).toBe(true);
    expect(minimalTabs.portfolio).toBe(true);
    expect(minimalTabs.workflows).toBe(false);
  });
});
