/**
 * Gather stage (issue #1654 slice 8).
 *
 * Venus's pipeline ruling (issue #1654, 2026-10-26): FEED collects data
 * from multiple providers; GATHER is a separate stage that combines and
 * enriches that data; ANALYSIS runs only on data that has passed through
 * both. Each stage persists its own results.
 *
 * This module is the gather stage for stock screening. It takes feed
 * output — a feed quote plus daily bars for the same symbol — and returns
 * the quote with every slice value computed from real bar history and
 * attached: Bollinger %B / bandwidth / squeeze minimum (slice 1),
 * anchored VWAP (slice 2), ATR% (slice 3), price-action regime (slice 5),
 * 6-vote composite bias score + label (slice 6), and Fibonacci levels
 * for the options-template preferFibLevels path (slice 4).
 *
 * The analysis side needs NO change: screenWithQuotes spreads the quote
 * onto the screened item, so gathered attachments flow straight into
 * evaluateUniverse, which gates on attached values and never sees bars.
 * That is the proof shape: a gate firing here fires on gathered data,
 * never on feed-carried values.
 *
 * Gather never fabricates. Any value that cannot be computed honestly
 * from the supplied bars is left absent, and the gates that need it
 * fail closed on absence — exactly as they do for feed-carried data.
 * No bars at all means no attachments at all.
 *
 * Persistence (Venus decision 2026-10-26): gather persists its enriched
 * dataset via the existing capture/blob pattern — one JSON blob per run
 * under gather/<runId>.json — with NO separate store. Gather is not a
 * provider fetch, so it records no provider capture row and claims no
 * providerId for computed values; the blob carries its own provenance
 * (bar provider, fetch time, completeness label) per symbol.
 *
 * Provenance labeling (slice 8 scope decision): Alpaca free-tier bars
 * formed within 15 minutes of fetch time are IEX-only, so a dataset
 * whose latest bar falls in that window is labeled "iex-partial" and
 * must be re-fetched for final values. Any other case labels
 * "complete" when bars exist, "unknown" when the fetch time or the
 * provider is not known. Labels travel with the dataset wherever it
 * surfaces; gathered data is never presented as live provider data.
 *
 * ORB is deliberately NOT computed here: slice 7's ORB functions take
 * minute bars plus an as-of time, and no gate consumes ORB state yet.
 * Computing it without a consumer would be speculative attachment.
 * Minute bars remain available through the slice 8 adapters for the
 * day a consumer exists.
 */

import {
  canonicalJson,
  getCaptureBlob,
  putCaptureBlob,
  type CaptureBlobDeps,
} from "./dataProviders/captureStore";
import type { DataProviderId } from "./dataProviders/contract";
import {
  classifyPriceRegime,
  computeAnchoredVwapFrom52wLow,
  computeAtr,
  computeBollingerBands,
  computeBollingerSqueezeGate,
  computeFibonacciRetracements,
  detectDeathCrossWithinSessions,
  type YahooDailyBar,
} from "./technicals";
import { compute6VoteCompositeBiasFromBars } from "./screeningIndicators";
import type { CompositeBias, ETradeQuote, PriceRegime } from "../types";

/** Slice values computed from bar history and attached to a feed quote. */
export interface GatheredAttachments {
  percentB?: number;
  bollingerBandwidth?: number;
  bollingerBandwidthMin?: number;
  bollingerBarsUsed?: number;
  anchoredVwap?: number;
  atrPct?: number;
  regime?: PriceRegime;
  compositeBiasScore?: number;
  compositeBias?: CompositeBias;
  /** Issue #1769: SMA50/SMA200 + death-cross flag from real bar history. */
  sma50?: number;
  sma200?: number;
  deathCrossWithin20?: boolean;
}

/** A feed quote carrying its gathered attachments. */
export type GatheredQuote = ETradeQuote & GatheredAttachments;

/** How complete the bar set behind a gathered symbol is. */
export type GatherBarCompleteness = "complete" | "iex-partial" | "unknown";

/** Provenance carried with every gathered symbol. */
export interface GatherBarProvenance {
  providerId: DataProviderId | "unknown";
  /** ISO fetch time of the bars, when known. */
  barsFetchedAt?: string;
  barCompleteness: GatherBarCompleteness;
  /** Bars the attachments were computed from (0 when none were supplied). */
  barsUsed: number;
}

/** One symbol's gather output. */
export interface GatheredSymbol {
  symbol: string;
  quote: GatheredQuote;
  /** Fibonacci retracement prices for the template path (slice 4). */
  fibLevels?: number[];
  provenance: GatherBarProvenance;
}

/** A whole run's gather output — the dataset that persists. */
export interface GatheredDataset {
  runId: string;
  gatheredAt: string;
  symbols: GatheredSymbol[];
}

/** Feed input for one symbol. */
export interface GatherInput {
  quote: ETradeQuote;
  /** Daily bars from the feed (already converted to YahooDailyBar). */
  dailyBars?: readonly YahooDailyBar[] | null;
  /** Bar provider, from the registry envelope providerId. */
  barProviderId?: DataProviderId;
  /** ISO time the bars were fetched, when known. */
  barsFetchedAt?: string;
}

