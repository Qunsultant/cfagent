/**
 * Issue #4235 — full scheduling flexibility, granularity first.
 *
 * Red pins (TDD): the default is at most once per day; finer
 * granularity is available only by explicit per-schedule opt-in,
 * recorded on the schedule. isDue honors all five cron fields (the
 * no-timeZone branch no longer ignores day fields), any valid
 * 5-field cron is accepted, and the UX offers bi-weekly / monthly /
 * semi-annual / annual presets with no cap on free input.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/orchestrate", () => ({
  OPERATION_CATALOG: [
    { agent: "search", binding: "ORCHESTRATOR_AGENT", operations: ["search.query"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import {
  isDue,
  isValidCron,
  cronRunsPerDay,
  isSubDailyCron,
  isSubDailyInterval,
  DEFAULT_SCHEDULES,
} from "../src/schedule";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { MockD1Database } from "./mock-d1";
import { resolveScheduleUpdate } from "../src/services/unifiedScheduleManagement";
import {
  CRON_PRESETS,
  INTERVAL_PRESETS,
  cadenceNeedsOptIn,
} from "../src/client/scheduledOptionsManager/format";
import { etToUtcCron } from "../src/client/options/cronTime";
import { buildScheduleSubmission } from "../src/client/scheduledOptionsManager/payloadBuilders";

function makeAgent() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
  };
  const env = {
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB); the agent never reads the "goals" KV key.
    AGENT_DB: new MockD1Database(),
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
  } as any;
  return new (ScheduledAgent as any)(ctx, env);
}

describe("cronRunsPerDay / isSubDailyCron / isSubDailyInterval (#4235)", () => {
  it("counts (minute, hour) pairs per day", () => {
    expect(cronRunsPerDay("0 6 * * *")).toBe(1);
    expect(cronRunsPerDay("0 */6 * * *")).toBe(4);
    expect(cronRunsPerDay("0 * * * *")).toBe(24);
    expect(cronRunsPerDay("0 6,18 * * *")).toBe(2);
    expect(cronRunsPerDay("*/30 * * * *")).toBe(48);
    // Day fields restrict which days fire, never the per-day count.
    expect(cronRunsPerDay("0 9 1 * *")).toBe(1);
    expect(cronRunsPerDay("0 9 * 1,7 *")).toBe(1);
    expect(cronRunsPerDay("0 6,18 1 * *")).toBe(2);
  });

  it("returns undefined for an invalid cron", () => {
    expect(cronRunsPerDay("not-a-cron")).toBeUndefined();
    expect(cronRunsPerDay("99 99 * * *")).toBeUndefined();
    expect(cronRunsPerDay("0 6 * *")).toBeUndefined();
  });

  it("isSubDailyCron is true exactly when a cron can fire more than once a day", () => {
    expect(isSubDailyCron("0 6 * * *")).toBe(false);
    expect(isSubDailyCron("0 9 1 * *")).toBe(false);
    expect(isSubDailyCron("0 9 1 1 *")).toBe(false);
    expect(isSubDailyCron("0 */6 * * *")).toBe(true);
    expect(isSubDailyCron("0 * * * *")).toBe(true);
    expect(isSubDailyCron("not-a-cron")).toBe(false);
  });

  it("isSubDailyInterval is true exactly for intervals under one day", () => {
    expect(isSubDailyInterval(3600)).toBe(true);
    expect(isSubDailyInterval(86399)).toBe(true);
    expect(isSubDailyInterval(86400)).toBe(false);
    expect(isSubDailyInterval(1209600)).toBe(false);
    expect(isSubDailyInterval(0)).toBe(false);
    expect(isSubDailyInterval(-5)).toBe(false);
  });
});

