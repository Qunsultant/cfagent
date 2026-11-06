/**
 * DO-SQLite-backed test fixtures (issue #2860, Factor 10 Dev/Prod
 * Parity).
 *
 * The G6/G8 claims stores (delivery suppression, stage claims)
 * were tested only against the SQL-shaped MockSqlStorage
 * (tests/mock-sql.ts) — a hand-rolled SQL interpreter, not SQLite.
 * These fixtures run the stores' exact SQL against real SQLite
 * (node:sqlite, the slice0 pattern from tests/asyncJobGate.test.ts):
 * the same SQLite engine the Durable Object's ctx.storage.sql runs
 * in production, reached through the same SqlStorage exec shape the
 * production adapters use. A test that passes here proves the
 * store's SQL is real-SQLite SQL — a MockSqlStorage pass cannot
 * prove that (the mock accepts SQL real SQLite would reject, and
 * vice versa).
 *
 * Two shapes:
 *  - makeDoSqliteStorage(): fresh in-memory database. Cheap; the
 *    default for store-behavior tests.
 *  - makeDoSqliteFileStorage(): file-backed database with reopen().
 *    Proves the durability property the claims exist for — a claim
 *    survives an instance eviction (close + reopen on the same file
 *    is the test's stand-in for a DO instance recycle). Callers own
 *    cleanup via close() + remove(); each file lives in its own
 *    mkdtemp dir so parallel workers never share a path.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqlStorage } from "../src/orm";

/** Eager SqlStorage adapter over node:sqlite (DDL runs at exec time). */
export function sqliteStorage(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|EXPLAIN|PRAGMA|WITH)\b/i.test(query)) {
        return stmt.all(...(args as any[])) as unknown[];
      }
      stmt.run(...(args as any[]));
      return [];
    },
  };
}

export interface DoSqliteStorage {
  db: DatabaseSync;
  sql: SqlStorage;
  close(): void;
}

/** A fresh in-memory DO-SQLite-backed SqlStorage. */
export function makeDoSqliteStorage(): DoSqliteStorage {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    sql: sqliteStorage(db),
    close() {
      db.close();
    },
  };
}

export interface DoSqliteFileStorage extends DoSqliteStorage {
  /** Absolute path of the backing file (for assertions/debugging). */
  path: string;
  /**
   * Close the current connection and reopen the same file, returning
   * a fresh SqlStorage over the reopened database — the instance-
   * eviction stand-in. The old `sql` must not be used after reopen.
   */
  reopen(): SqlStorage;
  /** Close the connection and delete the backing file + temp dir. */
  remove(): void;
}

/** A file-backed DO-SQLite-backed SqlStorage, with reopen() for durability tests. */
export function makeDoSqliteFileStorage(): DoSqliteFileStorage {
  const dir = mkdtempSync(join(tmpdir(), "cfagent-do-sqlite-"));
  const path = join(dir, "test.db");
  let db = new DatabaseSync(path);
  let sql = sqliteStorage(db);
  const storage: DoSqliteFileStorage = {
    path,
    get db() {
      return db;
    },
    get sql() {
      return sql;
    },
    close() {
      db.close();
    },
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      sql = sqliteStorage(db);
      return sql;
    },
    remove() {
      try {
        db.close();
      } catch {
        // Already closed — the file still needs deleting.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return storage;
}
