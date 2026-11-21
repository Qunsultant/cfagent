/** @vitest-environment jsdom */
/**
 * Issue #3297: the control says Paper/Live, the wire keeps TEST/PROD.
 *
 * The value is a trading type now (#3280 made it authoritative for both
 * brokers), but the menu still said TEST/PROD — E*TRADE's vocabulary — and the
 * stored key still reads `etrade:environment`. The label changes; the migration
 * does not.
 */
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { BROKER_ENVIRONMENT_STORAGE_KEY, setBrokerEnvironmentForTest } from "../src/client/brokerEnvironment";
import { BrokerDynamicMenu } from "../src/client/BrokerDynamicMenu";
import {
  setTenantProvidersStateForTest,
  resetTenantProvidersStateForTest,
} from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const menu = readFileSync("src/client/BrokerDynamicMenu.tsx", "utf8");

/** Rendered menu text for one environment (Alpaca tenant, #3855: the
 * toggle label now comes from the presentation's modeShort, so the
 * assertion reads the rendered control, not a source literal).
 * Issue #5879: the environment is set on the module value, not passed
 * as a prop — the menu reads the one persisted selection. */
async function renderMenuText(env: "TEST" | "PROD"): Promise<string> {
  setTenantProvidersStateForTest({ brokerId: "alpaca" });
  setBrokerEnvironmentForTest(env);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(BrokerDynamicMenu, {
        initialOpen: true,
        userLogin: "OpenAIMP",
        userName: "OpenAIMP User",
      }),
    );
  });
  const text = container.textContent ?? "";
  act(() => root.unmount());
  container.remove();
  resetTenantProvidersStateForTest();
  setBrokerEnvironmentForTest("TEST");
  return text;
}

describe("the switch speaks trading type (#3297)", () => {
  it("labels the two choices Paper and Live", async () => {
    expect(await renderMenuText("TEST")).toContain("🧪 Paper");
    expect(await renderMenuText("PROD")).toContain("🔴 Live");
  });

  it("no longer shows the raw environment tokens to a user", () => {
    expect(menu).not.toContain("🧪 TEST");
    expect(menu).not.toContain("🔴 PROD");
    expect(menu).not.toContain('isLive ? "PROD" : "TEST"');
  });

  it("keeps sending TEST/PROD on the wire (#3719 single toggle)", () => {
    // Issue #4652: the toggle routes through requestEnvSwitch, which asks before
    // the TEST→PROD direction and otherwise calls onSwitchEnv — the wire values
    // are unchanged.
    expect(menu).toContain('requestEnvSwitch(isLive ? "TEST" : "PROD")');
    expect(menu).toContain('const target = mode === "live" ? "PROD" : "TEST"');
  });
});

describe("the stored key is unchanged, and says so (#3297)", () => {
  it("is still etrade:environment — a rename would be a migration", () => {
    expect(BROKER_ENVIRONMENT_STORAGE_KEY).toBe("etrade:environment");
  });

  it("the module documents the alias it owes the next reader", () => {
    const source = readFileSync("src/client/brokerEnvironment.ts", "utf8");
    expect(source).toContain("broker:environment");
    expect(source).toContain("data migration");
  });
});
