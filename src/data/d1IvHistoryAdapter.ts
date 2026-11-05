/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — the D1
 * implementation of the IV-history port: Drizzle over
 * `agent_iv_history` (migration 0020).
 *
 * CUTOVER EXECUTED (issue #2337, R-2): this adapter IS the
 * production IV-history store whenever AGENT_DB is bound —
 * the composition root selects it by default, and
 * IV_HISTORY_D1_ENABLED === "false" is the rollback lever
 * back to the DO adapter. Per the owner ruling recorded on
 * the issue, the cutover is a warming-up restart: this store
 * started EMPTY, there is no backfill, and the series
 * collected per DO instance were abandoned (a scoped
 * exception to the 2026-10-13 365-day retention decision,
 * this store only). Until the collector re-warms the series,
 * reads report the honest warming-up state (observations 0,
 * warmingUp true, latest null) — never the abandoned DO data.
 *
 * Semantics identical to the DO adapter (the port's contract):
 *  - record() is first-write-wins per (symbol, date) and
 *    REPORTS the outcome: true when the row was written, false
 *    when the day already had its record. A pre-check read
 *    makes the outcome reportable; the (symbol, date) primary
 *    key + ON CONFLICT DO NOTHING keeps the guarantee even if
 *    a writer races the check. One statement unit per record,
 *    never batched (step-2 audit §4): a provider-failed day is
 *    an absent observation, never a rolled-back batch.
 *  - Symbols are normalized (trim + upper-case) on every path.
 *  - listSeries is newest-first; coverage reports the count
 *    and the MIN/MAX date span; listSymbols ascending.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { agentIvHistory } from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import {
  normalizeIvBroker,
  type IvBroker,
  type IvHistoryCoverage,
  type IvHistoryRecord,
  type IvHistoryStore,
} from "./ivHistoryPorts";

/** Drizzle D1 database object carrying the IV-history schema. */
export type IvHistoryDb = DrizzleD1Database<{
  agentIvHistory: typeof agentIvHistory;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1IvHistoryDb(d1: D1Database): IvHistoryDb {
  return drizzle(d1, { schema: { agentIvHistory } });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureIvHistorySchema(
  db: IvHistoryDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

type IvRow = typeof agentIvHistory.$inferSelect;

function rowToRecord(row: IvRow): IvHistoryRecord {
  return {
    symbol: row.symbol,
    date: row.date,
    // A pre-#3326 row has no broker; it was collected from E*TRADE chains.
    broker: normalizeIvBroker((row as { broker?: string | null }).broker),
    atmIv: row.atmIv,
    spot: row.spot,
    expiryDate: row.expiryDate,
    dte: row.dte,
    collectedAt: row.collectedAt,
  };
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** The D1 implementation of the IV-history port. */
export class D1IvHistoryStore implements IvHistoryStore {
  constructor(readonly db: IvHistoryDb) {}

  async record(record: IvHistoryRecord): Promise<boolean> {
    const symbol = normalizeSymbol(record.symbol);
    // First write wins per (symbol, date), whichever broker produced it: the
    // day has one observation, and a second broker must not rewrite provenance.
    if (await this.get(symbol, record.date)) return false;
    await this.db
      .insert(agentIvHistory)
      .values({
        symbol,
        date: record.date,
        atmIv: record.atmIv,
        spot: record.spot,
        expiryDate: record.expiryDate,
        dte: record.dte,
        collectedAt: record.collectedAt,
        broker: normalizeIvBroker(record.broker),
      })
      .onConflictDoNothing();
    return true;
  }

  async get(symbol: string, date: string, broker?: IvBroker): Promise<IvHistoryRecord | null> {
    const symbolMatch = eq(agentIvHistory.symbol, normalizeSymbol(symbol));
    const rows = await this.db
      .select()
      .from(agentIvHistory)
      .where(
        broker
          ? and(symbolMatch, eq(agentIvHistory.date, date), eq(agentIvHistory.broker, normalizeIvBroker(broker)))
          : and(symbolMatch, eq(agentIvHistory.date, date)),
      )
      .limit(1);
    return rows.length ? rowToRecord(rows[0]) : null;
  }

  async listSeries(
    symbol: string,
    options: { limit?: number; broker?: IvBroker } = {},
  ): Promise<IvHistoryRecord[]> {
    const symbolMatch = eq(agentIvHistory.symbol, normalizeSymbol(symbol));
    const query = this.db
      .select()
      .from(agentIvHistory)
      .where(
        options.broker
          ? and(symbolMatch, eq(agentIvHistory.broker, normalizeIvBroker(options.broker)))
          : symbolMatch,
      )
      .orderBy(desc(agentIvHistory.date));
    const rows = options.limit !== undefined ? await query.limit(options.limit) : await query;
    return rows.map(rowToRecord);
  }

  async coverage(symbol: string, broker?: IvBroker): Promise<IvHistoryCoverage> {
    const symbolMatch = eq(agentIvHistory.symbol, normalizeSymbol(symbol));
    const [row] = await this.db
      .select({
        count: sql<number>`COUNT(*)`,
        firstDate: sql<string | null>`MIN(${agentIvHistory.date})`,
        lastDate: sql<string | null>`MAX(${agentIvHistory.date})`,
      })
      .from(agentIvHistory)
      .where(
        broker ? and(symbolMatch, eq(agentIvHistory.broker, normalizeIvBroker(broker))) : symbolMatch,
      );
    return {
      observations: Number(row?.count ?? 0),
      firstDate: row?.firstDate ?? null,
      lastDate: row?.lastDate ?? null,
    };
  }

  async listSymbols(options: { broker?: IvBroker } = {}): Promise<string[]> {
    const query = this.db.selectDistinct({ symbol: agentIvHistory.symbol }).from(agentIvHistory);
    const rows = await (options.broker
      ? query.where(eq(agentIvHistory.broker, normalizeIvBroker(options.broker)))
      : query
    ).orderBy(asc(agentIvHistory.symbol));
    return rows.map((r) => r.symbol);
  }
}
