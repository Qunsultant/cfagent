/**
 * Issue #1980 — the D1 implementation of the stored index-list
 * port, Drizzle over the DML catalogue. Semantics identical to
 * the DO-SQLite and in-memory adapters: newest-first per index,
 * keep-per-index prune via per-row DELETEs. The CREATE is
 * idempotent, so environments whose migrations have not run
 * still get a writable table on first store, and reads against
 * a missing table resolve to undefined (no stored list) rather
 * than inventing one.
 *
 * #4282 P6a (#4384): the insert + reads + prune DELETE are
 * catalogue entries (dml.d1.mas_index_lists.*), executed
 * through the DML executor. The CREATE stays the DDL
 * catalogue's text, issued via db.run(sql.raw(...)).
 */
import { sql } from "drizzle-orm";
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import type { IndexId, IndexMember } from "../trading";
import type {
  IndexListArtifact,
  IndexListStore,
  IndexListStoreOptions,
} from "./indexListPorts";
import { masIndexLists } from "./drizzleSchema";
import { doTableSql } from "./schemaComponent/doCatalogue";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDml } from "./schemaComponent/dmlExecutor";

/** Drizzle D1 database object carrying the index-list schema. */
export type IndexListD1Db = DrizzleD1Database<{
  masIndexLists: typeof masIndexLists;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1IndexListDb(d1: D1Database): IndexListD1Db {
  return createDrizzleD1Db(d1, {
    schema: { masIndexLists },
  });
}

const CREATE_TABLE_SQL = doTableSql("mas_index_lists");

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
    await this.db.run(sql.raw(CREATE_TABLE_SQL));
    const id = this.idFactory();
    const createdAt = input.nowIso ?? new Date().toISOString();
    await executeDml(DML_CATALOGUE, this.db, "dml.d1.mas_index_lists.insert", {
      values: {
        id,
        createdAt,
        indexId: input.index,
        snapshotDate: input.snapshotDate,
        source: input.source,
        sourceLabel: input.sourceLabel,
        derivedFromHoldings: input.derivedFromHoldings ? 1 : 0,
        membersJson: JSON.stringify(input.symbols),
      },
    });
    const ids = (await executeDml(
      DML_CATALOGUE,
      this.db,
      "dml.d1.mas_index_lists.list_ids",
      { indexId: input.index },
    )) as Array<{ id: string }>;
    for (const excess of ids.slice(this.keepPerIndex)) {
      await executeDml(DML_CATALOGUE, this.db, "dml.d1.mas_index_lists.prune_delete", {
        id: excess.id,
      });
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
      const rows = (await executeDml(
        DML_CATALOGUE,
        this.db,
        "dml.d1.mas_index_lists.read_latest",
        { indexId: index },
      )) as IndexListRow[];
      if (!rows[0]) return undefined;
      return parseRow(rows[0], index);
    } catch {
      // Missing table (migrations not run, no store yet): no
      // stored list — the honest absence, never an invented one.
      return undefined;
    }
  }
}
