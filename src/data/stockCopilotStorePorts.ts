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
 * This module carries types + the interfaces ONLY. Adapters:
 * doSqliteStockCopilotStoreAdapter.ts +
 * doSqliteStockCopilotSurfaceAdapter.ts (production),
 * inMemoryStockCopilotStoreAdapter.ts +
 * inMemoryStockCopilotSurfaceAdapter.ts (test doubles).
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
  /** #3422: one login's recently closed positions, newest close
   *  first, bounded by limit — the chat-tab surface's history
   *  read. Rows already persist via close-as-update; this is
   *  the read the #3391 slice never needed. */
  listClosedPositions(
    userLogin: string,
    limit: number
  ): CopilotPositionRecord[];
}

// ---------------------------------------------------------------------------
// Issue #3422 — the chat-tab surface family: cycle activity log +
// per-instance pause control. Same residency (the hosting DO's
// SQLite), same construction discipline (consumers ensureSchema
// before use, exactly as the position facade does). Display-grade
// operational state for the copilot panel — NOT the #3397
// measurement ledger.
// ---------------------------------------------------------------------------

export const COPILOT_ACTIVITY_TABLE = "stock_copilot_activity";
export const COPILOT_CONTROL_TABLE = "stock_copilot_control";

/** Retention bound for the activity log: the newest ~100 cycles
 *  per login are kept; appends prune the rest. */
export const COPILOT_ACTIVITY_RETENTION = 100;

/** One exit inside a cycle activity record. */
export interface CopilotActivityExit {
  symbol: string;
  reason: string;
}

/**
 * One recorded cycle: a firing that actually evaluated the market
 * (or was refused by the paper guard before it could). Paused and
 * outside-hours firings are NOT recorded — they evaluated nothing.
 */
export interface CopilotCycleActivityRecord {
  id: string;
  userLogin: string;
  /** ISO timestamp of the cycle. */
  cycleAt: string;
  /** traded = at least one entry or exit landed; no_trade = the
   *  cycle evaluated and deliberately placed nothing (detail says
   *  why); refused = the paper guard refused the cycle (detail
   *  names the refusal). */
  outcome: "traded" | "no_trade" | "refused";
  /** Symbols entered this cycle. */
  entries: string[];
  /** Exits placed this cycle, each with its exit reason. */
  exits: CopilotActivityExit[];
  /** The no-trade reason summary, or the guard's refusal code;
   *  null for traded cycles. */
  detail: string | null;
}

export interface StockCopilotActivityPort {
  /** The table's DDL. Idempotent; consumers call it before use. */
  ensureSchema(): void;
  /** Append one cycle record and prune the login's log to the
   *  newest COPILOT_ACTIVITY_RETENTION records. */
  appendActivity(record: CopilotCycleActivityRecord): void;
  /** One login's recent cycle records, newest first. */
  listActivity(
    userLogin: string,
    limit: number
  ): CopilotCycleActivityRecord[];
}

/** The per-instance pause control: one row per login. */
export interface CopilotControlRecord {
  userLogin: string;
  /** Paused ⇒ the cycle still manages exits but places no entries. */
  paused: boolean;
  updatedAt: string;
  /** The login that made the change (the instance's own login). */
  updatedBy: string;
}

export interface StockCopilotControlPort {
  /** The table's DDL. Idempotent; consumers call it before use. */
  ensureSchema(): void;
  /** The login's control record, or null when never set (the
   *  default state: not paused). */
  getControl(userLogin: string): CopilotControlRecord | null;
  /** Upsert the login's control record. */
  setControl(record: CopilotControlRecord): void;
}
