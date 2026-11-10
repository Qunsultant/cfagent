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
  configureFeedJobScheduleViaDoor,
  getFeedJobStatusViaDoor,
  listFeedJobsViaDoor,
  manageFeedJobViaDoor,
  requireActingLogin,
  runFeedJobViaDoor,
  type FeedJobManagementAction,
} from "../../agents/orchestrator/meshDoors";

const SOURCE_PROPERTY = {
  type: "string",
  description:
    "The feed job's source or name: a provider (yahoo, alpaca, etrade, public), a universe (nasdaq100, sp100), \"fundamentals\" for the Yahoo fundamentals job, \"technicals\" for the Yahoo technicals job (persisted daily bars), or an exact feed job id (e.g. yahoo-nasdaq100-quotes).",
} as const;

export class RunFeedJobCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "run_feed_job";
  readonly description =
    "Run a data-provider feed job now through the job pipeline (the ScheduledAgent host's control plane) and return its settled outcome plus its status. The run pulls the source's dataset through the provider port and persists it as the platform's local copy. Examples: source \"yahoo\" runs the Yahoo Nasdaq-100 quotes job; \"alpaca\", \"etrade\", \"public\" run those providers' quotes jobs; \"nasdaq100\" refreshes the stored Nasdaq-100 universe; \"sp100\" runs Yahoo quotes over the S&P 100; \"fundamentals\" runs the Yahoo fundamentals job; \"technicals\" runs the Yahoo technicals job (persisted daily bars for enrich RSI/MACD/ATR and the screener UX). Requires the chat turn's acting identity.";
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
    "List every feed job (Yahoo quotes, fundamentals, and technicals, Yahoo S&P 100 quotes, Alpaca, E*TRADE, Public, and the Nasdaq-100 universe job) with its merged status: pipeline state, last run, rows persisted, freshness, and next scheduled run. Requires the chat turn's acting identity.";
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

/* ------------------------------------------------------------------ */
/* Schedule commands (#3530 slice B)                                   */
/*                                                                     */
/* The stored schedule slice A made configurable through the REST    */
/* route, through the Copilot with the same validation and the same  */
/* door — no second schedule shape anywhere in the chain.            */
/* ------------------------------------------------------------------ */

/** The typed refusal code for an invalid schedule patch (the schedule route's code). */
export const FEED_JOB_SCHEDULE_INVALID = "FEED_JOB_SCHEDULE_INVALID";

function schedulePatchRefusal(message: string): Error {
  return new Error(`${FEED_JOB_SCHEDULE_INVALID}: ${message}`);
}

export interface FeedJobSchedulePatchInput {
  source: string;
  enabled?: boolean;
  intervalMinutes?: number;
  cron?: string;
}

/**
 * Validate a schedule patch with the schedule route's rules
 * (src/agents/routes/dataProviders.ts), in the route's terms: an
 * empty patch, an unknown field, a non-boolean enabled, a
 * non-positive-integer intervalMinutes, an empty cron, or
 * intervalMinutes + cron together all refuse typed — before any
 * door call, so an invalid patch never partially writes.
 */
function validateFeedJobSchedulePatch(input: FeedJobSchedulePatchInput): {
  enabled?: boolean;
  intervalMinutes?: number;
  cron?: string;
} {
  const raw = input as unknown as Record<string, unknown>;
  const keys = Object.keys(raw).filter(
    (key) => key !== "source" && raw[key] !== undefined,
  );
  if (keys.length === 0) {
    throw schedulePatchRefusal(
      "The schedule patch is empty — name enabled, intervalMinutes, or cron.",
    );
  }
  for (const key of keys) {
    if (!["enabled", "intervalMinutes", "cron"].includes(key)) {
      throw schedulePatchRefusal(`Unknown schedule field "${key}".`);
    }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw schedulePatchRefusal('Schedule field "enabled" must be a boolean.');
  }
  if (
    raw.intervalMinutes !== undefined &&
    (typeof raw.intervalMinutes !== "number" ||
      !Number.isInteger(raw.intervalMinutes) ||
      raw.intervalMinutes <= 0)
  ) {
    throw schedulePatchRefusal(
      'Schedule field "intervalMinutes" must be a positive whole number of minutes.',
    );
  }
  if (
    raw.cron !== undefined &&
    (typeof raw.cron !== "string" || !raw.cron.trim())
  ) {
    throw schedulePatchRefusal('Schedule field "cron" must be a non-empty string.');
  }
  if (raw.intervalMinutes !== undefined && raw.cron !== undefined) {
    throw schedulePatchRefusal(
      "Name either intervalMinutes or cron, not both — a schedule carries one cadence mechanism.",
    );
  }
  return {
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...(typeof raw.intervalMinutes === "number"
      ? { intervalMinutes: raw.intervalMinutes }
      : {}),
    ...(typeof raw.cron === "string" ? { cron: raw.cron } : {}),
  };
}

export class GetFeedJobScheduleCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "get_feed_job_schedule";
  readonly description =
    "Report one feed job's STORED schedule — whether it is enabled, its cadence (an interval like \"every 60 minutes\" or a cron expression), and the next scheduled run when known — from the same surface view the Data Providers UX renders. A job with no stored definition reports schedule as null: an honest unknown, never a cadence fabricated from the registry default. Requires the chat turn's acting identity.";
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
    const view = await getFeedJobStatusViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: view.jobId,
      enabled: view.schedule?.enabled ?? null,
    });
    return {
      jobId: view.jobId,
      label: view.label,
      schedule: view.schedule,
      nextScheduledRun: view.nextScheduledRun,
    };
  }
}

export class SetFeedJobScheduleCommand
  implements IMcpToolCommand<FeedJobSchedulePatchInput>
{
  readonly name = "set_feed_job_schedule";
  readonly description =
    "Set one feed job's stored schedule through the pipeline host's control plane (the configure door the Data Providers schedule route uses): enable or disable the schedule, set its cadence in minutes, or set a cron expression. The patch merges over the stored schedule — disabling never loses the cadence and a cadence change never flips enablement. An invalid patch refuses with FEED_JOB_SCHEDULE_INVALID before any write. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      source: SOURCE_PROPERTY,
      enabled: {
        type: "boolean",
        description: "Enable or disable the job's schedule.",
      },
      intervalMinutes: {
        type: "number",
        description: "The cadence in whole minutes (a positive integer).",
      },
      cron: {
        type: "string",
        description: "A cron expression instead of an interval cadence.",
      },
    },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Feed job source or name"),
    enabled: z.boolean().optional().describe("Enable or disable the schedule"),
    intervalMinutes: z
      .number()
      .optional()
      .describe("The cadence in whole minutes"),
    cron: z.string().optional().describe("A cron expression"),
  });

  async execute(input: FeedJobSchedulePatchInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    // Identity first, patch validation second — the schedule
    // route's order (session, then body), so an identity-less call
    // refuses as identity_required whatever the patch holds.
    requireActingLogin(actingLogin);
    const patch = validateFeedJobSchedulePatch(input);
    const result = await configureFeedJobScheduleViaDoor(
      context.env,
      actingLogin,
      input.source,
      {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.intervalMinutes !== undefined
          ? { interval: `every ${patch.intervalMinutes} minutes` }
          : {}),
        ...(patch.cron !== undefined ? { cron: patch.cron.trim() } : {}),
      },
    );
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      enabled: result.schedule?.enabled ?? null,
      interval: result.schedule?.interval ?? null,
      cron: result.schedule?.cron ?? null,
    });
    return result;
  }
}
