/**
 * Issue #3536 (Pipeline J3, epic #3533) — the enrich jobs as J1
 * pipeline jobs: definitions, the step the runs execute, name
 * resolution for the copilot/UX surfaces, and the merged status
 * view. The composition point between the landed foundations,
 * in the feedPipelineJobs.ts pattern — it builds nothing
 * parallel:
 *
 * - The J1 job pipeline (#3534): every enrich job is a job
 *   DEFINITION (configuration alone) on the one control plane
 *   (JobPipelineControl) — schedulable, configurable,
 *   manageable, stage-addressable, in every execution mode the
 *   engine supports.
 * - The enrich service (enrichJobs.ts): the step an enrich job
 *   runs IS the enrich run — resolve the feed job's PERSISTED
 *   dataset, compute the configured elements, persist the
 *   enriched artifact. The run id the engine mints is the run
 *   id the enriched artifact carries, so every record of a run
 *   names the same run.
 * - The trigger: an enrich job is the CONSUMER of its feed job
 *   — the host dispatches it when the feed job's completion is
 *   recorded (the queue publication), and it is independently
 *   schedulable/runnable like every job on the plane.
 *
 * The composed step registry is the one registry every
 * residency builds: the feed steps plus enrich.apply plus
 * analyze.apply (#3537) plus generate.apply (#3538)
 * (createPipelineStepRegistry) — no second engine entry.
 */
import type { DataProviderId } from "../trading";
import type { FeedDatasetStore } from "../data/feedDatasetPorts";
import type { EnrichedDatasetStore } from "../data/enrichedDatasetPorts";
import {
  buildEnrichJobRegistry,
  buildEnrichStatus,
  resolveFeedInputArtifact,
  runEnrichJob,
  ENRICH_JOB_CODES,
  type EnrichJobDefinition,
  type EnrichJobRegistry,
  type EnrichJoinSource,
  type EnrichStatusView,
} from "./enrichJobs";
import {
  createFeedStepRegistry,
  feedShardSymbols,
  FEED_PIPELINE_CATALOG,
  type FeedStepDeps,
} from "./feedPipelineJobs";
import {
  registerAnalyzeStep,
  type AnalyzeStepDeps,
} from "./analyzePipelineJobs";
import {
  registerGenerateStep,
  type GenerateStepDeps,
} from "./generatePipelineJobs";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type {
  JobPipelineControl,
  JobStatusView,
} from "./jobPipelineEngine";
import { JobStepRegistry, type JobStepContext } from "./jobPipelineSteps";

/** The step name an enrich job's configuration references. */
export const ENRICH_APPLY_STEP = "enrich.apply";

/** One catalog entry: how the surfaces name and find an enrich job. */
export interface EnrichPipelineCatalogEntry {
  jobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  /** Lower-case name fragments the copilot/UX resolution accepts. */
  aliases: readonly string[];
}

/**
 * The enrich-job catalog — one entry per quotes feed job, in
 * feed-catalog order (the fundamentals and universe feed jobs
 * are enrichment SOURCES, not targets). The synthetic
 * bare-source aliases ("alpaca enrich") are granted only to a
 * source with ONE quotes job, so no alias the catalog invents
 * is ever ambiguous; the feed catalog's own aliases are
 * inherited suffixed/prefixed with "enrich" — including its
 * exact-unique bare "yahoo" (the Nasdaq-100 quotes job), which
 * resolves here exactly as it does on the feed side (#2144:
 * unique resolution, never a guess).
 */
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
export const ENRICH_PIPELINE_CATALOG: readonly EnrichPipelineCatalogEntry[] =
  QUOTES_FEED_ENTRIES.map((feed) => ({
    jobId: `${feed.jobId}-enrich`,
    feedJobId: feed.jobId,
    sourceId: feed.sourceId,
    dataset: feed.dataset,
    label: `Enrich — ${feed.label}`,
    aliases: [
      ...((SOURCE_JOB_COUNT.get(feed.sourceId) ?? 0) === 1
        ? [`${feed.sourceId} enrich`, `enrich ${feed.sourceId}`]
        : []),
      `${feed.jobId}-enrich`,
      ...feed.aliases.map((a) => `${a} enrich`),
      ...feed.aliases.map((a) => `enrich ${a}`),
    ],
  }));

