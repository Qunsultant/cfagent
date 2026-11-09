/**
 * Issue #3540 (Pipeline J7) — the pipeline-chain copilot
 * commands: the General Copilot tools (and, through the one
 * catalog, the Stock Copilot surface) for the composed
 * pipeline chains — the deliverJobCommands.ts pattern
 * transposed to the composed chain.
 *
 * Each command is a thin dispatch over the ScheduledAgent door
 * (src/agents/orchestrator/meshDoors.ts) — the pipeline's host
 * owns the control plane (#3543), and these tools are invoking
 * surfaces over it, never a second engine entry. A chain run
 * executes the lineage's five stage jobs as one composed job
 * (feed → enrich → analyze → generate → deliver over the
 * stages' persisted datasets, one run id for the whole
 * lineage); the status returned is the end-to-end roll-up —
 * per-stage states plus the current frontier — the same view
 * the UX renders.
 *
 * Identity follows the mesh rules: the tools take NO login
 * input — identity rides the turn context (context.actingLogin),
 * and the door refuses before dispatch when none is supplied.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  getPipelineChainStatusViaDoor,
  listPipelineChainsViaDoor,
  managePipelineChainViaDoor,
  runPipelineChainViaDoor,
  type PipelineChainManagementAction,
  type PipelineChainRunBridge,
} from "../../agents/orchestrator/meshDoors";
import { createRunBridgePorts } from "../../agents/orchestrator/runBridge";

const SOURCE_PROPERTY = {
  type: "string",
  description:
    "The pipeline chain's source or name: a qualified source + universe (\"yahoo nasdaq100 pipeline\", \"sp100 pipeline\"), \"pipeline\" plus a single-job source (\"alpaca pipeline\", \"etrade pipeline\", \"public pipeline\"), or an exact pipeline chain job id (e.g. yahoo-nasdaq100-quotes-pipeline).",
} as const;

const STAGE_PROPERTY = {
  type: "string",
  enum: ["feed", "enrich", "analyze", "generate", "deliver"],
  description:
    "The stage inside the chain the stage_* actions address: feed, enrich, analyze, generate, or deliver.",
} as const;

export class RunPipelineChainCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "run_pipeline_chain";
  readonly description =
    "Run a composed pipeline chain now through the job pipeline (the ScheduledAgent host's control plane) and return its settled outcome plus its end-to-end status. The chain executes the lineage's five stages as one job — feed pulls and persists the dataset, enrich derives from the persisted copy, analyze derives from the enriched copy, generate renders from the analyzed copy, and deliver delivers the generated reports to the configured channels — all under ONE run id, so every stage artifact of the run names the same lineage. Each stage also remains individually schedulable and manageable through its own job tools. A stage whose persisted input is missing refuses by name and the chain halts at that stage (its frontier), never fabricating downstream output. Examples: source \"yahoo nasdaq100 pipeline\" runs the Yahoo Nasdaq-100 chain end-to-end; \"sp100 pipeline\", \"alpaca pipeline\", \"etrade pipeline\", \"public pipeline\" run those chains. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Pipeline chain source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const runBridge = chainRunBridgeFromContext(context);
    const result = await runPipelineChainViaDoor(
      context.env,
      actingLogin,
      input.source,
      runBridge ? { runBridge } : undefined,
    );
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      runId: result.runId,
      state: result.state,
    });
    return result;
  }
}

/**
 * Issue #3787: the bridge handle for a chain run started from
 * this tool — the orchestrator instance's own store (the
 * context's SQL handle) under its session id, so the #3784
 * sweep reads the row. Best-effort: a context without a SQL
 * handle or session id runs unbridged (the chain still runs;
 * only its stuck coverage is off).
 */
export function chainRunBridgeFromContext(
  context: McpToolContext,
): PipelineChainRunBridge | undefined {
  try {
    const sql = (context.storage as { sql?: unknown } | undefined)?.sql;
    if (!sql) return undefined;
    if (typeof context.sessionId !== "string" || !context.sessionId) return undefined;
    return {
      ports: createRunBridgePorts(sql as never),
      sessionId: context.sessionId,
    };
  } catch {
    return undefined;
  }
}

