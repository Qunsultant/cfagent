/**
 * Issue #3535 (Pipeline J2, epic #3533) — the feed jobs as J1
 * pipeline jobs: definitions, the step library the runs execute,
 * name resolution for the copilot/UX surfaces, and the merged
 * status view. This module is the composition point between the
 * two landed foundations it evolves — it builds nothing parallel:
 *
 * - The J1 job pipeline (#3534): every feed job is a job
 *   DEFINITION (configuration alone) on the one control plane
 *   (JobPipelineControl) — schedulable, configurable, manageable
 *   (run / pause / resume-from-checkpoint / cancel / retry) and
 *   stage-addressable through the uniform operations, in every
 *   execution mode the engine supports.
 * - The #3530 feed machinery (feedJobs.ts): the step a feed job
 *   runs IS the #3530 run — the provider port fetch, the stored
 *   index-list universe, persistence through the capture-wired
 *   adapter into the feed-dataset store (the platform's local
 *   copy). A pipeline run and the S1 route run are the same work
 *   through two dispatch surfaces (#3514 uniformity); the run id
 *   the engine mints is the run id the captures and the dataset
 *   artifact carry, so every record of a run names the same run.
 *
 * The Nasdaq provider declares screenUniverse only (no quotes
 * legs), so the Nasdaq-100 universe job is the seventh job: its
 * step runs the platform's index-refresh producer (#1980) for
 * nasdaq100 — the stored index list IS the platform's persisted
 * Nasdaq-100 universe copy, the copy every quotes job reads.
 */
import type { DataProvider, DataProviderId } from "../trading";
import type { Env } from "../types";
import type { IndexListStore } from "../data/indexListPorts";
import type { FeedDatasetStore } from "../data/feedDatasetPorts";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  resolveRunUniverse,
  runFeedFundamentalsJob,
  runFeedJob,
  runFeedSentimentJob,
  runFeedTechnicalsJob,
  FEED_JOB_CODES,
  type FeedJobDefinition,
  type FeedJobRegistry,
  type FeedRunResult,
  type FeedStatusView,
} from "./feedJobs";
import {
  executeIndexListRefreshJob,
  type IndexListJobResult,
} from "./indexListJob";
import type { IndexListFetchService } from "./indexListProducer";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type {
  JobPipelineControl,
  JobStatusView,
} from "./jobPipelineEngine";
import { withSchedulePreserved } from "./jobPipelineEngine";
import {
  createBuiltinStepRegistry,
  JobStepRegistry,
  type JobStepContext,
} from "./jobPipelineSteps";

/** The step names a feed job's configuration references. */
export const FEED_PULL_STEP = "feed.pull";
export const FEED_UNIVERSE_STEP = "feed.universe";

/** The Nasdaq-100 universe job (the stored index list's refresh). */
export const NASDAQ100_UNIVERSE_JOB_ID = "nasdaq-nasdaq100-universe";

/** One catalog entry: how the surfaces name and find a feed job. */
export interface FeedPipelineCatalogEntry {
  jobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  /** Lower-case name fragments the copilot/UX resolution accepts. */
  aliases: readonly string[];
}

/**
 * The feed-job catalog — every pipeline feed job, in surface
 * order. The first six are #3530 feed jobs (feedJobs.ts registry);
 * the seventh is the universe job defined below.
 */
