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
  resolveResearchEngineAdapters,
  type ResearchStageOp,
} from "../../workflows/researchScreenEngine";
import { RESEARCH_PIPELINE_STAGES } from "../../workflows/stageRuntimeIds";
import { researchEngineJobId } from "../../workflows/researchDataPorts";
import {
  ANALYZE_OODA_STEP,
  EVALUATE_APPLY_STEP,
  createDefaultResearchStepDeps,
  registerResearchSteps,
} from "../../services/researchPipelineJobs";
import { JobPipelineControl } from "../../services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../../services/jobPipelineSteps";
import { codedMessage } from "../../outcomes/outcomeAspects";
import type { SqlStorage } from "../../orm";

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

    const sql = context.orm as unknown as SqlStorage | undefined;
    const envRecord = context.env as unknown as Record<string, string | undefined> | undefined;
    const d1 = (context.env as { AGENT_DB?: D1Database } | undefined)?.AGENT_DB;

    if (input.runId && input.stageId) {
      const stageResult = await executeResearchStageControl({
        runId: input.runId,
        stageId: input.stageId,
        op: input.op ?? "status",
        userLogin: actingLogin,
        ...(sql ? { sql } : {}),
        ...(d1 ? { d1 } : {}),
        ...(envRecord ? { env: envRecord } : {}),
      });
      context.audit("mcp.tool_called", "orchestrator", {
        tool: this.name,
        engineJobId: stageResult.engineJobId,
        stageId: stageResult.stageId,
        op: stageResult.op,
        storageMode: stageResult.storageMode,
        ephemeralFallback: stageResult.ephemeralFallback,
      });
      return stageResult;
    }

    const trigger = input.trigger ?? "manual";
    const dispatched = await dispatchResearchEngineRun({
      runId: input.runId,
      userLogin: actingLogin,
      trigger,
      ...(sql ? { sql } : {}),
      ...(d1 ? { d1 } : {}),
      ...(envRecord ? { env: envRecord } : {}),
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

    const sql = context.orm as unknown as SqlStorage | undefined;
    const envRecord = context.env as unknown as Record<string, string | undefined> | undefined;
    const d1 = (context.env as { AGENT_DB?: D1Database } | undefined)?.AGENT_DB;

    const { storageMode, ephemeralFallback, ephemeralReason, stores, runRecorder } =
      resolveResearchEngineAdapters({
        ...(sql ? { sql } : {}),
        ...(d1 ? { d1 } : {}),
        ...(envRecord ? { env: envRecord } : {}),
      });

    const runId = input.jobId.startsWith("research:")
      ? input.jobId.slice("research:".length)
      : input.jobId;
    const engineJobId = researchEngineJobId(runId);

    const control = new JobPipelineControl({
      stores,
      runRecorder,
      publisher: null,
      steps: registerResearchSteps(
        createBuiltinStepRegistry(),
        createDefaultResearchStepDeps(),
      ),
      invocation: "sync",
      // Issue #4782 S3 — the retry policy resolves from the
      // caller's env (platform default), as the adapters above do.
      ...(envRecord ? { env: envRecord } : {}),
    });

    const definition = await control.defineJob({
      jobId: engineJobId,
      name: input.name ?? `Chain — ${input.jobId}`,
      root: {
        kind: "research",
        inputs: {
          sources: input.sources ?? ["primary-feed"],
          datasets: input.datasets ?? ["quotes"],
        },
        steps: [{ step: "noop" }],
        schedule: input.cron ? { enabled: true, cron: input.cron } : { enabled: false },
        children: input.stages.map((kind) => ({
          kind,
          steps:
            kind === "analyze"
              ? [
                  {
                    step: ANALYZE_OODA_STEP,
                    params: { runId, userLogin: actingLogin, trigger: "manual" },
                  },
                ]
              : kind === "evaluate"
                ? [
                    {
                      step: EVALUATE_APPLY_STEP,
                      params: { runId, userLogin: actingLogin },
                    },
                  ]
                : [],
        })),
      },
    } as never);

    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      jobId: input.jobId,
      engineJobId: definition.jobId,
      runId,
      stages: input.stages,
      storageMode,
      ephemeralFallback,
    });

    return {
      ok: true,
      jobId: input.jobId,
      engineJobId: definition.jobId,
      runId,
      version: definition.version,
      stages: input.stages,
      owner: actingLogin,
      storageMode,
      ephemeralFallback,
      ...(ephemeralReason ? { ephemeralReason } : {}),
    };
  }
}
