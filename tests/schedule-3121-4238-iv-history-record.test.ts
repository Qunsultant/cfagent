/**
 * Issue #4238 — IV history collection in the single schedule.
 *
 * collectIvHistory is an internal-only callback: its runs land in the
 * ledger via the #3394 internal-callback recording, but it has no
 * unified-store record and no Schedules-home visibility. After this
 * slice, the armed IV alarm is adopted into the unified store as an
 * `internal`-kind record (system origin, record id = alarm id), the
 * home lists it under its friendly name with its cadence, its runs
 * join in the ledger by schedule id, and pause/resume/delete/trigger/
 * update work through the one management path. Record-only: nothing
 * is armed, cancelled, or re-armed here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

// Issue #1738: OrchestratorAgent is an Agents SDK actor now — mock the SDK
// with a plain base class (the api_chat_route.test.ts idiom) so the real
// module graph's `cloudflare:` imports never reach the node loader.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import { UNIFIED_SCHEDULE_KINDS } from "../src/data/unifiedSchedulePorts";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import {
  IV_HISTORY_COLLECTION_ORIGIN,
  ivHistoryCollectionToRecord,
  deleteUnifiedSchedule,
  listUnifiedScheduleItems,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
  type ScheduleAlarmLike,
} from "../src/services/unifiedScheduleManagement";
import { classifyScheduleKind } from "../src/services/scheduleKinds";
import { scheduleTitle } from "../src/client/scheduledOptionsManager/scheduleDetail";
import { MockSqlStorage } from "./mock-sql";

const NOW_ISO = "2026-11-18T10:30:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const IV_CRON = "15 22 * * 1-5";
const IV_PAYLOAD = {
  userLogin: "venus",
  environment: "PROD",
  trigger: "scheduled",
};

function ivAlarm(overrides: Partial<ScheduleAlarmLike> = {}): ScheduleAlarmLike {
  return {
    id: "iv-1",
    callback: "collectIvHistory",
    type: "cron",
    cron: IV_CRON,
    payload: IV_PAYLOAD,
    ...overrides,
  };
}

function ivRecord(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "iv-1",
    kind: "internal",
    state: "active",
    callback: "collectIvHistory",
    definition: {
      type: "cron",
      callback: "collectIvHistory",
      payload: {
        ...IV_PAYLOAD,
        provenance: {
          origin: "system",
          createdBy: "system",
          reason: IV_HISTORY_COLLECTION_ORIGIN,
          createdAt: NOW_ISO,
        },
      },
      cron: IV_CRON,
    },
    ownerLogin: "venus",
    provenance: {
      origin: "system",
      createdBy: "system",
      reason: IV_HISTORY_COLLECTION_ORIGIN,
      createdAt: NOW_ISO,
    },
    alarmId: "iv-1",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

/** An alarms port with the real contract: a cancelled alarm is gone. */
function alarmsPort(
  overrides: {
    list?: () => Promise<ScheduleAlarmLike[]>;
    get?: (id: string) => Promise<ScheduleAlarmLike | undefined>;
    arm?: (...args: unknown[]) => Promise<{ id: string }>;
  } = {},
) {
  const cancelled: string[] = [];
  const armed: unknown[] = [];
  const gone = new Set<string>();
  return {
    cancelled,
    armed,
    port: {
      list: overrides.list ?? (async () => [] as ScheduleAlarmLike[]),
      get: async (id: string) => {
        if (gone.has(id)) return undefined;
        return overrides.get ? overrides.get(id) : undefined;
      },
      cancel: async (id: string) => {
        cancelled.push(id);
        gone.add(id);
        return true;
      },
      arm: async (...args: unknown[]) => {
        armed.push(args);
        return { id: "new-alarm-1" };
      },
    },
  };
}

