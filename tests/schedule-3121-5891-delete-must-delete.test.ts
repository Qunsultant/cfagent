/**
 * Issue #5891 — Delete must delete.
 *
 * The Delete button did not delete the last 6-7 schedules in the
 * Schedules home — and the UI told the user it did. The row stayed,
 * no error, no explanation. `deleteUnifiedSchedule` returned
 * `{ok: true, cancelled: false}` — a silent no-op — for the six
 * derived records, goal records, and every other non-managed kind;
 * the route answered 200 with that body; the client never checked
 * `cancelled`; the confirm modal promised removal the path could
 * not do.
 *
 * This file pins the honest contract (service + route + client):
 * every kind the delete path refuses is refused with a named error
 * (the pause/resume/trigger precedent), the client treats a
 * `cancelled: false` answer as a failure, and deletable rows still
 * delete. The panel half (disabled Delete + modal copy) lives in
 * schedule-3121-5891-delete-must-delete.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deleteUnifiedSchedule,
  type ScheduleAlarmLike,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";
import { MockSqlStorage } from "./mock-sql";
import { deleteSchedule } from "../src/client/jobsApi";

const NOW = "2026-11-21T12:00:00.000Z";

/** The six derived rows Delete cannot remove (they re-derive from code). */
const DERIVED_IDS = [
  "token-renewal",
  "retention",
  "nightly-research",
  "sweep-stale-ledger-tasks",
  "sweep-stale-async-jobs",
  "schedule-watchdog",
] as const;

/**
 * An alarms port with the real contract: cancelling an unknown id
 * is false (nothing was there), cancelling a known alarm is true.
 */
function alarmsPort(known: string[] = []) {
  const cancelled: string[] = [];
  const knownSet = new Set(known);
  return {
    cancelled,
    port: {
      list: async () => [] as ScheduleAlarmLike[],
      get: async (id: string) =>
        knownSet.has(id)
          ? ({ id, callback: "autonomousMarketScreen", type: "cron", cron: "5 * * * *" } as ScheduleAlarmLike)
          : undefined,
      cancel: async (id: string) => {
        if (!knownSet.has(id)) return false;
        cancelled.push(id);
        return true;
      },
      arm: async () => ({ id: "new-1" }),
    },
  };
}

function record(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "screen-1",
    kind: "screen",
    state: "active",
    callback: "autonomousMarketScreen",
    definition: { type: "cron", callback: "autonomousMarketScreen", cron: "5 * * * *" },
    alarmId: "screen-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("5891 delete refuses the six derived records with a named error", () => {
  it.each(DERIVED_IDS)("delete of %s is a 400 naming the derived record", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort();
    const deleted = await deleteUnifiedSchedule({ store, alarms: port }, id);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.status).toBe(400);
      expect(deleted.error).toContain(id);
      expect(deleted.error).toContain("derived record");
      expect(deleted.error).toContain("delete");
      expect(deleted.error).not.toContain("Goal schedules");
    }
  });
});

describe("5891 delete refuses goal and non-managed kinds with a named error", () => {
  it("a goal record refuses through the goals surface", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort();
    store.save(record({ id: "goal-1", kind: "goal", callback: "runScheduledGoal", alarmId: null }));
    const deleted = await deleteUnifiedSchedule({ store, alarms: port }, "goal-1");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.status).toBe(400);
      expect(deleted.error).toContain("Goal schedules");
      expect(deleted.error).toContain("/api/schedule/goals/");
    }
    expect(await store.get("goal-1")).toBeDefined();
  });

  it.each(["worker-duty", "followup", "ticker-push"] as const)(
    "a %s record refuses naming its kind (and stays stored)",
    async (kind) => {
      const store = new InMemoryUnifiedScheduleStore();
      const { port } = alarmsPort();
      store.save(record({ id: `row-${kind}`, kind, alarmId: null }));
      const deleted = await deleteUnifiedSchedule({ store, alarms: port }, `row-${kind}`);
      expect(deleted.ok).toBe(false);
      if (!deleted.ok) {
        expect(deleted.status).toBe(400);
        expect(deleted.error).toContain(kind);
        expect(deleted.error).toContain("cannot be deleted");
      }
      expect(await store.get(`row-${kind}`)).toBeDefined();
    },
  );
});

describe("5891 delete of an unknown id is a 404, never a silent 200", () => {
  it("no record, no alarm, alarm cancel false -> 404 naming the id", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort();
    const deleted = await deleteUnifiedSchedule({ store, alarms: port }, "nope");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.status).toBe(404);
      expect(deleted.error).toContain("nope");
      expect(deleted.error).toContain("not found");
    }
  });
});

describe("5891 deletable rows still delete", () => {
  it("a screen record is removed and its alarm cancelled", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, cancelled } = alarmsPort(["screen-1"]);
    store.save(record());
    const deleted = await deleteUnifiedSchedule({ store, alarms: port }, "screen-1");
    expect(deleted).toEqual({ ok: true, cancelled: true });
    expect(await store.get("screen-1")).toBeUndefined();
    expect(cancelled).toEqual(["screen-1"]);
  });

  it("an internal record is removed and its alarm cancelled", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, cancelled } = alarmsPort(["iv-1"]);
    store.save(record({ id: "iv-1", kind: "internal", callback: "collectIvHistory", alarmId: "iv-1" }));
    const deleted = await deleteUnifiedSchedule({ store, alarms: port }, "iv-1");
    expect(deleted).toEqual({ ok: true, cancelled: true });
    expect(await store.get("iv-1")).toBeUndefined();
    expect(cancelled).toEqual(["iv-1"]);
  });
});

