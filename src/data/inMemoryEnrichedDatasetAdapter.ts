/**
 * Issue #3536 (Pipeline J3), ORM conformance pattern #3548 —
 * the in-memory implementation of the enriched-dataset store:
 * the test double every enrich test runs against, built on
 * the foundation's InMemoryRepository (the conformance twin of
 * the DO Repository core). Artifacts persist as the same flat
 * row shape the SQL residencies store (JSON in a text column),
 * so a value read back is a fresh parse in every residency.
 * Semantics identical to the SQL residencies: newest-first per
 * enrich job (createdAt desc, insertion desc as the tiebreak
 * the SQL residencies get from id ordering), keep-per-job
 * prune on store, latestUsable skipping failed/empty runs.
 * Constructed explicitly by its users (tests, local
 * development) — never as a silent production fallback.
 */
import { InMemoryRepository } from "./inMemoryOrmAdapters";
import type { jobEnrichedDatasets } from "./drizzleSchema";
import {
  ENRICHED_DATASETS_TABLE,
  isUsableEnrichedArtifact,
  type EnrichedDatasetArtifact,
  type EnrichedDatasetStore,
  type EnrichedDatasetStoreInput,
  type EnrichedDatasetStoreOptions,
} from "./enrichedDatasetPorts";

type EnrichedDatasetRow = typeof jobEnrichedDatasets.$inferSelect;

class EnrichedDatasetMemoryRepository extends InMemoryRepository<EnrichedDatasetRow> {
  constructor() {
    super(ENRICHED_DATASETS_TABLE, "id");
  }
}

export class InMemoryEnrichedDatasetStore implements EnrichedDatasetStore {
  private readonly repo = new EnrichedDatasetMemoryRepository();
  private seq = 0;
  private readonly seqById = new Map<string, number>();
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;

  constructor(options?: EnrichedDatasetStoreOptions) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private rowsFor(jobId: string): EnrichedDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .map((row) => JSON.parse(row.artifactJson) as EnrichedDatasetArtifact)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
        return (this.seqById.get(b.id) ?? 0) - (this.seqById.get(a.id) ?? 0);
      });
  }

  async store(input: EnrichedDatasetStoreInput): Promise<EnrichedDatasetArtifact> {
    const { nowIso, ...rest } = input;
    const artifact: EnrichedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    this.seqById.set(artifact.id, ++this.seq);
    this.repo.create({
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
    });
    for (const excess of this.rowsFor(artifact.jobId).slice(this.keepPerJob)) {
      this.repo.delete(excess.id);
      this.seqById.delete(excess.id);
    }
    return artifact;
  }

  async latest(jobId: string): Promise<EnrichedDatasetArtifact | undefined> {
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<EnrichedDatasetArtifact | undefined> {
    return this.rowsFor(jobId).find(isUsableEnrichedArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<EnrichedDatasetArtifact[]> {
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }
}
