/**
 * Issue #3540 (Pipeline J7, epic #3533) — the composed pipeline
 * chains as J1 pipeline jobs: definitions, name resolution, and
 * the end-to-end status roll-up.
 *
 * The chain definition is DERIVED, never hand-maintained: each
 * node is the corresponding stage job's own root node,
 * transposed from that stage job's current definition with only
 * its schedule removed (the chain root — the feed stage —
 * carries the one chain schedule in place of the feed job's
 * own; the stage jobs keep their own schedules and remain
 * individually schedulable through their own definitions). A
 * stage job reconfigured through configureJob is therefore
 * re-derived into the chain at the next ensure — the ensure
 * every host entry point runs — so the chain can never drift
 * into a forked copy of a stage's parameters.
 *
 * Execution needs no new machinery: the stages compose as a
 * NESTED chain of plain J1 nodes under JobPipelineControl —
 * each stage the single child of the stage before it, which is
 * the shape the engine's persisted hand-off rule assumes (a
 * stage's input is its parent stage's output), so the uniform
 * stage actions (run / re-run / stop / resume / cancel) resolve
 * real hand-offs at every stage. Each stage executes its
 * family's own step, which resolves the stage job's contract
 * from its family registry and reads / persists the stage's
 * dataset stores exactly as the standalone stage job does —
 * one engine, one set of steps, one lineage of persisted
 * artifacts keyed by the run id. A chain run's run id is
 * therefore the lineage key for every stage artifact it
 * produces.
 *
 * Failure semantics are the engine's, surfaced not re-built:
 * a stage step's failure fails the chain run at that child; the
 * run's stage ledger names the frontier; downstream children
 * never execute (their steps' named input refusals are the
 * second line of defence, not the mechanism); resume continues
 * the SAME run id from the persisted checkpoint with completed
 * stages read back from their hand-offs, never re-executed.
 */
import type { DataProviderId } from "../trading";
import type {
  JobDefinition,
  JobNodeConfig,
  JobPipelineStores,
} from "../data/jobPipelinePorts";
import type {
  JobPipelineControl,
  JobStageView,
  JobStatusView,
} from "./jobPipelineEngine";
import { withSchedulePreserved } from "./jobPipelineEngine";
import { FEED_PIPELINE_CATALOG, FEED_PULL_STEP } from "./feedPipelineJobs";
import { buildAllFeedPipelineJobDefinitions } from "./feedPipelineJobs";
import { buildAllEnrichPipelineJobDefinitions } from "./enrichPipelineJobs";
import { buildAllAnalyzePipelineJobDefinitions } from "./analyzePipelineJobs";
import { buildAllGeneratePipelineJobDefinitions } from "./generatePipelineJobs";
import { buildAllDeliverPipelineJobDefinitions } from "./deliverPipelineJobs";
import {
  buildPipelineChainRegistry,
  PIPELINE_CHAIN_STAGE_ORDER,
  type PipelineChainDefinition,
  type PipelineChainStageKind,
} from "./pipelineChains";

/** One catalog entry: how the surfaces name and find a chain. */
export interface ChainPipelineCatalogEntry {
  jobId: string;
  feedJobId: string;
  enrichJobId: string;
  analyzeJobId: string;
  generateJobId: string;
  deliverJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  /** Lower-case name fragments the copilot/UX resolution accepts. */
  aliases: readonly string[];
}

const QUOTES_FEED_ENTRIES = FEED_PIPELINE_CATALOG.filter(
  (e) => e.dataset === "quotes",
);
const SOURCE_JOB_COUNT = new Map<string, number>();
for (const entry of QUOTES_FEED_ENTRIES) {
  SOURCE_JOB_COUNT.set(
    entry.sourceId,
    (SOURCE_JOB_COUNT.get(entry.sourceId) ?? 0) + 1,
  );
}

