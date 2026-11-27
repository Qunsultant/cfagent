// @vitest-environment node
/**
 * Issue #5102 (F5 of #5094) — audit-record provenance: every run,
 * trade, report, and delivery record carries the binding tuple it
 * executed against (accountType / accountId / bindingScope /
 * bindingSource), stored full, displayed masked.
 *
 * What this file pins (F5's own surface):
 *  - the builder validates the four fields like the linkage ids
 *    (string-or-null, non-empty, never a poisoned #3650 literal)
 *    and omits them when the caller passes none;
 *  - the normalizer reads a legacy row (no binding keys) as
 *    EXPLICIT nulls — unbound, never a guessed binding — and
 *    sanitizes poisoned literals to null;
 *  - migration 0084 applies cleanly on a pre-F5 D1 database
 *    (0047 + 0072 + 0073 + 0076 + 0081) and the legacy row reads
 *    unbound afterwards; a bound row round-trips through the D1
 *    store with the full tuple;
 *  - a non-broker goal firing still records, with explicit nulls
 *    (the scheduled-agent funnel stamps `?? null`, never a fresh
 *    ambient read at fire time — F3's rule);
 *  - a delivery run carries the generating run's tuple from its
 *    options, and stamps explicit nulls without them (the
 *    pipeline-step caller passes nothing — see the PR body);
 *  - the binding filter parses strictly (invalid = rejected,
 *    never a silent empty page) and matches exactly, with an
 *    unbound row never matching a present field;
 *  - a brokered audit event carries the binding fields;
 *  - RunSummary / WorkflowRun mappers carry the tuple, and the
 *    merge hands a canonical report row its D1 ledger twin's
 *    tuple when its own body carries none ("reports ride the
 *    run row").
 *
 * What this file does NOT re-pin (already pinned elsewhere — one
 * of everything):
 *  - the builder carrying a present tuple: tests/job-run-records-2964.test.ts
 *    ("carries the bound-account tuple on the record when present (#5100)");
 *  - preview stamping the tuple + execute refusing a re-bound
 *    account (409, masked): tests/broker_orders_3089.test.ts
 *    ("the re-preview re-stamps the tuple too", "execute with a
 *    re-bound account is refused (409)");
 *  - the enforcement refusal itself (unbound slot fails loud with
 *    FAILURE_ACCOUNT_BINDING_MISSING):
 *    tests/account_binding_validation_5098.test.ts:386;
 *  - the CSV bytes: unchanged by design — the screener CSV columns
 *    mirror the XLSX tab column-for-column and the module forbids
 *    comment lines ("Provenance rides in report metadata, never in
 *    the CSV bytes"); the binding rides the run row, not the file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/orchestrate", () => ({
  OPERATION_CATALOG: [
    {
      agent: "test",
      binding: "SCHEDULED_AGENT",
      operations: ["test.op", "index.refresh_holdings"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({
    jobId: "job_test_1",
    ...req,
    status: "pending",
  })),
}));

vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: vi.fn(),
}));
vi.mock("../src/security/storageRetention", () => ({
  runStorageRetention: vi.fn(),
}));
vi.mock("../src/security/etradeOAuth", () => ({
  getStoredTokens: vi.fn(),
  isTokenExpiredEt: vi.fn(() => false),
  etradeIdentityFromLogin: vi.fn(async () => ({})),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";
import {
  buildJobRunRecord,
  normalizeJobRunRecord,
  type JobRunRecord,
} from "../src/services/jobRunRecords";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  MIGRATION_0047_JOB_RUN_RECORDS,
  MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
  MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
  MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
  MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
  MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { accountBindingAuditFields } from "../src/services/accountBindings";
import {
  isEmptyBindingFilter,
  matchesBindingFilter,
  parseBindingFilter,
} from "../src/services/bindingFilter";
import {
  mergeRunSummaries,
  runSummaryFromJobRunRecord,
  runSummaryFromReport,
} from "../src/services/runSummaries";
import { runFromJobRunRecord } from "../src/services/workflowRuns";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import type { GeneratedDatasetStoreInput } from "../src/data/generatedDatasetPorts";
import {
  buildDeliverJobRegistry,
  runDeliverJob,
  type DeliverChannelSenders,
} from "../src/services/deliverJobs";
import { makeLedgerStub } from "./ledger-stub";

/** Minimal D1Database stand-in over node:sqlite (the foundation tests' double). */
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

