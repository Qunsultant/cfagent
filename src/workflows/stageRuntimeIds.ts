/**
 * Issue #3191 - runtime id declarations shared by the server flows and the
 * workflow catalog.
 *
 * Why this file exists (and why it holds no imports): the workflow catalog
 * is rendered in the BROWSER, so anything it imports ends up in the client
 * bundle. Importing `trading-trade-workflow` or the options route directly
 * from the catalog dragged the agents SDK (`cloudflare:workers`) into the
 * frontend build and broke it. These constants are therefore pure data with
 * zero dependencies: the server modules re-export them so there is one
 * declaration, and the pins scan the flow sources to prove the data still
 * matches the code.
 */

/**
 * The payment workflow's real `step.do` ids, in flow order.
 * Pinned against src/workflows/paymentWorkflowFlow.ts by
 * tests/payment_saga_stage_ids_3191.test.ts.
 */
export const PAYMENT_STEP_IDS = [
  "gate-check",
  "record-coverage-required",
  "record-quota-exhausted",
  "consume-coverage",
  "record-checkout",
  "record-approval",
  "record-expiry",
  "record-rejection",
  "confirm-paid",
  "record-payment",
  "record-native-ledger",
  "record-usage",
  "issue-failure-credit",
  "start-screener",
] as const;

export type PaymentStepId = (typeof PAYMENT_STEP_IDS)[number];

/**
 * The saga workflow's real `step.do` ids (its polling waits are not steps).
 * Pinned against src/workflows/sagaWorkflowFlow.ts by
 * tests/payment_saga_stage_ids_3191.test.ts.
 */
export const SAGA_STEP_IDS = [
  "record-audit-saga-started",
  "start-payment-leg",
  "record-audit-payment-started",
  "record-audit-screen-completed",
  "compensate-failed-screen",
] as const;

export type SagaStepId = (typeof SAGA_STEP_IDS)[number];

/**
 * The trading leg's real durable step ids: the approval wait
 * (`step.waitForEvent("await-approval")`) and the settle (`step.do("settle-trade")`).
 * There is no fill or reconcile step - settlement happens inside `settle-trade`.
 * Pinned by tests/options_trading_stage_ids_3191.test.ts.
 */
export const TRADE_APPROVAL_STEP_IDS = ["await-approval", "settle-trade"] as const;

export type TradeApprovalStepId = (typeof TRADE_APPROVAL_STEP_IDS)[number];

/**
 * The options screen's real phases. Options is not a durable workflow: the
 * request handler IS the runtime, so `step.do` ids would be invention. Each
 * phase is pinned to a real call in src/agents/routes/etradeOptionsScreen.ts.
 */
export const OPTIONS_SCREEN_PHASES = ["provider-screen", "report-pipeline", "deliver"] as const;

export type OptionsScreenPhase = (typeof OPTIONS_SCREEN_PHASES)[number];

/**
 * Issue #3186 - the options pipeline's stage ids. The staged
 * producer/consumer pipeline supersedes the request handler as the
 * execution path, so its stages are the family's pipeline ids (the
 * #3191 phases above are retired since step 3d, when the pipeline
 * replaced the #3072 seam emitter entry by entry). Each id pins to
 * a real call (see tests/stage_families_3186.test.ts):
 * plan -> parseOptionsScreenRequest / optionsPlanBlock; chainFetch ->
 * fetchChainsForSymbol; enrich -> signal computation + enrichment
 * inside the screen path; screen -> screenOptions / evaluateChains;
 * risk -> assessSagaTradeRisk; persistCanonicalResults ->
 * recordUnifiedOptionsRun -> the mas_reports canonical store (the
 * scan-run store mas_opportunity_scans belongs to the
 * scanner/strategy leg, not this stage); shapeReport -> the
 * caller-supplied shapeReport fn (manual entry: PDF + XLSX + CSV
 * per-format legs; goal leg: report section; panel/scanner legs:
 * panel result); deliver -> the caller-supplied deliver fn (manual
 * entry: deliverGatedSlack / follow-up bridge; goal leg:
 * deferred-to-goal-run).
 *
 * Issue #4067 - this list IS the family's addressable vocabulary:
 * the control plane addresses these 8 execution stages by
 * (runId, stageId). The 4 display stages (feed/store/serve/deliver)
 * partition them in the catalog (workflowCatalog.ts,
 * options-screener entry) and are presentation only, never control
 * addresses - see OPTIONS_ADDRESSABLE_STAGES /
 * OPTIONS_DISPLAY_STAGES below.
 */