/**
 * Resolve a surface's name for an enrich job ("yahoo enrich",
 * "enrich alpaca", an exact job id) to the catalog entry. Exact
 * job ids win; then exact aliases; then a unique alias the
 * query contains. Ambiguous or unknown names return null — the
 * caller refuses by name rather than guessing (the #2144 rule,
 * applied to job names — the feed resolver's idiom).
 */
export function resolveEnrichJob(
  query: string,
): EnrichPipelineCatalogEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = ENRICH_PIPELINE_CATALOG.find((e) => e.jobId === q);
  if (byId) return byId;
  const exact = ENRICH_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => a === q),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = ENRICH_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => q.includes(a)),
  );
  return containing.length === 1 ? containing[0] : null;
}

/** The raw J1 definition (configuration alone) for one enrich job.
 *  The rules (elements, join sources) live in the step params —
 *  configuration the operator changes through configureJob,
 *  never code. */
export function buildEnrichPipelineJobDefinition(
  def: EnrichJobDefinition,
): unknown {
  return {
    jobId: def.id,
    name: `Enrich — ${def.sourceId} ${def.dataset} (${def.universe.label})`,
    root: {
      kind: "enrich",
      steps: [
        {
          step: ENRICH_APPLY_STEP,
          params: {
            enrichJobId: def.id,
            elements: [...def.elements],
            enrichFrom: def.enrichFrom.map((s) => ({
              feedJobId: s.feedJobId,
              sourceId: s.sourceId,
              dataset: s.dataset,
            })),
          },
        },
      ],
      inputs: { sources: [def.sourceId], datasets: [def.dataset] },
      schedule: {
        enabled: true,
        interval: `every ${def.cadenceMinutes} minutes`,
      },
    },
  };
}

/** Every raw enrich-job definition, in catalog order. */
export function buildAllEnrichPipelineJobDefinitions(
  env: Record<string, string | undefined>,
): unknown[] {
  const registry = buildEnrichJobRegistry(env);
  return ENRICH_PIPELINE_CATALOG.map((entry) => {
    const def = registry.get(entry.jobId);
    if (!def) {
      throw new Error(
        `Enrich catalog entry "${entry.jobId}" has no enrich job registered — the catalog and the registry have drifted.`,
      );
    }
    return buildEnrichPipelineJobDefinition(def);
  });
}

/**
 * Define every enrich job on a control plane, skipping
 * definitions whose stored raw configuration already matches
 * (the feed ensure's idiom). Returns the job ids ensured.
 */
export async function ensureEnrichPipelineJobs(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const raw of buildAllEnrichPipelineJobDefinitions(env)) {
    const jobId = (raw as { jobId: string }).jobId;
    const existing = await stores.definitions.getDefinition(jobId);
    if (
      existing &&
      JSON.stringify(existing.rawConfig) === JSON.stringify(raw)
    ) {
      ensured.push(jobId);
      continue;
    }
    await control.defineJob(raw);
    ensured.push(jobId);
  }
  return ensured;
}

/* ------------------------------------------------------------------ */
/* The step library                                                    */
/* ------------------------------------------------------------------ */

/** Host-supplied wiring for the enrich step (one per residency). */
export interface EnrichStepDeps {
  /** The enrich registry the step resolves its job contract from. */
  registry: EnrichJobRegistry;
  /** The feed-dataset store (the persisted inputs). Null ⇒ not configured. */
  datasetStore: FeedDatasetStore | null;
  /** The enriched-dataset store (this stage's output). Null ⇒ not configured. */
  enrichedStore: EnrichedDatasetStore | null;
  /**
   * The job's currently configured shard keys (its definition's
   * processing.shards, read at run time — the feed wiring's
   * idiom). Absent ⇒ step params may carry "shards" instead.
   */
  shardsFor?: (jobId: string) => Promise<readonly string[]>;
}

