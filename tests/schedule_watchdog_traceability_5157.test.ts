// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { watchdogMissedSchedules } from "../src/agents/orchestrator/scheduleWatchdog";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { MockD1Database } from "./mock-d1";
import { SCHEDULE_WATCHDOG_FIRST_SEEN_KEY } from "../src/services/scheduleWatchdog";

function makeSql(db: DatabaseSync) {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      const info = stmt.run(...(args as never[]));
      const out = [] as unknown[] & { rowsWritten?: number };
      out.rowsWritten = Number(info.changes);
      return out;
    },
  };
}

describe("Issue #5157 (Sub-issue 3 of #5154) — Schedule Watchdog Owner Traceability", () => {
  it("passes userLogin, callback, and jobId into MissedScheduleAlertInfo and audit payload", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);
    // Issue #6101 — the watchdog reads/writes the D1 ledger: the
    // store resolves from ctx.env.AGENT_DB, never the DO table.
    const d1 = new MockD1Database();
    const store = new D1JobRunRecordStore(
      createD1JobRunRecordDb(d1 as unknown as D1Database),
    );

    const memory = new Map<string, unknown>([
      [SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, { "8B6aST8Fa": "2026-11-16T00:00:00.000Z" }],
    ]);
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const alerts: Array<Record<string, unknown>> = [];

    const nowMs = Date.parse("2026-11-17T08:00:00.000Z");
    const res = await watchdogMissedSchedules(
      {
        env: { AGENT_DB: d1 } as any,
        sql: sql as never,
        storage: {
          get: async (k) => memory.get(k),
          put: async (k, v) => {
            memory.set(k, v);
          },
        },
        userLogin: "trader@example.com",
        listSchedules: async () => [
          {
            id: "8B6aST8Fa",
            callback: "runStockCopilotCycle",
            type: "cron",
            cron: "39 6 * * *",
          },
        ],
        audit: (type, _agent, payload) => audits.push({ type, payload }),
        notifyMissedSchedule: async (info) => {
          alerts.push(info as unknown as Record<string, unknown>);
        },
      },
      {
        recordedCallbacks: ["runStockCopilotCycle"],
        nowMs,
      },
    );

    expect(res.missed).toBe(1);
    expect(audits[0].payload.userLogin).toBe("trader@example.com");
    await Promise.resolve();
    expect(alerts[0]).toMatchObject({
      scheduleId: "8B6aST8Fa",
      callback: "runStockCopilotCycle",
      userLogin: "trader@example.com",
      jobId: "8B6aST8Fa",
    });
    // Issue #6101 — the missed-fire claim row lands in D1 (the
    // exactly-once claim), stamped with the owner's login.
    const rows = await store.listByJob("8B6aST8Fa");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("skipped");
    expect(rows[0].userId).toBe("trader@example.com");
  });
});