export const FEED_PIPELINE_CATALOG: readonly FeedPipelineCatalogEntry[] = [
  {
    jobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Nasdaq-100",
    aliases: ["yahoo", "yahoo quotes", "yahoo nasdaq100", "nasdaq100 quotes"],
  },
  {
    jobId: "yahoo-nasdaq100-fundamentals",
    sourceId: "yahoo",
    dataset: "fundamentals",
    // #3930: ONE parameterized fundamentals job — the label
    // names the DEFAULT universe (nasdaq100); a run's universe
    // input serves any stored list.
    label: "Yahoo fundamentals — parameterized (default Nasdaq-100)",
    aliases: ["fundamentals", "yahoo fundamentals"],
  },
  {
    jobId: "yahoo-nasdaq100-technicals",
    sourceId: "yahoo",
    dataset: "technicals",
    // #3931: ONE parameterized technicals job — the label
    // names the DEFAULT universe (nasdaq100); a run's universe
    // input serves any stored list.
    label: "Yahoo technicals — parameterized (default Nasdaq-100)",
    aliases: ["technicals", "yahoo technicals"],
  },
  {
    jobId: "yahoo-nasdaq100-sentiment",
    sourceId: "yahoo",
    dataset: "sentiment",
    // #3932: ONE parameterized sentiment job — the label
    // names the DEFAULT universe (nasdaq100); a run's universe
    // input serves any stored list.
    label: "Yahoo sentiment — parameterized (default Nasdaq-100)",
    aliases: ["sentiment", "yahoo sentiment"],
  },
  {
    jobId: "yahoo-sp100-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — S&P 100",
    aliases: ["sp100", "s&p 100", "yahoo sp100"],
  },
  {
    jobId: "yahoo-sp500-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — S&P 500",
    aliases: ["sp500", "s&p 500", "yahoo sp500"],
  },
  {
    jobId: "yahoo-dow-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Dow Jones Industrial Average",
    aliases: ["dow", "dow jones", "yahoo dow"],
  },
  {
    jobId: "yahoo-sp400-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — S&P MidCap 400",
    aliases: ["sp400", "s&p 400", "yahoo sp400"],
  },
  {
    jobId: "alpaca-nasdaq100-quotes",
    sourceId: "alpaca",
    dataset: "quotes",
    label: "Alpaca quotes — Nasdaq-100",
    aliases: ["alpaca"],
  },
  {
    jobId: "etrade-nasdaq100-quotes",
    sourceId: "etrade",
    dataset: "quotes",
    label: "E*TRADE quotes — Nasdaq-100",
    aliases: ["etrade", "e*trade", "e-trade"],
  },
  {
    jobId: "public-nasdaq100-quotes",
    sourceId: "public",
    dataset: "quotes",
    label: "Public.com quotes — Nasdaq-100",
    aliases: ["public", "public.com"],
  },
  {
    jobId: NASDAQ100_UNIVERSE_JOB_ID,
    sourceId: "nasdaq",
    dataset: "universe",
    label: "Nasdaq-100 universe (stored index list)",
    aliases: ["nasdaq", "nasdaq100", "nasdaq-100", "nasdaq universe"],
  },
];

/**
 * Resolve a surface's name for a feed job ("Yahoo", "Alpaca",
 * "Nasdaq-100", "SP100", "fundamentals", an exact job id) to the
 * catalog entry. Exact job ids win; then exact aliases; then a
 * unique alias the query contains. Ambiguous or unknown names
 * return null — the caller refuses by name rather than guessing
 * (the #2144 no-silent-substitution rule, applied to job names).
 */
export function resolveFeedJob(
  query: string,
): FeedPipelineCatalogEntry | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = FEED_PIPELINE_CATALOG.find((e) => e.jobId === q);
  if (byId) return byId;
  const exact = FEED_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => a === q),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const containing = FEED_PIPELINE_CATALOG.filter((e) =>
    e.aliases.some((a) => q.includes(a)),
  );
  return containing.length === 1 ? containing[0] : null;
}

/** The raw J1 definition (configuration alone) for one #3530 feed job. */
export function buildFeedPipelineJobDefinition(def: FeedJobDefinition): unknown {
  return {
    jobId: def.id,
    name: `Feed — ${def.sourceId} ${def.dataset} (${def.universe.label})`,
    root: {
      kind: "feed",
      steps: [{ step: FEED_PULL_STEP, params: { feedJobId: def.id } }],
      inputs: { sources: [def.sourceId], datasets: [def.dataset] },
      schedule: {
        enabled: true,
        interval: `every ${def.cadenceMinutes} minutes`,
      },
    },
  };
}

