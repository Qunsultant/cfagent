/**
 * Issue #3121 #4241 — nightly research run in the single schedule.
 *
 * The nightly research run IS the #354 daily options-research run:
 * POST /research/scheduled-tick, folded into the every-30-minute tick, firing
 * exactly once per weekday (Mon-Fri UTC) at/after 21:00 UTC (guard
 * shouldFireResearchTick + durable marker research_scheduled_last_run).
 * It runs, for the configured service identity: the #319 research run
 * (research + publish), due-run evaluations, discovery if due, and the
 * #1096 screening steps (strategy-bank re-selection proposals,
 * weights-v2, delivery). It already rides the tick today (tickRiders);
 * this slice stores ONE stable record (id nightly-research, kind
 * internal, state paused, monthly interval, callback
 * runResearchSchedule) and lists it with its last run joined from
 * the ledger, so the row reads "Last research: …" — or "never"
 * when the duty has never fired. The fired run writes one ledger
 * row (jobId = record id) from the scheduled-tick handler itself,
 * so the runs routes join without a new store or a new firing
 * mechanism. The old derived record (synthesized at read time,
 * management refused) is deleted: the row renders only when
 * stored, and the verbs operate on the stored row.
 *
 * State note: the Nov-12 definition comment recorded state `disabled`
 * — "firing waits on #4234". #4234 has since landed (55e3e1f): the
 * alarm tick dispatches the research POST on every tick and the
 * route's guard decides fire/no-fire, so the duty IS live through
 * the tick like #4239/#4240 — active, not disabled. No new kind: the
 * record uses `internal`, the #4238 seventh kind for internal-only
 * callbacks. There is no manual trigger route for the research run — the
 * run fires on the tick; the manual research route is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  UNIFIED_SCHEDULE_KINDS,
  type UnifiedScheduleRecord,
} from "../src/data/unifiedSchedulePorts";
import {
  NIGHTLY_RESEARCH_RECORD_ID,
  NIGHTLY_RESEARCH_ORIGIN,
  nightlyResearchRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
  reconcileSystemScheduleRecords,
} from "../src/services/unifiedScheduleManagement";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { scheduleIdToLedgerJobId } from "../src/services/jobRunRecords";
import { nightlyResearchDispatchCron } from "../src/services/researchScheduleGuard";
import { DEFAULT_RESEARCH_JOB_CONFIG } from "../src/config/researchJobConfig";
import { classifyScheduleKind } from "../src/services/scheduleKinds";
import { scheduleTitle } from "../src/client/scheduledOptionsManager/scheduleDetail";
import { recordNightlyResearchLedgerRun } from "../src/agents/routes/screenerResearch";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** node:sqlite double for the SqlStorage seam (same shape as #2337). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  get sql(): SqliteTestStorage {
    return this;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

const NOW = "2026-11-19T07:00:00.000Z";
const RUN_STARTED = "2026-11-19T21:00:00.000Z";
const RUN_FINISHED = "2026-11-19T21:05:00.000Z";
const MONTHLY_SECONDS = 2_592_000;

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

/** A stored nightly-research row, as the seed creates it (state set by the test). */
function storedResearchRecord(
  state: "active" | "paused",
  createdAt = NOW,
): UnifiedScheduleRecord {
  return {
    id: "nightly-research",
    kind: "internal",
    state,
    callback: "runResearchSchedule",
    definition: {
      type: "interval",
      intervalSeconds: MONTHLY_SECONDS,
      callback: "runResearchSchedule",
    } as unknown as UnifiedScheduleRecord["definition"],
    ownerLogin: null,
    provenance: { origin: "system", createdBy: "system", reason: "nightly-research", createdAt },
    alarmId: null,
    pausedAt: state === "paused" ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
  };
}

function alarmsStub(overrides: Record<string, unknown> = {}): any {
  return {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "new-1", callback: "runResearchSchedule" }),
    ...overrides,
  };
}

