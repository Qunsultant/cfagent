/**
 * Issue #273 — schedule management core: the unified schedule store
 * and the pure update-resolution rules behind PUT /api/schedules/:id.
 *
 * Pause semantics (issue #3121 Phase 2, #3123): the Agents SDK has no
 * native pause, so pausing is a record STATE in the unified store
 * (`unified_schedules`, kind screen) — the SDK schedule is cancelled
 * and the record keeps the full definition; resume re-arms the SAME
 * record id. These tests pin the record conversions, the store
 * round-trip, and the frequency/payload update rules.
 */
import { describe, it, expect } from "vitest";
import {
  screenScheduleToRecord,
  unifiedRecordToListItem,
  resolveScheduleUpdate,
} from "../src/services/unifiedScheduleManagement";
import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import { MockSqlStorage } from "./mock-sql";

const cronSchedule: any = {
  id: "sched-cron-1",
  callback: "autonomousMarketScreen",
  payload: { universe: "SP500", userLogin: "venus" },
  type: "cron",
  cron: "5 * * * *",
  time: 1760000000,
};

describe("screenScheduleToRecord / unifiedRecordToListItem (#273, #3123)", () => {
  it("captures the full definition of a cron schedule as an active screen record", () => {
    const rec = screenScheduleToRecord(cronSchedule, "2026-10-20T16:00:00.000Z");
    expect(rec.id).toBe("sched-cron-1");
    expect(rec.kind).toBe("screen");
    expect(rec.state).toBe("active");
    expect(rec.callback).toBe("autonomousMarketScreen");
    expect(rec.definition.payload).toEqual({ universe: "SP500", userLogin: "venus" });
    expect(rec.definition.type).toBe("cron");
    expect(rec.definition.cron).toBe("5 * * * *");
    expect(rec.definition.time).toBe(1760000000);
    expect(rec.alarmId).toBe("sched-cron-1");
    expect(rec.createdAt).toBe("2026-10-20T16:00:00.000Z");
    expect(rec.pausedAt).toBeUndefined();
  });

  it("captures interval schedules with their intervalSeconds", () => {
    const rec = screenScheduleToRecord(
      { id: "s2", callback: "autonomousOptionsAnalysis", payload: {}, type: "interval", intervalSeconds: 900, time: 1760000100 } as any,
      "2026-10-20T16:00:00.000Z"
    );
    expect(rec.definition.type).toBe("interval");
    expect(rec.definition.intervalSeconds).toBe(900);
    expect(rec.definition.cron).toBeUndefined();
  });

  it("renders a paused record as a list item flagged paused, with no next run", () => {
    const rec = screenScheduleToRecord(cronSchedule, "2026-10-20T16:00:00.000Z");
    const paused: UnifiedScheduleRecord = {
      ...rec,
      state: "paused",
      pausedAt: "2026-10-20T16:00:00.000Z",
    };
    const item = unifiedRecordToListItem(paused);
    expect(item.id).toBe("sched-cron-1");
    expect(item.paused).toBe(true);
    expect(item.cron).toBe("5 * * * *");
    expect(item.payload).toEqual({ universe: "SP500", userLogin: "venus" });
    expect((item as any).nextRun).toBeUndefined();
  });
});

describe("SqlUnifiedScheduleStore (#273, #3123)", () => {
  it("round-trips save → get → list → remove", () => {
    const store = new SqlUnifiedScheduleStore(new MockSqlStorage() as any);
    const rec: UnifiedScheduleRecord = {
      id: "p1",
      kind: "screen",
      state: "paused",
      callback: "autonomousMarketScreen",
      definition: {
        type: "interval",
        callback: "autonomousMarketScreen",
        payload: { universe: "NASDAQ100" },
        intervalSeconds: 1800,
        time: 1760000200,
      },
      alarmId: "p1",
      pausedAt: "2026-10-20T16:00:00.000Z",
      createdAt: "2026-10-20T16:00:00.000Z",
      updatedAt: "2026-10-20T16:00:00.000Z",
    };
    store.save(rec);
    expect(store.get("p1")).toEqual(rec);
    expect(store.list()).toEqual([rec]);
    expect(store.remove("p1")).toBe(true);
    expect(store.get("p1")).toBeUndefined();
    expect(store.remove("p1")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("save is an upsert keyed by id (re-pause / update-in-place)", () => {
    const store = new SqlUnifiedScheduleStore(new MockSqlStorage() as any);
    const base: UnifiedScheduleRecord = {
      id: "p2",
      kind: "screen",
      state: "paused",
      callback: "cb",
      definition: { type: "cron", callback: "cb", payload: {}, cron: "0 * * * *" },
      alarmId: "p2",
      pausedAt: "t0",
      createdAt: "t0",
      updatedAt: "t0",
    };
    store.save(base);
    store.save({ ...base, definition: { ...base.definition, cron: "30 9 * * *" } });
    expect(store.list()).toHaveLength(1);
    expect((store.get("p2")?.definition as any).cron).toBe("30 9 * * *");
  });
});

describe("resolveScheduleUpdate (#273)", () => {
  const nowMs = Date.parse("2026-10-20T16:00:00.000Z");
  const intervalCurrent: any = {
    type: "interval", callback: "autonomousOptionsAnalysis",
    payload: { symbols: ["AAPL"] }, intervalSeconds: 3600, time: 1760003600,
  };

  it("switches an interval job to a cron timing and keeps the payload", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { cron: "0 9 * * *" }, nowMs);
    expect(r).toEqual({
      ok: true,
      timing: { type: "cron", cron: "0 9 * * *" },
      payload: { symbols: ["AAPL"] },
    });
  });

  it("changes intervalSeconds and replaces the payload when one is given", () => {
    const r = resolveScheduleUpdate(
      intervalCurrent,
      { intervalSeconds: 900, payload: { symbols: ["MSFT"] } },
      nowMs
    );
    expect(r).toEqual({
      ok: true,
      timing: { type: "interval", intervalSeconds: 900 },
      payload: { symbols: ["MSFT"], trigger: "scheduled" },
    });
  });

  it("keeps the current timing for a payload-only update of a recurring job", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { payload: { symbols: [] } }, nowMs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timing).toEqual({ type: "interval", intervalSeconds: 3600 });
  });

  it("rejects a malformed cron expression", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { cron: "not a cron" }, nowMs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cron/i);
  });

  it("rejects a non-positive interval", () => {
    const r = resolveScheduleUpdate(intervalCurrent, { intervalSeconds: 0 }, nowMs);
    expect(r.ok).toBe(false);
  });

  it("rejects re-arming a one-time schedule whose time has passed", () => {
    const past: any = { type: "scheduled", callback: "cb", payload: {}, time: Math.floor(nowMs / 1000) - 3600 };
    const r = resolveScheduleUpdate(past, { payload: { a: 1 } }, nowMs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already|past|fired/i);
  });

  it("allows a payload-only update of a future one-time schedule", () => {
    const futureTime = Math.floor(nowMs / 1000) + 3600;
    const future: any = { type: "scheduled", callback: "cb", payload: {}, time: futureTime };
    const r = resolveScheduleUpdate(future, { payload: { a: 1 } }, nowMs);
    expect(r).toEqual({ ok: true, timing: { type: "scheduled", time: futureTime }, payload: { a: 1 } });
  });
});
