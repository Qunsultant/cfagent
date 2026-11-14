/**
 * Issue #3530 (S1) — the D1 implementation of the feed-dataset
 * port, raw prepare/bind (the d1IndexListAdapter pattern, not
 * Drizzle: one table, a handful of statements). Semantics
 * identical to the in-memory adapter: newest-first per (source,
 * dataset), keep-per-dataset prune via per-row DELETEs,
 * latestUsable skipping failed/empty runs.
 *
 * Statements are single-line (the feed-seam idiom); the CREATE
 * is idempotent and issued on the write path only, so reads
 * against a missing table resolve to undefined (no stored
 * dataset) rather than inventing one — the same tolerance the
 * D1 index-list adapter declares. The full artifact rides in
 * artifact_json (the index-list members_json pattern); status
 * and row count are denormalized columns so latestUsable can
 * filter without parsing every row.
 */
import type { DataProviderId } from "../trading";
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
  FeedDatasetStoreInput,
  FeedDatasetStoreOptions,
} from "./feedDatasetPorts";
import { feedDatasetRowCount } from "./feedDatasetPorts";
import { remainderD1TableSql } from "./schemaComponent/remainderCatalogue";

/** Minimal structural shape of the D1 binding this family needs. */
export interface FeedDatasetD1Db {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
    run(): Promise<unknown>;
  };
}

const CREATE_TABLE_SQL = remainderD1TableSql("mas_feed_datasets");
const INSERT_SQL =
  "INSERT INTO mas_feed_datasets (id, created_at, source_id, dataset, job_id, run_id, status, as_of, rows_persisted, artifact_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const IDS_SQL =
  "SELECT id FROM mas_feed_datasets WHERE source_id = ? AND dataset = ? ORDER BY created_at DESC, id DESC";
const LATEST_SQL =
  "SELECT artifact_json FROM mas_feed_datasets WHERE source_id = ? AND dataset = ? ORDER BY created_at DESC, id DESC LIMIT 1";
const LATEST_USABLE_SQL =
  "SELECT artifact_json FROM mas_feed_datasets WHERE source_id = ? AND dataset = ? AND status != 'failed' AND rows_persisted > 0 ORDER BY created_at DESC, id DESC LIMIT 1";
const LIST_SQL =
  "SELECT artifact_json FROM mas_feed_datasets WHERE source_id = ? AND dataset = ? ORDER BY created_at DESC, id DESC LIMIT ?";
const DELETE_SQL = "DELETE FROM mas_feed_datasets WHERE id = ?";

interface ArtifactJsonRow {
  artifact_json: string;
}

function parseArtifact(row: ArtifactJsonRow): FeedDatasetArtifact {
  return JSON.parse(row.artifact_json) as FeedDatasetArtifact;
}

export class D1FeedDatasetStore implements FeedDatasetStore {
  private readonly idFactory: () => string;
  private readonly keepPerDataset: number;

  constructor(
    private readonly db: FeedDatasetD1Db,
    options?: FeedDatasetStoreOptions,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerDataset = options?.keepPerDataset ?? 10;
  }

  private async ensureTable(): Promise<void> {
    await this.db.prepare(CREATE_TABLE_SQL).run();
  }

  async store(input: FeedDatasetStoreInput): Promise<FeedDatasetArtifact> {
    const { nowIso, ...rest } = input;
    const artifact: FeedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    await this.ensureTable();
    await this.db
      .prepare(INSERT_SQL)
      .bind(
        artifact.id,
        artifact.createdAt,
        artifact.sourceId,
        artifact.dataset,
        artifact.jobId,
        artifact.run.runId,
        artifact.run.status,
        artifact.asOf,
        feedDatasetRowCount(artifact),
        JSON.stringify(artifact),
      )
      .run();
    // Prune: keep the newest keepPerDataset rows for (source, dataset).
    const ids = await this.db
      .prepare(IDS_SQL)
      .bind(artifact.sourceId, artifact.dataset)
      .all<{ id: string }>();
    for (const row of ids.results.slice(this.keepPerDataset)) {
      await this.db.prepare(DELETE_SQL).bind(row.id).run();
    }
    return artifact;
  }

  async latest(
    sourceId: DataProviderId,
    dataset: string,
  ): Promise<FeedDatasetArtifact | undefined> {
    try {
      const row = await this.db
        .prepare(LATEST_SQL)
        .bind(sourceId, dataset)
        .first<ArtifactJsonRow>();
      return row ? parseArtifact(row) : undefined;
    } catch {
      // Missing table ⇒ no stored dataset (see the header).
      return undefined;
    }
  }

  async latestUsable(
    sourceId: DataProviderId,
    dataset: string,
  ): Promise<FeedDatasetArtifact | undefined> {
    try {
      const row = await this.db
        .prepare(LATEST_USABLE_SQL)
        .bind(sourceId, dataset)
        .first<ArtifactJsonRow>();
      return row ? parseArtifact(row) : undefined;
    } catch {
      return undefined;
    }
  }

  async listRuns(
    sourceId: DataProviderId,
    dataset: string,
    limit = 10,
  ): Promise<FeedDatasetArtifact[]> {
    try {
      const rows = await this.db
        .prepare(LIST_SQL)
        .bind(sourceId, dataset, limit)
        .all<ArtifactJsonRow>();
      return rows.results.map(parseArtifact);
    } catch {
      return [];
    }
  }
}
