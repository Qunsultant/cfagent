/**
 * #4282 P6b (#4385) — the DO DML entries: the first tranche (9
 * already-templated files, 53 statements).
 *
 * Column maps are identity by design and are omitted: the
 * Repository's row type IS the adapter's existing *Row interface
 * (snake_case keys), so toDbCol/fromDbRow pass keys through and the
 * adapter keeps its row→record mapping unchanged. No column-map
 * module exists for the tranche tables — the maps live here, next
 * to the entries they serve (one of everything).
 *
 * Template statements are byte-identical to the constants they
 * replace (the ${TABLE} interpolation resolved to the literal
 * table name, concatenation resolved) — the pin test asserts this
 * against the pre-migration text.
 *
 * Codes: dml.do.<table>.<action>. Actions follow the old constant
 * names (HAS → has, COUNT_DAY → count_day, …) so the migration is
 * a move, not a rename.
 *
 * #4386 (P6c): the ORM-core tables join this same catalogue
 * (REUSE — no sibling catalogue). The adapter entries carry the
 * tables' column maps from ../ormColumnMaps (the maps moved
 * there from doSqliteOrmAdapters.ts so these entries can import
 * them without a load-order cycle — see that module's header).
 * The settings entries carry no map (their record keys ARE the
 * column names) and idField "key". The parameterized operation
 * entries (table "__table__") are the 9 generator templates'
 * and the facade's browse/count reads' form: one entry per
 * Repository operation, the runtime table as a parameter.
 *
 * #4387 (P6d): the route-held DELETEs join this same catalogue
 * (REUSE — no sibling catalogue). The maintenance route's two
 * unpredicated DELETEs (mas_job_outcomes_meta, mas_events) are
 * template entries — an unpredicated DELETE is not a Repository
 * shape — executed through the DO DML executor. The
 * orchestratorMigration INSERT OR REPLACE does NOT join this
 * catalogue: it is the P3 parameterized seed entry
 * (seed.route.orchestrator_migration.insert_or_replace, the
 * remainder catalogue), resolved by the route through
 * remainderStatementSql; its table parameter is validated
 * against the combined catalogue there.
 */
import type { DoDmlCatalogueEntry } from "./doDmlCatalogue";
import {
  EVENT_COLUMN_MAP,
  MEMORY_COLUMN_MAP,
  MESSAGE_COLUMN_MAP,
  TRANSACTION_COLUMN_MAP,
} from "../ormColumnMaps";

