/**
 * Issue #3314: join `mas_opportunity_scans` rows to the consolidated
 * ledger — the structural cause of incident #3264's run `5fd079ec`
 * being unjoinable to any schedule, workflow, or async job.
 *
 * JOIN DECISION (with evidence): additive §4 linkage columns on the
 * scan row — `schedule_id`, `async_job_id`, `workflow_id` (probed
 * ADD COLUMN, the issue #103 pattern) — mirroring `job_run_records`'
 * own column names exactly, so the join is a plain equality on
 * identical names. Chosen over the ledger-artifactRefs join key:
 * the scan row must self-describe its schedule (the acceptance
 * criterion's "records the absence explicitly (null...)" needs
 * columns to be null on), and the S1 linkage stays one scheme — the
 * scan row carries the same §4 fields the ledger carries, stamped
 * at write time, explicit nulls when the caller knows none.
 * `trigger` stays inside summary_json (the #3264 fix, unchanged).
 *
 * The workflow command is NOT threaded (#4198 owns that): the
 * scheduled path stamps the linkage AFTER the workflow returns, via
 * the scan-store backfill (`updateLedgerLinkage`, the established
 * updatePdfKey pattern at the same call site), where the caller
 * knows both the scan id and the schedule id.
 *
 * Pins:
 * - 3314-P01: DO save with linkage → the three columns carry the
 *   ids, and get() surfaces them on the summary.
 * - 3314-P02: DO save without linkage → the columns read NULL
 *   (explicit absence, never a missing column) and the summary
 *   fields read null.
 * - 3314-P03: legacy table (pre-#103 shape) → ensure() probes and
 *   ALTERs all four missing columns; the legacy row reads NULLs.
 * - 3314-P04: joinability — a scan saved with linkage joins its
 *   ledger row (same scheduleId, generated_at inside the ledger
 *   row's window) in one SQL JOIN; a scan under another schedule
 *   joins nothing.
 * - 3314-P05: backfill — updateLedgerLinkage stamps the linkage
 *   after save; unknown id / invisible row → false; a poisoned
 *   "undefined"/"null" literal stamps as null (#3650).
 * - 3314-P06: in-memory adapter parity — same save/backfill
 *   contract as the DO adapter.
 * - 3314-P07: wiring — the scheduled options path backfills the
 *   linkage after the workflow returns (source pin; the live
 *   firing proof is owed post-merge).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { InMemoryScanRunStore } from "../src/data/inMemoryScanRunAdapter";
import { SqlScanRunStore } from "../src/data/doSqliteScanRunAdapter";
import type { ScanRunStore } from "../src/data/scanRunPorts";
import { recordLedgerRun } from "../src/services/unifiedLedger";

/**
 * Real in-memory SQLite executor (the options_discovery_ports_
 * conformance double): SELECT/PRAGMA return rows, everything else
 * runs and returns []. The DO adapter's bare path (no storage
 * handle) applies sequentially over it.
 */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function scanResult(generatedAt: string): never {
  return {
    generatedAt,
    mode: "live",
    modelVersion: "opp-v1",
    gate: { passed: true },
    coverage: { requested: 1, scanned: 1, withQuotes: 1, symbols: ["AAPL"] },
    opportunities: [],
    abstentions: [],
  } as never;
}

function scanColumns(sql: SqliteTestStorage, id: string): Record<string, unknown> {
  const rows = sql.exec(
    "SELECT schedule_id, async_job_id, workflow_id FROM mas_opportunity_scans WHERE id = ?",
    id,
  ) as Array<Record<string, unknown>>;
  return rows[0] ?? {};
}

const LINKAGE = { scheduleId: "sched-3314", asyncJobId: null, workflowId: null };

describe("3314-P01 DO save with linkage stamps the §4 id columns", () => {
  it("columns carry the ids and get() surfaces them on the summary", async () => {
    const sql = new SqliteTestStorage();
    const store = new SqlScanRunStore(sql as never, { idFactory: () => "scan-3314-p01" });
    await store.save(scanResult("2026-11-12T00:00:30.000Z"), {
      userLogin: "alice",
      trigger: "scheduled",
      linkage: LINKAGE,
    });
    expect(scanColumns(sql, "scan-3314-p01")).toEqual({
      schedule_id: "sched-3314",
      async_job_id: null,
      workflow_id: null,
    });
    const got = await store.get("scan-3314-p01", { userLogin: "alice" });
    expect(got?.scheduleId).toBe("sched-3314");
    expect(got?.asyncJobId ?? null).toBeNull();
    expect(got?.workflowId ?? null).toBeNull();
  });
});

