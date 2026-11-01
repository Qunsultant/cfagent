// @vitest-environment node
/**
 * #2358 (#1976 step 4a) — async-job family census pin.
 *
 * The six family files hold ZERO storage-shaped exec sites
 * (they serve through the Queue / Read / Maintenance ports),
 * the surface-2 `(x as any).exec` site in scheduledTasks is
 * gone, and the family's statements live in the data layer at
 * exact counts. This is the family-level companion to the
 * global D-D pin (tests/global_dd_census_2356.test.ts), whose
 * allow-list and by-table writer sets the parent updates with
 * this slice's deltas at ship time:
 *
 *  - Surface 1: asyncJobs.ts 23 -> 0, routes/maintenance.ts
 *    6 -> 0, chainExecutor.ts 1 -> 0, routes/workflowRuns.ts
 *    1 -> 0, asyncJobGate.ts 1 -> 0, shardJobs.ts 1 -> 0
 *    (family 33); orchestrator.ts 19 -> 17 (only its
 *    mas_async_jobs DDL third moved — the rest is #2359's).
 *    Above-layer total: 144 -> 109.
 *  - Surface 2: scheduledTasks.ts 1 -> 0 (the gate probe now
 *    reads through the read port's activeJobPayloads).
 *  - In-layer: doSqliteAsyncJobAdapter.ts 34 (new);
 *    doSqliteJobOutcomeAdapter.ts 12 -> 13 (+1: clearRows;
 *    countRows delegates to the existing count);
 *    doSqlitePausedScheduleAdapter.ts 6 -> 7 (+1: clearSync);
 *    the in-memory adapter, ports and composition root hold 0.
 *  - By-table: mas_async_jobs' writer set becomes exactly
 *    [src/data/doSqliteAsyncJobAdapter.ts]; the maintenance
 *    bypass entries for mas_job_outcomes and paused_schedules
 *    are REMOVED (their writers are exactly their adapters).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STORAGE_EXEC_PATTERN =
  /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;
const ANY_EXEC_PATTERN = /\(\s*[\w.[\]]+\s+as\s+any\s*\)\s*\.\s*exec\s*\(/g;

function countIn(file: string, pattern: RegExp = STORAGE_EXEC_PATTERN): number {
  return (readFileSync(file, "utf8").match(pattern) ?? []).length;
}

const FAMILY_FILES = [
  "src/agents/orchestrator/asyncJobs.ts",
  "src/agents/routes/maintenance.ts",
  "src/agentic/chainExecutor.ts",
  "src/agents/routes/workflowRuns.ts",
  "src/services/asyncJobGate.ts",
  "src/services/shardJobs.ts",
] as const;

const DATA_LAYER_FILES: Array<[string, number]> = [
  // 34 at #2358; 36 after #2567 (+2: the stuck_alerted_at column
  // migration and the guarded markStuckAlerted UPDATE).
  ["src/data/doSqliteAsyncJobAdapter.ts", 36],
  ["src/data/doSqliteJobOutcomeAdapter.ts", 13],
  ["src/data/doSqlitePausedScheduleAdapter.ts", 7],
  ["src/data/inMemoryAsyncJobAdapter.ts", 0],
  ["src/data/asyncJobPorts.ts", 0],
  ["src/data/createAsyncJobPorts.ts", 0],
];

describe("step-4a family census (#2358)", () => {
  it("the six family files hold zero above-layer storage exec sites", () => {
    for (const file of FAMILY_FILES) {
      expect(countIn(file), file).toBe(0);
    }
  });

  it("scheduledTasks holds zero surface-2 (as any).exec sites", () => {
    expect(countIn("src/services/scheduledTasks.ts", ANY_EXEC_PATTERN)).toBe(0);
    expect(countIn("src/services/scheduledTasks.ts")).toBe(0);
  });

  it("orchestrator.ts drops exactly its mas_async_jobs DDL third (19 -> 17)", () => {
    // #2359 (#1976 step 4d) pin update: step 4d moved the
    // four orchestrator-owned tables' DDL and the remaining
    // bypass statements behind the data layer, so the class
    // file's count drops again — 17 -> 4 (the ADR-out legacy
    // ai-chat lift + the G-7 mas_settings CREATE remain). This
    // pin's 4a-specific claim (the async-jobs third left in
    // 4a) is subsumed; the exact current count is pinned by
    // the 4d family census as well.
    // #2390 (step 4g) pin update: the G-7 mas_settings CREATE
    // retired to the dedicated settings port's adapter — the
    // class file's count drops 4 -> 3 (the ADR-out legacy
    // ai-chat lift remains).
    expect(countIn("src/agents/orchestrator.ts")).toBe(3);
  });

  it("the family's statements live in the data layer at exact counts", () => {
    for (const [file, expected] of DATA_LAYER_FILES) {
      expect(countIn(file), file).toBe(expected);
    }
  });

  it("mas_async_jobs has exactly one writer file: its DO adapter", () => {
    const WRITER = /(INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS \w+ ON|ALTER TABLE)\s+(?:IF NOT EXISTS \w+ ON\s+)?mas_async_jobs/;
    const writers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && WRITER.test(readFileSync(path, "utf8"))) {
          writers.push(path);
        }
      }
    };
    walk("src");
    expect(writers).toEqual(["src/data/doSqliteAsyncJobAdapter.ts"]);
  });

  it("the maintenance bypasses are closed: outcome/paused deletes live only in their adapters", () => {
    const maintenance = readFileSync("src/agents/routes/maintenance.ts", "utf8");
    expect(maintenance).not.toContain("DELETE FROM mas_async_jobs");
    expect(maintenance).not.toMatch(/DELETE FROM mas_job_outcomes(?!_meta)/);
    expect(maintenance).not.toContain("DELETE FROM paused_schedules");
    expect(maintenance).toContain("createAsyncJobPorts");
    expect(maintenance).toContain("countRows()");
    expect(maintenance).toContain("clearRows()");
    expect(maintenance).toContain("store.clear()");
  });
});
