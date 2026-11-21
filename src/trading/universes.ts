/**
 * Screener universe registry (issue #270).
 *
 * Universes are selectors over the live listings directory, never stored
 * ticker arrays. The exact selected listing snapshot is then passed into
 * quote acquisition once for each run.
 *
 * The listings directory is not market data (just "which symbols exist"),
 * so using it for universe membership is consistent with the E*TRADE-only
 * quote policy (#261). All prices/quotes come from E*TRADE (+ Yahoo history).
 */

import type { NasdaqStockListing } from "../services/nasdaqListings";
import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";

export type UniverseId =
  | "TECH"
  | "NASDAQ100"
  | "SP100"
  | "SP500"
  | "RUSSELL2000"
  | "ETF"
  | "LEV_ETF"
  | "ALL";

export interface UniverseDef {
  id: UniverseId;
  name: string;
  description: string;
  /** Default max symbols to quote (E*TRADE load control). */
  defaultMaxSymbols: number;
  /** Shardable: included when user selects ALL. */
  shardable: boolean;
}

function buildUniverses(): Record<UniverseId, UniverseDef> {
  const d = DEFAULT_SCREENER_CONFIG.universes.defaultMaxSymbols;
  return {
  TECH: {
    id: "TECH",
    name: "Technology",
    description: "Tech-keyword discovery (current default)",
    defaultMaxSymbols: d.TECH,
    shardable: false,
  },
  NASDAQ100: {
    id: "NASDAQ100",
    name: "Nasdaq-100",
    description: "Top 100 Nasdaq listings by market cap",
    defaultMaxSymbols: d.NASDAQ100,
    shardable: true,
  },
  SP100: {
    id: "SP100",
    name: "S&P 100",
    description: "Top 100 US listings by market cap (mega-cap)",
    defaultMaxSymbols: d.SP100,
    shardable: true,
  },
  SP500: {
    id: "SP500",
    name: "S&P 500",
    description: "Top 500 US listings by market cap",
    defaultMaxSymbols: d.SP500,
    shardable: true,
  },
  RUSSELL2000: {
    id: "RUSSELL2000",
    name: "Russell 2000",
    description: "US small-caps: market-cap ranks 1001–3000",
    defaultMaxSymbols: d.RUSSELL2000,
    shardable: true,
  },
  ETF: {
    id: "ETF",
    name: "ETFs",
    description: "Exchange-traded funds",
    defaultMaxSymbols: d.ETF,
    shardable: true,
  },
  LEV_ETF: {
    id: "LEV_ETF",
    name: "Leveraged ETFs",
    description: "2x/3x leveraged index, sector, and vol products",
    defaultMaxSymbols: d.LEV_ETF,
    shardable: true,
  },
  ALL: {
    id: "ALL",
    name: "All universes",
    description: "Auto-sharded into parallel per-universe runs",
    defaultMaxSymbols: d.ALL,
    shardable: false,
  },
  };
}

export const UNIVERSES: Record<UniverseId, UniverseDef> = buildUniverses();

export function shardableUniverses(): UniverseId[] {
  return (Object.keys(UNIVERSES) as UniverseId[]).filter(
    (id) => UNIVERSES[id].shardable
  );
}

function byMarketCapDesc(a: NasdaqStockListing, b: NasdaqStockListing): number {
  return (b.marketCap ?? 0) - (a.marketCap ?? 0);
}

function isEtfListing(l: NasdaqStockListing): boolean {
  const name = `${l.companyName} ${l.symbol}`.toUpperCase();
  return (
    name.includes("ETF") ||
    l.etf?.toUpperCase() === "Y" ||
    name.includes("ULTRA") ||
    name.includes("DIREXION") ||
    name.includes("PROSHARES")
  );
}

function isLeveragedEtfListing(l: NasdaqStockListing): boolean {
  if (!isEtfListing(l)) return false;
  const metadata = `${l.companyName} ${l.industry || ""} ${l.sector || ""}`;
  return /\b(?:1\.5|2|3|4|5|-1|-2|-3)x\b|\bleveraged?\b|\bultra(?:pro)?\b|\binverse\b|\bdaily\s+(?:bull|bear)\b/i.test(metadata);
}

/**
 * Resolve a universe to its symbol listings. Pure selector over the
 * listings directory — no market data involved.
 */
export function resolveUniverse(
  id: UniverseId,
  allListings: NasdaqStockListing[],
  config: ScreenerConfig = DEFAULT_SCREENER_CONFIG
): NasdaqStockListing[] {
  const u = config.universes;
  const sorted = [...allListings].sort(byMarketCapDesc);
  switch (id) {
    case "TECH": {
      // Keyword discovery (existing behavior, kept for compat).
      const keywords = [
        "tech", "software", "semiconductor", "computer", "internet",
        "data", "cloud", "cyber", "chip",
      ];
      return allListings.filter((l) =>
        keywords.some((k) => l.companyName.toLowerCase().includes(k))
      );
    }
    case "NASDAQ100":
      return sorted
        .filter((l) => String(l.exchange || "").toUpperCase() === "NASDAQ")
        .slice(0, u.nasdaq100Size);
    case "SP100":
      return sorted.slice(0, u.sp100Size);
    case "SP500":
      return sorted.slice(0, u.sp500Size);
    case "RUSSELL2000":
      return sorted.slice(u.russell2000Start, u.russell2000End);
    case "ETF":
      return allListings.filter(isEtfListing);
    case "LEV_ETF": {
      return allListings.filter(isLeveragedEtfListing);
    }
    case "ALL":
      // ALL is sharded by the caller — never resolved directly.
      return [];
    default:
      // Issue #5516: the configured default is a string until it reaches the
      // registry (defaultUniverseId is registry-free by design), so the one
      // place that indexes UNIVERSES is also the one place that refuses an id
      // it does not hold.
      throw new Error(
        `[universes] "${String(id)}" is not a screener universe (#5516). ` +
          `Screener universes: ${(Object.keys(UNIVERSES) as UniverseId[]).join(", ")}.`,
      );
  }
}