/** Alpaca free-tier IEX-only window: bars formed within this long of the fetch are partial. */
export const IEX_PARTIAL_WINDOW_MS = 15 * 60 * 1000;

/** Blob key prefix for persisted gather datasets. */
export const GATHER_BLOB_KEY_PREFIX = "gather/";

export function gatherBlobKey(runId: string): string {
  return `${GATHER_BLOB_KEY_PREFIX}${runId}.json`;
}

function labelCompleteness(
  providerId: DataProviderId | "unknown",
  bars: readonly YahooDailyBar[],
  barsFetchedAt: string | undefined
): GatherBarCompleteness {
  if (bars.length === 0 || barsFetchedAt === undefined) return "unknown";
  if (providerId !== "alpaca") return "complete";
  const fetchedMs = Date.parse(barsFetchedAt);
  if (!Number.isFinite(fetchedMs)) return "unknown";
  const latestMs = Date.parse(bars[bars.length - 1].date);
  if (!Number.isFinite(latestMs)) return "unknown";
  // A bar formed within the IEX-only window before the fetch is partial
  // (free-tier Alpaca serves IEX-only for the last 15 minutes).
  return fetchedMs - latestMs <= IEX_PARTIAL_WINDOW_MS ? "iex-partial" : "complete";
}

/**
 * Enrich one feed quote with every slice value its daily bars support.
 * No bars (or an empty set) returns the quote untouched: no attachment
 * is ever estimated, so downstream gates fail closed exactly as they
 * do for missing feed-carried data.
 */
export function gatherEnrichedQuote(input: GatherInput): GatheredSymbol {
  const { quote, dailyBars } = input;
  const bars = dailyBars ?? [];
  const providerId = input.barProviderId ?? "unknown";
  const provenance: GatherBarProvenance = {
    providerId,
    barsFetchedAt: input.barsFetchedAt,
    barCompleteness: labelCompleteness(providerId, bars, input.barsFetchedAt),
    barsUsed: bars.length,
  };
  if (bars.length === 0) {
    return { symbol: quote.symbol, quote: { ...quote }, provenance };
  }

  const attachments: GatheredAttachments = {};
  const closes = bars.map((b) => b.close);

  const bands = computeBollingerBands(closes);
  if (bands !== null) {
    attachments.percentB = bands.percentB;
    attachments.bollingerBandwidth = bands.bandwidth;
  }
  const squeeze = computeBollingerSqueezeGate(closes);
  if (squeeze !== null) {
    attachments.bollingerBandwidthMin = squeeze.bandwidthMin;
    attachments.bollingerBarsUsed = squeeze.barsUsed;
  }

  const avwap = computeAnchoredVwapFrom52wLow(bars);
  if (avwap !== null) attachments.anchoredVwap = avwap;

  const atr = computeAtr(bars);
  const lastClose = closes[closes.length - 1];
  if (atr !== null && lastClose !== 0) {
    const atrPct = (atr / lastClose) * 100;
    if (Number.isFinite(atrPct)) attachments.atrPct = atrPct;
  }

  const regime = classifyPriceRegime(bars);
  if (regime !== null) attachments.regime = regime;

  const bias = compute6VoteCompositeBiasFromBars(bars);
  if (bias !== null) {
    attachments.compositeBiasScore = bias.score;
    attachments.compositeBias = bias.bias;
  }

  const deathCross = detectDeathCrossWithinSessions(bars);
  if (deathCross !== null) {
    attachments.sma50 = deathCross.latestSma50;
    attachments.sma200 = deathCross.latestSma200;
    attachments.deathCrossWithin20 = deathCross.crossedWithinSessions;
  }

  const fib = computeFibonacciRetracements(bars);
  const fibLevels = fib !== null ? fib.levels.map((l) => l.price) : undefined;

  return {
    symbol: quote.symbol,
    quote: { ...quote, ...attachments },
    ...(fibLevels !== undefined ? { fibLevels } : {}),
    provenance,
  };
}

/** Run gather over a whole feed universe. */
export function gatherDataset(
  runId: string,
  inputs: readonly GatherInput[]
): GatheredDataset {
  return {
    runId,
    gatheredAt: new Date().toISOString(),
    symbols: inputs.map((input) => gatherEnrichedQuote(input)),
  };
}

/**
 * Persist a gathered dataset via the capture/blob pattern: one JSON blob
 * under gather/<runId>.json. Returns the blob key. The blob round-trips
 * through getCaptureBlob (R2 when bound, base64 metadata otherwise).
 */
export async function persistGatheredDataset(
  deps: CaptureBlobDeps,
  dataset: GatheredDataset
): Promise<{ key: string }> {
  const key = gatherBlobKey(dataset.runId);
  const bytes = new TextEncoder().encode(canonicalJson(dataset));
  await putCaptureBlob(deps.env, deps.storage, key, bytes);
  return { key };
}

/** Read back a persisted gathered dataset, or null when absent. */
export async function readGatheredDataset(
  deps: CaptureBlobDeps,
  runId: string
): Promise<GatheredDataset | null> {
  const bytes = await getCaptureBlob(deps.env, deps.storage, gatherBlobKey(runId));
  if (bytes === null) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as GatheredDataset;
}
