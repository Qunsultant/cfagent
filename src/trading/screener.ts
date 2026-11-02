/**
 * Dynamic Market Screener Engine
 *
 * Implements:
 * - Dynamic screening across multi-sector universes without reliance on static hardcoded values.
 * - Dynamic all-exchange U.S. equity listing discovery; no embedded ticker universe.
 * - Local filtering only against fields supplied by the listing feed.
 */

import type { StockScreenerFilter, StockScreenResult, ScreenedStockItem, ETradeQuote, StockScreenGatherSummary } from "../types";
import type { IMarketScreener } from "./interfaces";
import { type NasdaqStockListing } from "../services/nasdaqListings";
import { acquireUniverse, type NasdaqUniverseSeam } from "./screenerPipeline";

import {
  CURATED_STOCK_UNIVERSE,
  YFINANCE_MARKET_UNIVERSE,
  getCuratedStockListings,
  getCuratedStockUniverse,
  setCuratedStockUniverse,
  getCuratedStockBySymbol,
  type CuratedStockSecurity,
  type YFinanceSecurityDefinition,
} from "../config/curatedStockUniverse";

export type { CuratedStockSecurity, YFinanceSecurityDefinition };
export { CURATED_STOCK_UNIVERSE, YFINANCE_MARKET_UNIVERSE, getCuratedStockListings, getCuratedStockUniverse, setCuratedStockUniverse, getCuratedStockBySymbol };

export function inferSectorFromCompanyName(name: string): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (/\b(semiconductor|semiconductors|micro|chips?|wafer|devices?)\b/i.test(lower)) return "Semiconductors";
  if (/\b(technology|software|systems|cloud|data|cyber|network|computing|digital|platform|intelligence|ai)\b/i.test(lower)) return "Technology";
  if (/\b(bank|bancorp|financial|capital|insurance|wealth|trust|holdings?|investment|credit)\b/i.test(lower)) return "Financial";
  if (/\b(pharma|therapeutics|medical|health|care|biosciences?|biotech|clinical|hospital)\b/i.test(lower)) return "Healthcare";
  if (/\b(energy|petroleum|oil|gas|pipeline|refining|drilling|solar|clean energy)\b/i.test(lower)) return "Energy";
  if (/\b(retail|automotive|motors|motors?|apparel|entertainment|leisure|travel|hotel|restaurant)\b/i.test(lower)) return "Consumer Discretionary";
  if (/\b(telecom|communications?|media|wireless|broadcasting)\b/i.test(lower)) return "Communication Services";
  return undefined;
}

export function resolveStockSector(symbol: string, companyName?: string, rawSector?: string): string | undefined {
  if (rawSector && rawSector.toLowerCase() !== "equities" && rawSector.toLowerCase() !== "unknown" && rawSector.trim() !== "") {
    return rawSector;
  }
  const cleanSym = (symbol || "").trim().toUpperCase();
  const curated = getCuratedStockBySymbol(cleanSym);
  if (curated?.sector) return curated.sector;
  const inferred = inferSectorFromCompanyName(companyName || symbol);
  if (inferred) return inferred;
  return undefined;
}

export function calculateDynamicRsi(
  symbol: string,
  price: number,
  high52?: number,
  low52?: number,
  changePercent: number = 0,
  explicitRsi?: number
): number | undefined {
  if (explicitRsi !== undefined && Number.isFinite(explicitRsi) && explicitRsi >= 0 && explicitRsi <= 100) {
    return explicitRsi;
  }
  return undefined;
}

/**
 * Issue #1998 (Phase 3): the gather hook a listing-feed screen calls
 * when its filter needs technical fields the feed cannot supply.
 * The hook owns fetch + persist + read-back; the screen only
 * evaluates what the hook read back from storage, never fresh
 * compute inside the goal path (the dataset rule). The hook lives
 * outside src/trading (services/goalGather.ts); this interface is
 * the seam, so the trading layer never imports a service module.
 */
export interface ScreenLiveEnrichmentResult {
  /** Caller run id the gather rows are keyed by. */
  runId: string;
  /** Enriched quotes read back from storage, in acquired order. */
  enrichedQuotes: ETradeQuote[];
  /** Acquired symbols with no valid stored gather row. */
  missingSymbols: string[];
  /** Missing field names per missing symbol (e.g. week52High, rsi). */
  missingFields: Record<string, string[]>;
  /** Stored rows served by the gap-fill provider. */
  gapFilledCount: number;
  /** Content hash of the capability-route snapshot at run time. */
  routeVersionHash: string;
}

export interface ScreenLiveEnrichment {
  enrich(quotes: ETradeQuote[]): Promise<ScreenLiveEnrichmentResult>;
}

export class DynamicMarketScreener implements IMarketScreener {
  private static testUniverseFixture: ScreenedStockItem[] = [];
  private static testListingsFixture: NasdaqStockListing[] | null = null;
  private universeCache: ScreenedStockItem[] = [];

  /**
   * Test fixture injector — allows offline unit tests to inject deterministic fixtures
   * without embedding any mock data or fake prices in production code.
   */
  static setTestUniverseFixture(fixture: ScreenedStockItem[]): void {
    DynamicMarketScreener.testUniverseFixture = fixture;
  }

  static getTestUniverseFixture(): ScreenedStockItem[] {
    return DynamicMarketScreener.testUniverseFixture;
  }

  static setTestListingsFixture(fixture: NasdaqStockListing[] | null): void {
    DynamicMarketScreener.testListingsFixture = fixture;
  }

