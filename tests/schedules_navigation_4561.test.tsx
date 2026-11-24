/** @vitest-environment jsdom */
/**
 * Issue #4561 — Schedules navigation consolidation (navigation-only).
 *
 * Background Tasks becomes a fifth Schedules view; the goals/runs links
 * leave the platform-admin sub-menu; Schedules gains a left-nav sub-menu
 * and `schedules:*` deep links. No data consolidation, no view
 * consolidation: the queue view and Background Tasks stay separate tabs,
 * Workflow Runs and Free Runs stay where they are, and the
 * `legacySchedulesRedirect` shims keep working.
 * (Issue #4574, later: the Queues-page async-jobs copy this header once
 * said stays is removed as covered by Background Tasks, and the
 * dead-letter queue becomes the sixth view — the pins below now assert
 * six.)
 * (Issue #4260, later: the scheduling-channel flags become the seventh
 * view — the pins below now assert seven.)
 *
 * Pins:
 * - 4561-P01 the home resolves exactly seven views, Flags last.
 * - 4561-P02 the Schedules left-nav item carries one sub-menu entry per
 *   view, each with a label, description, and a resolvable icon.
 * - 4561-P03 every Schedules view resolves through the deep-link catalog
 *   to `?tab=schedules&view=<view>` — no view falls back to autopilot.
 * - 4561-P04 the schedules surface lists the seven views and the home
 *   mounts a TabPanel for each.
 * - 4561-P05 background-tasks / scheduled-goals / jobs are gone from the
 *   platform-admin sub-menu, the config items, the deep-link overrides,
 *   and the platform-admin surface values.
 * - 4561-P06 the retired platform-admin addresses still redirect to the
 *   home (the redirect is what makes the removal safe).
 * - 4561-P07 the home renders the Background Tasks tab and mounts the
 *   async-jobs panel on it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The home's panels fetch on mount; the navigation is under test, not them.
vi.mock("../src/client/AsyncJobsPanel", () => ({
  AsyncJobsPanel: () => <div data-testid="async-jobs-panel">async jobs</div>,
}));

import { SchedulesHome } from "../src/client/SchedulesHome";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  SCHEDULES_HOME_VIEWS,
  SCHEDULES_HOME_VIEW_LABELS,
  legacySchedulesRedirect,
} from "../src/client/schedulesHomeView";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  findNavItemConfig,
} from "../src/client/navConfig";
import { NAV_ICON_MAP } from "../src/client/components/NavigationMenu";
import {
  DEEP_LINK_OVERRIDES,
  SURFACE_TAB_DEFS,
  deepLinkForNavNode,
  deepLinkHrefForNavNode,
} from "../src/client/deepLinks";
import {
  platformAdminItems,
  PLATFORM_ADMIN_NAV_ITEMS,
} from "../src/client/platformAdminConfig";
import navConfigData from "../src/client/nav-config.json";

const here = join(process.cwd());
function read(rel: string): string {
  return readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
}

const SEVEN_VIEWS = ["list", "runs", "goals", "queue", "background-tasks", "dead-letter-queue", "flags"] as const;
const SEVEN_LABELS = ["Schedules", "Run ledger", "Goal schedules", "Queue", "Background Tasks", "Dead-letter queue", "Flags"];

describe("4561-P01 the home resolves exactly seven views (#4561)", () => {
  it("SCHEDULES_HOME_VIEWS lists the seven views, Flags last", () => {
    expect([...SCHEDULES_HOME_VIEWS]).toEqual([...SEVEN_VIEWS]);
    expect(SEVEN_VIEWS.map((v) => SCHEDULES_HOME_VIEW_LABELS[v])).toEqual(SEVEN_LABELS);
  });
});

describe("4561-P02 Schedules carries one sub-menu entry per view (#4561)", () => {
  it("the Schedules item has seven sub-items with labels, descriptions, and icons", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "schedules");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(7);
    for (const [index, view] of SEVEN_VIEWS.entries()) {
      const sub = item!.subItems![index];
      expect(sub.id).toBe(view);
      expect(sub.label).toBe(SEVEN_LABELS[index]);
      expect(sub.description).toBeTruthy();
      expect(sub.description!.length).toBeGreaterThan(0);
      expect(sub.icon).toBeTruthy();
      expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
    }
    // The sub-menu entries are the views, not nav ids of their own.
    expect(findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "schedules")).toBeDefined();
  });
});

describe("4561-P03 every Schedules view resolves through the catalog (#4561)", () => {
  it("each view deep-links to ?tab=schedules&view=<view>", () => {
    for (const view of SEVEN_VIEWS) {
      expect(deepLinkForNavNode("schedules", view)).toEqual({
        tab: "schedules",
        view,
      });
      expect(deepLinkHrefForNavNode("schedules", view)).toBe(`?tab=schedules&view=${view}`);
      // The override keys are real nav-node keys, not legacy leftovers.
      expect(DEEP_LINK_OVERRIDES[`schedules:${view}`]).toEqual({
        tab: "schedules",
        view,
      });
    }
  });
});

describe("4561-P04 the schedules surface lists the seven views (#4561)", () => {
  it("the surface def carries all seven values and the home mounts a TabPanel for each", () => {
    const surface = SURFACE_TAB_DEFS.find((d) => d.surface === "schedules");
    expect(surface).toBeDefined();
    expect(surface!.page).toBe("schedules");
    expect(surface!.param).toBe("view");
    expect([...surface!.values]).toEqual([...SEVEN_VIEWS]);
    const home = read("src/client/SchedulesHome.tsx");
    for (const view of SEVEN_VIEWS) {
      expect(home).toContain(`tabId="${view}"`);
      expect(home).toContain(`deepLink.view === "${view}"`);
    }
    expect(home).toContain("AsyncJobsPanel");
  });
});

describe("4561-P05 the three ids are gone from Platform Admin (#4561)", () => {
  it("config items, nav items, and the sub-menu no longer carry them", () => {
    const ids = platformAdminItems().map((item) => item.id);
    expect(ids).not.toContain("background-tasks");
    expect(ids).not.toContain("scheduled-goals");
    expect(ids).not.toContain("jobs");
    // 15 → 13 in #4575: free-runs and products left Platform Admin for the
    // product hub, which already owned both views.
    // 13 → 7 in #4585: data-providers, data-lifecycle, downloads,
    // iaaa-admin, users, and admin-access moved to the DataHub and
    // SecurityHub hubs.
    // 7 → 8 in #6151 S4: nav-config (Nav & Menu Access) joins.
    expect(ids).toHaveLength(8);
    const navIds = PLATFORM_ADMIN_NAV_ITEMS.map((item) => item.id);
    expect(navIds).not.toContain("platform-admin:background-tasks");
    expect(navIds).not.toContain("platform-admin:scheduled-goals");
    expect(navIds).not.toContain("platform-admin:jobs");
    const subMenu = (navConfigData.subMenus as Record<string, { id: string }[]>)["platform-admin"];
    const subIds = subMenu.map((item) => item.id);
    expect(subIds).not.toContain("platform-admin:background-tasks");
    expect(subIds).not.toContain("platform-admin:scheduled-goals");
    // 9 → 5 in #4585: the JSON sub-menu was always a partial mirror of the
    // derived sections; the six moved sections had four entries here
    // (data-providers, iaaa-admin, users, downloads) and all four left.
    expect(subIds).toHaveLength(5);
  });

  it("the deep-link overrides are deleted and the platform-admin surface drops background-tasks", () => {
    expect(DEEP_LINK_OVERRIDES["platform-admin:scheduled-goals"]).toBeUndefined();
    expect(DEEP_LINK_OVERRIDES["platform-admin:jobs"]).toBeUndefined();
    const platformAdmin = SURFACE_TAB_DEFS.find((d) => d.surface === "platform-admin");
    expect(platformAdmin).toBeDefined();
    expect(platformAdmin!.values).not.toContain("background-tasks");
    expect(platformAdmin!.values).not.toContain("scheduled-goals");
    expect(platformAdmin!.values).not.toContain("jobs");
  });
});

describe("4561-P06 the retired addresses still redirect to the home (#4561)", () => {
  it("legacySchedulesRedirect maps all three retired platform-admin addresses", () => {
    expect(legacySchedulesRedirect("?tab=platform-admin&view=scheduled-goals")).toEqual({
      tab: "schedules",
      view: "goals",
    });
    expect(legacySchedulesRedirect("?tab=platform-admin&view=jobs")).toEqual({
      tab: "schedules",
      view: "runs",
    });
    expect(
      legacySchedulesRedirect("?tab=platform-admin&view=iaaa-admin&iaaaTab=queue"),
    ).toEqual({ tab: "schedules", view: "queue" });
    expect(legacySchedulesRedirect("?tab=schedules&view=background-tasks")).toBeNull();
  });
});

describe("4561-P07 the home renders the Background Tasks tab (#4561)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
  }

  async function settle(times = 4) {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("the Background Tasks tab mounts the async-jobs panel", async () => {
    window.history.pushState(null, "", "/?tab=schedules&view=background-tasks");
    await render(
      <ToastProvider>
        <SchedulesHome />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(SEVEN_LABELS);
    expect(container.querySelector('[data-testid="async-jobs-panel"]')).toBeTruthy();
    expect(container.textContent).toContain("Background Tasks");
    expect(container.textContent).toContain("Async jobs & execution queue");
  });

  it("the default list view still renders all seven tabs", async () => {
    window.history.pushState(null, "", "/?tab=schedules");
    await render(
      <ToastProvider>
        <SchedulesHome />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(SEVEN_LABELS);
  });
});