describe("DEFAULT_SCHEDULES are daily or less (#4235 owner direction 2026-11-12)", () => {
  it("no built-in default runs more than once per day", () => {
    for (const goal of DEFAULT_SCHEDULES) {
      expect(isValidCron(goal.cron)).toBe(true);
      expect(cronRunsPerDay(goal.cron)).toBeLessThanOrEqual(1);
    }
  });

  it("the formerly sub-daily defaults are now daily at their landed #4253 values", () => {
    // Corrected from the WIP draft's proposed hours: #4253 LANDED
    // opportunity-hunt daily at 07:00 and resource-cap-alert daily
    // at 00:00 UTC, and #4306 S2 REMOVED feed-refresh from the
    // built-ins entirely (pinned by tests/feed_refresh_goal_3787.test.ts).
    // The requirement is daily-or-less, which the landed values meet;
    // this pin records the landed values, it does not re-decide them.
    const byId = new Map(DEFAULT_SCHEDULES.map((g) => [g.id, g]));
    expect(byId.get("opportunity-hunt")?.cron).toBe("0 7 * * *");
    expect(byId.get("resource-cap-alert")?.cron).toBe("0 0 * * *");
    expect(byId.get("feed-refresh")).toBeUndefined();
  });
});

describe("isDue honors all five cron fields without a timeZone (#4235)", () => {
  it("a monthly cron fires on the 1st, not on the 15th", () => {
    expect(isDue("0 9 1 * *", undefined, new Date("2026-10-01T09:00:00Z"))).toBe(true);
    expect(isDue("0 9 1 * *", undefined, new Date("2026-10-15T09:00:00Z"))).toBe(false);
    expect(isDue("0 9 1 * *", undefined, new Date("2026-11-01T09:00:00Z"))).toBe(true);
  });

  it("month and day-of-week fields gate firing", () => {
    expect(isDue("0 9 * 10 *", undefined, new Date("2026-10-26T09:00:00Z"))).toBe(true);
    expect(isDue("0 9 * 11 *", undefined, new Date("2026-10-26T09:00:00Z"))).toBe(false);
    // 2026-10-26 is a Monday.
    expect(isDue("0 9 * * 1", undefined, new Date("2026-10-26T09:00:00Z"))).toBe(true);
    expect(isDue("0 9 * * 2", undefined, new Date("2026-10-26T09:00:00Z"))).toBe(false);
  });

  it("steps in the hour field fire on the step hours (the old never-fires quirk is gone)", () => {
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T06:00:00Z"))).toBe(true);
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T12:00:00Z"))).toBe(true);
    expect(isDue("0 */6 * * *", undefined, new Date("2026-10-26T07:00:00Z"))).toBe(false);
  });

  it("the default 23h guard still caps a sub-daily cron at once per day", () => {
    const now = new Date("2026-10-26T06:00:00Z");
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(isDue("0 * * * *", oneHourAgo, now)).toBe(false);
    expect(isDue("0 * * * *", undefined, now)).toBe(true);
  });

  it("an opted-in sub-daily cron fires on the next hour tick, but not twice in one hour", () => {
    const opts = { subDailyOptIn: true };
    // 06:00 tick, last fired 05:00: a new hourly tick has occurred.
    expect(
      isDue("0 * * * *", new Date("2026-10-26T05:00:00Z").toISOString(), new Date("2026-10-26T06:00:00Z"), undefined, opts),
    ).toBe(true);
    // 06:30 tick, last fired 06:05 (late-tick firing): same hourly tick, no refire.
    expect(
      isDue("0 * * * *", new Date("2026-10-26T06:05:00Z").toISOString(), new Date("2026-10-26T06:30:00Z"), undefined, opts),
    ).toBe(false);
    // 07:00 tick, last fired 06:05: the next hourly tick has occurred.
    expect(
      isDue("0 * * * *", new Date("2026-10-26T06:05:00Z").toISOString(), new Date("2026-10-26T07:00:00Z"), undefined, opts),
    ).toBe(true);
  });
});

