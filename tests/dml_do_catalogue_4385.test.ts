/**
 * #4385 (P6b, #4282) — DO DML catalogue pin.
 *
 * The DO family's first-tranche DML lives in exactly one place: the
 * DO DML catalogue (src/data/schemaComponent/doDmlCatalogue.ts +
 * doDmlEntries.ts), executed only through the DO DML executor. This
 * test pins the slice surface, mirroring the P6a pin
 * (tests/dml_d1_catalogue_4384.test.ts):
 *
 * 1. Grep pin — zero inline raw-DML strings in the 9 tranche files
 *    (comment-stripped scan, the same rule as
 *    evidence-p6b/scan-do-dml.mjs). DDL stays in the adapters by
 *    design (CREATE TABLE / CREATE INDEX / ALTER / PRAGMA via the
 *    DDL catalogue) and is not DML — the pattern only matches
 *    INSERT/UPDATE/DELETE/REPLACE/SELECT string starts.
 * 2. Red-team — an uncoded statement cannot execute (unknown code is
 *    rejected fail-closed), a duplicate registration is rejected, a
 *    tampered entry fails validation, and a template with a missing
 *    param refuses to execute.
 * 3. Coverage — every migrated operation has a catalogue entry, every
 *    code parses under the shared <kind>.<plane>.<table>.<action>
 *    format, the per-table entry counts match the migration, every
 *    template statement is byte-identical to the constant it replaced,
 *    and every entry executes against real SQLite.
 *
 * Baseline on 1501f5f4 (evidence-p6b/scan-do-dml-1501f5f4.txt): 52
 * files, 142 write / 155 read = 297 statements; the tranche is 53
 * (21 write / 32 read). The pin is RED on that base by design.
 *
 * #4386 (P6c): the catalogue grew to 79 entries (64 repository +
 * 15 template) with the ORM-core tables — the counts below move
 * with the change (gitops §7: pins move with the change, they are
 * never weakened). The tranche files and their 11 templates are
 * unchanged; the P6c entries are pinned by
 * tests/orm_dml_catalogue_4386.test.ts.
 *
 * #4387 (P6d): the catalogue grows to 81 entries (64 repository +
 * 17 template) with the two route-held DELETEs — the counts below
 * move with the change (gitops §7). The route-held entries are
 * pinned by tests/dml_route_catalogue_4387.test.ts.
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
import type { SqlStorage } from "../src/data/repositoryPorts";

/** Real-SQLite SqlStorage (the conformance file's shape). */
class SqliteTestStorage implements SqlStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

const TRANCHE_FILES = [
  "src/data/doSqliteDiscoveryAlertAdapter.ts",
  "src/data/doSqliteDiscoveryRunAdapter.ts",
  "src/data/doSqliteDiscoverySetupAdapter.ts",
  "src/data/doSqliteEnrichmentAdapter.ts",
  "src/data/doSqliteFeedSnapshotAdapter.ts",
  "src/data/doSqliteIndexListAdapter.ts",
  "src/data/doSqliteIvHistoryAdapter.ts",
  "src/data/doSqliteScanRunAdapter.ts",
  "src/data/doSqliteStrategyProfileAdapter.ts",
];

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

describe("DO family pin: zero inline raw DML in the tranche files (#4385)", () => {
  it("no executable raw-DML strings in the 9 tranche files", () => {
    const hits: string[] = [];
    for (const file of TRANCHE_FILES) {
      const n = count(RAW_DML_PATTERN, stripComments(readFileSync(file, "utf8")));
      if (n > 0) hits.push(`${file}: ${n}`);
    }
    expect(hits, "raw DML string survives outside the catalogue").toEqual([]);
  });

  it("no this.sql.exec( DML call sites remain in the tranche files", () => {
    // The DDL ensure calls (CREATE TABLE / CREATE INDEX / ALTER /
    // PRAGMA) stay by design — this pins that every remaining
    // .exec( site is a DDL one.
    const hits: string[] = [];
    for (const file of TRANCHE_FILES) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const m of text.matchAll(/this\.sql\.exec\(([^,)]+)/g)) {
        const arg = m[1].trim();
        if (!/^(CREATE|ADD|ALTER|TABLE_INFO)/.test(arg)) {
          hits.push(`${file}: ${arg}`);
        }
      }
    }
    expect(hits, "non-DDL .exec( survives outside the catalogue").toEqual([]);
  });
});

