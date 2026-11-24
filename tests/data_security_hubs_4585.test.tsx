/** @vitest-environment jsdom */
/**
 * Issue #4585 — Platform Admin split: DataHub + SecurityHub hubs.
 *
 * Six sections move out of Platform Admin into two new hubs, navigation-only
 * (#4561/#4574 pattern): DataHub (`?tab=data-hub`: data-providers,
 * data-lifecycle, downloads) and SecurityHub (`?tab=security-hub`:
 * iaaa-admin, users, admin-access, profile, pdp — the pdp view added
 * by #4651 — pep, added by #4653 — pip, added by #4655 — and pap,
 * added by #4658). Platform
 * Admin keeps the remaining eight sections (#6151 S4 adds nav-config). Old
 * addresses redirect; nothing is deleted
 * (Policy Gate (i)); the panels keep their single live mount, now in the
 * hub. BYOK cards ride with data-providers; ProfileSection (mounted only
 * in onboarding today) is surfaced as the SecurityHub profile view.
 *
 * Pins:
 * - 4585-P01 the hubs resolve exactly their views, in order, with labels.
 * - 4585-P02 each hub's left-nav item carries one sub-menu entry per view,
 *   each with a label, description, and a resolvable icon.
 * - 4585-P03 each view resolves through the deep-link catalog to its hub
 *   address, the surface lists the values, and the home mounts a TabPanel
 *   for it carrying the panel.
 * - 4585-P04 `?tab=platform-admin&view=<moved>` redirects to the new hub;
 *   Platform Admin renders only the eight remaining sections.
 * - 4585-P05 each moved panel has one LIVE mount — the hub is the one home
 *   (PlatformAdminPage no longer mounts any of the six).
 * - 4585-P06 the homes render their tabs and mount the panels (DataHub:
 *   DataProvidersPanel + BYOK cards; SecurityHub: ProfileSection).
 * - 4585-P07 nav counts move: routes 44, navOrders 0..30, sub-menu groups
 *   17, surfaces 23.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The panels fetch on mount; the navigation is under test, not them.
vi.mock("../src/client/DataProvidersPanel", () => ({
  DataProvidersPanel: () => <div data-testid="data-providers-panel">data providers</div>,
}));
vi.mock("../src/client/AlpacaSignInCard", () => ({
  AlpacaSignInCard: () => <div data-testid="alpaca-signin-card">alpaca sign-in</div>,
}));
vi.mock("../src/client/DataLifecyclePanel", () => ({
  DataLifecyclePanel: () => <div data-testid="data-lifecycle-panel">data lifecycle</div>,
}));
vi.mock("../src/client/DownloadsPanel", () => ({
  DownloadsPanel: () => <div data-testid="downloads-panel">downloads</div>,
}));
vi.mock("../src/client/IaaaAdminPanel", () => ({
  IaaaAdminPanel: () => <div data-testid="iaaa-admin-panel">iaaa admin</div>,
}));
vi.mock("../src/client/UserAdminPanel", () => ({
  UserAdminPanel: () => <div data-testid="users-panel">users</div>,
}));
vi.mock("../src/client/PlatformAdminPanel", () => ({
  AdminAccessSection: () => <div data-testid="admin-access-section">admin access</div>,
}));
vi.mock("../src/client/ProfileSection", () => ({
  ProfileSection: () => <div data-testid="profile-section">profile</div>,
}));
vi.mock("../src/client/PdpPanel", () => ({
  PdpPanel: () => <div data-testid="pdp-panel">pdp</div>,
}));
vi.mock("../src/client/PepPanel", () => ({
  PepPanel: () => <div data-testid="pep-panel">pep</div>,
}));

import { DataHubHome } from "../src/client/DataHubHome";
import { SecurityHubHome } from "../src/client/SecurityHubHome";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  DATA_HUB_VIEWS,
  DATA_HUB_VIEW_LABELS,
} from "../src/client/dataHubView";
import {
  SECURITY_HUB_VIEWS,
  SECURITY_HUB_VIEW_LABELS,
} from "../src/client/securityHubView";
import { legacyPlatformAdminHubRedirect } from "../src/client/router";
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
import { PLATFORM_ADMIN_TABS } from "../src/client/PlatformAdminPage";
import navConfigData from "../src/client/nav-config.json";

const here = join(process.cwd());
function read(rel: string): string {
  return readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
}

const DATA_HUB_VIEWS_EXPECTED = ["data-providers", "feeds", "data-lifecycle", "downloads", "pipeline-policy"] as const;
const DATA_HUB_LABELS = ["Data Providers", "Feeds", "Data Lifecycle", "Parameters & Export", "Pipeline Policy"];
const SECURITY_HUB_VIEWS_EXPECTED = ["iaaa-admin", "users", "admin-access", "profile", "pdp", "pep", "pip", "pap"] as const;
const SECURITY_HUB_LABELS = ["IAAA Admin", "Users", "Admin Access", "Profile", "PDP", "PEP", "PIP", "PAP"];
const REMAINING_PLATFORM_ADMIN = [
  "ads",
  "provenance",
  "api-keys",
  "tenants",
  "channels",
  "accounts",
  "engine-tuning",
  // #6151 S4 adds Nav & Menu Access last.
  "nav-config",
] as const;

describe("4585-P01 the hubs resolve exactly their views (#4585)", () => {
  it("DATA_HUB_VIEWS lists the five data views, in order (#6147 S3 adds pipeline-policy)", () => {
    expect([...DATA_HUB_VIEWS]).toEqual([...DATA_HUB_VIEWS_EXPECTED]);
    expect(DATA_HUB_VIEWS_EXPECTED.map((v) => DATA_HUB_VIEW_LABELS[v])).toEqual(DATA_HUB_LABELS);
  });

  it("SECURITY_HUB_VIEWS lists the eight security views, in order (#4658 adds pap after pip)", () => {
    expect([...SECURITY_HUB_VIEWS]).toEqual([...SECURITY_HUB_VIEWS_EXPECTED]);
    expect(SECURITY_HUB_VIEWS_EXPECTED.map((v) => SECURITY_HUB_VIEW_LABELS[v])).toEqual(
      SECURITY_HUB_LABELS,
    );
  });
});

describe("4585-P02 each hub carries one sub-menu entry per view (#4585)", () => {
  it("the DataHub item has five sub-items with labels, descriptions, and icons (#6147 S3 adds pipeline-policy)", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "data-hub");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(5);
    for (const [index, view] of DATA_HUB_VIEWS_EXPECTED.entries()) {
      const sub = item!.subItems![index];
      expect(sub.id).toBe(view);
      expect(sub.label).toBe(DATA_HUB_LABELS[index]);
      expect(sub.description).toBeTruthy();
      expect(sub.description!.length).toBeGreaterThan(0);
      expect(sub.icon).toBeTruthy();
      expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
    }
    expect(findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "data-hub")).toBeDefined();
  });

  it("the SecurityHub item has eight sub-items with labels, descriptions, and icons", () => {
    const platform = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platform).toBeDefined();
    const item = platform!.items.find((i) => i.id === "security-hub");
    expect(item).toBeDefined();
    expect(item!.subItems).toHaveLength(8);
    for (const [index, view] of SECURITY_HUB_VIEWS_EXPECTED.entries()) {
      const sub = item!.subItems![index];
      expect(sub.id).toBe(view);
      expect(sub.label).toBe(SECURITY_HUB_LABELS[index]);
      expect(sub.description).toBeTruthy();
      expect(sub.description!.length).toBeGreaterThan(0);
      expect(sub.icon).toBeTruthy();
      expect(NAV_ICON_MAP[sub.icon!]).toBeDefined();
    }
    expect(findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "security-hub")).toBeDefined();
  });
});

describe("4585-P03 each view resolves through the catalog (#4585)", () => {
  it("DataHub views deep-link to ?tab=data-hub&view=<view>", () => {
    for (const view of DATA_HUB_VIEWS_EXPECTED) {
      expect(deepLinkForNavNode("data-hub", view)).toEqual({ tab: "data-hub", view });
      expect(deepLinkHrefForNavNode("data-hub", view)).toBe(`?tab=data-hub&view=${view}`);
      expect(DEEP_LINK_OVERRIDES[`data-hub:${view}`]).toEqual({ tab: "data-hub", view });
    }
    const surface = SURFACE_TAB_DEFS.find((d) => d.surface === "data-hub");
    expect(surface).toBeDefined();
    expect(surface!.page).toBe("data-hub");
    expect(surface!.param).toBe("view");
    expect([...surface!.values]).toEqual([...DATA_HUB_VIEWS_EXPECTED]);
    const home = read("src/client/DataHubHome.tsx");
    for (const view of DATA_HUB_VIEWS_EXPECTED) {
      expect(home).toContain(`tabId="${view}"`);
    }
    expect(home).toContain("DataProvidersPanel");
    expect(home).toContain("AlpacaSignInCard");
    expect(home).toContain("DataLifecyclePanel");
    expect(home).toContain("DownloadsPanel");
    expect(home).toContain("PipelinePolicyPanel");
  });

  it("SecurityHub views deep-link to ?tab=security-hub&view=<view>", () => {
    for (const view of SECURITY_HUB_VIEWS_EXPECTED) {
      expect(deepLinkForNavNode("security-hub", view)).toEqual({ tab: "security-hub", view });
      expect(deepLinkHrefForNavNode("security-hub", view)).toBe(
        `?tab=security-hub&view=${view}`,
      );
      expect(DEEP_LINK_OVERRIDES[`security-hub:${view}`]).toEqual({
        tab: "security-hub",
        view,
      });
    }
    const surface = SURFACE_TAB_DEFS.find((d) => d.surface === "security-hub");
    expect(surface).toBeDefined();
    expect(surface!.page).toBe("security-hub");
    expect(surface!.param).toBe("view");
    expect([...surface!.values]).toEqual([...SECURITY_HUB_VIEWS_EXPECTED]);
    const home = read("src/client/SecurityHubHome.tsx");
    for (const view of SECURITY_HUB_VIEWS_EXPECTED) {
      expect(home).toContain(`tabId="${view}"`);
    }
    expect(home).toContain("IaaaAdminPanel");
    expect(home).toContain("UserAdminPanel");
    expect(home).toContain("AdminAccessSection");
    expect(home).toContain("ProfileSection");
    expect(home).toContain("PdpPanel");
    expect(home).toContain("PepPanel");
    expect(home).toContain("PipPanel");
    expect(home).toContain("PolicyProposalsPanel");
  });
});

describe("4585-P04 old Platform Admin addresses redirect (#4585)", () => {
  it("each moved view redirects to its new hub; other addresses are untouched", () => {
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin&view=data-providers")).toEqual({
      tab: "data-hub",
      view: "data-providers",
    });
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin&view=data-lifecycle")).toEqual({
      tab: "data-hub",
      view: "data-lifecycle",
    });
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin&view=downloads")).toEqual({
      tab: "data-hub",
      view: "downloads",
    });
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin&view=iaaa-admin")).toEqual({
      tab: "security-hub",
      view: "iaaa-admin",
    });
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin&view=users")).toEqual({
      tab: "security-hub",
      view: "users",
    });
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin&view=admin-access")).toEqual({
      tab: "security-hub",
      view: "admin-access",
    });
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin&view=ads")).toBeNull();
    expect(legacyPlatformAdminHubRedirect("?tab=platform-admin")).toBeNull();
    expect(legacyPlatformAdminHubRedirect("?tab=data-hub&view=data-providers")).toBeNull();
  });

  it("Platform Admin keeps exactly the eight remaining sections", () => {
    expect(PLATFORM_ADMIN_TABS.map((t) => t.id)).toEqual([...REMAINING_PLATFORM_ADMIN]);
    const sections = (
      navConfigData.platformAdminSections as {
        id: string;
        items: { id: string }[];
      }[]
    )[0].items.map((i) => i.id);
    expect(sections).toEqual([...REMAINING_PLATFORM_ADMIN]);
  });
});

describe("4585-P05 each moved panel has one live mount (#4585)", () => {
  it("PlatformAdminPage no longer mounts any of the six moved panels", () => {
    const page = read("src/client/PlatformAdminPage.tsx");
    for (const panel of [
      "DataProvidersPanel",
      "AlpacaSignInCard",
      "DataLifecyclePanel",
      "DownloadsPanel",
      "IaaaAdminPanel",
      "UserAdminPanel",
      "AdminAccessSection",
    ]) {
      expect(page).not.toContain(panel);
    }
    for (const view of [
      "data-providers",
      "data-lifecycle",
      "downloads",
      "iaaa-admin",
      "users",
      "admin-access",
    ]) {
      expect(page).not.toContain(`"${view}"`);
    }
  });

  it("the six panels mount live exactly once each, in their hub", () => {
    const files = readdirSync(join(here, "src/client")).filter((f) => f.endsWith(".tsx"));
    const mounters: Record<string, string[]> = {};
    for (const panel of [
      "DataProvidersPanel",
      "DataLifecyclePanel",
      "DownloadsPanel",
      "IaaaAdminPanel",
      "UserAdminPanel",
      "AdminAccessSection",
    ]) {
      mounters[panel] = [];
      for (const file of files) {
        const src = read(`src/client/${file}`);
        if (src.includes(`<${panel}`)) mounters[panel].push(file);
      }
    }
    expect(mounters["DataProvidersPanel"]).toEqual(["DataHubHome.tsx"]);
    expect(mounters["DataLifecyclePanel"]).toEqual(["DataHubHome.tsx"]);
    expect(mounters["DownloadsPanel"]).toEqual(["DataHubHome.tsx"]);
    expect(mounters["IaaaAdminPanel"]).toEqual(["SecurityHubHome.tsx"]);
    expect(mounters["UserAdminPanel"]).toEqual(["SecurityHubHome.tsx"]);
    expect(mounters["AdminAccessSection"]).toEqual(["SecurityHubHome.tsx"]);
    // BYOK cards ride with data-providers: DataHub mounts both cards
    // (TEST + PROD); the Platform Admin page and drawer mount none.
    const dataHub = read("src/client/DataHubHome.tsx");
    expect(dataHub.split("<AlpacaSignInCard").length - 1).toBe(2);
    expect(read("src/client/PlatformAdminPage.tsx")).not.toContain("<AlpacaSignInCard");
    expect(read("src/client/PlatformAdminPanel.tsx")).not.toContain("<AlpacaSignInCard");
    // ProfileSection gains its second mount: onboarding + SecurityHub.
    const profile: string[] = [];
    for (const file of files) {
      if (read(`src/client/${file}`).includes("<ProfileSection")) profile.push(file);
    }
    expect(profile.sort()).toEqual(["FirstRunScreen.tsx", "SecurityHubHome.tsx"]);
    // PdpPanel (#4651) has its one live mount: the SecurityHub PDP tab.
    const pdp: string[] = [];
    for (const file of files) {
      if (read(`src/client/${file}`).includes("<PdpPanel")) pdp.push(file);
    }
    expect(pdp).toEqual(["SecurityHubHome.tsx"]);
    // PepPanel (#4653) has its one live mount: the SecurityHub PEP tab.
    const pep: string[] = [];
    for (const file of files) {
      if (read(`src/client/${file}`).includes("<PepPanel")) pep.push(file);
    }
    expect(pep).toEqual(["SecurityHubHome.tsx"]);
    // PipPanel (#4655) has its one live mount: the SecurityHub PIP tab.
    const pip: string[] = [];
    for (const file of files) {
      if (read(`src/client/${file}`).includes("<PipPanel")) pip.push(file);
    }
    expect(pip).toEqual(["SecurityHubHome.tsx"]);
    // PolicyProposalsPanel (#4658) has its one live mount: the
    // SecurityHub PAP tab (moved off the IAAA Admin Overview).
    const pap: string[] = [];
    for (const file of files) {
      if (read(`src/client/${file}`).includes("<PolicyProposalsPanel")) pap.push(file);
    }
    expect(pap).toEqual(["SecurityHubHome.tsx"]);
    const overview = read("src/client/IaaaAdminPanel.tsx");
    expect(overview).not.toContain("<PolicyProposalsPanel");
  });
});

describe("4585-P06 the homes render their tabs and mount the panels (#4585)", () => {
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

  it("the DataHub data-providers tab mounts the providers panel and the BYOK cards", async () => {
    window.history.pushState(null, "", "/?tab=data-hub&view=data-providers");
    await render(
      <ToastProvider>
        <DataHubHome userLogin="tester" />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(DATA_HUB_LABELS);
    expect(container.querySelector('[data-testid="data-providers-panel"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="alpaca-signin-card"]')).toHaveLength(2);
  });

  it("the DataHub default view renders all three tabs", async () => {
    window.history.pushState(null, "", "/?tab=data-hub");
    await render(
      <ToastProvider>
        <DataHubHome userLogin="tester" />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(DATA_HUB_LABELS);
    expect(container.querySelector('[data-testid="data-providers-panel"]')).toBeTruthy();
  });

  it("the SecurityHub profile tab mounts the profile section", async () => {
    window.history.pushState(null, "", "/?tab=security-hub&view=profile");
    await render(
      <ToastProvider>
        <SecurityHubHome
          userLogin="tester"
          user={{ login: "tester", name: "Tester", avatar: "" }}
        />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(SECURITY_HUB_LABELS);
    expect(container.querySelector('[data-testid="profile-section"]')).toBeTruthy();
  });

  it("the SecurityHub default view renders all eight tabs", async () => {
    window.history.pushState(null, "", "/?tab=security-hub");
    await render(
      <ToastProvider>
        <SecurityHubHome
          userLogin="tester"
          user={{ login: "tester", name: "Tester", avatar: "" }}
        />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(SECURITY_HUB_LABELS);
    expect(container.querySelector('[data-testid="iaaa-admin-panel"]')).toBeTruthy();
  });
});

describe("4585-P07 nav counts move (#4585)", () => {
  it("routes 47, navOrders 0..27, sub-menu groups 21, surfaces 31", () => {
    const routes = navConfigData.routes as {
      id: string;
      navEntry?: { navOrder: number };
    }[];
    // Issue 4682: the Marketing Hub route joins the table; 44 → 45.
    // Issue #5169: the Observability route joins the table; 45 → 46.
    // PR #5256 (#3696): the nav-settings route joins the table; 46 → 47.
    expect(routes).toHaveLength(47);
    const orders = routes
      .filter((r) => r.navEntry)
      .map((r) => r.navEntry!.navOrder)
      .sort((a, b) => a - b);
    // S1 #4626 retires the Approvals + Options Flows nav entries: 31 -> 29.
    // Issue 4682 retires the referrals, ads, and social nav entries
    // into the one Marketing Hub route: 29 -> 27.
    // Issue #5169 adds the Observability nav entry: 27 -> 28.
    expect(orders).toEqual(Array.from({ length: 28 }, (_, i) => i));
    const dataHub = routes.find((r) => r.id === "data-hub");
    const securityHub = routes.find((r) => r.id === "security-hub");
    expect(dataHub?.navEntry?.navOrder).toBe(25);
    expect(securityHub?.navEntry?.navOrder).toBe(26);
    expect(Object.keys(navConfigData.subMenus as Record<string, unknown>)).toHaveLength(21);
    // Issue #6164: iaaa-admin-sections adds the 31st surface.
    expect(SURFACE_TAB_DEFS).toHaveLength(31);
    const platformAdmin = SURFACE_TAB_DEFS.find((d) => d.surface === "platform-admin");
    expect([...platformAdmin!.values]).toEqual([...REMAINING_PLATFORM_ADMIN]);
  });
});
