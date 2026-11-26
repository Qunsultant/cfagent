/**
 * Issue #1819 — rollup / cap-alert / comparison as ScheduledAgent goals (RED).
 *
 * Follows the pipeline_scheduled_goals.test.ts harness: mocked `agents`
 * base, mocked orchestrate (createJob only — resource goals execute
 * directly in onCron, like social.publish, never through createJob),
 * fake DO storage, fake timers.
 *
 * Pinned behaviors:
 * - The three operations exist in the REAL OPERATION_CATALOG and the
 *   three goals exist in the REAL DEFAULT_SCHEDULES with their cadences.
 * - Rollup fires at 01:30 UTC for the previous UTC day; comparison fires
 *   at 02:00 UTC for the latest completed rollup day.
 * - The hourly alert NEVER stamps lastRun: isDue's 23h guard would
 *   otherwise suppress hourly evaluation for 23h after any stamp.
 *   Delivery dedup lives in alert state, not lastRun — so both the :00
 *   and :30 ticks match the hourly cron (minute-tolerance rule) and the
 *   second evaluation is a deduped no-op.
 * - Forced triggerGoal reproduces the scheduled run exactly (same report
 *   JSON), because the comparison goal reads the latest completed rollup
 *   rather than the wall-clock day.
 * - AGENT_DB unbound: the goal errors, stays due, and never stamps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    {
      agent: "resource",
      binding: "SCHEDULED_AGENT",
      operations: ["resource.rollup_daily", "resource.cap_alert", "resource.dashboard_comparison"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";

function makeCtx(initialGoals?: any[]) {
  const store = new Map<string, unknown>();
  if (initialGoals) store.set("goals", initialGoals);
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    _store: store,
  };
}

/** Fake D1 shared by the projection totals query and the rollup store. */
/**
 * #4282 P6a (#4384): the rollup store's statements moved into
 * the DML catalogue and now render through the Drizzle builder
 * — lowercase, quoted identifiers, `insert ... on conflict`
 * upserts instead of `INSERT OR REPLACE` — so this fake's
 * SQL-text dispatch matches the builder rendering, and its
 * bound statements expose .raw(): drizzle-orm 0.45.4's
 * select-with-fields path reads array-mode rows via .raw(),
 * never .all(). The maps keep their role: the goals write to
 * them and the tests seed/inspect them directly. Param order
 * is the values-object order (same columns as the old raw
 * SQL); raw() arrays are in SELECT-list order.
 */
