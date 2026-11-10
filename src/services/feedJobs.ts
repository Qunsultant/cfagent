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
 *   (#3930 fundamentals; #3931 technicals) — the run input's list. No list ⇒
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
  marketDataResearchBarsToDailyBars,
  scrubFailureMessage,
  SECTOR_IDS,
  type DataProvider,
  type DataProviderCapability,
  type DataProviderId,
  type IndexId,
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
  type FeedFundamentalsRow,
  type FeedQuotesResolution,
} from "../data/feedDatasetPorts";
import type { IndexListStore } from "../data/indexListPorts";
import { executeIndexListRefreshJob } from "./indexListJob";
import type { IndexListFetchService } from "./indexListProducer";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/feedJobs",
});

/** Stable coded errors for feed-job outcomes (externalized vocabulary). */
export const FEED_JOB_CODES = {
  jobNotFound: "FEED_JOB_NOT_FOUND",
  universeMissing: "FEED_UNIVERSE_MISSING",
  universeRefreshFailed: "FEED_UNIVERSE_REFRESH_FAILED",
  universeUnknown: "FEED_UNIVERSE_UNKNOWN",
  batchUnsupported: "FEED_PROVIDER_BATCH_UNSUPPORTED",
  providerMismatch: "FEED_PROVIDER_MISMATCH",
  noQuotesReturned: "FEED_NO_QUOTES_RETURNED",
  fetchFailed: "FEED_FETCH_FAILED",
  fundamentalsUnsupported: "FEED_PROVIDER_FUNDAMENTALS_UNSUPPORTED",
  noFundamentalsReturned: "FEED_NO_FUNDAMENTALS_RETURNED",
  historicalBarsUnsupported: "FEED_PROVIDER_HISTORICAL_BARS_UNSUPPORTED",
  noBarsReturned: "FEED_NO_BARS_RETURNED",
} as const;
export type FeedJobCode = (typeof FEED_JOB_CODES)[keyof typeof FEED_JOB_CODES];

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
 * fundamentals and technicals), else the definition's universe. A
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
   * (fundamentals, #3930; technicals, #3931; sentiment in #3932) —
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
export const YAHOO_SP100_QUOTES_JOB_ID = "yahoo-sp100-quotes";
export const YAHOO_SP500_QUOTES_JOB_ID = "yahoo-sp500-quotes";
export const YAHOO_DOW_QUOTES_JOB_ID = "yahoo-dow-quotes";
export const ALPACA_NASDAQ100_QUOTES_JOB_ID = "alpaca-nasdaq100-quotes";
export const ETRADE_NASDAQ100_QUOTES_JOB_ID = "etrade-nasdaq100-quotes";
export const PUBLIC_NASDAQ100_QUOTES_JOB_ID = "public-nasdaq100-quotes";
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
 *   refresh completed but produced no usable list).
 */
async function resolveUniverseListWithHydration(
  deps: FeedJobDeps,
  universeIndex: IndexId,
): Promise<{ list: StoredIndexList; refreshError?: string }> {
  const list = await deps.universeStore.latest(universeIndex);
  if (list && symbolsOfList(list).length > 0) return { list };
  if (!deps.indexRefresh) return { list };
  try {
    await executeIndexListRefreshJob({
      store: deps.indexRefresh.store,
      service: deps.indexRefresh.service,
      indices: [universeIndex],
    });
  } catch (err) {
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
    const artifact = await deps.datasetStore.store({
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
    });
    if (args.status === "failed") {
      structuredLog.warn("feedJobs.run_failed", {
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

  // 1. Universe — the stored index list, never an invented one.
  // #3930: the run input names the list (parameterized jobs);
  // absent ⇒ the definition's universe.
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  // #3976: a cold store hydrates through the wired index refresh
  // before the universe is declared missing.
  const { list, refreshError } = await resolveUniverseListWithHydration(
    deps,
    universeIndex,
  );
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
  let envelope;
  try {
    envelope = await deps.provider.getQuotesBatch(symbols, {
      runId,
      tenantId: opts.tenantId ?? "default",
      ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
    });
  } catch (err) {
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
      fundamentals: args.rows,
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

  // 1. Universe — the stored index list, never an invented one
  //    (a configured subset partitions it, as in the quotes run).
  // #3930: the run input names the list — the parameterized
  // job serves any stored list; absent ⇒ the default universe.
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  // #3976: same cold-store hydration as the quotes run.
  const { list, refreshError } = await resolveUniverseListWithHydration(
    deps,
    universeIndex,
  );
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

  // 2. The capability contract: no fundamentals method ⇒ a named
  //    refusal recorded as the run, never a fabricated dataset.
  if (typeof deps.provider.getFundamentals !== "function") {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols: symbols,
      codedError: FEED_JOB_CODES.fundamentalsUnsupported,
      errorMessage: `Provider "${def.sourceId}" does not implement fundamentals; the feed job cannot pull its dataset.`,
      universe,
    });
  }

  // 3. Fetch per symbol through the port. A symbol whose fetch
  //    throws or whose envelope names another provider is a
  //    missing symbol with the failure counted — one bad symbol
  //    never poisons the rows already pulled.
  const rows: FeedFundamentalsRow[] = [];
  const missingSymbols: string[] = [];
  let firstError: string | null = null;
  for (const symbol of symbols) {
    try {
      const envelope = await deps.provider.getFundamentals(symbol, {
        runId,
        tenantId: opts.tenantId ?? "default",
        ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
      });
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
      bars: args.rows,
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

  // 1. Universe — the stored index list, never an invented one
  //    (a configured subset partitions it, as in the quotes run).
  // #3931: the run input names the list — the parameterized
  // job serves any stored list; absent ⇒ the default universe.
  const universeIndex = resolveRunUniverse(def, opts.universe);
  const universeLabel = labelForRunUniverse(registry, universeIndex);
  const list = await deps.universeStore.latest(universeIndex);
  let symbols = list
    ? Array.from(
        new Set(
          list.symbols
            .map((m) => m.symbol.toUpperCase().trim())
            .filter((s) => s.length > 0),
        ),
      )
    : [];
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

  // 2. The capability contract: no historicalBars method ⇒ a named
  //    refusal recorded as the run, never a fabricated dataset.
  if (typeof deps.provider.getHistoricalBars !== "function") {
    return record({
      status: "failed",
      rows: [],
      requested: symbols.length,
      missingSymbols: symbols,
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
  const rows: FeedDailyBarRow[] = [];
  const missingSymbols: string[] = [];
  let firstError: string | null = null;
  for (const symbol of symbols) {
    try {
      const envelope = await deps.provider.getHistoricalBars(
        symbol,
        "1D",
        HISTORY_BAR_LIMIT,
        {
          runId,
          tenantId: opts.tenantId ?? "default",
          ...(opts.userLogin ? { userLogin: opts.userLogin } : {}),
        },
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
