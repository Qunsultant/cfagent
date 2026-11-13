/**
 * Issue #4363 ([Stage visibility] execution-mode control) — the MCP surface
 * for a job's execution mode.
 *
 * `set_job_execution_mode` sets the mode a job's NEXT run uses. The mode is
 * fixed at start, so a live run refuses by name with the next-run-only rule;
 * an idle/terminal job takes the new mode as a new definition version. The
 * mode axes are the engine's own (`concurrency`, `pacing`, `delivery`,
 * `shape`), validated by the engine's resolver — `online + sync` is refused
 * there, never downgraded here.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { setPipelineJobExecutionModeViaDoor } from "../../agents/orchestrator/meshDoors";

export interface SetJobExecutionModeInput {
  jobId: string;
  executionMode: {
    concurrency?: "sequential" | "parallel";
    pacing?: "batch" | "online";
    delivery?: "sync" | "async";
    shape?: "monolith" | "sharded";
  };
}

export class SetJobExecutionModeCommand
  implements IMcpToolCommand<SetJobExecutionModeInput>
{
  readonly name = "set_job_execution_mode";
  readonly description =
    "Set a workflow job's execution mode for its NEXT run: concurrency (sequential|parallel), pacing (batch|online), delivery (sync|async), shape (monolith|sharded). A live run refuses with the next-run-only rule — the mode is fixed at start; online+sync is refused. Requires the turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      jobId: { type: "string", description: "The workflow job id" },
      executionMode: {
        type: "object",
        description: "The axes to set; omitted axes keep the family default",
        properties: {
          concurrency: { type: "string", enum: ["sequential", "parallel"] },
          pacing: { type: "string", enum: ["batch", "online"] },
          delivery: { type: "string", enum: ["sync", "async"] },
          shape: { type: "string", enum: ["monolith", "sharded"] },
        },
      },
    },
    required: ["jobId", "executionMode"],
  };
  readonly zodSchema = z.object({
    jobId: z.string().min(1),
    executionMode: z.object({
      concurrency: z.enum(["sequential", "parallel"]).optional(),
      pacing: z.enum(["batch", "online"]).optional(),
      delivery: z.enum(["sync", "async"]).optional(),
      shape: z.enum(["monolith", "sharded"]).optional(),
    }),
  });

  async execute(input: SetJobExecutionModeInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await setPipelineJobExecutionModeViaDoor(
      context.env,
      actingLogin,
      input.jobId,
      input.executionMode,
    );
    context.audit("set_job_execution_mode", "mcp", {
      actingLogin: actingLogin ?? null,
      jobId: result.jobId,
      executionMode: result.executionMode,
      appliedTo: result.appliedTo,
    });
    return result;
  }
}
