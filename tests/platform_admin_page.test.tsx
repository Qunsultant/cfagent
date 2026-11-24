/** @vitest-environment jsdom */
/**
 * Platform Admin Page test suite (tabbed dedicated admin page).
 *
 * Verifies:
 *  - Platform Admin renders as a dedicated full page inside PageShell;
 *  - renders a tab list with all ten administration surfaces;
 *  - tab switching activates corresponding panel (ads,
 *    provenance, api-keys, data-providers, iaaa-admin, users, admin-access);
 *  - respects initialSection prop and ?view= query parameter;
 *  - updates URL view param on tab selection;
 *  - Chat.tsx registers "platform-admin" in TAB_CONTENT.
 *
 * Issue #3121 S2: the scheduled-goals and jobs sections folded into
 * the schedules home (`?tab=schedules&view=goals` / `view=runs`) — they
 * are gone from this page's tab list (13 tabs), and their old
 * addresses redirect to the home. Issue #4561: the background-tasks
 * section moved to the home too (`?tab=schedules&view=background-tasks`)
 * and the goals/runs links left the platform-admin sub-menu — 15 tabs
 * remain, and no platform-admin entry points at the home anymore.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/client/ApiKeysPanel", () => ({
  ApiKeysPanel: () => <div data-testid="api-keys-panel">api keys content</div>,
}));
vi.mock("../src/client/DataProvidersPanel", () => ({
  DataProvidersPanel: () => <div data-testid="data-providers-panel">data providers content</div>,
}));
vi.mock("../src/client/IaaaAdminPanel", () => ({
  IaaaAdminPanel: () => <div data-testid="iaaa-admin-panel">iaaa admin content</div>,
}));
vi.mock("../src/client/FreeRunAllowanceSection", () => ({
  FreeRunAllowanceSection: () => <div data-testid="free-runs-panel">free runs content</div>,
}));
vi.mock("../src/client/ProductsSection", () => ({
  ProductsSection: () => <div data-testid="products-panel">products content</div>,
}));

import { PlatformAdminPage, PLATFORM_ADMIN_TABS } from "../src/client/PlatformAdminPage";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.history.pushState(null, "", "/?tab=platform-admin");
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

describe("PlatformAdminPage component", () => {
  it("renders within PageShell with correct title and tablist", async () => {
    await render(
      <PlatformAdminPage
        user={{ login: "operator", name: "Operator One", providerName: "GitHub" }}
      />
    );

    const title = container.querySelector(".ui-page-shell-title");
    expect(title?.textContent).toBe("Platform Admin");

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();

    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(8);
    expect(PLATFORM_ADMIN_TABS).toHaveLength(8);

    // Initial default tab is ads
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].textContent).toContain("Ads & Banners");
    expect(container.textContent).toContain("Workspace Banners");
  });

  it("renders specific section when initialSection is passed", async () => {
    await render(
      <PlatformAdminPage
        initialSection="api-keys"
        user={{ login: "operator" }}
      />
    );

    const tabs = container.querySelectorAll('[role="tab"]');
    const apiKeysTab = Array.from(tabs).find((t) => t.textContent?.includes("API Keys"));
    expect(apiKeysTab?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="api-keys-panel"]')).toBeTruthy();
  });

  it("retires the free-runs and products sections to the product hub (#4575)", async () => {
    // Both ids left the PlatformAdminSectionId union when the hub became the
    // one home, so an old ?tab=platform-admin&view=free-runs address resolves
    // to the default section here — legacyProductRedirect sends the live
    // address to the hub before this page mounts.
    await render(
      <PlatformAdminPage initialSection="free-runs" user={{ login: "operator" }} />
    );

    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent ?? "").join(" ")).not.toContain("Free Runs");
    expect(tabs.map((t) => t.textContent ?? "").join(" ")).not.toContain("Products");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="free-runs-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="products-panel"]')).toBeNull();
  });

  it("switches tabs and displays the matching panel on click", async () => {
    const onSelectSection = vi.fn();
    await render(
      <PlatformAdminPage
        user={{ login: "operator" }}
        onSelectSection={onSelectSection}
      />
    );

    const tabs = container.querySelectorAll('[role="tab"]');

    // 1. Switch to Diagnostics & Provenance
    const provTab = Array.from(tabs).find((t) => t.textContent?.includes("Diagnostics & Provenance")) as HTMLElement;
    await act(async () => {
      provTab.click();
    });
    expect(container.textContent).toContain("Technical Diagnostics & Provenance");
    expect(container.textContent).toContain("did:agent:openaimp:trading");

    // 2. Switch to API Keys (#4585: Data Providers moved to the DataHub
    // home, so this step now exercises a remaining tab).
    const keysTab = Array.from(tabs).find((t) => t.textContent === "API Keys") as HTMLElement;
    await act(async () => {
      keysTab.click();
    });
    expect(container.querySelector('[data-testid="api-keys-panel"]')).toBeTruthy();

    // 3. Switch to Tenants (#4585: IAAA Admin moved to the SecurityHub home).
    const tenantsTab = Array.from(tabs).find((t) => t.textContent === "Tenants") as HTMLElement;
    await act(async () => {
      tenantsTab.click();
    });
    expect(onSelectSection).toHaveBeenCalledWith("tenants");
    expect(window.location.search).toContain("view=tenants");

    // 4. Switch to Accounts (#4585: Users moved to the SecurityHub home).
    const accountsTab = Array.from(tabs).find((t) => t.textContent === "Accounts") as HTMLElement;
    await act(async () => {
      accountsTab.click();
    });
    expect(onSelectSection).toHaveBeenCalledWith("accounts");
    expect(window.location.search).toContain("view=accounts");

    // 5. Switch to Channels (#3169: same shell assertion as Users
    // — the panel's tenant fetch resolves asynchronously).
    const channelsTab = Array.from(tabs).find((t) => t.textContent === "Channels") as HTMLElement;
    await act(async () => {
      channelsTab.click();
    });
    expect(container.textContent).toContain("Delivery-channel enablement per tenant");
    expect(onSelectSection).toHaveBeenCalledWith("channels");
    expect(window.location.search).toContain("view=channels");

    // 6. Switch to Engine Tuning (#4585: Admin Access moved to the
    // SecurityHub home, so this step now exercises a remaining tab).
    const tuningTab = Array.from(tabs).find((t) => t.textContent === "Engine Tuning") as HTMLElement;
    await act(async () => {
      tuningTab.click();
    });
    expect(onSelectSection).toHaveBeenCalledWith("engine-tuning");
    expect(window.location.search).toContain("view=engine-tuning");
  });

  it("Chat.tsx wires PlatformAdminPage into TAB_CONTENT", () => {
    const chatSrc = readFileSync(join(process.cwd(), "src", "client", "Chat.tsx"), "utf8");
    expect(chatSrc).toContain("import { PlatformAdminPage } from");
    expect(chatSrc).toContain('"platform-admin": (');
    expect(chatSrc).toContain("<PlatformAdminPage");
  });
});