/**
 * The chain catalog — one entry per quotes lineage, in
 * feed-catalog order. Aliases follow the family idiom: the
 * dataset-qualified "<source>-<dataset>-pipeline" form for
 * every chain, the bare "<source> pipeline" forms only for a
 * source with ONE quotes job (never an ambiguous invention),
 * and the feed aliases suffixed with "pipeline".
 */
export const CHAIN_PIPELINE_CATALOG: readonly ChainPipelineCatalogEntry[] =
  QUOTES_FEED_ENTRIES.map((feed) => {
    const baseAliases = Array.from(
      new Set([
        ...feed.aliases,
        ...feed.aliases
          .filter((a) => a.endsWith(" quotes"))
          .map((a) => a.replace(/ quotes$/, "")),
      ]),
    );
    const registryEntry = {
      jobId: `${feed.jobId}-pipeline`,
      feedJobId: feed.jobId,
      enrichJobId: `${feed.jobId}-enrich`,
      analyzeJobId: `${feed.jobId}-enrich-analyze`,
      generateJobId: `${feed.jobId}-enrich-analyze-generate`,
      deliverJobId: `${feed.jobId}-enrich-analyze-generate-deliver`,
      sourceId: feed.sourceId,
      dataset: feed.dataset,
      label: `Pipeline — ${feed.label}`,
      aliases: [
        ...((SOURCE_JOB_COUNT.get(feed.sourceId) ?? 0) === 1
          ? [`${feed.sourceId} pipeline`, `pipeline ${feed.sourceId}`]
          : []),
        `${feed.sourceId}-${feed.dataset}-pipeline`,
        `${feed.jobId.replace(/-quotes$/, "")}-pipeline`,
        `${feed.jobId}-pipeline`,
        ...baseAliases.map((a) => `${a} pipeline`),
        ...baseAliases.map((a) => `pipeline ${a}`),
      ],
    };
    return registryEntry;
  });

/**
 * Resolve a surface's name for a chain ("alpaca pipeline",
 * "yahoo nasdaq100 pipeline", an exact chain job id) to the
 * catalog entry. Exact job ids win; then exact aliases; then
 * a unique alias the query contains. Ambiguous or unknown
 * names return null — the caller refuses by name rather than
 * guessing (the #2144 rule, the family resolvers' idiom).
 */
export function resolvePipelineChain(
  query: string,
): ChainPipelineCatalogEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === q);
  if (byId) return byId;
  const exact = CHAIN_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => a === q),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = CHAIN_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => q.includes(a)),
  );
  return containing.length === 1 ? containing[0] : null;
}

interface RawJobDefinition {
  jobId: string;
  name?: string;
  root: JobNodeConfig;
}

function rawByJobId(definitions: unknown[]): Map<string, RawJobDefinition> {
  const map = new Map<string, RawJobDefinition>();
  for (const raw of definitions) {
    const def = raw as RawJobDefinition;
    map.set(def.jobId, def);
  }
  return map;
}

function cloneNode(node: JobNodeConfig): JobNodeConfig {
  return JSON.parse(JSON.stringify(node)) as JobNodeConfig;
}

/**
 * The raw J1 definition for one chain: the stage jobs' own root
 * nodes composed as a NESTED chain — the feed stage is the
 * root, and every later stage is the single child of the stage
 * before it (schedules stripped throughout; the root carries
 * the chain's cadence in place of the feed job's own schedule).
 * Nesting matches the engine's hand-off rule (a stage's
 * persisted input is its parent stage's output), so the
 * uniform stage actions resolve a real hand-off at every
 * stage of the chain. Derivation reads the stage jobs' CURRENT
 * built definitions, so it composes whatever configuration the
 * stage registries resolve from the env.
 */
