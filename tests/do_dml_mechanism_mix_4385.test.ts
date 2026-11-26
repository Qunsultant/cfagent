/**
 * #4385 (#4282 P6b) — DO mechanism-mix pin (ADR 0032 Decision 6).
 *
 * A mechanism-mix pin counts the mechanism mix per family, so
 * re-divergence fails CI. This sibling file (the census file is
 * 1,413 lines; the ADR allows a sibling) pins the DO family's mix
 * after the P6b first tranche:
 *
 *  - the 9 tranche files hold ZERO inline raw-DML statements;
 *  - the DO DML catalogue holds exactly 81 entries (64 repository +
 *    17 template) over the 9 tranche tables + the 5 ORM-core tables
 *    + the "__table__" parameterized placeholder (P6c, #4386) + the
 *    2 route-held tables (P6d, #4387: mas_job_outcomes_meta and
 *    mas_events, both template clears);
 *  - the remaining inline count is 235 (the 297-statement survey
 *    inventory on 1501f5f4, less the 53 migrated by P6b and the 16
 *    migrated by P6c, plus the 2 read sites #4507 added: the dedupe
 *    pair-scan and per-pair row-list SELECTs in
 *    doSqliteCanonicalReportStoreAdapter.ts — adapter-local
 *    reconciliation, not catalogue-migrated — plus the 1 read site
 *    #5235 added: the listAllWithDetail SELECT in
 *    doSqliteUsageEventAdapter.ts, the unfiltered meter read for
 *    the revenue-summary coverage cut — plus the 1 read site
 *    #3185 added: the listByTenant SELECT in
 *    doSqliteUsageEventAdapter.ts, the tenant-filtered meter read
 *    for the stamped tenantId — plus the 4 templates #3251
 *    added: the STMT_AUDIT_TABLE_* templates in
 *    doSessionStoreAdapter.ts, the parameterized path for the
 *    iaaa_audit_events append-only table) — plus the 4 statements
 *    #5175 slice 2 adds: the run-registry adapter's 2 INSERT + 2
 *    SELECT literals (doSqliteRunRegistryAdapter.ts) — a later
 *    slice moves this number down and updates this pin in the
 *    same PR; issue #6101 moves it down 255 → 248: the two deleted
 *    DO adapters (doSqliteJobRunRecordAdapter.ts,
 *    doSqliteJobStageEventAdapter.ts) take their 3 writes + 4 reads
 *    with them; the D1 writers replace them.
 *  - the named exemptions are recorded here with their reasons
 *    (Q4): the doSchema* ledger (5) and the kv_store funnel (11);
 *  - the P6c boundary is CLOSED by #4386: doSqliteOrmAdapters.ts
 *    holds ZERO inline statements (its 16 went with P6c, Q5).
 *
 * The scan rule is the survey's, made explicit (the same rule as
 * evidence-p6b/scan-do-dml.mjs): strip block + line comments, then
 * count string literals whose first keyword is INSERT / UPDATE /
 * DELETE / REPLACE (write) or SELECT (read). One constant = one
 * statement even when concatenated across literals.
 *
 * Baseline: evidence-p6b/scan-do-dml-1501f5f4.txt (52 files,
 * 142 write / 155 read = 297).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DO_DML_CATALOGUE } from "../src/data/schemaComponent/doDmlCatalogue";

const DO_DIR = "src/data";

function doFiles(): string[] {
  return readdirSync(DO_DIR)
    .filter(
      (f) =>
        (f.startsWith("doSqlite") || f.startsWith("doSession") || f.startsWith("doSchema")) &&
        f.endsWith(".ts"),
    )
    .sort()
    .map((f) => `${DO_DIR}/${f}`);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'A-Za-z0-9_])\/\/.*$/gm, "$1");
}

const WRITE_PATTERN = /[`'"]\s*(INSERT|UPDATE|DELETE|REPLACE)\b/g;
const READ_PATTERN = /[`'"]\s*SELECT\b/g;

function scanFile(file: string): { write: number; read: number } {
  const source = stripComments(readFileSync(file, "utf8"));
  return {
    write: (source.match(WRITE_PATTERN) ?? []).length,
    read: (source.match(READ_PATTERN) ?? []).length,
  };
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

const TRANCHE_TABLES = [
  "mas_discovery_alerts",
  "mas_discovery_runs",
  "mas_discovery_setup_runs",
  "mas_enrichment_runs",
  "mas_feed_snapshots",
  "mas_index_lists",
  "mas_iv_history",
  "mas_opportunity_scans",
  "mas_strategy_profiles",
];

/**
 * Named exemptions (Q4) — recorded with their reasons, not
 * catalogue entries. The counts are the survey's per-file counts;
 * the pin fails if the exempted files gain (or lose) statements
 * without this record changing in the same PR.
 */
