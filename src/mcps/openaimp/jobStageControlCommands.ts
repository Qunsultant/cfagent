/**
 * Issue #4362 ([Stage visibility] stock stage control surface) — the MCP
 * mirror of the per-stage control the engine already implements.
 *
 * `stock_copilot_stage_control` drives ONE stage of one stock (engine) run:
 * run / rerun / stop / resume / cancel, addressed by the same stage
 * vocabulary the status read uses (stage id `job:root`, stage kind `feed`,
 * or node path). The engine's control plane does the work; this tool is the
 * surface, not a second control plane.
 *
 * Gates: the chat turn's acting identity is required (the same operator
 * gate `options_copilot_stage_control` uses). An unknown job or stage
 * refuses by name with the stages that exist; a terminal stage refuses
 * with its current state — never a silent no-op.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  controlPipelineJobViaDoor,
  controlPipelineStageViaDoor,
  PIPELINE_JOB_OPERATIONS,
  type PipelineJobOperation,
} from "../../agents/orchestrator/meshDoors";

export const STOCK_STAGE_OPERATIONS = ["run", "rerun", "stop", "resume", "cancel"] as const;
export type StockStageOperation = (typeof STOCK_STAGE_OPERATIONS)[number];

export interface StockStageControlInput {
  jobId: string;
  stage: string;
  operation: StockStageOperation;
}

export class StockCopilotStageControlCommand
  implements IMcpToolCommand<StockStageControlInput>
{
  readonly name = "stock_copilot_stage_control";
  readonly description =
    "Drive one stage of one stock (workflow-engine) run from chat: run, re-run, stop, resume or cancel a stage by (jobId, stage). The stage is addressed by its stage id (job:root), its kind (feed, enrich, analyze, store, serve, deliver) or its node path. An unknown job or stage refuses with the stages that exist; a terminal stage refuses with its current state. Requires the chat turn's acting identity. Research and delivery only — places no orders.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      jobId: { type: "string", description: "The stock run's engine job id" },
      stage: {
        type: "string",
        description: "The stage address: stage id (job:root), stage kind (feed), or node path",
      },
      operation: {
        type: "string",
        enum: [...STOCK_STAGE_OPERATIONS],
        description: "The stage operation, with the pinned engine meanings",
      },
    },
    required: ["jobId", "stage", "operation"],
  };
  readonly zodSchema = z.object({
    jobId: z.string().min(1),
    stage: z.string().min(1),
    operation: z.enum(STOCK_STAGE_OPERATIONS),
  });

  async execute(input: StockStageControlInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await controlPipelineStageViaDoor(
      context.env,
      actingLogin,
      input.jobId,
      input.stage,
      input.operation,
    );
    context.audit("stock_copilot_stage_control", "mcp", {
      actingLogin: actingLogin ?? null,
      jobId: result.jobId,
      stageId: result.stageId,
      operation: result.operation,
      state: result.state,
    });
    return result;
  }
}

export type StockJobControlInput = {
  jobId: string;
  operation: PipelineJobOperation;
};

/**
 * Issue #5739 — the whole-job counterpart of the stage tool above. The
 * five operations ARE the engine's own verbs (`runJob` / `pauseJob` /
 * `resumeJob` / `cancelJob` / `retryJob`); this class is the MCP surface,
 * never a second control plane. The operation list is imported from the
 * door so the JSON schema, the zod schema and the dispatch cannot drift.
 */
export class StockCopilotJobControlCommand
  implements IMcpToolCommand<StockJobControlInput>
{
  readonly name = "stock_copilot_job_control";
  readonly description =
    "Control one WHOLE stock (workflow-engine) job from chat: start, pause, resume, cancel or retry it by jobId. Meanings are the engine's pinned ones: start dispatches a run now; pause is cooperative (honored at the next step boundary, the run stays resumable and is never failed); resume continues from the persisted checkpoint; cancel is terminal (downstream stages never proceed); retry runs the last run again as a new run. Use stock_copilot_stage_control for a single stage of a run. An unknown job refuses by name, and a refused transition reports the engine's reason rather than a silent no-op. Requires the chat turn's acting identity. Research and delivery only — places no orders.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      jobId: { type: "string", description: "The engine job id to control" },
      operation: {
        type: "string",
        enum: [...PIPELINE_JOB_OPERATIONS],
        description: "start | pause | resume | cancel | retry",
      },
    },
    required: ["jobId", "operation"],
  };
  readonly zodSchema = z.object({
    jobId: z.string().min(1),
    operation: z.enum(PIPELINE_JOB_OPERATIONS),
  });

  async execute(input: StockJobControlInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await controlPipelineJobViaDoor(
      context.env,
      actingLogin,
      input.jobId,
      input.operation,
    );
    context.audit("stock_copilot_job_control", "mcp", {
      actingLogin: actingLogin ?? null,
      jobId: result.jobId,
      operation: result.operation,
      state: result.state,
      runId: result.runId,
    });
    return result;
  }
}
