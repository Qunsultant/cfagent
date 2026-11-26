/**
 * Issue #3121 Phase 2 (#3123, reuse) — composition root for the
 * unified schedule store. This is the ONLY module that maps a DO
 * storage handle to the store implementations: domain code imports
 * this helper and the port types, never a store client.
 *
 * Issue #6503 — the live store is D1 ONLY (owner direction
 * 2026-11-25, FAIL CLOSED tap): `createD1UnifiedSchedulePorts`
 * builds the D1 adapter from a bound AGENT_DB and THROWS when the
 * binding is absent. There is no DO fallback, ever — an unbound
 * host refuses the schedule control plane rather than silently
 * reading/writing a DO table. Deploy must bind AGENT_DB on both DO
 * hosts. The DO factory below is retained but unused after the
 * cutover (no file deletion, gate i): no live call site may use it;
 * the DO tables are never read or written, no rows are copied —
 * D1 starts empty (NO-COPY owner direction 2026-11-25).
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import type { SqlStorage } from "../orm";
import { DoSqliteUnifiedScheduleStore, SqlUnifiedScheduleStore } from "./doSqliteUnifiedScheduleAdapter";
import {
  createD1UnifiedScheduleDb,
  D1UnifiedScheduleAdapter,
} from "./d1UnifiedScheduleAdapter";
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

export interface D1UnifiedSchedulePorts {
  /** The async port adapter over D1 — the live store. */
  unifiedSchedules: ScheduleStore;
}

export interface D1UnifiedSchedulePortInputs {
  /**
   * The bound D1 database (env.AGENT_DB). REQUIRED — a missing
   * binding is a fail-closed error, not a DO fallback (owner
   * decision 2026-11-25, issue #6503).
   */
  d1: D1Database | undefined | null;
}

/**
 * Build the D1 schedule ports from a bound AGENT_DB — the one seam
 * for the AGENT_DB-unbound behavior. It lands fail-closed: an
 * unbound host throws here, at construction, so the schedule
 * control plane refuses instead of silently operating on a DO
 * table that no longer exists as a live store.
 */
export function createD1UnifiedSchedulePorts(
  inputs: D1UnifiedSchedulePortInputs,
): D1UnifiedSchedulePorts {
  if (!inputs.d1) {
    throw new Error(
      "Schedule store unavailable: AGENT_DB is not bound on this host. " +
        "The unified schedule store lives in D1 only (#6503, fail-closed); " +
        "there is no Durable Object fallback — bind AGENT_DB on both DO hosts.",
    );
  }
  return {
    unifiedSchedules: new D1UnifiedScheduleAdapter(
      createD1UnifiedScheduleDb(inputs.d1),
    ),
  };
}
