/**
 * Issue #319 — research data provider backed by platform capabilities.
 *
 * Composes (never re-implements): E*TRADE quotes/chains (the platform
 * contract, resolved through TradingPlatformRegistry — #291 Q2),
 * Nasdaq listings + universe resolution (src/trading), Yahoo technicals
 * (src/trading), and model-calibrated chains as an explicitly-labeled
 * fallback. All trading imports go through src/trading/index.ts (boundary).
 *
 * Honesty rules enforced here:
 * - E*TRADE quote marketCap arrives in $B (client divides by 1e9); it is
 *   converted back to dollars for the pipeline's $5B filter.
 * - Chains the broker cannot serve are labeled `calibrated` (synthetic) —
 *   the quote-quality gate only ever lets `live` chains produce Qualified
 *   ideas. Calibrated chains are never presented as executable quotes.
 * - Catalysts: wired to the platform event calendar (`eventCalendar.ts`);
 *   returns `null` when uncovered so the pipeline flags the limitation
 *   instead of treating failed retrieval as "no event".
 *
 * READ-ONLY: no order functions are imported or called.
 */

import {
  normalizeResearchUniverseId,
  researchUniverseIds,
  ResearchUniverseRefusal,
  resolveUniverse,
  fetchPlatformTechnicalsBatch,
  buildCalibratedOptionChains,
  TradingPlatformRegistry,
  fetchQuoteLiveStrict,
  type ITradingPlatform,
  type NasdaqUniverseDeps,
  type YahooHistoryDeps,
  type TradingPlatformId,
  type DataProviderId,
  type OptionChainSource,
} from "../trading";
import { resolveResearchVenue, type ResearchVenue } from "./researchVenue";
import { isDemoCalibratedChainsEnabled } from "../config/demoMode";
import type { Env, ETradeOptionChain } from "../types";
import type { NasdaqStockListing } from "./nasdaqListings";
import type {
  ResearchDataProvider,
  QuoteSnapshot,
  ChainSnapshot,
  Technicals,
  CatalystInfo,
  RegimeAssessment,
  ProviderChainLeg,
  ProviderChainExpiry,
} from "./researchPipeline";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { getSymbolEventCalendar } from "./eventCalendar";
import {
  createDatasetOptionChainSource,
  readPersistedOptionsChains,
  type PersistedOptionsChainsRead,
} from "./feedOptionsChainSource";
import type { FeedDatasetStore, FeedOptionsChainRow } from "../data/feedDatasetPorts";
import { RESEARCH_CONFIG_DEFAULTS, type ResearchConfig } from "./researchConfig";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/researchProviders",
});


function isEtfSymbol(symbol: string, companyName: string): boolean {
  const haystack = `${companyName} ${symbol}`.toUpperCase();
  return (
    haystack.includes("ETF") ||
    haystack.includes("EXCHANGE TRADED") ||
    haystack.includes("INDEX FUND")
  );
}

function dteOf(year: number, month: number, day: number, now: number): number {
  const expiry = Date.UTC(year, month - 1, day, 21, 0, 0);
  return Math.max(0, Math.round((expiry - now) / 86_400_000));
}

type ResearchChainRules = Pick<ResearchConfig,
  | "nearExpiryMinDte"
  | "nearExpiryMaxDte"
  | "leapsExpiryMinDte"
  | "maxExpiriesPerBand"
  | "calibratedNearMaxDte"
  | "calibratedLeapsMaxDte"
>;

function toProviderLeg(
  optionType: "call" | "put",
  contract: {
    strikePrice: number;
    bid: number;
    ask: number;
    impliedVolatility?: number;
    volume?: number;
    openInterest?: number;
  },
  expiryIso: string,
  dte: number,
  asOf: number
): ProviderChainLeg {
  return {
    optionType,
    strike: contract.strikePrice,
    expiry: expiryIso,
    dte,
    bid: contract.bid,
    ask: contract.ask,
    iv:
      typeof contract.impliedVolatility === "number"
        ? contract.impliedVolatility / 100 > 5
          ? contract.impliedVolatility / 100
          : contract.impliedVolatility
        : null,
    volume: contract.volume ?? null,
    openInterest: contract.openInterest ?? null,
  };
}

