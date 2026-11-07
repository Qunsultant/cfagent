/**
 * Issue #3536 (Pipeline J3) — the enrich-job copilot commands:
 * the General Copilot tools (and, through the one catalog, the
 * Stock Copilot surface) for the pipeline's enrich jobs — the
 * feedJobCommands.ts pattern transposed, one stage later.
 *
 * Each command is a thin dispatch over the ScheduledAgent door
 * (src/agents/orchestrator/meshDoors.ts) — the pipeline's host
 * owns the control plane (#3543), and these tools are invoking
 * surfaces over it, never a second engine entry. An enrich run
 * consumes the feed job's PERSISTED dataset (never a live
 * fetch), computes the configured derived elements, and
 * persists the enriched dataset for the analyze stage; the
 * status returned is the same merged view the UX renders.
 *
 * Identity follows the mesh rules: the tools take NO login
 * input — identity rides the turn context (context.actingLogin),
 * and the door refuses before dispatch when none is supplied.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  getEnrichJobStatusViaDoor,
  listEnrichJobsViaDoor,
  manageEnrichJobViaDoor,
  runEnrichJobViaDoor,
  type EnrichJobManagementAction,
} from "../../agents/orchestrator/meshDoors";

const SOURCE_PROPERTY = {
  type: "string",
  description:
    "The enrich job's source or name: a qualified source + universe (\"yahoo nasdaq100 enrich\", \"sp100 enrich\"), \"enrich\" plus a single-job source (\"enrich alpaca\", \"enrich etrade\", \"enrich public\"), or an exact enrich job id (e.g. yahoo-nasdaq100-quotes-enrich).",
} as const;

export class RunEnrichJobCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "run_enrich_job";
  readonly description =
    "Run a data-provider enrich job now through the job pipeline (the ScheduledAgent host's control plane) and return its settled outcome plus its status. The run reads the feed job's persisted dataset copy (it never fetches live), computes the configured derived elements (snapshot indicators, screening scores, fundamentals joins, snapshot-series SMA/Bollinger), and persists the enriched dataset for the analyze stage. Examples: source \"yahoo nasdaq100 enrich\" enriches the Yahoo Nasdaq-100 quotes copy; \"sp100 enrich\", \"enrich alpaca\", \"enrich etrade\", \"enrich public\" run those copies' enrich jobs. A run with no persisted feed copy is refused by name (ENRICH_INPUT_MISSING). Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Enrich job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await runEnrichJobViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      runId: result.runId,
      state: result.state,
    });
    return result;
  }
}

export class GetEnrichJobStatusCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "get_enrich_job_status";
  readonly description =
    "Report one enrich job's status: the pipeline state, the last run's outcome, rows persisted in the enriched copy, data freshness (age + stale label), the lineage of the enriched copy (which feed run it derives from), recent run history, and the next scheduled run. An enrich job that has never run reports the honest never-run state. This is the same status the Data Providers UX surface renders. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Enrich job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await getEnrichJobStatusViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      state: result.enrich?.state ?? result.pipeline?.state ?? "unknown",
    });
    return result;
  }
}

export class ListEnrichJobsCommand implements IMcpToolCommand<{}> {
  readonly name = "list_enrich_jobs";
  readonly description =
    "List every enrich job (Yahoo Nasdaq-100, Yahoo S&P 100, Alpaca, E*TRADE, Public) with its merged status: pipeline state, last run, rows persisted in the enriched copy, freshness, lineage, and next scheduled run. Requires the chat turn's acting identity.";
  readonly jsonSchema = { type: "object" as const, properties: {} };
  readonly zodSchema = z.object({});

  async execute(_input: {}, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await listEnrichJobsViaDoor(context.env, actingLogin);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      count: result.jobs.length,
    });
    return result;
  }
}

export class ManageEnrichJobCommand
  implements IMcpToolCommand<{ source: string; action: EnrichJobManagementAction }>
{
  readonly name = "manage_enrich_job";
  readonly description =
    "Apply one management operation to an enrich job through the pipeline control plane: pause (stop at the next step boundary, resumable), resume (continue from the persisted checkpoint), cancel (terminal), or retry (re-run the last run as a new run). The control plane's own refusals (for example, pausing a job that is not running) are returned as errors, never as success. Requires the chat turn's acting identity.";
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
    source: z.string().min(1).describe("Enrich job source or name"),
    action: z
      .enum(["pause", "resume", "cancel", "retry"])
      .describe("The management operation"),
  });

  async execute(
    input: { source: string; action: EnrichJobManagementAction },
    context: McpToolContext,
  ) {
    const actingLogin = context.actingLogin?.();
    const result = await manageEnrichJobViaDoor(
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
