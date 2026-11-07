/**
 * Issue #2869 (producer/consumer persisted stages + queue pub/sub
 * under #2764) — the stage-message contract.
 *
 * Every stock-screen stage is a producer/consumer pair under
 * this contract (the #2621 shared runtime only — Cloudflare
 * Queues / Workflows / mas_async_jobs carry the messages; the
 * message catalog is the existing WorkflowJobCommand /
 * AsyncJob capability set, reused, not duplicated; there is
 * no second queue, recorder, catalog, or port layer here):
 *
 *   1. A stage reads ONLY persisted input (its queue message
 *      references persisted input by artifact key) or its
 *      queue message — never live data it fetched itself
 *      outside the pipeline, never in-memory-only results.
 *   2. It writes its output to the canonical store
 *      (user/session/run scoped — no "default" identity).
 *   3. It publishes a stage message (this module) so the
 *      next stage can consume it.
 *
 * The stages, named once here (planner/broker stages first,
 * then the pipeline stages in order):
 *   plan, brokerStart, acquireUniverse, fetchQuotes, enrich,
 *   computeIndicatorsAndScores, applyFilters, rankAndGrade,
 *   detectStandouts, persistCanonicalResults, shapeReport,
 *   deliver — plus analysis-done, the virtual message
 *   persistCanonicalResults' publisher emits and the report
 *   generator subscribes to (see stageReportConsumer.ts).
 *
 * Exactly-once EFFECT (not exactly-once delivery — queues
 * redeliver): a consumer claims idempotencyKey =
 * runId + stageId before acting; a redelivered message for
 * an already-claimed key is suppressed, never re-applied.
 * Delivery stages additionally suppress by (runId,
 * destination) via the Slice 7 suppressor.
 *
 * Failure handling, per stage: a message that fails
 * validation is POISON — dead-lettered immediately, never
 * retried (retrying a message that can never validate only
 * burns budget). A well-formed message that fails
 * processing retries within the pipelinePolicy budget; past
 * it, it is dead-lettered. Nothing is ever silently
 * dropped: every terminal path is a returned status or a
 * thrown error the caller must handle (loud failure).
 *
 * FUSED DEGENERATE CASE, explicitly recorded (not a
 * permanent bypass): today the monolithic path
 * (ScreenerAgent.runScreen) runs stages in-process and
 * persists via persistRun + the canonical report, emitting
 * no stage messages — EXCEPT the report leg since G8
 * #2869: generateRunPdf persists the analysis to a
 * per-run key and consumes a real analysis-done message
 * through stageReportProduction (in-process consume).
 * Slice 1 #2869 adds the queue transport for THAT message
 * (stageQueueTransport.ts): after the canonical row lands,
 * the same message is published to the shared screener-events
 * queue and consumed via ScreenerAgent.consumeQueuedAnalysisDone
 * (same consumer, durable claims; in the normal path it
 * duplicate-suppresses, because the in-process leg already
 * claimed). Slice 2 #2869 emits one stage message per stage
 * boundary inside runScreenInner (persist-then-publish, same
 * contract, same queue): the fused path is now a
 * producer/consumer path at every boundary — the in-process
 * stage still executes, and its boundary message is recorded
 * by the queue executor (ScreenerAgent.recordQueuedStageBoundary,
 * durable claims, artifact verified). analysis-done is not
 * re-emitted by slice 2 (slice 1 already publishes it after
 * the canonical row lands); deliver marks handoff to the
 * delivery bridge, not delivery itself. Slice 2 does NOT
 * rewrite any stage's execution, and it does not claim the
 * chain generateTabular leg decision (slice 3, still open).
 */

import {
  OPTIONS_PIPELINE_STAGES,
  PAYMENT_STEP_IDS,
  SAGA_STEP_IDS,
  TRADE_APPROVAL_STEP_IDS,
} from "./stageRuntimeIds";