const NAMED_EXEMPTIONS: Array<{
  file: string;
  write: number;
  read: number;
  reason: string;
}> = [
  {
    file: "src/data/doSchemaMarker.ts",
    write: 1,
    read: 1,
    reason:
      "schema-marker ledger: the substrate the catalogues stand on — its statements must run before any catalogue can be consulted (a catalogue entry for the ledger would be self-referential).",
  },
  {
    file: "src/data/doSchemaMigrations.ts",
    write: 2,
    read: 1,
    reason:
      "schema-migrations ledger: same substrate reason as the marker — the migration ledger runs before the catalogue exists.",
  },
  {
    file: "src/data/doSessionStoreAdapter.ts",
    write: 4,
    read: 7,
    reason:
      "kv_store funnel: the session store's generic key/value funnel writes through one parameterized path for all session families; cataloguing it per family would fork the funnel. The audit-table templates (STMT_AUDIT_TABLE_TAIL/COUNT/INSERT/LIST, #3251) are the same file's parameterized path for the iaaa_audit_events table.",
  },
];

describe("DO mechanism mix (#4385)", () => {
  it("the 9 tranche files hold zero inline raw-DML statements", () => {
    const hits: string[] = [];
    for (const file of TRANCHE_FILES) {
      const { write, read } = scanFile(file);
      if (write + read > 0) hits.push(`${file}: write=${write} read=${read}`);
    }
    expect(hits, "inline DML survives in a tranche file").toEqual([]);
  });

  it("the catalogue holds the tranche + the ORM core + the route-held pair + P6e: 83 entries", () => {
    expect(DO_DML_CATALOGUE.size()).toBe(83);
    for (const table of TRANCHE_TABLES) {
      expect(DO_DML_CATALOGUE.findByTable(table).length, table).toBeGreaterThan(0);
    }
    const forms = DO_DML_CATALOGUE.entries().reduce(
      (acc, e) => ({ ...acc, [e.form]: (acc[e.form] ?? 0) + 1 }),
      {} as Record<string, number>,
    );
    expect(forms.repository).toBe(64);
    expect(forms.template).toBe(19);
  });

  it("repository-bound tables: 9 tranche + 5 ORM-core + 1 parameterized = 15", () => {
    // The 5 ORM-core tables with catalogue entries are the 4
    // Repository-bound ones P6c migrated (messages, events,
    // memory, transactions) plus mas_settings (its port is not
    // Repository-bound, but its entries are repository-form).
    // The remaining 9 Repository-bound tables (mas_reports + the
    // 8 factories) stay plain Repository calls — no inline DML
    // of their own; their statements live in ormRepositoryCore,
    // census-pinned at 9 exec sites.
    const catalogueTables = new Set(
      DO_DML_CATALOGUE.entries()
        .filter((e) => e.form === "repository")
        .map((e) => e.table),
    );
    expect([...catalogueTables].sort()).toEqual(
      [...TRANCHE_TABLES, "mas_events", "mas_memory", "mas_messages", "mas_settings", "mas_transactions", "__table__"].sort(),
    );
    expect(catalogueTables.size).toBe(15);
  });

  it("template-only tables are exactly the 9 with inexpressible shapes", () => {
    const templateTables = new Set(
      DO_DML_CATALOGUE.entries()
        .filter((e) => e.form === "template")
        .map((e) => e.table),
    );
    expect([...templateTables].sort()).toEqual([
      "mas_autopilot",
      "mas_discovery_runs",
      "mas_discovery_setup_runs",
      "mas_events",
      "mas_iv_history",
      "mas_job_outcomes_meta",
      "mas_memory",
      "mas_opportunity_scans",
      "mas_transactions",
    ]);
  });

  it("the remaining inline count is 248 (255 − 3 #6101 writes − 4 #6101 reads: the two deleted DO adapters take their literals with them; the D1 writers replace them)", () => {
    let write = 0;
    let read = 0;
    for (const file of doFiles()) {
      const counts = scanFile(file);
      write += counts.write;
      read += counts.read;
    }
    expect(write).toBe(120);
    expect(read).toBe(128);
    expect(write + read).toBe(248);
  });

  it("the named exemptions hold their recorded counts, with reasons", () => {
    let exemptTotal = 0;
    for (const exemption of NAMED_EXEMPTIONS) {
      expect(exemption.reason.length, `${exemption.file} must record a reason`).toBeGreaterThan(0);
      const { write, read } = scanFile(exemption.file);
      expect(write, `${exemption.file} write`).toBe(exemption.write);
      expect(read, `${exemption.file} read`).toBe(exemption.read);
      exemptTotal += write + read;
    }
    expect(exemptTotal).toBe(16);
  });

  it("the P6c boundary is closed: doSqliteOrmAdapters.ts holds zero inline statements", () => {
    const { write, read } = scanFile("src/data/doSqliteOrmAdapters.ts");
    expect(write).toBe(0);
    expect(read).toBe(0);
  });
});
