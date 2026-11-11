/**
 * Issue #3530 (one-of-everything, S1) — the feed-dataset port: one
 * feed job's persisted dataset snapshot — the normalized quotes a
 * job pulled for its universe, with asOf + provenance, plus the
 * run record of the run that produced it.
 *
 * WHY A SIBLING STORE, not an extension of the feed-snapshot
 * store (feedSnapshotPorts.ts): that family stores per-(user,
 * symbol) OPTIONS snapshots (OptionsDataSnapshot) for discovery;
 * a feed dataset is a per-(source, dataset) quotes artifact with
 * a different owner and shape. Keying it by userLogin or forcing
 * it into an options-screen shape would fabricate data. This is
 * the index-list precedent (indexListPorts.ts, #1980) applied
 * again: a sibling family reusing the seam's idiom — one artifact
 * per store, asOf + provenance on every artifact, job results
 * carry descriptors not bytes — never a second feed system.
 *
 * RUN RECORDS live on the artifacts: every run stores exactly one
 * artifact (a failed run stores one with zero quotes), so
 * latest() IS the last run and latestUsable() is the last run
 * whose data a reader may serve. The platform's run-record
 * families cannot take a feed run without vocabulary surgery
 * (jobOutcomePorts' kind union is closed; jobRunRecordPorts
 * states worker-cron jobs have no records there) — #3527 S5 owns
 * system-wide registration; this family is the record until then.
 *
 * Residency: D1 (the capture/index-list ruling — the durable
 * readers, the data-providers status surface and future scheduled
 * consumers, run in different instances than the writer).
 * Adapters: d1FeedDatasetAdapter.ts (production),
 * inMemoryFeedDatasetAdapter.ts (test double). This module
 * carries the record types, the pure read resolver, and the port
 * interface ONLY (ADR 0002 R1/R2).
 */
import type {
  DataProviderId,
  FundamentalsResult,
  HistoricalBarsResult,
  IndexId,
  QuoteResult,
} from "../trading";
import type {
  BrokerOptionChain,
  BrokerOptionExpireDate,
} from "../types";

export type FeedDatasetRunStatus = "completed" | "partial" | "failed";
export type FeedDatasetRunTrigger = "manual" | "scheduled";

/** One feed run's outcome — the record the status surface renders. */
export interface FeedDatasetRunRecord {
  runId: string;
  trigger: FeedDatasetRunTrigger;
  startedAt: string;
  finishedAt: string;
  status: FeedDatasetRunStatus;
  /** Symbols the run set out to fetch (the universe's size). */
  requested: number;
  /** Symbols the provider actually returned quotes for. */
  received: number;
  /** requested - received. */
  failed: number;
  missingSymbols: string[];
  /** Stable coded error on a failed run; null otherwise. */
  codedError: string | null;
  /** Scrubbed, bounded failure message on a failed run; null otherwise. */
  errorMessage: string | null;
}

/** Where a dataset's universe came from — provenance, never invented. */
export interface FeedDatasetIndexUniverse {
  kind: "index";
  index: IndexId;
  label: string;
  /** The stored index list's snapshot date; null when no list existed. */
  snapshotDate: string | null;
  /** The stored index list's source label; null when no list existed. */
  sourceLabel: string | null;
  /** Symbols in the universe the run used (0 when none existed). */
  size: number;
}

/**
 * #4065 — an explicit-symbol run's universe: the run pulled
 * exactly these symbols (an options screen's underlyings, which
 * need not belong to any stored index list). There is no stored
 * list to name, so there is no snapshot date and no source label
 * — the symbols themselves ARE the provenance. Readers that need
 * a stored-list index (quotes / technicals / sentiment) treat a
 * symbols-kind artifact as unusable, never as an index run.
 */
export interface FeedDatasetSymbolUniverse {
  kind: "symbols";
  symbols: string[];
  label: string;
  snapshotDate: null;
  sourceLabel: null;
  /** Symbols in the universe the run used. */
  size: number;
}

export type FeedDatasetUniverse =
  | FeedDatasetIndexUniverse
  | FeedDatasetSymbolUniverse;

