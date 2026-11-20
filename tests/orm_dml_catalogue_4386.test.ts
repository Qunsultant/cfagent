/**
 * #4386 (P6c, #4282) — ORM-core DML catalogue pin.
 *
 * The ORM core's DML lives in exactly one place: the EXISTING
 * DO DML catalogue (src/data/schemaComponent/doDmlCatalogue.ts +
 * doDmlEntries.ts), executed only through the DO DML executor —
 * REUSE, no sibling catalogue, no sibling executor (the user's
 * one-solution ruling, comment 6897923641 on #4386). This test
 * pins the slice surface, mirroring the P6b pin
 * (tests/dml_do_catalogue_4385.test.ts):
 *
 * 1. Grep pin — zero inline raw-DML strings in
 *    doSqliteOrmAdapters.ts (the only remaining .exec( site is
 *    ensureSchema's DDL) and no COUNT(*) literal remains in
 *    ormFacade.ts (both counts moved to a parameterized entry).
 * 2. Red-team — an uncoded statement cannot execute, a
 *    parameterized entry resolves only when the code table
 *    equals the runtime table, the placeholder code is never
 *    callable directly, and a parameterized entry with a real
 *    table, a template form, or a column map fails validation.
 * 3. Coverage — every migrated operation has a catalogue entry,
 *    every code parses under the shared <kind>.<plane>.<table>.
 *    <action> format, the per-table entry counts match the
 *    migration (26 new entries: 22 repository + 4 template;
 *    catalogue 53 → 79), every template statement is
 *    byte-identical to the statement it replaced, and every
 *    entry executes against real SQLite.
 *
 * #4387 (P6d): the catalogue grows 79 → 81 with the two
 * route-held DELETEs (both template) — the counts below move
 * with the change (gitops §7). The route-held entries are
 * pinned by tests/dml_route_catalogue_4387.test.ts.
 *
 * Baseline on 7d81cd93 (evidence-p6c/scan-orm-core-7d81cd93.txt):
 * the 16 doSqliteOrmAdapters.ts statements (10 write / 6 read),
 * the 9 ormRepositoryCore.ts generator templates (the 10th
 * operation entry is the fixed mas_events tail read), and the
 * facade's 3 browse/count reads. The pin is RED on that base
 * by design.
 *
 * #4751 (P6c follow-on) moves the ruled point: the shared
 * where-language now expresses the dynamic WHERE ($or of $like
 * across the runtime-discovered TEXT columns), so the browse
 * SELECT is a findMany-style call — getTableData is no longer
 * an inline exec site, and the facade census moves 21 → 20.
 * The per-table-baked-entries and whole-table-fetch alternatives
 * stay ruled out (near-duplicates fragile to DDL drift; a full
 * fetch would load the whole table to filter in JS).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildDoDmlCatalogue,
  createDoDmlCatalogue,
  DO_DML_CATALOGUE,
  validateDoDmlEntry,
  type DoDmlCatalogueEntry,
} from "../src/data/schemaComponent/doDmlCatalogue";
import { DO_DML_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/doDmlEntries";
import { executeDoDml } from "../src/data/schemaComponent/doDmlExecutor";
import { isValidStatementCode } from "../src/data/schemaComponent/statementCodes";
import { SchemaErrorCode } from "../src/data/schemaComponent/schemaErrors";
import { doTableSql } from "../src/data/schemaComponent/doCatalogue";
import { ormTableSql } from "../src/data/schemaComponent/ormCatalogue";
import { Repository } from "../src/data/ormRepositoryCore";
import {
  EVENT_COLUMN_MAP,
  MEMORY_COLUMN_MAP,
  MESSAGE_COLUMN_MAP,
  TRANSACTION_COLUMN_MAP,
} from "../src/data/ormColumnMaps";
import type { SqlStorage } from "../src/data/repositoryPorts";

/**
 * Real-SQLite SqlStorage with rowsWritten-faithful write cursors
 * (the conformance file's shape — the DO's SqlStorage reports
 * rowsWritten, so this is the production path; the P6b pin's
 * storage exercises the verified-count fallback instead).
 */
class SqliteTestStorage implements SqlStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

