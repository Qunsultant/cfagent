/**
 * @vitest-environment jsdom
 *
 * Issue #3694: Broker mode parity, 24/7 continuous trading around the clock,
 * Alpaca sync parity, and Platform Admin extraction of engine-tuning & downloads.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsMenu } from "../src/client/BrokerDynamicMenu";
import { PlatformAdminPage } from "../src/client/PlatformAdminPage";
import { DataHubHome } from "../src/client/DataHubHome";
import {
  copilotSessionAt,
  resolveCopilotSessions,
  shapeCopilotSessionOrder,
} from "../src/services/stockCopilotSessions";
import {
  setTenantProvidersStateForTest,
  resetTenantProvidersStateForTest,
} from "../src/client/tenantProviders";
import { diagnosticsEndpoint, syncTarget } from "../src/client/brokerEndpoints";
import { setBrokerEnvironmentForTest } from "../src/client/brokerEnvironment";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Issue #3694 — 24/7 continuous trading around the clock", () => {
  const SATURDAY_NOON = new Date("2026-11-07T17:00:00Z"); // Saturday 12:00 PM ET
  const SUNDAY_MORNING = new Date("2026-11-08T15:00:00Z"); // Sunday 10:00 AM ET

  it("copilotSessionAt returns null on weekend by default, but returns exto when aroundTheClock=true", () => {
    // Default weekend behavior: null
    expect(copilotSessionAt(SATURDAY_NOON)).toBeNull();
    expect(copilotSessionAt(SUNDAY_MORNING)).toBeNull();

    // Around the clock: returns exto for continuous limit-order operation
    expect(copilotSessionAt(SATURDAY_NOON, true)).toBe("exto");
    expect(copilotSessionAt(SUNDAY_MORNING, true)).toBe("exto");
  });

  it("shapeCopilotSessionOrder produces LIMIT order with session terms for exto around-the-clock trading", () => {
    const shape = shapeCopilotSessionOrder("exto", 225.50);
    expect(shape.orderType).toBe("LIMIT");
    if (shape.orderType === "LIMIT") {
      expect(shape.limitPrice).toBe(225.50);
      expect(shape.requiresSessionTerms).toBe(true);
    }
  });

  it("resolveCopilotSessions parses around_the_clock and 24/7 tokens into all 4 sessions", () => {
    expect(resolveCopilotSessions({ readSettingRaw: () => "around_the_clock" })).toEqual([
      "pre_market",
      "regular",
      "after_hours",
      "exto",
    ]);
    expect(resolveCopilotSessions({ readSettingRaw: () => "24/7" })).toEqual([
      "pre_market",
      "regular",
      "after_hours",
      "exto",
    ]);
    expect(resolveCopilotSessions({ env: { STOCK_COPILOT_AROUND_THE_CLOCK: "true" } })).toEqual([
      "pre_market",
      "regular",
      "after_hours",
      "exto",
    ]);
  });
});

describe("Issue #3694 — Broker live/paper parity, Alpaca sync & mode buttons", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    resetTenantProvidersStateForTest();
    // Issue #5879: the menu reads the module environment value, so
    // reset it — a switch in one test would otherwise leak into the next.
    setBrokerEnvironmentForTest("TEST");
    vi.restoreAllMocks();
  });

  it("diagnosticsEndpoint and syncTarget support broker parity without regressions", () => {
    expect(diagnosticsEndpoint("etrade")).toBe("/api/etrade/diagnostics");
    expect(diagnosticsEndpoint("alpaca")).toBeNull();
    const target = syncTarget("alpaca");
    expect(target.path).toBe("/api/broker/status");
    expect(target.diagnostics).toBe(false);
  });

  it("SettingsMenu displays Alpaca · Paper when the persisted environment is paper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ configured: true, signedIn: true }),
      }))
    );
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
    // Issue #5879: the environment is set on the module value, not
    // passed as an accountMode prop — the menu reads the one persisted selection.
    setBrokerEnvironmentForTest("TEST");
    root = createRoot(container);
    await act(async () => {
      root.render(<SettingsMenu />);
    });

    const trigger = container.querySelector(".broker-dynamic-menu-trigger") as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.title).toContain("Settings (Alpaca · Paper)");

    // Open dropdown to inspect badge and buttons
    await act(async () => {
      trigger.click();
    });

    const envBadge = container.querySelector(".broker-env-badge");
    expect(envBadge?.textContent).toContain("PAPER");

    // Paper toggle button has active class, not prod
    const testBtn = container.querySelector(".btn-env-mini:not(.prod)");
    expect(testBtn?.textContent).toContain("🧪 Paper");
    expect(testBtn?.classList.contains("active")).toBe(true);

    act(() => {
      root?.unmount();
    });
    root = null;
  });

  it("SettingsMenu displays Alpaca · Live when the persisted environment is live", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ configured: true, signedIn: true }),
      }))
    );
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
    // Issue #5879: see the paper test above.
    setBrokerEnvironmentForTest("PROD");
    root = createRoot(container);
    await act(async () => {
      root.render(<SettingsMenu />);
    });

    const trigger = container.querySelector(".broker-dynamic-menu-trigger") as HTMLButtonElement;
    expect(trigger.title).toContain("Settings (Alpaca · Live)");

    // Open dropdown to inspect badge
    await act(async () => {
      trigger.click();
    });

    const envBadge = container.querySelector(".broker-env-badge");
    expect(envBadge?.textContent).toContain("LIVE");

    act(() => {
      root?.unmount();
    });
    root = null;
  });

  it("clicking Paper/Live button triggers handleSwitchEnvironment and does not call OAuth", async () => {
    // Issue #5879: the mock parent must do what the real parent does —
    // a switch updates the module value the menu reads. Without the
    // setBrokerEnvironmentForTest call the menu would still read TEST
    // after the mocked confirm, and the second click would target PROD
    // again instead of switching back to paper.
    const handleSwitchEnvironment = vi.fn((target: "TEST" | "PROD") => {
      setBrokerEnvironmentForTest(target);
    });
    const handleStartOAuth = vi.fn();

    root = createRoot(container);
    await act(async () => {
      root.render(
        <SettingsMenu
          initialOpen={true}
          handleSwitchEnvironment={handleSwitchEnvironment}
          handleStartOAuth={handleStartOAuth}
        />
      );
    });

    const singleLine = container.querySelector(".broker-controls-single-line");
    const buttons = singleLine?.querySelectorAll(".btn-env-mini");
    expect(buttons).toHaveLength(1);

    // Click Paper / Live toggle button. Issue #4652: arming live asks first,
    // so the click opens the confirmation and switches nothing yet.
    await act(async () => {
      (buttons![0] as HTMLButtonElement).click();
    });
    expect(handleSwitchEnvironment).not.toHaveBeenCalled();
    expect(handleStartOAuth).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog, "the live-switch confirmation").not.toBeNull();
    const confirm = [...dialog!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Switch to live trading"),
    ) as HTMLButtonElement | undefined;
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.click();
    });
    expect(handleSwitchEnvironment).toHaveBeenCalledWith("PROD");
    expect(handleStartOAuth).not.toHaveBeenCalled();

    // Click toggle button again to switch back
    await act(async () => {
      (buttons![0] as HTMLButtonElement).click();
    });
    expect(handleSwitchEnvironment).toHaveBeenCalledWith("TEST");
    expect(handleStartOAuth).not.toHaveBeenCalled();

    act(() => {
      root?.unmount();
    });
    root = null;
  });
});

describe("Issue #3694 — Platform Admin Engine Tuning and Downloads sub-tabs", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  it("renders Engine Tuning sub-tab in PlatformAdminPage", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<PlatformAdminPage initialSection="engine-tuning" />);
    });

    expect(container.textContent).toContain("ETAPI Engine Configuration & Tuning");
    expect(container.textContent).toContain("Strategy & Pricing");
    expect(container.textContent).toContain("Screener Bounds");

    act(() => {
      root?.unmount();
    });
    root = null;
  });

  it("renders Parameters & Export downloads sub-tab in DataHubHome (#4585: downloads moved out of Platform Admin into the DataHub hub)", async () => {
    window.history.pushState(null, "", "/?tab=data-hub&view=downloads");
    root = createRoot(container);
    await act(async () => {
      root.render(<DataHubHome />);
    });

    expect(container.textContent).toContain("Parameters & Options Data Export");
    expect(container.textContent).toContain("Options Chain & Dataset Download");
    expect(container.textContent).toContain("Export Formats & Data Dictionary");

    act(() => {
      root?.unmount();
    });
    root = null;
  });
});
