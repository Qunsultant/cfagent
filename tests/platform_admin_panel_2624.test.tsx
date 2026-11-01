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
vi.mock("../src/client/DataProvidersPanel", () => ({
  DataProvidersPanel: () => <div data-testid="data-providers-panel">providers</div>,
}));
vi.mock("../src/client/IaaaAdminPanel", () => ({
  IaaaAdminPanel: () => <div data-testid="iaaa-admin-panel">iaaa</div>,
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
  it("lists the eight extracted items in dropdown order", () => {
    const items = platformAdminItems();
    expect(items.map((item) => item.id)).toEqual([
      "ads",
      "background-tasks",
      "scheduled-goals",
      "provenance",
      "api-keys",
      "data-providers",
      "iaaa-admin",
      "admin-access",
    ]);
    expect(items[0].label).toBe("Ads & Partner Banners");
    expect(items[items.length - 1].label).toBe("Request admin access");
  });

  it("takes the panel title from the config", () => {
    expect(platformAdminTitle()).toBe("Platform Admin");
    const custom: PlatformAdminConfig = {
      sections: [{ id: "x", title: "Operations Admin", items: DEFAULT_PLATFORM_ADMIN_CONFIG.sections[0].items }],
    };
    expect(platformAdminTitle(custom)).toBe("Operations Admin");
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
    expect(item.subItems![7].id).toBe("platform-admin:admin-access");
  });

  it("maps sub-item ids to drawer sections, and nothing else", () => {
    expect(platformAdminSectionFromNavId("platform-admin")).toBe("ads");
    expect(platformAdminSectionFromNavId("platform-admin:api-keys")).toBe("api-keys");
    expect(platformAdminSectionFromNavId("platform-admin:iaaa-admin")).toBe("iaaa-admin");
    expect(platformAdminSectionFromNavId("options")).toBeUndefined();
    expect(platformAdminSectionFromNavId("screeners")).toBeUndefined();
  });
});

describe("platform admin panel (#2624)", () => {
  it("renders nothing while closed", async () => {
    await render(panel({ open: false }));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders a named drawer with every menu item", async () => {
    await render(panel());
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute("aria-label")).toBe("Platform Admin");
    expect(container.querySelector(".platform-admin-title")?.textContent).toBe("Platform Admin");

    const menuItems = container.querySelectorAll(".platform-admin-menu-item");
    expect(menuItems).toHaveLength(8);
    expect(menuItems[0].textContent).toContain("Ads & Partner Banners");
    expect(menuItems[7].textContent).toContain("Request admin access");
  });

  it("opens at the section the nav asked for", async () => {
    await render(panel({ initialSection: "api-keys" }));
    expect(container.querySelector('[data-testid="api-keys-panel"]')).toBeTruthy();
  });

  it("switches section on menu selection", async () => {
    await render(panel());
    expect(container.textContent).toContain("Workspace Banners");

    const dataProviders = Array.from(container.querySelectorAll(".platform-admin-menu-item")).find((item) =>
      item.textContent?.includes("Data Providers"),
    ) as HTMLElement;
    await act(async () => {
      dataProviders.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="data-providers-panel"]')).toBeTruthy();
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
    expect(container.querySelector(".platform-admin-title")?.textContent).toBe("Operations Admin");
    const labels = Array.from(container.querySelectorAll(".platform-admin-menu-label")).map((el) => el.textContent);
    expect(labels).toEqual(["Keys", "IAAA"]);
    expect(container.querySelector('[data-testid="api-keys-panel"]')).toBeTruthy();
  });

  it("closes on Escape and on the backdrop, never on a click inside", async () => {
    const onClose = vi.fn();
    await render(panel({ onClose }));

    const inside = container.querySelector(".platform-admin-content") as HTMLElement;
    await act(async () => {
      inside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = container.querySelector(".platform-admin-backdrop") as HTMLElement;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
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
  const settings = readFileSync(join(process.cwd(), "src", "client", "ETradeDynamicMenu.tsx"), "utf8");

  it("mounts the panel in the navigation shell and routes nav ids to it", () => {
    expect(nav).toContain("<PlatformAdminPanel");
    expect(nav).toContain("platformAdminSectionFromNavId");
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
});
