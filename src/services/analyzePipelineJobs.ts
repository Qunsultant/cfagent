/**
 * Issue #3537 (Pipeline J4, epic #3533) — the analyze jobs as
 * J1 pipeline jobs: definitions, the step the runs execute,
 * name resolution for the copilot/UX surfaces, and the merged
 * status view. The composition point between the landed
 * foundations, in the enrichPipelineJobs.ts pattern — it
 * builds nothing parallel:
 *
 * - The J1 job pipeline (#3534): every analyze job is a job
 *   DEFINITION (configuration alone) on the one control plane
 *   (JobPipelineControl) — schedulable, configurable,
 *   manageable, stage-addressable, in every execution mode the
 *   engine supports.
 * - The analyze service (analyzeJobs.ts): the step an analyze
 *   job runs IS the analyze run — resolve the enrich job's
 *   PERSISTED enriched dataset, apply the configured
 *   deterministic rule sets, persist the analyzed artifact.
 *   The run id the engine mints is the run id the analyzed
 *   artifact carries, so every record of a run names the
 *   same run.
 * - The trigger: an analyze job is the CONSUMER of its enrich
 *   job — the host dispatches it when the enrich job's
 *   completion is recorded (the queue publication), and it is
 *   independently schedulable/runnable like every job on the
 *   plane.
 *
 * The composed step registry (createPipelineStepRegistry in
 * enrichPipelineJobs.ts) gains analyze.apply through this
 * module's registerAnalyzeStep — the same one registry every
 * residency builds; no second engine entry, no parallel
 * registry.
 */
import type { DataProviderId } from "../trading";
import type { EnrichedDatasetStore } from "../data/enrichedDatasetPorts";
import type { AnalyzedDatasetStore } from "../data/analyzedDatasetPorts";
import {
  buildAnalyzeJobRegistry,
  buildAnalyzeStatus,
  resolveScreenerHandOff,
  runAnalyzeJob,
  AnalyzeJobError,
  ANALYZE_JOB_CODES,
  type AnalyzeJobDefinition,
  type AnalyzeJobRegistry,
  type AnalyzeStatusView,
  type RunAnalyzeJobOptions,
} from "./analyzeJobs";
import {
  feedShardSymbols,
  FEED_PIPELINE_CATALOG,
} from "./feedPipelineJobs";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type {
  JobPipelineControl,
  JobStatusView,
} from "./jobPipelineEngine";
import { withSchedulePreserved } from "./jobPipelineEngine";
import { JobStepRegistry, refuseGoalScreenParam, type JobStepContext } from "./jobPipelineSteps";

/** The step name an analyze job's configuration references. */
export const ANALYZE_APPLY_STEP = "analyze.apply";

/** The step name the screener analyze application references
 *  (#5824 3a): the same analyze job, the same analyzed store —
 *  but the input comes from the parent hand-off. */
export const ANALYZE_SCREENER_STEP = "analyze.screener";

/** One catalog entry: how the surfaces name and find an analyze job. */
export interface AnalyzePipelineCatalogEntry {
  jobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  /** Lower-case name fragments the copilot/UX resolution accepts. */
  aliases: readonly string[];
}

