// @vitest-environment node
/**
 * Issue #3538 (Pipeline J5) — the generated-dataset store: the
 * generate stage's persisted output family, on the CDO data
 * foundation in every residency (the #3548 pattern, the
 * analyzed store's shape transposed):
 *  - in-memory, DO-SQLite (Repository core), and D1 (drizzle)
 *    adapters share one semantics: newest-first per generate
 *    job, keep-per-job prune, latestUsable skipping
 *    failed/empty runs so a failed run never poisons reads;
 *  - the DO adapter's managed mode applies its declared
 *    versioned migration through the foundation's DO
 *    migration runner (ledger row recorded);
 *  - a drift pin: the Drizzle schema mapping and migration
 *    0056's DDL agree on columns (the foundation's rule — if
 *    they drift, the migration wins and this test is the
 *    alarm);
 *  - the composition root returns null without AGENT_DB (the
 *    surface reports not-configured, never invents a store).
 *
 * This store is the generate stage's hand-off record (what the
 * deliver stage consumes) — it is NOT a second report store:
 * the canonical report copy stays mas_reports, written only
 * through scheduledReports.storeReportAtGeneration (see
 * generate_jobs_3538.test.ts for the canonical leg's wiring).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import {
  createD1GeneratedDatasetDb,
  D1GeneratedDatasetStore,
  ensureGeneratedDatasetSchema,
} from "../src/data/d1GeneratedDatasetAdapter";
import {
  DoSqliteGeneratedDatasetStore,
  GENERATED_DATASET_SCHEMA_MIGRATION,
  GENERATED_DATASET_SCHEMA_STORE,
} from "../src/data/doSqliteGeneratedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { createGeneratedDatasetPorts } from "../src/data/createGeneratedDatasetPorts";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  MIGRATION_0056_JOB_GENERATED_DATASETS,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { jobGeneratedDatasets } from "../src/data/drizzleSchema";
import type {
  GeneratedDatasetStore,
  GeneratedDatasetStoreInput,
} from "../src/data/generatedDatasetPorts";
import type { SqlStorage } from "../src/orm";

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

/** node:sqlite double for the SqlStorage seam (same shape as the J1 suite's). */
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