/** The coded refusal every unwired enrich step fails its run with. */
export const ENRICH_NOT_CONFIGURED = "ENRICH_JOB_NOT_CONFIGURED";
export function enrichNotConfigured(jobId: string, missing: string): Error {
  return new Error(
    `${ENRICH_NOT_CONFIGURED}: enrich job "${jobId}" cannot run on this host — ${missing} is not wired. The run was refused rather than reading or writing through an unwired path.`,
  );
}

function stringParams(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

function joinSourceParams(value: unknown): EnrichJoinSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: EnrichJoinSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.feedJobId !== "string" ||
      typeof e.sourceId !== "string" ||
      typeof e.dataset !== "string"
    ) {
      return undefined;
    }
    out.push({
      feedJobId: e.feedJobId,
      sourceId: e.sourceId as DataProviderId,
      dataset: e.dataset,
    });
  }
  return out;
}

/**
 * Register the enrich step on a registry. Hosts compose the
 * FULL registry through createPipelineStepRegistry below; this
 * function exists so a registry built for tests can add the
 * enrich step alone.
 */
export function registerEnrichStep(
  registry: JobStepRegistry,
  deps: EnrichStepDeps,
): void {
  registry.register(ENRICH_APPLY_STEP, async (ctx: JobStepContext) => {
    const enrichJobId =
      typeof ctx.params.enrichJobId === "string" ? ctx.params.enrichJobId : "";
    const def = deps.registry.get(enrichJobId);
    if (!def) {
      throw new Error(
        `${ENRICH_JOB_CODES.jobNotFound}: step "${ENRICH_APPLY_STEP}" names enrich job "${enrichJobId}", which is not in the enrich registry.`,
      );
    }
    if (!deps.datasetStore) throw enrichNotConfigured(def.id, "the feed-dataset store");
    if (!deps.enrichedStore) throw enrichNotConfigured(def.id, "the enriched-dataset store");

    // Sharded shape: this unit enriches its partition of the
    // PERSISTED input's symbols (the partition is computed from
    // the stored copy — the same copy the run resolves, so
    // partitions and the whole-input run can never disagree on
    // membership; the feed step's idiom).
    let symbols: string[] | undefined;
    if (ctx.shardKey) {
      const shards =
        (await deps.shardsFor?.(def.id)) ??
        (Array.isArray(ctx.params.shards) ? (ctx.params.shards as string[]) : []);
      const input = await resolveFeedInputArtifact(
        deps.datasetStore,
        def.feedJobId,
        def.sourceId,
        def.dataset,
      );
      const inputSymbols = input
        ? input.quotes
            .map((q) => (q as { symbol?: unknown }).symbol)
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.toUpperCase())
        : [];
      symbols = feedShardSymbols(inputSymbols, shards, ctx.shardKey) ?? undefined;
    }

    const result = await runEnrichJob(
      deps.registry,
      { datasetStore: deps.datasetStore, enrichedStore: deps.enrichedStore },
      def.id,
      {
        trigger: "manual",
        runId: ctx.runId,
        ...(stringParams(ctx.params.elements)
          ? { elements: stringParams(ctx.params.elements) }
          : {}),
        ...(joinSourceParams(ctx.params.enrichFrom)
          ? { enrichFrom: joinSourceParams(ctx.params.enrichFrom) }
          : {}),
        ...(typeof ctx.params.seriesPeriod === "number"
          ? { seriesPeriod: ctx.params.seriesPeriod }
          : {}),
        ...(symbols ? { symbols } : {}),
      },
    );
    if (result.status === "failed") {
      // The enrich run recorded its own failure in the enriched
      // store; the pipeline run fails with the same coded error
      // so the job's run record and the dataset record agree.
      throw new Error(
        `${result.codedError ?? "ENRICH_RUN_FAILED"}: enrich job "${def.id}" run ${result.runId} failed (${result.errorMessage ?? "no detail"})`,
      );
    }
    return {
      output: {
        enrichJobId: def.id,
        feedJobId: def.feedJobId,
        sourceId: def.sourceId,
        dataset: def.dataset,
        enrichRunId: result.runId,
        artifactId: result.artifactId,
        status: result.status,
        requested: result.requested,
        received: result.received,
        failed: result.failed,
        inputArtifactId: result.inputArtifactId,
        inputRunId: result.inputRunId,
        elementCoverage: result.elementCoverage,
      },
      descriptor: `enrich ${def.sourceId}/${def.dataset}: ${result.received}/${result.requested} rows persisted (artifact ${result.artifactId}, input run ${result.inputRunId})`,
    };
  });
}

