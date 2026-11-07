/**
 * Issue #3535 (Pipeline J2) — the feed-job copilot commands: the
 * General Copilot tools (and, through the one catalog, the Stock
 * Copilot surface) for the pipeline's feed jobs.
 *
 * Each command is a thin dispatch over the ScheduledAgent door
 * (src/agents/orchestrator/meshDoors.ts) — the pipeline's host
 * owns the control plane (#3543), and these tools are invoking
 * surfaces over it, never a second engine entry. So "Run the
 * Yahoo feed job and show its status" (and the Nasdaq-100 /
 * SP100 / Alpaca / E*TRADE / Public equivalents) runs the same
 * runJob dispatch a scheduled firing and the UX make, and the
 * status returned is the same merged view the UX renders.
 *
 * Identity follows the mesh rules: the tools take NO login
 * input — identity rides the turn context (context.actingLogin),
 * and the door refuses before dispatch when none is supplied.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  getFeedJobStatusViaDoor,
  listFeedJobsViaDoor,
  manageFeedJobViaDoor,
  runFeedJobViaDoor,
  type FeedJobManagementAction,
} from "../../agents/orchestrator/meshDoors";

const SOURCE_PROPERTY = {
  type: "string",
  description:
    "The feed job's source or name: a provider (yahoo, alpaca, etrade, public), a universe (nasdaq100, sp100), \"fundamentals\" for the Yahoo fundamentals job, or an exact feed job id (e.g. yahoo-nasdaq100-quotes).",
} as const;

export class RunFeedJobCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "run_feed_job";
  readonly description =
    "Run a data-provider feed job now through the job pipeline (the ScheduledAgent host's control plane) and return its settled outcome plus its status. The run pulls the source's dataset through the provider port and persists it as the platform's local copy. Examples: source \"yahoo\" runs the Yahoo Nasdaq-100 quotes job; \"alpaca\", \"etrade\", \"public\" run those providers' quotes jobs; \"nasdaq100\" refreshes the stored Nasdaq-100 universe; \"sp100\" runs Yahoo quotes over the S&P 100; \"fundamentals\" runs the Yahoo fundamentals job. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Feed job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await runFeedJobViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      runId: result.runId,
      state: result.state,
    });
    return result;
  }
}

export class GetFeedJobStatusCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "get_feed_job_status";
  readonly description =
    "Report one feed job's status: the pipeline state (idle/running/paused/completed/failed), the last run's outcome, rows persisted in the local copy, data freshness (age + stale label), recent run history, and the next scheduled run. A source that has never run reports the honest never-run state. This is the same status the Data Providers UX surface renders. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Feed job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await getFeedJobStatusViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      state: result.feed?.state ?? result.pipeline?.state ?? "unknown",
    });
    return result;
  }
}

export class ListFeedJobsCommand implements IMcpToolCommand<{}> {
  readonly name = "list_feed_jobs";
  readonly description =
    "List every feed job (Yahoo quotes + fundamentals, Yahoo S&P 100 quotes, Alpaca, E*TRADE, Public, and the Nasdaq-100 universe job) with its merged status: pipeline state, last run, rows persisted, freshness, and next scheduled run. Requires the chat turn's acting identity.";
  readonly jsonSchema = { type: "object" as const, properties: {} };
  readonly zodSchema = z.object({});

  async execute(_input: {}, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await listFeedJobsViaDoor(context.env, actingLogin);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      count: result.jobs.length,
    });
    return result;
  }
}

export class ManageFeedJobCommand
  implements IMcpToolCommand<{ source: string; action: FeedJobManagementAction }>
{
  readonly name = "manage_feed_job";
  readonly description =
    "Apply one management operation to a feed job through the pipeline control plane: pause (stop at the next step boundary, resumable), resume (continue from the persisted checkpoint), cancel (terminal), or retry (re-run the last run as a new run). The control plane's own refusals (for example, pausing a job that is not running) are returned as errors, never as success. Requires the chat turn's acting identity.";
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
    source: z.string().min(1).describe("Feed job source or name"),
    action: z
      .enum(["pause", "resume", "cancel", "retry"])
      .describe("The management operation"),
  });

  async execute(
    input: { source: string; action: FeedJobManagementAction },
    context: McpToolContext,
  ) {
    const actingLogin = context.actingLogin?.();
    const result = await manageFeedJobViaDoor(
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
