/**
 * Issue #3538 (Pipeline J5, epic #3533) — the generate jobs as
 * J1 pipeline jobs: definitions, the step the runs execute,
 * name resolution for the copilot/UX surfaces, and the merged
 * status view. The composition point between the landed
 * foundations, in the analyzePipelineJobs.ts pattern — it
 * builds nothing parallel:
 *
 * - The J1 job pipeline (#3534): every generate job is a job
 *   DEFINITION (configuration alone) on the one control plane
 *   (JobPipelineControl) — schedulable, configurable,
 *   manageable, stage-addressable, in every execution mode the
 *   engine supports.
 * - The generate service (generateJobs.ts): the step a
 *   generate job runs IS the generate run — resolve the
 *   analyze job's PERSISTED analyzed dataset, render the
 *   configured reports in the configured formats, run each
 *   report's canonical leg, persist the generated artifact.
 *   The run id the engine mints is the run id the generated
 *   artifact carries, so every record of a run names the
 *   same run.
 * - The trigger: a generate job is the CONSUMER of its analyze
 *   job — the host dispatches it when the analyze job's
 *   completion is recorded (the queue publication), and it is
 *   independently schedulable/runnable like every job on the
 *   plane.
 *
 * The composed step registry (createPipelineStepRegistry in
 * enrichPipelineJobs.ts) gains generate.apply through this
 * module's registerGenerateStep — the same one registry every
 * residency builds; no second engine entry, no parallel
 * registry.
 */
import type { DataProviderId } from "../trading";
import type { AnalyzedDatasetStore } from "../data/analyzedDatasetPorts";
import type { GeneratedDatasetStore } from "../data/generatedDatasetPorts";
import {
  buildGenerateJobRegistry,
  buildGenerateStatus,
  runGenerateJob,
  GENERATE_JOB_CODES,
  type CanonicalReportStoreSeam,
  type GenerateJobDefinition,
  type GenerateJobRegistry,
  type GenerateStatusView,
} from "./generateJobs";
import {
  feedShardSymbols,
  FEED_PIPELINE_CATALOG,
} from "./feedPipelineJobs";
import { ANALYZE_PIPELINE_CATALOG } from "./analyzePipelineJobs";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type {
  JobPipelineControl,
  JobStatusView,
} from "./jobPipelineEngine";
import { JobStepRegistry, type JobStepContext } from "./jobPipelineSteps";

/** The step name a generate job's configuration references. */
export const GENERATE_APPLY_STEP = "generate.apply";

/** One catalog entry: how the surfaces name and find a generate job. */
export interface GeneratePipelineCatalogEntry {
  jobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  /** Lower-case name fragments the copilot/UX resolution accepts. */
  aliases: readonly string[];
}

/**
 * The generate-job catalog — one entry per analyze job, in
 * feed-catalog order (derived from the feed + analyze catalogs
 * exactly as the analyze catalog derives from the feed catalog:
 * the job id extends the lineage <feed job>-enrich-analyze-
 * generate). The synthetic bare-source aliases ("alpaca
 * generate") are granted only to a source with ONE quotes job,
 * so no invented alias is ever ambiguous; the feed catalog's
 * aliases are inherited with " generate" appended/prepended,
 * and the analyze forms are inherited the same way — including
 * the exact-unique bare "yahoo", which resolves here as
 * "yahoo generate" (#2144: unique resolution, never a guess).
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
const ANALYZE_BY_JOB_ID = new Map(ANALYZE_PIPELINE_CATALOG.map((e) => [e.jobId, e]));
export const GENERATE_PIPELINE_CATALOG: readonly GeneratePipelineCatalogEntry[] =
  QUOTES_FEED_ENTRIES.map((feed) => {
    const analyzeJobId = `${feed.jobId}-enrich-analyze`;
    const analyze = ANALYZE_BY_JOB_ID.get(analyzeJobId);
    if (!analyze) {
      throw new Error(
        `Generate catalog: analyze catalog entry "${analyzeJobId}" is missing — the catalogs have drifted.`,
      );
    }
    return {
      jobId: `${analyzeJobId}-generate`,
      analyzeJobId,
      enrichJobId: `${feed.jobId}-enrich`,
      feedJobId: feed.jobId,
      sourceId: feed.sourceId,
      dataset: feed.dataset,
      label: `Generate — ${feed.label}`,
      aliases: [
        ...((SOURCE_JOB_COUNT.get(feed.sourceId) ?? 0) === 1
          ? [`${feed.sourceId} generate`, `generate ${feed.sourceId}`]
          : []),
        `${analyzeJobId}-generate`,
        ...feed.aliases.map((a) => `${a} generate`),
        ...feed.aliases.map((a) => `generate ${a}`),
        ...analyze.aliases.map((a) => `${a} generate`),
        ...analyze.aliases.map((a) => `generate ${a}`),
      ],
    };
  });

/**
 * Resolve a surface's name for a generate job ("yahoo
 * generate", "generate alpaca", an exact job id) to the
 * catalog entry. Exact job ids win; then exact aliases; then
 * a unique alias the query contains. Ambiguous or unknown
 * names return null — the caller refuses by name rather than
 * guessing (the #2144 rule, the feed/enrich/analyze resolvers'
 * idiom).
 */
