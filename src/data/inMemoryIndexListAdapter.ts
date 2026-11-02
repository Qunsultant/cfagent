/**
 * Issue #1980 — the in-memory implementation of the stored
 * index-list port, with semantics identical to the SQL adapters:
 * newest-first per index, keep-per-index prune on store.
 */
import type { IndexId, IndexMember } from "../trading";
import type {
  IndexListArtifact,
  IndexListStore,
  IndexListStoreOptions,
} from "./indexListPorts";

interface IndexListRow {
  artifact: IndexListArtifact;
  seq: number;
}

/** Newest-first: createdAt descending, insertion descending. */
function byNewestFirst(a: IndexListRow, b: IndexListRow): number {
  if (a.artifact.createdAt !== b.artifact.createdAt) {
    return a.artifact.createdAt < b.artifact.createdAt ? 1 : -1;
  }
  return b.seq - a.seq;
}

export class InMemoryIndexListStore implements IndexListStore {
  private rows: IndexListRow[] = [];
  private seq = 0;
  private readonly idFactory: () => string;
  private readonly keepPerIndex: number;

  constructor(options?: IndexListStoreOptions) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerIndex = options?.keepPerIndex ?? 10;
  }

  async store(input: {
    index: IndexId;
    snapshotDate: string;
    symbols: IndexMember[];
    source: string;
    sourceLabel: string;
    derivedFromHoldings: boolean;
    nowIso?: string;
  }): Promise<IndexListArtifact> {
    const artifact: IndexListArtifact = {
      id: this.idFactory(),
      index: input.index,
      snapshotDate: input.snapshotDate,
      symbols: input.symbols,
      source: input.source,
      sourceLabel: input.sourceLabel,
      derivedFromHoldings: input.derivedFromHoldings,
      createdAt: input.nowIso ?? new Date().toISOString(),
    };
    this.rows.push({ artifact, seq: ++this.seq });
    const mine = this.rows
      .filter((r) => r.artifact.index === input.index)
      .sort(byNewestFirst);
    const excess = new Set(mine.slice(this.keepPerIndex).map((r) => r.artifact.id));
    if (excess.size > 0) {
      this.rows = this.rows.filter((r) => !excess.has(r.artifact.id));
    }
    return artifact;
  }

  async latest(index: IndexId): Promise<IndexListArtifact | undefined> {
    return this.rows
      .filter((r) => r.artifact.index === index)
      .sort(byNewestFirst)[0]?.artifact;
  }
}