// #6503 — the "goals" KV key is dead: goals live in the D1 unified
// store only (fail-closed without AGENT_DB). Fixtures plant via D1.
function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    _store: store,
  };
}

function makeEnv() {
  return {
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB). This file's own node:sqlite MockD1Database
    // (above) is the store; the tick resolves it from the env.
    AGENT_DB: new MockD1Database(),
    // #6101 step 9 — the KV "jobRunRecords" key is retired: the
    // fired goal's run lands via the ledger post on
    // ORCHESTRATOR_AGENT (the shared stub), and listJobRuns reads
    // it back from there.
    ORCHESTRATOR_AGENT: makeLedgerStub().namespace,
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
  };
}

function testGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-goal",
    name: "Test goal",
    cron: "0 6 * * *",
    operation: "test.op",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

const BOUND = {
  accountType: "stock",
  accountId: "PA-9001234",
  bindingScope: "schedule",
  bindingSource: "binding",
} as const;

function boundRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return buildJobRunRecord({
    system: "orchestrator-schedule",
    jobId: "sched-5102",
    operation: "autonomousMarketScreen",
    started: "2026-11-03T00:00:00.000Z",
    finished: "2026-11-03T00:00:01.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    ...BOUND,
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("builder + normalizer (#5102)", () => {
  it("omits the tuple when the caller passes none — absence is not a value", () => {
    const record = buildJobRunRecord({
      system: "scheduled-agent-goal",
      jobId: "test-goal",
      operation: "test.op",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    });
    expect(record.accountType).toBeUndefined();
    expect(record.accountId).toBeUndefined();
    expect(record.bindingScope).toBeUndefined();
    expect(record.bindingSource).toBeUndefined();
    // …and the read path turns that absence into explicit nulls.
    const read = normalizeJobRunRecord(record);
    expect(read.accountType).toBeNull();
    expect(read.accountId).toBeNull();
    expect(read.bindingScope).toBeNull();
    expect(read.bindingSource).toBeNull();
  });

  it("rejects a poisoned-literal, empty, or non-string binding field like a linkage id (#3650)", () => {
    const base = {
      system: "orchestrator-schedule" as const,
      jobId: "sched-5102",
      operation: "autonomousMarketScreen",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success" as const,
      triggeredBy: "scheduled" as const,
    };
    for (const key of ["accountType", "accountId", "bindingScope", "bindingSource"] as const) {
      expect(() => buildJobRunRecord({ ...base, [key]: "undefined" })).toThrow(
        `Job run ${key} must be a real id or null`,
      );
      expect(() => buildJobRunRecord({ ...base, [key]: "null" })).toThrow(
        `Job run ${key} must be a real id or null`,
      );
      expect(() => buildJobRunRecord({ ...base, [key]: "" })).toThrow(
        `Job run ${key} must be a non-empty string or null.`,
      );
      expect(() => buildJobRunRecord({ ...base, [key]: 42 as never })).toThrow(
        `Job run ${key} must be a string or null.`,
      );
    }
    // Explicit nulls are fine — that is the unbound stamp.
    expect(() =>
      buildJobRunRecord({
        ...base,
        accountType: null,
        accountId: null,
        bindingScope: null,
        bindingSource: null,
      }),
    ).not.toThrow();
  });

  it("normalizer: a legacy row with no binding keys reads as explicit nulls", () => {
    const legacy = boundRecord();
    delete (legacy as any).accountType;
    delete (legacy as any).accountId;
    delete (legacy as any).bindingScope;
    delete (legacy as any).bindingSource;
    const read = normalizeJobRunRecord(legacy);
    expect(read.accountType).toBeNull();
    expect(read.accountId).toBeNull();
    expect(read.bindingScope).toBeNull();
    expect(read.bindingSource).toBeNull();
    expect(read.jobId).toBe("sched-5102");
  });

  it("normalizer: poisoned-literal binding values sanitize to null, real values pass through", () => {
    const poisoned = normalizeJobRunRecord({
      ...boundRecord(),
      accountType: "undefined",
      accountId: "null",
      bindingScope: "",
      bindingSource: "binding",
    });
    expect(poisoned.accountType).toBeNull();
    expect(poisoned.accountId).toBeNull();
    expect(poisoned.bindingScope).toBeNull();
    expect(poisoned.bindingSource).toBe("binding");
    const kept = normalizeJobRunRecord(boundRecord());
    expect(kept.accountType).toBe("stock");
    expect(kept.accountId).toBe("PA-9001234");
    expect(kept.bindingScope).toBe("schedule");
    expect(kept.bindingSource).toBe("binding");
  });
});

describe("migration 0084 + adapters (#5102)", () => {
  it("0084 is registered, versioned 84, and carries the four ALTERs + the binding index", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0084_JOB_RUN_RECORDS_BINDING);
    expect(MIGRATION_0084_JOB_RUN_RECORDS_BINDING.version).toBe(84);
    expect(MIGRATION_0084_JOB_RUN_RECORDS_BINDING.name).toBe(
      "0084_job_run_records_binding",
    );
    expect(MIGRATION_0084_JOB_RUN_RECORDS_BINDING.sql).toContain(
      "ALTER TABLE job_run_records ADD COLUMN account_type TEXT",
    );
    expect(MIGRATION_0084_JOB_RUN_RECORDS_BINDING.sql).toContain(
      "ALTER TABLE job_run_records ADD COLUMN account_id TEXT",
    );
    expect(MIGRATION_0084_JOB_RUN_RECORDS_BINDING.sql).toContain(
      "ALTER TABLE job_run_records ADD COLUMN binding_scope TEXT",
    );
    expect(MIGRATION_0084_JOB_RUN_RECORDS_BINDING.sql).toContain(
      "ALTER TABLE job_run_records ADD COLUMN binding_source TEXT",
    );
    expect(MIGRATION_0084_JOB_RUN_RECORDS_BINDING.sql).toContain(
      "job_run_records_binding_idx",
    );
  });

  it("0084 applies cleanly on a pre-F5 D1 database and the legacy row reads unbound", async () => {
    const mock = new MockD1Database();
    const db = createD1JobRunRecordDb(mock as never);
    // The pre-F5 database: everything up to 0081, no binding columns.
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0047_JOB_RUN_RECORDS,
      MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
      MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
      MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
      MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
    ]);
    // A legacy row, written with only the pre-F5 columns.
    mock.sqlite
      .prepare(
        "INSERT INTO job_run_records (system, job_id, operation, started, finished, outcome, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "orchestrator-schedule",
        "sched-legacy",
        "autonomousMarketScreen",
        "2026-11-03T00:00:00.000Z",
        "2026-11-03T00:00:01.000Z",
        "success",
        "scheduled",
      );
    // Now 0084 lands on the live table.
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
    ]);
    const store = new D1JobRunRecordStore(db);
    const runs = await store.listRecent(10);
    expect(runs).toHaveLength(1);
    expect(runs[0].jobId).toBe("sched-legacy");
    expect(runs[0].accountType).toBeNull();
    expect(runs[0].accountId).toBeNull();
    expect(runs[0].bindingScope).toBeNull();
    expect(runs[0].bindingSource).toBeNull();
    // Applying 0084 again is a no-op (idempotent ensure).
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
    ]);
    expect((await store.listRecent(10))).toHaveLength(1);
  });

  it("D1 store round-trips a bound row with the full tuple", async () => {
    const mock = new MockD1Database();
    const db = createD1JobRunRecordDb(mock as never);
    const store = new D1JobRunRecordStore(db);
    await store.record(boundRecord());
    const runs = await store.listRecent(10);
    expect(runs).toHaveLength(1);
    expect(runs[0].accountType).toBe("stock");
    expect(runs[0].accountId).toBe("PA-9001234");
    expect(runs[0].bindingScope).toBe("schedule");
    expect(runs[0].bindingSource).toBe("binding");
  });

  it("D1 store round-trips bound and unbound rows", async () => {
    const mock = new MockD1Database();
    const db = createD1JobRunRecordDb(mock as never);
    const store = new D1JobRunRecordStore(db);
    await store.record(boundRecord());
    await store.record(
      buildJobRunRecord({
        system: "scheduled-agent-goal",
        jobId: "test-goal",
        operation: "test.op",
        started: "2026-11-03T00:00:00.000Z",
        finished: "2026-11-03T00:00:01.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
        accountType: null,
        accountId: null,
        bindingScope: null,
        bindingSource: null,
      }),
    );
    const bound = await store.latestByJob("sched-5102");
    expect(bound?.accountId).toBe("PA-9001234");
    expect(bound?.bindingScope).toBe("schedule");
    const unbound = await store.latestByJob("test-goal");
    expect(unbound?.accountType).toBeNull();
    expect(unbound?.accountId).toBeNull();
    expect(unbound?.bindingScope).toBeNull();
    expect(unbound?.bindingSource).toBeNull();
  });

  it("in-memory store keeps the record object, tuple included", async () => {
    const store = new InMemoryJobRunRecordStore();
    await store.record(boundRecord());
    const runs = await store.listRecent(10);
    expect(runs).toHaveLength(1);
    expect(runs[0].accountId).toBe("PA-9001234");
  });
});

