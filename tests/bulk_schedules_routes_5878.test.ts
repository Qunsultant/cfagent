/**
 * Issue #5878 — bulk pause / resume / run-now routes: POST
 * /api/schedules/pause, /resume and /trigger with `{ scope }`.
 * Exercised directly against handleSchedulesRoutes with the same
 * stub SchedulesRouteContext as the single-row route tests
 * (tests/schedules_manage_routes.test.ts): an in-memory schedule
 * map and a MockSqlStorage paused store.
 *
 * Issue #6503 — the unified store is D1 only (fail-closed), so
 * the six system duties are stored rows seeded into a MockD1
 * AGENT_DB, and the list reads the store only.
 *
 * Pins: the bulk branch runs before the single-row branch (the
 * literal id "pause" is never read as a schedule id); an invalid
 * scope is a 400 that runs nothing; a scope filters to its kind;
 * the summary reports per-row outcomes; each acted row gets its
 * single-row audit event plus one bulk audit event; the batch
 * never fails on a refused row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";
import { MockSqlStorage } from "./mock-sql";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import {
  pausedScreenScheduleToRecord,
  tickerPushScheduleToRecord,
} from "../src/services/unifiedScheduleManagement";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";

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
let d1: MockD1Database;

/** Minimal D1Database stand-in over node:sqlite (same as the #6503 repro). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

const NOW = "2026-11-21T10:00:00.000Z";

/**
 * Issue #6503 step 8 (G1) — bulk verbs are control ops, so the
 * fixture calls them as a platform-admin: the 'all'/'system'
 * scopes touch platform-level rows (platform-admin only) and the
 * kind scopes need a platform- or tenant-admin. Alias KV +
 * membership store stubs, same shape as
 * tests/schedule-6482-runaway-alarm-loop.test.ts.
 */
const ADMIN_LOGIN = "venus-admin";
const ADMIN_USER_ID = "user-admin-1";

