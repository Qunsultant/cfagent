/**
 * Issue #2361 (#1976 step 4e) — composition root for the
 * screener's run-lock family. This is the ONLY module that
 * maps a host's storage handle to the family's production
 * implementation: the screener imports this helper and the
 * port type, never a store client. It replaces the agent's
 * hand-rolled lockSql() executor callback.
 *
 * The lock table lives in the screener instance's own storage;
 * construction executes NOTHING — the table's DDL runs only
 * through the port's ensureSchema (called by acquire and the
 * probe, exactly as the legacy functions ensured it).
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from screenRunLockPorts.ts (type-only, erased at
 * compile time), never this root.
 */
import {
  resolveSchemaMigrationModeFromEnv,
  schemaMigrationConfigErrorEvent,
  type SchemaMigrationMode,
} from "../config/schemaMigrationModes";
import {
  DoSqliteScreenRunLock,
  type DoSqliteScreenRunLockOptions,
} from "./doSqliteScreenRunLockAdapter";
import { InMemoryScreenRunLock } from "./inMemoryScreenRunLockAdapter";
import type {
  ScreenRunLockPort,
  ScreenRunLockSqlExecutor,
} from "./screenRunLockPorts";

/**
 * #1767 (parent #1717): composition options for the lock port.
 * Either pass a resolved mode directly, or pass the host's env
 * carrier and let the SCHEMA_MIGRATION_MODE resolver decide
 * (run/session/user carriers are not populated here — Worker
 * env is the production-settable level; unset = legacy, the
 * current behavior). An invalid env value fails closed to
 * legacy and is console-logged with the schema.config_error
 * event name: this sync composition root has no audit sink, so
 * the log line — not silence — is the misconfiguration signal.
 */
export interface CreateScreenRunLockPortOptions {
  env?: { SCHEMA_MIGRATION_MODE?: unknown };
  schemaMigrationMode?: SchemaMigrationMode;
}

/** Compose the lock port over a host's DO storage. */
export function createScreenRunLockPort(
  sql: ScreenRunLockSqlExecutor,
  options: CreateScreenRunLockPortOptions = {},
): ScreenRunLockPort {
  let mode: SchemaMigrationMode = options.schemaMigrationMode ?? "legacy";
  if (options.schemaMigrationMode === undefined && options.env !== undefined) {
    const resolved = resolveSchemaMigrationModeFromEnv(options.env);
    if (resolved.invalid) {
      console.warn(
        `${schemaMigrationConfigErrorEvent()}: unrecognized SCHEMA_MIGRATION_MODE ${JSON.stringify(resolved.raw)} — failing closed to legacy`,
      );
    }
    mode = resolved.mode;
  }
  const adapterOptions: DoSqliteScreenRunLockOptions = {
    schemaMigrationMode: mode,
  };
  return new DoSqliteScreenRunLock(sql, adapterOptions);
}

/** Compose the in-memory lock port (test doubles). */
export function createInMemoryScreenRunLockPort(): ScreenRunLockPort {
  return new InMemoryScreenRunLock();
}
