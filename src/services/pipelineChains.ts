/**
 * Issue #3540 (Pipeline J7) — the pipeline-chain registry: the
 * composed feed → enrich → analyze → generate → deliver chain
 * as a first-class, named entity.
 *
 * J2–J6 (#3535–#3539) landed the five stage families as separate
 * pipeline jobs, chained by the host's completion intake. What
 * J7 adds is the COMPOSITION as one schedulable pipeline: one
 * chain per quotes lineage, defined over the SAME stage jobs —
 * the chain is a J1 job whose children ARE the stage jobs'
 * definitions (see chainPipelineJobs.ts), so a chain run and
 * the standalone stage jobs execute the identical steps over
 * the identical persisted datasets, and every stage stays
 * individually schedulable, configurable, and manageable.
 *
 * This module is the registry half (the deliverJobs.ts idiom):
 * chain definitions DERIVED from the five stage registries —
 * never a second hand-written lineage table. The fundamentals
 * feed job joins the yahoo chain because the yahoo enrich job's
 * own `enrichFrom` declares it as a join source; there is no
 * provider special case here.
 */
import { buildFeedJobRegistry } from "./feedJobs";
import { buildEnrichJobRegistry } from "./enrichJobs";
import { buildAnalyzeJobRegistry } from "./analyzeJobs";
import { buildGenerateJobRegistry } from "./generateJobs";
import { buildDeliverJobRegistry } from "./deliverJobs";

/** Refusal codes for the chain surface (named, never silent). */
export const PIPELINE_CHAIN_CODES = {
  chainNotFound: "PIPELINE_CHAIN_NOT_FOUND",
  chainNotConfigured: "PIPELINE_CHAIN_NOT_CONFIGURED",
  stageUnknown: "PIPELINE_CHAIN_STAGE_UNKNOWN",
} as const;
export type PipelineChainCode =
  (typeof PIPELINE_CHAIN_CODES)[keyof typeof PIPELINE_CHAIN_CODES];

/** The chain's stage vocabulary, in chain order. */
export type PipelineChainStageKind =
  | "feed"
  | "enrich"
  | "analyze"
  | "generate"
  | "deliver";

export const PIPELINE_CHAIN_STAGE_ORDER: readonly PipelineChainStageKind[] = [
  "feed",
  "enrich",
  "analyze",
  "generate",
  "deliver",
];

/** One stage of a chain: the stage kind, the stage job that
 *  executes it, and the node path addressing it inside the
 *  chain job's definition (the #3549 stage-op address). */
export interface PipelineChainStageRef {
  stage: PipelineChainStageKind;
  jobId: string;
  nodePath: string;
}

/** One child node of a chain job. The fundamentals feed node
 *  (yahoo lineage) folds into the feed stage for roll-up
 *  purposes — it is a feed-stage input, not a sixth stage. */
export interface PipelineChainNodeRef {
  nodePath: string;
  stage: PipelineChainStageKind;
  jobId: string;
}

/**
 * One composed pipeline chain. `id` is the chain JOB's id (the
 * lineage's feed job id + "-pipeline"); the stage job ids are
 * the lineage's own job ids, unchanged.
 */
export interface PipelineChainDefinition {
  id: string;
  feedJobId: string;
  /** The fundamentals feed job feeding the enrich join, when
   *  the lineage's enrich job declares one (yahoo); else null. */
  fundamentalsJobId: string | null;
  enrichJobId: string;
  analyzeJobId: string;
  generateJobId: string;
  deliverJobId: string;
  sourceId: string;
  dataset: string;
  universe: string;
  /** The chain's own cadence (the schedule on the chain job's
   *  root): the PIPELINE_CHAIN_<ID>_CADENCE_MINUTES knob, else
   *  the head feed job's cadence. Stage jobs keep their own
   *  cadences — the chain schedule is an ADDITIONAL door into
   *  the same stages, not a replacement. */
  cadenceMinutes: number;
  /** The five stages, in chain order. */
  stages: PipelineChainStageRef[];
  /** Every child node of the chain job, in execution order
   *  (the fundamentals node precedes enrich, folded to feed). */
  nodes: PipelineChainNodeRef[];
}

/**
 * Node paths inside the chain job definition use the engine's
 * child-index addressing (the J1 model has no node names), and
 * the composition is NESTED — each stage is the single child
 * of the stage before it — so the feed stage is the root (""),
 * the fundamentals input (when the lineage has one) is "0",
 * enrich is "0/0" (or "0" without fundamentals), and so on.
 * Nesting is the shape the engine's hand-off rule assumes:
 * a stage's persisted input is its PARENT stage's output, and
 * in a chain the parent IS the previous stage — so the uniform
 * stage actions (run / re-run from persisted input, #3549)
 * resolve a real hand-off at every stage. A flat container
 * root would hand its children a null hand-off and refuse
 * those actions by name.
 */
export function chainChildPath(parentPath: string): string {
  return parentPath === "" ? "0" : `${parentPath}/0`;
}

/** The node path addressing one stage of a chain (stage ops). */
export function chainStageNodePath(
  chain: PipelineChainDefinition,
  stage: PipelineChainStageKind,
): string {
  const ref = chain.stages.find((s) => s.stage === stage);
  if (!ref) {
    throw new Error(
      `Pipeline chain "${chain.id}" has no "${stage}" stage.`,
    );
  }
  return ref.nodePath;
}

