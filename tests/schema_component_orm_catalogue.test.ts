/**
 * #4282 P2a — ORM + index-schema catalogue: the shared mas_* tables,
 * the ORM-only tables, and the index-schema modules delegate to the
 * catalogue.
 *
 * The catalogue is the ORM/index plane's single home for statement
 * text; ormSchema.ts, ormFacade.ts, and the four index-schema modules
 * assemble their DDL from its codes and remain the executors
 * (delegation, not absorption).
 *
 * Anchors (measured from the base helpers at 4161aaad, before the
 * delegation — never re-derived from the delegated helpers):
 *  - ORM_STATEMENT_SHA256: sha256 of each catalogue entry's
 *    statement. A change to any statement's text — a column, a
 *    DEFAULT, even whitespace — fails this pin. The statements are
 *    byte-identical to the base helpers' executed strings, including
 *    the leading/trailing whitespace of the ormSchema/ormFacade
 *    template literals.
 *  - The expected-model fixture
 *    (tests/schema_component_orm_expected_model.json): the ORM +
 *    index-schema model built by executing the 26 base statements
 *    through the P0 InMemorySchemaInstance — 13 tables, 10 indexes.
 *    Regenerate only with the generator script
 *    ~/workspace/w4282/evidence-p2a/gen-orm-catalogue.ts run against
 *    the base tree, and review the refreshed fixture in the PR diff:
 *    a refresh that changes an existing table without a migration is
 *    a defect, not a cleanup (same discipline as the grep baseline).
 *
 * Scope correction (measured on the tip, not the filing counts):
 * 22 statements at #4282, not the filed ~15; 24 since #4412
 * restored the mas_promotions table + index; 26 since #3182
 * added the mas_transactions tenant column's ALTER + index. The filing's "12 INDEX" is a
 * grep count — 4 of the 12 lines are comment mentions, so the
 * executable index count is 8 — and the filing never counted the 2
 * audit-chain ALTERs that ensureAuditChainColumns executes. The 2
 * guarded mas_trades ALTERs (broker, price_source) stay inline in
 * ormFacade.initializeSchema until P3's reconciliation catalogue;
 * they are asserted as the only remaining inline DDL in the
 * delegated files.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  SHARED_MAS_TABLES,
  ensureSharedTable,
  ensureSharedTables,
  ensureAuditChainColumns,
} from "../src/data/ormSchema";
import {
  FRAMEWORK_QUEUE_INDEXES,
  ensureFrameworkQueueIndexes,
} from "../src/data/frameworkQueueIndexSchema";
import { ensureMasRetentionIndexes } from "../src/data/masRetentionIndexSchema";
import {
  UNIFIED_SCHEDULE_INDEXES,
  ensureUnifiedScheduleIndexes,
} from "../src/data/unifiedScheduleIndexSchema";
import {
  JOB_RUN_RECORD_INDEXES,
  ensureJobRunRecordIndexes,
} from "../src/data/jobRunRecordIndexSchema";
import {
  ORM_CATALOGUE,
  ORM_CATALOGUE_ENTRIES,
  buildOrmCatalogue,
  ormAuditChainAlterSql,
  ormIndexSql,
  ormTableSql,
} from "../src/data/schemaComponent/ormCatalogue";
import { validateCatalogueEntry } from "../src/data/schemaComponent/catalogue";
import {
  runEqualityCheck,
  type SchemaModel,
} from "../src/data/schemaComponent/equalityHarness";

/** sha256 of each catalogue entry's statement, measured from the base helpers. */
const ORM_STATEMENT_SHA256: Record<string, string> = {
  "schema.orm.mas_messages.create_table":
    "53e0d3f2ccbf8828758eae0bd3dfa7a51fa8c3176f7f6ba440439cc23426d4e5",
  "schema.orm.mas_events.create_table":
    "da6ca299b5b87fc74fddc7c504ed1dd96528006ce9e5b13697adeab9d37304ab",
  "schema.orm.mas_memory.create_table":
    "04722ed1c8de3e23e459fe2b14bf610c2965713878b6cd07ff116a09d1c2349e",
  "schema.orm.mas_referrals.create_table":
    "dac0425ec9aa29e1b2e7cf556dc5a6f5486af5469a62066467b1c5c37cae56da",
  "schema.orm.mas_ads.create_table":
    "8c3f99cd7add375ace503346113dcc63eaac3cdfda91a7e08df6dd9414821262",
  "schema.orm.mas_watchlists.create_table":
    "d1e45f58b918782a42844360638df5e37b475971fa7fca481c1e4d6596db3a77",
  "schema.orm.mas_transactions.create_table":
    "d37a4dda803eb8cc866ef2addd0c40ac52bf6405641ab1845225e0e7fba0f7b7",
  "schema.orm.mas_promotions.create_table":
    "7fb0e867c8891cb42a0f3abd99356b6243b104d66c839672ed6f39e3968d5ef5",
  "schema.orm.mas_events.alter_table_add_column_previous_event_hash":
    "9023001ed24d883d5009321d097984444b4a3ef732ecd483b2eeacbe6dcefb3d",
  "schema.orm.mas_events.alter_table_add_column_event_hash":
    "76bb4c99838e942e284484a2af3a5f6117573f8c584b922536c3278de484144f",
  "schema.orm.mas_transactions.alter_table_add_column_tenant_id":
    "a3b2b0a3d5d21fa0a6432cc86c564632d910f205239f251ba412600ca4fb365c",
  "schema.orm.mas_categories.create_table":
    "6687d9d035565abcd5ce7321a53df741dc5016a2a674101fc89ce03259a63821",
  "schema.orm.mas_external_ads.create_table":
    "bb4b61889c33cea0ddf2f2d550a6e6f12e6b714924922dafde3bf91753184c76",
  "schema.orm.webhook_replay_nonces.create_table":
    "6c097641c5a146633087861629801f82c6dea5e8f2bb80eb6f8db5988f14663a",
  "schema.orm.mas_trades.create_table":
    "d0be11fa5cf5c95b1d0ce0ed0379bf2c8bcbac22203fb62011e9b2f50f7fc0b9",
  "schema.orm.mas_options_chain_cache.create_table":
    "564070bddebdf12b90ef3a0401524f3ec234f83177e17e1cdafbc15a1d32e359",
  "schema.index.cf_agents_jobs.create_index_idx_cf_agents_jobs_time":
    "a2ec9c88f201f7117089a754196fff285f9507a0da674a47a139b10688330aa9",
  "schema.index.cf_agents_jobs.create_index_idx_cf_agents_jobs_exclusive_time":
    "01ace652f1cde26f87fbfc822b0c0e08a99825e2082042f52f26220d288ad552",
  "schema.index.cf_agents_jobs.create_index_idx_cf_agents_jobs_singleflight_running":
    "4023af68878e9b6ca500402c85eacfc4d6f4c4c68eda58d9a9c977fde1e1750b",
  "schema.index.mas_messages.create_index_idx_mas_messages_created":
    "c51e353c6efd17f12219808995e6454cace3b73a0f506ae645edf0c8639e5e26",
  "schema.index.mas_events.create_index_idx_mas_events_created":
    "3a2d55abeb93c43f3f20c2a12d7b12e5130a30ced30161ee29517b6a9e001869",
  "schema.index.mas_events.create_index_idx_mas_events_session_type":
    "794107ce1a6f887f0440b46f16be7bddda8438d2aeea0548d448d37009339c4a",
  "schema.index.mas_transactions.create_index_idx_mas_transactions_tenant_id":
    "558714cbe75842e8f123303d5b0762b5b73dcc829c03024656246b6cef1f4da9",
  "schema.index.unified_schedules.create_index_unified_schedules_created_idx":
    "02d02f32fdd8806de25d59e50690446684fc9c4ead6e7d62cca62aedebe12fbc",
  "schema.index.job_run_records.create_index_job_run_records_recent_idx":
    "d6b0db67c1df36730a3685431968a9ba486a8a5e972aa9652c220add27bafd5a",
  "schema.index.mas_promotions.create_index_idx_promotions_candidate":
    "d1774d012a9898a740590ca8cc96bcb92383106e31b361e7b5d0aa5976082fca",
};

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema_component_orm_expected_model.json",
);

