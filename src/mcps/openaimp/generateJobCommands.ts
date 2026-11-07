/**
 * Issue #3538 (Pipeline J5) — the generate-job copilot commands:
 * the General Copilot tools (and, through the one catalog, the
 * Stock Copilot surface) for the pipeline's generate jobs — the
 * analyzeJobCommands.ts pattern transposed, one stage later.
 *
 * Each command is a thin dispatch over the ScheduledAgent door
 * (src/agents/orchestrator/meshDoors.ts) — the pipeline's host
 * owns the control plane (#3543), and these tools are invoking
 * surfaces over it, never a second engine entry. A generate run
 * consumes the analyze job's PERSISTED analyzed dataset (never
 * a live fetch), renders the configured reports in the
 * configured formats deterministically, persists the generated
 * results for the deliver stage, and runs each report's
 * canonical leg (mas_reports) where a host wired it — recorded
 * per report either way; the status returned is the same
 * merged view the UX renders.
 *
 * Identity follows the mesh rules: the tools take NO login
 * input — identity rides the turn context (context.actingLogin),
 * and the door refuses before dispatch when none is supplied.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  getGenerateJobStatusViaDoor,
  listGenerateJobsViaDoor,
  manageGenerateJobViaDoor,
  runGenerateJobViaDoor,
  type GenerateJobManagementAction,
} from "../../agents/orchestrator/meshDoors";

const SOURCE_PROPERTY = {
  type: "string",
  description:
    "The generate job's source or name: a qualified source + universe (\"yahoo nasdaq100 generate\", \"sp100 generate\"), \"generate\" plus a single-job source (\"generate alpaca\", \"generate etrade\", \"generate public\"), or an exact generate job id (e.g. yahoo-nasdaq100-quotes-enrich-analyze-generate).",
} as const;

export class RunGenerateJobCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "run_generate_job";
  readonly description =
    "Run a data-provider generate job now through the job pipeline (the ScheduledAgent host's control plane) and return its settled outcome plus its status. The run reads the analyze job's persisted analyzed dataset (it never fetches live), renders the configured reports in the configured formats (deterministic renders — json, markdown, csv, pdf), persists the generated results for the deliver stage, and records each report's canonical report-store (mas_reports) leg outcome — stored/deduped where a host wired the canonical seam, not_wired with its reason where none did. A format that cannot be rendered is recorded failed with a coded reason, never fabricated. Examples: source \"yahoo nasdaq100 generate\" generates from the Yahoo Nasdaq-100 analyzed copy; \"sp100 generate\", \"generate alpaca\", \"generate etrade\", \"generate public\" run those copies' generate jobs. A run with no persisted analyzed copy is refused by name (GENERATE_INPUT_MISSING). Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Generate job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await runGenerateJobViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      runId: result.runId,
      state: result.state,
    });
    return result;
  }
}

export class GetGenerateJobStatusCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "get_generate_job_status";
  readonly description =
    "Report one generate job's status: the pipeline state, the last run's outcome, reports and formats persisted in the generated copy, data freshness (age + stale label), the lineage of the generated copy (which analyze run it derives from), each report's generated/failed formats and its canonical report-store leg outcome, recent run history, and the next scheduled run. A generate job that has never run reports the honest never-run state. This is the same status the Data Providers UX surface renders. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Generate job source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await getGenerateJobStatusViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      state: result.generate?.state ?? result.pipeline?.state ?? "unknown",
    });
    return result;
  }
}

export class ListGenerateJobsCommand implements IMcpToolCommand<{}> {
  readonly name = "list_generate_jobs";
  readonly description =
    "List every generate job (Yahoo Nasdaq-100, Yahoo S&P 100, Alpaca, E*TRADE, Public) with its merged status: pipeline state, last run, reports and formats persisted in the generated copy, freshness, lineage, canonical leg outcomes, and next scheduled run. Requires the chat turn's acting identity.";
  readonly jsonSchema = { type: "object" as const, properties: {} };
  readonly zodSchema = z.object({});

  async execute(_input: {}, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await listGenerateJobsViaDoor(context.env, actingLogin);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      count: result.jobs.length,
    });
    return result;
  }
}

export class ManageGenerateJobCommand
  implements IMcpToolCommand<{ source: string; action: GenerateJobManagementAction }>
{
  readonly name = "manage_generate_job";
  readonly description =
    "Apply one management operation to a generate job through the pipeline control plane: pause (stop at the next step boundary, resumable), resume (continue from the persisted checkpoint), cancel (terminal), or retry (re-run the last run as a new run). The control plane's own refusals (for example, pausing a job that is not running) are returned as errors, never as success. Requires the chat turn's acting identity.";
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
    source: z.string().min(1).describe("Generate job source or name"),
    action: z
      .enum(["pause", "resume", "cancel", "retry"])
      .describe("The management operation"),
  });

  async execute(
    input: { source: string; action: GenerateJobManagementAction },
    context: McpToolContext,
  ) {
    const actingLogin = context.actingLogin?.();
    const result = await manageGenerateJobViaDoor(
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
