# Table distribution — 186 tables across domains

Source: `~/workspace/wnorm/SURVEY.md` Appendix A (main tip `16d39b51`, 2026-11-22). Parsed rows: 197; distinct tables: 184; classified: 184.

## j-stack / execution (job pipeline, run ledger, async jobs, schedules) — 31

- `agent_async_jobs`
- `agent_dead_letter_records`
- `agent_reports`
- `agent_shard_jobs`
- `agent_synthesized_schedules`
- `dlq_depth_state`
- `job_analyzed_datasets`
- `job_delivery_datasets`
- `job_enriched_datasets`
- `job_generated_datasets`
- `job_pipeline_artifacts`
- `job_pipeline_definition_versions`
- `job_pipeline_definitions`
- `job_pipeline_instances`
- `job_run_records`
- `job_stage_events`
- `mas_async_jobs`
- `mas_cancel_previews`
- `mas_delivery_claims`
- `mas_job_outcomes`
- `mas_job_outcomes_meta`
- `mas_ladder_states`
- `mas_learnings`
- `mas_report_confirmations`
- `mas_reports`
- `mas_run_aliases`
- `mas_runs`
- `mas_stage_claims`
- `paused_schedules`
- `pending_schedule_approvals`
- `unified_schedules`

## events / audit — 12

- `agent_audit_chain`
- `agent_audit_policy_actions`
- `agent_audit_policy_settings`
- `agent_proposal_transitions`
- `agent_trace_records`
- `agent_usage_events`
- `agent_work_item_events`
- `iaaa_audit_events`
- `mas_adaptation_audit`
- `mas_events`
- `mas_policy_verdicts`
- `usage_events`

## sessions / identity — 17

- `agent_commercial_accounts`
- `agent_digest_pass_days`
- `agent_digest_sends`
- `agent_digest_subscriber_emails`
- `agent_notification_preferences`
- `agent_onboarding_state`
- `agent_profile_idempotency_keys`
- `agent_store_operators`
- `agent_tenant_channels`
- `agent_tenant_projection_carriers`
- `agent_tenant_settings`
- `agent_user_profiles`
- `kv_store`
- `mas_agent_workspace_files`
- `mas_memory`
- `mas_messages`
- `webhook_replay_nonces`

## payments / commerce — 38

- `agent_approved_free_quota_counts`
- `agent_approved_free_quota_settings`
- `agent_approved_free_quotas`
- `agent_billing_customers`
- `agent_billing_policy`
- `agent_bulk_moves`
- `agent_bundle_entitlements`
- `agent_bundle_purchases`
- `agent_cfpay_channel_purchases`
- `agent_code_redemption_counts`
- `agent_code_redemptions`
- `agent_code_run_balances`
- `agent_credit_claims`
- `agent_credit_redemptions`
- `agent_free_access_grants`
- `agent_free_run_allowances`
- `agent_free_run_counts`
- `agent_journal_accounts`
- `agent_journal_entries`
- `agent_native_ledger_rows`
- `agent_paid_submissions`
- `agent_payment_proof_redemptions`
- `agent_product_bundles`
- `agent_products`
- `agent_referral_attributions`
- `agent_referral_code_rules`
- `agent_referral_codes`
- `agent_referral_earnings`
- `agent_referral_rules`
- `agent_refund_policy`
- `agent_refunds`
- `agent_subscription_plans`
- `agent_subscriptions`
- `agent_top_up_drafts`
- `agent_version_moves`
- `mas_transactions`
- `user_request_quota_charges`
- `user_request_quota_overrides`

## trading (screener, discovery, strategy, market data) — 46

- `agent_breaker_state`
- `agent_calibration_decisions`
- `agent_chain_audit`
- `agent_chains`
- `agent_data_captures`
- `agent_data_provider_routes`
- `agent_data_providers`
- `agent_iv_history`
- `agent_market_edges`
- `agent_market_nodes`
- `agent_thesis_realizations`
- `breaker_trip_alerts`
- `mas_autopilot`
- `mas_challenger_approvals`
- `mas_challenger_promotions`
- `mas_challengers`
- `mas_comparison_arm_outcomes`
- `mas_data_captures`
- `mas_data_provider_routes`
- `mas_data_providers`
- `mas_discovery_alerts`
- `mas_discovery_runs`
- `mas_discovery_setup_runs`
- `mas_enrichment_runs`
- `mas_feed_datasets`
- `mas_feed_snapshots`
- `mas_goals`
- `mas_index_lists`
- `mas_iv_history`
- `mas_opportunity_scans`
- `mas_options_chain_cache`
- `mas_outcome_tracking`
- `mas_outcomes`
- `mas_scenarios`
- `mas_screening_activity`
- `mas_trades`
- `quote_source_setting`
- `research_evaluations`
- `research_runs`
- `research_settings`
- `research_task_store`
- `screen_run_locks`
- `stock_copilot_activity`
- `stock_copilot_control`
- `stock_copilot_learnings`
- `stock_copilot_positions`

## pickers / selection (presets, strategy bank, runs packs, watchlists) — 15

- `agent_offer_suppressions`
- `agent_price_catalogue`
- `agent_runs_pack_balances`
- `agent_runs_pack_drafts`
- `agent_runs_pack_versions`
- `mas_screener_presets`
- `mas_strategy_bank_active`
- `mas_strategy_bank_proposals`
- `mas_strategy_gates`
- `mas_strategy_profiles`
- `mas_strategy_reviews`
- `mas_strategy_weight_caps`
- `mas_strategy_weight_versions`
- `mas_strategy_weights_v2`
- `mas_watchlists`

## marketplace / growth — 9

- `agent_ads`
- `agent_categories`
- `agent_external_ads`
- `agent_referrals`
- `mas_ads`
- `mas_categories`
- `mas_external_ads`
- `mas_promotions`
- `mas_referrals`

## governance / fleet / mesh — 7

- `agent_conformance_cells`
- `agent_fleet_registry`
- `agent_governance`
- `agent_mesh_eval_results`
- `agent_mesh_proposals`
- `agent_mesh_trace_hops`
- `agent_proposals`

## observability / resources — 5

- `otel_config_overrides`
- `resource_alert_state`
- `resource_comparison_reports`
- `resource_daily_rollups`
- `resource_sql_ops`

## config / schema infra — 4

- `_migrations`
- `mas_do_schema_marker`
- `mas_schema_migrations`
- `mas_settings`

