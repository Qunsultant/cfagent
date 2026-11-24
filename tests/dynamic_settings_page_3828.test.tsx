/** @vitest-environment jsdom */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { NavSettingsPage } from "../src/client/NavSettingsPage";
import { leftNavConfigIds } from "../src/client/navPresets";

const CHAT_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/client/Chat.tsx"),
  "utf8",
);

const LEFT_NAV_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/client/components/LeftNavBar.tsx"),
  "utf8",
);

const NAV_MENU_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/client/components/NavigationMenu.tsx"),
  "utf8",
);

describe("Issue #3828 — Dynamic settings menu as a page from bottom-left fixed button", () => {
  // Issue #6147 S4a: the fixed bottom-left button is GONE — the trigger
  // moved into the nav shell (left-nav footer + top-bar control). The
  // page itself is unchanged; only the trigger's home moved.
  it("Chat.tsx no longer mounts a fixed bottom-left Settings button; the trigger lives in the nav shell", () => {
    expect(CHAT_SRC).not.toContain("<SettingsMenu");
    expect(CHAT_SRC).not.toContain('position: "fixed"');
    expect(CHAT_SRC).not.toContain('handleSelectTab("nav-settings")');
    expect(CHAT_SRC).toContain("settingsMenuProps={{");
    // Left mode: the footer trigger in LeftNavBar, wired by the
    // NavigationMenu mount.
    expect(LEFT_NAV_SRC).toContain("onOpenSettings");
    expect(LEFT_NAV_SRC).toContain('aria-label="Settings"');
    expect(LEFT_NAV_SRC).toContain("sidebar-settings-footer");
    expect(NAV_MENU_SRC).toContain('onOpenSettings={() => onSelectTab("nav-settings")}');
    // Top mode: the top bar carries its own trigger (the left-nav
    // footer does not exist in top layout).
    expect(NAV_MENU_SRC).toContain('onSelectTab("nav-settings")');
  });

  it("NavSettingsPage renders BrokerDynamicMenu inline as a page without dropdown trigger chrome", () => {
    const html = ReactDOMServer.renderToString(
      <NavSettingsPage
        visibleTabs={Object.fromEntries(leftNavConfigIds().map((id) => [id, true]))}
        activePreset="all"
        onToggleTabVisibility={() => {}}
        onApplyPreset={() => {}}
        settingsMenuProps={{
          userLogin: "OpenAIMP",
          activeEnv: "TEST",
        }}
      />,
    );
    expect(html).toContain("Platform &amp; Broker Settings");
    expect(html).toContain("broker-dynamic-menu-page");
    expect(html).not.toContain("settings-menu-trigger");
    expect(html).not.toContain("Open Navigation Settings");
    expect(html).toContain("Navigation presets");
  });
});
