/**
 * Issue #4331 (parent #4329 S2) — one schedule list's filter vocabulary.
 *
 * Pins:
 *  - 4331-P01 the owner's ten filters are the default set, in the owner's
 *    order, with "all" leading.
 *  - 4331-P02 the set and the default are configuration: an env list overrides,
 *    unknown ids drop, duplicates collapse, a blank value falls back, and a
 *    default outside the set is unreachable so it resolves to "all".
 *  - 4331-P03 the classifier maps a recorded callback to exactly one kind:
 *    queued (a delayed job) wins over everything, options before trading,
 *    strategy before trading, stocks by callback or universe, system for the
 *    platform's own upkeep, and an unmatched callback is "other".
 *  - 4331-P04 counts are per kind, for the filter buttons.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCHEDULE_LIST_FILTERS,
  resolveScheduleListDefaultFilter,
  resolveScheduleListFilters,
} from "../src/config/scheduleListModes";
import { classifyScheduleKind, countSchedulesByKind } from "../src/services/scheduleKinds";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(here, "..", "src/client/SchedulesPanel.tsx"), "utf8");
const manager = readFileSync(
  join(here, "..", "src/client/ScheduledOptionsManager.tsx"),
  "utf8",
);

describe("4331-P01 the owner's filters", () => {
  it("defaults to All, Stocks, Options, Strategy, Goal, Payment, Trading, System, Queued, Other", () => {
    expect([...DEFAULT_SCHEDULE_LIST_FILTERS]).toEqual([
      "all",
      "stocks",
      "options",
      "strategy",
      "goal",
      "payment",
      "trading",
      "system",
      "queued",
      "other",
    ]);
    expect(resolveScheduleListFilters()).toEqual([...DEFAULT_SCHEDULE_LIST_FILTERS]);
  });
});

describe("4331-P02 configured, not hardcoded", () => {
  it("honours the env set, drops unknowns, and always leads with all", () => {
    expect(resolveScheduleListFilters({ SCHEDULE_LIST_FILTERS: "options,bogus,goal" })).toEqual([
      "all",
      "options",
      "goal",
    ]);
    expect(resolveScheduleListFilters({ SCHEDULE_LIST_FILTERS: " , " })).toEqual([
      ...DEFAULT_SCHEDULE_LIST_FILTERS,
    ]);
  });

  it("falls a default outside the set back to all", () => {
    const filters = resolveScheduleListFilters({ SCHEDULE_LIST_FILTERS: "options" });
    expect(filters).toEqual(["all", "options"]);
    expect(resolveScheduleListDefaultFilter({ SCHEDULE_LIST_DEFAULT_FILTER: "goal" }, filters)).toBe(
      "all",
    );
    expect(resolveScheduleListDefaultFilter({ SCHEDULE_LIST_DEFAULT_FILTER: "options" }, filters)).toBe(
      "options",
    );
  });
});

describe("4331-P03 one kind per schedule", () => {
  it("classifies the recorded callbacks", () => {
    expect(classifyScheduleKind({ callback: "autonomousMarketScreen" })).toBe("stocks");
    expect(classifyScheduleKind({ callback: "autonomousOptionsAnalysis" })).toBe("options");
    expect(classifyScheduleKind({ callback: "autonomousStrategyDiscovery" })).toBe("strategy");
    expect(classifyScheduleKind({ callback: "sendScheduledReminder" })).toBe("system");
    expect(classifyScheduleKind({ callback: "pushTicks" })).toBe("system");
    expect(classifyScheduleKind({ callback: "goalTick" })).toBe("goal");
    expect(classifyScheduleKind({ callback: "paymentRetry" })).toBe("payment");
    expect(classifyScheduleKind({ callback: "brokerOrderSync" })).toBe("trading");
  });

  it("a universe payload marks a stock schedule", () => {
    expect(classifyScheduleKind({ callback: "custom", payload: { universe: "sp500" } })).toBe(
      "stocks",
    );
  });

  it("a delayed job is queued whatever its callback would say", () => {
    expect(classifyScheduleKind({ callback: "autonomousOptionsAnalysis", type: "delayed" })).toBe(
      "queued",
    );
  });

  it("never guesses: an unmatched callback is other", () => {
    expect(classifyScheduleKind({ callback: "mysteryJob" })).toBe("other");
    expect(classifyScheduleKind({})).toBe("other");
  });
});

describe("4331-P04 counts per kind", () => {
  it("counts every configured kind", () => {
    const counts = countSchedulesByKind([
      { callback: "autonomousMarketScreen" },
      { callback: "autonomousOptionsAnalysis" },
      { callback: "autonomousOptionsAnalysis", type: "delayed" },
      { callback: "mysteryJob" },
    ]);
    expect(counts.stocks).toBe(1);
    expect(counts.options).toBe(1);
    expect(counts.queued).toBe(1);
    expect(counts.other).toBe(1);
    expect(counts.trading).toBe(0);
  });
});

describe("4331-P05 one list on the page", () => {
  it("the panel lists every schedule — no screening-only exclusion", () => {
    // (#4329 S2) The old split rendered screening callbacks in the options
    // manager and everything else in a second table.
    expect(panel).not.toContain("SCREENING_CALLBACKS.has(s.callback)");
    expect(panel).toContain("const allSchedules = schedules;");
    expect(panel).not.toContain("Other Durable Schedules");
    expect(panel).toContain("Every durable schedule, one row each");
  });

  it("the options manager keeps its form but not its own list", () => {
    expect(panel).toContain("showSchedulesSection={false}");
    expect(manager).toContain("{showSchedulesSection && (");
  });

  it("the filter bar is the configured set, in order", () => {
    expect(panel).toContain("resolveScheduleListFilters()");
    expect(panel).toContain("SCHEDULE_LIST_FILTER_LABELS[id]");
  });
});
