/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the discovery-alert port: the legacy SqlDiscoveryAlertStore
 * (issue #18), moved into the data layer.
 * src/trading/options/discoveryAlertStore.ts is now a re-export
 * shim over this module and discoveryAlertPorts.ts.
 *
 * Dedupe rests on the schema's UNIQUE (scope_key, symbol,
 * thesis, day) constraint — a racing duplicate record fails
 * the INSERT rather than landing twice — so this adapter needs
 * no transaction wrap: its units are single statements.
 */
import type { DiscoverySignalType } from "../trading";
import type { OptionThesis } from "../trading";
import type {
  DiscoveryAlertRecord,
  DiscoveryAlertRecordInput,
  DiscoveryAlertSqlExecutor,
  DiscoveryAlertStore,
} from "./discoveryAlertPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

const TABLE = "mas_discovery_alerts";

const CREATE_TABLE_SQL = doTableSql("mas_discovery_alerts");
const HAS_SQL =
  `SELECT COUNT(*) AS count FROM ${TABLE} WHERE scope_key = ? AND symbol = ? AND thesis = ? AND day = ?`;
const COUNT_DAY_SQL = `SELECT COUNT(*) AS count FROM ${TABLE} WHERE scope_key = ? AND day = ?`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, run_id, scope_key, symbol, thesis, score, day, evidence, fired_signals, created_at) ` +
  `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const LIST_SQL =
  `SELECT id, run_id, scope_key, symbol, thesis, score, day, evidence, fired_signals, created_at FROM ${TABLE} ` +
  `WHERE scope_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`;

interface AlertRow {
  id: string;
  run_id: string;
  scope_key: string;
  symbol: string;
  thesis: string;
  score: number;
  day: string;
  evidence: string;
  fired_signals: string;
  created_at: string;
}

function rowToRecord(row: AlertRow): DiscoveryAlertRecord {
  return {
    id: row.id,
    runId: row.run_id,
    scopeKey: row.scope_key,
    symbol: row.symbol,
    thesis: row.thesis as OptionThesis,
    discoveryScore: Number(row.score),
    day: row.day,
    evidence: row.evidence,
    firedSignals: JSON.parse(row.fired_signals) as DiscoverySignalType[],
    createdAt: row.created_at,
  };
}

export class SqlDiscoveryAlertStore implements DiscoveryAlertStore {
  private ensured = false;
  private readonly idFactory: () => string;

  constructor(
    private readonly sql: DiscoveryAlertSqlExecutor,
    options: { idFactory?: () => string } = {},
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.ensured = true;
  }

  private count(query: string, ...params: unknown[]): number {
    const rows = Array.from(this.sql.exec(query, ...params)) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  async hasAlerted(scopeKey: string, symbol: string, thesis: OptionThesis, day: string): Promise<boolean> {
    this.ensure();
    return this.count(HAS_SQL, scopeKey, symbol, thesis, day) > 0;
  }

  async countForDay(scopeKey: string, day: string): Promise<number> {
    this.ensure();
    return this.count(COUNT_DAY_SQL, scopeKey, day);
  }

  async record(input: DiscoveryAlertRecordInput): Promise<DiscoveryAlertRecord> {
    this.ensure();
    const record: DiscoveryAlertRecord = { ...input, id: `disc_alert_${this.idFactory()}` };
    this.sql.exec(
      INSERT_SQL,
      record.id,
      record.runId,
      record.scopeKey,
      record.symbol,
      record.thesis,
      record.discoveryScore,
      record.day,
      record.evidence,
      JSON.stringify(record.firedSignals),
      record.createdAt,
    );
    return record;
  }

  async list(scopeKey: string, options: { limit?: number } = {}): Promise<DiscoveryAlertRecord[]> {
    this.ensure();
    const rows = Array.from(this.sql.exec(LIST_SQL, scopeKey, options.limit ?? 25)) as AlertRow[];
    return rows.map(rowToRecord);
  }
}
