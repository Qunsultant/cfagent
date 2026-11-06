/**
 * Issue #3071 (#3069 S1) — the workflow catalog: the one typed declaration
 * of which workflows can be run and what each of their stages is.
 *
 * Why a declaration and not a doc: #3069 R3 requires every stage to support
 * the same four mode axes, R4 requires durability/retry/resume, R5/R8
 * require all of it surfaced in the UI, and the control plane has to address
 * a stage by (workflow, stage). All four need the same facts in one place
 * that code can read and a pin can refuse.
 *
 * Reuse, not a second model: stage ids are `StageName` (messaging port),
 * the retry buckets are `pipelinePolicy`'s, checkpoints are the #3028
 * projection, and the pub/sub seam is the #2869 stage message. This module
 * adds no runtime behaviour — it declares what the runtime must satisfy, and
 * `assertWorkflowCatalog` refuses a declaration that does not.
 */

import { STAGE_NAMES, type StageName } from "../messaging/messagingPorts";
import {
  OPTIONS_PIPELINE_STAGES,
  PAYMENT_STEP_IDS,
  SAGA_STEP_IDS,
  TRADE_APPROVAL_STEP_IDS,
} from "./stageRuntimeIds";
import type { StageRetryBucket } from "./stageRunnerPorts";

/** The families the programme covers. */
export type WorkflowFamily =
  | "stock"
  | "options"
  | "trading"
  | "payment"
  | "saga"
  | "goal"
  | "strategy";

/** The four mode axes (#3069 R3). Every stage declares all four. */
export interface StageModes {
  /** Inline caller-waits, or a job/queue. */
  timing: readonly ("sync" | "async")[];
  /** One unit at a time, or a capped fan-out. */
  concurrency: readonly ("sequential" | "parallel")[];
  /** Whole set at once, or one unit per invocation. */
  volume: readonly ("batch" | "online")[];
  /** One partition per run, or partitioned across runs. */
  partitioning: readonly ("sharded" | "monolithic")[];
}

/** What one stage declares about itself. */
export interface StageDeclaration {
  stage: StageName;
  /** Human label key — resolved through the message catalog at render time. */
  labelKey: string;
  /** Human label the UI renders (externalized data, never a literal in a component). */
  label: string;
  /** What the stage persists before announcing (an artifact kind, never bulk data). */
  persists: string;
  /**
   * The stage-message ids this stage publishes (the #2869 seam). One entry per
   * runtime id that emits a boundary, so a stage with five steps publishes
   * five topics - the old single-topic field under-declared every such stage,
   * stock's feed included. A stage of a seam-wired family must publish exactly
   * its own runtime ids; an unwired family publishes nothing.
   *
   * Was: the stage-message id this stage publishes (the #2869 seam). Non-null only
   * where the family actually wires the seam; for an unwired family this is
   * null and the page says so, instead of naming a topic nobody emits.
   */
  publishes: readonly string[];
  /** The previous stage's seam topic, or null where the seam is unwired. */
  consumesStageMessage: string | null;
  /**
   * Issue #3166: the runtime stage ids (`StockStageId` for stock) this
   * declared stage executes, in order. Absent = the family is not mapped to
   * the runtime yet, and the page says so rather than implying coverage.
   */
  runtimeStageIds?: readonly string[];
  /** The previous stage's artifact the stage consumes, or null for the entry stage. */
  consumes: string | null;
  modes: StageModes;
  /** The pipelinePolicy bucket this stage's retries resolve from. */
  retryBucket: StageRetryBucket;
  /** True when the stage checkpoints its position (#3028 projection). */
  checkpointed: true;
  /** True when the stage needs a human approval before it may execute. */
  requiresApproval: boolean;
}