/**
 * Issue #3073 - the seam is no longer stock-only.
 *
 * #2869 built the stage contract for the stock screen, so `stageId` was
 * `StockStageId` and the stock ids were the only legal values. Every other
 * family (#3069 S2/S3) therefore had a declared contract and no seam. The
 * message now names its `family` and its `stageId` is validated against that
 * family's declared runtime ids - the same ids the workflow catalog shows,
 * from the same module (`stageRuntimeIds`), so a family cannot publish a
 * stage the catalog does not know about, or vice versa.
 */
export const STAGE_FAMILIES = ["stock", "options", "trading", "payment", "saga", "strategy", "goal", "jobs"] as const;

export type StageFamily = (typeof STAGE_FAMILIES)[number];

/** The declared runtime stage ids of each family (the catalog's projection). */
export const STAGE_IDS_BY_FAMILY: Record<StageFamily, readonly string[]> = {
  stock: [
    "plan",
    "brokerStart",
    "acquireUniverse",
    "fetchQuotes",
    "enrich",
    "computeIndicatorsAndScores",
    "applyFilters",
    "rankAndGrade",
    "detectStandouts",
    "persistCanonicalResults",
    "analysis-done",
    "shapeReport",
    "deliver",
  ],
  // #3186 step 3d: the legacy #3191 phases are RETIRED. Their only
  // publisher was the #3072 end-of-run emitter, called only by the
  // manual handler - which now runs the pipeline (per-stage messages).
  // A phase id is now rejected by stageMessage() validation.
  options: [...OPTIONS_PIPELINE_STAGES],
  trading: TRADE_APPROVAL_STEP_IDS,
  payment: PAYMENT_STEP_IDS,
  saga: SAGA_STEP_IDS,
  // #3186: the catalog's declared runtime steps (workflowCatalog.ts).
  strategy: ["feed", "analysis", "generation", "delivery"],
  // #3186: the composer's stages (catalog GOAL_SCREEN stage names).
  // Declared now, emitted by the goal-leg migration (step 3), not yet live.
  goal: ["feed", "analysis", "store", "deliver"],
  // #3543 (Pipeline J1 host wiring, consumed by J2 #3535): the job
  // pipeline's stage kinds — the epic's five producer/consumer
  // stages (#3533). A job tree's (runId, stageId) claim addressing
  // stays `job:<nodePath>` under this family's namespace (see
  // stageIdempotencyKey); the declared ids here are the stage
  // KINDS a login-scoped host may publish stage messages for.
  jobs: ["feed", "enrich", "analyze", "generate", "deliver"],
};

/**
 * Stock keeps the historical shape: its ids must equal STOCK_STAGE_IDS, which
 * is declared below. The map above is written out rather than derived from
 * STOCK_STAGE_IDS to keep this module import-cycle free; the pin in
 * tests/stage_seam_families_3073.test.ts asserts the two agree.
 */
export const STOCK_STAGE_IDS = [
  "plan",
  "brokerStart",
  "acquireUniverse",
  "fetchQuotes",
  "enrich",
  "computeIndicatorsAndScores",
  "applyFilters",
  "rankAndGrade",
  "detectStandouts",
  "persistCanonicalResults",
  "analysis-done",
  "shapeReport",
  "deliver",
] as const;

export type StockStageId = (typeof STOCK_STAGE_IDS)[number];

/** One stage message: references persisted output, never carries it. */
export interface StageMessage {
  runId: string;
  /** Which family's seam carried this message (#3073). Absent means stock, for pre-#3073 messages. */
  family?: StageFamily;
  stageId: string;
  /** The next stage's persisted input, by canonical artifact key. */
  artifactKeys: string[];
  /** Owning user login — required, never "default" (#1185). */
  userLogin: string;
  /** The stage that produced this message (== stageId, except analysis-done, produced by persistCanonicalResults). */
  producedBy: string;
  /** Idempotency key: runId + stageId (exactly-once effect). */
  idempotencyKey: string;
  provenance: {
    /** The run this stage belongs to (== runId for a fresh run; differs on replay, which replays a prior run's outputs). */
    parentRunId: string;
    traceId?: string;
  };
}

