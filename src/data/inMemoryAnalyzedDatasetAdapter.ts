/**
 * Issue #3537 (Pipeline J4), on the CDO data foundation
 * (#3548 pattern) — the in-memory implementation of the
 * analyzed-dataset store, the SAME port with zero residency:
 * the deterministic test double for the analyze stage and the
 * host compositions, built on the foundation's InMemoryRepository
 * (the inMemoryEnrichedDatasetAdapter pattern — an insertion
 * sequence tiebreaker, because wall-clock timestamps can
 * collide and insertion order is the truth the residencies'
 * created_at+id ordering approximates).
 *
 * Semantics identical to the other residencies: newest-first
 * per analyze job, keep-per-job prune on store, latestUsable
 * skipping failed/empty runs.
 */
import { InMemoryRepository } from "./inMemoryOrmAdapters";
import {
  isUsableAnalyzedArtifact,
  type AnalyzedDatasetArtifact,
  type AnalyzedDatasetStore,
  type AnalyzedDatasetStoreInput,
  type AnalyzedDatasetStoreOptions,
} from "./analyzedDatasetPorts";

interface AnalyzedDatasetRow {
  id: string;
  createdAt: string;
  jobId: string;
  enrichJobId: string;
  sourceId: string;
  dataset: string;
  runId: string;
  status: string;
  asOf: string;
  rowsPersisted: number;
  artifactJson: string;
  __seq: number;
}

/** The in-memory analyzed-dataset store (tests, host doubles). */
export class InMemoryAnalyzedDatasetStore implements AnalyzedDatasetStore {
  private readonly repo = new InMemoryRepository<AnalyzedDatasetRow>("id");
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;
  private seqCounter = 0;

  constructor(options?: AnalyzedDatasetStoreOptions) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private rowsFor(jobId: string): AnalyzedDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .sort((a, b) => b.__seq - a.__seq)
      .map((row) => JSON.parse(row.artifactJson) as AnalyzedDatasetArtifact);
  }

  async store(input: AnalyzedDatasetStoreInput): Promise<AnalyzedDatasetArtifact> {
    const { nowIso, ...rest } = input;
    const artifact: AnalyzedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    this.repo.create({
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
      __seq: this.seqCounter++,
    });
    const mine = this.rowsFor(artifact.jobId);
    for (const excess of mine.slice(this.keepPerJob)) {
      this.repo.delete(excess.id);
    }
    return artifact;
  }

  async latest(jobId: string): Promise<AnalyzedDatasetArtifact | undefined> {
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<AnalyzedDatasetArtifact | undefined> {
    return this.rowsFor(jobId).find(isUsableAnalyzedArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<AnalyzedDatasetArtifact[]> {
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }
}
