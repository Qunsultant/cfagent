/**
 * Issue #3394 — every SDK firing of an internal-only callback records
 * a consolidated-ledger run row with the S1 §4 linkage.
 *
 * The recording itself landed in #3788 (recordScheduleCallbackRun
 * wrappers on the four orchestrator methods); this file proves the
 * joinability the issue owns: an SDK-style firing (schedule object,
 * no trigger in the payload) lands a row whose scheduleId is the
 * schedule, and a firing with no originating schedule records
 * explicit nulls — never an absent field, never a guessed id.
 *
 * RED first: P01/P02 fail until the recorder's linkage is proven
 * per callback (they pass on the #3788 recorder as written — the
 * pins exist so a later refactor cannot silently drop a callback
 * from the recorded set); P03 fails if a wrapper stops routing
 * through the recorder.
 *
 * Pins:
 * - 3394-P01: SDK-style firing per callback joins schedule <-> row.
 * - 3394-P02: no-schedule firing records explicit nulls per callback.
 * - 3394-P03: each of the four wrapper methods routes through
 *   recordScheduleCallbackRun (source pin, mirroring S3-P07).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";

/** node:sqlite double for the SqlStorage seam (same shape as #2337 / #2964). */
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

const INTERNAL_CALLBACKS = [
  "executeAsyncJob",
  "expireStaleOrderDraft",
  "collectIvHistory",
  "autoRenewETradeTokens",
] as const;

describe("internal-callback SDK firings record a ledger row (#3394)", () => {
  for (const callback of INTERNAL_CALLBACKS) {
    it(`3394-P01: an SDK firing of ${callback} joins the schedule to its row`, async () => {
      const storage = new SqliteTestStorage();
      const scheduleId = `sched-3394-${callback}`;
      await recordScheduleCallbackRun(
        storage.sql as never,
        callback,
        {},
        { id: scheduleId },
        async () => ({ outcome: "success", descriptor: `${callback} complete` }),
      );
      const store = new SqlJobRunRecordStore(storage.sql as never);
      const rows = store.listByJob(scheduleId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.operation).toBe(callback);
      expect(row.triggeredBy).toBe("scheduled");
      expect(row.scheduleId).toBe(scheduleId);
      expect(row.jobId).toBe(scheduleId);
      // The firing ran through no workflow and no async job of its
      // own: explicit nulls, never absent, never guessed.
      expect(row.asyncJobId).toBeNull();
      expect(row.workflowId).toBeNull();
      expect(row.outcome).toBe("success");
      expect(row.descriptor).toBe(`${callback} complete`);
    });
  }

  it("3394-P02: a firing with no originating schedule records explicit nulls", async () => {
    for (const callback of INTERNAL_CALLBACKS) {
      const storage = new SqliteTestStorage();
      await recordScheduleCallbackRun(
        storage.sql as never,
        callback,
        {},
        undefined,
        async () => ({ outcome: "success", descriptor: `${callback} complete` }),
      );
      const store = new SqlJobRunRecordStore(storage.sql as never);
      const rows = store.listByJob(`callback:${callback}`);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.operation).toBe(callback);
      expect(row.scheduleId).toBeNull();
      expect(row.asyncJobId).toBeNull();
      expect(row.workflowId).toBeNull();
      expect(row.outcome).toBe("success");
    }
  });

  it("3394-P03: each internal-callback wrapper routes through recordScheduleCallbackRun", () => {
    const source = readFileSync(
      new URL("../src/agents/orchestrator.ts", import.meta.url),
      "utf-8",
    );
    for (const callback of INTERNAL_CALLBACKS) {
      const at = source.indexOf(`async ${callback}(`);
      expect(at, `${callback} wrapper not found in orchestrator.ts`).toBeGreaterThan(-1);
      const body = source.slice(at, at + 2500);
      expect(body).toContain("recordScheduleCallbackRun(");
    }
  });
});