export const DO_DML_CATALOGUE_ENTRIES: DoDmlCatalogueEntry[] = [
  // --- mas_discovery_alerts (SqlDiscoveryAlertStore) — 4 repository ---
  { code: "dml.do.mas_discovery_alerts.has", table: "mas_discovery_alerts", operation: "read", form: "repository", method: "count" },
  { code: "dml.do.mas_discovery_alerts.count_day", table: "mas_discovery_alerts", operation: "read", form: "repository", method: "count" },
  { code: "dml.do.mas_discovery_alerts.insert", table: "mas_discovery_alerts", operation: "insert", form: "repository", method: "create" },
  { code: "dml.do.mas_discovery_alerts.list", table: "mas_discovery_alerts", operation: "read", form: "repository", method: "findMany" },

  // --- mas_discovery_runs (SqlDiscoveryRunStore) — 4 repository + 2 template ---
  { code: "dml.do.mas_discovery_runs.insert", table: "mas_discovery_runs", operation: "insert", form: "repository", method: "create" },
  // The visibility predicate lives in the list statement itself (issue
  // #103): pagination walks only rows the caller may see, and a NULL
  // scope parameter matches only NULL-login rows because
  // `user_login = NULL` is never true in SQLite. A disjunction is not
  // a Repository shape — hence a template, not a repository entry.
  {
    code: "dml.do.mas_discovery_runs.list",
    table: "mas_discovery_runs",
    operation: "read",
    form: "template",
    statement: "SELECT summary_json FROM mas_discovery_runs WHERE (user_login IS NULL OR user_login = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    params: ["userLogin", "limit", "offset"],
    mode: "all",
  },
  { code: "dml.do.mas_discovery_runs.get", table: "mas_discovery_runs", operation: "read", form: "repository", method: "findById" },
  { code: "dml.do.mas_discovery_runs.count", table: "mas_discovery_runs", operation: "read", form: "repository", method: "count" },
  { code: "dml.do.mas_discovery_runs.prune_age", table: "mas_discovery_runs", operation: "delete", form: "repository", method: "deleteWhere" },
  {
    code: "dml.do.mas_discovery_runs.prune_cap",
    table: "mas_discovery_runs",
    operation: "delete",
    form: "template",
    statement: "DELETE FROM mas_discovery_runs WHERE id NOT IN (SELECT id FROM mas_discovery_runs ORDER BY created_at DESC, id DESC LIMIT ?)",
    params: ["maxRows"],
    mode: "run",
  },

  // --- mas_discovery_setup_runs (SqlDiscoverySetupStore) — 4 repository + 3 template ---
  { code: "dml.do.mas_discovery_setup_runs.insert", table: "mas_discovery_setup_runs", operation: "insert", form: "repository", method: "create" },
  {
    code: "dml.do.mas_discovery_setup_runs.list",
    table: "mas_discovery_setup_runs",
    operation: "read",
    form: "template",
    statement: "SELECT run_json FROM mas_discovery_setup_runs WHERE (user_login IS NULL OR user_login = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    params: ["userLogin", "limit", "offset"],
    mode: "all",
  },
  {
    code: "dml.do.mas_discovery_setup_runs.list_scoped",
    table: "mas_discovery_setup_runs",
    operation: "read",
    form: "template",
    statement: "SELECT run_json FROM mas_discovery_setup_runs WHERE (user_login IS NULL OR user_login = ?) AND scope_key = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    params: ["userLogin", "scopeKey", "limit", "offset"],
    mode: "all",
  },
  { code: "dml.do.mas_discovery_setup_runs.get", table: "mas_discovery_setup_runs", operation: "read", form: "repository", method: "findById" },
  { code: "dml.do.mas_discovery_setup_runs.count", table: "mas_discovery_setup_runs", operation: "read", form: "repository", method: "count" },
  { code: "dml.do.mas_discovery_setup_runs.prune_age", table: "mas_discovery_setup_runs", operation: "delete", form: "repository", method: "deleteWhere" },
  {
    code: "dml.do.mas_discovery_setup_runs.prune_cap",
    table: "mas_discovery_setup_runs",
    operation: "delete",
    form: "template",
    statement: "DELETE FROM mas_discovery_setup_runs WHERE id NOT IN (SELECT id FROM mas_discovery_setup_runs ORDER BY created_at DESC, id DESC LIMIT ?)",
    params: ["maxRows"],
    mode: "run",
  },

  // --- mas_enrichment_runs (SqlEnrichmentStore) — 3 repository ---
  { code: "dml.do.mas_enrichment_runs.insert_run", table: "mas_enrichment_runs", operation: "insert", form: "repository", method: "create" },
  { code: "dml.do.mas_enrichment_runs.list_runs", table: "mas_enrichment_runs", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_enrichment_runs.get_run", table: "mas_enrichment_runs", operation: "read", form: "repository", method: "findById" },

  // --- mas_feed_snapshots (SqlFeedSnapshotStore) — 5 repository ---
  { code: "dml.do.mas_feed_snapshots.insert", table: "mas_feed_snapshots", operation: "insert", form: "repository", method: "create" },
  { code: "dml.do.mas_feed_snapshots.ids", table: "mas_feed_snapshots", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_feed_snapshots.latest", table: "mas_feed_snapshots", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_feed_snapshots.by_id", table: "mas_feed_snapshots", operation: "read", form: "repository", method: "findOne" },
  { code: "dml.do.mas_feed_snapshots.delete", table: "mas_feed_snapshots", operation: "delete", form: "repository", method: "delete" },

  // --- mas_index_lists (SqlIndexListStore) — 4 repository ---
  { code: "dml.do.mas_index_lists.insert", table: "mas_index_lists", operation: "insert", form: "repository", method: "create" },
  { code: "dml.do.mas_index_lists.ids", table: "mas_index_lists", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_index_lists.latest", table: "mas_index_lists", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_index_lists.delete", table: "mas_index_lists", operation: "delete", form: "repository", method: "delete" },

  // --- mas_iv_history (SqlIvHistoryStore) — 7 repository + 4 template ---
  { code: "dml.do.mas_iv_history.get", table: "mas_iv_history", operation: "read", form: "repository", method: "findOne" },
  { code: "dml.do.mas_iv_history.get_broker", table: "mas_iv_history", operation: "read", form: "repository", method: "findOne" },
  { code: "dml.do.mas_iv_history.insert", table: "mas_iv_history", operation: "insert", form: "repository", method: "createOrIgnore" },
  { code: "dml.do.mas_iv_history.series", table: "mas_iv_history", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_iv_history.series_broker", table: "mas_iv_history", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_iv_history.series_limit", table: "mas_iv_history", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_iv_history.series_broker_limit", table: "mas_iv_history", operation: "read", form: "repository", method: "findMany" },
  {
    code: "dml.do.mas_iv_history.coverage",
    table: "mas_iv_history",
    operation: "read",
    form: "template",
    statement: "SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM mas_iv_history WHERE symbol = ?",
    params: ["symbol"],
    mode: "all",
  },
  {
    code: "dml.do.mas_iv_history.coverage_broker",
    table: "mas_iv_history",
    operation: "read",
    form: "template",
    statement: "SELECT COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date FROM mas_iv_history WHERE symbol = ? AND broker = ?",
    params: ["symbol", "broker"],
    mode: "all",
  },
  {
    code: "dml.do.mas_iv_history.symbols",
    table: "mas_iv_history",
    operation: "read",
    form: "template",
    statement: "SELECT DISTINCT symbol FROM mas_iv_history ORDER BY symbol ASC",
    params: [],
    mode: "all",
  },
  {
    code: "dml.do.mas_iv_history.symbols_broker",
    table: "mas_iv_history",
    operation: "read",
    form: "template",
    statement: "SELECT DISTINCT symbol FROM mas_iv_history WHERE broker = ? ORDER BY symbol ASC",
    params: ["broker"],
    mode: "all",
  },

  // --- mas_opportunity_scans (SqlScanRunStore) — 6 repository + 2 template ---
  { code: "dml.do.mas_opportunity_scans.insert", table: "mas_opportunity_scans", operation: "insert", form: "repository", method: "create" },
  {
    code: "dml.do.mas_opportunity_scans.list",
    table: "mas_opportunity_scans",
    operation: "read",
    form: "template",
    statement: "SELECT summary_json FROM mas_opportunity_scans WHERE (user_login IS NULL OR user_login = ?) ORDER BY generated_at DESC, id DESC LIMIT ? OFFSET ?",
    params: ["userLogin", "limit", "offset"],
    mode: "all",
  },
  { code: "dml.do.mas_opportunity_scans.get", table: "mas_opportunity_scans", operation: "read", form: "repository", method: "findById" },
  { code: "dml.do.mas_opportunity_scans.update_pdf_key", table: "mas_opportunity_scans", operation: "update", form: "repository", method: "update" },
  { code: "dml.do.mas_opportunity_scans.update_linkage", table: "mas_opportunity_scans", operation: "update", form: "repository", method: "update" },
  { code: "dml.do.mas_opportunity_scans.count", table: "mas_opportunity_scans", operation: "read", form: "repository", method: "count" },
  { code: "dml.do.mas_opportunity_scans.prune_age", table: "mas_opportunity_scans", operation: "delete", form: "repository", method: "deleteWhere" },
  {
    code: "dml.do.mas_opportunity_scans.prune_cap",
    table: "mas_opportunity_scans",
    operation: "delete",
    form: "template",
    statement: "DELETE FROM mas_opportunity_scans WHERE id NOT IN (SELECT id FROM mas_opportunity_scans ORDER BY generated_at DESC, id DESC LIMIT ?)",
    params: ["maxRows"],
    mode: "run",
  },

  // --- mas_strategy_profiles (SqlStrategyProfileStore) — 5 repository ---
  { code: "dml.do.mas_strategy_profiles.insert", table: "mas_strategy_profiles", operation: "insert", form: "repository", method: "create" },
  { code: "dml.do.mas_strategy_profiles.select_by_user", table: "mas_strategy_profiles", operation: "read", form: "repository", method: "findMany" },
  { code: "dml.do.mas_strategy_profiles.select_by_id", table: "mas_strategy_profiles", operation: "read", form: "repository", method: "findOne" },
  { code: "dml.do.mas_strategy_profiles.update", table: "mas_strategy_profiles", operation: "update", form: "repository", method: "updateWhere" },
  { code: "dml.do.mas_strategy_profiles.delete", table: "mas_strategy_profiles", operation: "delete", form: "repository", method: "deleteWhere" },

  // --- P6c (#4386): the ORM-core tables (DoSqlite* adapters) — 12 repository + 3 template ---
  // --- mas_messages (DoSqliteMessageAdapter) — 2 repository ---
  { code: "dml.do.mas_messages.ids_created_before", table: "mas_messages", operation: "read", form: "repository", method: "findMany", columnMap: MESSAGE_COLUMN_MAP },
  { code: "dml.do.mas_messages.delete_by_session", table: "mas_messages", operation: "delete", form: "repository", method: "deleteWhere", columnMap: MESSAGE_COLUMN_MAP },

  // --- mas_events (DoSqliteEventLogAdapter) — 1 repository + 1 template ---
  { code: "dml.do.mas_events.ids_created_before", table: "mas_events", operation: "read", form: "repository", method: "findMany", columnMap: EVENT_COLUMN_MAP },
  // The chained tail read (ormRepositoryCore.ts ChainedAuditRepository.create):
  // the latest event_hash by insertion order — a fixed table, so a
  // fixed template, not a parameterized entry. The create() method
  // itself keeps its direct read (the frozen audit chain, gate G-5);
  // this entry is the canonical record the pin executes.
  {
    code: "dml.do.mas_events.tail_hash",
    table: "mas_events",
    operation: "read",
    form: "template",
    statement: "SELECT event_hash FROM mas_events ORDER BY rowid DESC LIMIT 1",
    params: [],
    mode: "all",
  },

  // --- mas_memory (DoSqliteMemoryAdapter) — 2 repository + 2 template ---
  // clear is an unpredicated DELETE — deleteWhere refuses an empty
  // predicate by design, so it stays a template.
  {
    code: "dml.do.mas_memory.clear",
    table: "mas_memory",
    operation: "delete",
    form: "template",
    statement: "DELETE FROM mas_memory",
    params: [],
    mode: "run",
  },
  { code: "dml.do.mas_memory.keys_updated_before", table: "mas_memory", operation: "read", form: "repository", method: "findMany", columnMap: MEMORY_COLUMN_MAP },
  // search is a LIKE + OR disjunction across two columns — not a
  // Repository shape, hence a template (byte-identical to the
  // adapter's statement, params in binding order).
  {
    code: "dml.do.mas_memory.search",
    table: "mas_memory",
    operation: "read",
    form: "template",
    statement: "SELECT key, value, updated_at FROM mas_memory WHERE lower(key) LIKE ? OR lower(value) LIKE ? ORDER BY updated_at DESC LIMIT ?",
    params: ["like", "like", "limit"],
    mode: "all",
  },
  { code: "dml.do.mas_memory.list_recent", table: "mas_memory", operation: "read", form: "repository", method: "findMany", columnMap: MEMORY_COLUMN_MAP },

  // --- mas_transactions (DoSqliteTransactionLedgerAdapter) — 4 repository + 1 template ---
  { code: "dml.do.mas_transactions.replace", table: "mas_transactions", operation: "insert", form: "repository", method: "createOrReplace", columnMap: TRANSACTION_COLUMN_MAP },
  { code: "dml.do.mas_transactions.complete_with_gateway", table: "mas_transactions", operation: "update", form: "repository", method: "updateWhere", columnMap: TRANSACTION_COLUMN_MAP },
  { code: "dml.do.mas_transactions.reject_with_note", table: "mas_transactions", operation: "update", form: "repository", method: "updateWhere", columnMap: TRANSACTION_COLUMN_MAP },
  // The OR disjunction (id OR gateway_ref, the reference bound
  // twice) is not a Repository shape — a template, byte-identical
  // to the adapter's statement. The adapter keeps the
  // rowsWritten-or-0 return (the template dispatch's "run" shape).
  {
    code: "dml.do.mas_transactions.complete_by_gateway_ref",
    table: "mas_transactions",
    operation: "update",
    form: "template",
    statement: "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ? OR gateway_ref = ?",
    params: ["updatedAt", "ref", "ref"],
    mode: "run",
  },
  { code: "dml.do.mas_transactions.complete_by_id", table: "mas_transactions", operation: "update", form: "repository", method: "updateWhere", columnMap: TRANSACTION_COLUMN_MAP },

  // --- mas_settings (DoSqliteSettingsAdapter / DoSqliteSettingsReadAdapter) — 3 repository ---
  // No column map: the record keys (key, value, updated_at) ARE
  // the column names. set() is DELETE+INSERT (not INSERT OR
  // REPLACE) so MockSqlStorage-shaped stores stay compatible —
  // the incumbent idiom, preserved as two entries.
  { code: "dml.do.mas_settings.get", table: "mas_settings", operation: "read", form: "repository", method: "findById", idField: "key" },
  { code: "dml.do.mas_settings.insert", table: "mas_settings", operation: "insert", form: "repository", method: "create", idField: "key" },
  { code: "dml.do.mas_settings.delete", table: "mas_settings", operation: "delete", form: "repository", method: "delete", idField: "key" },

  // --- P6d (#4387): the route-held DELETEs (maintenance.ts clear-table) — 2 template ---
  // The Data Lifecycle delete path: the maintenance route clears
  // whole tables (the prune watermark, the audit history). An
  // unpredicated DELETE is not a Repository shape — deleteWhere
  // refuses an empty predicate by design — so both stay templates,
  // exactly like dml.do.mas_memory.clear above. The route calls
  // these entries through the DO DML executor; the inline strings
  // are gone. The clear contract is unchanged: mas_job_outcomes_meta
  // is its own clearable row (the watermark survives an outcomes
  // clear), mas_events stays auditConfirm-gated (#2489).
  {
    code: "dml.do.mas_job_outcomes_meta.clear",
    table: "mas_job_outcomes_meta",
    operation: "delete",
    form: "template",
    statement: "DELETE FROM mas_job_outcomes_meta",
    params: [],
    mode: "run",
  },
  {
    code: "dml.do.mas_events.clear",
    table: "mas_events",
    operation: "delete",
    form: "template",
    statement: "DELETE FROM mas_events",
    params: [],
    mode: "run",
  },

  // --- P6c (#4386): parameterized operation entries — 10 repository ---
  // One entry per Repository operation, registered once with the
  // placeholder table "__table__" — the 9 generator templates
  // (ormRepositoryCore.ts) and the facade's browse/count reads
  // dispatch through these with the runtime table as a parameter
  // (code table == runtime table, enforced by the executor).
  // No column map, no idField: both are table-specific, so the
  // executor uses the defaults (identity columns, id "id").
  { code: "dml.do.__table__.find_many", table: "__table__", operation: "read", form: "repository", method: "findMany", parameterizedTable: true },
  { code: "dml.do.__table__.find_by_id", table: "__table__", operation: "read", form: "repository", method: "findById", parameterizedTable: true },
  { code: "dml.do.__table__.insert", table: "__table__", operation: "insert", form: "repository", method: "create", parameterizedTable: true },
  { code: "dml.do.__table__.insert_or_ignore", table: "__table__", operation: "insert", form: "repository", method: "createOrIgnore", parameterizedTable: true },
  { code: "dml.do.__table__.insert_or_replace", table: "__table__", operation: "insert", form: "repository", method: "createOrReplace", parameterizedTable: true },
  { code: "dml.do.__table__.update", table: "__table__", operation: "update", form: "repository", method: "update", parameterizedTable: true },
  { code: "dml.do.__table__.update_where", table: "__table__", operation: "update", form: "repository", method: "updateWhere", parameterizedTable: true },
  { code: "dml.do.__table__.delete", table: "__table__", operation: "delete", form: "repository", method: "delete", parameterizedTable: true },
  { code: "dml.do.__table__.delete_where", table: "__table__", operation: "delete", form: "repository", method: "deleteWhere", parameterizedTable: true },
  { code: "dml.do.__table__.count", table: "__table__", operation: "read", form: "repository", method: "count", parameterizedTable: true },

  // --- P6e (#5033): mas_autopilot (DoSqliteAutopilotStateStore) — 2 template ---
  {
    code: "dml.do.mas_autopilot.get_value",
    table: "mas_autopilot",
    operation: "read",
    form: "template",
    statement: "SELECT value FROM mas_autopilot WHERE key = ?",
    params: ["key"],
    mode: "all",
  },
  {
    code: "dml.do.mas_autopilot.put_value",
    table: "mas_autopilot",
    operation: "insert",
    form: "template",
    statement: "INSERT OR REPLACE INTO mas_autopilot (key, value, updated_at) VALUES (?, ?, ?)",
    params: ["key", "value", "updated_at"],
    mode: "run",
  },
];
