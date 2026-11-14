/**
 * Issue #3538 (Pipeline J5), on the CDO data foundation
 * (#3548 pattern) — the DO-SQLite implementation of the
 * generated-dataset store (agent-hosted residency), built on
 * the foundation: the table is the foundation's (declared in
 * src/data/drizzleSchema.ts, DDL authority migration 0056 in
 * src/data/migrationRunner.ts — the same shape in every
 * residency), the repository rides the foundation's Repository
 * core (src/data/ormRepositoryCore.ts), and the schema is
 * ensured through the foundation's DO migration discipline —
 * one DDL home, applied directly in legacy mode or through
 * applyDoSchemaMigrations in managed mode (the
 * doSqliteAnalyzedDatasetAdapter pattern). All sql.exec sites
 * live here, inside src/data/ — never above the layer (global
 * D-D census surface 1).
 *
 * Semantics identical to the other residencies: newest-first
 * per generate job (createdAt desc, id desc), keep-per-job prune
 * on store, latestUsable skipping failed/empty runs. The
 * denormalized rows_persisted column carries the count of
 * format bodies the run generated (this family's "rows").
 */
import type { SqlStorage } from "../orm";
import type { SchemaMigrationMode } from "../config/schemaMigrationModes";
import type { DoSchemaMigration } from "../ports/schemaMigration";
import { applyDoSchemaMigrations } from "./doSchemaMigrations";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import { Repository } from "./ormRepositoryCore";
import type { jobGeneratedDatasets } from "./drizzleSchema";
import {
  GENERATED_DATASETS_TABLE,
  compareGeneratedArtifactsNewestFirst,
  generatedFormatCount,
  isUsableGeneratedArtifact,
  type GeneratedDatasetArtifact,
  type GeneratedDatasetStore,
  type GeneratedDatasetStoreInput,
  type GeneratedDatasetStoreOptions,
} from "./generatedDatasetPorts";

type GeneratedDatasetRow = typeof jobGeneratedDatasets.$inferSelect;

export const GENERATED_DATASET_COLUMNS: Record<keyof GeneratedDatasetRow & string, string> = {
  id: "id",
  createdAt: "created_at",
  jobId: "job_id",
  analyzeJobId: "analyze_job_id",
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
 * run these exact statements, and migration 0056 declares the
 * same shapes for D1 — the two modes and the two residencies
 * can never drift apart.
 */
export const GENERATED_DATASETS_DDL = doTableSql("job_generated_datasets");

export const GENERATED_DATASETS_INDEX_DDL = doIndexSql("idx_job_generated_datasets_job");

/**
 * The store's first framework migration: v1 is the table
 * exactly as migration 0056 declares it — IF NOT EXISTS, so an
 * instance converges on first managed ensure. A future schema
 * change rides as v2, never as an edit to this migration's `up`.
 */
export const GENERATED_DATASET_SCHEMA_MIGRATION: DoSchemaMigration = {
  version: 1,
  name: "0001_job_generated_datasets",
  up: [GENERATED_DATASETS_DDL, GENERATED_DATASETS_INDEX_DDL],
  down: [`DROP TABLE IF EXISTS ${GENERATED_DATASETS_TABLE}`],
};

/** The DO migration-framework store name for this family. */
export const GENERATED_DATASET_SCHEMA_STORE = "job_generated_datasets";

/** Options for the DO migration-framework wiring; unset = legacy. */
export interface DoSqliteGeneratedDatasetOptions {
  schemaMigrationMode?: SchemaMigrationMode;
}

class GeneratedDatasetRepository extends Repository<GeneratedDatasetRow> {
  constructor(sql: SqlStorage) {
    super(sql, GENERATED_DATASETS_TABLE, "id", GENERATED_DATASET_COLUMNS);
  }
}

function artifactToRow(artifact: GeneratedDatasetArtifact): GeneratedDatasetRow {
  return {
    id: artifact.id,
    createdAt: artifact.createdAt,
    jobId: artifact.jobId,
    analyzeJobId: artifact.analyzeJobId,
    sourceId: artifact.sourceId,
    dataset: artifact.dataset,
    runId: artifact.run.runId,
    status: artifact.run.status,
    asOf: artifact.run.finishedAt,
    rowsPersisted: generatedFormatCount(artifact),
    artifactJson: JSON.stringify(artifact),
  };
}

/** The DO-SQLite generated-dataset store over a host agent's own SQLite. */
export class DoSqliteGeneratedDatasetStore implements GeneratedDatasetStore {
  private readonly repo: GeneratedDatasetRepository;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly sql: SqlStorage,
    private readonly options: DoSqliteGeneratedDatasetOptions & GeneratedDatasetStoreOptions = {},
  ) {
    this.repo = new GeneratedDatasetRepository(sql);
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options.keepPerJob ?? 10;
  }

  private ensureSchema(): void {
    if (this.options.schemaMigrationMode === "managed") {
      applyDoSchemaMigrations(this.sql, GENERATED_DATASET_SCHEMA_STORE, [
        GENERATED_DATASET_SCHEMA_MIGRATION,
      ]);
      return;
    }
    this.sql.exec(GENERATED_DATASETS_DDL);
    this.sql.exec(GENERATED_DATASETS_INDEX_DDL);
  }

  private rowsFor(jobId: string): GeneratedDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .map((row) => JSON.parse(row.artifactJson) as GeneratedDatasetArtifact)
      .sort(compareGeneratedArtifactsNewestFirst);
  }

  async store(input: GeneratedDatasetStoreInput): Promise<GeneratedDatasetArtifact> {
    this.ensureSchema();
    const { nowIso, ...rest } = input;
    const artifact: GeneratedDatasetArtifact = {
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

  async latest(jobId: string): Promise<GeneratedDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<GeneratedDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId).find(isUsableGeneratedArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<GeneratedDatasetArtifact[]> {
    this.ensureSchema();
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }
}