/* =================================================================
 * Route: DELETE /api/schedules/:id (and POST /api/schedules/cancel,
 * the same handler) — the silent 200 + cancelled:false must end.
 * Harness follows tests/schedules_manage_routes.test.ts: a stub
 * SchedulesRouteContext backed by an in-memory schedule map and a
 * MockSqlStorage unified store.
 * ================================================================= */

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
let sql: MockSqlStorage;
let ctx: any;
let tickerPaused: string[];

function fakeTickerNamespace() {
  return {
    idFromName: (_name: string) => "ticker-id",
    get: (_id: unknown) => ({
      getTickerPushRecord: async () => null,
      pauseTickerPush: async () => {
        tickerPaused.push("ticker-push");
        return { ok: true };
      },
      resumeTickerPush: async () => ({ ok: true }),
      setTickerPushInterval: async (intervalSeconds: number) => ({ ok: true, intervalSeconds }),
      triggerTickerPush: async () => ({ ok: true }),
    }),
  };
}

beforeEach(() => {
  schedules = new Map();
  tickerPaused = [];
  sql = new MockSqlStorage();
  schedules.set("job-cron", {
    id: "job-cron",
    callback: "autonomousMarketScreen",
    payload: { universe: "SP500", userLogin: "venus" },
    type: "cron",
    cron: "5 * * * *",
    time: 1999999999,
  });
  ctx = {
    env: { TICKER_AGENT: fakeTickerNamespace() },
    agentCtx: { storage: { sql } },
    audit: vi.fn(),
    listSchedules: async () => [...schedules.values()],
    cancelSchedule: async (id: string) => schedules.delete(id),
    getScheduleById: async (id: string) => schedules.get(id),
    schedule: async () => ({ id: "new-1", callback: "autonomousMarketScreen" }),
    scheduleEvery: async () => ({ id: "new-1", callback: "autonomousMarketScreen" }),
    getScreenerExecutionContext: async () => ({ userLogin: "venus", environment: "PROD" }),
    getOrm: () => ({}),
    autonomousMarketScreen: async () => {},
    autoRenewETradeTokens: async () => {},
    creatableScheduleCallbacks: ["autonomousMarketScreen"],
    accountScopedScheduleCallbacks: new Set(["autonomousMarketScreen"]),
    runScheduleCallback: async () => {},
  };
});

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`https://example.test${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const url = new URL(request.url);
  return handleSchedulesRoutes(request, url, url.pathname, "sess", ctx);
}

describe("5891 DELETE route refuses honestly and audits truthfully", () => {
  it.each(DERIVED_IDS)("DELETE %s is a 400 naming the derived record", async (id) => {
    const res = await call("DELETE", `/api/schedules/${id}`);
    expect(res?.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toContain(id);
    expect(body.error).toContain("derived record");
    expect(body.cancelled).toBeUndefined();
    expect(ctx.audit).toHaveBeenCalledWith(
      "schedule.cancelled",
      "orchestrator",
      expect.objectContaining({ scheduleId: id, success: false }),
    );
  });

  it("DELETE of an unknown id is a 404, audited as a failed cancellation", async () => {
    const res = await call("DELETE", "/api/schedules/nope");
    expect(res?.status).toBe(404);
    const body = await res!.json();
    expect(body.error).toContain("nope");
    expect(ctx.audit).toHaveBeenCalledWith(
      "schedule.cancelled",
      "orchestrator",
      expect.objectContaining({ scheduleId: "nope", success: false }),
    );
  });

  it("DELETE of a deletable row is a 200 with cancelled:true, audited as success", async () => {
    const res = await call("DELETE", "/api/schedules/job-cron");
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({ scheduleId: "job-cron", cancelled: true });
    expect(ctx.audit).toHaveBeenCalledWith(
      "schedule.cancelled",
      "orchestrator",
      expect.objectContaining({ scheduleId: "job-cron", success: true }),
    );
    expect(schedules.has("job-cron")).toBe(false);
  });

  it("DELETE of ticker-push still pauses the feed and answers cancelled:true", async () => {
    const res = await call("DELETE", "/api/schedules/ticker-push");
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body).toEqual({ scheduleId: "ticker-push", cancelled: true });
    expect(tickerPaused).toEqual(["ticker-push"]);
    expect(ctx.audit).toHaveBeenCalledWith(
      "schedule.cancelled",
      "orchestrator",
      expect.objectContaining({ scheduleId: "ticker-push", success: true }),
    );
  });

  it("POST /api/schedules/cancel shares the refusal (same handler)", async () => {
    const res = await call("POST", "/api/schedules/cancel", { scheduleId: "token-renewal" });
    expect(res?.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toContain("token-renewal");
  });
});

/* =================================================================
 * Client: jobsApi.deleteSchedule must check `cancelled` — a 200
 * with cancelled:false is a failed delete, never a success.
 * ================================================================= */

describe("5891 deleteSchedule client checks cancelled", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = String(input);
        if (url === "/api/schedules/gone-row" ) {
          return Response.json({ scheduleId: "gone-row", cancelled: false });
        }
        if (url === "/api/schedules/refused-row") {
          return Response.json({ error: "Schedule 'refused-row' is a derived record with no alarm to delete." }, { status: 400 });
        }
        return Response.json({ scheduleId: "screen-1", cancelled: true });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a 200 with cancelled:false throws instead of reading as success", async () => {
    await expect(deleteSchedule("gone-row")).rejects.toThrow("gone-row");
  });

  it("a 400 refusal surfaces the server's named error", async () => {
    await expect(deleteSchedule("refused-row")).rejects.toThrow("derived record");
  });

  it("a real delete resolves with the cancelled result", async () => {
    await expect(deleteSchedule("screen-1")).resolves.toEqual({
      scheduleId: "screen-1",
      cancelled: true,
    });
  });
});