/** The raw J1 definition for the Nasdaq-100 universe job. */
export function buildNasdaqUniverseJobDefinition(cadenceMinutes: number): unknown {
  return {
    jobId: NASDAQ100_UNIVERSE_JOB_ID,
    name: "Feed — Nasdaq-100 universe (stored index list)",
    root: {
      kind: "feed",
      steps: [{ step: FEED_UNIVERSE_STEP, params: { index: "nasdaq100" } }],
      inputs: { sources: ["nasdaq"], datasets: ["universe"] },
      schedule: { enabled: true, interval: `every ${cadenceMinutes} minutes` },
    },
  };
}

/** Every raw feed-job definition, in catalog order. */
export function buildAllFeedPipelineJobDefinitions(
  env: Record<string, string | undefined>,
): unknown[] {
  const registry = buildFeedJobRegistry(env);
  const definitions: unknown[] = FEED_PIPELINE_CATALOG.map((entry) => {
    if (entry.jobId === NASDAQ100_UNIVERSE_JOB_ID) {
      const yahoo = registry.get("yahoo-nasdaq100-quotes");
      return buildNasdaqUniverseJobDefinition(yahoo?.cadenceMinutes ?? 60);
    }
    const def = registry.get(entry.jobId);
    if (!def) {
      throw new Error(
        `Feed catalog entry "${entry.jobId}" has no #3530 feed job registered — the catalog and the registry have drifted.`,
      );
    }
    return buildFeedPipelineJobDefinition(def);
  });
  return definitions;
}

/**
 * Define every feed job on a control plane, skipping definitions
 * whose stored raw configuration already matches (re-declaring on
 * every host boot must not churn definition versions). Returns
 * the job ids ensured, in catalog order.
 */
