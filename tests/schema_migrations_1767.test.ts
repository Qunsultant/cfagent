// @vitest-environment node
/**
 * Issue #1767 (parent #1717, slice F-37/F-38): automated DO SQLite
 * schema-migration framework + ORM-managed DDL.
 *
 * TDD Red first: these tests fail before the implementation (missing
 * modules) and pin the framework contract afterwards:
 *  - versioned application, idempotent re-apply, marker-LAST ledger
 *    (a throwing migration is NOT recorded, so it retries);
 *  - rollback of the latest applied migration only, via its `down`;
 *  - drift detection (declared vs applied) per instance + aggregation
 *    across instances;
 *  - SCHEMA_MIGRATION_MODE resolution run > session > user > env >
 *    built-in legacy, invalid failing closed to legacy;
 *  - the screen-run-lock store wired through the framework in managed
 *    mode, byte-identical legacy behavior in legacy mode (default).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  resolveSchemaMigrationMode,
  SCHEMA_MIGRATION_MODE_SWITCH,
  schemaMigrationConfigErrorEvent,
} from "../src/config/schemaMigrationModes";
import {
  aggregateDoSchemaDrift,
  applyDoSchemaMigrations,
  checkDoSchemaDrift,
  listAppliedDoSchemaMigrations,
  rollbackDoSchemaMigration,
  type DoSchemaMigration,
  type DoSchemaMigrationSql,
} from "../src/data/doSchemaMigrations";
import {
  DoSqliteScreenRunLock,
  SCREEN_RUN_LOCK_SCHEMA_MIGRATION,
} from "../src/data/doSqliteScreenRunLockAdapter";
import { createScreenRunLockPort } from "../src/data/createScreenRunLockPorts";

function makeSql(): DoSchemaMigrationSql {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...params: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        return stmt.all(...(params as any[])) as Array<
          Record<string, unknown>
        >;
      }
      stmt.run(...(params as any[]));
      return [];
    },
  };
}

const V1: DoSchemaMigration = {
  version: 1,
  name: "0001_things",
  up: [
    "CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY, v TEXT NOT NULL)",
  ],
  down: ["DROP TABLE IF EXISTS things"],
};

const V2: DoSchemaMigration = {
  version: 2,
  name: "0002_things_flag",
  up: [
    "CREATE TABLE IF NOT EXISTS thing_flags (thing_id TEXT NOT NULL, flag TEXT NOT NULL)",
  ],
  down: ["DROP TABLE IF EXISTS thing_flags"],
};

describe("#1767 SCHEMA_MIGRATION_MODE resolution", () => {
  it("defaults to legacy (current behavior) when every level is blank", () => {
    const r = resolveSchemaMigrationMode({});
    expect(r.mode).toBe("legacy");
    expect(r.invalid).toBe(false);
    expect(r.level).toBe("builtin");
  });

  it("resolves run > session > user > env, case-insensitive, trimmed", () => {
    expect(
      resolveSchemaMigrationMode({ env: "managed" }).mode,
    ).toBe("managed");
    expect(
      resolveSchemaMigrationMode({ env: "  MANAGED " }).mode,
    ).toBe("managed");
    expect(
      resolveSchemaMigrationMode({ user: "managed", env: "legacy" }).mode,
    ).toBe("managed");
    expect(
      resolveSchemaMigrationMode({
        session: "legacy",
        user: "managed",
        env: "managed",
      }).mode,
    ).toBe("legacy");
    expect(
      resolveSchemaMigrationMode({
        run: "managed",
        session: "legacy",
        user: "legacy",
        env: "legacy",
      }).mode,
    ).toBe("managed");
  });

  it("an unrecognized winning value FAILS CLOSED to legacy, no fall-through", () => {
    const r = resolveSchemaMigrationMode({
      session: "bogus",
      env: "managed",
    });
    expect(r.mode).toBe("legacy");
    expect(r.invalid).toBe(true);
    expect(r.level).toBe("session");
    expect(r.raw).toBe("bogus");
  });

  it("names the switch and its config-error event", () => {
    expect(SCHEMA_MIGRATION_MODE_SWITCH).toBe("SCHEMA_MIGRATION_MODE");
    expect(schemaMigrationConfigErrorEvent()).toBe("schema.config_error");
  });
});

describe("#1767 DO schema-migration framework", () => {
  it("applies migrations in version order and records the ledger", () => {
    const sql = makeSql();
    const applied = applyDoSchemaMigrations(sql, "things_store", [V1, V2], 1000);
    expect(applied).toEqual([1, 2]);
    expect(listAppliedDoSchemaMigrations(sql, "things_store")).toEqual([
      { version: 1, name: "0001_things" },
      { version: 2, name: "0002_things_flag" },
    ]);
    // Tables actually exist and are usable.
    sql.exec("INSERT INTO things (id, v) VALUES ('a', 'x')");
    sql.exec("INSERT INTO thing_flags (thing_id, flag) VALUES ('a', 'f')");
    const rows = [...sql.exec("SELECT id FROM things")];
    expect(rows).toHaveLength(1);
  });

  it("re-apply is a no-op (idempotent, ledger-first skip)", () => {
    const sql = makeSql();
    applyDoSchemaMigrations(sql, "things_store", [V1, V2], 1000);
    expect(applyDoSchemaMigrations(sql, "things_store", [V1, V2], 2000)).toEqual(
      [],
    );
    expect(listAppliedDoSchemaMigrations(sql, "things_store")).toHaveLength(2);
  });

  it("marker-LAST: a throwing migration is not recorded and retries cleanly", () => {
    const sql = makeSql();
    const badV2: DoSchemaMigration = {
      version: 2,
      name: "0002_things_flag",
      up: ["CREATE TABLEE IF NOT EXISTS thing_flags (thing_id TEXT)"],
      down: ["DROP TABLE IF EXISTS thing_flags"],
    };
    expect(() =>
      applyDoSchemaMigrations(sql, "things_store", [V1, badV2], 1000),
    ).toThrow();
    expect(listAppliedDoSchemaMigrations(sql, "things_store")).toEqual([
      { version: 1, name: "0001_things" },
    ]);
    // Retry with the fixed migration converges: only v2 runs.
    expect(applyDoSchemaMigrations(sql, "things_store", [V1, V2], 2000)).toEqual(
      [2],
    );
  });

  it("rejects duplicate versions and non-increasing declaration order", () => {
    const sql = makeSql();
    expect(() =>
      applyDoSchemaMigrations(sql, "s", [V1, { ...V1 }], 1000),
    ).toThrow(/duplicate|increasing/i);
    expect(() =>
      applyDoSchemaMigrations(sql, "s", [V2, V1], 1000),
    ).toThrow(/duplicate|increasing/i);
  });

  it("rolls back only the latest applied migration, via its down statements", () => {
    const sql = makeSql();
    applyDoSchemaMigrations(sql, "things_store", [V1, V2], 1000);
    expect(() =>
      rollbackDoSchemaMigration(sql, "things_store", [V1, V2], 1, 2000),
    ).toThrow(/latest/i);
    const rolled = rollbackDoSchemaMigration(sql, "things_store", [V1, V2], 2, 2000);
    expect(rolled).toBe(true);
    expect(listAppliedDoSchemaMigrations(sql, "things_store")).toEqual([
      { version: 1, name: "0001_things" },
    ]);
    // v2's table is gone, v1's table survives.
    expect(() => sql.exec("SELECT * FROM thing_flags")).toThrow();
    sql.exec("INSERT INTO things (id, v) VALUES ('a', 'x')");
  });

  it("rollback without down statements, or of an unapplied version, throws", () => {
    const sql = makeSql();
    const noDown: DoSchemaMigration = {
      version: 1,
      name: "0001_things",
      up: [...V1.up],
      down: [],
    };
    applyDoSchemaMigrations(sql, "things_store", [noDown], 1000);
    expect(() =>
      rollbackDoSchemaMigration(sql, "things_store", [noDown], 1, 2000),
    ).toThrow(/down/i);
    expect(() =>
      rollbackDoSchemaMigration(sql, "things_store", [V1, V2], 2, 2000),
    ).toThrow(/not applied|latest/i);
  });

  it("drift check: missing, unexpected, and clean states", () => {
    const sql = makeSql();
    applyDoSchemaMigrations(sql, "things_store", [V1], 1000);
    const pending = checkDoSchemaDrift(sql, "things_store", [V1, V2]);
    expect(pending.drifted).toBe(true);
    expect(pending.missing).toEqual([2]);
    expect(pending.unexpected).toEqual([]);

    const sql2 = makeSql();
    applyDoSchemaMigrations(sql2, "things_store", [V1, V2], 1000);
    const clean = checkDoSchemaDrift(sql2, "things_store", [V1, V2]);
    expect(clean.drifted).toBe(false);

    // An applied version outside the declared set is drift, not a pass.
    const sql3 = makeSql();
    applyDoSchemaMigrations(sql3, "things_store", [V1, V2], 1000);
    const stale = checkDoSchemaDrift(sql3, "things_store", [V1]);
    expect(stale.drifted).toBe(true);
    expect(stale.unexpected).toEqual([2]);
  });

  it("aggregates per-instance drift reports across instances", () => {
    const sql = makeSql();
    applyDoSchemaMigrations(sql, "things_store", [V1, V2], 1000);
    const clean = checkDoSchemaDrift(sql, "things_store", [V1, V2]);
    const drifted = checkDoSchemaDrift(sql, "things_store", [V1]);
    const agg = aggregateDoSchemaDrift([
      { instance: "screener:alice", report: clean },
      { instance: "screener:bob", report: drifted },
    ]);
    expect(agg.instances).toBe(2);
    expect(agg.driftedInstances).toEqual(["screener:bob"]);
    expect(agg.drifted).toBe(true);
  });
});

describe("#1767 screen-run-lock store through the framework", () => {
  it("managed mode creates the table AND records the ledger row; lock still works", () => {
    const sql = makeSql();
    const lock = new DoSqliteScreenRunLock(sql, {
      schemaMigrationMode: "managed",
    });
    const first = lock.acquire("alice", "nasdaq100", 1000);
    expect(first.acquired).toBe(true);
    expect(
      listAppliedDoSchemaMigrations(sql, "screen_run_locks"),
    ).toEqual([{ version: 1, name: SCREEN_RUN_LOCK_SCHEMA_MIGRATION.name }]);
    expect(lock.isRunning("alice", "nasdaq100", 1001).running).toBe(true);
    lock.release("alice", "nasdaq100", first.token);
    expect(lock.isRunning("alice", "nasdaq100", 1002).running).toBe(false);
    // Second ensure in managed mode is a ledger no-op, not a re-create.
    lock.acquire("alice", "nasdaq100", 2000);
    expect(
      listAppliedDoSchemaMigrations(sql, "screen_run_locks"),
    ).toHaveLength(1);
  });

  it("legacy mode (default) keeps the exact old behavior: table, no ledger", () => {
    const sql = makeSql();
    const lock = new DoSqliteScreenRunLock(sql);
    const first = lock.acquire("alice", "nasdaq100", 1000);
    expect(first.acquired).toBe(true);
    expect(listAppliedDoSchemaMigrations(sql, "screen_run_locks")).toEqual([]);
  });

  it("the composition root forwards an env-resolved managed mode", () => {
    const sql = makeSql();
    const lock = createScreenRunLockPort(sql, {
      env: { SCHEMA_MIGRATION_MODE: "managed" },
    });
    lock.acquire("alice", "nasdaq100", 1000);
    expect(
      listAppliedDoSchemaMigrations(sql, "screen_run_locks"),
    ).toHaveLength(1);
    const legacy = createScreenRunLockPort(makeSql(), {});
    legacy.acquire("alice", "nasdaq100", 1000);
  });
});