/** One runnable workflow. */
export interface WorkflowDeclaration {
  /** Stable id used by the control plane and the UI. */
  id: string;
  family: WorkflowFamily;
  labelKey: string;
  /** Human label, externalized here (data, not a literal in a component). */
  label: string;
  /**
   * Issue #3174: true only where the #2869 stage-message seam is actually
   * wired for this family. False means the stages are declared as the shape
   * the workflow executes, with no published topics claimed.
   */
  stageSeam: boolean;
  /**
   * Issue #3174: the workflow's real `step.do` ids (or stage ids where they
   * exist), so the page can show what actually runs without pretending they
   * are stage-message topics.
   */
  runtimeSteps: readonly string[];
  /**
   * Issue #3174: named gap when the family has no runtime mapping declared
   * yet. Rendered verbatim; never silently omitted.
   */
  runtimeMappingGap?: string;
  /**
   * True only when a verified submission path exists. The catalog UI may
   * offer Run only for these; a read-only entry names the missing runner.
   */
  runnable: boolean;
  /**
   * Issue #3074: where a runnable workflow is started — the application URL
   * of its existing, gated submission surface (never a second submission
   * path invented here, and never a bypass of that surface's flags/payment
   * gates). Null exactly when `runnable` is false.
   */
  runPath: string | null;
  stages: readonly StageDeclaration[];
}

/** The stage labels the UI renders (externalized data, one place). */
export const STAGE_LABELS: Record<StageName, string> = {
  feed: "Feed (quotes)",
  gather: "Gather (enrichment)",
  analysis: "Analysis (screen)",
  store: "Store (canonical report)",
  serve: "Serve (report availability)",
  deliver: "Deliver (channels)",
};

const ALL_MODES: StageModes = {
  timing: ["sync", "async"],
  concurrency: ["sequential", "parallel"],
  volume: ["batch", "online"],
  partitioning: ["sharded", "monolithic"],
};

function stage(
  name: StageName,
  over: Partial<StageDeclaration> & Pick<StageDeclaration, "persists" | "publishes">,
): StageDeclaration {
  return {
    stage: name,
    labelKey: `workflow.stage.${name}`,
    label: STAGE_LABELS[name],
    consumes: null,
    consumesStageMessage: null,
    modes: ALL_MODES,
    retryBucket: name === "deliver" ? "delivery" : name === "store" || name === "serve" ? "report" : "acquisition",
    checkpointed: true,
    requiresApproval: false,
    ...over,
  };
}

/**
 * The stock screener: the first family (#3069 S1). Six stages in canonical
 * order, each a producer/consumer on the #2869 seam.
 */
const STOCK_SCREENER: WorkflowDeclaration = {
  id: "stock-screener",
  family: "stock",
  labelKey: "workflow.stock-screener",
  label: "Stock screener",
  stageSeam: true,
  runtimeSteps: [
    "plan",
    "brokerStart",
    "acquireUniverse",
    "fetchQuotes",
    "enrich",
    "computeIndicatorsAndScores",
    "applyFilters",
    "rankAndGrade",
    "detectStandouts",
    "persistCanonicalResults",
    "analysis-done",
    "shapeReport",
    "deliver",
  ],
  runnable: true,
  runPath: "?tab=stock-hub&view=new-screen",
  stages: [
    stage("feed", { persists: "quotes", publishes: ["plan", "brokerStart", "acquireUniverse", "fetchQuotes"], consumes: null, runtimeStageIds: ["plan", "brokerStart", "acquireUniverse", "fetchQuotes"] }),
    stage("gather", { persists: "enrichment", publishes: ["enrich", "computeIndicatorsAndScores"], consumes: "quotes", runtimeStageIds: ["enrich", "computeIndicatorsAndScores"] }),
    stage("analysis", { persists: "screen-result", publishes: ["applyFilters", "rankAndGrade", "detectStandouts"], consumes: "enrichment", runtimeStageIds: ["applyFilters", "rankAndGrade", "detectStandouts"] }),
    stage("store", { persists: "canonical-report", publishes: ["persistCanonicalResults", "analysis-done"], consumes: "screen-result", runtimeStageIds: ["persistCanonicalResults", "analysis-done"] }),
    stage("serve", { persists: "served-report", publishes: ["shapeReport"], consumes: "canonical-report", runtimeStageIds: ["shapeReport"] }),
    stage("deliver", { persists: "delivery-state", publishes: ["deliver"], consumes: "served-report", runtimeStageIds: ["deliver"] }),
  ],
};

