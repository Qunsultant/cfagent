/**
 * Issue #4361 ([Stage visibility] chat stage read) — the two job-status
 * endpoints.
 *
 *   GET /api/jobs/:jobId/status              whole job + per-sub-job roll-up
 *   GET /api/jobs/:jobId/stages/:stageId     one sub-job (stageId, kind or node path)
 *
 * Both read the engine's own status view through `ctx.readJobStatus`
 * (production: the ScheduledAgent door; tests: a fake) — one stage
 * source, no second read mechanism. An unknown job refuses by name with
 * a 404; an unknown or ambiguous stage refuses with the stages that do
 * exist, never a silent null.
 */
import type { JobStatusView } from "../../services/jobPipelineEngine";
import {
  buildJobStatusReport,
  resolveSubJob,
  type JobStatusReport,
} from "../../services/jobStageStatus";

export type JobStageOperation = "run" | "rerun" | "stop" | "resume" | "cancel";

export interface JobStageControlResult {
  jobId: string;
  stageId: string;
  nodePath: string;
  operation: string;
  state: string;
  runId: string | null;
}

/** Issue #4467 — a replayed run: the original it came from and the new run. */
export interface JobRunReplayResult {
  jobId: string;
  /** The run whose definition version and trigger were replayed. */
  replayedRunId: string;
  /** The new run id the replay minted (never the original's). */
  runId: string;
  state: string;
  /** Issue #6400 — the stage address a stage replay narrowed to, when it did. */
  stage?: string;
}

export interface JobStatusRouteContext {
  /** The engine's status view for one job id, or null when no such job exists. */
  readJobStatus: (jobId: string) => Promise<JobStatusView | null>;
  /**
   * Issue #4362 — drive one stage of one run. Required for the POST
   * route; absent means the surface refuses by name rather than
   * pretending a control happened.
   */
  controlJobStage?: (
    jobId: string,
    stage: string,
    operation: JobStageOperation,
  ) => Promise<JobStageControlResult>;
  /**
   * Issue #4467 — replay a past run as a NEW run of its recorded
   * definition version. Required for the POST route; absent means the
   * surface refuses by name rather than pretending a replay happened.
   * Issue #6400 — `stage` narrows it to ONE stage of that run (a stage id
   * or node path), the same op, never a second route.
   */
  replayJobRun?: (
    jobId: string,
    runId: string,
    stage?: string,
  ) => Promise<JobRunReplayResult>;
}

const STATUS_PATH = /(?:^|\/api)\/jobs\/([^/]+)\/status$/;
const STAGE_PATH = /(?:^|\/api)\/jobs\/([^/]+)\/stages\/([^/]+)$/;
const CONTROL_PATH = /(?:^|\/api)\/jobs\/([^/]+)\/stages\/([^/]+)\/(run|rerun|stop|resume|cancel)$/;
/**
 * Issue #4467 — replay one past run as a new run. Issue #6400 — the same
 * route carries `?stage=<stage id|node path>` for one stage of that run.
 */
const REPLAY_PATH = /(?:^|\/api)\/jobs\/([^/]+)\/runs\/([^/]+)\/replay$/;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Serialize the report exactly as both surfaces return it. */
export function jobStatusPayload(report: JobStatusReport): Record<string, unknown> {
  return {
    jobId: report.jobId,
    status: report.status,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    durationMs: report.durationMs,
    runId: report.runId,
    executionMode: report.executionMode,
    subJobCount: report.subJobs.length,
    subJobs: report.subJobs,
  };
}

export async function handleJobStatusRoutes(
  request: Request,
  url: URL,
  path: string,
  ctx: JobStatusRouteContext,
): Promise<Response | null> {
  const replayMatch = request.method === "POST" ? REPLAY_PATH.exec(path) : null;
  if (replayMatch) {
    const jobId = decode(replayMatch[1]);
    const runId = decode(replayMatch[2]);
    if (!ctx.replayJobRun) {
      return Response.json(
        {
          error: `Replay for job "${jobId}" is unavailable: this surface has no control door configured.`,
        },
        { status: 503 },
      );
    }
    try {
      // Issue #6400 — one stage of this run, or the run whole.
      const stage = url.searchParams.get("stage") ?? undefined;
      return Response.json(await ctx.replayJobRun(jobId, runId, stage));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The refusals are the contract: an unknown run or job is 404; a
      // run whose configuration was not retained, or one that cannot be
      // replayed right now, is a 409; anything else is unavailable.
      const status = /job_run_not_found|No job with id|not found/i.test(message)
        ? 404
        : /replay_pre_retention_run|replay_definition_version_unresolved|replay_stage_composite|not one stage|already_running|already/i.test(
              message,
            )
          ? 409
          : 503;
      return Response.json({ error: message, jobId, runId }, { status });
    }
  }
  const controlMatch = request.method === "POST" ? CONTROL_PATH.exec(path) : null;
  if (controlMatch) {
    const jobId = decode(controlMatch[1]);
    if (!ctx.controlJobStage) {
      return Response.json(
        {
          error: `Stage control for job "${jobId}" is unavailable: this surface has no control door configured.`,
        },
        { status: 503 },
      );
    }
    try {
      const result = await ctx.controlJobStage(
        jobId,
        decode(controlMatch[2]),
        controlMatch[3] as JobStageOperation,
      );
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Issue #5278 — the resume refusals are state conflicts (the run
      // cannot continue under its own definition version), not an
      // unavailable surface: 409, alongside the existing not_* guards.
      const status =
        /not found|unknown|not part of|ambiguous|already|not_runnable|not_stoppable|not_resumable|pre_retention|version_unresolved/i.test(
          message,
        )
          ? 409
          : 503;
      return Response.json({ error: message, jobId }, { status });
    }
  }
  if (request.method !== "GET") return null;
  const stageMatch = STAGE_PATH.exec(path);
  const statusMatch = stageMatch ? null : STATUS_PATH.exec(path);
  if (!stageMatch && !statusMatch) return null;

  const jobId = decode((stageMatch ?? statusMatch)![1]);
  let view: JobStatusView | null;
  try {
    view = await ctx.readJobStatus(jobId);
  } catch (error) {
    return Response.json(
      {
        error: `Job status for "${jobId}" is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 503 },
    );
  }
  if (!view) {
    return Response.json(
      { error: `No job with id "${jobId}" exists on the workflow engine.` },
      { status: 404 },
    );
  }
  const report = buildJobStatusReport(jobId, view);
  if (!stageMatch) return Response.json(jobStatusPayload(report));

  const resolved = resolveSubJob(report, decode(stageMatch[2]));
  if (!resolved.ok) {
    return Response.json({ error: resolved.reason, jobId }, { status: 404 });
  }
  return Response.json({ jobId, ...resolved.subJob });
}
