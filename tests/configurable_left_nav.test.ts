import { describe, it, expect } from "vitest";
import React from "react";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  findNavItemConfig,
  isNavItemOrSubItemActive,
  type LeftNavConfig,
  type NavMenuItemConfig,
} from "../src/client/navConfig";
import { LeftNavBar } from "../src/client/components/LeftNavBar";
import { NavigationMenu } from "../src/client/components/NavigationMenu";

describe("navConfig - externalized navigation and sub-menu configuration", () => {
  it("exports a valid default LeftNavConfig with four primary sections plus the Platform Admin and Sandbox groups", () => {
    expect(DEFAULT_LEFT_NAV_CONFIG).toBeDefined();
    // Issue #2624: the Platform Admin destination is a fifth group, appended
    // after the route-derived sections (it opens a drawer, not a route).
    // Issue #2645: the Sandbox destination is a sixth group, appended after
    // Platform Admin (it links standalone demo pages, not routes).
    expect(DEFAULT_LEFT_NAV_CONFIG.sections).toHaveLength(7);
    const categories = DEFAULT_LEFT_NAV_CONFIG.sections.map((s) => s.category);
    // The sixth group is the Platform Admin drawer destination; the seventh is
    // the Sandbox demo-links destination. Both carry the "Platform" category
    // because they belong to that navigation family.
    expect(categories).toEqual(["Execution", "Intelligence", "Playbooks", "Marketing", "Billing", "Platform", "Platform"]);
  });

  it("every section has a non-empty title and at least one menu item", () => {
    for (const section of DEFAULT_LEFT_NAV_CONFIG.sections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("configures Screeners with sub-menu options for stocks and research", () => {
    const screenersItem = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "screeners");
    expect(screenersItem).toBeDefined();
    expect(screenersItem?.label).toBe("Stock Screener");
    expect(screenersItem?.subItems).toBeDefined();
    expect(screenersItem!.subItems!.length).toBeGreaterThanOrEqual(2);

    const subIds = screenersItem!.subItems!.map((sub) => sub.id);
    // Must include choices for stocks and options
    expect(subIds).toContain("screeners");
    expect(subIds).toContain("research"); // Stock screener
    
    const stockChoice = screenersItem!.subItems!.find((sub) => sub.id === "screeners");
    expect(stockChoice?.label).toMatch(/stock/i);

    const researchChoice = screenersItem!.subItems!.find((sub) => sub.id === "research");
    expect(researchChoice?.label).toMatch(/research/i);
  });

  it("isNavItemOrSubItemActive correctly detects parent and child active states", () => {
    const screenersItem = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "screeners")!;
    // Direct match
    expect(isNavItemOrSubItemActive(screenersItem, "screeners")).toBe(true);
    // Sub-item match (options)
    expect(isNavItemOrSubItemActive(screenersItem, "research")).toBe(true);
    // Unrelated tab
    expect(isNavItemOrSubItemActive(screenersItem, "portfolio")).toBe(false);
  });

  it("findNavItemConfig retrieves any item across sections by id", () => {
    const autopilot = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "autopilot");
    expect(autopilot).toBeDefined();
    expect(autopilot?.label).toBe("Autopilot Control");

    const nonexistent = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "nonexistent-item");
    expect(nonexistent).toBeUndefined();
  });

  it("allows constructing a custom LeftNavConfig for externalized customization", () => {
    const customConfig: LeftNavConfig = {
      sections: [
        {
          id: "custom-sec",
          title: "CUSTOM SECTION",
          category: "Execution",
          items: [
            {
              id: "custom-item",
              label: "Custom Item",
              category: "Execution",
              icon: "Autopilot",
              description: "Custom item description",
              subItems: [
                {
                  id: "custom-sub-1",
                  label: "Custom Sub 1",
                  description: "First sub item",
                },
                {
                  id: "custom-sub-2",
                  label: "Custom Sub 2",
                  description: "Second sub item",
                },
              ],
            },
          ],
        },
      ],
    };

    expect(customConfig.sections[0].items[0].subItems).toHaveLength(2);
    expect(findNavItemConfig(customConfig, "custom-item")?.label).toBe("Custom Item");
  });

  it("exports LeftNavBar as a configurable React component", () => {
    expect(typeof LeftNavBar).toBe("function");
    expect(typeof NavigationMenu).toBe("function");
  });
});
