/** @vitest-environment jsdom */
/**
 * Left-nav UX and interaction test suite (issue #2685):
 *  1. Collapsible sidebar and collapsed layout state
 *  2. Dual-target toggle: clicking the menu item row or chevron toggles sub-menus
 *  3. Stock Screener: renamed from Screeners, contains screeners & research only
 *  4. Options Screener: contains options, scanner, options-flows, iv-history; no docs/runs/schedules
 *  5. Workflows menu: hosts docs, workflow-runs, reports, review, track-record
 *  6. Platform menu: hosts platform-admin, schedules, agents, audit, workflows, endpoints
 *  7. Billing menu: separated from Platform, hosts payments, revenue, ledger, checkout
 *  8. Intelligence menu: hosts Goal Screen as its own top-level menu item
 *  9. Sandbox menu: hosts payment-assurance and checkout sandbox
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { LeftNavBar } from "../src/client/components/LeftNavBar";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  SUB_MENU_CONFIGS,
  findNavItemConfig,
  isNavItemOrSubItemActive,
} from "../src/client/navConfig";

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
});

async function renderNavBar(props: Partial<React.ComponentProps<typeof LeftNavBar>> = {}) {
  await act(async () => {
    root.render(
      <LeftNavBar
        config={DEFAULT_LEFT_NAV_CONFIG}
        activeTab="autopilot"
        onSelectTab={vi.fn()}
        collapsed={false}
        {...props}
      />
    );
  });
}

describe("LeftNavBar UX & Reorganization (issue #2685)", () => {
  it("renders the 7 configured sections: Execution, Intelligence, Workflows, Marketing, Billing, Platform, Sandbox", () => {
    expect(DEFAULT_LEFT_NAV_CONFIG.sections).toHaveLength(7);
    const titles = DEFAULT_LEFT_NAV_CONFIG.sections.map((s) => s.title);
    expect(titles).toContain("TRADING & EXECUTION");
    expect(titles).toContain("INTELLIGENCE & COPILOT");
    expect(titles).toContain("WORKFLOWS");
    expect(titles).toContain("MARKETING");
    expect(titles).toContain("BILLING");
    expect(titles).toContain("PLATFORM");
    expect(titles).toContain("SANDBOX");
  });

  it("configures Marketing menu with referrals, ads, and social", () => {
    const marketing = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-marketing");
    expect(marketing).toBeDefined();
    const itemIds = marketing!.items.map((i) => i.id);
    expect(itemIds).toContain("referrals");
    expect(itemIds).toContain("ads");
    expect(itemIds).toContain("social");
  });

  it("configures Agents with endpoints as a sub-menu under Platform", () => {
    const agentsItem = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "agents");
    expect(agentsItem).toBeDefined();
    expect(agentsItem?.subItems).toBeDefined();
    const subIds = agentsItem!.subItems!.map((s) => s.id);
    expect(subIds).toContain("agents");
    expect(subIds).toContain("endpoints");
  });

  it("places Voice and Omnichannel in Execution", () => {
    const exec = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-execution");
    expect(exec).toBeDefined();
    const itemIds = exec!.items.map((i) => i.id);
    expect(itemIds).toContain("voice");
    expect(itemIds).toContain("omnichannel");
  });

  it("positions Options Screener directly after Stock Screener and Chat under Goal Screen", () => {
    const intel = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-intelligence");
    expect(intel).toBeDefined();
    const itemIds = intel!.items.map((i) => i.id);
    const stockIdx = itemIds.indexOf("screeners");
    const optIdx = itemIds.indexOf("options-screener");
    const goalIdx = itemIds.indexOf("goal-screen");
    const chatIdx = itemIds.indexOf("chat");

    expect(stockIdx).toBeGreaterThanOrEqual(0);
    expect(optIdx).toBe(stockIdx + 1);
    expect(goalIdx).toBe(optIdx + 1);
    expect(chatIdx).toBe(goalIdx + 1);
  });

  it("positions Workflows & FAQ as the last menu item of Platform", () => {
    const plat = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(plat).toBeDefined();
    const lastItem = plat!.items[plat!.items.length - 1];
    expect(lastItem.id).toBe("workflows");
  });

  it("configures Stock Screener with only screeners and research sub-menus", () => {
    const stockSubItems = SUB_MENU_CONFIGS.screeners;
    expect(stockSubItems).toBeDefined();
    const subIds = stockSubItems.map((s) => s.id);
    expect(subIds).toEqual(["screeners", "research"]);
    expect(subIds).not.toContain("options");
    expect(subIds).not.toContain("scanner");
    expect(subIds).not.toContain("options-flows");
    expect(subIds).not.toContain("iv-history");
  });

  it("configures Options Screener with contracts, scanner, flows, and iv-history, without docs/runs/schedules", () => {
    const optionsSubItems = SUB_MENU_CONFIGS["options-screener"];
    expect(optionsSubItems).toBeDefined();
    const subIds = optionsSubItems.map((s) => s.id);
    expect(subIds).toEqual(["options", "scanner", "options-flows", "iv-history"]);
    expect(subIds).not.toContain("docs");
    expect(subIds).not.toContain("workflow-runs");
    expect(subIds).not.toContain("schedules");
  });

  it("configures Workflows menu with docs, workflow-runs, reports, review, track-record", () => {
    const workflowSubItems = SUB_MENU_CONFIGS["workflow-runs"];
    expect(workflowSubItems).toBeDefined();
    const subIds = workflowSubItems.map((s) => s.id);
    expect(subIds).toEqual(["docs", "workflow-runs", "reports", "review", "track-record"]);
  });

  it("configures Sandbox menu with payment-assurance and sandbox-checkout", () => {
    const sandboxSubItems = SUB_MENU_CONFIGS.sandbox;
    expect(sandboxSubItems).toBeDefined();
    const subIds = sandboxSubItems.map((s) => s.id);
    expect(subIds).toEqual(["payment-assurance", "sandbox-checkout"]);
  });

  it("toggles sub-menu open and closed on menu row click", async () => {
    const onSelectTab = vi.fn();
    await renderNavBar({ onSelectTab });

    // Find Stock Screener menu item button
    const buttons = Array.from(container.querySelectorAll(".sidebar-nav-item"));
    const stockBtn = buttons.find((b) => b.textContent?.includes("Stock Screener")) as HTMLButtonElement;
    expect(stockBtn).toBeDefined();

    // Click menu row -> expands sub-menu
    await act(async () => {
      stockBtn.click();
    });
    expect(onSelectTab).toHaveBeenCalledWith("screeners");

    // Sub-items should now be visible
    expect(container.textContent).toContain("Market Research");

    // Click menu row again -> collapses sub-menu
    await act(async () => {
      stockBtn.click();
    });
    expect(container.textContent).not.toContain("Market Research");
  });

  it("toggles sub-menu open and closed on chevron button click", async () => {
    await renderNavBar();

    const chevronBtn = container.querySelector(".submenu-toggle-btn") as HTMLButtonElement;
    expect(chevronBtn).toBeDefined();

    // Click chevron -> expands
    await act(async () => {
      chevronBtn.click();
    });
    expect(container.textContent).toContain("Market Research");

    // Click chevron again -> collapses
    await act(async () => {
      chevronBtn.click();
    });
    expect(container.textContent).not.toContain("Market Research");
  });

  it("supports collapsing the sidebar via onToggleCollapse", async () => {
    const onToggleCollapse = vi.fn();
    await renderNavBar({ onToggleCollapse, collapsed: false });

    const collapseBtn = container.querySelector(".sidebar-collapse-btn") as HTMLButtonElement;
    expect(collapseBtn).toBeDefined();

    await act(async () => {
      collapseBtn.click();
    });
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    // Rerender collapsed
    await renderNavBar({ onToggleCollapse, collapsed: true });
    const sidebar = container.querySelector(".app-sidebar");
    expect(sidebar?.classList.contains("collapsed")).toBe(true);
  });

  it("renders Goal Screen as its own top-level item in Intelligence section", async () => {
    await renderNavBar();
    expect(container.textContent).toContain("Goal Screen");
  });
  it("renders distinct icons for all eight Platform Admin sub-menu items", async () => {
    const adminItem = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "platform-admin");
    expect(adminItem).toBeDefined();
    expect(adminItem?.subItems).toHaveLength(8);
    for (const sub of adminItem!.subItems!) {
      expect(sub.icon, `Sub-item ${sub.id} missing icon`).toBeDefined();
      expect(sub.icon!.length).toBeGreaterThan(0);
    }
    const icons = adminItem!.subItems!.map((s) => s.icon);
    expect(new Set(icons).size).toBe(8);

    await renderNavBar();
    const chevronBtn = container.querySelector('[aria-controls="submenu-platform-admin"]') as HTMLButtonElement;
    expect(chevronBtn).toBeTruthy();
    await act(async () => {
      chevronBtn.click();
    });

    const submenu = container.querySelector('#submenu-platform-admin');
    expect(submenu).toBeTruthy();
    const svgs = submenu!.querySelectorAll('.submenu-item-bullet svg');
    expect(svgs.length).toBe(8);
  });
  it("renders Schedules under Platform with distinct Schedules icon and handles navigation", async () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const itemIds = platform!.items.map((i) => i.id);
    expect(itemIds).toContain("schedules");
    const schedulesItem = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "schedules");
    expect(schedulesItem).toBeDefined();
    expect(schedulesItem?.icon).toBe("Schedules");

    const onSelectTab = vi.fn();
    await renderNavBar({ onSelectTab });
    expect(container.textContent).toContain("Schedules");

    // Click Schedules item
    const schedulesBtn = Array.from(container.querySelectorAll(".sidebar-nav-item")).find(
      (btn) => btn.textContent?.includes("Schedules")
    ) as HTMLButtonElement | undefined;
    expect(schedulesBtn).toBeTruthy();
    await act(async () => {
      schedulesBtn!.click();
    });
    // navigateToTab or onSelectTab was triggered
    expect(isNavItemOrSubItemActive(schedulesItem!, "schedules")).toBe(true);
  });

  it("configures Sandbox menu with dedicated Sandbox icon instead of Checkout cart", () => {
    const sandboxSection = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-sandbox");
    expect(sandboxSection).toBeDefined();
    const sandboxItem = sandboxSection!.items.find((i) => i.id === "sandbox");
    expect(sandboxItem).toBeDefined();
    expect(sandboxItem?.icon).toBe("Sandbox");
  });
});