function makeFakeD1(projectionRows: Array<Record<string, unknown>> = []) {
  const rollups = new Map<string, Record<string, unknown>>();
  const alertState = new Map<string, Record<string, unknown>>();
  const reports = new Map<string, Record<string, unknown>>();
  /**
   * Issue #6503 — the fake also serves the D1 unified-schedules
   * table the goals tick reads now. The Drizzle adapter issues
   * `select ... from "unified_schedules"` (read via .all() or
   * .raw()) and `insert ... on conflict("id") do update` upserts
   * (via .run()); the map below is that table. Migration
   * statements hit the default run() success leg — the table is
   * created `IF NOT EXISTS` and the fake never persists DDL.
   */
  const schedules = new Map<string, Record<string, unknown>>();
  const SCHEDULE_COLS = [
    "id", "kind", "state", "callback", "operation", "definition_json",
    "owner_login", "provenance_json", "alarm_id", "paused_at",
    "created_at", "updated_at",
  ];
  function scheduleRows(sql: string, params: unknown[]) {
    let rows = [...schedules.values()];
    if (/"kind" = \?/i.test(sql)) rows = rows.filter((r) => r.kind === params[0]);
    else if (/"id" = \?/i.test(sql)) rows = rows.filter((r) => r.id === params[0]);
    else if (/"state" = \?/i.test(sql)) rows = rows.filter((r) => r.state === params[0]);
    rows.sort(
      (a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.id).localeCompare(String(b.id)),
    );
    return rows;
  }
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              if (/insert into "unified_schedules"/i.test(sql)) {
                const row: Record<string, unknown> = {};
                SCHEDULE_COLS.forEach((col, i) => {
                  row[col] = params[i];
                });
                schedules.set(String(row.id), row);
              } else if (/delete from "unified_schedules"/i.test(sql)) {
                if (/"id" = \?/i.test(sql)) schedules.delete(String(params[0]));
                else if (/"state" = \?/i.test(sql)) {
                  for (const [k, v] of [...schedules]) {
                    if (v.state === params[0]) schedules.delete(k);
                  }
                } else schedules.clear();
              } else if (/insert into "resource_daily_rollups"/i.test(sql)) {
                const [day, ns, op, caller, trigger, ops, rows_read, rows_written] = params as [
                  string, string, string, string, string, number, number, number,
                ];
                rollups.set([day, ns, op, caller, trigger].join("\0"), {
                  day, ns, op, caller, trigger, ops, rows_read, rows_written,
                });
              } else if (/insert into "resource_alert_state"/i.test(sql)) {
                const [budget, day, alerted_at, delivered, note] = params as [
                  string, string, number, number, string | null,
                ];
                alertState.set([budget, day].join("\0"), { budget, day, alerted_at, delivered, note });
              } else if (/insert into "resource_comparison_reports"/i.test(sql)) {
                const [day, generated_at, report_json] = params as [string, number, string];
                reports.set(day, { day, generated_at, report_json });
              }
              return { success: true };
            },
            all: async () => {
              if (/from "unified_schedules"/i.test(sql)) {
                return { results: scheduleRows(sql, params) };
              }
              if (/from "resource_daily_rollups"/i.test(sql) && /max\("day"\)/i.test(sql)) {
                const days = [...rollups.values()].map((r) => r.day as string);
                return { results: days.length ? [{ day: days.sort().at(-1) }] : [] };
              }
              if (/from "resource_daily_rollups"/i.test(sql)) {
                const [day] = params as [string];
                return { results: [...rollups.values()].filter((r) => r.day === day) };
              }
              if (/from "resource_alert_state"/i.test(sql)) {
                const [budget, day] = params as [string, string];
                const row = alertState.get([budget, day].join("\0"));
                return { results: row ? [row] : [] };
              }
              if (/from "resource_comparison_reports"/i.test(sql)) {
                const [day] = params as [string];
                const row = reports.get(day);
                return { results: row ? [row] : [] };
              }
              if (/from "resource_sql_ops"/i.test(sql)) {
                return { results: projectionRows };
              }
              return { results: [] };
            },
            raw: async () => {
              if (/from "unified_schedules"/i.test(sql)) {
                return scheduleRows(sql, params).map((r) =>
                  SCHEDULE_COLS.map((c) => r[c]),
                );
              }
              if (/from "resource_daily_rollups"/i.test(sql) && /max\("day"\)/i.test(sql)) {
                const days = [...rollups.values()].map((r) => r.day as string);
                return days.length ? [[days.sort().at(-1)]] : [];
              }
              if (/from "resource_daily_rollups"/i.test(sql)) {
                const [day] = params as [string];
                return [...rollups.values()]
                  .filter((r) => r.day === day)
                  .map((r) => [r.day, r.ns, r.op, r.caller, r.trigger, r.ops, r.rows_read, r.rows_written]);
              }
              if (/from "resource_alert_state"/i.test(sql)) {
                const [budget, day] = params as [string, string];
                const row = alertState.get([budget, day].join("\0"));
                return row ? [[row.budget, row.day, row.alerted_at, row.delivered, row.note]] : [];
              }
              if (/from "resource_comparison_reports"/i.test(sql)) {
                const [day] = params as [string];
                const row = reports.get(day);
                return row ? [[row.report_json]] : [];
              }
              if (/from "resource_sql_ops"/i.test(sql)) {
                return projectionRows.map((r) => [
                  r.bucket, r.ns, r.op, r.caller, r.trigger, r.ops, r.rows_read, r.rows_written,
                ]);
              }
              return [];
            },
          };
        },
      };
    },
  };
  return { db, rollups, alertState, reports, schedules };
}

