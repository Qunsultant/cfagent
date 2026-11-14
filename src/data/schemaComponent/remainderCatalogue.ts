/**
 * #4282 P3 — remainder catalogue: the long tail of DDL the P2a/P2b
 * delegations left behind, plus the ALTER reconciliation set and
 * the parameterized entry forms.
 *
 * The catalogue is the single home for statement text for the
 * statements below; the adapters, services, and stores that
 * execute them assemble their DDL from its codes and remain the
 * executors (delegation, not absorption). The DO execution idiom
 * is unchanged: `this.sql.exec(...)` against the DO SqlStorage
 * handle, with the catalogue statement as the argument; the D1
 * adapters keep their `prepare(...).run()` / `.bind().run()`
 * shape with the catalogue statement as the argument.
 *
 * Scope (re-measured on the base tree dd6df86a, not the filing
 * counts): 51 entries — 8 table statements, 2 index statements,
 * 39 reconciliation statements, 1 drop statement, 1 seed-form
 * entry. The filing's "~26 statements across ~17 files" was a
 * grep count: the 95 ALTER lines the census named are 39
 * distinct reconciliation statements (the rest are the same
 * statement executed once per trigger, or prose mentions), and
 * 6 D1-adapter tables delegate to entries that already exist
 * (mas_index_lists in the DO catalogue; quote_source_setting and
 * the three resource tables in the D1 catalogue).
 *
 * Ordering (the phase's reconciliation rule): entries are grouped
 * by table, and within a table the base CREATE comes first, then
 * the ALTERs in execution order, then the indexes, then the DROP.
 * The mas_reports CREATE and plain indexes live in the DO
 * catalogue; the remainder catalogue holds only its generic
 * ALTER and its DROP, so the full mas_reports order across
 * catalogues is: DO CREATE -> remainder ALTER (x11) -> DO plain
 * indexes -> remainder DROP -> DO unique index. The recreate
 * planner (P4) composes the sections in that order.
 *
 * The two frozen JobPipeline v1 copies are history, never the
 * live consts: the instances copy predates the run_schedule_id /
 * run_async_job_id columns (it is the 0046 shape), while the
 * legacy ensure path executes the live consts and the two
 * probed ALTERs converge an existing table. Their sha256 pins
 * match the DO suite's FROZEN_* constants.
 *
 * The two generic ALTER templates are parameterized so one entry
 * covers every concrete execution: mas_reports on ${TABLE} /
 * ${column} / ${type} (11 columns), mas_report_confirmations on
 * ${column} / ${type} (2 columns). The DROP is parameterized on
 * ${TABLE} because it names the index, not the table — a literal
 * entry must name its table verbatim, and the index name derives
 * from the table by convention (idx_${TABLE}_generation).
 *
 * The seed entry (orchestratorMigration INSERT OR REPLACE) defines
 * the entry FORM only: its parameters are the call site's own
 * assembly (table, cols.join(", "), placeholders). The DML half
 * lands in P6d; no DML site moves in P3.
 *
 * Code naming (`<kind>.<plane>.<table>.<action>`), mirroring the
 * DO catalogue:
 *  - table statement: `create_table` (plane \"do\" / \"d1\");
 *    the frozen v1 copies are `create_table_v1`.
 *  - index statement: `create_index_<index-name>` (plane
 *    \"index\").
 *  - reconciliation statement:
 *    `alter_table_add_column_<column>` (plane of the table).
 *  - generic reconciliation: `alter_table_add_column` (no column
 *    suffix — the column is a parameter).
 *  - drop statement: `drop_index_<index-name>` (plane \"index\").
 *  - seed form: `insert_or_replace` (kind \"seed\", plane
 *    \"route\").
 *
 * Anchors (measured from the base helpers at dd6df86a, before the
 * delegation — never re-derived from the delegated helpers): the
 * sha256 map in tests/schema_component_remainder_catalogue.test.ts
 * pins every entry's statement byte-for-byte, and the
 * expected-model fixture
 * (tests/schema_component_remainder_expected_model.json) pins the
 * schema the catalogue builds on top of the DO / D1 / ORM base
 * CREATEs.
 */
