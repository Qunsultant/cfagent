import { describe, it, expect } from "vitest";
import { isDue } from "../src/schedule";

// Monday 2026-10-26 09:00 EDT == 13:00Z. Sunday 2026-10-25, Saturday 2026-10-24.
// Monday 2026-01-05 09:00 EST == 14:00Z (winter, UTC-5).
const MON_0900_EDT = new Date("2026-10-26T13:00:00Z");
const MON_0830_EDT = new Date("2026-10-26T12:30:00Z");
const MON_0930_EDT = new Date("2026-10-26T13:30:00Z");
const SUN_0900_EDT = new Date("2026-10-25T13:00:00Z");
const SAT_0900_EDT = new Date("2026-10-24T13:00:00Z");
const MON_0900_EST = new Date("2026-01-05T14:00:00Z");
const WED_0900_EDT = new Date("2026-10-28T13:00:00Z");
const TUE_0900_EDT = new Date("2026-10-27T13:00:00Z");

describe("isDue without a timeZone — full five-field UTC matching (#4235)", () => {
  it("matches hour/minute in UTC", () => {
    expect(isDue("0 6 * * *", undefined, new Date("2026-10-26T06:00:00Z"))).toBe(true);
    expect(isDue("0 6 * * *", undefined, new Date("2026-10-26T05:59:00Z"))).toBe(false);
    expect(isDue("30 6 * * *", undefined, new Date("2026-10-26T06:15:00Z"))).toBe(false);
    expect(isDue("30 6 * * *", undefined, new Date("2026-10-26T06:30:00Z"))).toBe(true);
  });

  it("fires step hours: the old never-fires quirk is gone (#4235)", () => {
    // "0 */6 * * *" used to map the hour through Number() to NaN and
    // never fire; #4235 honors all five fields, so the step hours
    // fire — and only the step hours.
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T06:00:00Z"))).toBe(true);
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T12:00:00Z"))).toBe(true);
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T07:00:00Z"))).toBe(false);
    expect(isDue("0 */6 * * *", undefined, MON_0900_EDT)).toBe(false);
  });

  it("honors day-of-month/month/weekday fields (#4235)", () => {
    // 2026-10-26 is a Monday. The old code read only the first two
    // fields, so both of these fired; now the day fields gate.
    expect(isDue("0 6 * * 0", undefined, new Date("2026-10-26T06:00:00Z"))).toBe(false);
    expect(isDue("0 6 * * 1", undefined, new Date("2026-10-26T06:00:00Z"))).toBe(true);
    expect(isDue("0 6 15 3 2", undefined, new Date("2026-10-26T06:00:00Z"))).toBe(false);
    expect(isDue("0 6 26 10 1", undefined, new Date("2026-10-26T06:00:00Z"))).toBe(true);
  });

  it("returns false for unparseable minute/hour", () => {
    expect(isDue("not-a-cron", undefined, MON_0900_EDT)).toBe(false);
    expect(isDue("x 6 * * *", undefined, MON_0900_EDT)).toBe(false);
    expect(isDue("0 y * * *", undefined, MON_0900_EDT)).toBe(false);
  });

  it("enforces the 23h anti-double-fire guard", () => {
    const now = new Date("2026-10-26T06:00:00Z");
    expect(isDue("0 6 * * *", new Date(now.getTime() - 60 * 60 * 1000).toISOString(), now)).toBe(false);
    expect(isDue("0 6 * * *", new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), now)).toBe(true);
    expect(isDue("0 6 * * *", new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString(), now)).toBe(true);
  });
});

describe("isDue with a timeZone — zone wall-clock + weekday matching", () => {
  const NY = "America/New_York";

  it("fires the seeded social schedule: 09:00 ET weekdays", () => {
    expect(isDue("0 9 * * 1-5", undefined, MON_0900_EDT, NY)).toBe(true);
    expect(isDue("0 9 * * 1-5", undefined, SUN_0900_EDT, NY)).toBe(false);
    expect(isDue("0 9 * * 1-5", undefined, SAT_0900_EDT, NY)).toBe(false);
    expect(isDue("0 9 * * 1-5", undefined, MON_0830_EDT, NY)).toBe(false);
  });

  it("tolerates a late tick inside the hour (window rule, like the old code)", () => {
    expect(isDue("0 9 * * 1-5", undefined, MON_0930_EDT, NY)).toBe(true);
  });

  it("holds the same wall-clock time across DST (EDT and EST)", () => {
    expect(isDue("0 9 * * 1-5", undefined, MON_0900_EST, NY)).toBe(true);
  });

  it("matches weekday lists and ranges", () => {
    expect(isDue("0 9 * * 1,3,5", undefined, WED_0900_EDT, NY)).toBe(true);
    expect(isDue("0 9 * * 1,3,5", undefined, TUE_0900_EDT, NY)).toBe(false);
    expect(isDue("0 9 * * 6,0", undefined, SAT_0900_EDT, NY)).toBe(true);
    expect(isDue("0 9 * * 6,0", undefined, SUN_0900_EDT, NY)).toBe(true);
    expect(isDue("0 9 * * 6,0", undefined, MON_0900_EDT, NY)).toBe(false);
    expect(isDue("0 9 * * 7", undefined, SUN_0900_EDT, NY)).toBe(true);
  });

  it("matches hour ranges and steps, minute lists", () => {
    expect(isDue("0 9-11 * * *", undefined, new Date("2026-10-26T14:00:00Z"), NY)).toBe(true);
    expect(isDue("0 9-11 * * *", undefined, new Date("2026-10-26T16:00:00Z"), NY)).toBe(false);
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T16:00:00Z"), NY)).toBe(true);
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T17:00:00Z"), NY)).toBe(false);
    expect(isDue("30 9 * * *", undefined, new Date("2026-10-26T13:45:00Z"), NY)).toBe(true);
    expect(isDue("30 9 * * *", undefined, new Date("2026-10-26T13:15:00Z"), NY)).toBe(false);
  });

  it("matches day-of-month and month fields", () => {
    expect(isDue("0 9 26 * *", undefined, MON_0900_EDT, NY)).toBe(true);
    expect(isDue("0 9 27 * *", undefined, MON_0900_EDT, NY)).toBe(false);
    expect(isDue("0 9 * 10 *", undefined, MON_0900_EDT, NY)).toBe(true);
    expect(isDue("0 9 * 11 *", undefined, MON_0900_EDT, NY)).toBe(false);
  });

  it("keeps the 23h guard in the zone path", () => {
    expect(
      isDue("0 9 * * 1-5", new Date(MON_0900_EDT.getTime() - 60 * 60 * 1000).toISOString(), MON_0900_EDT, NY)
    ).toBe(false);
  });

  it("never throws: invalid cron or timeZone returns false", () => {
    expect(() => isDue("99 99 * * *", undefined, MON_0900_EDT, NY)).not.toThrow();
    expect(isDue("99 99 * * *", undefined, MON_0900_EDT, NY)).toBe(false);
    expect(() => isDue("0 9 * * *", undefined, MON_0900_EDT, "Not/AZone")).not.toThrow();
    expect(isDue("0 9 * * *", undefined, MON_0900_EDT, "Not/AZone")).toBe(false);
    expect(isDue("0 9 * * 8", undefined, MON_0900_EDT, NY)).toBe(false);
  });
});