describe("addGoal enforces the default daily cap with a recorded opt-in (#4235)", () => {
  it("rejects a sub-daily cron without the opt-in, naming it", async () => {
    const agent = makeAgent();
    await expect(
      agent.addGoal({ id: "hourly-x", name: "Hourly X", cron: "0 * * * *", operation: "search.query", budgetCents: 100 }),
    ).rejects.toThrow(/opt-in/i);
  });

  it("accepts a sub-daily cron with the opt-in and records it on the schedule", async () => {
    const agent = makeAgent();
    const goal = await agent.addGoal({
      id: "hourly-x", name: "Hourly X", cron: "0 * * * *",
      operation: "search.query", budgetCents: 100, subDailyOptIn: true,
    });
    expect(goal.subDailyOptIn).toBe(true);
    const stored = (await agent.listGoals()).find((g: any) => g.id === "hourly-x");
    expect(stored?.subDailyOptIn).toBe(true);
  });

  it("accepts monthly, semi-annual and annual crons without any opt-in", async () => {
    const agent = makeAgent();
    for (const [id, cron] of [
      ["monthly-x", "0 9 1 * *"],
      ["semiannual-x", "0 9 1 1,7 *"],
      ["annual-x", "0 9 1 1 *"],
    ] as const) {
      const goal = await agent.addGoal({ id, name: id, cron, operation: "search.query", budgetCents: 100 });
      expect(goal.cron).toBe(cron);
      expect(goal.subDailyOptIn).toBeUndefined();
    }
  });

  it("the invalid-cron error names the 5-field grammar, not 'minute hour * * *'", async () => {
    const agent = makeAgent();
    await expect(
      agent.addGoal({ id: "bad-x", name: "Bad X", cron: "not-a-cron", operation: "search.query", budgetCents: 100 }),
    ).rejects.toThrow(/5-field/i);
    await expect(
      agent.addGoal({ id: "bad-x", name: "Bad X", cron: "not-a-cron", operation: "search.query", budgetCents: 100 }),
    ).rejects.not.toThrow(/minute hour/);
  });
});

describe("resolveScheduleUpdate enforces the default daily cap (#4235)", () => {
  const current: any = { type: "cron", callback: "autonomousMarketScreen", cron: "0 6 * * *", payload: {} };
  const nowMs = new Date("2026-11-12T12:00:00Z").getTime();

  it("rejects a new sub-daily cron without the opt-in", () => {
    const res = resolveScheduleUpdate(current, { cron: "0 * * * *" } as any, nowMs);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/opt-in/i);
  });

  it("accepts a new sub-daily cron with the opt-in and carries it in the resolution", () => {
    const res = resolveScheduleUpdate(current, { cron: "0 * * * *", subDailyOptIn: true } as any, nowMs);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.timing).toEqual({ type: "cron", cron: "0 * * * *" });
      expect((res as any).subDailyOptIn).toBe(true);
    }
  });

  it("accepts a monthly cron without any opt-in", () => {
    const res = resolveScheduleUpdate(current, { cron: "0 9 1 * *" } as any, nowMs);
    expect(res.ok).toBe(true);
  });

  it("rejects a sub-daily interval without the opt-in, accepts it with one", () => {
    const denied = resolveScheduleUpdate(current, { intervalSeconds: 3600 } as any, nowMs);
    expect(denied.ok).toBe(false);
    const allowed = resolveScheduleUpdate(current, { intervalSeconds: 3600, subDailyOptIn: true } as any, nowMs);
    expect(allowed.ok).toBe(true);
  });

  it("rejects an out-of-range cron instead of arming a never-firing schedule", () => {
    const res = resolveScheduleUpdate(current, { cron: "99 99 * * *" } as any, nowMs);
    expect(res.ok).toBe(false);
  });

  it("a payload-only update keeps a stored sub-daily timing under its stored opt-in", () => {
    const subDailyCurrent: any = {
      type: "interval", callback: "autonomousMarketScreen",
      intervalSeconds: 300, subDailyOptIn: true, payload: {},
    };
    const res = resolveScheduleUpdate(subDailyCurrent, { payload: {} } as any, nowMs);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.timing).toEqual({ type: "interval", intervalSeconds: 300 });
  });
});

