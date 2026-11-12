/** @vitest-environment jsdom */
/**
 * Issue #3121 sub-issue #4110 — remove the unreachable scheduled-goals /
 * jobs mounts from PlatformAdminPanel (S6 comb finding).
 *
 * S2 folded the Platform Admin scheduled-goals and jobs outposts into the
 * schedules home (`?tab=schedules&view=goals` / `?tab=schedules&view=runs`)
 * and the tab list is clean, but the render blocks remain in
 * `src/client/PlatformAdminPanel.tsx`. They are unreachable: the drawer
 * itself never opens (`platformAdminOpen` in NavigationMenu is never set
 * true — no opener exists), the left-nav sub-menu entries resolve through
 * the deep-link catalog straight to the schedules home, and
 * `legacySchedulesRedirect` in Chat.tsx redirects the retired
 * `?tab=platform-admin&view=scheduled-goals|jobs` addresses to the home.
 *
 * Pins:
 * - 4110-P01 the panel source carries no `scheduled-goals` / `jobs`
 *   render block.
 * - 4110-P02 the panel no longer imports ScheduledGoalsPanel / JobsPanel.
 * - 4110-P03 an open drawer at either retired section mounts neither
 *   panel (render test).
 * - 4110-P04 the stale `deepLinkSurfaces` entry for `scheduled-goals`
 *   is corrected: the platform-admin surface no longer lists it as a
 *   tab id (it redirects to the home, so it is not a tab on that
 *   surface — matching `jobs`, which was never a value there).
 * - 4110-P05 the left-nav catalog still admits both ids
 *   (`platformAdminSections` / `PLATFORM_ADMIN_NAV_ITEMS`): the
 *   sub-menu shortcuts to the home stay, so this is dead-block removal
 *   only — no behavior change, and `PlatformAdminSectionId` is NOT
 *   narrowed (the ids are still admitted by the nav catalog).
 * - 4110-P06 the retired addresses still redirect to the home (the
 *   redirect is what makes the removal safe).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The admin panels fetch on mount; the drawer is under test, not them.
vi.mock("../src/client/AsyncJobsPanel", () => ({
  AsyncJobsPanel: () => <div data-testid="async-jobs-panel">async jobs</div>,
}));
vi.mock("../src/client/ScheduledGoalsPanel", () => ({
  ScheduledGoalsPanel: () => <div data-testid="scheduled-goals-panel">goals</div>,
}));
vi.mock("../src/client/JobsPanel", () => ({
  JobsPanel: () => <div data-testid="jobs-panel">jobs</div>,
}));

import { PlatformAdminPanel } from "../src/client/PlatformAdminPanel";
import { platformAdminItems } from "../src/client/platformAdminConfig";
import { PLATFORM_ADMIN_NAV_ITEMS } from "../src/client/platformAdminConfig";
import { legacySchedulesRedirect } from "../src/client/schedulesHomeView";

const here = join(process.cwd());
function read(rel: string): string {
  return readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
}

function navConfig(): {
  platformAdminSections: Array<{ items: Array<{ id: string }> }>;
  deepLinkSurfaces: Array<{ page: string; values: string[] }>;
  deepLinks: Record<string, unknown>;
} {
  return JSON.parse(read("src/client/nav-config.json"));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function panel(over: Partial<React.ComponentProps<typeof PlatformAdminPanel>> = {}) {
  return (
    <PlatformAdminPanel
      open
      onClose={() => {}}
      user={{ login: "tester", name: "Test User", providerName: "GitHub" }}
      {...over}
    />
  );
}

describe("4110-P01/P02 the dead render blocks and their imports are gone (#4110)", () => {
  it("PlatformAdminPanel.tsx carries no scheduled-goals or jobs render block", () => {
    const panelSource = read("src/client/PlatformAdminPanel.tsx");
    expect(panelSource).not.toContain('active === "scheduled-goals"');
    expect(panelSource).not.toContain('active === "jobs"');
    expect(panelSource).not.toContain("settings-scheduled-goals-section");
  });

  it("PlatformAdminPanel.tsx no longer imports the retired panels", () => {
    const panelSource = read("src/client/PlatformAdminPanel.tsx");
    expect(panelSource).not.toContain('from "./ScheduledGoalsPanel"');
    expect(panelSource).not.toContain('from "./JobsPanel"');
    expect(panelSource).not.toContain("<ScheduledGoalsPanel");
    expect(panelSource).not.toContain("<JobsPanel");
    // AsyncJobsPanel (background-tasks) is a different, live panel.
    expect(panelSource).toContain("AsyncJobsPanel");
  });
});

describe("4110-P03 an open drawer at a retired section mounts neither panel (#4110)", () => {
  it("initialSection scheduled-goals mounts no goals panel", async () => {
    await render(panel({ initialSection: "scheduled-goals" }));
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="scheduled-goals-panel"]')).toBeNull();
  });

  it("initialSection jobs mounts no jobs panel", async () => {
    await render(panel({ initialSection: "jobs" }));
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="jobs-panel"]')).toBeNull();
  });

  it("menu selection of a retired section mounts neither panel", async () => {
    await render(panel());
    const scheduledGoals = Array.from(
      container.querySelectorAll(".platform-admin-menu-item"),
    ).find((item) => item.textContent?.includes("Scheduled goals")) as HTMLElement;
    expect(scheduledGoals).toBeTruthy();
    await act(async () => {
      scheduledGoals.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="scheduled-goals-panel"]')).toBeNull();
    const jobs = Array.from(container.querySelectorAll(".platform-admin-menu-item")).find(
      (item) => item.textContent?.includes("Jobs") && !item.textContent?.includes("Background"),
    ) as HTMLElement;
    expect(jobs).toBeTruthy();
    await act(async () => {
      jobs.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="jobs-panel"]')).toBeNull();
  });
});

describe("4110-P04 the stale deepLinkSurfaces entry is corrected (#4110)", () => {
  it("the platform-admin surface no longer lists scheduled-goals as a tab id", () => {
    const config = navConfig();
    const platformAdmin = config.deepLinkSurfaces.find((s) => s.page === "platform-admin");
    expect(platformAdmin).toBeDefined();
    expect(platformAdmin!.values).not.toContain("scheduled-goals");
    // jobs was never a value there; the entry stays non-empty.
    expect(platformAdmin!.values).not.toContain("jobs");
    expect(platformAdmin!.values.length).toBeGreaterThan(0);
  });
});

describe("4110-P05 the left-nav catalog still admits both ids (#4110)", () => {
  it("platformAdminSections and the nav sub-menu still carry both ids", () => {
    const ids = platformAdminItems().map((item) => item.id);
    expect(ids).toContain("scheduled-goals");
    expect(ids).toContain("jobs");
    const navIds = PLATFORM_ADMIN_NAV_ITEMS.map((item) => item.id);
    expect(navIds).toContain("platform-admin:scheduled-goals");
    expect(navIds).toContain("platform-admin:jobs");
  });

  it("the deep-link overrides still land straight on the home", () => {
    const config = navConfig();
    expect(config.deepLinks["platform-admin:scheduled-goals"]).toEqual({
      tab: "schedules",
      view: "goals",
    });
    expect(config.deepLinks["platform-admin:jobs"]).toEqual({
      tab: "schedules",
      view: "runs",
    });
  });
});

describe("4110-P06 the retired addresses still redirect to the home (#4110)", () => {
  it("legacySchedulesRedirect maps both retired addresses", () => {
    expect(legacySchedulesRedirect("?tab=platform-admin&view=scheduled-goals")).toEqual({
      tab: "schedules",
      view: "goals",
    });
    expect(legacySchedulesRedirect("?tab=platform-admin&view=jobs")).toEqual({
      tab: "schedules",
      view: "runs",
    });
  });
});