describe("4241 stored nightly research record", () => {
  it("reconcile seeds the one stable nightly research record (id nightly-research, internal, paused, monthly)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const result = await reconcileSystemScheduleRecords(
      { store, alarms: alarmsStub() },
      NOW,
    );
    expect(result.seeded).toContain("nightly-research");
    const record = await store.get("nightly-research");
    expect(record?.id).toBe("nightly-research");
    expect(NIGHTLY_RESEARCH_RECORD_ID).toBe("nightly-research");
    expect(record?.kind).toBe("internal");
    expect(record?.state).toBe("paused");
    // The stored row fires through the research callback, not the
    // old "nightly-research" callback value the derived record used.
    expect(record?.callback).toBe("runResearchSchedule");
    expect(
      (record?.definition as unknown as Record<string, unknown>).intervalSeconds,
    ).toBe(MONTHLY_SECONDS);
    expect(
      (record?.definition as unknown as Record<string, unknown>).cron,
    ).toBeUndefined();
    expect(record?.provenance.origin).toBe("system");
    expect(record?.provenance.reason).toBe("nightly-research");
    expect(NIGHTLY_RESEARCH_ORIGIN).toBe("nightly-research");
    expect(record?.alarmId).toBeNull();
    expect(record?.createdAt).toBe(NOW);
    expect(record?.updatedAt).toBe(NOW);
  });

  it("reads the cadence from the one resolved config, never re-literalized (#6030)", () => {
    expect(DEFAULT_RESEARCH_JOB_CONFIG.scheduleUtcHour).toBe(21);
    expect(nightlyResearchDispatchCron()).toBe("0 21 * * 1-5");
    // The env moves the guard's cron with the fire hour. The stored
    // row itself is a monthly interval now — the guard cron is the
    // research fire rule, not the stored row's cadence.
    expect(nightlyResearchDispatchCron({ scheduleUtcHour: 22 })).toBe("0 22 * * 1-5");
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("nightly-research");
  });

  it("an in-place update preserves createdAt (upsert, not recreate)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedResearchRecord("active", "2026-11-18T07:00:00.000Z"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "nightly-research", NOW);
    expect(paused.ok).toBe(true);
    const after = await store.get("nightly-research");
    expect(after?.createdAt).toBe("2026-11-18T07:00:00.000Z");
    expect(after?.updatedAt).toBe(NOW);
    expect(after?.pausedAt).toBe(NOW);
    expect(after?.id).toBe("nightly-research");
  });
});

describe("4241 nightly research list item (Schedules home row)", () => {
  it("carries the last run joined from the ledger", () => {
    const record = storedResearchRecord("active");
    const item = nightlyResearchRecordToListItem(record, {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
    });
    expect(item.id).toBe("nightly-research");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("runResearchSchedule");
    // The stored row is a monthly interval, not the old nightly cron.
    expect(item.cron).toBeUndefined();
    expect(item.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunOutcome).toBe("success");
  });

  it("carries no last run when the duty has never fired", () => {
    const item = nightlyResearchRecordToListItem(storedResearchRecord("paused"));
    expect(item.lastRunAt).toBeUndefined();
    expect(item.lastRunOutcome).toBeUndefined();
  });
});

describe("4241 home naming + classifier + ledger join", () => {
  it("names the nightly-research callback 'Scheduled nightly research run'", () => {
    expect(scheduleTitle({ callback: "nightly-research" } as never)).toBe(
      "Scheduled nightly research run",
    );
  });

  it("classifies the nightly-research callback as system upkeep", () => {
    expect(classifyScheduleKind({ callback: "nightly-research" })).toBe("system");
    // The stored row's callback is the research runner, same class.
    expect(classifyScheduleKind({ callback: "runResearchSchedule" })).toBe("system");
  });

  it("resolves the nightly-research record id to its ledger job id (itself)", () => {
    expect(scheduleIdToLedgerJobId("nightly-research")).toBe("nightly-research");
    expect(scheduleIdToLedgerJobId("other-schedule")).toBe("other-schedule");
  });
});

