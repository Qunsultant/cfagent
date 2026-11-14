/**
 * Issue #2357 (#1976 step 4b) — the DO-SQLite implementation
 * of the strategy policy state port: the legacy
 * src/services/strategyPolicyState.ts, moved into the data
 * layer statement-for-statement. The service module is now
 * a re-export shim over this adapter and strategyPolicyPorts.
 */
import type {
  StrategyPolicySqlExecutor,
  StrategyPolicyStore,
} from "./strategyPolicyPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqliteStrategyPolicyStore implements StrategyPolicyStore {
  constructor(private readonly sql: StrategyPolicySqlExecutor) {}

  ensureTables(): void {
    const sql = this.sql;
    sql.exec(doTableSql("mas_strategy_weight_caps"));
    sql.exec(doTableSql("mas_strategy_gates"));
  }

  getCap(strategy: string): number | null {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT cap FROM mas_strategy_weight_caps WHERE strategy = ?`, strategy)
    ) as any[];
    return rows.length > 0 ? rows[0].cap : null;
  }

  getCaps(): Record<string, number> {
    this.ensureTables();
    const rows = Array.from(this.sql.exec(`SELECT strategy, cap FROM mas_strategy_weight_caps`)) as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.strategy] = r.cap;
    return out;
  }

  setCap(strategy: string, cap: number | null, now: Date = new Date()): void {
    this.ensureTables();
    if (cap === null) {
      this.sql.exec(`DELETE FROM mas_strategy_weight_caps WHERE strategy = ?`, strategy);
      return;
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO mas_strategy_weight_caps (strategy, cap, updated_at) VALUES (?, ?, ?)`,
      strategy,
      cap,
      now.toISOString()
    );
  }

  isGatedOff(strategy: string): boolean {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT gated_off FROM mas_strategy_gates WHERE strategy = ?`, strategy)
    ) as any[];
    return rows.length > 0 && (rows[0].gated_off === 1 || rows[0].gated_off === true);
  }

  hasGateRow(strategy: string): boolean {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT gated_off FROM mas_strategy_gates WHERE strategy = ?`, strategy)
    ) as any[];
    return rows.length > 0;
  }

  getGates(): Record<string, boolean> {
    this.ensureTables();
    const rows = Array.from(this.sql.exec(`SELECT strategy, gated_off FROM mas_strategy_gates`)) as any[];
    const out: Record<string, boolean> = {};
    for (const r of rows) out[r.strategy] = r.gated_off === 1 || r.gated_off === true;
    return out;
  }

  setGate(strategy: string, gatedOff: boolean | null, now: Date = new Date()): void {
    this.ensureTables();
    if (gatedOff === null) {
      this.sql.exec(`DELETE FROM mas_strategy_gates WHERE strategy = ?`, strategy);
      return;
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO mas_strategy_gates (strategy, gated_off, updated_at) VALUES (?, ?, ?)`,
      strategy,
      gatedOff ? 1 : 0,
      now.toISOString()
    );
  }
}
