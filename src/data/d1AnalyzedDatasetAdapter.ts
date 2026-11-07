/**
 * Issue #3537 (Pipeline J4), on the CDO data foundation
 * (#3548 pattern) — the D1 implementation of the
 * analyzed-dataset store (the production residency: the
 * generate stage's readers run in different instances than
 * the analyze writer, on the shared AGENT_DB binding — the
 * enriched-dataset family's residency ruling, applied again).
 * Built on the foundation's drizzle D1 pattern (the
 * d1EnrichedDatasetAdapter family): the table is the
 * foundation's (src/data/drizzleSchema.ts; DDL authority
 * migration 0052 in src/data/migrationRunner.ts — the same
 * shape in every residency), the schema is ensured through
 * the foundation's versioned migration runner, and all
 * query-builder sites live here, inside src/data/ — never
 * above the layer (global D-D census surface 3).
 *
 * Semantics identical to the other residencies: newest-first
 * per analyze job (created_at desc, id desc), keep-per-job
 * prune on store, latestUsable skipping failed/empty runs.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { jobAnalyzedDatasets } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0052_JOB_ANALYZED_DATASETS,
  type MigrationDb,
} from "./migrationRunner";
import {
  isUsableAnalyzedArtifact,
  type AnalyzedDatasetArtifact,
  type AnalyzedDatasetStore,
  type AnalyzedDatasetStoreInput,
  type AnalyzedDatasetStoreOptions,
} from "./analyzedDatasetPorts";

/** Drizzle D1 database object carrying the analyzed-dataset schema. */
export type AnalyzedDatasetDb = DrizzleD1Database<{
  jobAnalyzedDatasets: typeof jobAnalyzedDatasets;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1AnalyzedDatasetDb(d1: D1Database): AnalyzedDatasetDb {
  return drizzle(d1, { schema: { jobAnalyzedDatasets } });
}

/** Idempotent schema-ensure: applies migration 0052 if unapplied. */
export async function ensureAnalyzedDatasetSchema(
  db: AnalyzedDatasetDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0052_JOB_ANALYZED_DATASETS,
  ]);
}

/** The D1 analyzed-dataset store over the shared AgentDB binding. */
export class D1AnalyzedDatasetStore implements AnalyzedDatasetStore {
  private ensured: Promise<void> | null = null;
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(
    private readonly db: AnalyzedDatasetDb,
    options?: AnalyzedDatasetStoreOptions,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureAnalyzedDatasetSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  private async newestFirst(jobId: string, limit: number) {
    return this.db
      .select()
      .from(jobAnalyzedDatasets)
      .where(eq(jobAnalyzedDatasets.jobId, jobId))
      .orderBy(desc(jobAnalyzedDatasets.createdAt), desc(jobAnalyzedDatasets.id))
      .limit(limit);
  }

  async store(input: AnalyzedDatasetStoreInput): Promise<AnalyzedDatasetArtifact> {
    await this.ensure();
    const { nowIso, ...rest } = input;
    const artifact: AnalyzedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    await this.db.insert(jobAnalyzedDatasets).values({
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
    });
    // Prune to the newest keepPerJob rows for this job.
    const kept = await this.newestFirst(artifact.jobId, this.keepPerJob);
    const keptIds = new Set(kept.map((r) => r.id));
    const all = await this.newestFirst(artifact.jobId, 1000);
    for (const row of all) {
      if (!keptIds.has(row.id)) {
        await this.db
          .delete(jobAnalyzedDatasets)
          .where(eq(jobAnalyzedDatasets.id, row.id));
      }
    }
    return artifact;
  }

  async latest(jobId: string): Promise<AnalyzedDatasetArtifact | undefined> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, 1);
    return rows.length
      ? (JSON.parse(rows[0].artifactJson) as AnalyzedDatasetArtifact)
      : undefined;
  }

  async latestUsable(jobId: string): Promise<AnalyzedDatasetArtifact | undefined> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobAnalyzedDatasets)
      .where(
        and(
          eq(jobAnalyzedDatasets.jobId, jobId),
          ne(jobAnalyzedDatasets.status, "failed"),
          gt(jobAnalyzedDatasets.rowsPersisted, 0),
        ),
      )
      .orderBy(desc(jobAnalyzedDatasets.createdAt), desc(jobAnalyzedDatasets.id))
      .limit(1);
    if (!rows.length) return undefined;
    const artifact = JSON.parse(rows[0].artifactJson) as AnalyzedDatasetArtifact;
    return isUsableAnalyzedArtifact(artifact) ? artifact : undefined;
  }

  async listRuns(jobId: string, limit = 10): Promise<AnalyzedDatasetArtifact[]> {
    await this.ensure();
    const rows = await this.newestFirst(jobId, Math.max(0, limit));
    return rows.map((r) => JSON.parse(r.artifactJson) as AnalyzedDatasetArtifact);
  }
}
