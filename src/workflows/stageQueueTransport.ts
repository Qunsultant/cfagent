/**
 * Issue #2869 slice 1 (under #2764) — queue transport for the
 * analysis-done stage message, and nothing else.
 *
 * What this slice is, precisely:
 * - AFTER the canonical report row lands (persistScreenerReportCanonical
 *   in src/agents/orchestrator/reportDispatch.ts — the one recorder),
 *   the analysis-done StageMessage is published to the SHARED
 *   #2621 runtime: the Cloudflare Queue `screener-events` (producer
 *   binding SCREENER_EVENTS, already declared in wrangler.jsonc with
 *   its consumer + DLQ). No new queue, no new recorder, no new
 *   catalog, no new port layer: the message shape is the existing
 *   stageMessage contract, the consumer is the existing
 *   stageReportConsumer.consumeAnalysisDone, and the claims are the
 *   existing durable stage claims (mas_stage_claims).
 * - The queue executor is executeAnalysisDoneQueueMessage below:
 *   a thin, dependency-injected mapping from a queue message to
 *   a consume outcome onto ack/retry. It takes its consume
 *   function as a parameter and never calls the consumer
 *   itself — deliberately, so the Factor 6 pin (only one
 *   production caller of the consumer: the
 *   stageReportProduction helper, which passes the SQL-backed
 *   claims store whenever the agent has SQL) stays intact.
 *   The production glue (src/server.ts queue() ->
 *   ScreenerAgent .consumeQueuedAnalysisDone) supplies that
 *   consume via the production helper: persisted analysis
 *   read from the owning ScreenerAgent DO's storage, the
 *   SQL-backed claims store, and the one generation
 *   module's PDF leg. This module itself never touches a
 *   DO, a queue binding, or a provider — it is testable
 *   without workerd.
 *
 * What this slice is NOT (slices 2 and 3, still open on #2869):
 * - It does not emit one stage message per stage boundary inside
 *   runScreenInner; the other 12 stages still run in-process.
 * - It does not replace the in-process PDF leg. In the normal
 *   path the in-process leg (generateRunPdfViaStageConsumer) has
 *   already claimed runId::analysis-done, so the queued consume
 *   correctly returns duplicate-suppressed and generates nothing
 *   twice. The queued consume is the transport + the recovery
 *   path: when the in-process leg failed (its claim is released
 *   on generation failure), the queued consume can still
 *   generate from persisted data.
 * - It does not itself refresh the canonical mas_reports row's
 *   pdfKey when a queued consume generates after the in-process
 *   leg failed; the generated pdf fields land on the persisted
 *   analysis key (what replay reads). The slice 1 follow-up
 *   (#2869 pdfKey refresh, refreshCanonicalReportPdfFields via
 *   the one recorder) refreshes the canonical row from the
 *   queue handler on a generated queued outcome; this
 *   transport's consume return carries the pdf fields for it.
 * - Failed runs publish nothing: a run with no full analysis set
 *   (allStocks empty) has nothing for the consumer to generate
 *   from, and the consumer would throw rather than regenerate.
 *   The publisher caller (reportDispatch) enforces that guard;
 *   publishAnalysisDone also refuses a missing/empty timestamp
 *   or a non-login userLogin loudly by returning
 *   published: false, never by throwing into a persisted run.
 *
 * Failure discipline (stageMessage contract, unchanged):
 * - Publish failure never fails the run: the canonical row is
 *   already durable and the in-process leg already ran, so a
 *   queue send throw is logged and reported, not propagated.
 * - Poison (wrong stage, missing runId/artifact keys) is
 *   dead-lettered by the consumer and acked — never retried.
 * - Over-budget (attempt > maxAttempts, pipelinePolicy budget
 *   via the queue's max_retries + the consumer's maxAttempts)
 *   is dead-lettered and acked.
 * - A missing persisted analysis throws, so the platform
 *   retries up to max_retries and then DLQs it — loudly, never
 *   silently dropped.
 */