export function buildChainPipelineJobDefinition(
  chain: PipelineChainDefinition,
  stageDefinitions: Map<string, RawJobDefinition>,
): unknown {
  const nodes: JobNodeConfig[] = chain.nodes.map((node) => {
    const stageDef = stageDefinitions.get(node.jobId);
    if (!stageDef) {
      throw new Error(
        `Pipeline chain "${chain.id}": stage job "${node.jobId}" has no built definition — the catalogs have drifted.`,
      );
    }
    const transposed = cloneNode(stageDef.root);
    delete transposed.schedule;
    if (node.jobId === chain.fundamentalsJobId) {
      // #3930 — the fundamentals job is parameterized: the
      // chain's universe is the input for THIS chain's
      // fundamentals node (the standalone job definition
      // carries no universe param — it defaults to nasdaq100).
      // Without this, every chain's fundamentals node would
      // pull the default list and its enrich join — which is
      // universe-matched — would find no copy for its own
      // universe.
      const pull = transposed.steps?.find((s) => s.step === FEED_PULL_STEP);
      if (!pull) {
        throw new Error(
          `Pipeline chain "${chain.id}": fundamentals node "${node.jobId}" has no "${FEED_PULL_STEP}" step to parameterize — the catalogs have drifted.`,
        );
      }
      pull.params = { ...pull.params, universe: chain.universeIndex };
    }
    return transposed;
  });
  // Fold from the last stage up: each node gains the next as
  // its only child.
  let root: JobNodeConfig = nodes[nodes.length - 1];
  for (let i = nodes.length - 2; i >= 0; i--) {
    nodes[i].children = [root];
    root = nodes[i];
  }
  root.schedule = {
    enabled: true,
    interval: `every ${chain.cadenceMinutes} minutes`,
  };
  return {
    jobId: chain.id,
    name: `Pipeline — ${chain.sourceId} ${chain.dataset} (${chain.universe})`,
    root,
  };
}

/** Every raw chain definition, in catalog order. */
export function buildAllChainPipelineJobDefinitions(
  env: Record<string, string | undefined>,
): unknown[] {
  const registry = buildPipelineChainRegistry(env);
  const stageDefinitions = rawByJobId([
    ...buildAllFeedPipelineJobDefinitions(env),
    ...buildAllEnrichPipelineJobDefinitions(env),
    ...buildAllAnalyzePipelineJobDefinitions(env),
    ...buildAllGeneratePipelineJobDefinitions(env),
    ...buildAllDeliverPipelineJobDefinitions(env),
  ]);
  return CHAIN_PIPELINE_CATALOG.map((entry) => {
    const chain = registry.forId(entry.jobId);
    if (!chain) {
      throw new Error(
        `Chain catalog entry "${entry.jobId}" has no chain registered — the catalog and the registry have drifted.`,
      );
    }
    return buildChainPipelineJobDefinition(chain, stageDefinitions);
  });
}

/**
 * Define every chain on a control plane, skipping definitions
 * whose stored raw configuration already matches (the family
 * ensure idiom). Because the chain definition is derived from
 * the stage jobs' CURRENT definitions, callers ensure the stage
 * families BEFORE the chains (the host's ensure-all does), and
 * a stage job reconfigured since the last ensure re-derives its
 * chain here. Returns the chain job ids ensured.
 */
export async function ensureChainPipelineJobs(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const raw of buildAllChainPipelineJobDefinitions(env)) {
    const jobId = (raw as { jobId: string }).jobId;
    const existing = await stores.definitions.getDefinition(jobId);
    // #3530: the stored schedule is operator configuration — a
    // re-definition for other drift must not revert it.
    const effective = withSchedulePreserved(raw, existing);
    if (
      existing &&
      JSON.stringify(existing.rawConfig) === JSON.stringify(effective)
    ) {
      ensured.push(jobId);
      continue;
    }
    await control.defineJob(effective);
    ensured.push(jobId);
  }
  return ensured;
}