export interface FeedDatasetArtifact {
  id: string;
  jobId: string;
  sourceId: DataProviderId;
  /** Dataset id within the source (S1: "quotes"). */
  dataset: string;
  /** Capability elements the dataset carries (S1: ["quotes"]). */
  elements: string[];
  universe: FeedDatasetUniverse;
  /** The provider that actually served the fetch (envelope-verified). */
  providerId: DataProviderId;
  /** When the data was fetched (the producing run's finish time). */
  asOf: string;
  /** The normalized quotes, verbatim as the provider returned them. */
  quotes: QuoteResult[];
  /**
   * #3535 (Pipeline J2): the fundamentals dataset's rows — one per
   * symbol, verbatim as the provider returned them. Present only
   * on fundamentals-dataset artifacts; quotes artifacts omit it.
   * The store's row count (rows_persisted / latestUsable) counts
   * quotes + fundamentals rows, so a fundamentals copy is usable
   * exactly the way a quotes copy is.
   */
  fundamentals?: FeedFundamentalsRow[];
  /**
   * #3931 (sub-issue of #3929): the technicals dataset's rows —
   * one per symbol, the provider's daily bars verbatim as
   * returned (live bars only — the producing job skips a symbol
   * whose bars are not all live, never persists generated bars).
   * Present only on technicals-dataset artifacts; quotes and
   * fundamentals artifacts omit it. The store's row count counts
   * bars rows too, so a technicals copy is usable exactly the
   * way a quotes copy is.
   */
  bars?: FeedDailyBarRow[];
  /**
   * #3932 (sub-issue of #3929): the sentiment dataset's rows —
   * one per symbol, the news sentiment the producing job assessed
   * over the provider's real news feed (Yahoo News, classified by
   * the #132 batched LLM classifier — see feedJobs.ts). Present
   * only on sentiment-dataset artifacts; quotes, fundamentals,
   * and technicals artifacts omit it. The store's row count
   * counts sentiment rows too, so a sentiment copy is usable
   * exactly the way a quotes copy is.
   */
  sentiment?: FeedSentimentRow[];
  /**
   * #4065 — the options-chains dataset's rows — one per symbol:
   * the expirations the provider returned for the symbol (the
   * eligible DTE window, deduped, sorted), one chain per eligible
   * expiry fetched, verbatim as the provider returned it, and the
   * per-symbol fetch failures (empty when the symbol fetched
   * cleanly — a row with empty chains and no fetchErrors is a
   * legitimate empty slice, not a missing symbol). Present only
   * on options-chains-dataset artifacts; every other dataset
   * omits it. The store's row count counts chain rows too, so a
   * chains copy is usable exactly the way a quotes copy is.
   */
  chains?: FeedOptionsChainRow[];
  run: FeedDatasetRunRecord;
  createdAt: string;
}

/** One symbol's fundamentals row in a fundamentals-dataset artifact. */
export interface FeedFundamentalsRow {
  symbol: string;
  fundamentals: FundamentalsResult;
}

/** One symbol's daily-bar history in a technicals-dataset artifact. */
export interface FeedDailyBarRow {
  symbol: string;
  bars: HistoricalBarsResult;
}

/**
 * #3932 — one symbol's assessed news sentiment in a
 * sentiment-dataset artifact. The assessment follows #145's
 * provenance + honest-degradation pattern: `label` is the
 * aggregate of the fetched headlines' LLM labels (or null when
 * the headlines were fetched but no assessment was produced —
 * the AI binding absent, the gate off, or the model call failed),
 * `score` is the bull/bear balance in [-1, 1] (or null with an
 * unassessed row), `method` names how the label was produced
 * ("llm" + `model`, or "unavailable"), `headlines` is the
 * evidence the label rests on (capped by the producing job),
 * and `source` names the feed ("yahoo-news"). A row with a null
 * label is a REAL row — the symbol is covered by the dataset,
 * the assessment is what is missing — never a fabricated label.
 */
export interface PersistedSentiment {
  label: "bullish" | "bearish" | "neutral" | null;
  score: number | null;
  method: "llm" | "unavailable";
  model?: string;
  headlineCount: number;
  headlines: Array<{
    headline: string;
    source: string;
    publishedAt: string;
    url?: string;
  }>;
  source: "yahoo-news";
  asOf: string;
}

/** One symbol's assessed sentiment in a sentiment-dataset artifact. */
export interface FeedSentimentRow {
  symbol: string;
  sentiment: PersistedSentiment;
}

/**
 * #4065 — one symbol's option chains in an options-chains
 * dataset artifact. `expiries` are the eligible expirations the
 * provider returned for the symbol (the run's DTE window,
 * deduped, sorted); `chains` holds one chain per eligible expiry
 * fetched, verbatim as the provider returned it (each chain's
 * selectedExpiry names its expiry — the dataset-backed source
 * matches a requested expiry against it); `fetchErrors` names
 * the per-symbol fetch failures as plain strings (empty when
 * the symbol fetched cleanly). A row is stored for every symbol
 * whose expiration fetch succeeded, even when no expiry fell
 * inside the window (empty chains, no errors — the legitimate
 * empty slice); a symbol whose expiration fetch failed gets no
 * row and is named in the run record's missingSymbols instead.
 */
export interface FeedOptionsChainRow {
  symbol: string;
  expiries: BrokerOptionExpireDate[];
  chains: BrokerOptionChain[];
  fetchErrors: string[];
}

/** Rows a stored artifact carries (quotes + fundamentals + bars + sentiment + chains) — the
 *  count every adapter persists and every status surface shows. */
export function feedDatasetRowCount(artifact: FeedDatasetArtifact): number {
  return (
    artifact.quotes.length +
    (artifact.fundamentals?.length ?? 0) +
    (artifact.bars?.length ?? 0) +
    (artifact.sentiment?.length ?? 0) +
    (artifact.chains?.length ?? 0)
  );
}

