/**
 * Issue #3530 (S1) — the in-memory implementation of the
 * feed-dataset port, with semantics identical to the D1 adapter:
 * newest-first per (source, dataset), keep-per-dataset prune on
 * store, latestUsable skipping failed/empty runs.
 */
import type { DataProviderId } from "../trading";
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
  FeedDatasetStoreInput,
  FeedDatasetStoreOptions,
} from "./feedDatasetPorts";
import { feedDatasetRowCount } from "./feedDatasetPorts";

interface FeedDatasetRow {
  artifact: FeedDatasetArtifact;
  seq: number;
}

/** Newest-first: createdAt descending, insertion descending. */
function byNewestFirst(a: FeedDatasetRow, b: FeedDatasetRow): number {
  if (a.artifact.createdAt !== b.artifact.createdAt) {
    return a.artifact.createdAt < b.artifact.createdAt ? 1 : -1;
  }
  return b.seq - a.seq;
}

function isUsable(artifact: FeedDatasetArtifact): boolean {
  return artifact.run.status !== "failed" && feedDatasetRowCount(artifact) > 0;
}

export class InMemoryFeedDatasetStore implements FeedDatasetStore {
  private rows: FeedDatasetRow[] = [];
  private seq = 0;
  private readonly idFactory: () => string;
  private readonly keepPerDataset: number;

  constructor(options?: FeedDatasetStoreOptions) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerDataset = options?.keepPerDataset ?? 10;
  }

  private mine(sourceId: DataProviderId, dataset: string): FeedDatasetRow[] {
    return this.rows
      .filter(
        (r) => r.artifact.sourceId === sourceId && r.artifact.dataset === dataset,
      )
      .sort(byNewestFirst);
  }

  async store(input: FeedDatasetStoreInput): Promise<FeedDatasetArtifact> {
    const { nowIso, ...rest } = input;
    const artifact: FeedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    this.rows.push({ artifact, seq: ++this.seq });
    const excess = new Set(
      this.mine(input.sourceId, input.dataset)
        .slice(this.keepPerDataset)
        .map((r) => r.artifact.id),
    );
    if (excess.size > 0) {
      this.rows = this.rows.filter((r) => !excess.has(r.artifact.id));
    }
    return artifact;
  }

  async latest(
    sourceId: DataProviderId,
    dataset: string,
  ): Promise<FeedDatasetArtifact | undefined> {
    return this.mine(sourceId, dataset)[0]?.artifact;
  }

  async latestUsable(
    sourceId: DataProviderId,
    dataset: string,
  ): Promise<FeedDatasetArtifact | undefined> {
    return this.mine(sourceId, dataset).find((r) => isUsable(r.artifact))
      ?.artifact;
  }

  async listRuns(
    sourceId: DataProviderId,
    dataset: string,
    limit = 10,
  ): Promise<FeedDatasetArtifact[]> {
    return this.mine(sourceId, dataset)
      .slice(0, limit)
      .map((r) => r.artifact);
  }
}
