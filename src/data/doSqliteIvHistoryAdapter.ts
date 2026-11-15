/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the IV-history port: the legacy SqlIvHistoryStore (issue
 * #15), moved into the data layer.
 * src/trading/options/ivHistoryStore.ts is now a re-export shim
 * over this module and ivHistoryPorts.ts.
 *
 * This adapter is the PRODUCTION DEFAULT (cutover gate, R-2 on
 * #2337): the D1 adapter (d1IvHistoryAdapter.ts) is
 * conformance-proven but not selected until the owner ruling
 * on backfill vs warming-up restart lands. record() is a
 * single idempotent statement per record and is deliberately
 * NOT wrapped in a transaction batch (step-2 audit §4): a
 * provider-failed day is an absent observation, never a
 * rolled-back batch.
 */
import {
  computeIvStats,
  normalizeIvBroker,
  type IvBroker,
  type IvHistoryCoverage,
  type IvHistoryRecord,
  type IvHistoryStore,
  type IvSqlExecutor,
  type IvStats,
} from "./ivHistoryPorts";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import { DO_DML_CATALOGUE } from "./schemaComponent/doDmlCatalogue";
import { executeDoDml } from "./schemaComponent/doDmlExecutor";
import { remainderAlterSql } from "./schemaComponent/remainderCatalogue";

const CREATE_TABLE_SQL = doTableSql("mas_iv_history");
/**
 * Issue #3326: additive column for tables created before provenance existed.
 * Best-effort by design — a second run (or a fresh table) reports "duplicate
 * column name", which is the already-applied state, not a failure.
 */
const ALTER_ADD_BROKER_SQL = remainderAlterSql("mas_iv_history", "broker");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_iv_history_symbol_date");

interface IvRow {
  symbol: string;
  date: string;
  atm_iv: number;
  spot: number;
  expiry_date: string;
  dte: number;
  collected_at: string;
  broker?: string | null;
}

function rowToRecord(row: IvRow): IvHistoryRecord {
  return {
    symbol: row.symbol,
    date: row.date,
    // A pre-#3326 row has no broker; it was collected from E*TRADE chains.
    broker: normalizeIvBroker(row.broker),
    atmIv: Number(row.atm_iv),
    spot: Number(row.spot),
    expiryDate: row.expiry_date,
    dte: Number(row.dte),
    collectedAt: row.collected_at,
  };
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * IvHistoryStore over Durable Object SQLite. The table is ensured
 * lazily on first use (idempotent creation), following
 * the mas_opportunity_scans pattern.
 */
export class SqlIvHistoryStore implements IvHistoryStore {
  private ensured = false;

  constructor(private readonly sql: IvSqlExecutor) {}

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    try {
      this.sql.exec(ALTER_ADD_BROKER_SQL);
    } catch {
      // Already present: a fresh table has the column, and a second instance
      // re-running the probe sees the duplicate-column error. Not a failure.
    }
    this.sql.exec(CREATE_INDEX_SQL);
    this.ensured = true;
  }

  async record(record: IvHistoryRecord): Promise<boolean> {
    this.ensure();
    const symbol = normalizeSymbol(record.symbol);
    // First write wins: an existing (symbol, date) row is the day's
    // record, whatever a rerun computed later. The pre-check makes
    // the outcome reportable; INSERT OR IGNORE keeps the guarantee
    // even if a writer races the check.
    // First write wins per (symbol, date), regardless of broker: the day has
    // one observation, and a second broker must not rewrite its provenance.
    if (await this.get(symbol, record.date)) return false;
    return executeDoDml<boolean>(DO_DML_CATALOGUE, this.sql, "dml.do.mas_iv_history.insert", {
      record: {
        symbol,
        date: record.date,
        atm_iv: record.atmIv,
        spot: record.spot,
        expiry_date: record.expiryDate,
        dte: record.dte,
        collected_at: record.collectedAt,
        broker: normalizeIvBroker(record.broker),
      } satisfies IvRow,
    });
  }

  async get(symbol: string, date: string, broker?: IvBroker): Promise<IvHistoryRecord | null> {
    this.ensure();
    const sym = normalizeSymbol(symbol);
    const row = executeDoDml<IvRow | null>(
      DO_DML_CATALOGUE,
      this.sql,
      broker ? "dml.do.mas_iv_history.get_broker" : "dml.do.mas_iv_history.get",
      broker
        ? { where: { symbol: sym, date, broker: normalizeIvBroker(broker) } }
        : { where: { symbol: sym, date } },
    );
    return row ? rowToRecord(row) : null;
  }

  async listSeries(symbol: string, options: { limit?: number; broker?: IvBroker } = {}): Promise<IvHistoryRecord[]> {
    this.ensure();
    const sym = normalizeSymbol(symbol);
    const broker = options.broker ? normalizeIvBroker(options.broker) : undefined;
    const rows = executeDoDml<IvRow[]>(
      DO_DML_CATALOGUE,
      this.sql,
      broker
        ? options.limit !== undefined
          ? "dml.do.mas_iv_history.series_broker_limit"
          : "dml.do.mas_iv_history.series_broker"
        : options.limit !== undefined
          ? "dml.do.mas_iv_history.series_limit"
          : "dml.do.mas_iv_history.series",
      {
        where: broker ? { symbol: sym, broker } : { symbol: sym },
        orderBy: "date DESC",
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      },
    );
    return rows.map(rowToRecord);
  }

  async coverage(symbol: string, broker?: IvBroker): Promise<IvHistoryCoverage> {
    this.ensure();
    const rows = executeDoDml<Array<{ count: number; first_date: string | null; last_date: string | null }>>(
      DO_DML_CATALOGUE,
      this.sql,
      broker ? "dml.do.mas_iv_history.coverage_broker" : "dml.do.mas_iv_history.coverage",
      broker
        ? { symbol: normalizeSymbol(symbol), broker: normalizeIvBroker(broker) }
        : { symbol: normalizeSymbol(symbol) },
    );
    const row = rows[0];
    return {
      observations: Number(row?.count ?? 0),
      firstDate: row?.first_date ?? null,
      lastDate: row?.last_date ?? null,
    };
  }

  async listSymbols(options: { broker?: IvBroker } = {}): Promise<string[]> {
    this.ensure();
    const rows = executeDoDml<Array<{ symbol: string }>>(
      DO_DML_CATALOGUE,
      this.sql,
      options.broker ? "dml.do.mas_iv_history.symbols_broker" : "dml.do.mas_iv_history.symbols",
      options.broker ? { broker: normalizeIvBroker(options.broker) } : {},
    );
    return rows.map((r) => r.symbol);
  }
}
