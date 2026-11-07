/**
 * @vitest-environment jsdom
 *
 * Issue #3694: Broker mode parity, 24/7 continuous trading around the clock,
 * Alpaca sync parity, and Platform Admin extraction of engine-tuning & downloads.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsMenu } from "../src/client/ETradeDynamicMenu";
import { PlatformAdminPage } from "../src/client/PlatformAdminPage";
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
    vi.restoreAllMocks();
  });

  it("diagnosticsEndpoint and syncTarget support broker parity without regressions", () => {
    expect(diagnosticsEndpoint("etrade")).toBe("/api/etrade/diagnostics");
    expect(diagnosticsEndpoint("alpaca")).toBeNull();
    const target = syncTarget("alpaca");
    expect(target.path).toBe("/api/broker/status");
    expect(target.diagnostics).toBe(false);
  });

  it("SettingsMenu displays Alpaca · Paper when accountMode is paper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ configured: true, signedIn: true }),
      }))
    );
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
    root = createRoot(container);
    await act(async () => {
      root.render(<SettingsMenu accountMode="paper" />);
    });

    const trigger = container.querySelector(".etrade-dynamic-menu-trigger") as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.title).toContain("Settings (Alpaca · Paper)");

    // Open dropdown to inspect badge and buttons
    await act(async () => {
      trigger.click();
    });

    const envBadge = container.querySelector(".etrade-env-badge");
    expect(envBadge?.textContent).toContain("Alpaca · Paper");

    // Paper button has active class, Live does not
    const testBtn = container.querySelector(".btn-env-mini:not(.prod)");
    expect(testBtn?.textContent).toContain("🧪 Paper");
    expect(testBtn?.classList.contains("active")).toBe(true);

    act(() => {
      root?.unmount();
    });
    root = null;
  });

  it("SettingsMenu displays Alpaca · Live when accountMode is live", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ configured: true, signedIn: true }),
      }))
    );
    setTenantProvidersStateForTest({ brokerId: "alpaca" });
    root = createRoot(container);
    await act(async () => {
      root.render(<SettingsMenu accountMode="live" />);
    });

    const trigger = container.querySelector(".etrade-dynamic-menu-trigger") as HTMLButtonElement;
    expect(trigger.title).toContain("Settings (Alpaca · Live)");

    // Open dropdown to inspect badge
    await act(async () => {
      trigger.click();
    });

    const envBadge = container.querySelector(".etrade-env-badge");
    expect(envBadge?.textContent).toContain("Alpaca · Live");

    act(() => {
      root?.unmount();
    });
    root = null;
  });

  it("clicking Paper/Live button triggers handleSwitchEnvironment and does not call OAuth", async () => {
    const handleSwitchEnvironment = vi.fn();
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

    const singleLine = container.querySelector(".etrade-controls-single-line");
    const buttons = singleLine?.querySelectorAll(".btn-env-mini");
    expect(buttons).toHaveLength(2);

    // Click Paper / Sandbox
    await act(async () => {
      (buttons![0] as HTMLButtonElement).click();
    });
    expect(handleSwitchEnvironment).toHaveBeenCalledWith("TEST");
    expect(handleStartOAuth).not.toHaveBeenCalled();

    // Click Live
    await act(async () => {
      (buttons![1] as HTMLButtonElement).click();
    });
    expect(handleSwitchEnvironment).toHaveBeenCalledWith("PROD");
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

  it("renders Parameters & Export downloads sub-tab in PlatformAdminPage", async () => {
    root = createRoot(container);
    await act(async () => {
      root.render(<PlatformAdminPage initialSection="downloads" />);
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
