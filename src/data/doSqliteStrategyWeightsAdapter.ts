/**
 * Issue #2357 (#1976 step 4b) — the DO-SQLite implementation
 * of the strategy weights v2 port: the legacy store section
 * of src/services/strategyWeightsV2.ts, moved into the data
 * layer statement-for-statement. The service module keeps
 * the pure policy and delegates its store functions here.
 *
 * The mas_settings CREATE this adapter used to carry was one
 * of the three measured DDL ensurers for that table (G-7
 * remainder). Step 4g (#2390) retired it: the dedicated
 * settings port's adapter (doSqliteOrmAdapters.ts) is the
 * table's single ensurer now, composed alongside this store
 * in createStrategyClusterPorts. No settings VALUE is read or
 * written by this adapter.
 */
import {
  weightsV2Key,
  type StrategyWeightsSqlExecutor,
  type StrategyWeightsStore,
  type WeightVersionRecord,
  type WeightVersionWrite,
} from "./strategyWeightsPorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

export class DoSqliteStrategyWeightsStore implements StrategyWeightsStore {
  constructor(private readonly sql: StrategyWeightsSqlExecutor) {}

  ensureTables(): void {
    const sql = this.sql;
    sql.exec(doTableSql("mas_strategy_weights_v2"));
    sql.exec(doTableSql("mas_strategy_weight_versions"));
  }

  currentVersion(): number {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT version FROM mas_strategy_weight_versions`)
    ) as any[];
    return rows.reduce((m, r) => Math.max(m, Number(r.version) || 0), 0);
  }

  listVersionRecords(limit = 200): WeightVersionRecord[] {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(
        `SELECT * FROM mas_strategy_weight_versions ORDER BY version ASC LIMIT ?`,
        limit
      )
    ) as any[];
    return rows.map((r) => ({
      version: Number(r.version),
      strategy: String(r.strategy),
      regime: String(r.regime),
      before: r.before_weight === null || r.before_weight === undefined ? null : Number(r.before_weight),
      after: Number(r.after_weight),
      signal: r.signal === null || r.signal === undefined ? null : Number(r.signal),
      evaluated: Number(r.evaluated) || 0,
      winRateAfterCost:
        r.win_rate_after_cost === null || r.win_rate_after_cost === undefined
          ? null
          : Number(r.win_rate_after_cost),
      avgRAfterCost:
        r.avg_r_after_cost === null || r.avg_r_after_cost === undefined
          ? null
          : Number(r.avg_r_after_cost),
      actor: String(r.actor),
      rationale: String(r.rationale),
      createdAt: String(r.created_at),
    }));
  }

  getWeights(): Record<string, number> {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT strategy, regime, weight FROM mas_strategy_weights_v2`)
    ) as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[weightsV2Key(String(r.strategy), String(r.regime))] = Number(r.weight);
    return out;
  }

  getWeightsForRegime(regime: string): Record<string, number> {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT strategy, weight FROM mas_strategy_weights_v2 WHERE regime = ?`, regime)
    ) as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.strategy)] = Number(r.weight);
    return out;
  }

  getWeightsCollapsed(): Record<string, number> {
    this.ensureTables();
    const rows = Array.from(
      this.sql.exec(`SELECT strategy, weight FROM mas_strategy_weights_v2`)
    ) as any[];
    const sums = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const key = String(r.strategy);
      const acc = sums.get(key) ?? { total: 0, count: 0 };
      acc.total += Number(r.weight);
      acc.count += 1;
      sums.set(key, acc);
    }
    const out: Record<string, number> = {};
    for (const [key, acc] of sums) out[key] = acc.total / acc.count;
    return out;
  }

  weightRowExists(strategy: string, regime: string): boolean {
    const rows = Array.from(
      this.sql.exec(
        `SELECT weight FROM mas_strategy_weights_v2 WHERE strategy = ? AND regime = ?`,
        strategy,
        regime
      )
    ) as any[];
    return rows.length > 0;
  }

  writeWeightRow(
    strategy: string,
    regime: string,
    weight: number | null,
    version: number,
    now: Date
  ): void {
    // DELETE+INSERT idiom (MockSqlStorage parity, as in the legacy module).
    this.sql.exec(
      `DELETE FROM mas_strategy_weights_v2 WHERE strategy = ? AND regime = ?`,
      strategy,
      regime
    );
    if (weight !== null) {
      this.sql.exec(
        `INSERT INTO mas_strategy_weights_v2 (strategy, regime, weight, version, updated_at) VALUES (?, ?, ?, ?, ?)`,
        strategy,
        regime,
        weight,
        version,
        now.toISOString()
      );
    }
  }

  writeVersionRecord(rec: WeightVersionWrite, now: Date): void {
    this.sql.exec(
      `INSERT INTO mas_strategy_weight_versions (id, version, strategy, regime, before_weight, after_weight, signal, evaluated, win_rate_after_cost, avg_r_after_cost, actor, rationale, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `wv-${rec.version}-${rec.strategy}-${rec.regime}`,
      rec.version,
      rec.strategy,
      rec.regime,
      rec.before,
      rec.after,
      rec.signal,
      rec.evaluated,
      rec.winRateAfterCost,
      rec.avgRAfterCost,
      rec.actor,
      rec.rationale,
      now.toISOString()
    );
  }
}
