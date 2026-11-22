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
import type { DataProvider, DataProviderId, IndexId } from "../trading";
import type { Env } from "../types";
import type { IndexListStore } from "../data/indexListPorts";
import type { FeedDatasetStore } from "../data/feedDatasetPorts";
import type { FeedProviderWiringDeps } from "./feedProviderWiring";
import { resolveProviderDataset } from "../config/vocabulary";
import {
  buildFeedJobRegistry,
  buildFeedStatus,
  resolveRunUniverse,
  runFeedFundamentalsJob,
  runFeedJob,
  runFeedOptionsChainsJob,
  runFeedSentimentJob,
  runFeedTechnicalsJob,
  FEED_JOB_CODES,
  FEED_JOB_DEFAULTS,
  type FeedJobDefinition,
  type FeedJobRegistry,
  type FeedRunResult,
  type FeedStatusView,
} from "./feedJobs";
import {
  INDEX_REFRESH_INDICES,
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
  /** The family a surface groups by (e.g. "nasdaq100"); absent = not in a named family. */
  family?: string;
  /** The declared consumers of this dataset (surface copy; the validated graph is #6049). */
  consumers?: readonly string[];
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
    family: "index100",
    consumers: ["enrich", "analyze", "research"],
    label: "Yahoo quotes — Nasdaq-100",
    aliases: ["yahoo", "yahoo quotes", "yahoo nasdaq100", "nasdaq100 quotes"],
  },
  {
    jobId: "yahoo-nasdaq100-fundamentals",
    sourceId: "yahoo",
    dataset: "fundamentals",
    family: "index100",
    consumers: ["enrich", "analyze"],
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
    family: "index100",
    consumers: ["enrich", "screener"],
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
    family: "index100",
    consumers: ["enrich", "screener"],
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
    jobId: "yahoo-sector-energy-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Energy",
    aliases: ["sector-energy", "energy", "yahoo sector energy"],
  },
  {
    jobId: "yahoo-sector-materials-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Materials",
    aliases: ["sector-materials", "materials", "yahoo sector materials"],
  },
  {
    jobId: "yahoo-sector-industrials-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Industrials",
    aliases: [
      "sector-industrials",
      "industrials",
      "yahoo sector industrials",
    ],
  },
  {
    jobId: "yahoo-sector-consumer-discretionary-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Consumer Discretionary",
    aliases: [
      "sector-consumer-discretionary",
      "consumer-discretionary",
      "consumer discretionary",
      "yahoo sector consumer-discretionary",
      "yahoo sector consumer discretionary",
    ],
  },
  {
    jobId: "yahoo-sector-consumer-staples-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Consumer Staples",
    aliases: [
      "sector-consumer-staples",
      "consumer-staples",
      "consumer staples",
      "yahoo sector consumer-staples",
      "yahoo sector consumer staples",
    ],
  },
  {
    jobId: "yahoo-sector-health-care-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Health Care",
    aliases: [
      "sector-health-care",
      "health-care",
      "health care",
      "yahoo sector health-care",
      "yahoo sector health care",
    ],
  },
  {
    jobId: "yahoo-sector-financials-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Financials",
    aliases: ["sector-financials", "financials", "yahoo sector financials"],
  },
  {
    jobId: "yahoo-sector-information-technology-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Information Technology",
    aliases: [
      "sector-information-technology",
      "information-technology",
      "information technology",
      "yahoo sector information-technology",
      "yahoo sector information technology",
    ],
  },
  {
    jobId: "yahoo-sector-communication-services-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Communication Services",
    aliases: [
      "sector-communication-services",
      "communication-services",
      "communication services",
      "yahoo sector communication-services",
      "yahoo sector communication services",
    ],
  },
  {
    jobId: "yahoo-sector-utilities-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Utilities",
    aliases: ["sector-utilities", "utilities", "yahoo sector utilities"],
  },
  {
    jobId: "yahoo-sector-real-estate-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    label: "Yahoo quotes — Real Estate",
    aliases: [
      "sector-real-estate",
      "real-estate",
      "real estate",
      "yahoo sector real-estate",
      "yahoo sector real estate",
    ],
  },
  {
    jobId: "alpaca-nasdaq100-quotes",
    sourceId: "alpaca",
    dataset: "quotes",
    family: "index100",
    consumers: ["enrich", "analyze", "research"],
    label: "Alpaca quotes — Nasdaq-100",
    aliases: ["alpaca"],
  },
  {
    jobId: "etrade-nasdaq100-quotes",
    sourceId: "etrade",
    dataset: "quotes",
    family: "index100",
    consumers: ["enrich", "analyze", "research"],
    label: "E*TRADE quotes — Nasdaq-100",
    aliases: ["etrade", "e*trade", "e-trade"],
  },
  {
    jobId: "public-nasdaq100-quotes",
    sourceId: "public",
    dataset: "quotes",
    family: "index100",
    consumers: ["enrich", "analyze", "research"],
    label: "Public.com quotes — Nasdaq-100",
    aliases: ["public", "public.com"],
  },
  {
    jobId: "etrade-options-chains",
    sourceId: "etrade",
    dataset: "options-chains",
    consumers: ["options screens"],
    // #4065: ONE chains job per optionsChains-serving source —
    // the label names the source; a run's universe/symbols
    // input names what it actually pulls.
    label: "E*TRADE options chains — parameterized (default Nasdaq-100)",
    aliases: ["options chains", "etrade options chains"],
  },
  {
    jobId: "alpaca-options-chains",
    sourceId: "alpaca",
    dataset: "options-chains",
    consumers: ["options screens"],
    label: "Alpaca options chains — parameterized (default Nasdaq-100)",
    aliases: ["alpaca options chains"],
  },
  {
    jobId: "public-options-chains",
    sourceId: "public",
    dataset: "options-chains",
    consumers: ["options screens"],
    label: "Public.com options chains — parameterized (default Nasdaq-100)",
    aliases: ["public options chains"],
  },
  {
    jobId: NASDAQ100_UNIVERSE_JOB_ID,
    sourceId: "nasdaq",
    dataset: "universe",
    family: "index100",
    consumers: ["feed jobs"],
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
      return buildNasdaqUniverseJobDefinition(yahoo?.cadenceMinutes ?? FEED_JOB_DEFAULTS.cadenceMinutes);
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
   *
   * Issue #5823 (#4437 slice 2): the per-request override the
   * screener's feed deps bind through — the run's own login (the
   * per-login providers fetch as the run's user, never the host's
   * wiring login) and the Yahoo breaker (#1745, screener binds
   * only). The feed step passes no override, so its provider is
   * exactly as before.
   */
  providerFor: (
    def: FeedJobDefinition,
    opts?: Pick<FeedProviderWiringDeps, "userLogin" | "yahooBreaker">,
  ) => DataProvider | undefined;
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
 * #5955 — this unit's shard-table row: the row in `ctx.params.shards`
 * whose shardId is the unit's shard key, else undefined (monolith,
 * or no row for the key). The one shard-table reader in this file:
 * both `explicitSymbolsFor` (6b0) and `shardUniverseFor` (6b1)
 * read through it, so the two can never disagree on which row is
 * this unit's. Rows are the `WorkflowShard` shape (`{ shardId,
 * universe?, symbols? }`) the screener builder puts on every
 * node's params; a row without the field being read behaves as
 * if the row carried none (the agent then resolves the other
 * field instead).
 */
function shardRowFor(
  ctx: JobStepContext,
): { shardId?: unknown; universe?: unknown; symbols?: unknown } | undefined {
  if (!ctx.shardKey || !Array.isArray(ctx.params.shards)) return undefined;
  return ctx.params.shards.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { shardId?: unknown }).shardId === ctx.shardKey,
  ) as
    | { shardId?: unknown; universe?: unknown; symbols?: unknown }
    | undefined;
}

/**
 * #5954 — this unit's explicit symbols, read the bespoke way
 * (shardSymbolsFor in screenerPipelineJobs.ts): the shard
 * table's row for this unit's shard key, else the flat list
 * under monolith (or when the row carries no explicit
 * symbols — the agent then resolves the row's universe
 * instead). Items are listing objects ({symbol}) or bare
 * strings; the result is normalized (uppercase, trimmed,
 * deduped). Empty ⇒ the run has no explicit symbols and
 * resolves its universe from the stored list, as before.
 * The helper lives here (not shared with shardSymbolsFor):
 * the bespoke step returns the listing objects and retires
 * in slice 7, while the feed step needs symbol strings — the
 * behavior contract is pinned by tests on both sides.
 */
function explicitSymbolsFor(ctx: JobStepContext): string[] {
  const read = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      const symbol =
        typeof item === "string"
          ? item
          : item !== null && typeof item === "object"
            ? (item as { symbol?: unknown }).symbol
            : undefined;
      if (typeof symbol === "string") {
        const s = symbol.toUpperCase().trim();
        if (s.length > 0 && !out.includes(s)) out.push(s);
      }
    }
    return out;
  };
  const flat = read(ctx.params.symbols);
  if (!ctx.shardKey) return flat;
  const rowSymbols = read(shardRowFor(ctx)?.symbols);
  if (rowSymbols.length > 0) return rowSymbols;
  return flat;
}

/**
 * #5955 — this unit's shard universe, read the bespoke way
 * (`screenRequestFromParams` in screenerPipelineJobs.ts reads
 * the same row's `universe`): the shard table's row for this
 * unit's shard key, lowercased like the node param below.
 * Undefined ⇒ the unit names no universe of its own (monolith,
 * or a partition shard whose row carries no universe) and the
 * node's `universe` param decides, as before. A shard universe
 * with no stored index list (ETF / LEV_ETF — no `IndexId`)
 * refuses by name in `resolveRunUniverse` below, never a
 * silent default (that coverage is 6b2's slice).
 */
function shardUniverseFor(ctx: JobStepContext): string | undefined {
  const universe = shardRowFor(ctx)?.universe;
  if (typeof universe !== "string" || universe.trim() === "") return undefined;
  return universe.trim().toLowerCase();
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
    if (!provider) {
      // #5494 — an unserved provider × dataset pair refuses by name with the
      // coded refusal and BOTH axes; only a host-side wiring gap (no acting
      // login, no capture residency) is FEED_JOB_NOT_CONFIGURED. Neither branch
      // substitutes another provider for the requested one.
      const pair = resolveProviderDataset(def.sourceId, def.dataset);
      if (!pair.ok) throw new Error(`${pair.code}: ${pair.message}`);
      throw feedNotConfigured(
        def.id,
        `a capture-wired provider for "${def.sourceId}" serving dataset "${def.dataset}"`,
      );
    }

    // #5954 — explicit symbols (the premium path): the unit's
    // own symbols, read the bespoke way (explicitSymbolsFor
    // above — the shard table's row for this unit's shard key,
    // else the flat list). Present ⇒ the run is symbols-fed:
    // the stored list is never consulted, so `resolveRunUniverse`
    // is skipped below (it would refuse "symbols" — no stored
    // list by that name exists) and no partition is computed
    // (the explicit list IS the fetch set). Explicit symbols win
    // over the universe param, exactly as in the bespoke feed
    // stage. Symbols-fed fetching is a quotes-run mode: any
    // other dataset refuses by name rather than fetching a
    // stored list the caller did not name.
    const explicitSymbols = explicitSymbolsFor(ctx);
    const symbolsMode = explicitSymbols.length > 0;
    if (symbolsMode && def.dataset !== "quotes") {
      throw new Error(
        `${FEED_JOB_CODES.symbolsUnsupported}: feed job "${def.id}" (dataset "${def.dataset}") cannot run a symbols-fed fetch; explicit symbols are a quotes-run mode.`,
      );
    }

    // #3930: the run's universe input (a parameterized job —
    // fundamentals, technicals, sentiment): the step param names the stored index
    // list; absent ⇒ the definition's universe. Resolved (and
    // refused by name when unknown or unsupported) BEFORE any
    // refresh or fetch, so the refresh, the shard partition,
    // and the run all read the same list.
    // #5954: in symbols mode there is no stored universe to
    // resolve — the runner resolves the job's default list for
    // the membership check only. A "symbols" universe with no
    // explicit symbols falls through here and refuses by name
    // below, never silently pulling the default list.
    // #5955: the unit's shard universe wins over the node's
    // `universe` param — one job definition serves
    // multi-universe commands, and the run input the runner
    // resolves is the shard's stored list (the quotes jobs are
    // parameterized since #5955, so the input is accepted).
    // Absent ⇒ the node param, as before.
    const shardUniverse = shardUniverseFor(ctx);
    const universeParam =
      shardUniverse ??
      (typeof ctx.params.universe === "string" && ctx.params.universe.trim() !== ""
        ? ctx.params.universe.trim().toLowerCase()
        : undefined);
    const effectiveUniverse = symbolsMode
      ? undefined
      : resolveRunUniverse(def, universeParam);

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
    // #5954: skipped in symbols mode — there is no stored list
    // to hydrate for the partition read (the explicit list IS
    // the fetch set).
    if (!symbolsMode && ctx.shardKey && deps.indexRefresh) {
      const existingList = await deps.universeStore.latest(effectiveUniverse!);
      if (!existingList || existingList.symbols.length === 0) {
        try {
          await executeIndexListRefreshJob({
            store: deps.indexRefresh.store,
            service: deps.indexRefresh.service,
            indices: [effectiveUniverse!],
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
    // #5954: skipped in symbols mode — the explicit list is the
    // fetch set, not a partition of a stored list.
    // #5955: skipped for a universe shard — the shard IS the
    // universe, so the unit pulls its WHOLE universe (the
    // bespoke feed resolves the shard's universe to its full
    // list, no partitioning). Partitioning a universe shard
    // across all shard keys would silently drop most of the
    // universe. The partition below applies only when the row
    // carries no universe (the feed family's own s0/s1
    // sharding, splitting ONE universe across units).
    let symbols: string[] | undefined;
    if (!symbolsMode && shardUniverse === undefined && ctx.shardKey) {
      const shards =
        (await deps.shardsFor?.(def.id)) ??
        (Array.isArray(ctx.params.shards) ? (ctx.params.shards as string[]) : []);
      const list = await deps.universeStore.latest(effectiveUniverse!);
      const universeSymbols = list
        ? list.symbols.map((m) => m.symbol.toUpperCase().trim()).filter(Boolean)
        : [];
      symbols = feedShardSymbols(universeSymbols, shards, ctx.shardKey) ?? undefined;
    }

    const runOpts = {
      // Issue #4767 — the feed pull records the run's dispatch
      // trigger, threaded in by the engine through the step
      // context; a feed leg run is never an ad-hoc manual run
      // merely because the step wrote it that way.
      trigger: ctx.trigger,
      kind: ctx.runKind,
      runId: ctx.runId,
      ...(deps.userLogin ? { userLogin: deps.userLogin } : {}),
      // #5954: symbols mode passes the explicit list and no
      // universe (the runner resolves the job's default list
      // for the membership check only); the index path passes
      // the resolved universe and the shard partition, as before.
      ...(symbolsMode
        ? { explicitSymbols }
        : {
            ...(universeParam ? { universe: effectiveUniverse! } : {}),
            ...(symbols ? { symbols } : {}),
          }),
      // #4065 — the chains run's fetch window rides the step
      // params (the composition passes the screen's DTE window
      // in); absent ⇒ the runner's defaults. A non-numeric
      // value is ignored, never coerced into a window the
      // caller did not name.
      ...(typeof ctx.params.minDte === "number" &&
      Number.isFinite(ctx.params.minDte)
        ? { minDte: ctx.params.minDte }
        : {}),
      ...(typeof ctx.params.maxDte === "number" &&
      Number.isFinite(ctx.params.maxDte)
        ? { maxDte: ctx.params.maxDte }
        : {}),
      ...(typeof ctx.params.maxExpirationsPerSymbol === "number" &&
      Number.isFinite(ctx.params.maxExpirationsPerSymbol)
        ? { maxExpirationsPerSymbol: ctx.params.maxExpirationsPerSymbol }
        : {}),
    };
    const runnerDeps = {
      provider,
      universeStore: deps.universeStore,
      datasetStore: deps.datasetStore,
      ...(deps.indexRefresh ? { indexRefresh: deps.indexRefresh } : {}),
      // #4312 — the Worker env rides the runner deps for every
      // dataset (not only sentiment), so the feed leg bounds
      // resolve from their env knobs on every feed run.
      ...(deps.env ? { env: deps.env } : {}),
    };
    const result: FeedRunResult =
      def.dataset === "fundamentals"
        ? await runFeedFundamentalsJob(deps.registry, runnerDeps, def.id, runOpts)
        : def.dataset === "technicals"
          ? await runFeedTechnicalsJob(deps.registry, runnerDeps, def.id, runOpts)
          : def.dataset === "sentiment"
            ? await runFeedSentimentJob(
                deps.registry,
                runnerDeps,
                def.id,
                runOpts,
              )
            : def.dataset === "options-chains"
              ? await runFeedOptionsChainsJob(
                  deps.registry,
                  runnerDeps,
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
    const index = resolveUniverseIndex(ctx.params);
    const result: IndexListJobResult = await executeIndexListRefreshJob({
      store: deps.indexRefresh.store,
      service: deps.indexRefresh.service,
      indices: [index],
    });
    // executeIndexListRefreshJob throws when every index failed,
    // so reaching here means the stored list was refreshed (a
    // partial result still names its failures in the output).
    const artifact = result.artifacts[0];
    return {
      output: {
        // #5499: the nasdaq100 job keeps its constant id byte-for-byte; a
        // run of any other index names its own job, never the nasdaq100 one.
        feedJobId: index === "nasdaq100" ? NASDAQ100_UNIVERSE_JOB_ID : ctx.jobId,
        sourceId: "nasdaq",
        dataset: "universe",
        index,
        status: result.status,
        artifactId: artifact?.artifactId ?? null,
        memberCount: artifact?.memberCount ?? 0,
        snapshotDate: artifact?.snapshotDate ?? null,
        failures: result.failures,
      },
      descriptor: `${index} universe refreshed: ${artifact?.memberCount ?? 0} members (snapshot ${artifact?.snapshotDate ?? "unknown"})`,
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
  /** The catalog family, when the entry declares one (surface grouping only). */
  family?: string;
  /** The declared consumers (surface copy; the validated graph is #6049). */
  consumers?: readonly string[];
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
    ...(args.entry.family !== undefined ? { family: args.entry.family } : {}),
    ...(args.entry.consumers !== undefined ? { consumers: args.entry.consumers } : {}),
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


/**
 * Issue #5499 — the universe step serves every index the refresh service can
 * serve, not nasdaq100 only. The known set is the refresh registry itself
 * (Wikipedia + holdings lists), so a new index reaches this step by being
 * added to that one list; an unknown id refuses by name with the known ones.
 * Absent means nasdaq100, the historical default, resolved here (not in the
 * handler) so the rule is one function.
 */
export function resolveUniverseIndex(params: Record<string, unknown>): IndexId {
  const raw = typeof params?.index === "string" ? params.index.trim() : "";
  const index = raw === "" ? "nasdaq100" : raw;
  const known: readonly string[] = [
    ...INDEX_REFRESH_INDICES.wikipedia,
    ...INDEX_REFRESH_INDICES.holdings,
  ];
  if (!known.includes(index)) {
    throw new Error(
      `${FEED_JOB_CODES.jobNotFound}: step "${FEED_UNIVERSE_STEP}" does not know index "${index}"; known: ${known.join(", ")}.`,
    );
  }
  return index as IndexId;
}
