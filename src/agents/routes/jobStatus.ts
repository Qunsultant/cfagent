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
}

const STATUS_PATH = /(?:^|\/api)\/jobs\/([^/]+)\/status$/;
const STAGE_PATH = /(?:^|\/api)\/jobs\/([^/]+)\/stages\/([^/]+)$/;
const CONTROL_PATH = /(?:^|\/api)\/jobs\/([^/]+)\/stages\/([^/]+)\/(run|rerun|stop|resume|cancel)$/;

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
      const status = /not found|unknown|not part of|ambiguous|already|not_runnable|not_stoppable|not_resumable/i.test(
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
