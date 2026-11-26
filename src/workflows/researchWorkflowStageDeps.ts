/**
 * Issues #6092 / #6093 — the production OODA stage dependencies for the
 * JobPipelineWorkflow residency.
 *
 * The workflow host does not own the ResearchAgent's per-tenant state (history
 * deps, universe deps, account binding). It therefore calls the owning
 * Orchestrator DO, which binds those seams once, for every stage:
 *
 *   feed / enrich        -> OrchestratorAgent.runResearchStage
 *   analyze              -> runResearchAndPublish(stage: "analyze")
 *   generate             -> runResearchAndPublish(stage: "generate")
 *   deliver              -> runResearchAndPublish(stage: "deliver")
 *   evaluate             -> OrchestratorAgent.runResearchEvaluate
 *
 * `requireStageInputs` is on: the analyze stage must consume the engine-persisted
 * feed + enrich outputs (they travel through `ctx.input`), and a missing one is a
 * coded stage-input failure — never a silent re-fetch in the workflow residency.
 */
import type { Env } from "../types";
import { actorGateway } from "../services/cloudflareActorGateway";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import type {
  ResearchStepDeps,
} from "../services/researchPipelineJobs";
import {
  researchDispatchRefusal,
  type ResearchDispatchTarget,
} from "./researchScreenEngine";
import type { ResearchFeedStageOutput } from "../services/researchFeedHandoff";
import type { ResearchEnrichStageOutput } from "../services/researchEnrichHandoff";
import type { ResearchEvaluation, ResearchReport } from "../services/researchPipeline";

interface OrchestratorResearchDoor {
  runResearchStage(input: {
    stage: "feed" | "enrich";
    runId: string;
    userLogin?: string;
    trigger?: "manual" | "scheduled";
    feed?: ResearchFeedStageOutput;
    brokerId?: string;
    mode?: string;
  }): Promise<ResearchFeedStageOutput | ResearchEnrichStageOutput>;
  runResearchEvaluate(input: { runId: string; userLogin?: string }): Promise<ResearchEvaluation | null>;
  runResearchAndPublish(
    trigger: "manual" | "scheduled",
    userLogin?: string,
    selection?: {
      brokerId?: string;
      mode?: string;
      runId?: string;
      stage?: "analyze" | "generate" | "deliver";
      report?: ResearchReport;
      publication?: unknown;
    },
  ): Promise<{ success: boolean; error?: string; report?: unknown }>;
}

export function createWorkflowResearchStepDeps(env: Env): ResearchStepDeps {
  // Resolve lazily: building the deps must not require the binding, only using a stage does.
  const door = () =>
    actorGateway.stub<OrchestratorResearchDoor>(
      env.ORCHESTRATOR_AGENT,
      SHARED_ORCHESTRATOR_INSTANCE,
    );

  return {
    requireStageInputs: true,
    runFeedStage: async (input) =>
      (await door().runResearchStage({
        stage: "feed",
        runId: input.runId,
        userLogin: input.userLogin,
        trigger: input.trigger,
        ...(input.brokerId ? { brokerId: input.brokerId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      })) as ResearchFeedStageOutput,
    runEnrichStage: async (input) =>
      (await door().runResearchStage({
        stage: "enrich",
        runId: input.runId,
        userLogin: input.userLogin,
        trigger: input.trigger,
        feed: input.feed,
        ...(input.brokerId ? { brokerId: input.brokerId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      })) as ResearchEnrichStageOutput,
    runOodaAnalysis: async (input) => {
      const result = await door().runResearchAndPublish(input.trigger, input.userLogin, {
        runId: input.runId,
        stage: "analyze",
        ...(input.feed ? { feed: input.feed } : {}),
        ...(input.enrich ? { enrich: input.enrich } : {}),
        ...(input.brokerId ? { brokerId: input.brokerId } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      });
      if (!result.success || !result.report) {
        throw new Error(result.error ?? "research_stage_failed: analyze.ooda did not return a report.");
      }
      return result.report as ResearchReport;
    },
    runGenerateStage: async (input) => {
      const result = await door().runResearchAndPublish("manual", input.userLogin, {
        runId: input.runId,
        stage: "generate",
        report: input.report,
      });
      if (!result.success) {
        throw new Error(result.error ?? "research_stage_failed: generate did not complete.");
      }
      return result;
    },
    runDeliverStage: async (input) => {
      const result = await door().runResearchAndPublish("manual", input.userLogin, {
        runId: input.runId,
        stage: "deliver",
        report: input.report,
        publication: input.publication,
      });
      if (!result.success) {
        throw new Error(result.error ?? "research_stage_failed: deliver did not complete.");
      }
      return result;
    },
    runEvaluateStage: async (input) =>
      door().runResearchEvaluate({ runId: input.runId, userLogin: input.userLogin }),
  };
}

/**
 * Issue #6040 — the dispatch target for a host that reaches the agent over the
 * orchestrator door (the Worker's `/mcp` route). It reuses the stage deps above
 * and adds the one thing the stage list cannot express: the whole-run publish
 * entry the direct-rollback path executes. Both slots call the SAME
 * `runResearchAndPublish` the manual route and the workflow residency call —
 * no second dispatcher, and no literal receipt.
 */
export function createWorkflowResearchDispatch(
  env: Env,
  owner: {
    userLogin: string;
    trigger: "manual" | "scheduled";
    brokerId?: string;
    mode?: string;
  },
): ResearchDispatchTarget {
  return {
    researchDeps: createWorkflowResearchStepDeps(env),
    execute: async (ctx) => {
      if (!ctx?.runId) {
        throw researchDispatchRefusal(
          "the run id is required to dispatch a research run; nothing was started.",
        );
      }
      const result = await actorGateway
        .stub<OrchestratorResearchDoor>(
          env.ORCHESTRATOR_AGENT,
          SHARED_ORCHESTRATOR_INSTANCE,
        )
        .runResearchAndPublish(owner.trigger, owner.userLogin, {
          runId: ctx.runId,
          ...(owner.brokerId ? { brokerId: owner.brokerId } : {}),
          ...(owner.mode ? { mode: owner.mode } : {}),
          ...(ctx.feed ? { feed: ctx.feed } : {}),
          ...(ctx.enrich ? { enrich: ctx.enrich } : {}),
          ...(ctx.deferPublication ? { stage: "analyze" as const } : {}),
        });
      return { ...result };
    },
  };
}