export interface FeedDatasetStoreOptions {
  idFactory?: () => string;
  /** Artifacts kept per (source, dataset) after each store. Default 10. */
  keepPerDataset?: number;
}

export type FeedDatasetStoreInput = Omit<
  FeedDatasetArtifact,
  "id" | "createdAt"
> & {
  /** Injectable clock (tests); defaults to now. */
  nowIso?: string;
};

/** The feed-dataset store port (reader + the write side). */
export interface FeedDatasetStore {
  /** Store one run's artifact and prune to the newest
   *  keepPerDataset rows for its (source, dataset). */
  store(input: FeedDatasetStoreInput): Promise<FeedDatasetArtifact>;
  /** The newest artifact for (source, dataset) — the LAST RUN,
   *  whatever its outcome; undefined when the job has never run. */
  latest(
    sourceId: DataProviderId,
    dataset: string,
  ): Promise<FeedDatasetArtifact | undefined>;
  /** The newest artifact a reader may serve: completed or partial
   *  with at least one quote. A failed run never poisons reads. */
  latestUsable(
    sourceId: DataProviderId,
    dataset: string,
  ): Promise<FeedDatasetArtifact | undefined>;
  /** Run history for (source, dataset), newest first. */
  listRuns(
    sourceId: DataProviderId,
    dataset: string,
    limit?: number,
  ): Promise<FeedDatasetArtifact[]>;
}

/** Provenance a read carries — the copy's origin, labelled, always. */
export interface FeedQuotesProvenance {
  providerId: DataProviderId;
  runId: string;
  jobId: string;
  asOf: string;
  universeIndex: IndexId;
  universeSnapshotDate: string | null;
  universeSourceLabel: string | null;
}

export type FeedQuotesResolution =
  | {
      status: "hit";
      quotes: QuoteResult[];
      /** Requested symbols the stored copy does not carry. */
      missingSymbols: string[];
      provenance: FeedQuotesProvenance;
      ageSeconds: number;
      /** True when the copy is older than the caller's bound (or,
       *  absent a bound, reported false — staleness is judged only
       *  against a bound the caller actually set). */
      stale: boolean;
    }
  | { status: "missing"; reason: string };

function quoteSymbol(quote: QuoteResult): string {
  return typeof (quote as { symbol?: unknown }).symbol === "string"
    ? ((quote as { symbol: string }).symbol.toUpperCase())
    : "";
}

/**
 * Resolve a quotes read against one stored artifact. Pure: a read
 * NEVER fetches — this function has no provider in its inputs, so
 * a missing or stale copy is a labelled outcome, never a silent
 * live refetch (the feed seam's honesty rule, carried over).
 */
export function resolveFeedQuotesFromArtifact(args: {
  artifact: FeedDatasetArtifact | undefined;
  sourceId: DataProviderId;
  dataset: string;
  /** Subset to serve; absent ⇒ the whole stored copy. */
  symbols?: string[];
  /** Freshness bound (seconds). Absent ⇒ no staleness judgment;
   *  the copy is served with its age surfaced. Deliberately no
   *  default (the feedSnapshotPorts rule). */
  maxAgeSeconds?: number;
  nowMs: number;
}): FeedQuotesResolution {
  const { artifact } = args;
  if (!artifact) {
    return {
      status: "missing",
      reason: `no stored feed snapshot for ${args.sourceId}/${args.dataset}: the feed job has not produced a usable dataset yet`,
    };
  }
  const bySymbol = new Map<string, QuoteResult>();
  for (const q of artifact.quotes) {
    const symbol = quoteSymbol(q);
    if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, q);
  }
  let quotes: QuoteResult[];
  let missingSymbols: string[] = [];
  if (args.symbols && args.symbols.length > 0) {
    quotes = [];
    for (const raw of args.symbols) {
      const symbol = raw.toUpperCase().trim();
      const found = bySymbol.get(symbol);
      if (found) quotes.push(found);
      else missingSymbols.push(symbol);
    }
  } else {
    quotes = [...bySymbol.values()];
  }
  const asOfMs = Date.parse(artifact.asOf);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((args.nowMs - asOfMs) / 1000));
  const stale =
    args.maxAgeSeconds !== undefined && ageSeconds > args.maxAgeSeconds;
  // #4065: a quotes read needs a stored-list universe — an
  // explicit-symbol artifact names no list, so it is unusable
  // here (a labelled miss, never a fabricated index).
  if (artifact.universe.kind !== "index") {
    return {
      status: "missing",
      reason: `stored feed snapshot for ${args.sourceId}/${args.dataset} carries an explicit-symbol universe, not a stored index list: no quotes provenance to serve`,
    };
  }
  return {
    status: "hit",
    quotes,
    missingSymbols,
    provenance: {
      providerId: artifact.providerId,
      runId: artifact.run.runId,
      jobId: artifact.jobId,
      asOf: artifact.asOf,
      universeIndex: artifact.universe.index,
      universeSnapshotDate: artifact.universe.snapshotDate,
      universeSourceLabel: artifact.universe.sourceLabel,
    },
    ageSeconds,
    stale,
  };
}
