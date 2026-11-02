/**
 * Issue #1980 — catalog + defaults membership, REAL modules, no
 * mocks (the resource_catalog_defaults_1819.test.ts pattern: a
 * mocked import here would make membership pass vacuously).
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_SCHEDULES } from "../src/schedule";
import { OPERATION_CATALOG } from "../src/orchestrate";

describe("catalog and defaults (real modules, no mocks)", () => {
  it("OPERATION_CATALOG carries the two index refresh operations", () => {
    const entry = OPERATION_CATALOG.find((e) => e.agent === "index");
    expect(entry).toBeDefined();
    expect(entry!.operations).toEqual(["index.refresh_wikipedia", "index.refresh_holdings"]);
  });

  it("DEFAULT_SCHEDULES carries the two index refresh goals with UTC cadences", () => {
    const byId = new Map(DEFAULT_SCHEDULES.map((g) => [g.id, g]));
    expect(byId.get("index-refresh-wikipedia")).toMatchObject({
      cron: "0 4 * * 0",
      timeZone: "UTC",
      operation: "index.refresh_wikipedia",
      enabled: true,
    });
    // Holdings ships DISABLED: no holdings fetcher binding exists
    // in code yet (see src/schedule.ts); forced triggerGoal still
    // exercises it, and the operator enables it once bound.
    expect(byId.get("index-refresh-holdings")).toMatchObject({
      cron: "0 3 * * *",
      timeZone: "UTC",
      operation: "index.refresh_holdings",
      enabled: false,
    });
  });
});
