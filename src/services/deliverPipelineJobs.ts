/**
 * Issue #3539 (Pipeline J6, epic #3533) — the deliver jobs as
 * J1 pipeline jobs: definitions, the step the runs execute,
 * name resolution for the copilot/UX surfaces, and the merged
 * status view. The composition point between the landed
 * foundations, in the generatePipelineJobs.ts pattern — it
 * builds nothing parallel:
 *
 * - The J1 job pipeline (#3534): every deliver job is a job
 *   DEFINITION (configuration alone) on the one control plane
 *   (JobPipelineControl) — schedulable, configurable,
 *   manageable, stage-addressable, in every execution mode the
 *   engine supports.
 * - The deliver service (deliverJobs.ts): the step a deliver
 *   job runs IS the deliver run — resolve the generate job's
 *   PERSISTED generated dataset, deliver each report over the
 *   configured channels (the platform's transports behind
 *   their existing seams), persist the per-channel outcomes.
 *   The run id the engine mints is the run id the delivery
 *   artifact carries, so every record of a run names the
 *   same run.
 * - The trigger: a deliver job is the CONSUMER of its
 *   generate job — the host dispatches it when the generate
 *   job's completion is recorded (the queue publication), and
 *   it is independently schedulable/runnable like every job
 *   on the plane. Deliver is the END OF THE CHAIN: its own
 *   completions dispatch nothing.
 *
 * The composed step registry (createPipelineStepRegistry in
 * enrichPipelineJobs.ts) gains deliver.apply through this
 * module's registerDeliverStep — the same one registry every
 * residency builds; no second engine entry, no parallel
 * registry.
 */
import type { DataProviderId } from "../trading";
import type { GeneratedDatasetStore } from "../data/generatedDatasetPorts";
import type { DeliveryDatasetStore } from "../data/deliveryDatasetPorts";
import {
  buildDeliverJobRegistry,
  buildDeliverStatus,
  deliverPairKey,
  runDeliverJob,
  DELIVER_JOB_CODES,
  type DeliverChannel,
  type DeliverChannelSenders,
  type DeliverJobDefinition,
  type DeliverJobRegistry,
  type DeliverStatusView,
} from "./deliverJobs";
import {
  feedShardSymbols,
  FEED_PIPELINE_CATALOG,
} from "./feedPipelineJobs";
import { GENERATE_PIPELINE_CATALOG } from "./generatePipelineJobs";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type {
  JobPipelineControl,
  JobStatusView,
} from "./jobPipelineEngine";
import { JobStepRegistry, type JobStepContext } from "./jobPipelineSteps";

/** The step name a deliver job's configuration references. */
export const DELIVER_APPLY_STEP = "deliver.apply";

/** One catalog entry: how the surfaces name and find a deliver job. */
export interface DeliverPipelineCatalogEntry {
  jobId: string;
  generateJobId: string;
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
 * The deliver-job catalog — one entry per generate job, in
 * feed-catalog order (derived from the feed + generate
 * catalogs exactly as the generate catalog derives from the
 * analyze catalog: the job id extends the lineage <feed
 * job>-enrich-analyze-generate-deliver). The synthetic
 * bare-source aliases ("alpaca deliver") are granted only to
 * a source with ONE quotes job, so no invented alias is ever
 * ambiguous; the feed catalog's aliases are inherited with
 * " deliver" appended/prepended, and the generate forms are
 * inherited the same way — including the exact-unique bare
 * "yahoo", which resolves here as "yahoo deliver" (#2144:
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
const GENERATE_BY_JOB_ID = new Map(GENERATE_PIPELINE_CATALOG.map((e) => [e.jobId, e]));
export const DELIVER_PIPELINE_CATALOG: readonly DeliverPipelineCatalogEntry[] =
  QUOTES_FEED_ENTRIES.map((feed) => {
    const generateJobId = `${feed.jobId}-enrich-analyze-generate`;
    const generate = GENERATE_BY_JOB_ID.get(generateJobId);
    if (!generate) {
      throw new Error(
        `Deliver catalog: generate catalog entry "${generateJobId}" is missing — the catalogs have drifted.`,
      );
    }
    return {
      jobId: `${generateJobId}-deliver`,
      generateJobId,
      analyzeJobId: `${feed.jobId}-enrich-analyze`,
      enrichJobId: `${feed.jobId}-enrich`,
      feedJobId: feed.jobId,
      sourceId: feed.sourceId,
      dataset: feed.dataset,
      label: `Deliver — ${feed.label}`,
      aliases: [
        ...((SOURCE_JOB_COUNT.get(feed.sourceId) ?? 0) === 1
          ? [`${feed.sourceId} deliver`, `deliver ${feed.sourceId}`]
          : []),
        `${generateJobId}-deliver`,
        ...feed.aliases.map((a) => `${a} deliver`),
        ...feed.aliases.map((a) => `deliver ${a}`),
        ...generate.aliases.map((a) => `${a} deliver`),
        ...generate.aliases.map((a) => `deliver ${a}`),
      ],
    };
  });

/**
 * Resolve a surface's name for a deliver job ("yahoo
 * deliver", "deliver alpaca", an exact job id) to the
 * catalog entry. Exact job ids win; then exact aliases; then
 * a unique alias the query contains. Ambiguous or unknown
 * names return null — the caller refuses by name rather than
 * guessing (the #2144 rule, the feed/enrich/analyze/generate
 * resolvers' idiom).
 */
export function resolveDeliverJob(
  query: string,
): DeliverPipelineCatalogEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = DELIVER_PIPELINE_CATALOG.find((e) => e.jobId === q);
  if (byId) return byId;
  const exact = DELIVER_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => a === q),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = DELIVER_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => q.includes(a)),
  );
  return containing.length === 1 ? containing[0] : null;
}

