/**
 * Issue #3530 (one-of-everything, S1) — feed jobs: the contract,
 * the registry, and the run/read/status service.
 *
 * A feed job pulls ONE source's declared dataset (quotes for
 * the Nasdaq-100 universe — Yahoo in S1; E*TRADE + Alpaca in S2)
 * through the provider PORT,
 * persists it as the platform's local copy (the feed-dataset
 * store, feedDatasetPorts.ts — with the fetch's captures landing
 * in the capture log through the capture-wired adapter, exactly
 * as screening's fetches do), and serves reads from that copy.
 *
 * Honesty rules (the platform's, carried over):
 * - A read NEVER fetches: the read path has no provider in its
 *   inputs. A missing copy is a typed "missing"; a stale copy is
 *   served labelled stale — never silently refreshed, never
 *   silently substituted with another provider's data (#2144).
 * - A run that fetched nothing is a FAILED run, not an empty
 *   success; a failed run is recorded (its artifact carries the
 *   run record) but never poisons reads (latestUsable skips it).
 * - Provenance is verified, not assumed: an envelope naming a
 *   different provider than the job's source fails the run.
 * - The universe is a STORED index list (indexListPorts —
 *   the platform's snapshot-dated membership): the job
 *   definition's universe, or — for a parameterized job
 *   (#3930 fundamentals; #3931 technicals; #3932 sentiment) —
 *   the run input's list. No list ⇒
 *   a typed FEED_UNIVERSE_MISSING failure, never an
 *   invented universe.
 *
 * Run outcomes are RETURNED, not thrown — the run record is the
 * job's state (there is no async-job executor owning it on this
 * path), so a fetch failure is a recorded failed result. Only
 * contract violations throw (unknown job id — a caller bug).
 */
import {
  HISTORY_BAR_LIMIT,
  classifyNewsSentiment,
  marketDataResearchBarsToDailyBars,
  scrubFailureMessage,
  SECTOR_IDS,
  type DataProvider,
  type DataProviderCapability,
  type DataProviderId,
  type FlowSentiment,
  type IndexId,
  type NewsFlowItem,
  type QuoteResult,
  type YahooDailyBar,
} from "../trading";
import {
  feedDatasetRowCount,
  resolveFeedQuotesFromArtifact,
  type FeedDailyBarRow,
  type FeedDatasetArtifact,
  type FeedDatasetRunRecord,
  type FeedDatasetStore,
  type FeedDatasetStoreInput,
  type FeedFundamentalsRow,
  type FeedOptionsChainRow,
  type FeedQuotesResolution,
  type FeedSentimentRow,
  type PersistedSentiment,
} from "../data/feedDatasetPorts";
import type { IndexListStore } from "../data/indexListPorts";
import { executeIndexListRefreshJob } from "./indexListJob";
import {
  FEED_JOB_TIMEOUTS,
  FeedJobTimeoutError,
  withFeedDeadline,
} from "./feedJobTimeouts";
// Issue #4068: the coded errors live in the leaf ./feedJobCodes (re-exported
// here, so every existing importer keeps its path) — jobPipelineEngine
// imports the leaf directly so the engine never pulls in this module.
import { FEED_JOB_CODES, type FeedJobCode } from "./feedJobCodes";
export { FEED_JOB_CODES, type FeedJobCode };
import type { IndexListFetchService } from "./indexListProducer";
import type { BrokerOptionChain, Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/feedJobs",
});

/** Stable coded errors for feed-job outcomes (externalized vocabulary) — see ./feedJobCodes (leaf); re-exported above. */

/** Stable log event code for a failed feed run (codes + counts only, never payloads). */
export const FEED_JOB_RUN_FAILED = "feed_job_run_failed";

export class FeedJobError extends Error {
  readonly code: FeedJobCode;
  constructor(code: FeedJobCode, message: string) {
    super(message);
    this.name = "FeedJobError";
    this.code = code;
  }
}

/**
 * #3930 — the known index ids at runtime (the IndexId union's
 * mirror: the base indices plus the sector keys). A run input
 * naming anything outside this set is refused by name
 * (FEED_UNIVERSE_UNKNOWN) — never resolved against a stored
 * list it cannot name.
 */
const KNOWN_INDEX_IDS: ReadonlySet<string> = new Set<string>([
  "dow",
  "sp500",
  "sp100",
  "nasdaq100",
  "russell2000",
  "russell1000",
  "sp400",
  "russell3000",
  ...SECTOR_IDS,
]);

export function isKnownIndexId(value: unknown): value is IndexId {
  return typeof value === "string" && KNOWN_INDEX_IDS.has(value);
}

/**
 * #3930 — resolve the stored index list a run pulls: the run
 * input when the job is parameterized (the gap-filling jobs —
 * fundamentals, technicals, and sentiment), else the definition's universe. A
 * universe input on a non-parameterized job, and an input
 * naming no known index, both refuse by name (a caller or
 * configuration bug — never a silent default, never a list
 * the input did not name).
 */
export function resolveRunUniverse(
  def: FeedJobDefinition,
  rawUniverse: unknown,
): IndexId {
  if (rawUniverse === undefined || rawUniverse === null) {
    return def.universe.index;
  }
  if (!def.parameterizedUniverse) {
    throw new FeedJobError(
      FEED_JOB_CODES.universeUnknown,
      `Feed job "${def.id}" does not take a universe input; its universe is fixed to ${def.universe.index}.`,
    );
  }
  if (!isKnownIndexId(rawUniverse)) {
    throw new FeedJobError(
      FEED_JOB_CODES.universeUnknown,
      `"${String(rawUniverse)}" is not a known index id; a parameterized run's universe input must name a stored index list (nasdaq100, sp100, sp500, dow, sp400, …).`,
    );
  }
  return rawUniverse;
}

/**
 * #3930 — the display label for a run's universe: the
 * registry's own label when a job covers that universe, else
 * the index id itself (the honest identifier, never a
 * fabricated label).
 */
export function labelForRunUniverse(
  registry: FeedJobRegistry,
  universeIndex: IndexId,
): string {
  return (
    registry.list().find((j) => j.universe.index === universeIndex)?.universe
      .label ?? universeIndex
  );
}

/**
 * The feed-job contract every source slice registers against:
 * a source, the dataset it maintains, the universe it covers,
 * and its cadence/freshness knobs (config-resolved, see
 * buildFeedJobRegistry — never literals at call sites).
 */
export interface FeedJobDefinition {
  id: string;
  sourceId: DataProviderId;
  /** Dataset id within the source (S1: "quotes"). */
  dataset: string;
  elements: readonly DataProviderCapability[];
  universe: { kind: "index"; index: IndexId; label: string };
  /**
   * #3930 — the job's universe is a RUN INPUT, not a fixed
   * property: the definition's universe is the DEFAULT input
   * (nasdaq100 for the gap-filling jobs); a run may name any stored
   * index list instead. Only the gap-filling jobs set this
   * (fundamentals, #3930; technicals, #3931; sentiment, #3932) —
   * quotes jobs stay one definition per universe.
   */
  parameterizedUniverse?: boolean;
  /** Declared pull cadence — the scheduling slice's input. */
  cadenceMinutes: number;
  /** Age past which the stored copy is labelled stale. */
  staleAfterMinutes: number;
}

/**
 * The feed-job registry — the DataProviderRegistry idiom
 * (unique ids, re-registering throws so provenance ids stay
 * unambiguous; explicit resolution failure, no silent fallback).
 */
export class FeedJobRegistry {
  private jobs = new Map<string, FeedJobDefinition>();

  register(job: FeedJobDefinition): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`Feed job "${job.id}" is already registered.`);
    }
    this.jobs.set(job.id, job);
  }

  get(id: string): FeedJobDefinition | undefined {
    return this.jobs.get(id);
  }

  list(): FeedJobDefinition[] {
    return Array.from(this.jobs.values());
  }

  /** The job maintaining a source's dataset, if one is registered. */
  forSource(sourceId: DataProviderId): FeedJobDefinition | undefined {
    return this.list().find((j) => j.sourceId === sourceId);
  }
}

/* ------------------------------------------------------------------ */
/* Cadence / freshness knobs — config, not literals.                   */
/* FEED_JOB_<JOB_ID>_CADENCE_MINUTES / FEED_JOB_<JOB_ID>_STALE_MINUTES */
/* ------------------------------------------------------------------ */