  /** Public read access for the shared screener pipeline (#259). */
  static getTestListingsFixture(): NasdaqStockListing[] | null {
    return DynamicMarketScreener.testListingsFixture;
  }

  getDefaultUniverse(): ScreenedStockItem[] {
    return [];
  }

  constructor(initialUniverse?: ScreenedStockItem[]) {
    if (initialUniverse && initialUniverse.length > 0) {
      this.universeCache = initialUniverse;
    } else if (DynamicMarketScreener.testUniverseFixture.length > 0) {
      this.universeCache = DynamicMarketScreener.testUniverseFixture;
    } else {
      this.universeCache = this.getDefaultUniverse();
    }
  }

  setUniverse(universe: ScreenedStockItem[]): void {
    this.universeCache = universe || [];
  }

  getUniverse(): ScreenedStockItem[] {
    return this.universeCache;
  }

  /**
   * Internal evaluator that strictly verifies filter rules and builds an auditable scan ledger
   */
  private evaluateUniverse(
    universe: ScreenedStockItem[],
    filter: StockScreenerFilter = {}
  ): StockScreenResult {
    const summaryParts: string[] = [];
    const rejections: { symbol: string; reason: string; changePercent?: number; price?: number; rsi?: number }[] = [];
    let passedStocks: ScreenedStockItem[] = [];

    if (filter.search && filter.search.trim()) {
      summaryParts.push(`Search: "${filter.search.trim()}"`);
    }
    if (filter.sector && filter.sector !== "all" && filter.sector !== "Any") {
      summaryParts.push(`Sector: ${filter.sector}`);
    }
    if (filter.minPrice !== undefined) summaryParts.push(`Min price: $${filter.minPrice}`);
    if (filter.maxPrice !== undefined) summaryParts.push(`Max price: $${filter.maxPrice}`);
    if (filter.minMarketCap !== undefined && filter.minMarketCap > 0) {
      summaryParts.push(
        `Min Cap: >= $${filter.minMarketCap >= 1e9 ? (filter.minMarketCap / 1e12).toFixed(1) + "T" : filter.minMarketCap + "B"}`
      );
    }
    if (filter.maxPeRatio !== undefined && filter.maxPeRatio > 0) {
      summaryParts.push(`Max P/E: <= ${filter.maxPeRatio}`);
    }
    if (filter.minRsi !== undefined) {
      summaryParts.push(`RSI >= ${filter.minRsi}`);
    }
    if (filter.maxRsi !== undefined) {
      summaryParts.push(`RSI <= ${filter.maxRsi}`);
    }
    if (filter.minPercentB !== undefined) {
      summaryParts.push(`%B >= ${filter.minPercentB}`);
    }
    if (filter.maxPercentB !== undefined) {
      summaryParts.push(`%B <= ${filter.maxPercentB}`);
    }
    if (filter.requireSqueezeGate) {
      summaryParts.push("Squeeze Gate (bandwidth at lookback minimum)");
    }
    if (filter.requireAboveAnchoredVwap) {
      summaryParts.push("Above Anchored VWAP (52W low)");
    }
    if (filter.minAtrPct !== undefined) {
      summaryParts.push(`ATR% >= ${filter.minAtrPct}`);
    }
    if (filter.maxAtrPct !== undefined) {
      summaryParts.push(`ATR% <= ${filter.maxAtrPct}`);
    }
    if (filter.regimeFilter !== undefined) {
      summaryParts.push(`Regime: ${filter.regimeFilter}`);
    }
    if (filter.minCompositeBiasScore !== undefined) {
      summaryParts.push(`Composite bias >= ${filter.minCompositeBiasScore}`);
    }
    if (filter.requireNoRecentDeathCross) {
      summaryParts.push("No death cross within 20 sessions");
    }
    if (filter.requireOrbBreakout) {
      summaryParts.push("ORB breakout confirmed (trigger + VWAP hold)");
    }
    if (filter.requirePreMarketMomentumGap || filter.minAbsGapPct !== undefined) {
      summaryParts.push(`|Gap%| >= ${filter.minAbsGapPct ?? 2.0}`);
    }
    if (filter.gainersOnly) {
      summaryParts.push("Gainers Only");
    }
    if (filter.losersOnly) {
      summaryParts.push("Losers Only");
    }
    if (filter.momentum && filter.momentum !== "any") {
      summaryParts.push(`Momentum: ${filter.momentum}`);
    }
    if (filter.minVolume !== undefined && filter.minVolume > 0) {
      summaryParts.push(`Min Vol: >= ${filter.minVolume.toLocaleString()}`);
    }
    if (filter.rsiFilter) {
      if (filter.rsiFilter === "oversold") summaryParts.push("RSI < 35 (Oversold)");
      else if (filter.rsiFilter === "overbought") summaryParts.push("RSI > 70 (Overbought)");
      else if (filter.rsiFilter === "neutral") summaryParts.push("RSI 35-70 (Neutral)");
    }

    if (!universe || universe.length === 0) {
      return {
        totalScanned: 0,
        totalScreened: 0,
        matchedCount: 0,
        status: "no_universe",
        filterApplied: filter,
        filterSummary: summaryParts.join(", ") || "Live E*TRADE Candidate Universe",
        ledger: {
          universeSymbols: [],
          totalEvaluated: 0,
          passedCount: 0,
          rejectedCount: 0,
          rejections: [],
        },
        stocks: [],
        scannedAt: new Date().toISOString(),
      };
    }

    for (const stock of universe) {
      const effectiveRsi = stock.rsi14 ?? stock.rsi;

      // 1. Search term check
      if (filter.search && filter.search.trim()) {
        const q = filter.search.trim().toLowerCase();
        if (!stock.symbol.toLowerCase().includes(q) && !stock.companyName.toLowerCase().includes(q)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Search mismatch for "${filter.search.trim()}"`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      if (filter.minPrice !== undefined && stock.lastPrice < filter.minPrice) {
        rejections.push({
          symbol: stock.symbol,
          reason: `Price ($${stock.lastPrice.toFixed(2)}) below minimum $${filter.minPrice.toFixed(2)}`,
          price: stock.lastPrice,
          changePercent: stock.changePercent,
        });
        continue;
      }
      if (filter.maxPrice !== undefined && stock.lastPrice > filter.maxPrice) {
        rejections.push({
          symbol: stock.symbol,
          reason: `Price ($${stock.lastPrice.toFixed(2)}) above maximum $${filter.maxPrice.toFixed(2)}`,
          price: stock.lastPrice,
          changePercent: stock.changePercent,
        });
        continue;
      }

      // 2. Sector check
      // Issue #919: "ALL" (any case) means no sector filter — treat as wildcard.
      const sectorLower = (filter.sector || "").toLowerCase().trim();
      if (filter.sector && sectorLower !== "all" && sectorLower !== "any") {
        const sec = filter.sector.toLowerCase().trim();
        const effectiveSector = resolveStockSector(stock.symbol, stock.companyName, stock.sector);
        stock.sector = effectiveSector;
        // Issue #950: no sector data means no sector verdict — pass, never reject.
        if (effectiveSector) {
        const itemSec = effectiveSector.toLowerCase().trim();
        const sectorMatches =
          (sec === "semiconductors")
            ? (itemSec === "semiconductors")
            : (sec === "tech" || sec === "technology")
            ? (itemSec === "technology" || itemSec === "semiconductors" || itemSec.includes("tech"))
            : (sec === "financial" || sec === "financials" || sec === "finance" || sec === "financial services")
            ? (itemSec === "financial" || itemSec === "financials" || itemSec === "financial services" || itemSec.includes("finan"))
            : (sec === "consumer discretionary" || sec === "consumer")
            ? (itemSec === "consumer discretionary" || itemSec.includes("consumer"))
            : (sec === "communication services" || sec === "communication")
            ? (itemSec === "communication services" || itemSec.includes("communication"))
            : (sec === "healthcare" || sec === "health")
            ? (itemSec === "healthcare" || itemSec.includes("health"))
            : (sec === "energy")
            ? (itemSec === "energy" || itemSec.includes("energy"))
            : (itemSec === sec || itemSec.includes(sec) || sec.includes(itemSec));
        if (!sectorMatches) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Sector "${stock.sector}" does not match requested "${filter.sector}"`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        }
      }

      // 3. Market Cap check
      if (filter.minMarketCap !== undefined && filter.minMarketCap > 0) {
        const cap = stock.marketCap || 0;
        const normalizedCap = cap < 1e8 ? cap * 1e9 : cap;
        const filterCap = filter.minMarketCap < 1e8 ? filter.minMarketCap * 1e9 : filter.minMarketCap;
        if (normalizedCap < filterCap) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Market cap ($${(normalizedCap / 1e9).toFixed(1)}B) below minimum threshold`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 4. Max P/E check
      if (filter.maxPeRatio !== undefined && filter.maxPeRatio > 0) {
        if (!stock.peRatio || stock.peRatio > filter.maxPeRatio) {
          rejections.push({
            symbol: stock.symbol,
            reason: `P/E ratio (${stock.peRatio ?? "N/A"}) exceeds maximum of ${filter.maxPeRatio}`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 5. Min RSI
      if (filter.minRsi !== undefined && (effectiveRsi === undefined || effectiveRsi < filter.minRsi)) {
        rejections.push({
          symbol: stock.symbol,
          reason: `RSI-14 (${effectiveRsi?.toFixed(1) ?? "N/A"}) below minimum ${filter.minRsi}`,
          rsi: effectiveRsi,
          price: stock.price,
          changePercent: stock.changePercent,
        });
        continue;
      }

      // 6. Max RSI
      if (filter.maxRsi !== undefined && (effectiveRsi === undefined || effectiveRsi > filter.maxRsi)) {
        rejections.push({
          symbol: stock.symbol,
          reason: `RSI-14 (${effectiveRsi?.toFixed(1) ?? "N/A"}) exceeds maximum ${filter.maxRsi}`,
          rsi: effectiveRsi,
          price: stock.price,
          changePercent: stock.changePercent,
        });
        continue;
      }

      const isMovers = filter.gainersLosers === "movers" || (Boolean(filter.gainersOnly) && Boolean(filter.losersOnly));

      // 7. Gainers Only: STRICT POSITIVE DAILY CHANGE REQUIRED
      if (!isMovers && (filter.gainersOnly || filter.gainersLosers === "gainers")) {
        if (stock.changePercent <= 0) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Negative/flat daily change (${stock.changePercent >= 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%) violates gainersOnly rule`,
            changePercent: stock.changePercent,
            price: stock.price,
            rsi: effectiveRsi,
          });
          continue;
        }
      }

      // 8. Losers Only: STRICT NEGATIVE DAILY CHANGE REQUIRED
      if (!isMovers && (filter.losersOnly || filter.gainersLosers === "losers")) {
        if (stock.changePercent >= 0) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Positive/flat daily change (+${stock.changePercent.toFixed(2)}%) violates losersOnly rule`,
            changePercent: stock.changePercent,
            price: stock.price,
            rsi: effectiveRsi,
          });
          continue;
        }
      }

      // 9. Min Volume
      if (filter.minVolume !== undefined && filter.minVolume > 0 && stock.volume < filter.minVolume) {
        rejections.push({
          symbol: stock.symbol,
          reason: `Volume (${stock.volume.toLocaleString()}) below minimum ${filter.minVolume.toLocaleString()}`,
          price: stock.price,
          changePercent: stock.changePercent,
        });
        continue;
      }

      if (filter.momentum === "bullish_breakout") {
        const high52 = stock.week52High || stock.high52 || 0;
        if (high52 <= 0 || stock.lastPrice < high52 || stock.changePercent <= 0) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Price is not making a positive 52-week high breakout",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      } else if (filter.momentum === "bearish_pullback") {
        if (stock.changePercent >= 0 || stock.lastPrice >= stock.open) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Price is not pulling back below the open",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      } else if (filter.momentum === "high_relative_volume") {
        const relativeVolume = stock.averageVolume && stock.averageVolume > 0
          ? stock.volume / stock.averageVolume
          : undefined;
        if (relativeVolume === undefined || relativeVolume < 1.5) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Relative volume (${relativeVolume?.toFixed(2) ?? "N/A"}x) is below 1.5x`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 10. RSI Filter presets
      if (filter.rsiFilter) {
        if (filter.rsiFilter === "oversold" && (effectiveRsi === undefined || effectiveRsi >= 35)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `RSI (${effectiveRsi?.toFixed(1) ?? "N/A"}) not oversold (< 35)`,
            rsi: effectiveRsi,
            changePercent: stock.changePercent,
          });
          continue;
        } else if (filter.rsiFilter === "overbought" && (effectiveRsi === undefined || effectiveRsi <= 70)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `RSI (${effectiveRsi?.toFixed(1) ?? "N/A"}) not overbought (> 70)`,
            rsi: effectiveRsi,
            changePercent: stock.changePercent,
          });
          continue;
        } else if (filter.rsiFilter === "neutral" && (effectiveRsi === undefined || effectiveRsi < 35 || effectiveRsi > 70)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `RSI (${effectiveRsi?.toFixed(1) ?? "N/A"}) not in neutral range [35, 70]`,
            rsi: effectiveRsi,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 11. Bollinger gates (issue #1654 slice 1; screener-rules.md §1.1).
      // %B gating is opt-in: active when either %B bound is set. The
      // overextension cap defaults to 1.0 (doc Extension Gate
      // %B ∈ [0.0, 1.0]) when maxPercentB is unset. Band values are
      // attached upstream where real bar history exists; a requested
      // gate with no band data fail-closes (unavailable, never zero).
      // evaluateUniverse itself sees no bar history — it gates on the
      // attached values, it never fabricates them.
      const percentBGatingActive = filter.maxPercentB !== undefined || filter.minPercentB !== undefined;
      if (percentBGatingActive) {
        const percentB = stock.percentB;
        if (percentB === undefined || !Number.isFinite(percentB)) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Bollinger %B unavailable — %B gate requested but no band data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        const maxPercentB = filter.maxPercentB ?? 1.0;
        if (percentB > maxPercentB) {
          rejections.push({
            symbol: stock.symbol,
            reason: `%B (${percentB.toFixed(2)}) above maximum ${maxPercentB.toFixed(2)} (overextended)`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (filter.minPercentB !== undefined && percentB < filter.minPercentB) {
          rejections.push({
            symbol: stock.symbol,
            reason: `%B (${percentB.toFixed(2)}) below minimum ${filter.minPercentB.toFixed(2)}`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      if (filter.requireSqueezeGate) {
        const bandwidth = stock.bollingerBandwidth;
        const bandwidthMin = stock.bollingerBandwidthMin;
        const barsUsed = stock.bollingerBarsUsed;
        if (
          bandwidth === undefined || !Number.isFinite(bandwidth) ||
          bandwidthMin === undefined || !Number.isFinite(bandwidthMin) ||
          barsUsed === undefined || !Number.isFinite(barsUsed)
        ) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Bollinger squeeze data unavailable — squeeze gate requested but no band data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        // Floor: 21 bars = default 20-period bands + 1 prior bandwidth
        // point. Fewer bars cannot support a non-trivial minimum (a
        // one-point "minimum" would pass everything) — reject, don't
        // weaken the gate.
        if (barsUsed < 21) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Bollinger squeeze data insufficient history (bars: ${barsUsed}, need ≥ 21)`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (bandwidth > bandwidthMin + 1e-12) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Bandwidth (${bandwidth.toFixed(4)}) above lookback minimum (${bandwidthMin.toFixed(4)}) — squeeze gate not met`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 12. Anchored VWAP gate (issue #1654 slice 2; screener-rules.md).
      // Spot must remain STRICTLY above the anchored VWAP from the
      // 52-week low bar: equality rejects (Venus ruling 2026-10-26,
      // recorded on #1654; the slice spec's equality-passes reading
      // is superseded). The AVWAP value is attached upstream
      // where real bar history exists; a requested gate with no AVWAP
      // data fail-closes (unavailable, never estimated). Like slice 1,
      // evaluateUniverse itself sees no bar history — it gates on the
      // attached value, it never fabricates it.
      if (filter.requireAboveAnchoredVwap) {
        const anchoredVwap = stock.anchoredVwap;
        if (anchoredVwap === undefined || !Number.isFinite(anchoredVwap)) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Anchored VWAP unavailable — AVWAP gate requested but no AVWAP data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (stock.lastPrice <= anchoredVwap) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Price ($${stock.lastPrice.toFixed(2)}) not above anchored VWAP ($${anchoredVwap.toFixed(2)})`,
            price: stock.lastPrice,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 13. ATR% gate (issue #1654 slice 3; screener-rules.md §1.4 +
      // fit-gap Gap 7: ATR% = ATR₁₄ / P × 100, gate [1.0%, 8.0%]).
      // ATR% gating is opt-in: active when either bound is set, and
      // the unset bound defaults to the doc bound (min 1.0, max 8.0)
      // — mirroring slice 1's %B defaulting. Bounds are inclusive.
      // The ATR% value is attached upstream where real bar history
      // exists; a requested gate with no ATR data fail-closes
      // (unavailable, never estimated). Like slices 1–2,
      // evaluateUniverse itself sees no bar history — it gates on the
      // attached value, it never fabricates it.
      const atrPctGatingActive = filter.minAtrPct !== undefined || filter.maxAtrPct !== undefined;
      if (atrPctGatingActive) {
        const atrPct = stock.atrPct;
        if (atrPct === undefined || !Number.isFinite(atrPct)) {
          rejections.push({
            symbol: stock.symbol,
            reason: "ATR% unavailable — ATR% gate requested but no ATR data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        const minAtrPct = filter.minAtrPct ?? 1.0;
        const maxAtrPct = filter.maxAtrPct ?? 8.0;
        if (atrPct < minAtrPct) {
          rejections.push({
            symbol: stock.symbol,
            reason: `ATR% (${atrPct.toFixed(2)}) below minimum ${minAtrPct.toFixed(2)}`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (atrPct > maxAtrPct) {
          rejections.push({
            symbol: stock.symbol,
            reason: `ATR% (${atrPct.toFixed(2)}) above maximum ${maxAtrPct.toFixed(2)}`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 14. HH/HL regime filter (issue #1654 slice 5; screener-rules.md).
      // Candidates must carry the requested regime. The regime value
      // is attached upstream where real bar history exists; a requested
      // filter with no regime data fail-closes (unavailable, never
      // estimated). Like slices 1–2, evaluateUniverse itself sees no
      // bar history — it gates on the attached value, it never
      // fabricates it.
      if (filter.regimeFilter !== undefined) {
        const regime = stock.regime;
        if (regime === undefined) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Regime unavailable — regime filter requested but no regime data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (regime !== filter.regimeFilter) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Regime (${regime}) does not match filter (${filter.regimeFilter})`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 15. 6-vote composite bias gate (issue #1654 slice 6;
      // screener-rules.md). Candidates must carry an attached bias
      // score at or above the minimum. The score is computed
      // upstream from real bar history (see
      // compute6VoteCompositeBiasFromBars); a requested gate with
      // no attached score fail-closes (unavailable, never
      // estimated). Like slices 1–2/5, evaluateUniverse itself sees
      // no bar history — it gates on the attached value, it never
      // fabricates it.
      if (filter.minCompositeBiasScore !== undefined) {
        const biasScore = stock.compositeBiasScore;
        if (biasScore === undefined) {
          rejections.push({
            symbol: stock.symbol,
            reason:
              "Composite bias unavailable — bias gate requested but no bias data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (biasScore < filter.minCompositeBiasScore) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Composite bias score ${biasScore} below minimum ${filter.minCompositeBiasScore}`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 16. Death-cross hard rejection (issue #1769; screener-rules.md
      // §1.1). A cross within the last 20 sessions rejects; an older
      // cross or no cross passes. A requested gate with no attached
      // death-cross data fail-closes, never estimates.
      if (filter.requireNoRecentDeathCross) {
        const deathCross = stock.deathCrossWithin20;
        if (deathCross === undefined) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Death-cross data unavailable — death-cross gate requested but no SMA data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (deathCross) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Death cross within 20 sessions — SMA50 below SMA200 (hard rejection)",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 17. ORB breakout gate (issue #1769; screener-rules.md §1.4).
      // Passes only when BOTH the breakout trigger and the VWAP hold
      // are confirmed on attached intraday data. A requested gate
      // with no attached ORB data fail-closes, never estimates.
      if (filter.requireOrbBreakout) {
        const triggered = stock.orbTriggered;
        const vwapConfirmed = stock.orbVwapConfirmed;
        if (triggered === undefined || vwapConfirmed === undefined) {
          rejections.push({
            symbol: stock.symbol,
            reason: "ORB data unavailable — ORB gate requested but no intraday breakout data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        if (!triggered || !vwapConfirmed) {
          rejections.push({
            symbol: stock.symbol,
            reason: !triggered
              ? "ORB breakout trigger not met — price did not clear OR_H x 1.001 with RVOL >= 1.5x"
              : "ORB VWAP hold not confirmed — fewer than 70% of completed 15-min bars closed above session VWAP",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 18. Pre-market gap gate (issue #1769; screener-rules.md §1.4).
      // Completes the pre-market momentum trio (gap + RVOL via the
      // high_relative_volume momentum filter + ATR% gate §13): |Gap%|
      // must reach the threshold, defaulting to the doc bound 2.0%
      // when only requirePreMarketMomentumGap is set. Bounds are
      // inclusive. A requested gate with no gap data fail-closes.
      const gapGatingActive = filter.requirePreMarketMomentumGap || filter.minAbsGapPct !== undefined;
      if (gapGatingActive) {
        const gap = stock.gapPercent;
        if (gap === undefined || !Number.isFinite(gap)) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Gap data unavailable — gap gate requested but no gap data attached",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
        const minAbsGapPct = filter.minAbsGapPct ?? 2.0;
        if (Math.abs(gap) < minAbsGapPct) {
          rejections.push({
            symbol: stock.symbol,
            reason: `|Gap%| (${Math.abs(gap).toFixed(2)}) below minimum ${minAbsGapPct.toFixed(2)}`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // Passed all checks!
      passedStocks.push({
        ...stock,
        price: stock.lastPrice || stock.price,
        marketCap: (stock.marketCap || 0) < 1e8 ? (stock.marketCap || 0) * 1e9 : stock.marketCap,
        rsi14: effectiveRsi,
        rsi: effectiveRsi,
        changePeriod: stock.changePeriod || "1D (Regular Trading Day)",
        previousClose: stock.previousClose || Number(((stock.lastPrice || stock.price) - stock.change).toFixed(2)),
        rsiLookback: "14-Period Daily RSI",
        macdIndicatorVersion: "MACD (12, 26, 9 EMA)",
        validationStatus: "PASS_CONFIRMED",
        signal: effectiveRsi !== undefined && effectiveRsi > 70
          ? "OVERBOUGHT"
          : effectiveRsi !== undefined && effectiveRsi < 35
          ? "OVERSOLD_BOUNCE"
          : stock.changePercent > 0.5
          ? "BULLISH_MOMENTUM"
          : "RANGE_BOUND",
      });
    }

    const isMovers = filter.gainersLosers === "movers" || (Boolean(filter.gainersOnly) && Boolean(filter.losersOnly));
    let moversData: { gainers: ScreenedStockItem[]; losers: ScreenedStockItem[] } | undefined;

    // Sorting
    if (isMovers) {
      const gainers = passedStocks.filter((s) => s.changePercent > 0).sort((a, b) => b.changePercent - a.changePercent);
      const losers = passedStocks.filter((s) => s.changePercent < 0).sort((a, b) => a.changePercent - b.changePercent);
      moversData = { gainers: [...gainers], losers: [...losers] };

      passedStocks.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    } else if (filter.gainersOnly || filter.gainersLosers === "gainers") {
      passedStocks.sort((a, b) => b.changePercent - a.changePercent);
    } else if (filter.losersOnly || filter.gainersLosers === "losers") {
      passedStocks.sort((a, b) => a.changePercent - b.changePercent);
    } else if (filter.gainersLosers === "active") {
      passedStocks.sort((a, b) => b.volume - a.volume);
    } else if (filter.sector && filter.sector !== "all" && filter.sector !== "Any") {
      passedStocks.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
    }

    // Fail-closed verification: double check that no invalid row exists in passedStocks
    let status: "matches_found" | "no_matches" | "SCAN_INVALID_DATA_MISMATCH" =
      passedStocks.length > 0 ? "matches_found" : "no_matches";

    if (filter.gainersOnly && !(Boolean(filter.gainersOnly) && Boolean(filter.losersOnly))) {
      const invalid = passedStocks.find((s) => s.changePercent <= 0);
      if (invalid) {
        status = "SCAN_INVALID_DATA_MISMATCH";
      }
    }

    const finalStocks = filter.limit !== undefined && filter.limit > 0
      ? passedStocks.slice(0, filter.limit)
      : passedStocks;

    return {
      totalScanned: universe.length,
      totalScreened: universe.length,
      matchedCount: finalStocks.length,
      status,
      filterApplied: filter,
      filterSummary: summaryParts.join(", ") || "Live E*TRADE Candidate Universe",
      ledger: {
        universeSymbols: universe.map((s) => s.symbol),
        totalEvaluated: universe.length,
        passedCount: finalStocks.length,
        rejectedCount: rejections.length,
        rejections,
      },
      stocks: finalStocks,
      movers: moversData,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluates screener filters against real quotes provided directly (e.g. from E*TRADE REST API)
   */
  screenWithQuotes(quotes: ETradeQuote[], filter: StockScreenerFilter = {}, cacheResult = true): StockScreenResult {
    const universe = quotes.map((q) => {
      const rsi14 = calculateDynamicRsi(
        q.symbol,
        q.lastPrice,
        q.week52High,
        q.week52Low,
        q.changePercent,
        q.rsi
      );
      return {
        ...q,
        price: q.lastPrice,
        sector: resolveStockSector(q.symbol, q.companyName, q.sector),
        rsi14,
        // Issue #1007: a provider-supplied MACD signal (Yahoo adapter
        // data field) survives as data; snapshot quotes carry none and
        // keep the honest unavailable label, exactly as before.
        macdSignal: q.macdSignal || "MACD unavailable from listing feed",
        signal: (rsi14 !== undefined && rsi14 > 70 ? "OVERBOUGHT" : rsi14 !== undefined && rsi14 < 35 ? "OVERSOLD_BOUNCE" : q.changePercent > 0.5 ? "BULLISH_MOMENTUM" : "RANGE_BOUND") as any,
        technicalSignal: rsi14 === undefined ? "Daily quote momentum; RSI unavailable" : rsi14 < 35 ? "Oversold" : rsi14 > 70 ? "Overbought" : "RSI neutral",
        momentumScore: Math.round(50 + q.changePercent * 5),
        highlightReason: `${q.companyName} ${q.source || "market listing"}`,
      } as ScreenedStockItem;
    });

    if (cacheResult) this.universeCache = universe;
    return this.evaluateUniverse(universe, filter);
  }

  /**
   * Filter and scan stocks based on fundamental and technical criteria (synchronous baseline)
   */
  screenStocks(filter: StockScreenerFilter = {}): StockScreenResult {
    return this.evaluateUniverse(this.getUniverse(), filter);
  }

  /**
   * Asynchronous market screener evaluating current equities universe
   */
  async screenMarkets(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    return this.evaluateUniverse(this.getUniverse(), filter);
  }

  async screenLive(
    filter: StockScreenerFilter = {},
    seam?: NasdaqUniverseSeam
  ): Promise<StockScreenResult> {
    // Unsupported-filter guard (manual-path-specific: the listing feed
    // cannot provide technical data). Behavior preserved.
    const unsupported: string[] = [];
    const hasTechnicalIndicators =
      filter.minRsi !== undefined ||
      filter.maxRsi !== undefined ||
      (filter.rsiFilter !== undefined && filter.rsiFilter !== "any") ||
      (filter.momentum !== undefined && filter.momentum !== "any");

    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase()) && hasTechnicalIndicators) {
      unsupported.push("sector");
    }
    if (hasTechnicalIndicators) {
      if (filter.minRsi !== undefined || filter.maxRsi !== undefined || (filter.rsiFilter && filter.rsiFilter !== "any")) {
        unsupported.push("RSI");
      }
      if (filter.momentum && filter.momentum !== "any") {
        unsupported.push("technical momentum");
      }
    }
    if (filter.minVolume !== undefined) unsupported.push("volume");
    if (filter.maxPeRatio !== undefined) unsupported.push("P/E");

    // Issue #259: universe acquisition via the shared pipeline.
    // Issue #1378: the universe seam is threaded, never defaulted
    // — without one, acquireUniverse returns the error-result
    // shape naming the missing seam (decision D1).
    const acquired = await acquireUniverse({
      mode: "all-listings",
      exchange: filter.exchange,
      universeDeps: seam?.universeDeps,
      universeRoute: seam?.universeRoute,
    });

    // Narrow the pipeline's discovery to this trigger's literal type.
    const toDiscovery = (message?: string) => ({
      mode: "all_us_listings" as const,
      candidateCount: acquired.discovery.candidateCount,
      listingCount: acquired.discovery.listingCount,
      sourceCounts: acquired.discovery.sourceCounts ?? {},
      message: message ?? acquired.discovery.message,
      ...(acquired.discovery.error ? { error: acquired.discovery.error } : {}),
    });

    // Fixture fetch failure → error result (original behavior).
    if (acquired.error) {
      return {
        ...this.screenWithQuotes([], filter, false),
        discovery: toDiscovery(),
      };
    }

    const quotes = acquired.quotes;

    // Empty universe → empty result with message (original behavior).
    if (quotes.length === 0) {
      return {
        ...this.screenWithQuotes([], filter, false),
        discovery: toDiscovery(),
      };
    }

    // Issue #1998 (Phase 3): when a gather hook is threaded on the
    // seam and the filter's technical criteria are exactly the ones
    // enrichment can supply (RSI, technical momentum), enrich first
    // and evaluate the READ-BACK rows — never the in-memory join.
    // Criteria enrichment cannot supply (sector, volume, P/E) still
    // refuse below, exactly as before; without a hook, everything
    // below is unchanged.
    const enrichment = seam?.enrichment;
    const enrichable =
      enrichment !== undefined &&
      hasTechnicalIndicators &&
      unsupported.every((u) => u === "RSI" || u === "technical momentum");
    if (enrichable && enrichment) {
      // Issue #1999: a throwing hook is a first-class gather
      // failure, never a silent leg and never a thrown leg without
      // a gather record. The failed summary rides the same
      // nothing-evaluable shape below, so the leg still fails via
      // the #1963 contract — now with the failure named.
      let gathered: ScreenLiveEnrichmentResult;
      try {
        gathered = await enrichment.enrich(quotes);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const message = `Goal gather failed for this run: ${error}; technical criteria were not applied.`;
        const scannedAt = new Date().toISOString();
        return {
          totalScanned: quotes.length,
          totalScreened: quotes.length,
          matchedCount: 0,
          filterApplied: filter,
          filterSummary: message,
          stocks: [],
          scannedAt,
          status: "no_matches",
          ledger: {
            universeSymbols: quotes.map((quote) => quote.symbol),
            totalEvaluated: quotes.length,
            passedCount: 0,
            rejectedCount: quotes.length,
            rejections: quotes.map((quote) => ({ symbol: quote.symbol, reason: message })),
          },
          validationError: message,
          discovery: toDiscovery(message),
          gather: {
            runId: "",
            stored: 0,
            missing: quotes.length,
            excluded: 0,
            gapFilled: 0,
            routeVersionHash: "",
            status: "failed",
            error,
          },
        };
      }
      // A stored row is not automatically evaluable: a symbol whose
      // row lacks a field THIS filter needs is excluded from
      // evaluation and ledger-rejected with the honest missing-data
      // reason — it must not be evaluated as if the field were a
      // real zero (a missing 52-week high is not "not breaking
      // out"). bearish_pullback needs only change/open, which live
      // quotes always carry, so it adds no field requirement.
      const neededFields = new Set<string>();
      if (filter.momentum === "bullish_breakout") neededFields.add("week52High");
      if (filter.momentum === "high_relative_volume") neededFields.add("averageVolume");
      if (
        filter.minRsi !== undefined ||
        filter.maxRsi !== undefined ||
        (filter.rsiFilter !== undefined && filter.rsiFilter !== "any")
      ) {
        neededFields.add("rsi");
      }
      const missingFor = (symbol: string): string[] =>
        (gathered.missingFields[symbol.toUpperCase()] ?? []).filter((f) => neededFields.has(f));
      const evaluable = gathered.enrichedQuotes.filter((q) => missingFor(q.symbol).length === 0);
      // Nothing evaluable means the filter was not evaluated at all:
      // that is a failed leg (the #1963 contract), never a
      // successful empty result.
      if (evaluable.length === 0) {
        const message =
          gathered.enrichedQuotes.length === 0
            ? "Goal gather produced no stored rows for this run; technical criteria were not applied."
            : "Goal gather stored rows, but none carry the fields this filter needs; technical criteria were not applied.";
        const scannedAt = new Date().toISOString();
        return {
          totalScanned: quotes.length,
          totalScreened: quotes.length,
          matchedCount: 0,
          filterApplied: filter,
          filterSummary: message,
          stocks: [],
          scannedAt,
          status: "no_matches",
          ledger: {
            universeSymbols: quotes.map((quote) => quote.symbol),
            totalEvaluated: quotes.length,
            passedCount: 0,
            rejectedCount: quotes.length,
            rejections: quotes.map((quote) => ({ symbol: quote.symbol, reason: message })),
          },
          validationError: message,
          discovery: toDiscovery(message),
          // Issue #1999: the gather ran (it just yielded nothing
          // evaluable) — status "ok", not "failed". A failed gather
          // is only the throwing-hook shape above.
          gather: {
            runId: gathered.runId,
            stored: gathered.enrichedQuotes.length,
            missing: gathered.missingSymbols.length,
            excluded: gathered.enrichedQuotes.length,
            gapFilled: gathered.gapFilledCount,
            routeVersionHash: gathered.routeVersionHash,
            status: "ok",
          },
        };
      }
      const excludedQuotes = gathered.enrichedQuotes.filter((q) => missingFor(q.symbol).length > 0);
      const enriched = this.screenWithQuotes(evaluable, filter, false);
      // No-row symbols never flow through filter evaluation as if
      // their fields were real zeros: they are ledger-rejected with
      // the honest missing-data reason, and totals reconcile to the
      // full acquired universe.
      const excludedRejections = excludedQuotes.map((q) => ({
        symbol: q.symbol,
        reason: `No persisted gather value for ${missingFor(q.symbol).join(", ")} in this run; technical criteria were not evaluated for this symbol.`,
      }));
      const missingRejections = gathered.missingSymbols.map((symbol) => ({
        symbol,
        reason: `No persisted gather row for this symbol in this run (missing: ${(gathered.missingFields[symbol] ?? ["gather row"]).join(", ")}).`,
      }));
      const gatherSummary: StockScreenGatherSummary = {
        runId: gathered.runId,
        stored: gathered.enrichedQuotes.length,
        missing: gathered.missingSymbols.length,
        excluded: excludedQuotes.length,
        gapFilled: gathered.gapFilledCount,
        routeVersionHash: gathered.routeVersionHash,
        status: "ok",
      };
      return {
        ...enriched,
        totalScanned: quotes.length,
        totalScreened: quotes.length,
        filterSummary: `${enriched.filterSummary}; gather: ${gatherSummary.stored} stored / ${gatherSummary.missing} missing / ${gatherSummary.excluded} excluded (route ${gatherSummary.routeVersionHash.slice(0, 8)})`,
        ledger: enriched.ledger
          ? {
              ...enriched.ledger,
              universeSymbols: quotes.map((quote) => quote.symbol),
              totalEvaluated: quotes.length,
              rejectedCount:
                enriched.ledger.rejectedCount + excludedRejections.length + missingRejections.length,
              rejections: [...enriched.ledger.rejections, ...excludedRejections, ...missingRejections],
            }
          : undefined,
        discovery: toDiscovery(),
        gather: gatherSummary,
      };
    }

    if (unsupported.length > 0) {
      const message = `The dynamic listing feed does not provide ${unsupported.join(", ")} data. Those criteria were not applied; use only price, daily change, market cap, and ticker/company search.`;
      const scannedAt = new Date().toISOString();
      return {
        totalScanned: quotes.length,
        totalScreened: quotes.length,
        matchedCount: 0,
        filterApplied: filter,
        filterSummary: message,
        stocks: [],
        scannedAt,
        status: "no_matches",
        ledger: {
          universeSymbols: quotes.map((quote) => quote.symbol),
          totalEvaluated: quotes.length,
          passedCount: 0,
          rejectedCount: quotes.length,
          rejections: quotes.map((quote) => ({ symbol: quote.symbol, reason: message })),
        },
        validationError: message,
        discovery: toDiscovery(message),
      };
    }

    const result = this.screenWithQuotes(quotes, filter, false);
    return {
      ...result,
      discovery: toDiscovery(),
    };
  }

  /**
   * Retrieves baseline quote from market universe
   */
  async getQuote(symbol: string): Promise<ETradeQuote> {
    const cleanSym = symbol.trim().toUpperCase();
    const found = this.getUniverse().find((s) => s.symbol === cleanSym);

    if (found) {
      return {
        ...found,
        price: found.lastPrice,
        high52: found.week52High,
        low52: found.week52Low,
        source: "E*TRADE Market Data Feed",
      };
    }
    throw new Error(`Quote data unavailable for '${cleanSym}'. No live or cached quote available from E*TRADE feed.`);
  }
}
