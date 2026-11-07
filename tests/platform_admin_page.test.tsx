/** @vitest-environment jsdom */
/**
 * Platform Admin Page test suite (tabbed dedicated admin page).
 *
 * Verifies:
 *  - Platform Admin renders as a dedicated full page inside PageShell;
 *  - renders a tab list with all ten administration surfaces;
 *  - tab switching activates corresponding panel (ads, background-tasks,
 *    provenance, api-keys, data-providers, iaaa-admin, users, admin-access);
 *  - respects initialSection prop and ?view= query parameter;
 *  - updates URL view param on tab selection;
 *  - Chat.tsx registers "platform-admin" in TAB_CONTENT.
 *
 * Issue #3121 S2: the scheduled-goals and jobs sections folded into
 * the schedules home (`?tab=schedules&view=goals` / `view=runs`) — they
 * are gone from this page's tab list (13 tabs), and their old
 * addresses redirect to the home. The left-nav entries still exist
 * and link straight to the home.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/client/AsyncJobsPanel", () => ({
  AsyncJobsPanel: () => <div data-testid="async-jobs-panel">async jobs content</div>,
}));
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
    expect(tabs).toHaveLength(15);
    expect(PLATFORM_ADMIN_TABS).toHaveLength(15);

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

  it("renders the free-runs section when initialSection is passed (#3315)", async () => {
    await render(
      <PlatformAdminPage
        initialSection="free-runs"
        user={{ login: "operator" }}
      />
    );

    const tabs = container.querySelectorAll('[role="tab"]');
    const freeRunsTab = Array.from(tabs).find((t) => t.textContent?.includes("Free Runs"));
    expect(freeRunsTab?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="free-runs-panel"]')).toBeTruthy();
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

    // 1. Switch to Background Tasks
    const bgTab = Array.from(tabs).find((t) => t.textContent?.includes("Background Tasks")) as HTMLElement;
    await act(async () => {
      bgTab.click();
    });
    expect(container.querySelector('[data-testid="async-jobs-panel"]')).toBeTruthy();
    expect(onSelectSection).toHaveBeenCalledWith("background-tasks");
    expect(window.location.search).toContain("view=background-tasks");

    // 2. Switch to Diagnostics & Provenance
    const provTab = Array.from(tabs).find((t) => t.textContent?.includes("Diagnostics & Provenance")) as HTMLElement;
    await act(async () => {
      provTab.click();
    });
    expect(container.textContent).toContain("Technical Diagnostics & Provenance");
    expect(container.textContent).toContain("did:agent:openaimp:trading");

    // 3. Switch to Data Providers
    const provsTab = Array.from(tabs).find((t) => t.textContent?.includes("Data Providers")) as HTMLElement;
    await act(async () => {
      provsTab.click();
    });
    expect(container.querySelector('[data-testid="data-providers-panel"]')).toBeTruthy();

    // 4. Switch to IAAA Admin
    const iaaaTab = Array.from(tabs).find((t) => t.textContent?.includes("IAAA Admin")) as HTMLElement;
    await act(async () => {
      iaaaTab.click();
    });
    expect(container.querySelector('[data-testid="iaaa-admin-panel"]')).toBeTruthy();

    // 5. Switch to Users (#2220: the tab renders its panel shell;
    // the panel's own fetch resolves asynchronously, so assert the
    // page-level section copy, not the fetched profile).
    const usersTab = Array.from(tabs).find((t) => t.textContent === "Users") as HTMLElement;
    await act(async () => {
      usersTab.click();
    });
    expect(container.textContent).toContain("User profiles, tenant memberships");

    // 6. Switch to Channels (#3169: same shell assertion as Users
    // — the panel's tenant fetch resolves asynchronously).
    const channelsTab = Array.from(tabs).find((t) => t.textContent === "Channels") as HTMLElement;
    await act(async () => {
      channelsTab.click();
    });
    expect(container.textContent).toContain("Delivery-channel enablement per tenant");
    expect(onSelectSection).toHaveBeenCalledWith("channels");
    expect(window.location.search).toContain("view=channels");

    // 7. Switch to Admin Access
    const accessTab = Array.from(tabs).find((t) => t.textContent?.includes("Admin Access")) as HTMLElement;
    await act(async () => {
      accessTab.click();
    });
    expect(container.textContent).toContain("Signed in as operator");
    const reqBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Request admin access")
    );
    expect(reqBtn).toBeTruthy();
  });

  it("Chat.tsx wires PlatformAdminPage into TAB_CONTENT", () => {
    const chatSrc = readFileSync(join(process.cwd(), "src", "client", "Chat.tsx"), "utf8");
    expect(chatSrc).toContain("import { PlatformAdminPage } from");
    expect(chatSrc).toContain('"platform-admin": (');
    expect(chatSrc).toContain("<PlatformAdminPage");
  });
});
