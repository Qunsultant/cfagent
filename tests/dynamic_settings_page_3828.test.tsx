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

describe("Issue #3828 — Dynamic settings menu as a page from bottom-left fixed button", () => {
  it("Chat.tsx mounts a fixed bottom-left Settings button outside side-nav and removes <SettingsMenu from top headers", () => {
    expect(CHAT_SRC).not.toContain("<SettingsMenu");
    expect(CHAT_SRC).toContain('aria-label="Settings"');
    expect(CHAT_SRC).toContain('handleSelectTab("nav-settings")');
    expect(CHAT_SRC).toContain('position: "fixed"');
    expect(CHAT_SRC).toContain("settingsMenuProps={{");
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