/**
 * THE composed step registry — the feed steps plus enrich.apply
 * plus analyze.apply (#3537) plus generate.apply (#3538), built
 * identically in every residency (the ScheduledAgent host, the
 * workflow start path, the workflow itself). One registry, one
 * engine, every stage family so far. The analyze deps are the
 * third argument and the generate deps the fourth: production
 * compositions always pass them; a stage-scoped test registry
 * may omit them (the registry then simply lacks those steps,
 * exactly as registerEnrichStep alone composes an enrich-only
 * registry).
 */
export function createPipelineStepRegistry(
  feedDeps: FeedStepDeps,
  enrichDeps: EnrichStepDeps,
  analyzeDeps?: AnalyzeStepDeps,
  generateDeps?: GenerateStepDeps,
): JobStepRegistry {
  const registry = createFeedStepRegistry(feedDeps);
  registerEnrichStep(registry, enrichDeps);
  if (analyzeDeps) registerAnalyzeStep(registry, analyzeDeps);
  if (generateDeps) registerGenerateStep(registry, generateDeps);
  return registry;
}

/* ------------------------------------------------------------------ */
/* The merged status view (UX + copilot — one source of truth)         */
/* ------------------------------------------------------------------ */

/**
 * One enrich job's surface status: the enriched-dataset view
 * (last run, rows persisted, freshness, lineage, history)
 * joined with the J1 pipeline view and the next scheduled
 * firing estimated from the declared cadence (the feed surface
 * view's shape, transposed).
 */
export interface EnrichJobSurfaceView {
  jobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  enrich: EnrichStatusView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    stages: JobStatusView["stages"];
  } | null;
  nextScheduledRun: string | null;
}

export async function buildEnrichJobSurfaceView(args: {
  entry: EnrichPipelineCatalogEntry;
  enrichedStore: EnrichedDatasetStore | null;
  registry: EnrichJobRegistry;
  pipeline: JobStatusView | null;
  nowMs: number;
}): Promise<EnrichJobSurfaceView> {
  const def = args.registry.get(args.entry.jobId);
  const enrich =
    args.enrichedStore && def
      ? await buildEnrichStatus(args.enrichedStore, def, args.nowMs)
      : null;
  const pipeline = args.pipeline
    ? {
        state: args.pipeline.instance?.state ?? "idle",
        currentRunId: args.pipeline.instance?.currentRunId ?? null,
        lastRunStatus: args.pipeline.latestRun?.outcome ?? null,
        lastRunAt:
          args.pipeline.latestRun?.finished ??
          args.pipeline.latestRun?.started ??
          null,
        stages: args.pipeline.stages,
      }
    : null;
  let nextScheduledRun: string | null = null;
  const schedule = args.pipeline?.definition.config.schedule;
  if (schedule?.enabled) {
    const anchor =
      args.pipeline?.instance?.runStartedAt ?? enrich?.lastRun?.startedAt ?? null;
    const cadence = def?.cadenceMinutes ?? null;
    if (anchor && cadence) {
      const at = Date.parse(anchor);
      if (!Number.isNaN(at)) {
        nextScheduledRun = new Date(at + cadence * 60_000).toISOString();
      }
    }
  }
  return {
    jobId: args.entry.jobId,
    feedJobId: args.entry.feedJobId,
    sourceId: args.entry.sourceId,
    dataset: args.entry.dataset,
    label: args.entry.label,
    enrich,
    pipeline,
    nextScheduledRun,
  };
}
