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
import { remainderAlterSql } from "./schemaComponent/remainderCatalogue";

const TABLE = "mas_iv_history";

const CREATE_TABLE_SQL = doTableSql("mas_iv_history");
/**
 * Issue #3326: additive column for tables created before provenance existed.
 * Best-effort by design — a second run (or a fresh table) reports "duplicate
 * column name", which is the already-applied state, not a failure.
 */
const ALTER_ADD_BROKER_SQL = remainderAlterSql("mas_iv_history", "broker");
const CREATE_INDEX_SQL = doIndexSql("idx_mas_iv_history_symbol_date");
const COLUMNS = `symbol, date, atm_iv, spot, expiry_date, dte, collected_at, broker`;
const GET_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE symbol = ? AND date = ?`;
const GET_BROKER_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE symbol = ? AND date = ? AND broker = ?`;
const INSERT_SQL =
  `INSERT OR IGNORE INTO ${TABLE} (symbol, date, atm_iv, spot, expiry_date, dte, collected_at, broker) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const SERIES_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE symbol = ? ORDER BY date DESC`;
const SERIES_BROKER_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE symbol = ? AND broker = ? ORDER BY date DESC`;
const SERIES_LIMIT_SQL = `SELECT ${COLUMNS} FROM ${TABLE} WHERE symbol = ? ORDER BY date DESC LIMIT ?`;
const SERIES_BROKER_LIMIT_SQL =
  `SELECT ${COLUMNS} FROM ${TABLE} WHERE symbol = ? AND broker = ? ORDER BY date DESC LIMIT ?`;
const COVERAGE_SQL =
  `SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM ${TABLE} WHERE symbol = ?`;
const COVERAGE_BROKER_SQL =
  `SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM ${TABLE} WHERE symbol = ? AND broker = ?`;
const SYMBOLS_SQL = `SELECT DISTINCT symbol FROM ${TABLE} ORDER BY symbol ASC`;
const SYMBOLS_BROKER_SQL = `SELECT DISTINCT symbol FROM ${TABLE} WHERE broker = ? ORDER BY symbol ASC`;

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
    this.sql.exec(
      INSERT_SQL,
      symbol,
      record.date,
      record.atmIv,
      record.spot,
      record.expiryDate,
      record.dte,
      record.collectedAt,
      normalizeIvBroker(record.broker),
    );
    return true;
  }

  async get(symbol: string, date: string, broker?: IvBroker): Promise<IvHistoryRecord | null> {
    this.ensure();
    const sym = normalizeSymbol(symbol);
    const rows = (
      broker
        ? Array.from(this.sql.exec(GET_BROKER_SQL, sym, date, normalizeIvBroker(broker)))
        : Array.from(this.sql.exec(GET_SQL, sym, date))
    ) as IvRow[];
    return rows.length ? rowToRecord(rows[0]) : null;
  }

  async listSeries(symbol: string, options: { limit?: number; broker?: IvBroker } = {}): Promise<IvHistoryRecord[]> {
    this.ensure();
    const sym = normalizeSymbol(symbol);
    const broker = options.broker ? normalizeIvBroker(options.broker) : undefined;
    const statement = broker
      ? options.limit !== undefined
        ? SERIES_BROKER_LIMIT_SQL
        : SERIES_BROKER_SQL
      : options.limit !== undefined
        ? SERIES_LIMIT_SQL
        : SERIES_SQL;
    const params: unknown[] = broker ? [sym, broker] : [sym];
    if (options.limit !== undefined) params.push(options.limit);
    const rows = Array.from(this.sql.exec(statement, ...params)) as IvRow[];
    return rows.map(rowToRecord);
  }

  async coverage(symbol: string, broker?: IvBroker): Promise<IvHistoryCoverage> {
    this.ensure();
    const rows = (
      broker
        ? Array.from(this.sql.exec(COVERAGE_BROKER_SQL, normalizeSymbol(symbol), normalizeIvBroker(broker)))
        : Array.from(this.sql.exec(COVERAGE_SQL, normalizeSymbol(symbol)))
    ) as Array<{
      count: number;
      first_date: string | null;
      last_date: string | null;
    }>;
    const row = rows[0];
    return {
      observations: Number(row?.count ?? 0),
      firstDate: row?.first_date ?? null,
      lastDate: row?.last_date ?? null,
    };
  }

  async listSymbols(options: { broker?: IvBroker } = {}): Promise<string[]> {
    this.ensure();
    const rows = (
      options.broker
        ? Array.from(this.sql.exec(SYMBOLS_BROKER_SQL, normalizeIvBroker(options.broker)))
        : Array.from(this.sql.exec(SYMBOLS_SQL))
    ) as Array<{ symbol: string }>;
    return rows.map((r) => r.symbol);
  }
}