describe("UX presets: long cadences offered, sub-daily flagged for opt-in (#4235)", () => {
  it("CRON_PRESETS offer monthly, semi-annual and annual", () => {
    const labels = CRON_PRESETS.map((p) => p.label);
    expect(labels.some((l) => /monthly/i.test(l))).toBe(true);
    expect(labels.some((l) => /semi-annual/i.test(l))).toBe(true);
    expect(labels.some((l) => /annual/i.test(l))).toBe(true);
  });

  it("INTERVAL_PRESETS offer bi-weekly plus daily-or-less intervals", () => {
    const byLabel = new Map(INTERVAL_PRESETS.map((p) => [p.label, p.seconds]));
    expect(byLabel.get("Every 2 weeks")).toBe(1209600);
    expect(byLabel.get("Every 12 hours")).toBe(43200);
    expect(byLabel.get("Every 24 hours")).toBe(86400);
  });

  it("the long cron presets convert to valid daily-or-less UTC crons", () => {
    const EDT_REF = new Date("2026-07-15T16:00:00.000Z");
    for (const preset of CRON_PRESETS) {
      const cron = etToUtcCron(
        {
          hour: preset.etHour,
          minute: preset.etMinute,
          ...(preset.daysOfWeek !== undefined ? { daysOfWeek: preset.daysOfWeek } : {}),
          ...(preset.dayOfMonth !== undefined ? { dayOfMonth: preset.dayOfMonth } : {}),
          ...(preset.month !== undefined ? { month: preset.month } : {}),
        },
        EDT_REF,
      );
      expect(isValidCron(cron)).toBe(true);
      expect(isSubDailyCron(cron)).toBe(false);
    }
  });

  it("cadenceNeedsOptIn flags exactly the sub-daily cadences", () => {
    expect(cadenceNeedsOptIn("interval", 3600)).toBe(true);
    expect(cadenceNeedsOptIn("interval", 86400)).toBe(false);
    expect(cadenceNeedsOptIn("interval", 1209600)).toBe(false);
    expect(cadenceNeedsOptIn("cron", "0 * * * *")).toBe(true);
    expect(cadenceNeedsOptIn("cron", "0 9 1 * *")).toBe(false);
    expect(cadenceNeedsOptIn("cron", "0 6 * * *")).toBe(false);
    expect(cadenceNeedsOptIn("delayed")).toBe(false);
    expect(cadenceNeedsOptIn("scheduled")).toBe(false);
  });
});

describe("etToUtcCron with day-of-month / month (#4235)", () => {
  const EDT_REF = new Date("2026-07-15T16:00:00.000Z");
  const EST_REF = new Date("2026-01-15T17:00:00.000Z");

  it("monthly on the 1st at 9:30 AM ET converts to the 1st in UTC", () => {
    expect(etToUtcCron({ hour: 9, minute: 30, dayOfMonth: 1 }, EDT_REF)).toBe("30 13 1 * *");
    expect(etToUtcCron({ hour: 9, minute: 30, dayOfMonth: 1 }, EST_REF)).toBe("30 14 1 * *");
  });

  it("semi-annual and annual intents carry the month field", () => {
    expect(etToUtcCron({ hour: 9, minute: 30, dayOfMonth: 1, month: "1,7" }, EDT_REF)).toBe("30 13 1 1,7 *");
    expect(etToUtcCron({ hour: 9, minute: 30, dayOfMonth: 1, month: "1" }, EDT_REF)).toBe("30 13 1 1 *");
  });

  it("throws when the UTC conversion would roll the calendar day of a dated intent", () => {
    expect(() => etToUtcCron({ hour: 23, minute: 30, dayOfMonth: 1 }, EDT_REF)).toThrow(/roll/i);
  });
});

describe("buildScheduleSubmission threads the opt-in, only when set (#4235)", () => {
  const baseForm: any = {
    jobType: "marketScreen",
    targetSymbols: "",
    maxItems: 100,
    targetUniverse: "NASDAQ100",
    sector: "Technology",
    minPrice: "",
    maxPrice: "",
    minMarketCap: "",
    maxPe: "",
    trendFilter: "",
    scheduleType: "interval",
    intervalSeconds: 300,
    cronExpression: "",
    delaySeconds: 1800,
    scheduledDate: "",
    thesis: "bullish",
    riskProfile: "balanced",
    pushToSlack: false,
    slackChannel: "",
    emailTo: "",
    webhookUrl: "",
    discoveryRequests: [],
    discoveryInputModel: "saved-request",
    derivedSource: "symbols",
    derivedSymbolsText: "",
    derivedWatchlistName: "",
    derivedProfileId: "",
    noViewDraft: {},
    environment: "TEST",
  };

  it("a sub-daily form with the opt-in submits subDailyOptIn: true", () => {
    const built = buildScheduleSubmission({ ...baseForm, subDailyOptIn: true });
    expect("requestBody" in built).toBe(true);
    if ("requestBody" in built) expect(built.requestBody.subDailyOptIn).toBe(true);
  });

  it("the default form submits no opt-in field (golden bodies unchanged)", () => {
    const built = buildScheduleSubmission({ ...baseForm, intervalSeconds: 86400 });
    expect("requestBody" in built).toBe(true);
    if ("requestBody" in built) expect("subDailyOptIn" in built.requestBody).toBe(false);
  });
});
