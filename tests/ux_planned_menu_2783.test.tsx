/** @vitest-environment jsdom */
/**
 * Issue #2972 (retires issue #2783): the Planned menu is gone from the
 * left nav — no PLANNED section, no planned item, no planned_asset_tabs
 * flag. This file pins that absence. Issue 4630 SUPERSEDES the #2972
 * bookmark contract: the planned deep links are gone too — an old
 * planned bookmark no longer resolves to an Assets Hub view, and the
 * canonical assets-hub:* keys are the only addresses. What stays: the
 * #2438 hub-bar exclusion removal.
 *
 * The file name keeps the #2783 origin (no-deletion gate); the content
 * asserts the #2972 end state.
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
  findNavItemConfig,
} from "../src/client/navConfig";
import {
  DEEP_LINK_OVERRIDES,
  deepLinkForNavNode,
  deepLinkHref,
} from "../src/client/deepLinks";
import { TAB_TO_FEATURE_MAP } from "../src/client/featureFlags";
import { ALL_FEATURE_FLAGS } from "../src/features/featureFlagPorts";

const ROOT = join(__dirname, "..");
const hubSource = readFileSync(
  join(ROOT, "src/client/ScreenersHub.tsx"),
  "utf8",
);

const PLANNED_IDS = ["forex", "futures", "commodities", "bonds"] as const;

describe("Planned menu removal (issue #2972)", () => {
  it("has no PLANNED section and no planned item anywhere in the nav", () => {
    expect(
      DEFAULT_LEFT_NAV_CONFIG.sections.find(
        (s) => s.id === "section-planned",
      ),
    ).toBeUndefined();
    expect(
      DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.title === "PLANNED"),
    ).toBeUndefined();
    expect(findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "planned")).toBeUndefined();
  });

  it("has no planned sub-menu group in the externalized config", () => {
    expect(SUB_MENU_CONFIGS.planned).toBeUndefined();
    expect(Object.keys(SUB_MENU_CONFIGS)).not.toContain("planned");
  });

  it("retires the planned_asset_tabs flag from the registry and the tab map", () => {
    expect(ALL_FEATURE_FLAGS as readonly string[]).not.toContain(
      "planned_asset_tabs",
    );
    for (const id of ["planned", ...PLANNED_IDS]) {
      expect(id in TAB_TO_FEATURE_MAP).toBe(false);
    }
  });

  it("the Planned deep links are gone (bookmark contract superseded, issue 4630)", () => {
    // The #2972 contract kept these keys so old bookmarks still landed
    // on the Assets Hub views. Issue 4630 removes them as duplicates of
    // the assets-hub:* keys; the canonical keys are the only addresses.
    for (const key of ["planned", ...PLANNED_IDS.map((id) => `planned:${id}`)]) {
      expect(DEEP_LINK_OVERRIDES[key]).toBeUndefined();
    }
    for (const id of PLANNED_IDS) {
      expect(deepLinkForNavNode("planned", id)).toEqual({ tab: "autopilot" });
      expect(deepLinkForNavNode("assets-hub", id)).toEqual({
        tab: "assets-hub",
        view: id,
      });
      expect(deepLinkHref({ tab: "assets-hub", view: id })).toBe(
        `?tab=assets-hub&view=${id}`,
      );
    }
    expect(deepLinkForNavNode(null, "planned")).toEqual({ tab: "autopilot" });
  });

  it("removes the hub-bar exclusion (issue #2438 filter is gone)", () => {
    expect(hubSource).not.toContain("PLANNED_BAR_EXCLUDED");
  });
});

describe("Planned menu absence in the rendered nav (issue #2972)", () => {
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

  it("renders no Planned row even when the retired flag is still set", async () => {
    (window as any).__FEATURES__ = { planned_asset_tabs: true };
    await renderNavBar();
    expect(plannedRow()).toBeUndefined();
    expect(container.textContent).not.toContain("PLANNED");
  });

  it("renders no Planned row with no feature flags set", async () => {
    await renderNavBar();
    expect(plannedRow()).toBeUndefined();
    expect(container.textContent).not.toContain("PLANNED");
  });
});