function knobKey(jobId: string, suffix: string): string {
  return `FEED_JOB_${jobId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
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

export function resolveFeedJobCadenceMinutes(
  env: Record<string, string | undefined>,
  jobId: string,
  fallback: number,
): number {
  return resolveMinutesKnob(env, jobId, "CADENCE_MINUTES", fallback);
}

export function resolveFeedJobStaleMinutes(
  env: Record<string, string | undefined>,
  jobId: string,
  fallback: number,
): number {
  return resolveMinutesKnob(env, jobId, "STALE_MINUTES", fallback);
}

export const YAHOO_NASDAQ100_QUOTES_JOB_ID = "yahoo-nasdaq100-quotes";
export const YAHOO_NASDAQ100_FUNDAMENTALS_JOB_ID = "yahoo-nasdaq100-fundamentals";
export const YAHOO_NASDAQ100_TECHNICALS_JOB_ID = "yahoo-nasdaq100-technicals";
export const YAHOO_NASDAQ100_SENTIMENT_JOB_ID = "yahoo-nasdaq100-sentiment";
export const YAHOO_SP100_QUOTES_JOB_ID = "yahoo-sp100-quotes";
export const YAHOO_SP500_QUOTES_JOB_ID = "yahoo-sp500-quotes";
export const YAHOO_DOW_QUOTES_JOB_ID = "yahoo-dow-quotes";
export const ALPACA_NASDAQ100_QUOTES_JOB_ID = "alpaca-nasdaq100-quotes";
export const ETRADE_NASDAQ100_QUOTES_JOB_ID = "etrade-nasdaq100-quotes";
export const PUBLIC_NASDAQ100_QUOTES_JOB_ID = "public-nasdaq100-quotes";
export const ETRADE_OPTIONS_CHAINS_JOB_ID = "etrade-options-chains";
export const ALPACA_OPTIONS_CHAINS_JOB_ID = "alpaca-options-chains";
export const PUBLIC_OPTIONS_CHAINS_JOB_ID = "public-options-chains";
export const FEED_JOB_DEFAULTS = {
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
} as const;

/**
 * One built-in quotes job: the source's quotes for the stored
 * Nasdaq-100 universe — the shape every quotes source registers
 * (S1: Yahoo; S2: E*TRADE + Alpaca; #3535: Public). The definition
 * is data; the run/read/status machinery is shared, never forked
 * per source.
 */
function nasdaq100QuotesJob(
  env: Record<string, string | undefined>,
  id: string,
  sourceId: DataProviderId,
): FeedJobDefinition {
  return {
    id,
    sourceId,
    dataset: "quotes",
    elements: ["quotes"],
    universe: { kind: "index", index: "nasdaq100", label: "Nasdaq-100" },
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      id,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      id,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  };
}

/**
 * The built-in registry. S1 registered exactly one job — Yahoo
 * quotes over the stored Nasdaq-100 list. S2 (#3530) registers
 * E*TRADE and Alpaca quotes over the same universe against the
 * same contract. #3535 (Pipeline J2) registers the full per-source
 * set against the same contract: Yahoo fundamentals and the
 * S&P 100 quotes universe, plus the Public quotes job (each
 * provider adapter declares quotes + a batch form — the dataset
 * contract this family runs against; Public's legs allow quotes +
 * optionsChains per its adapter, so its quotes job is in scope
 * per #3530/#3533). #3876 registers the S&P 500 quotes universe
 * on the same contract, immediately after the S&P 100 job.
 * #3905 registers the Dow quotes universe on the same contract,
 * immediately after the S&P 500 job.
 *
 * The Nasdaq provider declares screenUniverse only — it has NO
 * quotes job here (S2 finding, #3530: its dataset is the US
 * listed-securities universe, not quotes, and this contract's
 * artifact payload + universe shape cannot express it). Its
 * Nasdaq-100 universe copy is the stored index list, maintained
 * by the index-refresh machinery (#1980) and exposed to the
 * pipeline as the nasdaq-nasdaq100-universe job (feedPipelineJobs).
 */
export function buildFeedJobRegistry(
  env: Record<string, string | undefined>,
): FeedJobRegistry {
  const registry = new FeedJobRegistry();
  registry.register(
    nasdaq100QuotesJob(env, YAHOO_NASDAQ100_QUOTES_JOB_ID, "yahoo"),
  );
  registry.register({
    id: YAHOO_NASDAQ100_FUNDAMENTALS_JOB_ID,
    sourceId: "yahoo",
    dataset: "fundamentals",
    elements: ["fundamentals"],
    // #3930 — ONE fundamentals job, parameterized: the id
    // names the DEFAULT universe (nasdaq100, kept for
    // lineage), and a run's `universe` input names the stored
    // index list it actually pulls. There is no per-universe
    // fundamentals job (Correction 2, #3930 comment
    // 6760544285): the same job serves nasdaq100, sp100,
    // sp500, dow, sp400, and any other stored list.
    universe: { kind: "index", index: "nasdaq100", label: "Nasdaq-100" },
    parameterizedUniverse: true,
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      YAHOO_NASDAQ100_FUNDAMENTALS_JOB_ID,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      YAHOO_NASDAQ100_FUNDAMENTALS_JOB_ID,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  });
  registry.register({
    id: YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
    sourceId: "yahoo",
    dataset: "technicals",
    elements: ["historicalBars"],
    // #3931 — ONE technicals job, parameterized, on the same
    // idiom as the fundamentals job: the id names the DEFAULT
    // universe (nasdaq100, kept for lineage), and a run's
    // `universe` input names the stored index list it actually
    // pulls. There is no per-universe technicals job
    // (Correction 2, #3931 comment 6760545755): the same job
    // serves nasdaq100, sp100, sp500, dow, sp400, and any other
    // stored list. It persists the daily bars the live history
    // fetch already retrieves (HISTORY_BAR_LIMIT bars per
    // symbol, live bars only) so enrich and the UX both read
    // from the same persisted copy.
    universe: { kind: "index", index: "nasdaq100", label: "Nasdaq-100" },
    parameterizedUniverse: true,
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  });
  registry.register({
    id: YAHOO_NASDAQ100_SENTIMENT_JOB_ID,
    sourceId: "yahoo",
    dataset: "sentiment",
    elements: ["news"],
    // #3932 — ONE sentiment job, parameterized, on the same
    // idiom as the fundamentals and technicals jobs: the id
    // names the DEFAULT universe (nasdaq100, kept for
    // lineage), and a run's `universe` input names the stored
    // index list it actually pulls. There is no per-universe
    // sentiment job (Correction 2, #3932 comments 6760487336
    // + 6760547214): the same job serves nasdaq100, sp100,
    // sp500, dow, sp400, and any other stored list. It fetches
    // the Yahoo News feed per symbol and classifies the
    // headlines with the #132 batched LLM classifier, so enrich
    // and the UX both read sourced sentiment from the same
    // persisted copy.
    universe: { kind: "index", index: "nasdaq100", label: "Nasdaq-100" },
    parameterizedUniverse: true,
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      YAHOO_NASDAQ100_SENTIMENT_JOB_ID,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      YAHOO_NASDAQ100_SENTIMENT_JOB_ID,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  });
  registry.register({
    id: YAHOO_SP100_QUOTES_JOB_ID,
    sourceId: "yahoo",
    dataset: "quotes",
    elements: ["quotes"],
    universe: { kind: "index", index: "sp100", label: "S&P 100" },
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      YAHOO_SP100_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      YAHOO_SP100_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  });
  registry.register({
    id: YAHOO_SP500_QUOTES_JOB_ID,
    sourceId: "yahoo",
    dataset: "quotes",
    elements: ["quotes"],
    universe: { kind: "index", index: "sp500", label: "S&P 500" },
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      YAHOO_SP500_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      YAHOO_SP500_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  });
  registry.register({
    id: YAHOO_DOW_QUOTES_JOB_ID,
    sourceId: "yahoo",
    dataset: "quotes",
    elements: ["quotes"],
    universe: { kind: "index", index: "dow", label: "Dow Jones Industrial Average" },
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      YAHOO_DOW_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      YAHOO_DOW_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  });
  registry.register(
    nasdaq100QuotesJob(env, ALPACA_NASDAQ100_QUOTES_JOB_ID, "alpaca"),
  );
  registry.register(
    nasdaq100QuotesJob(env, ETRADE_NASDAQ100_QUOTES_JOB_ID, "etrade"),
  );
  registry.register(
    nasdaq100QuotesJob(env, PUBLIC_NASDAQ100_QUOTES_JOB_ID, "public"),
  );
  // #4065 — ONE options-chains job per source that serves the
  // optionsChains capability (the three optionsChains-serving
  // sources — the #3990 taxonomy; the pure data providers
  // declare no optionsChains and get no chains job). Each is
  // parameterized on the #3930 idiom: the id names the DEFAULT universe (nasdaq100,
  // kept for lineage), and a run's `universe` input names the
  // stored index list it actually pulls — or a run's `symbols`
  // input names explicit underlyings (an options screen's
  // underlyings, which need not belong to any stored list;
  // the artifact then carries a symbols-kind universe). There
  // is no per-universe chains job: the same job serves any
  // stored list and any explicit-symbol run.
  for (const [jobId, sourceId] of [
    [ETRADE_OPTIONS_CHAINS_JOB_ID, "etrade"],
    [ALPACA_OPTIONS_CHAINS_JOB_ID, "alpaca"],
    [PUBLIC_OPTIONS_CHAINS_JOB_ID, "public"],
  ] as const) {
    registry.register({
      id: jobId,
      sourceId,
      dataset: "options-chains",
      elements: ["optionsChains"],
      universe: { kind: "index", index: "nasdaq100", label: "Nasdaq-100" },
      parameterizedUniverse: true,
      cadenceMinutes: resolveFeedJobCadenceMinutes(
        env,
        jobId,
        FEED_JOB_DEFAULTS.cadenceMinutes,
      ),
      staleAfterMinutes: resolveFeedJobStaleMinutes(
        env,
        jobId,
        FEED_JOB_DEFAULTS.staleAfterMinutes,
      ),
    });
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface FeedJobDeps {
  /** The job source's provider, capture-wired by the caller —
   *  captures are the adapter's own write, as in screening. */
  provider: DataProvider;
  /** The stored index-list store the universe resolves from. */
  universeStore: IndexListStore;
  datasetStore: FeedDatasetStore;
  /**
   * #3976 — the index-refresh wiring (#3875's machinery: the
   * same store + membership service the host composes for the
   * universe step). When wired, a run whose universe list is
   * missing/empty refreshes that index ONCE through
   * executeIndexListRefreshJob before resolving; a refresh that
   * throws, or that completes without producing a usable list,
   * fails the run FEED_UNIVERSE_REFRESH_FAILED — never the bare
   * FEED_UNIVERSE_MISSING, which is reserved for hosts that wire
   * no refresh at all. Absent/null ⇒ the pre-#3976 behaviour,
   * byte-identical.
   */
  indexRefresh?: {
    store: IndexListStore;
    service: IndexListFetchService;
  } | null;
  /**
   * #3932 — the Worker env the sentiment job classifies
   * through (the #132 classifier needs the AI binding via the
   * gateway port). Optional: absent ⇒ the classifier degrades
   * honestly (rows persist with method "unavailable" — the
   * news was fetched, the assessment is absent, never guessed).
   * The other feed jobs ignore it.
   */
  env?: Env;
}

export interface RunFeedJobOptions {
  trigger?: "manual" | "scheduled";
  userLogin?: string;
  tenantId?: string;
  runId?: string;
  /**
   * #3930 — the run's universe input (a parameterized job
   * only — the gap-filling jobs): the stored index list the run
   * pulls, as an IndexId. Absent ⇒ the definition's universe
   * (nasdaq100 for the fundamentals job). A value on a
   * non-parameterized job, or an unknown index id, refuses by
   * name (FEED_UNIVERSE_UNKNOWN).
   */
  universe?: IndexId;
  /**
   * #3535: pull only this subset of the universe (a sharded
   * pipeline run's partition). Provenance still names the stored
   * index list; the artifact's universe size is the subset's.
   */
  symbols?: string[];
  /**
   * #4065 — the chains run's fetch window: the DTE band whose
   * expirations the job persists, and the cap on expirations
   * fetched per symbol. Defaults mirror the screener's own
   * fetch (minDte 0, maxDte 365, maxExpirationsPerSymbol 100
   * — the screener config default). A screen whose DTE window
   * lies outside the persisted window cannot be served from
   * the dataset; the composition (#4068) passes the screen's
   * window into the run. Absent ⇒ the defaults.
   */
  minDte?: number;
  maxDte?: number;
  maxExpirationsPerSymbol?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface FeedRunResult {
  jobId: string;
  runId: string;
  status: FeedDatasetRunRecord["status"];
  artifactId: string;
  requested: number;
  received: number;
  failed: number;
  missingSymbols: string[];
  codedError: string | null;
  startedAt: string;
  finishedAt: string;
}

/** IndexListStore.latest() row shape (the runners read symbols/snapshot off it). */
type StoredIndexList = Awaited<ReturnType<IndexListStore["latest"]>>;

function symbolsOfList(list: StoredIndexList): string[] {
  return list
    ? Array.from(
        new Set(
          list.symbols
            .map((m) => m.symbol.toUpperCase().trim())
            .filter((s) => s.length > 0),
        ),
      )
    : [];
}

/**
 * #3976 — resolve a run's universe list, hydrating a cold store
 * through the wired index refresh when the first read finds no
 * usable list. Shared by both runners (quotes + fundamentals).
 *
 * Outcomes:
 * - a usable list on the first read ⇒ returned as-is; the
 *   refresh is never invoked;
 * - no usable list and NO refresh wired ⇒ { list } stands
 *   (missing/empty) and the caller records the bare
 *   FEED_UNIVERSE_MISSING, exactly as before #3976;
 * - refresh wired and it throws ⇒ { refreshError } — the caller
 *   records FEED_UNIVERSE_REFRESH_FAILED naming the failure;
 * - refresh returns but the re-read still finds no usable list
 *   ⇒ { refreshError } — FEED_UNIVERSE_REFRESH_FAILED (the
 *   refresh completed but produced no usable list);
 * - #3992 PR-2: the refresh never settles within its named
 *   bound ⇒ { refreshTimedOut: true } — the caller records
 *   FEED_REFRESH_TIMEOUT, distinctly from a refresh that
 *   failed. The race abandons the refresh (it is not aborted
 *   and may still land its snapshot in the background) but the
 *   run settles and records exactly once.
 */
async function resolveUniverseListWithHydration(
  deps: FeedJobDeps,
  universeIndex: IndexId,
): Promise<{
  list: StoredIndexList;
  refreshError?: string;
  refreshTimedOut?: boolean;
}> {
  const list = await deps.universeStore.latest(universeIndex);
  if (list && symbolsOfList(list).length > 0) return { list };
  if (!deps.indexRefresh) return { list };
  try {
    await withFeedDeadline(
      executeIndexListRefreshJob({
        store: deps.indexRefresh.store,
        service: deps.indexRefresh.service,
        indices: [universeIndex],
      }),
      FEED_JOB_TIMEOUTS.refreshMs,
      FEED_JOB_CODES.refreshTimeout,
    );
  } catch (err) {
    if (err instanceof FeedJobTimeoutError) {
      return { list, refreshTimedOut: true };
    }
    return {
      list,
      refreshError: scrubFailureMessage(
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
  const refreshed = await deps.universeStore.latest(universeIndex);
  if (refreshed && symbolsOfList(refreshed).length > 0) {
    return { list: refreshed };
  }
  return {
    list: refreshed ?? list,
    refreshError:
      "the index-list refresh completed but produced no usable list for this index",
  };
}

function quoteSymbol(quote: QuoteResult): string {
  return typeof (quote as { symbol?: unknown }).symbol === "string"
    ? ((quote as { symbol: string }).symbol.toUpperCase())
    : "";
}

/**
 * #3992 PR-3 — the capture-leg bound: one store attempt for a
 * run artifact, raced against FEED_JOB_TIMEOUTS.captureMs via
 * the PR-1 substrate. The outcome is a VALUE, never a rejection,
 * so the caller decides the failure semantics: a timeout is a
 * named outcome the record() closures answer with one degraded
 * fallback write; a store error keeps carrying the original
 * error object so the closures can rethrow it byte-identically
 * to the pre-PR-3 propagation. The race abandons a hung store
 * (its late write may still land in the background) but the
 * helper has settled, so exactly one outcome is ever observed.
 */
type StoreRunArtifactOutcome =
  | { ok: true; artifact: FeedDatasetArtifact }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; error: unknown };

async function storeRunArtifact(
  store: FeedDatasetStore,
  input: FeedDatasetStoreInput,
): Promise<StoreRunArtifactOutcome> {
  try {
    const artifact = await withFeedDeadline(
      store.store(input),
      FEED_JOB_TIMEOUTS.captureMs,
      FEED_JOB_CODES.captureTimeout,
    );
    return { ok: true, artifact };
  } catch (err) {
    if (err instanceof FeedJobTimeoutError) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "error", error: err };
  }
}

/**
 * #3992 PR-3 — the message a per-symbol fetch timeout leaves
 * in the loop's firstError: it names the stable code and the
 * whole-loop budget, so a run that fetched nothing fails with
 * its no*Returned code AND an errorMessage that says why.
 */
function fetchTimeoutMessage(): string {
  return `Provider fetch leg did not settle within ${FEED_JOB_TIMEOUTS.fetchMs}ms (${FEED_JOB_CODES.fetchTimeout}).`;
}

export async function runFeedJob(
  registry: FeedJobRegistry,
  deps: FeedJobDeps,
  jobId: string,
  opts: RunFeedJobOptions = {},
): Promise<FeedRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new FeedJobError(
      FEED_JOB_CODES.jobNotFound,
      `No feed job is registered with id "${jobId}".`,
    );
  }
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const runId = opts.runId ?? `feed-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";

  /** Record the run's artifact (its metadata IS the run record)
   *  and shape the result. Every run — success or failure —
   *  lands here exactly once. */
  const record = async (args: {
    status: FeedDatasetRunRecord["status"];
    quotes: QuoteResult[];
    requested: number;
    missingSymbols: string[];
    codedError: string | null;
    errorMessage: string | null;
    universe: FeedDatasetArtifact["universe"];
  }): Promise<FeedRunResult> => {
    const finishedAt = now();
    const run: FeedDatasetRunRecord = {
      runId,
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: args.status,
      requested: args.requested,
      received: args.quotes.length,
      failed: args.requested - args.quotes.length,
      missingSymbols: args.missingSymbols,
      codedError: args.codedError,
      errorMessage: args.errorMessage,
    };
    const storeInput: FeedDatasetStoreInput = {
      jobId: def.id,
      sourceId: def.sourceId,
      dataset: def.dataset,
      elements: [...def.elements],
      universe: args.universe,
      providerId: def.sourceId,
      asOf: finishedAt.toISOString(),
      quotes: args.quotes,
      run,
      nowIso: finishedAt.toISOString(),
    };
    // #3992 PR-3: the store write is bound by the capture leg.
    // A store error rethrows exactly as before; a capture
    // timeout degrades honestly (degradedRun below).
    const outcome = await storeRunArtifact(deps.datasetStore, storeInput);
    if (!outcome.ok && outcome.reason === "error") throw outcome.error;
    let artifactId: string;
    let settledRun = run;
    if (outcome.ok) {
      artifactId = outcome.artifact.id;
    } else {
      // The primary write did not settle within the capture
      // bound: attempt ONE degraded fallback — same runId, a
      // failed empty record coded FEED_CAPTURE_TIMEOUT — and
      // land the run on it. If the fallback also fails, the
      // run still settles: captureTimeout with artifactId ""
      // (no artifact exists; an id is never fabricated).
      const degradedRun: FeedDatasetRunRecord = {
        ...run,
        status: "failed",
        received: 0,
        failed: args.requested,
        missingSymbols: symbols,
        codedError: FEED_JOB_CODES.captureTimeout,
        errorMessage: `Run-record store write did not settle within ${FEED_JOB_TIMEOUTS.captureMs}ms (${FEED_JOB_CODES.captureTimeout}); the run's data was not persisted.`,
      };
      const fallback = await storeRunArtifact(deps.datasetStore, {
        ...storeInput,
        quotes: [],
        run: degradedRun,
      });
      settledRun = degradedRun;
      artifactId = fallback.ok ? fallback.artifact.id : "";
    }
    if (settledRun.status === "failed") {
      structuredLog.warn("feedJobs.run_failed", {
        message: `[feedJobs] ${FEED_JOB_RUN_FAILED}`,
        jobId: def.id,
        runId,
        code: settledRun.codedError,
        requested: args.requested,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: settledRun.status,
      artifactId,
      requested: settledRun.requested,
      received: settledRun.received,
      failed: settledRun.failed,
      missingSymbols: settledRun.missingSymbols,
      codedError: settledRun.codedError,
      startedAt: settledRun.startedAt,
      finishedAt: settledRun.finishedAt,
    };
  };

  // 1. Universe — the stored index list, never an invented one.
  // #3930: the run input names the list (parameterized jobs);
  // absent ⇒ the definition's universe.
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  // #3976: a cold store hydrates through the wired index refresh
  // before the universe is declared missing.
  const { list, refreshError, refreshTimedOut } =
    await resolveUniverseListWithHydration(deps, universeIndex);
  let symbols = symbolsOfList(list);
  // #3535: a sharded partition pulls only its subset of the
  // universe (universe order preserved; unknown symbols ignored —
  // a partition is a filter on the universe, never an addition).
  if (opts.symbols && list) {
    const wanted = new Set(
      opts.symbols.map((s) => s.toUpperCase().trim()).filter((s) => s.length > 0),
    );
    symbols = symbols.filter((s) => wanted.has(s));
  }
  const universe: FeedDatasetArtifact["universe"] = {
    kind: "index",
    index: universeIndex,
    label: universeLabel,
    snapshotDate: list?.snapshotDate ?? null,
    sourceLabel: list?.sourceLabel ?? null,
    size: symbols.length,
  };
  if (!list || symbols.length === 0) {
    if (refreshTimedOut) {
      return record({
        status: "failed",
        quotes: [],
        requested: 0,
        missingSymbols: [],
        codedError: FEED_JOB_CODES.refreshTimeout,
        errorMessage: `Index-list refresh for the ${universeLabel} universe did not settle within ${FEED_JOB_TIMEOUTS.refreshMs}ms (FEED_REFRESH_TIMEOUT). The feed job has no universe to pull.`,
        universe,
      });
    }
    if (refreshError !== undefined) {
      return record({
        status: "failed",
        quotes: [],
        requested: 0,
        missingSymbols: [],
        codedError: FEED_JOB_CODES.universeRefreshFailed,
        errorMessage: `Index-list refresh for the ${universeLabel} universe failed: ${refreshError}. The feed job has no universe to pull.`,
        universe,
      });
    }
    return record({
      status: "failed",
      quotes: [],
      requested: 0,
      missingSymbols: [],
      codedError: FEED_JOB_CODES.universeMissing,
      errorMessage: `No stored ${universeLabel} index list exists; the feed job has no universe to pull. Refresh the index list first.`,
      universe,
    });
  }

  // 2. The batch contract: the job maintains its dataset in one
  //    batch pull per run (the provider's own batching discipline).
  if (typeof deps.provider.getQuotesBatch !== "function") {
    return record({
      status: "failed",
      quotes: [],
      requested: symbols.length,
      missingSymbols: symbols,
      codedError: FEED_JOB_CODES.batchUnsupported,
      errorMessage: `Provider "${def.sourceId}" does not implement batch quotes; the feed job cannot pull its dataset.`,
      universe,
    });
  }

  // 3. Fetch through the port. Captures fire inside the
  //    capture-wired adapter under this run's id.
  // #3992 PR-3: the batch await is raced against the fetch
  // bound; a timeout is discriminated in the catch and records
  // FEED_FETCH_TIMEOUT, distinctly from FEED_FETCH_FAILED.
  let envelope;
  try {
    envelope = await withFeedDeadline(
      deps.provider.getQuotesBatch(symbols, {
        runId,
        tenantId: opts.tenantId ?? "default",
        ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
      }),
      FEED_JOB_TIMEOUTS.fetchMs,
      FEED_JOB_CODES.fetchTimeout,
    );
  } catch (err) {
    if (err instanceof FeedJobTimeoutError) {
      return record({
        status: "failed",
        quotes: [],
        requested: symbols.length,
        missingSymbols: symbols,
        codedError: FEED_JOB_CODES.fetchTimeout,
        errorMessage: `Provider batch quote fetch for the ${universeLabel} universe did not settle within ${FEED_JOB_TIMEOUTS.fetchMs}ms (${FEED_JOB_CODES.fetchTimeout}).`,
        universe,
      });
    }
    return record({
      status: "failed",
      quotes: [],
      requested: symbols.length,
      missingSymbols: symbols,
      codedError: FEED_JOB_CODES.fetchFailed,
      errorMessage: scrubFailureMessage(
        err instanceof Error ? err.message : String(err),
      ),
      universe,
    });
  }

  // 4. Provenance is verified: an envelope naming another
  //    provider is refused, never relabelled.
  if (envelope.providerId !== def.sourceId) {
    return record({
      status: "failed",
      quotes: [],
      requested: symbols.length,
      missingSymbols: symbols,
      codedError: FEED_JOB_CODES.providerMismatch,
      errorMessage: `Provider envelope named "${envelope.providerId}" for a "${def.sourceId}" feed job; the result was refused, not relabelled.`,
      universe,
    });
  }

  // 5. Per-element outcome: what the universe asked for vs what
  //    the provider actually returned (extras are not the dataset).
  const requested = new Set(symbols);
  const bySymbol = new Map<string, QuoteResult>();
  for (const q of envelope.result ?? []) {
    const symbol = quoteSymbol(q);
    if (symbol && requested.has(symbol) && !bySymbol.has(symbol)) {
      bySymbol.set(symbol, q);
    }
  }
  const quotes = symbols
    .map((s) => bySymbol.get(s))
    .filter((q): q is QuoteResult => q !== undefined);
  const missingSymbols = symbols.filter((s) => !bySymbol.has(s));
  if (quotes.length === 0) {
    return record({
      status: "failed",
      quotes: [],
      requested: symbols.length,
      missingSymbols,
      codedError: FEED_JOB_CODES.noQuotesReturned,
      errorMessage: `Provider "${def.sourceId}" returned no quotes for the ${universeLabel} universe; nothing was persisted as data.`,
      universe,
    });
  }
  return record({
    status: missingSymbols.length > 0 ? "partial" : "completed",
    quotes,
    requested: symbols.length,
    missingSymbols,
    codedError: null,
    errorMessage: null,
    universe,
  });
}

/**
 * #3535 (Pipeline J2) — the fundamentals feed run: the same
 * contract as runFeedJob, over the provider's per-symbol
 * fundamentals capability. Fundamentals have no batch form in
 * the #1116 contract, so the run walks the universe symbol by
 * symbol through the capture-wired provider (each fetch lands in
 * the capture log under this run's id, exactly as quotes do).
 * Honesty rules are the quotes run's, unchanged: the universe is
 * the stored index list; provenance is verified per envelope; a
 * run that fetched nothing is a FAILED run; per-symbol failures
 * are named in missingSymbols, never silently dropped.
 */
export async function runFeedFundamentalsJob(
  registry: FeedJobRegistry,
  deps: FeedJobDeps,
  jobId: string,
  opts: RunFeedJobOptions = {},
): Promise<FeedRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new FeedJobError(
      FEED_JOB_CODES.jobNotFound,
      `No feed job is registered with id "${jobId}".`,
    );
  }
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const runId = opts.runId ?? `feed-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";

  const record = async (args: {
    status: FeedDatasetRunRecord["status"];
    rows: FeedFundamentalsRow[];
    requested: number;
    missingSymbols: string[];
    /** #3992 PR-3: every requested symbol — the degraded
     *  capture-fallback record names them all as missing. */
    allSymbols: string[];
    codedError: string | null;
    errorMessage: string | null;
    universe: FeedDatasetArtifact["universe"];
  }): Promise<FeedRunResult> => {
    const finishedAt = now();
    const run: FeedDatasetRunRecord = {
      runId,
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: args.status,
      requested: args.requested,
      received: args.rows.length,
      failed: args.requested - args.rows.length,
      missingSymbols: args.missingSymbols,
      codedError: args.codedError,
      errorMessage: args.errorMessage,
    };
    const storeInput: FeedDatasetStoreInput = {
      jobId: def.id,
      sourceId: def.sourceId,
      dataset: def.dataset,
      elements: [...def.elements],
      universe: args.universe,
      providerId: def.sourceId,
      asOf: finishedAt.toISOString(),
      quotes: [],
      fundamentals: args.rows,
      run,
      nowIso: finishedAt.toISOString(),
    };
    // #3992 PR-3: the store write is bound by the capture leg.
    // A store error rethrows exactly as before; a capture
    // timeout degrades honestly (degradedRun below).
    const outcome = await storeRunArtifact(deps.datasetStore, storeInput);
    if (!outcome.ok && outcome.reason === "error") throw outcome.error;
    let artifactId: string;
    let settledRun = run;
    if (outcome.ok) {
      artifactId = outcome.artifact.id;
    } else {
      // The primary write did not settle within the capture
      // bound: attempt ONE degraded fallback — same runId, a
      // failed empty record coded FEED_CAPTURE_TIMEOUT — and
      // land the run on it. If the fallback also fails, the
      // run still settles: captureTimeout with artifactId ""
      // (no artifact exists; an id is never fabricated).
      const degradedRun: FeedDatasetRunRecord = {
        ...run,
        status: "failed",
        received: 0,
        failed: args.requested,
        missingSymbols: args.allSymbols,
        codedError: FEED_JOB_CODES.captureTimeout,
        errorMessage: `Run-record store write did not settle within ${FEED_JOB_TIMEOUTS.captureMs}ms (${FEED_JOB_CODES.captureTimeout}); the run's data was not persisted.`,
      };
      const fallback = await storeRunArtifact(deps.datasetStore, {
        ...storeInput,
        fundamentals: [],
        run: degradedRun,
      });
      settledRun = degradedRun;
      artifactId = fallback.ok ? fallback.artifact.id : "";
    }
    if (settledRun.status === "failed") {
      structuredLog.warn(FEED_JOB_RUN_FAILED, {
        message: `[feedJobs] ${FEED_JOB_RUN_FAILED}`,
        jobId: def.id,
        runId,
        code: settledRun.codedError,
        requested: args.requested,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: settledRun.status,
      artifactId,
      requested: settledRun.requested,
      received: settledRun.received,
      failed: settledRun.failed,
      missingSymbols: settledRun.missingSymbols,
      codedError: settledRun.codedError,
      startedAt: settledRun.startedAt,
      finishedAt: settledRun.finishedAt,
    };
  };

  // 1. Universe — the stored index list, never an invented one
  //    (a configured subset partitions it, as in the quotes run).
  // #3930: the run input names the list — the parameterized
  // job serves any stored list; absent ⇒ the default universe.
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  // #3976: same cold-store hydration as the quotes run.
  const { list, refreshError, refreshTimedOut } =
    await resolveUniverseListWithHydration(deps, universeIndex);
  let symbols = symbolsOfList(list);
  if (opts.symbols && list) {
    const wanted = new Set(
      opts.symbols.map((s) => s.toUpperCase().trim()).filter((s) => s.length > 0),
    );
    symbols = symbols.filter((s) => wanted.has(s));
  }
  const universe: FeedDatasetArtifact["universe"] = {
    kind: "index",
    index: universeIndex,
    label: universeLabel,
    snapshotDate: list?.snapshotDate ?? null,
    sourceLabel: list?.sourceLabel ?? null,
    size: symbols.length,
  };
  if (!list || symbols.length === 0) {
    if (refreshTimedOut) {
      return record({
        status: "failed",
        rows: [],
        requested: 0,
        missingSymbols: [],
        allSymbols: symbols,
        codedError: FEED_JOB_CODES.refreshTimeout,
        errorMessage: `Index-list refresh for the ${universeLabel} universe did not settle within ${FEED_JOB_TIMEOUTS.refreshMs}ms (FEED_REFRESH_TIMEOUT). The feed job has no universe to pull.`,
        universe,
      });
    }
    if (refreshError !== undefined) {
      return record({
        status: "failed",
        rows: [],
        requested: 0,
        missingSymbols: [],
        allSymbols: symbols,
        codedError: FEED_JOB_CODES.universeRefreshFailed,
        errorMessage: `Index-list refresh for the ${universeLabel} universe failed: ${refreshError}. The feed job has no universe to pull.`,
        universe,
      });
    }
    return record({
      status: "failed",
      rows: [],
      requested: 0,
      missingSymbols: [],
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.universeMissing,
      errorMessage: `No stored ${universeLabel} index list exists; the feed job has no universe to pull. Refresh the index list first.`,
      universe,
    });
  }

  // 2. The capability contract: no fundamentals method ⇒ a named
  //    refusal recorded as the run, never a fabricated dataset.
  if (typeof deps.provider.getFundamentals !== "function") {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols: symbols,
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.fundamentalsUnsupported,
      errorMessage: `Provider "${def.sourceId}" does not implement fundamentals; the feed job cannot pull its dataset.`,
      universe,
    });
  }

  // 3. Fetch per symbol through the port. A symbol whose fetch
  //    throws or whose envelope names another provider is a
  //    missing symbol with the failure counted — one bad symbol
  //    never poisons the rows already pulled.
  // #3992 PR-3: the WHOLE loop is bound by the fetch leg — one
  //    deadline for the loop, captured before it starts on the
  //    same clock the race's default timers read (Date.now —
  //    vitest fake timers drive both). Each symbol's await is
  //    raced with the REMAINING budget, never a fresh bound per
  //    symbol; a symbol that times out is missing with the
  //    timeout named in firstError, and once the budget is gone
  //    no further fetch starts — the remaining symbols are
  //    marked missing in one pass.
  const rows: FeedFundamentalsRow[] = [];
  const missingSymbols: string[] = [];
  let firstError: string | null = null;
  const fetchDeadlineMs = Date.now() + FEED_JOB_TIMEOUTS.fetchMs;
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const remainingMs = fetchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      for (let j = i; j < symbols.length; j++) {
        missingSymbols.push(symbols[j]);
      }
      firstError ??= fetchTimeoutMessage();
      break;
    }
    try {
      const envelope = await withFeedDeadline(
        deps.provider.getFundamentals(symbol, {
          runId,
          tenantId: opts.tenantId ?? "default",
          ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
        }),
        remainingMs,
        FEED_JOB_CODES.fetchTimeout,
      );
      if (envelope.providerId !== def.sourceId) {
        missingSymbols.push(symbol);
        firstError ??= `Provider envelope named "${envelope.providerId}" for a "${def.sourceId}" feed job; the result was refused, not relabelled.`;
        continue;
      }
      if (envelope.result == null) {
        missingSymbols.push(symbol);
        continue;
      }
      rows.push({ symbol, fundamentals: envelope.result });
    } catch (err) {
      missingSymbols.push(symbol);
      firstError ??=
        err instanceof FeedJobTimeoutError
          ? fetchTimeoutMessage()
          : scrubFailureMessage(
              err instanceof Error ? err.message : String(err),
            );
    }
  }
  if (rows.length === 0) {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols,
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.noFundamentalsReturned,
      errorMessage:
        firstError ??
        `Provider "${def.sourceId}" returned no fundamentals for the ${universeLabel} universe; nothing was persisted as data.`,
      universe,
    });
  }
  return record({
    status: missingSymbols.length > 0 ? "partial" : "completed",
    rows,
    requested: symbols.length,
    missingSymbols,
    allSymbols: symbols,
    codedError: null,
    errorMessage: null,
    universe,
  });
}