/**
 * Issue #6503 — the fixture goal is planted in the D1 schedule
 * store, not the DO KV "goals" key (which the agent no longer
 * reads). Planting exactly one goal keeps each tick isolated: an
 * empty store would re-seed all nine built-in goals.
 */
async function plantGoals(db: any, goals: Array<Record<string, unknown>>) {
  const store = createD1UnifiedSchedulePorts({ d1: db as never }).unifiedSchedules;
  for (const goal of goals) {
    await store.save(goalToRecord(goal as never));
  }
}

function makeEnv(fakeD1: any, slackUrl?: string) {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    AGENT_DB: fakeD1,
    SESSION_STORE: null,
    ...(slackUrl ? { SLACK_WEBHOOK_URL: slackUrl } : {}),
  };
}

function resourceGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "resource-daily-rollup",
    name: "Resource daily rollup",
    cron: "30 1 * * *",
    timeZone: "UTC",
    operation: "resource.rollup_daily",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resource.rollup_daily via onCron", () => {
  it("fires at 01:30 UTC for the previous UTC day and stamps lastRun", async () => {
    vi.setSystemTime(new Date("2026-10-27T01:30:00Z"));
    const { db, rollups } = makeFakeD1([
      { bucket: 0, ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 100, rows_read: 100, rows_written: 0 },
    ]);
    await plantGoals(db, [resourceGoal()]);
    const ctx = makeCtx();
    const env = makeEnv(db);
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.errors).toEqual([]);
    expect(tick.jobsCreated).toBe(1);
    expect(rollups.size).toBe(1);
    const row = [...rollups.values()][0];
    expect(row).toMatchObject({ day: "2026-10-26", op: "get", ops: 100, rows_read: 100 });
    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBe("2026-10-27T01:30:00.000Z");
  });

  it("does not fire at 01:00 UTC (before the scheduled minute)", async () => {
    vi.setSystemTime(new Date("2026-10-27T01:00:00Z"));
    const { db, rollups } = makeFakeD1([]);
    await plantGoals(db, [resourceGoal()]);
    const ctx = makeCtx();
    const env = makeEnv(db);
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsCreated).toBe(0);
    expect(rollups.size).toBe(0);
  });

  it("errors and stays due when AGENT_DB is unbound", async () => {
    vi.setSystemTime(new Date("2026-10-27T01:30:00Z"));
    const ctx = makeCtx();
    const env = makeEnv(undefined);
    delete (env as any).AGENT_DB;
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    // Issue #6503 — the load itself is fail-closed now: the tick
    // refuses before any goal is evaluated, so nothing is skipped
    // (0, not 1) and nothing is created; the error names AGENT_DB.
    expect(tick.jobsSkipped).toBe(0);
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors.join(" ")).toMatch(/AGENT_DB/);
  });
});

