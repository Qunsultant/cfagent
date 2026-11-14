/**
 * #4282 P2b — DO catalogue: the Durable Object adapters delegate to the
 * catalogue.
 *
 * The catalogue is the DO plane's single home for statement text; the
 * 49 DO adapters and the two schema-marker modules assemble their DDL
 * from its codes and remain the executors (delegation, not absorption).
 * The DO execution idiom is unchanged: `this.sql.exec(...)` against
 * the DO SqlStorage handle, with the catalogue statement as the
 * argument.
 *
 * Anchors (measured from the base tree b3062e2e, before the delegation
 * — never re-derived from the delegated helpers):
 *  - DO_STATEMENT_SHA256: sha256 of each catalogue entry's statement.
 *    A change to any statement's text — a column, a DEFAULT, even
 *    whitespace — fails this pin. The statements are byte-identical
 *    to the base helpers' executed strings, including the
 *    leading/trailing whitespace of the adapters' template literals.
 *  - The expected-model fixture
 *    (tests/schema_component_do_expected_model.json): the DO model
 *    built by executing the 103 catalogue statements (parameterized
 *    mas_reports entries resolved with their table) plus the two
 *    ORM-catalogue indexes the DO adapters execute, through the P0
 *    InMemorySchemaInstance — 66 tables, 39 indexes. Regenerate only
 *    with the generator script
 *    ~/workspace/w4282/evidence-p2b/gen-do-catalogue.ts run against
 *    the base tree, and review the refreshed fixture in the PR diff:
 *    a refresh that changes an existing table without a migration is
 *    a defect, not a cleanup (same discipline as the grep baseline).
 *  - The executed-list pin fixture
 *    (tests/schema_component_do_base_sql.json): the ordered statement
 *    list every adapter's ensure path executes on the base tree,
 *    captured with a RecordingSqlStorage. The delegated adapters must
 *    execute exactly these lists — statement text unchanged, no logic
 *    change.
 *
 * Scope correction (measured on the tip, not the filing counts): 103
 * statements, not the filed ~112. The filing's "76 TABLE / 35 INDEX"
 * is a grep count — 9 of the 77 TABLE lines are comment mentions,
 * 2 are the frozen JobPipeline v1 migration copies, and 2 of the
 * executed indexes already live in the ORM catalogue. The 48
 * probed/guarded reconciliation statements stay inline until P3's
 * reconciliation catalogue; they are asserted as the only remaining
 * inline DDL in the delegated files (plus the 2 frozen JobPipeline
 * v1 copies and 1 log message).
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockSqlStorage } from "./mock-sql";
import {
  DO_CATALOGUE,
  DO_CATALOGUE_ENTRIES,
  buildDoCatalogue,
  doIndexSql,
  doStatementSql,
  doTableSql,
} from "../src/data/schemaComponent/doCatalogue";
import { ormIndexSql, ORM_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/ormCatalogue";
import { validateCatalogueEntry } from "../src/data/schemaComponent/catalogue";
import { resolveStatementText } from "../src/data/schemaComponent/executor";
import {
  InMemorySchemaInstance,
  diffSchema,
  type SchemaModel,
} from "../src/data/schemaComponent/equalityHarness";

import { DoSqliteAdaptationAuditStore } from "../src/data/doSqliteAdaptationAuditAdapter";
import {
  ANALYZED_DATASETS_DDL,
  ANALYZED_DATASETS_INDEX_DDL,
  ANALYZED_DATASET_SCHEMA_MIGRATION,
  DoSqliteAnalyzedDatasetStore,
} from "../src/data/doSqliteAnalyzedDatasetAdapter";
import { DoSqliteAsyncJobStore } from "../src/data/doSqliteAsyncJobAdapter";
import { DoSqliteAutopilotStateStore } from "../src/data/doSqliteAutopilotStateAdapter";
import { DoSqliteCanonicalReportStore } from "../src/data/doSqliteCanonicalReportStoreAdapter";
import { DoSqliteChallengerStore } from "../src/data/doSqliteChallengerAdapter";
import { DoSqliteComparisonLedgerStore } from "../src/data/doSqliteComparisonLedgerAdapter";
import {
  DELIVERY_DATASETS_DDL,
  DELIVERY_DATASETS_INDEX_DDL,
  DELIVERY_DATASET_SCHEMA_MIGRATION,
  DoSqliteDeliveryDatasetStore,
} from "../src/data/doSqliteDeliveryDatasetAdapter";
import { SqlDiscoveryAlertStore } from "../src/data/doSqliteDiscoveryAlertAdapter";
import { SqlDiscoveryRunStore } from "../src/data/doSqliteDiscoveryRunAdapter";
import { SqlDiscoverySetupStore } from "../src/data/doSqliteDiscoverySetupAdapter";
import {
  ENRICHED_DATASETS_DDL,
  ENRICHED_DATASETS_INDEX_DDL,
  ENRICHED_DATASET_SCHEMA_MIGRATION,
  DoSqliteEnrichedDatasetStore,
} from "../src/data/doSqliteEnrichedDatasetAdapter";
import { SqlEnrichmentStore } from "../src/data/doSqliteEnrichmentAdapter";
import { SqlFeedSnapshotStore } from "../src/data/doSqliteFeedSnapshotAdapter";
import {
  GENERATED_DATASETS_DDL,
  GENERATED_DATASETS_INDEX_DDL,
  GENERATED_DATASET_SCHEMA_MIGRATION,
  DoSqliteGeneratedDatasetStore,
} from "../src/data/doSqliteGeneratedDatasetAdapter";
import { DoSqliteGoalScenarioStore } from "../src/data/doSqliteGoalScenarioAdapter";
import { SqlIndexListStore } from "../src/data/doSqliteIndexListAdapter";
import { SqlIvHistoryStore } from "../src/data/doSqliteIvHistoryAdapter";
import { DoSqliteJobOutcomeStore } from "../src/data/doSqliteJobOutcomeAdapter";
import {
  JOB_PIPELINE_ARTIFACTS_DDL,
  JOB_PIPELINE_ARTIFACTS_INDEX_DDL,
  JOB_PIPELINE_DEFINITIONS_DDL,
  JOB_PIPELINE_INSTANCES_DDL,
  JOB_PIPELINE_SCHEMA_MIGRATION,
  DoSqliteJobPipelineStores,
} from "../src/data/doSqliteJobPipelineAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { createDoSqliteJobStageEventStore } from "../src/data/doSqliteJobStageEventAdapter";
import {
  MAS_SETTINGS_DDL,
  DoSqliteSettingsAdapter,
} from "../src/data/doSqliteOrmAdapters";
import { DoSqliteOutcomeTrackingStore } from "../src/data/doSqliteOutcomeTrackingAdapter";
import { SqlPausedScheduleStore } from "../src/data/doSqlitePausedScheduleAdapter.deprecated";
import { SqlPendingScheduleApprovalStore } from "../src/data/doSqlitePendingScheduleApprovalsAdapter";
import { DoSqlitePolicyVerdictStore } from "../src/data/doSqlitePolicyVerdictAdapter";
import { ensureCaptureTable } from "../src/data/doSqliteProviderCaptureAdapter";
import {
  ensureProviderConfigTable,
  ensureProviderRoutingTable,
} from "../src/data/doSqliteProviderConfigAdapter";
import { DoSqliteReportConfirmationStore } from "../src/data/doSqliteReportConfirmationAdapter";
import {
  DoSqliteResearchSettingsStore,
  DoSqliteResearchTaskStore,
  DoSqliteResearchRunStore,
  DoSqliteResearchEvaluationStore,
} from "../src/data/doSqliteResearchStoreAdapter";
import { DoSqliteReselectionStore } from "../src/data/doSqliteReselectionAdapter";
import { SqlScanRunStore } from "../src/data/doSqliteScanRunAdapter";
import {
  SCREEN_RUN_LOCK_SCHEMA_MIGRATION,
  DoSqliteScreenRunLock,
} from "../src/data/doSqliteScreenRunLockAdapter";
import { DoSqliteScreenerPresetStore } from "../src/data/doSqliteScreenerPresetAdapter";
import { DoSqliteScreeningActivityStore } from "../src/data/doSqliteScreeningActivityAdapter";
import { DoSqliteStockCopilotPositionStore } from "../src/data/doSqliteStockCopilotStoreAdapter";
import {
  DoSqliteStockCopilotActivityStore,
  DoSqliteStockCopilotControlStore,
  DoSqliteStockCopilotMemoryStore,
} from "../src/data/doSqliteStockCopilotSurfaceAdapter";
import { DoSqliteStrategyPolicyStore } from "../src/data/doSqliteStrategyPolicyAdapter";
import { SqlStrategyProfileStore } from "../src/data/doSqliteStrategyProfileAdapter";
import { DoSqliteStrategyReviewStore } from "../src/data/doSqliteStrategyReviewAdapter";
import { DoSqliteStrategyWeightsStore } from "../src/data/doSqliteStrategyWeightsAdapter";
import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import { DoSqliteUsageEventStore } from "../src/data/doSqliteUsageEventAdapter";
import { DoSqliteUserRequestQuota } from "../src/data/doSqliteUserRequestQuotaAdapter";
import { ensureWorkspaceSqlSchema } from "../src/data/doSqliteWorkspaceStoreAdapter";
import { DoSessionStoreAdapter } from "../src/data/doSessionStoreAdapter";
import { readDoSchemaVersion } from "../src/data/doSchemaMarker";
import { listAppliedDoSchemaMigrations } from "../src/data/doSchemaMigrations";

/** sha256 of each catalogue entry's statement, measured from the base helpers. */
const DO_STATEMENT_SHA256: Record<string, string> = {
  "schema.do.job_analyzed_datasets.create_table": "27e6d73511b1f28cde32f099b94ce509fbbd86bce368bfcb3eb68d19211e9c15",
  "schema.do.job_delivery_datasets.create_table": "9b2956cad80923dda2660f45541488b0da2d26ef5f2b18c18638afafef2d9054",
  "schema.do.job_enriched_datasets.create_table": "d86886dbf7ed0391ad5d3d4454fe8f89d3530fcc22afad37e4e8a17322e0d969",
  "schema.do.job_generated_datasets.create_table": "ff6c2c27c5d78fa8f43e69823ab661957db54e23f1184a3e84468fc8fc04ca84",
  "schema.do.job_pipeline_artifacts.create_table": "7b6f844398cf553abd6377e3f5a0e6d024945cc5a7a1995ff2cfa562479c715a",
  "schema.do.job_pipeline_definitions.create_table": "63e75c48b6a9568f8b746518374b1ea721667aa8c19f6911589ace3db38d59c6",
  "schema.do.job_pipeline_instances.create_table": "f69e0f462cb1418c687b6a970bd9ef035c8280f8a0a2b22a20e1e93b44bcf704",
  "schema.do.job_run_records.create_table": "13ece01aa0866f3c8ae8c317ab922c8a6491aa6cd6bd4963b0e259fbfa2c915b",
  "schema.do.job_stage_events.create_table": "35c76adfe72cfa7a970a51db32c0c53ea7e3d3a97a50f3d631882f9448840aca",
  "schema.do.kv_store.create_table": "516aa66d405986dc7230f7154a6b0365cb02a91f2ddd1972033286553634e661",
  "schema.do.mas_adaptation_audit.create_table": "de2de2116954a30edbdbb3a2da6500146c6303485e577368ebd0abff5d6eb7b8",
  "schema.do.mas_agent_workspace_files.create_table": "84a9b347798fbeab8d30c2be4e390ade91cb6dc59663250f2dd42ec23fc79d97",
  "schema.do.mas_async_jobs.create_table": "2211b6e5e708bffe2b3937180e65d1919ec6903ebd0d30544ef0d90a6b8432a5",
  "schema.do.mas_autopilot.create_table": "a9c7d32ded16e9094588aef398ad7856ba973ea0246d27daea2e957c03e8805c",
  "schema.do.mas_challenger_approvals.create_table": "c24e017890ce9d00adcb13740b09b19c30ec5f1c3966527f4799361fda56797b",
  "schema.do.mas_challenger_promotions.create_table": "f740a2f0f155a052979499970900d94f6c21266ddb12b780a6dc7d255c09ce34",
  "schema.do.mas_challengers.create_table": "1ea2f19c19f6da65b5764cf9d570135645d4dab608819480190a212e8f1b0b4f",
  "schema.do.mas_comparison_arm_outcomes.create_table": "c44c5df6aea1aa7db50125671014c083f93371a5105106d568d10efd9af2dc2f",
  "schema.do.mas_data_captures.create_table": "3642beccf3b977c4a53a9579a6054475f9dbc5025b6a717a499e9f2221c3c301",
  "schema.do.mas_data_provider_routes.create_table": "a7114a94f1b309c12efe8251836181e034abebadec540e4426c419b8d3c04e56",
  "schema.do.mas_data_providers.create_table": "c02d147910fc5297d4c0d40ccd0a0dfc242c3d6c44a1ed183ed47f6157aa3e9a",
  "schema.do.mas_discovery_alerts.create_table": "100c8c0540577981346d0f9f4863b6246e331da43f86d9b61e30a2afc734758b",
  "schema.do.mas_discovery_runs.create_table": "4fa9e32fdcc2ec421ea21f62c033a7bbca88d91a4c398dfd3ef716c3ec1b47cf",
  "schema.do.mas_discovery_setup_runs.create_table": "8f11ea1dedd2ba58559c568ee1de762a544e2854df04c857168f5e2760af0853",
  "schema.do.mas_do_schema_marker.create_table": "ba9411f24a11c84a97c8373d5eef6f647dfb0efdf50f2d49141efe76b105b9e6",
  "schema.do.mas_enrichment_runs.create_table": "7e2c9491097bd5b2ad11929acdc6f89170ecff89600c5701c5399b49dd7bac7c",
  "schema.do.mas_feed_snapshots.create_table": "be59373f1b7545b55b3ac92e699476cb34c1b67d57b2f4c7e774b92cc32237cd",
  "schema.do.mas_goals.create_table": "adf0ef40acf4a06c146cb0997677bc441aefaf128984435f8520324911078160",
  "schema.do.mas_index_lists.create_table": "9279f97695765e5013be8cea4116546ffe4cf360c41de1e2964edbe0f2f94579",
  "schema.do.mas_iv_history.create_table": "c112a3afedf16bbfbbaebb6932f0bbe3fc21e3c27581e09e40d10ad169d829b0",
  "schema.do.mas_job_outcomes.create_table": "7fcd1b9a603d3882ed26aab26009d4bd8c380b205630396e0b34da906fea4e83",
  "schema.do.mas_job_outcomes_meta.create_table": "5665b8d99a650d75bf97236e459b068bc79889ef83aea044f4566b166b1f956b",
  "schema.do.mas_opportunity_scans.create_table": "e7738286ef07beb2670f3c1ace7e4d0168b7344414e6397089db2b42ca78f011",
  "schema.do.mas_outcome_tracking.create_table": "42f1d3ef5d275c57082d64bb80a98e6863cb12146e73cddd86f5f02d1ea2a530",
  "schema.do.mas_outcomes.create_table": "bb6f6cc6480f3ec9d50fa1e5933661c072caa38cca0402dac464bf0d437aed87",
  "schema.do.mas_policy_verdicts.create_table": "d05f7fc4f9d4db430c9344d6a1e86422fb80770a3c7bb254128a321b640945ed",
  "schema.do.mas_report_confirmations.create_table": "9089cbc440a8c6f0bbd0859903e3ecb04b41bc15795fafc6fdbe3b225c2f5fa9",
  "schema.do.mas_reports.create_table": "6497bc8d4ea00782bdff77ed66ee52748cb14391f1b84e1fc18ca7970337ac6d",
  "schema.do.mas_scenarios.create_table": "77a1cd6199041e19eb5c2a4e9f2c31a245c8e35c482fac2d421338cd1ff7c3f7",
  "schema.do.mas_schema_migrations.create_table": "2b72c0f1dad94ceab100307f43a9cb4ad09433b7769cf156d852c6f7b3f606b9",
  "schema.do.mas_screener_presets.create_table": "308aa3f367dba54e4e334e3d6a21794cdfd499f5c97ba12df1780e7721a9e536",
  "schema.do.mas_screening_activity.create_table": "941c0d9d996174a57d5f4ec625bdf9902df5f566ddae71a316a392d65d709d92",
  "schema.do.mas_settings.create_table": "2bafeee3d1cdf46c8bdfaf3257a917e3635e291545e0a77fc3a173f197692d6a",
  "schema.do.mas_strategy_bank_active.create_table": "775a06ec9ed1320f850c7d8d7f462138655dc93c2366235c35a2620c51e810d2",
  "schema.do.mas_strategy_bank_proposals.create_table": "ce543e9b6a34481ef185b49676c874384532d724aee802ff91023ad453e48a10",
  "schema.do.mas_strategy_gates.create_table": "27c908be0302783c8f610bda35f96e9efdb8ba5bcca90a63370292d461f2636a",
  "schema.do.mas_strategy_profiles.create_table": "8af63bf6566411f0be54f994aab4d8b0ece10af40bc0180a6e0f380f55d45f0d",
  "schema.do.mas_strategy_reviews.create_table": "3f284b067b23f1c1814f144cdb4c9cbf918a714d249f16e38aacba6964a9a160",
  "schema.do.mas_strategy_weight_caps.create_table": "85a93a3251ca4e78aef4fb81487b9849dfa0ab4bdf99820244e7d7874992ed89",
  "schema.do.mas_strategy_weight_versions.create_table": "ab3be8b16deda44af426c9cfe7ff95b36800b883cd227ae047da501d7e78771d",
  "schema.do.mas_strategy_weights_v2.create_table": "160e7684757d833ffde85f0f3eb0cd371096987730307fb5922e95c45365e399",
  "schema.do.paused_schedules.create_table": "9ecf887c37c7bd63e915b27a57624026fb1b0771079d3daeb6e55b578c6f76da",
  "schema.do.pending_schedule_approvals.create_table": "b81dd5b87b77cea20b9eda34a70258d768d0f7fe8ad93dfa2ffd22db027ad687",
  "schema.do.research_evaluations.create_table": "fe1a7d70bf58b0f4982f6673e037fce98250fed49981fb858ce06273422aee81",
  "schema.do.research_runs.create_table": "28733d511d8b6ddbe686da1eee09c93a74da0dcccac1d707aabdce0e9c03b461",
  "schema.do.research_settings.create_table": "a5b4bddb3d6595027e6eb31a5b654c116b1c372aec8973ce031dcd98bbbc2ef7",
  "schema.do.research_task_store.create_table": "5a469f9e633cbcdfb3f01fd7388fade217a1a0509002eef551e4549ccd6f94df",
  "schema.do.screen_run_locks.create_table": "5c13dc3d8dcf0f7166a50e78049b3354c5592e2de60e8522c6dbf56f2fbe699d",
  "schema.do.stock_copilot_activity.create_table": "4201a06ef780ff4cdde0cc2bb772b9b863f06e329405f987f637cb04608d8e00",
  "schema.do.stock_copilot_control.create_table": "14a66be1a55e1b570348f993afac1ce061a73dca0c90340fa54fc689f589f4f8",
  "schema.do.stock_copilot_learnings.create_table": "9f5f6ab3cb8ebadc7f8ad38f686f0c3c9f7b51b2c1ca2e1552ce76bfb47aaf5d",
  "schema.do.stock_copilot_positions.create_table": "b8a30f4e31a09c2a6761984d8075c5a2d22bf8038f1cfb0a560c2cf7e79a876e",
  "schema.do.unified_schedules.create_table": "a380b367f6f2c907456a3e689ceaeae0b239b927fa81c504d1c54ac0e4fab14c",
  "schema.do.usage_events.create_table": "39928d777a615301df03c022d2ead4deeff205f3e5c843f607cd0ba0d14b1801",
  "schema.do.user_request_quota_charges.create_table": "5ad5ffeac557a26afc06def41a1d3de3d818cdbefb66e561bc39d05e55032499",
  "schema.do.user_request_quota_overrides.create_table": "cd0d6cfa079309a60b904c95caa9cf34301d53a369eb0139085e3e421ea17380",
  "schema.index.job_analyzed_datasets.create_index_idx_job_analyzed_datasets_job": "c167804c3c6bbec4bc4ceff29ae60f6fb389004027a666667f4679c1370e735d",
  "schema.index.job_delivery_datasets.create_index_idx_job_delivery_datasets_job": "c8770b9eb47a6a0824de0e0a4bb8547f10ab347773d1db935101bf9f5c38773f",
  "schema.index.job_enriched_datasets.create_index_idx_job_enriched_datasets_job": "bc0ea9f7304d15727441c7b1327d32b5d80d676f6e72fd307aa12ab243c91d1f",
  "schema.index.job_generated_datasets.create_index_idx_job_generated_datasets_job": "45532de396aa9134aa2a70fd69e9a02973c307ef1f6e3a3d1b24a3efc465ca34",
  "schema.index.job_pipeline_artifacts.create_index_idx_job_pipeline_artifacts_run": "03b7783865e06fc3f7ea9c15b171e94d81f5dad8bd3a4f173fe16fd5cb06d166",
  "schema.index.job_run_records.create_index_job_run_records_job_idx": "15e1b0c2660b27c6ec80676c369b4c9e53f76ee33d98342d6921118e74b5af47",
  "schema.index.job_stage_events.create_index_idx_job_stage_events_run": "4cc73fb84a740562077dec630b5614619ae0826f55a8790b6efbf94343fc7a13",
  "schema.index.mas_adaptation_audit.create_index_idx_adaptation_audit_subject": "64f90b29c7fa125891a0a9f5e07b1f49f988739c987dbd69666bcc63502603df",
  "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_chain": "dac23ae92ced221f0cb95e9e736f7b233379b36c27d55d01ab1cd8d14ac02f6d",
  "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_parent": "69808db381d3f03afcde826676d44ec3159be17436bf063fdd79b88e151d7fb1",
  "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_session_created": "2a3eb01a0566a74766b96a819042bf477a0bfd99a55d32adee4b625de7266536",
  "schema.index.mas_async_jobs.create_index_idx_mas_async_jobs_status_created": "10714e710c8d794c8af66d8251a884c79ca63f1efbab694a6b6c6dee46e2f34e",
  "schema.index.mas_data_captures.create_index_idx_mas_data_captures_provider": "b0b18872e4f735169d97f33c0c83c3a361fa1129c2236edd19d579b2bc2de414",
  "schema.index.mas_data_captures.create_index_idx_mas_data_captures_run": "564884a0070d83c206f0a4c4cc97cc309592c5535ca88d557c5534a0dfd0f753",
  "schema.index.mas_data_providers.create_index_idx_mas_data_providers_precedence": "1e86bd9877db7fceef3c39a30d2f8e763dfbfea30d5147edc7defe3b632f28fd",
  "schema.index.mas_discovery_runs.create_index_idx_mas_discovery_runs_created_at": "1f3a93cd56e72efd3809f96fafb088fa5a07f15df78493f7c840462034e24222",
  "schema.index.mas_discovery_setup_runs.create_index_idx_mas_discovery_setup_runs_created_at": "34b8fe41811f5f1081517df59cbad61a177937360105af60e5ce343ab3b9c5fd",
  "schema.index.mas_enrichment_runs.create_index_idx_mas_enrichment_runs_job": "568e02fad51170eb889ea7187c27ab2ad77c53fe24492c67add782f4c38b4280",
  "schema.index.mas_feed_snapshots.create_index_idx_mas_feed_snapshots_lookup": "b8edf91d082cca815acdb9a4bd670ae8503f3f68055af0be41051735cdaaac1c",
  "schema.index.mas_goals.create_index_idx_mas_goals_user_status": "08af24a63424204e010200a7b5974949af5d00b63ebb2381fc95d2ea474cb6d8",
  "schema.index.mas_index_lists.create_index_idx_mas_index_lists_lookup": "a0ee1a43093d88bfec6301bbcc5cd75164fcb1e22c486a7c4e9164b4910c9776",
  "schema.index.mas_iv_history.create_index_idx_mas_iv_history_symbol_date": "40a6f90477ca8a693ece00a7f0d817f69cb7903872877dea77ba13610f54c61d",
  "schema.index.mas_job_outcomes.create_index_idx_mas_job_outcomes_created": "c6e8f53f1283a691671a5f630a15d4c6d712f0a2bb3ecd48483908a9eea6449b",
  "schema.index.mas_opportunity_scans.create_index_idx_mas_opportunity_scans_generated_at": "0aefb25fbaab5e4d0498d6a1b30d4ec672421c6bb57b0e8526fb53a0c125f7e2",
  "schema.index.mas_outcomes.create_index_idx_mas_outcomes_user_scenario": "00ab2b9b5298627188f91bfd5425a9c3d4e658ccfe12e894dd8c341327488bc4",
  "schema.index.mas_policy_verdicts.create_index_idx_mas_policy_verdicts_created": "9053c5868ad18dd4a1d389c2a90701e32c076b82d6be450afb4a4f7ccd302210",
  "schema.index.mas_reports.create_index_idx_mas_reports_created": "57edb073991c2d894e22df47d762b1984114e0210a3fed590e28c8a27d570ac9",
  "schema.index.mas_reports.create_index_idx_mas_reports_user": "aea8f447c088a1973df99347a25c0de542704c03c8cf1a433a5da896f4e44989",
  "schema.index.mas_reports.create_unique_index_idx_mas_reports_generation": "67d1f62e148eb78e60c90f7bd9f7cea398187c9203eb36e9f2043f78874935f2",
  "schema.index.mas_scenarios.create_index_idx_mas_scenarios_user_goal": "99a7456ee829ea93b326e0cca7ac86a99f29362dffc01895a31892e169cd371c",
  "schema.index.mas_screening_activity.create_index_idx_screening_activity_user": "373d64333717cfefad92b52e7be1ee2db1820e72e3de8f76523733944a9c8216",
  "schema.index.mas_strategy_profiles.create_index_idx_mas_strategy_profiles_user_name": "77233cfae0409fab0b6e0fcb262ef2c9b78c89c86428d298b110e75d55a55220",
  "schema.index.mas_strategy_reviews.create_index_idx_strategy_reviews_decision": "22b7df08edd42b1cdc86610ed1ef7658356b8f0036e04e1047c9c47202679318",
  "schema.index.mas_strategy_reviews.create_index_idx_strategy_reviews_symbol": "dcbb594b17fac29932d8ba65b48db34d0532860b3fc410bfbe904fff752396a6",
  "schema.index.unified_schedules.create_index_unified_schedules_kind_idx": "777e049a05fde276b484bb3a7b2c90d65f89d4e0ea9aa8a2a428e9ef03dbf1de",
  "schema.index.unified_schedules.create_index_unified_schedules_state_idx": "f0a8ccc3aca646a2effb847bdd363174ea01896f1486a62c28020e7a50454f70",
  "schema.index.usage_events.create_index_idx_usage_events_user": "a51856829519f0695692fb0c51bae86da2432e538055442f127d8ae3525626f4",
};