describe("scheduled-agent funnel (#5102)", () => {
  it("a fired non-broker goal still records, with explicit nulls", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const ctx = makeCtx();
    const env = makeEnv();
    // #6503 — plant the fixture goal in D1, sweeping migration
    // 0092's seeded built-ins so the tick sees ONLY test-goal
    // (same pattern as the #6503 G3 goals-tick file).
    const store = createD1UnifiedSchedulePorts({
      d1: (env as any).AGENT_DB as never,
    }).unifiedSchedules;
    await store.save(goalToRecord(testGoal() as any));
    for (const row of await store.listByKind("goal")) {
      if (row.id !== "test-goal") await store.remove(row.id);
    }
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsCreated).toBe(1);
    const runs = await agent.listJobRuns("test-goal");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("success");
    // Explicit nulls — the keys are present, the values are null:
    // the row says "unbound" instead of saying nothing at all.
    expect("accountType" in runs[0]).toBe(true);
    expect("accountId" in runs[0]).toBe(true);
    expect("bindingScope" in runs[0]).toBe(true);
    expect("bindingSource" in runs[0]).toBe(true);
    expect(runs[0].accountType).toBeNull();
    expect(runs[0].accountId).toBeNull();
    expect(runs[0].bindingScope).toBeNull();
    expect(runs[0].bindingSource).toBeNull();
  });
});