/** The raw J1 definition (configuration alone) for one deliver
 *  job. The rules (channels + targets) live in the step
 *  params — configuration the operator changes through
 *  configureJob, never code. */
export function buildDeliverPipelineJobDefinition(
  def: DeliverJobDefinition,
): unknown {
  return {
    jobId: def.id,
    name: `Deliver — ${def.sourceId} ${def.dataset} (${def.universe.label})`,
    root: {
      kind: "deliver",
      steps: [
        {
          step: DELIVER_APPLY_STEP,
          params: {
            deliverJobId: def.id,
            channels: [...def.channels],
            ...(def.slackChannel ? { slackChannel: def.slackChannel } : {}),
            ...(def.emailTo ? { emailTo: def.emailTo } : {}),
            ...(def.webhookUrl ? { webhookUrl: def.webhookUrl } : {}),
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

/** Every raw deliver-job definition, in catalog order. */
export function buildAllDeliverPipelineJobDefinitions(
  env: Record<string, string | undefined>,
): unknown[] {
  const registry = buildDeliverJobRegistry(env);
  return DELIVER_PIPELINE_CATALOG.map((entry) => {
    const def = registry.get(entry.jobId);
    if (!def) {
      throw new Error(
        `Deliver catalog entry "${entry.jobId}" has no deliver job registered — the catalog and the registry have drifted.`,
      );
    }
    return buildDeliverPipelineJobDefinition(def);
  });
}

/**
 * Define every deliver job on a control plane, skipping
 * definitions whose stored raw configuration already matches
 * (the feed/enrich/analyze/generate ensure's idiom). Returns
 * the job ids ensured.
 */
export async function ensureDeliverPipelineJobs(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const raw of buildAllDeliverPipelineJobDefinitions(env)) {
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

/** Host-supplied wiring for the deliver step (one per residency). */
export interface DeliverStepDeps {
  /** The deliver registry the step resolves its job contract from. */
  registry: DeliverJobRegistry;
  /** The generated-dataset store (the persisted inputs). Null ⇒ not configured. */
  generatedStore: GeneratedDatasetStore | null;
  /** The delivery-dataset store (this stage's output). Null ⇒ not configured. */
  deliveryStore: DeliveryDatasetStore | null;
  /** The channel senders for this residency (deliverJobs'
   *  createDeliverChannelSenders in production). */
  senders: DeliverChannelSenders;
  /** Per-channel coded reasons a sender could not be built. */
  unconfiguredReasons?: Partial<Record<DeliverChannel, string>>;
  /**
   * The job's currently configured shard keys (its definition's
   * processing.shards, read at run time — the feed wiring's
   * idiom). Absent ⇒ step params may carry "shards" instead.
   */
  shardsFor?: (jobId: string) => Promise<readonly string[]>;
}

/** The coded refusal every unwired deliver step fails its run with. */
export const DELIVER_NOT_CONFIGURED = "DELIVER_JOB_NOT_CONFIGURED";
export function deliverNotConfigured(jobId: string, missing: string): Error {
  return new Error(
    `${DELIVER_NOT_CONFIGURED}: deliver job "${jobId}" cannot run on this host — ${missing} is not wired. The run was refused rather than reading or writing through an unwired path.`,
  );
}

function stringParams(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : undefined;
}

function stringParam(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Register the deliver step on a registry. Hosts compose the
 * FULL registry through createPipelineStepRegistry (in
 * enrichPipelineJobs.ts, which takes these deps as its fifth
 * argument); this function exists so a registry built for
 * tests can add the deliver step alone.
 */
export function registerDeliverStep(
  registry: JobStepRegistry,
  deps: DeliverStepDeps,
): void {
  registry.register(DELIVER_APPLY_STEP, async (ctx: JobStepContext) => {
    const deliverJobId =
      typeof ctx.params.deliverJobId === "string" ? ctx.params.deliverJobId : "";
    const def = deps.registry.get(deliverJobId);
    if (!def) {
      throw new Error(
        `${DELIVER_JOB_CODES.jobNotFound}: step "${DELIVER_APPLY_STEP}" names deliver job "${deliverJobId}", which is not in the deliver registry.`,
      );
    }
    if (!deps.generatedStore) throw deliverNotConfigured(def.id, "the generated-dataset store");
    if (!deps.deliveryStore) throw deliverNotConfigured(def.id, "the delivery-dataset store");

    const channels = stringParams(ctx.params.channels) ?? [...def.channels];

    // Sharded shape: this unit delivers its partition of the
    // run's (report × channel) pairs (the pair list is computed
    // from the PERSISTED input — the same copy the run
    // resolves, so partitions and the whole-input run can
    // never disagree on membership; the sibling steps'
    // partition idiom applied to pair keys). A pair belongs
    // to exactly one shard unit, so sharded delivery never
    // double-sends; the store's per-input dedupe covers the
    // cross-mode case (a sharded run after a whole run).
    let pairKeys: string[] | undefined;
    if (ctx.shardKey) {
      const shards =
        (await deps.shardsFor?.(def.id)) ??
        (Array.isArray(ctx.params.shards) ? (ctx.params.shards as string[]) : []);
      const input = await deps.generatedStore.latestUsable(def.generateJobId);
      const allPairKeys = input
        ? input.reports
            .filter((r) => r.formats.some((f) => f.status === "generated"))
            .flatMap((r) => channels.map((c) => deliverPairKey(r.kind, c)))
        : [];
      pairKeys = feedShardSymbols(allPairKeys, shards, ctx.shardKey) ?? undefined;
    }

    const result = await runDeliverJob(
      deps.registry,
      {
        generatedStore: deps.generatedStore,
        deliveryStore: deps.deliveryStore,
        senders: deps.senders,
        ...(deps.unconfiguredReasons
          ? { unconfiguredReasons: deps.unconfiguredReasons }
          : {}),
      },
      def.id,
      {
        trigger: "manual",
        runId: ctx.runId,
        ...(stringParams(ctx.params.channels)
          ? { channels: stringParams(ctx.params.channels) }
          : {}),
        ...(stringParam(ctx.params.slackChannel) !== undefined
          ? { slackChannel: stringParam(ctx.params.slackChannel) }
          : {}),
        ...(stringParam(ctx.params.emailTo) !== undefined
          ? { emailTo: stringParam(ctx.params.emailTo) }
          : {}),
        ...(stringParam(ctx.params.webhookUrl) !== undefined
          ? { webhookUrl: stringParam(ctx.params.webhookUrl) }
          : {}),
        ...(pairKeys ? { pairKeys } : {}),
      },
    );
    if (result.status === "failed") {
      // The deliver run recorded its own failure in the
      // delivery store; the pipeline run fails with the same
      // coded error so the job's run record and the dataset
      // record agree.
      throw new Error(
        `${result.codedError ?? "DELIVER_RUN_FAILED"}: deliver job "${def.id}" run ${result.runId} failed (${result.errorMessage ?? "no detail"})`,
      );
    }
    return {
      output: {
        deliverJobId: def.id,
        generateJobId: def.generateJobId,
        sourceId: def.sourceId,
        dataset: def.dataset,
        deliverRunId: result.runId,
        artifactId: result.artifactId,
        status: result.status,
        requested: result.requested,
        received: result.received,
        failed: result.failed,
        inputArtifactId: result.inputArtifactId,
        inputRunId: result.inputRunId,
        reportsDelivered: result.reportsDelivered,
        channelOutcomes: result.channelOutcomes,
      },
      descriptor: `deliver ${def.sourceId}/${def.dataset}: ${result.received}/${result.requested} channel deliveries recorded (artifact ${result.artifactId}, input run ${result.inputRunId})`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* The merged status view (UX + copilot — one source of truth)         */
/* ------------------------------------------------------------------ */

/**
 * One deliver job's surface status: the delivery-dataset view
 * (last run, channels delivered, freshness, lineage, history)
 * joined with the J1 pipeline view and the next scheduled
 * firing estimated from the declared cadence (the generate
 * surface view's shape, transposed).
 */
export interface DeliverJobSurfaceView {
  jobId: string;
  generateJobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  deliver: DeliverStatusView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    stages: JobStatusView["stages"];
  } | null;
  nextScheduledRun: string | null;
}

export async function buildDeliverJobSurfaceView(args: {
  entry: DeliverPipelineCatalogEntry;
  deliveryStore: DeliveryDatasetStore | null;
  registry: DeliverJobRegistry;
  pipeline: JobStatusView | null;
  nowMs: number;
}): Promise<DeliverJobSurfaceView> {
  const def = args.registry.get(args.entry.jobId);
  const deliver =
    args.deliveryStore && def
      ? await buildDeliverStatus(args.deliveryStore, def, args.nowMs)
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
      args.pipeline?.instance?.runStartedAt ?? deliver?.lastRun?.startedAt ?? null;
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
    generateJobId: args.entry.generateJobId,
    analyzeJobId: args.entry.analyzeJobId,
    enrichJobId: args.entry.enrichJobId,
    feedJobId: args.entry.feedJobId,
    sourceId: args.entry.sourceId,
    dataset: args.entry.dataset,
    label: args.entry.label,
    deliver,
    pipeline,
    nextScheduledRun,
  };
}
