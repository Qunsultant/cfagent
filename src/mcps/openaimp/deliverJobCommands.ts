/**
 * Issue #3539 (Pipeline J6) — the deliver-job copilot commands:
 * the General Copilot tools (and, through the one catalog, the
 * Stock Copilot surface) for the pipeline's deliver jobs — the
 * generateJobCommands.ts pattern transposed, one stage later.
 *
 * Each command is a thin dispatch over the ScheduledAgent door
 * (src/agents/orchestrator/meshDoors.ts) — the pipeline's host
 * owns the control plane (#3543), and these tools are invoking
 * surfaces over it, never a second engine entry. A deliver run
 * consumes the generate job's PERSISTED generated dataset
 * (never a live fetch or a re-render), delivers each persisted
 * report to the configured channels, and records every
 * delivery per channel — a channel that already delivered the
 * same report is never re-delivered, so a resume re-delivers
 * only what did not complete; the status returned is the same
 * merged view the UX renders.
 *
 * Identity follows the mesh rules: the tools take NO login
 * input — identity rides the turn context (context.actingLogin),
 * and the door refuses before dispatch when none is supplied.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  getDeliverJobStatusViaDoor,
  listDeliverJobsViaDoor,
  manageDeliverJobViaDoor,
  runDeliverJobViaDoor,
  type DeliverJobManagementAction,
} from "../../agents/orchestrator/meshDoors";

const SOURCE_PROPERTY = {
  type: "string",
  description:
    "The deliver job's source or name: a qualified source + universe (\"yahoo nasdaq100 deliver\", \"sp100 deliver\"), \"deliver\" plus a single-job source (\"deliver alpaca\", \"deliver etrade\", \"deliver public\"), or an exact deliver job id (e.g. yahoo-nasdaq100-quotes-enrich-analyze-generate-deliver).",
} as const;

export class RunDeliverJobCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "run_deliver_job";
  readonly description =
    "Run a data-provider deliver job now through the job pipeline (the ScheduledAgent host's control plane) and return its settled outcome plus its status. The run reads the generate job's persisted generated dataset (it never fetches live and never re-renders), delivers each persisted report to the configured channels (Slack, email, webhook, and the UX surfaces), and records every delivery with its outcome per channel: a failed channel retries independently, a channel a deployment does not configure records not_configured with its reason — never a fake delivered state — and a (report, channel) pair an earlier run over the same generated copy already delivered is recorded already_delivered without sending again, so a resume re-delivers only what did not complete. Examples: source \"yahoo nasdaq100 deliver\" delivers the Yahoo Nasdaq-100 generated copy; \"sp100 deliver\", \"deliver alpaca\", \"deliver etrade\", \"deliver public\" run those copies' deliver jobs. A run with no persisted generated copy is refused by name (DELIVER_INPUT_MISSING). Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Deliver job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await runDeliverJobViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      runId: result.runId,
      state: result.state,
    });
    return result;
  }
}

export class GetDeliverJobStatusCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "get_deliver_job_status";
  readonly description =
    "Report one deliver job's status: the pipeline state, the last run's outcome, channel pairs delivered in the delivery copy, data freshness (age + stale label), the lineage of the delivery copy (which generate run it derives from), each report's per-channel delivery outcomes (delivered / failed / not_configured / already_delivered), recent run history, and the next scheduled run. A deliver job that has never run reports the honest never-run state. This is the same status the Data Providers UX surface renders. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Deliver job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await getDeliverJobStatusViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      state: result.deliver?.state ?? result.pipeline?.state ?? "unknown",
    });
    return result;
  }
}

export class ListDeliverJobsCommand implements IMcpToolCommand<{}> {
  readonly name = "list_deliver_jobs";
  readonly description =
    "List every deliver job (Yahoo Nasdaq-100, Yahoo S&P 100, Alpaca, E*TRADE, Public) with its merged status: pipeline state, last run, channel pairs delivered in the delivery copy, freshness, lineage, per-channel outcomes, and next scheduled run. Requires the chat turn's acting identity.";
  readonly jsonSchema = { type: "object" as const, properties: {} };
  readonly zodSchema = z.object({});

  async execute(_input: {}, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await listDeliverJobsViaDoor(context.env, actingLogin);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      count: result.jobs.length,
    });
    return result;
  }
}

export class ManageDeliverJobCommand
  implements IMcpToolCommand<{ source: string; action: DeliverJobManagementAction }>
{
  readonly name = "manage_deliver_job";
  readonly description =
    "Apply one management operation to a deliver job through the pipeline control plane: pause (stop at the next step boundary, resumable), resume (continue from the persisted checkpoint — a resumed deliver run re-delivers only the channels that did not complete), cancel (terminal), or retry (re-run the last run as a new run). The control plane's own refusals (for example, pausing a job that is not running) are returned as errors, never as success. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      source: SOURCE_PROPERTY,
      action: {
        type: "string",
        enum: ["pause", "resume", "cancel", "retry"],
        description: "The management operation to apply.",
      },
    },
    required: ["source", "action"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Deliver job source or name"),
    action: z
      .enum(["pause", "resume", "cancel", "retry"])
      .describe("The management operation"),
  });

  async execute(
    input: { source: string; action: DeliverJobManagementAction },
    context: McpToolContext,
  ) {
    const actingLogin = context.actingLogin?.();
    const result = await manageDeliverJobViaDoor(
      context.env,
      actingLogin,
      input.source,
      input.action,
    );
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      action: result.action,
      state: result.instance?.state ?? result.run?.state ?? "unknown",
    });
    return result;
  }
}
