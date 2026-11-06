/**
 * Issue #1888: enrichment service — deterministic provider fetch,
 * bar mapping, coverage accounting, fallback rules, killswitch
 * predicate. No agent judgment in this path; calibration judgment
 * stays in #1742's governed pattern with human approval.
 *
 * Consumed, not duplicated: the Yahoo and Alpaca provider
 * implementations behind `EnrichmentMarketData` (breaker-wrapped
 * by their own wiring, #1745), the feature-flag port (#1815), the
 * observability stream (#1743, via the injected emit sink), and
 * #1739 CloudEvents envelopes (built in enrichmentPorts).
 *
 * Honest Alpaca limitation: Alpaca exposes no live fundamentals,
 * so fundamentals ALWAYS come from Yahoo — in Alpaca mode as a
 * documented by-design coverage, never faked, and never counted
 * as a failure fallback. A primary quote/bar failure in
 * Alpaca-fallback mode retries Yahoo; a symbol whose providers
 * all fail is a qualified partial, never a thrown run.
 */

import {
  computeCoverage,
  DAILY_TIMEFRAME,
  DEFAULT_MINUTE_TIMEFRAME,
  enrichmentLoopStopped,
  resolveEnrichmentSelection,
  resolveMinuteTimeframe,
  toEnrichmentCompletedEnvelope,
  type BreakerStateView,
  type EnrichmentBar,
  type EnrichmentRunRecord,
  type EnrichmentRunStore,
  type EnrichmentSymbolResult,
} from "./enrichmentPorts";
import type { MessageEnvelope } from "../messaging/messagingPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "enrichment/enrichmentService",
});

/**
 * Neutral market-data port: the boundary adapter in the route
 * module maps the existing Yahoo/Alpaca providers onto this shape,
 * so this service never names a provider implementation.
 */
export interface EnrichmentMarketData {
  isAlpacaConfigured(): boolean;
  getQuote(
    symbol: string,
    provider: "yahoo" | "alpaca",
  ): Promise<{ ok: boolean }>;
  getFundamentals(
    symbol: string,
    provider: "yahoo" | "alpaca",
  ): Promise<{ ok: boolean }>;
  getBars(
    symbol: string,
    provider: "yahoo" | "alpaca",
    timeframe: string,
    limit: number,
  ): Promise<EnrichmentBar[]>;
}

export interface RunEnrichmentInput {
  jobId: string;
  stage: "feed" | "gather";
  symbols: string[];
  minuteTimeframe?: string;
  marketData: EnrichmentMarketData;
  /** Evaluated `enrichment_alpaca` flag value (caller reads the port). */
  alpacaFlagOn: boolean;
  killswitchThrown: boolean;
  globalHalted: boolean;
  store?: EnrichmentRunStore;
  breakerSnapshots?: () => BreakerStateView[];
  /** Best-effort stream emission; failures swallowed, never thrown. */
  emit?: (envelope: MessageEnvelope) => void | Promise<void>;
  nowMs?: () => number;
}

function cleanSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of symbols) {
    const s = raw.trim().toUpperCase();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export async function runEnrichment(
  input: RunEnrichmentInput,
): Promise<EnrichmentRunRecord> {
  const nowMs = input.nowMs ?? Date.now;
  const atMs = nowMs();
  const createdAt = new Date(atMs).toISOString();
  const selection = resolveEnrichmentSelection({
    alpacaFlagOn: input.alpacaFlagOn,
    alpacaConfigured: input.marketData.isAlpacaConfigured(),
  });
  const breakerState = input.breakerSnapshots ? input.breakerSnapshots() : [];

  const stopped = enrichmentLoopStopped({
    killswitchThrown: input.killswitchThrown,
    globalHalted: input.globalHalted,
  });
  const symbols = cleanSymbols(input.symbols);
  if (symbols.length === 0) {
    throw new Error("runEnrichment requires at least one symbol");
  }

  const minuteTimeframe = input.minuteTimeframe ?? DEFAULT_MINUTE_TIMEFRAME;
  const minute = resolveMinuteTimeframe(selection.primary, minuteTimeframe);
  if (!minute.supported) {
    // Explicit before any fetch — never silently serve daily bars
    // for a minute request.
    throw new Error(minute.error);
  }

  const base: Omit<EnrichmentRunRecord, "symbolsServed" | "barsFetched" | "dailyBars" | "minuteBars" | "fallbacks" | "errors" | "partial" | "results"> = {
    id: `enr-${input.jobId}-${atMs}`,
    jobId: input.jobId,
    stage: input.stage,
    provider: selection.primary,
    mode: selection.mode,
    minuteTimeframe,
    symbolsRequested: symbols.length,
    stopped,
    breakerState,
    killswitchState: input.killswitchThrown ? "halted" : "clear",
    createdAt,
  };

  if (stopped) {
    // Stopped attempts are recorded, never fetched: the record is
    // evidence, not an enrichment run.
    const record: EnrichmentRunRecord = {
      ...base,
      symbolsServed: 0,
      barsFetched: 0,
      dailyBars: 0,
      minuteBars: 0,
      fallbacks: 0,
      errors: [],
      partial: false,
      stopReason: input.killswitchThrown
        ? "enrichment killswitch thrown"
        : "global halt thrown",
      results: [],
    };
    await emitBestEffort(input.emit, toEnrichmentCompletedEnvelope(record));
    if (input.store) await input.store.recordRun(record);
    return record;
  }

  const { primary, fallback } = selection;
  let fallbacks = 0;
  const results: EnrichmentSymbolResult[] = [];
  const errors: string[] = [];

  // One fallback attempt per failed fetch; a fetch that succeeds on
  // the fallback counts once. No retries beyond the provider pair:
  // the underlying providers already carry #1745 breaker budgets.
  async function fetchWithFallback<T>(
    kind: string,
    symbol: string,
    fn: (provider: "yahoo" | "alpaca") => Promise<T>,
  ): Promise<{ value: T | null; provider: "yahoo" | "alpaca" | null; fallbackUsed: boolean }> {
    try {
      return { value: await fn(primary), provider: primary, fallbackUsed: false };
    } catch (primaryErr) {
      if (!fallback) {
        errors.push(`${primary}: ${symbol} ${kind} failed`);
        return { value: null, provider: null, fallbackUsed: false };
      }
      try {
        const value = await fn(fallback);
        fallbacks += 1;
        return { value, provider: fallback, fallbackUsed: true };
      } catch {
        errors.push(
          `${primary}+${fallback}: ${symbol} ${kind} failed (${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)})`,
        );
        return { value: null, provider: null, fallbackUsed: false };
      }
    }
  }

  for (const symbol of symbols) {
    const quote = await fetchWithFallback("quote", symbol, (p) =>
      input.marketData.getQuote(symbol, p),
    );
    const daily = await fetchWithFallback("daily bars", symbol, (p) =>
      input.marketData.getBars(symbol, p, DAILY_TIMEFRAME, 30),
    );
    const minuteBars = await fetchWithFallback("minute bars", symbol, (p) =>
      input.marketData.getBars(symbol, p, minuteTimeframe, 30),
    );
    // Fundamentals are Yahoo-only by provider capability (Alpaca
    // has no live fundamentals): by-design coverage, not a fallback.
    let fundamentals = false;
    try {
      const f = await input.marketData.getFundamentals(symbol, "yahoo");
      fundamentals = f.ok;
    } catch {
      errors.push(`yahoo: ${symbol} fundamentals failed`);
    }
    const dailyCount = daily.value ? daily.value.length : 0;
    const minuteCount = minuteBars.value ? minuteBars.value.length : 0;
    const served =
      quote.value !== null && dailyCount > 0 && minuteCount > 0;
    const complete = served && fundamentals;
    const fallbackUsed =
      quote.fallbackUsed || daily.fallbackUsed || minuteBars.fallbackUsed;
    results.push({
      symbol,
      served,
      complete,
      quote: quote.value !== null,
      fundamentals,
      fundamentalsProvider: fundamentals ? "yahoo" : null,
      dailyBars: dailyCount,
      minuteBars: minuteCount,
      provider: quote.provider ?? daily.provider ?? minuteBars.provider,
      fallbackUsed,
      ...(served ? {} : { error: `${symbol} not fully served` }),
    });
  }

  const symbolsServed = results.filter((r) => r.served).length;
  const dailyBars = results.reduce((n, r) => n + r.dailyBars, 0);
  const minuteBars = results.reduce((n, r) => n + r.minuteBars, 0);
  const coverage = computeCoverage(symbols.length, symbolsServed);

  const record: EnrichmentRunRecord = {
    ...base,
    symbolsServed,
    barsFetched: dailyBars + minuteBars,
    dailyBars,
    minuteBars,
    fallbacks,
    errors,
    partial: coverage.partial || results.some((r) => !r.complete),
    results,
  };
  await emitBestEffort(input.emit, toEnrichmentCompletedEnvelope(record));
  if (input.store) await input.store.recordRun(record);
  return record;
}

async function emitBestEffort(
  emit: RunEnrichmentInput["emit"],
  envelope: MessageEnvelope,
): Promise<void> {
  if (!emit) return;
  try {
    await emit(envelope);
  } catch (err) {
    structuredLog.warn("enrichment.event_emission_failed", {
      message: "[Enrichment] Event emission failed (ignored)",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
