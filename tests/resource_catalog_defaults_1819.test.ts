/**
 * Issue #1819 — catalog + defaults membership, REAL modules, no mocks.
 *
 * Kept separate from resource_goals_scheduled_1819.test.ts because that
 * file mocks ../src/orchestrate for the ScheduledAgent harness; a mocked
 * import here would make this membership test pass vacuously.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_SCHEDULES } from "../src/schedule";
import { OPERATION_CATALOG } from "../src/orchestrate";

describe("catalog and defaults (real modules, no mocks)", () => {
  it("OPERATION_CATALOG carries the three resource operations", () => {
    const entry = OPERATION_CATALOG.find((e) => e.agent === "resource");
    expect(entry).toBeDefined();
    expect(entry!.operations).toEqual([
      "resource.rollup_daily",
      "resource.cap_alert",
      "resource.dashboard_comparison",
    ]);
  });

  it("DEFAULT_SCHEDULES carries the three resource goals with UTC cadences", () => {
    const byId = new Map(DEFAULT_SCHEDULES.map((g) => [g.id, g]));
    expect(byId.get("resource-daily-rollup")).toMatchObject({
      cron: "30 1 * * *",
      timeZone: "UTC",
      operation: "resource.rollup_daily",
      enabled: true,
    });
    expect(byId.get("resource-cap-alert")).toMatchObject({
      // Issue #4253 — daily-defaults directive: was hourly.
      cron: "0 0 * * *",
      timeZone: "UTC",
      operation: "resource.cap_alert",
      enabled: true,
    });
    expect(byId.get("resource-dashboard-comparison")).toMatchObject({
      cron: "0 2 * * *",
      timeZone: "UTC",
      operation: "resource.dashboard_comparison",
      enabled: true,
    });
  });
});