describe("3314-P02 DO save without linkage records explicit nulls", () => {
  it("columns read NULL and the summary fields read null, never a missing column", async () => {
    const sql = new SqliteTestStorage();
    const store = new SqlScanRunStore(sql as never, { idFactory: () => "scan-3314-p02" });
    await store.save(scanResult("2026-11-12T00:00:30.000Z"), { userLogin: "alice" });
    expect(scanColumns(sql, "scan-3314-p02")).toEqual({
      schedule_id: null,
      async_job_id: null,
      workflow_id: null,
    });
    const got = await store.get("scan-3314-p02", { userLogin: "alice" });
    expect(got?.scheduleId ?? null).toBeNull();
    expect(got?.asyncJobId ?? null).toBeNull();
    expect(got?.workflowId ?? null).toBeNull();
  });
});

describe("3314-P03 legacy table gains the columns by probe; legacy rows read NULLs", () => {
  it("ensure() ALTERs all four missing columns and the legacy row joins as unjoined, not dropped", async () => {
    const sql = new SqliteTestStorage();
    // Pre-#103 table shape: no user_login, no linkage columns.
    sql.exec(
      "CREATE TABLE mas_opportunity_scans (id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, " +
        "mode TEXT NOT NULL, model_version TEXT NOT NULL, summary_json TEXT NOT NULL, result_json TEXT NOT NULL)",
    );
    sql.exec(
      "INSERT INTO mas_opportunity_scans (id, generated_at, mode, model_version, summary_json, result_json) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
      "legacy-1",
      "2026-10-16T00:00:00.000Z",
      "live",
      "opp-v1",
      JSON.stringify({ id: "legacy-1" }),
      JSON.stringify({}),
    );
    const store = new SqlScanRunStore(sql as never, { idFactory: () => "post-migration" });
    await store.save(scanResult("2026-11-12T00:00:30.000Z"), {
      userLogin: "alice",
      linkage: LINKAGE,
    });
    const columns = (
      sql.exec("PRAGMA table_info(mas_opportunity_scans)") as Array<{ name: string }>
    ).map((c) => c.name);
    for (const col of ["user_login", "schedule_id", "async_job_id", "workflow_id"]) {
      expect(columns).toContain(col);
    }
    expect(scanColumns(sql, "legacy-1")).toEqual({
      schedule_id: null,
      async_job_id: null,
      workflow_id: null,
    });
    expect(scanColumns(sql, "post-migration")).toEqual({
      schedule_id: "sched-3314",
      async_job_id: null,
      workflow_id: null,
    });
    // The legacy row still reads back — a null linkage never drops it.
    expect((await store.get("legacy-1"))?.id).toBe("legacy-1");
  });
});

describe("3314-P04 joinability: scan row joins its ledger row in one SQL JOIN", () => {
  it("same scheduleId + generated_at inside the ledger window joins; another schedule joins nothing", async () => {
    const sql = new SqliteTestStorage();
    const scans = new SqlScanRunStore(sql as never);
    const ledger = new SqlJobRunRecordStore(sql as never);
    await scans.save(scanResult("2026-11-12T00:00:30.000Z"), {
      id: "scan-3314-join",
      userLogin: "alice",
      trigger: "scheduled",
      linkage: LINKAGE,
    });
    await scans.save(scanResult("2026-11-12T00:00:30.000Z"), {
      id: "scan-3314-other",
      userLogin: "alice",
      trigger: "scheduled",
      linkage: { scheduleId: "sched-other", asyncJobId: null, workflowId: null },
    });
    recordLedgerRun(ledger, {
      system: "orchestrator-schedule",
      jobId: "sched-3314",
      operation: "autonomousOptionsAnalysis",
      started: "2026-11-12T00:00:00.000Z",
      finished: "2026-11-12T00:01:00.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      scheduleId: "sched-3314",
    });
    const join = (scanId: string): Array<Record<string, unknown>> =>
      sql.exec(
        "SELECT s.id AS scan_id, l.job_id AS ledger_job_id, l.schedule_id AS ledger_schedule_id " +
          "FROM mas_opportunity_scans s " +
          "JOIN job_run_records l ON s.schedule_id = l.schedule_id " +
          "AND s.generated_at >= l.started AND s.generated_at <= l.finished " +
          "WHERE s.id = ?",
        scanId,
      ) as Array<Record<string, unknown>>;
    expect(join("scan-3314-join")).toEqual([
      { scan_id: "scan-3314-join", ledger_job_id: "sched-3314", ledger_schedule_id: "sched-3314" },
    ]);
    expect(join("scan-3314-other")).toEqual([]);
  });
});

