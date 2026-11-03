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
 * through stageReportProduction (in-process consume, not
 * queue transport). That path is the degenerate case this
 * contract migrates: a follow-up slice under #2869 emits
 * one stage message per stage boundary inside runScreenInner
 * (persist-then-publish, same contract), after which the
 * fused path is gone, and a second follow-up wires queue
 * transport for the analysis-done message. This slice lands the contract, the
 * report consumer, and the batching primitives; it does NOT
 * rewrite any stage's execution, and it does not claim the
 * migration is done.
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
  stageId: StockStageId;
  /** The next stage's persisted input, by canonical artifact key. */
  artifactKeys: string[];
  /** Owning user login — required, never "default" (#1185). */
  userLogin: string;
  /** The stage that produced this message (== stageId, except analysis-done, produced by persistCanonicalResults). */
  producedBy: StockStageId;
  /** Idempotency key: runId + stageId (exactly-once effect). */
  idempotencyKey: string;
  provenance: {
    /** The run this stage belongs to (== runId for a fresh run; differs on replay, which replays a prior run's outputs). */
    parentRunId: string;
    traceId?: string;
  };
}

/** The exactly-once-effect key for one stage of one run. */
export function stageIdempotencyKey(runId: string, stageId: StockStageId): string {
  return `${runId}::${stageId}`;
}

/** Build a stage message. Refuses loudly (never a malformed message): runId, userLogin, and at least one artifact key are required. */
export function stageMessage(args: {
  runId: string;
  stageId: StockStageId;
  artifactKeys: string[];
  userLogin: string;
  producedBy?: StockStageId;
  traceId?: string;
}): StageMessage {
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
    stageId: args.stageId,
    artifactKeys: [...args.artifactKeys],
    userLogin,
    producedBy: args.producedBy ?? args.stageId,
    idempotencyKey: stageIdempotencyKey(runId, args.stageId),
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
  stageId: StockStageId;
  output: T;
  userLogin: string;
  traceId?: string;
}): Promise<StageMessage> {
  const artifactKeys = await args.persist(args.output);
  const message = stageMessage({
    runId: args.runId,
    stageId: args.stageId,
    artifactKeys,
    userLogin: args.userLogin,
    ...(args.traceId ? { traceId: args.traceId } : {}),
  });
  await args.publish(message);
  return message;
}
