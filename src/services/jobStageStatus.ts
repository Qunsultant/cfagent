/**
 * Issue #4361 ([Stage visibility] chat stage read) — the job-status
 * report behind the two REST endpoints and their MCP mirrors.
 *
 * One projection over the engine's own status view: the job's recorded
 * state and window, then one entry per stage (the job's sub-job) with
 * its status and recorded start/end/duration. The stage roll-up is the
 * chain surface's `aggregateStageStatus` — the same rule the Workflow
 * Runs projection uses, so the surfaces cannot disagree.
 *
 * Nothing here invents a value: a stamp the engine never recorded stays
 * null, and a stage with no units reads as not-run.
 */
import type { JobStatusView, JobStageView } from "./jobPipelineEngine";
import { aggregateStageStatus } from "./chainPipelineJobs";

/** One sub-job (stage) of a job, as the status endpoints return it. */
export interface JobSubJobStatus {
  /** The engine's stage id (`job:<nodePath>`) — the address endpoint (b) takes. */
  stageId: string;
  nodePath: string;
  /** The stage's kind from the job definition (feed, enrich, …), when known. */
  kind: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  units: number;
  completedUnits: number;
  error: string | null;
}

/** The whole-job status report: the job plus its sub-jobs. */
export interface JobStatusReport {
  jobId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  /** The engine run id the report describes (null when the job never ran). */
  runId: string | null;
  /** Issue #4363 — the execution mode the definition records (null when none). */
  executionMode: Record<string, string> | null;
  subJobs: JobSubJobStatus[];
}

const SUB_JOB_STATUS: Record<string, string> = {
  completed: "completed",
  failed: "failed",
  running: "running",
  stopped: "stopped",
  cancelled: "cancelled",
  pending: "pending",
  "not-run": "not-run",
};

/** One stage view as its sub-job entry. */
export function subJobStatusFromStageView(view: JobStageView): JobSubJobStatus {
  const aggregate = aggregateStageStatus([view]);
  return {
    stageId: view.stageId,
    nodePath: view.nodePath,
    kind: view.kind,
    status: SUB_JOB_STATUS[aggregate.status] ?? "pending",
    startedAt: view.startedAt,
    endedAt: view.endedAt,
    durationMs: view.durationMs,
    units: aggregate.units,
    completedUnits: aggregate.completedUnits,
    error: aggregate.error,
  };
}

/**
 * The job's own verb: the recorded run outcome wins; a live instance
 * supplies queued/running/paused; an idle instance with a last run reads
 * that run's outcome. Never guessed from the stages alone.
 */
function jobStatusFromView(view: JobStatusView): string {
  const outcome = view.latestRun?.outcome;
  if (outcome === "success") return "completed";
  if (outcome === "failure") return "failed";
  if (outcome === "skipped") return "cancelled";
  const state = view.instance?.state;
  if (state === "running" || state === "queued" || state === "paused") return state;
  if (state === "cancelled") return "cancelled";
  return "queued";
}

function durationBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

/** Build the whole-job report from the engine's status view. */
export function buildJobStatusReport(jobId: string, view: JobStatusView): JobStatusReport {
  const startedAt = view.instance?.runStartedAt ?? view.latestRun?.started ?? null;
  const endedAt = view.latestRun?.finished ?? null;
  return {
    jobId,
    status: jobStatusFromView(view),
    startedAt,
    endedAt,
    durationMs: durationBetween(startedAt, endedAt),
    runId:
      view.instance?.currentRunId ??
      view.instance?.stageCheckpoint?.runId ??
      view.latestRun?.workflowId ??
      null,
    executionMode: (view.definition.config.executionMode as unknown as Record<string, string> | undefined) ?? null,
    subJobs: view.stages.map(subJobStatusFromStageView),
  };
}

/**
 * Resolve one sub-job by the address a caller has: the stage id
 * (`job:<nodePath>`), the stage kind (`feed`), or the node path. A
 * value matching none is refused with the stages that do exist — never
 * a silent null.
 */
export function resolveSubJob(
  report: JobStatusReport,
  address: string,
): { ok: true; subJob: JobSubJobStatus } | { ok: false; reason: string } {
  const wanted = address.trim();
  if (!wanted) {
    return { ok: false, reason: "A stage id is required (for example \"job:root\" or \"feed\")." };
  }
  const exact = report.subJobs.find((sub) => sub.stageId === wanted);
  if (exact) return { ok: true, subJob: exact };
  const byKind = report.subJobs.filter((sub) => sub.kind === wanted);
  if (byKind.length === 1) return { ok: true, subJob: byKind[0] };
  const byPath = report.subJobs.filter((sub) => sub.nodePath === wanted);
  if (byPath.length === 1) return { ok: true, subJob: byPath[0] };
  if (byKind.length > 1 || byPath.length > 1) {
    return {
      ok: false,
      reason: `Stage address "${wanted}" is ambiguous: it matches ${report.subJobs
        .filter((sub) => sub.kind === wanted || sub.nodePath === wanted)
        .map((sub) => sub.stageId)
        .join(", ")}. Use the stage id.`,
    };
  }
  return {
    ok: false,
    reason: `Stage "${wanted}" is not part of job "${report.jobId}". Its stages are: ${
      report.subJobs.map((sub) => sub.stageId).join(", ") || "none recorded"
    }.`,
  };
}
