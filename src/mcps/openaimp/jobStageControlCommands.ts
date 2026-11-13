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
import { controlPipelineStageViaDoor } from "../../agents/orchestrator/meshDoors";

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
