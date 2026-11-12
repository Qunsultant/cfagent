/**
 * Issue #4116 — one system-of-record D1: project the DO run ledgers
 * (mas_reports, mas_async_jobs) into D1 behind three carriers
 * (queues + ORM + sweep), each configurable and externalized.
 *
 * Pinned here (TDD red→green):
 *  1. Migration 0059 registers the new D1 tables (agent_async_jobs,
 *     agent_tenant_projection_carriers) + the agent_reports
 *     linked_job_run_id column; the registry stays well-formed.
 *  2. Async-job upsert: idempotent replay is a no-op, a stale write
 *     never overwrites a newer row, a newer write lands (the ruling's
 *     shared ordering rule in its conditional-upsert form).
 *  3. Carrier config: absent row = unconfigured (named refusal, no
 *     carrier fires, no default); each flag gates its carrier
 *     independently; store-unavailable is named.
 *  4. Projector: reports reuse the versioned agent_reports table
 *     (read-before-write, version+1 on change, skip when already
 *     current); async jobs use the conditional upsert; both stamp
 *     the twin link when it resolves exactly.
 *  5. Twin link: bare generation_id == jobId (parent rows) and the
 *     pipeline-generate: prefix both resolve; the run-window +
 *     uniqueness guard leaves ambiguous / absent links NULL (twin
 *     survives honestly, never a heuristic merge).
 *  6. Queue envelope: run-ledger.project is a CloudEvents envelope
 *     (claim-check refs only); the consumer applies the shared
 *     projector; a handler throw retries to DLQ.
 *  7. Sweep: bounded (100), single-shot, per-record failures
 *     collected, unbound AGENT_DB is a named 503, no cron.
 *  8. D1-only reads: /api/runs + Workflow Runs + detail read D1
 *     alone (no DO read in the path); the parity suite proves the
 *     D1-only lists equal the merged lists modulo linked-twin
 *     absorption (no silent loss, no duplicates).
 *
 * mas_stage_claims is NOT projected in this slice: explicit owner
 * deferral (see the design doc) — no read surface consumes stage
 * claims, a D1 mirror would be a content-free key table, and
 * claims live in multiple DOs with no instance enumeration.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import {
  agentAsyncJobs,
  agentTenantProjectionCarriers,
  agentReports,
} from "../src/data/drizzleSchema";
import {
  createD1RunLedgerDb,
  D1RunLedgerAdapter,
  ensureRunLedgerSchema,
} from "../src/data/d1RunLedgerAdapter";
import { createRunLedgerAdapter, ensureRunLedgerTables } from "../src/data/createRunLedgerPorts";
import { reconcileRunLedgerProjection } from "../src/agents/orchestrator/runLedgerReconcile";
import { createAsyncJobPorts } from "../src/data/createAsyncJobPorts";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import {
  readTenantProjectionCarriers,
  type TenantProjectionCarriersRead,
} from "../src/services/projectionCarriers";
import {
  createRunLedgerProjector,
  resolveLinkedJobRunId,
  type ReportProjectionInput,
  type AsyncJobProjectionInput,
} from "../src/data/runLedgerProjection";
import {
  createD1AuditReportDb,
  D1AuditReportAdapter,
  ensureAuditReportSchema,
} from "../src/data/d1AuditReportAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import { postRunLedgerBestEffort } from "../src/services/runLedgerProjectionPosting";
import {
  extractRunLedgerProject,
  isRunLedgerProjectEnvelope,
  publishRunLedgerProject,
  runLedgerProjectEvent,
} from "../src/workflows/runLedgerQueueTransport";
import { createScreenerEventsWorkHandler } from "../src/messaging/screenerEventsConsumer";
import { MockSqlStorage } from "./mock-sql";
import { storeReportAtGeneration } from "../src/services/scheduledReports";
import {
  projectAsyncJobBestEffort,
  projectCanonicalReportBestEffort,
} from "../src/services/runLedgerProjectionHooks";
import type { AsyncJobStoredRow } from "../src/data/asyncJobPorts";
import { createAuditReportAdapter } from "../src/data/createAuditReportPorts";
import {
  createRunLedgerAdapter,
  ensureRunLedgerTables,
} from "../src/data/createRunLedgerPorts";
import type { JobRunRecord } from "../src/services/jobRunRecords";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { handleReportsRoutes } from "../src/agents/routes/reports";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";
import {
  resolveLedgerReadMode,
  listProjectedReportSummaries,
} from "../src/services/runLedgerReads";

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

function jobRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return buildJobRunRecord({
    system: "job-pipeline",
    jobId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
    operation: "run",
    started: "2026-11-12T00:00:00.000Z",
    finished: "2026-11-12T00:05:00.000Z",
    outcome: "success",
    triggeredBy: "manual",
    ...overrides,
  });
}

function reportInput(overrides: Partial<ReportProjectionInput> = {}): ReportProjectionInput {
  return {
    reportId: "rep-1",
    runId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
    generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
    title: "Market screen — ALL (manual)",
    source: "screener",
    summary: "Scanned 100 symbols, 5 matched.",
    body: JSON.stringify({ success: true, matchedCount: 5 }),
    createdAtMs: Date.parse("2026-11-12T00:01:00.000Z"),
    updatedAtMs: Date.parse("2026-11-12T00:01:00.000Z"),
    tenantId: "primary",
    workspaceId: "primary",
    userLogin: "alice",
    bodyR2Key: null,
    ...overrides,
  };
}

function asyncJobInput(overrides: Partial<AsyncJobProjectionInput> = {}): AsyncJobProjectionInput {
  return {
    jobId: "job-async-1",
    sessionId: "sess-1",
    capability: "screen.stock",
    displayName: "Stock screen",
    status: "completed",
    payloadJson: "{}",
    resultJson: null,
    error: null,
    errorCode: null,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:05:00.000Z",
    startedAt: "2026-11-12T00:00:00.000Z",
    completedAt: "2026-11-12T00:05:00.000Z",
    parentJobId: null,
    jobKind: "main",
    channel: null,
    notBefore: null,
    stage: null,
    chainId: null,
    trigger: "manual",
    triggeredBy: "alice",
    scheduleId: null,
    tenantId: "primary",
    ...overrides,
  };
}

describe("migration 0059 (run ledger, #4116)", () => {
  it("registers version 59 (position-independent containment — latest is owned by migration_registry.test.ts)", () => {
    const found = ALL_MIGRATIONS.find((m) => m.version === 59);
    expect(found).toBeDefined();
    expect(found?.name).toBe("0059_run_ledger");
  });

  it("declares the new tables in the drizzle schema", () => {
    expect(agentAsyncJobs).toBeDefined();
    expect(agentTenantProjectionCarriers).toBeDefined();
    expect(agentReports).toBeDefined();
  });

  it("creates the tables + the linked_job_run_id column from the migration SQL", async () => {
    const mock = new MockD1Database();
    const db = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(db);
    const tables = mock.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("agent_async_jobs");
    expect(names).toContain("agent_tenant_projection_carriers");
    const cols = mock.sqlite.prepare("PRAGMA table_info(agent_reports)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("linked_job_run_id");
  });

  it("migration 0060 adds the user_login owner column (read-scope parity, #4116)", async () => {
    expect(ALL_MIGRATIONS.find((m) => m.version === 60)?.name).toBe("0060_run_ledger_owner");
    const mock = new MockD1Database();
    const db = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(db);
    const cols = mock.sqlite.prepare("PRAGMA table_info(agent_reports)").all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain("user_login");
    expect(cols.map((c) => c.name)).toContain("body_r2_key");
  });

  it("ensureAuditReportSchema alone provides the 0059/0060 columns the adapter reads", async () => {
    // Issue #4116: the adapter's report reads select
    // linked_job_run_id / user_login / body_r2_key, so its
    // ensure must provide them — a 0004-only DB broke the
    // #1688 D1 adapter suite (no such column). The gated
    // runner makes a later ensureRunLedgerTables pass a skip.
    const mock = new MockD1Database();
    const auditDb = createD1AuditReportDb(mock as never);
    await ensureAuditReportSchema(auditDb);
    const cols = mock.sqlite.prepare("PRAGMA table_info(agent_reports)").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("linked_job_run_id");
    expect(names).toContain("user_login");
    expect(names).toContain("body_r2_key");
    const store = new D1AuditReportAdapter(auditDb);
    expect(await store.latestReport("primary", "rep-1")).toBeNull();
    expect(await store.listReports("primary", { limit: 10 })).toEqual([]);
    // A second ensure (run-ledger path) is a gated no-op.
    const runDb = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(runDb);
    expect(await store.listReports("primary", { limit: 10 })).toEqual([]);
  });
});

describe("async-job conditional upsert (shared ordering rule, #4116)", () => {
  async function adapter() {
    const mock = new MockD1Database();
    const db = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(db);
    return new D1RunLedgerAdapter(db);
  }

  it("inserts, then a replay of the same updated_at is a no-op", async () => {
    const a = await adapter();
    const row = asyncJobInput();
    expect(await a.recordAsyncJob(row, Date.now())).toBe(true);
    expect(await a.recordAsyncJob(row, Date.now())).toBe(false);
    const listed = await a.listAsyncJobs("primary", 10);
    expect(listed).toHaveLength(1);
    expect(listed[0].jobId).toBe("job-async-1");
  });

  it("a stale write never overwrites a newer row", async () => {
    const a = await adapter();
    const newer = asyncJobInput({ status: "completed", updatedAt: "2026-11-12T00:05:00.000Z" });
    const stale = asyncJobInput({ status: "queued", updatedAt: "2026-11-12T00:00:00.000Z" });
    expect(await a.recordAsyncJob(newer, Date.now())).toBe(true);
    expect(await a.recordAsyncJob(stale, Date.now())).toBe(false);
    const listed = await a.listAsyncJobs("primary", 10);
    expect(listed[0].status).toBe("completed");
  });

  it("a newer write lands and replaces the older row", async () => {
    const a = await adapter();
    const older = asyncJobInput({ status: "queued", updatedAt: "2026-11-12T00:00:00.000Z" });
    const newer = asyncJobInput({ status: "completed", updatedAt: "2026-11-12T00:05:00.000Z" });
    expect(await a.recordAsyncJob(older, Date.now())).toBe(true);
    expect(await a.recordAsyncJob(newer, Date.now())).toBe(true);
    const listed = await a.listAsyncJobs("primary", 10);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("completed");
  });

  it("rows are tenant-scoped: another tenant's rows never leak", async () => {
    const a = await adapter();
    await a.recordAsyncJob(asyncJobInput({ tenantId: "primary" }), Date.now());
    await a.recordAsyncJob(asyncJobInput({ jobId: "job-async-2", tenantId: "other" }), Date.now());
    expect(await a.listAsyncJobs("primary", 10)).toHaveLength(1);
    expect(await a.listAsyncJobs("other", 10)).toHaveLength(1);
  });
});

describe("carrier config (configurable + externalized, #4116)", () => {
  async function adapter() {
    const mock = new MockD1Database();
    const db = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(db);
    return new D1RunLedgerAdapter(db);
  }

  it("absent row = unconfigured: no carrier fires, named refusal, no default", async () => {
    const a = await adapter();
    const read: TenantProjectionCarriersRead = await readTenantProjectionCarriers(
      { AGENT_DB: new MockD1Database() },
      a,
    );
    expect(read.status).toBe("unconfigured");
    if (read.status === "unconfigured") {
      expect(read.error).toMatch(/not configured/i);
    }
  });

  it("unbound AGENT_DB = store_unavailable, never a silent empty config", async () => {
    const read = await readTenantProjectionCarriers({ AGENT_DB: undefined });
    expect(read.status).toBe("store_unavailable");
  });

  it("each flag gates its carrier independently", async () => {
    const a = await adapter();
    await a.setTenantProjectionCarriers(
      "primary",
      { queues: true, orm: false, sweep: true },
      "merged",
      Date.now(),
    );
    const read = await readTenantProjectionCarriers({ AGENT_DB: new MockD1Database() }, a);
    expect(read.status).toBe("ok");
    if (read.status === "ok") {
      expect(read.carriers).toEqual({ queues: true, orm: false, sweep: true });
      expect(read.readMode).toBe("merged");
    }
  });

  it("createRunLedgerAdapter returns null when AGENT_DB is unbound, never throws", () => {
    expect(createRunLedgerAdapter({})).toBeNull();
    expect(createRunLedgerAdapter({ AGENT_DB: undefined })).toBeNull();
  });
});

describe("twin-link resolution (projection-time, #4116)", () => {
  const started = "2026-11-12T00:00:00.000Z";
  const finished = "2026-11-12T00:05:00.000Z";
  const jobId = "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234";

  it("bare generation_id == jobId links the run in-window", () => {
    const records = [jobRecord()];
    const linked = resolveLinkedJobRunId(jobId, Date.parse("2026-11-12T00:01:00.000Z"), records);
    expect(linked).toBe(`d1:${jobId}:${started}:${finished}`);
  });

  it("pipeline-generate: prefix resolves the generate job id", () => {
    const gen = jobRecord({ jobId: "yahoo-nasdaq100-generate" });
    const linked = resolveLinkedJobRunId(
      "pipeline-generate:yahoo-nasdaq100-generate:artifact-7",
      Date.parse("2026-11-12T00:04:00.000Z"),
      [gen],
    );
    expect(linked).toBe(`d1:yahoo-nasdaq100-generate:${started}:${finished}`);
  });

  it("a row created outside every run window links nothing (twin survives)", () => {
    const records = [jobRecord()];
    const linked = resolveLinkedJobRunId(jobId, Date.parse("2026-11-12T01:00:00.000Z"), records);
    expect(linked).toBeNull();
  });

  it("two candidate runs in-window link nothing (ambiguous, never guessed)", () => {
    const first = jobRecord({ started, finished: "2026-11-12T00:03:00.000Z" });
    const second = jobRecord({ started: "2026-11-12T00:02:00.000Z", finished });
    const linked = resolveLinkedJobRunId(jobId, Date.parse("2026-11-12T00:02:30.000Z"), [first, second]);
    expect(linked).toBeNull();
  });

  it("no job record for the generation id links nothing", () => {
    expect(resolveLinkedJobRunId("screener:other", Date.now(), [])).toBeNull();
    expect(resolveLinkedJobRunId(null, Date.now(), [jobRecord()])).toBeNull();
  });
});

describe("shared projector (one writer, three carriers, #4116)", () => {
  async function projector() {
    const mock = new MockD1Database();
    const auditDb = createD1AuditReportDb(mock as never);
    await ensureAuditReportSchema(auditDb);
    const reportStore = new D1AuditReportAdapter(auditDb);
    const runDb = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(runDb);
    const asyncJobStore = new D1RunLedgerAdapter(runDb);
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    const jobRecordStore = new D1JobRunRecordStore(jobDb);
    const p = createRunLedgerProjector({ reportStore, asyncJobStore, jobRecordStore });
    return { p, reportStore, asyncJobStore, jobRecordStore };
  }

  it("projects a report, stamps the twin link, and replays as already-current", async () => {
    const { p, reportStore, jobRecordStore } = await projector();
    await jobRecordStore.record(jobRecord());
    const first = await p.projectReport(reportInput(), Date.now());
    expect(first.projected).toBe(true);
    expect(first.linkedJobRunId).toBe(
      "d1:screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234:2026-11-12T00:00:00.000Z:2026-11-12T00:05:00.000Z",
    );
    const latest = await reportStore.latestReport("primary", "rep-1");
    expect(latest).not.toBeNull();
    expect(latest?.version).toBe(1);
    expect(latest?.linkedJobRunId).toBe(first.linkedJobRunId);
    const replay = await p.projectReport(reportInput(), Date.now());
    expect(replay).toEqual({
      projected: false,
      skipped: "already-current",
      linkedJobRunId: first.linkedJobRunId,
    });
  });

  it("a newer report version lands as version+1; an older replay stays skipped", async () => {
    const { p, reportStore, jobRecordStore } = await projector();
    await jobRecordStore.record(jobRecord());
    await p.projectReport(reportInput(), Date.now());
    const newer = await p.projectReport(
      reportInput({
        summary: "Scanned 100 symbols, 6 matched.",
        updatedAtMs: Date.parse("2026-11-12T00:02:00.000Z"),
      }),
      Date.now(),
    );
    expect(newer.projected).toBe(true);
    const latest = await reportStore.latestReport("primary", "rep-1");
    expect(latest?.version).toBe(2);
    expect(latest?.summary).toBe("Scanned 100 symbols, 6 matched.");
    const stale = await p.projectReport(reportInput(), Date.now());
    expect(stale.projected).toBe(false);
    expect(stale.skipped).toBe("already-current");
  });

  it("an ambiguous twin link stays null but the report still projects", async () => {
    const { p, reportStore, jobRecordStore } = await projector();
    await jobRecordStore.record(
      jobRecord({ started: "2026-11-12T00:00:00.000Z", finished: "2026-11-12T00:03:00.000Z" }),
    );
    await jobRecordStore.record(
      jobRecord({ started: "2026-11-12T00:02:00.000Z", finished: "2026-11-12T00:05:00.000Z" }),
    );
    const res = await p.projectReport(
      reportInput({ createdAtMs: Date.parse("2026-11-12T00:02:30.000Z") }),
      Date.now(),
    );
    expect(res.projected).toBe(true);
    expect(res.linkedJobRunId).toBeNull();
    const latest = await reportStore.latestReport("primary", "rep-1");
    expect(latest?.linkedJobRunId).toBeNull();
  });

  it("projects an async job; a replay is already-current", async () => {
    const { p, asyncJobStore } = await projector();
    const first = await p.projectAsyncJob(asyncJobInput(), Date.now());
    expect(first).toEqual({ projected: true, linkedJobRunId: null });
    const replay = await p.projectAsyncJob(asyncJobInput(), Date.now());
    expect(replay.projected).toBe(false);
    expect(replay.skipped).toBe("already-current");
    const listed = await asyncJobStore.listAsyncJobs("primary", 10);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("completed");
  });
});

describe("best-effort post (ORM carrier, #4116)", () => {
  it("posts a report and an async job; a replay counts as posted (already-current)", async () => {
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock as never };
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    await new D1JobRunRecordStore(jobDb).record(jobRecord());
    const first = await postRunLedgerBestEffort(
      env,
      "primary",
      { ledger: "reports", row: reportInput() },
      Date.now(),
    );
    expect(first.posted).toBe(true);
    expect(first.linkedJobRunId).toContain("d1:screener:chat:ALL");
    const job = await postRunLedgerBestEffort(
      env,
      "primary",
      { ledger: "async_jobs", row: asyncJobInput() },
      Date.now(),
    );
    expect(job.posted).toBe(true);
    const replay = await postRunLedgerBestEffort(
      env,
      "primary",
      { ledger: "reports", row: reportInput() },
      Date.now(),
    );
    expect(replay.posted).toBe(true);
    expect(replay.skipped).toBe("already-current");
  });

  it("unbound AGENT_DB is a named skip, never a throw", async () => {
    const res = await postRunLedgerBestEffort(
      { AGENT_DB: undefined },
      "primary",
      { ledger: "reports", row: reportInput() },
      Date.now(),
    );
    expect(res).toEqual({ posted: false, projected: false, skipped: "unbound", linkedJobRunId: null });
  });

  it("a throwing store is a failed post, never a throw into the DO write", async () => {
    const throwing = {
      prepare() {
        throw new Error("d1 down");
      },
    };
    const res = await postRunLedgerBestEffort(
      { AGENT_DB: throwing as never },
      "primary",
      { ledger: "reports", row: reportInput() },
      Date.now(),
    );
    expect(res.posted).toBe(false);
    expect(res.skipped).toBeDefined();
  });
});

describe("queue carrier (run-ledger.project, #4116)", () => {
  it("publishes a claim-check envelope (refs only, never the row payload)", async () => {
    const sent: unknown[] = [];
    const queue = { send: async (msg: unknown) => void sent.push(msg) };
    const res = await publishRunLedgerProject({
      queue: queue as never,
      message: { ledger: "reports", naturalKey: "rep-1", tenantId: "primary", userLogin: "alice" },
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(res.published).toBe(true);
    expect(sent).toHaveLength(1);
    const envelope = sent[0] as { type: string; id: string; data: Record<string, unknown> };
    expect(envelope.type).toBe("run-ledger.project");
    expect(envelope.id.startsWith("run-ledger-project:reports:rep-1:")).toBe(true);
    expect(envelope.data).toEqual({
      ledger: "reports",
      naturalKey: "rep-1",
      tenantId: "primary",
      userLogin: "alice",
    });
    expect(JSON.stringify(envelope)).not.toContain("Scanned 100");
  });

  it("no queue binding, bad ledger, and default login are named refusals, never throws", async () => {
    const noQueue = await publishRunLedgerProject({
      queue: null,
      message: { ledger: "reports", naturalKey: "rep-1", tenantId: "primary", userLogin: "alice" },
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(noQueue).toEqual({
      published: false,
      reason: expect.stringContaining("no SCREENER_EVENTS queue binding"),
    });
    const badLedger = await publishRunLedgerProject({
      queue: { send: async () => {} } as never,
      message: { ledger: "bogus", naturalKey: "rep-1", tenantId: "primary", userLogin: "alice" } as never,
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(badLedger.published).toBe(false);
    const defaultLogin = await publishRunLedgerProject({
      queue: { send: async () => {} } as never,
      message: { ledger: "reports", naturalKey: "rep-1", tenantId: "primary", userLogin: "default" },
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(defaultLogin.published).toBe(false);
  });

  it("a send throw is a failed publish, never a throw into the DO write", async () => {
    const res = await publishRunLedgerProject({
      queue: {
        send: async () => {
          throw new Error("queue down");
        },
      } as never,
      message: { ledger: "async_jobs", naturalKey: "job-1", tenantId: "primary", userLogin: "alice" },
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(res.published).toBe(false);
  });

  it("the guard accepts only well-shaped run-ledger.project envelopes", () => {
    const good = runLedgerProjectEvent({
      ledger: "async_jobs",
      naturalKey: "job-1",
      tenantId: "primary",
      userLogin: "alice",
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(isRunLedgerProjectEnvelope(good)).toBe(true);
    expect(extractRunLedgerProject(good)).toEqual({
      ledger: "async_jobs",
      naturalKey: "job-1",
      tenantId: "primary",
      userLogin: "alice",
    });
    expect(isRunLedgerProjectEnvelope({ ...good, type: "options_analysis" })).toBe(false);
    expect(isRunLedgerProjectEnvelope({ ...good, data: { ledger: "reports" } })).toBe(false);
    expect(extractRunLedgerProject({ ...good, type: "job.completed" })).toBeNull();
  });

  it("the consumer routes run-ledger.project to the projector and keeps options_analysis working", async () => {
    const projected: unknown[] = [];
    const options: unknown[] = [];
    const handler = createScreenerEventsWorkHandler({
      dispatchOptionsAnalysis: async (payload, runId, unitId) => {
        options.push({ payload, runId, unitId });
        return "dispatched";
      },
      dispatchRunLedgerProject: async (project) => {
        projected.push(project);
        return "projected";
      },
    });
    const projectEnvelope = runLedgerProjectEvent({
      ledger: "reports",
      naturalKey: "rep-1",
      tenantId: "primary",
      userLogin: "alice",
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(await handler(projectEnvelope)).toBe("processed");
    expect(projected).toEqual([
      { ledger: "reports", naturalKey: "rep-1", tenantId: "primary", userLogin: "alice" },
    ]);
    expect(options).toHaveLength(0);
    const optionsEnvelope = {
      specversion: "1.0" as const,
      id: "opt-1",
      source: "test",
      type: "options_analysis",
      time: "2026-11-12T00:01:00.000Z",
      data: { payload: { userLogin: "alice" } },
    };
    expect(await handler(optionsEnvelope)).toBe("processed");
    expect(options).toHaveLength(1);
    expect(projected).toHaveLength(1);
  });

  it("without a run-ledger dispatch the envelope drops with a dead-letter record", async () => {
    const drops: unknown[] = [];
    const handler = createScreenerEventsWorkHandler({
      dispatchOptionsAnalysis: async () => "dispatched",
      onDeadLetter: { record: (r: unknown) => void drops.push(r) },
    });
    const envelope = runLedgerProjectEvent({
      ledger: "reports",
      naturalKey: "rep-1",
      tenantId: "primary",
      userLogin: "alice",
      at: "2026-11-12T00:01:00.000Z",
    });
    expect(await handler(envelope)).toBe("drop");
    expect(drops).toHaveLength(1);
  });
});

describe("write-site hooks (ORM + queue carriers, #4116)", () => {
  const hookEnv = (mock: MockD1Database, queue?: { send: (msg: unknown) => Promise<void> }) => ({
    AGENT_DB: mock as never,
    IAAA_TENANT_ID: "primary",
    SCREENER_EVENTS: queue as never,
  });

  async function configureCarriers(
    mock: MockD1Database,
    carriers: { queues: boolean; orm: boolean; sweep: boolean },
  ) {
    const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
    await ensureRunLedgerTables(adapter);
    await adapter.setTenantProjectionCarriers("primary", carriers, "merged", Date.now());
  }

  it("the report hook projects the landed row (with the twin link) and publishes the queue claim-check", async () => {
    const mock = new MockD1Database();
    await configureCarriers(mock, { queues: true, orm: true, sweep: false });
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    await new D1JobRunRecordStore(jobDb).record(jobRecord());
    const sent: unknown[] = [];
    const env = hookEnv(mock, { send: async (msg: unknown) => void sent.push(msg) });
    const sql = new MockSqlStorage();
    const stored = storeReportAtGeneration(sql, {
      runId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      title: "Market screen — ALL (scheduled)",
      source: "screener",
      summary: "Scanned 100 symbols, 5 matched, 3 opportunities.",
      userLogin: "alice",
      body: { timestamp: "2026-11-12T00:00:00.000Z", success: true },
      createdAt: "2026-11-12T00:00:00.000Z",
    });
    expect(stored).not.toBeNull();
    await projectCanonicalReportBestEffort({
      env,
      sql: sql as never,
      reportId: stored!.reportId,
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      userLogin: "alice",
    });
    const audit = createAuditReportAdapter({ AGENT_DB: mock as never })!;
    const listed = await audit.listReports("primary", { limit: 10 });
    expect(listed).toHaveLength(1);
    expect(listed[0].linkedJobRunId).toContain("d1:screener:chat:ALL");
    expect(sent).toHaveLength(1);
    expect((sent[0] as { type: string }).type).toBe("run-ledger.project");
    expect((sent[0] as { data: Record<string, unknown> }).data).toEqual({
      ledger: "reports",
      naturalKey: stored!.reportId,
      tenantId: "primary",
      userLogin: "alice",
    });
  });

  it("an unconfigured tenant projects nothing and publishes nothing, by name", async () => {
    const mock = new MockD1Database();
    const sent: unknown[] = [];
    const env = hookEnv(mock, { send: async (msg: unknown) => void sent.push(msg) });
    const sql = new MockSqlStorage();
    const stored = storeReportAtGeneration(sql, {
      runId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      title: "Market screen — ALL (scheduled)",
      source: "screener",
      summary: "Scanned 100 symbols.",
      userLogin: "alice",
      body: { timestamp: "2026-11-12T00:00:00.000Z", success: true },
      createdAt: "2026-11-12T00:00:00.000Z",
    });
    await projectCanonicalReportBestEffort({
      env,
      sql: sql as never,
      reportId: stored!.reportId,
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      userLogin: "alice",
    });
    const audit = createAuditReportAdapter({ AGENT_DB: mock as never })!;
    expect(await audit.listReports("primary", { limit: 10 })).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("a missing report row is a skip, never a throw into the DO write", async () => {
    const mock = new MockD1Database();
    await configureCarriers(mock, { queues: true, orm: true, sweep: false });
    const sql = new MockSqlStorage();
    await expect(
      projectCanonicalReportBestEffort({
        env: hookEnv(mock),
        sql: sql as never,
        reportId: "no-such-report",
        generationId: "screener:2026-11-12T00:00:00.000Z",
        userLogin: "alice",
      }),
    ).resolves.toBeNull();
  });

  it("the async-job hook projects the row and publishes the claim-check", async () => {
    const mock = new MockD1Database();
    await configureCarriers(mock, { queues: true, orm: true, sweep: false });
    const sent: unknown[] = [];
    const env = hookEnv(mock, { send: async (msg: unknown) => void sent.push(msg) });
    const row: AsyncJobStoredRow = {
      job_id: "job-42",
      session_id: "sess-1",
      capability: "screener.run",
      display_name: "Market screen",
      status: "queued",
      payload_json: JSON.stringify({ userLogin: "alice" }),
      result_json: null,
      response_status: null,
      error: null,
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
      started_at: null,
      completed_at: null,
      parent_job_id: null,
      job_kind: "main",
      channel: null,
      not_before: null,
      stage: null,
      chain_id: null,
      stuck_alerted_at: null,
    } as AsyncJobStoredRow;
    await projectAsyncJobBestEffort({ env, row });
    const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
    const listed = await adapter.listAsyncJobs("primary", 10);
    expect(listed).toHaveLength(1);
    expect(listed[0].jobId).toBe("job-42");
    expect(listed[0].status).toBe("queued");
    expect(sent).toHaveLength(1);
    expect((sent[0] as { data: Record<string, unknown> }).data).toEqual({
      ledger: "async_jobs",
      naturalKey: "job-42",
      tenantId: "primary",
      userLogin: "alice",
    });
  });

  it("the async-job hook with no owning login still ORM-projects but skips the queue (no identity to route to)", async () => {
    const mock = new MockD1Database();
    await configureCarriers(mock, { queues: true, orm: true, sweep: false });
    const sent: unknown[] = [];
    const env = hookEnv(mock, { send: async (msg: unknown) => void sent.push(msg) });
    const row: AsyncJobStoredRow = {
      job_id: "job-43",
      session_id: "sess-1",
      capability: "screener.run",
      display_name: "Market screen",
      status: "completed",
      payload_json: JSON.stringify({}),
      result_json: JSON.stringify({ status: "completed" }),
      response_status: null,
      error: null,
      created_at: "2026-11-12T00:00:00.000Z",
      updated_at: "2026-11-12T00:00:00.000Z",
      started_at: null,
      completed_at: "2026-11-12T00:01:00.000Z",
      parent_job_id: null,
      job_kind: "main",
      channel: null,
      not_before: null,
      stage: null,
      chain_id: null,
      stuck_alerted_at: null,
    } as AsyncJobStoredRow;
    await projectAsyncJobBestEffort({ env, row });
    const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
    expect(await adapter.listAsyncJobs("primary", 10)).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("skipQueue projects via ORM but publishes nothing (the queue consumer's re-projection, no loop)", async () => {
    const mock = new MockD1Database();
    await configureCarriers(mock, { queues: true, orm: true, sweep: false });
    const sent: unknown[] = [];
    const env = hookEnv(mock, { send: async (msg: unknown) => void sent.push(msg) });
    const sql = new MockSqlStorage();
    const stored = storeReportAtGeneration(sql, {
      runId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      title: "Market screen — ALL (scheduled)",
      source: "screener",
      summary: "Scanned 100 symbols.",
      userLogin: "alice",
      body: { timestamp: "2026-11-12T00:00:00.000Z", success: true },
      createdAt: "2026-11-12T00:00:00.000Z",
    });
    const res = await projectCanonicalReportBestEffort({
      env,
      sql: sql as never,
      reportId: stored!.reportId,
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      userLogin: "alice",
      skipQueue: true,
    });
    expect(res?.projected).toBe(true);
    const audit = createAuditReportAdapter({ AGENT_DB: mock as never })!;
    expect(await audit.listReports("primary", { limit: 10 })).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });
});

describe("sweep carrier (one-off backfill, #4116)", () => {
  async function seedDoRows(sql: MockSqlStorage) {
    const reportIds: string[] = [];
    for (const n of [1, 2]) {
      const stored = storeReportAtGeneration(sql, {
        runId: `screener:chat:ALL:2026-11-12T00:00:0${n}.000Z:abcd123${n}`,
        generationId: `screener:chat:ALL:2026-11-12T00:00:0${n}.000Z:abcd123${n}`,
        title: `Market screen — ALL (scheduled) #${n}`,
        source: "screener",
        summary: "Scanned 100 symbols.",
        userLogin: "alice",
        body: { timestamp: `2026-11-12T00:00:0${n}.000Z`, success: true },
        createdAt: `2026-11-12T00:00:0${n}.000Z`,
      });
      reportIds.push(stored!.reportId);
    }
    const ports = createAsyncJobPorts(sql as never);
    ports.queue.ensureSchema();
    ports.queue.insertQueued({
      jobId: "job-sweep-1",
      sessionId: "sess-1",
      capability: "screener.run",
      displayName: "Market screen",
      payloadJson: JSON.stringify({ userLogin: "alice" }),
      nowIso: "2026-11-12T00:00:00.000Z",
      parentJobId: null,
      jobKind: "main",
      channel: null,
      notBefore: null,
      stage: null,
      chainId: null,
      trigger: "manual",
      triggeredBy: "manual",
      scheduleId: null,
    });
    return reportIds;
  }

  async function configureSweep(mock: MockD1Database, sweep: boolean) {
    const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
    await ensureRunLedgerTables(adapter);
    await adapter.setTenantProjectionCarriers(
      "primary",
      { queues: false, orm: true, sweep },
      "merged",
      Date.now(),
    );
  }

  it("projects every missed row; a second run reconciles zero (already-current)", async () => {
    const mock = new MockD1Database();
    await configureSweep(mock, true);
    const sql = new MockSqlStorage();
    await seedDoRows(sql);
    const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
    const first = await reconcileRunLedgerProjection({ env, sql: sql as never, sessionId: "sess-1" });
    expect(first).toEqual({ checked: 3, reconciled: 3, alreadyCurrent: 0, errors: [] });
    const audit = createAuditReportAdapter({ AGENT_DB: mock as never })!;
    expect(await audit.listReports("primary", { limit: 10 })).toHaveLength(2);
    const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
    expect(await adapter.listAsyncJobs("primary", 10)).toHaveLength(1);
    const second = await reconcileRunLedgerProjection({ env, sql: sql as never, sessionId: "sess-1" });
    expect(second).toEqual({ checked: 3, reconciled: 0, alreadyCurrent: 3, errors: [] });
  });

  it("the limit bounds each ledger per call", async () => {
    const mock = new MockD1Database();
    await configureSweep(mock, true);
    const sql = new MockSqlStorage();
    await seedDoRows(sql);
    const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
    const limited = await reconcileRunLedgerProjection({ env, sql: sql as never, sessionId: "sess-1", limit: 1 });
    expect(limited.checked).toBe(2);
    expect(limited.reconciled).toBe(2);
  });

  it("a tenant without the sweep carrier gets a named refusal, never a silent zero-row pass", async () => {
    const mock = new MockD1Database();
    await configureSweep(mock, false);
    const sql = new MockSqlStorage();
    await seedDoRows(sql);
    const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
    const res = await reconcileRunLedgerProjection({ env, sql: sql as never, sessionId: "sess-1" });
    expect(res.checked).toBe(0);
    expect(res.refused).toContain("sweep carrier not configured for tenant primary");
  });

  it("a failing store collects per-row errors and never throws", async () => {
    const mock = new MockD1Database();
    await configureSweep(mock, true);
    const sql = new MockSqlStorage();
    await seedDoRows(sql);
    // Selective failure: reads (incl. the carrier-config read)
    // succeed, but every INSERT fails — so the sweep checks all
    // three rows and collects one error per row instead of
    // refusing at the config gate.
    const throwing = {
      prepare(query: string) {
        if (/^\s*insert\s+into/i.test(query)) throw new Error("d1 down");
        return mock.prepare(query);
      },
    };
    const env = { AGENT_DB: throwing as never, IAAA_TENANT_ID: "primary" };
    const res = await reconcileRunLedgerProjection({ env, sql: sql as never, sessionId: "sess-1" });
    expect(res.checked).toBe(3);
    expect(res.reconciled).toBe(0);
    expect(res.errors).toHaveLength(3);
    expect(res.errors.map((e) => e.ledger).sort()).toEqual(["async_jobs", "reports", "reports"]);
  });
});

describe("queue consumer DO door (projectQueuedRunLedger, #4116)", () => {
  it("projects, reports already-current on replay, and names a missing row", async () => {
    const mock = new MockD1Database();
    const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
    await ensureRunLedgerTables(adapter);
    await adapter.setTenantProjectionCarriers(
      "primary",
      { queues: true, orm: true, sweep: true },
      "merged",
      Date.now(),
    );
    const sql = new MockSqlStorage();
    const stored = storeReportAtGeneration(sql, {
      runId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      title: "Market screen — ALL (scheduled)",
      source: "screener",
      summary: "Scanned 100 symbols.",
      userLogin: "alice",
      body: { timestamp: "2026-11-12T00:00:00.000Z", success: true },
      createdAt: "2026-11-12T00:00:00.000Z",
    });
    const agent = new OrchestratorAgent(
      {
        id: { toString: () => "alice" },
        storage: { sql },
        waitUntil: () => {},
      } as never,
      { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" } as never,
    );
    const first = await agent.projectQueuedRunLedger({
      ledger: "reports",
      naturalKey: stored!.reportId,
      tenantId: "primary",
      userLogin: "alice",
    });
    expect(first).toEqual({ status: "projected" });
    const second = await agent.projectQueuedRunLedger({
      ledger: "reports",
      naturalKey: stored!.reportId,
      tenantId: "primary",
      userLogin: "alice",
    });
    expect(second).toEqual({ status: "already-current" });
    const missing = await agent.projectQueuedRunLedger({
      ledger: "reports",
      naturalKey: "no-such-report",
      tenantId: "primary",
      userLogin: "alice",
    });
    expect(missing).toEqual({ status: "missing-row" });
    const audit = createAuditReportAdapter({ AGENT_DB: mock as never })!;
    expect(await audit.listReports("primary", { limit: 10 })).toHaveLength(1);
  });
});

describe("owner scope + backfill (migration 0060, #4116)", () => {
  async function projector() {
    const mock = new MockD1Database();
    const auditDb = createD1AuditReportDb(mock as never);
    await ensureAuditReportSchema(auditDb);
    const reportStore = new D1AuditReportAdapter(auditDb);
    const runDb = createD1RunLedgerDb(mock as never);
    await ensureRunLedgerSchema(runDb);
    const asyncJobStore = new D1RunLedgerAdapter(runDb);
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    const jobRecordStore = new D1JobRunRecordStore(jobDb);
    const p = createRunLedgerProjector({ reportStore, asyncJobStore, jobRecordStore });
    return { p, reportStore, asyncJobStore, jobRecordStore, mock };
  }

  it("listReports filters by owner exactly like the DO read; unfiltered stays tenant-scoped", async () => {
    const { p, reportStore } = await projector();
    await p.projectReport(reportInput(), Date.now());
    await p.projectReport(
      reportInput({ reportId: "rep-2", userLogin: "bob", generationId: "screener:chat:ALL:2026-11-12T00:02:00.000Z:bbbb2222" }),
      Date.now(),
    );
    expect(await reportStore.listReports("primary", { userLogin: "alice" })).toHaveLength(1);
    expect((await reportStore.listReports("primary", { userLogin: "alice" }))[0].reportId).toBe("rep-1");
    expect(await reportStore.listReports("primary", { userLogin: "bob" })).toHaveLength(1);
    expect(await reportStore.listReports("primary")).toHaveLength(2);
  });

  it("a re-projection that now knows the owner upgrades the null owner to version+1 (backfill)", async () => {
    const { p, reportStore } = await projector();
    const first = await p.projectReport(reportInput({ userLogin: null }), Date.now());
    expect(first.projected).toBe(true);
    const second = await p.projectReport(reportInput({ userLogin: "alice" }), Date.now());
    expect(second.projected).toBe(true);
    const latest = await reportStore.latestReport("primary", "rep-1");
    expect(latest?.version).toBe(2);
    expect(latest?.userLogin).toBe("alice");
    const third = await p.projectReport(reportInput({ userLogin: "alice" }), Date.now());
    expect(third.projected).toBe(false);
    expect(third.skipped).toBe("already-current");
  });

  it("a re-projection after the job twin lands upgrades the null link to version+1 (backfill)", async () => {
    const { p, reportStore, jobRecordStore } = await projector();
    const first = await p.projectReport(reportInput(), Date.now());
    expect(first.projected).toBe(true);
    expect(first.linkedJobRunId).toBeNull();
    await jobRecordStore.record(jobRecord());
    const second = await p.projectReport(reportInput(), Date.now());
    expect(second.projected).toBe(true);
    expect(second.linkedJobRunId).toContain("d1:screener:chat:ALL");
    const latest = await reportStore.latestReport("primary", "rep-1");
    expect(latest?.version).toBe(2);
    expect(latest?.linkedJobRunId).toContain("d1:screener:chat:ALL");
  });

  it("listAsyncJobs filters by session (the D1-only Workflow Runs jobs read)", async () => {
    const { p, asyncJobStore } = await projector();
    await p.projectAsyncJob(asyncJobInput(), Date.now());
    await p.projectAsyncJob(asyncJobInput({ jobId: "job-async-2", sessionId: "sess-2" }), Date.now());
    expect(await asyncJobStore.listAsyncJobs("primary", 10)).toHaveLength(2);
    expect(await asyncJobStore.listAsyncJobs("primary", 10, { sessionId: "sess-1" })).toHaveLength(1);
    expect((await asyncJobStore.listAsyncJobs("primary", 10, { sessionId: "sess-2" }))[0].jobId).toBe("job-async-2");
  });
});

describe("D1-only reads + parity vs the merged view (#4116)", () => {
  /**
   * The parity fixture: DO rows (MockSqlStorage) + the engine's D1
   * job-run-record twin row, then the sweep backfills DO → D1, so
   * the fixture is honest about the projection path. The same
   * fixture is then read through both modes (the carrier config
   * row's readMode flips between calls) and the two views must
   * agree modulo linked-twin absorption: every merged run present
   * exactly once in D1-only, no extra rows, no silent loss.
   */
  const SESSION = "parity-session";

  async function parityFixture() {
    const mock = new MockD1Database();
    const sql = new MockSqlStorage();
    const jobDb = createD1JobRunRecordDb(mock as never);
    await ensureJobRunRecordsSchema(jobDb);
    await new D1JobRunRecordStore(jobDb).record(jobRecord());
    const body1 = { pdfKey: "reports/rep-1.pdf", trigger: "manual", success: true, matchedCount: 5 };
    const body2 = { pdfKey: "reports/rep-2.pdf", trigger: "scheduled", success: true, matchedCount: 2 };
    const stored1 = storeReportAtGeneration(sql as never, {
      runId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      generationId: "screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234",
      title: "Market screen — ALL (manual)",
      source: "screener",
      summary: "Scanned 100 symbols, 5 matched.",
      userLogin: "alice",
      body: body1,
      createdAt: "2026-11-12T00:01:00.000Z",
    });
    const stored2 = storeReportAtGeneration(sql as never, {
      runId: "screener:other:2026-11-12T00:10:00.000Z:efgh5678",
      generationId: "screener:other:2026-11-12T00:10:00.000Z:efgh5678",
      title: "Market screen — OTHER (scheduled)",
      source: "screener",
      summary: "Scanned 50 symbols, 2 matched.",
      userLogin: "alice",
      body: body2,
      createdAt: "2026-11-12T00:10:00.000Z",
    });
    expect(stored1).not.toBeNull();
    expect(stored2).not.toBeNull();
    const ports = createAsyncJobPorts(sql as never);
    ports.queue.ensureSchema();
    ports.queue.insertQueued({
      jobId: "job-async-1",
      sessionId: "sess-1",
      capability: "screen.stock",
      displayName: "Stock screen",
      payloadJson: JSON.stringify({ userLogin: "alice" }),
      nowIso: "2026-11-12T00:00:00.000Z",
      parentJobId: null,
      jobKind: "main",
      channel: null,
      notBefore: null,
      stage: null,
      chainId: null,
      trigger: "manual",
      triggeredBy: "alice",
      scheduleId: null,
    });
    const adapter = createRunLedgerAdapter({ AGENT_DB: mock as never })!;
    await ensureRunLedgerTables(adapter);
    await adapter.setTenantProjectionCarriers(
      "primary",
      { queues: true, orm: true, sweep: true },
      "merged",
      Date.now(),
    );
    const env = { AGENT_DB: mock as never, IAAA_TENANT_ID: "primary" };
    const swept = await reconcileRunLedgerProjection({ env, sql: sql as never, sessionId: "sess-1" });
    expect(swept.errors).toEqual([]);
    expect(swept.reconciled).toBe(3);
    const audit = createAuditReportAdapter({ AGENT_DB: mock as never })!;
    const projected = await audit.listReports("primary", { limit: 10 });
    expect(projected).toHaveLength(2);
    const twinned = projected.find((r) => r.reportId === stored1!.reportId);
    expect(twinned?.linkedJobRunId).toBe(
      "d1:screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234:2026-11-12T00:00:00.000Z:2026-11-12T00:05:00.000Z",
    );
    return { mock, sql, env, adapter, stored1: stored1!, stored2: stored2!, twinId: twinned!.linkedJobRunId! };
  }

  async function setReadMode(adapter: D1RunLedgerAdapter, mode: "merged" | "d1-only") {
    await adapter.setTenantProjectionCarriers(
      "primary",
      { queues: true, orm: true, sweep: true },
      mode,
      Date.now(),
    );
  }

  function reportsCtx(fx: Awaited<ReturnType<typeof parityFixture>>) {
    return {
      ensureTables: () => fx.sql as never,
      env: fx.env as never,
      jobRunRecordReader: async () => [jobRecord()],
      getScreenerAgent: () => ({ getHistory: async () => [] }) as never,
      getScreenerExecutionContext: async () => null as never,
    } as never;
  }

  function runsRequest() {
    return new Request("http://x/api/runs?kind=all", {
      method: "GET",
      headers: { "x-user-login": "alice" },
    });
  }

  it("resolveLedgerReadMode: unconfigured reads merged; configured d1-only reads d1-only", async () => {
    const bare = new MockD1Database();
    expect(await resolveLedgerReadMode({ AGENT_DB: bare as never })).toBe("merged");
    const fx = await parityFixture();
    expect(await resolveLedgerReadMode(fx.env)).toBe("merged");
    await setReadMode(fx.adapter, "d1-only");
    expect(await resolveLedgerReadMode(fx.env)).toBe("d1-only");
  });

  it("listProjectedReportSummaries throws when AGENT_DB is unbound (named, never silent-empty)", async () => {
    await expect(
      listProjectedReportSummaries({ AGENT_DB: undefined }, { tenantId: "primary", limit: 10 }),
    ).rejects.toThrow("AgentDB is not bound");
  });

  it("/api/runs: D1-only == merged modulo the absorbed twin (same runs, same fields, no extras)", async () => {
    const fx = await parityFixture();
    const mergedRes = await handleReportsRoutes(
      runsRequest(),
      new URL("http://x/api/runs?kind=all"),
      "/api/runs",
      SESSION,
      reportsCtx(fx),
    );
    expect(mergedRes?.status).toBe(200);
    const merged = (await mergedRes!.json()) as { runs: any[]; ledgerReadMode: string };
    expect(merged.ledgerReadMode).toBe("merged");
    await setReadMode(fx.adapter, "d1-only");
    const d1Res = await handleReportsRoutes(
      runsRequest(),
      new URL("http://x/api/runs?kind=all"),
      "/api/runs",
      SESSION,
      reportsCtx(fx),
    );
    expect(d1Res?.status).toBe(200);
    const d1 = (await d1Res!.json()) as {
      runs: any[];
      ledgerReadMode: string;
      storeErrors?: Record<string, string>;
    };
    expect(d1.ledgerReadMode).toBe("d1-only");
    // The twin is named as not-projected only for the stores that
    // have no projection; reports + jobRunRecords both land.
    expect(d1.storeErrors?.reports).toBeUndefined();
    expect(d1.storeErrors?.jobRunRecords).toBeUndefined();
    const mergedIds = merged.runs.map((r) => r.id);
    const d1Ids = d1.runs.map((r) => r.id);
    // The merged view carries the twin as its own row; D1-only
    // absorbs it into the canonical row — exactly one row fewer,
    // and every other run present exactly once.
    expect(mergedIds).toContain(fx.twinId);
    expect(d1Ids).not.toContain(fx.twinId);
    expect(d1Ids.sort()).toEqual(mergedIds.filter((id) => id !== fx.twinId).sort());
    // Field parity on the shared runs (same row, same shape).
    for (const run of d1.runs) {
      const twin = merged.runs.find((r) => r.id === run.id);
      expect(twin).toBeDefined();
      expect(run.runId).toBe(twin.runId);
      expect(run.title).toBe(twin.title);
      expect(run.status).toBe(twin.status);
      expect(run.reportUrl).toBe(twin.reportUrl);
    }
  });

  it("/api/runs/details: the twin id resolves to the canonical detail in D1-only mode", async () => {
    const fx = await parityFixture();
    const ctx = reportsCtx(fx);
    const mergedTwin = await handleReportsRoutes(
      new Request(`http://x/api/runs/details?id=${encodeURIComponent(fx.twinId)}`, { headers: { "x-user-login": "alice" } }),
      new URL(`http://x/api/runs/details?id=${encodeURIComponent(fx.twinId)}`),
      "/api/runs/details",
      SESSION,
      ctx,
    );
    expect(mergedTwin?.status).toBe(200);
    const mergedBody = (await mergedTwin!.json()) as { detail: { runId: string }; ledgerReadMode: string };
    expect(mergedBody.ledgerReadMode).toBe("merged");
    // In merged mode the twin id finds the job-run-record's own
    // detail (its runId IS the derived d1:... id).
    expect(mergedBody.detail.runId).toBe(fx.twinId);
    await setReadMode(fx.adapter, "d1-only");
    const d1Twin = await handleReportsRoutes(
      new Request(`http://x/api/runs/details?id=${encodeURIComponent(fx.twinId)}`, { headers: { "x-user-login": "alice" } }),
      new URL(`http://x/api/runs/details?id=${encodeURIComponent(fx.twinId)}`),
      "/api/runs/details",
      SESSION,
      ctx,
    );
    expect(d1Twin?.status).toBe(200);
    const d1Body = (await d1Twin!.json()) as { detail: { runId: string; reportId?: string }; ledgerReadMode: string };
    expect(d1Body.ledgerReadMode).toBe("d1-only");
    // The twin id redirects to the canonical report's detail — the
    // run is still found by its old id, never a 404.
    expect(d1Body.detail.runId).toBe("screener:chat:ALL:2026-11-12T00:00:00.000Z:abcd1234");
    expect((d1Body.detail as { id: string }).id).toBe(fx.stored1.reportId);
  });

  it("Workflow Runs: D1-only jobs + report runs == merged modulo the absorbed twin", async () => {
    const fx = await parityFixture();
    const ctx = {
      ensureTables: () => fx.sql as never,
      userLogin: "alice",
      env: fx.env as never,
      jobRunRecordReader: async () => [jobRecord()],
      scheduleReader: async () => [],
    } as never;
    const mergedRes = await handleWorkflowRunsRoutes(
      new Request("http://x/api/workflow-runs", { method: "GET" }),
      new URL("http://x/api/workflow-runs"),
      "/api/workflow-runs",
      "sess-1",
      ctx,
    );
    expect(mergedRes?.status).toBe(200);
    const merged = (await mergedRes!.json()) as { runs: any[]; ledgerReadMode: string };
    expect(merged.ledgerReadMode).toBe("merged");
    await setReadMode(fx.adapter, "d1-only");
    const d1Res = await handleWorkflowRunsRoutes(
      new Request("http://x/api/workflow-runs", { method: "GET" }),
      new URL("http://x/api/workflow-runs"),
      "/api/workflow-runs",
      "sess-1",
      ctx,
    );
    expect(d1Res?.status).toBe(200);
    const d1 = (await d1Res!.json()) as {
      runs: any[];
      ledgerReadMode: string;
      storeErrors?: Record<string, string>;
    };
    expect(d1.ledgerReadMode).toBe("d1-only");
    expect(d1.storeErrors?.jobs).toBeUndefined();
    expect(d1.storeErrors?.canonicalDocs).toBeUndefined();
    // Outcomes + transitions are not projected: empty + named.
    expect(d1.storeErrors?.outcomes).toMatch("not projected");
    expect(d1.storeErrors?.stages).toMatch("not projected");
    const mergedIds = merged.runs.map((r) => String(r.id));
    const d1Ids = d1.runs.map((r) => String(r.id));
    // The job-backed run and both report runs survive; the twin
    // job-run-record run is absorbed into the canonical report run.
    expect(mergedIds).toContain(fx.twinId);
    expect(d1Ids).not.toContain(fx.twinId);
    expect(d1Ids.sort()).toEqual(mergedIds.filter((id) => id !== fx.twinId).sort());
    // The projected async job reads as the same job-backed run.
    const d1Job = d1.runs.find((r) => String(r.id).includes("job-async-1") || (r.jobs ?? []).some((j: any) => j.job_id === "job-async-1"));
    expect(d1Job).toBeDefined();
  });
});
