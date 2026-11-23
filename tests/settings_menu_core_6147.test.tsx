/** @vitest-environment jsdom */
/**
 * Issue #6147 (S1, items 1 + 3 + 4) — settings menu core.
 *
 * Pins the three S1 changes where they are observable without a browser:
 *
 * - Item 1: `.broker-brand-title` has a flex-row rule in the sanctioned
 *   token-only sheet (`primitives.css`) — icon beside the name, not
 *   stacked above it — and NO rule in the frozen `styles.deprecated.css`.
 * - Item 3: the rendered picker shows IBKR as a disabled pill carrying
 *   its reason, and the header still renders the brand wrapper.
 * - Item 4: the rendered section order is Broker → Environment &
 *   Connection → Data provider.
 *
 * Render harness follows tests/dynamic_settings_page_3828.test.tsx
 * (NavSettingsPage, page variant, server render — no effects run).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { NavSettingsPage } from "../src/client/NavSettingsPage";
import { leftNavConfigIds } from "../src/client/navPresets";

const PRIMITIVES_CSS = fs.readFileSync(
  path.resolve(process.cwd(), "src/client/components/ui/primitives.css"),
  "utf8",
);
const DEPRECATED_CSS = fs.readFileSync(
  path.resolve(process.cwd(), "src/client/styles.deprecated.css"),
  "utf8",
);
const MENU_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/client/BrokerDynamicMenu.tsx"),
  "utf8",
);

function renderSettingsPage(): string {
  return ReactDOMServer.renderToString(
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
}

describe("Issue #6147 (S1) — settings menu core: header, IBKR picker, section order", () => {
  it("6147-S1-P11: .broker-brand-title is a token-only flex row in primitives.css", () => {
    const match = PRIMITIVES_CSS.match(/\.broker-brand-title\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const rule = match?.[1] ?? "";
    expect(rule).toContain("display: flex");
    expect(rule).toContain("align-items: center");
    expect(rule).toMatch(/gap:\s*var\(--space-[^)]+\)/);
    expect(rule).not.toMatch(/\d+(px|rem)/);
  });

  it("6147-S1-P12: the frozen sheet carries no .broker-brand-title rule", () => {
    expect(DEPRECATED_CSS).not.toContain(".broker-brand-title");
  });

  it("6147-S1-P13: the menu still renders the brand wrapper (icon + SmallHeader title)", () => {
    expect(MENU_SRC).toContain('className="broker-brand-title"');
    expect(MENU_SRC).toContain('className="brand-icon"');
    expect(MENU_SRC).toContain("<SmallHeader title=");
    const html = renderSettingsPage();
    expect(html).toContain("broker-brand-title");
    expect(html).toContain("brand-icon");
  });

  it("6147-S1-P14: the picker renders IBKR as a disabled pill carrying its reason", () => {
    const html = renderSettingsPage();
    expect(html).toContain("Interactive Brokers");
    expect(html).toContain(
      'title="Interactive Brokers has no execution adapter yet — read-only"',
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*title="Interactive Brokers has no execution adapter yet — read-only"/,
    );
  });

  it("6147-S1-P15: sections render Broker, then Environment & Connection, then Data provider", () => {
    const html = renderSettingsPage();
    const broker = html.indexOf("<span>Broker</span>");
    const env = html.indexOf("<span>Environment &amp; Connection</span>");
    const data = html.indexOf("<span>Data provider</span>");
    expect(broker).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(-1);
    expect(data).toBeGreaterThan(-1);
    expect(broker).toBeLessThan(env);
    expect(env).toBeLessThan(data);
  });
});
