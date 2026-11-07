/**
 * Issue #3538 (Pipeline J5), on the CDO data foundation
 * (#3548 pattern) — the in-memory implementation of the
 * generated-dataset store, the SAME port with zero residency:
 * the deterministic test double for the generate stage and the
 * host compositions, built on the foundation's InMemoryRepository
 * (the inMemoryAnalyzedDatasetAdapter pattern — an insertion
 * sequence tiebreaker, because wall-clock timestamps can
 * collide and insertion order is the truth the residencies'
 * created_at+id ordering approximates).
 *
 * Semantics identical to the other residencies: newest-first
 * per generate job, keep-per-job prune on store, latestUsable
 * skipping failed/empty runs.
 */
import { InMemoryRepository } from "./inMemoryOrmAdapters";
import {
  generatedFormatCount,
  isUsableGeneratedArtifact,
  type GeneratedDatasetArtifact,
  type GeneratedDatasetStore,
  type GeneratedDatasetStoreInput,
  type GeneratedDatasetStoreOptions,
} from "./generatedDatasetPorts";

interface GeneratedDatasetRow {
  id: string;
  createdAt: string;
  jobId: string;
  analyzeJobId: string;
  sourceId: string;
  dataset: string;
  runId: string;
  status: string;
  asOf: string;
  rowsPersisted: number;
  artifactJson: string;
  __seq: number;
}

/** The in-memory generated-dataset store (tests, host doubles). */
export class InMemoryGeneratedDatasetStore implements GeneratedDatasetStore {
  private readonly repo = new InMemoryRepository<GeneratedDatasetRow>("id");
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;
  private seqCounter = 0;

  constructor(options?: GeneratedDatasetStoreOptions) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private rowsFor(jobId: string): GeneratedDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .sort((a, b) => b.__seq - a.__seq)
      .map((row) => JSON.parse(row.artifactJson) as GeneratedDatasetArtifact);
  }

  async store(input: GeneratedDatasetStoreInput): Promise<GeneratedDatasetArtifact> {
    const { nowIso, ...rest } = input;
    const artifact: GeneratedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    this.repo.create({
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
      __seq: this.seqCounter++,
    });
    const mine = this.rowsFor(artifact.jobId);
    for (const excess of mine.slice(this.keepPerJob)) {
      this.repo.delete(excess.id);
    }
    return artifact;
  }

  async latest(jobId: string): Promise<GeneratedDatasetArtifact | undefined> {
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<GeneratedDatasetArtifact | undefined> {
    return this.rowsFor(jobId).find(isUsableGeneratedArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<GeneratedDatasetArtifact[]> {
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }
}
