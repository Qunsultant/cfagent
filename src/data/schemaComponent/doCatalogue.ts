/**
 * #4282 P2b — DO catalogue: the Durable Object adapters' single
 * home for statement text.
 *
 * The catalogue is the DO plane's single home for statement
 * text; the 49 DO adapters and the two schema-marker modules
 * assemble their DDL from its codes and remain the executors
 * (delegation, not absorption). The DO execution idiom is
 * unchanged: `this.sql.exec(...)` against the DO SqlStorage
 * handle, with the catalogue statement as the argument.
 *
 * Scope (measured from the base tree b3062e2e, not the filing
 * counts): 103 statements — 66 table statements, 36 index
 * statements, 1 unique-index statement. The filing's "76
 * TABLE / 35 INDEX" is a grep count: 9 of the 77 TABLE lines
 * are comment mentions (one per file, see the build report),
 * 2 are the frozen JobPipeline v1 migration copies, and 2 of
 * the executed indexes already live in the ORM catalogue
 * (job_run_records_recent_idx, unified_schedules_created_idx —
 * read via ormIndexSql, never duplicated here).
 *
 * What stays inline (P3's scope, asserted by the wiring test):
 * every probed/guarded reconciliation statement — the additive
 * column pattern (probe, then add only when missing) — plus
 * the frozen JobPipeline v1 migration copies, which are
 * history and must never change.
 *
 * The four mas_reports entries are parameterized on ${TABLE}:
 * the adapter's template-assembled statements live in the
 * catalogue in their parameterized form, resolved at the call
 * site with the adapter's TABLE constant.
 *
 * Code naming (`<kind>.<plane>.<table>.<action>`), mirroring
 * the ORM catalogue:
 *  - table statement: `create_table` (plane "do").
 *  - index statement: `create_index_<index-name>` (plane
 *    "index").
 *  - unique-index statement: `create_unique_index_<index-name>`
 *    (plane "index").
 *
 * Anchors (measured from the base helpers at b3062e2e, before
 * the delegation — never re-derived from the delegated
 * helpers): the sha256 map in
 * tests/schema_component_do_catalogue.test.ts pins every
 * entry's statement byte-for-byte, and the expected-model
 * fixture (tests/schema_component_do_expected_model.json)
 * pins the schema the catalogue builds.
 */
import type { CatalogueEntry } from "./catalogueTypes";
import { createCatalogue, type SchemaCatalogue } from "./catalogue";
import { resolveStatementText } from "./executor";

