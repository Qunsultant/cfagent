/**
 * Issue #3536 (Pipeline J3, epic #3533) — enrich jobs: the
 * contract, the registry, the computation, and the run/read/
 * status service. The consumer half of the pipeline's first
 * hand-off: an enrich job reads the PERSISTED feed dataset its
 * feed job produced (the local copy, with its provenance —
 * feedDatasetPorts), computes the derived elements its
 * externalized configuration names, and persists the enriched
 * dataset (enrichedDatasetPorts) for the analyze stage.
 *
 * Honesty rules (the platform's, carried over from #3530 and
 * from the screening-indicator precedent #261):
 * - A read NEVER fetches: this module has no provider in its
 *   inputs. The input is resolved from the feed-dataset store
 *   by the producing feed job's id — exact lineage, never a
 *   neighbouring job's copy silently substituted (#2144).
 * - An element the persisted inputs cannot support is recorded
 *   as UNAVAILABLE with a coded reason — never fabricated.
 *   Series indicators (SMA / Bollinger) compute over the
 *   persisted snapshot series (the feed store's run history)
 *   with that basis recorded on the artifact; RSI / MACD / ATR
 *   require daily-bar history the feed stage does not persist,
 *   so they are named-unavailable until a bars dataset exists.
 * - A missing persisted input refuses BY NAME
 *   (ENRICH_INPUT_MISSING, fail-closed — the stage_input_missing
 *   pattern): the failed run is recorded on the enriched store
 *   (its artifact carries the run record) and returned, never a
 *   silent empty success.
 *
 * Run outcomes are RETURNED, not thrown — the run record is the
 * job's state (the #3530 idiom). Only contract violations throw
 * (unknown job id — a caller bug; an unknown element name in
 * configuration — a configuration bug).
 */
import {
  computeBollingerBands,
  computeScreeningIndicators,
  computeSma,
  scrubFailureMessage,
  type DataProviderId,
  type IndexId,
  type QuoteResult,
  type ScreeningIndicators,
} from "../trading";
import {
  feedDatasetRowCount,
  type FeedDatasetArtifact,
  type FeedDatasetStore,
} from "../data/feedDatasetPorts";
import {
  type EnrichedDatasetArtifact,
  type EnrichedDatasetStore,
  type EnrichedElementGap,
} from "../data/enrichedDatasetPorts";
import { buildFeedJobRegistry } from "./feedJobs";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/enrichJobs",
});

/** Stable coded errors for enrich-job outcomes (externalized vocabulary). */
export const ENRICH_JOB_CODES = {
  jobNotFound: "ENRICH_JOB_NOT_FOUND",
  inputMissing: "ENRICH_INPUT_MISSING",
  elementUnknown: "ENRICH_ELEMENT_UNKNOWN",
} as const;
export type EnrichJobCode = (typeof ENRICH_JOB_CODES)[keyof typeof ENRICH_JOB_CODES];

/** Stable log event code for a failed enrich run (codes + counts only, never payloads). */
export const ENRICH_JOB_RUN_FAILED = "enrich_job_run_failed";