/**
 * Re-derive ONE chain's definition from the stage jobs'
 * definitions AS STORED on this control plane (post-configure
 * state included), so a stage job reconfigured through
 * configureJob flows into its chain without waiting for a
 * registry rebuild. Used by the host's chain surface reads and
 * dispatches. Returns the stored chain definition.
 */
export async function refreshChainDefinitionFromStoredStages(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  chain: PipelineChainDefinition,
): Promise<JobDefinition> {
  const stageDefinitions = new Map<string, RawJobDefinition>();
  for (const node of chain.nodes) {
    const stored = await stores.definitions.getDefinition(node.jobId);
    if (!stored) {
      throw new Error(
        `Pipeline chain "${chain.id}": stage job "${node.jobId}" is not defined on this control plane; ensure the stage families before the chains.`,
      );
    }
    stageDefinitions.set(node.jobId, {
      jobId: stored.jobId,
      name: stored.name,
      root: stored.root,
    });
  }
  const raw = buildChainPipelineJobDefinition(chain, stageDefinitions);
  const existing = await stores.definitions.getDefinition(chain.id);
  if (
    existing &&
    JSON.stringify(existing.rawConfig) === JSON.stringify(raw)
  ) {
    return existing;
  }
  return control.defineJob(raw);
}

/* ------------------------------------------------------------------ */
/* The end-to-end status roll-up (UX + copilot — one source of truth)  */
/* ------------------------------------------------------------------ */

/** One stage's rolled-up state inside a chain run. */
export type PipelineChainStageStatus =
  | "completed"
  | "running"
  | "failed"
  | "stopped"
  | "cancelled"
  | "pending"
  | "not-run";

/** One stage of the chain roll-up. */
export interface PipelineChainStageView {
  stage: PipelineChainStageKind;
  jobId: string;
  /** The node path addressing this stage inside the chain job. */
  nodePath: string;
  /** This stage's state in the chain's current/last run. */
  status: PipelineChainStageStatus;
  units: number;
  completedUnits: number;
  /** The newest unit error recorded for this stage, when any. */
  error: string | null;
  /** The stage job's OWN latest state (its standalone runs —
   *  the completion-chained path advances these independently
   *  of chain runs). */
  jobState: string | null;
  jobLastRunStatus: string | null;
  jobLastRunAt: string | null;
}

/**
 * The one-query answer to "where is the pipeline?": the
 * chain's per-stage states, the frontier (the stage the
 * current/last chain run stopped advancing at — the failed,
 * stopped, or in-flight stage; null when the last chain run
 * completed or no chain run exists and every stage job has a
 * successful run), the chain run's own state, and the next
 * scheduled firing from the chain's declared cadence.
 */
export interface PipelineChainSurfaceView {
  jobId: string;
  feedJobId: string;
  enrichJobId: string;
  analyzeJobId: string;
  generateJobId: string;
  deliverJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  stages: PipelineChainStageView[];
  frontier: PipelineChainStageKind | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    lastError: string | null;
  } | null;
  nextScheduledRun: string | null;
}

function aggregateStageStatus(
  views: JobStageView[],
): { status: PipelineChainStageStatus; units: number; completedUnits: number; error: string | null } {
  const units = views.flatMap((v) => v.units);
  if (units.length === 0) {
    return { status: "not-run", units: 0, completedUnits: 0, error: null };
  }
  const statuses = units.map((u) => u.status);
  const error =
    [...units].reverse().find((u) => u.error)?.error ?? null;
  const completedUnits = statuses.filter((s) => s === "completed").length;
  let status: PipelineChainStageStatus;
  if (statuses.every((s) => s === "completed")) status = "completed";
  else if (statuses.some((s) => s === "failed" || s === "timed_out")) status = "failed";
  else if (statuses.some((s) => s === "running")) status = "running";
  else if (statuses.some((s) => s === "stopped")) status = "stopped";
  else if (statuses.every((s) => s === "cancelled" || s === "completed")) status = "cancelled";
  else status = "pending";
  return { status, units: units.length, completedUnits, error };
}

