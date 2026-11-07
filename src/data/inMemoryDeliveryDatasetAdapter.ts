/**
 * Issue #3539 (Pipeline J6), on the CDO data foundation
 * (#3548 pattern) — the in-memory implementation of the
 * delivery-dataset store, the SAME port with zero residency:
 * the deterministic test double for the deliver stage and
 * the host compositions, built on the foundation's
 * InMemoryRepository (the inMemoryGeneratedDatasetAdapter
 * pattern — an insertion sequence tiebreaker, because
 * wall-clock timestamps can collide and insertion order is
 * the truth the residencies' created_at+id ordering
 * approximates).
 *
 * Semantics identical to the other residencies: newest-first
 * per deliver job, keep-per-job prune on store, latestUsable
 * skipping failed/empty runs, and listForInput — the resume
 * lookup over the consumed generated artifact's id.
 */
import { InMemoryRepository } from "./inMemoryOrmAdapters";
import {
  deliveredChannelCount,
  isUsableDeliveryArtifact,
  type DeliveryDatasetArtifact,
  type DeliveryDatasetStore,
  type DeliveryDatasetStoreInput,
  type DeliveryDatasetStoreOptions,
} from "./deliveryDatasetPorts";

interface DeliveryDatasetRow {
  id: string;
  createdAt: string;
  jobId: string;
  generateJobId: string;
  sourceId: string;
  dataset: string;
  runId: string;
  status: string;
  asOf: string;
  rowsPersisted: number;
  inputArtifactId: string;
  artifactJson: string;
  __seq: number;
}

/** The in-memory delivery-dataset store (tests, host doubles). */
export class InMemoryDeliveryDatasetStore implements DeliveryDatasetStore {
  private readonly repo = new InMemoryRepository<DeliveryDatasetRow>("id");
  private readonly idFactory: () => string;
  private readonly keepPerJob: number;
  private seqCounter = 0;

  constructor(options?: DeliveryDatasetStoreOptions) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerJob = options?.keepPerJob ?? 10;
  }

  private rowsFor(jobId: string): DeliveryDatasetArtifact[] {
    return this.repo
      .findMany({ where: { jobId } })
      .sort((a, b) => b.__seq - a.__seq)
      .map((row) => JSON.parse(row.artifactJson) as DeliveryDatasetArtifact);
  }

  async store(input: DeliveryDatasetStoreInput): Promise<DeliveryDatasetArtifact> {
    const { nowIso, ...rest } = input;
    const artifact: DeliveryDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    this.repo.create({
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
      __seq: this.seqCounter++,
    });
    const mine = this.rowsFor(artifact.jobId);
    for (const excess of mine.slice(this.keepPerJob)) {
      this.repo.delete(excess.id);
    }
    return artifact;
  }

  async latest(jobId: string): Promise<DeliveryDatasetArtifact | undefined> {
    return this.rowsFor(jobId)[0];
  }

  async latestUsable(jobId: string): Promise<DeliveryDatasetArtifact | undefined> {
    return this.rowsFor(jobId).find(isUsableDeliveryArtifact);
  }

  async listRuns(jobId: string, limit = 10): Promise<DeliveryDatasetArtifact[]> {
    return this.rowsFor(jobId).slice(0, Math.max(0, limit));
  }

  async listForInput(
    jobId: string,
    inputArtifactId: string,
    limit = 50,
  ): Promise<DeliveryDatasetArtifact[]> {
    return this.rowsFor(jobId)
      .filter((a) => a.inputArtifactId === inputArtifactId)
      .slice(0, Math.max(0, limit));
  }
}
