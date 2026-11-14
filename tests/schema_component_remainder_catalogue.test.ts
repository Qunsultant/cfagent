/**
 * #4282 P3 — remainder catalogue: the long tail of DDL the P2a/P2b
 * delegations left behind, plus the ALTER reconciliation set and the
 * parameterized entry forms.
 *
 * What this suite pins (measured from the base tree dd6df86a, never
 * from the delegated code):
 *  - the catalogue holds all 51 remainder statements (8 table, 2
 *    index, 39 reconciliation, 1 drop, 1 seed-form), each valid, each
 *    byte-identical to the base (sha256 pin), each reachable by code.
 *  - the catalogue builds the base remainder schema exactly: the
 *    expected-model fixture
 *    (tests/schema_component_remainder_expected_model.json) is the
 *    schema the base executions build for the 19 remainder tables.
 *  - the delegated adapters, services, stores, and ORM path execute
 *    exactly the base statement lists (tests/
 *    schema_component_p3_base_sql.json), with ONE disclosed exception:
 *    the three resource-rollup CREATEs are NORMALIZED to the D1
 *    catalogue's text (whitespace only — the adapter indented 4
 *    spaces, the migration 2; the equality harness proves the two
 *    texts build the identical model, and the base capture preserves
 *    the originals as the "before" evidence).
 *  - no inline DDL remains in the P3 delegated files.
 *  - the frozen JobPipeline v1 copies are history, never the live
 *    consts (their sha256 pins match the DO suite's FROZEN_*).
 *  - the seed entry defines the orchestratorMigration form only; no
 *    DML site moves in P3 (P6d owns the move).
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockSqlStorage } from "./mock-sql";
import {
  REMAINDER_CATALOGUE,
  REMAINDER_CATALOGUE_ENTRIES,
  buildRemainderCatalogue,
  remainderAlterSql,
  remainderD1TableSql,
  remainderFrozenTableSql,
  remainderIndexSql,
  remainderStatementSql,
  remainderTableSql,
} from "../src/data/schemaComponent/remainderCatalogue";
import {
  DO_CATALOGUE_ENTRIES,
  doStatementSql,
  doTableSql,
} from "../src/data/schemaComponent/doCatalogue";
import {
  D1_CATALOGUE_ENTRIES,
  d1TableSql,
} from "../src/data/schemaComponent/d1Catalogue";
import {
  ORM_CATALOGUE_ENTRIES,
  ormTableSql,
} from "../src/data/schemaComponent/ormCatalogue";
import { validateCatalogueEntry } from "../src/data/schemaComponent/catalogue";
import { resolveStatementText } from "../src/data/schemaComponent/executor";
import {
  InMemorySchemaInstance,
  diffSchema,
  type SchemaModel,
} from "../src/data/schemaComponent/equalityHarness";
import { DoSqliteAsyncJobStore } from "../src/data/doSqliteAsyncJobAdapter";
import { DoSqliteCanonicalReportStore } from "../src/data/doSqliteCanonicalReportStoreAdapter";
import { SqlIvHistoryStore } from "../src/data/doSqliteIvHistoryAdapter";
import {
  DoSqliteJobPipelineStores,
  JOB_PIPELINE_ARTIFACTS_DDL,
  JOB_PIPELINE_ARTIFACTS_INDEX_DDL,
  JOB_PIPELINE_INSTANCES_DDL,
  JOB_PIPELINE_SCHEMA_MIGRATION,
} from "../src/data/doSqliteJobPipelineAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { ensureCaptureTable } from "../src/data/doSqliteProviderCaptureAdapter";
import {
  ensureProviderConfigTable,
  ensureProviderRoutingTable,
} from "../src/data/doSqliteProviderConfigAdapter";
import { DoSqliteReportConfirmationStore } from "../src/data/doSqliteReportConfirmationAdapter";
import { SqlScanRunStore } from "../src/data/doSqliteScanRunAdapter";
import { DoSqliteStockCopilotPositionStore } from "../src/data/doSqliteStockCopilotStoreAdapter";
import { DoSqliteStockCopilotActivityStore } from "../src/data/doSqliteStockCopilotSurfaceAdapter";
import { ensureLearningsTable } from "../src/services/learnings";
import { createSqlCancelPreviewStore } from "../src/services/cancelPreviewStore";
import { createSqlLadderStateStore } from "../src/services/ladderStateStore";
import { ensureDeliveryClaimsTable } from "../src/data/deliveryClaimsStore";
import { ensureStageClaimsTable } from "../src/data/stageClaimsStore";
import { D1FeedDatasetStore } from "../src/data/d1FeedDatasetAdapter";
import { D1IndexListStore } from "../src/data/d1IndexListAdapter";
import { D1QuoteSourceAdapter } from "../src/data/d1QuoteSourceAdapter";
import { D1ResourceRollupStore } from "../src/data/d1ResourceRollupAdapter";
import { D1ResourceUsageAdapter } from "../src/data/d1ResourceUsageAdapter";
import { DatabaseORM } from "../src/orm";

/** sha256 of every remainder entry's statement, byte-for-byte. */
const REMAINDER_STATEMENT_SHA256 = {
  "schema.do.job_pipeline_definitions.create_table_v1": "63e75c48b6a9568f8b746518374b1ea721667aa8c19f6911589ace3db38d59c6",
  "schema.do.job_pipeline_instances.create_table_v1": "0fa9e16462343d5cd5be880d0767fdfa1ef4175bdde89dfcceb9d9ce8983cf19",
  "schema.do.job_pipeline_instances.alter_table_add_column_run_async_job_id": "2f53b06113b1799ba1d1c6c6521c03ceefeda12c589f5912b2c54f012137f940",
  "schema.do.job_pipeline_instances.alter_table_add_column_run_schedule_id": "169fd10000cea187259ba2897726d232e9d8712ac213adb663256eb1ded38f9f",
  "schema.do.job_run_records.alter_table_add_column_async_job_id": "971fcbef16599175e193a2e080bc0bc0dfcf504b610ed01b59214ea692bc4204",
  "schema.do.job_run_records.alter_table_add_column_broker_id": "00782ec57efc29f19e0121600ab1328eda5f4b18d73361cbbe448231ddb5fada",
  "schema.do.job_run_records.alter_table_add_column_data_provider_id": "c01a18e42c963b3ae7a7b0dd203ee1f1395f4cee2e3f93249925b3c789f7139d",
  "schema.do.job_run_records.alter_table_add_column_mode": "a8d3fd8af1665bb22bf91003c4b76d0985c22345902b9ee3c72526cf40b052fb",
  "schema.do.job_run_records.alter_table_add_column_mode_source": "71969e34b3cb1c832deb37f4d6443db130af9eaaa32ae4ab31692885a3f5e460",
  "schema.do.job_run_records.alter_table_add_column_schedule_id": "2dcd58a376779545fcd1157f16c7508df1f938fc33de5463dc2c489f082dffaa",
  "schema.do.job_run_records.alter_table_add_column_trigger_text": "d4929f6197dda08fedb5a8bf84da0e7c5547e70e7b0db21a023db793536bbfdd",
  "schema.do.job_run_records.alter_table_add_column_workflow_id": "b80ea3a44cdb0d30b1f7da42b65543bbe6b28c27398a24b1a477c147605fc3ae",
  "schema.do.mas_async_jobs.alter_table_add_column_chain_id": "6ce7bfa86fd12746c47e09735e8ca618df98cef7542c8c9612c6bc490b1afdc1",
  "schema.do.mas_async_jobs.alter_table_add_column_channel": "bf2fe63006e8b081f55e30581ade5dae1e9909a83d008965ffc8f513d3397342",
  "schema.do.mas_async_jobs.alter_table_add_column_error_code": "b48a4d1ba3bd1a349f5ae07b9ef4a140452c6296b5ec5729d047fea2245d0f99",
  "schema.do.mas_async_jobs.alter_table_add_column_job_kind": "852fb985246f2a8d23d3b21e769ad690705386b7a34ac746e77dd713084da2ab",
  "schema.do.mas_async_jobs.alter_table_add_column_last_activity_at": "be4488d836c36cf653bbc5d8e5d6af3281562f0600ac2de0cd32158276407c7f",
  "schema.do.mas_async_jobs.alter_table_add_column_not_before": "51ecb07e37e2cf0854b14b8606e4f5880a912f4dde2487d9ec7dbe467d3a8571",
  "schema.do.mas_async_jobs.alter_table_add_column_parent_job_id": "cc5a319e5ad0be25702e3e49209e81d52f9260f31ee31f22e69a1f58683844a5",
  "schema.do.mas_async_jobs.alter_table_add_column_schedule_id": "f18f1fa3d0aa037e0ce71675739e3472913cc8a03112b3e3d9f574dcd276e63c",
  "schema.do.mas_async_jobs.alter_table_add_column_stage": "5d627d7afe796e4cc3519fa35fe0fc93559b9d6fc17736d006a18ae728b79ce4",
  "schema.do.mas_async_jobs.alter_table_add_column_stuck_alerted_at": "dbf20bd9ee452eaf893332fb97ab22f2122275a6aec2ef2bc00266c8825b3e5a",
  "schema.do.mas_async_jobs.alter_table_add_column_trigger": "7b2ca3e6a3afc7a0b995ce8b157fee84465a2097481c833f0cdc73299bc6c4f3",
  "schema.do.mas_async_jobs.alter_table_add_column_triggered_by": "1b8b03d19108080a0598a3d6670c4875f1e46a4975d360661f372953f411a462",
  "schema.do.mas_cancel_previews.create_table": "a4ac73975d46b23cd003ee3d002d9fad1153e7e9f10b9158270dca70f2379b9d",
  "schema.do.mas_data_captures.alter_table_add_column_failure_kind": "72b3e16c757797af3a5d7836955f78adc895c43b8fd08a5f8615cbe21857c0fd",
  "schema.do.mas_data_captures.alter_table_add_column_failure_message": "3f913e44a69bbcd55805b282f3974949433babd3a60e93e212505d8772a1eec4",
  "schema.do.mas_data_provider_routes.alter_table_add_column_min_tier": "a4284fb8e18c2971f5325813d975947cb95611f2b88e304c08e1ea04f7c8ec1a",
  "schema.do.mas_delivery_claims.create_table": "2f39244fc35555527dc62d88d72ed9df7f022ecfc721d4fb99c5545fe4647916",
  "schema.d1.mas_feed_datasets.create_table": "4a4eb562e0cee0a5db6ecc190e69b947993c8a22fbe7c3637705f24fcebffb61",
  "schema.do.mas_iv_history.alter_table_add_column_broker": "c428061b166e59e985551d641e9b64a9ef02683b1515837810cebf08ab78aa24",
  "schema.do.mas_ladder_states.create_table": "75af3b6c65413793b515748a443982705a2f994c80b0531b46e7ba4144e0e485",
  "schema.do.mas_learnings.create_table": "cc7d303f5749c7eb88c1ad3de6d10567d5a09a4bef7810a3d0012e6dde00b243",
  "schema.index.mas_learnings.create_index_idx_learnings_active": "a69dc8fda741fbba93fddbebc62e89a7dc11d853e7a3c0284ee191b32181e628",
  "schema.index.mas_learnings.create_index_idx_learnings_domain": "95e3dac36c2edbe2d904d3766af29b8cc557b5509b9912c5b44397bec9f8b2d6",
  "schema.do.mas_opportunity_scans.alter_table_add_column_async_job_id": "a3298b1c7d2242cf74e1b80d814dd240ba4eddb673ea2c93ea7fa87a79f13b66",
  "schema.do.mas_opportunity_scans.alter_table_add_column_schedule_id": "3f2b9a5cb514b82016154c54bd6a76b2f6202cbcba25c568c3bfb973499dcc2b",
  "schema.do.mas_opportunity_scans.alter_table_add_column_user_login": "84d45cd85a2c49a84b4af6e17d418a7643b36b4c3693c0981e5512f1a4a43ec0",
  "schema.do.mas_opportunity_scans.alter_table_add_column_workflow_id": "2ba98732883ac752ac1bafe8583a3e8c1e030849a285cff245f4c9e92ca7ac7a",
  "schema.do.mas_report_confirmations.alter_table_add_column": "9c0dabbe6fbbe9f8c55938c1b8e93cef4240520814b30d3cf986707b68ab1dfd",
  "schema.do.mas_reports.alter_table_add_column": "d86b2aec458a2a1854d471c10bc6a8ffe8f37b05adb5d06ad374facdae2f09ea",
  "schema.index.mas_reports.drop_index_idx_mas_reports_generation": "59f431304462a0f467c7c5e60996e752ae289c8943024afe70ddbdd2541e795d",
  "schema.do.mas_stage_claims.create_table": "260b5e4d5df573a31723f53ede6f6dd025d06df56981e236ca294c05aedeb628",
  "schema.orm.mas_trades.alter_table_add_column_broker": "7834d9e5f79d40b95e2ee560baa78516e2408e4661665a95cad45ab0faf6c112",
  "schema.orm.mas_trades.alter_table_add_column_price_source": "29e11de70b4fe0a986f306027d5c806afe1dd7313633500a73890e225ad27bfa",
  "schema.do.stock_copilot_activity.alter_table_add_column_critic_verdict_json": "64dd279747ad9a77a808e5e63c8baf21307acfbcde00195e6ec01064095f1134",
  "schema.do.stock_copilot_activity.alter_table_add_column_mode": "5eb025894bfc9a3e47c888234122af4170214d0ed31da66e373f3d126a7a670b",
  "schema.do.stock_copilot_activity.alter_table_add_column_session": "a5f1dc8ac6e137f026e2611705c21a32be485279d86c5f774575e319a6aee161",
  "schema.do.stock_copilot_positions.alter_table_add_column_entry_order_type": "7e5bb8dc793c944dde7f415fb6ceb9fabbc919d66a8cec4539232616b893a62c",
  "schema.do.stock_copilot_positions.alter_table_add_column_entry_session": "88c3d71a0541b5199e9a3d7f67fe02bfae3f4e7c4935b5b908f3c618daf8b03e",
  "seed.route.orchestrator_migration.insert_or_replace": "cf67ae430b5c1e25c7f7fbd393500411570765fef5261cbbec7badf1a243fc68",
}

