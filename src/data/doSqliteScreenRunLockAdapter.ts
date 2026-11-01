/**
 * Issue #2361 (#1976 step 4e) — the DO-SQLite implementation
 * of the screener's run-lock port: the statements from
 * src/services/screenRunLock.ts, moved into the data layer
 * statement-for-statement, plus the table's DDL (its ONE home
 * now). The lock's #1993 design note (why instance-local,
 * why synchronous) lives on the port in screenRunLockPorts.ts.
 */
import type { SchemaMigrationMode } from "../config/schemaMigrationModes";
import { applyDoSchemaMigrations } from "./doSchemaMigrations";
import type { DoSchemaMigration } from "../ports/schemaMigration";
import {
  SCREEN_RUN_LOCK_STALE_MS,
  type ScreenRunLockAcquisition,
  type ScreenRunLockPort,
  type ScreenRunLockSqlExecutor,
} from "./screenRunLockPorts";

type Row = Record<string, unknown>;

/**
 * The lock table's DDL, its ONE home: both the legacy
 * ensureSchema branch and the managed migration below run this
 * exact statement, so the two modes can never drift apart.
 */
const SCREEN_RUN_LOCK_TABLE_DDL = `CREATE TABLE IF NOT EXISTS screen_run_locks (
      user_login TEXT NOT NULL,
      universe TEXT NOT NULL,
      token TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (user_login, universe)
    )`;

/**
 * #1767 (parent #1717): the screen-run-lock store's first
 * framework migration. v1 is the table exactly as the legacy
 * path creates it — IF NOT EXISTS, so an instance whose table
 * was created by the legacy path converges on first managed
 * ensure (ledger row recorded, no DDL error, no data loss).
 * A future lock-schema change rides as v2, never as an edit
 * to this migration's `up` (applied instances never re-run v1).
 */
export const SCREEN_RUN_LOCK_SCHEMA_MIGRATION: DoSchemaMigration = {
  version: 1,
  name: "0001_screen_run_locks",
  up: [SCREEN_RUN_LOCK_TABLE_DDL],
  down: ["DROP TABLE IF EXISTS screen_run_locks"],
};

/** Options for the #1767 framework wiring; unset = legacy. */
export interface DoSqliteScreenRunLockOptions {
  schemaMigrationMode?: SchemaMigrationMode;
}

export class DoSqliteScreenRunLock implements ScreenRunLockPort {
  constructor(
    private readonly sql: ScreenRunLockSqlExecutor,
    private readonly options: DoSqliteScreenRunLockOptions = {},
  ) {}

  ensureSchema(): void {
    if (this.options.schemaMigrationMode === "managed") {
      applyDoSchemaMigrations(this.sql, "screen_run_locks", [
        SCREEN_RUN_LOCK_SCHEMA_MIGRATION,
      ]);
      return;
    }
    this.sql.exec(SCREEN_RUN_LOCK_TABLE_DDL);
  }

  acquire(
    userLogin: string,
    universe: string,
    now: number = Date.now()
  ): ScreenRunLockAcquisition {
    this.ensureSchema();
    const token = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO screen_run_locks (user_login, universe, token, started_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_login, universe) DO NOTHING`,
      userLogin,
      universe,
      token,
      now
    );
    let rows = Array.from(
      this.sql.exec(
        `SELECT token, started_at FROM screen_run_locks
     WHERE user_login = ? AND universe = ?`,
        userLogin,
        universe
      )
    ) as Row[];
    if (rows[0]?.token === token) {
      return { acquired: true, token, startedAt: now, tookOverStale: false };
    }
    const startedAt = Number(rows[0]?.started_at);
    if (Number.isFinite(startedAt) && now - startedAt > SCREEN_RUN_LOCK_STALE_MS) {
      // Compare-and-swap on the observed started_at: a competing
      // takeover winner changes the row first, and this update then
      // affects zero rows, so only one contender ever wins.
      this.sql.exec(
        `UPDATE screen_run_locks SET token = ?, started_at = ?
       WHERE user_login = ? AND universe = ? AND started_at = ?`,
        token,
        now,
        userLogin,
        universe,
        startedAt
      );
      rows = Array.from(
        this.sql.exec(
          `SELECT token FROM screen_run_locks
       WHERE user_login = ? AND universe = ?`,
          userLogin,
          universe
        )
      ) as Row[];
      if (rows[0]?.token === token) {
        return { acquired: true, token, startedAt: now, tookOverStale: true };
      }
    }
    return {
      acquired: false,
      token: null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      tookOverStale: false,
    };
  }

  release(userLogin: string, universe: string, token: string | null): void {
    if (!token) return;
    this.sql.exec(
      `DELETE FROM screen_run_locks
     WHERE user_login = ? AND universe = ? AND token = ?`,
      userLogin,
      universe,
      token
    );
  }

  isRunning(
    userLogin: string,
    universe: string,
    now: number = Date.now()
  ): { running: boolean; startedAt: number | null } {
    this.ensureSchema();
    const rows = Array.from(
      this.sql.exec(
        `SELECT started_at FROM screen_run_locks
     WHERE user_login = ? AND universe = ?`,
        userLogin,
        universe
      )
    ) as Row[];
    if (!rows[0]) return { running: false, startedAt: null };
    const startedAt = Number(rows[0].started_at);
    if (Number.isFinite(startedAt) && now - startedAt <= SCREEN_RUN_LOCK_STALE_MS) {
      return { running: true, startedAt };
    }
    return { running: false, startedAt };
  }
}