describe("DO DML catalogue red-team (#4385)", () => {
  it("rejects an unregistered code — an uncoded statement cannot execute", () => {
    const catalogue = createDoDmlCatalogue();
    const storage = new SqliteTestStorage();
    expect(() =>
      executeDoDml(catalogue, storage, "dml.do.nope.nope", {}),
    ).toThrowError(/not registered/);
  });

  it("rejects a duplicate registration", () => {
    const catalogue = createDoDmlCatalogue();
    const entry = DO_DML_CATALOGUE_ENTRIES[0];
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

  it("rejects a tampered entry at validation (code/table/form/method disagreement)", () => {
    const entry = DO_DML_CATALOGUE_ENTRIES[0];
    const wrongTable = { ...entry, table: "some_other_table" };
    expect(validateDoDmlEntry(wrongTable).valid).toBe(false);
    const wrongCode = { ...entry, code: "not-a-code" };
    expect(validateDoDmlEntry(wrongCode).valid).toBe(false);
    const wrongPlane = { ...entry, code: entry.code.replace(".do.", ".d1.") };
    expect(validateDoDmlEntry(wrongPlane).valid).toBe(false);
    const wrongMethod = { ...entry, method: "explode" };
    expect(validateDoDmlEntry(wrongMethod).valid).toBe(false);
    const withStatement = { ...entry, statement: "SELECT 1" };
    expect(validateDoDmlEntry(withStatement).valid).toBe(false);
    const template = DO_DML_CATALOGUE_ENTRIES.find((e) => e.form === "template")!;
    const wrongVerb = { ...template, statement: "DELETE FROM x WHERE id = ?" };
    expect(validateDoDmlEntry(wrongVerb).valid).toBe(false);
    const wrongMode = { ...template, mode: "sometimes" };
    expect(validateDoDmlEntry(wrongMode).valid).toBe(false);
  });

  it("freezes registered entries so a registered entry cannot be mutated in place", () => {
    const catalogue = createDoDmlCatalogue();
    const entry: DoDmlCatalogueEntry = {
      code: "dml.do.freeze_probe.probe",
      table: "freeze_probe",
      operation: "read",
      form: "repository",
      method: "count",
    };
    catalogue.register(entry);
    expect(Object.isFrozen(catalogue.get(entry.code))).toBe(true);
    expect(() => {
      (catalogue.get(entry.code) as { table: string }).table = "mutated";
    }).toThrow();
  });

  it("refuses a template execution with a missing param (fail-closed, never a NULL binding)", () => {
    const storage = new SqliteTestStorage();
    storage.exec(doTableSql("mas_discovery_runs"));
    expect(() =>
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_runs.list", {
        userLogin: null,
        limit: 25,
      }),
    ).toThrowError(/missing param "offset"/);
  });

  it("refuses a repository execution with a missing record param", () => {
    const storage = new SqliteTestStorage();
    storage.exec(doTableSql("mas_discovery_alerts"));
    expect(() =>
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_alerts.insert", {}),
    ).toThrowError(/param "record" must be an object/);
  });
});

