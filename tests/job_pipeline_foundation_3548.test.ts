// @vitest-environment node
/**
 * Issue #3548 (Pipeline J1 ORM conformance) — the pipeline's
 * persistence rides the CDO data foundation, in every
 * residency:
 *  - the D1 adapters are the foundation's drizzle pattern over
 *    the foundation's schema (migration-applied), round-tripping
 *    the full record shapes;
 *  - the DO adapter's managed mode applies its declared
 *    versioned migration through the foundation's DO migration
 *    runner (ledger row recorded);
 *  - a drift pin: the Drizzle schema mapping and the migration
 *    DDL agree on columns for every pipeline table (the
 *    foundation's rule — if they drift, the migration wins and
 *    this test is the alarm).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import {
  createD1JobPipelineDb,
  D1JobPipelineStores,
  ensureJobPipelineSchema,
} from "../src/data/d1JobPipelineAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
  ensureJobRunRecordsSchema,
} from "../src/data/d1JobRunRecordAdapter";
import {
  DoSqliteJobPipelineStores,
  JOB_PIPELINE_SCHEMA_MIGRATION,
} from "../src/data/doSqliteJobPipelineAdapter";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import {
  jobPipelineArtifacts,
  jobPipelineDefinitions,
  jobPipelineInstances,
  jobRunRecords,
} from "../src/data/drizzleSchema";
import type {
  JobDefinition,
  JobInstanceRecord,
} from "../src/data/jobPipelinePorts";
import { buildJobRunRecord } from "../src/services/jobRunRecords";

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

const DEFINITION: JobDefinition = {
  jobId: "feed-nasdaq",
  name: "NASDAQ feed",
  root: { kind: "feed", steps: [{ step: "record" }] },
  rawConfig: { jobId: "feed-nasdaq", root: { kind: "feed" } },
  config: {
    inputs: { sources: ["nasdaq100"], datasets: [], items: [] },
    processing: { inMemory: false, checkpointEverySteps: 1, shards: [] },
    outputs: { reports: [], formats: [], channels: [] },
    executionMode: { concurrency: "sequential", pacing: "batch", delivery: "async", shape: "monolith" },
    schedule: { enabled: false },
  },
  version: 3,
  updatedAt: "2026-11-06T12:00:00.000Z",
};

const INSTANCE: JobInstanceRecord = {
  jobId: "feed-nasdaq",
  state: "paused",
  desiredState: "none",
  currentRunId: "run-1",
  runStartedAt: "2026-11-06T12:00:00.000Z",
  runTrigger: "scheduled",
  runScheduleId: null,
  // Issue #4357 — the bridge id that dispatched this run; null when
  // no async job dispatched it. The round-trip below proves the
  // column carries a value through every residency.
  runAsyncJobId: "bridge-1",
  checkpoint: {
    runId: "run-1",
    nodePath: "",
    scopePath: "",
    stepIndex: 1,
    itemIndex: 0,
    shardIndex: 0,
    childIndex: 0,
    artifactKeys: ["root/step-0"],
    updatedAt: "2026-11-06T12:01:00.000Z",
  },
  stageCheckpoint: {
    runId: "run-1",
    units: [
      {
        stage: "job:root",
        unitId: "run-1",
        status: "stopped",
        attempt: 1,
        progress: { stepIndex: 1, itemIndex: 0 },
        updatedAt: "2026-11-06T12:01:00.000Z",
      },
    ],
  },
  stageDesired: null,
  lastError: null,
  updatedAt: "2026-11-06T12:01:00.000Z",
};

describe("D1 residency on the foundation (drizzle + migration runner)", () => {
  it("round-trips definitions, instances (with the stage ledger), and artifacts", async () => {
    const mock = new MockD1Database();
    const stores = new D1JobPipelineStores(createD1JobPipelineDb(mock as any));
    await ensureJobPipelineSchema(createD1JobPipelineDb(mock as any));

    await stores.definitions.saveDefinition(DEFINITION);
    expect(await stores.definitions.getDefinition("feed-nasdaq")).toEqual(DEFINITION);
    expect((await stores.definitions.listDefinitions()).map((d) => d.jobId)).toEqual([
      "feed-nasdaq",
    ]);
    const bumped = { ...DEFINITION, version: 4 };
    await stores.definitions.saveDefinition(bumped);
    expect((await stores.definitions.getDefinition("feed-nasdaq"))?.version).toBe(4);

    await stores.instances.saveInstance(INSTANCE);
    expect(await stores.instances.getInstance("feed-nasdaq")).toEqual(INSTANCE);
    expect(await stores.instances.getInstance("missing")).toBeNull();

    await stores.artifacts.putArtifact("run-1", "root/output", { rows: 3 });
    await stores.artifacts.putArtifact("run-1", "root/step-0", [1, 2]);
    await stores.artifacts.putArtifact("run-1", "root/output", { rows: 4 });
    expect(await stores.artifacts.getArtifact("run-1", "root/output")).toEqual({ rows: 4 });
    expect(await stores.artifacts.listArtifactKeys("run-1")).toEqual([
      "root/output",
      "root/step-0",
    ]);
    expect(await stores.artifacts.getArtifact("run-1", "absent")).toBeNull();
  });

  it("records, lists, and prunes run records through the one machinery", async () => {
    const mock = new MockD1Database();
    const db = createD1JobRunRecordDb(mock as any);
    await ensureJobRunRecordsSchema(db);
    const store = new D1JobRunRecordStore(db);
    for (let i = 0; i < 105; i++) {
      await store.record(
        buildJobRunRecord({
          system: "job-pipeline",
          jobId: "feed-nasdaq",
          operation: "feed",
          started: `2026-11-06T12:${String(i % 60).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}.000Z`,
          finished: "2026-11-06T13:00:00.000Z",
          outcome: "success",
          triggeredBy: "manual",
        }),
      );
    }
    const history = await store.listByJob("feed-nasdaq", 200);
    expect(history).toHaveLength(100); // the per-job cap pruned the oldest five
    expect((await store.latestByJob("feed-nasdaq"))?.jobId).toBe("feed-nasdaq");
    expect(await store.latestByJob("other-job")).toBeUndefined();
    expect((await store.listRecent(2)).length).toBe(2);
  });
});

describe("DO residency migration discipline", () => {
  it("applies the declared v1 migration in managed mode and records the ledger row", async () => {
    const storage = new SqliteTestStorage();
    const stores = new DoSqliteJobPipelineStores(storage as any, {
      schemaMigrationMode: "managed",
    });
    await stores.definitions.saveDefinition(DEFINITION);
    expect(await stores.definitions.getDefinition("feed-nasdaq")).toEqual(DEFINITION);
    await stores.instances.saveInstance(INSTANCE);
    expect(await stores.instances.getInstance("feed-nasdaq")).toEqual(INSTANCE);
    const ledger = storage.sqlite
      .prepare(
        "SELECT version, name FROM mas_schema_migrations WHERE store = 'job_pipeline'",
      )
      .all() as Array<{ version: number; name: string }>;
    expect(ledger).toEqual([
      { version: JOB_PIPELINE_SCHEMA_MIGRATION.version, name: JOB_PIPELINE_SCHEMA_MIGRATION.name },
    ]);
  });
});

describe("schema ↔ migration agreement (the foundation drift pin)", () => {
  it("the Drizzle mapping and migrations 0046/0047 declare the same columns", async () => {
    const mock = new MockD1Database();
    await applyMigrations(
      createD1JobPipelineDb(mock as any) as unknown as MigrationDb,
      ALL_MIGRATIONS,
    );
    const pragmaColumns = (table: string): string[] =>
      (
        mock.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      )
        .map((r) => r.name)
        .sort();
    const mappingColumns = (table: Parameters<typeof getTableColumns>[0]): string[] =>
      Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
    expect(pragmaColumns("job_pipeline_definitions")).toEqual(
      mappingColumns(jobPipelineDefinitions),
    );
    expect(pragmaColumns("job_pipeline_instances")).toEqual(
      mappingColumns(jobPipelineInstances),
    );
    expect(pragmaColumns("job_pipeline_artifacts")).toEqual(
      mappingColumns(jobPipelineArtifacts),
    );
    expect(pragmaColumns("job_run_records")).toEqual(mappingColumns(jobRunRecords));
  });
});

describe("4427-P01 the D1 instance upsert keeps the schedule link", () => {
  it("keeps a schedule id stamped after the row already exists", async () => {
    const mock = new MockD1Database();
    const stores = new D1JobPipelineStores(createD1JobPipelineDb(mock as any));
    await ensureJobPipelineSchema(createD1JobPipelineDb(mock as any));

    // defineJob mints the instance first — no run, so no schedule link yet.
    await stores.instances.saveInstance({ ...INSTANCE, runScheduleId: null, state: "idle" });

    // A scheduled dispatch then saves the same instance carrying the schedule
    // that fired it. This is the conflict path: if the upsert set omits the
    // column, the stamp never lands and resume-after-restart loses the link.
    await stores.instances.saveInstance({
      ...INSTANCE,
      runScheduleId: "sched-4427",
      state: "running",
      updatedAt: "2026-11-14T00:00:00.000Z",
    });

    const read = await stores.instances.getInstance("feed-nasdaq");
    expect(read?.runScheduleId).toBe("sched-4427");
    // Neighbours in the same upsert set stay intact.
    expect(read?.runAsyncJobId).toBe("bridge-1");
    expect(read?.state).toBe("running");
    expect(read?.currentRunId).toBe("run-1");
  });
});
