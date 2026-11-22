/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the feed-snapshot port: the legacy SqlFeedSnapshotStore
 * (consolidation #1236), moved into the data layer.
 * src/services/feedSnapshotStore.ts is now a re-export shim
 * over this module and feedSnapshotPorts.ts.
 *
 * The store surface is SYNCHRONOUS (the port keeps the shape
 * the seam was written with). The INSERT + keep-per-symbol
 * prune pair still runs as one unit when the host supplies
 * the transaction-capable storage object and the process
 * registered the transaction runner (src/server.ts does; see
 * transactionRunnerProvider.ts): the runner's sync leg
 * executes its closure synchronously inside transactionSync
 * and rethrows a unit failure synchronously, preserving this
 * surface's throw contract (ADR D-C, step-2 audit §4). Over a
 * bare sql handle — or unregistered — the pair applies
 * sequentially, exactly the legacy behaviour.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import { getTransactionRunner } from "./transactionRunnerProvider";
import type { OptionsDataSnapshot } from "../trading";
import type {
  FeedSnapshotArtifact,
  FeedSnapshotLoadParams,
  FeedSnapshotStore,
  FeedSnapshotStoreOptions,
  FeedSqlExecutor,
} from "./feedSnapshotPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import { DO_DML_CATALOGUE } from "./schemaComponent/doDmlCatalogue";
import { executeDoDml } from "./schemaComponent/doDmlExecutor";

const CREATE_TABLE_SQL = doTableSql("mas_feed_snapshots");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_feed_snapshots_lookup");

interface FeedSnapshotRow {
  id: string;
  snapshot_json: string;
  as_of: string;
  data_source: string;
  load_params_json: string;
  created_at: string;
}

function parseRow(
  row: FeedSnapshotRow,
  userLogin: string,
  symbol: string,
): FeedSnapshotArtifact {
  return {
    id: row.id,
    userLogin,
    symbol,
    snapshot: JSON.parse(row.snapshot_json) as OptionsDataSnapshot,
    asOf: row.as_of,
    dataSource: row.data_source,
    loadParams: JSON.parse(row.load_params_json) as FeedSnapshotLoadParams,
    createdAt: row.created_at,
  };
}

export class SqlFeedSnapshotStore implements FeedSnapshotStore {
  private readonly idFactory: () => string;
  private readonly keepPerSymbol: number;

  constructor(
    private readonly sql: FeedSqlExecutor,
    options?: FeedSnapshotStoreOptions,
    /** The transaction-capable storage object (ctx.storage),
     *  when the host supplies it — enables the withTransaction
     *  unit on store (see the module header). */
    private readonly storage?: DoTransactionStorage,
  ) {
    this.idFactory = options?.idFactory ?? (() => crypto.randomUUID());
    this.keepPerSymbol = options?.keepPerSymbol ?? 10;
  }

  private ensureTables(): void {
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
  }

  store(input: {
    userLogin: string;
    symbol: string;
    snapshot: OptionsDataSnapshot;
    asOf: string;
    dataSource: string;
    loadParams: FeedSnapshotLoadParams;
    nowIso?: string;
  }): FeedSnapshotArtifact {
    this.ensureTables();
    const symbol = input.symbol.toUpperCase().trim();
    const id = this.idFactory();
    const createdAt = input.nowIso ?? new Date().toISOString();
    const write = () => {
      executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_feed_snapshots.insert", {
        record: {
          id,
          created_at: createdAt,
          user_login: input.userLogin,
          symbol,
          as_of: input.asOf,
          data_source: input.dataSource,
          snapshot_json: JSON.stringify(input.snapshot),
          load_params_json: JSON.stringify(input.loadParams),
        },
      });
      // Prune one row at a time (single-id DELETEs): the shared mock
      // used not to evaluate NOT IN subqueries (issue #6099 fixed
      // that in tests/mock-sql.ts), and per-row deletes are exactly
      // as cheap at this volume — the shape stays as-is.
      const ids = executeDoDml<Array<{ id: string }>>(
        DO_DML_CATALOGUE,
        this.sql,
        "dml.do.mas_feed_snapshots.ids",
        {
          where: { user_login: input.userLogin, symbol },
          orderBy: "created_at DESC, id DESC",
        },
      );
      for (const excess of ids.slice(this.keepPerSymbol)) {
        executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_feed_snapshots.delete", {
          id: excess.id,
        });
      }
    };
    const runner = this.storage?.transactionSync ? getTransactionRunner() : null;
    if (this.storage && runner) {
      // Synchronous unit (see the module header): the runner's
      // sync leg executes the closure inside transactionSync and
      // rethrows a unit failure synchronously, so this sync
      // surface keeps its throw contract.
      runner.runSyncUnit(
        this.storage,
        { operationName: "feedSnapshots.store", domain: "options-discovery" },
        write,
      );
    } else {
      write();
    }
    return {
      id,
      userLogin: input.userLogin,
      symbol,
      snapshot: input.snapshot,
      asOf: input.asOf,
      dataSource: input.dataSource,
      loadParams: input.loadParams,
      createdAt,
    };
  }

  latest(userLogin: string, symbol: string): FeedSnapshotArtifact | undefined {
    this.ensureTables();
    const rows = executeDoDml<FeedSnapshotRow[]>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_feed_snapshots.latest",
      {
        where: { user_login: userLogin, symbol: symbol.toUpperCase().trim() },
        orderBy: "created_at DESC, id DESC",
        limit: 1,
      },
    );
    const row = rows[0];
    if (!row) return undefined;
    return parseRow(row, userLogin, symbol.toUpperCase().trim());
  }

  byId(userLogin: string, id: string): FeedSnapshotArtifact | undefined {
    this.ensureTables();
    const row = executeDoDml<FeedSnapshotRow | null>(
      DO_DML_CATALOGUE,
      this.sql,
      "dml.do.mas_feed_snapshots.by_id",
      { where: { user_login: userLogin, id } },
    );
    if (!row) return undefined;
    // The row's symbol is not needed beyond the stored snapshot,
    // which always carries its own symbol.
    const snapshot = JSON.parse(row.snapshot_json) as OptionsDataSnapshot;
    return parseRow(row, userLogin, snapshot.symbol);
  }
}