import type { CatalogueEntry } from "./catalogueTypes";
import { createCatalogue, type SchemaCatalogue } from "./catalogue";
import { resolveStatementText } from "./executor";

/** The remainder section: every statement in scope, in code order. */
export const REMAINDER_CATALOGUE_ENTRIES: CatalogueEntry[] = [
  {
    code: "schema.do.job_pipeline_definitions.create_table_v1",
    plane: "do",
    table: "job_pipeline_definitions",
    statement: `CREATE TABLE IF NOT EXISTS job_pipeline_definitions (
      job_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_pipeline_instances.create_table_v1",
    plane: "do",
    table: "job_pipeline_instances",
    statement: `CREATE TABLE IF NOT EXISTS job_pipeline_instances (
      job_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      desired_state TEXT NOT NULL,
      current_run_id TEXT,
      run_started_at TEXT,
      run_trigger TEXT,
      checkpoint_json TEXT,
      stage_checkpoint_json TEXT,
      stage_desired_json TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_pipeline_instances.alter_table_add_column_run_async_job_id",
    plane: "do",
    table: "job_pipeline_instances",
    statement: `ALTER TABLE job_pipeline_instances ADD COLUMN run_async_job_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_pipeline_instances.alter_table_add_column_run_schedule_id",
    plane: "do",
    table: "job_pipeline_instances",
    statement: `ALTER TABLE job_pipeline_instances ADD COLUMN run_schedule_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_async_job_id",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN async_job_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_broker_id",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN broker_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_data_provider_id",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN data_provider_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_mode",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN mode TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_mode_source",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN mode_source TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_schedule_id",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN schedule_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_trigger_text",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN trigger_text TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_run_records.alter_table_add_column_workflow_id",
    plane: "do",
    table: "job_run_records",
    statement: `ALTER TABLE job_run_records ADD COLUMN workflow_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_chain_id",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN chain_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_channel",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN channel TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_error_code",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN error_code TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_job_kind",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'main'`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_last_activity_at",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN last_activity_at TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_not_before",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN not_before TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_parent_job_id",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN parent_job_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_schedule_id",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN schedule_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_stage",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN stage TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_stuck_alerted_at",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN stuck_alerted_at TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_trigger",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN trigger TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.alter_table_add_column_triggered_by",
    plane: "do",
    table: "mas_async_jobs",
    statement: `ALTER TABLE mas_async_jobs ADD COLUMN triggered_by TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_cancel_previews.create_table",
    plane: "do",
    table: "mas_cancel_previews",
    statement: `CREATE TABLE IF NOT EXISTS mas_cancel_previews (token TEXT PRIMARY KEY, ids_json TEXT, created_at TEXT, expires_at TEXT, used_at TEXT)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_data_captures.alter_table_add_column_failure_kind",
    plane: "do",
    table: "mas_data_captures",
    statement: `ALTER TABLE mas_data_captures ADD COLUMN failure_kind TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_data_captures.alter_table_add_column_failure_message",
    plane: "do",
    table: "mas_data_captures",
    statement: `ALTER TABLE mas_data_captures ADD COLUMN failure_message TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_data_provider_routes.alter_table_add_column_min_tier",
    plane: "do",
    table: "mas_data_provider_routes",
    statement: `ALTER TABLE mas_data_provider_routes ADD COLUMN min_tier TEXT NOT NULL DEFAULT 'freemium'`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_delivery_claims.create_table",
    plane: "do",
    table: "mas_delivery_claims",
    statement: `CREATE TABLE IF NOT EXISTS mas_delivery_claims (key TEXT PRIMARY KEY, claimed_at TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.d1.mas_feed_datasets.create_table",
    plane: "d1",
    table: "mas_feed_datasets",
    statement: `CREATE TABLE IF NOT EXISTS mas_feed_datasets (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, source_id TEXT NOT NULL, dataset TEXT NOT NULL, job_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, as_of TEXT NOT NULL, rows_persisted INTEGER NOT NULL, artifact_json TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_iv_history.alter_table_add_column_broker",
    plane: "do",
    table: "mas_iv_history",
    statement: `ALTER TABLE mas_iv_history ADD COLUMN broker TEXT NOT NULL DEFAULT 'etrade'`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_ladder_states.create_table",
    plane: "do",
    table: "mas_ladder_states",
    statement: `CREATE TABLE IF NOT EXISTS mas_ladder_states (ladder_id TEXT PRIMARY KEY, symbol TEXT, entry_mode TEXT, spec_json TEXT, plan_json TEXT, placed_json TEXT, committed_notional REAL, stopped_by TEXT, created_at TEXT, updated_at TEXT)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_learnings.create_table",
    plane: "do",
    table: "mas_learnings",
    statement: `CREATE TABLE IF NOT EXISTS mas_learnings (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    observation TEXT NOT NULL,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT 'reflection',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    superseded_by TEXT
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_learnings.create_index_idx_learnings_active",
    plane: "index",
    table: "mas_learnings",
    index: "idx_learnings_active",
    statement: `CREATE INDEX IF NOT EXISTS idx_learnings_active ON mas_learnings(superseded_by)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_learnings.create_index_idx_learnings_domain",
    plane: "index",
    table: "mas_learnings",
    index: "idx_learnings_domain",
    statement: `CREATE INDEX IF NOT EXISTS idx_learnings_domain ON mas_learnings(domain)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_opportunity_scans.alter_table_add_column_async_job_id",
    plane: "do",
    table: "mas_opportunity_scans",
    statement: `ALTER TABLE mas_opportunity_scans ADD COLUMN async_job_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_opportunity_scans.alter_table_add_column_schedule_id",
    plane: "do",
    table: "mas_opportunity_scans",
    statement: `ALTER TABLE mas_opportunity_scans ADD COLUMN schedule_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_opportunity_scans.alter_table_add_column_user_login",
    plane: "do",
    table: "mas_opportunity_scans",
    statement: `ALTER TABLE mas_opportunity_scans ADD COLUMN user_login TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_opportunity_scans.alter_table_add_column_workflow_id",
    plane: "do",
    table: "mas_opportunity_scans",
    statement: `ALTER TABLE mas_opportunity_scans ADD COLUMN workflow_id TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_report_confirmations.alter_table_add_column",
    plane: "do",
    table: "mas_report_confirmations",
    statement: `ALTER TABLE mas_report_confirmations ADD COLUMN \${column} \${type}`,
    kind: "schema",
    form: "parameterized",
    parameters: ["column", "type"],
  },
  {
    code: "schema.do.mas_reports.alter_table_add_column",
    plane: "do",
    table: "mas_reports",
    statement: `ALTER TABLE \${TABLE} ADD COLUMN \${column} \${type}`,
    kind: "schema",
    form: "parameterized",
    parameters: ["TABLE", "column", "type"],
  },
  {
    code: "schema.index.mas_reports.drop_index_idx_mas_reports_generation",
    plane: "index",
    table: "mas_reports",
    index: "idx_mas_reports_generation",
    statement: `DROP INDEX idx_\${TABLE}_generation`,
    kind: "schema",
    form: "parameterized",
    parameters: ["TABLE"],
  },
  {
    code: "schema.do.mas_stage_claims.create_table",
    plane: "do",
    table: "mas_stage_claims",
    statement: `CREATE TABLE IF NOT EXISTS mas_stage_claims (key TEXT PRIMARY KEY, claimed_at TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_trades.alter_table_add_column_broker",
    plane: "orm",
    table: "mas_trades",
    statement: `ALTER TABLE mas_trades ADD COLUMN broker TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.orm.mas_trades.alter_table_add_column_price_source",
    plane: "orm",
    table: "mas_trades",
    statement: `ALTER TABLE mas_trades ADD COLUMN price_source TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_activity.alter_table_add_column_critic_verdict_json",
    plane: "do",
    table: "stock_copilot_activity",
    statement: `ALTER TABLE stock_copilot_activity ADD COLUMN critic_verdict_json TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_activity.alter_table_add_column_mode",
    plane: "do",
    table: "stock_copilot_activity",
    statement: `ALTER TABLE stock_copilot_activity ADD COLUMN mode TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_activity.alter_table_add_column_session",
    plane: "do",
    table: "stock_copilot_activity",
    statement: `ALTER TABLE stock_copilot_activity ADD COLUMN session TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_positions.alter_table_add_column_entry_order_type",
    plane: "do",
    table: "stock_copilot_positions",
    statement: `ALTER TABLE stock_copilot_positions ADD COLUMN entry_order_type TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_positions.alter_table_add_column_entry_session",
    plane: "do",
    table: "stock_copilot_positions",
    statement: `ALTER TABLE stock_copilot_positions ADD COLUMN entry_session TEXT`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "seed.route.orchestrator_migration.insert_or_replace",
    plane: "route",
    table: "orchestrator_migration",
    statement: `INSERT OR REPLACE INTO \${table} (\${cols}) VALUES (\${placeholders})`,
    kind: "seed",
    form: "parameterized",
    parameters: ["table", "cols", "placeholders"],
  },
];

/** Build a fresh catalogue holding the remainder section. */
export function buildRemainderCatalogue(): SchemaCatalogue {
  const catalogue = createCatalogue();
  for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
    catalogue.register(entry);
  }
  return catalogue;
}

/** The remainder section as a registered catalogue (built once at import). */
export const REMAINDER_CATALOGUE: SchemaCatalogue = buildRemainderCatalogue();

/** The table statement for one DO-plane remainder table, byte-identical to the base. */
export function remainderTableSql(table: string): string {
  return REMAINDER_CATALOGUE.get(`schema.do.${table}.create_table`).statement;
}

/** The table statement for one D1-plane remainder table, byte-identical to the base. */
export function remainderD1TableSql(table: string): string {
  return REMAINDER_CATALOGUE.get(`schema.d1.${table}.create_table`).statement;
}

/** The frozen v1 table statement for one JobPipeline table, byte-identical to the base. */
export function remainderFrozenTableSql(table: string): string {
  return REMAINDER_CATALOGUE.get(`schema.do.${table}.create_table_v1`).statement;
}

/** The index statement for one remainder index, byte-identical to the base. */
export function remainderIndexSql(indexName: string): string {
  const entry = REMAINDER_CATALOGUE.entries().find((e) => e.index === indexName);
  if (!entry) {
    throw new Error(`no remainder catalogue entry for index ${indexName}`);
  }
  return entry.statement;
}

/**
 * The reconciliation statement for one (table, column) pair,
 * byte-identical to the base. The plane follows the table: the
 * mas_trades entries live on the ORM plane, the rest on DO.
 */
export function remainderAlterSql(table: string, column: string): string {
  const entry = REMAINDER_CATALOGUE.entries().find(
    (e) => e.table === table && e.code.endsWith(`alter_table_add_column_${column}`),
  );
  if (!entry) {
    throw new Error(`no remainder catalogue entry for ALTER ${table}.${column}`);
  }
  return entry.statement;
}

/**
 * Resolve one remainder catalogue statement (literal or
 * parameterized) to its executable text. Parameterized entries
 * (the two generic ALTERs, the DROP, the seed form) resolve
 * through the executor's resolver, so a missing parameter fails
 * closed with MISSING_PARAMETER.
 */
export function remainderStatementSql(
  code: string,
  params: Record<string, string> = {},
): string {
  return resolveStatementText(REMAINDER_CATALOGUE.get(code), params);
}
