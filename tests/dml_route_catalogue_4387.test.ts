/**
 * #4387 (P6d, #4282) — route-held DML catalogue pin.
 *
 * The last inline DML sites outside the store families live in two
 * routes, and this test pins the slice surface, mirroring the P6b pin
 * (tests/dml_do_catalogue_4385.test.ts):
 *
 * 1. Grep pin — zero inline raw WRITE-DML strings in the two route
 *    files (comment-stripped scan, the P6b rule restricted to the
 *    write verbs INSERT / UPDATE / DELETE / REPLACE). Scope decision,
 *    recorded here: the SELECT reads in these files stay inline by
 *    design — the clear-table preview COUNTs, the events export, the
 *    migration's sqlite_master discovery and per-table SELECT * are
 *    reads, not DML, and #4387 catalogues only the two DELETEs and
 *    the INSERT OR REPLACE template. A future slice that catalogues
 *    the reads narrows this pin to the full P6b rule (write + read).
 * 2. Coverage — the two new DO DML entries exist, their codes parse
 *    under the shared <kind>.<plane>.<table>.<action> format, their
 *    statements are byte-identical to the strings they replaced, and
 *    each executes against real SQLite through the DO DML executor.
 *    The orchestratorMigration INSERT OR REPLACE resolves through
 *    the P3 parameterized seed entry
 *    (seed.route.orchestrator_migration.insert_or_replace), and the
 *    resolved statement is byte-identical to the template the route
 *    assembled before.
 * 3. Characterization — the maintenance clear of
 *    mas_job_outcomes_meta and mas_events through the route behaves
 *    exactly as before (preview counts without deleting, confirm
 *    deletes, the audit row, the missing-table tolerance); the
 *    migration import still writes rows through the route.
 * 4. Red-team — an uncoded statement cannot execute (unknown code
 *    is rejected fail-closed), and a parameterized entry with an
 *    uncatalogued table is rejected (through the route, the table
 *    lands in tableErrors and no rows are written, while the other
 *    tables still import).
 *
 * Entry shape (ADR 0032, #3260): the D1 plane is Drizzle, the DO
 * plane is the mini-ORM over DO SQLite, and raw SQL lives inside
 * the layer behind ports. These two DELETEs execute on DO storage
 * (the caller's own per-user agent instance), so they are DO DML
 * catalogue entries — template form, because an unpredicated DELETE
 * is not a Repository shape (deleteWhere refuses an empty predicate
 * by design; the dml.do.mas_memory.clear precedent) — executed
 * through the DO DML executor, which AOP-logs every execution with
 * the catalogue code as operationName. The migration insert is the
 * P3 seed entry's DML half: same entry, same parameters, now
 * resolved by the route instead of assembled inline.
 *
 * Baseline (fresh main, the P6b rule): maintenance.ts write 2
 * (the two DELETEs) / write+read 5; orchestratorMigration.ts
 * write 1 (the INSERT template) / write+read 3. After this slice:
 * write 0 / write+read 3 and 2 (the remaining hits are the SELECT
 * reads named above).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  handleMaintenanceRoutes,
  type MaintenanceRouteContext,
} from "../src/agents/routes/maintenance";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  handleOrchestratorMigrationRoutes,
  migrationInsertSql,
  type OrchestratorMigrationContext,
} from "../src/agents/routes/orchestratorMigration";
import {
  createMemoryMembershipStore,
  type Membership,
} from "../src/security/authorization";
import { IAAA_ALIAS_KEY_PREFIX } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";
import type { SqlStorage } from "../src/data/repositoryPorts";
import {
  DO_DML_CATALOGUE,
  type DoDmlCatalogueEntry,
} from "../src/data/schemaComponent/doDmlCatalogue";
import { DO_DML_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/doDmlEntries";
import { executeDoDml } from "../src/data/schemaComponent/doDmlExecutor";
import { isValidStatementCode } from "../src/data/schemaComponent/statementCodes";

const ROUTE_FILES = [
  "src/agents/routes/maintenance.ts",
  "src/agents/routes/orchestratorMigration.ts",
];

/** Strip block + line comments so comment-only SQL never trips the pin. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'A-Za-z0-9_])\/\/.*$/gm, "$1");
}

/** The P6b raw-DML rule, restricted to the write verbs (see header). */
const RAW_WRITE_DML_PATTERN = /[`'"]\s*(INSERT|UPDATE|DELETE|REPLACE)\b/g;

function count(pattern: RegExp, source: string): number {
  return (source.match(pattern) ?? []).length;
}

describe("route-held DML pin: zero inline raw write-DML in the route files (#4387)", () => {
  it("no executable raw write-DML strings in the two route files", () => {
    const hits: string[] = [];
    for (const file of ROUTE_FILES) {
      const n = count(RAW_WRITE_DML_PATTERN, stripComments(readFileSync(file, "utf8")));
      if (n > 0) hits.push(`${file}: ${n}`);
    }
    expect(hits, "raw write-DML string survives outside the catalogue").toEqual([]);
  });

  it("no deleteRows( raw-string carrier remains in maintenance.ts", () => {
    const text = stripComments(readFileSync(ROUTE_FILES[0], "utf8"));
    expect(text).not.toContain("deleteRows(");
    expect(text).not.toContain("DELETE FROM");
  });

  it("no template-assembled INSERT remains in orchestratorMigration.ts", () => {
    const text = stripComments(readFileSync(ROUTE_FILES[1], "utf8"));
    expect(text).not.toContain("INSERT OR REPLACE INTO");
    // The route resolves the P3 seed entry by code.
    expect(text).toContain("seed.route.orchestrator_migration.insert_or_replace");
  });
});

describe("route-held DML catalogue coverage (#4387)", () => {
  const NEW_ENTRIES: Array<{ code: string; statement: string }> = [
    {
      code: "dml.do.mas_job_outcomes_meta.clear",
      statement: "DELETE FROM mas_job_outcomes_meta",
    },
    {
      code: "dml.do.mas_events.clear",
      statement: "DELETE FROM mas_events",
    },
  ];

  it("the two new entries exist, parse, and validate", () => {
    for (const { code } of NEW_ENTRIES) {
      expect(isValidStatementCode(code), code).toBe(true);
      expect(DO_DML_CATALOGUE.has(code), code).toBe(true);
      const entry: DoDmlCatalogueEntry = DO_DML_CATALOGUE.get(code);
      expect(entry.operation).toBe("delete");
      // Unpredicated DELETEs are templates (the mas_memory.clear
      // precedent), not repository entries.
      expect(entry.form).toBe("template");
      expect(entry.mode).toBe("run");
      expect(entry.params).toEqual([]);
    }
    // Both are in the declared entry list (no shadow registration).
    for (const { code } of NEW_ENTRIES) {
      expect(
        DO_DML_CATALOGUE_ENTRIES.some((e) => e.code === code),
        code,
      ).toBe(true);
    }
  });

  it("each new template statement is byte-identical to the string it replaced", () => {
    for (const { code, statement } of NEW_ENTRIES) {
      expect(DO_DML_CATALOGUE.get(code).statement, code).toBe(statement);
    }
  });

  it("each new entry clears its table against real SQLite", () => {
    for (const { code } of NEW_ENTRIES) {
      const table = code.split(".")[2];
      const db = new DatabaseSync(":memory:");
      db.exec(`CREATE TABLE ${table} (k TEXT PRIMARY KEY, v TEXT)`);
      db.prepare(`INSERT INTO ${table} (k, v) VALUES ('a', '1')`).run();
      db.prepare(`INSERT INTO ${table} (k, v) VALUES ('b', '2')`).run();
      const storage = {
        exec: (query: string, ...args: unknown[]) => {
          const stmt = db.prepare(query);
          if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
            return stmt.all(...(args as never[])) as unknown[];
          }
          stmt.run(...(args as never[]));
          return [];
        },
      } as unknown as SqlStorage;
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ).toBe(2);
      executeDoDml(DO_DML_CATALOGUE, storage, code, {});
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ).toBe(0);
    }
  });

  it("the migration insert resolves byte-identical to the old template", () => {
    expect(
      migrationInsertSql("mas_reports", "id, title", "?, ?"),
    ).toBe("INSERT OR REPLACE INTO mas_reports (id, title) VALUES (?, ?)");
    expect(
      migrationInsertSql("mas_events", "id, type", "?, ?"),
    ).toBe("INSERT OR REPLACE INTO mas_events (id, type) VALUES (?, ?)");
  });
});

describe("route-held DML catalogue red-team (#4387)", () => {
  it("rejects an unregistered code — an uncoded statement cannot execute", () => {
    const storage = {
      exec: () => [],
    } as unknown as SqlStorage;
    expect(() =>
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.nope.nope", {}),
    ).toThrowError(/not registered/);
  });

  it("rejects a parameterized entry with an uncatalogued table", () => {
    expect(() =>
      migrationInsertSql("definitely_not_a_table_xyz", "id", "?"),
    ).toThrowError(/uncatalogued table/);
    // The placeholder table itself is never a runtime table.
    expect(() =>
      migrationInsertSql("__table__", "id", "?"),
    ).toThrowError(/uncatalogued table/);
  });
});

/* ------------------------------------------------------------------ */
/* Characterization: maintenance clear of the two tables (#4387)      */
/* ------------------------------------------------------------------ */

/** Eager SqlStorage adapter over node:sqlite (the maintenance test's shape). */
function makeSql(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|EXPLAIN|PRAGMA|WITH)\b/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      stmt.run(...(args as never[]));
      return [];
    },
  } as unknown as SqlStorage;
}

function seedClearTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE mas_job_outcomes_meta (k TEXT PRIMARY KEY, v TEXT)`);
  db.exec(
    `CREATE TABLE mas_events (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, agent TEXT, payload TEXT, created_at TEXT)`,
  );
  db.prepare(`INSERT INTO mas_job_outcomes_meta (k, v) VALUES ('pruned_at', '2026-10-29T00:00:00.000Z')`).run();
  const ev = db.prepare(
    `INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, 'sess-1', 'test.event', 'orchestrator', '{}', '2026-10-29')`,
  );
  ev.run("e1");
  ev.run("e2");
  ev.run("e3");
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const CLEAR_PATH = "/api/maintenance/clear-table";

