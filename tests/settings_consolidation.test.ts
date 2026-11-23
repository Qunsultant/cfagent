import { describe, it, expect } from "vitest";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  isNavIdVisible,
} from "../src/client/components/NavigationMenu";
import { NAV_TAB_PRESETS } from "../src/client/navPresets";

describe("Settings Consolidation & Unified Preferences", () => {
  it("maintains complete configuration presets for navigation visible tabs", () => {
    expect(NAV_TAB_PRESETS.alltabs).toBeDefined();
    expect(NAV_TAB_PRESETS.trading).toBeDefined();
    expect(NAV_TAB_PRESETS.minimal).toBeDefined();
    expect(NAV_TAB_PRESETS.none).toBeDefined();

    // In trading, essential execution tools are active; research lives
    // in the research preset now, not trading.
    expect(NAV_TAB_PRESETS.trading.autopilot).toBe(true);
    expect(NAV_TAB_PRESETS.trading.order).toBe(true);
    expect(NAV_TAB_PRESETS.trading.portfolio).toBe(true);
    expect(NAV_TAB_PRESETS.trading["stock-hub"]).toBe(false);

    // Non-core tabs are disabled in trading
    expect(NAV_TAB_PRESETS.trading["marketing-hub"]).toBe(false);
    expect(NAV_TAB_PRESETS.trading["platform-admin"]).toBe(false);
  });

  it("provides all default items in NAVIGATION_ITEMS with proper metadata", () => {
    for (const item of NAVIGATION_ITEMS) {
      expect(item.id).toBeTruthy();
      expect(item.label).toBeTruthy();
      expect(item.category).toBeTruthy();
      expect(["Execution", "Intelligence", "Playbooks", "Platform", "Billing", "Marketing"]).toContain(item.category);
      expect(DEFAULT_VISIBLE_NAV_TABS[item.id]).toBe(true);
    }
  });

  it("supports granular tab toggling without losing other tab states", () => {
    const userTabs = { ...DEFAULT_VISIBLE_NAV_TABS };
    expect(userTabs["stock-hub"]).toBe(true);

    // Toggle stock-hub off (#2896: the screeners menu entry became Stock Hub)
    userTabs["stock-hub"] = false;
    expect(userTabs["stock-hub"]).toBe(false);
    expect(userTabs.autopilot).toBe(true);
    expect(userTabs.order).toBe(true);

    // Apply minimal preset
    const minimalTabs = { ...NAV_TAB_PRESETS.minimal };
    expect(minimalTabs.autopilot).toBe(true);
    expect(minimalTabs.portfolio).toBe(true);
    expect(minimalTabs["workflow-runs"]).toBe(false);
    // workflows is a route-only id: it follows its parent, workflow-runs.
    expect(isNavIdVisible("workflows", minimalTabs)).toBe(false);
  });
});
