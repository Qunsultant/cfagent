/**
 * Issue #5117 (#5109 Sub-issue 5: MCP endpoints) — Platform MCP commands for
 * the nightly OODA research engine job (`research:<runId>`) and runtime
 * pipeline-chain definition (`define_pipeline_chain`):
 *   - `run_research_job`: runs the research chain or addresses one stage by
 *     `(runId, stageId)` for Copilot's agent-composed path (`a1`).
 *   - `define_pipeline_chain`: defines/updates a declarative pipeline chain on
 *     `JobPipelineControl` at runtime using the `jobs` family stage vocabulary.
 */
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  dispatchResearchEngineRun,
  executeResearchStageControl,
  type ResearchStageOp,
} from "../../workflows/researchScreenEngine";
import { RESEARCH_PIPELINE_STAGES } from "../../workflows/stageRuntimeIds";
import { createInMemoryJobPipelineStores } from "../../data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../../data/inMemoryJobRunRecordAdapter";
import { JobPipelineControl, jobRunRecorderFromStore } from "../../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../../services/jobPipelineSteps";
import { codedMessage } from "../../outcomes/outcomeAspects";

export interface RunResearchJobInput {
  trigger?: "manual" | "scheduled";
  runId?: string;
  stageId?: string;
  op?: ResearchStageOp;
}

export class RunResearchJobCommand implements IMcpToolCommand<RunResearchJobInput> {
  readonly name = "run_research_job";
  readonly description =
    "Run the nightly OODA options-research engine job (`research:<runId>`) or control one stage (`feed`, `enrich`, `analyze`, `generate`, `deliver`, `evaluate`) by `(runId, stageId)`. Requires the chat turn's acting identity.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      trigger: { type: "string", enum: ["manual", "scheduled"] },
      runId: { type: "string", description: "Optional existing runId for stage control." },
      stageId: {
        type: "string",
        enum: [...RESEARCH_PIPELINE_STAGES],
        description: "Optional stage id for per-stage Copilot composition.",
      },
      op: {
        type: "string",
        enum: ["status", "run", "rerun", "stop", "resume", "cancel"],
      },
    },
  };

  readonly zodSchema = z.object({
    trigger: z.enum(["manual", "scheduled"]).optional(),
    runId: z.string().optional(),
    stageId: z.enum(RESEARCH_PIPELINE_STAGES).optional(),
    op: z.enum(["status", "run", "rerun", "stop", "resume", "cancel"]).optional(),
  });

  async execute(input: RunResearchJobInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.()?.trim() || "";
    if (!actingLogin || actingLogin === "default") {
      throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
    }

    if (input.runId && input.stageId) {
      const stageResult = await executeResearchStageControl({
        runId: input.runId,
        stageId: input.stageId,
        op: input.op ?? "status",
        userLogin: actingLogin,
      });
      context.audit("mcp.tool_called", "orchestrator", {
        tool: this.name,
        engineJobId: stageResult.engineJobId,
        stageId: stageResult.stageId,
        op: stageResult.op,
      });
      return stageResult;
    }

    const trigger = input.trigger ?? "manual";
    const dispatched = await dispatchResearchEngineRun({
      runId: input.runId,
      userLogin: actingLogin,
      trigger,
      execute: async () => ({
        dispatched: true,
        trigger,
        stages: RESEARCH_PIPELINE_STAGES,
      }),
    });
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      engineJobId: dispatched.engineJobId,
      trigger,
    });
    return dispatched;
  }
}

export interface DefinePipelineChainInput {
  jobId: string;
  name?: string;
  stages: string[];
  sources?: string[];
  datasets?: string[];
  cron?: string;
}

export class DefinePipelineChainCommand implements IMcpToolCommand<DefinePipelineChainInput> {
  readonly name = "define_pipeline_chain";
  readonly description =
    "Define or update a declarative pipeline chain on `JobPipelineControl` over the `jobs` family stages (`feed`, `enrich`, `analyze`, `generate`, `deliver`, `evaluate`). Requires the chat turn's acting identity.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      jobId: { type: "string", description: "Unique chain jobId (e.g. research-custom-chain)." },
      name: { type: "string" },
      stages: {
        type: "array",
        items: { type: "string", enum: [...RESEARCH_PIPELINE_STAGES] },
        minItems: 1,
      },
      sources: { type: "array", items: { type: "string" } },
      datasets: { type: "array", items: { type: "string" } },
      cron: { type: "string" },
    },
    required: ["jobId", "stages"],
  };

  readonly zodSchema = z.object({
    jobId: z.string().min(1),
    name: z.string().optional(),
    stages: z.array(z.enum(RESEARCH_PIPELINE_STAGES)).min(1),
    sources: z.array(z.string()).optional(),
    datasets: z.array(z.string()).optional(),
    cron: z.string().optional(),
  });

  async execute(input: DefinePipelineChainInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.()?.trim() || "";
    if (!actingLogin || actingLogin === "default") {
      throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
    }

    const stores = createInMemoryJobPipelineStores();
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      invocation: "sync",
    });

    const definition = await control.defineJob({
      jobId: input.jobId,
      name: input.name ?? `Chain — ${input.jobId}`,
      root: {
        kind: "chain",
        inputs: {
          sources: input.sources ?? ["primary-feed"],
          datasets: input.datasets ?? ["quotes"],
        },
        schedule: input.cron ? { enabled: true, cron: input.cron } : { enabled: false },
        children: input.stages.map((kind) => ({
          kind,
          steps: [],
        })),
      },
    } as never);

    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: definition.jobId,
      stages: input.stages,
    });

    return {
      ok: true,
      jobId: definition.jobId,
      version: definition.version,
      stages: input.stages,
      owner: actingLogin,
    };
  }
}
