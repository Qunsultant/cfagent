/**
 * Issue #3419 (epic #3416) — one active mode per broker, and a menu that names
 * the selection.
 *
 * What these tests defend:
 *   1. The menu's broker label comes from `brokerPresentation`, not from a
 *      local ternary that defaults to E*TRADE. That ternary is exactly how the
 *      old menu kept saying E*TRADE after a broker switch.
 *   2. The mode phrase is the broker's own word: E*TRADE's test side is a
 *      "Paper sandbox"; Alpaca's is "Paper trading". Borrowing the noun is the
 *      same defect as borrowing the name.
 *   3. The environment control is single-valued: ONE boolean decides which of
 *      the two buttons carries `active`, so both can never be active at once —
 *      the epic's "exactly one active mode per broker" requirement, expressed
 *      as the structure that makes it true rather than a second list of modes.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsMenu } from "../src/client/ETradeDynamicMenu";
import { brokerPresentation } from "../src/trading/brokerPresentation";
import { saveTenantProviders } from "../src/client/tenantProviders";

const MENU_SRC = readFileSync(join(__dirname, "../src/client/ETradeDynamicMenu.tsx"), "utf8");

async function selectBroker(brokerId: string): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ brokerId, dataProviderId: brokerId }),
    })),
  );
  await saveTenantProviders({ brokerId, dataProviderId: brokerId });
}

function renderMenu(): string {
  return ReactDOMServer.renderToString(React.createElement(SettingsMenu));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("menu names the selected broker (#3419)", () => {
  it("renders without a broker-specific label baked into the trigger", async () => {
    await selectBroker("alpaca");
    const html = renderMenu();
    // The collapsed trigger names no firm: the broker's name lives in the
    // panel, which opens on demand. What matters is that the trigger does not
    // claim E*TRADE for an Alpaca tenant.
    expect(html).toContain("settings-menu-trigger");
    expect(html).not.toContain("E*TRADE");
  });

  it("derives the label from the presentation module, not a local fallback", () => {
    expect(MENU_SRC).toContain("brokerPresentation(selectedBrokerId).label");
    expect(MENU_SRC).not.toContain('selectedBrokerId === "alpaca" ? "Alpaca" : "E*TRADE"');
    expect(MENU_SRC).not.toContain('?? "E*TRADE"');
  });
});

describe("mode phrase is the broker's own word (#3419)", () => {
  it("keeps E*TRADE's sandbox noun on E*TRADE", () => {
    expect(brokerPresentation("etrade").modeWord.paper).toBe("Paper sandbox");
    expect(brokerPresentation("etrade").modeWord.live).toBe("Live execution");
  });

  it("gives Alpaca its own noun", () => {
    expect(brokerPresentation("alpaca").modeWord.paper).toBe("Paper trading");
    expect(brokerPresentation("alpaca").modeWord.live).toBe("Live trading");
  });

  it("no longer hardcodes the E*TRADE phrase in the menu", () => {
    expect(MENU_SRC).not.toContain('"Paper sandbox"');
    expect(MENU_SRC).toContain(".modeWord[");
  });
});

describe("one active mode per broker (#3419)", () => {
  it("decides both environment buttons from the same single boolean", () => {
    // Two `active` classes driven by one value cannot both be on. A second
    // mode list (e.g. "paper is active when Alpaca and TEST") is what the
    // epic forbids; this pin makes the single source structural.
    expect(MENU_SRC).toContain('${!isLive ? "active" : ""}');
    expect(MENU_SRC).toContain('${isLive ? "active" : ""}');
    expect(MENU_SRC).not.toMatch(/const\s+isPaper\s*=/);
  });

  it("reads the mode from the one broker-environment module", () => {
    expect(MENU_SRC).toContain("useBrokerEnvironment()");
  });
});
