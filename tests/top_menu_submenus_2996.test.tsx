/** @vitest-environment jsdom */
/**
 * Top-menu sub-menus (issue #2996).
 *
 * The top strip used to render flat buttons from the route list only,
 * so no sub-menu ever showed in top layout. The strip now sources
 * sub-menus from the left-nav config and renders them as dropdowns
 * (ui Menu primitive); menu-only parents get their own strip entries.
 * These tests pin that the strip exposes exactly the sidebar's visible
 * sub-menus — same data, same feature-flag gating — and that the
 * rendered strip behaves: dropdowns open, subs navigate, menu-only
 * triggers toggle without navigating, flat buttons keep their hrefs.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import {
  NavigationMenu,
  NAVIGATION_ITEMS,
  topStripSubItems,
  topStripMenuOnlyParents,
} from "../src/client/components/NavigationMenu";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  SUB_MENU_CONFIGS,
  findNavItemConfig,
} from "../src/client/navConfig";
import { PLATFORM_ADMIN_NAV_ITEMS } from "../src/client/platformAdminConfig";
import { isTabFeatureEnabled } from "../src/client/featureFlags";
import { deepLinkForNavNode, deepLinkHref } from "../src/client/deepLinks";

/** Sidebar-visible subs for a config item, computed from raw data (not via the helper). */
function sidebarVisibleSubs(itemId: string): string[] {
  const item = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, itemId);
  if (!item?.subItems) return [];
  const raw =
    itemId === "platform-admin"
      ? PLATFORM_ADMIN_NAV_ITEMS.map((s) => s.id)
      : (SUB_MENU_CONFIGS[itemId] ?? []).map((s) => s.id);
  // The config item's own sub list and the raw list must agree; the
  // raw list is the independent expectation for the gating check.
  expect(item.subItems.map((s) => s.id)).toEqual(raw);
  return raw.filter((id) => isTabFeatureEnabled(id as any));
}

describe("top-strip sub-menu data (issue #2996)", () => {
  it("exposes the options-screener subs (9 visible after #2994)", () => {
    // options-flows is feature-gated (options_flows flag) and filtered
    // out here, exactly as the sidebar filters it — see the parity
    // test below. The raw config still lists 10 entries.
    expect(topStripSubItems("options-screener").map((s) => s.id)).toEqual([
      "strategy-scanner",
      "options-runs",
      "discovery",
      "strategy-panel",
      "contracts-screener",
      "custom-thesis",
      "nlq-options",
      "ai-strategy-ideas",
      "iv-history",
    ]);
  });

  it("matches the sidebar's visible subs for every config parent", () => {
    for (const section of DEFAULT_LEFT_NAV_CONFIG.sections) {
      for (const item of section.items) {
        if (!item.subItems || item.subItems.length === 0) continue;
        expect(topStripSubItems(item.id).map((s) => s.id)).toEqual(
          sidebarVisibleSubs(item.id),
        );
      }
    }
  });

  it("yields no subs for a strip id that is itself a sub", () => {
    expect(topStripSubItems("docs")).toEqual([]);
    expect(topStripSubItems("workflow-runs").map((s) => s.id)).toContain("docs");
  });

  it("lists exactly the menu-only parents, in config order", () => {
    expect(topStripMenuOnlyParents().map((p) => p.id)).toEqual([
      "orders",
      "sandbox",
    ]);
  });

  it("covers every config parent with visible subs: strip dropdown or menu-only entry", () => {
    const stripIds = new Set(NAVIGATION_ITEMS.map((i) => i.id));
    const menuOnlyIds = new Set(topStripMenuOnlyParents().map((p) => p.id));
    for (const section of DEFAULT_LEFT_NAV_CONFIG.sections) {
      for (const item of section.items) {
        if (!item.subItems || item.subItems.length === 0) continue;
        const visible = topStripSubItems(item.id);
        if (visible.length === 0) {
          // Gated out everywhere — the sidebar hides these too
          // (payments in this environment) — so nothing is reachable
          // to cover. The parity test above pins the empty result.
          expect(sidebarVisibleSubs(item.id)).toEqual([]);
          continue;
        }
        const viaStrip = stripIds.has(item.id);
        const viaMenuOnly = menuOnlyIds.has(item.id);
        expect(viaStrip || viaMenuOnly).toBe(true);
      }
    }
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.pushState(null, "", "/?tab=autopilot");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.querySelectorAll('[role="menu"]').forEach((el) => el.remove());
});

async function renderTopStrip(activeTab: string = "autopilot") {
  await act(async () => {
    root.render(
      <NavigationMenu
        layout="top"
        onToggleLayout={vi.fn()}
        activeTab={activeTab as any}
        onSelectTab={vi.fn()}
        onAskAgent={vi.fn()}
        user={{ login: "tester", name: "Tester", avatar: "" }}
      />,
    );
  });
}

function menuTrigger(label: string): HTMLButtonElement {
  const triggers = [
    ...container.querySelectorAll('button[aria-haspopup="menu"]'),
  ] as HTMLButtonElement[];
  const found = triggers.find((b) => (b.textContent ?? "").includes(label));
  expect(found).toBeDefined();
  return found!;
}

describe("top-strip rendering (issue #2996)", () => {
  it("renders a dropdown for options-screener with the parent first, then its subs", async () => {
    await renderTopStrip();
    const trigger = menuTrigger("Options Screener");
    await act(async () => {
      trigger.click();
    });
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const labels = [...(menu as HTMLElement).querySelectorAll('[role="menuitem"]')].map(
      (el) => el.textContent,
    );
    expect(labels[0]).toBe("Options Screener");
    expect(labels.slice(1)).toEqual(
      topStripSubItems("options-screener").map((s) => s.label),
    );
    expect(labels).not.toContain("Best Trade");
  });

  it("navigates through the catalog when a sub is clicked", async () => {
    await renderTopStrip();
    await act(async () => {
      menuTrigger("Options Screener").click();
    });
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    const discovery = [...menu.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === "Discovery",
    );
    expect(discovery).toBeDefined();
    await act(async () => {
      (discovery as HTMLElement).click();
    });
    const link = deepLinkForNavNode("options-screener", "discovery");
    const params = new URLSearchParams(window.location.search);
    if ("tab" in link) {
      expect(params.get("tab")).toBe((link as any).tab);
      if ((link as any).view) expect(params.get("view")).toBe((link as any).view);
    }
  });

  it("renders menu-only parents as toggling triggers with subs only", async () => {
    await renderTopStrip();
    const trigger = menuTrigger("Sandbox");
    // Toggle-only: a button, not a link — no href to follow.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("href")).toBeNull();
    await act(async () => {
      trigger.click();
    });
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(topStripSubItems("sandbox").map((s) => s.label));
  });

  it("keeps flat buttons with real hrefs for entries without subs", async () => {
    await renderTopStrip();
    // Portfolio is a strip entry with no sub-menu. (Autopilot would
    // serve too, but it is feature-gated out in this environment.)
    const link = deepLinkForNavNode(null, "portfolio");
    const anchor = container.querySelector(
      `a[href="${deepLinkHref(link)}"]`,
    ) as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("aria-haspopup")).toBeNull();
  });

  it("marks a dropdown trigger active when its parent is the active tab", async () => {
    await renderTopStrip("options-screener");
    const trigger = menuTrigger("Options Screener");
    expect(trigger.className).toContain("active");
  });
});
