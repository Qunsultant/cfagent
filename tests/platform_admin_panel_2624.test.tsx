/** @vitest-environment jsdom */
/**
 * Issue #2624 — Platform Admin as a left-nav destination.
 *
 * Pins:
 *  - the menu is externalized config (the #2529 navConfig idiom): eight
 *    items, in the order they held in the settings dropdown;
 *  - the left nav carries a "Platform Admin" item with those eight
 *    sub-items (same shape as Screeners), and `platform-admin:<section>`
 *    ids resolve to a drawer section rather than a route;
 *  - the drawer renders only when open, names itself from the config, and
 *    switches section on menu selection;
 *  - the nav shell owns the drawer (so the item works on every page) and
 *    the settings dropdown keeps the signed-in user card.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The admin panels fetch on mount; the drawer is under test, not them.
vi.mock("../src/client/AsyncJobsPanel", () => ({
  AsyncJobsPanel: () => <div data-testid="async-jobs-panel">async jobs</div>,
}));
vi.mock("../src/client/ScheduledGoalsPanel", () => ({
  ScheduledGoalsPanel: () => <div data-testid="scheduled-goals-panel">goals</div>,
}));
vi.mock("../src/client/ApiKeysPanel", () => ({
  ApiKeysPanel: () => <div data-testid="api-keys-panel">keys</div>,
}));

import { PlatformAdminPanel } from "../src/client/PlatformAdminPanel";
import {
  DEFAULT_PLATFORM_ADMIN_CONFIG,
  platformAdminItems,
  platformAdminTitle,
  type PlatformAdminConfig,
} from "../src/client/platformAdminConfig";
import { DEFAULT_LEFT_NAV_CONFIG, platformAdminSectionFromNavId } from "../src/client/navConfig";

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

describe("platform admin config (#2624)", () => {
  it("lists the eight remaining items in dropdown order", () => {
    // Issue #4585 moved data-providers, data-lifecycle, downloads,
    // iaaa-admin, users, and admin-access into the DataHub and
    // SecurityHub hubs; Platform Admin keeps the other seven, and
    // #6151 S4 adds Nav & Menu Access last.
    const items = platformAdminItems();
    expect(items.map((item) => item.id)).toEqual([
      "ads",
      "provenance",
      "api-keys",
      "tenants",
      "channels",
      "accounts",
      "engine-tuning",
      "nav-config",
    ]);
    expect(items[0].label).toBe("Ads & Partner Banners");
    expect(items[items.length - 1].label).toBe("Nav & Menu Access");
  });

  it("takes the panel title from the config", () => {
    expect(platformAdminTitle()).toBe("Platform Admin");
    const custom: PlatformAdminConfig = {
      sections: [{ id: "x", title: "Operations Admin", items: DEFAULT_PLATFORM_ADMIN_CONFIG.sections[0].items }],
    };
    expect(platformAdminTitle(custom)).toBe("Operations Admin");
  });
  it("every platform admin item defines a distinct icon", () => {
    const items = platformAdminItems();
    for (const item of items) {
      expect(item.icon).toBeDefined();
    }
    const icons = items.map((i) => i.icon);
    // Issue #4585 moved Users (the duplicate Agents) to SecurityHub;
    // #6151 S4 adds Nav & Menu Access (Approvals) — all eight
    // remaining icons are distinct.
    expect(new Set(icons).size).toBe(8);
  });
});

describe("platform admin in the left navigation (#2624)", () => {
  const adminSection = DEFAULT_LEFT_NAV_CONFIG.sections.find((section) => section.id === "section-platform");

  it("is a left-nav item with its own eight-item sub-menu", () => {
    expect(adminSection).toBeTruthy();
    expect(adminSection!.title).toBe("PLATFORM");
    const item = adminSection!.items.find((i) => i.id === "platform-admin")!;
    expect(item).toBeTruthy();
    expect(item.id).toBe("platform-admin");
    expect(item.label).toBe("Platform Admin");
    expect(item.subItems).toHaveLength(8);
    expect(item.subItems![0].id).toBe("platform-admin:ads");
    expect(item.subItems![4].id).toBe("platform-admin:channels");
    expect(item.subItems![5].id).toBe("platform-admin:accounts");
    expect(item.subItems![6].id).toBe("platform-admin:engine-tuning");
    expect(item.subItems![7].id).toBe("platform-admin:nav-config");
  });

  it("maps sub-item ids to drawer sections, and nothing else", () => {
    expect(platformAdminSectionFromNavId("platform-admin")).toBe("ads");
    expect(platformAdminSectionFromNavId("platform-admin:api-keys")).toBe("api-keys");
    expect(platformAdminSectionFromNavId("platform-admin:channels")).toBe("channels");
    expect(platformAdminSectionFromNavId("platform-admin:iaaa-admin")).toBe("iaaa-admin");
    expect(platformAdminSectionFromNavId("platform-admin:users")).toBe("users");
    expect(platformAdminSectionFromNavId("options")).toBeUndefined();
    expect(platformAdminSectionFromNavId("screeners")).toBeUndefined();
  });
});

describe("platform admin panel (#2624)", () => {
  // Tail slice 1 (issue #5016): the drawer is the ui Drawer primitive now,
  // which portals to document.body, and the menu is a Tabs strip — so
  // these tests query the document (the #1880 portaled-dialog lesson),
  // not the render container, and read tabs instead of menu items.
  it("renders nothing while closed", async () => {
    await render(panel({ open: false }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders a named drawer with every menu item", async () => {
    await render(panel());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(document.querySelector(".ui-drawer-title")?.textContent).toBe("Platform Admin");
    expect(dialog!.getAttribute("aria-labelledby")).toBe(document.querySelector(".ui-drawer-title")?.id);

    const menuItems = document.querySelectorAll('[role="tab"]');
    expect(menuItems).toHaveLength(8);
    expect(menuItems[0].textContent).toContain("Ads & Partner Banners");
    expect(menuItems[4].textContent).toContain("Channels");
    expect(menuItems[5].textContent).toContain("Accounts");
    expect(menuItems[7].textContent).toContain("Nav & Menu Access");
    expect(menuItems[6].textContent).toContain("Engine Tuning");
  });

  it("opens at the section the nav asked for", async () => {
    await render(panel({ initialSection: "api-keys" }));
    expect(document.querySelector('[data-testid="api-keys-panel"]')).toBeTruthy();
  });

  it("switches section on menu selection", async () => {
    await render(panel());
    expect(document.body.textContent).toContain("Workspace Banners");

    const apiKeys = Array.from(document.querySelectorAll('[role="tab"]')).find((item) =>
      item.textContent?.includes("API Keys"),
    ) as HTMLElement;
    await act(async () => {
      apiKeys.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="api-keys-panel"]')).toBeTruthy();
  });

  it("honours a custom config's title and item order", async () => {
    const custom: PlatformAdminConfig = {
      sections: [
        {
          id: "custom",
          title: "Operations Admin",
          items: [
            { id: "api-keys", label: "Keys", description: "first" },
            { id: "iaaa-admin", label: "IAAA", description: "second" },
          ],
        },
      ],
    };
    await render(panel({ config: custom }));
    expect(document.querySelector(".ui-drawer-title")?.textContent).toBe("Operations Admin");
    const labels = Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.textContent);
    expect(labels).toEqual(["Keys", "IAAA"]);
    expect(document.querySelector('[data-testid="api-keys-panel"]')).toBeTruthy();
  });

  it("closes on Escape and on the backdrop, never on a click inside", async () => {
    const onClose = vi.fn();
    await render(panel({ onClose }));

    const inside = document.querySelector(".ui-drawer-body") as HTMLElement;
    await act(async () => {
      inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    // The Drawer closes on a backdrop *click* (target === currentTarget),
    // not a mousedown like the old hand-rolled shell.
    const backdrop = document.querySelector(".ui-drawer-backdrop") as HTMLElement;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("nav shell owns the drawer; settings keeps the user card (#2624)", () => {
  const nav = readFileSync(join(process.cwd(), "src", "client", "components", "NavigationMenu.tsx"), "utf8");
  const settings = readFileSync(join(process.cwd(), "src", "client", "BrokerDynamicMenu.tsx"), "utf8");

  it("mounts the panel in the navigation shell and routes nav ids to it", () => {
    expect(nav).toContain("<PlatformAdminPanel");
    // Issue #2776: admin ids route through the deep-link catalog, not a
    // direct platformAdminSectionFromNavId call in NavigationMenu.
    expect(nav).toContain("navigateToDeepLink(deepLinkForNavNode(null, id))");
    expect(nav).toContain("onSelectTab={handleSelectNavId}");
  });

  it("leaves no admin button or drawer in the settings dropdown", () => {
    expect(settings).not.toContain("PlatformAdminPanel");
    expect(settings).not.toContain("Open Platform Admin");
    expect(settings).not.toContain("settings-iaaa-admin-section");
    expect(settings).not.toContain("settings-api-keys-section");
  });

  it("keeps the signed-in user card in the dropdown", () => {
    expect(settings).toContain("settings-user-card");
    expect(settings).toContain("settings-user-name");
    expect(settings).toContain("settings-user-login");
    expect(settings).toContain("Logged in via");
  });

  it("shows the signed-in user at the top of the dropdown, above broker selection (#3362)", () => {
    // Each marker occurs exactly once in BrokerDynamicMenu.tsx, in JSX —
    // so source order is the panel's section order.
    const userAt = settings.indexOf("settings-user-card");
    const brokerAt = settings.indexOf("broker-select-section");
    expect(userAt).toBeGreaterThan(-1);
    expect(brokerAt).toBeGreaterThan(-1);
    expect(userAt).toBeLessThan(brokerAt);
  });
});
