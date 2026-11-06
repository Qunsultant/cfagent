/**
 * Issue #3530 (one-of-everything, S1) — feed jobs: the contract,
 * the registry, and the run/read/status service.
 *
 * A feed job pulls ONE source's declared dataset (S1: Yahoo
 * quotes for the Nasdaq-100 universe) through the provider PORT,
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
 * - The universe is the STORED Nasdaq-100 index list
 *   (indexListPorts — the platform's snapshot-dated membership);
 *   no list ⇒ a typed FEED_UNIVERSE_MISSING failure, never an
 *   invented universe.
 *
 * Run outcomes are RETURNED, not thrown — the run record is the
 * job's state (there is no async-job executor owning it on this
 * path), so a fetch failure is a recorded failed result. Only
 * contract violations throw (unknown job id — a caller bug).
 */
import {
  scrubFailureMessage,
  type DataProvider,
  type DataProviderCapability,
  type DataProviderId,
  type IndexId,
  type QuoteResult,
} from "../trading";
import {
  resolveFeedQuotesFromArtifact,
  type FeedDatasetArtifact,
  type FeedDatasetRunRecord,
  type FeedDatasetStore,
  type FeedQuotesResolution,
} from "../data/feedDatasetPorts";
import type { IndexListStore } from "../data/indexListPorts";

/** Stable coded errors for feed-job outcomes (externalized vocabulary). */
export const FEED_JOB_CODES = {
  jobNotFound: "FEED_JOB_NOT_FOUND",
  universeMissing: "FEED_UNIVERSE_MISSING",
  batchUnsupported: "FEED_PROVIDER_BATCH_UNSUPPORTED",
  providerMismatch: "FEED_PROVIDER_MISMATCH",
  noQuotesReturned: "FEED_NO_QUOTES_RETURNED",
  fetchFailed: "FEED_FETCH_FAILED",
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
export const FEED_JOB_DEFAULTS = {
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
} as const;

/** The built-in registry. S1 registers exactly one job — Yahoo
 *  quotes over the stored Nasdaq-100 list; later source slices
 *  register theirs here against the same contract. */
export function buildFeedJobRegistry(
  env: Record<string, string | undefined>,
): FeedJobRegistry {
  const registry = new FeedJobRegistry();
  registry.register({
    id: YAHOO_NASDAQ100_QUOTES_JOB_ID,
    sourceId: "yahoo",
    dataset: "quotes",
    elements: ["quotes"],
    universe: { kind: "index", index: "nasdaq100", label: "Nasdaq-100" },
    cadenceMinutes: resolveFeedJobCadenceMinutes(
      env,
      YAHOO_NASDAQ100_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.cadenceMinutes,
    ),
    staleAfterMinutes: resolveFeedJobStaleMinutes(
      env,
      YAHOO_NASDAQ100_QUOTES_JOB_ID,
      FEED_JOB_DEFAULTS.staleAfterMinutes,
    ),
  });
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
}

export interface RunFeedJobOptions {
  trigger?: "manual" | "scheduled";
  userLogin?: string;
  tenantId?: string;
  runId?: string;
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
      console.warn(`[feedJobs] ${FEED_JOB_RUN_FAILED}`, {
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
  const list = await deps.universeStore.latest(def.universe.index);
  const symbols = list
    ? Array.from(
        new Set(
          list.symbols
            .map((m) => m.symbol.toUpperCase().trim())
            .filter((s) => s.length > 0),
        ),
      )
    : [];
  const universe: FeedDatasetArtifact["universe"] = {
    kind: "index",
    index: def.universe.index,
    label: def.universe.label,
    snapshotDate: list?.snapshotDate ?? null,
    sourceLabel: list?.sourceLabel ?? null,
    size: symbols.length,
  };
  if (!list || symbols.length === 0) {
    return record({
      status: "failed",
      quotes: [],
      requested: 0,
      missingSymbols: [],
      codedError: FEED_JOB_CODES.universeMissing,
      errorMessage: `No stored ${def.universe.label} index list exists; the feed job has no universe to pull. Refresh the index list first.`,
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
      errorMessage: `Provider "${def.sourceId}" returned no quotes for the ${def.universe.label} universe; nothing was persisted as data.`,
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
  const [latest, usable] = await Promise.all([
    store.latest(def.sourceId, def.dataset),
    store.latestUsable(def.sourceId, def.dataset),
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
      rowsPersisted: usable.quotes.length,
      stale: ageSeconds > def.staleAfterMinutes * 60,
    },
  };
}