function chainToSnapshot(
  symbol: string,
  chain: ETradeOptionChain,
  expiryIso: string,
  dte: number,
  asOf: number,
  provenance: ChainSnapshot["provenance"]
): ProviderChainExpiry {
  const legs: ProviderChainLeg[] = [];
  for (const pair of chain.pairs ?? []) {
    if (pair.call) {
      legs.push(
        toProviderLeg("call", pair.call, expiryIso, dte, asOf)
      );
    }
    if (pair.put) {
      legs.push(
        toProviderLeg("put", pair.put, expiryIso, dte, asOf)
      );
    }
  }
  return { expiry: expiryIso, dte, legs };
}

/**
 * Issue #5912 — the research data provider over whichever trading platform
 * the run selected. The platform seam was always generic (`ITradingPlatform`);
 * only the resolution was hardcoded, so the name is kept and the selection
 * is a constructor option: unset resolves the configured default, as before.
 */
export class EtradeResearchDataProvider implements ResearchDataProvider {
  private readonly platform: ITradingPlatform;
  /** Issue #6036 — the pair this provider actually executes (never a requested string). */
  readonly venue: ResearchVenue;
  private listingsCache: NasdaqStockListing[] | null = null;
  private persistedChainsPromise?: Promise<PersistedOptionsChainsRead | undefined>;

  constructor(
    private readonly env: Env,
    private readonly userLogin: string,
    /**
     * Issue #1331: platform history deps, bound by the caller
     * (research-agent binds route-resolved + capture; the fit
     * runner binds when it has sql). Absent, technicals are
     * honestly null — the old direct Yahoo fetch is deleted, so
     * there is no fallback to fall back to.
     */
    private readonly historyDeps?: YahooHistoryDeps,
    /**
     * Issue #1378: platform universe deps, bound by the caller
     * (research-agent binds route-resolved + capture; the fit
     * runner binds when it has sql). Decision D2 recorded
     * exception: research has no caller run id, so captures are
     * recorded under generated run ids — never a fake id forced
     * through the research paths. Absent, getUniverseSymbols
     * degrades to [] and etfMap to an empty map with a warn
     * naming the missing seam — the #1331 null-technicals
     * precedent — never a direct fetch and never a throw.
     */
    private readonly universeDeps?: NasdaqUniverseDeps,
    /**
     * Issue #5912 — the venue this run quotes from: a broker id the platform
     * registry knows, plus the mode that overrides its environment
     * ("live" / "paper" / "sandbox", per the platform's own vocabulary).
     * Unset = the configured default in the deployment's environment.
     */
    private readonly selection?: {
      brokerId?: string;
      mode?: string;
      chainFeed?: { datasetStore: FeedDatasetStore | null; maxAgeSeconds: number };
      chainRules?: ResearchChainRules;
    }
  ) {
    // #6036 — the venue is resolved once, by the one resolver the
    // dispatch paths share: a normalised mode, a catalogued broker ×
    // mode pair, and a named refusal instead of a silent paper run.
    // #291 Q2: still resolved through the platform registry (was a direct
    // ETradeService construction — the T0 ledger's researchProviders
    // entry). ORM-free, exactly as before.
    this.venue = resolveResearchVenue({
      brokerId: selection?.brokerId,
      mode: selection?.mode,
    });
    this.platform = TradingPlatformRegistry.getPlatform(
      this.venue.brokerId,
      env,
      undefined,
      userLogin,
      this.venue.mode,
    );
  }

  private async listings(): Promise<NasdaqStockListing[]> {
    if (!this.listingsCache) {
      // Issue #1378: the lifetime cache is kept (decision D3),
      // now over the ROUTED adapter result. No freshness change.
      if (!this.universeDeps) {
        structuredLog.warn("researchProviders.universe_deps_missing", {
          message: "[research] universeDeps missing: getUniverseSymbols/etfMap degrade to empty (no dep-less listings fetch exists, #1378)",
        });
        return [];
      }
      this.listingsCache = await this.universeDeps.fetchListings();
    }
    return this.listingsCache;
  }

  async getUniverseSymbols(universe: string): Promise<string[]> {
    // Issue #6032 — the id is validated before the listings are read and
    // long before a quote is attempted: an unknown (or `ALL`) universe is
    // a named refusal carrying the accepted set, never a `[]` that maps to
    // an empty "0 candidates" run.
    const id = normalizeResearchUniverseId(universe);
    if (id === null) {
      throw new ResearchUniverseRefusal(universe, researchUniverseIds());
    }
    const listings = await this.listings();
    const resolved = resolveUniverse(id, listings);
    return resolved.map((l) => l.symbol);
  }

