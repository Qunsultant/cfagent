// @vitest-environment node
/**
 * Issue #3539 (Pipeline J6) — the delivery-dataset store: the
 * deliver stage's persisted output family, on the CDO data
 * foundation in every residency (the #3548 pattern, the
 * generated store's shape transposed):
 *  - in-memory, DO-SQLite (Repository core), and D1 (drizzle)
 *    adapters share one semantics: newest-first per deliver
 *    job, keep-per-job prune, latestUsable skipping failed
 *    runs so a failed run never poisons reads;
 *  - latestUsable serves an all-already_delivered artifact —
 *    a resume run that delivered nothing itself still
 *    produced a usable delivery record (the D1 adapter's
 *    documented deviation from a rows_persisted SQL filter);
 *  - listForInput is the resume lookup: every retained
 *    artifact that consumed one generated artifact, newest
 *    first, keyed exactly by the denormalized input column;
 *  - the DO adapter's managed mode applies its declared
 *    versioned migration through the foundation's DO
 *    migration runner (ledger row recorded);
 *  - a drift pin: the Drizzle schema mapping and migration
 *    0057's DDL agree on columns (the foundation's rule — if
 *    they drift, the migration wins and this test is the
 *    alarm);
 *  - the composition root returns null without AGENT_DB (the
 *    surface reports not-configured, never invents a store).
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getTableColumns } from "drizzle-orm";
import {
  createD1DeliveryDatasetDb,
  D1DeliveryDatasetStore,
  ensureDeliveryDatasetSchema,
} from "../src/data/d1DeliveryDatasetAdapter";
import {
  DoSqliteDeliveryDatasetStore,
  DELIVERY_DATASET_SCHEMA_MIGRATION,
  DELIVERY_DATASET_SCHEMA_STORE,
} from "../src/data/doSqliteDeliveryDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import { createDeliveryDatasetPorts } from "../src/data/createDeliveryDatasetPorts";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  MIGRATION_0057_JOB_DELIVERY_DATASETS,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { jobDeliveryDatasets } from "../src/data/drizzleSchema";
import type {
  DeliveryDatasetStore,
  DeliveryDatasetStoreInput,
} from "../src/data/deliveryDatasetPorts";
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

const GENERATE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze-generate";
const JOB = `${GENERATE_JOB}-deliver`;
const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function input(
  runId: string,
  atMs: number,
  overrides: Partial<DeliveryDatasetStoreInput> = {},
): DeliveryDatasetStoreInput {
  return {
    jobId: JOB,
    generateJobId: GENERATE_JOB,
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
    inputArtifactId: `generated-${runId}`,
    inputRunId: `generate-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    channelsRequested: ["slack", "email", "webhook", "ux"],
    reports: [
      {
        kind: "analysis",
        title: `Analysis — yahoo quotes (${runId})`,
        channels: [
          {
            channel: "slack",
            status: "delivered",
            target: "#reports",
            formats: ["markdown"],
            codedError: null,
            errorMessage: null,
            detail: null,
          },
          {
            channel: "email",
            status: "not_configured",
            target: null,
            formats: [],
            codedError: "email_recipient_not_configured",
            errorMessage: null,
            detail: null,
          },
        ],
      },
    ],
    summary: {
      reportsDelivered: 1,
      channelsDelivered: 1,
      channelsAlreadyDelivered: 0,
      channelsFailed: 0,
      channelsNotConfigured: 1,
    },
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: 1,
      received: 1,
      failed: 0,
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
    ...overrides,
  };
}

async function conformance(make: () => DeliveryDatasetStore) {
  const store = make();
  expect(await store.latest(JOB)).toBeUndefined();
  expect(await store.latestUsable(JOB)).toBeUndefined();
  expect(await store.listRuns(JOB)).toEqual([]);
  expect(await store.listForInput(JOB, "generated-run-1")).toEqual([]);

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
  expect(read?.reports[0]?.channels[0]?.status).toBe("delivered");
  expect(read?.reports[0]?.channels[1]?.codedError).toBe(
    "email_recipient_not_configured",
  );
  expect(read?.inputArtifactId).toBe("generated-run-2");
  expect(read?.inputRunId).toBe("generate-run-2");

  // The resume lookup: exact per (deliver job, input artifact).
  expect(
    (await store.listForInput(JOB, "generated-run-1")).map((a) => a.run.runId),
  ).toEqual(["run-1"]);
  expect(
    (await store.listForInput(JOB, "generated-run-2")).map((a) => a.run.runId),
  ).toEqual(["run-2"]);
  expect(await store.listForInput(JOB, "generated-nope")).toEqual([]);
  expect(await store.listForInput("other-job", "generated-run-1")).toEqual([]);

  // A failed run is recorded but never poisons reads.
  await store.store(
    input("run-3", T0 + 120_000, {
      reports: [],
      summary: {
        reportsDelivered: 0,
        channelsDelivered: 0,
        channelsAlreadyDelivered: 0,
        channelsFailed: 0,
        channelsNotConfigured: 0,
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
        codedError: "DELIVER_INPUT_MISSING",
        errorMessage: "no usable input",
      },
    }),
  );
  expect((await store.latest(JOB))?.run.runId).toBe("run-3");
  expect((await store.latestUsable(JOB))?.run.runId).toBe("run-2");
  // Jobs are keyed independently.
  expect(await store.latest("alpaca-nasdaq100-quotes-enrich-analyze-generate-deliver")).toBeUndefined();

  // An all-already_delivered resume artifact IS usable even
  // though this run delivered nothing itself (rows_persisted 0
  // in the SQL residencies — the D1 deviation under test).
  const resumed = await store.store(
    input("run-4", T0 + 180_000, {
      inputArtifactId: "generated-run-2",
      inputRunId: "generate-run-2",
      reports: [
        {
          kind: "analysis",
          title: "Analysis — yahoo quotes (run-2)",
          channels: [
            {
              channel: "slack",
              status: "already_delivered",
              target: "#reports",
              formats: ["markdown"],
              codedError: null,
              errorMessage: null,
              detail: "delivered by run run-2",
            },
          ],
        },
      ],
      summary: {
        reportsDelivered: 1,
        channelsDelivered: 0,
        channelsAlreadyDelivered: 1,
        channelsFailed: 0,
        channelsNotConfigured: 0,
      },
      run: {
        runId: "run-4",
        trigger: "manual",
        startedAt: iso(T0 + 180_000),
        finishedAt: iso(T0 + 181_000),
        status: "completed",
        requested: 1,
        received: 1,
        failed: 0,
        codedError: null,
        errorMessage: null,
      },
    }),
  );
  expect(resumed.summary.channelsDelivered).toBe(0);
  expect((await store.latestUsable(JOB))?.run.runId).toBe("run-4");
  expect(
    (await store.listForInput(JOB, "generated-run-2")).map((a) => a.run.runId),
  ).toEqual(["run-4", "run-2"]);
}

describe("delivery-dataset store conformance (#3539)", () => {
  it("in-memory residency", async () => {
    await conformance(() => new InMemoryDeliveryDatasetStore());
  });

  it("DO-SQLite residency (legacy ensure)", async () => {
    const sql = new SqliteTestStorage();
    await conformance(
      () => new DoSqliteDeliveryDatasetStore(sql as unknown as SqlStorage),
    );
  });

  it("D1 residency (drizzle over the mock)", async () => {
    const mock = new MockD1Database();
    await conformance(
      () =>
        new D1DeliveryDatasetStore(
          createD1DeliveryDatasetDb(mock as unknown as D1Database),
        ),
    );
  });

  it("prunes to the newest keepPerJob artifacts per job", async () => {
    const store = new InMemoryDeliveryDatasetStore({ keepPerJob: 2 });
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
    const store = new DoSqliteDeliveryDatasetStore(sql as unknown as SqlStorage, {
      schemaMigrationMode: "managed",
    });
    await store.store(input("run-1", T0));
    const ledger = sql.sqlite
      .prepare(
        "SELECT version, name FROM mas_schema_migrations WHERE store = ?",
      )
      .all(DELIVERY_DATASET_SCHEMA_STORE) as Array<{ version: number; name: string }>;
    expect(ledger).toEqual([
      {
        version: DELIVERY_DATASET_SCHEMA_MIGRATION.version,
        name: DELIVERY_DATASET_SCHEMA_MIGRATION.name,
      },
    ]);
    expect((await store.latest(JOB))?.run.runId).toBe("run-1");
  });

  it("migration 0057 is registered and the D1 ensure applies it", async () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0057_JOB_DELIVERY_DATASETS);
    const mock = new MockD1Database();
    const applied = await ensureDeliveryDatasetSchema(
      createD1DeliveryDatasetDb(mock as unknown as D1Database),
    );
    expect(applied).toEqual([57]);
  });

  it("the composition root returns null without AGENT_DB", () => {
    expect(createDeliveryDatasetPorts({})).toBeNull();
    const mock = new MockD1Database();
    expect(
      createDeliveryDatasetPorts({ AGENT_DB: mock as unknown as D1Database }),
    ).not.toBeNull();
  });
});

describe("schema ↔ migration agreement (the foundation drift pin)", () => {
  it("the Drizzle mapping and migration 0057 declare the same columns", async () => {
    const mock = new MockD1Database();
    await applyMigrations(
      createD1DeliveryDatasetDb(mock as unknown as D1Database) as unknown as MigrationDb,
      ALL_MIGRATIONS,
    );
    const pragmaColumns = (
      mock.sqlite.prepare(`PRAGMA table_info(job_delivery_datasets)`).all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .sort();
    const mappingColumns = Object.values(getTableColumns(jobDeliveryDatasets))
      .map((c) => c.name)
      .sort();
    expect(pragmaColumns).toEqual(mappingColumns);
    expect(pragmaColumns).toContain("artifact_json");
    expect(pragmaColumns).toContain("input_artifact_id");
  });
});