describe("delivery runs (#5102)", () => {
  const GENERATE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze-generate";
  const JOB = `${GENERATE_JOB}-deliver`;
  const T0 = Date.parse("2026-11-07T13:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const PDF_B64 = Buffer.from("PDFBYTES").toString("base64");

  function generatedInput(runId: string, atMs: number): GeneratedDatasetStoreInput {
    return {
      jobId: GENERATE_JOB,
      analyzeJobId: "yahoo-nasdaq100-quotes-enrich-analyze",
      enrichJobId: "yahoo-nasdaq100-quotes-enrich",
      feedJobId: "yahoo-nasdaq100-quotes",
      sourceId: "yahoo",
      dataset: "quotes",
      universe: {
        kind: "index",
        index: "nasdaq100",
        label: "Nasdaq-100",
        snapshotDate: "2026-11-02",
        sourceLabel: "Wikipedia (Nasdaq-100 table)",
        size: 2,
      },
      inputArtifactId: `analyzed-${runId}`,
      inputRunId: `analyze-${runId}`,
      inputAsOf: iso(atMs - 3600_000),
      reportsRequested: ["analysis"],
      formatsRequested: ["json", "markdown", "pdf"],
      reports: [
        {
          kind: "analysis",
          title: "Analysis — yahoo quotes",
          formats: [
            {
              format: "json",
              status: "generated",
              contentType: "application/json",
              bodyText: '{"ok":true}',
              bodyBase64: null,
              sizeBytes: 10,
              codedError: null,
              errorMessage: null,
            },
            {
              format: "markdown",
              status: "generated",
              contentType: "text/markdown",
              bodyText: "# Analysis\nbody",
              bodyBase64: null,
              sizeBytes: 15,
              codedError: null,
              errorMessage: null,
            },
            {
              format: "pdf",
              status: "generated",
              contentType: "application/pdf",
              bodyText: null,
              bodyBase64: PDF_B64,
              sizeBytes: 8,
              codedError: null,
              errorMessage: null,
            },
          ],
          canonical: {
            status: "not_wired",
            reportId: null,
            fanoutCode: null,
            reason: "canonical_report_store_not_wired",
          },
        },
      ],
      summary: {
        reportsGenerated: 1,
        formatsGenerated: 3,
        formatsFailed: 0,
        canonicalStored: 0,
        canonicalNotWired: 1,
      },
      run: {
        runId,
        trigger: "manual",
        startedAt: iso(atMs),
        finishedAt: iso(atMs + 1000),
        status: "completed",
        requested: 3,
        received: 3,
        failed: 0,
        codedError: null,
        errorMessage: null,
      },
      nowIso: iso(atMs),
    };
  }

  function spySenders(): { senders: DeliverChannelSenders; calls: { slack: any[]; email: any[]; webhook: any[] } } {
    const calls = { slack: [] as any[], email: [] as any[], webhook: [] as any[] };
    return {
      calls,
      senders: {
        slack: async (input: any) => {
          calls.slack.push(input);
          return { ok: true };
        },
        email: async (input: any) => {
          calls.email.push(input);
          return { ok: true };
        },
        webhook: async (input: any) => {
          calls.webhook.push(input);
          return { ok: true, target: "hooks.example.com" };
        },
      },
    };
  }

  async function seededWorld() {
    const generatedStore = new InMemoryGeneratedDatasetStore();
    await generatedStore.store(generatedInput("gen-1", T0));
    const deliveryStore = new InMemoryDeliveryDatasetStore();
    const registry = buildDeliverJobRegistry({
      DELIVER_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_DELIVER_EMAIL_TO:
        "ops@example.com",
      DELIVER_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_DELIVER_SLACK_CHANNEL:
        "#reports",
    });
    return { generatedStore, deliveryStore, registry };
  }

  it("a delivery run carries the generating run's tuple from its options", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, ...BOUND },
    );
    expect(result.status).toBe("completed");
    const recorded = await deliveryStore.latest(JOB);
    expect(recorded).toBeDefined();
    expect(recorded!.run.accountType).toBe("stock");
    expect(recorded!.run.accountId).toBe("PA-9001234");
    expect(recorded!.run.bindingScope).toBe("schedule");
    expect(recorded!.run.bindingSource).toBe("binding");
    // The channel records do NOT duplicate the tuple — they inherit
    // it for display from their parent run.
    expect(recorded!.reports[0].channels[0]).not.toHaveProperty("accountId");
  });

  it("a delivery run without binding options stamps explicit nulls and still records", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-2", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    const recorded = await deliveryStore.latest(JOB);
    expect(recorded).toBeDefined();
    expect(recorded!.run.accountType).toBeNull();
    expect(recorded!.run.accountId).toBeNull();
    expect(recorded!.run.bindingScope).toBeNull();
    expect(recorded!.run.bindingSource).toBeNull();
  });
});