  /** ETF markers for the currently cached listings (heuristic, documented). */
  async etfMap(): Promise<Map<string, boolean>> {
    const listings = await this.listings();
    const map = new Map<string, boolean>();
    for (const l of listings) {
      map.set(l.symbol.toUpperCase(), isEtfSymbol(l.symbol, l.companyName ?? ""));
    }
    return map;
  }

  async getQuote(symbol: string): Promise<QuoteSnapshot | null> {
    let quote;
    try {
      // LIVE_STRICT (#291 quote unification): the semantics this provider
      // always had via ETradeService.getQuoteAsync — a failed live quote
      // throws here and becomes null, never a stale-cache snapshot.
      quote = await fetchQuoteLiveStrict(this.platform, symbol, {
        // Research follows the resolved venue mode, never the worker's
        // deployment environment (a PROD worker can still read paper data).
        isLive: this.venue.mode === "live",
      });
    } catch (error) {
      structuredLog.warn("researchProviders.quote_unavailable", {
        symbol,
        brokerId: this.venue.brokerId,
        mode: this.venue.mode,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!quote || !(quote.lastPrice > 0)) return null;
    const etfs = await this.etfMap().catch(() => new Map<string, boolean>());
    // NOTE: ETradeQuote.marketCap arrives in $B (client divides by 1e9).
    const marketCapDollars =
      typeof quote.marketCap === "number" && quote.marketCap > 0
        ? quote.marketCap * 1e9
        : null;
    return {
      symbol: quote.symbol,
      price: quote.lastPrice,
      timestamp: Date.parse(quote.timestamp) || Date.now(),
      marketCap: marketCapDollars,
      isEtf: etfs.get(symbol.toUpperCase()) ?? false,
      quoteStatus: quote.quoteStatus ?? "unknown",
      source: quote.source ?? this.venue.brokerId,
    };
  }

  async getChain(symbol: string): Promise<ChainSnapshot> {
    const now = Date.now();
    const rules = { ...RESEARCH_CONFIG_DEFAULTS, ...this.selection?.chainRules };
    const brokerSource = this.venue.brokerId;
    let source: string = brokerSource;
    let sourceAsOf = now;
    let chainSource: OptionChainSource | ITradingPlatform = this.platform;
    let persistedRow: FeedOptionsChainRow | undefined;
    let persistedFetchErrors: string[] = [];
    let failureReason: string | undefined;
    const feed = this.selection?.chainFeed;
    if (feed?.datasetStore) {
      try {
        this.persistedChainsPromise ??= readPersistedOptionsChains(
          feed.datasetStore,
          brokerSource as DataProviderId,
          { maxAgeSeconds: feed.maxAgeSeconds, nowMs: now },
        );
        const persisted = await this.persistedChainsPromise;
        const row = persisted?.chainsBySymbol.get(symbol.toUpperCase());
        if (persisted && !persisted.stale && row?.chains.length) {
          chainSource = createDatasetOptionChainSource(persisted.artifact);
          persistedRow = row;
          source = persisted.label;
          const persistedAsOf = Date.parse(persisted.asOf);
          sourceAsOf = Number.isNaN(persistedAsOf) ? now : persistedAsOf;
        } else if (persisted && !persisted.stale && row) {
          persistedFetchErrors = row.fetchErrors;
        }
      } catch (error) {
        structuredLog.warn("researchProviders.options_chain_feed_read_failed", {
          brokerId: brokerSource,
          symbol,
          error: safeChainError(error),
        });
      }
    }
    // Live path first.
    try {
      if (!chainSource.getOptionExpireDates || !chainSource.getOptionChains) {
        throw new Error(`${brokerSource} options feed does not expose the option-chain data plane.`);
      }
      const expiries = await chainSource.getOptionExpireDates(symbol);
      // Issue #353 — select expiries across the near band (30–45 DTE) AND the
      // LEAPS band (>=180 DTE); the old slice(0, 4) cut every LEAPS expiry,
      // which made the PMCC branch unreachable.
      const withDte = expiries.map((exp) => ({
        exp,
        dte: dteOf(exp.year, exp.month, exp.day, now),
      }));
      const nearBand = withDte
        .filter(
          (e) => e.dte >= rules.nearExpiryMinDte && e.dte <= rules.nearExpiryMaxDte
        )
        .sort((a, b) => a.dte - b.dte)
        .slice(0, rules.maxExpiriesPerBand);
      const leapsBand = withDte
        .filter((e) => e.dte >= rules.leapsExpiryMinDte)
        .sort((a, b) => a.dte - b.dte)
        .slice(0, rules.maxExpiriesPerBand);
      const picked = [...nearBand, ...leapsBand].map((e) => e.exp);
      if (expiries.length === 0) {
        failureReason = persistedRow
          ? `${source} has no eligible option expirations for ${symbol}.`
          : `${source} returned no option expirations for ${symbol}.`;
        if (persistedRow?.fetchErrors.length) {
          failureReason = [...persistedRow.fetchErrors].join("; ");
        }
      } else if (picked.length === 0) {
        failureReason = `${source} returned ${expiries.length} expiration(s) for ${symbol}, but none were in the configured near-term (${rules.nearExpiryMinDte}–${rules.nearExpiryMaxDte} DTE) or LEAPS (≥${rules.leapsExpiryMinDte} DTE) bands.`;
      }
      const chainExpiries: ProviderChainExpiry[] = [];
      const chainErrors: string[] = [];
      let underlyingPrice = 0;
      for (const exp of picked) {
        const dte = dteOf(exp.year, exp.month, exp.day, now);
        try {
          const chain = await chainSource.getOptionChains({
            symbol,
            expiryYear: exp.year,
            expiryMonth: exp.month,
            expiryDay: exp.day,
            chainType: "CALLPUT",
          });
          if (!chain) {
            chainErrors.push(`${formatExpiry(exp)}: provider returned no chain.`);
            continue;
          }
          if (!underlyingPrice && chain.underlyingPrice > 0) {
            underlyingPrice = chain.underlyingPrice;
          }
          const iso = `${exp.year}-${String(exp.month).padStart(2, "0")}-${String(exp.day).padStart(2, "0")}`;
          const snapshot = chainToSnapshot(symbol, chain, iso, dte, sourceAsOf, "live");
          if (snapshot.legs.length === 0) {
            chainErrors.push(`${formatExpiry(exp)}: contracts were returned without usable option quotes.`);
            continue;
          }
          chainExpiries.push(snapshot);
        } catch (error) {
          chainErrors.push(`${formatExpiry(exp)}: ${safeChainError(error)}`);
        }
      }
      if (chainExpiries.length > 0) {
        return {
          symbol,
          underlyingPrice,
          asOf: sourceAsOf,
          provenance: "live",
          source,
          ...([...chainErrors, ...(persistedRow?.fetchErrors ?? [])].length
            ? { failureReason: [...chainErrors, ...(persistedRow?.fetchErrors ?? [])].join("; ") }
            : {}),
          expiries: chainExpiries.sort((a, b) => a.dte - b.dte),
        };
      }
      if (chainErrors.length > 0) {
        failureReason = [...chainErrors, ...(persistedRow?.fetchErrors ?? []), ...persistedFetchErrors].join("; ");
      } else if (persistedRow && persistedRow.chains.length === 0) {
        failureReason = `${source} contains no eligible option contracts for ${symbol}.`;
      }
    } catch (error) {
      failureReason = safeChainError(error);
    }
    if (persistedFetchErrors.length) {
      failureReason = [...persistedFetchErrors, ...(failureReason ? [failureReason] : [])].join("; ");
    }
    // #928 (parent #913 S10) — calibrated fallback is demo-gated, exactly
    // like every other calibrated consumer (issue #65). Gate off (PROD
    // default) => no calibrated chain: fall through to the explicit
    // unavailable snapshot below, never a substitute number. Gate on =>
    // calibrated chain as before, provenance "calibrated" (ChainProvenance
    // has no "calibrated-demo" member; downstream layers map "calibrated"
    // to the "calibrated-demo" dataSource).
    if (!isDemoCalibratedChainsEnabled()) {
      return {
        symbol,
        underlyingPrice: 0,
        asOf: now,
        provenance: "unavailable",
        source,
        failureReason: failureReason ?? `${source} returned no usable option chains for ${symbol}.`,
        expiries: [],
      };
    }
    // Calibrated fallback: explicitly synthetic, never an executable quote.
    // Issue #353 — mirror the two live bands: the builder's DTE grid now
    // covers LEAPS, so the PMCC path works on calibrated chains too.
    try {
      const calibrated = [
        ...buildCalibratedOptionChains(
          [symbol],
          0,
          rules.calibratedNearMaxDte
        ),
        ...buildCalibratedOptionChains(
          [symbol],
          rules.leapsExpiryMinDte,
          rules.calibratedLeapsMaxDte
        ),
      ];
      const chainExpiries: ProviderChainExpiry[] = [];
      let underlyingPrice = 0;
      for (const chain of calibrated) {
        const exp = chain.selectedExpiry;
        if (!exp) continue;
        const dte = dteOf(exp.year, exp.month, exp.day, now);
        if (!underlyingPrice && chain.underlyingPrice > 0) {
          underlyingPrice = chain.underlyingPrice;
        }
        const iso = `${exp.year}-${String(exp.month).padStart(2, "0")}-${String(exp.day).padStart(2, "0")}`;
        chainExpiries.push(
          chainToSnapshot(symbol, chain, iso, dte, now, "calibrated")
        );
      }
      if (chainExpiries.length > 0) {
        return {
          symbol,
          underlyingPrice,
          asOf: now,
          provenance: "calibrated",
          source: "calibrated",
          expiries: chainExpiries.sort((a, b) => a.dte - b.dte),
        };
      }
    } catch {
      // fall through
    }
    return {
      symbol,
      underlyingPrice: 0,
      asOf: now,
      provenance: "unavailable",
      source,
      failureReason: failureReason ?? `${source} returned no usable option chains for ${symbol}.`,
      expiries: [],
    };
  }

  async getTechnicals(symbol: string): Promise<Technicals | null> {
    if (!this.historyDeps) return null;
    try {
      const map = await fetchPlatformTechnicalsBatch(this.historyDeps, [symbol]);
      const t = map.get(symbol);
      if (!t) return null;
      const hist = t.macdHistogram ?? 0;
      const trend = hist > 0 ? "up" : hist < 0 ? "down" : "flat";
      const momentum =
        t.rsi14 != null
          ? Math.max(-1, Math.min(1, (t.rsi14 - 50) / 50))
          : null;
      const notes: string[] = [];
      if (t.macdSignal) notes.push(`MACD signal: ${t.macdSignal}.`);
      if (t.gapPercent != null) {
        notes.push(`Overnight gap ${t.gapPercent.toFixed(2)}% (${t.gapDirection}).`);
      }
      return {
        trend,
        momentum,
        rsi: t.rsi14,
        notes,
      };
    } catch {
      return null;
    }
  }

  async getCatalysts(symbol: string): Promise<CatalystInfo[] | null> {
    const cal = await getSymbolEventCalendar(symbol);
    if (!cal.covered) {
      // Honesty contract (spec §7): never treat failed/uncovered retrieval as "no event".
      return null;
    }
    const catalysts: CatalystInfo[] = [];
    if (cal.earningsDate) {
      catalysts.push({
        description: `Upcoming earnings on ${cal.earningsDate}${
          cal.daysToEarnings != null ? ` (${cal.daysToEarnings}d)` : ""
        }`,
        date: cal.earningsDate,
        direction: "neutral",
      });
    }
    if (cal.exDividendDate) {
      catalysts.push({
        description: `Upcoming ex-dividend on ${cal.exDividendDate}${
          cal.daysToExDiv != null ? ` (${cal.daysToExDiv}d)` : ""
        }`,
        date: cal.exDividendDate,
        direction: "neutral",
      });
    }
    return catalysts;
  }

  async getRegime(): Promise<RegimeAssessment> {
    const now = Date.now();
    try {
      const [quote, techMap] = await Promise.all([
        this.getQuote("SPY"),
        this.historyDeps
          ? fetchPlatformTechnicalsBatch(this.historyDeps, ["SPY"]).catch(() => null)
          : Promise.resolve(null),
      ]);
      const t = techMap?.get("SPY");
      const hist = t?.macdHistogram ?? 0;
      let regime: RegimeAssessment["regime"] = "chop";
      if (hist > 0) regime = "bull";
      else if (hist < 0) regime = "bear";
      return {
        regime,
        notes: [
          `SPY ${quote ? `at ${quote.price}` : "quote unavailable"}; MACD histogram ${hist.toFixed(3)}.`,
        ],
        asOf: now,
      };
    } catch {
      return { regime: "unknown", notes: ["Regime assessment failed."], asOf: now };
    }
  }
}

function formatExpiry(expiry: { year: number; month: number; day: number }): string {
  return `${expiry.year}-${String(expiry.month).padStart(2, "0")}-${String(expiry.day).padStart(2, "0")}`;
}

/** Keep provider refusal details useful while excluding credentials and bounding report text. */
function safeChainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(APCA-API-(?:KEY-ID|SECRET-KEY))\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(api[_-]?key|secret|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}
