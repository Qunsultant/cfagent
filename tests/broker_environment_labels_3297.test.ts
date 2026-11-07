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
import { readFileSync } from "node:fs";
import { BROKER_ENVIRONMENT_STORAGE_KEY } from "../src/client/brokerEnvironment";

const menu = readFileSync("src/client/BrokerDynamicMenu.tsx", "utf8");

describe("the switch speaks trading type (#3297)", () => {
  it("labels the two choices Paper and Live", () => {
    expect(menu).toContain("🧪 Paper");
    expect(menu).toContain("🔴 Live");
  });

  it("no longer shows the raw environment tokens to a user", () => {
    expect(menu).not.toContain("🧪 TEST");
    expect(menu).not.toContain("🔴 PROD");
    expect(menu).not.toContain('isLive ? "PROD" : "TEST"');
  });

  it("keeps sending TEST/PROD on the wire (#3719 single toggle)", () => {
    expect(menu).toContain('onSwitchEnv(isLive ? "TEST" : "PROD")');
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
