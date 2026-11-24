/** @vitest-environment jsdom */
/**
 * Left-nav UX and interaction test suite (issue #2685):
 *  1. Collapsible sidebar and collapsed layout state
 *  2. Dual-target toggle: clicking the menu item row or chevron toggles sub-menus
 *  3. Stock Hub: the stock-specific hub (issue #2896), contains stocks, new-screen & research
 *  4. Options Screener: contains options, scanner, options-flows, iv-history; no docs/runs/schedules
 *  5. Workflows menu: hosts docs, workflow-runs, workflows, reports, review, track-record
 *  6. Platform menu: hosts platform-admin, schedules, workflow-runs, queues, agents, audit, nlq
 *     (issue #2974: the Workflows item moved into Platform intact with its
 *     six-entry sub-menu; Schedules sits before it via the retargeted
 *     injection; Records NLQ moved in last; endpoints is an Agents
 *     sub-item, never top-level Platform)
 *     (issue #2957: workflows moved to the Workflow Runs menu by #2843)
 *  7. Orders/Billings/Payments section: three menus — Orders (checkout,
 *     ledger), Billing (billing, revenue), Payments (payments,
 *     payment-assurance) (issue #2968)
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
import { ROUTES, getRoute, hasNavEntry, getNavGroup } from "../src/client/routes";
import { NAVIGATION_ITEMS } from "../src/client/components/NavigationMenu";
import { NAV_TAB_PRESETS } from "../src/client/navPresets";
import { deepLinkHrefForNavNode } from "../src/client/deepLinks";

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
  it("renders the 6 configured sections: Execution, Intelligence, Marketing, Billing, Platform, Sandbox", () => {
    expect(DEFAULT_LEFT_NAV_CONFIG.sections).toHaveLength(6);
    const titles = DEFAULT_LEFT_NAV_CONFIG.sections.map((s) => s.title);
    expect(titles).toContain("TRADING & EXECUTION");
    expect(titles).toContain("INTELLIGENCE & COPILOT");
    expect(titles).not.toContain("WORKFLOWS");
    expect(titles).toContain("MARKETING");
    expect(titles).toContain("ORDERS/BILLINGS/PAYMENTS");
    expect(titles).toContain("PLATFORM");
    expect(titles).toContain("SANDBOX");
  });

  it("holds the final Platform order: Platform Admin, Schedules, Workflows, Agents, Audit & Vault, DataHub, SecurityHub, Observability (#2974; Queues retired into Schedules in #4574; audit + NLQ merged into Audit & Vault in #4575; DataHub + SecurityHub split out of Platform Admin in #4585; Observability added in #5169)", () => {
    const plat = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(plat).toBeDefined();
    expect(plat!.items.map((i) => i.id)).toEqual([
      "platform-admin",
      "schedules",
      "workflow-runs",
      "agents",
      "audit-vault",
      "data-hub",
      "security-hub",
      "observability",
    ]);
  });

  it("leaves no Playbooks stragglers: no section-workflows, no Playbooks route category (#2974)", () => {
    expect(DEFAULT_LEFT_NAV_CONFIG.sections.map((s) => s.id)).not.toContain("section-workflows");
    expect(ROUTES.filter((r) => r.category === "Playbooks")).toEqual([]);
  });

  it("removes the Research & Dual Feed top-level entry: route stays, nav entry and strip item go (#2974)", () => {
    const research = getRoute("research");
    expect(research).toBeDefined();
    expect(hasNavEntry(research!)).toBe(false);
    expect(NAVIGATION_ITEMS.map((i) => i.id)).not.toContain("research");
  });

  it("configures the Marketing menu with the Marketing Hub and the Product Hub (issue 4682)", () => {
    const marketing = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-marketing");
    expect(marketing).toBeDefined();
    const itemIds = marketing!.items.map((i) => i.id);
    // Issue 4682: the referrals, ads, and social top-level entries
    // retired into the one Marketing Hub route; the Product Hub stays.
    expect(itemIds).toContain("marketing-hub");
    expect(itemIds).toContain("product-hub");
    expect(itemIds).not.toContain("referrals");
    expect(itemIds).not.toContain("ads");
    expect(itemIds).not.toContain("social");
    const hub = marketing!.items.find((i) => i.id === "marketing-hub")!;
    expect(hub.subItems!.map((s) => s.id)).toEqual(["referrals", "ads", "social"]);
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

  it("positions Options Screener directly after Stock Hub and Chat under Goal Screen", () => {
    const intel = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-intelligence");
    expect(intel).toBeDefined();
    const itemIds = intel!.items.map((i) => i.id);
    const stockIdx = itemIds.indexOf("stock-hub");
    const optIdx = itemIds.indexOf("options-screener");
    const goalIdx = itemIds.indexOf("goal-screen");
    const oodaIdx = itemIds.indexOf("ooda");
    const chatIdx = itemIds.indexOf("chat");

    expect(stockIdx).toBeGreaterThanOrEqual(0);
    expect(optIdx).toBe(stockIdx + 1);
    expect(goalIdx).toBe(optIdx + 1);
    expect(oodaIdx).toBe(goalIdx + 1);
    expect(chatIdx).toBe(oodaIdx + 1);
  });

  it("positions workflows in the Workflows sub-menu and not top-level in Platform", () => {
    const plat = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(plat).toBeDefined();
    const itemIds = plat!.items.map((i) => i.id);
    expect(itemIds).not.toContain("workflows");
    expect(itemIds).toContain("schedules");
  });

  it("on ?tab=schedules, Schedules is active and Platform Admin is neither active nor auto-expanded (#2957)", async () => {
    await renderNavBar({ activeTab: "schedules" });
    expect(getNavGroup("schedules")).toBe("schedules");

    const buttons = Array.from(container.querySelectorAll(".sidebar-nav-item"));
    const schedulesBtn = buttons.find((b) => b.textContent?.includes("Schedules"));
    expect(schedulesBtn).toBeDefined();
    expect(schedulesBtn!.classList.contains("active")).toBe(true);

    const platformAdminBtn = buttons.find((b) => b.textContent?.includes("Platform Admin"));
    expect(platformAdminBtn).toBeDefined();
    expect(platformAdminBtn!.classList.contains("active")).toBe(false);

    // Platform Admin's sub-menu stays collapsed on landing: its wrapper
    // carries no "expanded" class (before #2957 the platform-admin
    // navGroup made it active and auto-expanded here).
    const wrappers = Array.from(container.querySelectorAll(".sidebar-nav-item-wrapper"));
    const platformAdminWrapper = wrappers.find((w) => w.textContent?.includes("Platform Admin"));
    expect(platformAdminWrapper).toBeDefined();
    expect(platformAdminWrapper!.classList.contains("expanded")).toBe(false);
  });

  it("configures Stock Hub with stocks, new-screen, research, patterns, opportunity-hunt and presets sub-menus", () => {
    const stockSubItems = SUB_MENU_CONFIGS["stock-hub"];
    expect(stockSubItems).toBeDefined();
    const subIds = stockSubItems.map((s) => s.id);
    expect(subIds).toEqual(["screeners", "new-screen", "research", "patterns", "opportunity-hunt", "presets"]);
    expect(subIds).not.toContain("options");
    expect(subIds).not.toContain("scanner");
    expect(subIds).not.toContain("options-flows");
    expect(subIds).not.toContain("iv-history");
  });

  it("configures Options Screener with contracts, scanner, flows, iv-history, and the research surfaces, without docs/runs/schedules", () => {
    const optionsSubItems = SUB_MENU_CONFIGS["options-screener"];
    expect(optionsSubItems).toBeDefined();
    const subIds = optionsSubItems.map((s) => s.id);
    expect(subIds).toEqual([
      "strategy-scanner",
      "options-runs",
      "discovery",
      "strategy-panel",
      "contracts-screener",
      "custom-thesis",
      "nlq-options",
      "ai-strategy-ideas",
      "iv-history",
      "options-flows",
    ]);
    expect(subIds).not.toContain("docs");
    expect(subIds).not.toContain("workflow-runs");
    expect(subIds).not.toContain("schedules");
  });

  it("configures Workflows menu with docs, workflows, workflow-catalog, reports, review, track-record (#4575 retired the Workflow Runs entry; the Schedules ledger is the one home)", () => {
    const workflowSubItems = SUB_MENU_CONFIGS["workflow-runs"];
    expect(workflowSubItems).toBeDefined();
    const subIds = workflowSubItems.map((s) => s.id);
    expect(subIds).toEqual([
      "docs",
      "workflows",
      "workflow-catalog",
      "reports",
      "review",
      "track-record",
    ]);
  });

  it("configures Sandbox menu with sandbox-checkout, and ORDERS/BILLINGS/PAYMENTS menus (#2968)", () => {
    const sandboxSubItems = SUB_MENU_CONFIGS.sandbox;
    expect(sandboxSubItems).toBeDefined();
    const subIds = sandboxSubItems.map((s) => s.id);
    expect(subIds).toEqual(["sandbox-checkout"]);

    const billingSec = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-billing");
    expect(billingSec).toBeDefined();
    expect(billingSec!.title).toBe("ORDERS/BILLINGS/PAYMENTS");
    const itemIds = billingSec!.items.map((i) => i.id);
    expect(itemIds).toEqual(["orders", "billing", "payments"]);
    // The pages live as submenus, not as separate top-level items:
    // revenue, ledger, checkout, and payment-assurance appear only
    // under a parent. (billing and payments ARE top-level ids too,
    // as the menu parents — the shared-id precedent workflow-runs
    // sets — and their pages are their submenu children.)
    for (const id of ["revenue", "ledger", "checkout", "payment-assurance"]) {
      expect(itemIds).not.toContain(id);
    }
    expect(SUB_MENU_CONFIGS.orders.map((s) => s.id)).toEqual(["checkout", "ledger"]);
    // Issue #4638: the billing sub-menu is one entry per Billing
    // section tab (Overview first — the billing page itself, by
    // default) plus the Revenue Analytics sibling route.
    // Issue #5230 (slice 2.32): the eleventh tab is billing-policy,
    // between plan-stripe-price and support-snapshot.
    expect(SUB_MENU_CONFIGS.billing.map((s) => s.id)).toEqual([
      "overview",
      "refund-policy",
      "refund-flow",
      "usage-billing",
      "referral-codes",
      "approved-free-quota",
      "top-up-limits",
      "offer-rules",
      "plan-stripe-price",
      "billing-policy",
      "support-snapshot",
      "revenue",
    ]);
    expect(SUB_MENU_CONFIGS.payments.map((s) => s.id)).toEqual(["payments", "payment-assurance"]);
    // Submenu links land on the same ?tab=X destinations the
    // top-level items used (default route resolution, no overrides).
    expect(deepLinkHrefForNavNode("orders", "checkout")).toBe("?tab=checkout");
    expect(deepLinkHrefForNavNode("billing", "revenue")).toBe("?tab=revenue");
    expect(deepLinkHrefForNavNode("payments", "payment-assurance")).toBe("?tab=payment-assurance");
  });

  it("toggles sub-menu open and closed on menu row click", async () => {
    const onSelectTab = vi.fn();
    await renderNavBar({ onSelectTab });

    // Find Stock Hub menu item button
    const buttons = Array.from(container.querySelectorAll(".sidebar-nav-item"));
    const stockBtn = buttons.find((b) => b.textContent?.includes("Stock Hub")) as HTMLButtonElement;
    expect(stockBtn).toBeDefined();

    // Click menu row -> expands sub-menu
    await act(async () => {
      stockBtn.click();
    });
    // Issue #2776: nav rows navigate via the URL (Chat derives its tab
    // from the routechange subscription), not via the onSelectTab prop.
    expect(window.location.search).toContain("tab=stock-hub");

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
    // Issue #4561 removed Tasks, ScheduledGoals, and Jobs (all unique);
    // issue #4585 moved Users out (the Agents duplicate with Tenants
    // leaves with it); #6151 S4 adds Nav & Menu Access (Approvals),
    // so all eight remaining icons are distinct.
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

describe("Settings footer (issue #6147 S4a)", () => {
  it("the last menu is Sandbox — verified at build time (Ceos 2026-11-23 19:40)", () => {
    const lastSection = DEFAULT_LEFT_NAV_CONFIG.sections.at(-1)!;
    expect(lastSection.id).toBe("section-sandbox");
    expect(lastSection.items.at(-1)!.id).toBe("sandbox");
  });

  it("footer settings trigger is present with preset `none` (every tab hidden)", async () => {
    await renderNavBar({ visibleTabs: NAV_TAB_PRESETS.none, onOpenSettings: vi.fn() });
    // No nav item renders under `none` …
    expect(container.querySelectorAll(".sidebar-nav-item")).toHaveLength(0);
    // … but the footer trigger is outside the visibility filter.
    const settingsBtn = container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement | null;
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn!.textContent).toContain("Settings");
  });

  it("expanded Sandbox sub-menu stays above the footer (in-flow, inside the scroll container)", async () => {
    await renderNavBar({ onOpenSettings: vi.fn() });
    const chevronBtn = container.querySelector(
      '[aria-controls="submenu-sandbox"]',
    ) as HTMLButtonElement;
    expect(chevronBtn).toBeTruthy();
    await act(async () => {
      chevronBtn.click();
    });
    const submenu = container.querySelector("#submenu-sandbox");
    expect(submenu).not.toBeNull();
    const footer = container.querySelector(".sidebar-settings-footer") as HTMLElement | null;
    expect(footer).not.toBeNull();
    const scroll = container.querySelector(".sidebar-nav-scroll") as HTMLElement;
    // The sub-menu renders inside the scroll container; the footer
    // does not — so an expanded sub-menu scrolls within its own
    // container and can never extend behind the footer.
    expect(scroll.contains(submenu)).toBe(true);
    expect(scroll.contains(footer)).toBe(false);
    // DOM order: the sub-menu precedes the footer …
    expect(submenu!.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // … and the footer is the aside's last child.
    expect(container.querySelector("aside")!.lastElementChild).toBe(footer);
  });

  it("collapsed nav shows the gear only", async () => {
    await renderNavBar({ collapsed: true, onOpenSettings: vi.fn() });
    const settingsBtn = container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement;
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn.textContent).not.toContain("Settings");
    expect(settingsBtn.querySelector("svg")).not.toBeNull();
  });

  it("expanded nav shows gear + label", async () => {
    await renderNavBar({ collapsed: false, onOpenSettings: vi.fn() });
    const settingsBtn = container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement;
    expect(settingsBtn).not.toBeNull();
    expect(settingsBtn.textContent).toContain("Settings");
  });

  it("clicking the footer trigger calls onOpenSettings, not onSelectTab", async () => {
    const onOpenSettings = vi.fn();
    const onSelectTab = vi.fn();
    await renderNavBar({ onOpenSettings, onSelectTab });
    const settingsBtn = container.querySelector(
      'button[aria-label="Settings"]',
    ) as HTMLButtonElement;
    await act(async () => {
      settingsBtn.click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onSelectTab).not.toHaveBeenCalled();
  });

  it("no footer renders without an onOpenSettings handler", async () => {
    await renderNavBar({});
    expect(container.querySelector(".sidebar-settings-footer")).toBeNull();
    expect(container.querySelector('button[aria-label="Settings"]')).toBeNull();
  });
});

describe("Assets Hub registry + binding sub-menus (#6147 S2; #4681)", () => {
  it("configures Assets Hub with forex, futures, commodities, bonds, registry, binding", () => {
    const assetsSubItems = SUB_MENU_CONFIGS["assets-hub"];
    expect(assetsSubItems).toBeDefined();
    expect(assetsSubItems.map((s) => s.id)).toEqual([
      "forex",
      "futures",
      "commodities",
      "bonds",
      "registry",
      "binding",
    ]);
  });

  it("on ?tab=assets-hub&view=registry, Assets Hub is active and the Registry sub-item is active", async () => {
    window.history.pushState(null, "", "/?tab=assets-hub&view=registry");
    await renderNavBar({ activeTab: "assets-hub" });
    const registryBtn = Array.from(container.querySelectorAll(".sidebar-submenu-item")).find((b) =>
      b.textContent?.includes("Registry"),
    );
    expect(registryBtn).toBeDefined();
    expect(registryBtn!.classList.contains("active")).toBe(true);
    const bindingBtn = Array.from(container.querySelectorAll(".sidebar-submenu-item")).find((b) =>
      b.textContent?.includes("Binding"),
    );
    expect(bindingBtn).toBeDefined();
    expect(bindingBtn!.classList.contains("active")).toBe(false);
  });

  it("on ?tab=assets-hub&view=binding, the Binding sub-item is active", async () => {
    window.history.pushState(null, "", "/?tab=assets-hub&view=binding");
    await renderNavBar({ activeTab: "assets-hub" });
    const bindingBtn = Array.from(container.querySelectorAll(".sidebar-submenu-item")).find((b) =>
      b.textContent?.includes("Binding"),
    );
    expect(bindingBtn).toBeDefined();
    expect(bindingBtn!.classList.contains("active")).toBe(true);
    const registryBtn = Array.from(container.querySelectorAll(".sidebar-submenu-item")).find((b) =>
      b.textContent?.includes("Registry"),
    );
    expect(registryBtn).toBeDefined();
    expect(registryBtn!.classList.contains("active")).toBe(false);
  });

  it("on bare ?tab=assets-hub, the Forex sub-item is active by default", async () => {
    window.history.pushState(null, "", "/?tab=assets-hub");
    await renderNavBar({ activeTab: "assets-hub" });
    const forexBtn = Array.from(container.querySelectorAll(".sidebar-submenu-item")).find((b) =>
      b.textContent?.includes("Forex"),
    );
    expect(forexBtn).toBeDefined();
    expect(forexBtn!.classList.contains("active")).toBe(true);
  });
});
