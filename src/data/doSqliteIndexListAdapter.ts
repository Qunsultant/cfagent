/**
 * Issue #1980 — the DO-SQLite implementation of the stored
 * index-list port, in the feed-seam idiom verbatim: idempotent creation
 * + single-line statements (the MockSqlStorage
 * lesson — multi-line column lists silently no-op in the shared
 * mock), newest-first per index, keep-per-index prune via
 * per-row DELETEs.
 */
import type { IndexId, IndexMember } from "../trading";
import type {
  IndexListArtifact,
  IndexListSqlExecutor,
  IndexListStore,
  IndexListStoreOptions,
} from "./indexListPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";

const TABLE = "mas_index_lists";

const CREATE_TABLE_SQL = doTableSql("mas_index_lists");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_index_lists_lookup");
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, created_at, index_id, snapshot_date, source, source_label, derived_from_holdings, members_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const IDS_SQL =
  `SELECT id FROM ${TABLE} WHERE index_id = ? ORDER BY created_at DESC, id DESC`;
const LATEST_SQL =
  `SELECT id, snapshot_date, source, source_label, derived_from_holdings, members_json, created_at FROM ${TABLE} WHERE index_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

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

export class SqlIndexListStore implements IndexListStore {
  private readonly idFactory: () => string;
  private readonly keepPerIndex: number;

  constructor(
    private readonly sql: IndexListSqlExecutor,
    options?: IndexListStoreOptions,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerIndex = options?.keepPerIndex ?? 10;
  }

  private ensureTables(): void {
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
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
    this.ensureTables();
    const id = this.idFactory();
    const createdAt = input.nowIso ?? new Date().toISOString();
    this.sql.exec(
      INSERT_SQL,
      id,
      createdAt,
      input.index,
      input.snapshotDate,
      input.source,
      input.sourceLabel,
      input.derivedFromHoldings ? 1 : 0,
      JSON.stringify(input.symbols),
    );
    const ids = Array.from(
      this.sql.exec(IDS_SQL, input.index),
    ) as Array<{ id: string }>;
    for (const excess of ids.slice(this.keepPerIndex)) {
      this.sql.exec(DELETE_SQL, excess.id);
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
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(LATEST_SQL, index),
    ) as IndexListRow[];
    const row = rows[0];
    if (!row) return undefined;
    return parseRow(row, index);
  }
}