/**
 * #3931 (sub-issue of #3929) — the technicals feed run: the same
 * contract as runFeedFundamentalsJob, over the provider's
 * historicalBars capability. The job persists the daily bars the
 * live history fetch already retrieves (HISTORY_BAR_LIMIT bars
 * per symbol, the same window the screener's live technicals leg
 * fetches), so enrich and the UX both read from the same persisted
 * copy. Honesty rules are the fundamentals run's, unchanged: the
 * universe is the stored index list; provenance is verified per
 * envelope; a run that fetched nothing is a FAILED run; per-symbol
 * failures are named in missingSymbols, never silently dropped.
 * Bars that are not all live (the provider's generated fallback)
 * are skipped per symbol — the live-only rule from #1331, applied
 * at persist time: generated bars are never persisted as data.
 */
export async function runFeedTechnicalsJob(
  registry: FeedJobRegistry,
  deps: FeedJobDeps,
  jobId: string,
  opts: RunFeedJobOptions = {},
): Promise<FeedRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new FeedJobError(
      FEED_JOB_CODES.jobNotFound,
      `No feed job is registered with id "${jobId}".`,
    );
  }
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const runId = opts.runId ?? `feed-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";

  const record = async (args: {
    status: FeedDatasetRunRecord["status"];
    rows: FeedDailyBarRow[];
    requested: number;
    missingSymbols: string[];
    /** #3992 PR-3: every requested symbol — the degraded
     *  capture-fallback record names them all as missing. */
    allSymbols: string[];
    codedError: string | null;
    errorMessage: string | null;
    universe: FeedDatasetArtifact["universe"];
  }): Promise<FeedRunResult> => {
    const finishedAt = now();
    const run: FeedDatasetRunRecord = {
      runId,
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: args.status,
      requested: args.requested,
      received: args.rows.length,
      failed: args.requested - args.rows.length,
      missingSymbols: args.missingSymbols,
      codedError: args.codedError,
      errorMessage: args.errorMessage,
    };
    const storeInput: FeedDatasetStoreInput = {
      jobId: def.id,
      sourceId: def.sourceId,
      dataset: def.dataset,
      elements: [...def.elements],
      universe: args.universe,
      providerId: def.sourceId,
      asOf: finishedAt.toISOString(),
      quotes: [],
      bars: args.rows,
      run,
      nowIso: finishedAt.toISOString(),
    };
    // #3992 PR-3: the store write is bound by the capture leg.
    // A store error rethrows exactly as before; a capture
    // timeout degrades honestly (degradedRun below).
    const outcome = await storeRunArtifact(deps.datasetStore, storeInput);
    if (!outcome.ok && outcome.reason === "error") throw outcome.error;
    let artifactId: string;
    let settledRun = run;
    if (outcome.ok) {
      artifactId = outcome.artifact.id;
    } else {
      // The primary write did not settle within the capture
      // bound: attempt ONE degraded fallback — same runId, a
      // failed empty record coded FEED_CAPTURE_TIMEOUT — and
      // land the run on it. If the fallback also fails, the
      // run still settles: captureTimeout with artifactId ""
      // (no artifact exists; an id is never fabricated).
      const degradedRun: FeedDatasetRunRecord = {
        ...run,
        status: "failed",
        received: 0,
        failed: args.requested,
        missingSymbols: args.allSymbols,
        codedError: FEED_JOB_CODES.captureTimeout,
        errorMessage: `Run-record store write did not settle within ${FEED_JOB_TIMEOUTS.captureMs}ms (${FEED_JOB_CODES.captureTimeout}); the run's data was not persisted.`,
      };
      const fallback = await storeRunArtifact(deps.datasetStore, {
        ...storeInput,
        bars: [],
        run: degradedRun,
      });
      settledRun = degradedRun;
      artifactId = fallback.ok ? fallback.artifact.id : "";
    }
    if (settledRun.status === "failed") {
      structuredLog.warn(FEED_JOB_RUN_FAILED, {
        message: `[feedJobs] ${FEED_JOB_RUN_FAILED}`,
        jobId: def.id,
        runId,
        code: settledRun.codedError,
        requested: args.requested,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: settledRun.status,
      artifactId,
      requested: settledRun.requested,
      received: settledRun.received,
      failed: settledRun.failed,
      missingSymbols: settledRun.missingSymbols,
      codedError: settledRun.codedError,
      startedAt: settledRun.startedAt,
      finishedAt: settledRun.finishedAt,
    };
  };

  // 1. Universe — the stored index list, never an invented one
  //    (a configured subset partitions it, as in the quotes run).
  // #3931: the run input names the list — the parameterized
  // job serves any stored list; absent ⇒ the default universe.
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  // #3982: same cold-store hydration as the quotes and
  // fundamentals runs (#3976) — the technicals runner resolves
  // its universe through the shared helper, never a bare read.
  const { list, refreshError, refreshTimedOut } =
    await resolveUniverseListWithHydration(deps, universeIndex);
  let symbols = symbolsOfList(list);
  if (opts.symbols && list) {
    const wanted = new Set(
      opts.symbols.map((s) => s.toUpperCase().trim()).filter((s) => s.length > 0),
    );
    symbols = symbols.filter((s) => wanted.has(s));
  }
  const universe: FeedDatasetArtifact["universe"] = {
    kind: "index",
    index: universeIndex,
    label: universeLabel,
    snapshotDate: list?.snapshotDate ?? null,
    sourceLabel: list?.sourceLabel ?? null,
    size: symbols.length,
  };
  if (!list || symbols.length === 0) {
    if (refreshTimedOut) {
      return record({
        status: "failed",
        rows: [],
        requested: 0,
        missingSymbols: [],
        allSymbols: symbols,
        codedError: FEED_JOB_CODES.refreshTimeout,
        errorMessage: `Index-list refresh for the ${universeLabel} universe did not settle within ${FEED_JOB_TIMEOUTS.refreshMs}ms (FEED_REFRESH_TIMEOUT). The feed job has no universe to pull.`,
        universe,
      });
    }
    if (refreshError !== undefined) {
      return record({
        status: "failed",
        rows: [],
        requested: 0,
        missingSymbols: [],
        allSymbols: symbols,
        codedError: FEED_JOB_CODES.universeRefreshFailed,
        errorMessage: `Index-list refresh for the ${universeLabel} universe failed: ${refreshError}. The feed job has no universe to pull.`,
        universe,
      });
    }
    return record({
      status: "failed",
      rows: [],
      requested: 0,
      missingSymbols: [],
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.universeMissing,
      errorMessage: `No stored ${universeLabel} index list exists; the feed job has no universe to pull. Refresh the index list first.`,
      universe,
    });
  }

  // 2. The capability contract: no historicalBars method ⇒ a named
  //    refusal recorded as the run, never a fabricated dataset.
  if (typeof deps.provider.getHistoricalBars !== "function") {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols: symbols,
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.historicalBarsUnsupported,
      errorMessage: `Provider "${def.sourceId}" does not implement historicalBars; the feed job cannot pull its dataset.`,
      universe,
    });
  }

  // 3. Fetch per symbol through the port — the same window the
  //    live technicals leg fetches (HISTORY_BAR_LIMIT daily bars).
  //    A symbol whose fetch throws, whose envelope names another
  //    provider, or whose bars are not all live is a missing
  //    symbol with the failure counted — one bad symbol never
  //    poisons the rows already pulled, and generated bars are
  //    never persisted as data.
  // #3992 PR-3: the WHOLE loop is bound by the fetch leg, as in
  //    the fundamentals run — one deadline captured before the
  //    loop on the race's clock (Date.now); each symbol races
  //    with the remaining budget; a timeout is missing with the
  //    timeout named; an exhausted budget starts no new fetch.
  const rows: FeedDailyBarRow[] = [];
  const missingSymbols: string[] = [];
  let firstError: string | null = null;
  const fetchDeadlineMs = Date.now() + FEED_JOB_TIMEOUTS.fetchMs;
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const remainingMs = fetchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      for (let j = i; j < symbols.length; j++) {
        missingSymbols.push(symbols[j]);
      }
      firstError ??= fetchTimeoutMessage();
      break;
    }
    try {
      const envelope = await withFeedDeadline(
        deps.provider.getHistoricalBars(symbol, "1D", HISTORY_BAR_LIMIT, {
          runId,
          tenantId: opts.tenantId ?? "default",
          ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
        }),
        remainingMs,
        FEED_JOB_CODES.fetchTimeout,
      );
      if (envelope.providerId !== def.sourceId) {
        missingSymbols.push(symbol);
        firstError ??= `Provider envelope named "${envelope.providerId}" for a "${def.sourceId}" feed job; the result was refused, not relabelled.`;
        continue;
      }
      if (envelope.result == null || envelope.result.length === 0) {
        missingSymbols.push(symbol);
        continue;
      }
      if (!marketDataResearchBarsToDailyBars(envelope.result)) {
        missingSymbols.push(symbol);
        firstError ??= `Provider "${def.sourceId}" returned non-live bars for "${symbol}"; the symbol was skipped, not persisted as data.`;
        continue;
      }
      rows.push({ symbol, bars: envelope.result });
    } catch (err) {
      missingSymbols.push(symbol);
      firstError ??=
        err instanceof FeedJobTimeoutError
          ? fetchTimeoutMessage()
          : scrubFailureMessage(
              err instanceof Error ? err.message : String(err),
            );
    }
  }
  if (rows.length === 0) {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols,
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.noBarsReturned,
      errorMessage:
        firstError ??
        `Provider "${def.sourceId}" returned no daily bars for the ${universeLabel} universe; nothing was persisted as data.`,
      universe,
    });
  }
  return record({
    status: missingSymbols.length > 0 ? "partial" : "completed",
    rows,
    requested: symbols.length,
    missingSymbols,
    allSymbols: symbols,
    codedError: null,
    errorMessage: null,
    universe,
  });
}