function knobKey(jobId: string, suffix: string): string {
  return `PIPELINE_CHAIN_${jobId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function resolveMinutesKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  suffix: string,
  fallback: number,
): number {
  const raw = env[knobKey(jobId, suffix)];
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The chain registry — the FeedJobRegistry idiom (unique ids,
 * re-registering throws; explicit resolution failure, no silent
 * fallback).
 */
export class PipelineChainRegistry {
  private chains = new Map<string, PipelineChainDefinition>();

  register(chain: PipelineChainDefinition): void {
    if (this.chains.has(chain.id)) {
      throw new Error(`Pipeline chain "${chain.id}" is already registered.`);
    }
    this.chains.set(chain.id, chain);
  }

  forId(id: string): PipelineChainDefinition | undefined {
    return this.chains.get(id);
  }

  forFeedJob(feedJobId: string): PipelineChainDefinition | undefined {
    return [...this.chains.values()].find((c) => c.feedJobId === feedJobId);
  }

  /** The chain containing a stage job, when the job is one. */
  forStageJob(jobId: string): PipelineChainDefinition | undefined {
    return [...this.chains.values()].find((c) =>
      c.nodes.some((n) => n.jobId === jobId),
    );
  }

  list(): PipelineChainDefinition[] {
    return [...this.chains.values()];
  }
}

/**
 * Build the chain registry from the five stage registries over
 * the worker env — one chain per QUOTES feed job, its lineage
 * resolved through the stage registries' own lineage lookups
 * (forFeedJob → forEnrichJob → forAnalyzeJob → forGenerateJob).
 * A quotes lineage missing any stage throws BY NAME: the
 * catalog is derived, and a broken derivation is a build-time
 * fact, never a runtime surprise.
 */
export function buildPipelineChainRegistry(
  env: Record<string, string | undefined>,
): PipelineChainRegistry {
  const feedRegistry = buildFeedJobRegistry(env);
  const enrichRegistry = buildEnrichJobRegistry(env);
  const analyzeRegistry = buildAnalyzeJobRegistry(env);
  const generateRegistry = buildGenerateJobRegistry(env);
  const deliverRegistry = buildDeliverJobRegistry(env);
  const registry = new PipelineChainRegistry();
  for (const feed of feedRegistry.list()) {
    if (feed.dataset !== "quotes") continue;
    const enrich = enrichRegistry.forFeedJob(feed.id);
    const analyze = enrich ? analyzeRegistry.forEnrichJob(enrich.id) : undefined;
    const generate = analyze
      ? generateRegistry.forAnalyzeJob(analyze.id)
      : undefined;
    const deliver = generate
      ? deliverRegistry.forGenerateJob(generate.id)
      : undefined;
    if (!enrich || !analyze || !generate || !deliver) {
      throw new Error(
        `Pipeline chain lineage for feed job "${feed.id}" is incomplete ` +
          `(enrich: ${enrich?.id ?? "missing"}, analyze: ${analyze?.id ?? "missing"}, ` +
          `generate: ${generate?.id ?? "missing"}, deliver: ${deliver?.id ?? "missing"}); ` +
          `the chain catalog is derived from the stage registries and refuses a partial chain.`,
      );
    }
    const fundamentalsJobId =
      enrich.enrichFrom.find((s) => s.dataset === "fundamentals")?.feedJobId ??
      null;
    const id = `${feed.id}-pipeline`;
    const orderedNodes: Array<{
      stage: PipelineChainStageKind;
      jobId: string;
    }> = [
      { stage: "feed", jobId: feed.id },
      ...(fundamentalsJobId
        ? [{ stage: "feed" as const, jobId: fundamentalsJobId }]
        : []),
      { stage: "enrich", jobId: enrich.id },
      { stage: "analyze", jobId: analyze.id },
      { stage: "generate", jobId: generate.id },
      { stage: "deliver", jobId: deliver.id },
    ];
    const nodes: PipelineChainNodeRef[] = [];
    let path = "";
    for (const node of orderedNodes) {
      nodes.push({ ...node, nodePath: path });
      path = chainChildPath(path);
    }
    const stages: PipelineChainStageRef[] = (
      [
        ["feed", feed.id],
        ["enrich", enrich.id],
        ["analyze", analyze.id],
        ["generate", generate.id],
        ["deliver", deliver.id],
      ] as Array<[PipelineChainStageKind, string]>
    ).map(([stage, jobId]) => ({
      stage,
      jobId,
      nodePath: nodes.find((node) => node.jobId === jobId)!.nodePath,
    }));
    registry.register({
      id,
      feedJobId: feed.id,
      fundamentalsJobId,
      enrichJobId: enrich.id,
      analyzeJobId: analyze.id,
      generateJobId: generate.id,
      deliverJobId: deliver.id,
      sourceId: feed.sourceId,
      dataset: feed.dataset,
      universe: feed.universe.label,
      cadenceMinutes: resolveMinutesKnob(
        env,
        id,
        "CADENCE_MINUTES",
        feed.cadenceMinutes,
      ),
      stages,
      nodes,
    });
  }
  return registry;
}