const BASE_SQL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema_component_p3_base_sql.json",
);
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema_component_remainder_expected_model.json",
);

function expectedRemainderModel(): SchemaModel {
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

class RecordingSqlStorage extends MockSqlStorage {
  readonly queries: string[] = [];
  override exec(query: string, ...args: unknown[]): Iterable<unknown> {
    this.queries.push(query);
    return super.exec(query, ...args);
  }
}

/**
 * The base CanonicalReport capture never executes the DROP: the mock
 * answers PRAGMA index_info with no rows. This recorder answers the
 * probe with a wrong-shaped index (one column instead of
 * (user_login, generation_id)), the only path that executes the DROP.
 */
class WrongIndexShapeSqlStorage extends MockSqlStorage {
  readonly queries: string[] = [];
  override exec(query: string, ...args: unknown[]): Iterable<unknown> {
    this.queries.push(query);
    if (/PRAGMA\s+index_info/i.test(query)) {
      return [{ seqno: 0, name: "generation_id" }];
    }
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

/** Minimal D1 binding: records prepare() SQL, answers run/bind/first/all. */
class FakeD1 {
  readonly prepared: string[] = [];
  prepare(sql: string): unknown {
    this.prepared.push(sql);
    return {
      bind: (..._args: unknown[]) => ({
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
      run: async () => ({}),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
  }
}

/**
 * Drive every P3 trigger on a fresh recorder, SEQUENTIALLY so the
 * capture order matches the fixture. This is the same driver the
 * generator used on the base tree — the executed-list pin below
 * asserts the delegated adapters reproduce those lists exactly,
 * except the disclosed D1ResourceRollupEnsure normalization.
 */
async function driveAll(): Promise<BaseCapture[]> {
  const captures: BaseCapture[] = [];
  const cap = (
    adapter: string,
    file: string,
    trigger: string,
    run: (rec: RecordingSqlStorage) => unknown,
  ) => {
    const rec = new RecordingSqlStorage();
    const out = run(rec);
    if (out instanceof Promise) return out.then(() => {
      captures.push({ adapter, file, trigger, queries: rec.queries });
    });
    captures.push({ adapter, file, trigger, queries: rec.queries });
    return Promise.resolve();
  };

  await cap("LearningsEnsure", "services/learnings.ts", "ensureLearningsTable(sql)", (rec) =>
    ensureLearningsTable(rec as never),
  );
  await cap("CancelPreviewSave", "services/cancelPreviewStore.ts", "createSqlCancelPreviewStore(sql).save(...)", (rec) =>
    createSqlCancelPreviewStore(rec as never).save({
      token: "p3-generator-token",
      ids: ["order-1"],
      createdAt: "2026-11-14T00:00:00Z",
      expiresAt: "2026-11-14T01:00:00Z",
    }),
  );
  await cap("LadderStateSave", "services/ladderStateStore.ts", "createSqlLadderStateStore(sql).save(...)", (rec) =>
    createSqlLadderStateStore(rec as never).save({
      ladderId: "p3-generator-ladder",
      symbol: "AAPL",
      entryMode: "base-breakout",
      specJson: "{}",
      planJson: "{}",
      placed: [],
      committedNotional: 0,
      stoppedBy: null,
      createdAt: "2026-11-14T00:00:00Z",
      updatedAt: "2026-11-14T00:00:00Z",
    } as never),
  );
  await cap("DeliveryClaimsEnsure", "data/deliveryClaimsStore.ts", "ensureDeliveryClaimsTable(sql)", (rec) =>
    ensureDeliveryClaimsTable(rec as never),
  );
  await cap("StageClaimsEnsure", "data/stageClaimsStore.ts", "ensureStageClaimsTable(sql)", (rec) =>
    ensureStageClaimsTable(rec as never),
  );
  {
    const fake = new FakeD1();
    const store = new D1FeedDatasetStore(fake as never);
    await (store as unknown as { ensureTable: () => Promise<void> }).ensureTable();
    captures.push({
      adapter: "D1FeedDatasetEnsure",
      file: "data/d1FeedDatasetAdapter.ts",
      trigger: "ensureTable() [private]",
      queries: fake.prepared,
    });
  }
  {
    const fake = new FakeD1();
    const store = new D1IndexListStore(fake as never);
    await store.store({
      index: "nasdaq100",
      snapshotDate: "2026-11-14",
      symbols: [],
      source: "p3-generator",
      sourceLabel: "p3-generator",
      derivedFromHoldings: false,
    } as never);
    captures.push({
      adapter: "D1IndexListStore",
      file: "data/d1IndexListAdapter.ts",
      trigger: "store(...)",
      queries: fake.prepared,
    });
  }
  {
    const fake = new FakeD1();
    const adapter = new D1QuoteSourceAdapter(fake as never);
    await adapter.ensureSchema();
    captures.push({
      adapter: "D1QuoteSourceEnsure",
      file: "data/d1QuoteSourceAdapter.ts",
      trigger: "ensureSchema()",
      queries: fake.prepared,
    });
  }
  {
    const fake = new FakeD1();
    const store = new D1ResourceRollupStore(fake as never);
    await store.ensureSchema();
    captures.push({
      adapter: "D1ResourceRollupEnsure",
      file: "data/d1ResourceRollupAdapter.ts",
      trigger: "ensureSchema()",
      queries: fake.prepared,
    });
  }
  {
    const fake = new FakeD1();
    const adapter = new D1ResourceUsageAdapter(fake as never);
    await adapter.record({} as never);
    captures.push({
      adapter: "D1ResourceUsageRecord",
      file: "data/d1ResourceUsageAdapter.ts",
      trigger: "record(...)",
      queries: fake.prepared,
    });
  }
  await cap("OrmInitializeSchema", "src/orm.ts", 'initializeSchema("p3-generator")', (rec) => {
    const orm = new DatabaseORM(rec as never);
    orm.initializeSchema("p3-generator");
  });
  await cap("CanonicalReportEnsure", "data/doSqliteCanonicalReportStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteCanonicalReportStore(rec as never).ensureSchema(),
  );
  {
    const rec = new WrongIndexShapeSqlStorage();
    await new DoSqliteCanonicalReportStore(rec as never).ensureSchema();
    captures.push({
      adapter: "CanonicalReportEnsureDrop",
      file: "data/doSqliteCanonicalReportStoreAdapter.ts",
      trigger: "ensureSchema() [wrong-shape index_info]",
      queries: rec.queries,
    });
  }
  await cap("AsyncJobEnsure", "data/doSqliteAsyncJobAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteAsyncJobStore(rec as never).ensureSchema(),
  );
  await cap("IvHistoryEnsure", "data/doSqliteIvHistoryAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlIvHistoryStore(rec as never) as unknown as AnyStore, "ensure"),
  );
  await cap("JobPipelineEnsure", "data/doSqliteJobPipelineAdapter.ts", "ensureSchema() [private, legacy]", (rec) =>
    callEnsure(new DoSqliteJobPipelineStores(rec as never) as unknown as AnyStore, "ensureSchema"),
  );
  captures.push({
    adapter: "JobPipelineMigrationV1",
    file: "data/doSqliteJobPipelineAdapter.ts",
    trigger: "JOB_PIPELINE_SCHEMA_MIGRATION.up (declaration)",
    queries: [...JOB_PIPELINE_SCHEMA_MIGRATION.up],
  });
  await cap("JobRunRecordList", "data/doSqliteJobRunRecordAdapter.ts", "listRecent(10)", (rec) =>
    new SqlJobRunRecordStore(rec as never).listRecent(10),
  );
  await cap("ProviderCaptureEnsure", "data/doSqliteProviderCaptureAdapter.ts", "ensureCaptureTable(sql)", (rec) =>
    ensureCaptureTable(rec as never),
  );
  await cap("ProviderConfigEnsure", "data/doSqliteProviderConfigAdapter.ts", "ensureProviderConfigTable(sql)", (rec) =>
    ensureProviderConfigTable(rec as never),
  );
  await cap("ProviderRoutingEnsure", "data/doSqliteProviderConfigAdapter.ts", "ensureProviderRoutingTable(sql)", (rec) =>
    ensureProviderRoutingTable(rec as never),
  );
  await cap("ReportConfirmationEnsure", "data/doSqliteReportConfirmationAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteReportConfirmationStore(rec as never).ensureSchema(),
  );
  await cap("ScanRunEnsure", "data/doSqliteScanRunAdapter.ts", "ensure() [private]", (rec) =>
    callEnsure(new SqlScanRunStore(rec as never) as unknown as AnyStore, "ensure"),
  );
  await cap("StockCopilotPositionEnsure", "data/doSqliteStockCopilotStoreAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteStockCopilotPositionStore(rec as never).ensureSchema(),
  );
  await cap("StockCopilotActivityEnsure", "data/doSqliteStockCopilotSurfaceAdapter.ts", "ensureSchema()", (rec) =>
    new DoSqliteStockCopilotActivityStore(rec as never).ensureSchema(),
  );
  return captures;
}

/** Every file whose DDL moves in P3 (the wiring test scans these). */
const P3_DELEGATED_FILES = [
  "services/learnings.ts",
  "services/cancelPreviewStore.ts",
  "services/ladderStateStore.ts",
  "data/deliveryClaimsStore.ts",
  "data/stageClaimsStore.ts",
  "data/d1FeedDatasetAdapter.ts",
  "data/d1IndexListAdapter.ts",
  "data/d1QuoteSourceAdapter.ts",
  "data/d1ResourceRollupAdapter.ts",
  "data/d1ResourceUsageAdapter.ts",
  "data/doSqliteAsyncJobAdapter.ts",
  "data/doSqliteCanonicalReportStoreAdapter.ts",
  "data/doSqliteIvHistoryAdapter.ts",
  "data/doSqliteJobPipelineAdapter.ts",
  "data/doSqliteJobRunRecordAdapter.ts",
  "data/doSqliteProviderCaptureAdapter.ts",
  "data/doSqliteProviderConfigAdapter.ts",
  "data/doSqliteReportConfirmationAdapter.ts",
  "data/doSqliteScanRunAdapter.ts",
  "data/doSqliteStockCopilotStoreAdapter.ts",
  "data/doSqliteStockCopilotSurfaceAdapter.ts",
  "data/ormFacade.ts",
];

describe("remainder catalogue — P3 long tail + ALTER reconciliation (#4282 P3)", () => {
  it("catalogues all 51 remainder statements: 8 table + 2 index + 39 alter + 1 drop + 1 seed-form", () => {
    const catalogue = buildRemainderCatalogue();
    expect(REMAINDER_CATALOGUE_ENTRIES.length).toBe(51);
    expect(catalogue.size()).toBe(51);
    expect(catalogue.byKind("schema").length).toBe(50);
    expect(catalogue.byKind("seed").length).toBe(1);
    const verbs = new Map<string, number>();
    const classify = (statement: string): string => {
      const upper = statement.trim().toUpperCase();
      for (const verb of [
        "CREATE UNIQUE INDEX",
        "CREATE TABLE",
        "CREATE INDEX",
        "ALTER TABLE",
        "DROP INDEX",
        "INSERT OR REPLACE",
      ]) {
        if (upper.startsWith(verb)) return verb;
      }
      return "OTHER";
    };
    for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
      const validation = validateCatalogueEntry(entry);
      expect(validation.valid, entry.code).toBe(true);
      const verb = classify(entry.statement);
      verbs.set(verb, (verbs.get(verb) ?? 0) + 1);
    }
    expect(verbs.get("CREATE TABLE")).toBe(8);
    expect(verbs.get("CREATE INDEX")).toBe(2);
    expect(verbs.get("ALTER TABLE")).toBe(39);
    expect(verbs.get("DROP INDEX")).toBe(1);
    expect(verbs.get("INSERT OR REPLACE")).toBe(1);
    expect(verbs.get("OTHER")).toBeUndefined();
    // Every code is unique and every entry is reachable by its code.
    const codes = new Set(REMAINDER_CATALOGUE_ENTRIES.map((e) => e.code));
    expect(codes.size).toBe(51);
    for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
      expect(catalogue.get(entry.code).statement).toBe(entry.statement);
    }
    // Planes: do 44, d1 1, orm 2, index 3, route 1.
    expect(REMAINDER_CATALOGUE_ENTRIES.filter((e) => e.plane === "do").length).toBe(44);
    expect(REMAINDER_CATALOGUE_ENTRIES.filter((e) => e.plane === "d1").length).toBe(1);
    expect(REMAINDER_CATALOGUE_ENTRIES.filter((e) => e.plane === "orm").length).toBe(2);
    expect(REMAINDER_CATALOGUE_ENTRIES.filter((e) => e.plane === "index").length).toBe(3);
    expect(REMAINDER_CATALOGUE_ENTRIES.filter((e) => e.plane === "route").length).toBe(1);
    // Exactly the four parameterized entries, with their parameters.
    const parameterized = REMAINDER_CATALOGUE_ENTRIES.filter((e) => e.form === "parameterized");
    expect(parameterized.map((e) => e.code).sort()).toEqual([
      "schema.do.mas_report_confirmations.alter_table_add_column",
      "schema.do.mas_reports.alter_table_add_column",
      "schema.index.mas_reports.drop_index_idx_mas_reports_generation",
      "seed.route.orchestrator_migration.insert_or_replace",
    ]);
    expect(
      parameterized.find((e) => e.code === "schema.do.mas_reports.alter_table_add_column")!.parameters,
    ).toEqual(["TABLE", "column", "type"]);
    expect(
      parameterized.find((e) => e.code === "schema.do.mas_report_confirmations.alter_table_add_column")!.parameters,
    ).toEqual(["column", "type"]);
    expect(
      parameterized.find((e) => e.code === "schema.index.mas_reports.drop_index_idx_mas_reports_generation")!.parameters,
    ).toEqual(["TABLE"]);
    expect(
      parameterized.find((e) => e.code === "seed.route.orchestrator_migration.insert_or_replace")!.parameters,
    ).toEqual(["table", "cols", "placeholders"]);
    // No remainder CODE collides with another catalogue's code:
    // each statement has exactly one home per plane. The same
    // statement TEXT may appear in two planes (the catalogue is
    // organized by plane, and a statement that executes on two planes
    // has an entry per plane) — the four such overlaps are all in the
    // job_pipeline set, named explicitly below.
    const otherCodes = new Set([
      ...D1_CATALOGUE_ENTRIES.map((e) => e.code),
      ...ORM_CATALOGUE_ENTRIES.map((e) => e.code),
      ...DO_CATALOGUE_ENTRIES.map((e) => e.code),
    ]);
    for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
      expect(otherCodes.has(entry.code), entry.code).toBe(false);
    }
    // The four cross-plane text overlaps (same statement, two planes):
    // the D1 migration created the job_pipeline tables in the 0046
    // shape and reconciles the same two columns, so the frozen copies
    // and the two instances ALTERs ARE the D1 entries' texts. The
    // definitions copy additionally equals the DO live const — the
    // freeze matters for instances, not definitions.
    const d1ByStatement = new Map(
      D1_CATALOGUE_ENTRIES.map((e) => [e.statement, e.code]),
    );
    const doByStatement = new Map(
      DO_CATALOGUE_ENTRIES.map((e) => [e.statement, e.code]),
    );
    const findRemainder = (code: string) =>
      REMAINDER_CATALOGUE_ENTRIES.find((e) => e.code === code)!;
    expect(
      d1ByStatement.get(findRemainder("schema.do.job_pipeline_definitions.create_table_v1").statement),
    ).toBe("schema.d1.job_pipeline_definitions.create_table");
    expect(
      doByStatement.get(findRemainder("schema.do.job_pipeline_definitions.create_table_v1").statement),
    ).toBe("schema.do.job_pipeline_definitions.create_table");
    expect(
      d1ByStatement.get(findRemainder("schema.do.job_pipeline_instances.create_table_v1").statement),
    ).toBe("schema.d1.job_pipeline_instances.create_table");
    expect(
      d1ByStatement.get(
        findRemainder("schema.do.job_pipeline_instances.alter_table_add_column_run_schedule_id").statement,
      ),
    ).toBe("schema.d1.job_pipeline_instances.alter_table_add_column_run_schedule_id");
    expect(
      d1ByStatement.get(
        findRemainder("schema.do.job_pipeline_instances.alter_table_add_column_run_async_job_id").statement,
      ),
    ).toBe("schema.d1.job_pipeline_instances.alter_table_add_column_run_async_job_id");
    // Every other remainder statement is unique across catalogues.
    const allOtherStatements = new Set([
      ...D1_CATALOGUE_ENTRIES.map((e) => e.statement),
      ...ORM_CATALOGUE_ENTRIES.map((e) => e.statement),
      ...DO_CATALOGUE_ENTRIES.map((e) => e.statement),
    ]);
    const crossPlane = new Set([
      "schema.do.job_pipeline_definitions.create_table_v1",
      "schema.do.job_pipeline_instances.create_table_v1",
      "schema.do.job_pipeline_instances.alter_table_add_column_run_schedule_id",
      "schema.do.job_pipeline_instances.alter_table_add_column_run_async_job_id",
    ]);
    for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
      if (crossPlane.has(entry.code)) continue;
      expect(allOtherStatements.has(entry.statement), entry.code).toBe(false);
    }
  });

  it("each entry's statement is byte-identical to the base (sha256 pin)", () => {
    expect(Object.keys(REMAINDER_STATEMENT_SHA256).length).toBe(51);
    for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
      const digest = createHash("sha256")
        .update(entry.statement, "utf8")
        .digest("hex");
      expect(digest, entry.code).toBe(REMAINDER_STATEMENT_SHA256[entry.code]);
    }
  });

  it("equality pin: the remainder catalogue builds the base remainder schema exactly", () => {
    const expected = expectedRemainderModel();
    expect(Object.keys(expected.tables).length).toBe(19);
    // The (column, type) pairs the two generic ALTERs reconcile, read
    // from the base fixture — the catalogue resolves one template per
    // pair, exactly as the adapters do at the call site.
    const base = baseCaptures();
    const canonicalBase = base.find((c) => c.adapter === "CanonicalReportEnsure")!;
    const reportPairs = [...new Set(
      canonicalBase.queries
        .filter((q) => q.trim().startsWith("ALTER TABLE"))
        .map((q) => {
          const m = q.match(/ADD COLUMN\s+([a-z0-9_]+)\s+(.+)$/i);
          return `${m![1]}|${m![2].trim()}`;
        }),
    )].map((s) => s.split("|") as [string, string]);
    expect(reportPairs).toHaveLength(11);
    const confirmBase = base.find((c) => c.adapter === "ReportConfirmationEnsure")!;
    const confirmPairs = confirmBase.queries
      .filter((q) => q.trim().startsWith("ALTER TABLE"))
      .map((q) => {
        const m = q.match(/ADD COLUMN\s+([a-z0-9_]+)\s+(.+)$/i);
        return [m![1], m![2].trim()] as [string, string];
      });
    expect(confirmPairs).toEqual([
      ["report_id", "TEXT"],
      ["created_by", "TEXT"],
    ]);
    const instance = new InMemorySchemaInstance();
    // Base CREATEs for the reconciled tables whose CREATE lives in
    // the DO / ORM catalogues (the remainder catalogue holds only
    // their ALTERs / DROP).
    for (const table of [
      "mas_async_jobs",
      "mas_iv_history",
      "job_run_records",
      "mas_data_captures",
      "mas_data_provider_routes",
      "mas_report_confirmations",
      "mas_opportunity_scans",
      "stock_copilot_positions",
      "stock_copilot_activity",
    ]) {
      instance.exec(doTableSql(table));
    }
    instance.exec(
      doStatementSql("schema.do.mas_reports.create_table", { TABLE: "mas_reports" }),
    );
    instance.exec(ormTableSql("mas_trades"));
    // Remainder entries in catalogue order. The two generic ALTERs
    // resolve once per reconciled column; the DROP resolves with the
    // table; the seed form is DML and has no schema effect.
    for (const entry of REMAINDER_CATALOGUE_ENTRIES) {
      if (entry.kind === "seed") continue;
      if (entry.code === "schema.do.mas_reports.alter_table_add_column") {
        for (const [column, type] of reportPairs) {
          instance.exec(
            resolveStatementText(entry, { TABLE: "mas_reports", column, type }),
          );
        }
        continue;
      }
      if (entry.code === "schema.do.mas_report_confirmations.alter_table_add_column") {
        for (const [column, type] of confirmPairs) {
          instance.exec(resolveStatementText(entry, { column, type }));
        }
        continue;
      }
      instance.exec(resolveStatementText(entry, { TABLE: entry.table }));
    }
    // The DO indexes for the reconciled tables, after the DROP — the
    // real ensure order drops the stale unique index before
    // re-creating it, and the model must end with it present.
    // job_run_records_recent_idx is ORM-sourced (P2b), not DO.
    for (const entry of ORM_CATALOGUE_ENTRIES) {
      if (entry.plane !== "index" || entry.table !== "job_run_records") continue;
      instance.exec(resolveStatementText(entry, { TABLE: entry.table }));
    }
    for (const entry of DO_CATALOGUE_ENTRIES) {
      if (entry.plane !== "index") continue;
      if (
        ![
          "mas_async_jobs",
          "mas_iv_history",
          "job_run_records",
          "mas_data_captures",
          "mas_opportunity_scans",
          "mas_reports",
        ].includes(entry.table)
      ) {
        continue;
      }
      instance.exec(resolveStatementText(entry, { TABLE: entry.table }));
    }
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
    expect(base.length).toBe(25);
    const actual = await driveAll();
    expect(actual.length).toBe(25);
    for (let i = 0; i < base.length; i++) {
      expect(actual[i].adapter, `capture ${i} adapter`).toBe(base[i].adapter);
      expect(actual[i].file, `capture ${i} file`).toBe(base[i].file);
      expect(actual[i].trigger, `capture ${i} trigger`).toBe(base[i].trigger);
      if (base[i].adapter === "D1ResourceRollupEnsure") {
        // DISCLOSED NORMALIZATION: the adapter's three CREATEs differ
        // from the D1 catalogue's migration text only in whitespace
        // (4-space vs 2-space indent). The delegated adapter executes
        // the catalogue text; the equality pin below proves the two
        // texts build the identical model, and the base fixture
        // preserves the originals as the "before" evidence.
        expect(actual[i].queries, `capture ${i} (${base[i].adapter})`).toEqual([
          d1TableSql("resource_daily_rollups"),
          d1TableSql("resource_alert_state"),
          d1TableSql("resource_comparison_reports"),
        ]);
        continue;
      }
      expect(actual[i].queries, `capture ${i} (${base[i].adapter})`).toEqual(
        base[i].queries,
      );
    }
  });

  it("the three normalized D1 delegations build the identical model", () => {
    // The adapter's CREATE and the D1 catalogue's CREATE for each
    // resource table parse to the same model: the normalization is
    // whitespace only, never a schema change.
    const base = baseCaptures();
    const rollup = base.find((c) => c.adapter === "D1ResourceRollupEnsure")!;
    for (const table of [
      "resource_daily_rollups",
      "resource_alert_state",
      "resource_comparison_reports",
    ]) {
      const adapterSql = rollup.queries.find((q) => q.includes(table))!;
      const catalogueSql = d1TableSql(table);
      expect(adapterSql).not.toBe(catalogueSql);
      const fromAdapter = new InMemorySchemaInstance();
      fromAdapter.exec(adapterSql);
      const fromCatalogue = new InMemorySchemaInstance();
      fromCatalogue.exec(catalogueSql);
      expect(diffSchema(fromAdapter.introspect(), fromCatalogue.introspect())).toEqual({
        missingTables: [],
        extraTables: [],
        missingColumns: [],
        extraColumns: [],
        changedColumns: [],
        missingIndexes: [],
        extraIndexes: [],
        changedIndexes: [],
        missingConstraints: [],
        extraConstraints: [],
      });
    }
  });

  it("the D1 delegations resolve to the existing catalogue entries", () => {
    const base = baseCaptures();
    const indexList = base.find((c) => c.adapter === "D1IndexListStore")!;
    expect(doTableSql("mas_index_lists")).toBe(
      indexList.queries.find((q) => q.trim().startsWith("CREATE TABLE")),
    );
    const quote = base.find((c) => c.adapter === "D1QuoteSourceEnsure")!;
    expect(d1TableSql("quote_source_setting")).toBe(quote.queries[0]);
    const usage = base.find((c) => c.adapter === "D1ResourceUsageRecord")!;
    expect(d1TableSql("resource_sql_ops")).toBe(usage.queries[0]);
    const feed = base.find((c) => c.adapter === "D1FeedDatasetEnsure")!;
    expect(remainderD1TableSql("mas_feed_datasets")).toBe(feed.queries[0]);
  });

  it("the exported DDL consts are the catalogue statements, and the managed migration rides them", () => {
    // Accessors resolve to the base texts.
    expect(remainderTableSql("mas_learnings")).toBe(
      remainderStatementSql("schema.do.mas_learnings.create_table"),
    );
    expect(remainderIndexSql("idx_learnings_domain")).toBe(
      remainderStatementSql("schema.index.mas_learnings.create_index_idx_learnings_domain"),
    );
    expect(remainderAlterSql("mas_async_jobs", "parent_job_id")).toBe(
      "ALTER TABLE mas_async_jobs ADD COLUMN parent_job_id TEXT",
    );
    expect(remainderAlterSql("mas_trades", "broker")).toBe(
      "ALTER TABLE mas_trades ADD COLUMN broker TEXT",
    );
    expect(
      remainderStatementSql("schema.do.mas_reports.alter_table_add_column", {
        TABLE: "mas_reports",
        column: "generation_id",
        type: "TEXT",
      }),
    ).toBe("ALTER TABLE mas_reports ADD COLUMN generation_id TEXT");
    expect(
      remainderStatementSql("schema.index.mas_reports.drop_index_idx_mas_reports_generation", {
        TABLE: "mas_reports",
      }),
    ).toBe("DROP INDEX idx_mas_reports_generation");
    // The frozen v1 copies: sha256-pinned to the DO suite's FROZEN_*
    // constants, and the instances copy differs from the live const.
    expect(
      createHash("sha256")
        .update(remainderFrozenTableSql("job_pipeline_definitions"), "utf8")
        .digest("hex"),
    ).toBe("63e75c48b6a9568f8b746518374b1ea721667aa8c19f6911589ace3db38d59c6");
    expect(
      createHash("sha256")
        .update(remainderFrozenTableSql("job_pipeline_instances"), "utf8")
        .digest("hex"),
    ).toBe("0fa9e16462343d5cd5be880d0767fdfa1ef4175bdde89dfcceb9d9ce8983cf19");
    expect(remainderFrozenTableSql("job_pipeline_instances")).not.toBe(
      JOB_PIPELINE_INSTANCES_DDL,
    );
    // The managed migration rides the catalogue: its `up` is the two
    // frozen entries plus the live artifacts consts.
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up).toHaveLength(4);
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up[0]).toBe(
      remainderFrozenTableSql("job_pipeline_definitions"),
    );
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up[1]).toBe(
      remainderFrozenTableSql("job_pipeline_instances"),
    );
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up[2]).toBe(JOB_PIPELINE_ARTIFACTS_DDL);
    expect(JOB_PIPELINE_SCHEMA_MIGRATION.up[3]).toBe(
      JOB_PIPELINE_ARTIFACTS_INDEX_DDL,
    );
    // The seed form resolves exactly as the call site assembles it.
    expect(
      remainderStatementSql("seed.route.orchestrator_migration.insert_or_replace", {
        table: "mas_reports",
        cols: "id, title",
        placeholders: "?, ?",
      }),
    ).toBe("INSERT OR REPLACE INTO mas_reports (id, title) VALUES (?, ?)");
    // A missing parameter fails closed.
    expect(() =>
      remainderStatementSql("schema.do.mas_reports.alter_table_add_column", {
        TABLE: "mas_reports",
      }),
    ).toThrow();
  });

  it("no inline DDL remains in the P3 delegated files", () => {
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
    for (const file of P3_DELEGATED_FILES) {
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
    expect(inline).toEqual([]);
  });

  it("the remainder catalogue is registered in the schemaComponent barrel", async () => {
    const barrel = await import("../src/data/schemaComponent");
    expect(barrel.REMAINDER_CATALOGUE).toBe(REMAINDER_CATALOGUE);
    expect(barrel.buildRemainderCatalogue).toBe(buildRemainderCatalogue);
    expect(barrel.remainderTableSql).toBe(remainderTableSql);
    expect(barrel.remainderD1TableSql).toBe(remainderD1TableSql);
    expect(barrel.remainderFrozenTableSql).toBe(remainderFrozenTableSql);
    expect(barrel.remainderIndexSql).toBe(remainderIndexSql);
    expect(barrel.remainderAlterSql).toBe(remainderAlterSql);
    expect(barrel.remainderStatementSql).toBe(remainderStatementSql);
    expect(barrel.d1TableSql).toBe(d1TableSql);
  });
});
