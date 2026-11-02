/**
 * Phase 5 Slice 7 (issue #2000) — the five-item alerting list.
 *
 * One coherent inventory over the machinery slices 1, 2, and 6
 * established — DLQ depth, breaker trips, stuck rows — plus the
 * two signals built in-slice: monolithic serve-stage failures
 * and gather misses. Every item delivers through the existing
 * postSlackText channel; no second channel, no second claim
 * mechanism. Each item's claim is the mechanism its signal
 * already owns (see ALERTING_ITEMS).
 *
 * Working defaults (NOT rulings), pinned by tests:
 * - Serve-stage failure = a followup.report job (the serve
 *   stage) reaching terminal `failed` WITHOUT chain identity.
 *   Chained serve failures never alert (visible in the stage
 *   feed + retryable per stage via retryAsyncJob); a retry's
 *   own failure never re-alerts (the incident was alerted on
 *   the original failure). The failure STATE is still recorded
 *   for retries — only the page is suppressed.
 * - Gather miss (event) = a gather run with missingSymbols > 0
 *   (any symbol requested but not stored, per the #2056 rule:
 *   live alone supplies rows, Yahoo-only never stores).
 * - Gather-miss alert = TOTAL miss only: requested > 0 and
 *   stored === 0. A partial miss is event-visible, not paged.
 * - Non-misses: a legitimately empty universe (requested 0)
 *   emits no event and no alert; a Yahoo-column-only gap
 *   (live rows exist, Yahoo complemented columns) is success.
 * - Alert copy carries ids + counts + a runbook link only.
 *   Error messages, symbol lists, and identities never ride
 *   an alert (the #1743 redaction rule, applied to Slack).
 */

export interface AlertingItem {
  id: "dlq-depth" | "breaker-trip" | "stuck-row" | "serve-stage-failure" | "gather-miss";
  /** What fires it. */
  signal: string;
  /** Runbook section linked from the alert text. */
  runbook: string;
  /** The one delivery channel for every item. */
  delivery: "postSlackText";
  /** The claim that makes one incident alert once. */
  claim: string;
}

export const ALERTING_ITEMS: AlertingItem[] = [
  {
    id: "dlq-depth",
    signal: "Un-replayed dead-letter rows at or above DLQ_DEPTH_ALERT_THRESHOLD (Slice 1, maybeAlertDlqDepth).",
    runbook: "docs/operations/runbook/dlq-replay.md",
    delivery: "postSlackText",
    claim: "Depth-incident claim in the dead-letter store (claim-first; clears when depth drops below threshold).",
  },
  {
    id: "breaker-trip",
    signal: "breaker.state_changed envelope with to=open (Slice 2, createBreakerTripSubscriber).",
    runbook: "docs/operations/runbook/alerting.md#breaker-trips",
    delivery: "postSlackText",
    claim: "Envelope-id claim (provider:to:seq, the idempotency key); a re-delivery claims nothing.",
  },
  {
    id: "stuck-row",
    signal: "mas_async_jobs row in running older than STUCK_RUN_ALERT_THRESHOLD_MINUTES (Slice 6 / #2567, maybeAlertStuckRunning).",
    runbook: "docs/operations/runbook/stuck-runs.md",
    delivery: "postSlackText",
    claim: "Guarded markStuckAlerted stamp on the job row (claim-first; the 2h reap is the backstop).",
  },
  {
    id: "serve-stage-failure",
    signal: "followup.report job (the serve stage) terminal-failed with no chain identity (this slice, maybeAlertServeFailure).",
    runbook: "docs/operations/runbook/alerting.md#serve-stage-failures",
    delivery: "postSlackText",
    claim: "Structural: a job fails through the executor catch at most once, and a retry's failure (retryOf set) never re-alerts.",
  },
  {
    id: "gather-miss",
    signal: "Goal gather with stored === 0 and requested > 0 (this slice; partial misses emit the event only).",
    runbook: "docs/operations/runbook/alerting.md#gather-misses",
    delivery: "postSlackText",
    claim: "One enrich call per runId per run (runId is the gather's idempotency key); a manual re-enrich with the same runId would re-alert (documented limitation).",
  },
];

