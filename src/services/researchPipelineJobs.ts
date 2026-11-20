/**
 * Issue #5118 (#5109 Sub-issue 2: Services) — Research pipeline services on the
 * one J-stack engine:
 *   - Registers `analyze.ooda` alongside `analyze.apply` on `JobStepRegistry`.
 *   - Adds the `evaluate` stage (`evaluate.apply`) to the `jobs` family.
 *   - Defines `research:<runId>` (`buildResearchJobDefinition`) and its catalog entry.
 *   - Records ledger ownership: `workflowRuns` / `JobRunRecorder` is the single
 *     run recorder; `ResearchTaskLedger` reconciles onto it via
 *     `reconcileResearchTaskWithRunRecord` with no silent second recorder.
 */
import type { JobStepRegistry } from "./jobPipelineSteps";
import type { ResearchEvaluation, ResearchReport } from "./researchPipeline";
import { codedMessage } from "../outcomes/outcomeAspects";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import {
  DEFAULT_RESEARCH_JOB_CONFIG,
  RESEARCH_AOP_RULES,
  resolveResearchJobConfig,
  type ResearchJobConfig,
} from "../config/researchJobConfig";
import {
  RESEARCH_PIPELINE_STAGES,
  type ResearchPipelineStage,
} from "../workflows/stageRuntimeIds";
import {
  researchArtifactKey,
  researchEngineJobId,
  type ResearchEvaluationStorePort,
} from "../workflows/researchDataPorts";
import { jobDefinitionSpec } from "../config/jobDefinitionCatalog";
import { bindJobDefinitionParams } from "./jobDefinitionParamBinders";
import { buildJobConfigFromSpec } from "./jobDefinitionSpecBuilder";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/researchPipelineJobs",
});

export const ANALYZE_OODA_STEP = "analyze.ooda";
export const EVALUATE_APPLY_STEP = "evaluate.apply";
export const RESEARCH_FEED_STEP = "research.feed";
export const RESEARCH_ENRICH_STEP = "research.enrich";
export const RESEARCH_GENERATE_STEP = "research.generate";
export const RESEARCH_DELIVER_STEP = "research.deliver";

export { RESEARCH_PIPELINE_STAGES, type ResearchPipelineStage };

/**
 * Ledger ownership record (Gap 3 reconciliation, #5118):
 * The J-stack `JobRunRecorder` / `workflowRuns` is the single authoritative run
 * recorder. `ResearchTaskLedger` is an execution-status projection reconciled
 * into `research:<runId>` via `reconcileResearchTaskWithRunRecord`.
 */
export const RESEARCH_LEDGER_OWNERSHIP = {
  authoritativeRecorder: "workflowRuns",
  ledgerRole: "projection",
  reconciliationFn: "reconcileResearchTaskWithRunRecord",
  jobIdPrefix: "research:",
} as const;

export interface ResearchPipelineCatalogEntry {
  id: "research";
  label: string;
  jobIdPrefix: "research:";
  stages: readonly ResearchPipelineStage[];
  analyzeStep: typeof ANALYZE_OODA_STEP;
  evaluateStep: typeof EVALUATE_APPLY_STEP;
}

export const RESEARCH_PIPELINE_CATALOG_ENTRY: ResearchPipelineCatalogEntry = {
  id: "research",
  label: "Nightly OODA Research",
  jobIdPrefix: "research:",
  stages: RESEARCH_PIPELINE_STAGES,
  analyzeStep: ANALYZE_OODA_STEP,
  evaluateStep: EVALUATE_APPLY_STEP,
};

export interface ResearchStepDeps {
  /** Execute the OODA analysis loop and return the structured ResearchReport. */
  runOodaAnalysis: (input: {
    runId: string;
    userLogin: string;
    trigger: "manual" | "scheduled";
    datasetAsOf?: string | null;
  }) => Promise<ResearchReport | Record<string, unknown>>;
  /** Execute the §9 outcome evaluation pass for a run or due runs. */
  runEvaluateStage?: (input: {
    runId: string;
    userLogin: string;
    evaluationStore?: ResearchEvaluationStorePort;
  }) => Promise<ResearchEvaluation | null>;
  evaluationStore?: ResearchEvaluationStorePort;
}

/**
 * Register `analyze.ooda` and `evaluate.apply` on the shared `JobStepRegistry`
 * alongside `analyze.apply`.
 */
