/**
 * Issue #3539 (Pipeline J6), on the CDO data foundation
 * (#3548 pattern) — the DO-SQLite implementation of the
 * delivery-dataset store (agent-hosted residency), built on
 * the foundation: the table is the foundation's (declared in
 * src/data/drizzleSchema.ts, DDL authority migration 0057 in
 * src/data/migrationRunner.ts — the same shape in every
 * residency), the repository rides the foundation's Repository
 * core (src/data/ormRepositoryCore.ts), and the schema is
 * ensured through the foundation's DO migration discipline —
 * one DDL home, applied directly in legacy mode or through
 * applyDoSchemaMigrations in managed mode (the
 * doSqliteGeneratedDatasetAdapter pattern). All sql.exec
 * sites live here, inside src/data/ — never above the layer
 * (global D-D census surface 1).
 *
 * Semantics identical to the other residencies: newest-first
 * per deliver job (createdAt desc, id desc), keep-per-job
 * prune on store, latestUsable skipping failed/empty runs,
 * and listForInput — the resume lookup over the denormalized
 * input artifact id. The denormalized rows_persisted column
 * carries the count of channel pairs the run itself
 * delivered (this family's "rows").
 */
import type { SqlStorage } from "../orm";
import type { SchemaMigrationMode } from "../config/schemaMigrationModes";
import type { DoSchemaMigration } from "../ports/schemaMigration";
import { applyDoSchemaMigrations } from "./doSchemaMigrations";
import { Repository } from "./ormRepositoryCore";
import type { jobDeliveryDatasets } from "./drizzleSchema";
import {
  DELIVERY_DATASETS_TABLE,
  compareDeliveryArtifactsNewestFirst,
  deliveredChannelCount,
  isUsableDeliveryArtifact,
  type DeliveryDatasetArtifact,
  type DeliveryDatasetStore,
  type DeliveryDatasetStoreInput,
  type DeliveryDatasetStoreOptions,
} from "./deliveryDatasetPorts";

type DeliveryDatasetRow = typeof jobDeliveryDatasets.$inferSelect;

export const DELIVERY_DATASET_COLUMNS: Record<keyof DeliveryDatasetRow & string, string> = {
  id: "id",
  createdAt: "created_at",
  jobId: "job_id",
  generateJobId: "generate_job_id",
  sourceId: "source_id",
  dataset: "dataset",
  runId: "run_id",
  status: "status",
  asOf: "as_of",
  rowsPersisted: "rows_persisted",
  inputArtifactId: "input_artifact_id",
  artifactJson: "artifact_json",
};

/**
 * The table's DDL, its ONE home for the DO residency: both
 * the legacy ensureSchema branch and the managed migration
 * below run these exact statements, and migration 0057
 * declares the same shapes for D1 — the two modes and the
 * two residencies can never drift apart.
 */
export const DELIVERY_DATASETS_DDL = `CREATE TABLE IF NOT EXISTS ${DELIVERY_DATASETS_TABLE} (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      generate_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      input_artifact_id TEXT NOT NULL,
      artifact_json TEXT NOT NULL
    )`;

export const DELIVERY_DATASETS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_job_delivery_datasets_job
      ON ${DELIVERY_DATASETS_TABLE} (job_id, created_at DESC, id DESC)`;

/**
 * The store's first framework migration: v1 is the table
 * exactly as migration 0057 declares it — IF NOT EXISTS, so
 * an instance converges on first managed ensure. A future
 * schema change rides as v2, never as an edit to this
 * migration's `up`.
 */
export const DELIVERY_DATASET_SCHEMA_MIGRATION: DoSchemaMigration = {
  version: 1,
  name: "0001_job_delivery_datasets",
  up: [DELIVERY_DATASETS_DDL, DELIVERY_DATASETS_INDEX_DDL],
  down: [`DROP TABLE IF EXISTS ${DELIVERY_DATASETS_TABLE}`],
};

/** The DO migration-framework store name for this family. */
export const DELIVERY_DATASET_SCHEMA_STORE = "job_delivery_datasets";

/** Options for the DO migration-framework wiring; unset = legacy. */
export interface DoSqliteDeliveryDatasetOptions {
  schemaMigrationMode?: SchemaMigrationMode;
}

class DeliveryDatasetRepository extends Repository<DeliveryDatasetRow> {
  constructor(sql: SqlStorage) {
    super(sql, DELIVERY_DATASETS_TABLE, "id", DELIVERY_DATASET_COLUMNS);
  }
}

function artifactToRow(artifact: DeliveryDatasetArtifact): DeliveryDatasetRow {
  return {
    id: artifact.id,
    createdAt: artifact.createdAt,
    jobId: artifact.jobId,
    generateJobId: artifact.generateJobId,
    sourceId: artifact.sourceId,
    dataset: artifact.dataset,
    runId: artifact.run.runId,
    status: artifact.run.status,
    asOf: artifact.run.finishedAt,
    rowsPersisted: deliveredChannelCount(artifact),
    inputArtifactId: artifact.inputArtifactId,
    artifactJson: JSON.stringify(artifact),
  };
}

/** The DO-SQLite delivery-dataset store over a host agent's own SQLite. */
export class DoSqliteDeliveryDatasetStore implements DeliveryDatasetStore {
  private readonly repo: DeliveryDatasetRepository;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly sql: SqlStorage,
    private readonly options: DoSqliteDeliveryDatasetOptions & DeliveryDatasetStoreOptions = {},
  ) {
    this.repo = new DeliveryDatasetRepository(sql);
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options.keepPerJob ?? 10;
  }

  private ensureSchema(): void {
    if (this.options.schemaMigrationMode === "managed") {
      applyDoSchemaMigrations(this.sql, DELIVERY_DATASET_SCHEMA_STORE, [
        DELIVERY_DATASET_SCHEMA_MIGRATION,
      ]);
      return;
    }
    this.sql.exec(DELIVERY_DATASETS_DDL);
    this.sql.exec(DELIVERY_DATASETS_INDEX_DDL);
  }

  private rowsFor(jobId: string): DeliveryDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .map((row) => JSON.parse(row.artifactJson) as DeliveryDatasetArtifact)
      .sort(compareDeliveryArtifactsNewestFirst);
  }

  async store(input: DeliveryDatasetStoreInput): Promise<DeliveryDatasetArtifact> {
    this.ensureSchema();
    const { nowIso, ...rest } = input;
    const artifact: DeliveryDatasetArtifact = {
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

  async latest(jobId: string): Promise<DeliveryDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<DeliveryDatasetArtifact | undefined> {
    this.ensureSchema();
    return this.rowsFor(jobId).find(isUsableDeliveryArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<DeliveryDatasetArtifact[]> {
    this.ensureSchema();
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }

  async listForInput(
    jobId: string,
    inputArtifactId: string,
    limit = 50,
  ): Promise<DeliveryDatasetArtifact[]> {
    this.ensureSchema();
    return this.rowsFor(jobId)
      .filter((a) => a.inputArtifactId === inputArtifactId)
      .slice(0, Math.max(0, limit));
  }
}
