/**
 * Issue #2868 (AOP slice under #2764) — stock-screen aspects,
 * applied once, through the repo's existing join points.
 *
 * No generic AOP framework is built here, and no existing
 * aspect is moved or duplicated. This module does two things:
 *
 * 1. THE MAP — SCREEN_RUN_ASPECTS names, for each of the
 *    nine cross-cutting concerns, the ONE join point that
 *    implements it. A future path must reuse the named join
 *    point, not re-implement the concern.
 * 2. THE TWO MISSING PIECES — failure classification and
 *    structured run logging, which had no once-only
 *    implementation (classification was ad-hoc string checks
 *    per call site; run logging was unstructured lines).
 *    They are wired at the one funnel every sync and
 *    workflow-child path shares: ScreenerAgent.runScreen.
 *
 * Concern -> join point (all pre-existing except the two
 * marked NEW, which this module provides):
 *   logging              NEW: logScreenRunEvent, wired in runScreen.
 *   auth/scoping         ScreenerAgent.recordOwner + screenRunLock
 *                        (#1185 owner identity, #828/#1993 lock).
 *   paid-run             Chat monetization budget gate
 *                        (nlqPorts/meshScreenDoor paid paths, S10).
 *   retry                pipelinePolicy retry budgets.
 *   failure-classification NEW: classifyScreenFailure, wired in
 *                        runScreen's failure path (rethrow unchanged).
 *   partial-result-marking collateShards qualified rule (Slice 6)
 *                        + ScreenerRunResult.partial (#462).
 *   delivery             Slice 3 persistThenDeliverAll +
 *                        Slice 7 (runId, destination) suppressor.
 *   provenance           manualWorkflowJobId / workflow traceparent
 *                        + canonical report generation
 *                        (screener:<timestamp>). Issue #2860
 *                        (Factor 14): the funnel trace_id IS the
 *                        workflow traceparent's trace-id when the
 *                        run carries one (funnelTraceIdForRun).
 *   telemetry            NEW (#2860 Factor 14): the funnel's events
 *                        fold into the screen-run metrics accumulator
 *                        (src/telemetry/screenRunStats.ts) at the
 *                        logScreenRunEvent join point — one fold per
 *                        logged event, never throwing, same loss
 *                        semantics as the retrieval-stats accumulator
 *                        (per-isolate; durable home is #1743's
 *                        Analytics Engine pipeline, a named
 *                        follow-up).
 *
 * The scheduled sharded chain bypasses runScreen (it runs
 * through shard jobs), so its aspects live at the chain's own
 * join points: chain submission logging + classification
 * (#2860: screen.started on submission, screen.failed with
 * the classifier's verdict on submission failure, the
 * inner audit carrying the same classification), the
 * planFeedStart audit, mas_async_jobs completion marking,
 * and collation. Remaining boundary, stated plainly:
 * in-flight job failures surface via the async_job.failed
 * audit + job rows, NOT classified — the generic executor
 * is shared runtime, so classifying there is a #2621
 * decision, not a stock slice. Nothing about the chain's
 * execution changes in this slice.
 */

import { parseTraceparent } from "../observability/observabilityPorts";
import { ingestScreenRunEvent } from "../telemetry/screenRunStats";

export const SCREEN_RUN_ASPECTS = {
  logging: { joinPoint: "ScreenerAgent.runScreen via logScreenRunEvent (this module); chain submission via the same fn (scheduledTasks autonomousMarketScreenSharded)" },
  authScoping: { joinPoint: "ScreenerAgent.recordOwner + screenRunLock (#1185, #828, #1993)" },
  paidRun: { joinPoint: "Chat monetization budget gate (nlqPorts / meshScreenDoor paid paths)" },
  retry: { joinPoint: "pipelinePolicy retry budgets" },
  failureClassification: { joinPoint: "classifyScreenFailure (this module), wired in runScreen + chain submission (scheduledTasks autonomousMarketScreenSharded)" },
  partialResultMarking: { joinPoint: "collateShards qualified rule + ScreenerRunResult.partial (#462)" },
  delivery: { joinPoint: "persistThenDeliverAll + deliverySuppressor (Slices 3 and 7)" },
  provenance: { joinPoint: "manualWorkflowJobId + workflow traceparent + canonical generation screener:<timestamp>; funnel trace_id is the workflow traceparent's trace-id (funnelTraceIdForRun, #2860 Factor 14)" },
  telemetry: { joinPoint: "screenRunStats accumulator, folded at logScreenRunEvent (this module, #2860 Factor 14)" },
} as const;