export function registerResearchSteps(
  registry: JobStepRegistry,
  deps: ResearchStepDeps,
): JobStepRegistry {
  for (const [stepName, stageId] of [
    [RESEARCH_FEED_STEP, "feed"],
    [RESEARCH_ENRICH_STEP, "enrich"],
    [RESEARCH_GENERATE_STEP, "generate"],
    [RESEARCH_DELIVER_STEP, "deliver"],
  ] as const) {
    registry.register(stepName, async (ctx) => {
      const params = (ctx.params ?? {}) as { runId?: string };
      const runId = params.runId || ctx.jobId.replace(/^research:/, "");
      return {
        output: { stage: stageId, runId, status: "completed" },
        descriptor: researchArtifactKey(runId, stageId),
      };
    });
  }

  registry.register(ANALYZE_OODA_STEP, async (ctx) => {
    const params = (ctx.params ?? {}) as {
      runId?: string;
      userLogin?: string;
      trigger?: "manual" | "scheduled";
      datasetAsOf?: string | null;
    };
    const runId = params.runId || ctx.jobId.replace(/^research:/, "");
    const userLogin = params.userLogin || "";
    if (!userLogin) {
      throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
    }
    const config = resolveResearchJobConfig();
    assertResearchAopCompliance(config, { userLogin });
    const trigger = params.trigger === "scheduled" ? "scheduled" : "manual";
    structuredLog.info("researchPipelineJobs.analyze_ooda_started", {
      jobId: ctx.jobId,
      runId,
      trigger,
      oodaBudgetMs: config.oodaBudgetMs,
    });
    const report = await deps.runOodaAnalysis({
      runId,
      userLogin,
      trigger,
      datasetAsOf: params.datasetAsOf ?? null,
    });
    const ideaCount = Array.isArray((report as { ideas?: unknown[] }).ideas)
      ? (report as { ideas: unknown[] }).ideas.length
      : 0;
    return {
      output: report,
      descriptor: `${researchArtifactKey(runId, "analyze")} (${ideaCount} ideas)`,
    };
  });

  registry.register(EVALUATE_APPLY_STEP, async (ctx) => {
    const params = (ctx.params ?? {}) as {
      runId?: string;
      userLogin?: string;
    };
    const runId = params.runId || ctx.jobId.replace(/^research:/, "");
    const userLogin = params.userLogin || "";
    if (!userLogin) {
      throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
    }
    try {
      const evaluation = deps.runEvaluateStage
        ? await deps.runEvaluateStage({
            runId,
            userLogin,
            evaluationStore: deps.evaluationStore,
          })
        : null;
      if (evaluation && deps.evaluationStore) {
        deps.evaluationStore.saveEvaluation(runId, JSON.stringify(evaluation));
      }
      return {
        output: evaluation,
        descriptor: `${researchArtifactKey(runId, "evaluate")} (${evaluation ? evaluation.aggregates.evaluated : 0} evaluated)`,
      };
    } catch (err) {
      structuredLog.error("researchPipelineJobs.evaluate_apply_failed", {
        jobId: ctx.jobId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(codedMessage("FAILURE_RESEARCH_EVALUATE_FAILED"));
    }
  });

  return registry;
}

/**
 * Default production `ResearchStepDeps` factory (#5237) for host and workflow
 * residencies. Allows overriding `runOodaAnalysis`, `runEvaluateStage`, or
 * `evaluationStore` while ensuring `analyze.ooda` and `evaluate.apply` are
 * always registered in `createPipelineStepRegistry`.
 */
export function createDefaultResearchStepDeps(
  overrides: Partial<ResearchStepDeps> & { allowTestStub?: boolean } = {},
): ResearchStepDeps {
  return {
    runOodaAnalysis:
      overrides.runOodaAnalysis ??
      (async (ctx) => {
        if (!overrides.allowTestStub) {
          throw new Error(
            `FAILURE_RESEARCH_DEPS_MISSING: analyze.ooda for ${ctx.runId} requires explicit production researchDeps.`,
          );
        }
        return {
          ok: true,
          runId: ctx.runId,
          userLogin: ctx.userLogin,
          trigger: ctx.trigger,
        };
      }),
    ...(overrides.runEvaluateStage ? { runEvaluateStage: overrides.runEvaluateStage } : {}),
    ...(overrides.evaluationStore ? { evaluationStore: overrides.evaluationStore } : {}),
  };
}

/**
 * Programme §10 AOP guard for research job execution (#5119):
 * enforces externalized config bounds, owner-scoped identity, and rule flags.
 */
export function assertResearchAopCompliance(
  config: ResearchJobConfig = DEFAULT_RESEARCH_JOB_CONFIG,
  ctx: { userLogin?: string },
): void {
  if (!ctx.userLogin?.trim()) {
    throw new Error(codedMessage("FAILURE_RESEARCH_OWNER_MISSING"));
  }
  if (
    !RESEARCH_AOP_RULES.storedDataOnly ||
    !RESEARCH_AOP_RULES.durableResumableStages ||
    !RESEARCH_AOP_RULES.ownerScopedReads ||
    !RESEARCH_AOP_RULES.cappedParallel ||
    !RESEARCH_AOP_RULES.fullProvenance
  ) {
    throw new Error("Research AOP invariants violated");
  }
  if (config.oodaBudgetMs <= 0 || config.maxParallelCandidates < 1) {
    throw new Error("Invalid externalized ResearchJobConfig bounds");
  }
}

export interface ResearchJobDefinitionConfig {
  /** Issue #5916 — per-stage execution-mode overrides (config-driven). */
  stageModes?: import("../config/researchJobConfig").ResearchStageModes;
  userLogin: string;
  trigger: "manual" | "scheduled";
  sourceId?: string;
  dataset?: string;
  cron?: string;
}

/**
 * Build the declarative `research:<runId>` engine job definition across the
 * 6-stage `jobs` family (`feed`, `enrich`, `analyze`, `generate`, `deliver`, `evaluate`).
 */
export function buildResearchJobDefinition(
  runId: string,
  config: ResearchJobDefinitionConfig,
) {
  const spec = jobDefinitionSpec("research");
  const bound = bindJobDefinitionParams(
    spec,
    {
      runId,
      ...(config.sourceId !== undefined ? { sourceId: config.sourceId } : {}),
      ...(config.dataset !== undefined ? { dataset: config.dataset } : {}),
      trigger: config.trigger,
      ...(config.cron !== undefined ? { cron: config.cron } : {}),
    },
    config.userLogin,
  );
  const jobId = researchEngineJobId(runId);
  const sourceId = String(bound.sourceId ?? "primary-feed");
  const dataset = String(bound.dataset ?? "quotes");
  const built = buildJobConfigFromSpec(spec, jobId, bound);
  const rawRoot = built.root as Record<string, unknown> & {
    children?: Array<Record<string, unknown>>;
  };
  // Issue #5916 — a stage's own mode wins over the job's, per axis.
  const stageModes = config.stageModes ?? {};
  const withStageMode = <T extends Record<string, unknown>>(node: T): T => {
    const override = stageModes[node.kind as keyof typeof stageModes];
    if (!override) return node;
    const existing = (node.executionMode ?? {}) as Record<string, unknown>;
    return { ...node, executionMode: { ...existing, ...override } };
  };
  const children = (rawRoot.children ?? []).map((child) => {
    if (child.kind === "feed") {
      return withStageMode({
        ...child,
        inputs: { sources: [sourceId], datasets: [dataset] },
        steps: [{ step: RESEARCH_FEED_STEP, params: { runId } }],
      });
    }
    if (child.kind === "enrich") {
      return withStageMode({
        ...child,
        inputs: { sources: [sourceId], datasets: [dataset] },
        steps: [{ step: RESEARCH_ENRICH_STEP, params: { runId } }],
      });
    }
    if (child.kind === "generate") {
      return withStageMode({ ...child, steps: [{ step: RESEARCH_GENERATE_STEP, params: { runId } }] });
    }
    if (child.kind === "deliver") {
      return withStageMode({ ...child, steps: [{ step: RESEARCH_DELIVER_STEP, params: { runId } }] });
    }
    return withStageMode(child);
  });

  return {
    jobId: built.jobId,
    name: `Nightly OODA Research (${runId})`,
    root: {
      ...rawRoot,
      inputs: { sources: [sourceId], datasets: [dataset] },
      steps: [{ step: "noop" }],
      schedule: bound.cron
        ? { enabled: true, cron: String(bound.cron) }
        : { enabled: false },
      children,
    },
  };
}