/**
 * The analyze-job catalog — one entry per quotes feed job, in
 * feed-catalog order (derived from the feed catalog exactly as
 * the enrich catalog is: the job id extends the lineage
 * <feed job>-enrich-analyze). The synthetic bare-source
 * aliases ("alpaca analyze") are granted only to a source
 * with ONE quotes job, so no invented alias is ever ambiguous;
 * the feed catalog's aliases are inherited with " analyze"
 * appended/prepended, and the enrich forms are inherited the
 * same way — including the exact-unique bare "yahoo", which
 * resolves here as "yahoo analyze" (#2144: unique resolution,
 * never a guess).
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
export const ANALYZE_PIPELINE_CATALOG: readonly AnalyzePipelineCatalogEntry[] =
  QUOTES_FEED_ENTRIES.map((feed) => {
    const enrichAliases: string[] = [
      ...((SOURCE_JOB_COUNT.get(feed.sourceId) ?? 0) === 1
        ? [`${feed.sourceId} enrich`, `enrich ${feed.sourceId}`]
        : []),
      `${feed.jobId}-enrich`,
      ...feed.aliases.map((a) => `${a} enrich`),
      ...feed.aliases.map((a) => `enrich ${a}`),
    ];
    return {
      jobId: `${feed.jobId}-enrich-analyze`,
      enrichJobId: `${feed.jobId}-enrich`,
      feedJobId: feed.jobId,
      sourceId: feed.sourceId,
      dataset: feed.dataset,
      label: `Analyze — ${feed.label}`,
      aliases: [
        ...((SOURCE_JOB_COUNT.get(feed.sourceId) ?? 0) === 1
          ? [`${feed.sourceId} analyze`, `analyze ${feed.sourceId}`]
          : []),
        `${feed.jobId}-enrich-analyze`,
        ...feed.aliases.map((a) => `${a} analyze`),
        ...feed.aliases.map((a) => `analyze ${a}`),
        ...enrichAliases.map((a) => `${a} analyze`),
        ...enrichAliases.map((a) => `analyze ${a}`),
      ],
    };
  });

/**
 * Resolve a surface's name for an analyze job ("yahoo
 * analyze", "enrich yahoo analyze", an exact job id) to the
 * catalog entry. Exact job ids win; then exact aliases; then
 * a unique alias the query contains. Ambiguous or unknown
 * names return null — the caller refuses by name rather than
 * guessing (the #2144 rule, the feed/enrich resolvers' idiom).
 */
export function resolveAnalyzeJob(
  query: string,
): AnalyzePipelineCatalogEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = ANALYZE_PIPELINE_CATALOG.find((e) => e.jobId === q);
  if (byId) return byId;
  const exact = ANALYZE_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => a === q),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = ANALYZE_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => q.includes(a)),
  );
  return containing.length === 1 ? containing[0] : null;
}

/** The raw J1 definition (configuration alone) for one analyze
 *  job. The rules (rule sets, thresholds) live in the step
 *  params — configuration the operator changes through
 *  configureJob, never code. Thresholds ride the definition
 *  only when a registry knob set them; the step falls back to
 *  the service defaults otherwise. */
