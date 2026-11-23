/**
 * Issue #6006 — fold mas_job_outcomes into the one run source (D1
 * job_run_records) behind the one read seam, so GET /api/runs can
 * surface the outcome facts (codedError / origin / counts /
 * artifacts) the #2606 re-point renders.
 *
 * Pinned here (TDD red→green):
 *  1. Fold mapper: completed → success, failed → failure + error,
 *     partial → success + "Partial coverage" descriptor; the nine
 *     outcome facts ride the folded row; started == finished ==
 *     createdAt (one timestamp, never an invented interval).
 *  2. Attach-or-create: a twin matched by EXACT linkage (workflowId
 *     first, else asyncJobId) is attached, never duplicated; no twin
 *     creates one `job-outcome` row; a re-fold of identical facts is
 *     a no-op; scheduleId alone or a shared timestamp never matches
 *     (no heuristic merge); the engine row's own fields stay
 *     authoritative — errorText fills only when null and the outcome
 *     failed with a codedError.
 *  3. D1 round-trip: the nine fact columns survive record → read,
 *     including delivery-states JSON.
 *  4. Read seam: runSummaryFromJobRunRecord surfaces codedError,
 *     origin, resultCount (= matched) and the artifact keys on a
 *     folded row; pre-fold rows carry null, never invented facts.
 *  5. Projector: projectJobOutcome lands the fold and replays as
 *     already-current with the folded row's id.
 *  6. Hook: projectJobOutcomeBestEffort never throws — missing row,
 *     unbound D1, and unconfigured carriers all return null; with
 *     the ORM carrier configured it folds the stored row end to end.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MockSqlStorage } from "./mock-sql";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
  jobOutcomeFoldRecord,
  sameOutcomeFacts,
} from "../src/data/d1JobRunRecordAdapter";
import {
  createD1RunLedgerDb,
  D1RunLedgerAdapter,
  ensureRunLedgerSchema,
} from "../src/data/d1RunLedgerAdapter";
import { createRunLedgerProjector } from "../src/data/runLedgerProjection";
import { buildJobRunRecord, type JobRunRecord } from "../src/services/jobRunRecords";
import { recordJobOutcome, type JobOutcomeRow } from "../src/services/jobOutcomes";
import { runSummaryFromJobRunRecord } from "../src/services/runSummaries";
import { projectJobOutcomeBestEffort } from "../src/services/runLedgerProjectionHooks";
import { resolveIaaaTenant } from "../src/security/iaaaGithubEndToEnd";

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
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

function outcome(overrides: Partial<JobOutcomeRow> = {}): JobOutcomeRow {
  return {
    id: "discovery:2026-11-23T00:00:00.000Z",
    kind: "discovery",
    trigger: "scheduled",
    status: "completed",
    scanned: 120,
    matched: 7,
    codedError: null,
    reportUrl: null,
    pdfKey: null,
    xlsxKey: null,
    csvKey: null,
    deliveryStates: { slack: "sent" },
    origin: "discovery",
    createdAt: "2026-11-23T00:00:00.000Z",
    ...overrides,
  };
}

function engineRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return buildJobRunRecord({
    system: "job-pipeline",
    jobId: "screener:chat:ALL:2026-11-23T00:00:00.000Z:abcd1234",
    operation: "run",
    started: "2026-11-23T00:00:00.000Z",
    finished: "2026-11-23T00:05:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    ...overrides,
  });
}

async function jobStore() {
  const mock = new MockD1Database();
  const db = createD1JobRunRecordDb(mock as never);
  await ensureJobRunRecordsSchema(db);
  return { mock, store: new D1JobRunRecordStore(db) };
}

describe("fold mapper (jobOutcomeFoldRecord / sameOutcomeFacts, #6006)", () => {
  it("completed folds to success with the nine facts and one timestamp", () => {
    const folded = jobOutcomeFoldRecord(
      outcome({ pdfKey: "pdf-1", xlsxKey: "xlsx-1", csvKey: "csv-1", reportUrl: "https://example.invalid/r" }),
    );
    expect(folded.system).toBe("job-outcome");
    expect(folded.jobId).toBe("discovery:2026-11-23T00:00:00.000Z");
    expect(folded.operation).toBe("discovery");
    expect(folded.outcome).toBe("success");
    expect(folded.started).toBe("2026-11-23T00:00:00.000Z");
    expect(folded.finished).toBe("2026-11-23T00:00:00.000Z");
    expect(folded.triggeredBy).toBe("scheduled");
    expect(folded.codedError).toBeNull();
    expect(folded.origin).toBe("discovery");
    expect(folded.scanned).toBe(120);
    expect(folded.matched).toBe(7);
    expect(folded.deliveryStates).toEqual({ slack: "sent" });
    expect(folded.pdfKey).toBe("pdf-1");
    expect(folded.xlsxKey).toBe("xlsx-1");
    expect(folded.csvKey).toBe("csv-1");
    expect(folded.reportUrl).toBe("https://example.invalid/r");
  });

  it("failed folds to failure and carries the coded error as error", () => {
    const folded = jobOutcomeFoldRecord(
      outcome({ status: "failed", codedError: "FAILURE_NO_SCREENING_PROVIDER" }),
    );
    expect(folded.outcome).toBe("failure");
    expect(folded.error).toBe("FAILURE_NO_SCREENING_PROVIDER");
    expect(folded.codedError).toBe("FAILURE_NO_SCREENING_PROVIDER");
  });

  it("partial folds to success with a Partial coverage descriptor", () => {
    const folded = jobOutcomeFoldRecord(outcome({ status: "partial" }));
    expect(folded.outcome).toBe("success");
    expect(folded.descriptor).toBe("Partial coverage — scanned 120, matched 7");
  });

  it("sameOutcomeFacts is key-order-insensitive for delivery states", () => {
    const folded = jobOutcomeFoldRecord(
      outcome({ deliveryStates: { b: "2", a: "1" } }),
    );
    expect(sameOutcomeFacts(folded, outcome({ deliveryStates: { a: "1", b: "2" } }))).toBe(true);
    expect(sameOutcomeFacts(folded, outcome({ codedError: "X" }))).toBe(false);
    expect(sameOutcomeFacts(folded, outcome({ matched: 8 }))).toBe(false);
  });
});

describe("attach-or-create (D1JobRunRecordStore.attachOutcomeFacts, #6006)", () => {
  it("no twin creates one job-outcome row and re-folding it is a no-op", async () => {
    const { store } = await jobStore();
    const first = await store.attachOutcomeFacts({ outcome: outcome(), tenantId: "primary" }, Date.now());
    expect(first.landed).toBe(true);
    expect(first.created).toBe(true);
    expect(first.record.system).toBe("job-outcome");
    expect(first.record.jobId).toBe(outcome().id);
    const rows = await store.listByJob(outcome().id);
    expect(rows).toHaveLength(1);
    // Read-back convention (rowToRecord): an absent fact is omitted,
    // so it reads as undefined — never an invented null or value.
    expect(rows[0].codedError).toBeUndefined();
    expect(rows[0].origin).toBe("discovery");
    expect(rows[0].scanned).toBe(120);
    expect(rows[0].matched).toBe(7);
    expect(rows[0].deliveryStates).toEqual({ slack: "sent" });
    const replay = await store.attachOutcomeFacts({ outcome: outcome(), tenantId: "primary" }, Date.now());
    expect(replay).toEqual({ landed: false, created: false, record: expect.anything() });
    expect(await store.listByJob(outcome().id)).toHaveLength(1);
  });

  it("a twin matched by workflowId is attached, never duplicated", async () => {
    const { store } = await jobStore();
    await store.record(engineRecord({ workflowId: outcome().id }));
    const result = await store.attachOutcomeFacts({ outcome: outcome(), tenantId: "primary" }, Date.now());
    expect(result.landed).toBe(true);
    expect(result.created).toBe(false);
    expect(result.record.system).toBe("job-pipeline");
    expect(result.record.jobId).toBe("screener:chat:ALL:2026-11-23T00:00:00.000Z:abcd1234");
    expect(result.record.origin).toBe("discovery");
    expect(result.record.matched).toBe(7);
    expect(await store.listRecent(10)).toHaveLength(1);
  });

  it("a twin matched by asyncJobId is attached when no workflowId matches", async () => {
    const { store } = await jobStore();
    await store.record(engineRecord({ asyncJobId: outcome().id }));
    const result = await store.attachOutcomeFacts({ outcome: outcome(), tenantId: "primary" }, Date.now());
    expect(result.landed).toBe(true);
    expect(result.created).toBe(false);
    expect(result.record.matched).toBe(7);
    expect(await store.listRecent(10)).toHaveLength(1);
  });

  it("scheduleId alone never matches: a same-schedule row stays separate", async () => {
    const { store } = await jobStore();
    await store.record(engineRecord({ scheduleId: outcome().id }));
    const result = await store.attachOutcomeFacts({ outcome: outcome(), tenantId: "primary" }, Date.now());
    expect(result.created).toBe(true);
    expect(await store.listRecent(10)).toHaveLength(2);
  });

  it("errorText fills only when null and the outcome failed with a codedError", async () => {
    const { store } = await jobStore();
    // The engine row carries no error text (a success row here — the
    // builder forbids a failure row without one); the failed outcome
    // fills errorText with its codedError.
    await store.record(engineRecord({ workflowId: outcome().id }));
    const failed = outcome({ status: "failed", codedError: "FAILURE_NO_SCREENING_PROVIDER" });
    const result = await store.attachOutcomeFacts({ outcome: failed, tenantId: "primary" }, Date.now());
    expect(result.landed).toBe(true);
    expect(result.record.error).toBe("FAILURE_NO_SCREENING_PROVIDER");
    // The engine row's own error stays authoritative on a later fold.
    await store.record(
      engineRecord({
        jobId: "screener:chat:ALL:2026-11-24T00:00:00.000Z:eeee5678",
        started: "2026-11-24T00:00:00.000Z",
        finished: "2026-11-24T00:05:00.000Z",
        workflowId: "other:row",
        error: "engine-error",
      }),
    );
    const other = await store.attachOutcomeFacts(
      { outcome: outcome({ id: "other:row", status: "failed", codedError: "SOMETHING_ELSE" }), tenantId: "primary" },
      Date.now(),
    );
    expect(other.record.error).toBe("engine-error");
  });
});

describe("read seam (runSummaryFromJobRunRecord, #6006)", () => {
  it("a folded row surfaces codedError, origin, resultCount and artifact keys", () => {
    const summary = runSummaryFromJobRunRecord(
      jobOutcomeFoldRecord(
        outcome({
          status: "failed",
          codedError: "FAILURE_NO_SCREENING_PROVIDER",
          pdfKey: "pdf-1",
          reportUrl: "https://example.invalid/r",
        }),
      ),
    );
    expect(summary.status).toBe("failed");
    expect(summary.codedError).toBe("FAILURE_NO_SCREENING_PROVIDER");
    expect(summary.origin).toBe("discovery");
    expect(summary.resultCount).toBe(7);
    expect(summary.pdfKey).toBe("pdf-1");
    expect(summary.reportUrl).toBe("https://example.invalid/r");
  });

  it("a pre-fold engine row carries null facts, never invented ones", () => {
    const summary = runSummaryFromJobRunRecord(engineRecord());
    expect(summary.codedError).toBeNull();
    expect(summary.origin).toBeNull();
    expect(summary.resultCount).toBeNull();
    expect(summary.pdfKey).toBeNull();
  });
});

describe("projector (projectJobOutcome, #6006)", () => {
  async function projector() {
    const mock = new MockD1Database();
    const runDb = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(runDb);
    const asyncJobStore = new D1RunLedgerAdapter(runDb);
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    const jobRecordStore = new D1JobRunRecordStore(jobDb);
    const p = createRunLedgerProjector({
      reportStore: asyncJobStore as never,
      asyncJobStore,
      jobRecordStore,
      projectedJobRecordStore: jobRecordStore,
    });
    return { p, jobRecordStore };
  }

  it("lands the fold and replays as already-current with the folded id", async () => {
    const { p, jobRecordStore } = await projector();
    const first = await p.projectJobOutcome({ outcome: outcome(), tenantId: "primary" }, Date.now());
    expect(first.projected).toBe(true);
    expect(first.linkedJobRunId).toBeTruthy();
    const rows = await jobRecordStore.listByJob(outcome().id);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("discovery");
    const replay = await p.projectJobOutcome({ outcome: outcome(), tenantId: "primary" }, Date.now());
    expect(replay.projected).toBe(false);
    expect(replay.skipped).toBe("already-current");
    expect(replay.linkedJobRunId).toBe(first.linkedJobRunId);
  });
});

describe("hook (projectJobOutcomeBestEffort, #6006)", () => {
  it("missing row returns null and never throws", async () => {
    const sql = new MockSqlStorage();
    await expect(
      projectJobOutcomeBestEffort({ env: {}, sql, outcomeId: "nope", userLogin: null }),
    ).resolves.toBeNull();
  });

  it("unbound D1 returns null and never throws", async () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, outcome());
    await expect(
      projectJobOutcomeBestEffort({ env: {}, sql, outcomeId: outcome().id, userLogin: null }),
    ).resolves.toBeNull();
  });

  it("with the ORM carrier configured it folds the stored row end to end", async () => {
    const mock = new MockD1Database();
    const runDb = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(runDb);
    const adapter = new D1RunLedgerAdapter(runDb);
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    const env = { AGENT_DB: mock as never };
    const tenantId = resolveIaaaTenant(env);
    await adapter.setTenantProjectionCarriers(
      tenantId,
      { queues: false, orm: true, sweep: true },
      "merged",
      Date.now(),
    );
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, outcome());
    const post = await projectJobOutcomeBestEffort({
      env,
      sql,
      outcomeId: outcome().id,
      userLogin: null,
      skipQueue: true,
    });
    expect(post).not.toBeNull();
    expect(post?.projected).toBe(true);
    const store = new D1JobRunRecordStore(jobDb);
    const rows = await store.listByJob(outcome().id);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("discovery");
    expect(rows[0].matched).toBe(7);
  });
});
