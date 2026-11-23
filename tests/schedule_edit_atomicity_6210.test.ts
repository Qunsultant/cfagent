/**
 * Issue #6210 — schedule edit is not atomic.
 *
 * Server half: `updateUnifiedSchedule` cancels the alarm and then
 * re-arms it; if the re-arm throws, the schedule is gone (the record
 * still points at the cancelled alarm). The fix rolls the original
 * alarm back on a failed re-arm, so the stored schedule keeps its
 * interval and next run. Pinned here against a fake alarms port.
 */
import { describe, it, expect, vi } from "vitest";
import {
  screenScheduleToRecord,
  updateUnifiedSchedule,
  type ScheduleAlarmLike,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";

const NOW = Date.now();
const NOW_ISO = "2026-11-23T08:00:00.000Z";

function originalAlarm(): ScheduleAlarmLike {
  return {
    id: "alarm-1",
    callback: "autonomousMarketScreen",
    type: "interval",
    intervalSeconds: 20160,
    payload: { universe: "NASDAQ100" },
  };
}

async function storeWithOriginal() {
  const store = new InMemoryUnifiedScheduleStore();
  await store.save(screenScheduleToRecord(originalAlarm(), NOW_ISO));
  return store;
}

describe("6210 updateUnifiedSchedule rolls back on a failed re-arm", () => {
  it("a failed re-arm re-arms the original alarm and the record keeps its interval", async () => {
    const store = await storeWithOriginal();
    const cancel = vi.fn(async (_id: string) => true);
    const arm = vi.fn(async (timing: any, callback: string, payload: unknown) => {
      if (timing.type === "interval" && timing.intervalSeconds === 3600) {
        throw new Error("SDK arm failed: alarm unavailable");
      }
      return { id: "alarm-rollback", callback, type: timing.type, intervalSeconds: timing.intervalSeconds, payload };
    });
    const alarms: any = { list: async () => [], get: async () => originalAlarm(), cancel, arm };

    const result = await updateUnifiedSchedule({ store, alarms }, "alarm-1", { intervalSeconds: 3600, subDailyOptIn: true }, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("SDK arm failed");
      expect(result.error).toContain("original schedule was restored");
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("alarm-1");
    expect(arm).toHaveBeenCalledTimes(2);
    // Second arm is the rollback: the original timing, callback, payload.
    expect(arm).toHaveBeenNthCalledWith(
      2,
      { type: "interval", intervalSeconds: 20160 },
      "autonomousMarketScreen",
      { universe: "NASDAQ100" },
    );
    const record = await store.get("alarm-1");
    expect(record).toBeDefined();
    expect(record?.alarmId).toBe("alarm-rollback");
    expect((record?.definition as any).intervalSeconds).toBe(20160);
    expect(record?.state).toBe("active");
  });

  it("a successful update still cancels once and re-arms once", async () => {
    const store = await storeWithOriginal();
    const cancel = vi.fn(async (_id: string) => true);
    const arm = vi.fn(async (timing: any, callback: string, payload: unknown) => ({
      id: "alarm-2", callback, type: timing.type, intervalSeconds: timing.intervalSeconds, payload,
    }));
    const alarms: any = { list: async () => [], get: async () => originalAlarm(), cancel, arm };

    const result = await updateUnifiedSchedule({ store, alarms }, "alarm-1", { intervalSeconds: 3600, subDailyOptIn: true }, NOW);

    expect(result.ok).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith(
      { type: "interval", intervalSeconds: 3600 },
      "autonomousMarketScreen",
      expect.anything(),
    );
    const record = await store.get("alarm-1");
    expect(record?.alarmId).toBe("alarm-2");
    expect((record?.definition as any).intervalSeconds).toBe(3600);
  });

  it("a failed rollback names both failures and leaves the record as it was", async () => {
    const store = await storeWithOriginal();
    const cancel = vi.fn(async (_id: string) => true);
    const arm = vi.fn(async () => {
      throw new Error("SDK arm failed: alarm unavailable");
    });
    const alarms: any = { list: async () => [], get: async () => originalAlarm(), cancel, arm };

    const result = await updateUnifiedSchedule({ store, alarms }, "alarm-1", { intervalSeconds: 3600, subDailyOptIn: true }, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("SDK arm failed");
      expect(result.error).toContain("could not be restored");
    }
    expect(arm).toHaveBeenCalledTimes(2);
    const record = await store.get("alarm-1");
    expect(record?.alarmId).toBe("alarm-1");
    expect((record?.definition as any).intervalSeconds).toBe(20160);
  });
});
