// @vitest-environment node
/**
 * Issue #6030 — one declaration of the OODA fire hour.
 *
 * The scheduled research run's hour used to be declared twice: a module
 * literal in `researchScheduleGuard` (`RESEARCH_SCHEDULED_FIRE_HOUR_UTC`)
 * and `researchJobConfig.scheduleUtcHour` (overridable by
 * `RESEARCH_SCHEDULE_UTC_HOUR`). They agreed only because both defaults
 * were 21, so setting the env var moved the guard window and left the
 * fire decision behind: a 21:00 tick dispatched, the deterministic door
 * refused `outside_guard_window`, and the 22:00 window then found the
 * day's run already burned.
 *
 * These pins hold the two decisions to one source:
 *  - the fire hour comes from `resolveResearchJobConfig(env)`, the same
 *    value `isWithinResearchGuardWindow` reads;
 *  - the derived nightly cron moves with it;
 *  - the default (no env) behaviour is unchanged.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isWithinResearchGuardWindow,
  resolveResearchJobConfig,
} from "../src/config/researchJobConfig";
import {
  nightlyResearchDispatchCron,
  shouldFireResearchTick,
} from "../src/services/researchScheduleGuard";

/** Monday 2026-10-19 at the given UTC hour, minute 0. */
function mondayAt(hour: number): Date {
  return new Date(Date.UTC(2026, 9, 19, hour, 0, 0));
}

const ENV_21 = { RESEARCH_SCHEDULE_UTC_HOUR: "21" } as Record<string, string>;
const ENV_22 = { RESEARCH_SCHEDULE_UTC_HOUR: "22" } as Record<string, string>;

describe("#6030 one fire hour: the guard reads the research config", () => {
  it("the guard module carries no fire-hour literal of its own", () => {
    const source = readFileSync("src/services/researchScheduleGuard.ts", "utf8");
    expect(source).not.toContain("RESEARCH_SCHEDULED_FIRE_HOUR_UTC");
    expect(source).toContain("config.scheduleUtcHour");
  });

  it("the derived cron is the config hour in cron form", () => {
    expect(nightlyResearchDispatchCron(resolveResearchJobConfig(ENV_21))).toBe(
      "0 21 * * 1-5"
    );
    expect(nightlyResearchDispatchCron(resolveResearchJobConfig(ENV_22))).toBe(
      "0 22 * * 1-5"
    );
  });

  it("with RESEARCH_SCHEDULE_UTC_HOUR=22 a 21:00 tick does not fire, and 22:00 does", () => {
    const config = resolveResearchJobConfig(ENV_22);
    expect(shouldFireResearchTick(mondayAt(21), null, config)).toEqual({
      fire: false,
      dateKey: "2026-10-19",
      reason: "too-early",
    });

    const onTime = shouldFireResearchTick(mondayAt(22), null, config);
    expect(onTime.fire).toBe(true);
    expect(isWithinResearchGuardWindow(mondayAt(22), config)).toBe(true);
  });

  it("the day's run fires once: a second tick the same day is already-fired", () => {
    const config = resolveResearchJobConfig(ENV_22);
    expect(shouldFireResearchTick(mondayAt(22), null, config).fire).toBe(true);
    expect(shouldFireResearchTick(mondayAt(22), "2026-10-19", config)).toEqual({
      fire: false,
      dateKey: "2026-10-19",
      reason: "already-fired",
    });
  });

  it("the fire decision and the guard window open together, for every configured hour", () => {
    // At the window's opening minute the two must agree: the tick fires
    // and the deterministic door admits it. Below the hour both refuse;
    // above it the window has closed but the day's run may still catch up
    // (the guard fires once per weekday, never twice) — that asymmetry is
    // intentional and asserted here, not accidental.
    for (const env of [ENV_21, ENV_22]) {
      const config = resolveResearchJobConfig(env);
      const hour = config.scheduleUtcHour;
      for (const probe of [hour - 1, hour, hour + 1]) {
        const now = mondayAt(probe);
        const fire = shouldFireResearchTick(now, null, config);
        const inWindow = isWithinResearchGuardWindow(now, config);
        if (probe < hour) {
          expect(fire.fire, `h=${probe} env=${hour}`).toBe(false);
          expect(inWindow, `h=${probe} env=${hour}`).toBe(false);
        } else if (probe === hour) {
          expect(fire.fire, `h=${probe} env=${hour}`).toBe(true);
          expect(inWindow, `h=${probe} env=${hour}`).toBe(true);
        } else {
          expect(fire.fire, `h=${probe} env=${hour}`).toBe(true);
          expect(inWindow, `h=${probe} env=${hour}`).toBe(false);
        }
      }
    }
  });

  it("the default (no env) behaviour is unchanged: 21:00 UTC, Mon-Fri", () => {
    const config = resolveResearchJobConfig(undefined);
    expect(config.scheduleUtcHour).toBe(21);
    expect(shouldFireResearchTick(mondayAt(21), null, config).fire).toBe(true);
    expect(shouldFireResearchTick(mondayAt(20), null, config)).toEqual({
      fire: false,
      dateKey: "2026-10-19",
      reason: "too-early",
    });
    // Saturday 2026-10-24 22:00 UTC — the weekend rule still wins.
    const saturday = new Date(Date.UTC(2026, 9, 24, 22, 0, 0));
    expect(shouldFireResearchTick(saturday, null, config)).toEqual({
      fire: false,
      dateKey: "2026-10-24",
      reason: "weekend",
    });
  });
});