describe("ivHistoryCollectionToRecord (#4238)", () => {
  it("builds an internal record with the system origin on the record and the payload", () => {
    const record = ivHistoryCollectionToRecord(
      ivAlarm(),
      { userLogin: "venus", cron: IV_CRON },
      NOW_ISO,
    );
    expect(record.id).toBe("iv-1");
    expect(record.kind).toBe("internal");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("collectIvHistory");
    expect(record.alarmId).toBe("iv-1");
    expect(record.ownerLogin).toBe("venus");
    expect(record.definition).toEqual({
      type: "cron",
      callback: "collectIvHistory",
      payload: {
        ...IV_PAYLOAD,
        provenance: {
          origin: "system",
          createdBy: "system",
          reason: IV_HISTORY_COLLECTION_ORIGIN,
          createdAt: NOW_ISO,
        },
      },
      cron: IV_CRON,
    });
    expect(record.provenance).toEqual({
      origin: "system",
      createdBy: "system",
      reason: IV_HISTORY_COLLECTION_ORIGIN,
      createdAt: NOW_ISO,
    });
    expect(record.createdAt).toBe(NOW_ISO);
    expect(record.updatedAt).toBe(NOW_ISO);
  });

  it("keeps an already-stamped payload provenance instead of restamping", () => {
    const stamped = {
      ...IV_PAYLOAD,
      provenance: {
        origin: "system",
        createdBy: "system",
        reason: IV_HISTORY_COLLECTION_ORIGIN,
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    };
    const record = ivHistoryCollectionToRecord(
      ivAlarm({ payload: stamped }),
      { userLogin: "venus", cron: IV_CRON },
      NOW_ISO,
    );
    expect(
      (record.definition.payload as { provenance: { createdAt: string } }).provenance.createdAt,
    ).toBe("2026-11-01T00:00:00.000Z");
  });

  it("an existing record keeps its creation time", () => {
    const record = ivHistoryCollectionToRecord(
      ivAlarm(),
      { userLogin: "venus", cron: IV_CRON },
      NOW_ISO,
      ivRecord({ createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }),
    );
    expect(record.createdAt).toBe("2026-11-01T00:00:00.000Z");
    expect(record.updatedAt).toBe(NOW_ISO);
  });
});

describe("internal is the seventh unified-store kind (#4238)", () => {
  it("declares internal in the kind union", () => {
    expect((UNIFIED_SCHEDULE_KINDS as readonly string[])).toContain("internal");
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
  });

  it("classifies an IV schedule under the system family for the home filter", () => {
    expect(classifyScheduleKind({ callback: "collectIvHistory", type: "cron" })).toBe("system");
  });

  it("names the IV job for the Schedules home without touching the manager registry", () => {
    // The system-job registry stays the three screening jobs (pinned in
    // scheduled_options_manager.test.ts, which also pins no trigger route
    // for collectIvHistory); the home names the IV row via scheduleTitle.
    expect(scheduleTitle({ callback: "collectIvHistory" } as never)).toBe("Scheduled IV collection");
  });
});

describe("ensureIvHistoryCollectionRecord adopts the armed IV alarm (#4238)", () => {
  let scheduleCalls: unknown[];
  let cancelCalls: unknown[];
  let existing: unknown[];
  let sql: MockSqlStorage;
  let agent: any;

  beforeEach(() => {
    scheduleCalls = [];
    cancelCalls = [];
    existing = [];
    sql = new MockSqlStorage();
    agent = Object.create(OrchestratorAgent.prototype);
    agent.ctx = { storage: { sql }, id: { toString: () => "iv-history-test" } };
    agent.env = {};
    agent.listSchedules = async () => existing;
    agent.schedule = async (...args: unknown[]) => {
      scheduleCalls.push(args);
      return { id: "mock-schedule" };
    };
    agent.cancelSchedule = async (id: string) => {
      cancelCalls.push(id);
      return true;
    };
    agent.audit = () => {};
  });

  it("adopts an existing IV alarm into the store without arming or cancelling", async () => {
    existing = [ivAlarm()];
    await agent.ensureIvHistoryCollectionRecord({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toHaveLength(0);
    const store = new SqlUnifiedScheduleStore(sql as any);
    const record = store.get("iv-1");
    expect(record).toBeDefined();
    expect(record?.kind).toBe("internal");
    expect(record?.state).toBe("active");
    expect(record?.callback).toBe("collectIvHistory");
    expect(record?.ownerLogin).toBe("venus");
    expect(record?.alarmId).toBe("iv-1");
    expect(record?.provenance).toEqual(
      expect.objectContaining({ origin: "system", reason: IV_HISTORY_COLLECTION_ORIGIN }),
    );
    expect((record?.definition as { cron?: string }).cron).toBe(IV_CRON);
    expect(store.listByKind("internal").map((r) => r.id)).toEqual(["iv-1"]);
  });

  it("does not adopt a record that already exists (no duplicate save churn)", async () => {
    existing = [ivAlarm()];
    const store = new SqlUnifiedScheduleStore(sql as any);
    store.save(ivRecord({ createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }));
    await agent.ensureIvHistoryCollectionRecord({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    expect(store.get("iv-1")?.createdAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("does not adopt a second record for an alarm a resumed record already points at", async () => {
    // A pause/resume cycle keeps the record id and re-arms under a new
    // alarm id: the live alarm's id is the record's alarmId, not its id.
    existing = [ivAlarm({ id: "iv-2" })];
    const store = new SqlUnifiedScheduleStore(sql as any);
    store.save(ivRecord({ id: "iv-1", alarmId: "iv-2", createdAt: "2026-11-01T00:00:00.000Z" }));
    await agent.ensureIvHistoryCollectionRecord({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
    expect(store.get("iv-1")?.alarmId).toBe("iv-2");
  });

  it("adopts nothing when no IV alarm exists, and arms nothing", async () => {
    await agent.ensureIvHistoryCollectionRecord({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toHaveLength(0);
    const store = new SqlUnifiedScheduleStore(sql as any);
    expect(store.list()).toHaveLength(0);
  });

  it("does not adopt another user's IV alarm", async () => {
    existing = [ivAlarm({ payload: { ...IV_PAYLOAD, userLogin: "other" } })];
    await agent.ensureIvHistoryCollectionRecord({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    const store = new SqlUnifiedScheduleStore(sql as any);
    expect(store.list()).toHaveLength(0);
  });

  it("adopts nothing for a non-cron IV alarm (not the known shape)", async () => {
    existing = [
      {
        id: "iv-1",
        callback: "collectIvHistory",
        type: "interval",
        intervalSeconds: 3600,
        payload: IV_PAYLOAD,
      },
    ];
    await agent.ensureIvHistoryCollectionRecord({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    const store = new SqlUnifiedScheduleStore(sql as any);
    expect(store.list()).toHaveLength(0);
  });

  it("adoption still succeeds when the unified store is unavailable", async () => {
    existing = [ivAlarm()];
    agent.ctx = {
      storage: {
        sql: {
          exec: () => {
            throw new Error("unified store unavailable in this harness");
          },
        },
      },
      id: { toString: () => "iv-history-test" },
    };
    await agent.ensureIvHistoryCollectionRecord({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
    expect(cancelCalls).toHaveLength(0);
  });
});

describe("the one management path serves internal records (#4238)", () => {
  it("lists one row per IV duty: the active record with its alarm wins over a stale paused record (#5890)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort({
      list: async () => [ivAlarm()],
      get: async (id: string) => (id === "iv-1" ? ivAlarm() : undefined),
    });
    store.save(ivRecord());
    store.save(ivRecord({ id: "iv-paused", alarmId: "iv-paused", state: "paused", pausedAt: NOW_ISO }));
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    // Issue #5890 — the two records are one job (same callback, same
    // payload, same cadence): the stale per-alarm paused record must
    // not render as a second row. The live row is the job's state.
    expect(items.map((i) => i.id).sort()).toEqual(["iv-1"]);
    expect(items.find((i) => i.id === "iv-1")?.kind).toBe("internal");
    expect(items.find((i) => i.id === "iv-1")?.paused).toBe(false);
  });

  it("lists a paused internal record with no live alarm as the one paused row (#5890)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort({ list: async () => [] });
    store.save(ivRecord({ id: "iv-paused", alarmId: "iv-paused", state: "paused", pausedAt: NOW_ISO }));
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items.map((i) => i.id)).toEqual(["iv-paused"]);
    expect(items.find((i) => i.id === "iv-paused")?.paused).toBe(true);
  });

  it("pauses an internal record and cancels its alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, cancelled } = alarmsPort({ get: async () => ivAlarm() });
    store.save(ivRecord());
    const result = await pauseUnifiedSchedule({ store, alarms: port }, "iv-1", NOW_ISO);
    expect(result.ok).toBe(true);
    expect((await store.get("iv-1"))?.state).toBe("paused");
    expect((await store.get("iv-1"))?.kind).toBe("internal");
    expect(cancelled).toEqual(["iv-1"]);
  });

  it("resumes a paused internal record by re-arming its stored timing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, armed } = alarmsPort();
    store.save(ivRecord({ state: "paused", pausedAt: NOW_ISO }));
    const result = await resumeUnifiedSchedule({ store, alarms: port }, "iv-1", NOW_ISO);
    expect(result.ok).toBe(true);
    expect((await store.get("iv-1"))?.state).toBe("active");
    expect((await store.get("iv-1"))?.kind).toBe("internal");
    expect((await store.get("iv-1"))?.alarmId).toBe("new-alarm-1");
    expect(armed).toHaveLength(1);
    expect(armed[0]).toEqual([
      { type: "cron", cron: IV_CRON },
      "collectIvHistory",
      expect.objectContaining({ userLogin: "venus" }),
    ]);
  });

  it("deletes an internal record and cancels its alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, cancelled } = alarmsPort();
    store.save(ivRecord());
    const result = await deleteUnifiedSchedule({ store, alarms: port }, "iv-1");
    expect(result).toEqual({ ok: true, cancelled: true });
    expect(await store.get("iv-1")).toBeUndefined();
    expect(cancelled).toEqual(["iv-1"]);
  });

  it("triggers an internal record through the callback", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort({ get: async () => ivAlarm() });
    store.save(ivRecord());
    const ran: unknown[] = [];
    const result = await triggerUnifiedSchedule({ store, alarms: port }, "iv-1", async (callback, payload) => {
      ran.push([callback, payload]);
    });
    expect(result).toEqual({ ok: true, scheduleId: "iv-1", callback: "collectIvHistory" });
    expect(ran).toHaveLength(1);
    expect((ran[0] as unknown[])[0]).toBe("collectIvHistory");
    expect((ran[0] as unknown[])[1]).toEqual(
      expect.objectContaining({ trigger: "manual", scheduleId: "iv-1" }),
    );
  });

  it("updates an internal record's cadence by re-arming", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, armed, cancelled } = alarmsPort({ get: async () => ivAlarm() });
    store.save(ivRecord());
    const result = await updateUnifiedSchedule(
      { store, alarms: port },
      "iv-1",
      { cron: "0 22 * * 1-5" },
      NOW_MS,
    );
    expect(result.ok).toBe(true);
    expect((await store.get("iv-1"))?.kind).toBe("internal");
    expect(((await store.get("iv-1"))?.definition as { cron?: string }).cron).toBe("0 22 * * 1-5");
    expect(cancelled).toEqual(["iv-1"]);
    expect(armed).toHaveLength(1);
  });
});