/**
 * Issue #2860 (Factor 14): the funnel's trace_id for a run. When
 * the run carries a workflow traceparent (W3C `00-<trace-id>-...`,
 * stamped on the WorkflowJobCommand by the mesh screen door and
 * threaded through shardScreenRequest → toAgentRequest →
 * ScreenerRunRequest), the funnel trace_id IS that trace-id — so a
 * run's started/completed/failed lines correlate with the
 * workflow's own hops by trace_id, with no separate correlation
 * map. An invalid or absent traceparent keeps the old behavior: a
 * fresh UUID per run (manual/scheduled runs have no workflow
 * traceparent). Never throws; never invents an id.
 */
export function funnelTraceIdForRun(traceparent?: string): string {
  const parsed = traceparent === undefined ? null : parseTraceparent(traceparent);
  return parsed?.traceId ?? crypto.randomUUID();
}

export type ScreenFailureClassification =
  | "retryable"
  | "auth"
  | "provider"
  | "validation"
  | "unknown";

/**
 * Classify a screen failure once, for logging and for
 * callers that branch on failure kind. Pure: no I/O, no
 * state, no behaviour change to the failure itself — the
 * caller still throws or returns exactly what it did.
 * Precedence is deliberate: "already running" is retryable
 * even though it also reads as a conflict; auth beats
 * provider (an auth-dead provider is an auth failure).
 */
export function classifyScreenFailure(error: unknown): ScreenFailureClassification {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  if (lower.includes("already running")) return "retryable";
  if (
    lower.includes("auth") ||
    lower.includes("token") ||
    lower.includes("unauthorized") ||
    lower.includes("not authenticated")
  ) {
    return "auth";
  }
  if (
    lower.includes("unavailable") ||
    lower.includes("provider") ||
    lower.includes("quote") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return "provider";
  }
  if (
    lower.includes("invalid") ||
    lower.includes("required") ||
    lower.includes("validation")
  ) {
    return "validation";
  }
  return "unknown";
}

export interface ScreenRunLogEvent {
  event: "screen.started" | "screen.completed" | "screen.failed";
  trigger: string;
  universe: string;
  userLogin?: string;
  traceId: string;
  success?: boolean;
  matchedCount?: number;
  durationMs?: number;
  classification?: ScreenFailureClassification;
  error?: string;
}

/**
 * One structured JSON log line per run event, carrying the
 * standards fields (docs/architecture/standards/standards.md):
 * trace_id, actor_id (the run's user login), agent_id.
 * tenant_id rides when the caller knows it (runScreen does
 * not — the workflow tenant is resolved at the workflow
 * layer, not inside the agent — so it is omitted, never
 * invented). Logging never throws: a logging failure must
 * not fail a screen.
 */
export function logScreenRunEvent(input: {
  event: ScreenRunLogEvent["event"];
  trigger: string;
  universe: string;
  userLogin?: string;
  traceId: string;
  success?: boolean;
  matchedCount?: number;
  durationMs?: number;
  classification?: ScreenFailureClassification;
  error?: string;
}): void {
  try {
    const line: Record<string, unknown> = {
      trace_id: input.traceId,
      agent_id: "screener-agent",
      event: input.event,
      trigger: input.trigger,
      universe: input.universe,
    };
    if (input.userLogin) line.actor_id = input.userLogin;
    if (input.success !== undefined) line.success = input.success;
    if (input.matchedCount !== undefined) line.matched_count = input.matchedCount;
    if (input.durationMs !== undefined) line.duration_ms = input.durationMs;
    if (input.classification) line.classification = input.classification;
    if (input.error) line.error = input.error;
    // Issue #2860 (Factor 14): the same event folds into the
    // screen-run metrics accumulator at this one join point, so
    // every funnel emission (runScreen + chain submission) is
    // aggregated exactly once. Inside the logging try: a fold
    // failure must not fail a screen, and logging still emits.
    ingestScreenRunEvent({
      event: input.event,
      trigger: input.trigger,
      universe: input.universe,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.classification ? { classification: input.classification } : {}),
    });
    console.log(JSON.stringify(line));
  } catch {
    // Logging never fails a screen.
  }
}
