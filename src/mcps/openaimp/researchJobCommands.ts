/**
 * Issue #5117 (#5109 Sub-issue 5: MCP endpoints) — Platform MCP commands for
 * the nightly OODA research engine job (`research:<runId>`) and runtime
 * pipeline-chain definition (`define_pipeline_chain`):
 *   - `run_research_job`: runs the research chain or addresses one stage by
 *     `(runId, stageId)` for Copilot's agent-composed path (`a1`).
 *   - `define_pipeline_chain`: defines/updates a declarative pipeline chain on
 *     `JobPipelineControl` at runtime using the `jobs` family stage vocabulary.
 */
import type { Env } from "../../types";
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import {
  dispatchResearchEngineRun,
  executeResearchStageControl,
  readResearchStages,
  researchDispatchRefusal,
  resolveResearchEngineAdapters,
  type ResearchDispatchTarget,
  type ResearchStageOp,
} from "../../workflows/researchScreenEngine";
import { createWorkflowResearchDispatch } from "../../workflows/researchWorkflowStageDeps";
import { RESEARCH_PIPELINE_STAGES } from "../../workflows/stageRuntimeIds";
import { researchEngineJobId } from "../../workflows/researchDataPorts";
import {
  ANALYZE_OODA_STEP,
  EVALUATE_APPLY_STEP,
  createDefaultResearchStepDeps,
  registerResearchSteps,
} from "../../services/researchPipelineJobs";
import { createJobPipelineControl } from "../../services/jobPipelineControlFactory";
import { createBuiltinStepRegistry } from "../../services/jobPipelineSteps";
import { codedMessage } from "../../outcomes/outcomeAspects";
import type { SqlStorage } from "../../orm";
import { actorGateway } from "../../services/cloudflareActorGateway";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../../security/serviceIdentity";

export interface RunResearchJobInput {
  trigger?: "manual" | "scheduled";
  runId?: string;
  stageId?: string;
  op?: ResearchStageOp;
}

export class RunResearchJobCommand implements IMcpToolCommand<RunResearchJobInput> {
  readonly name = "run_research_job";
  readonly description =
    "Run the nightly OODA options-research engine job (`research:<runId>`) or control one stage (`feed`, `enrich`, `analyze`, `generate`, `deliver`, `evaluate`) by `(runId, stageId)`. A dispatch returns the run it started (`runId`, the `research:<runId>` job id, and the six stage rows) — name that run id in the answer. Requires the chat turn's acting identity.";

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

    // Issue #6034 — a run-level status read answers the one stage contract
    // (the same shape `GET /research/runs/:runId/stages` returns), never a
    // dispatch receipt.
    if (input.runId && !input.stageId && (input.op ?? "status") === "status") {
      const stages = await readResearchStages({
        runId: input.runId,
        userLogin: actingLogin,
        ...(sql ? { sql } : {}),
        ...(d1 ? { d1 } : {}),
        ...(envRecord ? { env: envRecord } : {}),
      });
      context.audit("mcp.tool_called", "orchestrator", {
        tool: this.name,
        engineJobId: stages.engineJobId,
        op: "status",
        storageMode: stages.storageMode,
      });
      return stages;
    }

    const trigger = input.trigger ?? "manual";
    // Issue #6040 — one dispatch, one receipt. The host either already holds
    // the research handles (in-agent contexts) or has the ORCHESTRATOR_AGENT
    // binding the door needs; a host with neither refuses by name instead of
    // reporting a run that never happened.
    const dispatchTarget: ResearchDispatchTarget | undefined =
      context.researchDispatch ??
      (context.env?.ORCHESTRATOR_AGENT
        ? createWorkflowResearchDispatch(context.env, { userLogin: actingLogin, trigger })
        : undefined);
    if (!dispatchTarget) {
      throw researchDispatchRefusal(
        "this host has no research dispatch target (no ORCHESTRATOR_AGENT binding and no in-process research handles); the run was not dispatched.",
      );
    }

    const dispatched = await dispatchResearchEngineRun({
      runId: input.runId,
      userLogin: actingLogin,
      trigger,
      ...(sql ? { sql } : {}),
      ...(d1 ? { d1 } : {}),
      ...(envRecord ? { env: envRecord } : {}),
      // Issue #6035 (b) — the full env: a hosted deployment runs the job on
      // the workflow residency instead of the in-process sync invocation.
      ...(context.env ? { durableEnv: context.env as unknown as Env } : {}),
      // Issue #6040 — the real six stage bodies and the real whole-run
      // execute. The audit trail and the caller name the run that started.
      researchDeps: dispatchTarget.researchDeps,
      execute: dispatchTarget.execute,
    });
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      runId: dispatched.runId,
      jobId: dispatched.engineJobId,
      trigger,
      storageMode: dispatched.storageMode,
    });
    return {
      runId: dispatched.runId,
      jobId: dispatched.engineJobId,
      stages: dispatched.stageVisibility,
    };
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

    // Issue #6250 — the MCP research dispatch builds through the ONE
    // factory, with the caller's env: the run emits `job.run.settled`.
    const control = createJobPipelineControl({
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
    }, { ...(envRecord ? { env: envRecord } : {}) });

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

/** Issue #5976 — the config door the orchestrator exposes (one owner, one store). */
interface ResearchConfigDoor {
  researchConfigForMcp(
    userLogin: string | undefined,
    patch?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export interface ResearchConfigInput {
  action: "get" | "update";
  patch?: Record<string, unknown>;
}

/**
 * Issue #5976 — inspect and update the canonical OODA configuration from chat
 * or MCP. Reads and writes go through the same `ResearchConfigService` the
 * settings page and `POST /api/research/settings` use, so a chat update is
 * validated by name, atomic on refusal, and visible in the UI immediately. The
 * model can carry a user-requested value; it cannot infer one.
 */
export class ResearchConfigCommand implements IMcpToolCommand<ResearchConfigInput> {
  readonly name = "research_config";
  readonly description =
    "Inspect or update the canonical OODA research configuration (the same store and validation the settings page and API use). `get` returns the effective config; `update` applies the given settings, refusing unknown or invalid keys by name atomically.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["get", "update"] },
      patch: {
        type: "object",
        description: "For update: the settings to change, keyed by research setting name.",
        additionalProperties: true,
      },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["get", "update"]),
    patch: z.record(z.string(), z.unknown()).optional(),
  });

  async execute(input: ResearchConfigInput, context: McpToolContext) {
    const actingLogin = context.actingLogin?.()?.trim() || "";
    if (!actingLogin || actingLogin === "default") {
      throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
    }
    if (input.action === "update" && !input.patch) {
      throw new Error(
        "research_config_patch_missing: an update must name the settings to change; nothing was written.",
      );
    }
    const door = actorGateway.stub<ResearchConfigDoor>(
      context.env.ORCHESTRATOR_AGENT,
      SHARED_ORCHESTRATOR_INSTANCE,
    );
    const result =
      input.action === "update"
        ? await door.researchConfigForMcp(actingLogin, input.patch)
        : await door.researchConfigForMcp(actingLogin);
    context.audit("mcp.tool_called", "orchestrator", {
      tool: this.name,
      action: input.action,
      ...(input.action === "update" ? { keys: Object.keys(input.patch ?? {}) } : {}),
    });
    return result;
  }
}
