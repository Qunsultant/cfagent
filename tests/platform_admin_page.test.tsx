/** @vitest-environment jsdom */
/**
 * Platform Admin Page test suite (tabbed dedicated admin page).
 *
 * Verifies:
 *  - Platform Admin renders as a dedicated full page inside PageShell;
 *  - renders a tab list with all eight administration surfaces;
 *  - tab switching activates corresponding panel (ads, background-tasks,
 *    scheduled-goals, provenance, api-keys, data-providers, iaaa-admin, admin-access);
 *  - respects initialSection prop and ?view= query parameter;
 *  - updates URL view param on tab selection;
 *  - Chat.tsx registers "platform-admin" in TAB_CONTENT.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/client/AsyncJobsPanel", () => ({
  AsyncJobsPanel: () => <div data-testid="async-jobs-panel">async jobs content</div>,
}));
vi.mock("../src/client/ScheduledGoalsPanel", () => ({
  ScheduledGoalsPanel: () => <div data-testid="scheduled-goals-panel">scheduled goals content</div>,
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

    // 2. Switch to Scheduled Goals
    const goalsTab = Array.from(tabs).find((t) => t.textContent?.includes("Scheduled Goals")) as HTMLElement;
    await act(async () => {
      goalsTab.click();
    });
    expect(container.querySelector('[data-testid="scheduled-goals-panel"]')).toBeTruthy();
    expect(onSelectSection).toHaveBeenCalledWith("scheduled-goals");

    // 3. Switch to Diagnostics & Provenance
    const provTab = Array.from(tabs).find((t) => t.textContent?.includes("Diagnostics & Provenance")) as HTMLElement;
    await act(async () => {
      provTab.click();
    });
    expect(container.textContent).toContain("Technical Diagnostics & Provenance");
    expect(container.textContent).toContain("did:agent:openaimp:trading");

    // 4. Switch to Data Providers
    const provsTab = Array.from(tabs).find((t) => t.textContent?.includes("Data Providers")) as HTMLElement;
    await act(async () => {
      provsTab.click();
    });
    expect(container.querySelector('[data-testid="data-providers-panel"]')).toBeTruthy();

    // 5. Switch to IAAA Admin
    const iaaaTab = Array.from(tabs).find((t) => t.textContent?.includes("IAAA Admin")) as HTMLElement;
    await act(async () => {
      iaaaTab.click();
    });
    expect(container.querySelector('[data-testid="iaaa-admin-panel"]')).toBeTruthy();

    // 6. Switch to Admin Access
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
