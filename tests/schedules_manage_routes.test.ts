/**
 * Issue #273 — schedules management routes: PUT /api/schedules/:id
 * (frequency + payload update), POST /api/schedules/:id/pause and
 * /resume, and POST /api/schedules/:id/trigger (the per-job trigger the
 * SchedulesPanel already calls). Exercised directly against
 * handleSchedulesRoutes with a stub SchedulesRouteContext backed by an
 * in-memory schedule map and a MockSqlStorage paused store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";
import { MockSqlStorage } from "./mock-sql";

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
    // Issue #6482 — the seed is a monthly cadence (2,592,000s):
    // a sub-monthly seed would be refused at resume / update by
    // the floor, which is the behavior the tests below pin.
    intervalSeconds: 2_592_000,
    time: 1999999999,
  });
  schedules.set("job-cron", {
    id: "job-cron",
    callback: "autonomousMarketScreen",
    payload: { universe: "SP500", userLogin: "venus" },
    type: "cron",
    cron: "5 * * * *",
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

describe(" pause / resume (#273)", () => {
  it("pause removes the SDK schedule and the list shows it as paused", async () => {
    const res = await call("POST", "/api/schedules/job-cron/pause");
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.schedule.paused).toBe(true);
    expect(schedules.has("job-cron")).toBe(false);

    const list = await (await call("GET", "/api/schedules"))!.json();
    const paused = list.schedules.find((s: any) => s.id === "job-cron");
    expect(paused).toBeTruthy();
    expect(paused.paused).toBe(true);
    expect(paused.cron).toBe("5 * * * *");
    expect(list.creatableCallbacks).toContain("autonomousMarketScreen");
  });

  it("resume re-arms the stored definition and clears the paused record", async () => {
    await call("POST", "/api/schedules/job-interval/pause");
    const res = await call("POST", "/api/schedules/job-interval/resume");
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.previousId).toBe("job-interval");
    const rearmed = schedules.get(body.schedule.id);
    expect(rearmed?.type).toBe("interval");
    expect(rearmed?.intervalSeconds).toBe(2_592_000);
    expect(rearmed?.callback).toBe("autonomousOptionsAnalysis");
    expect(rearmed?.payload).toEqual({ symbols: ["AAPL"], userLogin: "venus" });

    const list = await (await call("GET", "/api/schedules"))!.json();
    expect(list.schedules.some((s: any) => s.paused)).toBe(false);
  });

  it("pause of an unknown id is a 404; resume of a non-paused id is a 404", async () => {
    expect((await call("POST", "/api/schedules/nope/pause"))?.status).toBe(404);
    expect((await call("POST", "/api/schedules/job-cron/resume"))?.status).toBe(404);
  });

  it("deleting a paused job removes its record", async () => {
    await call("POST", "/api/schedules/job-cron/pause");
    const res = await call("DELETE", "/api/schedules/job-cron");
    const body = await res!.json();
    expect(body.cancelled).toBe(true);
    const list = await (await call("GET", "/api/schedules"))!.json();
    expect(list.schedules.some((s: any) => s.id === "job-cron")).toBe(false);
  });
});

describe("agent schedule approvals fail closed when PDP is disabled (#3122)", () => {
  it("denies and audits approval decisions without enforced policy", async () => {
    const res = await call("POST", "/api/schedules/approvals/not-found/approve");

    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({
      error: "Approval denied by policy: PDP enforcement is disabled",
    });
    expect(ctx.audit).toHaveBeenCalledWith(
      "agent.schedule.approval-denied",
      "orchestrator",
      expect.objectContaining({
        pendingApprovalId: "not-found",
        decidedBy: "venus",
        pdpEnforced: false,
      }),
    );
  });
});

describe("PUT /api/schedules/:id (#273)", () => {
  it("changes an interval job's frequency atomically (cancel + recreate)", async () => {
    // Issue #4235 — the update carries the explicit per-schedule
    // opt-in; the atomic cancel + recreate is the same behavior
    // this pin always asserted. Issue #6482 — the new frequency is
    // a monthly-plus cadence (5,184,000s = 60 days): a sub-monthly
    // target is refused by the floor before the cancel (see the
    // below-floor test below), so the atomicity pin runs above it.
    const res = await call("PUT", "/api/schedules/job-interval", { intervalSeconds: 5_184_000, subDailyOptIn: true });
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(schedules.has("job-interval")).toBe(false);
    const updated = schedules.get(body.schedule.id);
    expect(updated?.type).toBe("interval");
    expect(updated?.intervalSeconds).toBe(5_184_000);
    // Issue #4235 — the re-armed alarm's payload records the opt-in
    // the update supplied, exactly as creation stamps it.
    expect(updated?.payload).toEqual({ symbols: ["AAPL"], userLogin: "venus", subDailyOptIn: true });
  });

  it("refuses a below-floor update with 400 and leaves the job untouched (#6482)", async () => {
    // Issue #6482 — the floor is checked before the cancel
    // (#6210 atomicity): the update is refused and the original
    // schedule is still armed at its stored monthly timing. Before
    // this fix the cancel ran first, the re-arm was refused, the
    // rollback re-arm of the original (also sub-monthly in the old
    // fixture) was refused too, and the route reported 500 with the
    // schedule lost.
    const res = await call("PUT", "/api/schedules/job-interval", { intervalSeconds: 900, subDailyOptIn: true });
    expect(res?.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toContain("SCHEDULE_BELOW_FREQUENCY_FLOOR");
    expect(schedules.get("job-interval")?.intervalSeconds).toBe(2_592_000);
    expect(schedules.get("job-interval")?.callback).toBe("autonomousOptionsAnalysis");
  });

  it("switches a job from interval to cron", async () => {
    // Issue #6482 — the new cron is yearly: a weekday cron's
    // shortest gap is below the monthly floor, so the switch pins
    // a floor-passing cadence.
    const res = await call("PUT", "/api/schedules/job-interval", { cron: "0 9 1 1 *" });
    const body = await res!.json();
    const updated = schedules.get(body.schedule.id);
    expect(updated?.type).toBe("cron");
    expect(updated?.cron).toBe("0 9 1 1 *");
  });

  it("updates a paused job in place without re-arming it", async () => {
    await call("POST", "/api/schedules/job-cron/pause");
    const sizeBefore = schedules.size;
    const res = await call("PUT", "/api/schedules/job-cron", { cron: "30 10 * * *" });
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.schedule.paused).toBe(true);
    expect(body.schedule.cron).toBe("30 10 * * *");
    expect(schedules.size).toBe(sizeBefore);
  });

  it("rejects a malformed cron with 400 and leaves the job untouched", async () => {
    const res = await call("PUT", "/api/schedules/job-interval", { cron: "bogus" });
    expect(res?.status).toBe(400);
    expect(schedules.get("job-interval")?.intervalSeconds).toBe(2_592_000);
  });

  it("PUT of an unknown id is a 404", async () => {
    expect((await call("PUT", "/api/schedules/nope", { intervalSeconds: 60 }))?.status).toBe(404);
  });
});

describe("POST /api/schedules/:id/trigger (#273)", () => {
  it("dispatches the job's callback with its payload plus a manual trigger mark", async () => {
    const res = await call("POST", "/api/schedules/job-cron/trigger");
    expect(res?.status).toBe(200);
    expect(callbackRuns).toEqual([
      { callback: "autonomousMarketScreen", payload: { universe: "SP500", userLogin: "venus", trigger: "manual", scheduleId: "job-cron" } },
    ]);
  });

  it("refuses to trigger a paused job (409) and 404s unknown ids", async () => {
    await call("POST", "/api/schedules/job-cron/pause");
    expect((await call("POST", "/api/schedules/job-cron/trigger"))?.status).toBe(409);
    expect((await call("POST", "/api/schedules/nope/trigger"))?.status).toBe(404);
    expect(callbackRuns).toEqual([]);
  });
});