/** The options screener: second family, same seam, per-format store legs.
 * Issue #3186 (step 3d): the runtime is the one options pipeline - the
 * catalog's display stages partition its eight execution stages (feed
 * covers plan/chainFetch/enrich/screen/risk; store covers
 * persistCanonicalResults; serve covers shapeReport; deliver covers
 * deliver). The legacy #3191 phases are retired (their only publisher
 * was the #3072 emitter, called only by the manual handler). */
const OPTIONS_SCREENER: WorkflowDeclaration = {
  id: "options-screener",
  family: "options",
  labelKey: "workflow.options-screener",
  label: "Options screener",
  stageSeam: true,
  runtimeSteps: OPTIONS_PIPELINE_STAGES,
  runnable: true,
  runPath: "?tab=options-screener",
  stages: [
    stage("feed", {
      persists: "options-chains",
      publishes: ["plan", "chainFetch", "enrich", "screen", "risk"],
      consumes: null,
      runtimeStageIds: ["plan", "chainFetch", "enrich", "screen", "risk"],
    }),
    stage("store", {
      persists: "canonical-report",
      publishes: ["persistCanonicalResults"],
      consumes: "options-chains",
      runtimeStageIds: ["persistCanonicalResults"],
    }),
    stage("serve", {
      persists: "served-report",
      publishes: ["shapeReport"],
      consumes: "canonical-report",
      runtimeStageIds: ["shapeReport"],
    }),
    stage("deliver", {
      persists: "delivery-state",
      publishes: ["deliver"],
      consumes: "served-report",
      runtimeStageIds: ["deliver"],
    }),
  ],
};

/** The trading leg: approval-gated before execution (#3073). */
const TRADING_LEG: WorkflowDeclaration = {
  id: "trading-leg",
  family: "trading",
  labelKey: "workflow.trading-leg",
  label: "Trading leg",
  stageSeam: true,
  runtimeSteps: TRADE_APPROVAL_STEP_IDS,
  runnable: false,
  runPath: null,
  stages: [
    // Two stages, because the flow has two: no feed and no separate delivery
    // stage exist in TradingTradeWorkflow (#3191 removed the invented four).
    stage("analysis", {
      persists: "approval-decision",
      publishes: ["await-approval"],
      consumes: null,
      requiresApproval: true,
      runtimeStageIds: ["await-approval"],
    }),
    stage("store", {
      persists: "settlement",
      publishes: ["settle-trade"],
      consumes: "approval-decision",
      requiresApproval: true,
      runtimeStageIds: ["settle-trade"],
    }),
  ],
};

/** Payment: the charged path, gate-checked before anything is confirmed. */
const PAYMENT_RUN: WorkflowDeclaration = {
  id: "payment-run",
  family: "payment",
  labelKey: "workflow.payment-run",
  label: "Payment run",
  stageSeam: true,
  runtimeSteps: [
    "gate-check",
    "record-checkout",
    "record-approval",
    "confirm-paid",
    "record-payment",
    "record-native-ledger",
    "record-usage",
  ],

  runnable: false,
  runPath: null,
  stages: [
    stage("analysis", {
      persists: "gate-decision",
      publishes: ["gate-check", "record-coverage-required", "consume-coverage"],
      consumes: null,
      runtimeStageIds: ["gate-check", "record-coverage-required", "consume-coverage"],
    }),
    stage("store", {
      persists: "payment-record",
      publishes: [
        "record-checkout",
        "record-approval",
        "record-expiry",
        "record-rejection",
        "record-payment",
      ],
      consumes: "gate-decision",
      runtimeStageIds: [
        "record-checkout",
        "record-approval",
        "record-expiry",
        "record-rejection",
        "record-payment",
      ],
    }),
    stage("deliver", {
      persists: "checkout-state",
      publishes: ["confirm-paid", "record-native-ledger", "record-usage", "issue-failure-credit", "start-screener"],
      consumes: "payment-record",
      requiresApproval: true,
      runtimeStageIds: ["confirm-paid", "record-native-ledger", "record-usage", "issue-failure-credit", "start-screener"],
    }),
  ],
};

