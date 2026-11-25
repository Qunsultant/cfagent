/**
 * Issue #5878 — bulk pause / resume / run-now routes: POST
 * /api/schedules/pause, /resume and /trigger with `{ scope }`.
 * Exercised directly against handleSchedulesRoutes with the same
 * stub SchedulesRouteContext as the single-row route tests
 * (tests/schedules_manage_routes.test.ts): an in-memory schedule
 * map and a MockSqlStorage paused store.
 *
 * Pins: the bulk branch runs before the single-row branch (the
 * literal id "pause" is never read as a schedule id); an invalid
 * scope is a 400 that runs nothing; a scope filters to its kind;
 * the summary reports per-row outcomes; each acted row gets its
 * single-row audit event plus one bulk audit event; the batch
 * never fails on a refused row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";
import { MockSqlStorage } from "./mock-sql";
import { createUnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { pausedScreenScheduleToRecord } from "../src/services/unifiedScheduleManagement";

interface FakeSchedule {
  id: string;
  callback: string;
  payload: any;
  type: string;
  cron?: string;
  intervalSeconds?: number;
  time?: number;
}

let schedules: Map<string, FakeSchedule>;
let seq: number;
let callbackRuns: Array<{ callback: string; payload: any }>;
let sql: MockSqlStorage;
let ctx: any;

function seed() {
  schedules.set("job-interval", {
    id: "job-interval",
    callback: "autonomousOptionsAnalysis",
    payload: { symbols: ["AAPL"], userLogin: "venus" },
    type: "interval",
    // Issue #6482 — monthly: bulk resume re-arms through the
    // floor-checked alarms port, so a sub-monthly fixture row could
    // never resume (the old 3600s value is refused by the floor).
    intervalSeconds: 2_592_000,
    time: 1999999999,
  });
  schedules.set("job-cron", {
    id: "job-cron",
    callback: "autonomousMarketScreen",
    payload: { universe: "SP500", userLogin: "venus" },
    type: "cron",
    // Issue #6482 — yearly (the old hourly cron is refused by the
    // monthly floor at resume).
    cron: "5 0 1 1 *",
    time: 1999999999,
  });
}

beforeEach(() => {
  schedules = new Map();
  seq = 0;
  callbackRuns = [];
  sql = new MockSqlStorage();
  seed();
  ctx = {
    env: {},
    agentCtx: { storage: { sql } },
    audit: vi.fn(),
    listSchedules: async () => [...schedules.values()],
    cancelSchedule: async (id: string) => schedules.delete(id),
    getScheduleById: async (id: string) => schedules.get(id),
    schedule: async (when: any, callback: string, payload: any) => {
      const id = `new-${++seq}`;
      const s: FakeSchedule = {
        id, callback, payload,
        type: typeof when === "string" ? "cron" : "scheduled",
        ...(typeof when === "string" ? { cron: when } : { time: Math.floor(new Date(when).getTime() / 1000) }),
      };
      schedules.set(id, s);
      return s;
    },
    scheduleEvery: async (intervalSeconds: number, callback: string, payload: any) => {
      const id = `new-${++seq}`;
      const s: FakeSchedule = { id, callback, payload, type: "interval", intervalSeconds };
      schedules.set(id, s);
      return s;
    },
    getScreenerExecutionContext: async () => ({ userLogin: "venus", environment: "PROD" }),
    getOrm: () => ({}),
    autonomousMarketScreen: async () => {},
    autoRenewETradeTokens: async () => {},
    creatableScheduleCallbacks: ["autonomousOptionsAnalysis", "autonomousMarketScreen", "autonomousStrategyDiscovery"],
    accountScopedScheduleCallbacks: new Set(["autonomousOptionsAnalysis", "autonomousMarketScreen", "autonomousStrategyDiscovery"]),
    runScheduleCallback: async (callback: string, payload: any) => {
      callbackRuns.push({ callback, payload });
    },
  };
});

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`https://example.test${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const url = new URL(request.url);
  const res = await handleSchedulesRoutes(request, url, url.pathname, "sess", ctx);
  return res;
}

async function listIds(): Promise<string[]> {
  const list = await (await call("GET", "/api/schedules"))!.json();
  return (list.schedules as Array<{ id: string }>).map((s) => s.id);
}

function auditEvents(type: string): Array<{ scheduleId?: string; scope?: string }> {
  return (ctx.audit as any).mock.calls
    .filter((c: any[]) => c[0] === type)
    .map((c: any[]) => c[2]);
}

describe("bulk pause / resume / trigger routes (#5878)", () => {
  it("lists the managed rows plus the six derived system rows", async () => {
    const ids = await listIds();
    expect(ids).toContain("job-cron");
    expect(ids).toContain("job-interval");
    for (const derived of [
      "token-renewal",
      "retention",
      "nightly-research",
      "sweep-stale-ledger-tasks",
      "sweep-stale-async-jobs",
      "schedule-watchdog",
    ]) {
      expect(ids).toContain(derived);
    }
    expect(ids).toHaveLength(8);
  });

  it("bulk pause over all pauses the managed rows and refuses the derived rows per row", async () => {
    const res = await call("POST", "/api/schedules/pause", { scope: "all" });
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.verb).toBe("pause");
    expect(body.scope).toBe("all");
    expect(body.total).toBe(8);
    expect(body.applied).toBe(2);
    expect(body.already).toBe(0);
    expect(body.refused).toBe(6);
    expect(body.results.map((r: any) => [r.id, r.outcome])).toEqual([
      ["job-interval", "paused"],
      ["job-cron", "paused"],
      ["token-renewal", "refused"],
      ["retention", "refused"],
      ["nightly-research", "refused"],
      ["sweep-stale-ledger-tasks", "refused"],
      ["sweep-stale-async-jobs", "refused"],
      ["schedule-watchdog", "refused"],
    ]);
    for (const result of body.results.filter((r: any) => r.outcome === "refused")) {
      expect(result.reason).toContain("derived record");
    }
    // The paused rows stay listed, as the single-row path does.
    const ids = await listIds();
    expect(ids).toContain("job-cron");
    expect(ids).toContain("job-interval");
    expect(schedules.has("job-cron")).toBe(false);
    expect(schedules.has("job-interval")).toBe(false);
    // Per-row audit events plus one bulk audit event.
    expect(auditEvents("schedule.paused").map((e) => e.scheduleId).sort()).toEqual([
      "job-cron",
      "job-interval",
    ]);
    const bulk = auditEvents("schedule.bulk-paused");
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ scope: "all", total: 8, applied: 2, already: 0, refused: 6 });
  });

  it("bulk pause over one kind touches only that kind", async () => {
    const res = await call("POST", "/api/schedules/pause", { scope: "options" });
    const body = await res!.json();
    expect(body.total).toBe(1);
    expect(body.applied).toBe(1);
    expect(body.results).toEqual([{ id: "job-interval", kind: "options", outcome: "paused" }]);
    expect(schedules.has("job-cron")).toBe(true);
    expect(schedules.has("job-interval")).toBe(false);
  });

  it("bulk pause over the system kind refuses every derived row and pauses nothing", async () => {
    const res = await call("POST", "/api/schedules/pause", { scope: "system" });
    const body = await res!.json();
    expect(body.total).toBe(6);
    expect(body.applied).toBe(0);
    expect(body.refused).toBe(6);
    expect(schedules.has("job-cron")).toBe(true);
    expect(schedules.has("job-interval")).toBe(true);
  });

  it("an invalid scope is a 400 that runs nothing", async () => {
    for (const bad of [{ scope: "bogus" }, {}, { scope: 42 }]) {
      const res = await call("POST", "/api/schedules/pause", bad);
      expect(res?.status).toBe(400);
      const body = await res!.json();
      expect(body.error).toContain("scope");
    }
    expect(schedules.has("job-cron")).toBe(true);
    expect(schedules.has("job-interval")).toBe(true);
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("bulk resume re-arms paused rows and reports active rows as already-active", async () => {
    await call("POST", "/api/schedules/pause", { scope: "all" });
    (ctx.audit as any).mockClear();
    const res = await call("POST", "/api/schedules/resume", { scope: "all" });
    const body = await res!.json();
    expect(body.total).toBe(8);
    expect(body.applied).toBe(2);
    expect(body.refused).toBe(6);
    expect(body.results.map((r: any) => [r.id, r.outcome])).toEqual([
      ["job-interval", "resumed"],
      ["job-cron", "resumed"],
      ["token-renewal", "refused"],
      ["retention", "refused"],
      ["nightly-research", "refused"],
      ["sweep-stale-ledger-tasks", "refused"],
      ["sweep-stale-async-jobs", "refused"],
      ["schedule-watchdog", "refused"],
    ]);
    // Resume re-arms under new SDK alarm ids (the record id is
    // stable, only the alarm changes — #3123-P03): the map holds
    // two re-armed alarms, and the list shows both rows active.
    expect(schedules.size).toBe(2);
    const list = await (await call("GET", "/api/schedules"))!.json();
    for (const id of ["job-cron", "job-interval"]) {
      const row = list.schedules.find((s: any) => s.id === id);
      expect(row).toBeTruthy();
      expect(row.paused).toBe(false);
    }
    expect(auditEvents("schedule.resumed")).toHaveLength(2);
    expect(auditEvents("schedule.bulk-resumed")).toHaveLength(1);
  });

  it("bulk resume refuses a sub-monthly paused row per row while resuming monthly rows (#6482)", async () => {
    // A paused sub-monthly record, seeded directly in the unified
    // store (it has no live alarm — the floor governs arms, and
    // resume is an arm).
    const store = createUnifiedSchedulePorts({ sql, storage: { sql } as never }).unifiedSchedulesSync;
    const subMonthly = pausedScreenScheduleToRecord(
      {
        callback: "autonomousMarketScreen",
        type: "interval",
        intervalSeconds: 3600,
        payload: { universe: "SP500", userLogin: "venus" },
        ownerLogin: "venus",
      },
      "2026-11-24T00:00:00.000Z",
    );
    store.save(subMonthly);
    await call("POST", "/api/schedules/pause", { scope: "all" });
    (ctx.audit as any).mockClear();
    const res = await call("POST", "/api/schedules/resume", { scope: "all" });
    const body = await res!.json();
    expect(body.total).toBe(9);
    expect(body.applied).toBe(2);
    expect(body.refused).toBe(7);
    expect(body.results.find((r: any) => r.id === "job-interval")?.outcome).toBe("resumed");
    expect(body.results.find((r: any) => r.id === "job-cron")?.outcome).toBe("resumed");
    const refusedRow = body.results.find((r: any) => r.id === subMonthly.id);
    expect(refusedRow?.outcome).toBe("refused");
    expect(refusedRow?.reason).toContain("SCHEDULE_BELOW_FREQUENCY_FLOOR");
    // The monthly rows re-armed; the sub-monthly row stays paused.
    expect(schedules.size).toBe(2);
    expect((await store.get(subMonthly.id))?.state).toBe("paused");
  });

  it("bulk resume over all-active rows reports already-active, not refused", async () => {
    const res = await call("POST", "/api/schedules/resume", { scope: "stocks" });
    const body = await res!.json();
    expect(body.total).toBe(1);
    expect(body.applied).toBe(0);
    expect(body.already).toBe(1);
    expect(body.refused).toBe(0);
    expect(body.results).toEqual([{ id: "job-cron", kind: "stocks", outcome: "already-active" }]);
  });

  it("bulk trigger runs the active rows and refuses paused and derived rows", async () => {
    await call("POST", "/api/schedules/job-cron/pause");
    (ctx.audit as any).mockClear();
    callbackRuns.length = 0;
    const res = await call("POST", "/api/schedules/trigger", { scope: "all" });
    const body = await res!.json();
    expect(body.total).toBe(8);
    expect(body.applied).toBe(1);
    expect(body.refused).toBe(7);
    expect(body.results.find((r: any) => r.id === "job-interval")?.outcome).toBe("triggered");
    expect(body.results.find((r: any) => r.id === "job-cron")?.outcome).toBe("refused");
    expect(body.results.find((r: any) => r.id === "job-cron")?.reason).toContain("paused");
    expect(callbackRuns.map((r) => r.callback)).toEqual(["autonomousOptionsAnalysis"]);
    expect(auditEvents("schedule.triggered").map((e) => e.scheduleId)).toEqual(["job-interval"]);
    expect(auditEvents("schedule.bulk-triggered")).toHaveLength(1);
  });

  it("the bulk path never reads 'pause' as a schedule id", async () => {
    const res = await call("POST", "/api/schedules/pause", { scope: "stocks" });
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.results.map((r: any) => r.id)).toEqual(["job-cron"]);
  });
});
