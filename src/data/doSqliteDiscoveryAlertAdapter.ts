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
import { DO_DML_CATALOGUE } from "./schemaComponent/doDmlCatalogue";
import { executeDoDml } from "./schemaComponent/doDmlExecutor";

const CREATE_TABLE_SQL = doTableSql("mas_discovery_alerts");

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

  private count(code: string, where: Record<string, unknown>): number {
    return executeDoDml<number>(DO_DML_CATALOGUE, this.sql, code, { where });
  }

  async hasAlerted(scopeKey: string, symbol: string, thesis: OptionThesis, day: string): Promise<boolean> {
    this.ensure();
    return this.count("dml.do.mas_discovery_alerts.has", { scope_key: scopeKey, symbol, thesis, day }) > 0;
  }

  async countForDay(scopeKey: string, day: string): Promise<number> {
    this.ensure();
    return this.count("dml.do.mas_discovery_alerts.count_day", { scope_key: scopeKey, day });
  }

  async record(input: DiscoveryAlertRecordInput): Promise<DiscoveryAlertRecord> {
    this.ensure();
    const record: DiscoveryAlertRecord = { ...input, id: `disc_alert_${this.idFactory()}` };
    executeDoDml(DO_DML_CATALOGUE, this.sql, "dml.do.mas_discovery_alerts.insert", {
      record: {
        id: record.id,
        run_id: record.runId,
        scope_key: record.scopeKey,
        symbol: record.symbol,
        thesis: record.thesis,
        score: record.discoveryScore,
        day: record.day,
        evidence: record.evidence,
        fired_signals: JSON.stringify(record.firedSignals),
        created_at: record.createdAt,
      } satisfies AlertRow,
    });
    return record;
  }

  async list(scopeKey: string, options: { limit?: number } = {}): Promise<DiscoveryAlertRecord[]> {
    this.ensure();
    const rows = executeDoDml<AlertRow[]>(DO_DML_CATALOGUE, this.sql, "dml.do.mas_discovery_alerts.list", {
      where: { scope_key: scopeKey },
      orderBy: "created_at DESC, id DESC",
      limit: options.limit ?? 25,
    });
    return rows.map(rowToRecord);
  }
}
