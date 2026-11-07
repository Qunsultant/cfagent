/**
 * @vitest-environment jsdom
 *
 * Issue #3719: Broker-neutral dynamic menu harmonization:
 *   1. Top-left user info (@user, login provider) and top-right broker info / connection.
 *   2. Deduplication of broker name and offline state in headers and badges.
 *   3. Single toggle button for Paper and Live environments (defaulting to Paper).
 *   4. Alpaca and E*TRADE diagnostics isolation with broker-specific presentation and actions.
 *   5. Removal of Account Details card and Tuning & Options Data from the dynamic menu.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerDynamicMenu, SettingsMenu } from "../src/client/BrokerDynamicMenu";
import { setTenantProvidersStateForTest, resetTenantProvidersStateForTest } from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MENU_SRC = readFileSync(join(__dirname, "../src/client/BrokerDynamicMenu.tsx"), "utf8");

describe("BrokerDynamicMenu harmonization and neutrality (#3719)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    if (container.parentElement) {
      container.parentElement.removeChild(container);
    }
    resetTenantProvidersStateForTest();
    vi.unstubAllGlobals();
  });

  async function renderMenu(props: Partial<React.ComponentProps<typeof BrokerDynamicMenu>> = {}) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <BrokerDynamicMenu
          initialOpen={true}
          userLogin="OpenAIMP"
          userName="OpenAIMP User"
          {...props}
        />
      );
    });
  }

  it("places user info in top-left and broker info / connection in top-right without duplications", async () => {
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
    await renderMenu();

    const header = container.querySelector(".unified-menu-header");
    expect(header).not.toBeNull();

    // Top-left user card
    const userCard = header?.querySelector(".settings-user-card");
    expect(userCard).not.toBeNull();
    expect(userCard?.textContent).toContain("OpenAIMP User");
    expect(userCard?.textContent).toContain("@OpenAIMP");

    // Top-right broker brand and badge
    const brokerRight = header?.querySelector(".broker-header-right");
    expect(brokerRight).not.toBeNull();
    expect(brokerRight?.textContent).toContain("Alpaca");

    // Env badge shows OFFLINE without repeating broker name
    const envBadge = brokerRight?.querySelector(".etrade-env-badge");
    expect(envBadge?.textContent).toBe("OFFLINE");
    expect(envBadge?.textContent).not.toContain("Alpaca · OFFLINE");
  });

  it("renders a single toggle button for Paper and Live, defaulting to Paper", async () => {
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
    const handleSwitchEnvironment = vi.fn();

    await renderMenu({
      handleSwitchEnvironment,
    });

    const singleLine = container.querySelector(".broker-controls-single-line");
    const buttons = singleLine?.querySelectorAll(".btn-env-mini");
    expect(buttons).toHaveLength(1);

    const toggleBtn = buttons![0] as HTMLButtonElement;
    expect(toggleBtn.textContent).toContain("🧪 Paper");
    expect(toggleBtn.classList.contains("active")).toBe(true);
    expect(toggleBtn.classList.contains("prod")).toBe(false);

    // Clicking toggle flips to PROD
    await act(async () => {
      toggleBtn.click();
    });
    expect(handleSwitchEnvironment).toHaveBeenCalledWith("PROD");
  });

  it("removes account details card and tuning controls from the dynamic menu", () => {
    expect(MENU_SRC).not.toContain("etrade-panel-account-card");
    expect(MENU_SRC).not.toContain("btn-mask-mini");
    expect(MENU_SRC).not.toContain("Account Value");
    expect(MENU_SRC).not.toContain("btn-menu-tuning");
    expect(MENU_SRC).not.toContain("menu-download-row");
    expect(MENU_SRC).not.toContain("OptionsDataDownloadDropdown");
  });

  it("SettingsMenu re-export alias is preserved for backwards compatibility", () => {
    expect(SettingsMenu).toBe(BrokerDynamicMenu);
  });
});