describe("resource.cap_alert via onCron", () => {
  it("alerts once per breach-day via the injected Slack poster and never stamps lastRun", async () => {
    const posts: Array<{ url: string; body: string }> = [];
    const post = vi.fn(async (url: string, _headers: any, body: string) => {
      posts.push({ url, body });
      return { status: 200, body: "ok" };
    });
    const { db, alertState } = makeFakeD1([
      { bucket: 0, ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 1000, rows_read: 3_600_000, rows_written: 10 },
    ]);
    const goal = resourceGoal({
      id: "resource-cap-alert",
      name: "Resource cap alert",
      cron: "0 * * * *",
      operation: "resource.cap_alert",
    });
    await plantGoals(db, [goal]);
    const ctx = makeCtx();
    const env = makeEnv(db, "https://hooks.slack.test/services/XXX");
    const agent = new ScheduledAgent(ctx as never, env as never);

    vi.setSystemTime(new Date("2026-10-26T15:00:00Z"));
    const tick1 = await agent.onCron(env as never, { halted: false, resourceSlackPost: post } as never);
    expect(tick1.errors).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(posts[0].body).toMatch(/rowsRead/);
    expect(posts[0].body).toMatch(/3,600,000/);
    expect(alertState.size).toBe(1);

    // The :30 tick also matches the hourly cron (minute tolerance), but
    // alert-state dedup makes it a no-op, not a second alert.
    vi.setSystemTime(new Date("2026-10-26T15:30:00Z"));
    await agent.onCron(env as never, { halted: false, resourceSlackPost: post } as never);
    expect(post).toHaveBeenCalledTimes(1);

    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBeUndefined();
  });

  it("does not post or record state below all thresholds", async () => {
    const post = vi.fn(async () => ({ status: 200, body: "ok" }));
    const { db, alertState } = makeFakeD1([
      { bucket: 0, ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 100, rows_read: 100, rows_written: 0 },
    ]);
    const goal = resourceGoal({
      id: "resource-cap-alert",
      name: "Resource cap alert",
      cron: "0 * * * *",
      operation: "resource.cap_alert",
    });
    await plantGoals(db, [goal]);
    const ctx = makeCtx();
    const env = makeEnv(db, "https://hooks.slack.test/services/XXX");
    const agent = new ScheduledAgent(ctx as never, env as never);
    vi.setSystemTime(new Date("2026-10-26T15:00:00Z"));
    const tick = await agent.onCron(env as never, { halted: false, resourceSlackPost: post } as never);
    expect(tick.errors).toEqual([]);
    expect(post).not.toHaveBeenCalled();
    expect(alertState.size).toBe(0);
  });
});

describe("resource.dashboard_comparison via onCron", () => {
  it("writes the report for the latest completed rollup day, and forced evaluation reproduces it exactly", async () => {
    const { db, reports, rollups } = makeFakeD1();
    rollups.set("2026-10-26\0sessions\0get\0requireAuth\0user", {
      day: "2026-10-26", ns: "sessions", op: "get", caller: "requireAuth", trigger: "user",
      ops: 30_000, rows_read: 30_000, rows_written: 0,
    });
    const goal = resourceGoal({
      id: "resource-dashboard-comparison",
      name: "Resource dashboard comparison",
      cron: "0 2 * * *",
      operation: "resource.dashboard_comparison",
    });
    await plantGoals(db, [goal]);
    const ctx = makeCtx();
    const env = makeEnv(db);
    const agent = new ScheduledAgent(ctx as never, env as never);

    vi.setSystemTime(new Date("2026-10-27T02:00:00Z"));
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.errors).toEqual([]);
    expect(tick.jobsCreated).toBe(1);
    const scheduledJson = [...reports.values()][0].report_json as string;
    const scheduled = JSON.parse(scheduledJson);
    expect(scheduled.day).toBe("2026-10-26");
    expect(scheduled.grandTotals).toEqual({ ops: 30_000, rowsRead: 30_000, rowsWritten: 0 });
    expect(scheduled.dashboard).toBeNull();

    // Forced evaluation at a different time reproduces the scheduled run
    // exactly: same latest-completed day, same report content.
    reports.clear();
    vi.setSystemTime(new Date("2026-10-28T17:45:00Z"));
    const forced = await agent.triggerGoal("resource-dashboard-comparison", env as never);
    expect(forced.errors).toEqual([]);
    const forcedJson = [...reports.values()][0].report_json as string;
    expect(JSON.parse(forcedJson)).toEqual(scheduled);
  });

  it("stays due when no completed rollup exists yet", async () => {
    const { db, reports } = makeFakeD1();
    const goal = resourceGoal({
      id: "resource-dashboard-comparison",
      name: "Resource dashboard comparison",
      cron: "0 2 * * *",
      operation: "resource.dashboard_comparison",
    });
    await plantGoals(db, [goal]);
    const ctx = makeCtx();
    const env = makeEnv(db);
    const agent = new ScheduledAgent(ctx as never, env as never);
    vi.setSystemTime(new Date("2026-10-27T02:00:00Z"));
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(reports.size).toBe(0);
    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBeUndefined();
  });
});