/** The DO section: every statement the DO adapters execute, in code order. */
export const DO_CATALOGUE_ENTRIES: CatalogueEntry[] = [
  {
    code: "schema.do.job_analyzed_datasets.create_table",
    plane: "do",
    table: "job_analyzed_datasets",
    statement: `CREATE TABLE IF NOT EXISTS job_analyzed_datasets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      enrich_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_delivery_datasets.create_table",
    plane: "do",
    table: "job_delivery_datasets",
    statement: `CREATE TABLE IF NOT EXISTS job_delivery_datasets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      generate_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      input_artifact_id TEXT NOT NULL,
      artifact_json TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_enriched_datasets.create_table",
    plane: "do",
    table: "job_enriched_datasets",
    statement: `CREATE TABLE IF NOT EXISTS job_enriched_datasets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      feed_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_generated_datasets.create_table",
    plane: "do",
    table: "job_generated_datasets",
    statement: `CREATE TABLE IF NOT EXISTS job_generated_datasets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      job_id TEXT NOT NULL,
      analyze_job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      dataset TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      as_of TEXT NOT NULL,
      rows_persisted INTEGER NOT NULL,
      artifact_json TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_pipeline_artifacts.create_table",
    plane: "do",
    table: "job_pipeline_artifacts",
    statement: `CREATE TABLE IF NOT EXISTS job_pipeline_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      value_json TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_pipeline_definitions.create_table",
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
    code: "schema.do.job_pipeline_instances.create_table",
    plane: "do",
    table: "job_pipeline_instances",
    statement: `CREATE TABLE IF NOT EXISTS job_pipeline_instances (
      job_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      desired_state TEXT NOT NULL,
      current_run_id TEXT,
      run_started_at TEXT,
      run_trigger TEXT,
      run_schedule_id TEXT,
      run_async_job_id TEXT,
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
    code: "schema.do.job_run_records.create_table",
    plane: "do",
    table: "job_run_records",
    statement: `CREATE TABLE IF NOT EXISTS job_run_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system TEXT NOT NULL,
      job_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      started TEXT NOT NULL,
      finished TEXT NOT NULL,
      outcome TEXT NOT NULL,
      triggered_by TEXT NOT NULL,
      trigger_text TEXT,
      schedule_id TEXT,
      async_job_id TEXT,
      workflow_id TEXT,
      error_text TEXT,
      detail TEXT,
      descriptor TEXT,
      artifact_refs_json TEXT,
      broker_id TEXT,
      data_provider_id TEXT,
      mode TEXT,
      mode_source TEXT
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.job_stage_events.create_table",
    plane: "do",
    table: "job_stage_events",
    statement: `CREATE TABLE IF NOT EXISTS job_stage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      claim_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      unit_id TEXT,
      action TEXT NOT NULL,
      at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      detail TEXT
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.kv_store.create_table",
    plane: "do",
    table: "kv_store",
    statement: `CREATE TABLE IF NOT EXISTS kv_store (
         ns TEXT NOT NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         expires_at INTEGER,
         PRIMARY KEY (ns, key)
       )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_adaptation_audit.create_table",
    plane: "do",
    table: "mas_adaptation_audit",
    statement: `CREATE TABLE IF NOT EXISTS mas_adaptation_audit (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    subject TEXT NOT NULL,
    parameter TEXT NOT NULL,
    before_value TEXT NOT NULL,
    after_value TEXT NOT NULL,
    delta REAL,
    rationale TEXT NOT NULL,
    data_window TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied',
    block_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_agent_workspace_files.create_table",
    plane: "do",
    table: "mas_agent_workspace_files",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_agent_workspace_files (
        user_login TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_login, path)
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_async_jobs.create_table",
    plane: "do",
    table: "mas_async_jobs",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_async_jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        response_status INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_autopilot.create_table",
    plane: "do",
    table: "mas_autopilot",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_autopilot (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_challenger_approvals.create_table",
    plane: "do",
    table: "mas_challenger_approvals",
    statement: `CREATE TABLE IF NOT EXISTS mas_challenger_approvals (
    id TEXT PRIMARY KEY,
    challenger_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    approver TEXT NOT NULL,
    decision TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_challenger_promotions.create_table",
    plane: "do",
    table: "mas_challenger_promotions",
    statement: `CREATE TABLE IF NOT EXISTS mas_challenger_promotions (
    id TEXT PRIMARY KEY,
    challenger_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    action TEXT NOT NULL,
    prior_json TEXT NOT NULL,
    applied_json TEXT NOT NULL,
    weights_version INTEGER,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_challengers.create_table",
    plane: "do",
    table: "mas_challengers",
    statement: `CREATE TABLE IF NOT EXISTS mas_challengers (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    regime TEXT,
    spec_json TEXT NOT NULL,
    criteria_json TEXT NOT NULL,
    eval_set_version TEXT NOT NULL,
    source_proposal_id TEXT,
    status TEXT NOT NULL,
    evaluation_json TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_comparison_arm_outcomes.create_table",
    plane: "do",
    table: "mas_comparison_arm_outcomes",
    statement: `CREATE TABLE IF NOT EXISTS mas_comparison_arm_outcomes (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, arm TEXT NOT NULL, candidate_id TEXT NOT NULL, structure TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_data_captures.create_table",
    plane: "do",
    table: "mas_data_captures",
    statement: `CREATE TABLE IF NOT EXISTS mas_data_captures (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    request_params_json TEXT NOT NULL DEFAULT '{}',
    run_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    user_login TEXT,
    fetched_at TEXT NOT NULL,
    status TEXT NOT NULL,
    raw_kind TEXT,
    raw_blob_ref TEXT,
    raw_byte_size INTEGER,
    raw_sha256 TEXT,
    normalized_digest TEXT,
    retention_class TEXT NOT NULL,
    failure_error TEXT,
    failure_kind TEXT,
    failure_message TEXT,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_data_provider_routes.create_table",
    plane: "do",
    table: "mas_data_provider_routes",
    statement: `CREATE TABLE IF NOT EXISTS mas_data_provider_routes (
    capability TEXT PRIMARY KEY,
    primary_provider_id TEXT NOT NULL,
    gap_fill_provider_id TEXT,
    min_tier TEXT NOT NULL DEFAULT 'freemium',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_data_providers.create_table",
    plane: "do",
    table: "mas_data_providers",
    statement: `CREATE TABLE IF NOT EXISTS mas_data_providers (
    id TEXT PRIMARY KEY,
    adapter_kind TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    precedence INTEGER NOT NULL,
    credential_ref TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_discovery_alerts.create_table",
    plane: "do",
    table: "mas_discovery_alerts",
    statement: `CREATE TABLE IF NOT EXISTS mas_discovery_alerts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_key TEXT NOT NULL, symbol TEXT NOT NULL, thesis TEXT NOT NULL, score REAL NOT NULL, day TEXT NOT NULL, evidence TEXT NOT NULL, fired_signals TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(scope_key, symbol, thesis, day))`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_discovery_runs.create_table",
    plane: "do",
    table: "mas_discovery_runs",
    statement: `CREATE TABLE IF NOT EXISTS mas_discovery_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, user_login TEXT, summary_json TEXT NOT NULL, run_json TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_discovery_setup_runs.create_table",
    plane: "do",
    table: "mas_discovery_setup_runs",
    statement: `CREATE TABLE IF NOT EXISTS mas_discovery_setup_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, scope_key TEXT NOT NULL, user_login TEXT, run_json TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_do_schema_marker.create_table",
    plane: "do",
    table: "mas_do_schema_marker",
    statement: `CREATE TABLE IF NOT EXISTS mas_do_schema_marker (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_enrichment_runs.create_table",
    plane: "do",
    table: "mas_enrichment_runs",
    statement: `CREATE TABLE IF NOT EXISTS mas_enrichment_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, job_id TEXT NOT NULL, stage TEXT NOT NULL, record_json TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_feed_snapshots.create_table",
    plane: "do",
    table: "mas_feed_snapshots",
    statement: `CREATE TABLE IF NOT EXISTS mas_feed_snapshots (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, user_login TEXT NOT NULL, symbol TEXT NOT NULL, as_of TEXT NOT NULL, data_source TEXT NOT NULL, snapshot_json TEXT NOT NULL, load_params_json TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_goals.create_table",
    plane: "do",
    table: "mas_goals",
    statement: `CREATE TABLE IF NOT EXISTS mas_goals (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_index_lists.create_table",
    plane: "do",
    table: "mas_index_lists",
    statement: `CREATE TABLE IF NOT EXISTS mas_index_lists (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, index_id TEXT NOT NULL, snapshot_date TEXT NOT NULL, source TEXT NOT NULL, source_label TEXT NOT NULL, derived_from_holdings INTEGER NOT NULL, members_json TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_iv_history.create_table",
    plane: "do",
    table: "mas_iv_history",
    statement: `CREATE TABLE IF NOT EXISTS mas_iv_history (symbol TEXT NOT NULL, date TEXT NOT NULL, atm_iv REAL NOT NULL, spot REAL NOT NULL, expiry_date TEXT NOT NULL, dte INTEGER NOT NULL, collected_at TEXT NOT NULL, broker TEXT NOT NULL DEFAULT 'etrade', PRIMARY KEY (symbol, date))`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_job_outcomes.create_table",
    plane: "do",
    table: "mas_job_outcomes",
    statement: `CREATE TABLE IF NOT EXISTS mas_job_outcomes (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, status TEXT, scanned INTEGER, matched INTEGER, coded_error TEXT, report_url TEXT, pdf_key TEXT, xlsx_key TEXT, csv_key TEXT, delivery_json TEXT, origin TEXT, created_at TEXT)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_job_outcomes_meta.create_table",
    plane: "do",
    table: "mas_job_outcomes_meta",
    statement: `CREATE TABLE IF NOT EXISTS mas_job_outcomes_meta (k TEXT PRIMARY KEY, v TEXT)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_opportunity_scans.create_table",
    plane: "do",
    table: "mas_opportunity_scans",
    statement: `CREATE TABLE IF NOT EXISTS mas_opportunity_scans (id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, mode TEXT NOT NULL, model_version TEXT NOT NULL, user_login TEXT, schedule_id TEXT, async_job_id TEXT, workflow_id TEXT, summary_json TEXT NOT NULL, result_json TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_outcome_tracking.create_table",
    plane: "do",
    table: "mas_outcome_tracking",
    statement: `CREATE TABLE IF NOT EXISTS mas_outcome_tracking (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    recommendation_ref TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_kind TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_outcomes.create_table",
    plane: "do",
    table: "mas_outcomes",
    statement: `CREATE TABLE IF NOT EXISTS mas_outcomes (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    goal_id TEXT,
    scenario_id TEXT,
    recommendation_ref TEXT,
    screen_run_ref TEXT,
    kind TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_policy_verdicts.create_table",
    plane: "do",
    table: "mas_policy_verdicts",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_policy_verdicts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        quantity REAL NOT NULL,
        notional REAL,
        mode TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL,
        execution_allowed INTEGER NOT NULL,
        requires_approval INTEGER NOT NULL,
        binding_rule TEXT,
        detail TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        projections_json TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        signing_key_id TEXT NOT NULL,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_report_confirmations.create_table",
    plane: "do",
    table: "mas_report_confirmations",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_report_confirmations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        report_id TEXT,
        created_by TEXT
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_reports.create_table",
    plane: "do",
    table: "mas_reports",
    statement: `CREATE TABLE IF NOT EXISTS \${TABLE} (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    generation_id TEXT
  )`,
    kind: "schema",
    form: "parameterized",
    parameters: ["TABLE"],
  },
  {
    code: "schema.do.mas_scenarios.create_table",
    plane: "do",
    table: "mas_scenarios",
    statement: `CREATE TABLE IF NOT EXISTS mas_scenarios (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    portfolio_ref_kind TEXT NOT NULL,
    portfolio_ref TEXT,
    shocks_json TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_schema_migrations.create_table",
    plane: "do",
    table: "mas_schema_migrations",
    statement: `CREATE TABLE IF NOT EXISTS mas_schema_migrations (
  store TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL,
  PRIMARY KEY (store, version)
)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_screener_presets.create_table",
    plane: "do",
    table: "mas_screener_presets",
    statement: `
      CREATE TABLE IF NOT EXISTS mas_screener_presets (
        id TEXT PRIMARY KEY,
        user_login TEXT NOT NULL,
        name TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        criteria_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_screening_activity.create_table",
    plane: "do",
    table: "mas_screening_activity",
    statement: `CREATE TABLE IF NOT EXISTS mas_screening_activity (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail_json TEXT,
    ref_id TEXT,
    actor TEXT,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_settings.create_table",
    plane: "do",
    table: "mas_settings",
    statement: `CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_bank_active.create_table",
    plane: "do",
    table: "mas_strategy_bank_active",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_bank_active (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    version INTEGER NOT NULL,
    strategies_json TEXT NOT NULL,
    challenger_id TEXT,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_bank_proposals.create_table",
    plane: "do",
    table: "mas_strategy_bank_proposals",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_bank_proposals (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    regime TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_gates.create_table",
    plane: "do",
    table: "mas_strategy_gates",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_gates (
    strategy TEXT PRIMARY KEY,
    gated_off INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_profiles.create_table",
    plane: "do",
    table: "mas_strategy_profiles",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_profiles (id TEXT PRIMARY KEY, user_login TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, spec_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_reviews.create_table",
    plane: "do",
    table: "mas_strategy_reviews",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_reviews (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    label TEXT NOT NULL,
    rank INTEGER NOT NULL,
    rationale TEXT NOT NULL,
    quant_status TEXT NOT NULL DEFAULT 'unverified',
    decision TEXT NOT NULL DEFAULT 'pending',
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_weight_caps.create_table",
    plane: "do",
    table: "mas_strategy_weight_caps",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_weight_caps (
    strategy TEXT PRIMARY KEY,
    cap REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_weight_versions.create_table",
    plane: "do",
    table: "mas_strategy_weight_versions",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_weight_versions (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    strategy TEXT NOT NULL,
    regime TEXT NOT NULL,
    before_weight REAL,
    after_weight REAL NOT NULL,
    signal REAL,
    evaluated INTEGER NOT NULL DEFAULT 0,
    win_rate_after_cost REAL,
    avg_r_after_cost REAL,
    actor TEXT NOT NULL,
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.mas_strategy_weights_v2.create_table",
    plane: "do",
    table: "mas_strategy_weights_v2",
    statement: `CREATE TABLE IF NOT EXISTS mas_strategy_weights_v2 (
    strategy TEXT NOT NULL,
    regime TEXT NOT NULL,
    weight REAL NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (strategy, regime)
  )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.paused_schedules.create_table",
    plane: "do",
    table: "paused_schedules",
    statement: `CREATE TABLE IF NOT EXISTS paused_schedules (
      id TEXT PRIMARY KEY,
      callback TEXT NOT NULL,
      payload_json TEXT,
      sched_type TEXT NOT NULL,
      cron TEXT,
      interval_seconds INTEGER,
      time INTEGER,
      delay_seconds INTEGER,
      paused_at TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.pending_schedule_approvals.create_table",
    plane: "do",
    table: "pending_schedule_approvals",
    statement: `CREATE TABLE IF NOT EXISTS pending_schedule_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      approval_reasons_json TEXT NOT NULL,
      status TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.research_evaluations.create_table",
    plane: "do",
    table: "research_evaluations",
    statement: `CREATE TABLE IF NOT EXISTS research_evaluations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, evaluated_at TEXT NOT NULL,
      evaluation_json TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.research_runs.create_table",
    plane: "do",
    table: "research_runs",
    statement: `CREATE TABLE IF NOT EXISTS research_runs (
      run_id TEXT PRIMARY KEY, trigger TEXT NOT NULL, user_login TEXT NOT NULL,
      created_at TEXT NOT NULL, rules_version TEXT NOT NULL, status TEXT NOT NULL,
      ideas_count INTEGER NOT NULL, report_json TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.research_settings.create_table",
    plane: "do",
    table: "research_settings",
    statement: `CREATE TABLE IF NOT EXISTS research_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.research_task_store.create_table",
    plane: "do",
    table: "research_task_store",
    statement: `CREATE TABLE IF NOT EXISTS research_task_store (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.screen_run_locks.create_table",
    plane: "do",
    table: "screen_run_locks",
    statement: `CREATE TABLE IF NOT EXISTS screen_run_locks (
      user_login TEXT NOT NULL,
      universe TEXT NOT NULL,
      token TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (user_login, universe)
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_activity.create_table",
    plane: "do",
    table: "stock_copilot_activity",
    statement: `CREATE TABLE IF NOT EXISTS stock_copilot_activity (
        id TEXT PRIMARY KEY,
        user_login TEXT NOT NULL,
        cycle_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        entries_json TEXT NOT NULL,
        exits_json TEXT NOT NULL,
        detail TEXT,
        session TEXT
      )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_control.create_table",
    plane: "do",
    table: "stock_copilot_control",
    statement: `CREATE TABLE IF NOT EXISTS stock_copilot_control (
        user_login TEXT PRIMARY KEY,
        paused INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_learnings.create_table",
    plane: "do",
    table: "stock_copilot_learnings",
    statement: `CREATE TABLE IF NOT EXISTS stock_copilot_learnings (
        id TEXT PRIMARY KEY,
        user_login TEXT NOT NULL,
        cycle_id TEXT,
        timestamp TEXT NOT NULL,
        category TEXT NOT NULL,
        insight TEXT NOT NULL,
        source_verdict TEXT,
        suggested_action TEXT
      )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.stock_copilot_positions.create_table",
    plane: "do",
    table: "stock_copilot_positions",
    statement: `CREATE TABLE IF NOT EXISTS stock_copilot_positions (
        id TEXT PRIMARY KEY,
        user_login TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        quantity REAL NOT NULL,
        entry_price REAL NOT NULL,
        stop_price REAL NOT NULL,
        target_price REAL NOT NULL,
        broker_order_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        exit_broker_order_ref TEXT,
        exit_price REAL,
        exit_reason TEXT,
        entry_session TEXT,
        entry_order_type TEXT
      )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.unified_schedules.create_table",
    plane: "do",
    table: "unified_schedules",
    statement: `CREATE TABLE IF NOT EXISTS unified_schedules (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      callback TEXT,
      operation TEXT,
      definition_json TEXT NOT NULL,
      owner_login TEXT,
      provenance_json TEXT,
      alarm_id TEXT,
      paused_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.usage_events.create_table",
    plane: "do",
    table: "usage_events",
    statement: `CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      user_login TEXT NOT NULL,
      run_id TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL,
      detail_json TEXT
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.user_request_quota_charges.create_table",
    plane: "do",
    table: "user_request_quota_charges",
    statement: `CREATE TABLE IF NOT EXISTS user_request_quota_charges (
      tenant_id TEXT NOT NULL,
      user_login TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      run_id TEXT NOT NULL,
      charged_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, user_login, window_kind, window_key, run_id)
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.do.user_request_quota_overrides.create_table",
    plane: "do",
    table: "user_request_quota_overrides",
    statement: `CREATE TABLE IF NOT EXISTS user_request_quota_overrides (
      id TEXT NOT NULL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_login TEXT NOT NULL,
      window_kind TEXT NOT NULL,
      window_key TEXT NOT NULL,
      extra_runs INTEGER NOT NULL,
      granted_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      expires_ms INTEGER
    )`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_analyzed_datasets.create_index_idx_job_analyzed_datasets_job",
    plane: "index",
    table: "job_analyzed_datasets",
    index: "idx_job_analyzed_datasets_job",
    statement: `CREATE INDEX IF NOT EXISTS idx_job_analyzed_datasets_job
      ON job_analyzed_datasets (job_id, created_at DESC, id DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_delivery_datasets.create_index_idx_job_delivery_datasets_job",
    plane: "index",
    table: "job_delivery_datasets",
    index: "idx_job_delivery_datasets_job",
    statement: `CREATE INDEX IF NOT EXISTS idx_job_delivery_datasets_job
      ON job_delivery_datasets (job_id, created_at DESC, id DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_enriched_datasets.create_index_idx_job_enriched_datasets_job",
    plane: "index",
    table: "job_enriched_datasets",
    index: "idx_job_enriched_datasets_job",
    statement: `CREATE INDEX IF NOT EXISTS idx_job_enriched_datasets_job
      ON job_enriched_datasets (job_id, created_at DESC, id DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_generated_datasets.create_index_idx_job_generated_datasets_job",
    plane: "index",
    table: "job_generated_datasets",
    index: "idx_job_generated_datasets_job",
    statement: `CREATE INDEX IF NOT EXISTS idx_job_generated_datasets_job
      ON job_generated_datasets (job_id, created_at DESC, id DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_pipeline_artifacts.create_index_idx_job_pipeline_artifacts_run",
    plane: "index",
    table: "job_pipeline_artifacts",
    index: "idx_job_pipeline_artifacts_run",
    statement: `CREATE INDEX IF NOT EXISTS idx_job_pipeline_artifacts_run
      ON job_pipeline_artifacts (run_id, artifact_key)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_run_records.create_index_job_run_records_job_idx",
    plane: "index",
    table: "job_run_records",
    index: "job_run_records_job_idx",
    statement: `CREATE INDEX IF NOT EXISTS job_run_records_job_idx ON job_run_records (job_id, started DESC, id DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.job_stage_events.create_index_idx_job_stage_events_run",
    plane: "index",
    table: "job_stage_events",
    index: "idx_job_stage_events_run",
    statement: `CREATE INDEX IF NOT EXISTS idx_job_stage_events_run ON job_stage_events (run_id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_adaptation_audit.create_index_idx_adaptation_audit_subject",
    plane: "index",
    table: "mas_adaptation_audit",
    index: "idx_adaptation_audit_subject",
    statement: `CREATE INDEX IF NOT EXISTS idx_adaptation_audit_subject ON mas_adaptation_audit(subject, created_at)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_chain",
    plane: "index",
    table: "mas_async_jobs",
    index: "idx_mas_async_jobs_chain",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_chain ON mas_async_jobs(chain_id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_parent",
    plane: "index",
    table: "mas_async_jobs",
    index: "idx_mas_async_jobs_parent",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_parent ON mas_async_jobs(parent_job_id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_session_created",
    plane: "index",
    table: "mas_async_jobs",
    index: "idx_mas_async_jobs_session_created",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_session_created ON mas_async_jobs(session_id, created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_status_created",
    plane: "index",
    table: "mas_async_jobs",
    index: "idx_mas_async_jobs_status_created",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_status_created ON mas_async_jobs(status, created_at)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_data_captures.create_index_idx_mas_data_captures_provider",
    plane: "index",
    table: "mas_data_captures",
    index: "idx_mas_data_captures_provider",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_data_captures_provider ON mas_data_captures(tenant_id, provider_id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_data_captures.create_index_idx_mas_data_captures_run",
    plane: "index",
    table: "mas_data_captures",
    index: "idx_mas_data_captures_run",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_data_captures_run ON mas_data_captures(tenant_id, run_id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_data_providers.create_index_idx_mas_data_providers_precedence",
    plane: "index",
    table: "mas_data_providers",
    index: "idx_mas_data_providers_precedence",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_data_providers_precedence ON mas_data_providers(precedence)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_discovery_runs.create_index_idx_mas_discovery_runs_created_at",
    plane: "index",
    table: "mas_discovery_runs",
    index: "idx_mas_discovery_runs_created_at",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_discovery_runs_created_at ON mas_discovery_runs (created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_discovery_setup_runs.create_index_idx_mas_discovery_setup_runs_created_at",
    plane: "index",
    table: "mas_discovery_setup_runs",
    index: "idx_mas_discovery_setup_runs_created_at",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_discovery_setup_runs_created_at ON mas_discovery_setup_runs (created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_enrichment_runs.create_index_idx_mas_enrichment_runs_job",
    plane: "index",
    table: "mas_enrichment_runs",
    index: "idx_mas_enrichment_runs_job",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_enrichment_runs_job ON mas_enrichment_runs (job_id, stage, created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_feed_snapshots.create_index_idx_mas_feed_snapshots_lookup",
    plane: "index",
    table: "mas_feed_snapshots",
    index: "idx_mas_feed_snapshots_lookup",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_feed_snapshots_lookup ON mas_feed_snapshots (user_login, symbol, created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_goals.create_index_idx_mas_goals_user_status",
    plane: "index",
    table: "mas_goals",
    index: "idx_mas_goals_user_status",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_goals_user_status ON mas_goals(user_login, status)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_index_lists.create_index_idx_mas_index_lists_lookup",
    plane: "index",
    table: "mas_index_lists",
    index: "idx_mas_index_lists_lookup",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_index_lists_lookup ON mas_index_lists (index_id, created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_iv_history.create_index_idx_mas_iv_history_symbol_date",
    plane: "index",
    table: "mas_iv_history",
    index: "idx_mas_iv_history_symbol_date",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_iv_history_symbol_date ON mas_iv_history (symbol, date DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_job_outcomes.create_index_idx_mas_job_outcomes_created",
    plane: "index",
    table: "mas_job_outcomes",
    index: "idx_mas_job_outcomes_created",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_job_outcomes_created ON mas_job_outcomes(created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_opportunity_scans.create_index_idx_mas_opportunity_scans_generated_at",
    plane: "index",
    table: "mas_opportunity_scans",
    index: "idx_mas_opportunity_scans_generated_at",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_opportunity_scans_generated_at ON mas_opportunity_scans (generated_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_outcomes.create_index_idx_mas_outcomes_user_scenario",
    plane: "index",
    table: "mas_outcomes",
    index: "idx_mas_outcomes_user_scenario",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_outcomes_user_scenario ON mas_outcomes(user_login, scenario_id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_policy_verdicts.create_index_idx_mas_policy_verdicts_created",
    plane: "index",
    table: "mas_policy_verdicts",
    index: "idx_mas_policy_verdicts_created",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_policy_verdicts_created ON mas_policy_verdicts(created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_reports.create_index_idx_mas_reports_created",
    plane: "index",
    table: "mas_reports",
    index: "idx_mas_reports_created",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_reports_created ON \${TABLE} (created_at DESC)`,
    kind: "schema",
    form: "parameterized",
    parameters: ["TABLE"],
  },
  {
    code: "schema.index.mas_reports.create_index_idx_mas_reports_user",
    plane: "index",
    table: "mas_reports",
    index: "idx_mas_reports_user",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_reports_user ON \${TABLE} (user_login)`,
    kind: "schema",
    form: "parameterized",
    parameters: ["TABLE"],
  },
  {
    code: "schema.index.mas_reports.create_unique_index_idx_mas_reports_generation",
    plane: "index",
    table: "mas_reports",
    index: "idx_mas_reports_generation",
    statement: `CREATE UNIQUE INDEX IF NOT EXISTS idx_mas_reports_generation ON \${TABLE} (user_login, generation_id)`,
    kind: "schema",
    form: "parameterized",
    parameters: ["TABLE"],
  },
  {
    code: "schema.index.mas_scenarios.create_index_idx_mas_scenarios_user_goal",
    plane: "index",
    table: "mas_scenarios",
    index: "idx_mas_scenarios_user_goal",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_scenarios_user_goal ON mas_scenarios(user_login, goal_id)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_screening_activity.create_index_idx_screening_activity_user",
    plane: "index",
    table: "mas_screening_activity",
    index: "idx_screening_activity_user",
    statement: `CREATE INDEX IF NOT EXISTS idx_screening_activity_user ON mas_screening_activity (user_login, created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_strategy_profiles.create_index_idx_mas_strategy_profiles_user_name",
    plane: "index",
    table: "mas_strategy_profiles",
    index: "idx_mas_strategy_profiles_user_name",
    statement: `CREATE INDEX IF NOT EXISTS idx_mas_strategy_profiles_user_name ON mas_strategy_profiles (user_login, name)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_strategy_reviews.create_index_idx_strategy_reviews_decision",
    plane: "index",
    table: "mas_strategy_reviews",
    index: "idx_strategy_reviews_decision",
    statement: `CREATE INDEX IF NOT EXISTS idx_strategy_reviews_decision ON mas_strategy_reviews(decision)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.mas_strategy_reviews.create_index_idx_strategy_reviews_symbol",
    plane: "index",
    table: "mas_strategy_reviews",
    index: "idx_strategy_reviews_symbol",
    statement: `CREATE INDEX IF NOT EXISTS idx_strategy_reviews_symbol ON mas_strategy_reviews(symbol)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.unified_schedules.create_index_unified_schedules_kind_idx",
    plane: "index",
    table: "unified_schedules",
    index: "unified_schedules_kind_idx",
    statement: `CREATE INDEX IF NOT EXISTS unified_schedules_kind_idx ON unified_schedules (kind, created_at ASC, id ASC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.unified_schedules.create_index_unified_schedules_state_idx",
    plane: "index",
    table: "unified_schedules",
    index: "unified_schedules_state_idx",
    statement: `CREATE INDEX IF NOT EXISTS unified_schedules_state_idx ON unified_schedules (state, created_at ASC, id ASC)`,
    kind: "schema",
    form: "literal",
  },
  {
    code: "schema.index.usage_events.create_index_idx_usage_events_user",
    plane: "index",
    table: "usage_events",
    index: "idx_usage_events_user",
    statement: `CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events (user_login, created_at DESC)`,
    kind: "schema",
    form: "literal",
  },
];

/** Build a fresh catalogue holding the DO section. */
export function buildDoCatalogue(): SchemaCatalogue {
  const catalogue = createCatalogue();
  for (const entry of DO_CATALOGUE_ENTRIES) {
    catalogue.register(entry);
  }
  return catalogue;
}

/** The DO section as a registered catalogue (built once at import). */
export const DO_CATALOGUE: SchemaCatalogue = buildDoCatalogue();

/** The table statement for one DO table, byte-identical to the base. */
export function doTableSql(table: string): string {
  return DO_CATALOGUE.get(`schema.do.${table}.create_table`).statement;
}

/** The index statement for one DO index, byte-identical to the base. */
export function doIndexSql(indexName: string): string {
  const entry = DO_CATALOGUE.entries().find((e) => e.index === indexName);
  if (!entry) {
    throw new Error(`no DO catalogue entry for index ${indexName}`);
  }
  return entry.statement;
}

/**
 * Resolve one DO catalogue statement (literal or parameterized)
 * to its executable text. Parameterized entries (the mas_reports
 * ${TABLE} form) resolve through the executor's resolver, so a
 * missing parameter fails closed with MISSING_PARAMETER.
 */
export function doStatementSql(
  code: string,
  params: Record<string, string> = {},
): string {
  return resolveStatementText(DO_CATALOGUE.get(code), params);
}
