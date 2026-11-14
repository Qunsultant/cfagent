/**
 * Issue #1980 — the D1 implementation of the stored index-list
 * port, raw prepare/bind (the d1QuoteSourceAdapter pattern, not
 * Drizzle: one table, four statements). Semantics identical to
 * the DO-SQLite and in-memory adapters: newest-first per index,
 * keep-per-index prune via per-row DELETEs. Statements are
 * single-line (the feed-seam idiom); the CREATE is idempotent,
 * so environments whose migrations have not run still get a
 * writable table on first store, and reads against a missing
 * table resolve to undefined (no stored list) rather than
 * inventing one.
 */
import type { IndexId, IndexMember } from "../trading";
import type {
  IndexListArtifact,
  IndexListStore,
  IndexListStoreOptions,
} from "./indexListPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

/** Minimal structural shape of the D1 binding this adapter needs. */
export interface IndexListD1Db {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
    run(): Promise<unknown>;
  };
}

const CREATE_TABLE_SQL = doTableSql("mas_index_lists");
const INSERT_SQL =
  "INSERT INTO mas_index_lists (id, created_at, index_id, snapshot_date, source, source_label, derived_from_holdings, members_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const IDS_SQL =
  "SELECT id FROM mas_index_lists WHERE index_id = ? ORDER BY created_at DESC, id DESC";
const LATEST_SQL =
  "SELECT id, snapshot_date, source, source_label, derived_from_holdings, members_json, created_at FROM mas_index_lists WHERE index_id = ? ORDER BY created_at DESC, id DESC LIMIT 1";
const DELETE_SQL = "DELETE FROM mas_index_lists WHERE id = ?";

interface IndexListRow {
  id: string;
  snapshot_date: string;
  source: string;
  source_label: string;
  derived_from_holdings: number;
  members_json: string;
  created_at: string;
}

function parseRow(row: IndexListRow, index: IndexId): IndexListArtifact {
  return {
    id: row.id,
    index,
    snapshotDate: row.snapshot_date,
    symbols: JSON.parse(row.members_json) as IndexMember[],
    source: row.source,
    sourceLabel: row.source_label,
    derivedFromHoldings: row.derived_from_holdings === 1,
    createdAt: row.created_at,
  };
}

export class D1IndexListStore implements IndexListStore {
  private readonly idFactory: () => string;
  private readonly keepPerIndex: number;

  constructor(
    private readonly db: IndexListD1Db,
    options?: IndexListStoreOptions,
  ) {
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
    await this.db.prepare(CREATE_TABLE_SQL).run();
    const id = this.idFactory();
    const createdAt = input.nowIso ?? new Date().toISOString();
    await this.db
      .prepare(INSERT_SQL)
      .bind(
        id,
        createdAt,
        input.index,
        input.snapshotDate,
        input.source,
        input.sourceLabel,
        input.derivedFromHoldings ? 1 : 0,
        JSON.stringify(input.symbols),
      )
      .run();
    const ids = await this.db
      .prepare(IDS_SQL)
      .bind(input.index)
      .all<{ id: string }>();
    for (const excess of ids.results.slice(this.keepPerIndex)) {
      await this.db.prepare(DELETE_SQL).bind(excess.id).run();
    }
    return {
      id,
      index: input.index,
      snapshotDate: input.snapshotDate,
      symbols: input.symbols,
      source: input.source,
      sourceLabel: input.sourceLabel,
      derivedFromHoldings: input.derivedFromHoldings,
      createdAt,
    };
  }

  async latest(index: IndexId): Promise<IndexListArtifact | undefined> {
    try {
      const row = await this.db
        .prepare(LATEST_SQL)
        .bind(index)
        .first<IndexListRow>();
      if (!row) return undefined;
      return parseRow(row, index);
    } catch {
      // Missing table (migrations not run, no store yet): no
      // stored list — the honest absence, never an invented one.
      return undefined;
    }
  }
}