/**
 * #3932 — headlines classified per LLM call. The #132
 * discipline is batched, never per-headline: one gateway call
 * carries a bounded chunk of headlines (20 × ≤300 chars ≈
 * 7k chars of prompt), so a full-universe run classifies in a
 * handful of calls instead of one call per headline — and never
 * one unbounded call for the whole universe either.
 */
export const SENTIMENT_CLASSIFY_BATCH_SIZE = 20;

/** Headlines fetched per symbol per run (the adapter's fetch window). */
export const SENTIMENT_NEWS_PER_SYMBOL = 5;

/**
 * #3932 — aggregate one symbol's classified headline labels
 * into the persisted sentiment value: the bull/bear balance
 * (bullish +1, neutral 0, bearish −1, mean over the classified
 * headlines, rounded to 6 decimals) and the label it supports
 * (bullish at +1/3 and above, bearish at −1/3 and below,
 * neutral between — a tied or balanced feed is neutral, never
 * a coin flip). No labels ⇒ { label: null, score: null } (the
 * feed was fetched but nothing was assessed — the caller
 * records method "unavailable", never a guessed label).
 */
export function aggregateHeadlineSentiment(labels: readonly FlowSentiment[]): {
  label: PersistedSentiment["label"];
  score: number | null;
} {
  if (labels.length === 0) return { label: null, score: null };
  let balance = 0;
  for (const label of labels) {
    if (label === "bullish") balance += 1;
    else if (label === "bearish") balance -= 1;
  }
  const raw = balance / labels.length;
  const score = Math.round(raw * 1e6) / 1e6;
  const label: PersistedSentiment["label"] =
    raw >= 1 / 3 ? "bullish" : raw <= -1 / 3 ? "bearish" : "neutral";
  return { label, score };
}

