/**
 * Issue #3537 (Pipeline J4), on the CDO data foundation
 * (#3548 pattern) — the DO-SQLite implementation of the
 * analyzed-dataset store (agent-hosted residency), built on
 * the foundation: the table is the foundation's (declared in
 * src/data/drizzleSchema.ts, DDL authority migration 0052 in
 * src/data/migrationRunner.ts — the same shape in every
 * residency), the repository rides the foundation's Repository
 * core (src/data/ormRepositoryCore.ts), and the schema is
 * ensured through the foundation's DO migration discipline —
 * one DDL home, applied directly in legacy mode or through
 * applyDoSchemaMigrations in managed mode (the
 * doSqliteEnrichedDatasetAdapter pattern). All sql.exec sites
 * live here, inside src/data/ — never above the layer (global
 * D-D census surface 1).
 *
 * Semantics identical to the other residencies: newest-first
 * per analyze job (createdAt desc, id desc), keep-per-job prune
 * on store, latestUsable skipping failed/empty runs.
 */
import type { SqlStorage } from "../orm";
import type { SchemaMigrationMode } from "../config/schemaMigrationModes";
import type { DoSchemaMigration } from "../ports/schemaMigration";
import { applyDoSchemaMigrations } from "./doSchemaMigrations";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import { Repository } from "./ormRepositoryCore";
import type { jobAnalyzedDatasets } from "./drizzleSchema";
import {
  ANALYZED_DATASETS_TABLE,
  compareAnalyzedArtifactsNewestFirst,
  isUsableAnalyzedArtifact,
  type AnalyzedDatasetArtifact,
  type AnalyzedDatasetStore,
  type AnalyzedDatasetStoreInput,
  type AnalyzedDatasetStoreOptions,
} from "./analyzedDatasetPorts";

type AnalyzedDatasetRow = typeof jobAnalyzedDatasets.$inferSelect;

export const ANALYZED_DATASET_COLUMNS: Record<keyof AnalyzedDatasetRow & string, string> = {
  id: "id",
  createdAt: "created_at",
  jobId: "job_id",
  enrichJobId: "enrich_job_id",
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
 * run these exact statements, and migration 0052 declares the
 * same shapes for D1 — the two modes and the two residencies
 * can never drift apart.
 */
export const ANALYZED_DATASETS_DDL = doTableSql("job_analyzed_datasets");

export const ANALYZED_DATASETS_INDEX_DDL = doIndexSql("idx_job_analyzed_datasets_job");

/**
 * The store's first framework migration: v1 is the table
 * exactly as migration 0052 declares it — IF NOT EXISTS, so an
 * instance converges on first managed ensure. A future schema
 * change rides as v2, never as an edit to this migration's `up`.
 */
export const ANALYZED_DATASET_SCHEMA_MIGRATION: DoSchemaMigration = {
  version: 1,
  name: "0001_job_analyzed_datasets",
  up: [ANALYZED_DATASETS_DDL, ANALYZED_DATASETS_INDEX_DDL],
  down: [`DROP TABLE IF EXISTS ${ANALYZED_DATASETS_TABLE}`],
};

/** The DO migration-framework store name for this family. */
export const ANALYZED_DATASET_SCHEMA_STORE = "job_analyzed_datasets";

/** Options for the DO migration-framework wiring; unset = legacy. */
export interface DoSqliteAnalyzedDatasetOptions {
  schemaMigrationMode?: SchemaMigrationMode;
}

class AnalyzedDatasetRepository extends Repository<AnalyzedDatasetRow> {
  constructor(sql: SqlStorage) {
    super(sql, ANALYZED_DATASETS_TABLE, "id", ANALYZED_DATASET_COLUMNS);
  }
}

function artifactToRow(artifact: AnalyzedDatasetArtifact): AnalyzedDatasetRow {
  return {
    id: artifact.id,
    createdAt: artifact.createdAt,
    jobId: artifact.jobId,
    enrichJobId: artifact.enrichJobId,
    sourceId: artifact.sourceId,
    dataset: artifact.dataset,
    runId: artifact.run.runId,
    status: artifact.run.status,
    asOf: artifact.run.finishedAt,
    rowsPersisted: artifact.rows.length,
    artifactJson: JSON.stringify(artifact),
  };
}

/** The DO-SQLite analyzed-dataset store over a host agent's own SQLite. */
export class DoSqliteAnalyzedDatasetStore implements AnalyzedDatasetStore {
  private readonly repo: AnalyzedDatasetRepository;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly sql: SqlStorage,
    private readonly options: DoSqliteAnalyzedDatasetOptions & AnalyzedDatasetStoreOptions = {},
  ) {
    this.repo = new AnalyzedDatasetRepository(sql);
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options.keepPerJob ?? 10;
  }

  private ensureSchema(): void {
    if (this.options.schemaMigrationMode === "managed") {
      applyDoSchemaMigrations(this.sql, ANALYZED_DATASET_SCHEMA_STORE, [
        ANALYZED_DATASET_SCHEMA_MIGRATION,
      ]);
      return;
    }
    this.sql.exec(ANALYZED_DATASETS_DDL);
    this.sql.exec(ANALYZED_DATASETS_INDEX_DDL);
  }

  private rowsFor(jobId: string): AnalyzedDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .map((row) => JSON.parse(row.artifactJson) as AnalyzedDatasetArtifact)
      .sort(compareAnalyzedArtifactsNewestFirst);
  }

  async store(input: AnalyzedDatasetStoreInput): Promise<AnalyzedDatasetArtifact> {
    this.ensureSchema();
    const { nowIso, ...rest } = input;
    const artifact: AnalyzedDatasetArtifact = {
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

  async latest(jobId: string): Promise<AnalyzedDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<AnalyzedDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId).find(isUsableAnalyzedArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<AnalyzedDatasetArtifact[]> {
    this.ensureSchema();
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }
}
