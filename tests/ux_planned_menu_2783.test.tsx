/** @vitest-environment jsdom */
/**
 * Issue #2783: Planned menu in the left nav for forex/futures/commodities/
 * bonds, hub-bar exclusion removed (nothing hidden), feature-flagged and
 * enabled for now. Pins: nav config section + subs, catalog overrides,
 * flag map + defaults, hub bar, and menu-only parent behavior (toggle
 * without navigating, hidden entirely when the flag is off).
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LeftNavBar } from "../src/client/components/LeftNavBar";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  SUB_MENU_CONFIGS,
} from "../src/client/navConfig";
import { deepLinkForNavNode, deepLinkHref } from "../src/client/deepLinks";
import {
  TAB_TO_FEATURE_MAP,
  isTabFeatureEnabled,
} from "../src/client/featureFlags";
import type { NavTabId } from "../src/client/components/NavigationMenu";
import { ALL_FEATURE_FLAGS } from "../src/features/featureFlagPorts";

const ROOT = join(__dirname, "..");
const hubSource = readFileSync(
  join(ROOT, "src/client/ScreenersHub.tsx"),
  "utf8",
);

const PLANNED_IDS = ["forex", "futures", "commodities", "bonds"] as const;

describe("Planned menu (issue #2783)", () => {
  it("adds a PLANNED section with the four asset subs", () => {
    const section = DEFAULT_LEFT_NAV_CONFIG.sections.find(
      (s) => s.id === "section-planned",
    );
    expect(section).toBeDefined();
    expect(section!.title).toBe("PLANNED");
    expect(section!.items.map((i) => i.id)).toEqual(["planned"]);
    expect(section!.items[0].subItems!.map((s) => s.id)).toEqual([
      ...PLANNED_IDS,
    ]);
    for (const sub of section!.items[0].subItems!) {
      expect(sub.badge).toBe("Planned");
    }
    expect(SUB_MENU_CONFIGS.planned.map((s) => s.id)).toEqual([
      ...PLANNED_IDS,
    ]);
  });

  it("resolves every Planned sub to its hub view link", () => {
    for (const id of PLANNED_IDS) {
      expect(deepLinkForNavNode("planned", id)).toEqual({
        tab: "screeners",
        view: id,
      });
      expect(deepLinkHref({ tab: "screeners", view: id })).toBe(
        `?tab=screeners&view=${id}`,
      );
    }
  });

  it("gates the menu and its subs on the planned_asset_tabs flag", () => {
    expect(ALL_FEATURE_FLAGS).toContain("planned_asset_tabs");
    for (const id of ["planned", ...PLANNED_IDS]) {
      expect(TAB_TO_FEATURE_MAP[id as NavTabId]).toBe("planned_asset_tabs");
    }
    for (const id of ["planned", ...PLANNED_IDS]) {
      expect(
        isTabFeatureEnabled(id as NavTabId, { planned_asset_tabs: true }),
      ).toBe(true);
      expect(isTabFeatureEnabled(id as NavTabId, {})).toBe(false);
    }
  });

  it("removes the hub-bar exclusion (issue #2438 filter is gone)", () => {
    expect(hubSource).not.toContain("PLANNED_BAR_EXCLUDED");
  });
});

describe("Planned menu behavior (issue #2783)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.pushState(null, "", "/?tab=autopilot");
    delete (window as any).__FEATURES__;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as any).__FEATURES__;
  });

  async function renderNavBar() {
    await act(async () => {
      root.render(
        <LeftNavBar
          config={DEFAULT_LEFT_NAV_CONFIG}
          activeTab="autopilot"
          onSelectTab={vi.fn()}
          collapsed={false}
        />,
      );
    });
  }

  function plannedRow() {
    const rows = Array.from(
      container.querySelectorAll(".sidebar-nav-item"),
    );
    return rows.find(
      (r) => r.querySelector(".item-label")?.textContent === "Planned",
    );
  }

  it("toggles the submenu open without navigating when the flag is on", async () => {
    (window as any).__FEATURES__ = { planned_asset_tabs: true };
    await renderNavBar();
    const row = plannedRow();
    expect(row).toBeDefined();
    await act(async () => {
      (row as HTMLElement).click();
    });
    for (const id of PLANNED_IDS) {
      expect(container.textContent).toContain(
        id.charAt(0).toUpperCase() + id.slice(1),
      );
    }
    expect(window.location.search).toBe("?tab=autopilot");
  });

  it("hides the whole menu when the flag is off", async () => {
    await renderNavBar();
    expect(plannedRow()).toBeUndefined();
    expect(container.textContent).not.toContain("PLANNED");
    expect(container.textContent).not.toContain("Forex");
  });
});
