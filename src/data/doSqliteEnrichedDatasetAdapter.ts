/**
 * Issue #3536 (Pipeline J3), on the CDO data foundation
 * (#3548 pattern) — the DO-SQLite implementation of the
 * enriched-dataset store (agent-hosted residency), built on
 * the foundation: the table is the foundation's (declared in
 * src/data/drizzleSchema.ts, DDL authority migration 0051 in
 * src/data/migrationRunner.ts — the same shape in every
 * residency), the repository rides the foundation's Repository
 * core (src/data/ormRepositoryCore.ts), and the schema is
 * ensured through the foundation's DO migration discipline —
 * one DDL home, applied directly in legacy mode or through
 * applyDoSchemaMigrations in managed mode (the
 * doSqliteJobPipelineAdapter pattern). All sql.exec sites live
 * here, inside src/data/ — never above the layer (global D-D
 * census surface 1).
 *
 * Semantics identical to the other residencies: newest-first
 * per enrich job (createdAt desc, id desc), keep-per-job prune
 * on store, latestUsable skipping failed/empty runs.
 */
import type { SqlStorage } from "../orm";
import type { SchemaMigrationMode } from "../config/schemaMigrationModes";
import type { DoSchemaMigration } from "../ports/schemaMigration";
import { applyDoSchemaMigrations } from "./doSchemaMigrations";
import { Repository } from "./ormRepositoryCore";
import type { jobEnrichedDatasets } from "./drizzleSchema";
import {
  ENRICHED_DATASETS_TABLE,
  compareEnrichedArtifactsNewestFirst,
  isUsableEnrichedArtifact,
  type EnrichedDatasetArtifact,
  type EnrichedDatasetStore,
  type EnrichedDatasetStoreInput,
  type EnrichedDatasetStoreOptions,
} from "./enrichedDatasetPorts";

type EnrichedDatasetRow = typeof jobEnrichedDatasets.$inferSelect;

export const ENRICHED_DATASET_COLUMNS: Record<keyof EnrichedDatasetRow & string, string> = {
  id: "id",
  createdAt: "created_at",
  jobId: "job_id",
  feedJobId: "feed_job_id",
  sourceId: "source_id",
  dataset: "dataset",
  runId: "run_id",
  status: "status",
  asOf: "as_of",
  rowsPersisted: "rows_persisted",
  artifactJson: "artifact_json",
};

/**
 * The table's DDL, its ONE home for the DO residency: both the
 * legacy ensureSchema branch and the managed migration below
 * run these exact statements, and migration 0051 declares the
 * same shapes for D1 — the two modes and the two residencies
 * can never drift apart.
 */
export const ENRICHED_DATASETS_DDL = `CREATE TABLE IF NOT EXISTS ${ENRICHED_DATASETS_TABLE} (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      feed_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    )`;

export const ENRICHED_DATASETS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_job_enriched_datasets_job
      ON ${ENRICHED_DATASETS_TABLE} (job_id, created_at DESC, id DESC)`;

/**
 * The store's first framework migration: v1 is the table
 * exactly as migration 0051 declares it — IF NOT EXISTS, so an
 * instance converges on first managed ensure. A future schema
 * change rides as v2, never as an edit to this migration's `up`.
 */
export const ENRICHED_DATASET_SCHEMA_MIGRATION: DoSchemaMigration = {
  version: 1,
  name: "0001_job_enriched_datasets",
  up: [ENRICHED_DATASETS_DDL, ENRICHED_DATASETS_INDEX_DDL],
  down: [`DROP TABLE IF EXISTS ${ENRICHED_DATASETS_TABLE}`],
};

/** The DO migration-framework store name for this family. */
export const ENRICHED_DATASET_SCHEMA_STORE = "job_enriched_datasets";

/** Options for the DO migration-framework wiring; unset = legacy. */
export interface DoSqliteEnrichedDatasetOptions {
  schemaMigrationMode?: SchemaMigrationMode;
}

class EnrichedDatasetRepository extends Repository<EnrichedDatasetRow> {
  constructor(sql: SqlStorage) {
    super(sql, ENRICHED_DATASETS_TABLE, "id", ENRICHED_DATASET_COLUMNS);
  }
}

function artifactToRow(artifact: EnrichedDatasetArtifact): EnrichedDatasetRow {
  return {
    id: artifact.id,
    createdAt: artifact.createdAt,
    jobId: artifact.jobId,
    feedJobId: artifact.feedJobId,
    sourceId: artifact.sourceId,
    dataset: artifact.dataset,
    runId: artifact.run.runId,
    status: artifact.run.status,
    asOf: artifact.run.finishedAt,
    rowsPersisted: artifact.rows.length,
    artifactJson: JSON.stringify(artifact),
  };
}

/** The DO-SQLite enriched-dataset store over a host agent's own SQLite. */
export class DoSqliteEnrichedDatasetStore implements EnrichedDatasetStore {
  private readonly repo: EnrichedDatasetRepository;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly sql: SqlStorage,
    private readonly options: DoSqliteEnrichedDatasetOptions & EnrichedDatasetStoreOptions = {},
  ) {
    this.repo = new EnrichedDatasetRepository(sql);
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options.keepPerJob ?? 10;
  }

  private ensureSchema(): void {
    if (this.options.schemaMigrationMode === "managed") {
      applyDoSchemaMigrations(this.sql, ENRICHED_DATASET_SCHEMA_STORE, [
        ENRICHED_DATASET_SCHEMA_MIGRATION,
      ]);
      return;
    }
    this.sql.exec(ENRICHED_DATASETS_DDL);
    this.sql.exec(ENRICHED_DATASETS_INDEX_DDL);
  }

  private rowsFor(jobId: string): EnrichedDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .map((row) => JSON.parse(row.artifactJson) as EnrichedDatasetArtifact)
      .sort(compareEnrichedArtifactsNewestFirst);
  }

  async store(input: EnrichedDatasetStoreInput): Promise<EnrichedDatasetArtifact> {
    this.ensureSchema();
    const { nowIso, ...rest } = input;
    const artifact: EnrichedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    this.repo.create(artifactToRow(artifact));
    const mine = this.rowsFor(artifact.jobId);
    for (const excess of mine.slice(this.keepPerJob)) {
      this.repo.delete(excess.id);
    }
    return artifact;
  }

  async latest(jobId: string): Promise<EnrichedDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<EnrichedDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId).find(isUsableEnrichedArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<EnrichedDatasetArtifact[]> {
    this.ensureSchema();
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }
}