async function postClear(
  ctx: MaintenanceRouteContext,
  body: Record<string, unknown>,
) {
  const req = new Request(`https://agent.test${CLEAR_PATH}`, {
    method: "POST",
    // Issue #6503 step 8b — the clear-table rows this file pins are
    // platform-admin only; the caller header rides with the admin
    // ctx built by makeAdminMaintenanceCtx below.
    headers: { "Content-Type": "application/json", "x-user-login": ADMIN_LOGIN },
    body: JSON.stringify(body),
  });
  const res = await handleMaintenanceRoutes(
    req,
    new URL(`https://agent.test${CLEAR_PATH}`),
    CLEAR_PATH,
    "sess-1",
    ctx,
  );
  return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
}

describe("maintenance clear characterization: meta + events (#4387)", () => {
  // Issue #6503 step 8b — the clear-table rows this section pins
  // are platform-admin only: the ctx carries the file's admin
  // identity (mapKv alias + memory membership store, defined
  // below for the import section and reused here, not a second
  // shape). postClear sends the matching x-user-login header.
  function makeAdminMaintenanceCtx(db: DatabaseSync): MaintenanceRouteContext {
    const store = createMemoryMembershipStore();
    void store.put(platformAdminMembership(ADMIN_ID));
    return {
      agentCtx: { storage: { sql: makeSql(db) } },
      audit: vi.fn(),
      // Issue #6503 step 9 (G2) — the gated clear-table audit
      // blocks without a working audit store; the fixture carries
      // the memory store.
      auditStore: createMemoryAuditStore(),
      getScreenerExecutionContext: async () => undefined,
      flagAliasKv: mapKv({
        [`${IAAA_ALIAS_KEY_PREFIX}login:${ADMIN_LOGIN}`]: JSON.stringify({
          githubLogin: ADMIN_LOGIN,
          internalUserId: ADMIN_ID,
          recordedAtMs: 1,
          source: "wired-login",
        }),
      }),
      flagMembershipStore: store,
    } as unknown as MaintenanceRouteContext;
  }

  it("preview counts without deleting and without auditing", async () => {
    const db = new DatabaseSync(":memory:");
    seedClearTables(db);
    const ctx = makeAdminMaintenanceCtx(db);
    for (const [table, expected] of [
      ["mas_job_outcomes_meta", 1],
      ["mas_events", 3],
    ] as const) {
      const { status, body } = await postClear(ctx, { table });
      expect(status).toBe(200);
      expect(body.confirmed).toBe(false);
      expect(body.wouldDelete).toBe(expected);
      expect(countRows(db, table)).toBe(expected);
    }
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("confirm clears the watermark row; outcomes are untouched by this path", async () => {
    const db = new DatabaseSync(":memory:");
    seedClearTables(db);
    const ctx = makeAdminMaintenanceCtx(db);
    const { status, body } = await postClear(ctx, {
      table: "mas_job_outcomes_meta",
      confirm: true,
    });
    expect(status).toBe(200);
    expect(body.deleted).toBe(1);
    expect(countRows(db, "mas_job_outcomes_meta")).toBe(0);
    expect(countRows(db, "mas_events")).toBe(3);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    expect((ctx.audit as unknown as { mock: { calls: Array<Array<unknown>> } }).mock.calls[0][0]).toBe(
      "maintenance.table.cleared",
    );
  });

  it("confirm clears audit history only with the second confirmation (#2489)", async () => {
    const db = new DatabaseSync(":memory:");
    seedClearTables(db);
    const ctx = makeAdminMaintenanceCtx(db);
    const refused = await postClear(ctx, { table: "mas_events", confirm: true });
    expect(refused.status).toBe(400);
    expect(countRows(db, "mas_events")).toBe(3);
    const { status, body } = await postClear(ctx, {
      table: "mas_events",
      confirm: true,
      auditConfirm: true,
    });
    expect(status).toBe(200);
    expect(body.deleted).toBe(3);
    expect(countRows(db, "mas_events")).toBe(0);
    expect(countRows(db, "mas_job_outcomes_meta")).toBe(1);
  });

  it("missing tables preview and confirm at zero, never 500", async () => {
    const fresh = new DatabaseSync(":memory:");
    const ctx = makeAdminMaintenanceCtx(fresh);
    for (const table of ["mas_job_outcomes_meta", "mas_events"] as const) {
      const preview = await postClear(ctx, { table });
      expect(preview.status).toBe(200);
      expect(preview.body.wouldDelete).toBe(0);
      // mas_events needs the second confirmation even on an empty
      // table — the #2489 gate fires before the delete runs.
      const confirmed = await postClear(ctx, {
        table,
        confirm: true,
        ...(table === "mas_events" ? { auditConfirm: true } : {}),
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.deleted).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Characterization: migration import through the route (#4387)       */
/* The 2681 suite pins the full round-trip unmodified; this section  */
/* pins the P6d behaviour only: an uncatalogued table is rejected    */
/* through the real import route, and the other tables still import. */
/* ------------------------------------------------------------------ */

const IMPORT = "/admin/orchestrator-migration/import";
const ADMIN_LOGIN = "admin-user";
const ADMIN_ID = "admin-id-1";

function mapKv(seed: Record<string, string> = {}): KvLike {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
  } as unknown as KvLike;
}

function platformAdminMembership(userId: string): Membership {
  return {
    membershipId: `m-platform-admin-${userId}`,
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "bootstrap" }],
    createdBy: "bootstrap",
    createdAtMs: 1,
  };
}

/** Minimal in-memory DO storage for the import path (the 2681 shape). */
class FakeMigrationStorage {
  kv = new Map<string, unknown>();
  tables = new Map<string, Array<Record<string, unknown>>>();

  async get(key: string): Promise<unknown> {
    return this.kv.has(key) ? this.kv.get(key) : null;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.kv.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.kv.delete(key);
  }
  async list(opts: { limit?: number; startAfter?: string } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.kv.keys()].sort();
    let start = 0;
    if (opts.startAfter !== undefined) {
      const idx = keys.indexOf(opts.startAfter);
      start = idx >= 0 ? idx + 1 : keys.length;
    }
    const slice = opts.limit === undefined ? keys.slice(start) : keys.slice(start, start + opts.limit);
    const out = new Map<string, unknown>();
    for (const k of slice) out.set(k, this.kv.get(k));
    return out;
  }

  exec(sql: string, ...args: unknown[]): Iterable<Record<string, unknown>> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const insertMatch = normalized.match(/INSERT OR REPLACE INTO ([A-Za-z0-9_]+) \(([^)]+)\) VALUES/);
    if (insertMatch) {
      const table = insertMatch[1];
      const cols = insertMatch[2].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        row[c] = args[i];
      });
      const rows = this.tables.get(table) ?? [];
      const pk = ["id", "job_id", "schedule_id"].find((k) => row[k] !== undefined);
      if (pk !== undefined) {
        const idx = rows.findIndex((r) => r[pk] === row[pk]);
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
      } else {
        rows.push(row);
      }
      this.tables.set(table, rows);
      return [];
    }
    throw new Error(`FakeMigrationStorage: unsupported SQL: ${sql}`);
  }
}

function makeMigrationCtx(storage: FakeMigrationStorage): OrchestratorMigrationContext {
  const store = createMemoryMembershipStore();
  void store.put(platformAdminMembership(ADMIN_ID));
  const aliasKv = mapKv({
    [`${IAAA_ALIAS_KEY_PREFIX}login:${ADMIN_LOGIN}`]: JSON.stringify({
      githubLogin: ADMIN_LOGIN,
      internalUserId: ADMIN_ID,
      recordedAtMs: 1,
      source: "wired-login",
    }),
  });
  return {
    env: {},
    audit: vi.fn(),
    membershipStore: store,
    aliasKv,
    storage: {
      get: (k: string) => storage.get(k),
      put: (k: string, v: unknown) => storage.put(k, v),
      delete: (k: string) => storage.delete(k),
      list: (o?: { limit?: number; startAfter?: string }) => storage.list(o),
      sql: { exec: (sql: string, ...args: unknown[]) => storage.exec(sql, ...args) },
    },
    listSchedules: async () => [],
    schedule: async () => ({}),
    scheduleEvery: async () => ({}),
  } as unknown as OrchestratorMigrationContext;
}

async function postImport(
  ctx: OrchestratorMigrationContext,
  body: Record<string, unknown>,
) {
  const req = new Request(`https://agent.test${IMPORT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-login": ADMIN_LOGIN },
    body: JSON.stringify(body),
  });
  const res = await handleOrchestratorMigrationRoutes(
    req,
    new URL(`https://agent.test${IMPORT}`),
    IMPORT,
    "session-1",
    ctx,
  );
  return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
}

describe("migration import characterization: uncatalogued table rejected (#4387)", () => {
  it("an uncatalogued table lands in tableErrors and writes nothing; catalogued tables still import", async () => {
    const storage = new FakeMigrationStorage();
    const ctx = makeMigrationCtx(storage);
    const { status, body } = await postImport(ctx, {
      tables: {
        mas_messages: [{ id: "msg-1", body: "hello" }],
        definitely_not_a_table_xyz: [{ id: "x-1", body: "smuggled" }],
        mas_events: [{ id: "ev-1", type: "test.event" }],
      },
    });
    expect(status).toBe(200);
    expect((body.tables as Record<string, number>)["mas_messages"]).toBe(1);
    expect((body.tables as Record<string, number>)["mas_events"]).toBe(1);
    expect((body.tables as Record<string, number>)["definitely_not_a_table_xyz"]).toBe(0);
    const errors = body.tableErrors as Array<{ table: string; error: string }>;
    expect(errors.map((e) => e.table)).toEqual(["definitely_not_a_table_xyz"]);
    expect(errors[0].error).toMatch(/uncatalogued table/);
    expect(storage.tables.get("mas_messages")).toHaveLength(1);
    expect(storage.tables.get("mas_events")).toHaveLength(1);
    expect(storage.tables.has("definitely_not_a_table_xyz")).toBe(false);
  });
});
