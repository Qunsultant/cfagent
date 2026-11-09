// @vitest-environment node
/**
 * Issue #3788 (parent incident #3781) — schedule watchdog, pure core.
 *
 * A schedule/goal/task that misses its firing must be detectable: the
 * watchdog computes each enabled goal's most recent expected cron tick
 * and flags it when no run exists at or after that tick (grace applied),
 * with exactly-once semantics carried by the ledger record itself. The
 * same core covers durable schedules (cron / interval / one-time) and
 * classifies the copilot Think task's silent paths.
 *
 * TDD Red: the modules under test do not exist yet.
 */
import { describe, expect, it } from "vitest";

import { resolveMissedScheduleGraceMs } from "../src/config/missedScheduleAlert";
import { isValidCron, previousCronTickMs } from "../src/schedule";
import {
  classifyCopilotNonDeclaration,
  copilotCycleErrorCode,
  copilotCycleLedgerOutcome,
  findMissedDurableSchedule,
  findMissedGoalFiring,
  missedFiringDetail,
  type DurableScheduleShape,
  type GoalWatchdogInput,
} from "../src/services/scheduleWatchdog";

/** Monday 2026-11-09 02:35 UTC — after the 01:30 rollup tick, before 06:00. */
const NOW = Date.parse("2026-11-09T02:35:00.000Z");
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function goal(overrides: Partial<GoalWatchdogInput["goal"]> = {}): GoalWatchdogInput["goal"] {
  return {
    id: "daily-qa-sweep",
    cron: "0 6 * * *",
    enabled: true,
    ...overrides,
  };
}

describe("previousCronTickMs (#3788)", () => {
  it("finds the previous daily tick (no timeZone, UTC read)", () => {
    expect(previousCronTickMs("0 6 * * *", NOW)).toBe(
      Date.parse("2026-11-08T06:00:00.000Z"),
    );
  });

  it("finds the previous hourly tick for a UTC goal", () => {
    expect(previousCronTickMs("0 * * * *", NOW, "UTC")).toBe(
      Date.parse("2026-11-09T02:00:00.000Z"),
    );
  });

  it("finds the previous rollup tick (30 1 * * *, UTC)", () => {
    expect(previousCronTickMs("30 1 * * *", NOW, "UTC")).toBe(
      Date.parse("2026-11-09T01:30:00.000Z"),
    );
  });

  it("finds the previous weekly tick (Sunday 04:00 UTC)", () => {
    // 2026-11-08 is a Sunday.
    expect(previousCronTickMs("0 4 * * 0", NOW, "UTC")).toBe(
      Date.parse("2026-11-08T04:00:00.000Z"),
    );
  });

  it("returns undefined for the never-due no-timeZone quirk cron", () => {
    // schedule.ts preserves this deliberately: "0 */6 * * *" maps the
    // hour through Number() to NaN and is NEVER due without a timeZone.
    // The watchdog mirrors the firing predicate, so it never flags it.
    expect(previousCronTickMs("0 */6 * * *", NOW)).toBeUndefined();
    expect(isValidCron("0 */6 * * *")).toBe(true);
  });

  it("matches the same cron with a timeZone (step hours are real there)", () => {
    expect(previousCronTickMs("0 */6 * * *", NOW, "UTC")).toBe(
      Date.parse("2026-11-09T00:00:00.000Z"),
    );
  });

  it("returns undefined for an unparseable cron", () => {
    expect(previousCronTickMs("not-a-cron", NOW)).toBeUndefined();
    expect(previousCronTickMs("0 6 * * * *", NOW)).toBeUndefined();
  });

  it("reads wall-clock in a non-UTC zone (America/New_York, EST)", () => {
    // Monday 09:00 ET = 14:00 UTC, after NOW — so the previous weekday
    // 09:00 tick is Friday 2026-11-06 09:00 EST (14:00 UTC).
    expect(previousCronTickMs("0 9 * * 1-5", NOW, "America/New_York")).toBe(
      Date.parse("2026-11-06T14:00:00.000Z"),
    );
  });

  it("returns undefined when the only tick is beyond the scan window", () => {
    // Monthly "0 0 1 * *": the Nov 1 tick is 8d 2h35m before NOW, past
    // the 8-day scan window — a goal with no tick in the window never
    // alerts (it may simply not have had its first tick yet).
    expect(previousCronTickMs("0 0 1 * *", NOW, "UTC")).toBeUndefined();
  });
});