describe("3314-P05 backfill stamps the linkage after save", () => {
  it("updateLedgerLinkage stamps columns + summary; unknown/invisible → false; poisoned literals → null", async () => {
    const sql = new SqliteTestStorage();
    const store = new SqlScanRunStore(sql as never, { idFactory: () => "scan-3314-p05" });
    await store.save(scanResult("2026-11-12T00:00:30.000Z"), { userLogin: "alice" });
    expect(scanColumns(sql, "scan-3314-p05")).toEqual({
      schedule_id: null,
      async_job_id: null,
      workflow_id: null,
    });
    expect(await store.updateLedgerLinkage("scan-3314-p05", LINKAGE, { userLogin: "bob" })).toBe(false);
    expect(await store.updateLedgerLinkage("missing-run", LINKAGE, { userLogin: "alice" })).toBe(false);
    expect(await store.updateLedgerLinkage("scan-3314-p05", LINKAGE, { userLogin: "alice" })).toBe(true);
    expect(scanColumns(sql, "scan-3314-p05")).toEqual({
      schedule_id: "sched-3314",
      async_job_id: null,
      workflow_id: null,
    });
    expect((await store.get("scan-3314-p05", { userLogin: "alice" }))?.scheduleId).toBe("sched-3314");
    // Issue #3650 — a poisoned literal is a missing id, never a stamped one.
    expect(
      await store.updateLedgerLinkage(
        "scan-3314-p05",
        { scheduleId: "undefined", asyncJobId: "null", workflowId: "  " },
        { userLogin: "alice" },
      ),
    ).toBe(true);
    expect(scanColumns(sql, "scan-3314-p05")).toEqual({
      schedule_id: null,
      async_job_id: null,
      workflow_id: null,
    });
  });
});

describe("3314-P06 in-memory adapter parity", () => {
  it("same save/backfill contract as the DO adapter", async () => {
    const store: ScanRunStore = new InMemoryScanRunStore({ idFactory: () => "scan-3314-p06" });
    await store.save(scanResult("2026-11-12T00:00:30.000Z"), { userLogin: "alice" });
    expect((await store.get("scan-3314-p06", { userLogin: "alice" }))?.scheduleId ?? null).toBeNull();
    expect(await store.updateLedgerLinkage("missing-run", LINKAGE, { userLogin: "alice" })).toBe(false);
    expect(await store.updateLedgerLinkage("scan-3314-p06", LINKAGE, { userLogin: "bob" })).toBe(false);
    expect(await store.updateLedgerLinkage("scan-3314-p06", LINKAGE, { userLogin: "alice" })).toBe(true);
    const got = await store.get("scan-3314-p06", { userLogin: "alice" });
    expect(got?.scheduleId).toBe("sched-3314");
    expect(got?.asyncJobId ?? null).toBeNull();
    expect(got?.workflowId ?? null).toBeNull();
    // Save-time linkage lands on the summary too.
    const store2: ScanRunStore = new InMemoryScanRunStore({ idFactory: () => "scan-3314-p06b" });
    await store2.save(scanResult("2026-11-12T00:00:30.000Z"), { userLogin: "alice", linkage: LINKAGE });
    expect((await store2.get("scan-3314-p06b", { userLogin: "alice" }))?.scheduleId).toBe("sched-3314");
  });
});

describe("3314-P07 wiring: the scheduled options path backfills the linkage after the workflow", () => {
  it("autonomousOptionsAnalysis stamps the arming schedule onto the scan row once the run id is known", () => {
    const tasks = readFileSync("src/services/scheduledTasks.ts", "utf8");
    expect(tasks).toContain("updateLedgerLinkage");
    expect(tasks).toContain("options.scheduleId");
    // The stamp lives in the post-workflow block, next to the #3264
    // key stamps — after the scan row id is known, before any later
    // throw can skip it — and never fails the run.
    expect(tasks).toContain("options_scan_row_linkage_stamp_failed");
  });
});
