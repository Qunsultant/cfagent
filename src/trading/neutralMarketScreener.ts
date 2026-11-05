/**
 * Issue #3272 (catalogue): the neutral stock screener behind the provider table.
 *
 * Why it exists: `SCREENING_PROVIDER_DESCRIPTORS` must equal what
 * `createDefaultScreeningRegistry` builds — a descriptor without a registered
 * provider is the unpaid claim that pin rejects. The neutral screen existed as
 * a route but had no `IMarketScreener`, because `screenMarkets(filter)` could
 * not say which universe to scan. `StockScreenerFilter.universe` fixes that.
 *
 * It then does exactly what the route does: resolve the universe through the
 * live listings feed, quote it through the selected broker, and run the
 * unchanged `screenWithQuotes` evaluator.
 *
 * Honest refusals, never empty successes:
 *   - no quote source → `no_universe` with a named reason;
 *   - a failed listings feed → the same, with the upstream reason;
 *   - an over-cap universe is scanned partially, and the filter summary says so.
 */
import type { StockScreenerFilter, StockScreenResult } from "../types";
import type { IMarketScreener } from "./interfaces";
import { resolveUniverseSymbols, screenSymbolsWithSource, type StockQuoteSource } from "./stockQuoteSource";

export interface NeutralMarketScreenerDeps {
  /** Null when no broker selection is available to this run. */
  quoteSource?: StockQuoteSource | null;
  /** Bounded quote reads per scan (subrequest safety). */
  maxSymbols?: number;
}

export const NEUTRAL_SCREEN_MAX_SYMBOLS = 25;

export class NeutralMarketScreener implements IMarketScreener {
  constructor(private readonly deps: NeutralMarketScreenerDeps = {}) {}

  private refusal(filter: StockScreenerFilter, reason: string): StockScreenResult {
    return {
      totalScanned: 0,
      totalScreened: 0,
      matchedCount: 0,
      filterApplied: filter,
      filterSummary: reason,
      stocks: [],
      scannedAt: new Date().toISOString(),
      status: "no_universe",
      validationError: reason,
    };
  }

  async screenMarkets(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    const source = this.deps.quoteSource;
    if (!source) {
      return this.refusal(
        filter,
        "No broker quote source is available for this run; the neutral stock screen needs a selected broker.",
      );
    }

    const universe =
      typeof filter.universe === "string" && filter.universe.trim() ? filter.universe.trim().toUpperCase() : "NASDAQ100";
    const cap = this.deps.maxSymbols ?? NEUTRAL_SCREEN_MAX_SYMBOLS;

    let resolved: { symbols: string[]; universeSize: number; truncated: boolean };
    try {
      resolved = await resolveUniverseSymbols(universe, cap);
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : "the listings feed failed";
      return this.refusal(
        filter,
        `The ${universe} universe could not be resolved (${reason}). No curated table is substituted.`,
      );
    }
    if (resolved.symbols.length === 0) {
      return this.refusal(filter, `The ${universe} universe resolved to no symbols.`);
    }

    const { result } = await screenSymbolsWithSource(source, resolved.symbols, filter);
    // The universe slice is part of the provenance, not a silent cap.
    const slice = resolved.truncated
      ? `universe ${universe}: ${resolved.symbols.length} of ${resolved.universeSize} scanned (bounded)`
      : `universe ${universe}: all ${resolved.universeSize} scanned`;
    return { ...result, filterSummary: `${result.filterSummary} · ${slice}` };
  }
}