/** Saga: one cross-domain journey, payment leg then screen leg, compensable. */
const SAGA_RUN: WorkflowDeclaration = {
  id: "saga-run",
  family: "saga",
  labelKey: "workflow.saga-run",
  label: "Goal saga",
  stageSeam: true,
  runtimeSteps: [
    "record-audit-saga-started",
    "start-payment-leg",
    "record-audit-payment-started",
    "record-audit-screen-completed",
    "compensate-failed-screen",
  ],

  runnable: false,
  runPath: null,
  stages: [
    stage("feed", {
      persists: "payment-leg",
      publishes: ["record-audit-saga-started", "start-payment-leg", "record-audit-payment-started"],
      consumes: null,
      requiresApproval: true,
      runtimeStageIds: ["record-audit-saga-started", "start-payment-leg", "record-audit-payment-started"],
    }),
    stage("analysis", {
      persists: "screen-leg",
      publishes: ["record-audit-screen-completed"],
      consumes: "payment-leg",
      runtimeStageIds: ["record-audit-screen-completed"],
    }),
    stage("deliver", {
      persists: "compensation-state",
      publishes: ["compensate-failed-screen"],
      consumes: "screen-leg",
      runtimeStageIds: ["compensate-failed-screen"],
    }),
  ],
};

/** Goal screen: runs on the screener workflow, goal-shaped request. */
const GOAL_SCREEN: WorkflowDeclaration = {
  id: "goal-screen",
  family: "goal",
  labelKey: "workflow.goal-screen",
  label: "Goal screen",
  stageSeam: false,
  runtimeSteps: [],
  runtimeMappingGap:
    "goal runs execute through the screener workflow with a goal command; their stage ids are the stock seam's, not separately declared (#3072).",
  runnable: false,
  runPath: null,
  stages: [
    stage("feed", { persists: "goal-universe", publishes: [], consumes: null }),
    stage("analysis", { persists: "goal-matches", publishes: [], consumes: "goal-universe" }),
    stage("store", { persists: "goal-report", publishes: [], consumes: "goal-matches" }),
    stage("deliver", { persists: "goal-outcome", publishes: [], consumes: "goal-report" }),
  ],
};

/** Strategy discovery: ranked strategies, no artifacts by design. */
const STRATEGY_DISCOVERY: WorkflowDeclaration = {
  id: "strategy-discovery",
  family: "strategy",
  labelKey: "workflow.strategy-discovery",
  label: "Strategy discovery",
  stageSeam: false,
  runtimeSteps: ["feed", "analysis", "generation", "delivery"],
  runtimeMappingGap:
    "strategy stages are recorded on the unified run record (UnifiedStrategyStage), not as stage-message topics (#3073).",
  runnable: true,
  runPath: "?tab=options-screener",
  stages: [
    stage("analysis", { persists: "ranked-strategies", publishes: [], consumes: null }),
    stage("store", { persists: "canonical-run-record", publishes: [], consumes: "ranked-strategies" }),
    stage("deliver", { persists: "delivery-state", publishes: [], consumes: "canonical-run-record" }),
  ],
};

/** Every workflow the catalogue knows. */
export const WORKFLOW_CATALOG: readonly WorkflowDeclaration[] = [
  STOCK_SCREENER,
  OPTIONS_SCREENER,
  TRADING_LEG,
  PAYMENT_RUN,
  SAGA_RUN,
  GOAL_SCREEN,
  STRATEGY_DISCOVERY,
];