function stubKv(entries: Record<string, string>) {
  const store = new Map<string, string>();
  for (const [login, userId] of Object.entries(entries)) {
    store.set(`iaaa-alias:login:${login}`, JSON.stringify({ internalUserId: userId }));
  }
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function stubMembershipStore(adminIds: string[]) {
  return {
    getMembershipsByUser: async (internalUserId: string) =>
      adminIds.includes(internalUserId)
        ? [
            {
              membershipId: "m-admin-1",
              internalUserId,
              tenantId: "platform",
              roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
              createdBy: "test",
              createdAtMs: 1,
            },
          ]
        : [],
    put: async () => {},
    revokeMembership: async () => false,
  };
}

/** The six stored system rows (#6503), seeded PAUSED like the seed creates them. */
const STORED_SYSTEM_IDS = [
  "token-renewal",
  "retention",
  "nightly-research",
  "sweep-stale-ledger-tasks",
  "sweep-stale-async-jobs",
  "schedule-watchdog",
] as const;

const SYSTEM_CALLBACKS: Record<string, string> = {
  "token-renewal": "autoRenewETradeTokens",
  retention: "retention",
  "nightly-research": "runResearchSchedule",
  "sweep-stale-ledger-tasks": "sweepStaleLedgerTasks",
  "sweep-stale-async-jobs": "sweepStaleAsyncJobs",
  "schedule-watchdog": "watchdogMissedSchedules",
};

function storedSystemRecord(id: (typeof STORED_SYSTEM_IDS)[number]): UnifiedScheduleRecord {
  return {
    id,
    kind: "internal",
    state: "paused",
    callback: SYSTEM_CALLBACKS[id],
    definition: {
      type: "interval",
      intervalSeconds: 2_592_000,
      callback: SYSTEM_CALLBACKS[id],
    } as unknown as UnifiedScheduleRecord["definition"],
    ownerLogin: null,
    provenance: { origin: "system", createdBy: "system", reason: id, createdAt: NOW },
    alarmId: null,
    pausedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Seed the six stored rows and clear the migration-seeded goal rows (else exact counts break). */
async function seedStoredSystemRows() {
  const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
  for (const id of STORED_SYSTEM_IDS) {
    await store.save(storedSystemRecord(id));
  }
  for (const goal of await store.listByKind("goal")) {
    await store.remove(goal.id);
  }
}

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

beforeEach(async () => {
  schedules = new Map();
  seq = 0;
  callbackRuns = [];
  sql = new MockSqlStorage();
  d1 = new MockD1Database();
  seed();
  await seedStoredSystemRows();
  ctx = {
    // Issue #6503 — the unified store is D1 only (fail-closed).
    env: { AGENT_DB: d1 },
    agentCtx: { storage: { sql } },
    audit: vi.fn(),
    // Issue #6503 step 9 (G2) — the bulk verbs audit-before-write
    // through this store; without it the wired fallback (no
    // SESSION_STORE in tests) blocks every bulk op with 503.
    auditStore: createMemoryAuditStore(),
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
    flagAliasKv: stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID }),
    flagMembershipStore: stubMembershipStore([ADMIN_USER_ID]),
  };
});

async function call(method: string, path: string, body?: unknown) {
  const request = new Request(`https://example.test${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      // Issue #6503 step 8 (G1) — bulk verbs are control ops: the
      // fixture calls as the platform-admin (see above).
      "x-user-login": ADMIN_LOGIN,
    },
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

/**
 * Issue #6503 step 14b — a live ticker-push feed for the bulk
 * exclusion pin: the namespace answers getTickerPushRecord with an
 * ACTIVE record (armed, never paused) and spies on every feed
 * control RPC, so the test can prove a bulk verb never dispatches
 * the feed. Same namespace shape as
 * tests/schedule-3121-4237-ticker-push.test.ts.
 */
function fakeTickerNamespace(spies: {
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  trigger: ReturnType<typeof vi.fn>;
}) {
  const record = tickerPushScheduleToRecord(
    { intervalSeconds: 3000, armed: true, lastPushAt: new Date().toISOString() },
    new Date(Date.now() - 1000).toISOString(),
  );
  return {
    idFromName: (_name: string) => "ticker-id",
    get: (_id: unknown) => ({
      getTickerPushRecord: async () => record,
      pauseTickerPush: spies.pause,
      resumeTickerPush: spies.resume,
      triggerTickerPush: spies.trigger,
      setTickerPushInterval: async (intervalSeconds: number) => ({
        ok: true as const,
        intervalSeconds,
      }),
    }),
  };
}

/** Bind the live feed into the fixture ctx and return the feed RPC spies. */
function withLiveFeed() {
  const spies = {
    pause: vi.fn(async () => ({ ok: true as const })),
    resume: vi.fn(async () => ({ ok: true as const })),
    trigger: vi.fn(async () => ({ ok: true as const })),
  };
  ctx.env = { AGENT_DB: d1, TICKER_AGENT: fakeTickerNamespace(spies) };
  return spies;
}

describe("bulk pause / resume / trigger routes (#5878)", () => {
  it("lists the managed rows plus the six stored system rows", async () => {
    const ids = await listIds();
    expect(ids).toContain("job-cron");
    expect(ids).toContain("job-interval");
    for (const stored of STORED_SYSTEM_IDS) {
      expect(ids).toContain(stored);
    }
    expect(ids).toHaveLength(8);
  });

  it("bulk pause over all pauses the managed rows and reports the stored rows already-paused", async () => {
    const res = await call("POST", "/api/schedules/pause", { scope: "all" });
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.verb).toBe("pause");
    expect(body.scope).toBe("all");
    expect(body.total).toBe(8);
    expect(body.applied).toBe(2);
    expect(body.already).toBe(6);
    expect(body.refused).toBe(0);
    expect(body.results.map((r: any) => [r.id, r.outcome])).toEqual([
      ["job-interval", "paused"],
      ["job-cron", "paused"],
      ["nightly-research", "already-paused"],
      ["retention", "already-paused"],
      ["schedule-watchdog", "already-paused"],
      ["sweep-stale-async-jobs", "already-paused"],
      ["sweep-stale-ledger-tasks", "already-paused"],
      ["token-renewal", "already-paused"],
    ]);
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
    expect(bulk[0]).toMatchObject({ scope: "all", total: 8, applied: 2, already: 6, refused: 0 });
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

  it("bulk pause over the system kind reports the six stored rows already-paused", async () => {
    // The six are seeded PAUSED (the state the list renders them
    // in), so a pause over their scope applies nothing and refuses
    // nothing — every row is already-paused.
    const res = await call("POST", "/api/schedules/pause", { scope: "system" });
    const body = await res!.json();
    expect(body.total).toBe(6);
    expect(body.applied).toBe(0);
    expect(body.already).toBe(6);
    expect(body.refused).toBe(0);
    expect(body.results.map((r: any) => [r.id, r.outcome])).toEqual([
      ["nightly-research", "already-paused"],
      ["retention", "already-paused"],
      ["schedule-watchdog", "already-paused"],
      ["sweep-stale-async-jobs", "already-paused"],
      ["sweep-stale-ledger-tasks", "already-paused"],
      ["token-renewal", "already-paused"],
    ]);
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
    expect(body.applied).toBe(8);
    expect(body.refused).toBe(0);
    expect(body.results.map((r: any) => [r.id, r.outcome])).toEqual([
      ["nightly-research", "resumed"],
      ["retention", "resumed"],
      ["schedule-watchdog", "resumed"],
      ["sweep-stale-async-jobs", "resumed"],
      ["sweep-stale-ledger-tasks", "resumed"],
      ["token-renewal", "resumed"],
      ["job-cron", "resumed"],
      ["job-interval", "resumed"],
    ]);
    // Resume re-arms under new SDK alarm ids (the record id is
    // stable, only the alarm changes — #3123-P03): the map holds
    // eight re-armed alarms, and the list shows the managed rows active.
    expect(schedules.size).toBe(8);
    const list = await (await call("GET", "/api/schedules"))!.json();
    for (const id of ["job-cron", "job-interval"]) {
      const row = list.schedules.find((s: any) => s.id === id);
      expect(row).toBeTruthy();
      expect(row.paused).toBe(false);
    }
    expect(auditEvents("schedule.resumed")).toHaveLength(8);
    expect(auditEvents("schedule.bulk-resumed")).toHaveLength(1);
  });

  it("bulk resume refuses a sub-monthly paused row per row while resuming monthly rows (#6482)", async () => {
    // A paused sub-monthly record, seeded directly in the D1
    // unified store (it has no live alarm — the floor governs arms,
    // and resume is an arm).
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
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
    await store.save(subMonthly);
    await call("POST", "/api/schedules/pause", { scope: "all" });
    (ctx.audit as any).mockClear();
    const res = await call("POST", "/api/schedules/resume", { scope: "all" });
    const body = await res!.json();
    expect(body.total).toBe(9);
    expect(body.applied).toBe(8);
    expect(body.refused).toBe(1);
    expect(body.results.find((r: any) => r.id === "job-interval")?.outcome).toBe("resumed");
    expect(body.results.find((r: any) => r.id === "job-cron")?.outcome).toBe("resumed");
    const refusedRow = body.results.find((r: any) => r.id === subMonthly.id);
    expect(refusedRow?.outcome).toBe("refused");
    expect(refusedRow?.reason).toContain("SCHEDULE_BELOW_FREQUENCY_FLOOR");
    // The monthly rows re-armed; the sub-monthly row stays paused.
    expect(schedules.size).toBe(8);
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

  it("bulk trigger runs the active rows and refuses paused rows", async () => {
    // Resume first so the six stored rows hold live alarms (a
    // paused row refuses trigger), then pause only job-cron.
    await call("POST", "/api/schedules/resume", { scope: "all" });
    await call("POST", "/api/schedules/job-cron/pause");
    (ctx.audit as any).mockClear();
    callbackRuns.length = 0;
    const res = await call("POST", "/api/schedules/trigger", { scope: "all" });
    const body = await res!.json();
    expect(body.total).toBe(8);
    expect(body.applied).toBe(7);
    expect(body.refused).toBe(1);
    expect(body.results.find((r: any) => r.id === "job-interval")?.outcome).toBe("triggered");
    expect(body.results.find((r: any) => r.id === "job-cron")?.outcome).toBe("refused");
    expect(body.results.find((r: any) => r.id === "job-cron")?.reason).toContain("paused");
    // The stored rows trigger through their re-armed alarms, in
    // list order: the live-alarm rows first (by id), then the
    // paused job-cron row, which refuses.
    expect(callbackRuns.map((r) => r.callback)).toEqual([
      "autonomousOptionsAnalysis",
      "runResearchSchedule",
      "retention",
      "watchdogMissedSchedules",
      "sweepStaleAsyncJobs",
      "sweepStaleLedgerTasks",
      "autoRenewETradeTokens",
    ]);
    expect(auditEvents("schedule.triggered").map((e) => e.scheduleId)).toEqual([
      "job-interval",
      "nightly-research",
      "retention",
      "schedule-watchdog",
      "sweep-stale-async-jobs",
      "sweep-stale-ledger-tasks",
      "token-renewal",
    ]);
    expect(auditEvents("schedule.bulk-triggered")).toHaveLength(1);
  });

  it("bulk verbs over a list with the live feed never touch the feed (#6503 step 14b)", async () => {
    // Step 14 reclassified ticker-push as a feed, not a schedule:
    // the home renders it as a feed card outside the table, so a
    // bulk scope must never name it — not "all", and not the
    // "system" kind it classifies as (catalogue kind: system).
    const feed = withLiveFeed();

    // The GET list still carries the feed row: the feed card reads
    // from this route, and step 14b changes the bulk verb only.
    const listed = await listIds();
    expect(listed).toHaveLength(9);
    expect(listed).toContain("ticker-push");

    // The "system" kind scope names the six stored system rows
    // only — the feed classifies as system, so a kind filter
    // alone would still match it.
    const systemRes = await call("POST", "/api/schedules/pause", { scope: "system" });
    const systemBody = await systemRes!.json();
    expect(systemBody.total).toBe(6);
    expect(systemBody.applied).toBe(0);
    expect(systemBody.already).toBe(6);
    expect(systemBody.results.map((r: any) => r.id)).not.toContain("ticker-push");
    expect(feed.pause).not.toHaveBeenCalled();

    // Pause-all pauses the two managed rows, reports the six
    // stored rows already-paused, and never pauses the feed.
    const pauseRes = await call("POST", "/api/schedules/pause", { scope: "all" });
    expect(pauseRes?.status).toBe(200);
    const pauseBody = await pauseRes!.json();
    expect(pauseBody.total).toBe(8);
    expect(pauseBody.applied).toBe(2);
    expect(pauseBody.already).toBe(6);
    expect(pauseBody.refused).toBe(0);
    expect(pauseBody.results.map((r: any) => r.id)).not.toContain("ticker-push");
    expect(feed.pause).not.toHaveBeenCalled();
    // The bulk audit names schedules only, and the feed row is
    // still listed, active — its state/alarm untouched.
    const bulkPause = auditEvents("schedule.bulk-paused");
    expect(bulkPause).toHaveLength(2);
    expect(bulkPause[1]).toMatchObject({ scope: "all", total: 8, applied: 2, already: 6, refused: 0 });
    expect((bulkPause[1] as any).scheduleIds).toHaveLength(8);
    expect((bulkPause[1] as any).scheduleIds).not.toContain("ticker-push");
    expect(auditEvents("schedule.paused").map((e) => e.scheduleId)).not.toContain("ticker-push");
    const afterPause = await (await call("GET", "/api/schedules"))!.json();
    const feedRow = afterPause.schedules.find((s: any) => s.id === "ticker-push");
    expect(feedRow).toBeTruthy();
    expect(feedRow.paused).toBe(false);

    // Resume-all re-arms the eight schedules; the feed's resume
    // RPC is never called.
    const resumeRes = await call("POST", "/api/schedules/resume", { scope: "all" });
    const resumeBody = await resumeRes!.json();
    expect(resumeBody.total).toBe(8);
    expect(resumeBody.applied).toBe(8);
    expect(resumeBody.results.map((r: any) => r.id)).not.toContain("ticker-push");
    expect(feed.resume).not.toHaveBeenCalled();

    // Trigger-all runs the eight schedules; the feed is never triggered.
    callbackRuns.length = 0;
    const triggerRes = await call("POST", "/api/schedules/trigger", { scope: "all" });
    const triggerBody = await triggerRes!.json();
    expect(triggerBody.total).toBe(8);
    expect(triggerBody.applied).toBe(8);
    expect(triggerBody.refused).toBe(0);
    expect(triggerBody.results.map((r: any) => r.id)).not.toContain("ticker-push");
    expect(feed.trigger).not.toHaveBeenCalled();
  });

  it("the bulk path never reads 'pause' as a schedule id", async () => {
    const res = await call("POST", "/api/schedules/pause", { scope: "stocks" });
    expect(res?.status).toBe(200);
    const body = await res!.json();
    expect(body.success).toBe(true);
    expect(body.results.map((r: any) => r.id)).toEqual(["job-cron"]);
  });
});