describe("resolveMissedScheduleGraceMs (#3788)", () => {
  it("defaults to 60 minutes", () => {
    expect(resolveMissedScheduleGraceMs({})).toBe(60 * MIN);
  });

  it("honours a named env value; blank/unparseable falls back to default", () => {
    expect(resolveMissedScheduleGraceMs({ MISSED_SCHEDULE_GRACE_MINUTES: "15" })).toBe(15 * MIN);
    expect(resolveMissedScheduleGraceMs({ MISSED_SCHEDULE_GRACE_MINUTES: "" })).toBe(60 * MIN);
    expect(resolveMissedScheduleGraceMs({ MISSED_SCHEDULE_GRACE_MINUTES: "nope" })).toBe(60 * MIN);
  });

  it("0 disables the watchdog", () => {
    expect(resolveMissedScheduleGraceMs({ MISSED_SCHEDULE_GRACE_MINUTES: "0" })).toBe(0);
    expect(resolveMissedScheduleGraceMs({ MISSED_SCHEDULE_GRACE_MINUTES: "-5" })).toBe(0);
  });
});

describe("findMissedGoalFiring (#3788)", () => {
  const grace = 60 * MIN;

  it("flags a never-fired goal past its expected tick + grace", () => {
    const finding = findMissedGoalFiring({
      goal: goal(),
      runs: [],
      firstSeenAtMs: NOW - 2 * 24 * HOUR,
      nowMs: NOW,
      graceMs: grace,
    });
    expect(finding?.code).toBe("missed_fire");
    expect(finding?.expectedTickMs).toBe(Date.parse("2026-11-08T06:00:00.000Z"));
    expect(finding?.lastRunIso).toBeNull();
  });

  it("flags a #1819 resource goal the same way (resource-daily-rollup)", () => {
    const finding = findMissedGoalFiring({
      goal: goal({
        id: "resource-daily-rollup",
        cron: "30 1 * * *",
        timeZone: "UTC",
        operation: "resource.rollup_daily",
      }),
      runs: [],
      firstSeenAtMs: NOW - 2 * 24 * HOUR,
      nowMs: NOW,
      graceMs: grace,
    });
    expect(finding?.code).toBe("missed_fire");
    expect(finding?.expectedTickMs).toBe(Date.parse("2026-11-09T01:30:00.000Z"));
  });

  it("does not flag when a run exists at or after the expected tick", () => {
    expect(
      findMissedGoalFiring({
        goal: goal(),
        runs: [{ started: "2026-11-08T06:05:00.000Z" }],
        firstSeenAtMs: NOW - 2 * 24 * HOUR,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("does not flag when lastRun covers the expected tick (record pruned)", () => {
    expect(
      findMissedGoalFiring({
        goal: goal({ lastRun: "2026-11-08T06:00:00.000Z" }),
        runs: [],
        firstSeenAtMs: NOW - 2 * 24 * HOUR,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("does not flag a run older than the expected tick", () => {
    expect(
      findMissedGoalFiring({
        goal: goal(),
        runs: [{ started: "2026-11-07T06:00:00.000Z" }],
        firstSeenAtMs: NOW - 2 * 24 * HOUR,
        nowMs: NOW,
        graceMs: grace,
      })?.code,
    ).toBe("missed_fire");
  });

  it("does not flag inside the grace window", () => {
    // Expected tick 01:30, now 02:35 — 65 min later; a 2h grace covers it.
    expect(
      findMissedGoalFiring({
        goal: goal({ id: "resource-daily-rollup", cron: "30 1 * * *", timeZone: "UTC" }),
        runs: [],
        firstSeenAtMs: NOW - 2 * 24 * HOUR,
        nowMs: NOW,
        graceMs: 2 * HOUR,
      }),
    ).toBeNull();
  });

  it("never flags a disabled goal", () => {
    expect(
      findMissedGoalFiring({
        goal: goal({ enabled: false }),
        runs: [],
        firstSeenAtMs: NOW - 2 * 24 * HOUR,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("never flags a just-created goal (first seen after the expected tick)", () => {
    expect(
      findMissedGoalFiring({
        goal: goal(),
        runs: [],
        firstSeenAtMs: NOW - 30 * MIN,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("never flags when the watchdog is disabled (grace 0)", () => {
    expect(
      findMissedGoalFiring({
        goal: goal(),
        runs: [],
        firstSeenAtMs: NOW - 2 * 24 * HOUR,
        nowMs: NOW,
        graceMs: 0,
      }),
    ).toBeNull();
  });

  it("never flags a goal whose cron has no tick in the window", () => {
    expect(
      findMissedGoalFiring({
        goal: goal({ cron: "0 0 1 * *", timeZone: "UTC" }),
        runs: [],
        firstSeenAtMs: NOW - 2 * 24 * HOUR,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("flags an enabled goal with an unparseable cron (it can never fire)", () => {
    const finding = findMissedGoalFiring({
      goal: goal({ cron: "not-a-cron" }),
      runs: [],
      firstSeenAtMs: NOW,
      nowMs: NOW,
      graceMs: grace,
    });
    expect(finding?.code).toBe("invalid_cron");
    expect(finding?.expectedTickMs).toBeUndefined();
  });

  it("fails closed with no first-seen stamp (unattributable observation)", () => {
    // A first-seen storage failure must not alert on the deploy tick:
    // without a stamp the miss cannot be attributed to a schedule
    // that existed when the tick passed.
    expect(
      findMissedGoalFiring({
        goal: goal({ cron: "0 6 * * *" }),
        runs: [],
        firstSeenAtMs: undefined,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("missedFireDetail names the tick and the last run (or never)", () => {
    expect(
      missedFiringDetail("daily-qa-sweep", {
        code: "missed_fire",
        expectedTickMs: Date.parse("2026-11-08T06:00:00.000Z"),
        expectedTickIso: "2026-11-08T06:00:00.000Z",
        lastRunIso: null,
      }),
    ).toBe("missed-fire: expected 2026-11-08T06:00:00.000Z (last run: never)");
    expect(
      missedFiringDetail("daily-qa-sweep", { code: "invalid_cron" }, "not-a-cron"),
    ).toBe("invalid-cron: not-a-cron never matches; goal cannot fire");
  });
});

describe("findMissedDurableSchedule (#3788)", () => {
  const grace = 60 * MIN;
  const firstSeen = NOW - 2 * 24 * HOUR;

  function schedule(overrides: Partial<DurableScheduleShape>): DurableScheduleShape {
    return { id: "sched-1", callback: "autonomousMarketScreen", ...overrides };
  }

  it("flags a cron schedule with no run since its expected tick", () => {
    const finding = findMissedDurableSchedule({
      schedule: schedule({ type: "cron", cron: "0 6 * * *" }),
      latestRun: undefined,
      firstSeenAtMs: firstSeen,
      nowMs: NOW,
      graceMs: grace,
    });
    expect(finding?.code).toBe("missed_fire");
    expect(finding?.expectedTickMs).toBe(Date.parse("2026-11-08T06:00:00.000Z"));
  });

  it("flags an interval schedule whose last run predates time - interval", () => {
    // Next execution 01:30, every 15 min → previous firing 01:15,
    // 80 minutes before the 02:35 now — past the 60-minute grace.
    const nextTimeSec = Date.parse("2026-11-09T01:30:00.000Z") / 1000;
    const finding = findMissedDurableSchedule({
      schedule: schedule({ type: "interval", time: nextTimeSec, intervalSeconds: 900 }),
      latestRun: { started: "2026-11-09T01:00:00.000Z" },
      firstSeenAtMs: firstSeen,
      nowMs: NOW,
      graceMs: grace,
    });
    expect(finding?.code).toBe("missed_fire");
    expect(finding?.expectedTickMs).toBe(Date.parse("2026-11-09T01:15:00.000Z"));
  });

  it("does not flag an interval schedule whose run covers the expected tick", () => {
    const nextTimeSec = Date.parse("2026-11-09T02:00:00.000Z") / 1000;
    expect(
      findMissedDurableSchedule({
        schedule: schedule({ type: "interval", time: nextTimeSec, intervalSeconds: 900 }),
        latestRun: { started: "2026-11-09T01:50:00.000Z" },
        firstSeenAtMs: firstSeen,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("flags a one-time schedule past its time + grace with no run", () => {
    const timeSec = Date.parse("2026-11-09T01:00:00.000Z") / 1000;
    expect(
      findMissedDurableSchedule({
        schedule: schedule({ type: "scheduled", time: timeSec }),
        latestRun: undefined,
        firstSeenAtMs: firstSeen,
        nowMs: NOW,
        graceMs: grace,
      })?.code,
    ).toBe("missed_fire");
  });

  it("does not flag a one-time schedule that already ran", () => {
    const timeSec = Date.parse("2026-11-09T01:00:00.000Z") / 1000;
    expect(
      findMissedDurableSchedule({
        schedule: schedule({ type: "scheduled", time: timeSec }),
        latestRun: { started: "2026-11-09T01:00:05.000Z" },
        firstSeenAtMs: firstSeen,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("never flags a schedule with no timing (unknown type)", () => {
    expect(
      findMissedDurableSchedule({
        schedule: schedule({}),
        latestRun: undefined,
        firstSeenAtMs: firstSeen,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("never flags a just-created schedule", () => {
    expect(
      findMissedDurableSchedule({
        schedule: schedule({ type: "cron", cron: "0 6 * * *" }),
        latestRun: undefined,
        firstSeenAtMs: NOW - 30 * MIN,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });

  it("fails closed with no first-seen stamp (unattributable observation)", () => {
    expect(
      findMissedDurableSchedule({
        schedule: schedule({ type: "cron", cron: "0 6 * * *" }),
        latestRun: undefined,
        firstSeenAtMs: undefined,
        nowMs: NOW,
        graceMs: grace,
      }),
    ).toBeNull();
  });
});

describe("copilot Think task signals (#3788)", () => {
  it("classifies each non-declaration cause", () => {
    expect(
      classifyCopilotNonDeclaration({ flagEnabled: false, contextError: false, hasLogin: true }),
    ).toBe("flag_off");
    expect(
      classifyCopilotNonDeclaration({ flagEnabled: true, contextError: true, hasLogin: false }),
    ).toBe("context_error");
    expect(
      classifyCopilotNonDeclaration({ flagEnabled: true, contextError: false, hasLogin: false }),
    ).toBe("no_login_context");
    expect(
      classifyCopilotNonDeclaration({ flagEnabled: true, contextError: false, hasLogin: true }),
    ).toBeNull();
  });

  it("maps cycle statuses to ledger outcomes (never a fourth outcome)", () => {
    expect(copilotCycleLedgerOutcome("ok")).toEqual({
      outcome: "success",
      descriptor: "cycle complete",
    });
    expect(copilotCycleLedgerOutcome("paused")).toEqual({
      outcome: "skipped",
      detail: "cycle paused",
    });
    expect(copilotCycleLedgerOutcome("outside_enabled_sessions")).toEqual({
      outcome: "skipped",
      detail: "cycle outside_enabled_sessions",
    });
    expect(copilotCycleLedgerOutcome("disabled")).toEqual({
      outcome: "skipped",
      detail: "cycle disabled",
    });
    expect(copilotCycleLedgerOutcome("mode_unresolved", "MODE_UNRESOLVED")).toEqual({
      outcome: "skipped",
      detail: "cycle refused: mode_unresolved (MODE_UNRESOLVED)",
    });
    expect(copilotCycleLedgerOutcome("refused_mode_mismatch", "MODE_MISMATCH")).toEqual({
      outcome: "skipped",
      detail: "cycle refused: refused_mode_mismatch (MODE_MISMATCH)",
    });
    expect(copilotCycleLedgerOutcome("inactive_broker")).toEqual({
      outcome: "skipped",
      detail: "cycle refused: inactive_broker",
    });
  });

  it("derives an error code from a thrown error, defaulting to cycle_failed", () => {
    const coded = new Error("boom") as Error & { code: string };
    coded.code = "ALPACA_TIMEOUT";
    expect(copilotCycleErrorCode(coded)).toBe("ALPACA_TIMEOUT");
    expect(copilotCycleErrorCode(new Error("boom"))).toBe("cycle_failed");
    expect(copilotCycleErrorCode("string failure")).toBe("cycle_failed");
  });
});