/**
 * #3932 (sub-issue of #3929) — the sentiment feed run: the same
 * contract as runFeedFundamentalsJob, over the provider's news
 * capability. Per symbol the job fetches the Yahoo News feed
 * (SENTIMENT_NEWS_PER_SYMBOL recent headlines) and classifies
 * them with the #132 batched LLM classifier (classifyNewsSentiment
 * — one gateway call per bounded chunk, the #881 instruction/data
 * separation inside), then persists one row per symbol with the
 * aggregate label + score + method + headline evidence.
 * Honesty rules are the fundamentals run's, unchanged: the
 * universe is the stored index list; provenance is verified per
 * envelope; a run that fetched nothing is a FAILED run;
 * per-symbol failures are named in missingSymbols, never
 * silently dropped. And #145's honest degradation: without an
 * AI binding (no env, the gate off, a failed model call) the
 * headlines still persist — with method "unavailable" and a
 * null label — so enrich can name the gap instead of guessing.
 */
export async function runFeedSentimentJob(
  registry: FeedJobRegistry,
  deps: FeedJobDeps,
  jobId: string,
  opts: RunFeedJobOptions = {},
): Promise<FeedRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new FeedJobError(
      FEED_JOB_CODES.jobNotFound,
      `No feed job is registered with id "${jobId}".`,
    );
  }
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const runId = opts.runId ?? `feed-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";

  const record = async (args: {
    status: FeedDatasetRunRecord["status"];
    rows: FeedSentimentRow[];
    requested: number;
    missingSymbols: string[];
    /** #3992 PR-3: every requested symbol — the degraded
     *  capture-fallback record names them all as missing. */
    allSymbols: string[];
    codedError: string | null;
    errorMessage: string | null;
    universe: FeedDatasetArtifact["universe"];
  }): Promise<FeedRunResult> => {
    const finishedAt = now();
    const run: FeedDatasetRunRecord = {
      runId,
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: args.status,
      requested: args.requested,
      received: args.rows.length,
      failed: args.requested - args.rows.length,
      missingSymbols: args.missingSymbols,
      codedError: args.codedError,
      errorMessage: args.errorMessage,
    };
    const storeInput: FeedDatasetStoreInput = {
      jobId: def.id,
      sourceId: def.sourceId,
      dataset: def.dataset,
      elements: [...def.elements],
      universe: args.universe,
      providerId: def.sourceId,
      asOf: finishedAt.toISOString(),
      quotes: [],
      sentiment: args.rows,
      run,
      nowIso: finishedAt.toISOString(),
    };
    // #3992 PR-3: the store write is bound by the capture leg.
    // A store error rethrows exactly as before; a capture
    // timeout degrades honestly (degradedRun below).
    const outcome = await storeRunArtifact(deps.datasetStore, storeInput);
    if (!outcome.ok && outcome.reason === "error") throw outcome.error;
    let artifactId: string;
    let settledRun = run;
    if (outcome.ok) {
      artifactId = outcome.artifact.id;
    } else {
      // The primary write did not settle within the capture
      // bound: attempt ONE degraded fallback — same runId, a
      // failed empty record coded FEED_CAPTURE_TIMEOUT — and
      // land the run on it. If the fallback also fails, the
      // run still settles: captureTimeout with artifactId ""
      // (no artifact exists; an id is never fabricated).
      const degradedRun: FeedDatasetRunRecord = {
        ...run,
        status: "failed",
        received: 0,
        failed: args.requested,
        missingSymbols: args.allSymbols,
        codedError: FEED_JOB_CODES.captureTimeout,
        errorMessage: `Run-record store write did not settle within ${FEED_JOB_TIMEOUTS.captureMs}ms (${FEED_JOB_CODES.captureTimeout}); the run's data was not persisted.`,
      };
      const fallback = await storeRunArtifact(deps.datasetStore, {
        ...storeInput,
        sentiment: [],
        run: degradedRun,
      });
      settledRun = degradedRun;
      artifactId = fallback.ok ? fallback.artifact.id : "";
    }
    if (settledRun.status === "failed") {
      structuredLog.warn(FEED_JOB_RUN_FAILED, {
        message: `[feedJobs] ${FEED_JOB_RUN_FAILED}`,
        jobId: def.id,
        runId,
        code: settledRun.codedError,
        requested: args.requested,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: settledRun.status,
      artifactId,
      requested: settledRun.requested,
      received: settledRun.received,
      failed: settledRun.failed,
      missingSymbols: settledRun.missingSymbols,
      codedError: settledRun.codedError,
      startedAt: settledRun.startedAt,
      finishedAt: settledRun.finishedAt,
    };
  };

  // 1. Universe — the stored index list, never an invented one
  //    (a configured subset partitions it, as in the quotes run).
  // #3932: the run input names the list — the parameterized
  // job serves any stored list; absent ⇒ the default universe.
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  // #3932 + #3982: same cold-store hydration as the quotes,
  // fundamentals, and technicals runs (#3976/#3982) — the
  // sentiment runner resolves its universe through the shared
  // helper, never a bare read.
  const { list, refreshError, refreshTimedOut } =
    await resolveUniverseListWithHydration(deps, universeIndex);
  let symbols = symbolsOfList(list);
  if (opts.symbols && list) {
    const wanted = new Set(
      opts.symbols.map((s) => s.toUpperCase().trim()).filter((s) => s.length > 0),
    );
    symbols = symbols.filter((s) => wanted.has(s));
  }
  const universe: FeedDatasetArtifact["universe"] = {
    kind: "index",
    index: universeIndex,
    label: universeLabel,
    snapshotDate: list?.snapshotDate ?? null,
    sourceLabel: list?.sourceLabel ?? null,
    size: symbols.length,
  };
  if (!list || symbols.length === 0) {
    if (refreshTimedOut) {
      return record({
        status: "failed",
        rows: [],
        requested: 0,
        missingSymbols: [],
        allSymbols: symbols,
        codedError: FEED_JOB_CODES.refreshTimeout,
        errorMessage: `Index-list refresh for the ${universeLabel} universe did not settle within ${FEED_JOB_TIMEOUTS.refreshMs}ms (FEED_REFRESH_TIMEOUT). The feed job has no universe to pull.`,
        universe,
      });
    }
    if (refreshError !== undefined) {
      return record({
        status: "failed",
        rows: [],
        requested: 0,
        missingSymbols: [],
        allSymbols: symbols,
        codedError: FEED_JOB_CODES.universeRefreshFailed,
        errorMessage: `Index-list refresh for the ${universeLabel} universe failed: ${refreshError}. The feed job has no universe to pull.`,
        universe,
      });
    }
    return record({
      status: "failed",
      rows: [],
      requested: 0,
      missingSymbols: [],
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.universeMissing,
      errorMessage: `No stored ${universeLabel} index list exists; the feed job has no universe to pull. Refresh the index list first.`,
      universe,
    });
  }

  // 2. The capability contract: no news method ⇒ a named
  //    refusal recorded as the run, never a fabricated dataset.
  if (typeof deps.provider.getNews !== "function") {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols: symbols,
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.newsUnsupported,
      errorMessage: `Provider "${def.sourceId}" does not implement news; the feed job cannot pull its dataset.`,
      universe,
    });
  }

  // 3. Fetch the news per symbol through the port. A symbol
  //    whose fetch throws, whose envelope names another
  //    provider, or whose feed is empty is a missing symbol
  //    with the failure counted — one bad symbol never poisons
  //    the rows already pulled.
  // #3992 PR-3: the WHOLE loop is bound by the fetch leg, as in
  //    the fundamentals and technicals runs — one deadline
  //    captured before the loop on the race's clock (Date.now);
  //    each symbol races with the remaining budget; a timeout
  //    is missing with the timeout named; an exhausted budget
  //    starts no new fetch. Only the news FETCH is raced here:
  //    the classification batches below are NOT bounded in
  //    this PR — the PR-4 execution deadline covers them.
  const articlesBySymbol = new Map<
    string,
    Array<{ headline: string; source: string; publishedAt: string; url?: string }>
  >();
  const missingSymbols: string[] = [];
  let firstError: string | null = null;
  const fetchDeadlineMs = Date.now() + FEED_JOB_TIMEOUTS.fetchMs;
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const remainingMs = fetchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      for (let j = i; j < symbols.length; j++) {
        missingSymbols.push(symbols[j]);
      }
      firstError ??= fetchTimeoutMessage();
      break;
    }
    try {
      const envelope = await withFeedDeadline(
        deps.provider.getNews(symbol, {
          runId,
          tenantId: opts.tenantId ?? "default",
          ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
        }),
        remainingMs,
        FEED_JOB_CODES.fetchTimeout,
      );
      if (envelope.providerId !== def.sourceId) {
        missingSymbols.push(symbol);
        firstError ??= `Provider envelope named "${envelope.providerId}" for a "${def.sourceId}" feed job; the result was refused, not relabelled.`;
        continue;
      }
      const articles = (envelope.result ?? []).slice(0, SENTIMENT_NEWS_PER_SYMBOL);
      if (articles.length === 0) {
        missingSymbols.push(symbol);
        continue;
      }
      articlesBySymbol.set(
        symbol,
        articles.map((a) => ({
          headline: a.headline,
          source: a.source,
          publishedAt: a.publishedAt,
          ...(a.url ? { url: a.url } : {}),
        })),
      );
    } catch (err) {
      missingSymbols.push(symbol);
      firstError ??=
        err instanceof FeedJobTimeoutError
          ? fetchTimeoutMessage()
          : scrubFailureMessage(
              err instanceof Error ? err.message : String(err),
            );
    }
  }
  if (articlesBySymbol.size === 0) {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols,
      allSymbols: symbols,
      codedError: FEED_JOB_CODES.noNewsReturned,
      errorMessage:
        firstError ??
        `Provider "${def.sourceId}" returned no news for the ${universeLabel} universe; nothing was persisted as data.`,
      universe,
    });
  }

  // 4. Classify the fetched headlines with the #132 batched
  //    classifier, in bounded chunks. classifyNewsSentiment
  //    never throws and leaves failures "unavailable" — the
  //    gate off, no AI binding, a quota error, or a malformed
  //    reply all degrade to unassessed rows, never guessed
  //    labels. Items are keyed `news-<SYMBOL>-<index>` so the
  //    labels map back to their symbol.
  const items: NewsFlowItem[] = [];
  const itemSymbol: string[] = [];
  for (const [symbol, articles] of articlesBySymbol) {
    for (const [idx, a] of articles.entries()) {
      const publishedMs = Date.parse(a.publishedAt);
      items.push({
        id: `news-${symbol}-${idx}`,
        time: new Date(Number.isNaN(publishedMs) ? Date.now() : publishedMs).toISOString(),
        timestamp: Number.isNaN(publishedMs) ? Date.now() : publishedMs,
        headline: a.headline,
        symbols: [symbol],
        source: a.source,
        sentiment: "neutral",
        sentimentMethod: "unavailable",
        ...(a.url ? { url: a.url } : {}),
      });
      itemSymbol.push(symbol);
    }
  }
  for (let i = 0; i < items.length; i += SENTIMENT_CLASSIFY_BATCH_SIZE) {
    await classifyNewsSentiment(
      deps.env,
      items.slice(i, i + SENTIMENT_CLASSIFY_BATCH_SIZE),
    );
  }

  // 5. Aggregate per symbol over the headlines the model
  //    actually labelled. A symbol whose headlines were all
  //    left unassessed persists with method "unavailable" and
  //    a null label — the news is the row's evidence, the
  //    assessment is honestly absent.
  const finishedAt = now();
  const asOf = finishedAt.toISOString();
  const rows: FeedSentimentRow[] = [];
  for (const [symbol, articles] of articlesBySymbol) {
    const labels: FlowSentiment[] = [];
    let model: string | undefined;
    items.forEach((item, i) => {
      if (itemSymbol[i] !== symbol) return;
      if (item.sentimentMethod !== "llm") return;
      labels.push(item.sentiment);
      model ??= item.sentimentModel;
    });
    if (labels.length === 0) {
      rows.push({
        symbol,
        sentiment: {
          label: null,
          score: null,
          method: "unavailable",
          headlineCount: articles.length,
          headlines: articles,
          source: "yahoo-news",
          asOf,
        },
      });
      continue;
    }
    const { label, score } = aggregateHeadlineSentiment(labels);
    rows.push({
      symbol,
      sentiment: {
        label,
        score,
        method: "llm",
        ...(model ? { model } : {}),
        headlineCount: articles.length,
        headlines: articles,
        source: "yahoo-news",
        asOf,
      },
    });
  }
  return record({
    status: missingSymbols.length > 0 ? "partial" : "completed",
    rows,
    requested: symbols.length,
    missingSymbols,
    allSymbols: symbols,
    codedError: null,
    errorMessage: null,
    universe,
  });
}

