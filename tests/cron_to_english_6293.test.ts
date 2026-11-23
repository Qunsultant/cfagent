 /** Issue #6293 — cronToEnglish must never render NaN, and stepped hours
 * are their own cadence (not daily).
 *
 * The deployed opportunity-hunt goal stores "0 * /6 * * *" while the
 * built-in config says "0 7 * * *"; the old translator took the Daily
 * branch and rendered "Daily at NaN:00 AM UTC" (parseInt of the step
 * is NaN). Stepped minutes in an otherwise plain field fall back to the
 * raw cron rather than a broken rendering.
 */
import { describe, it, expect } from "vitest";
import { cronToEnglish } from "../src/client/SchedulesPanel";

describe("cronToEnglish (issue 6293)", () => {
  it("renders a plain daily cron as before", () => {
    expect(cronToEnglish("0 3 * * *")).toBe("Daily at 3:00 AM UTC");
    expect(cronToEnglish("0 7 * * *")).toBe("Daily at 7:00 AM UTC");
    expect(cronToEnglish("30 22 * * *")).toBe("Daily at 10:30 PM UTC");
  });

  it("renders stepped hours as every-N-hours, never NaN", () => {
    expect(cronToEnglish("0 */6 * * *")).toBe("Every 6 hours at :00");
    expect(cronToEnglish("0 */1 * * *")).toBe("Every 1 hour at :00");
    expect(cronToEnglish("30 */2 * * *")).toBe("Every 2 hours at :30");
    expect(cronToEnglish("0 */6 * * *")).not.toContain("NaN");
  });

  it("renders a plain hourly cron as before", () => {
    expect(cronToEnglish("5 * * * *")).toBe("Every hour at :05");
  });

  it("falls back to the raw cron for stepped minutes", () => {
    expect(cronToEnglish("*/15 * * * *")).toBe("*/15 * * * *");
    expect(cronToEnglish("*/15 3 * * *")).toBe("*/15 3 * * *");
  });

  it("renders a plain weekly cron as before", () => {
    expect(cronToEnglish("15 22 * * 1-5")).toBe("Weekdays at 10:15 PM UTC");
  });
});