/** The catalog as the UI reads it (stable ordering by id). */
export function listWorkflows(): readonly WorkflowDeclaration[] {
  return [...WORKFLOW_CATALOG].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One workflow by id, or null. */
export function workflowById(id: string): WorkflowDeclaration | null {
  return WORKFLOW_CATALOG.find((workflow) => workflow.id === id) ?? null;
}

/**
 * Assert the catalog's invariants. Refuses loudly rather than rendering a
 * half-declared workflow: a duplicate id, an empty stage list, an unknown
 * stage name, stages out of canonical order, or a stage missing one of the
 * four mode axes is a defect in the declaration, not a UI condition.
 */
export function assertWorkflowCatalog(
  catalog: readonly WorkflowDeclaration[] = WORKFLOW_CATALOG,
): void {
  if (catalog.length === 0) throw new Error("Workflow catalog refused: it is empty.");
  const seen = new Set<string>();
  for (const workflow of catalog) {
    if (!workflow.id.trim()) throw new Error("Workflow catalog refused: a workflow carries no id.");
    if (seen.has(workflow.id)) {
      throw new Error(`Workflow catalog refused: duplicate workflow id ${workflow.id}.`);
    }
    seen.add(workflow.id);
    for (const stageDeclaration of workflow.stages) {
      const topics = stageDeclaration.publishes;
      if (workflow.stageSeam) {
        // Issue #3072/#3073: a wired stage publishes one boundary per runtime
        // step it executes - not a summary of them. Anything else is a claim
        // about messages nobody sends.
        const stagesIds = stageDeclaration.runtimeStageIds ?? [];
        if (topics.length === 0) {
          throw new Error(
            `Workflow catalog refused: ${workflow.id}/${stageDeclaration.stage} is in a seam-wired workflow but publishes nothing.`,
          );
        }
        if (topics.join("|") !== stagesIds.join("|")) {
          throw new Error(
            `Workflow catalog refused: ${workflow.id}/${stageDeclaration.stage} publishes [${topics.join(", ")}] but executes [${stagesIds.join(", ")}]; a seam-wired stage publishes exactly its runtime steps.`,
          );
        }
      } else if (topics.length > 0) {
        throw new Error(
          `Workflow catalog refused: ${workflow.id}/${stageDeclaration.stage} publishes topics for a family whose seam is not wired.`,
        );
      }
    }
    if (!workflow.label.trim()) {
      throw new Error(`Workflow catalog refused: ${workflow.id} carries no human label.`);
    }
    if (workflow.runnable && !workflow.runPath) {
      throw new Error(
        `Workflow catalog refused: ${workflow.id} is runnable but names no runPath (the catalog must link a verified submission surface, never invent one).`,
      );
    }
    if (!workflow.runnable && workflow.runPath) {
      throw new Error(
        `Workflow catalog refused: ${workflow.id} is not runnable but declares a runPath.`,
      );
    }
    if (workflow.stages.length === 0) {
      throw new Error(`Workflow catalog refused: workflow ${workflow.id} declares no stages.`);
    }
    let lastIndex = -1;
    const seenRuntimeIds = new Set<string>();
    for (const stageDeclaration of workflow.stages) {
      if (!STAGE_NAMES.includes(stageDeclaration.stage)) {
        throw new Error(
          `Workflow catalog refused: ${workflow.id} declares unknown stage ${String(stageDeclaration.stage)}.`,
        );
      }
      const index = STAGE_NAMES.indexOf(stageDeclaration.stage);
      if (index <= lastIndex) {
        throw new Error(
          `Workflow catalog refused: ${workflow.id} declares stages out of canonical order (${workflow.stages
            .map((s) => s.stage)
            .join(" → ")}).`,
        );
      }
      lastIndex = index;
      for (const axis of ["timing", "concurrency", "volume", "partitioning"] as const) {
        const modes = stageDeclaration.modes[axis];
        if (!Array.isArray(modes) || modes.length === 0) {
          throw new Error(
            `Workflow catalog refused: ${workflow.id}/${stageDeclaration.stage} declares no ${axis} mode (#3069 R3 requires all four axes).`,
          );
        }
      }
      if (!stageDeclaration.label.trim()) {
        throw new Error(
          `Workflow catalog refused: ${workflow.id}/${stageDeclaration.stage} carries no human label.`,
        );
      }
      for (const runtimeId of stageDeclaration.runtimeStageIds ?? []) {
        if (seenRuntimeIds.has(runtimeId)) {
          throw new Error(
            `Workflow catalog refused: ${workflow.id} assigns runtime stage id ${runtimeId} to two stages.`,
          );
        }
        seenRuntimeIds.add(runtimeId);
      }
      if (!stageDeclaration.checkpointed) {
        throw new Error(
          `Workflow catalog refused: ${workflow.id}/${stageDeclaration.stage} is not checkpointed (#3069 R4).`,
        );
      }
    }
  }
}