/**
 * #4065 — the options-chains feed run: the same contract as
 * runFeedFundamentalsJob, over the provider's optionsChains
 * capability (getOptionExpiryDates + getOptionsChain). The job
 * persists the chains the live chainFetch already retrieves —
 * one row per symbol (the eligible expirations, one chain per
 * eligible expiry, verbatim as the provider returned them) —
 * so chainFetch can consume a persisted dataset exactly the
 * way the stock feed's quotes are consumed, instead of calling
 * a live client object at the entry.
 *
 * Decision (a) of #4065, on evidence: the chain source CAN
 * execute in workflow residency — the #3941 proof (PR #4056)
 * constructs the same broker clients inside the residency from
 * env through createCaptureWiredFeedProvider, and this runner
 * builds its provider the same way, through the same
 * providerFor seam. The live client object itself never
 * crosses a residency boundary (step inputs must be
 * serializable) — the J-engine constructs deps inside the
 * residency from env, exactly like the feed provider.
 *
 * Universe — two honest provenances, never a silent drop:
 * - a run input naming symbols: when every named symbol is a
 *   member of the stored list the run resolves (the default
 *   nasdaq100, or the run's `universe` input), the run is a
 *   subset of that list — index-kind universe, size the
 *   subset's (the #3535 pin: a sharded run's partition is a
 *   subset of the stored list, and its artifact still names
 *   the list). When ANY named symbol is not a member, the run
 *   is an explicit-symbol run — symbols-kind universe, the
 *   symbols used as-is (an options screen's underlyings need
 *   not belong to any stored list; filtering them against the
 *   list would silently drop the screen's symbols). The
 *   membership check is a plain store read — a run that names
 *   its symbols never triggers an index refresh for a list it
 *   may not need.
 * - no symbols input: the stored index list, with the
 *   fundamentals run's hydration + failure codes
 *   (FEED_REFRESH_TIMEOUT / FEED_UNIVERSE_REFRESH_FAILED /
 *   FEED_UNIVERSE_MISSING).
 *
 * Fetch window — the run's DTE band (minDte/maxDte) and the
 * per-symbol expiration cap (maxExpirationsPerSymbol); the
 * defaults mirror the screener's own fetch (0–365 days, 100
 * expirations — the screener config default). A misconfigured
 * window (minDte > maxDte) fails the run by name, never
 * persists an empty dataset.
 *
 * Honesty rules are the fundamentals run's, unchanged:
 * provenance is verified per envelope; a run that fetched
 * nothing is a FAILED run; per-symbol failures are named in
 * missingSymbols, never silently dropped. Two chains-specific
 * rules, mirroring the screener's fetchChainsForSymbol:
 * - expirations exist but none fall inside the window ⇒ a
 *   legitimate empty row (empty chains, no errors) — the
 *   symbol IS covered by the dataset, with nothing in-window.
 * - the provider returns NO expirations for a symbol ⇒ no
 *   row, the symbol is missing. The screener falls back to an
 *   unscoped chain request there; the feed job does NOT — an
 *   unscoped chain would land in the dataset without its
 *   expiry in the row's expiries, unmatchable provenance.
 * A row whose chain fetch failed for one expiry keeps its
 * fetched chains and names the failure in fetchErrors; the
 * run is partial. No behaviour change to any other stage.
 */
