/**
 * Issue #3391 (parent #3380) — composition root for the Stock
 * Copilot store family (positions; #3422 adds activity + control).
 * This is the ONLY module that
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
import {
  DoSqliteStockCopilotActivityStore,
  DoSqliteStockCopilotControlStore,
} from "./doSqliteStockCopilotSurfaceAdapter";
import { InMemoryStockCopilotPositionStore } from "./inMemoryStockCopilotStoreAdapter";
import {
  InMemoryStockCopilotActivityStore,
  InMemoryStockCopilotControlStore,
} from "./inMemoryStockCopilotSurfaceAdapter";
import type {
  StockCopilotActivityPort,
  StockCopilotControlPort,
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

/** #3422: compose the cycle-activity port over a host's DO storage. */
export function createStockCopilotActivityPort(
  sql: StockCopilotStoreSqlExecutor
): StockCopilotActivityPort {
  return new DoSqliteStockCopilotActivityStore(sql);
}

/** #3422: compose the activity port over the in-memory adapter (tests). */
export function createInMemoryStockCopilotActivityPort(): StockCopilotActivityPort {
  return new InMemoryStockCopilotActivityStore();
}

/** #3422: compose the pause-control port over a host's DO storage. */
export function createStockCopilotControlPort(
  sql: StockCopilotStoreSqlExecutor
): StockCopilotControlPort {
  return new DoSqliteStockCopilotControlStore(sql);
}

/** #3422: compose the control port over the in-memory adapter (tests). */
export function createInMemoryStockCopilotControlPort(): StockCopilotControlPort {
  return new InMemoryStockCopilotControlStore();
}
