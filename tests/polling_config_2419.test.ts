/**
 * Issue #2419 — externalized polling cadences (AOP).
 *
 * Every tunable in the polling migration resolves through here: the
 * server injects window.__POLLING_CONFIG__ at boot from wrangler vars,
 * the landing page interpolates the same values at render time, and
 * anything without an injected value falls back to the defaults below.
 * No polling interval literal lives in component code.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  POLLING_CONFIG_DEFAULTS,
  clampAutoRefreshIntervalS,
  resolvePollingConfig,
  resolvePollingConfigFromEnv,
  getPollingConfig,
} from "../src/client/pollingConfig";

describe("polling config (#2419)", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("defaults to the documented cadences", () => {
    expect(POLLING_CONFIG_DEFAULTS).toEqual({
      quotesRestFallbackMs: 60_000,
      quotesWsReconnectBaseMs: 1_000,
      quotesWsReconnectCapMs: 30_000,
      optionsFlowsPollMs: 30_000,
      optionsLatestPollMs: 60_000,
      chatAutoRefreshFloorS: 5,
      goalTrackPollMs: 2_000,
      goalTrackDeadlineMs: 600_000,
      autoRefreshIntervalOptionsS: [10, 15, 30, 60, 120, 300],
      autoRefreshDefaultS: 15,
      autoRefreshMinS: 10,
      autoRefreshMaxS: 300,
      // Issue #4782 S3 — the live parent poll intervals (the 15s
      // DEFAULT_POLL_INTERVAL_MS is dead code, left for #4776).
      screenDoorParentPollMs: 5_000,
      chatScreenParentPollMs: 5_000,
    });
  });

  it("resolves the live parent poll intervals from env (#4782 S3)", () => {
    const resolved = resolvePollingConfigFromEnv({
      SCREEN_DOOR_PARENT_POLL_MS: "3000",
      CHAT_SCREEN_PARENT_POLL_MS: "7000",
    });
    expect(resolved.screenDoorParentPollMs).toBe(3_000);
    expect(resolved.chatScreenParentPollMs).toBe(7_000);
    const bad = resolvePollingConfigFromEnv({
      SCREEN_DOOR_PARENT_POLL_MS: "not-a-number",
      CHAT_SCREEN_PARENT_POLL_MS: "-5",
    });
    expect(bad.screenDoorParentPollMs).toBe(5_000);
    expect(bad.chatScreenParentPollMs).toBe(5_000);
  });

  it("resolves injected values and ignores invalid ones", () => {
    const resolved = resolvePollingConfig({
      quotesRestFallbackMs: 45_000,
      optionsFlowsPollMs: "not-a-number",
      goalTrackPollMs: -5,
      chatAutoRefreshFloorS: 10,
    });
    expect(resolved.quotesRestFallbackMs).toBe(45_000);
    expect(resolved.optionsFlowsPollMs).toBe(30_000);
    expect(resolved.goalTrackPollMs).toBe(2_000);
    expect(resolved.chatAutoRefreshFloorS).toBe(10);
  });

  it("maps wrangler env var names to config keys", () => {
    const resolved = resolvePollingConfigFromEnv({
      QUOTES_REST_FALLBACK_MS: "45000",
      OPTIONS_LATEST_POLL_MS: "90000",
      CHAT_AUTO_REFRESH_FLOOR_S: "8",
    });
    expect(resolved.quotesRestFallbackMs).toBe(45_000);
    expect(resolved.optionsLatestPollMs).toBe(90_000);
    expect(resolved.chatAutoRefreshFloorS).toBe(8);
    expect(resolved.optionsFlowsPollMs).toBe(30_000);
  });

  it("resolves auto-refresh options from injected and env values (#2513)", () => {
    const injected = resolvePollingConfig({
      autoRefreshIntervalOptionsS: [20, 40],
      autoRefreshDefaultS: 20,
      autoRefreshMinS: 20,
      autoRefreshMaxS: 40,
    });
    expect(injected.autoRefreshIntervalOptionsS).toEqual([20, 40]);
    expect(injected.autoRefreshDefaultS).toBe(20);
    expect(injected.autoRefreshMinS).toBe(20);
    expect(injected.autoRefreshMaxS).toBe(40);

    const fromEnv = resolvePollingConfigFromEnv({
      AUTO_REFRESH_INTERVAL_OPTIONS_S: "10,30,90",
      AUTO_REFRESH_DEFAULT_S: "30",
      AUTO_REFRESH_MIN_S: "10",
      AUTO_REFRESH_MAX_S: "90",
    });
    expect(fromEnv.autoRefreshIntervalOptionsS).toEqual([10, 30, 90]);
    expect(fromEnv.autoRefreshDefaultS).toBe(30);
    expect(fromEnv.autoRefreshMinS).toBe(10);
    expect(fromEnv.autoRefreshMaxS).toBe(90);

    const invalid = resolvePollingConfig({
      autoRefreshIntervalOptionsS: "not-a-list",
      autoRefreshDefaultS: -1,
      autoRefreshMinS: 0,
    });
    expect(invalid.autoRefreshIntervalOptionsS).toEqual([10, 15, 30, 60, 120, 300]);
    expect(invalid.autoRefreshDefaultS).toBe(15);
    expect(invalid.autoRefreshMinS).toBe(10);
  });

  it("clamps auto-refresh intervals to the configured min/max (#2513)", () => {
    expect(clampAutoRefreshIntervalS(5)).toBe(10);
    expect(clampAutoRefreshIntervalS(15)).toBe(15);
    expect(clampAutoRefreshIntervalS(600)).toBe(300);
    expect(clampAutoRefreshIntervalS(45.7)).toBe(45);
    expect(
      clampAutoRefreshIntervalS(100, {
        autoRefreshMinS: 20,
        autoRefreshMaxS: 40,
      }),
    ).toBe(40);
  });

  it("reads the server-injected window config, else defaults", () => {
    (globalThis as { window?: unknown }).window = {
      __POLLING_CONFIG__: { optionsFlowsPollMs: 15_000 },
    };
    expect(getPollingConfig().optionsFlowsPollMs).toBe(15_000);
    expect(getPollingConfig().optionsLatestPollMs).toBe(60_000);
    delete (globalThis as { window?: unknown }).window;
    expect(getPollingConfig()).toEqual(POLLING_CONFIG_DEFAULTS);
  });
});
