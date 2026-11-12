/**
 * Issue #3121 Phase 2 (#3123, reuse) — composition root for the
 * unified schedule store. This is the ONLY module that maps a DO
 * storage handle to the store implementations: domain code imports
 * this helper and the port types, never a store client.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import type { SqlStorage } from "../orm";
import { DoSqliteUnifiedScheduleStore, SqlUnifiedScheduleStore } from "./doSqliteUnifiedScheduleAdapter";
import type { ScheduleStore, SyncScheduleStore } from "./unifiedSchedulePorts";

export interface UnifiedSchedulePorts {
  /** The async port adapter (ScheduledAgent + async call sites). */
  unifiedSchedules: ScheduleStore;
  /** The synchronous surface (the orchestrator routes, sync over DO SQLite). */
  unifiedSchedulesSync: SyncScheduleStore;
}

export interface UnifiedSchedulePortInputs {
  /** The DO sql executor (ctx.storage.sql-shaped). */
  sql: SqlStorage;
  /** The transaction-capable storage object (ctx.storage) when the
   *  host supplies it — enables the withTransaction wrap on save. */
  storage?: DoTransactionStorage;
}

export function createUnifiedSchedulePorts(
  inputs: UnifiedSchedulePortInputs,
): UnifiedSchedulePorts {
  const { sql } = inputs;
  const storage = inputs.storage as DoTransactionStorage | undefined;
  return {
    unifiedSchedules: new DoSqliteUnifiedScheduleStore(sql, storage),
    unifiedSchedulesSync: new SqlUnifiedScheduleStore(sql),
  };
}
