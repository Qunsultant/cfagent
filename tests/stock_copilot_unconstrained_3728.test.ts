/**
 * Issue #3728: Unconstrained Stock Copilot autonomous loop service resolution.
 */
import { describe, expect, it } from "vitest";
import {
  copilotSessionAt,
  isAroundTheClock,
  resolveCopilotSessions,
  COPILOT_SESSIONS,
} from "../src/services/stockCopilotSessions";

describe("Issue #3728: isAroundTheClock resolver", () => {
  const SATURDAY_NOON = new Date("2026-11-07T17:00:00Z"); // Saturday 12:00 PM ET
  const SUNDAY_MORNING = new Date("2026-11-08T15:00:00Z"); // Sunday 10:00 AM ET

  it("returns false when no around-the-clock env or settings are present", () => {
    expect(isAroundTheClock({})).toBe(false);
    expect(isAroundTheClock({ env: {} })).toBe(false);
    expect(isAroundTheClock({ readSettingRaw: () => null, env: {} })).toBe(false);
  });

  it("returns true when STOCK_COPILOT_AROUND_THE_CLOCK is true in env", () => {
    expect(isAroundTheClock({ env: { STOCK_COPILOT_AROUND_THE_CLOCK: "true" } })).toBe(true);
  });

  it("returns true when STOCK_COPILOT_FORCE_ALL_SESSIONS or IGNORE_SESSIONS is true in env", () => {
    expect(isAroundTheClock({ env: { STOCK_COPILOT_FORCE_ALL_SESSIONS: "true" } })).toBe(true);
    expect(isAroundTheClock({ env: { STOCK_COPILOT_IGNORE_SESSIONS: "true" } })).toBe(true);
  });

  it("returns true when stock_copilot:around_the_clock setting is true", () => {
    expect(
      isAroundTheClock({
        readSettingRaw: (key) => (key === "stock_copilot:around_the_clock" ? "true" : null),
      }),
    ).toBe(true);
  });

  it("returns true when all 4 sessions are explicitly stored in stock_copilot:sessions", () => {
    expect(
      isAroundTheClock({
        readSettingRaw: (key) =>
          key === "stock_copilot:sessions" ? "pre_market,regular,after_hours,exto" : null,
      }),
    ).toBe(true);
  });

  it("returns true when around_the_clock, 24/7, continuous, or all is stored in sessions", () => {
    expect(
      isAroundTheClock({
        readSettingRaw: (key) =>
          key === "stock_copilot:sessions" ? "around_the_clock" : null,
      }),
    ).toBe(true);
    expect(
      isAroundTheClock({
        readSettingRaw: (key) => (key === "stock_copilot:sessions" ? "24/7" : null),
      }),
    ).toBe(true);
    expect(
      isAroundTheClock({
        readSettingRaw: (key) => (key === "stock_copilot:sessions" ? "continuous" : null),
      }),
    ).toBe(true);
  });

  it("enables copilotSessionAt to map weekend and off-hours to exto when around-the-clock is active", () => {
    const aroundTheClock = isAroundTheClock({
      env: { STOCK_COPILOT_AROUND_THE_CLOCK: "true" },
    });
    expect(copilotSessionAt(SATURDAY_NOON, aroundTheClock)).toBe("exto");
    expect(copilotSessionAt(SUNDAY_MORNING, aroundTheClock)).toBe("exto");
  });
});
