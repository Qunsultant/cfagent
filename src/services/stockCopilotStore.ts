/**
 * Stock Copilot position store (issue #3391) — the copilot's own
 * working state, in the hosting Durable Object's SQLite, following
 * the repo's SqlStorage store pattern (cf. the canonical report
 * store ports).
 *
 * One table: `stock_copilot_positions` — every position the copilot
 * opened, WITH the exit plan it was opened under (stop/target). An
 * entry without a paired exit plan is a defect (#3391 acceptance),
 * so the plan columns are NOT NULL and the row is written in the
 * same step as the entry decision, immediately after the order is
 * accepted. The cycle reads its open rows at the start of every pass
 * to evaluate exits; a row closes when its exit order is accepted.
 *
 * Scope note: this is operational state for the loop's own position
 * management — not a decision history. Durable persistence of cycle
 * decisions for performance measurement is MVP2 (issue #3397) and is
 * deliberately not built here.
 */

import type { SqlStorage } from "../orm";

export const COPILOT_POSITIONS_TABLE = "stock_copilot_positions";

export interface CopilotPositionRecord {
  id: string;
  userLogin: string;
  symbol: string;
  strategy: string;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  brokerOrderRef: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  exitBrokerOrderRef: string | null;
  /** Exit decision price (the close the exit evaluated at); the
   *  platform reports fills asynchronously, so this is not a
   *  confirmed fill. */
  exitPrice: number | null;
  exitReason: string | null;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

function mapPosition(row: Record<string, unknown>): CopilotPositionRecord {
  return {
    id: str(row.id),
    userLogin: str(row.user_login),
    symbol: str(row.symbol),
    strategy: str(row.strategy),
    quantity: num(row.quantity),
    entryPrice: num(row.entry_price),
    stopPrice: num(row.stop_price),
    targetPrice: num(row.target_price),
    brokerOrderRef: str(row.broker_order_ref),
    status: str(row.status) === "closed" ? "closed" : "open",
    openedAt: str(row.opened_at),
    closedAt: strOrNull(row.closed_at),
    exitBrokerOrderRef: strOrNull(row.exit_broker_order_ref),
    exitPrice: numOrNull(row.exit_price),
    exitReason: strOrNull(row.exit_reason),
  };
}

export class StockCopilotPositionStore {
  constructor(private readonly sql: SqlStorage) {}

  ensureTables(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${COPILOT_POSITIONS_TABLE} (
        id TEXT PRIMARY KEY,
        user_login TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        quantity REAL NOT NULL,
        entry_price REAL NOT NULL,
        stop_price REAL NOT NULL,
        target_price REAL NOT NULL,
        broker_order_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        exit_broker_order_ref TEXT,
        exit_price REAL,
        exit_reason TEXT
      )`,
    );
  }

  async openPosition(input: {
    userLogin: string;
    symbol: string;
    strategy: string;
    quantity: number;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    brokerOrderRef: string;
    openedAt?: string;
  }): Promise<CopilotPositionRecord> {
    this.ensureTables();
    const record: CopilotPositionRecord = {
      id: crypto.randomUUID(),
      userLogin: input.userLogin,
      symbol: input.symbol.toUpperCase(),
      strategy: input.strategy,
      quantity: input.quantity,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      targetPrice: input.targetPrice,
      brokerOrderRef: input.brokerOrderRef,
      status: "open",
      openedAt: input.openedAt ?? new Date().toISOString(),
      closedAt: null,
      exitBrokerOrderRef: null,
      exitPrice: null,
      exitReason: null,
    };
    this.sql.exec(
      `INSERT INTO ${COPILOT_POSITIONS_TABLE} (id, user_login, symbol, strategy, quantity, entry_price, stop_price, target_price, broker_order_ref, status, opened_at, closed_at, exit_broker_order_ref, exit_price, exit_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.userLogin,
      record.symbol,
      record.strategy,
      record.quantity,
      record.entryPrice,
      record.stopPrice,
      record.targetPrice,
      record.brokerOrderRef,
      record.status,
      record.openedAt,
      record.closedAt,
      record.exitBrokerOrderRef,
      record.exitPrice,
      record.exitReason,
    );
    return record;
  }

  async listOpenPositions(userLogin: string): Promise<CopilotPositionRecord[]> {
    this.ensureTables();
    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${COPILOT_POSITIONS_TABLE} WHERE user_login = ? AND status = 'open' ORDER BY opened_at ASC`,
        userLogin,
      ),
    ] as Array<Record<string, unknown>>;
    return rows.map(mapPosition);
  }

  async closePosition(
    id: string,
    patch: {
      exitBrokerOrderRef: string;
      exitPrice: number;
      exitReason: string;
      closedAt?: string;
    },
  ): Promise<void> {
    this.ensureTables();
    this.sql.exec(
      `UPDATE ${COPILOT_POSITIONS_TABLE} SET status = ?, exit_broker_order_ref = ?, exit_price = ?, exit_reason = ?, closed_at = ? WHERE id = ?`,
      "closed",
      patch.exitBrokerOrderRef,
      patch.exitPrice,
      patch.exitReason,
      patch.closedAt ?? new Date().toISOString(),
      id,
    );
  }
}
