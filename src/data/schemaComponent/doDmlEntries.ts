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
 */
import type { DoDmlCatalogueEntry } from "./doDmlCatalogue";

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
];
