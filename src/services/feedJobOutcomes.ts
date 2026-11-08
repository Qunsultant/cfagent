/**
 * Issue #3530 slice B — feed runs in the Autopilot job-outcome feed.
 *
 * A feed run settles on the ScheduledAgent host's pipeline engine;
 * its outcome belongs in the ONE job-outcome sink
 * (mas_job_outcomes) the Autopilot Control Center reads — the sink
 * the #3527 S5 corpus/reports riders and the async-jobs bridge
 * already write through `recordJobOutcome`. This module is the
 * projection + observer half of that write:
 *
 * - The engine reports each terminally settled run exactly once
 *   (from recordTerminal, its one terminal-recording point) to a
 *   settle observer. Runs that never dispatched — guard-skipped
 *   ticks, disabled jobs — never reach it, so they write NO row:
 *   a row exists only for a run that actually settled.
 * - The observer keeps only feed-catalog jobs, reads the settled
 *   run's OWN feed record back (matched by run id) for its status
 *   and counts, and projects keys + outcome codes only — never
 *   content, never artifact payloads.
 * - Status projection is honest: the feed record's
 *   completed/partial/failed stands as recorded (a partial pull
 *   renders partial, never success); an engine-level failure with
 *   no feed record (the step refused before any pull — e.g. an
 *   unattended firing refused as FEED_JOB_NOT_CONFIGURED) renders
 *   failed with that typed code; a cancelled run renders failed
 *   with the engine's own job_cancelled code, because the sink's
 *   vocabulary has no cancelled status and a cancelled run is
 *   neither a success nor nothing.
 * - The record seam is injected: the host wires it to the mesh
 *   door into the shared Orchestrator instance (the store the
 *   Autopilot route reads — the residency decision is recorded in
 *   the slice's DESIGN.md). The write is best-effort-but-honest:
 *   any failure is logged here with the run's ids, never thrown,
 *   and never fails the feed run itself.
 */
import { FEED_PIPELINE_CATALOG } from "./feedPipelineJobs";
import { FEED_JOB_RUN_FAILED } from "./feedJobs";
import type { FeedDatasetRunRecord } from "../data/feedDatasetPorts";
import type { JobOutcomeInput } from "../data/jobOutcomePorts";
import type { JobRunSettledInfo } from "./jobPipelineEngine";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/feedJobOutcomes",
});

/** The origin label feed rows carry in the outcome sink. */
export const FEED_JOB_OUTCOME_ORIGIN = "feed-pipeline";

/** The coded error a cancelled feed run renders under (the engine's own run-record detail vocabulary). */
export const FEED_JOB_CANCELLED_CODE = "job_cancelled";

/** Extract the run's stable outcome code from a settle error, or null.
 *  The engine wraps step errors before they reach the settle point
 *  ("Step "feed.pull" … failed: CODE: message", or its unit wrap
 *  "… last error code: CODE: …"), so the code is recovered from the
 *  first `<CODE>:` token — the codebase's coded-error prefix
 *  convention — never from prose: a token must be ALL-CAPS with an
 *  underscore and be immediately followed by a colon. A bare
 *  leading "CODE: message" or "[CODE] message" matches the same
 *  rule. Anything else is codeless and falls back. */
function leadingCodeOf(error: string | undefined): string | null {
  if (!error) return null;
  const trimmed = error.trim();
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed)) return trimmed;
  const token = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+):/.exec(trimmed);
  return token ? token[1] : null;
}

/**
 * Project one settled feed run into its outcome-sink row. When the
 * run's own feed record is supplied it governs status, counts, and
 * coded error; without one, the settle state stands alone (counts
 * unknown are omitted, never invented).
 */
export function buildFeedJobOutcomeInput(
  settle: JobRunSettledInfo,
  feedRun: FeedDatasetRunRecord | null,
): JobOutcomeInput {
  const base = {
    id: settle.runId,
    kind: "feed" as const,
    trigger: settle.trigger,
    origin: FEED_JOB_OUTCOME_ORIGIN,
  };
  if (settle.state === "cancelled") {
    return { ...base, status: "failed", codedError: FEED_JOB_CANCELLED_CODE };
  }
  if (feedRun) {
    return {
      ...base,
      status: feedRun.status,
      scanned: feedRun.requested,
      matched: feedRun.received,
      ...(feedRun.codedError ? { codedError: feedRun.codedError } : {}),
    };
  }
  if (settle.state === "completed") {
    return { ...base, status: "completed" };
  }
  return {
    ...base,
    status: "failed",
    codedError: leadingCodeOf(settle.error) ?? FEED_JOB_RUN_FAILED,
  };
}

export interface FeedRunSettledObserverDeps {
  /** The record seam: one outcome row into the sink of record. */
  record: (input: JobOutcomeInput) => void | Promise<void>;
  /**
   * Read the settled run's own feed record (matched by run id), or
   * null when the run produced none / it cannot be read.
   */
  readFeedRun: (
    jobId: string,
    runId: string,
  ) => Promise<FeedDatasetRunRecord | null>;
}

/**
 * Build the pipeline host's settle observer: feed-catalog settles
 * become outcome rows; every other job's settle is ignored. The
 * observer never throws — a failed projection is logged with the
 * run's ids and the run stands on its own records.
 */
export function createFeedRunSettledObserver(
  deps: FeedRunSettledObserverDeps,
): (info: JobRunSettledInfo) => Promise<void> {
  return async (info) => {
    if (!FEED_PIPELINE_CATALOG.some((entry) => entry.jobId === info.jobId)) {
      return;
    }
    try {
      const feedRun = await deps
        .readFeedRun(info.jobId, info.runId)
        .catch(() => null);
      await deps.record(buildFeedJobOutcomeInput(info, feedRun));
    } catch (err) {
      structuredLog.warn("feed_job_outcome_record_failed", {
        message:
          "Feed job outcome record failed; the feed run stands on its own records (run record + dataset artifact).",
        jobId: info.jobId,
        runId: info.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