describe("4241 management works on the stored nightly research record (no derived refusal)", () => {
  it("pause pauses a stored active research row", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedResearchRecord("active"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "nightly-research", NOW);
    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.record.state).toBe("paused");
      expect(paused.record.id).toBe("nightly-research");
    }
    expect((await store.get("nightly-research"))?.state).toBe("paused");
  });

  it("resume re-arms a stored paused research row from its own monthly timing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedResearchRecord("paused"));
    const arm = vi.fn(async () => ({ id: "alarm-9", callback: "runResearchSchedule" }));
    const resumed = await resumeUnifiedSchedule(
      { store, alarms: alarmsStub({ arm }) },
      "nightly-research",
      NOW,
    );
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.record.state).toBe("active");
      expect(resumed.record.alarmId).toBe("alarm-9");
    }
    expect(arm).toHaveBeenCalledTimes(1);
    const [timing] = arm.mock.calls[0] as unknown as Array<Record<string, unknown>>;
    expect(timing).toEqual({ type: "interval", intervalSeconds: MONTHLY_SECONDS });
  });

  it("trigger runs a stored active research row and stamps triggered, not manual", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save({ ...storedResearchRecord("active"), alarmId: "alarm-1" });
    const seen: Array<{ callback: string; payload: unknown }> = [];
    const triggered = await triggerUnifiedSchedule(
      {
        store,
        alarms: alarmsStub({
          get: async () => ({ id: "alarm-1", callback: "runResearchSchedule", payload: {} }),
        }),
      },
      "nightly-research",
      async (callback: string, payload: unknown) => {
        seen.push({ callback, payload });
      },
    );
    expect(triggered.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].callback).toBe("runResearchSchedule");
    expect((seen[0].payload as Record<string, unknown>).trigger).toBe("triggered");
  });

  it("update re-times a stored paused research row without an alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedResearchRecord("paused"));
    const updated = await updateUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "nightly-research",
      { intervalSeconds: MONTHLY_SECONDS * 2 },
      Date.parse(NOW),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.record.state).toBe("paused");
      const def = updated.record.definition as unknown as Record<string, unknown>;
      expect(def.intervalSeconds).toBe(MONTHLY_SECONDS * 2);
      expect(updated.record.createdAt).toBe(NOW);
    }
  });

  it("delete removes a stored research row and it stays gone", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedResearchRecord("paused"));
    const deleted = await deleteUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "nightly-research",
    );
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.cancelled).toBe(true);
    expect(await store.get("nightly-research")).toBeUndefined();
  });

  it("a missing research row 404s every verb, never a derived refusal", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    // The strict alarms port: cancelling an unknown id is false
    // (nothing was there), like the real port's contract.
    const deps = { store, alarms: alarmsStub({ cancel: async () => false }) };
    const cases: Array<{ result: Awaited<ReturnType<typeof pauseUnifiedSchedule>>; message: string }> = [
      { result: await pauseUnifiedSchedule(deps, "nightly-research", NOW), message: "not found" },
      { result: await resumeUnifiedSchedule(deps, "nightly-research", NOW), message: "is not paused" },
      { result: await deleteUnifiedSchedule(deps, "nightly-research"), message: "not found" },
      { result: await triggerUnifiedSchedule(deps, "nightly-research", async () => {}), message: "not found" },
      {
        result: await updateUnifiedSchedule(deps, "nightly-research", { intervalSeconds: MONTHLY_SECONDS }, Date.parse(NOW)),
        message: "not found",
      },
    ];
    for (const { result, message } of cases) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.error).toContain("nightly-research");
        expect(result.error).toContain(message);
        expect(result.error).not.toContain("derived");
      }
    }
  });
});

