// @vitest-environment node
/**
 * Issue #3536 (Pipeline J3) — the enriched-dataset store: the
 * enrich stage's persisted output family, on the CDO data
 * foundation in every residency (the #3548 pattern):
 *  - in-memory, DO-SQLite (Repository core), and D1 (drizzle)
 *    adapters share one semantics: newest-first per enrich job,
 *    keep-per-job prune, latestUsable skipping failed/empty
 *    runs so a failed run never poisons reads;
 *  - the DO adapter's managed mode applies its declared
 *    versioned migration through the foundation's DO migration
 *    runner (ledger row recorded);
 *  - a drift pin: the Drizzle schema mapping and migration
 *    0051's DDL agree on columns (the foundation's rule — if
 *    they drift, the migration wins and this test is the alarm);
 *  - the composition root returns null without AGENT_DB (the
 *    surface reports not-configured, never invents a store).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import {
  createD1EnrichedDatasetDb,
  D1EnrichedDatasetStore,
  ensureEnrichedDatasetSchema,
} from "../src/data/d1EnrichedDatasetAdapter";
import {
  DoSqliteEnrichedDatasetStore,
  ENRICHED_DATASET_SCHEMA_MIGRATION,
  ENRICHED_DATASET_SCHEMA_STORE,
} from "../src/data/doSqliteEnrichedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { createEnrichedDatasetAdapter } from "../src/data/createEnrichedDatasetPorts";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  MIGRATION_0051_JOB_ENRICHED_DATASETS,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { jobEnrichedDatasets } from "../src/data/drizzleSchema";
import type {
  EnrichedDatasetStore,
  EnrichedDatasetStoreInput,
} from "../src/data/enrichedDatasetPorts";
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

const JOB = "yahoo-nasdaq100-quotes-enrich";
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function input(
  runId: string,
  atMs: number,
  overrides: Partial<EnrichedDatasetStoreInput> = {},
): EnrichedDatasetStoreInput {
  return {
    jobId: JOB,
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
    inputArtifactId: `input-${runId}`,
    inputRunId: `feed-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    elements: ["momentum"],
    gaps: [],
    elementCoverage: { momentum: { computed: 2, unavailable: 0 } },
    rows: [
      { symbol: "AAPL", lastPrice: 100, features: { momentum: 1.5 }, unavailable: [] },
      { symbol: "MSFT", lastPrice: 200, features: { momentum: -0.5 }, unavailable: [] },
    ],
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: 2,
      received: 2,
      failed: 0,
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
    ...overrides,
  };
}

async function conformance(make: () => EnrichedDatasetStore) {
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
  expect(read?.rows[0]?.features).toEqual({ momentum: 1.5 });
  expect(read?.inputArtifactId).toBe("input-run-2");

  // A failed run is recorded but never poisons reads.
  await store.store(
    input("run-3", T0 + 120_000, {
      rows: [],
      run: {
        runId: "run-3",
        trigger: "manual",
        startedAt: iso(T0 + 120_000),
        finishedAt: iso(T0 + 121_000),
        status: "failed",
        requested: 2,
        received: 0,
        failed: 2,
        missingSymbols: ["AAPL", "MSFT"],
        codedError: "ENRICH_INPUT_MISSING",
        errorMessage: "no usable input",
      },
    }),
  );
  expect((await store.latest(JOB))?.run.runId).toBe("run-3");
  expect((await store.latestUsable(JOB))?.run.runId).toBe("run-2");
  // Jobs are keyed independently.
  expect(await store.latest("alpaca-nasdaq100-quotes-enrich")).toBeUndefined();
}

describe("enriched-dataset store conformance (#3536)", () => {
  it("in-memory residency", async () => {
    await conformance(() => new InMemoryEnrichedDatasetStore());
  });

  it("DO-SQLite residency (legacy ensure)", async () => {
    const sql = new SqliteTestStorage();
    await conformance(
      () => new DoSqliteEnrichedDatasetStore(sql as unknown as SqlStorage),
    );
  });

  it("D1 residency (drizzle over the mock)", async () => {
    const mock = new MockD1Database();
    await conformance(
      () =>
        new D1EnrichedDatasetStore(
          createD1EnrichedDatasetDb(mock as unknown as D1Database),
        ),
    );
  });

  it("prunes to the newest keepPerJob artifacts per job", async () => {
    const store = new InMemoryEnrichedDatasetStore({ keepPerJob: 2 });
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
    const store = new DoSqliteEnrichedDatasetStore(sql as unknown as SqlStorage, {
      schemaMigrationMode: "managed",
    });
    await store.store(input("run-1", T0));
    const ledger = sql.sqlite
      .prepare(
        "SELECT version, name FROM mas_schema_migrations WHERE store = ?",
      )
      .all(ENRICHED_DATASET_SCHEMA_STORE) as Array<{ version: number; name: string }>;
    expect(ledger).toEqual([
      {
        version: ENRICHED_DATASET_SCHEMA_MIGRATION.version,
        name: ENRICHED_DATASET_SCHEMA_MIGRATION.name,
      },
    ]);
    expect((await store.latest(JOB))?.run.runId).toBe("run-1");
  });

  it("migration 0051 is registered and the D1 ensure applies it", async () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0051_JOB_ENRICHED_DATASETS);
    const mock = new MockD1Database();
    const applied = await ensureEnrichedDatasetSchema(
      createD1EnrichedDatasetDb(mock as unknown as D1Database),
    );
    expect(applied).toEqual([51]);
  });

  it("the composition root returns null without AGENT_DB", () => {
    expect(createEnrichedDatasetAdapter({})).toBeNull();
    const mock = new MockD1Database();
    expect(
      createEnrichedDatasetAdapter({ AGENT_DB: mock as unknown as D1Database }),
    ).not.toBeNull();
  });
});

describe("schema ↔ migration agreement (the foundation drift pin)", () => {
  it("the Drizzle mapping and migration 0051 declare the same columns", async () => {
    const mock = new MockD1Database();
    await applyMigrations(
      createD1EnrichedDatasetDb(mock as unknown as D1Database) as unknown as MigrationDb,
      ALL_MIGRATIONS,
    );
    const pragmaColumns = (
      mock.sqlite.prepare(`PRAGMA table_info(job_enriched_datasets)`).all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .sort();
    const mappingColumns = Object.values(getTableColumns(jobEnrichedDatasets))
      .map((c) => c.name)
      .sort();
    expect(pragmaColumns).toEqual(mappingColumns);
    expect(pragmaColumns).toContain("artifact_json");
  });
});