describe("binding filter (#5102)", () => {
  it("parses a full valid query", () => {
    const parsed = parseBindingFilter(
      new URLSearchParams(
        "broker=alpaca&mode=paper&accountType=stock&accountId=PA-9001234&bindingScope=schedule",
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter).toEqual({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "PA-9001234",
      bindingScope: "schedule",
    });
    expect(isEmptyBindingFilter(parsed.filter)).toBe(false);
  });

  it("an empty query is an empty filter (matches everything)", () => {
    const parsed = parseBindingFilter(new URLSearchParams(""));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter).toEqual({});
    expect(isEmptyBindingFilter(parsed.filter)).toBe(true);
  });

  it("rejects an unknown broker, mode, account type, scope, or poisoned account id — never a silent empty page", () => {
    for (const query of [
      "broker=nope",
      "mode=live2",
      "accountType=nope",
      "accountId=undefined",
      "accountId=null",
      "bindingScope=nope",
    ]) {
      const parsed = parseBindingFilter(new URLSearchParams(query));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toBeTruthy();
    }
    // An empty value is absence, not an invalid value — same as a
    // missing param, it narrows nothing.
    expect(parseBindingFilter(new URLSearchParams("accountId=")).ok).toBe(true);
    expect(parseBindingFilter(new URLSearchParams("broker=")).ok).toBe(true);
  });

  it("matches exactly per field, and an unbound row never matches a present field", () => {
    const row = {
      brokerId: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "PA-9001234",
      bindingScope: "schedule",
    };
    expect(matchesBindingFilter(row, {})).toBe(true);
    expect(matchesBindingFilter(row, { broker: "alpaca" })).toBe(true);
    expect(matchesBindingFilter(row, { broker: "etrade" })).toBe(false);
    expect(matchesBindingFilter(row, { mode: "live" })).toBe(false);
    expect(matchesBindingFilter(row, { accountId: "PA-9001234" })).toBe(true);
    expect(matchesBindingFilter(row, { accountId: "PA-0000000" })).toBe(false);
    expect(matchesBindingFilter(row, { bindingScope: "schedule" })).toBe(true);
    expect(matchesBindingFilter(row, { bindingScope: "copilot" })).toBe(false);
    const unbound = {
      brokerId: null,
      mode: null,
      accountType: null,
      accountId: null,
      bindingScope: null,
    };
    expect(matchesBindingFilter(unbound, {})).toBe(true);
    expect(matchesBindingFilter(unbound, { broker: "alpaca" })).toBe(false);
    expect(matchesBindingFilter(unbound, { accountId: "PA-9001234" })).toBe(false);
    expect(matchesBindingFilter(unbound, { mode: "paper" })).toBe(false);
  });
});