export const OPTIONS_PIPELINE_STAGES = [
  "plan",
  "chainFetch",
  "enrich",
  "screen",
  "risk",
  "persistCanonicalResults",
  "shapeReport",
  "deliver",
] as const;

export type OptionsPipelineStage = (typeof OPTIONS_PIPELINE_STAGES)[number];

/**
 * Issue #4067 - the options addressable vocabulary. Same array as
 * OPTIONS_PIPELINE_STAGES, named for the concept the control plane
 * imports: the stages a run executes, in pipeline order. The 4
 * display stages are presentation only and are never in this set;
 * stageMessage() refuses a display id for the options family
 * (see tests/options_stage_vocabulary_4067.test.ts).
 */
export const OPTIONS_ADDRESSABLE_STAGES = OPTIONS_PIPELINE_STAGES;

/**
 * Issue #4272 (#3552 S2) - the strategy pipeline's stages, in
 * pipeline order. The strategy pipeline IS the eight-stage options
 * pipeline run over strategy ports (#4271), so the strategy
 * vocabulary is the same 8 stage ids as the options vocabulary BY
 * DESIGN — one list, not two: this is the #4067 pin under the
 * strategy family's name, so the pin stays the single source of
 * truth. A strategy job's children carry these kinds (see
 * strategyScreenJobDefinition), and the control plane addresses a
 * strategy run's stages by (runId, stageId) under this vocabulary
 * (see tests/strategy_stage_vocabulary_4272.test.ts).
 */
export const STRATEGY_PIPELINE_STAGES = OPTIONS_PIPELINE_STAGES;

export type StrategyPipelineStage = (typeof STRATEGY_PIPELINE_STAGES)[number];

/** Issue #4272 - the strategy addressable vocabulary (the 8 execution stages). */
export const STRATEGY_ADDRESSABLE_STAGES = STRATEGY_PIPELINE_STAGES;

/**
 * Issue #4067 - the 4 display stages the catalog partitions the 8
 * execution stages under (workflowCatalog.ts, options-screener
 * entry: feed covers plan/chainFetch/enrich/screen/risk; store
 * covers persistCanonicalResults; serve covers shapeReport; deliver
 * covers deliver). Presentation only - with one shared id: "deliver"
 * is both the display stage and execution stage 8, so it IS
 * addressable as the execution stage; "feed", "store" and "serve"
 * have no execution-stage counterpart and are never control
 * addresses.
 */
export const OPTIONS_DISPLAY_STAGES = ["feed", "store", "serve", "deliver"] as const;

export type OptionsDisplayStage = (typeof OPTIONS_DISPLAY_STAGES)[number];

/**
 * The per-run persisted-analysis key family (moved here from
 * stageReportProduction.ts by #3186 step 3e). stageQueueTransport
 * needs only this key helper, and importing the whole report
 * production module from the transport dragged the server-only
 * report chain (stockReportArtifacts -> unifiedReportPipeline ->
 * ReportAssetAgent -> the agents SDK, `cloudflare:workers`) into
 * the browser bundle and broke the client build - the same failure
 * class #3191's header documents for the catalog. This file is
 * pure data with zero imports, so the transport can use the key
 * without the chain. stageReportProduction re-exports it, so
 * existing import paths keep working.
 */
export const STAGE_ANALYSIS_KEY_PREFIX = "screener:analysis:";

export function stageAnalysisKey(timestamp: string): string {
  return `${STAGE_ANALYSIS_KEY_PREFIX}${timestamp}`;
}