/**
 * Compose the chain roll-up from the chain job's status view
 * and the stage jobs' own status views. Pure composition over
 * existing records — no new persistence.
 *
 * Frontier rule: when the chain job has a run record, the
 * frontier is the first stage (in chain order) whose chain-run
 * status is not "completed" — unless that run succeeded, in
 * which case there is no frontier. When the chain has never
 * run, the frontier is the first stage whose stage job has no
 * successful run of its own (the completion-chained path's
 * frontier), or null when every stage job has succeeded.
 */
export function buildChainSurfaceView(args: {
  entry: ChainPipelineCatalogEntry;
  chain: PipelineChainDefinition;
  pipeline: JobStatusView | null;
  stagePipelines: Partial<Record<string, JobStatusView | null>>;
  nowMs: number;
}): PipelineChainSurfaceView {
  const { entry, chain, pipeline } = args;
  const stageViewsByPath = new Map(
    (pipeline?.stages ?? []).map((s) => [s.nodePath, s]),
  );
  const stages: PipelineChainStageView[] = PIPELINE_CHAIN_STAGE_ORDER.map(
    (stage) => {
      const ref = chain.stages.find((s) => s.stage === stage)!;
      const nodeViews = chain.nodes
        .filter((n) => n.stage === stage)
        .map((n) => stageViewsByPath.get(n.nodePath))
        .filter((v): v is JobStageView => v !== undefined);
      const aggregate = aggregateStageStatus(nodeViews);
      const jobStatus = args.stagePipelines[ref.jobId] ?? null;
      return {
        stage,
        jobId: ref.jobId,
        nodePath: ref.nodePath,
        status: aggregate.status,
        units: aggregate.units,
        completedUnits: aggregate.completedUnits,
        error: aggregate.error,
        jobState: jobStatus?.instance?.state ?? null,
        jobLastRunStatus: jobStatus?.latestRun?.outcome ?? null,
        jobLastRunAt:
          jobStatus?.latestRun?.finished ??
          jobStatus?.latestRun?.started ??
          null,
      };
    },
  );

  let frontier: PipelineChainStageKind | null = null;
  if (pipeline?.latestRun) {
    if (pipeline.latestRun.outcome !== "success") {
      frontier =
        stages.find((s) => s.status !== "completed")?.stage ?? null;
    }
  } else if (pipeline) {
    frontier =
      stages.find((s) => s.jobLastRunStatus !== "success")?.stage ?? null;
  }

  const pipelineView = pipeline
    ? {
        state: pipeline.instance?.state ?? "idle",
        currentRunId: pipeline.instance?.currentRunId ?? null,
        lastRunStatus: pipeline.latestRun?.outcome ?? null,
        lastRunAt:
          pipeline.latestRun?.finished ?? pipeline.latestRun?.started ?? null,
        lastError: pipeline.instance?.lastError ?? null,
      }
    : null;

  let nextScheduledRun: string | null = null;
  const schedule = pipeline?.definition.config.schedule;
  if (schedule?.enabled) {
    const anchor =
      pipeline?.instance?.runStartedAt ??
      pipeline?.latestRun?.started ??
      null;
    if (anchor) {
      const at = Date.parse(anchor);
      if (!Number.isNaN(at)) {
        nextScheduledRun = new Date(
          at + chain.cadenceMinutes * 60_000,
        ).toISOString();
      }
    }
  }

  return {
    jobId: entry.jobId,
    feedJobId: entry.feedJobId,
    enrichJobId: entry.enrichJobId,
    analyzeJobId: entry.analyzeJobId,
    generateJobId: entry.generateJobId,
    deliverJobId: entry.deliverJobId,
    sourceId: entry.sourceId,
    dataset: entry.dataset,
    label: entry.label,
    stages,
    frontier,
    pipeline: pipelineView,
    nextScheduledRun,
  };
}