export async function runFeedOptionsChainsJob(
  registry: FeedJobRegistry,
  deps: FeedJobDeps,
  jobId: string,
  opts: RunFeedJobOptions = {},
): Promise<FeedRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new FeedJobError(
      FEED_JOB_CODES.jobNotFound,
      `No feed job is registered with id "${jobId}".`,
    );
  }
  const now = opts.now ?? (() => new Date());
  const startedAt = now();
  const runId = opts.runId ?? `feed-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";

  const record = async (args: {
    status: FeedDatasetRunRecord["status"];
    rows: FeedOptionsChainRow[];
    requested: number;
    missingSymbols: string[];
    codedError: string | null;
    errorMessage: string | null;
    universe: FeedDatasetArtifact["universe"];
  }): Promise<FeedRunResult> => {
    const finishedAt = now();
    const run: FeedDatasetRunRecord = {
      runId,
      trigger,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: args.status,
      requested: args.requested,
      received: args.rows.length,
      failed: args.requested - args.rows.length,
      missingSymbols: args.missingSymbols,
      codedError: args.codedError,
      errorMessage: args.errorMessage,
    };
    const artifact = await deps.datasetStore.store({
      jobId: def.id,
      sourceId: def.sourceId,
      dataset: def.dataset,
      elements: [...def.elements],
      universe: args.universe,
      providerId: def.sourceId,
      asOf: finishedAt.toISOString(),
      quotes: [],
      chains: args.rows,
      run,
      nowIso: finishedAt.toISOString(),
    });
    if (args.status === "failed") {
      structuredLog.warn(FEED_JOB_RUN_FAILED, {
        message: `[feedJobs] ${FEED_JOB_RUN_FAILED}`,
        jobId: def.id,
        runId,
        code: args.codedError,
        requested: args.requested,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: args.status,
      artifactId: artifact.id,
      requested: run.requested,
      received: run.received,
      failed: run.failed,
      missingSymbols: run.missingSymbols,
      codedError: run.codedError,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  };

  // 0. Fetch window — a misconfigured window fails the run by
  //    name, never persists an empty dataset. Validated after
  //    the universe input resolves (an unknown universe refuses
  //    by name first) and before any store read or fetch.
  const minDte = opts.minDte ?? 0;
  const maxDte = opts.maxDte ?? 365;
  const maxExpirationsPerSymbol = opts.maxExpirationsPerSymbol ?? 100;
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  if (minDte > maxDte) {
    return record({
      status: "failed",
      rows: [],
      requested: 0,
      missingSymbols: [],
      codedError: FEED_JOB_CODES.fetchFailed,
      errorMessage: `Invalid DTE window for the options-chains run: minDte (${minDte}) exceeds maxDte (${maxDte}).`,
      universe: {
        kind: "index",
        index: universeIndex,
        label: universeLabel,
        snapshotDate: null,
        sourceLabel: null,
        size: 0,
      },
    });
  }

  // 1. Universe — explicit symbols (membership rule) or the
  //    stored index list (with hydration, like the
  //    fundamentals run).
  const explicitSymbols = Array.from(
    new Set(
      (opts.symbols ?? [])
        .map((s) => s.toUpperCase().trim())
        .filter((s) => s.length > 0),
    ),
  );
  let symbols: string[];
  let universe: FeedDatasetArtifact["universe"];
  if (explicitSymbols.length > 0) {
    const list = await deps.universeStore.latest(universeIndex);
    const listed = new Set(symbolsOfList(list));
    if (list && explicitSymbols.every((s) => listed.has(s))) {
      symbols = explicitSymbols;
      universe = {
        kind: "index",
        index: universeIndex,
        label: universeLabel,
        snapshotDate: list.snapshotDate ?? null,
        sourceLabel: list.sourceLabel ?? null,
        size: symbols.length,
      };
    } else {
      symbols = explicitSymbols;
      universe = {
        kind: "symbols",
        symbols: [...explicitSymbols],
        label: `Run symbols (${explicitSymbols.length})`,
        snapshotDate: null,
        sourceLabel: null,
        size: symbols.length,
      };
    }
  } else {
    // #3976: same cold-store hydration as the fundamentals run.
    const { list, refreshError, refreshTimedOut } =
      await resolveUniverseListWithHydration(deps, universeIndex);
    symbols = symbolsOfList(list);
    universe = {
      kind: "index",
      index: universeIndex,
      label: universeLabel,
      snapshotDate: list?.snapshotDate ?? null,
      sourceLabel: list?.sourceLabel ?? null,
      size: symbols.length,
    };
    if (!list || symbols.length === 0) {
      if (refreshTimedOut) {
        return record({
          status: "failed",
          rows: [],
          requested: 0,
          missingSymbols: [],
          codedError: FEED_JOB_CODES.refreshTimeout,
          errorMessage: `Index-list refresh for the ${universeLabel} universe did not settle within ${FEED_JOB_TIMEOUTS.refreshMs}ms (FEED_REFRESH_TIMEOUT). The feed job has no universe to pull.`,
          universe,
        });
      }
      if (refreshError !== undefined) {
        return record({
          status: "failed",
          rows: [],
          requested: 0,
          missingSymbols: [],
          codedError: FEED_JOB_CODES.universeRefreshFailed,
          errorMessage: `Index-list refresh for the ${universeLabel} universe failed: ${refreshError}. The feed job has no universe to pull.`,
          universe,
        });
      }
      return record({
        status: "failed",
        rows: [],
        requested: 0,
        missingSymbols: [],
        codedError: FEED_JOB_CODES.universeMissing,
        errorMessage: `No stored ${universeLabel} index list exists; the feed job has no universe to pull. Refresh the index list first.`,
        universe,
      });
    }
  }

  // 2. The capability contract: no chain methods ⇒ a named
  //    refusal recorded as the run, never a fabricated dataset.
  if (
    typeof deps.provider.getOptionExpiryDates !== "function" ||
    typeof deps.provider.getOptionsChain !== "function"
  ) {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols: symbols,
      codedError: FEED_JOB_CODES.optionsChainsUnsupported,
      errorMessage: `Provider "${def.sourceId}" does not implement optionsChains; the feed job cannot pull its dataset.`,
      universe,
    });
  }

  // 3. Fetch per symbol through the port. The DTE window and
  //    the per-symbol expiration cap mirror the screener's
  //    fetchChainsForSymbol (dedupe + sort + cap); the budget
  //    and the retry pass do not apply — the dataset is the
  //    fetch, and a dataset-backed read is deterministic by
  //    construction. A symbol whose expiration fetch throws,
  //    whose envelope names another provider, or whose provider
  //    returns no expirations gets no row and is named missing;
  //    a chain fetch that fails for one expiry is named in the
  //    row's fetchErrors and the run goes partial.
  const todayUtc = Date.UTC(
    now().getUTCFullYear(),
    now().getUTCMonth(),
    now().getUTCDate(),
  );
  const rows: FeedOptionsChainRow[] = [];
  const missingSymbols: string[] = [];
  let firstError: string | null = null;
  for (const symbol of symbols) {
    try {
      const expirationsEnvelope = await deps.provider.getOptionExpiryDates(
        symbol,
        {
          runId,
          tenantId: opts.tenantId ?? "default",
          ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
        },
      );
      if (expirationsEnvelope.providerId !== def.sourceId) {
        missingSymbols.push(symbol);
        firstError ??= `Provider envelope named "${expirationsEnvelope.providerId}" for a "${def.sourceId}" feed job; the result was refused, not relabelled.`;
        continue;
      }
      const expirations = expirationsEnvelope.result ?? [];
      if (expirations.length === 0) {
        missingSymbols.push(symbol);
        firstError ??= `Provider "${def.sourceId}" returned no expirations for ${symbol}; no chain row was persisted for it.`;
        continue;
      }
      const eligible = Array.from(
        new Map(
          expirations
            .filter((expiry) => {
              const dte = Math.ceil(
                (Date.UTC(expiry.year, expiry.month - 1, expiry.day) -
                  todayUtc) /
                  (24 * 60 * 60 * 1000),
              );
              return dte >= minDte && dte <= maxDte;
            })
            .map((expiry) => [
              `${expiry.year}-${expiry.month}-${expiry.day}`,
              expiry,
            ]),
        ).values(),
      )
        .sort(
          (a, b) =>
            Date.UTC(a.year, a.month - 1, a.day) -
            Date.UTC(b.year, b.month - 1, b.day),
        )
        .slice(0, maxExpirationsPerSymbol);
      const chains: BrokerOptionChain[] = [];
      const fetchErrors: string[] = [];
      for (const expiry of eligible) {
        try {
          const chainEnvelope = await deps.provider.getOptionsChain(
            {
              symbol,
              expiryYear: expiry.year,
              expiryMonth: expiry.month,
              expiryDay: expiry.day,
              includeWeekly: true,
            },
            {
              runId,
              tenantId: opts.tenantId ?? "default",
              ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
            },
          );
          if (chainEnvelope.providerId !== def.sourceId) {
            fetchErrors.push(
              `Chain for ${expiry.year}-${expiry.month}-${expiry.day} named provider "${chainEnvelope.providerId}"; refused, not relabelled.`,
            );
            continue;
          }
          if (chainEnvelope.result) {
            const returned = chainEnvelope.result;
            // The dataset's chain→expiry association is the
            // chain's selectedExpiry (all three chains-serving
            // adapters stamp it). A chain that names a different
            // expiry than the one requested is a provider
            // contract violation — refused, never stored under
            // the wrong expiry. A chain with no stamp gets the
            // request's expiry on a copy (the request IS the
            // provenance: this chain was fetched for exactly
            // this expiry); the provider's object is never
            // mutated.
            if (returned.selectedExpiry) {
              const stamped = returned.selectedExpiry;
              if (
                stamped.year !== expiry.year ||
                stamped.month !== expiry.month ||
                stamped.day !== expiry.day
              ) {
                fetchErrors.push(
                  `Chain for ${expiry.year}-${expiry.month}-${expiry.day} named a different expiry (${stamped.year}-${stamped.month}-${stamped.day}); refused, not relabelled.`,
                );
                continue;
              }
              chains.push(returned);
            } else {
              chains.push({
                ...returned,
                selectedExpiry: {
                  year: expiry.year,
                  month: expiry.month,
                  day: expiry.day,
                },
              });
            }
          }
        } catch (err) {
          fetchErrors.push(
            scrubFailureMessage(
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      }
      rows.push({ symbol, expiries: eligible, chains, fetchErrors });
    } catch (err) {
      missingSymbols.push(symbol);
      firstError ??= scrubFailureMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (rows.length === 0) {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols,
      codedError: FEED_JOB_CODES.noChainsReturned,
      errorMessage:
        firstError ??
        `Provider "${def.sourceId}" returned no chains for the ${universeLabel} universe; nothing was persisted as data.`,
      universe,
    });
  }
  return record({
    status:
      missingSymbols.length > 0 ||
      rows.some((row) => row.fetchErrors.length > 0)
        ? "partial"
        : "completed",
    rows,
    requested: symbols.length,
    missingSymbols,
    codedError: null,
    errorMessage: null,
    universe,
  });
}

/* ------------------------------------------------------------------ */
/* The persisted-technicals read — the UX's primary source (#3931)     */
/* ------------------------------------------------------------------ */

/** One persisted-technicals read: bars by symbol + provenance. */
export interface PersistedTechnicalsRead {
  /** Daily bars per symbol (live bars only, converted). */
  barsBySymbol: Map<string, YahooDailyBar[]>;
  /** The UX label for these bars (names the persisted source). */
  label: string;
  /** When the bars were fetched (the producing run's finish time). */
  asOf: string;
  /** The universe whose copy this is (bars are per-symbol facts;
   *  the universe names which list the job pulled, not a filter). */
  universeIndex: IndexId;
  universeLabel: string;
  ageSeconds: number;
  /** True when the copy is older than the caller's bound (or,
   *  absent a bound, reported false — staleness is judged only
   *  against a bound the caller actually set). */
  stale: boolean;
}

/**
 * Read the newest usable technicals copy: the persisted bars the
 * UX reads as its primary source. A read NEVER fetches — the store
 * is the only input. Absent or unusable ⇒ undefined (the caller
 * falls back to the live fetch); a stale copy is returned WITH
 * stale: true so the caller can fall back to live instead of
 * serving old bars as current. Symbols whose stored bars are not
 * all live are skipped (defense in depth — the producing job
 * already refuses them at persist time).
 */
export async function readPersistedTechnicalsBars(
  store: FeedDatasetStore,
  args: {
    maxAgeSeconds?: number;
    nowMs: number;
  },
): Promise<PersistedTechnicalsRead | undefined> {
  const artifact = await store.latestUsable("yahoo", "technicals");
  if (!artifact || !artifact.bars || artifact.bars.length === 0) return undefined;
  // #4065: a technicals read needs a stored-list universe — an
  // explicit-symbol artifact names no list, so it is unusable
  // here (undefined, per this reader's contract — the caller
  // falls back to the live fetch, never a fabricated index).
  if (artifact.universe.kind !== "index") return undefined;
  const barsBySymbol = new Map<string, YahooDailyBar[]>();
  for (const row of artifact.bars) {
    const daily = marketDataResearchBarsToDailyBars(row.bars);
    if (daily) barsBySymbol.set(row.symbol.toUpperCase(), daily);
  }
  if (barsBySymbol.size === 0) return undefined;
  const asOfMs = Date.parse(artifact.asOf);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((args.nowMs - asOfMs) / 1000));
  return {
    barsBySymbol,
    label: `Persisted Yahoo daily bars (as of ${artifact.asOf.slice(0, 10)})`,
    asOf: artifact.asOf,
    universeIndex: artifact.universe.index,
    universeLabel: artifact.universe.label,
    ageSeconds,
    stale: args.maxAgeSeconds !== undefined && ageSeconds > args.maxAgeSeconds,
  };
}

/* ------------------------------------------------------------------ */
/* The persisted-sentiment read — the UX's primary source (#3932)      */
/* ------------------------------------------------------------------ */

/** One persisted-sentiment read: rows by symbol + provenance. */
export interface PersistedSentimentRead {
  /** Assessed sentiment per symbol (labelled and unassessed
   *  rows alike — the caller distinguishes them by the row's
   *  method, never by absence from the map). */
  sentimentBySymbol: Map<string, FeedSentimentRow>;
  /** The UX label for these rows (names the persisted source). */
  label: string;
  /** When the rows were assessed (the producing run's finish time). */
  asOf: string;
  /** The universe whose copy this is (rows are per-symbol facts;
   *  the universe names which list the job pulled, not a filter). */
  universeIndex: IndexId;
  universeLabel: string;
  ageSeconds: number;
  /** True when the copy is older than the caller's bound (or,
   *  absent a bound, reported false — staleness is judged only
   *  against a bound the caller actually set). */
  stale: boolean;
}

/**
 * Read the newest usable sentiment copy: the persisted rows the
 * UX reads as its primary source. A read NEVER fetches — the store
 * is the only input. Absent or unusable ⇒ undefined (the caller
 * shows a named gap, never the price-derived heuristic); a stale
 * copy is returned WITH stale: true so the caller can show the
 * gap instead of serving old sentiment as current.
 */
export async function readPersistedSentiment(
  store: FeedDatasetStore,
  args: {
    maxAgeSeconds?: number;
    nowMs: number;
  },
): Promise<PersistedSentimentRead | undefined> {
  const artifact = await store.latestUsable("yahoo", "sentiment");
  if (!artifact || !artifact.sentiment || artifact.sentiment.length === 0) {
    return undefined;
  }
  // #4065: a sentiment read needs a stored-list universe — an
  // explicit-symbol artifact names no list, so it is unusable
  // here (undefined, per this reader's contract — the caller
  // shows the gap, never a fabricated index).
  if (artifact.universe.kind !== "index") return undefined;
  const sentimentBySymbol = new Map<string, FeedSentimentRow>();
  for (const row of artifact.sentiment) {
    sentimentBySymbol.set(row.symbol.toUpperCase(), row);
  }
  if (sentimentBySymbol.size === 0) return undefined;
  const asOfMs = Date.parse(artifact.asOf);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((args.nowMs - asOfMs) / 1000));
  return {
    sentimentBySymbol,
    label: `Yahoo News (persisted sentiment, as of ${artifact.asOf.slice(0, 10)})`,
    asOf: artifact.asOf,
    universeIndex: artifact.universe.index,
    universeLabel: artifact.universe.label,
    ageSeconds,
    stale: args.maxAgeSeconds !== undefined && ageSeconds > args.maxAgeSeconds,
  };
}

/* ------------------------------------------------------------------ */
/* The read path — the persisted copy only. NO provider exists here.   */
/* ------------------------------------------------------------------ */

export async function readFeedQuotes(
  store: FeedDatasetStore,
  args: {
    sourceId: DataProviderId;
    dataset: string;
    symbols?: string[];
    maxAgeSeconds?: number;
    nowMs: number;
  },
): Promise<FeedQuotesResolution> {
  const artifact = await store.latestUsable(args.sourceId, args.dataset);
  return resolveFeedQuotesFromArtifact({
    artifact,
    sourceId: args.sourceId,
    dataset: args.dataset,
    symbols: args.symbols,
    maxAgeSeconds: args.maxAgeSeconds,
    nowMs: args.nowMs,
  });
}

/* ------------------------------------------------------------------ */
/* Status — what the UX renders (one source of truth: the store).      */
/* ------------------------------------------------------------------ */

export interface FeedStatusView {
  jobId: string;
  sourceId: DataProviderId;
  dataset: string;
  elements: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: FeedDatasetRunRecord | null;
  /** #3535: recent run history, newest first (the status
   *  surface's history block; the store's listRuns is the truth). */
  history: FeedDatasetRunRecord[];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    rowsPersisted: number;
    stale: boolean;
  } | null;
}

export async function buildFeedStatus(
  store: FeedDatasetStore,
  def: FeedJobDefinition,
  nowMs: number,
): Promise<FeedStatusView> {
  const [latest, usable, runArtifacts] = await Promise.all([
    store.latest(def.sourceId, def.dataset),
    store.latestUsable(def.sourceId, def.dataset),
    store.listRuns(def.sourceId, def.dataset, 5),
  ]);
  const base: FeedStatusView = {
    jobId: def.id,
    sourceId: def.sourceId,
    dataset: def.dataset,
    elements: [...def.elements],
    universeLabel: def.universe.label,
    cadenceMinutes: def.cadenceMinutes,
    staleAfterMinutes: def.staleAfterMinutes,
    state: latest ? "ready" : "never-run",
    lastRun: latest?.run ?? null,
    history: runArtifacts.map((a) => a.run),
    snapshot: null,
  };
  if (!usable) return base;
  const asOfMs = Date.parse(usable.asOf);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
  return {
    ...base,
    snapshot: {
      artifactId: usable.id,
      asOf: usable.asOf,
      ageSeconds,
      rowsPersisted: feedDatasetRowCount(usable),
      stale: ageSeconds > def.staleAfterMinutes * 60,
    },
  };
}