describe("4241 fired run writes one ledger row (jobId = record id)", () => {
  it("records the run with the record id as jobId and scheduleId", async () => {
    // Issue #6101 — the row lands in D1, not the DO.
    const d1 = new MockD1Database();
    const store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
    await recordNightlyResearchLedgerRun(store, RUN_STARTED, RUN_FINISHED);
    const latest = await store.latestByJob(NIGHTLY_RESEARCH_RECORD_ID);
    expect(latest).not.toBeNull();
    expect(latest?.jobId).toBe("nightly-research");
    expect(latest?.scheduleId).toBe("nightly-research");
    expect(latest?.operation).toBe("nightly-research");
    expect(latest?.system).toBe("orchestrator-schedule");
    expect(latest?.outcome).toBe("success");
    expect(latest?.triggeredBy).toBe("scheduled");
    expect(latest?.started).toBe(RUN_STARTED);
    expect(latest?.finished).toBe(RUN_FINISHED);
  });

  it("is a no-op without a store and never throws on a broken store", async () => {
    await expect(
      recordNightlyResearchLedgerRun(null, RUN_STARTED, RUN_FINISHED),
    ).resolves.toBeUndefined();
    await expect(
      recordNightlyResearchLedgerRun(undefined, RUN_STARTED, RUN_FINISHED),
    ).resolves.toBeUndefined();
    const broken = {
      record: async () => {
        throw new Error("d1 down");
      },
    };
    await expect(
      recordNightlyResearchLedgerRun(broken as never, RUN_STARTED, RUN_FINISHED),
    ).resolves.toBeUndefined();
  });
});