function expectedOrmModel(): SchemaModel {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as SchemaModel;
}

/** MockSqlStorage that records every statement it is asked to execute. */
class RecordingSqlStorage extends MockSqlStorage {
  readonly queries: string[] = [];
  override exec(query: string, ...args: unknown[]): Iterable<unknown> {
    this.queries.push(query);
    return super.exec(query, ...args);
  }
}

describe("ORM + index-schema catalogue — helpers delegate (#4282 P2a)", () => {
  it("catalogues all 26 ORM/index statements: 13 CREATE TABLE + 3 ALTER TABLE + 10 CREATE INDEX", () => {
    const catalogue = buildOrmCatalogue();
    expect(ORM_CATALOGUE_ENTRIES.length).toBe(26);
    expect(catalogue.size()).toBe(26);
    expect(catalogue.byKind("schema").length).toBe(26);
    const verbs = new Map<string, number>();
    const classify = (statement: string): string => {
      const upper = statement.trim().toUpperCase();
      for (const verb of [
        "CREATE UNIQUE INDEX",
        "CREATE TABLE",
        "CREATE INDEX",
        "ALTER TABLE",
      ]) {
        if (upper.startsWith(verb)) return verb;
      }
      return "OTHER";
    };
    for (const entry of ORM_CATALOGUE_ENTRIES) {
      const validation = validateCatalogueEntry(entry);
      expect(validation.valid).toBe(true);
      const verb = classify(entry.statement);
      verbs.set(verb, (verbs.get(verb) ?? 0) + 1);
    }
    expect(verbs.get("CREATE TABLE")).toBe(13);
    expect(verbs.get("CREATE INDEX")).toBe(10);
    expect(verbs.get("ALTER TABLE")).toBe(3);
    expect(verbs.get("OTHER")).toBeUndefined();
    // Every code is unique and every entry is reachable by its code.
    const codes = new Set(ORM_CATALOGUE_ENTRIES.map((e) => e.code));
    expect(codes.size).toBe(26);
    for (const entry of ORM_CATALOGUE_ENTRIES) {
      expect(catalogue.get(entry.code).statement).toBe(entry.statement);
    }
    // Planes: ORM tables on "orm", indexes on "index".
    expect(
      ORM_CATALOGUE_ENTRIES.filter((e) => e.plane === "orm").length,
    ).toBe(16);
    expect(
      ORM_CATALOGUE_ENTRIES.filter((e) => e.plane === "index").length,
    ).toBe(10);
  });

  it("each entry's statement is byte-identical to the base (sha256 pin)", () => {
    expect(Object.keys(ORM_STATEMENT_SHA256).length).toBe(26);
    for (const entry of ORM_CATALOGUE_ENTRIES) {
      const digest = createHash("sha256")
        .update(entry.statement, "utf8")
        .digest("hex");
      expect(digest, entry.code).toBe(ORM_STATEMENT_SHA256[entry.code]);
    }
  });

  it("equality pin: the catalogue builds the base ORM + index schema exactly", async () => {
    const catalogue = buildOrmCatalogue();
    const expected = expectedOrmModel();
    expect(Object.keys(expected.tables).length).toBe(13);
    expect(Object.keys(expected.indexes).length).toBe(10);
    const { diff, report } = await runEqualityCheck(catalogue, expected);
    expect(report).toBe(
      "schema diff: no differences — the catalogue-built schema equals the expected schema",
    );
    expect(diff.missingTables).toEqual([]);
    expect(diff.extraTables).toEqual([]);
    expect(diff.missingIndexes).toEqual([]);
    expect(diff.extraIndexes).toEqual([]);
    expect(diff.missingColumns).toEqual([]);
    expect(diff.extraColumns).toEqual([]);
    expect(diff.changedColumns).toEqual([]);
    expect(diff.changedIndexes).toEqual([]);
    expect(diff.missingConstraints).toEqual([]);
    expect(diff.extraConstraints).toEqual([]);
  });

  it("ensureSharedTable / ensureSharedTables execute exactly the catalogue CREATEs", () => {
    const rec = new RecordingSqlStorage();
    for (const table of SHARED_MAS_TABLES) {
      ensureSharedTable(rec, table);
    }
    expect(rec.queries).toEqual(
      [...SHARED_MAS_TABLES].map((t) => ormTableSql(t)),
    );
    const recAll = new RecordingSqlStorage();
    ensureSharedTables(recAll);
    expect(recAll.queries).toEqual(rec.queries);
  });

  it("ensureAuditChainColumns executes exactly the catalogue ALTERs", () => {
    const rec = new RecordingSqlStorage();
    ensureAuditChainColumns(rec);
    // The helper first probes with PRAGMA table_info; only the ALTERs
    // are catalogue statements.
    const alters = rec.queries.filter((q) =>
      q.trim().startsWith("ALTER TABLE"),
    );
    expect(alters).toEqual([
      ormAuditChainAlterSql("previous_event_hash"),
      ormAuditChainAlterSql("event_hash"),
    ]);
  });

  it("DatabaseORM.initializeSchema executes exactly the catalogue CREATEs for its 13 tables", () => {
    const rec = new RecordingSqlStorage();
    const orm = new DatabaseORM(rec);
    orm.initializeSchema("orm-catalogue-pin");
    const creates = rec.queries.filter((q) =>
      q.trim().startsWith("CREATE TABLE"),
    );
    // 8 shared + 5 ORM-only from the catalogue; mas_reports stays in
    // its service (issue #389) and is the only other CREATE here.
    const catalogueCreates = creates.filter((q) => !q.includes("mas_reports"));
    expect(catalogueCreates).toHaveLength(13);
    expect(new Set(catalogueCreates).size).toBe(13);
    for (const sql of catalogueCreates) {
      expect(
        ORM_CATALOGUE_ENTRIES.some((e) => e.statement === sql),
        sql.slice(0, 60),
      ).toBe(true);
    }
    // The only ALTERs initializeSchema still executes inline are the
    // 2 guarded mas_trades reconciliations (P3's scope) plus the 11
    // mas_reports reconciliation ALTERs that ensureScheduledReportsTable
    // owns (issue #389 — the service is mas_reports' single source).
    // Asserted here so a third inline ALTER cannot creep in unnoticed.
    const alters = rec.queries.filter((q) =>
      q.trim().startsWith("ALTER TABLE"),
    );
    const inlineAlters = alters.filter(
      (q) => !ORM_CATALOGUE_ENTRIES.some((e) => e.statement === q),
    );
    const masTradesInline = inlineAlters.filter((q) =>
      q.includes("ALTER TABLE mas_trades"),
    );
    const masReportsInline = inlineAlters.filter((q) =>
      q.includes("ALTER TABLE mas_reports"),
    );
    expect(masTradesInline).toEqual([
      "ALTER TABLE mas_trades ADD COLUMN broker TEXT",
      "ALTER TABLE mas_trades ADD COLUMN price_source TEXT",
    ]);
    expect(masReportsInline).toHaveLength(11);
    expect(inlineAlters).toHaveLength(13);
  });

  it("the four index-schema modules execute exactly the catalogue CREATE INDEX statements", () => {
    const rec = new RecordingSqlStorage();
    ensureFrameworkQueueIndexes(rec);
    ensureMasRetentionIndexes(rec);
    ensureUnifiedScheduleIndexes(rec);
    ensureJobRunRecordIndexes(rec);
    const creates = rec.queries.filter((q) =>
      q.trim().startsWith("CREATE INDEX"),
    );
    expect(creates).toHaveLength(8);
    expect(new Set(creates).size).toBe(8);
    for (const sql of creates) {
      expect(
        ORM_CATALOGUE_ENTRIES.some((e) => e.statement === sql),
        sql.slice(0, 60),
      ).toBe(true);
    }
    // The exported index arrays are built from the same catalogue
    // entries, so callers reading them see identical SQL.
    expect(FRAMEWORK_QUEUE_INDEXES.map((i) => i.sql)).toEqual([
      ormIndexSql("idx_cf_agents_jobs_time"),
      ormIndexSql("idx_cf_agents_jobs_exclusive_time"),
      ormIndexSql("idx_cf_agents_jobs_singleflight_running"),
    ]);
    expect(UNIFIED_SCHEDULE_INDEXES.map((i) => i.sql)).toEqual([
      ormIndexSql("unified_schedules_created_idx"),
    ]);
    expect(JOB_RUN_RECORD_INDEXES.map((i) => i.sql)).toEqual([
      ormIndexSql("job_run_records_recent_idx"),
    ]);
  });

  it("no inline DDL remains in the delegated files except the 2 P3 mas_trades ALTERs", () => {
    const srcRoot = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
    );
    const files = [
      "data/ormSchema.ts",
      "data/ormFacade.ts",
      "data/frameworkQueueIndexSchema.ts",
      "data/masRetentionIndexSchema.ts",
      "data/unifiedScheduleIndexSchema.ts",
      "data/jobRunRecordIndexSchema.ts",
    ];
    const inline: string[] = [];
    const ddlPattern =
      /CREATE TABLE IF NOT EXISTS \w+|CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+|ALTER TABLE \w+ ADD COLUMN/;
    for (const file of files) {
      const lines = readFileSync(path.join(srcRoot, file), "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        // Comment mentions (header prose) are not statements.
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        if (ddlPattern.test(line)) {
          inline.push(`${file}: ${trimmed}`);
        }
      }
    }
    expect(inline).toEqual([
      'data/ormFacade.ts: this.sql.exec("ALTER TABLE mas_trades ADD COLUMN broker TEXT");',
      'data/ormFacade.ts: this.sql.exec("ALTER TABLE mas_trades ADD COLUMN price_source TEXT");',
    ]);
  });
});