/**
 * The exactly-once-effect key for one stage of one run.
 *
 * Stock keys keep their historical shape (`run::stage`) because claims written
 * by running instances must still match after this change; every other family
 * is namespaced by family, so two families cannot collide on a shared id.
 *
 * "jobs" (#3549) began as a claim namespace ahead of a message
 * family: configured job trees claim under it (their stage ids
 * are `job:<nodePath>`). The message family is declared as of
 * #3543 (Pipeline J1 host wiring, consumed by J2 #3535): its
 * declared ids are the pipeline's stage kinds (feed / enrich /
 * analyze / generate / deliver), the static catalog a
 * login-scoped host publishes against, while the configuration-
 * dynamic `job:<nodePath>` ids remain the claim addressing.
 */
export function stageIdempotencyKey(
  runId: string,
  stageId: string,
  family: StageFamily = "stock",
): string {
  return family === "stock" ? `${runId}::${stageId}` : `${runId}::${family}::${stageId}`;
}

/** Build a stage message. Refuses loudly (never a malformed message): runId, userLogin, and at least one artifact key are required. */
export function stageMessage(args: {
  runId: string;
  stageId: string;
  family?: StageFamily;
  artifactKeys: string[];
  userLogin: string;
  producedBy?: string;
  traceId?: string;
}): StageMessage {
  const family = args.family ?? "stock";
  if (!STAGE_IDS_BY_FAMILY[family]) {
    throw new Error(`stageMessage refused: unknown stage family "${family}".`);
  }
  if (!STAGE_IDS_BY_FAMILY[family].includes(args.stageId)) {
    throw new Error(
      `stageMessage refused: stage "${args.stageId}" is not a declared ${family} stage id.`,
    );
  }
  const runId = args.runId.trim();
  const userLogin = args.userLogin.trim();
  if (!runId) throw new Error("stageMessage refused: runId is required.");
  if (!userLogin || userLogin === "default") {
    throw new Error("stageMessage refused: a real userLogin is required, never \"default\".");
  }
  if (!args.artifactKeys || args.artifactKeys.length === 0) {
    throw new Error("stageMessage refused: at least one artifactKey is required — a message must reference persisted output.");
  }
  return {
    runId,
    family,
    stageId: args.stageId,
    artifactKeys: [...args.artifactKeys],
    userLogin,
    producedBy: args.producedBy ?? args.stageId,
    idempotencyKey: stageIdempotencyKey(runId, args.stageId, family),
    provenance: {
      parentRunId: runId,
      ...(args.traceId ? { traceId: args.traceId } : {}),
    },
  };
}

/** True when this message is the report generator's trigger. */
export function isAnalysisDoneMessage(message: StageMessage): boolean {
  return message.stageId === "analysis-done";
}

/**
 * Persist-then-publish, the one ordering a producer must use:
 * persist first, publish second. If publish throws, the output
 * is already durable, so the caller may republish the same
 * message (same idempotencyKey) without re-running the stage.
 * Publish-then-persist is refused by construction: there is
 * no helper for it, and this helper never publishes first.
 */
export async function publishStageOutput<T>(args: {
  persist: (output: T) => Promise<string[]>;
  publish: (message: StageMessage) => Promise<void>;
  runId: string;
  family?: StageFamily;
  stageId: string;
  output: T;
  userLogin: string;
  traceId?: string;
}): Promise<StageMessage> {
  const artifactKeys = await args.persist(args.output);
  const message = stageMessage({
    runId: args.runId,
    family: args.family,
    stageId: args.stageId,
    artifactKeys,
    userLogin: args.userLogin,
    ...(args.traceId ? { traceId: args.traceId } : {}),
  });
  await args.publish(message);
  return message;
}
