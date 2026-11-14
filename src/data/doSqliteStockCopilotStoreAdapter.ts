/**
 * Issue #3391 (parent #3380) — the DO-SQLite implementation of
 * the Stock Copilot position-store port: every
 * `stock_copilot_positions` statement of the legacy
 * src/services/stockCopilotStore.ts, moved into the data layer
 * statement-for-statement. The service module keeps the record
 * construction and the async API; this store holds the SQL,
 * including the table's DDL (its one home now).
 */
import {
  COPILOT_POSITIONS_TABLE,
  type CloseCopilotPositionPatch,
  type CopilotPositionRecord,
  type StockCopilotPositionPort,
  type StockCopilotStoreSqlExecutor,
} from "./stockCopilotStorePorts";
import { doTableSql } from "./schemaComponent/doCatalogue";

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
    entrySession: strOrNull(row.entry_session),
    entryOrderType: strOrNull(row.entry_order_type),
    status: str(row.status) === "closed" ? "closed" : "open",
    openedAt: str(row.opened_at),
    closedAt: strOrNull(row.closed_at),
    exitBrokerOrderRef: strOrNull(row.exit_broker_order_ref),
    exitPrice: numOrNull(row.exit_price),
    exitReason: strOrNull(row.exit_reason),
  };
}

export class DoSqliteStockCopilotPositionStore
  implements StockCopilotPositionPort
{
  constructor(private readonly sql: StockCopilotStoreSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(
      doTableSql("stock_copilot_positions"),
    );
    // #3398: tables created before session recording gain the
    // columns in place (the data layer's PRAGMA/ALTER idiom).
    const cols = Array.from(
      this.sql.exec(`PRAGMA table_info(${COPILOT_POSITIONS_TABLE})`),
    ) as Array<{ name?: unknown }>;
    const names = new Set(cols.map((c) => String(c.name ?? "")));
    if (!names.has("entry_session")) {
      this.sql.exec(`ALTER TABLE ${COPILOT_POSITIONS_TABLE} ADD COLUMN entry_session TEXT`);
    }
    if (!names.has("entry_order_type")) {
      this.sql.exec(`ALTER TABLE ${COPILOT_POSITIONS_TABLE} ADD COLUMN entry_order_type TEXT`);
    }
  }

  insertPosition(record: CopilotPositionRecord): void {
    this.sql.exec(
      `INSERT INTO ${COPILOT_POSITIONS_TABLE} (id, user_login, symbol, strategy, quantity, entry_price, stop_price, target_price, broker_order_ref, status, opened_at, closed_at, exit_broker_order_ref, exit_price, exit_reason, entry_session, entry_order_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      record.entrySession ?? null,
      record.entryOrderType ?? null,
    );
  }

  listOpenPositions(userLogin: string): CopilotPositionRecord[] {
    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${COPILOT_POSITIONS_TABLE} WHERE user_login = ? AND status = 'open' ORDER BY opened_at ASC`,
        userLogin,
      ),
    ] as Array<Record<string, unknown>>;
    return rows.map(mapPosition);
  }

  closePosition(id: string, patch: CloseCopilotPositionPatch): void {
    this.sql.exec(
      `UPDATE ${COPILOT_POSITIONS_TABLE} SET status = ?, exit_broker_order_ref = ?, exit_price = ?, exit_reason = ?, closed_at = ? WHERE id = ?`,
      "closed",
      patch.exitBrokerOrderRef,
      patch.exitPrice,
      patch.exitReason,
      patch.closedAt,
      id,
    );
  }

  listClosedPositions(
    userLogin: string,
    limit: number,
  ): CopilotPositionRecord[] {
    const rows = [
      ...this.sql.exec(
        `SELECT * FROM ${COPILOT_POSITIONS_TABLE} WHERE user_login = ? AND status = 'closed' ORDER BY closed_at DESC, rowid DESC LIMIT ?`,
        userLogin,
        limit,
      ),
    ] as Array<Record<string, unknown>>;
    return rows.map(mapPosition);
  }
}
