/**
 * Issue #2513 — auto-refresh interval options are externalized in
 * pollingConfig, not hardcoded in the dynamic panel menu.
 *
 * Guards: the menu reads its pill options from getPollingConfig(),
 * the menu source no longer contains the literal options array, and
 * the autoRefresh default interval is the polling config default.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { POLLING_CONFIG_DEFAULTS } from "../src/client/pollingConfig";
import { AUTO_REFRESH_DEFAULT_INTERVAL_S } from "../src/client/autoRefresh";

describe("auto-refresh config externalization (#2513)", () => {
  it("derives the auto-refresh default from the polling config default", () => {
    expect(AUTO_REFRESH_DEFAULT_INTERVAL_S).toBe(15);
    expect(AUTO_REFRESH_DEFAULT_INTERVAL_S).toBe(
      POLLING_CONFIG_DEFAULTS.autoRefreshDefaultS,
    );
    expect(POLLING_CONFIG_DEFAULTS.autoRefreshIntervalOptionsS).toEqual([
      10, 15, 30, 60, 120, 300,
    ]);
    expect(POLLING_CONFIG_DEFAULTS.autoRefreshMinS).toBe(10);
    expect(POLLING_CONFIG_DEFAULTS.autoRefreshMaxS).toBe(300);
  });

  it("reads menu pill options from getPollingConfig, not a literal array", () => {
    const menu = readFileSync("src/client/BrokerDynamicMenu.tsx", "utf8");
    expect(menu).toContain("getPollingConfig().autoRefreshIntervalOptionsS");
    expect(menu).not.toContain("[10, 15, 30, 60, 120, 300]");
  });

  it("clamps the server interval via the polling config helper", () => {
    const reports = readFileSync("src/agents/routes/reports.ts", "utf8");
    expect(reports).toContain("clampAutoRefreshIntervalS");
    expect(reports).toContain("resolvePollingConfigFromEnv");
  });
});