export class GetPipelineChainStatusCommand
  implements IMcpToolCommand<{ source: string }>
{
  readonly name = "get_pipeline_chain_status";
  readonly description =
    "Report one pipeline chain's end-to-end status — the answer to \"where is the pipeline?\": the chain's run state and last run outcome, EVERY stage's state in the chain's current/last run (feed, enrich, analyze, generate, deliver, with unit counts and errors), the FRONTIER (the stage the chain stopped advancing at — the failed, stopped, or in-flight stage; null when the last chain run completed), each stage job's own latest run state (the stage jobs also advance independently through their own schedules), and the next scheduled chain run. A chain that has never run reports the honest never-run state with frontier \"feed\". This is the same status the Data Providers UX surface renders. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: { source: SOURCE_PROPERTY },
    required: ["source"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Pipeline chain source or name"),
  });

  async execute(input: { source: string }, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await getPipelineChainStatusViaDoor(context.env, actingLogin, input.source);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: result.jobId,
      state: result.pipeline?.state ?? "unknown",
      frontier: result.frontier ?? "none",
    });
    return result;
  }
}

export class ListPipelineChainsCommand implements IMcpToolCommand<{}> {
  readonly name = "list_pipeline_chains";
  readonly description =
    "List every composed pipeline chain (Yahoo Nasdaq-100, Yahoo S&P 100, Alpaca, E*TRADE, Public) with its end-to-end status: chain run state, per-stage states, the current frontier, each stage job's own latest run state, and the next scheduled chain run. Requires the chat turn's acting identity.";
  readonly jsonSchema = { type: "object" as const, properties: {} };
  readonly zodSchema = z.object({});

  async execute(_input: {}, context: McpToolContext) {
    const actingLogin = context.actingLogin?.();
    const result = await listPipelineChainsViaDoor(context.env, actingLogin);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      count: result.jobs.length,
    });
    return result;
  }
}

export class ManagePipelineChainCommand
  implements
    IMcpToolCommand<{
      source: string;
      action: PipelineChainManagementAction;
      stage?: string;
    }>
{
  readonly name = "manage_pipeline_chain";
  readonly description =
    "Apply one management operation to a pipeline chain through the pipeline control plane: pause (stop the chain's run at the next stage boundary, resumable), resume (continue the chain from the persisted checkpoint — completed stages are read back from their hand-offs, never re-executed), cancel (terminal for the chain's run), retry (re-run as a new run), or the per-stage operations stage_pause / stage_resume / stage_cancel, which stop, resume, or cancel ONE stage inside the chain's run (the stage parameter names it: feed, enrich, analyze, generate, or deliver) — a stage can be paused or cancelled without dismantling the chain, and a cancelled stage's downstream never proceeds. The control plane's own refusals (for example, pausing a chain that is not running, or resuming a stage that is not the stopped one) are returned as errors, never as success. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      source: SOURCE_PROPERTY,
      action: {
        type: "string",
        enum: [
          "pause",
          "resume",
          "cancel",
          "retry",
          "stage_pause",
          "stage_resume",
          "stage_cancel",
        ],
        description: "The management operation to apply.",
      },
      stage: STAGE_PROPERTY,
    },
    required: ["source", "action"],
  };
  readonly zodSchema = z.object({
    source: z.string().min(1).describe("Pipeline chain source or name"),
    action: z
      .enum([
        "pause",
        "resume",
        "cancel",
        "retry",
        "stage_pause",
        "stage_resume",
        "stage_cancel",
      ])
      .describe("The management operation"),
    stage: z
      .enum(["feed", "enrich", "analyze", "generate", "deliver"])
      .optional()
      .describe("The stage the stage_* actions address"),
  });

  async execute(
    input: {
      source: string;
      action: PipelineChainManagementAction;
      stage?: string;
    },
    context: McpToolContext,
  ) {
    const actingLogin = context.actingLogin?.();
    const result = await managePipelineChainViaDoor(
      context.env,
      actingLogin,
      input.source,
      input.action,
      input.stage,
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