export function resolveGenerateJob(
  query: string,
): GeneratePipelineCatalogEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = GENERATE_PIPELINE_CATALOG.find((e) => e.jobId === q);
  if (byId) return byId;
  const exact = GENERATE_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => a === q),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = GENERATE_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => q.includes(a)),
  );
  return containing.length === 1 ? containing[0] : null;
}

/** The raw J1 definition (configuration alone) for one generate
 *  job. The rules (reports, formats) live in the step params —
 *  configuration the operator changes through configureJob,
 *  never code. */
export function buildGeneratePipelineJobDefinition(
  def: GenerateJobDefinition,
): unknown {
  return {
    jobId: def.id,
    name: `Generate — ${def.sourceId} ${def.dataset} (${def.universe.label})`,
    root: {
      kind: "generate",
      steps: [
        {
          step: GENERATE_APPLY_STEP,
          params: {
            generateJobId: def.id,
            reports: [...def.reports],
            formats: [...def.formats],
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

/** Every raw generate-job definition, in catalog order. */
export function buildAllGeneratePipelineJobDefinitions(
  env: Record<string, string | undefined>,
): unknown[] {
  const registry = buildGenerateJobRegistry(env);
  return GENERATE_PIPELINE_CATALOG.map((entry) => {
    const def = registry.get(entry.jobId);
    if (!def) {
      throw new Error(
        `Generate catalog entry "${entry.jobId}" has no generate job registered — the catalog and the registry have drifted.`,
      );
    }
    return buildGeneratePipelineJobDefinition(def);
  });
}

/**
 * Define every generate job on a control plane, skipping
 * definitions whose stored raw configuration already matches
 * (the feed/enrich/analyze ensure's idiom). Returns the job
 * ids ensured.
 */
export async function ensureGeneratePipelineJobs(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const raw of buildAllGeneratePipelineJobDefinitions(env)) {
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

/** Host-supplied wiring for the generate step (one per residency). */
export interface GenerateStepDeps {
  /** The generate registry the step resolves its job contract from. */
  registry: GenerateJobRegistry;
  /** The analyzed-dataset store (the persisted inputs). Null ⇒ not configured. */
  analyzedStore: AnalyzedDatasetStore | null;
  /** The generated-dataset store (this stage's output). Null ⇒ not configured. */
  generatedStore: GeneratedDatasetStore | null;
  /**
   * The canonical report-store seam (mas_reports), host-bound
   * where the residency owns reports; null/absent ⇒ each
   * report's canonical leg is recorded not_wired (the service
   * records it per report — an unwired leg never fails a run
   * whose generated output persisted, the #2347 discipline).
   */
  canonicalReportStore?: CanonicalReportStoreSeam | null;
  /**
   * The job's currently configured shard keys (its definition's
   * processing.shards, read at run time — the feed wiring's
   * idiom). Absent ⇒ step params may carry "shards" instead.
   */
  shardsFor?: (jobId: string) => Promise<readonly string[]>;
}

/** The coded refusal every unwired generate step fails its run with. */
export const GENERATE_NOT_CONFIGURED = "GENERATE_JOB_NOT_CONFIGURED";
export function generateNotConfigured(jobId: string, missing: string): Error {
  return new Error(
    `${GENERATE_NOT_CONFIGURED}: generate job "${jobId}" cannot run on this host — ${missing} is not wired. The run was refused rather than reading or writing through an unwired path.`,
  );
}

function stringParams(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

/**
 * Register the generate step on a registry. Hosts compose the
 * FULL registry through createPipelineStepRegistry (in
 * enrichPipelineJobs.ts, which takes these deps as its fourth
 * argument); this function exists so a registry built for
 * tests can add the generate step alone.
 */
export function registerGenerateStep(
  registry: JobStepRegistry,
  deps: GenerateStepDeps,
): void {
  registry.register(GENERATE_APPLY_STEP, async (ctx: JobStepContext) => {
    const generateJobId =
      typeof ctx.params.generateJobId === "string" ? ctx.params.generateJobId : "";
    const def = deps.registry.get(generateJobId);
    if (!def) {
      throw new Error(
        `${GENERATE_JOB_CODES.jobNotFound}: step "${GENERATE_APPLY_STEP}" names generate job "${generateJobId}", which is not in the generate registry.`,
      );
    }
    if (!deps.analyzedStore) throw generateNotConfigured(def.id, "the analyzed-dataset store");
    if (!deps.generatedStore) throw generateNotConfigured(def.id, "the generated-dataset store");

    // Sharded shape: this unit generates from its partition of
    // the PERSISTED input's symbols (the partition is computed
    // from the stored copy — the same copy the run resolves, so
    // partitions and the whole-input run can never disagree on
    // membership; the analyze step's idiom).
    let symbols: string[] | undefined;
    if (ctx.shardKey) {
      const shards =
        (await deps.shardsFor?.(def.id)) ??
        (Array.isArray(ctx.params.shards) ? (ctx.params.shards as string[]) : []);
      const input = await deps.analyzedStore.latestUsable(def.analyzeJobId);
      const inputSymbols = input
        ? input.rows.map((r) => r.symbol.toUpperCase())
        : [];
      symbols = feedShardSymbols(inputSymbols, shards, ctx.shardKey) ?? undefined;
    }

    const result = await runGenerateJob(
      deps.registry,
      {
        analyzedStore: deps.analyzedStore,
        generatedStore: deps.generatedStore,
        canonicalReportStore: deps.canonicalReportStore ?? null,
      },
      def.id,
      {
        trigger: "manual",
        runId: ctx.runId,
        ...(stringParams(ctx.params.reports)
          ? { reports: stringParams(ctx.params.reports) }
          : {}),
        ...(stringParams(ctx.params.formats)
          ? { formats: stringParams(ctx.params.formats) }
          : {}),
        ...(symbols ? { symbols } : {}),
      },
    );
    if (result.status === "failed") {
      // The generate run recorded its own failure in the
      // generated store; the pipeline run fails with the same
      // coded error so the job's run record and the dataset
      // record agree.
      throw new Error(
        `${result.codedError ?? "GENERATE_RUN_FAILED"}: generate job "${def.id}" run ${result.runId} failed (${result.errorMessage ?? "no detail"})`,
      );
    }
    return {
      output: {
        generateJobId: def.id,
        analyzeJobId: def.analyzeJobId,
        sourceId: def.sourceId,
        dataset: def.dataset,
        generateRunId: result.runId,
        artifactId: result.artifactId,
        status: result.status,
        requested: result.requested,
        received: result.received,
        failed: result.failed,
        inputArtifactId: result.inputArtifactId,
        inputRunId: result.inputRunId,
        reportsGenerated: result.reportsGenerated,
        canonical: result.canonical,
      },
      descriptor: `generate ${def.sourceId}/${def.dataset}: ${result.received}/${result.requested} report formats persisted (artifact ${result.artifactId}, input run ${result.inputRunId})`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* The merged status view (UX + copilot — one source of truth)         */
/* ------------------------------------------------------------------ */

/**
 * One generate job's surface status: the generated-dataset view
 * (last run, reports persisted, freshness, lineage, history)
 * joined with the J1 pipeline view and the next scheduled
 * firing estimated from the declared cadence (the analyze
 * surface view's shape, transposed).
 */
export interface GenerateJobSurfaceView {
  jobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  generate: GenerateStatusView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    stages: JobStatusView["stages"];
  } | null;
  nextScheduledRun: string | null;
}

export async function buildGenerateJobSurfaceView(args: {
  entry: GeneratePipelineCatalogEntry;
  generatedStore: GeneratedDatasetStore | null;
  registry: GenerateJobRegistry;
  pipeline: JobStatusView | null;
  nowMs: number;
}): Promise<GenerateJobSurfaceView> {
  const def = args.registry.get(args.entry.jobId);
  const generate =
    args.generatedStore && def
      ? await buildGenerateStatus(args.generatedStore, def, args.nowMs)
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
      args.pipeline?.instance?.runStartedAt ?? generate?.lastRun?.startedAt ?? null;
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
    analyzeJobId: args.entry.analyzeJobId,
    enrichJobId: args.entry.enrichJobId,
    feedJobId: args.entry.feedJobId,
    sourceId: args.entry.sourceId,
    dataset: args.entry.dataset,
    label: args.entry.label,
    generate,
    pipeline,
    nextScheduledRun,
  };
}