export function buildAnalyzePipelineJobDefinition(
  def: AnalyzeJobDefinition,
): unknown {
  return {
    jobId: def.id,
    name: `Analyze — ${def.sourceId} ${def.dataset} (${def.universe.label})`,
    root: {
      kind: "analyze",
      steps: [
        {
          step: ANALYZE_APPLY_STEP,
          params: {
            analyzeJobId: def.id,
            ruleSets: [...def.ruleSets],
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

/** Every raw analyze-job definition, in catalog order. */
export function buildAllAnalyzePipelineJobDefinitions(
  env: Record<string, string | undefined>,
): unknown[] {
  const registry = buildAnalyzeJobRegistry(env);
  return ANALYZE_PIPELINE_CATALOG.map((entry) => {
    const def = registry.get(entry.jobId);
    if (!def) {
      throw new Error(
        `Analyze catalog entry "${entry.jobId}" has no analyze job registered — the catalog and the registry have drifted.`,
      );
    }
    return buildAnalyzePipelineJobDefinition(def);
  });
}

/**
 * Define every analyze job on a control plane, skipping
 * definitions whose stored raw configuration already matches
 * (the feed/enrich ensure's idiom). Returns the job ids ensured.
 */
export async function ensureAnalyzePipelineJobs(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const raw of buildAllAnalyzePipelineJobDefinitions(env)) {
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

/* ------------------------------------------------------------------ */
/* The step library                                                    */
/* ------------------------------------------------------------------ */

/** Host-supplied wiring for the analyze step (one per residency). */
export interface AnalyzeStepDeps {
  /** The analyze registry the step resolves its job contract from. */
  registry: AnalyzeJobRegistry;
  /** The enriched-dataset store (the persisted inputs). Null ⇒ not configured. */
  enrichedStore: EnrichedDatasetStore | null;
  /** The analyzed-dataset store (this stage's output). Null ⇒ not configured. */
  analyzedStore: AnalyzedDatasetStore | null;
  /**
   * The job's currently configured shard keys (its definition's
   * processing.shards, read at run time — the feed wiring's
   * idiom). Absent ⇒ step params may carry "shards" instead.
   */
  shardsFor?: (jobId: string) => Promise<readonly string[]>;
}

/** The coded refusal every unwired analyze step fails its run with. */
export const ANALYZE_NOT_CONFIGURED = "ANALYZE_JOB_NOT_CONFIGURED";
export function analyzeNotConfigured(jobId: string, missing: string): Error {
  return new Error(
    `${ANALYZE_NOT_CONFIGURED}: analyze job "${jobId}" cannot run on this host — ${missing} is not wired. The run was refused rather than reading or writing through an unwired path.`,
  );
}

function stringParams(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

function thresholdsParam(value: unknown): Partial<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Partial<Record<string, unknown>>;
}

/** Resolve the analyze job a step invocation names, or refuse
 *  by name (a caller bug — the #3530 idiom). */
function resolveAnalyzeStepJob(
  deps: AnalyzeStepDeps,
  stepName: string,
  ctx: JobStepContext,
): AnalyzeJobDefinition {
  const analyzeJobId =
    typeof ctx.params.analyzeJobId === "string" ? ctx.params.analyzeJobId : "";
  const def = deps.registry.get(analyzeJobId);
  if (!def) {
    throw new Error(
      `${ANALYZE_JOB_CODES.jobNotFound}: step "${stepName}" names analyze job "${analyzeJobId}", which is not in the analyze registry.`,
    );
  }
  return def;
}

/** The shard partition for a run, from the input's symbols —
 *  the same copy the run resolves, so partitions and the
 *  whole-input run can never disagree on membership (the
 *  enrich step's idiom). Absent without a shard key. */
async function shardSymbolsForRun(
  deps: AnalyzeStepDeps,
  def: AnalyzeJobDefinition,
  ctx: JobStepContext,
  inputSymbols: readonly string[],
): Promise<string[] | undefined> {
  if (!ctx.shardKey) return undefined;
  const shards =
    (await deps.shardsFor?.(def.id)) ??
    (Array.isArray(ctx.params.shards) ? (ctx.params.shards as string[]) : []);
  return (
    feedShardSymbols(
      inputSymbols.map((s) => s.toUpperCase()),
      shards,
      ctx.shardKey,
    ) ?? undefined
  );
}

/** The shared tail of the analyze step handlers: run the job
 *  with the resolved options and map the run result to the
 *  step output. A failed run throws with the run's own coded
 *  error so the job's run record and the dataset record agree. */
async function executeAnalyzeStepRun(
  deps: AnalyzeStepDeps,
  def: AnalyzeJobDefinition,
  ctx: JobStepContext,
  extra: Omit<RunAnalyzeJobOptions, "trigger" | "kind" | "runId" | "nowMs">,
) {
  // The stores are non-null here by construction: the step
  // handlers throw ANALYZE_JOB_NOT_CONFIGURED before reaching
  // this tail when a store they need is unwired, and the
  // hand-off run never reads the enriched store at all.
  const result = await runAnalyzeJob(
    deps.registry,
    { enrichedStore: deps.enrichedStore!, analyzedStore: deps.analyzedStore! },
    def.id,
    {
      trigger: ctx.trigger,
      kind: ctx.runKind,
      runId: ctx.runId,
      ...(stringParams(ctx.params.ruleSets)
        ? { ruleSets: stringParams(ctx.params.ruleSets) }
        : {}),
      ...(thresholdsParam(ctx.params.thresholds)
        ? { thresholds: thresholdsParam(ctx.params.thresholds) }
        : {}),
      ...extra,
    },
  );
  if (result.status === "failed") {
    // The analyze run recorded its own failure in the analyzed
    // store; the pipeline run fails with the same coded error
    // so the job's run record and the dataset record agree.
    throw new Error(
      `${result.codedError ?? "ANALYZE_RUN_FAILED"}: analyze job "${def.id}" run ${result.runId} failed (${result.errorMessage ?? "no detail"})`,
    );
  }
  return {
    output: {
      analyzeJobId: def.id,
      enrichJobId: def.enrichJobId,
      sourceId: def.sourceId,
      dataset: def.dataset,
      analyzeRunId: result.runId,
      artifactId: result.artifactId,
      status: result.status,
      requested: result.requested,
      received: result.received,
      failed: result.failed,
      inputArtifactId: result.inputArtifactId,
      inputRunId: result.inputRunId,
      ruleCoverage: result.ruleCoverage,
    },
    descriptor: `analyze ${def.sourceId}/${def.dataset}: ${result.received}/${result.requested} rows persisted (artifact ${result.artifactId}, input run ${result.inputRunId})`,
  };
}

/**
 * Register the analyze step on a registry. Hosts compose the
 * FULL registry through createPipelineStepRegistry (in
 * enrichPipelineJobs.ts, which takes these deps as its third
 * argument); this function exists so a registry built for
 * tests can add the analyze step alone.
 */
export function registerAnalyzeStep(
  registry: JobStepRegistry,
  deps: AnalyzeStepDeps,
): void {
  registry.register(ANALYZE_APPLY_STEP, async (ctx: JobStepContext) => {
    const def = resolveAnalyzeStepJob(deps, ANALYZE_APPLY_STEP, ctx);
    if (!deps.enrichedStore) throw analyzeNotConfigured(def.id, "the enriched-dataset store");
    if (!deps.analyzedStore) throw analyzeNotConfigured(def.id, "the analyzed-dataset store");

    // Sharded shape: this unit analyzes its partition of the
    // PERSISTED input's symbols (the partition is computed from
    // the stored copy — the same copy the run resolves, so
    // partitions and the whole-input run can never disagree on
    // membership; the enrich step's idiom).
    const input = await deps.enrichedStore.latestUsable(def.enrichJobId);
    const symbols = await shardSymbolsForRun(
      deps,
      def,
      ctx,
      input ? input.rows.map((r) => r.symbol) : [],
    );
    return executeAnalyzeStepRun(deps, def, ctx, {
      ...(symbols ? { symbols } : {}),
    });
  });
}

/**
 * Issue #5884 (6b3) — this unit's hand-off: the hand-off
 * itself, or its shard's entry of the per-shard map the
 * engine hands a sharded unit (the bespoke screener step's
 * priorFor idiom, src/services/screenerPipelineJobs.ts — the
 * map read, not a rule, so it lives here rather than as a
 * cross-module import; the deliver step's screenerPriorFor
 * is the same idiom). Without the unwrap, a sharded run's
 * analyze node receives the map and refuses it as malformed.
 */
function screenerHandOffFor(input: unknown, shardKey: string | null): unknown {
  if (
    shardKey &&
    input !== null &&
    typeof input === "object" &&
    shardKey in (input as Record<string, unknown>)
  ) {
    return (input as Record<string, unknown>)[shardKey];
  }
  return input;
}

/**
 * Register the screener analyze application alongside
 * analyze.apply (#5824 3a — the analyze.ooda precedent): the
 * same analyze job, the same analyzed store, but the input
 * comes from the parent hand-off (the gather stage's output)
 * instead of the persisted enriched store, because the
 * screener's factor grades need the quote fields (peRatio)
 * the persisted rows do not carry.
 *
 * params.inputMode "handOff" selects the hand-off input; any
 * other value (or absent) runs the persisted input, exactly
 * like analyze.apply. The hand-off is refused by name when
 * it is not the gather-output shape. The goal branch (3b)
 * and the portfolio modifier (3c) are NOT here — the step
 * runs the market analyze only. Since slice 6b3 (#5884) the
 * screener spec points its analyze node at this step.
 */
export function registerScreenerAnalyzeStep(
  registry: JobStepRegistry,
  deps: AnalyzeStepDeps,
): void {
  registry.register(ANALYZE_SCREENER_STEP, async (ctx: JobStepContext) => {
    // Issue #5886 (6d): the market chain refuses a goalScreen
    // param by name — a goal run belongs on the goalScreen
    // definition, never on this step.
    refuseGoalScreenParam(ctx.params, ANALYZE_SCREENER_STEP);
    const def = resolveAnalyzeStepJob(deps, ANALYZE_SCREENER_STEP, ctx);
    if (!deps.analyzedStore) throw analyzeNotConfigured(def.id, "the analyzed-dataset store");

    if (ctx.params.inputMode !== "handOff") {
      if (!deps.enrichedStore) throw analyzeNotConfigured(def.id, "the enriched-dataset store");
      const input = await deps.enrichedStore.latestUsable(def.enrichJobId);
      const symbols = await shardSymbolsForRun(
        deps,
        def,
        ctx,
        input ? input.rows.map((r) => r.symbol) : [],
      );
      return executeAnalyzeStepRun(deps, def, ctx, {
        ...(symbols ? { symbols } : {}),
      });
    }

    // The hand-off is refused by name: the mapper's coded
    // error is rethrown in the step family's `${CODE}: ...`
    // message form, so a caller reading the failure sees the
    // code without importing the error class.
    let handOff;
    try {
      handOff = resolveScreenerHandOff(screenerHandOffFor(ctx.input, ctx.shardKey));
    } catch (e) {
      if (e instanceof AnalyzeJobError) {
        throw new Error(`${e.code}: ${e.message}`);
      }
      throw e;
    }
    const symbols = await shardSymbolsForRun(
      deps,
      def,
      ctx,
      handOff.rows.map((r) => r.symbol),
    );
    return executeAnalyzeStepRun(deps, def, ctx, {
      ...(symbols ? { symbols } : {}),
      handOffRows: handOff.rows,
      handOffLineage: {
        inputArtifactId: handOff.inputArtifactId,
        inputRunId: handOff.inputRunId,
        inputAsOf: handOff.inputAsOf,
      },
    });
  });
}

/* ------------------------------------------------------------------ */
/* The merged status view (UX + copilot — one source of truth)         */
/* ------------------------------------------------------------------ */

/**
 * One analyze job's surface status: the analyzed-dataset view
 * (last run, rows persisted, freshness, lineage, history)
 * joined with the J1 pipeline view and the next scheduled
 * firing estimated from the declared cadence (the enrich
 * surface view's shape, transposed).
 */
export interface AnalyzeJobSurfaceView {
  jobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  analyze: AnalyzeStatusView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    stages: JobStatusView["stages"];
  } | null;
  nextScheduledRun: string | null;
}

export async function buildAnalyzeJobSurfaceView(args: {
  entry: AnalyzePipelineCatalogEntry;
  analyzedStore: AnalyzedDatasetStore | null;
  registry: AnalyzeJobRegistry;
  pipeline: JobStatusView | null;
  nowMs: number;
}): Promise<AnalyzeJobSurfaceView> {
  const def = args.registry.get(args.entry.jobId);
  const analyze =
    args.analyzedStore && def
      ? await buildAnalyzeStatus(args.analyzedStore, def, args.nowMs)
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
      args.pipeline?.instance?.runStartedAt ?? analyze?.lastRun?.startedAt ?? null;
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
    enrichJobId: args.entry.enrichJobId,
    feedJobId: args.entry.feedJobId,
    sourceId: args.entry.sourceId,
    dataset: args.entry.dataset,
    label: args.entry.label,
    analyze,
    pipeline,
    nextScheduledRun,
  };
}
