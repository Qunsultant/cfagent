/**
 * Issue #3391 (parent #3380) — the Stock Copilot position-store
 * port: the copilot loop's operational state (its open positions,
 * each WITH the exit plan it was opened under) behind the data
 * layer, following the canonical-report store family
 * (canonicalReportStorePorts.ts).
 *
 * The statements originally sat in src/services/
 * stockCopilotStore.ts, above the layer; the global D-D census
 * (#2356) counts storage-shaped sites above src/data/ against a
 * shrink-only allow-list, so the SQL lives in the adapters now
 * and the service module keeps only the record construction
 * (ids, timestamps, defaults) and the store's async API.
 *
 * Residency: the hosting Durable Object's SQLite — one table,
 * `stock_copilot_positions`, in whichever orchestrator instance
 * runs the login's copilot task. Scope: operational state for
 * the loop's own position management, NOT a decision history —
 * durable persistence of cycle decisions for performance
 * measurement is MVP2 (issue #3397).
 *
 * This module carries types + the interface ONLY. Adapters:
 * doSqliteStockCopilotStoreAdapter.ts (production),
 * inMemoryStockCopilotStoreAdapter.ts (test doubles).
 * Composition root: createStockCopilotStorePorts.ts.
 */
import type { SqlStorage } from "./repositoryPorts";

export type StockCopilotStoreSqlExecutor = SqlStorage;

export const COPILOT_POSITIONS_TABLE = "stock_copilot_positions";

/** One tracked copilot position, with its exit plan. */
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

/** The close write's fields, fully resolved by the caller (the
 *  service facade owns the closedAt default). */
export interface CloseCopilotPositionPatch {
  exitBrokerOrderRef: string;
  exitPrice: number;
  exitReason: string;
  closedAt: string;
}

export interface StockCopilotPositionPort {
  /** The table's DDL. Idempotent; called before every operation
   *  by the service facade, exactly as the legacy store ensured
   *  it inline. */
  ensureSchema(): void;
  /** Insert one opened position (insert-or-throw on the id
   *  primary key). The exit plan columns are NOT NULL in the
   *  DDL — an entry without a paired exit plan is a defect
   *  (#3391 acceptance), and the row lands in the same step as
   *  the entry decision, immediately after the order is
   *  accepted. */
  insertPosition(record: CopilotPositionRecord): void;
  /** One login's open positions, oldest first. */
  listOpenPositions(userLogin: string): CopilotPositionRecord[];
  /** Close one position: status + exit order ref + exit
   *  decision price + exit reason + close timestamp. */
  closePosition(id: string, patch: CloseCopilotPositionPatch): void;
}