/** sha256 of the two frozen JobPipeline v1 migration copies (history — never the live consts). */
const FROZEN_JOB_PIPELINE_DEFINITIONS_SHA256 =
  "63e75c48b6a9568f8b746518374b1ea721667aa8c19f6911589ace3db38d59c6";
const FROZEN_JOB_PIPELINE_INSTANCES_SHA256 =
  "0fa9e16462343d5cd5be880d0767fdfa1ef4175bdde89dfcceb9d9ce8983cf19";

const BASE_SQL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema_component_do_base_sql.json",
);
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema_component_do_expected_model.json",
);

function expectedDoModel(): SchemaModel {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as SchemaModel;
}

interface BaseCapture {
  adapter: string;
  file: string;
  trigger: string;
  queries: string[];
}

function baseCaptures(): BaseCapture[] {
  return (JSON.parse(readFileSync(BASE_SQL_PATH, "utf8")) as {
    captures: BaseCapture[];
  }).captures;
}

/** MockSqlStorage that records every statement it is asked to execute. */
class RecordingSqlStorage extends MockSqlStorage {
  readonly queries: string[] = [];
  override exec(query: string, ...args: unknown[]): Iterable<unknown> {
    this.queries.push(query);
    return super.exec(query, ...args);
  }
}

type AnyStore = Record<string, unknown>;

