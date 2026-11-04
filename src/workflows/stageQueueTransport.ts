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
 * - It does not refresh the canonical mas_reports row's pdfKey
 *   when a queued consume generates after the in-process leg
 *   failed; the generated pdf fields land on the persisted
 *   analysis key (what replay reads). Refreshing the canonical
 *   row from a queued consume is a follow-up decision, not
 *   smuggled into this slice.
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
  stageMessage,
  type StageMessage,
} from "./stageMessage";
import { stageAnalysisKey } from "./stageReportProduction";

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
    maxAttempts: args.maxAttempts ?? 3,
  });
  if (outcome.status === "dead-lettered") {
    return { action: "ack", status: outcome.status, reason: outcome.reason };
  }
  return { action: "ack", status: outcome.status };
}