describe("DO DML catalogue coverage (#4385)", () => {
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
    // 53 (P6b tranche) + 26 (P6c ORM-core) + 2 (P6d route-held) = 81.
    expect(DO_DML_CATALOGUE_ENTRIES.length).toBe(81);
    expect(new Set(DO_DML_CATALOGUE_ENTRIES.map((e) => e.code)).size).toBe(
      DO_DML_CATALOGUE_ENTRIES.length,
    );
  });

  it("per-table entry counts match the migration (64 repository + 15 template)", () => {
    const counts: Record<string, number> = {
      mas_discovery_alerts: 4,
      mas_discovery_runs: 6,
      mas_discovery_setup_runs: 7,
      mas_enrichment_runs: 3,
      mas_feed_snapshots: 5,
      mas_index_lists: 4,
      mas_iv_history: 11,
      mas_opportunity_scans: 8,
      mas_strategy_profiles: 5,
    };
    for (const [table, expected] of Object.entries(counts)) {
      expect(DO_DML_CATALOGUE.findByTable(table).length, table).toBe(expected);
    }
    const forms = DO_DML_CATALOGUE_ENTRIES.reduce(
      (acc, e) => ({ ...acc, [e.form]: (acc[e.form] ?? 0) + 1 }),
      {} as Record<string, number>,
    );
    // 42 + 22 (P6c) repository; 11 + 4 (P6c) + 2 (P6d) template.
    expect(forms.repository).toBe(64);
    expect(forms.template).toBe(17);
  });

  it("every template statement is byte-identical to the constant it replaced", () => {
    const expected: Record<string, string> = {
      "dml.do.mas_discovery_runs.list":
        "SELECT summary_json FROM mas_discovery_runs WHERE (user_login IS NULL OR user_login = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      "dml.do.mas_discovery_runs.prune_cap":
        "DELETE FROM mas_discovery_runs WHERE id NOT IN (SELECT id FROM mas_discovery_runs ORDER BY created_at DESC, id DESC LIMIT ?)",
      "dml.do.mas_discovery_setup_runs.list":
        "SELECT run_json FROM mas_discovery_setup_runs WHERE (user_login IS NULL OR user_login = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      "dml.do.mas_discovery_setup_runs.list_scoped":
        "SELECT run_json FROM mas_discovery_setup_runs WHERE (user_login IS NULL OR user_login = ?) AND scope_key = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      "dml.do.mas_discovery_setup_runs.prune_cap":
        "DELETE FROM mas_discovery_setup_runs WHERE id NOT IN (SELECT id FROM mas_discovery_setup_runs ORDER BY created_at DESC, id DESC LIMIT ?)",
      "dml.do.mas_iv_history.coverage":
        "SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM mas_iv_history WHERE symbol = ?",
      "dml.do.mas_iv_history.coverage_broker":
        "SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM mas_iv_history WHERE symbol = ? AND broker = ?",
      "dml.do.mas_iv_history.symbols":
        "SELECT DISTINCT symbol FROM mas_iv_history ORDER BY symbol ASC",
      "dml.do.mas_iv_history.symbols_broker":
        "SELECT DISTINCT symbol FROM mas_iv_history WHERE broker = ? ORDER BY symbol ASC",
      "dml.do.mas_opportunity_scans.list":
        "SELECT summary_json FROM mas_opportunity_scans WHERE (user_login IS NULL OR user_login = ?) ORDER BY generated_at DESC, id DESC LIMIT ? OFFSET ?",
      "dml.do.mas_opportunity_scans.prune_cap":
        "DELETE FROM mas_opportunity_scans WHERE id NOT IN (SELECT id FROM mas_opportunity_scans ORDER BY generated_at DESC, id DESC LIMIT ?)",
    };
    expect(Object.keys(expected)).toHaveLength(11);
    for (const [code, statement] of Object.entries(expected)) {
      const entry = DO_DML_CATALOGUE.get(code);
      expect(entry.form).toBe("template");
      expect(entry.statement, code).toBe(statement);
    }
  });

  it("one key code per migrated family is registered", () => {
    for (const code of [
      "dml.do.mas_discovery_alerts.insert",
      "dml.do.mas_discovery_runs.prune_age",
      "dml.do.mas_discovery_setup_runs.list_scoped",
      "dml.do.mas_enrichment_runs.get_run",
      "dml.do.mas_feed_snapshots.by_id",
      "dml.do.mas_index_lists.latest",
      "dml.do.mas_iv_history.insert",
      "dml.do.mas_opportunity_scans.update_linkage",
      "dml.do.mas_strategy_profiles.update",
    ]) {
      expect(DO_DML_CATALOGUE.has(code), code).toBe(true);
    }
  });
});