describe("4241 list route reads the stored nightly research row (no synthesis)", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;
  let d1: MockD1Database;

  function baseCtx(overrides: Partial<SchedulesRouteContext> = {}): SchedulesRouteContext {
    return {
      env: { AGENT_DB: d1 },
      agentCtx: { storage: { sql: sql.sql as never } } as never,
      audit: vi.fn(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
      ...overrides,
    } as unknown as SchedulesRouteContext;
  }

  async function seedNightlyResearchRun() {
    // Issue #6101 — the seed lands in D1 (the describe's mock binding).
    const store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
    await recordNightlyResearchLedgerRun(store, RUN_STARTED, RUN_FINISHED);
  }

  /** The stored research row the list renders (D1 only, #6503 fail-closed). */
  async function seedStoredResearchRow() {
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    // Paused: the seed default — and the list renders a stored row
    // from the store only when paused (an active row renders
    // through its live alarm, which this fixture has none of).
    await store.save(storedResearchRecord("paused"));
  }

  beforeEach(async () => {
    sql = new SqliteTestStorage();
    d1 = new MockD1Database();
    ctx = baseCtx();
    await seedStoredResearchRow();
  });

  async function list() {
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", ctx);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { schedules: Array<Record<string, unknown>> };
  }

  it("shows the stored nightly research row with its last run when the ledger has a run", async () => {
    await seedNightlyResearchRun();
    const body = await list();
    const row = body.schedules.find((s) => s.id === "nightly-research");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("internal");
    expect(row?.callback).toBe("runResearchSchedule");
    expect(row?.cron).toBeUndefined();
    expect(row?.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(row?.state).toBe("paused");
    expect(row?.lastRunAt).toBe(RUN_STARTED);
    expect(row?.lastRunOutcome).toBe("success");
  });

  it("shows the stored row with no last run when the duty has never fired", async () => {
    const body = await list();
    const row = body.schedules.find((s) => s.id === "nightly-research");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });

  it("keeps the stored row without a last run (list still 200) when the ledger read throws", async () => {
    // The ledger read fails but the unified-store list still works:
    // only job_run_records queries throw. The stored row renders
    // without its last run — a ledger failure never drops a row.
    // Issue #6101 — the ledger read is a D1 read now, so the
    // failure is injected on the D1 binding, not the DO sql.
    const throwingD1 = {
      prepare: (sqlText: string) => {
        if (sqlText.includes("job_run_records")) throw new Error("d1 down");
        return d1.prepare(sqlText);
      },
      batch: (stmts: never[]) => d1.batch(stmts),
    };
    const throwing = baseCtx({
      env: { AGENT_DB: throwingD1 },
    });
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", throwing);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { schedules: Array<Record<string, unknown>> };
    const row = body.schedules.find((s) => s.id === "nightly-research");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });
});

describe("4241 runs routes join the nightly research record to its ledger rows", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;
  let d1: MockD1Database;

  function baseCtx(): SchedulesRouteContext {
    return {
      // Issue #6101 — the runs routes read the D1 ledger.
      env: { AGENT_DB: d1 },
      agentCtx: { storage: { sql: sql.sql as never } } as never,
      audit: vi.fn(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
    } as unknown as SchedulesRouteContext;
  }

  beforeEach(async () => {
    sql = new SqliteTestStorage();
    d1 = new MockD1Database();
    ctx = baseCtx();
    const store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
    await recordNightlyResearchLedgerRun(store, RUN_STARTED, RUN_FINISHED);
  });

  async function call(path: string, url = `https://agent.internal${path}`) {
    return handleSchedulesRoutes(
      new Request(url, { method: "GET" }),
      new URL(url),
      path,
      "session-1",
      ctx,
    );
  }

  it("GET /schedules/nightly-research/runs returns the nightly research ledger rows", async () => {
    const res = await call("/schedules/nightly-research/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("nightly-research");
  });

  it("GET /schedules/runs?scheduleId=nightly-research returns the same rows", async () => {
    const res = await call("/schedules/runs", "https://agent.internal/schedules/runs?scheduleId=nightly-research");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("nightly-research");
  });
});

describe("4241 detail route answers the stored nightly research record", () => {
  it("GET /api/schedules/nightly-research returns the stored detail, not 404", async () => {
    const sql = new SqliteTestStorage();
    const d1 = new MockD1Database();
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    await store.save(storedResearchRecord("active"));
    const ctx = {
      env: { AGENT_DB: d1 },
      agentCtx: { storage: { sql: sql.sql as never } } as never,
      audit: vi.fn(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
    } as unknown as SchedulesRouteContext;
    const path = "/api/schedules/nightly-research";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method: "GET" }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    const detail = data.schedule ?? data;
    expect(detail.id).toBe("nightly-research");
    expect(detail.callback).toBe("runResearchSchedule");
  });
});

describe("4241 Schedules home renders the nightly research row (source pins)", () => {
  it("the panel names the nightly research row and shows its last run", () => {
    const panel = source("src/client/SchedulesPanel.tsx");
    expect(panel).toContain("Last research");
    expect(panel).toContain('s.id === "nightly-research"');
  });

  it("no new firing: the research run rides the stored schedule, not a tick rider (#6299)", () => {
    const riders = source("src/services/tickRiders.ts");
    // Issue #6299 — the rider is RETIRED. Before it, this pin asserted the
    // tick DID dispatch the research route; now the absence is the guarantee:
    // one scheduler (the stored schedule record), no second firing mechanism.
    // The URL still appears in the retirement comment, so the guarantee is
    // pinned on the CALL: no dispatch to the research route from this tick.
    expect(riders).not.toContain('new Request("https://agent.internal/research/scheduled-tick"');
    // The slice adds no Worker cron and no SDK alarm for the research run.
    const guard = source("src/services/researchScheduleGuard.ts");
    // #6030 — one declaration: the cron is derived from the config hour,
    // and no second fire-hour literal exists in the guard.
    expect(guard).toContain("export function nightlyResearchDispatchCron(");
    expect(guard).toContain("config.scheduleUtcHour");
    expect(guard).not.toContain("RESEARCH_SCHEDULED_FIRE_HOUR_UTC");
    expect(guard).not.toContain("NIGHTLY_RESEARCH_DISPATCH_CRON =");
    // The fired run is recorded in the ledger from the scheduled-tick
    // handler, after the durable marker write.
    const route = source("src/agents/routes/screenerResearch.ts");
    expect(route).toContain("recordNightlyResearchLedgerRun");
  });
});
