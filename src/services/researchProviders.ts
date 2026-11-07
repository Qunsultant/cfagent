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
 * - Catalysts: no catalyst feed is wired on the platform, so this provider
 *   returns null and the pipeline flags the limitation instead of
 *   inventing events.
 *
 * READ-ONLY: no order functions are imported or called.
 */

import {
  resolveUniverse,
  fetchPlatformTechnicalsBatch,
  buildCalibratedOptionChains,
  TradingPlatformRegistry,
  fetchQuoteLiveStrict,
  type ITradingPlatform,
  type NasdaqUniverseDeps,
  type YahooHistoryDeps,
} from "../trading";
import { resolveEnvironmentConfig } from "../config/environment";
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

/**
 * Issue #353 — research chain expiry selection windows. getChain covers TWO
 * working windows instead of the first four expirations only: the near band
 * the short-dated structures use, and the LEAPS band the PMCC long leg
 * requires (>=180 DTE, per the catalog's poor_mans_covered_call farMinDte).
 * Selection is bounded per band so wide option chains stay cheap.
 */
const NEAR_EXPIRY_MIN_DTE = 30;
const NEAR_EXPIRY_MAX_DTE = 45;
const LEAPS_EXPIRY_MIN_DTE = 180;
const MAX_EXPIRIES_PER_BAND = 4;

/** Calibrated-fallback DTE windows mirror the two live bands. */
const CALIBRATED_NEAR_MAX_DTE = 120;
const CALIBRATED_LEAPS_MIN_DTE = 180;
const CALIBRATED_LEAPS_MAX_DTE = 400;

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

export class EtradeResearchDataProvider implements ResearchDataProvider {
  private readonly platform: ITradingPlatform;
  private listingsCache: NasdaqStockListing[] | null = null;

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
    private readonly universeDeps?: NasdaqUniverseDeps
  ) {
    // #291 Q2: resolved through the platform registry (was a direct
    // ETradeService construction — the T0 ledger's researchProviders
    // entry). ORM-free, exactly as before.
    this.platform = TradingPlatformRegistry.getPlatform("etrade", env, undefined, userLogin);
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
    const listings = await this.listings();
    const resolved = resolveUniverse(
      universe as "NASDAQ100",
      listings
    );
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
        isLive: resolveEnvironmentConfig(this.env).isLive,
      });
    } catch {
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
      source: quote.source ?? "etrade",
    };
  }

  async getChain(symbol: string): Promise<ChainSnapshot> {
    const now = Date.now();
    // Live path first.
    try {
      if (!this.platform.getOptionExpireDates || !this.platform.getOptionChains) {
        throw new Error("platform lacks the options data plane");
      }
      const expiries = await this.platform.getOptionExpireDates(symbol);
      // Issue #353 — select expiries across the near band (30–45 DTE) AND the
      // LEAPS band (>=180 DTE); the old slice(0, 4) cut every LEAPS expiry,
      // which made the PMCC branch unreachable.
      const withDte = expiries.map((exp) => ({
        exp,
        dte: dteOf(exp.year, exp.month, exp.day, now),
      }));
      const nearBand = withDte
        .filter(
          (e) => e.dte >= NEAR_EXPIRY_MIN_DTE && e.dte <= NEAR_EXPIRY_MAX_DTE
        )
        .sort((a, b) => a.dte - b.dte)
        .slice(0, MAX_EXPIRIES_PER_BAND);
      const leapsBand = withDte
        .filter((e) => e.dte >= LEAPS_EXPIRY_MIN_DTE)
        .sort((a, b) => a.dte - b.dte)
        .slice(0, MAX_EXPIRIES_PER_BAND);
      const picked = [...nearBand, ...leapsBand].map((e) => e.exp);
      const chainExpiries: ProviderChainExpiry[] = [];
      let underlyingPrice = 0;
      for (const exp of picked) {
        const dte = dteOf(exp.year, exp.month, exp.day, now);
        const chain = await this.platform.getOptionChains({
          symbol,
          expiryYear: exp.year,
          expiryMonth: exp.month,
          expiryDay: exp.day,
          chainType: "CALLPUT",
        });
        if (!chain) continue;
        if (!underlyingPrice && chain.underlyingPrice > 0) {
          underlyingPrice = chain.underlyingPrice;
        }
        const iso = `${exp.year}-${String(exp.month).padStart(2, "0")}-${String(exp.day).padStart(2, "0")}`;
        chainExpiries.push(
          chainToSnapshot(symbol, chain, iso, dte, now, "live")
        );
      }
      if (chainExpiries.length > 0) {
        return {
          symbol,
          underlyingPrice,
          asOf: now,
          provenance: "live",
          expiries: chainExpiries.sort((a, b) => a.dte - b.dte),
        };
      }
    } catch {
      // Fall through to the calibrated path — labeled, never live.
    }
    // #928 (parent #913 S10) — calibrated fallback is demo-gated, exactly
    // like every other calibrated consumer (issue #65). Gate off (PROD
    // default) => no calibrated chain: fall through to the explicit
    // unavailable snapshot below, never a substitute number. Gate on =>
    // calibrated chain as before, provenance "calibrated" (ChainProvenance
    // has no "calibrated-demo" member; downstream layers map "calibrated"
    // to the "calibrated-demo" dataSource).
    if (!isDemoCalibratedChainsEnabled()) {
      return { symbol, underlyingPrice: 0, asOf: now, provenance: "unavailable", expiries: [] };
    }
    // Calibrated fallback: explicitly synthetic, never an executable quote.
    // Issue #353 — mirror the two live bands: the builder's DTE grid now
    // covers LEAPS, so the PMCC path works on calibrated chains too.
    try {
      const calibrated = [
        ...buildCalibratedOptionChains(
          [symbol],
          0,
          CALIBRATED_NEAR_MAX_DTE
        ),
        ...buildCalibratedOptionChains(
          [symbol],
          CALIBRATED_LEAPS_MIN_DTE,
          CALIBRATED_LEAPS_MAX_DTE
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
          expiries: chainExpiries.sort((a, b) => a.dte - b.dte),
        };
      }
    } catch {
      // fall through
    }
    return { symbol, underlyingPrice: 0, asOf: now, provenance: "unavailable", expiries: [] };
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

  async getCatalysts(_symbol: string): Promise<CatalystInfo[] | null> {
    // No catalyst feed is wired on the platform. Returning null keeps the
    // pipeline honest: the thesis gate records the limitation instead of
    // inventing events (spec §7: never treat failed retrieval as "no event").
    return null;
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
