/**
 * Issue #3537 (Pipeline J4) — the analyze-job copilot commands:
 * the General Copilot tools (and, through the one catalog, the
 * Stock Copilot surface) for the pipeline's analyze jobs — the
 * enrichJobCommands.ts pattern transposed, one stage later.
 *
 * Each command is a thin dispatch over the ScheduledAgent door
 * (src/agents/orchestrator/meshDoors.ts) — the pipeline's host
 * owns the control plane (#3543), and these tools are invoking
 * surfaces over it, never a second engine entry. An analyze run
 * consumes the enrich job's PERSISTED enriched dataset (never a
 * live fetch), applies the configured DETERMINISTIC rule sets
 * (momentum, range, volume, value — signals, scores, and a
 * composite over the components that evaluated), and persists
 * the analyzed dataset for the generate stage; the status
 * returned is the same merged view the UX renders.
 *
 * Identity follows the mesh rules: the tools take NO login
 * input — identity rides the turn context (context.actingLogin),
 * and the door refuses before dispatch when none is supplied.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  getAnalyzeJobStatusViaDoor,
  listAnalyzeJobsViaDoor,
  manageAnalyzeJobViaDoor,
  runAnalyzeJobViaDoor,
  type AnalyzeJobManagementAction,
} from "../../agents/orchestrator/meshDoors";

const SOURCE_PROPERTY = {
  type: "string",
  description:
    "The analyze job's source or name: a qualified source + universe (\"yahoo nasdaq100 analyze\", \"sp100 analyze\"), \"analyze\" plus a single-job source (\"analyze alpaca\", \"analyze etrade\", \"analyze public\"), or an exact analyze job id (e.g. yahoo-nasdaq100-quotes-enrich-analyze).",
} as const;

export class RunAnalyzeJobCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "run_analyze_job";
  readonly description =
    "Run a data-provider analyze job now through the job pipeline (the ScheduledAgent host's control plane) and return its settled outcome plus its status. The run reads the enrich job's persisted enriched dataset (it never fetches live), applies the configured deterministic rule sets (momentum, range, volume, value — per-symbol signals and scores, a composite over the components that evaluated, and universe aggregates), and persists the analyzed dataset for the generate stage. A rule set the persisted features cannot support is recorded as unavailable with a reason, never fabricated. Examples: source \"yahoo nasdaq100 analyze\" analyzes the Yahoo Nasdaq-100 enriched copy; \"sp100 analyze\", \"analyze alpaca\", \"analyze etrade\", \"analyze public\" run those copies' analyze jobs. A run with no persisted enriched copy is refused by name (ANALYZE_INPUT_MISSING). Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Analyze job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await runAnalyzeJobViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      runId: result.runId,
      state: result.state,
    });
    return result;
  }
}

export class GetAnalyzeJobStatusCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "get_analyze_job_status";
  readonly description =
    "Report one analyze job's status: the pipeline state, the last run's outcome, rows persisted in the analyzed copy, data freshness (age + stale label), the lineage of the analyzed copy (which enrich run it derives from), the analyzed copy's universe summary, recent run history, and the next scheduled run. An analyze job that has never run reports the honest never-run state. This is the same status the Data Providers UX surface renders. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Analyze job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await getAnalyzeJobStatusViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      state: result.analyze?.state ?? result.pipeline?.state ?? "unknown",
    });
    return result;
  }
}

export class ListAnalyzeJobsCommand implements IMcpToolCommand<{}> {
  readonly name = "list_analyze_jobs";
  readonly description =
    "List every analyze job (Yahoo Nasdaq-100, Yahoo S&P 100, Alpaca, E*TRADE, Public) with its merged status: pipeline state, last run, rows persisted in the analyzed copy, freshness, lineage, and next scheduled run. Requires the chat turn's acting identity.";
  readonly jsonSchema = { type: "object" as const, properties: {} };
  readonly zodSchema = z.object({});

  async execute(_input: {}, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await listAnalyzeJobsViaDoor(context.env, actingLogin);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      count: result.jobs.length,
    });
    return result;
  }
}

export class ManageAnalyzeJobCommand
  implements IMcpToolCommand<{ source: string; action: AnalyzeJobManagementAction }>
{
  readonly name = "manage_analyze_job";
  readonly description =
    "Apply one management operation to an analyze job through the pipeline control plane: pause (stop at the next step boundary, resumable), resume (continue from the persisted checkpoint), cancel (terminal), or retry (re-run the last run as a new run). The control plane's own refusals (for example, pausing a job that is not running) are returned as errors, never as success. Requires the chat turn's acting identity.";
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
    source: z.string().min(1).describe("Analyze job source or name"),
    action: z
      .enum(["pause", "resume", "cancel", "retry"])
      .describe("The management operation"),
  });

  async execute(
    input: { source: string; action: AnalyzeJobManagementAction },
    context: McpToolContext,
  ) {
    const actingLogin = context.actingLogin?.();
    const result = await manageAnalyzeJobViaDoor(
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
