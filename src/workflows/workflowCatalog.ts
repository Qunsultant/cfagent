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
  /** What the stage persists before announcing (an artifact kind, never bulk data). */
  persists: string;
  /** The stage-message id this stage publishes (the #2869 seam). */
  publishes: string;
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
    consumes: null,
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
  runnable: true,
  runPath: "?tab=stock-hub&view=new-screen",
  stages: [
    stage("feed", { persists: "quotes", publishes: "feed-done", consumes: null }),
    stage("gather", { persists: "enrichment", publishes: "gather-done", consumes: "quotes" }),
    stage("analysis", { persists: "screen-result", publishes: "analysis-done", consumes: "enrichment" }),
    stage("store", { persists: "canonical-report", publishes: "store-done", consumes: "screen-result" }),
    stage("serve", { persists: "served-report", publishes: "serve-done", consumes: "canonical-report" }),
    stage("deliver", { persists: "delivery-state", publishes: "deliver-done", consumes: "served-report" }),
  ],
};

/** The options screener: second family, same seam, per-format store legs. */
const OPTIONS_SCREENER: WorkflowDeclaration = {
  id: "options-screener",
  family: "options",
  labelKey: "workflow.options-screener",
  runnable: true,
  runPath: "?tab=options-screener",
  stages: [
    stage("feed", { persists: "options-chains", publishes: "feed-done", consumes: null }),
    stage("gather", { persists: "enrichment", publishes: "gather-done", consumes: "options-chains" }),
    stage("analysis", { persists: "strategy-candidates", publishes: "analysis-done", consumes: "enrichment" }),
    stage("store", { persists: "per-format-artifacts", publishes: "store-done", consumes: "strategy-candidates" }),
    stage("serve", { persists: "served-report", publishes: "serve-done", consumes: "per-format-artifacts" }),
    stage("deliver", { persists: "delivery-state", publishes: "deliver-done", consumes: "served-report" }),
  ],
};

/** The trading leg: approval-gated before execution (#3073). */
const TRADING_LEG: WorkflowDeclaration = {
  id: "trading-leg",
  family: "trading",
  labelKey: "workflow.trading-leg",
  runnable: false,
  runPath: null,
  stages: [
    stage("feed", { persists: "quote-snapshot", publishes: "feed-done", consumes: null }),
    stage("analysis", { persists: "preview", publishes: "analysis-done", consumes: "quote-snapshot" }),
    stage("store", {
      persists: "order-draft",
      publishes: "store-done",
      consumes: "preview",
      requiresApproval: true,
    }),
    stage("deliver", { persists: "fill-state", publishes: "deliver-done", consumes: "order-draft" }),
  ],
};

/** Every workflow the catalogue knows. */
export const WORKFLOW_CATALOG: readonly WorkflowDeclaration[] = [
  STOCK_SCREENER,
  OPTIONS_SCREENER,
  TRADING_LEG,
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
      if (!stageDeclaration.checkpointed) {
        throw new Error(
          `Workflow catalog refused: ${workflow.id}/${stageDeclaration.stage} is not checkpointed (#3069 R4).`,
        );
      }
    }
  }
}
