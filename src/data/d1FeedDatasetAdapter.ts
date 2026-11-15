/**
 * Issue #3530 (S1) — the D1 implementation of the feed-dataset
 * port, Drizzle over the DML catalogue (the d1IndexListAdapter
 * pattern). Semantics identical to the in-memory adapter:
 * newest-first per (source, dataset), keep-per-dataset prune via
 * per-row DELETEs, latestUsable skipping failed/empty runs.
 *
 * The CREATE is idempotent and issued on the write path only, so
 * reads against a missing table resolve to undefined (no stored
 * dataset) rather than inventing one — the same tolerance the
 * D1 index-list adapter declares. The full artifact rides in
 * artifact_json (the index-list members_json pattern); status
 * and row count are denormalized columns so latestUsable can
 * filter without parsing every row.
 *
 * #4282 P6a (#4384): the insert + reads + prune DELETE are
 * catalogue entries (dml.d1.mas_feed_datasets.*), executed
 * through the DML executor. The CREATE stays the DDL
 * catalogue's text, issued via db.run(sql.raw(...)).
 */
import { sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { DataProviderId } from "../trading";
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
  FeedDatasetStoreInput,
  FeedDatasetStoreOptions,
} from "./feedDatasetPorts";
import { feedDatasetRowCount } from "./feedDatasetPorts";
import { masFeedDatasets } from "./drizzleSchema";
import { remainderD1TableSql } from "./schemaComponent/remainderCatalogue";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDml } from "./schemaComponent/dmlExecutor";

/** Drizzle D1 database object carrying the feed-dataset schema. */
export type FeedDatasetD1Db = DrizzleD1Database<{
  masFeedDatasets: typeof masFeedDatasets;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1FeedDatasetDb(d1: D1Database): FeedDatasetD1Db {
  return drizzle(d1, {
    schema: { masFeedDatasets },
  });
}

const CREATE_TABLE_SQL = remainderD1TableSql("mas_feed_datasets");

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
    await this.db.run(sql.raw(CREATE_TABLE_SQL));
  }

  async store(input: FeedDatasetStoreInput): Promise<FeedDatasetArtifact> {
    const { nowIso, ...rest } = input;
    const artifact: FeedDatasetArtifact = {
      ...rest,
      id: this.idFactory(),
      createdAt: nowIso ?? new Date().toISOString(),
    };
    await this.ensureTable();
    await executeDml(DML_CATALOGUE, this.db, "dml.d1.mas_feed_datasets.insert", {
      values: {
        id: artifact.id,
        createdAt: artifact.createdAt,
        sourceId: artifact.sourceId,
        dataset: artifact.dataset,
        jobId: artifact.jobId,
        runId: artifact.run.runId,
        status: artifact.run.status,
        asOf: artifact.asOf,
        rowsPersisted: feedDatasetRowCount(artifact),
        artifactJson: JSON.stringify(artifact),
      },
    });
    // Prune: keep the newest keepPerDataset rows for (source, dataset).
    const ids = (await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.mas_feed_datasets.list_ids",
      { sourceId: artifact.sourceId, dataset: artifact.dataset },
    )) as Array<{ id: string }>;
    for (const row of ids.slice(this.keepPerDataset)) {
      await executeDml(DML_CATALOGUE, this.db, "dml.d1.mas_feed_datasets.prune_delete", {
        id: row.id,
      });
    }
    return artifact;
  }

  async latest(
    sourceId: DataProviderId,
    dataset: string,
  ): Promise<FeedDatasetArtifact | undefined> {
    try {
      const rows = (await executeDml(
        DML_CATALOGUE,
        this.db,
        "dml.d1.mas_feed_datasets.read_latest",
        { sourceId, dataset },
      )) as ArtifactJsonRow[];
      return rows[0] ? parseArtifact(rows[0]) : undefined;
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
      const rows = (await executeDml(
        DML_CATALOGUE,
        this.db,
        "dml.d1.mas_feed_datasets.read_latest_usable",
        { sourceId, dataset },
      )) as ArtifactJsonRow[];
      return rows[0] ? parseArtifact(rows[0]) : undefined;
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
      const rows = (await executeDml(
        DML_CATALOGUE,
        this.db,
        "dml.d1.mas_feed_datasets.read_list",
        { sourceId, dataset, limit },
      )) as ArtifactJsonRow[];
      return rows.map(parseArtifact);
    } catch {
      return [];
    }
  }
}