describe("DO DML catalogue execution (#4385)", () => {
  const NOW = "2026-10-15T00:00:00.000Z";

  function storageWith(table: string): SqliteTestStorage {
    const storage = new SqliteTestStorage();
    storage.exec(doTableSql(table));
    return storage;
  }

  it("DiscoveryAlert: count / insert / list round-trip through the catalogue", () => {
    const storage = storageWith("mas_discovery_alerts");
    const record = {
      id: "a1", run_id: "r1", scope_key: "s1", symbol: "AAPL", thesis: "bullish",
      score: 80, day: "2026-10-15", evidence: "e", fired_signals: "[]", created_at: NOW,
    };
    executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_alerts.insert", { record });
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_alerts.has", {
        where: { scope_key: "s1", symbol: "AAPL", thesis: "bullish", day: "2026-10-15" },
      }),
    ).toBe(1);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_alerts.count_day", {
        where: { scope_key: "s1", day: "2026-10-15" },
      }),
    ).toBe(1);
    const rows = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_alerts.list",
      { where: { scope_key: "s1" }, orderBy: "created_at DESC, id DESC", limit: 25 },
    );
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
  });

  it("DiscoveryRun + DiscoverySetup: insert / get / list / count / prune through the catalogue", () => {
    for (const [table, insertCode, getCode, listCode, countCode, pruneAgeCode, pruneCapCode] of [
      ["mas_discovery_runs", "dml.do.mas_discovery_runs.insert", "dml.do.mas_discovery_runs.get", "dml.do.mas_discovery_runs.list", "dml.do.mas_discovery_runs.count", "dml.do.mas_discovery_runs.prune_age", "dml.do.mas_discovery_runs.prune_cap"],
      ["mas_discovery_setup_runs", "dml.do.mas_discovery_setup_runs.insert", "dml.do.mas_discovery_setup_runs.get", "dml.do.mas_discovery_setup_runs.list", "dml.do.mas_discovery_setup_runs.count", "dml.do.mas_discovery_setup_runs.prune_age", "dml.do.mas_discovery_setup_runs.prune_cap"],
    ] as const) {
      const storage = storageWith(table);
      const record: Record<string, unknown> =
        table === "mas_discovery_runs"
          ? { id: "d1", created_at: NOW, status: "completed", user_login: null, summary_json: '{"id":"d1"}', run_json: '{"requests":[]}' }
          : { id: "d1", created_at: NOW, scope_key: "k", user_login: null, run_json: '{"id":"d1"}' };
      executeDoDml(DO_DML_CATALOGUE, storage, insertCode, { record });
      expect(executeDoDml<number>(DO_DML_CATALOGUE, storage, countCode, {})).toBe(1);
      const row = executeDoDml<Record<string, unknown> | null>(
        DO_DML_CATALOGUE, storage, getCode, { id: "d1" },
      );
      expect(row?.run_json).toBe(record.run_json);
      const listed = executeDoDml<Array<Record<string, unknown>>>(
        DO_DML_CATALOGUE, storage, listCode,
        { userLogin: null, limit: 25, offset: 0 },
      );
      expect(listed).toHaveLength(1);
      if (table === "mas_discovery_setup_runs") {
        const scoped = executeDoDml<Array<Record<string, unknown>>>(
          DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_setup_runs.list_scoped",
          { userLogin: null, scopeKey: "k", limit: 25, offset: 0 },
        );
        expect(scoped).toHaveLength(1);
        const scopedMiss = executeDoDml<Array<Record<string, unknown>>>(
          DO_DML_CATALOGUE, storage, "dml.do.mas_discovery_setup_runs.list_scoped",
          { userLogin: null, scopeKey: "other", limit: 25, offset: 0 },
        );
        expect(scopedMiss).toHaveLength(0);
      }
      expect(
        executeDoDml(DO_DML_CATALOGUE, storage, pruneAgeCode, {
          where: { created_at: { $lt: "2026-01-01T00:00:00.000Z" } },
        }),
      ).toBe(0);
      expect(executeDoDml<number>(DO_DML_CATALOGUE, storage, countCode, {})).toBe(1);
      executeDoDml(DO_DML_CATALOGUE, storage, pruneCapCode, { maxRows: 1 });
      expect(executeDoDml<number>(DO_DML_CATALOGUE, storage, countCode, {})).toBe(1);
      executeDoDml(DO_DML_CATALOGUE, storage, pruneAgeCode, {
        where: { created_at: { $lt: "2999-01-01T00:00:00.000Z" } },
      });
      expect(executeDoDml<number>(DO_DML_CATALOGUE, storage, countCode, {})).toBe(0);
    }
  });

  it("Enrichment: insert / list / get through the catalogue", () => {
    const storage = storageWith("mas_enrichment_runs");
    executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_enrichment_runs.insert_run", {
      record: { id: "e1", created_at: NOW, job_id: "j1", stage: "done", record_json: '{"id":"e1"}' },
    });
    const rows = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_enrichment_runs.list_runs",
      { orderBy: "created_at DESC, id DESC", limit: 20 },
    );
    expect(rows.map((r) => r.id)).toEqual(["e1"]);
    const row = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_enrichment_runs.get_run", { id: "e1" },
    );
    expect(row?.record_json).toBe('{"id":"e1"}');
    expect(
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_enrichment_runs.get_run", { id: "nope" }),
    ).toBeNull();
  });

  it("FeedSnapshot + IndexList: insert / ids / latest / by-id / delete through the catalogue", () => {
    const feed = storageWith("mas_feed_snapshots");
    executeDoDml(DO_DML_CATALOGUE, feed, "dml.do.mas_feed_snapshots.insert", {
      record: {
        id: "f1", created_at: NOW, user_login: "alice", symbol: "AAPL", as_of: NOW,
        data_source: "x", snapshot_json: "{}", load_params_json: "{}",
      },
    });
    const ids = executeDoDml<Array<{ id: string }>>(
      DO_DML_CATALOGUE, feed, "dml.do.mas_feed_snapshots.ids",
      { where: { user_login: "alice", symbol: "AAPL" }, orderBy: "created_at DESC, id DESC" },
    );
    expect(ids.map((r) => r.id)).toEqual(["f1"]);
    const latest = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, feed, "dml.do.mas_feed_snapshots.latest",
      { where: { user_login: "alice", symbol: "AAPL" }, orderBy: "created_at DESC, id DESC", limit: 1 },
    );
    expect(latest.map((r) => r.id)).toEqual(["f1"]);
    const byId = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, feed, "dml.do.mas_feed_snapshots.by_id",
      { where: { user_login: "alice", id: "f1" } },
    );
    expect(byId?.id).toBe("f1");
    expect(
      executeDoDml(DO_DML_CATALOGUE, feed, "dml.do.mas_feed_snapshots.delete", { id: "f1" }),
    ).toBe(true);
    expect(
      executeDoDml(DO_DML_CATALOGUE, feed, "dml.do.mas_feed_snapshots.delete", { id: "f1" }),
    ).toBe(false);

    const index = storageWith("mas_index_lists");
    executeDoDml(DO_DML_CATALOGUE, index, "dml.do.mas_index_lists.insert", {
      record: {
        id: "i1", created_at: NOW, index_id: "SPX", snapshot_date: "2026-10-15",
        source: "s", source_label: "l", derived_from_holdings: 1, members_json: "[]",
      },
    });
    const indexIds = executeDoDml<Array<{ id: string }>>(
      DO_DML_CATALOGUE, index, "dml.do.mas_index_lists.ids",
      { where: { index_id: "SPX" }, orderBy: "created_at DESC, id DESC" },
    );
    expect(indexIds.map((r) => r.id)).toEqual(["i1"]);
    const indexLatest = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, index, "dml.do.mas_index_lists.latest",
      { where: { index_id: "SPX" }, orderBy: "created_at DESC, id DESC", limit: 1 },
    );
    expect(indexLatest.map((r) => r.id)).toEqual(["i1"]);
    expect(
      executeDoDml(DO_DML_CATALOGUE, index, "dml.do.mas_index_lists.delete", { id: "i1" }),
    ).toBe(true);
  });

  it("IvHistory: createOrIgnore / get / series / coverage / symbols through the catalogue", () => {
    const storage = storageWith("mas_iv_history");
    const record = {
      symbol: "AAPL", date: "2026-10-15", atm_iv: 0.3, spot: 100,
      expiry_date: "2026-11-20", dte: 36, collected_at: NOW, broker: "etrade",
    };
    expect(
      executeDoDml<boolean>(DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.insert", { record }),
    ).toBe(true);
    expect(
      executeDoDml<boolean>(DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.insert", { record }),
    ).toBe(false);
    const row = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.get",
      { where: { symbol: "AAPL", date: "2026-10-15" } },
    );
    expect(row?.atm_iv).toBe(0.3);
    const brokerRow = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.get_broker",
      { where: { symbol: "AAPL", date: "2026-10-15", broker: "etrade" } },
    );
    expect(brokerRow?.atm_iv).toBe(0.3);
    const series = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.series",
      { where: { symbol: "AAPL" }, orderBy: "date DESC" },
    );
    expect(series.map((r) => r.date)).toEqual(["2026-10-15"]);
    const brokerSeries = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.series_broker",
      { where: { symbol: "AAPL", broker: "etrade" }, orderBy: "date DESC" },
    );
    expect(brokerSeries.map((r) => r.date)).toEqual(["2026-10-15"]);
    const brokerLimited = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.series_broker_limit",
      { where: { symbol: "AAPL", broker: "etrade" }, orderBy: "date DESC", limit: 1 },
    );
    expect(brokerLimited).toHaveLength(1);
    const limited = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.series_limit",
      { where: { symbol: "AAPL" }, orderBy: "date DESC", limit: 1 },
    );
    expect(limited).toHaveLength(1);
    const coverage = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.coverage", { symbol: "AAPL" },
    );
    expect(coverage[0]?.count).toBe(1);
    const brokerCoverage = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.coverage_broker",
      { symbol: "AAPL", broker: "etrade" },
    );
    expect(brokerCoverage[0]?.count).toBe(1);
    const symbols = executeDoDml<Array<{ symbol: string }>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.symbols", {},
    );
    expect(symbols.map((r) => r.symbol)).toEqual(["AAPL"]);
    const brokerSymbols = executeDoDml<Array<{ symbol: string }>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_iv_history.symbols_broker", { broker: "etrade" },
    );
    expect(brokerSymbols.map((r) => r.symbol)).toEqual(["AAPL"]);
  });

  it("ScanRun: insert / get / update / count / prune through the catalogue", () => {
    const storage = storageWith("mas_opportunity_scans");
    executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.insert", {
      record: {
        id: "sc1", generated_at: NOW, mode: "m", model_version: "v1", user_login: null,
        schedule_id: null, async_job_id: null, workflow_id: null,
        summary_json: '{"id":"sc1"}', result_json: "{}",
      },
    });
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.count", {}),
    ).toBe(1);
    const row = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.get", { id: "sc1" },
    );
    expect(row?.summary_json).toBe('{"id":"sc1"}');
    const updated = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.update_pdf_key",
      { id: "sc1", updates: { summary_json: '{"id":"sc1","pdfKey":"k"}', result_json: '{"pdfKey":"k"}' } },
    );
    expect(updated?.summary_json).toBe('{"id":"sc1","pdfKey":"k"}');
    const linked = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.update_linkage",
      {
        id: "sc1",
        updates: { schedule_id: "s", async_job_id: "j", workflow_id: "w", summary_json: '{"id":"sc1"}' },
      },
    );
    expect(linked?.schedule_id).toBe("s");
    const listed = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.list",
      { userLogin: null, limit: 25, offset: 0 },
    );
    expect(listed).toHaveLength(1);
    executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.prune_age", {
      where: { generated_at: { $lt: "2999-01-01T00:00:00.000Z" } },
    });
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_opportunity_scans.count", {}),
    ).toBe(0);
  });

  it("StrategyProfile: insert / select / updateWhere / deleteWhere through the catalogue", () => {
    const storage = storageWith("mas_strategy_profiles");
    executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_strategy_profiles.insert", {
      record: {
        id: "p1", user_login: "alice", name: "Alpha", version: 1,
        spec_json: "{}", created_at: NOW, updated_at: NOW,
      },
    });
    const byUser = executeDoDml<Array<Record<string, unknown>>>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_strategy_profiles.select_by_user",
      { where: { user_login: "alice" } },
    );
    expect(byUser.map((r) => r.id)).toEqual(["p1"]);
    const byId = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_strategy_profiles.select_by_id",
      { where: { user_login: "alice", id: "p1" } },
    );
    expect(byId?.name).toBe("Alpha");
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_strategy_profiles.update", {
        where: { user_login: "alice", id: "p1" },
        set: { name: "Beta", version: 2, spec_json: '{"v":2}', updated_at: "2026-10-16T00:00:00.000Z" },
      }),
    ).toBe(1);
    const after = executeDoDml<Record<string, unknown> | null>(
      DO_DML_CATALOGUE, storage, "dml.do.mas_strategy_profiles.select_by_id",
      { where: { user_login: "alice", id: "p1" } },
    );
    expect(after?.name).toBe("Beta");
    expect(after?.version).toBe(2);
    expect(
      executeDoDml<number>(DO_DML_CATALOGUE, storage, "dml.do.mas_strategy_profiles.delete", {
        where: { user_login: "alice", id: "p1" },
      }),
    ).toBe(1);
    expect(
      executeDoDml(DO_DML_CATALOGUE, storage, "dml.do.mas_strategy_profiles.select_by_id", {
        where: { user_login: "alice", id: "p1" },
      }),
    ).toBeNull();
  });
});