const ANALYZE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze";
const JOB = `${ANALYZE_JOB}-generate`;
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function input(
  runId: string,
  atMs: number,
  overrides: Partial<GeneratedDatasetStoreInput> = {},
): GeneratedDatasetStoreInput {
  return {
    jobId: JOB,
    analyzeJobId: ANALYZE_JOB,
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
    formatsRequested: ["json", "markdown", "csv", "pdf"],
    reports: [
      {
        kind: "analysis",
        title: `Analysis — yahoo quotes (${runId})`,
        formats: [
          {
            format: "json",
            status: "generated",
            contentType: "application/json",
            bodyText: "{}",
            bodyBase64: null,
            sizeBytes: 2,
            codedError: null,
            errorMessage: null,
          },
        ],
        canonical: { status: "not_wired", reportId: null, fanoutCode: null, reason: "canonical_report_store_not_wired" },
      },
    ],
    summary: {
      reportsGenerated: 1,
      formatsGenerated: 1,
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
      requested: 4,
      received: 4,
      failed: 0,
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
    ...overrides,
  };
}

async function conformance(make: () => GeneratedDatasetStore) {
  const store = make();
  expect(await store.latest(JOB)).toBeUndefined();
  expect(await store.latestUsable(JOB)).toBeUndefined();
  expect(await store.listRuns(JOB)).toEqual([]);

  const first = await store.store(input("run-1", T0));
  expect(first.id).toBeTruthy();
  expect(first.createdAt).toBe(iso(T0));
  const second = await store.store(input("run-2", T0 + 60_000));
  expect((await store.latest(JOB))?.run.runId).toBe("run-2");
  expect((await store.latestUsable(JOB))?.run.runId).toBe("run-2");
  expect((await store.listRuns(JOB)).map((a) => a.run.runId)).toEqual([
    "run-2",
    "run-1",
  ]);
  expect((await store.listRuns(JOB, 1)).map((a) => a.run.runId)).toEqual(["run-2"]);
  // Round-trip fidelity: a read is the stored artifact, parsed fresh.
  const read = await store.latest(JOB);
  expect(read).toEqual(second);
  expect(first.id).not.toBe(second.id);
  expect(read?.reports[0]?.formats[0]?.format).toBe("json");
  expect(read?.reports[0]?.canonical.status).toBe("not_wired");
  expect(read?.inputArtifactId).toBe("analyzed-run-2");
  expect(read?.inputRunId).toBe("analyze-run-2");

  // A failed run is recorded but never poisons reads.
  await store.store(
    input("run-3", T0 + 120_000, {
      reports: [],
      summary: {
        reportsGenerated: 0,
        formatsGenerated: 0,
        formatsFailed: 0,
        canonicalStored: 0,
        canonicalNotWired: 0,
      },
      run: {
        runId: "run-3",
        trigger: "manual",
        startedAt: iso(T0 + 120_000),
        finishedAt: iso(T0 + 121_000),
        status: "failed",
        requested: 4,
        received: 0,
        failed: 4,
        codedError: "GENERATE_INPUT_MISSING",
        errorMessage: "no usable input",
      },
    }),
  );
  expect((await store.latest(JOB))?.run.runId).toBe("run-3");
  expect((await store.latestUsable(JOB))?.run.runId).toBe("run-2");
  // Jobs are keyed independently.
  expect(await store.latest("alpaca-nasdaq100-quotes-enrich-analyze-generate")).toBeUndefined();
}

describe("generated-dataset store conformance (#3538)", () => {
  it("in-memory residency", async () => {
    await conformance(() => new InMemoryGeneratedDatasetStore());
  });

  it("DO-SQLite residency (legacy ensure)", async () => {
    const sql = new SqliteTestStorage();
    await conformance(
      () => new DoSqliteGeneratedDatasetStore(sql as unknown as SqlStorage),
    );
  });

  it("D1 residency (drizzle over the mock)", async () => {
    const mock = new MockD1Database();
    await conformance(
      () =>
        new D1GeneratedDatasetStore(
          createD1GeneratedDatasetDb(mock as unknown as D1Database),
        ),
    );
  });

  it("prunes to the newest keepPerJob artifacts per job", async () => {
    const store = new InMemoryGeneratedDatasetStore({ keepPerJob: 2 });
    await store.store(input("run-1", T0));
    await store.store(input("run-2", T0 + 1000));
    await store.store(input("run-3", T0 + 2000));
    expect((await store.listRuns(JOB, 10)).map((a) => a.run.runId)).toEqual([
      "run-3",
      "run-2",
    ]);
  });

  it("the DO managed mode records its declared migration in the ledger", async () => {
    const sql = new SqliteTestStorage();
    const store = new DoSqliteGeneratedDatasetStore(sql as unknown as SqlStorage, {
      schemaMigrationMode: "managed",
    });
    await store.store(input("run-1", T0));
    const ledger = sql.sqlite
      .prepare(
        "SELECT version, name FROM mas_schema_migrations WHERE store = ?",
      )
      .all(GENERATED_DATASET_SCHEMA_STORE) as Array<{ version: number; name: string }>;
    expect(ledger).toEqual([
      {
        version: GENERATED_DATASET_SCHEMA_MIGRATION.version,
        name: GENERATED_DATASET_SCHEMA_MIGRATION.name,
      },
    ]);
    expect((await store.latest(JOB))?.run.runId).toBe("run-1");
  });

  it("migration 0056 is registered and the D1 ensure applies it", async () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0056_JOB_GENERATED_DATASETS);
    const mock = new MockD1Database();
    const applied = await ensureGeneratedDatasetSchema(
      createD1GeneratedDatasetDb(mock as unknown as D1Database),
    );
    expect(applied).toEqual([56]);
  });

  it("the composition root returns null without AGENT_DB", () => {
    expect(createGeneratedDatasetPorts({})).toBeNull();
    const mock = new MockD1Database();
    expect(
      createGeneratedDatasetPorts({ AGENT_DB: mock as unknown as D1Database }),
    ).not.toBeNull();
  });
});

describe("schema ↔ migration agreement (the foundation drift pin)", () => {
  it("the Drizzle mapping and migration 0056 declare the same columns", async () => {
    const mock = new MockD1Database();
    await applyMigrations(
      createD1GeneratedDatasetDb(mock as unknown as D1Database) as unknown as MigrationDb,
      ALL_MIGRATIONS,
    );
    const pragmaColumns = (
      mock.sqlite.prepare(`PRAGMA table_info(job_generated_datasets)`).all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .sort();
    const mappingColumns = Object.values(getTableColumns(jobGeneratedDatasets))
      .map((c) => c.name)
      .sort();
    expect(pragmaColumns).toEqual(mappingColumns);
    expect(pragmaColumns).toContain("artifact_json");
  });
});