describe("brokered audit events (#5102)", () => {
  it("a brokered execution's audit fields carry the full tuple", () => {
    const fields = accountBindingAuditFields({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "PA-9001234",
      scope: "schedule",
      source: "binding",
    } as never);
    expect(fields).toEqual({
      broker: "alpaca",
      mode: "paper",
      accountType: "stock",
      accountId: "PA-9001234",
      bindingScope: "schedule",
      bindingSource: "binding",
    });
  });

  it("no context means no fields — never an invented binding on the event", () => {
    expect(accountBindingAuditFields(null)).toEqual({});
  });
});

describe("run summaries + workflow runs (#5102)", () => {
  it("runSummaryFromReport reads the generating run's tuple from body provenance", () => {
    const summary = runSummaryFromReport({
      id: "rep-5102",
      runId: "sched-5102",
      title: "Options screen",
      source: "options_research",
      summary: "1 completed.",
      body: JSON.stringify({
        success: true,
        mode: "paper",
        provenance: {
          brokerId: "alpaca",
          accountType: "options",
          accountId: "PA-9001234",
          bindingScope: "schedule",
          bindingSource: "binding",
        },
      }),
      createdAt: "2026-11-03T00:00:00.000Z",
      generationId: null,
      fanoutOutcome: null,
      userLogin: "owner",
    } as never);
    expect(summary.accountType).toBe("options");
    expect(summary.accountId).toBe("PA-9001234");
    expect(summary.bindingScope).toBe("schedule");
    expect(summary.bindingSource).toBe("binding");
    expect(summary.brokerId).toBe("alpaca");
    expect(summary.mode).toBe("paper");
  });

  it("runSummaryFromReport without provenance reads unbound, never guessed", () => {
    const summary = runSummaryFromReport({
      id: "rep-legacy",
      runId: "sched-legacy",
      title: "Options screen",
      source: "options_research",
      summary: "1 completed.",
      body: JSON.stringify({ success: true }),
      createdAt: "2026-11-03T00:00:00.000Z",
      generationId: null,
      fanoutOutcome: null,
      userLogin: "owner",
    } as never);
    expect(summary.accountType).toBeNull();
    expect(summary.accountId).toBeNull();
    expect(summary.bindingScope).toBeNull();
    expect(summary.bindingSource).toBeNull();
    expect(summary.brokerId).toBeNull();
    expect(summary.mode).toBeNull();
  });

  it("runSummaryFromJobRunRecord carries the ledger row's tuple", () => {
    const summary = runSummaryFromJobRunRecord(boundRecord());
    expect(summary.accountType).toBe("stock");
    expect(summary.accountId).toBe("PA-9001234");
    expect(summary.bindingScope).toBe("schedule");
    expect(summary.bindingSource).toBe("binding");
  });

  it("merge hands a canonical report row its D1 ledger twin's tuple when its own body carries none", () => {
    const canonical = runSummaryFromReport({
      id: "rep-5102",
      runId: "wf-5102",
      title: "Options screen",
      source: "options_research",
      summary: "1 completed.",
      body: JSON.stringify({ success: true, jobRunId: "wf-5102" }),
      createdAt: "2026-11-03T00:00:00.000Z",
      generationId: null,
      fanoutOutcome: null,
      userLogin: "owner",
    } as never);
    expect(canonical.accountId).toBeNull();
    const twin = runSummaryFromJobRunRecord(
      boundRecord({ workflowId: "wf-5102" }),
    );
    expect(twin.source).toBe("job-pipeline");
    const merged = mergeRunSummaries([[canonical], [twin]], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].reportId).toBe("rep-5102");
    expect(merged[0].accountType).toBe("stock");
    expect(merged[0].accountId).toBe("PA-9001234");
    expect(merged[0].bindingScope).toBe("schedule");
    expect(merged[0].bindingSource).toBe("binding");
  });

  it("merge keeps a canonical row's own tuple — the twin only fills an absent one", () => {
    const canonical = runSummaryFromReport({
      id: "rep-5102",
      runId: "wf-5102",
      title: "Options screen",
      source: "options_research",
      summary: "1 completed.",
      body: JSON.stringify({
        success: true,
        jobRunId: "wf-5102",
        provenance: {
          accountType: "options",
          accountId: "PA-7777777",
          bindingScope: "copilot",
          bindingSource: "binding",
        },
      }),
      createdAt: "2026-11-03T00:00:00.000Z",
      generationId: null,
      fanoutOutcome: null,
      userLogin: "owner",
    } as never);
    const twin = runSummaryFromJobRunRecord(
      boundRecord({ workflowId: "wf-5102" }),
    );
    const merged = mergeRunSummaries([[canonical], [twin]], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].accountId).toBe("PA-7777777");
    expect(merged[0].accountType).toBe("options");
    expect(merged[0].bindingScope).toBe("copilot");
  });

  it("merge lends nothing when the twin's own tuple is entirely null", () => {
    const canonical = runSummaryFromReport({
      id: "rep-5102",
      runId: "wf-5102",
      title: "Options screen",
      source: "options_research",
      summary: "1 completed.",
      body: JSON.stringify({ success: true, jobRunId: "wf-5102" }),
      createdAt: "2026-11-03T00:00:00.000Z",
      generationId: null,
      fanoutOutcome: null,
      userLogin: "owner",
    } as never);
    const twin = runSummaryFromJobRunRecord(
      buildJobRunRecord({
        system: "scheduled-agent-goal",
        jobId: "test-goal",
        operation: "test.op",
        started: "2026-11-03T00:00:00.000Z",
        finished: "2026-11-03T00:00:01.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
        workflowId: "wf-5102",
        accountType: null,
        accountId: null,
        bindingScope: null,
        bindingSource: null,
      }),
    );
    const merged = mergeRunSummaries([[canonical], [twin]], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0].accountId).toBeNull();
    expect(merged[0].accountType).toBeNull();
  });

  it("runFromJobRunRecord carries the tuple onto the Workflow Run", () => {
    const run = runFromJobRunRecord(boundRecord());
    expect(run.accountType).toBe("stock");
    expect(run.accountId).toBe("PA-9001234");
    expect(run.bindingScope).toBe("schedule");
    expect(run.bindingSource).toBe("binding");
  });

  it("runFromJobRunRecord without a tuple carries no binding fields", () => {
    const run = runFromJobRunRecord(
      buildJobRunRecord({
        system: "scheduled-agent-goal",
        jobId: "test-goal",
        operation: "test.op",
        started: "2026-11-03T00:00:00.000Z",
        finished: "2026-11-03T00:00:01.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
      }),
    );
    expect(run.accountType).toBeUndefined();
    expect(run.accountId).toBeUndefined();
    expect(run.bindingScope).toBeUndefined();
    expect(run.bindingSource).toBeUndefined();
  });
});
