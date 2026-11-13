/**
 * Issue #4361 ([Stage visibility] chat stage read) — the MCP mirror of the
 * two job-status endpoints.
 *
 *   get_job_status        whole job + per-sub-job roll-up (start/end/duration)
 *   get_job_stage_status  one sub-job by job id + stage address, with its units
 *
 * Both read the engine's own status view through the ScheduledAgent door —
 * the same source the REST endpoints serve, so chat and the runs page cannot
 * disagree about a stage. `get_async_job` is deliberately untouched: its
 * record shape carries no stages and cannot.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { getPipelineJobStatusViaDoor } from "../../agents/orchestrator/meshDoors";
import {
  buildJobStatusReport,
  resolveSubJob,
  type JobStatusReport,
} from "../../services/jobStageStatus";
import { jobStatusPayload } from "../../agents/routes/jobStatus";

async function readReport(context: McpToolContext, jobId: string): Promise<JobStatusReport> {
  const view = await getPipelineJobStatusViaDoor(context.env, jobId);
  if (!view) {
    throw new Error(`No job with id "${jobId}" exists on the workflow engine.`);
  }
  return buildJobStatusReport(jobId, view);
}

export class GetJobStatusCommand implements IMcpToolCommand<{ jobId: string }> {
  readonly name = "get_job_status";
  readonly description =
    "Get a workflow job's status and its per-stage (sub-job) status, each with start, end and duration — live while the job runs.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      jobId: { type: "string", description: "The job id (for a chat screen: the job id the run reported)" },
    },
    required: ["jobId"],
  };
  readonly zodSchema = z.object({ jobId: z.string().min(1) });

  async execute(input: { jobId: string }, context: McpToolContext) {
    const report = await readReport(context, input.jobId);
    return jobStatusPayload(report);
  }
}

export class GetJobStageStatusCommand
  implements IMcpToolCommand<{ jobId: string; stageId: string }>
{
  readonly name = "get_job_stage_status";
  readonly description =
    "Get one stage (sub-job) of a workflow job by job id and stage address — its status, start, end, duration and units.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      jobId: { type: "string", description: "The job id the stage belongs to" },
      stageId: {
        type: "string",
        description: "The stage address: the stage id (job:root), the stage kind (feed), or the node path",
      },
    },
    required: ["jobId", "stageId"],
  };
  readonly zodSchema = z.object({ jobId: z.string().min(1), stageId: z.string().min(1) });

  async execute(input: { jobId: string; stageId: string }, context: McpToolContext) {
    const report = await readReport(context, input.jobId);
    const resolved = resolveSubJob(report, input.stageId);
    if (!resolved.ok) throw new Error(resolved.reason);
    return { jobId: report.jobId, ...resolved.subJob };
  }
}
