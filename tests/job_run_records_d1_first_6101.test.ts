/**
 * Issue #6101 — the run-ledger cutover: the DO job_run_records
 * writers are re-pointed at the D1 writer, the #6099 projector /
 * twin / sweep / carriers are deleted, and the D1 run record
 * carries the ID columns (platform, tenant, user, session) plus
 * correlation/trace as plain columns.
 *
 * Pinned here (TDD red→green):
 *  1. Migration 0093 applies: job_run_records gains platform_id,
 *     user_id, session_id, correlation_id, trace_id (all nullable);
 *     agent_tenant_projection_carriers is dropped.
 *  2. record() is idempotent by the derived identity
 *     (job_id, started, finished): a retry is a no-op, one row,
 *     never a throw, never a duplicate (Q2 ruling).
 *  3. record() stamps the identity columns from the record;
 *     absent identities write NULL, never an invented value.
 *  4. The port module (createJobRunRecordPorts): null when
 *     AGENT_DB is unbound (never throws); a store when bound;
 *     the memoized ensured port applies the schema once.
 *  5. recordLedgerRunD1: the one async D1 write entry — builds
 *     (validates) via buildJobRunRecord, then records; a poisoned
 *     identity literal throws the #3650 honesty error.
 *  6. jobRunRecorderFromD1: the engine seam stamps the host's
 *     attribution (tenant/platform/user/session) on every
 *     recordRun; listRuns/latestRun read D1.
 *  7. buildJobRunRecord accepts the identity fields and rejects a
 *     poisoned literal in any of them.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import {
  MIGRATION_0004_AGENT_AUDIT_REPORTS,
  MIGRATION_0047_JOB_RUN_RECORDS,
  MIGRATION_0059_RUN_LEDGER,
  MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
  MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
  MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
  MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
  MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
  MIGRATION_0086_JOB_RUN_RECORDS_OUTCOME_FACTS,
  MIGRATION_0091_JOB_RUN_RECORD_PROVENANCE,
  MIGRATION_0093_JOB_RUN_RECORD_IDENTITIES,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import {
  createJobRunRecordAdapter,
  jobRunRecordPort,
  jobRunRecorderFromD1,
  recordLedgerRunD1,
  resolveLedgerAttribution,
} from "../src/data/createJobRunRecordPorts";
import { buildJobRunRecord, type JobRunRecord } from "../src/services/jobRunRecords";

/** Minimal D1Database stand-in over node:sqlite (the J1 suite's double). */
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
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
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
}

function baseRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    system: "orchestrator-schedule",
    jobId: "job-6101",
    operation: "test-op",
    started: "2026-11-26T10:00:00.000Z",
    finished: "2026-11-26T10:00:01.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    ...overrides,
  };
}