/** Pick exactly the load-shaping fields off a discovery request (or
 *  any request-shaped object). Unknown fields (thesis, targets,
 *  strategy lists) never shape the chain load, so they never take
 *  part in filter matching. */
export function pickFeedLoadParams(request: {
  symbol?: unknown;
  minDte?: unknown;
  maxDte?: unknown;
  minVolume?: unknown;
  minOpenInterest?: unknown;
  maxSpreadPct?: unknown;
  maxQuoteAgeSeconds?: unknown;
  contractLimit?: unknown;
  dataMode?: unknown;
  expirationDteBands?: unknown;
}): FeedSnapshotLoadParams {
  const out: FeedSnapshotLoadParams = {};
  if (typeof request.symbol === "string" && request.symbol.trim()) {
    out.symbol = request.symbol.toUpperCase().trim();
  }
  const numeric: Array<keyof FeedSnapshotLoadParams> = [
    "minDte", "maxDte", "minVolume", "minOpenInterest",
    "maxSpreadPct", "maxQuoteAgeSeconds", "contractLimit",
  ];
  for (const key of numeric) {
    if (typeof request[key] === "number") (out as Record<string, unknown>)[key] = request[key];
  }
  if (typeof request.dataMode === "string") out.dataMode = request.dataMode;
  if (request.expirationDteBands !== undefined) out.expirationDteBands = request.expirationDteBands;
  return out;
}

function normalizeDataMode(value: unknown): unknown {
  return value === undefined ? "live" : value;
}

function filtersMatch(
  artifactParams: FeedSnapshotLoadParams,
  requestFilters: FeedSnapshotLoadParams,
): boolean {
  const keys = new Set([
    ...Object.keys(artifactParams),
    ...Object.keys(requestFilters),
  ] as Array<keyof FeedSnapshotLoadParams>);
  for (const key of keys) {
    const a = key === "dataMode"
      ? normalizeDataMode(artifactParams[key])
      : artifactParams[key];
    const b = key === "dataMode"
      ? normalizeDataMode(requestFilters[key])
      : requestFilters[key];
    // An absent dataMode is the live path (loadSnapshot: anything
    // other than "calibrated-demo" loads live), so normalization
    // above makes absent ≡ "live" on both sides.
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}