function callEnsure(store: AnyStore, method: string): void {
  const fn = store[method];
  if (typeof fn !== "function") {
    throw new Error(`no method ${method} on store`);
  }
  (fn as () => void).call(store);
}

/**
 * Drive every adapter's ensure path on a fresh recorder, in the same
 * order as the base capture. This is the same driver the generator
 * used on the base tree — the executed-list pin below asserts the
 * delegated adapters reproduce those lists exactly.
 */
async function driveAll(): Promise<BaseCapture[]> {
  const captures: BaseCapture[] = [];
  const pending: Array<Promise<void>> = [];
  const cap = (
    adapter: string,
    file: string,
    trigger: string,
    run: (rec: RecordingSqlStorage) => unknown,
  ) => {
    const rec = new RecordingSqlStorage();
    const out = run(rec);
    if (out instanceof Promise) {
      pending.push(
        out.then(() => {
          captures.push({ adapter, file, trigger, queries: rec.queries });
        }),
      );
      return;
    }
    captures.push({ adapter, file, trigger, queries: rec.queries });
  };

  cap("DoSqliteAdaptationAuditStore", "doSqliteAdaptationAuditAdapter.ts", "ensureTable()", (rec) =>
    new DoSqliteAdaptationAuditStore(rec as never).ensureTable());
  cap("DoSqliteAnalyzedDatasetStore", "doSqliteAnalyzedDatasetAdapter.ts", "ensureSchema() [private]", (rec) =>
    callEnsure(new DoSqliteAnalyzedDatasetStore(rec as never) as unknown as AnyStore, "ensureSchema"));
  cap("DoSqliteAsyncJobStore", "doSqliteAsyncJobAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteAsyncJobStore(rec as never).ensureSchema());
  cap("DoSqliteAutopilotStateStore", "doSqliteAutopilotStateAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteAutopilotStateStore(rec as never).ensureSchema());
  cap("DoSqliteCanonicalReportStore", "doSqliteCanonicalReportStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteCanonicalReportStore(rec as never).ensureSchema());
  cap("DoSqliteChallengerStore", "doSqliteChallengerAdapter.ts", "ensureTables()", (rec) =>
    new DoSqliteChallengerStore(rec as never).ensureTables());
  cap("DoSqliteComparisonLedgerStore", "doSqliteComparisonLedgerAdapter.ts", "ensureTable()", (rec) =>
    new DoSqliteComparisonLedgerStore(rec as never).ensureTable());
  cap("DoSqliteDeliveryDatasetStore", "doSqliteDeliveryDatasetAdapter.ts", "ensureSchema() [private]", (rec) =>
    callEnsure(new DoSqliteDeliveryDatasetStore(rec as never) as unknown as AnyStore, "ensureSchema"));
  cap("SqlDiscoveryAlertStore", "doSqliteDiscoveryAlertAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlDiscoveryAlertStore(rec as never) as unknown as AnyStore, "ensure"));
  cap("SqlDiscoveryRunStore", "doSqliteDiscoveryRunAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlDiscoveryRunStore(rec as never) as unknown as AnyStore, "ensure"));
  cap("SqlDiscoverySetupStore", "doSqliteDiscoverySetupAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlDiscoverySetupStore(rec as never) as unknown as AnyStore, "ensure"));
  cap("DoSqliteEnrichedDatasetStore", "doSqliteEnrichedDatasetAdapter.ts", "ensureSchema() [private]", (rec) =>
    callEnsure(new DoSqliteEnrichedDatasetStore(rec as never) as unknown as AnyStore, "ensureSchema"));
  cap("SqlEnrichmentStore", "doSqliteEnrichmentAdapter.ts", "ensureTables()", (rec) =>
    new SqlEnrichmentStore(rec as never).ensureTables());
  cap("SqlFeedSnapshotStore", "doSqliteFeedSnapshotAdapter.ts", "ensureTables() [private]", (rec) =>
    callEnsure(new SqlFeedSnapshotStore(rec as never) as unknown as AnyStore, "ensureTables"));
  cap("DoSqliteGeneratedDatasetStore", "doSqliteGeneratedDatasetAdapter.ts", "ensureSchema() [private]", (rec) =>
    callEnsure(new DoSqliteGeneratedDatasetStore(rec as never) as unknown as AnyStore, "ensureSchema"));
  cap("DoSqliteGoalScenarioStore", "doSqliteGoalScenarioAdapter.ts", "ensureTables()", (rec) =>
    new DoSqliteGoalScenarioStore(rec as never).ensureTables());
  cap("SqlIndexListStore", "doSqliteIndexListAdapter.ts", "ensureTables() [private]", (rec) =>
    callEnsure(new SqlIndexListStore(rec as never) as unknown as AnyStore, "ensureTables"));
  cap("SqlIvHistoryStore", "doSqliteIvHistoryAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlIvHistoryStore(rec as never) as unknown as AnyStore, "ensure"));
  cap("DoSqliteJobOutcomeStore", "doSqliteJobOutcomeAdapter.ts", "ensureTables()", (rec) =>
    new DoSqliteJobOutcomeStore(rec as never).ensureTables());
  cap("DoSqliteJobOutcomeStore.maybePrune", "doSqliteJobOutcomeAdapter.ts", "maybePrune(0) — non-ensure path: ensureMetaTable()", (rec) =>
    new DoSqliteJobOutcomeStore(rec as never).maybePrune(0));
  cap("DoSqliteJobPipelineStores", "doSqliteJobPipelineAdapter.ts", "ensureSchema() [private, legacy]", (rec) =>
    callEnsure(new DoSqliteJobPipelineStores(rec as never) as unknown as AnyStore, "ensureSchema"));
  cap("SqlJobRunRecordStore", "doSqliteJobRunRecordAdapter.ts", "listRecent(10)", (rec) =>
    new SqlJobRunRecordStore(rec as never).listRecent(10));
  cap("JobStageEventStore", "doSqliteJobStageEventAdapter.ts", "listByRun()", (rec) =>
    createDoSqliteJobStageEventStore(rec as never).listByRun("probe-run"));
  cap("DoSqliteSettingsAdapter", "doSqliteOrmAdapters.ts", "ensureSchema()", (rec) =>
    new DoSqliteSettingsAdapter(rec as never).ensureSchema());
  cap("DoSqliteOutcomeTrackingStore", "doSqliteOutcomeTrackingAdapter.ts", "ensureTable()", (rec) =>
    new DoSqliteOutcomeTrackingStore(rec as never, new DoSqliteGoalScenarioStore(rec as never)).ensureTable());
  cap("SqlPausedScheduleStore", "doSqlitePausedScheduleAdapter.deprecated.ts", "list()", (rec) =>
    new SqlPausedScheduleStore(rec as never).list());
  cap("SqlPendingScheduleApprovalStore", "doSqlitePendingScheduleApprovalsAdapter.ts", "loadAll()", (rec) =>
    new SqlPendingScheduleApprovalStore(rec as never).loadAll());
  cap("DoSqlitePolicyVerdictStore", "doSqlitePolicyVerdictAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqlitePolicyVerdictStore(rec as never).ensureSchema());
  cap("ensureCaptureTable", "doSqliteProviderCaptureAdapter.ts", "ensureCaptureTable(sql)", (rec) =>
    ensureCaptureTable(rec as never));
  cap("ensureProviderConfigTable", "doSqliteProviderConfigAdapter.ts", "ensureProviderConfigTable(sql)", (rec) =>
    ensureProviderConfigTable(rec as never));
  cap("ensureProviderRoutingTable", "doSqliteProviderConfigAdapter.ts", "ensureProviderRoutingTable(sql)", (rec) =>
    ensureProviderRoutingTable(rec as never));
  cap("DoSqliteReportConfirmationStore", "doSqliteReportConfirmationAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteReportConfirmationStore(rec as never).ensureSchema());
  cap("DoSqliteResearchSettingsStore", "doSqliteResearchStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteResearchSettingsStore(rec as never).ensureSchema());
  cap("DoSqliteResearchTaskStore", "doSqliteResearchStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteResearchTaskStore(rec as never).ensureSchema());
  cap("DoSqliteResearchRunStore", "doSqliteResearchStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteResearchRunStore(rec as never).ensureSchema());
  cap("DoSqliteResearchEvaluationStore", "doSqliteResearchStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteResearchEvaluationStore(rec as never).ensureSchema());
  cap("DoSqliteReselectionStore", "doSqliteReselectionAdapter.ts", "ensureTable()", (rec) =>
    new DoSqliteReselectionStore(rec as never).ensureTable());
  cap("SqlScanRunStore", "doSqliteScanRunAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlScanRunStore(rec as never) as unknown as AnyStore, "ensure"));
  cap("DoSqliteScreenRunLock", "doSqliteScreenRunLockAdapter.ts", "ensureSchema() [legacy]", (rec) =>
    new DoSqliteScreenRunLock(rec as never).ensureSchema());
  cap("DoSqliteScreenerPresetStore", "doSqliteScreenerPresetAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteScreenerPresetStore(rec as never).ensureSchema());
  cap("DoSqliteScreeningActivityStore", "doSqliteScreeningActivityAdapter.ts", "ensureTable()", (rec) =>
    new DoSqliteScreeningActivityStore(rec as never).ensureTable());
  cap("DoSqliteStockCopilotPositionStore", "doSqliteStockCopilotStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteStockCopilotPositionStore(rec as never).ensureSchema());
  cap("DoSqliteStockCopilotActivityStore", "doSqliteStockCopilotSurfaceAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteStockCopilotActivityStore(rec as never).ensureSchema());
  cap("DoSqliteStockCopilotControlStore", "doSqliteStockCopilotSurfaceAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteStockCopilotControlStore(rec as never).ensureSchema());
  cap("DoSqliteStockCopilotMemoryStore", "doSqliteStockCopilotSurfaceAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteStockCopilotMemoryStore(rec as never).ensureSchema());
  cap("DoSqliteStrategyPolicyStore", "doSqliteStrategyPolicyAdapter.ts", "ensureTables()", (rec) =>
    new DoSqliteStrategyPolicyStore(rec as never).ensureTables());
  cap("SqlStrategyProfileStore", "doSqliteStrategyProfileAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlStrategyProfileStore(rec as never) as unknown as AnyStore, "ensure"));
  cap("DoSqliteStrategyReviewStore", "doSqliteStrategyReviewAdapter.ts", "ensureTable()", (rec) =>
    new DoSqliteStrategyReviewStore(rec as never).ensureTable());
  cap("DoSqliteStrategyWeightsStore", "doSqliteStrategyWeightsAdapter.ts", "ensureTables()", (rec) =>
    new DoSqliteStrategyWeightsStore(rec as never).ensureTables());
  cap("SqlUnifiedScheduleStore", "doSqliteUnifiedScheduleAdapter.ts", "list()", (rec) =>
    new SqlUnifiedScheduleStore(rec as never).list());
  cap("DoSqliteUsageEventStore", "doSqliteUsageEventAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteUsageEventStore(rec as never).ensureSchema());
  cap("DoSqliteUserRequestQuota", "doSqliteUserRequestQuotaAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteUserRequestQuota(rec as never).ensureSchema());
  cap("ensureWorkspaceSqlSchema", "doSqliteWorkspaceStoreAdapter.ts", "ensureWorkspaceSqlSchema(sql)", (rec) =>
    ensureWorkspaceSqlSchema(rec as never));
  cap("DoSessionStoreAdapter", "doSessionStoreAdapter.ts", "ensureSchema()", (rec) => {
    const handle = {
      exec: (query: string, ...args: unknown[]) => {
        const rows = [...rec.exec(query, ...args)] as unknown[];
        const cursor = rows as unknown as {
          toArray: () => unknown[];
          rowsRead: number;
          rowsWritten: number;
        };
        cursor.toArray = () => rows;
        cursor.rowsRead = rows.length;
        cursor.rowsWritten = 0;
        return cursor;
      },
    };
    return new DoSessionStoreAdapter(() => handle as never, 1).ensureSchema();
  });
  cap("readDoSchemaVersion", "doSchemaMarker.ts", "readDoSchemaVersion(sql)", (rec) =>
    readDoSchemaVersion(rec as never));
  cap("listAppliedDoSchemaMigrations", "doSchemaMigrations.ts", "listAppliedDoSchemaMigrations(sql, probe)", (rec) =>
    listAppliedDoSchemaMigrations(rec as never, "probe-store"));

  await Promise.all(pending);
  return captures;
}

/** The 49 delegated files (the DO adapters + the two schema-marker modules). */
const DO_DELEGATED_FILES: string[] = [
  "data/doSchemaMarker.ts",
  "data/doSchemaMigrations.ts",
  "data/doSessionStoreAdapter.ts",
  "data/doSqliteAdaptationAuditAdapter.ts",
  "data/doSqliteAnalyzedDatasetAdapter.ts",
  "data/doSqliteAsyncJobAdapter.ts",
  "data/doSqliteAutopilotStateAdapter.ts",
  "data/doSqliteCanonicalReportStoreAdapter.ts",
  "data/doSqliteChallengerAdapter.ts",
  "data/doSqliteComparisonLedgerAdapter.ts",
  "data/doSqliteDeliveryDatasetAdapter.ts",
  "data/doSqliteDiscoveryAlertAdapter.ts",
  "data/doSqliteDiscoveryRunAdapter.ts",
  "data/doSqliteDiscoverySetupAdapter.ts",
  "data/doSqliteEnrichedDatasetAdapter.ts",
  "data/doSqliteEnrichmentAdapter.ts",
  "data/doSqliteFeedSnapshotAdapter.ts",
  "data/doSqliteGeneratedDatasetAdapter.ts",
  "data/doSqliteGoalScenarioAdapter.ts",
  "data/doSqliteIndexListAdapter.ts",
  "data/doSqliteIvHistoryAdapter.ts",
  "data/doSqliteJobOutcomeAdapter.ts",
  "data/doSqliteJobPipelineAdapter.ts",
  "data/doSqliteJobRunRecordAdapter.ts",
  "data/doSqliteJobStageEventAdapter.ts",
  "data/doSqliteOrmAdapters.ts",
  "data/doSqliteOutcomeTrackingAdapter.ts",
  "data/doSqlitePausedScheduleAdapter.deprecated.ts",
  "data/doSqlitePendingScheduleApprovalsAdapter.ts",
  "data/doSqlitePolicyVerdictAdapter.ts",
  "data/doSqliteProviderCaptureAdapter.ts",
  "data/doSqliteProviderConfigAdapter.ts",
  "data/doSqliteReportConfirmationAdapter.ts",
  "data/doSqliteResearchStoreAdapter.ts",
  "data/doSqliteReselectionAdapter.ts",
  "data/doSqliteScanRunAdapter.ts",
  "data/doSqliteScreenRunLockAdapter.ts",
  "data/doSqliteScreenerPresetAdapter.ts",
  "data/doSqliteScreeningActivityAdapter.ts",
  "data/doSqliteStockCopilotStoreAdapter.ts",
  "data/doSqliteStockCopilotSurfaceAdapter.ts",
  "data/doSqliteStrategyPolicyAdapter.ts",
  "data/doSqliteStrategyProfileAdapter.ts",
  "data/doSqliteStrategyReviewAdapter.ts",
  "data/doSqliteStrategyWeightsAdapter.ts",
  "data/doSqliteUnifiedScheduleAdapter.ts",
  "data/doSqliteUsageEventAdapter.ts",
  "data/doSqliteUserRequestQuotaAdapter.ts",
  "data/doSqliteWorkspaceStoreAdapter.ts",
];

/** No inline DDL-verb lines remain in the delegated files after P3:
 * the 40 probed/guarded reconciliation statements and the two frozen
 * JobPipeline v1 copies moved to the remainder catalogue (#4282 P3),
 * and the CanonicalReport log line was reworded. The list is kept (as
 * an empty array) so a future inline statement fails this test by
 * appearing in the diff, exactly as a non-empty list would. */
const DO_REMAINING_INLINE_DDL: string[] = [];

describe("DO catalogue — adapters delegate (#4282 P2b)", () => {
  it("catalogues all 103 DO statements: 66 table + 36 index + 1 unique-index", () => {
    const catalogue = buildDoCatalogue();
    expect(DO_CATALOGUE_ENTRIES.length).toBe(103);
    expect(catalogue.size()).toBe(103);
    expect(catalogue.byKind("schema").length).toBe(103);
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
    for (const entry of DO_CATALOGUE_ENTRIES) {
      const validation = validateCatalogueEntry(entry);
      expect(validation.valid).toBe(true);
      const verb = classify(entry.statement);
      verbs.set(verb, (verbs.get(verb) ?? 0) + 1);
    }
    expect(verbs.get("CREATE TABLE")).toBe(66);
    expect(verbs.get("CREATE INDEX")).toBe(36);
    expect(verbs.get("CREATE UNIQUE INDEX")).toBe(1);
    expect(verbs.get("OTHER")).toBeUndefined();
    // Every code is unique and every entry is reachable by its code.
    const codes = new Set(DO_CATALOGUE_ENTRIES.map((e) => e.code));
    expect(codes.size).toBe(103);
    for (const entry of DO_CATALOGUE_ENTRIES) {
      expect(catalogue.get(entry.code).statement).toBe(entry.statement);
    }
    // Planes: DO tables on "do", indexes on "index".
    expect(
      DO_CATALOGUE_ENTRIES.filter((e) => e.plane === "do").length,
    ).toBe(66);
    expect(
      DO_CATALOGUE_ENTRIES.filter((e) => e.plane === "index").length,
    ).toBe(37);
    // Exactly the four mas_reports entries are parameterized.
    const parameterized = DO_CATALOGUE_ENTRIES.filter(
      (e) => e.form === "parameterized",
    );
    expect(parameterized.map((e) => e.code).sort()).toEqual([
      "schema.do.mas_reports.create_table",
      "schema.index.mas_reports.create_index_idx_mas_reports_created",
      "schema.index.mas_reports.create_index_idx_mas_reports_user",
      "schema.index.mas_reports.create_unique_index_idx_mas_reports_generation",
    ]);
    for (const entry of parameterized) {
      expect(entry.parameters).toEqual(["TABLE"]);
      expect(entry.table).toBe("mas_reports");
    }
    // No DO entry duplicates an ORM-catalogue statement.
    const ormStatements = new Set(ORM_CATALOGUE_ENTRIES.map((e) => e.statement));
    for (const entry of DO_CATALOGUE_ENTRIES) {
      expect(ormStatements.has(entry.statement)).toBe(false);
    }
  });

  it("each entry's statement is byte-identical to the base (sha256 pin)", () => {
    expect(Object.keys(DO_STATEMENT_SHA256).length).toBe(103);
    for (const entry of DO_CATALOGUE_ENTRIES) {
      const digest = createHash("sha256")
        .update(entry.statement, "utf8")
        .digest("hex");
      expect(digest, entry.code).toBe(DO_STATEMENT_SHA256[entry.code]);
    }
  });

  it("equality pin: the catalogue builds the base DO schema exactly", () => {
    const expected = expectedDoModel();
    expect(Object.keys(expected.tables).length).toBe(66);
    expect(Object.keys(expected.indexes).length).toBe(39);
    // runEqualityCheck passes no parameters, and the catalogue holds
    // parameterized entries — resolve them manually, exactly as the
    // adapters do at the call site.
    const instance = new InMemorySchemaInstance();
    for (const entry of DO_CATALOGUE_ENTRIES) {
      instance.exec(resolveStatementText(entry, { TABLE: entry.table }));
    }
    instance.exec(ormIndexSql("unified_schedules_created_idx"));
    instance.exec(ormIndexSql("job_run_records_recent_idx"));
    const actual = instance.introspect();
    const diff = diffSchema(actual, expected);
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

  it("the delegated adapters execute exactly the base statement lists", async () => {
    const base = baseCaptures();
    expect(base.length).toBe(56);
    const actual = await driveAll();
    expect(actual.length).toBe(56);
    for (let i = 0; i < base.length; i++) {
      expect(actual[i].adapter, `capture ${i} adapter`).toBe(base[i].adapter);
      expect(actual[i].file, `capture ${i} file`).toBe(base[i].file);
      expect(actual[i].trigger, `capture ${i} trigger`).toBe(base[i].trigger);
      expect(actual[i].queries, `capture ${i} (${base[i].adapter})`).toEqual(
        base[i].queries,
      );
    }
  });

  it("the exported DDL consts are the catalogue statements, and the managed migrations ride them", () => {
    expect(ANALYZED_DATASETS_DDL).toBe(doTableSql("job_analyzed_datasets"));
    expect(ANALYZED_DATASETS_INDEX_DDL).toBe(
      doIndexSql("idx_job_analyzed_datasets_job"),
    );
    expect(DELIVERY_DATASETS_DDL).toBe(doTableSql("job_delivery_datasets"));
    expect(DELIVERY_DATASETS_INDEX_DDL).toBe(
      doIndexSql("idx_job_delivery_datasets_job"),
    );
    expect(ENRICHED_DATASETS_DDL).toBe(doTableSql("job_enriched_datasets"));
    expect(ENRICHED_DATASETS_INDEX_DDL).toBe(
      doIndexSql("idx_job_enriched_datasets_job"),
    );
    expect(GENERATED_DATASETS_DDL).toBe(doTableSql("job_generated_datasets"));
    expect(GENERATED_DATASETS_INDEX_DDL).toBe(
      doIndexSql("idx_job_generated_datasets_job"),
    );
    expect(JOB_PIPELINE_DEFINITIONS_DDL).toBe(
      doTableSql("job_pipeline_definitions"),
    );
    expect(JOB_PIPELINE_INSTANCES_DDL).toBe(
      doTableSql("job_pipeline_instances"),
    );
    expect(JOB_PIPELINE_ARTIFACTS_DDL).toBe(
      doTableSql("job_pipeline_artifacts"),
    );
    expect(JOB_PIPELINE_ARTIFACTS_INDEX_DDL).toBe(
      doIndexSql("idx_job_pipeline_artifacts_run"),
    );
    expect(MAS_SETTINGS_DDL).toBe(doTableSql("mas_settings"));
    // SCREEN_RUN_LOCK_TABLE_DDL is module-private; its value is pinned
    // through the migration's `up` below (up[0] IS the const).
    // The managed migrations reference the live consts, so a managed
    // ensure executes catalogue text too.
    expect(ANALYZED_DATASET_SCHEMA_MIGRATION.up).toEqual([
      ANALYZED_DATASETS_DDL,
      ANALYZED_DATASETS_INDEX_DDL,
    ]);
    expect(DELIVERY_DATASET_SCHEMA_MIGRATION.up).toEqual([
      DELIVERY_DATASETS_DDL,
      DELIVERY_DATASETS_INDEX_DDL,
    ]);
    expect(ENRICHED_DATASET_SCHEMA_MIGRATION.up).toEqual([
      ENRICHED_DATASETS_DDL,
      ENRICHED_DATASETS_INDEX_DDL,
    ]);
    expect(GENERATED_DATASET_SCHEMA_MIGRATION.up).toEqual([
      GENERATED_DATASETS_DDL,
      GENERATED_DATASETS_INDEX_DDL,
    ]);
    expect(SCREEN_RUN_LOCK_SCHEMA_MIGRATION.up).toEqual([
      doTableSql("screen_run_locks"),
    ]);
    // JobPipeline v1: the first two `up` entries are FROZEN history
    // (never the live consts); the last two ride the live consts.
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up).toHaveLength(4);
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up[2]).toBe(
      JOB_PIPELINE_ARTIFACTS_DDL,
    );
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up[3]).toBe(
      JOB_PIPELINE_ARTIFACTS_INDEX_DDL,
    );
    expect(
      createHash("sha256")
        .update(JOB_PIPELINE_SCHEMA_MIGRATION.up[0], "utf8")
        .digest("hex"),
    ).toBe(FROZEN_JOB_PIPELINE_DEFINITIONS_SHA256);
    expect(
      createHash("sha256")
        .update(JOB_PIPELINE_SCHEMA_MIGRATION.up[1], "utf8")
        .digest("hex"),
    ).toBe(FROZEN_JOB_PIPELINE_INSTANCES_SHA256);
    // The frozen instances copy differs from the live const (it predates
    // the run_schedule_id / run_async_job_id columns) — that is the
    // point of freezing it.
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up[1]).not.toBe(
      JOB_PIPELINE_INSTANCES_DDL,
    );
    // The parameterized mas_reports entries resolve to the base text:
    // the resolved table statement is exactly what the base adapter
    // executed (first query of the base CanonicalReport capture).
    const canonicalBase = baseCaptures().find(
      (c) => c.adapter === "DoSqliteCanonicalReportStore",
    );
    expect(canonicalBase).toBeDefined();
    const baseTableSql = canonicalBase!.queries.find((q) =>
      q.trim().startsWith("CREATE TABLE"),
    );
    expect(baseTableSql).toBeDefined();
    expect(
      doStatementSql("schema.do.mas_reports.create_table", {
        TABLE: "mas_reports",
      }),
    ).toBe(baseTableSql);
  });

  it("no inline DDL remains in the delegated files (P3 emptied the pinned set)", () => {
    const srcRoot = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
    );
    const inline: string[] = [];
    // Stronger than the ORM suite's pattern: any DDL verb, so a
    // template-assembled statement cannot hide behind ${TABLE}.
    const ddlPattern =
      /\bCREATE TABLE\b|\bCREATE (?:UNIQUE )?INDEX\b|\bALTER TABLE\b/;
    for (const file of DO_DELEGATED_FILES) {
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
    expect(inline).toEqual(DO_REMAINING_INLINE_DDL);
  });

  it("the DO catalogue is registered in the schemaComponent barrel", async () => {
    const barrel = await import("../src/data/schemaComponent");
    expect(barrel.DO_CATALOGUE).toBe(DO_CATALOGUE);
    expect(barrel.buildDoCatalogue).toBe(buildDoCatalogue);
    expect(barrel.doTableSql).toBe(doTableSql);
    expect(barrel.doIndexSql).toBe(doIndexSql);
    expect(barrel.doStatementSql).toBe(doStatementSql);
  });
});