export class EnrichJobError extends Error {
  readonly code: EnrichJobCode;
  constructor(code: EnrichJobCode, message: string) {
    super(message);
    this.name = "EnrichJobError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* The element vocabulary                                              */
/* ------------------------------------------------------------------ */

/**
 * Snapshot elements: derived from the persisted quote itself.
 * Each names the feature key(s) it writes — one for most, the
 * Bollinger family for "bollinger".
 */
export const ENRICH_SNAPSHOT_ELEMENTS = [
  "momentum",
  "intradayPosition",
  "dayRangePercent",
  "gapPercent",
  "relativeVolume",
  "vwapDeviationPercent",
  "spreadPercent",
  "rangePosition52w",
] as const;

/** Screening elements: the platform's snapshot screening
 *  indicators (#261), computed by computeScreeningIndicators. */
export const ENRICH_SCREENING_ELEMENTS = [
  "sentiment",
  "rangeZone",
  "valueZone",
  "screenScore",
] as const;

/** Fundamentals elements: joined from a persisted fundamentals
 *  dataset (the enrichFrom sources), by symbol. */
export const ENRICH_FUNDAMENTALS_ELEMENTS = [
  "peTrailing",
  "peForward",
  "pegRatio",
  "priceToBook",
  "beta",
  "marketCap",
  "enterpriseValue",
  "dividendYield",
  "profitMargins",
  "operatingMargins",
  "returnOnEquity",
  "targetMeanPrice",
  "analystUpsidePercent",
  "recommendationKey",
] as const;

/** Series elements: computed over the PERSISTED SNAPSHOT SERIES
 *  (the feed store's run history for the input dataset), with
 *  the basis recorded on the artifact. */
export const ENRICH_SERIES_ELEMENTS = ["sma", "bollinger"] as const;

/** Known elements the persisted inputs cannot support today:
 *  each requires daily-bar history, which no feed dataset
 *  persists. Accepted in configuration, reported unavailable
 *  with the coded reason — never fabricated. */
export const ENRICH_HISTORY_ELEMENTS = ["rsi", "macd", "atr"] as const;

export const ENRICH_ALL_ELEMENTS: readonly string[] = [
  ...ENRICH_SNAPSHOT_ELEMENTS,
  ...ENRICH_SCREENING_ELEMENTS,
  ...ENRICH_FUNDAMENTALS_ELEMENTS,
  ...ENRICH_SERIES_ELEMENTS,
  ...ENRICH_HISTORY_ELEMENTS,
];

const FUNDAMENTALS_SET = new Set<string>(ENRICH_FUNDAMENTALS_ELEMENTS);
const SERIES_SET = new Set<string>(ENRICH_SERIES_ELEMENTS);
const HISTORY_SET = new Set<string>(ENRICH_HISTORY_ELEMENTS);

/** Coded gap reasons (externalized vocabulary). */
export const ENRICH_GAP_REASONS = {
  requiresDailyBarHistory: "requires_daily_bar_history",
  insufficientSnapshotSeries: "insufficient_snapshot_series",
  fieldNotInSnapshot: "field_not_in_snapshot",
  joinDatasetMissing: "join_dataset_missing",
  symbolNotInJoinDataset: "symbol_not_in_join_dataset",
} as const;

/** The default element set every built-in enrich job computes. */
export const ENRICH_DEFAULT_ELEMENTS: readonly string[] = [
  ...ENRICH_SNAPSHOT_ELEMENTS,
  ...ENRICH_SCREENING_ELEMENTS,
  ...ENRICH_SERIES_ELEMENTS,
];

/** Validate a configured element list; an unknown name is a
 *  configuration error, refused by name (never silently dropped). */
export function validateEnrichElements(elements: readonly string[]): string[] {
  const out: string[] = [];
  for (const element of elements) {
    if (!ENRICH_ALL_ELEMENTS.includes(element)) {
      throw new EnrichJobError(
        ENRICH_JOB_CODES.elementUnknown,
        `Unknown enrich element "${element}". Known elements: ${ENRICH_ALL_ELEMENTS.join(", ")}.`,
      );
    }
    if (!out.includes(element)) out.push(element);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The contract + registry                                             */
/* ------------------------------------------------------------------ */

/** One persisted dataset an enrich job joins onto its input, by symbol. */
export interface EnrichJoinSource {
  /** The feed job maintaining the join dataset (exact lineage). */
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  /**
   * #3930 — the universe whose copy of the join dataset this
   * join reads: the join is by symbol AND by universe, so one
   * parameterized job serving many lists never hands an enrich
   * job another universe's copy. Absent ⇒ the enrich job's own
   * universe (the built-in registry always names it).
   */
  universe?: IndexId;
}

/**
 * The enrich-job contract: the feed job whose persisted dataset
 * it consumes, the elements it derives, the datasets it joins,
 * and its cadence/freshness knobs (config-resolved, see
 * buildEnrichJobRegistry — never literals at call sites).
 */
export interface EnrichJobDefinition {
  id: string;
  /** The feed job whose persisted dataset is the input. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The input dataset id within the source ("quotes"). */
  dataset: string;
  universe: { kind: "index"; index: IndexId; label: string };
  /** The elements this job computes by default (the pipeline
   *  definition's step params may override per configuration). */
  elements: readonly string[];
  /** Persisted datasets joined onto the input rows, by symbol. */
  enrichFrom: readonly EnrichJoinSource[];
  /** Declared cadence — the scheduling slice's input. */
  cadenceMinutes: number;
  /** Age past which the stored enriched copy is labelled stale. */
  staleAfterMinutes: number;
}

/**
 * The enrich-job registry — the FeedJobRegistry idiom (unique
 * ids, re-registering throws so provenance ids stay
 * unambiguous; explicit resolution failure, no silent fallback).
 */
export class EnrichJobRegistry {
  private jobs = new Map<string, EnrichJobDefinition>();

  register(job: EnrichJobDefinition): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`Enrich job "${job.id}" is already registered.`);
    }
    this.jobs.set(job.id, job);
  }

  get(id: string): EnrichJobDefinition | undefined {
    return this.jobs.get(id);
  }

  list(): EnrichJobDefinition[] {
    return Array.from(this.jobs.values());
  }

  /** The enrich job consuming a feed job's dataset, if one is registered. */
  forFeedJob(feedJobId: string): EnrichJobDefinition | undefined {
    return this.list().find((j) => j.feedJobId === feedJobId);
  }
}

/* ------------------------------------------------------------------ */
/* Cadence / freshness / element knobs — config, not literals.         */
/* ENRICH_JOB_<JOB_ID>_CADENCE_MINUTES / _STALE_MINUTES / _ELEMENTS    */
/* ------------------------------------------------------------------ */

function knobKey(jobId: string, suffix: string): string {
  return `ENRICH_JOB_${jobId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
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

function resolveElementsKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  fallback: readonly string[],
): string[] {
  const raw = env[knobKey(jobId, "ELEMENTS")];
  if (typeof raw !== "string" || !raw.trim()) return [...fallback];
  return validateEnrichElements(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
}

/**
 * #3930 — the per-job fundamentals-join mode, from
 * ENRICH_JOB_<JOB_ID>_FUNDAMENTALS_JOIN: "auto" (default —
 * join the parameterized fundamentals dataset for the job's
 * own universe when one is registered), "on" (the same join,
 * pinned explicitly), "off" (quotes-only — the pre-#3930
 * behavior, kept behind the switch). An unknown value falls
 * back to "auto" (the minutes-knob idiom).
 */
export function resolveFundamentalsJoinMode(
  env: Record<string, string | undefined>,
  jobId: string,
): "auto" | "on" | "off" {
  const raw = env[knobKey(jobId, "FUNDAMENTALS_JOIN")];
  if (raw === "off" || raw === "on" || raw === "auto") return raw;
  return "auto";
}

export const ENRICH_JOB_DEFAULTS = {
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
} as const;

/**
 * The built-in registry: one enrich job per QUOTES feed job in
 * the #3530 registry (the fundamentals job is an enrichment
 * SOURCE, not a target; the universe job's product is the
 * stored index list, not a feed-dataset artifact). #3930: every
 * quotes job joins the parameterized fundamentals dataset for
 * ITS OWN universe — the join is by symbol and by universe, so
 * a broker chain carries the 14 fundamentals elements exactly
 * where the persisted dataset carries the symbol, and named
 * gaps where it does not. The per-job FUNDAMENTALS_JOIN knob ("auto" | "on" | "off",
 * default "auto") opts one job out to quotes-only; an unknown
 * value falls back to "auto". Every job's element set is the
 * default snapshot + screening + series set (plus the
 * fundamentals elements for jobs with a join source).
 */
export function buildEnrichJobRegistry(
  env: Record<string, string | undefined>,
): EnrichJobRegistry {
  const feedRegistry = buildFeedJobRegistry(env);
  const fundamentalsJobs = feedRegistry
    .list()
    .filter((j) => j.dataset === "fundamentals");
  const registry = new EnrichJobRegistry();
  for (const feed of feedRegistry.list()) {
    if (feed.dataset !== "quotes") continue;
    const id = `${feed.id}-enrich`;
    const enrichFrom: EnrichJoinSource[] =
      resolveFundamentalsJoinMode(env, id) === "off"
        ? []
        : fundamentalsJobs.map((job) => ({
            feedJobId: job.id,
            sourceId: job.sourceId,
            dataset: job.dataset,
            universe: feed.universe.index,
          }));
    const defaults = enrichFrom.length
      ? [...ENRICH_DEFAULT_ELEMENTS, ...ENRICH_FUNDAMENTALS_ELEMENTS]
      : ENRICH_DEFAULT_ELEMENTS;
    registry.register({
      id,
      feedJobId: feed.id,
      sourceId: feed.sourceId,
      dataset: feed.dataset,
      universe: feed.universe,
      elements: resolveElementsKnob(env, id, defaults),
      enrichFrom,
      cadenceMinutes: resolveMinutesKnob(
        env,
        id,
        "CADENCE_MINUTES",
        ENRICH_JOB_DEFAULTS.cadenceMinutes,
      ),
      staleAfterMinutes: resolveMinutesKnob(
        env,
        id,
        "STALE_MINUTES",
        ENRICH_JOB_DEFAULTS.staleAfterMinutes,
      ),
    });
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/* Quote field extraction (structural — both normalized shapes)        */
/* ------------------------------------------------------------------ */

interface QuoteFields {
  symbol: string;
  lastPrice: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number | null;
  volume: number;
  averageVolume: number | null;
  vwap: number | null;
  bid: number | null;
  ask: number | null;
  peRatio: number | null;
  week52High: number | null;
  week52Low: number | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read the fields enrichment derives from, off either
 *  normalized quote shape (the feed seam's structural-read
 *  idiom — the shapes are the providers' own, never converted). */
export function extractQuoteFields(quote: QuoteResult): QuoteFields | null {
  const q = quote as unknown as Record<string, unknown>;
  const symbol = typeof q.symbol === "string" ? q.symbol.toUpperCase().trim() : "";
  const lastPrice = num(q.lastPrice) ?? num(q.price);
  if (!symbol || lastPrice === null) return null;
  return {
    symbol,
    lastPrice,
    changePercent: num(q.changePercent) ?? 0,
    open: num(q.open) ?? lastPrice,
    high: num(q.high) ?? lastPrice,
    low: num(q.low) ?? lastPrice,
    previousClose: num(q.previousClose),
    volume: num(q.volume) ?? 0,
    averageVolume: num(q.averageVolume),
    vwap: num(q.vwap),
    bid: num(q.bid),
    ask: num(q.ask),
    peRatio: num(q.peRatio) ?? num(q.trailingPE),
    week52High: num(q.week52High) ?? num(q.high52),
    week52Low: num(q.week52Low) ?? num(q.low52),
  };
}

/* ------------------------------------------------------------------ */
/* The computation (pure: persisted artifacts in, enriched rows out)   */
/* ------------------------------------------------------------------ */

export interface EnrichComputationInput {
  /** The persisted input artifact (the feed job's own copy). */
  inputArtifact: FeedDatasetArtifact;
  /** The input bucket's run history, newest first — the
   *  snapshot series the series elements compute over. */
  seriesArtifacts: readonly FeedDatasetArtifact[];
  /** Join artifacts by feed job id (absent ⇒ the join dataset
   *  has no usable persisted copy). */
  joinArtifacts: ReadonlyMap<string, FeedDatasetArtifact>;
  /** The elements to compute (validated configuration). */
  elements: readonly string[];
  /** The snapshot-series window for sma / bollinger. Default 5. */
  seriesPeriod?: number;
  /** The enrich job's join configuration (for gap attribution). */
  enrichFrom: readonly EnrichJoinSource[];
}

export interface EnrichComputation {
  rows: EnrichedDatasetArtifact["rows"];
  gaps: EnrichedElementGap[];
  elementCoverage: EnrichedDatasetArtifact["elementCoverage"];
  /** Symbols the join datasets did not carry (partial signal). */
  joinMissingSymbols: string[];
  /** True when a configured join dataset had no usable copy. */
  joinDatasetMissing: boolean;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

export function computeEnrichment(input: EnrichComputationInput): EnrichComputation {
  const period =
    input.seriesPeriod && Number.isInteger(input.seriesPeriod) && input.seriesPeriod > 1
      ? input.seriesPeriod
      : 5;
  const elements = validateEnrichElements(input.elements);
  const gaps: EnrichedElementGap[] = [];
  const coverage: EnrichComputation["elementCoverage"] = {};
  for (const element of elements) coverage[element] = { computed: 0, unavailable: 0 };

  // History elements are unavailable for the whole artifact —
  // one gap entry, not one per symbol.
  for (const element of elements) {
    if (HISTORY_SET.has(element)) {
      gaps.push({
        element,
        reason: ENRICH_GAP_REASONS.requiresDailyBarHistory,
        symbols: [],
      });
    }
  }

  // Fundamentals join maps, per join source.
  const joinRows = new Map<string, Map<string, Record<string, unknown>>>();
  let joinDatasetMissing = false;
  for (const source of input.enrichFrom) {
    const artifact = input.joinArtifacts.get(source.feedJobId);
    if (!artifact) {
      joinDatasetMissing = true;
      continue;
    }
    const bySymbol = new Map<string, Record<string, unknown>>();
    for (const row of artifact.fundamentals ?? []) {
      bySymbol.set(row.symbol.toUpperCase(), row.fundamentals as unknown as Record<string, unknown>);
    }
    joinRows.set(source.feedJobId, bySymbol);
  }
  const wantsFundamentals = elements.some((e) => FUNDAMENTALS_SET.has(e));
  if (wantsFundamentals && input.enrichFrom.length > 0 && joinDatasetMissing) {
    for (const element of elements) {
      if (!FUNDAMENTALS_SET.has(element)) continue;
      gaps.push({ element, reason: ENRICH_GAP_REASONS.joinDatasetMissing, symbols: [] });
    }
  }

  // Snapshot series closes per symbol, chronological.
  const seriesCloses = new Map<string, number[]>();
  if (elements.some((e) => SERIES_SET.has(e))) {
    const chronological = [...input.seriesArtifacts].reverse();
    for (const artifact of chronological) {
      for (const quote of artifact.quotes) {
        const fields = extractQuoteFields(quote);
        if (!fields) continue;
        const list = seriesCloses.get(fields.symbol) ?? [];
        list.push(fields.lastPrice);
        seriesCloses.set(fields.symbol, list);
      }
    }
  }

  const rows: EnrichedDatasetArtifact["rows"] = [];
  const joinMissing = new Set<string>();
  const gapSymbols = new Map<string, Set<string>>(); // `${element}|${reason}` -> symbols
  const noteGap = (element: string, reason: string, symbol: string) => {
    const key = `${element}|${reason}`;
    const set = gapSymbols.get(key) ?? new Set<string>();
    set.add(symbol);
    gapSymbols.set(key, set);
  };

  for (const quote of input.inputArtifact.quotes) {
    const fields = extractQuoteFields(quote);
    if (!fields) continue;
    const features: Record<string, number | string> = {};
    const unavailable: string[] = [];
    const mark = (element: string, ok: boolean, reason?: string) => {
      coverage[element][ok ? "computed" : "unavailable"]++;
      if (!ok) {
        unavailable.push(element);
        if (reason) noteGap(element, reason, fields.symbol);
      }
    };
    const setNum = (element: string, feature: string, value: number | null, reason?: string) => {
      if (value === null || !Number.isFinite(value)) {
        mark(element, false, reason ?? ENRICH_GAP_REASONS.fieldNotInSnapshot);
      } else {
        features[feature] = round6(value);
        mark(element, true);
      }
    };

    for (const element of elements) {
      if (HISTORY_SET.has(element)) {
        coverage[element].unavailable++;
        unavailable.push(element);
        continue;
      }
      if (FUNDAMENTALS_SET.has(element)) continue; // handled in the join pass below
      if (SERIES_SET.has(element)) continue; // handled in the series pass below
      switch (element) {
        case "momentum":
          setNum(element, "momentum", fields.changePercent);
          break;
        case "intradayPosition":
          setNum(
            element,
            "intradayPosition",
            fields.high > fields.low
              ? Math.min(1, Math.max(0, (fields.lastPrice - fields.low) / (fields.high - fields.low)))
              : null,
          );
          break;
        case "dayRangePercent":
          setNum(
            element,
            "dayRangePercent",
            fields.previousClose && fields.previousClose > 0
              ? ((fields.high - fields.low) / fields.previousClose) * 100
              : null,
          );
          break;
        case "gapPercent":
          setNum(
            element,
            "gapPercent",
            fields.previousClose && fields.previousClose > 0
              ? ((fields.open - fields.previousClose) / fields.previousClose) * 100
              : null,
          );
          break;
        case "relativeVolume":
          setNum(
            element,
            "relativeVolume",
            fields.averageVolume && fields.averageVolume > 0
              ? fields.volume / fields.averageVolume
              : null,
          );
          break;
        case "vwapDeviationPercent":
          setNum(
            element,
            "vwapDeviationPercent",
            fields.vwap && fields.vwap > 0
              ? ((fields.lastPrice - fields.vwap) / fields.vwap) * 100
              : null,
          );
          break;
        case "spreadPercent": {
          const mid =
            fields.bid !== null && fields.ask !== null ? (fields.bid + fields.ask) / 2 : null;
          setNum(
            element,
            "spreadPercent",
            mid && mid > 0 && fields.bid !== null && fields.ask !== null
              ? ((fields.ask - fields.bid) / mid) * 100
              : null,
          );
          break;
        }
        case "rangePosition52w":
          setNum(
            element,
            "rangePosition52w",
            fields.week52High !== null &&
              fields.week52Low !== null &&
              fields.week52High > fields.week52Low
              ? Math.min(
                  1,
                  Math.max(
                    0,
                    (fields.lastPrice - fields.week52Low) /
                      (fields.week52High - fields.week52Low),
                  ),
                )
              : null,
          );
          break;
        case "sentiment":
        case "rangeZone":
        case "valueZone":
        case "screenScore": {
          const indicators: ScreeningIndicators = computeScreeningIndicators({
            lastPrice: fields.lastPrice,
            changePercent: fields.changePercent,
            open: fields.open,
            high: fields.high,
            low: fields.low,
            week52High: fields.week52High ?? 0,
            week52Low: fields.week52Low ?? 0,
            peRatio: fields.peRatio ?? undefined,
            volume: fields.volume,
            averageVolume: fields.averageVolume ?? undefined,
          });
          const value =
            element === "sentiment"
              ? indicators.sentiment
              : element === "rangeZone"
                ? indicators.rangeZone
                : element === "valueZone"
                  ? indicators.valueZone
                  : indicators.screenScore;
          if (typeof value === "number") features[element] = round6(value);
          else features[element] = value;
          mark(element, true);
          break;
        }
        default:
          // validateEnrichElements already refused unknown names;
          // reaching here means a vocabulary group was missed.
          mark(element, false, ENRICH_GAP_REASONS.fieldNotInSnapshot);
      }
    }

    // Series pass (over the persisted snapshot series).
    for (const element of elements) {
      if (!SERIES_SET.has(element)) continue;
      const closes = seriesCloses.get(fields.symbol) ?? [];
      if (element === "sma") {
        const sma = computeSma(closes, period);
        if (sma === null) {
          mark(element, false, ENRICH_GAP_REASONS.insufficientSnapshotSeries);
        } else {
          features.sma = round6(sma);
          mark(element, true);
        }
      } else {
        const bands = computeBollingerBands(closes, period, 2);
        if (bands === null) {
          mark(element, false, ENRICH_GAP_REASONS.insufficientSnapshotSeries);
        } else {
          features.bollingerMiddle = round6(bands.middle);
          features.bollingerUpper = round6(bands.upper);
          features.bollingerLower = round6(bands.lower);
          features.bollingerPercentB = round6(bands.percentB);
          features.bollingerBandwidth = round6(bands.bandwidth);
          mark(element, true);
        }
      }
    }

    // Fundamentals join pass.
    if (wantsFundamentals) {
      let joined: Record<string, unknown> | undefined;
      for (const source of input.enrichFrom) {
        joined = joinRows.get(source.feedJobId)?.get(fields.symbol);
        if (joined) break;
      }
      for (const element of elements) {
        if (!FUNDAMENTALS_SET.has(element)) continue;
        if (!joined) {
          coverage[element].unavailable++;
          unavailable.push(element);
          joinMissing.add(fields.symbol);
          noteGap(
            element,
            joinDatasetMissing
              ? ENRICH_GAP_REASONS.joinDatasetMissing
              : ENRICH_GAP_REASONS.symbolNotInJoinDataset,
            fields.symbol,
          );
          continue;
        }
        const raw =
          element === "analystUpsidePercent"
            ? (() => {
                const target = num(joined.targetMeanPrice);
                return target !== null && fields.lastPrice > 0
                  ? ((target - fields.lastPrice) / fields.lastPrice) * 100
                  : null;
              })()
            : element === "recommendationKey"
              ? typeof joined.recommendationKey === "string"
                ? joined.recommendationKey
                : null
              : num(joined[element]);
        if (raw === null) {
          coverage[element].unavailable++;
          unavailable.push(element);
          noteGap(element, ENRICH_GAP_REASONS.fieldNotInSnapshot, fields.symbol);
        } else {
          features[element] = typeof raw === "number" ? round6(raw) : raw;
          coverage[element].computed++;
        }
      }
    }

    rows.push({
      symbol: fields.symbol,
      lastPrice: fields.lastPrice,
      features,
      unavailable: [...new Set(unavailable)],
    });
  }

  for (const [key, symbols] of gapSymbols) {
    const [element, reason] = key.split("|");
    gaps.push({ element, reason, symbols: [...symbols].sort() });
  }

  return {
    rows,
    gaps,
    elementCoverage: coverage,
    joinMissingSymbols: [...joinMissing].sort(),
    joinDatasetMissing,
  };
}

/* ------------------------------------------------------------------ */
/* Input resolution — the persisted copy, by the producing job's id    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the newest USABLE artifact a feed job produced: the
 * (source, dataset) bucket's history filtered to that job's own
 * artifacts — exact lineage, so a sibling job sharing the
 * bucket (Yahoo's two universes) is never silently substituted.
 * #3930: a universe index narrows the match to that universe's
 * copy — required now that ONE parameterized job persists a
 * copy per universe into the same bucket; without it an enrich
 * job could join another universe's dataset (values for the
 * overlapping symbols, silent gaps for the rest).
 */
export async function resolveFeedInputArtifact(
  store: FeedDatasetStore,
  feedJobId: string,
  sourceId: DataProviderId,
  dataset: string,
  universeIndex?: IndexId,
): Promise<FeedDatasetArtifact | undefined> {
  const history = await store.listRuns(sourceId, dataset, 10);
  return history.find(
    (a) =>
      a.jobId === feedJobId &&
      a.run.status !== "failed" &&
      feedDatasetRowCount(a) > 0 &&
      (universeIndex === undefined || a.universe.index === universeIndex),
  );
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface EnrichJobDeps {
  /** The feed-dataset store (the input copies). */
  datasetStore: FeedDatasetStore;
  /** The enriched-dataset store (this stage's persisted output). */
  enrichedStore: EnrichedDatasetStore;
}

export interface RunEnrichJobOptions {
  trigger?: "manual" | "scheduled";
  /** The run id to record under (the pipeline engine's run id,
   *  when dispatched through the plane — one run, one id). */
  runId?: string;
  /** Injectable clock (tests); defaults to now. */
  nowMs?: number;
  /** Element override (the pipeline definition's configured
   *  params win over the registry defaults). */
  elements?: readonly string[];
  /** Join-source override (configuration, same rule). */
  enrichFrom?: readonly EnrichJoinSource[];
  /** Snapshot-series window override (configuration). */
  seriesPeriod?: number;
  /** Shard partition: enrich only these symbols of the input
   *  artifact (the plane's sharded shape — one unit per
   *  partition, each persisting its own artifact). */
  symbols?: readonly string[];
}

export interface EnrichRunResult {
  jobId: string;
  runId: string;
  status: "completed" | "partial" | "failed";
  artifactId: string | null;
  /** Symbols the run set out to enrich. */
  requested: number;
  /** Symbols enriched. */
  received: number;
  failed: number;
  codedError: string | null;
  errorMessage: string | null;
  /** The input artifact consumed (lineage), when one was. */
  inputArtifactId: string | null;
  inputRunId: string | null;
  elementCoverage: EnrichedDatasetArtifact["elementCoverage"];
}

/**
 * Run one enrich job: resolve the persisted input, compute,
 * persist the enriched artifact. Outcomes are RETURNED (the
 * failed-input run is recorded first); only an unknown job id
 * throws (a caller bug, the #3530 idiom).
 */
export async function runEnrichJob(
  registry: EnrichJobRegistry,
  deps: EnrichJobDeps,
  jobId: string,
  opts: RunEnrichJobOptions = {},
): Promise<EnrichRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new EnrichJobError(
      ENRICH_JOB_CODES.jobNotFound,
      `Enrich job "${jobId}" is not registered.`,
    );
  }
  const startedMs = opts.nowMs ?? Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = opts.runId ?? `enrich-run-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";
  const elements = validateEnrichElements(opts.elements ?? def.elements);
  const enrichFrom = opts.enrichFrom ?? def.enrichFrom;

  const finish = async (
    partial: Omit<
      EnrichRunResult,
      "jobId" | "runId" | "artifactId" | "inputArtifactId" | "inputRunId"
    > & {
      rows: EnrichedDatasetArtifact["rows"];
      gaps: EnrichedElementGap[];
      inputArtifact: FeedDatasetArtifact | undefined;
    },
  ): Promise<EnrichRunResult> => {
    const finishedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
    const artifact = await deps.enrichedStore.store({
      jobId: def.id,
      feedJobId: def.feedJobId,
      sourceId: def.sourceId,
      dataset: def.dataset,
      universe: partial.inputArtifact?.universe ?? {
        kind: "index",
        index: def.universe.index,
        label: def.universe.label,
        snapshotDate: null,
        sourceLabel: null,
        size: 0,
      },
      inputArtifactId: partial.inputArtifact?.id ?? "",
      inputRunId: partial.inputArtifact?.run.runId ?? "",
      inputAsOf: partial.inputArtifact?.asOf ?? "",
      elements,
      gaps: partial.gaps,
      elementCoverage: partial.elementCoverage,
      rows: partial.rows,
      run: {
        runId,
        trigger,
        startedAt,
        finishedAt,
        status: partial.status,
        requested: partial.requested,
        received: partial.received,
        failed: partial.failed,
        missingSymbols: partial.inputArtifact
          ? partial.inputArtifact.run.missingSymbols
          : [],
        codedError: partial.codedError,
        errorMessage: partial.errorMessage,
      },
      nowIso: finishedAt,
    });
    if (partial.status === "failed") {
      structuredLog.warn(ENRICH_JOB_RUN_FAILED, {
        message: `[enrichJobs] ${partial.codedError ?? "ENRICH_RUN_FAILED"}: enrich job "${def.id}" run ${runId} failed (${partial.errorMessage ?? "no detail"})`,
        jobId: def.id,
        runId,
        codedError: partial.codedError,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: partial.status,
      artifactId: artifact.id,
      requested: partial.requested,
      received: partial.received,
      failed: partial.failed,
      codedError: partial.codedError,
      errorMessage: partial.errorMessage,
      inputArtifactId: partial.inputArtifact?.id ?? null,
      inputRunId: partial.inputArtifact?.run.runId ?? null,
      elementCoverage: partial.elementCoverage,
    };
  };

  const inputArtifact = await resolveFeedInputArtifact(
    deps.datasetStore,
    def.feedJobId,
    def.sourceId,
    def.dataset,
  );
  if (!inputArtifact) {
    return finish({
      status: "failed",
      requested: 0,
      received: 0,
      failed: 0,
      codedError: ENRICH_JOB_CODES.inputMissing,
      errorMessage: scrubFailureMessage(
        `No usable persisted dataset for feed job "${def.feedJobId}" (${def.sourceId}/${def.dataset}): the enrich run was refused rather than fetching live or enriching a sibling job's copy.`,
      ),
      rows: [],
      gaps: [],
      elementCoverage: Object.fromEntries(
        elements.map((e) => [e, { computed: 0, unavailable: 0 }]),
      ),
      inputArtifact: undefined,
    });
  }

  // The snapshot series: the input bucket's history (the same
  // read that resolved the input — reads never fetch).
  const seriesArtifacts = await deps.datasetStore.listRuns(
    def.sourceId,
    def.dataset,
    10,
  );
  const joinArtifacts = new Map<string, FeedDatasetArtifact>();
  for (const source of enrichFrom) {
    const join = await resolveFeedInputArtifact(
      deps.datasetStore,
      source.feedJobId,
      source.sourceId,
      source.dataset,
      // #3930: the join reads the dataset copy for the enrich
      // job's universe (the source names it explicitly, else
      // the enrich job's own universe) — never the bucket's
      // newest copy, which may belong to another universe.
      source.universe ?? def.universe.index,
    );
    if (join) joinArtifacts.set(source.feedJobId, join);
  }

  // A sharded unit enriches its partition of the input only
  // (the artifact it persists carries that partition's rows;
  // its lineage still names the whole input artifact).
  const effectiveInput = opts.symbols
    ? {
        ...inputArtifact,
        quotes: inputArtifact.quotes.filter((q) => {
          const symbol = (q as { symbol?: unknown }).symbol;
          return (
            typeof symbol === "string" &&
            opts.symbols!.some((s) => s.toUpperCase() === symbol.toUpperCase())
          );
        }),
      }
    : inputArtifact;

  const computation = computeEnrichment({
    inputArtifact: effectiveInput,
    seriesArtifacts: seriesArtifacts.filter((a) => a.jobId === def.feedJobId),
    joinArtifacts,
    elements,
    seriesPeriod: opts.seriesPeriod,
    enrichFrom,
  });

  const requested = effectiveInput.quotes.length;
  const received = computation.rows.length;
  const status =
    computation.joinDatasetMissing || computation.joinMissingSymbols.length > 0
      ? "partial"
      : "completed";
  return finish({
    status,
    requested,
    received,
    failed: requested - received,
    codedError: null,
    errorMessage: null,
    rows: computation.rows,
    gaps: computation.gaps,
    elementCoverage: computation.elementCoverage,
    inputArtifact,
  });
}

/* ------------------------------------------------------------------ */
/* Status — what the UX renders (one source of truth: the store)       */
/* ------------------------------------------------------------------ */

export interface EnrichStatusView {
  jobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  elements: string[];
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: EnrichedDatasetArtifact["run"] | null;
  /** Recent run history, newest first. */
  history: EnrichedDatasetArtifact["run"][];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    rowsPersisted: number;
    stale: boolean;
    /** Lineage: the feed artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    elements: string[];
  } | null;
}

export async function buildEnrichStatus(
  store: EnrichedDatasetStore,
  def: EnrichJobDefinition,
  nowMs: number,
): Promise<EnrichStatusView> {
  const [latest, usable, runArtifacts] = await Promise.all([
    store.latest(def.id),
    store.latestUsable(def.id),
    store.listRuns(def.id, 5),
  ]);
  const base: EnrichStatusView = {
    jobId: def.id,
    feedJobId: def.feedJobId,
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
  const asOfMs = Date.parse(usable.createdAt);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
  return {
    ...base,
    snapshot: {
      artifactId: usable.id,
      asOf: usable.createdAt,
      ageSeconds,
      rowsPersisted: usable.rows.length,
      stale: ageSeconds > def.staleAfterMinutes * 60,
      inputArtifactId: usable.inputArtifactId,
      inputRunId: usable.inputRunId,
      inputAsOf: usable.inputAsOf,
      elements: [...usable.elements],
    },
  };
}