/** Strip block + line comments so comment-only SQL never trips the pin. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'A-Za-z0-9_])\/\/.*$/gm, "$1");
}

const RAW_DML_PATTERN = /[`'"]\s*(INSERT|UPDATE|DELETE|REPLACE|SELECT)\b/g;

function count(pattern: RegExp, source: string): number {
  return (source.match(pattern) ?? []).length;
}

describe("ORM-core pin: zero inline raw DML in doSqliteOrmAdapters.ts (#4386)", () => {
  it("no executable raw-DML strings remain in the adapter module", () => {
    const text = stripComments(readFileSync("src/data/doSqliteOrmAdapters.ts", "utf8"));
    expect(count(RAW_DML_PATTERN, text)).toBe(0);
  });

  it("the only remaining .exec( site is ensureSchema's DDL", () => {
    const text = stripComments(readFileSync("src/data/doSqliteOrmAdapters.ts", "utf8"));
    const sites = [...text.matchAll(/this\.sql\.exec\(([^,)]+)/g)].map((m) => m[1].trim());
    expect(sites).toEqual(["MAS_SETTINGS_DDL"]);
  });

  it("no COUNT(*) literal remains in the facade — both counts moved to the parameterized entry", () => {
    const text = stripComments(readFileSync("src/data/ormFacade.ts", "utf8"));
    expect(text).not.toContain("COUNT(*)");
  });
});

describe("ORM-core DML catalogue red-team (#4386)", () => {
  it("rejects an unregistered code — an uncoded statement cannot execute", () => {
    const catalogue = createDoDmlCatalogue();
    const storage = new SqliteTestStorage();
    expect(() =>
      executeDoDml(catalogue, storage, "dml.do.mas_messages.nope", {
        table: "mas_messages",
      }),
    ).toThrowError(/not registered/);
  });

  it("a parameterized dispatch refuses a missing runtime table", () => {
    const storage = new SqliteTestStorage();
    storage.exec(ormTableSql("mas_messages"));
    expect(() =>
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.count", {}),
    ).toThrowError(/param "table"/);
  });

  it("a parameterized dispatch refuses a code table that is not the runtime table", () => {
    const storage = new SqliteTestStorage();
    storage.exec(ormTableSql("mas_messages"));
    storage.exec(ormTableSql("mas_events"));
    expect(() =>
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.count", {
        table: "mas_events",
      }),
    ).toThrowError(/does not match/);
  });

  it("the placeholder code itself is never callable — callers pass the resolved code", () => {
    const storage = new SqliteTestStorage();
    storage.exec(ormTableSql("mas_messages"));
    expect(() =>
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.__table__.count", {
        table: "mas_messages",
      }),
    ).toThrowError(/does not match/);
  });

  it("a parameterized entry with a real table fails validation", () => {
    const entry = DO_DML_CATALOGUE_ENTRIES.find((e) => e.parameterizedTable)!;
    expect(validateDoDmlEntry({ ...entry, table: "mas_messages" }).valid).toBe(false);
  });

  it("a parameterized entry in template form fails validation", () => {
    const entry = DO_DML_CATALOGUE_ENTRIES.find((e) => e.parameterizedTable)!;
    expect(
      validateDoDmlEntry({
        ...entry,
        form: "template",
        statement: "SELECT 1",
        params: [],
        mode: "all",
      }).valid,
    ).toBe(false);
  });

  it("a parameterized entry carrying a column map fails validation", () => {
    const entry = DO_DML_CATALOGUE_ENTRIES.find((e) => e.parameterizedTable)!;
    expect(
      validateDoDmlEntry({ ...entry, columnMap: { id: "id" } }).valid,
    ).toBe(false);
  });

  it("rejects a duplicate registration of a parameterized entry", () => {
    const catalogue = createDoDmlCatalogue();
    const entry = DO_DML_CATALOGUE_ENTRIES.find((e) => e.parameterizedTable)!;
    catalogue.register(entry);
    let caught: unknown;
    try {
      catalogue.register(entry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe(SchemaErrorCode.DUPLICATE_CODE);
  });

  it("refuses a template execution with a missing param (fail-closed, never a NULL binding)", () => {
    const storage = new SqliteTestStorage();
    storage.exec(ormTableSql("mas_memory"));
    expect(() =>
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_memory.search", {
        like: "%a%",
      }),
    ).toThrowError(/missing param "limit"/);
  });
});

describe("ORM-core DML catalogue coverage (#4386)", () => {
  it("every entry code parses under the shared format and agrees with its table", () => {
    for (const entry of DO_DML_CATALOGUE_ENTRIES) {
      expect(isValidStatementCode(entry.code), entry.code).toBe(true);
      expect(validateDoDmlEntry(entry).valid, entry.code).toBe(true);
    }
  });

  it("the built catalogue holds exactly the declared entries, no more", () => {
    const built = buildDoDmlCatalogue();
    expect(built.size()).toBe(DO_DML_CATALOGUE_ENTRIES.length);
    expect(DO_DML_CATALOGUE.size()).toBe(DO_DML_CATALOGUE_ENTRIES.length);
    expect(DO_DML_CATALOGUE_ENTRIES.length).toBe(83);
    expect(new Set(DO_DML_CATALOGUE_ENTRIES.map((e) => e.code)).size).toBe(
      DO_DML_CATALOGUE_ENTRIES.length,
    );
  });

  it("per-table entry counts match the migration (22 repository + 4 template new in P6c, +2 template in P6d)", () => {
    const counts: Record<string, number> = {
      mas_messages: 2,
      mas_events: 3,
      mas_memory: 4,
      mas_transactions: 5,
      mas_settings: 3,
      mas_job_outcomes_meta: 1,
      __table__: 10,
    };
    for (const [table, expected] of Object.entries(counts)) {
      expect(DO_DML_CATALOGUE.findByTable(table).length, table).toBe(expected);
    }
    const forms = DO_DML_CATALOGUE_ENTRIES.reduce(
      (acc, e) => ({ ...acc, [e.form]: (acc[e.form] ?? 0) + 1 }),
      {} as Record<string, number>,
    );
    expect(forms.repository).toBe(64);
    expect(forms.template).toBe(19);
  });

  it("every template statement is byte-identical to the statement it replaced", () => {
    const expected: Record<string, string> = {
      "dml.do.mas_memory.clear": "DELETE FROM mas_memory",
      "dml.do.mas_memory.search":
        "SELECT key, value, updated_at FROM mas_memory WHERE lower(key) LIKE ? OR lower(value) LIKE ? ORDER BY updated_at DESC LIMIT ?",
      "dml.do.mas_transactions.complete_by_gateway_ref":
        "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ? OR gateway_ref = ?",
      "dml.do.mas_events.tail_hash":
        "SELECT event_hash FROM mas_events ORDER BY rowid DESC LIMIT 1",
    };
    expect(Object.keys(expected)).toHaveLength(4);
    for (const [code, statement] of Object.entries(expected)) {
      const entry = DO_DML_CATALOGUE.get(code);
      expect(entry.form).toBe("template");
      expect(entry.statement, code).toBe(statement);
    }
  });

  it("one key code per migrated family is registered", () => {
    for (const code of [
      "dml.do.mas_messages.ids_created_before",
      "dml.do.mas_messages.delete_by_session",
      "dml.do.mas_events.ids_created_before",
      "dml.do.mas_events.tail_hash",
      "dml.do.mas_memory.clear",
      "dml.do.mas_memory.search",
      "dml.do.mas_memory.list_recent",
      "dml.do.mas_transactions.replace",
      "dml.do.mas_transactions.complete_with_gateway",
      "dml.do.mas_transactions.complete_by_gateway_ref",
      "dml.do.mas_settings.get",
      "dml.do.mas_settings.insert",
      "dml.do.__table__.count",
      "dml.do.__table__.find_many",
      "dml.do.__table__.insert_or_replace",
    ]) {
      expect(DO_DML_CATALOGUE.has(code), code).toBe(true);
    }
  });
});

describe("ORM-core DML catalogue execution (#4386)", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const T1 = "2026-02-02T02:02:02.000Z";

  function storageWithOrm(table: string): SqliteTestStorage {
    const storage = new SqliteTestStorage();
    storage.exec(ormTableSql(table));
    return storage;
  }

  it("Messages: ids_created_before / delete_by_session round-trip through the catalogue", () => {
    const storage = storageWithOrm("mas_messages");
    const repo = new Repository(storage, "mas_messages", "id", MESSAGE_COLUMN_MAP);
    repo.create({
      id: "m1", sessionId: "s1", role: "user", content: "hello",
      agent: "mas", createdAt: T0,
    });
    repo.create({
      id: "m2", sessionId: "s1", role: "assistant", content: "hi",
      agent: "mas", createdAt: T1,
    });
    repo.create({
      id: "m3", sessionId: "s2", role: "user", content: "yo",
      agent: "mas", createdAt: T0,
    });
    const ids = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_messages.ids_created_before",
      { where: { createdAt: { $lt: "2026-01-15T00:00:00.000Z" } }, orderBy: "created_at ASC", limit: 10 },
    );
    expect(ids.map((r) => r.id)).toEqual(["m1", "m3"]);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.delete_by_session", {
        where: { sessionId: "s1" },
      }),
    ).toBe(2);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.count", {
        table: "mas_messages",
      }),
    ).toBe(1);
  });

  it("Events: ids_created_before / tail_hash round-trip through the catalogue", () => {
    const storage = storageWithOrm("mas_events");
    const repo = new Repository(storage, "mas_events", "id", EVENT_COLUMN_MAP);
    repo.create({
      id: "e1", sessionId: "s1", type: "t", agent: "mas", payload: "{}",
      createdAt: T0, previousEventHash: null, eventHash: "hash-1",
    });
    repo.create({
      id: "e2", sessionId: "s1", type: "t", agent: "mas", payload: "{}",
      createdAt: T1, previousEventHash: "hash-1", eventHash: "hash-2",
    });
    const ids = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_events.ids_created_before",
      { where: { createdAt: { $lt: "2026-01-15T00:00:00.000Z" } }, orderBy: "created_at ASC", limit: 10 },
    );
    expect(ids.map((r) => r.id)).toEqual(["e1"]);
    const tail = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_events.tail_hash", {},
    );
    expect(tail).toEqual([{ event_hash: "hash-2" }]);
  });

  it("Memory: clear / keys_updated_before / search / list_recent round-trip through the catalogue", () => {
    const storage = storageWithOrm("mas_memory");
    const repo = new Repository(storage, "mas_memory", "key", MEMORY_COLUMN_MAP);
    repo.create({ key: "alpha", value: "Alpha value", updatedAt: T0 });
    repo.create({ key: "beta", value: "Beta value", updatedAt: T1 });
    repo.create({ key: "gamma", value: "unrelated", updatedAt: T0 });
    const keys = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_memory.keys_updated_before",
      { where: { updatedAt: { $lt: "2026-01-15T00:00:00.000Z" } }, orderBy: "updated_at ASC", limit: 10 },
    );
    expect(keys.map((r) => r.key)).toEqual(["alpha", "gamma"]);
    const found = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_memory.search",
      { like: "%alpha%", limit: 10 },
    );
    expect(found).toEqual([{ key: "alpha", value: "Alpha value", updated_at: T0 }]);
    const recent = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_memory.list_recent",
      { orderBy: "updated_at DESC", limit: 2 },
    );
    expect(recent.map((r) => r.key)).toEqual(["beta", "alpha"]);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_memory.clear", {}),
    ).toBe(3);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_memory.count", {
        table: "mas_memory",
      }),
    ).toBe(0);
  });

  it("Ledger: replace / four transitions round-trip through the catalogue", () => {
    const storage = storageWithOrm("mas_transactions");
    const repo = new Repository(storage, "mas_transactions", "id", TRANSACTION_COLUMN_MAP);
    const record = {
      id: "tx1", sessionId: "s1", action: "charge", amount: 200, currency: "USD",
      customer: "cust-1", gateway: "stripe", gatewayRef: "gw-1", status: "authorized",
      checkoutUrl: "https://pay.example/tx1", proposerDid: "did:ex:proposer",
      authorizerDid: "did:ex:authorizer", proofSignature: "sig", note: "original note",
      createdAt: T0, updatedAt: T0, tenantId: null,
    };
    const replaced = executeDoDml<Record<string, unknown>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_transactions.replace", { record },
    );
    expect(replaced.id).toBe("tx1");
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_transactions.complete_with_gateway", {
        where: { id: "tx1" },
        set: {
          status: "completed", gatewayRef: "gw-2", checkoutUrl: "https://pay.example/new",
          authorizerDid: "did:ex:human", note: "Confirmed", updatedAt: T1,
        },
      }),
    ).toBe(1);
    const row = repo.findById("tx1")!;
    expect(row.status).toBe("completed");
    expect(row.gatewayRef).toBe("gw-2");
    expect(row.amount).toBe(200);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_transactions.reject_with_note", {
        where: { id: "tx1" },
        set: { status: "rejected", authorizerDid: "did:ex:reviewer", note: "No", updatedAt: T1 },
      }),
    ).toBe(1);
    expect(repo.findById("tx1")!.status).toBe("rejected");
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_transactions.complete_by_id", {
        where: { id: "tx1" },
        set: { status: "completed", updatedAt: T1 },
      }),
    ).toBe(1);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_transactions.complete_by_gateway_ref", {
        updatedAt: T1, ref: "gw-2",
      }),
    ).toBe(1);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_transactions.complete_by_gateway_ref", {
        updatedAt: T1, ref: "no_such_ref",
      }),
    ).toBe(0);
  });

  it("Settings: DELETE+INSERT set / get / delete round-trip through the catalogue", () => {
    const storage = new SqliteTestStorage();
    storage.exec(doTableSql("mas_settings"));
    // The set idiom, exactly as the adapter runs it: DELETE then INSERT.
    expect(
      executeDoDml<boolean>(DO_DML_CATALOGUE, storage, "dml.do.mas_settings.delete", { id: "k1" }),
    ).toBe(false);
    executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_settings.insert", {
      record: { key: "k1", value: "v1", updated_at: T0 },
    });
    const row = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_settings.get", { id: "k1" },
    );
    expect(row).toEqual({ key: "k1", value: "v1", updated_at: T0 });
    expect(
      executeDoDml<Record<string, unknown> | null>(
        DO_DML_CATALOGUE, storage, "dml.do.mas_settings.get", { id: "missing" },
      ),
    ).toBeNull();
    expect(
      executeDoDml<boolean>(DO_DML_CATALOGUE, storage, "dml.do.mas_settings.delete", { id: "k1" }),
    ).toBe(true);
    expect(
      executeDoDml<Record<string, unknown> | null>(
        DO_DML_CATALOGUE, storage, "dml.do.mas_settings.get", { id: "k1" },
      ),
    ).toBeNull();
  });

  it("Parameterized operations: the full Repository surface on mas_messages via resolved codes", () => {
    const storage = storageWithOrm("mas_messages");
    const table = "mas_messages";
    const record = {
      id: "p1", session_id: "s1", role: "user", content: "hello",
      agent: "mas", created_at: T0,
    };
    expect(
      executeDoDml<Record<string, unknown>>(
        DO_DML_CATALOGUE, storage, "dml.do.mas_messages.insert", { table, record },
      ),
    ).toEqual(record);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.count", { table }),
    ).toBe(1);
    expect(
      executeDoDml<Record<string, unknown> | null>(
        DO_DML_CATALOGUE, storage, "dml.do.mas_messages.find_by_id", { table, id: "p1" },
      ),
    ).toEqual(record);
    expect(
      executeDoDml<Array<Record<string, unknown>>>(
        DO_DML_CATALOGUE, storage, "dml.do.mas_messages.find_many",
        { table, where: { session_id: "s1" } },
      ),
    ).toHaveLength(1);
    const updated = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_messages.update",
      { table, id: "p1", updates: { content: "edited" } },
    );
    expect(updated?.content).toBe("edited");
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.update_where", {
        table, where: { session_id: "s1" }, set: { agent: "other" },
      }),
    ).toBe(1);
    expect(
      executeDoDml<boolean>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.insert_or_ignore", {
        table, record,
      }),
    ).toBe(false);
    const replaced = executeDoDml<Record<string, unknown>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_messages.insert_or_replace",
      { table, record: { ...record, content: "replaced" } },
    );
    expect(replaced.content).toBe("replaced");
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.count", { table }),
    ).toBe(1);
    expect(
      executeDoDml<boolean>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.delete", {
        table, id: "p1",
      }),
    ).toBe(true);
    executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.insert", {
      table, record: { ...record, id: "p2" },
    });
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.delete_where", {
        table, where: { session_id: "s1" },
      }),
    ).toBe(1);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_messages.count", { table }),
    ).toBe(0);
  });
});