/** A failed async job, as the executor catch sees it. */
export interface ServeFailureJob {
  jobId: string;
  capability: string;
  stage: string | null;
  chainId: string | null;
  retryOf: string | null;
  userLogin: string;
  error: string;
}

function isMonolithicServe(job: ServeFailureJob): boolean {
  return job.capability === "followup.report" && !job.stage && !job.chainId;
}

/**
 * Whether this failure pages the operator. Chained serve
 * failures are owned by the stage feed + per-stage retry; a
 * retry's own failure is owned by the original incident.
 */
export function shouldAlertServeFailure(job: ServeFailureJob): boolean {
  if (!isMonolithicServe(job)) return false;
  if (job.retryOf) return false;
  return true;
}

export function serveStageFailureText(job: ServeFailureJob): string {
  return [
    `🚨 Serve-stage failure: report job ${job.jobId} failed with no chain to resume from — the run's report was not generated.`,
    `Owner: ${job.userLogin} · Job: ${job.jobId}`,
    "Diagnosis + safe intervention: docs/operations/runbook/alerting.md#serve-stage-failures",
  ].join("\n");
}

export interface ServeFailureDeps {
  recordTransition: (t: {
    userLogin: string;
    stage: "serve";
    jobId: string;
    status: "failed";
    reason: string;
  }) => void;
  audit: (type: string, agent: string, payload: Record<string, unknown>) => void;
  postText: (text: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Record a monolithic serve failure as a first-class failure
 * state (stage transition + audit, like the chained path) and,
 * for a first failure only, page the operator. Never throws:
 * a delivery failure is audited, never surfaced — the job is
 * already terminal, and alerting must not fail it twice.
 */
export async function maybeAlertServeFailure(
  job: ServeFailureJob,
  deps: ServeFailureDeps,
): Promise<{ recorded: boolean; alerted: boolean }> {
  if (!isMonolithicServe(job)) return { recorded: false, alerted: false };
  deps.recordTransition({
    userLogin: job.userLogin,
    stage: "serve",
    jobId: job.jobId,
    status: "failed",
    reason: job.error,
  });
  deps.audit("async_job.serve_failed", "orchestrator", {
    jobId: job.jobId,
    capability: job.capability,
    ownerLogin: job.userLogin,
  });
  if (!shouldAlertServeFailure(job)) return { recorded: true, alerted: false };
  let result: { ok: boolean; error?: string };
  try {
    result = await deps.postText(serveStageFailureText(job));
  } catch (err) {
    deps.audit("async_job.serve_alert_failed", "orchestrator", {
      jobId: job.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { recorded: true, alerted: false };
  }
  deps.audit(
    result.ok ? "async_job.serve_alert" : "async_job.serve_alert_failed",
    "orchestrator",
    {
      jobId: job.jobId,
      ...(result.ok ? {} : { error: result.error ?? "post failed" }),
    },
  );
  return { recorded: true, alerted: result.ok };
}

/** Gather counts for one run (requested = universe size). */
export interface GatherCounts {
  requested: number;
  stored: number;
  missing: number;
}

/** Any requested-but-unstored symbol is a miss event. */
export function isGatherMiss(counts: GatherCounts): boolean {
  return counts.missing > 0;
}

/** Only a total miss pages: the run's dataset is empty. */
export function shouldAlertGatherMiss(counts: GatherCounts): boolean {
  return counts.requested > 0 && counts.stored === 0;
}

export function gatherMissText(input: GatherCounts & { runId: string }): string {
  return [
    `🚨 Gather miss: goal run ${input.runId} stored 0 of ${input.requested} requested symbols — the run has no dataset to evaluate.`,
    `Run: ${input.runId} · Requested: ${input.requested} · Stored: ${input.stored} · Missing: ${input.missing}`,
    "Diagnosis + safe intervention: docs/operations/runbook/alerting.md#gather-misses",
  ].join("\n");
}