import type { StageConsumeResult } from "./stageReportConsumer";
import {
  isAnalysisDoneMessage,
  STOCK_STAGE_IDS,
  stageMessage,
  type StageMessage,
  type StockStageId,
} from "./stageMessage";
import { stageAnalysisKey } from "./stageRuntimeIds";
import { STAGE_IDS_BY_FAMILY, type StageFamily } from "./stageMessage";
import { maxAttemptsForStage, resolveStageConfig } from "./stageConfig";

/** The queue send seam: a Cloudflare Queue binding's send. */
export interface StageQueueSend {
  send: (body: unknown) => Promise<unknown> | unknown;
}

/** Build the analysis-done message for one run. Reuses the stage contract. */
export function buildAnalysisDoneMessage(args: {
  timestamp: string;
  userLogin: string;
}): StageMessage {
  return stageMessage({
    runId: `screener:${args.timestamp}`,
    stageId: "analysis-done",
    artifactKeys: [stageAnalysisKey(args.timestamp)],
    userLogin: args.userLogin,
  });
}

/** True only for a well-shaped analysis-done stage message body. */
export function isAnalysisDoneStageMessage(
  value: unknown,
): value is StageMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<StageMessage>;
  return (
    isAnalysisDoneMessage(m as StageMessage) &&
    typeof m.runId === "string" &&
    m.runId.trim() !== "" &&
    Array.isArray(m.artifactKeys) &&
    m.artifactKeys.length > 0 &&
    typeof m.userLogin === "string" &&
    m.userLogin.trim() !== "" &&
    m.userLogin !== "default" &&
    typeof m.idempotencyKey === "string" &&
    m.idempotencyKey !== ""
  );
}

export type PublishAnalysisDoneResult =
  | { published: true; message: StageMessage }
  | { published: false; reason: string };

/**
 * Publish one analysis-done message. Never throws: absence of a
 * queue binding, a bad timestamp/login, or a send failure is
 * reported, because the caller has already persisted the run
 * and the in-process leg has already run — a publish failure
 * must not turn a persisted run into a failed request.
 */