export async function ensureFeedPipelineJobs(
  control: JobPipelineControl,
  stores: JobPipelineStores,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const ensured: string[] = [];
  for (const raw of buildAllFeedPipelineJobDefinitions(env)) {
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

/** Host-supplied wiring for the feed steps (one per residency). */
export interface FeedStepDeps {
  /** The #3530 registry the step resolves its job contract from. */
  registry: FeedJobRegistry;
  /**
   * The capture-wired provider for a feed job's source. Undefined
   * ⇒ the step refuses FEED_JOB_NOT_CONFIGURED (a run is never
   * fetched through an unwired, uncaptured path).
   */
  providerFor: (def: FeedJobDefinition) => DataProvider | undefined;
  /** The stored index-list store (universes). Null ⇒ not configured. */
  universeStore: IndexListStore | null;
  /** The feed-dataset store (the local copy). Null ⇒ not configured. */
  datasetStore: FeedDatasetStore | null;
  /** The index-refresh wiring for the universe step. Null ⇒ not configured. */
  indexRefresh?: {
    store: IndexListStore;
    service: IndexListFetchService;
  } | null;
  /**
   * The job's currently configured shard keys (its definition's
   * processing.shards, read at run time so a configureJob patch
   * takes effect on the next run). Hosts wire this from the
   * pipeline definition store; absent ⇒ step params may carry
   * "shards" instead.
   */
  shardsFor?: (jobId: string) => Promise<readonly string[]>;
  /** The acting login threaded into provider run contexts, when the host has one. */
  userLogin?: string;
  /**
   * #3932 — the Worker env the sentiment job classifies
   * through (the #132 classifier needs the AI binding via the
   * gateway port). Optional: a host without it runs the
   * sentiment job honestly unassessed (rows persist with
   * method "unavailable"); the other feed jobs ignore it.
   */
  env?: Env;
}

/** The coded refusal every unwired feed step fails its run with. */
export function feedNotConfigured(jobId: string, missing: string): Error {
  return new Error(
    `FEED_JOB_NOT_CONFIGURED: feed job "${jobId}" cannot run on this host — ${missing} is not wired. The run was refused rather than fetching through an unwired path.`,
  );
}

/**
 * Partition the universe for one shard unit: shard keys come
 * from the job's configured processing.shards (the definition
 * order); a unit pulls the symbols whose universe index falls in
 * its partition. Monolith runs (no shardKey) pull the whole
 * universe. Returns null for the whole-universe case.
 */
export function feedShardSymbols(
  universeSymbols: readonly string[],
  shards: readonly string[],
  shardKey: string | null,
): string[] | null {
  if (!shardKey) return null;
  const index = shards.indexOf(shardKey);
  if (index < 0 || shards.length === 0) return null;
  return universeSymbols.filter((_, i) => i % shards.length === index);
}

/**
 * The feed step registry: the J1 built-ins plus the two feed
 * steps. Hosts compose this wherever a pipeline control plane is
 * built for feed work (the ScheduledAgent host, the workflow
 * residency) — one registry, every residency.
 */
export function createFeedStepRegistry(deps: FeedStepDeps): JobStepRegistry {
  const registry = createBuiltinStepRegistry();

  registry.register(FEED_PULL_STEP, async (ctx: JobStepContext) => {
    const feedJobId =
      typeof ctx.params.feedJobId === "string" ? ctx.params.feedJobId : "";
    const def = deps.registry.get(feedJobId);
    if (!def) {
      throw new Error(
        `${FEED_JOB_CODES.jobNotFound}: step "${FEED_PULL_STEP}" names feed job "${feedJobId}", which is not in the feed registry.`,
      );
    }
    if (!deps.datasetStore) throw feedNotConfigured(def.id, "the feed-dataset store");
    if (!deps.universeStore) throw feedNotConfigured(def.id, "the index-list (universe) store");
    const provider = deps.providerFor(def);
    if (!provider) throw feedNotConfigured(def.id, `a capture-wired provider for "${def.sourceId}"`);

    // #3930: the run's universe input (a parameterized job —
    // fundamentals, technicals, sentiment): the step param names the stored index
    // list; absent ⇒ the definition's universe. Resolved (and
    // refused by name when unknown or unsupported) BEFORE any
    // refresh or fetch, so the refresh, the shard partition,
    // and the run all read the same list.
    const universeParam =
      typeof ctx.params.universe === "string" && ctx.params.universe.trim() !== ""
        ? ctx.params.universe.trim().toLowerCase()
        : undefined;
    const effectiveUniverse = resolveRunUniverse(def, universeParam);

    // #3976: hydration lives in the RUNNERS now — the host's
    // indexRefresh wiring is passed into the runner deps below,
    // and a refresh failure is recorded on the run as
    // FEED_UNIVERSE_REFRESH_FAILED instead of being swallowed
    // here (the pre-#3976 `.catch(() => undefined)`) and
    // resurfacing as the bare FEED_UNIVERSE_MISSING. The one
    // step-level hydration that remains is FOR THE SHARD
    // PARTITION READ ONLY: a sharded unit's partition is
    // computed from the stored list BEFORE its run (the #3535
    // pin: one run per unit, pulling only its partition), so a
    // cold store must be hydrated before that read. Its failure
    // is thrown NAMED — never swallowed.
    if (ctx.shardKey && deps.indexRefresh) {
      const existingList = await deps.universeStore.latest(effectiveUniverse);
      if (!existingList || existingList.symbols.length === 0) {
        try {
          await executeIndexListRefreshJob({
            store: deps.indexRefresh.store,
            service: deps.indexRefresh.service,
            indices: [effectiveUniverse],
          });
        } catch (err) {
          throw new Error(
            `${FEED_JOB_CODES.universeRefreshFailed}: index-list refresh for the "${effectiveUniverse}" universe failed before the shard partition could be computed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Sharded shape: this unit pulls its partition of the
    // universe (the partition is computed from the stored list —
    // the same list the run itself resolves, so partitions and
    // the whole-universe pull can never disagree on membership).
    let symbols: string[] | undefined;
    if (ctx.shardKey) {
      const shards =
        (await deps.shardsFor?.(def.id)) ??
        (Array.isArray(ctx.params.shards) ? (ctx.params.shards as string[]) : []);
      const list = await deps.universeStore.latest(effectiveUniverse);
      const universeSymbols = list
        ? list.symbols.map((m) => m.symbol.toUpperCase().trim()).filter(Boolean)
        : [];
      symbols = feedShardSymbols(universeSymbols, shards, ctx.shardKey) ?? undefined;
    }

    const runOpts = {
      trigger: "manual" as const,
      runId: ctx.runId,
      ...(deps.userLogin ? { userLogin: deps.userLogin } : {}),
      ...(universeParam ? { universe: effectiveUniverse } : {}),
      ...(symbols ? { symbols } : {}),
    };
    const runnerDeps = {
      provider,
      universeStore: deps.universeStore,
      datasetStore: deps.datasetStore,
      ...(deps.indexRefresh ? { indexRefresh: deps.indexRefresh } : {}),
    };
    const result: FeedRunResult =
      def.dataset === "fundamentals"
        ? await runFeedFundamentalsJob(deps.registry, runnerDeps, def.id, runOpts)
        : def.dataset === "technicals"
          ? await runFeedTechnicalsJob(deps.registry, runnerDeps, def.id, runOpts)
          : def.dataset === "sentiment"
            ? await runFeedSentimentJob(
                deps.registry,
                { ...runnerDeps, ...(deps.env ? { env: deps.env } : {}) },
                def.id,
                runOpts,
              )
            : await runFeedJob(deps.registry, runnerDeps, def.id, runOpts);
    if (result.status === "failed") {
      // The feed run recorded its own failure in the dataset
      // store; the pipeline run fails with the same coded error
      // so the job's run record and the dataset record agree.
      throw new Error(
        `${result.codedError ?? "FEED_FETCH_FAILED"}: feed job "${def.id}" run ${result.runId} failed (${result.requested} requested, ${result.received} received).`,
      );
    }
    return {
      output: {
        feedJobId: def.id,
        sourceId: def.sourceId,
        dataset: def.dataset,
        feedRunId: result.runId,
        artifactId: result.artifactId,
        status: result.status,
        requested: result.requested,
        received: result.received,
        failed: result.failed,
        missingSymbols: result.missingSymbols,
      },
      descriptor: `feed ${def.sourceId}/${def.dataset}: ${result.received}/${result.requested} rows persisted (artifact ${result.artifactId})`,
    };
  });

  registry.register(FEED_UNIVERSE_STEP, async (ctx: JobStepContext) => {
    if (!deps.indexRefresh) {
      throw feedNotConfigured(NASDAQ100_UNIVERSE_JOB_ID, "the index-refresh wiring");
    }
    const index = typeof ctx.params.index === "string" ? ctx.params.index : "nasdaq100";
    if (index !== "nasdaq100") {
      throw new Error(
        `${FEED_JOB_CODES.jobNotFound}: step "${FEED_UNIVERSE_STEP}" maintains the nasdaq100 list only; got "${index}".`,
      );
    }
    const result: IndexListJobResult = await executeIndexListRefreshJob({
      store: deps.indexRefresh.store,
      service: deps.indexRefresh.service,
      indices: ["nasdaq100"],
    });
    // executeIndexListRefreshJob throws when every index failed,
    // so reaching here means the stored list was refreshed (a
    // partial result still names its failures in the output).
    const artifact = result.artifacts[0];
    return {
      output: {
        feedJobId: NASDAQ100_UNIVERSE_JOB_ID,
        sourceId: "nasdaq",
        dataset: "universe",
        index: "nasdaq100",
        status: result.status,
        artifactId: artifact?.artifactId ?? null,
        memberCount: artifact?.memberCount ?? 0,
        snapshotDate: artifact?.snapshotDate ?? null,
        failures: result.failures,
      },
      descriptor: `nasdaq100 universe refreshed: ${artifact?.memberCount ?? 0} members (snapshot ${artifact?.snapshotDate ?? "unknown"})`,
    };
  });

  return registry;
}

/* ------------------------------------------------------------------ */
/* The merged status view (UX + copilot — one source of truth)         */
/* ------------------------------------------------------------------ */

/**
 * One feed job's surface status: the #3530 dataset view (last
 * run, rows persisted, freshness, history) joined with the J1
 * pipeline view (instance state, the current/last run's stages)
 * and the next scheduled firing estimated from the declared
 * cadence. Either side may be absent (never defined on the
 * pipeline host / never run) — absence renders as an honest
 * state, never a fabricated one.
 */
export interface FeedJobSurfaceView {
  jobId: string;
  sourceId: DataProviderId;
  dataset: string;
  label: string;
  feed: FeedStatusView | null;
  pipeline: {
    state: string;
    currentRunId: string | null;
    /** Issue #4002 (recording slice): when the instance's current
     *  run started. The onStart recovery uses this as the guard
     *  for attributing a pipeline run id to an orphaned async
     *  job row — a run that started after the executor's last
     *  activity is a later run, not this row's orphan. Read
     *  straight from the instance record, not from artifacts, so
     *  it survives the host's orphan settle. */
    runStartedAt: string | null;
    lastRunStatus: string | null;
    lastRunAt: string | null;
    stages: JobStatusView["stages"];
  } | null;
  /** ISO time of the next scheduled firing, estimated as the
   *  last dispatch + the declared interval; null when unknown. */
  nextScheduledRun: string | null;
  /**
   * The STORED definition's schedule — the configuration that
   * actually schedules this job (#3530 scheduling-config) — or
   * null when there is no stored pipeline definition to read it
   * from (host unreachable / never defined): an honest unknown,
   * never a cadence fabricated from the registry default.
   */
  schedule: {
    enabled: boolean;
    interval: string | null;
    cron: string | null;
  } | null;
}

export async function buildFeedJobSurfaceView(args: {
  entry: FeedPipelineCatalogEntry;
  datasetStore: FeedDatasetStore | null;
  registry: FeedJobRegistry;
  pipeline: JobStatusView | null;
  nowMs: number;
}): Promise<FeedJobSurfaceView> {
  const def = args.registry.get(args.entry.jobId);
  const feed =
    args.datasetStore && def
      ? await buildFeedStatus(args.datasetStore, def, args.nowMs)
      : null;
  const pipeline = args.pipeline
    ? {
        state: args.pipeline.instance?.state ?? "idle",
        currentRunId: args.pipeline.instance?.currentRunId ?? null,
        // Issue #4002 (recording slice): the instance's current
        // run start, straight from the record — not lastRunAt,
        // which the host's orphan settle rewrites to settle time.
        runStartedAt: args.pipeline.instance?.runStartedAt ?? null,
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
      args.pipeline?.instance?.runStartedAt ?? feed?.lastRun?.startedAt ?? null;
    const cadence = def?.cadenceMinutes ?? null;
    if (anchor && cadence) {
      const at = Date.parse(anchor);
      if (!Number.isNaN(at)) {
        nextScheduledRun = new Date(at + cadence * 60_000).toISOString();
      }
    }
  }
  const storedSchedule = args.pipeline?.definition.config.schedule;
  return {
    jobId: args.entry.jobId,
    sourceId: args.entry.sourceId,
    dataset: args.entry.dataset,
    label: args.entry.label,
    feed,
    pipeline,
    nextScheduledRun,
    schedule: storedSchedule
      ? {
          enabled: storedSchedule.enabled,
          interval: storedSchedule.interval ?? null,
          cron: storedSchedule.cron ?? null,
        }
      : null,
  };
}