describe("migration 0093 — run-record identities + carrier drop", () => {
  it("applies the identity columns and drops the carrier table", async () => {
    // 0093 is an ALTER on the table 0047 creates (and the carrier
    // table 0081 creates): apply the pre-0093 ensure chain first,
    // assert the pre-state, then apply 0093 alone.
    // NOTE: migration 0059 no longer creates the carrier table —
    // the #6101 fix round removed its CREATE from the catalogue
    // (the table dies with the projector; the catalogue must not
    // plan its creation). The pre-state table is staged here
    // explicitly, with the exact pre-#6101 DDL: a world that had
    // the table is what 0093 has to drop.
    const mock = new MockD1Database();
    const d1 = mock as unknown as D1Database;
    const db = createD1JobRunRecordDb(d1);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0004_AGENT_AUDIT_REPORTS,
      MIGRATION_0047_JOB_RUN_RECORDS,
      // 0059 used to create the carrier table (the #4116
      // projection); it no longer does — see the NOTE above.
      MIGRATION_0059_RUN_LEDGER,
      MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
      MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
      MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
      MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
      MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
      MIGRATION_0086_JOB_RUN_RECORDS_OUTCOME_FACTS,
      MIGRATION_0091_JOB_RUN_RECORD_PROVENANCE,
    ]);
    // Stage the pre-#6101 carrier table explicitly (see NOTE).
    mock.sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_tenant_projection_carriers (
  tenant_id TEXT PRIMARY KEY,
  queues_enabled INTEGER NOT NULL,
  orm_enabled INTEGER NOT NULL,
  sweep_enabled INTEGER NOT NULL,
  read_mode TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
)`);
    const colsBefore = mock.sqlite
      .prepare("PRAGMA table_info(job_run_records)")
      .all() as Array<{ name: string }>;
    expect(new Set(colsBefore.map((c) => c.name)).has("platform_id")).toBe(false);
    expect(
      mock.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tenant_projection_carriers'")
        .all(),
    ).toHaveLength(1);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0093_JOB_RUN_RECORD_IDENTITIES,
    ]);
    const cols = mock.sqlite
      .prepare("PRAGMA table_info(job_run_records)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of ["platform_id", "user_id", "session_id", "correlation_id", "trace_id"]) {
      expect(names.has(col)).toBe(true);
    }
    const tables = mock.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tenant_projection_carriers'")
      .all();
    expect(tables).toHaveLength(0);
  });

  it("ensureJobRunRecordsSchema applies 0093 (columns exist after ensure)", async () => {
    const mock = new MockD1Database();
    const d1 = mock as unknown as D1Database;
    const db = createD1JobRunRecordDb(d1);
    await ensureJobRunRecordsSchema(db);
    const cols = mock.sqlite
      .prepare("PRAGMA table_info(job_run_records)")
      .all() as Array<{ name: string }>;
    expect(new Set(cols.map((c) => c.name)).has("platform_id")).toBe(true);
  });
});

describe("D1JobRunRecordStore.record — idempotent + attributed (Q2/Q7/Q8)", () => {
  it("a retry of the same identity is a no-op: one row, no throw", async () => {
    const d1 = new MockD1Database() as unknown as D1Database;
    const db = createD1JobRunRecordDb(d1);
    await ensureJobRunRecordsSchema(db);
    const store = new D1JobRunRecordStore(db);
    const record = baseRecord();
    await store.record(record);
    await store.record(record);
    const rows = await store.listByJob("job-6101", 10);
    expect(rows).toHaveLength(1);
  });

  it("stamps the identity columns; absent identities write NULL", async () => {
    const mock = new MockD1Database();
    const d1 = mock as unknown as D1Database;
    const db = createD1JobRunRecordDb(d1);
    await ensureJobRunRecordsSchema(db);
    const store = new D1JobRunRecordStore(db);
    await store.record(
      baseRecord({
        tenantId: "tenant-1",
        platformId: "cfagent",
        userId: "alice",
        sessionId: "sess-9",
        correlationId: "corr-1",
        traceId: "trace-1",
      }),
    );
    await store.record(baseRecord({ jobId: "job-6101-b" }));
    const rows = mock.sqlite
      .prepare("SELECT job_id, tenant_id, platform_id, user_id, session_id, correlation_id, trace_id FROM job_run_records ORDER BY job_id")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      job_id: "job-6101",
      tenant_id: "tenant-1",
      platform_id: "cfagent",
      user_id: "alice",
      session_id: "sess-9",
      correlation_id: "corr-1",
      trace_id: "trace-1",
    });
    expect(rows[1]).toMatchObject({
      job_id: "job-6101-b",
      tenant_id: null,
      platform_id: null,
      user_id: null,
      session_id: null,
      correlation_id: null,
      trace_id: null,
    });
  });

  it("reads the identity columns back through rowToRecord", async () => {
    const d1 = new MockD1Database() as unknown as D1Database;
    const db = createD1JobRunRecordDb(d1);
    await ensureJobRunRecordsSchema(db);
    const store = new D1JobRunRecordStore(db);
    await store.record(
      baseRecord({ tenantId: "tenant-1", platformId: "cfagent", sessionId: "sess-9" }),
    );
    const [row] = await store.listByJob("job-6101", 1);
    expect(row.tenantId).toBe("tenant-1");
    expect(row.platformId).toBe("cfagent");
    expect(row.sessionId).toBe("sess-9");
    // The normalizer reads an absent identity as an explicit null
    // (the binding-tuple convention), never an invented value.
    expect(row.userId).toBeNull();
  });
});

describe("createJobRunRecordPorts — the D1 run-record port", () => {
  it("returns null when AGENT_DB is unbound, never throws", () => {
    expect(createJobRunRecordAdapter({})).toBeNull();
    expect(createJobRunRecordAdapter({ AGENT_DB: undefined })).toBeNull();
    expect(createJobRunRecordAdapter(null as never)).toBeNull();
  });

  it("returns a store when AGENT_DB is bound", async () => {
    const d1 = new MockD1Database() as unknown as D1Database;
    const store = createJobRunRecordAdapter({ AGENT_DB: d1 });
    expect(store).not.toBeNull();
    await store!.record(baseRecord());
    expect((await store!.listByJob("job-6101", 1)).length).toBe(1);
  });

  it("jobRunRecordPort memoizes the ensured port per env", async () => {
    const d1 = new MockD1Database() as unknown as D1Database;
    const env = { AGENT_DB: d1 };
    const a = await jobRunRecordPort(env);
    const b = await jobRunRecordPort(env);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    expect(await jobRunRecordPort({})).toBeNull();
    expect(await jobRunRecordPort(null)).toBeNull();
  });

  it("resolveLedgerAttribution resolves tenant + platform, never invents user/session", () => {
    const attr = resolveLedgerAttribution({ AGENT_DB: {}, IAAA_TENANT_ID: "tenant-1", PLATFORM_ID: "cfagent" });
    expect(attr.tenantId).toBe("tenant-1");
    expect(attr.platformId).toBe("cfagent");
    expect(attr.userId).toBeUndefined();
    expect(attr.sessionId).toBeUndefined();
    const def = resolveLedgerAttribution({});
    expect(def.tenantId).toBe("primary");
    expect(def.platformId).toBe("cfagent");
    const over = resolveLedgerAttribution(
      { IAAA_TENANT_ID: "tenant-1" },
      { userId: "alice", sessionId: "sess-9", correlationId: "corr-1", traceId: "trace-1" },
    );
    expect(over.userId).toBe("alice");
    expect(over.sessionId).toBe("sess-9");
    expect(over.correlationId).toBe("corr-1");
    expect(over.traceId).toBe("trace-1");
  });
});

describe("recordLedgerRunD1 — the one async D1 write entry", () => {
  it("builds, validates and records; the built row is returned", async () => {
    const d1 = new MockD1Database() as unknown as D1Database;
    const store = createJobRunRecordAdapter({ AGENT_DB: d1 })!;
    const built = await recordLedgerRunD1(store, baseRecord(), {
      tenantId: "tenant-1",
      platformId: "cfagent",
    });
    expect(built.jobId).toBe("job-6101");
    expect(built.tenantId).toBe("tenant-1");
    expect((await store.listByJob("job-6101", 1)).length).toBe(1);
  });

  it("a poisoned identity literal throws the #3650 honesty error", async () => {
    const d1 = new MockD1Database() as unknown as D1Database;
    const store = createJobRunRecordAdapter({ AGENT_DB: d1 })!;
    await expect(
      recordLedgerRunD1(store, baseRecord({ tenantId: "undefined" })),
    ).rejects.toThrow(/missing id/i);
    await expect(
      recordLedgerRunD1(store, baseRecord({ sessionId: "null" })),
    ).rejects.toThrow(/missing id/i);
    expect((await store.listByJob("job-6101", 10)).length).toBe(0);
  });

  it("buildJobRunRecord accepts the identity fields", () => {
    const built = buildJobRunRecord(
      baseRecord({ tenantId: "t", platformId: "cfagent", userId: "alice", sessionId: "s" }),
    );
    expect(built.tenantId).toBe("t");
    expect(built.userId).toBe("alice");
    expect(() => buildJobRunRecord(baseRecord({ userId: "undefined" }))).toThrow(
      /missing id/i,
    );
  });
});

describe("jobRunRecorderFromD1 — the engine seam", () => {
  it("stamps the host attribution on every recordRun; reads come from D1", async () => {
    const d1 = new MockD1Database() as unknown as D1Database;
    const store = createJobRunRecordAdapter({ AGENT_DB: d1 })!;
    const recorder = jobRunRecorderFromD1(store, { tenantId: "tenant-1", platformId: "cfagent" });
    await recorder.recordRun(baseRecord());
    const runs = await recorder.listRuns("job-6101");
    expect(runs).toHaveLength(1);
    expect(runs[0].tenantId).toBe("tenant-1");
    expect(runs[0].platformId).toBe("cfagent");
    const latest = await recorder.latestRun("job-6101");
    expect(latest?.jobId).toBe("job-6101");
  });
});

describe("D1JobRunRecordStore.foldJobOutcome — the direct outcome fold (#6101)", () => {
  function outcomeStore() {
    const d1 = new MockD1Database() as unknown as D1Database;
    const db = createD1JobRunRecordDb(d1);
    return new D1JobRunRecordStore(db);
  }

  it("folds an outcome with no run row: creates its own job-outcome row", async () => {
    const store = outcomeStore();
    const result = await store.foldJobOutcome(
      {
        id: "outcome-1",
        kind: "goal",
        trigger: "scheduled",
        status: "completed",
        scanned: 10,
        matched: 3,
        origin: "goal-screen",
        createdAt: "2026-11-26T10:00:00.000Z",
      },
      "tenant-1",
      Date.parse("2026-11-26T10:00:00.000Z"),
    );
    expect(result.created).toBe(true);
    expect(result.landed).toBe(true);
    const rows = await store.listByJob("outcome-1", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].system).toBe("job-outcome");
    expect(rows[0].scanned).toBe(10);
    expect(rows[0].matched).toBe(3);
    expect(rows[0].outcome).toBe("success");
  });

  it("attaches to the linked run row when one exists (no new row)", async () => {
    const store = outcomeStore();
    await store.record(
      baseRecord({ jobId: "run-1", workflowId: "outcome-2", started: "2026-11-26T10:00:00.000Z", finished: "2026-11-26T10:00:01.000Z" }),
    );
    const result = await store.foldJobOutcome(
      {
        id: "outcome-2",
        kind: "goal",
        trigger: "scheduled",
        status: "completed",
        scanned: 4,
        matched: 1,
        origin: "goal-screen",
        createdAt: "2026-11-26T10:00:02.000Z",
      },
      "tenant-1",
      Date.parse("2026-11-26T10:00:02.000Z"),
    );
    expect(result.created).toBe(false);
    expect(result.landed).toBe(true);
    expect((await store.listByJob("outcome-2", 10))).toHaveLength(0);
    const runs = await store.listByJob("run-1", 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].scanned).toBe(4);
    expect(runs[0].matched).toBe(1);
  });

  it("a re-fold of identical facts is a no-op (landed false)", async () => {
    const store = outcomeStore();
    const input = {
      id: "outcome-3",
      kind: "goal" as const,
      trigger: "scheduled" as const,
      status: "completed" as const,
      scanned: 2,
      matched: 1,
      origin: "goal-screen",
      createdAt: "2026-11-26T10:00:00.000Z",
    };
    await store.foldJobOutcome(input, "tenant-1", Date.parse("2026-11-26T10:00:00.000Z"));
    const again = await store.foldJobOutcome(input, "tenant-1", Date.parse("2026-11-26T10:00:01.000Z"));
    expect(again.landed).toBe(false);
    expect(again.created).toBe(false);
    expect((await store.listByJob("outcome-3", 10))).toHaveLength(1);
  });

  it("prev-merge: a partial re-fold keeps the first fold's facts (the DO record rule)", async () => {
    const store = outcomeStore();
    await store.foldJobOutcome(
      {
        id: "outcome-4",
        kind: "options",
        trigger: "manual",
        status: "completed",
        scanned: 10,
        matched: 2,
        pdfKey: "pdf-1",
        deliveryStates: { slack: "sent" },
        origin: "manual-options-inline",
        createdAt: "2026-11-26T10:00:00.000Z",
      },
      "tenant-1",
      Date.parse("2026-11-26T10:00:00.000Z"),
    );
    // A re-record that omits scanned/pdfKey and adds an email leg:
    // defined fields win, undefined never wipes, delivery merges.
    const merged = await store.foldJobOutcome(
      {
        id: "outcome-4",
        kind: "options",
        trigger: "manual",
        status: "completed",
        deliveryStates: { email: "sent" },
        origin: "manual-options-inline",
        createdAt: "2026-11-26T10:00:01.000Z",
      },
      "tenant-1",
      Date.parse("2026-11-26T10:00:01.000Z"),
    );
    expect(merged.landed).toBe(true);
    const rows = await store.listByJob("outcome-4", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].scanned).toBe(10);
    expect(rows[0].pdfKey).toBe("pdf-1");
    expect(rows[0].deliveryStates).toEqual({ slack: "sent", email: "sent" });
  });

  it("a completed re-record without a coded error clears a stale one", async () => {
    const store = outcomeStore();
    await store.foldJobOutcome(
      {
        id: "outcome-5",
        kind: "goal",
        trigger: "scheduled",
        status: "failed",
        codedError: "E_STALE",
        origin: "goal-screen",
        createdAt: "2026-11-26T10:00:00.000Z",
      },
      "tenant-1",
      Date.parse("2026-11-26T10:00:00.000Z"),
    );
    // The stale code is on the row before the re-record.
    expect((await store.listByJob("outcome-5", 10))[0].codedError).toBe("E_STALE");
    await store.foldJobOutcome(
      {
        id: "outcome-5",
        kind: "goal",
        trigger: "scheduled",
        status: "completed",
        origin: "goal-screen",
        createdAt: "2026-11-26T10:00:01.000Z",
      },
      "tenant-1",
      Date.parse("2026-11-26T10:00:01.000Z"),
    );
    const rows = await store.listByJob("outcome-5", 10);
    expect(rows).toHaveLength(1);
    // rowToRecord omits null facts: a cleared code reads back as
    // undefined (the #6006 read-back convention), never the stale code.
    expect(rows[0].codedError).toBeUndefined();
  });
});