export async function publishAnalysisDone(args: {
  queue?: StageQueueSend | null;
  timestamp: string;
  userLogin: string;
}): Promise<PublishAnalysisDoneResult> {
  const timestamp = args.timestamp?.trim();
  const userLogin = args.userLogin?.trim();
  if (!timestamp) {
    return { published: false, reason: "no run timestamp; refusing to publish without a runId." };
  }
  if (!userLogin || userLogin === "default") {
    return { published: false, reason: "no real userLogin; refusing to publish under a default identity." };
  }
  if (!args.queue || typeof args.queue.send !== "function") {
    return { published: false, reason: "no SCREENER_EVENTS queue binding; publish skipped (legacy in-process path only)." };
  }
  let message: StageMessage;
  try {
    message = buildAnalysisDoneMessage({ timestamp, userLogin });
  } catch (err) {
    return { published: false, reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    await args.queue.send(message);
  } catch (err) {
    console.error(
      "[stageQueueTransport] analysis-done publish failed (run persisted, in-process leg already ran):",
      err instanceof Error ? err.message : String(err),
    );
    return { published: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { published: true, message };
}

export type QueueMessageAction = "ack" | "retry";

export interface ExecuteAnalysisDoneResult {
  action: QueueMessageAction;
  status: StageConsumeResult["status"];
  reason?: string;
}

/**
 * The queue executor core: map one analysis-done queue message
 * onto an injected consume function, then onto ack/retry.
 * The consume function is injected (production: the
 * stageReportProduction helper) so this module never
 * becomes a second production caller of the consumer
 * (Factor 6 pin, tests/factor6_durable_claims_2860.test.ts).
 * - generated / duplicate-suppressed -> ack (effect landed, or
 *   already landed; redelivery must not regenerate).
 * - dead-lettered (poison or over-budget) -> ack (the consume
 *   already invoked deadLetter; retrying would loop or repeat
 *   a budget-exhausted message).
 * - missing persisted analysis -> THROW (the consumer refuses
 *   to fabricate analysis; the platform retries to max_retries,
 *   then DLQs — loud, never silent).
 * Non-analysis-done bodies are not the executor's work: they
 * return dead-lettered/ack so the caller never retries a
 * message this executor could never consume. Callers that
 * route by type (server.ts queue()) should only hand this
 * executor analysis-done bodies; the guard here is defense.
 */
export async function executeAnalysisDoneQueueMessage(args: {
  message: StageMessage;
  attempt?: number;
  maxAttempts?: number;
  /** Environment for externalized stage config; omit to run on code defaults. */
  env?: Record<string, string | undefined>;
  consume: (input: {
    message: StageMessage;
    attempt: number;
    maxAttempts: number;
  }) => Promise<StageConsumeResult>;
  deadLetter?: (info: { message: StageMessage; reason: string }) => Promise<void> | void;
}): Promise<ExecuteAnalysisDoneResult> {
  if (!isAnalysisDoneStageMessage(args.message)) {
    if (args.deadLetter) {
      await args.deadLetter({
        message: args.message,
        reason: "poison message: not a well-shaped analysis-done stage message; refusing without retry.",
      });
    }
    return { action: "ack", status: "dead-lettered", reason: "poison message: not a well-shaped analysis-done stage message." };
  }
  const outcome = await args.consume({
    message: args.message,
    attempt: args.attempt ?? 1,
    // Issue #3075: the budget is externalized config, not a literal at the seam.
    maxAttempts: args.maxAttempts ?? maxAttemptsForStage(resolveStageConfig(args.env ?? {}), args.message.stageId),
  });
  if (outcome.status === "dead-lettered") {
    return { action: "ack", status: outcome.status, reason: outcome.reason };
  }
  return { action: "ack", status: outcome.status };
}

/**
 * Issue #2869 slice 2 (under #2764) — per-boundary stage messages
 * inside runScreenInner, over slice 1's transport, and nothing else.
 *
 * Boundary semantics, stated plainly so no message overclaims:
 * - Each message references a stage artifact the producer persisted
 *   FIRST in the owning ScreenerAgent DO's storage (persist-then-
 *   publish, stageMessage contract): the artifact is a small stage
 *   summary (counts, keys, statuses), never the stage's full payload
 *   and never live data. The next stage in the fused path already
 *   ran in-process; the queued message is the boundary record and
 *   the recovery journal, exactly like slice 1's analysis-done
 *   message (in-process primary, queued consume as record /
 *   recovery). It does not re-execute a stage.
 * - brokerStart marks the broker-routed command entering the agent
 *   (the broker's start decision itself is upstream, in the route /
 *   workflow child — this message does not re-decide it).
 * - persistCanonicalResults marks the agent's persistRun boundary
 *   (latest/history + per-run artifacts in DO storage); the
 *   canonical row in the orchestrator seam lands downstream and
 *   its own boundary is slice 1's analysis-done publish.
 * - shapeReport marks report artifacts recorded by persistRun
 *   (generation ran inside persistRun, before the agent-local
 *   persist — emission order here follows the stage list, not
 *   the generation/persist interleaving).
 * - deliver marks handoff of the persisted result to the delivery
 *   bridge; actual delivery and (runId, destination) suppression
 *   are the bridge's (G6) responsibility and are NOT claimed by
 *   this message.
 * - analysis-done is NOT emitted here: slice 1 already publishes
 *   it after the canonical row lands. Emitting it twice would
 *   double-publish one boundary.
 * Publish failure never fails a run: the boundary artifact is
 * already durable, so a later republish with the same
 * idempotencyKey (runId::stageId) replays the same message.
 * Poison (wrong stage, missing keys, default identity) is
 * dead-lettered by the caller and acked — never retried.
 * A missing persisted artifact throws from the recorder, so
 * the platform retries to max_retries, then DLQs — loud,
 * never silently dropped (same discipline as analysis-done).
 */

/** The per-run stage artifact key family for boundary summaries. */
export const STAGE_BOUNDARY_KEY_PREFIX = "screener:stage:";

export function stageBoundaryKey(timestamp: string, stageId: StockStageId): string {
  return `${STAGE_BOUNDARY_KEY_PREFIX}${timestamp}:${stageId}`;
}

/** True only for a well-shaped stage message of any stage id. */
export function isStageMessage(value: unknown): value is StageMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<StageMessage>;
  const family = m.family ?? "stock";
  const familyIds = STAGE_IDS_BY_FAMILY[family as StageFamily];
  return (
    typeof m.stageId === "string" &&
    Array.isArray(familyIds) &&
    familyIds.includes(m.stageId) &&
    typeof m.runId === "string" &&
    m.runId.trim() !== "" &&
    Array.isArray(m.artifactKeys) &&
    m.artifactKeys.length > 0 &&
    typeof m.userLogin === "string" &&
    m.userLogin.trim() !== "" &&
    m.userLogin !== "default" &&
    typeof m.idempotencyKey === "string" &&
    m.idempotencyKey !== "" &&
    typeof m.producedBy === "string" &&
    (m.producedBy as string).length > 0
  );
}

/** True only for a well-shaped non-analysis-done stage message. */
export function isStageBoundaryMessage(value: unknown): value is StageMessage {
  return isStageMessage(value) && !isAnalysisDoneMessage(value as StageMessage);
}

/** Build one stage-boundary message for a run. Reuses the stage contract. */
export function buildStageBoundaryMessage(args: {
  /** Stock keeps its timestamp-derived run id; other families pass their own runId. */
  timestamp?: string;
  runId?: string;
  family?: StageFamily;
  userLogin: string;
  stageId: string;
  artifactKeys: string[];
}): StageMessage {
  const family = args.family ?? "stock";
  const runId = args.runId ?? (args.timestamp ? `screener:${args.timestamp}` : "");
  return stageMessage({
    runId,
    family,
    stageId: args.stageId,
    artifactKeys: args.artifactKeys,
    userLogin: args.userLogin,
  });
}

export type PublishStageBoundaryResult =
  | { published: true; message: StageMessage }
  | { published: false; reason: string };

/**
 * Publish one stage-boundary message. Never throws: absence of a
 * queue binding, a bad timestamp/login, or a send failure is
 * reported, because the caller has already persisted the boundary
 * artifact and the in-process stage has already run — a publish
 * failure must not turn a persisted run into a failed request.
 */
export async function publishStageBoundaryMessage(args: {
  queue?: StageQueueSend | null;
  message: StageMessage;
}): Promise<PublishStageBoundaryResult> {
  if (!isStageMessage(args.message)) {
    return { published: false, reason: "refusing to publish a malformed stage message." };
  }
  if (!args.queue || typeof args.queue.send !== "function") {
    return { published: false, reason: "no SCREENER_EVENTS queue binding; publish skipped (legacy in-process path only)." };
  }
  try {
    await args.queue.send(args.message);
  } catch (err) {
    console.error(
      "[stageQueueTransport] stage-boundary publish failed (boundary persisted, in-process stage already ran):",
      err instanceof Error ? err.message : String(err),
    );
    return { published: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { published: true, message: args.message };
}

export type StageBoundaryRecordStatus = "recorded" | "duplicate-suppressed" | "dead-lettered";

/**
 * The queue executor core for stage-boundary messages: map one
 * message onto an injected record function, then onto ack.
 * The record function (production: the owning ScreenerAgent's
 * boundary recorder, which claims the idempotencyKey and
 * verifies the artifact key exists) throws on a missing
 * persisted artifact, so the caller retries into the DLQ —
 * this executor never swallows that throw into an ack.
 * Non-boundary bodies are dead-lettered and acked, never
 * retried: this executor could never consume them.
 */
export async function executeStageBoundaryQueueMessage(args: {
  message: StageMessage;
  record: (input: { message: StageMessage }) => Promise<StageBoundaryRecordStatus>;
  deadLetter?: (info: { message: StageMessage; reason: string }) => Promise<void> | void;
}): Promise<{ action: "ack"; status: StageBoundaryRecordStatus; reason?: string }> {
  if (!isStageBoundaryMessage(args.message)) {
    if (args.deadLetter) {
      await args.deadLetter({
        message: args.message,
        reason: "poison message: not a well-shaped non-analysis-done stage message; refusing without retry.",
      });
    }
    return { action: "ack", status: "dead-lettered", reason: "poison message: not a well-shaped non-analysis-done stage message." };
  }
  const status = await args.record({ message: args.message });
  return { action: "ack", status };
}
