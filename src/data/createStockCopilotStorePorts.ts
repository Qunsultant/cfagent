/**
 * Issue #3391 (parent #3380) — composition root for the Stock
 * Copilot position-store family. This is the ONLY module that
 * maps a host's storage handle to the family's production
 * implementation: domain code imports this helper and the port
 * type, never a store client.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from stockCopilotStorePorts.ts (type-only, erased at
 * compile time), never this root.
 */
import { DoSqliteStockCopilotPositionStore } from "./doSqliteStockCopilotStoreAdapter";
import { InMemoryStockCopilotPositionStore } from "./inMemoryStockCopilotStoreAdapter";
import type {
  StockCopilotPositionPort,
  StockCopilotStoreSqlExecutor,
} from "./stockCopilotStorePorts";

/** Compose the family's port over a host's DO storage. */
export function createStockCopilotPositionPort(
  sql: StockCopilotStoreSqlExecutor
): StockCopilotPositionPort {
  return new DoSqliteStockCopilotPositionStore(sql);
}

/** Compose the family's port over the in-memory adapter (tests). */
export function createInMemoryStockCopilotPositionPort(): StockCopilotPositionPort {
  return new InMemoryStockCopilotPositionStore();
}
