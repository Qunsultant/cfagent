/**
 * Issue #3538 (Pipeline J5), on the CDO data foundation
 * (#3548 pattern) — the D1 implementation of the
 * generated-dataset store (the production residency: the
 * deliver stage's readers run in different instances than
 * the generate writer, on the shared AGENT_DB binding — the
 * analyzed-dataset family's residency ruling, applied again).
 * Built on the foundation's drizzle D1 pattern (the
 * d1AnalyzedDatasetAdapter family): the table is the
 * foundation's (src/data/drizzleSchema.ts; DDL authority
 * migration 0056 in src/data/migrationRunner.ts — the same
 * shape in every residency), the schema is ensured through
 * the foundation's versioned migration runner, and all
 * query-builder sites live here, inside src/data/ — never
 * above the layer (global D-D census surface 3).
 *
 * Semantics identical to the other residencies: newest-first
 * per generate job (created_at desc, id desc), keep-per-job
 * prune on store, latestUsable skipping failed/empty runs.
 * The denormalized rows_persisted column carries the count of
 * format bodies the run generated (this family's "rows").
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { jobGeneratedDatasets } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0056_JOB_GENERATED_DATASETS,
  type MigrationDb,
} from "./migrationRunner";
import {
  generatedFormatCount,
  isUsableGeneratedArtifact,
  type GeneratedDatasetArtifact,
  type GeneratedDatasetStore,
  type GeneratedDatasetStoreInput,
  type GeneratedDatasetStoreOptions,
} from "./generatedDatasetPorts";

/** Drizzle D1 database object carrying the generated-dataset schema. */
export type GeneratedDatasetDb = DrizzleD1Database<{
  jobGeneratedDatasets: typeof jobGeneratedDatasets;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1GeneratedDatasetDb(d1: D1Database): GeneratedDatasetDb {
  return drizzle(d1, { schema: { jobGeneratedDatasets } });
}

/** Idempotent schema-ensure: applies migration 0056 if unapplied. */
export async function ensureGeneratedDatasetSchema(
  db: GeneratedDatasetDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0056_JOB_GENERATED_DATASETS,
  ]);
}

/** The D1 generated-dataset store over the shared AgentDB binding. */
export class D1GeneratedDatasetStore implements GeneratedDatasetStore {
  private ensured: Promise<void> | null = null;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly db: GeneratedDatasetDb,
    options?: GeneratedDatasetStoreOptions,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureGeneratedDatasetSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  private async newestFirst(jobId: string, limit: number) {
    return this.db
      .select()
      .from(jobGeneratedDatasets)
      .where(eq(jobGeneratedDatasets.jobId, jobId))
      .orderBy(desc(jobGeneratedDatasets.createdAt), desc(jobGeneratedDatasets.id))
      .limit(limit);
  }

  async store(input: GeneratedDatasetStoreInput): Promise<GeneratedDatasetArtifact> {
    await this.ensure();
    const { nowIso, ...rest } = input;
    const artifact: GeneratedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    await this.db.insert(jobGeneratedDatasets).values({
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
    });
    // Prune to the newest keepPerJob rows for this job.
    const kept = await this.newestFirst(artifact.jobId, this.keepPerJob);
    const keptIds = new Set(kept.map((r) => r.id));
    const all = await this.newestFirst(artifact.jobId, 1000);
    for (const row of all) {
      if (!keptIds.has(row.id)) {
        await this.db
          .delete(jobGeneratedDatasets)
          .where(eq(jobGeneratedDatasets.id, row.id));
      }
    }
    return artifact;
  }

  async latest(jobId: string): Promise<GeneratedDatasetArtifact | undefined> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, 1);
    return rows.length
      ? (JSON.parse(rows[0].artifactJson) as GeneratedDatasetArtifact)
      : undefined;
  }

  async latestUsable(jobId: string): Promise<GeneratedDatasetArtifact | undefined> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobGeneratedDatasets)
      .where(
        and(
          eq(jobGeneratedDatasets.jobId, jobId),
          ne(jobGeneratedDatasets.status, "failed"),
          gt(jobGeneratedDatasets.rowsPersisted, 0),
        ),
      )
      .orderBy(desc(jobGeneratedDatasets.createdAt), desc(jobGeneratedDatasets.id))
      .limit(1);
    if (!rows.length) return undefined;
    const artifact = JSON.parse(rows[0].artifactJson) as GeneratedDatasetArtifact;
    return isUsableGeneratedArtifact(artifact) ? artifact : undefined;
  }

  async listRuns(jobId: string, limit = 10): Promise<GeneratedDatasetArtifact[]> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, Math.max(0, limit));
    return rows.map((r) => JSON.parse(r.artifactJson) as GeneratedDatasetArtifact);
  }
}
